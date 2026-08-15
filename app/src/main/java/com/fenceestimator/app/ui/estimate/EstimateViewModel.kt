package com.fenceestimator.app.ui.estimate

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.EstimateLineItem
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.MaterialItem
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.estimate.EstimateEngine
import com.fenceestimator.app.estimate.PdfExporter
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

    private val _message = MutableSharedFlow<String>(extraBufferCapacity = 1)
    /** Surfaces why a generate attempt produced nothing, instead of failing silently. */
    val message: SharedFlow<String> = _message

    /** Last computed takeoff per run, so the counts stay on screen after generating. */
    private val _takeoff = MutableStateFlow<Map<Long, List<TakeoffLine>>>(emptyMap())
    val takeoff: StateFlow<Map<Long, List<TakeoffLine>>> = _takeoff

    /**
     * Totals have to be a real observable. They used to be a plain function
     * call, and Compose skipped recomposing the totals card when only the line
     * items changed -- which is exactly why the materials total sat at $0 and
     * "sometimes went back to 0" depending on what else happened to redraw.
     */
    val totals: StateFlow<EstimateEngine.Totals> =
        combine(job, lineItems, runs) { currentJob, items, currentRuns ->
            if (currentJob == null) EMPTY_TOTALS
            else EstimateEngine.computeTotals(currentJob, items, feetAcross(currentJob, currentRuns))
        }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), EMPTY_TOTALS)

    /** Total footage across runs, counting typed-in lengths as well as drawn ones. */
    private fun feetAcross(currentJob: Job, currentRuns: List<FenceRun>): Float =
        currentRuns.sumOf { feetFor(currentJob, it).toDouble() }.toFloat()

    private fun feetFor(currentJob: Job, run: FenceRun): Float {
        run.manualLinearFeet?.let { if (it > 0f) return it }
        val pxPerFt = currentJob.calibrationPixelsPerFoot ?: return 0f
        val points = FenceCodec.decodePoints(run.pointsEncoded)
        return FenceGeometryEngine.analyze(points, pxPerFt, run.closedLoop).totalLinearFeet
    }

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
        var pxPerFt = job.value?.calibrationPixelsPerFoot
        if (!run.usesManualFeet) {
            if (pxPerFt == null) {
                val current = job.value
                if (current != null && current.surveyImagePath == null) {
                    // A grid drawing has a fixed known scale, so set it and carry
                    // on rather than refusing to generate anything.
                    pxPerFt = SurveyViewModel.PIXELS_PER_FOOT_GRID
                    repository.updateJob(current.copy(calibrationPixelsPerFoot = pxPerFt))
                } else {
                    _message.tryEmit(
                        "Set the scale on the Survey screen, or just type the length into " +
                            "\"Total feet\" on this run and press Suggest again."
                    )
                    return
                }
            }
            val points = FenceCodec.decodePoints(run.pointsEncoded)
            if (points.size < 2) {
                _message.tryEmit(
                    "Draw \"${run.label.ifBlank { "this run" }}\" on the Survey screen, " +
                        "or type its length into \"Total feet\" here."
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
            _message.tryEmit("Your materials catalog is empty. Add items under Catalog, then try again.")
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

        // Carry over any price the user typed by hand. Regenerating replaces
        // the whole takeoff, and without this a corrected price would silently
        // revert to the catalog figure every time Suggest was pressed.
        val editedPrices = lineItems.value
            .filter { it.fenceRunId == run.id && !it.isAutoGenerated && it.role != null }
            .associate { it.role!! to it.unitPrice }

        val finalItems = built.items.map { item ->
            val kept = item.role?.let { editedPrices[it] }
            if (kept != null && kept != item.unitPrice) item.copy(unitPrice = kept, isAutoGenerated = false)
            else item
        }

        repository.replaceAutoGeneratedLineItemsForRun(run.id, finalItems)
        _takeoff.value = _takeoff.value + (run.id to suggestions.takeoff)

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
                built.items.isEmpty() -> "Nothing priced -- your catalog has no ${
                    run.fenceType.name.replace("_", " ").lowercase()
                } items. Add them under Catalog."
                problems.isEmpty() -> "Replaced with ${built.items.size} line items."
                else -> "Replaced with ${built.items.size} line items. Check: ${problems.joinToString("; ")}"
            }
        )
    }

    /** Clears the run's removed-item list so auto-added hardware comes back. */
    fun restoreRemovedItems(run: FenceRun) {
        viewModelScope.launch {
            repository.updateFenceRun(run.copy(suppressedRolesCsv = ""))
            _message.tryEmit("Removed items restored. Press Suggest Quantities to add them back.")
        }
    }

    fun setManualFeet(run: FenceRun, feet: Float?, corners: Int) {
        viewModelScope.launch {
            repository.updateFenceRun(run.copy(manualLinearFeet = feet, manualCornerCount = corners))
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
                    isInvoice = isInvoice
                )
            }
            onReady(file)
        }
    }

    fun captureSignature(path: String) {
        val current = job.value ?: return
        viewModelScope.launch {
            repository.updateJob(current.copy(signatureImagePath = path, signedAt = System.currentTimeMillis()))
        }
    }

    private companion object {
        val EMPTY_TOTALS = EstimateEngine.Totals(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    }
}
