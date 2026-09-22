package com.fenceestimator.app.ui.estimate

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.R
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.ChangeOrder
import com.fenceestimator.app.data.EstimateLineItem
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.MaterialItem
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.estimate.DrawingScale
import com.fenceestimator.app.estimate.EstimateEngine
import com.fenceestimator.app.estimate.PdfExporter
import com.fenceestimator.app.estimate.PostWorkings
import com.fenceestimator.app.estimate.TakeoffLine
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FenceGeometryEngine
import com.fenceestimator.app.ui.survey.SurveyViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

class EstimateViewModel(private val repository: Repository, private val jobId: Long) : ViewModel() {
    val job: StateFlow<Job?> = repository.observeJob(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    val runs: StateFlow<List<FenceRun>> = repository.observeFenceRuns(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val lineItems: StateFlow<List<EstimateLineItem>> = repository.observeLineItems(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val catalog: StateFlow<List<MaterialItem>> = repository.observeCatalog()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    private val _message = MutableSharedFlow<com.fenceestimator.app.ui.components.UiMessage>(extraBufferCapacity = 1)
    /** Surfaces why a generate attempt produced nothing, instead of failing silently. */
    val message: SharedFlow<com.fenceestimator.app.ui.components.UiMessage> = _message

    /**
     * The counts, for every run, always.
     *
     * This used to be a map filled in only when somebody pressed Generate,
     * so the takeoff -- the posts, panels, bags of concrete a contractor
     * reads out to the supply house -- appeared once and then vanished the
     * next time the estimate was opened. The numbers were never stored
     * anywhere; they were a side effect of a button. Derived from the runs
     * instead, so they are simply always there, and they follow the drawing
     * the moment it changes.
     */
    val takeoff: StateFlow<Map<Long, List<TakeoffLine>>> =
        combine(job, runs) { currentJob, currentRuns ->
            if (currentJob == null) emptyMap()
            else currentRuns.associate { r ->
                r.id to runCatching {
                    EstimateEngine.suggestQuantities(
                        run = r,
                        pixelsPerFoot = currentJob.calibrationPixelsPerFoot
                            ?: SurveyViewModel.PIXELS_PER_FOOT_GRID,
                        wastePercent = currentJob.wastePercent,
                    ).takeoff
                }.getOrDefault(emptyList())
            }
        }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyMap())

    /** The arithmetic behind one run's post count, for the "why?" sheet. */
    fun postWorkings(run: FenceRun): PostWorkings? {
        val currentJob = job.value ?: return null
        return runCatching {
            EstimateEngine.explainPosts(
                run,
                currentJob.calibrationPixelsPerFoot ?: SurveyViewModel.PIXELS_PER_FOOT_GRID,
            )
        }.getOrNull()
    }

    /**
     * Totals have to be a real observable. They used to be a plain function
     * call, and Compose skipped recomposing the totals card when only the line
     * items changed -- which is exactly why the materials total sat at $0 and
     * "sometimes went back to 0" depending on what else happened to redraw.
     */
    val changeOrders: StateFlow<List<ChangeOrder>> = repository.observeChangeOrders(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val totals: StateFlow<EstimateEngine.Totals> =
        combine(job, lineItems, runs, changeOrders) { currentJob, items, currentRuns, orders ->
            if (currentJob == null) EMPTY_TOTALS
            else EstimateEngine.computeTotals(
                currentJob, items, feetAcross(currentJob, currentRuns), orders, currentRuns
            )
        }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), EMPTY_TOTALS)

    /**
     * Materials on THIS job still priced with a figure FenceFlow shipped
     * rather than one this company checked.
     *
     * The catalog banner counts placeholders across the whole catalog, which
     * is a housekeeping number. This is the one that matters: it answers
     * "would the quote I am about to send rest on a guess?" -- so it looks
     * only at the lines actually on this estimate.
     *
     * An auto-generated line takes its description straight from the catalog
     * item's name, which is what makes the join exact. A line somebody typed
     * themselves is their own figure and is left alone, and so is any line
     * where a real supplier price has since come back, because at that point
     * the guess is no longer what the job is priced on.
     */
    val unverifiedPriceNames: StateFlow<List<String>> =
        combine(lineItems, catalog) { items, cat ->
            val guessed = cat
                .filter { com.fenceestimator.app.data.isPlaceholderPrice(it.sourceDoc) }
                .map { it.name }
                .toSet()
            items
                .filter { it.isAutoGenerated && it.supplierUnitPrice == null && it.description in guessed }
                .map { it.description }
                .distinct()
                .sorted()
        }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    /** Total footage across runs, counting typed-in lengths as well as drawn ones. */
    private fun feetAcross(currentJob: Job, currentRuns: List<FenceRun>): Float =
        EstimateEngine.linearFeet(currentJob, currentRuns)

    private fun feetFor(currentJob: Job, run: FenceRun): Float =
        EstimateEngine.linearFeet(currentJob, listOf(run))

    /** Runs currently regenerating, so a double-tap can't produce two sets of items. */
    private val regenerating = mutableSetOf<Long>()

    fun regenerateSuggested(run: FenceRun) {
        if (!regenerating.add(run.id)) return
        viewModelScope.launch {
            try {
                regenerateInternal(run)
            } finally {
                regenerating.remove(run.id)
            }
        }
    }

    private suspend fun regenerateInternal(run: FenceRun) {
        // Typed-in footage needs no scale and no drawing at all. Only fall
        // back to measuring the drawing when there's no number to work from.
        // A stored scale that is not a positive number is no scale (DrawingScale.of):
        // measuring by it makes every length zero or infinite.
        var pxPerFt = job.value?.calibrationPixelsPerFoot?.takeIf { it > 0f && it.isFinite() }
        if (!run.usesManualFeet) {
            if (pxPerFt == null) {
                val current = job.value
                val seed = current?.let { DrawingScale.calibrationToSeed(it) }
                if (current != null && seed != null) {
                    // A grid drawing has a known scale -- the grid's own, the
                    // one the drawing screen is already showing it at -- so
                    // store it and carry on rather than refusing to generate
                    // anything. This wrote a flat 20 units per foot whatever
                    // the grid's size: right for the default 400 ft grid, but
                    // on a 100 ft grid (80 units per foot) it told the drawing
                    // it was a quarter of its real scale, and every side then
                    // measured four times its length. Stored, not just used,
                    // so the job's own footage (EstimateEngine.linearFeet,
                    // which counts an uncalibrated drawing as nothing) and the
                    // office's price-job read the same scale.
                    pxPerFt = seed
                    repository.updateJob(current.copy(calibrationPixelsPerFoot = seed))
                } else {
                    _message.tryEmit(com.fenceestimator.app.ui.components.UiMessage(R.string.evm_set_scale_or_type))
                    return
                }
            }
            val points = FenceCodec.decodePoints(run.pointsEncoded)
            // A run that is only a gate has nothing to draw and nothing to
            // type, but it still carries posts, hardware and concrete -- a
            // standalone gate sale is a real job. Refusing until fence was
            // drawn meant a gate-only job showed no materials at all.
            val hasGates = FenceCodec.decodeGates(run.gatesEncoded).isNotEmpty()
            if (points.size < 2 && !hasGates) {
                _message.tryEmit(
                    if (run.label.isBlank())
                        com.fenceestimator.app.ui.components.UiMessage(R.string.evm_draw_or_type_unnamed)
                    else com.fenceestimator.app.ui.components.UiMessage(R.string.evm_draw_or_type_named, listOf(run.label))
                )
                return
            }
        }

        var availableCatalog = catalog.value
        if (availableCatalog.isEmpty()) {
            // Catalog can be empty on installs affected by the old seeding bug; repair and retry.
            repository.ensureSeedDataPresent()
            availableCatalog = repository.observeCatalog().first()
        }
        if (availableCatalog.isEmpty()) {
            _message.tryEmit(com.fenceestimator.app.ui.components.UiMessage(R.string.evm_catalog_empty))
            return
        }

        val suggestions = EstimateEngine.suggestQuantities(
            run = run,
            pixelsPerFoot = pxPerFt ?: SurveyViewModel.PIXELS_PER_FOOT_GRID,
            wastePercent = job.value?.wastePercent ?: 0.0
        )
        val built = EstimateEngine.buildLineItems(
            jobId = jobId,
            fenceRunId = run.id,
            run = run,
            suggestions = suggestions,
            catalog = availableCatalog,
            preferredManufacturerId = job.value?.preferredManufacturerId
        )

        // The same merge the automatic refresh uses (TakeoffLineMerge): a
        // line somebody edited is kept exactly as it is -- this button used
        // to delete it and carry across only its PRICE, so a typed quantity
        // went back to the engine's number every time Suggest was pressed --
        // and supplier quotes carry over, which this path never did. Read
        // from the database inside the write, not from [lineItems], which is
        // a screen's snapshot and can be a sync behind.
        val plan = repository.replaceAutoGeneratedLineItemsForRun(run.id, built.items)
        val keptEdited = plan.keptEdited.size

        // Say exactly what's missing. Silence here is what left people
        // staring at a $0 estimate with nothing to act on.
        val problems = mutableListOf<String>()
        if (built.unmatchedRoles.isNotEmpty()) {
            problems += "no catalog item for " + built.unmatchedRoles.joinToString(", ") {
                it.name.replace("_", " ").lowercase()
            }
        }
        if (built.zeroPricedNames.isNotEmpty()) {
            problems += "priced at \$0: " + built.zeroPricedNames.joinToString(", ")
        }

        _message.tryEmit(
            when {
                // The fence-type word rides along as data; it is a product
                // term and the catalog lists it under the same word.
                built.items.isEmpty() -> com.fenceestimator.app.ui.components.UiMessage(
                    R.string.evm_nothing_priced,
                    listOf(run.fenceType.name.replace("_", " ").lowercase())
                )
                // Say so when edited lines were kept. Otherwise "Replaced
                // with 12 line items" beside a line that visibly did not
                // change reads as the button not working.
                problems.isEmpty() && keptEdited > 0 -> com.fenceestimator.app.ui.components.UiMessage(
                    R.string.evm_replaced_lines_kept, listOf(plan.insert.size, keptEdited)
                )
                problems.isEmpty() -> com.fenceestimator.app.ui.components.UiMessage(
                    R.string.evm_replaced_lines, listOf(built.items.size)
                )
                keptEdited > 0 -> com.fenceestimator.app.ui.components.UiMessage(
                    R.string.evm_replaced_lines_kept_check,
                    listOf(plan.insert.size, keptEdited, problems.joinToString("; "))
                )
                else -> com.fenceestimator.app.ui.components.UiMessage(
                    R.string.evm_replaced_lines_check,
                    listOf(built.items.size, problems.joinToString("; "))
                )
            }
        )
    }

    /** Clears the run's removed-item list so auto-added hardware comes back. */
    fun restoreRemovedItems(run: FenceRun) {
        viewModelScope.launch {
            repository.updateFenceRun(run.copy(suppressedRolesCsv = ""))
            _message.tryEmit(com.fenceestimator.app.ui.components.UiMessage(R.string.evm_removed_restored))
        }
    }

    fun setManualFeet(run: FenceRun, feet: Float?, corners: Int) {
        viewModelScope.launch {
            repository.updateFenceRun(run.copy(manualLinearFeet = feet, manualCornerCount = corners))
        }
    }

    /**
     * Whether this run was drawn, and so could be used to fix the scale.
     *
     * A typed-in length with no drawing behind it has nothing to measure
     * against.
     */
    fun canRecalibrateFrom(run: FenceRun): Boolean =
        FenceCodec.decodePoints(run.pointsEncoded).size >= 2

    /**
     * Makes the drawing agree with a length you actually measured.
     *
     * Typing a length used to override the drawing for that one run and leave
     * the drawing itself wrong -- so the fence was quoted at the right length
     * while the plan the crew works from, the gate positions on it, and every
     * other run sharing that drawing all stayed at the wrong scale.
     *
     * This goes the other way. It takes the line as drawn, divides its length
     * on screen by the real length, and stores the result as the drawing's
     * scale. One measured run therefore corrects the whole plan: every other
     * run, every gate, every distance measured off it afterwards.
     *
     * The typed length is then cleared, because the drawing now says the same
     * thing and two sources of truth for one number is how they drift apart.
     *
     * @return true when the scale was set.
     */
    fun recalibrateFromRun(run: FenceRun, actualFeet: Float) {
        val points = FenceCodec.decodePoints(run.pointsEncoded)
        val pixels = FenceGeometryEngine.pixelLength(points, run.closedLoop)
        val currentJob = job.value

        if (actualFeet <= 0f || pixels <= 0f || currentJob == null) {
            _message.tryEmit(com.fenceestimator.app.ui.components.UiMessage(R.string.evm_draw_first_scale))
            return
        }

        viewModelScope.launch {
            repository.updateJob(
                currentJob.copy(
                    calibrationPixelsPerFoot = pixels / actualFeet,
                    calibrationKnownFeet = actualFeet
                )
            )
            // The drawing now says the same thing, so the typed override goes.
            // Two sources of truth for one number is how they drift apart.
            repository.updateFenceRun(run.copy(manualLinearFeet = null))
            _message.tryEmit(com.fenceestimator.app.ui.components.UiMessage(
                R.string.evm_scale_set, listOf("%.0f".format(java.util.Locale.US, actualFeet))
            ))
        }
    }

    fun setWastePercent(percent: Double) {
        val current = job.value ?: return
        viewModelScope.launch { repository.updateJob(current.copy(wastePercent = percent)) }
    }

    fun regenerateAll() {
        runs.value.forEach { regenerateSuggested(it) }
    }

    fun updateLineItem(item: EstimateLineItem) {
        viewModelScope.launch { repository.updateLineItem(item) }
    }

    /**
     * Hands a line somebody changed back to the takeoff: it is marked as the
     * takeoff's again, then its run is regenerated, so it takes the drawing's
     * number (or goes, if the drawing no longer needs it).
     *
     * The way back had to exist. A line edited by hand is now kept through
     * every regenerate (TakeoffLineMerge), and deleting it was the only other
     * door -- but a delete records the role against the run
     * ([deleteLineItem]), so Suggest never built that line again: a typed
     * number could only be traded for no line at all.
     */
    fun useSuggested(item: EstimateLineItem) {
        val run = runs.value.firstOrNull { it.id == item.fenceRunId } ?: return
        if (item.role == com.fenceestimator.app.data.MaterialRole.NONE) return
        viewModelScope.launch {
            repository.updateLineItem(item.copy(isAutoGenerated = true))
            regenerateSuggested(run)
        }
    }

    /**
     * Deleting an auto-added item also records its role against the run, so
     * Suggest Quantities won't put it straight back the next time it runs.
     * That's what makes "unless I remove them" actually hold.
     */
    fun deleteLineItem(item: EstimateLineItem) {
        viewModelScope.launch {
            repository.deleteLineItem(item)
            val role = item.role ?: return@launch
            val run = runs.value.firstOrNull { it.id == item.fenceRunId } ?: return@launch
            if (role in run.suppressedRoles) return@launch
            val updated = (run.suppressedRoles + role).joinToString(",") { it.name }
            repository.updateFenceRun(run.copy(suppressedRolesCsv = updated))
        }
    }

    fun addManualLineItem() {
        viewModelScope.launch {
            repository.saveLineItem(
                EstimateLineItem(
                    jobId = jobId,
                    fenceRunId = null,
                    sortOrder = (lineItems.value.maxOfOrNull { it.sortOrder } ?: 0) + 1,
                    description = "New item",
                    quantity = 1.0,
                    unitPrice = 0.0,
                    isAutoGenerated = false
                )
            )
        }
    }

    fun linearFeetFor(run: FenceRun): Float {
        val currentJob = job.value ?: return run.manualLinearFeet ?: 0f
        return feetFor(currentJob, run)
    }

    fun totalLinearFeet(): Float {
        val currentJob = job.value ?: return 0f
        return feetAcross(currentJob, runs.value)
    }

    /**
     * Records what the supplier quoted and re-costs the job from it.
     *
     * A line left blank keeps its catalog estimate rather than being zeroed --
     * "they did not quote this" is not the same as "this is free", and treating
     * it as free is how a job looks profitable right up until the invoice
     * arrives.
     *
     * The job counts as confirmed only when every line has a real price. Half a
     * quote is still a guess, and a guess that calls itself confirmed is worse
     * than one that admits it.
     */
    fun applySupplierPrices(pricesByItemId: Map<Long, Double>, reference: String) {
        viewModelScope.launch {
            val items = lineItems.value
            items.forEach { item ->
                val quoted = pricesByItemId[item.id]
                if (quoted != null && quoted != item.supplierUnitPrice) {
                    repository.updateLineItem(item.copy(supplierUnitPrice = quoted))
                }
            }

            val allPriced = items.all { item ->
                pricesByItemId.containsKey(item.id) || item.supplierUnitPrice != null
            }
            val current = job.value ?: return@launch
            repository.updateJob(
                current.copy(
                    supplierQuoteReference = reference,
                    materialPricesConfirmedAt = if (allPriced && items.isNotEmpty()) {
                        System.currentTimeMillis()
                    } else null
                )
            )
            _message.tryEmit(
                if (allPriced && items.isNotEmpty())
                    com.fenceestimator.app.ui.components.UiMessage(R.string.evm_supplier_saved_real)
                else com.fenceestimator.app.ui.components.UiMessage(R.string.evm_saved_some_catalog)
            )
        }
    }

    fun exportDocument(
        context: Context,
        business: BusinessProfile,
        document: com.fenceestimator.app.estimate.JobDocument,
        onReady: (File) -> Unit
    ) {
        val currentJob = job.value ?: return
        viewModelScope.launch {
            val file = withContext(Dispatchers.IO) {
                PdfExporter.export(
                    context = context,
                    job = currentJob,
                    estimateNumber = jobId.toString().padStart(5, (48).toChar()),
                    business = business,
                    runs = runs.value,
                    lineItems = lineItems.value,
                    totals = totals.value,
                    linearFeet = totalLinearFeet(),
                    document_ = document,
                    // Without the orders, a job with change-order money fell
                    // back to the LIVE total (JobMoney.documentTotal): the
                    // invoice, its Balance Due and the {TOTAL} in the contract
                    // terms printed the drifting recompute on exactly the
                    // accepted jobs with extra work, against the job screen,
                    // the quote page and the payment link.
                    changeOrders = changeOrders.value
                )
            }
            onReady(file)
        }
    }

    fun exportPdf(context: Context, business: BusinessProfile, isInvoice: Boolean = false, onReady: (File) -> Unit) {
        val currentJob = job.value ?: return
        viewModelScope.launch {
            val file = withContext(Dispatchers.IO) {
                PdfExporter.export(
                    context = context,
                    job = currentJob,
                    estimateNumber = jobId.toString().padStart(5, '0'),
                    business = business,
                    runs = runs.value,
                    lineItems = lineItems.value,
                    totals = totals.value,
                    linearFeet = totalLinearFeet(),
                    isInvoice = isInvoice,
                    changeOrders = changeOrders.value
                )
            }
            onReady(file)
        }
    }

    /**
     * Stores the signature together with what it is a signature FOR.
     *
     * Recording the path alone leaves "someone signed something": redraw the
     * layout afterwards and the file on disk silently stands as agreement to a
     * price and a length that no longer exist. Written in the same update so a
     * signature can never exist without its terms.
     *
     * acceptedTotal is frozen here too, in the same write: this is the moment
     * the customer agreed to the price, and from here on it is the figure the
     * phone bills against and the only contract_total it pushes (see
     * JobMoney.anchoredTotal). Before it existed the phone went on pushing its
     * live recompute after the signature -- job 4598 was signed at $9,710 and
     * its quote page later showed $13,410. The server stamps the same figure
     * from signed_contract_total when this reaches it; frozen locally as well
     * so a signature taken with no signal holds the price straight away. A
     * zero (totals not loaded yet) freezes nothing rather than a $0 price.
     *
     * Every change order on the job is marked as inside that price in the
     * same transaction (ChangeOrder.inAcceptedTotal): grandTotal counts them
     * all, signed or not, so one still unsigned now is already paid for in
     * the figure, and must not be added again when it is signed tomorrow.
     */
    fun captureSignature(path: String) {
        val current = job.value ?: return
        val agreed = totals.value
        viewModelScope.launch {
            repository.recordSignedAcceptance(
                current.copy(
                    signatureImagePath = path,
                    signedAt = System.currentTimeMillis(),
                    signedContractTotal = agreed.grandTotal,
                    signedLinearFeet = agreed.billableLinearFeet,
                    acceptedTotal = agreed.grandTotal.takeIf { it > 0.005 } ?: current.acceptedTotal
                )
            )
        }
    }

    private companion object {
        val EMPTY_TOTALS = EstimateEngine.Totals(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    }
}
