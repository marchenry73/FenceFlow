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
import com.fenceestimator.app.estimate.TakeoffRefresher
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
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.withContext
import java.io.File

class EstimateViewModel(
    private val repository: Repository,
    private val jobId: Long,
    /**
     * Who is holding the phone, so every write funnel below can refuse a
     * guest in the read-only demo. Read live rather than taken once, the way
     * every other view model in this app reaches the session, so a demo that
     * starts or ends while this screen is already open is caught too.
     */
    private val session: com.fenceestimator.app.cloud.SessionManager
) : ViewModel() {
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
            else {
                // Worked out ONCE for the whole job, outside the per-run map:
                // two sides at one joint share ONE post, and which run is
                // billed for it is decided ACROSS runs (the taller fence
                // first). Must match what the office does (priceJob, engine
                // 2026.10.8) or the phone and the office quote a different
                // number of posts for the same drawing.
                val joins = EstimateEngine.joinAdjustments(
                    currentRuns,
                    currentJob.calibrationPixelsPerFoot ?: SurveyViewModel.PIXELS_PER_FOOT_GRID,
                )
                currentRuns.associate { r ->
                r.id to runCatching {
                    // The same refusal [TakeoffRefresher.refreshRun] applies
                    // before it (re)writes a run's stored line items: a run
                    // on an uncalibrated survey photo has no honest scale to
                    // measure, so the grid's flat fallback below would be a
                    // guess, not a fact. Without this check this readout
                    // measured one anyway -- real post and panel counts sat
                    // right next to the $0 total [EstimateEngine.linearFeet]
                    // correctly billed for the identical run, which read as
                    // the app contradicting itself on the same screen. Reused
                    // rather than re-derived, so this can never drift from
                    // the rule the stored takeoff already follows.
                    if (r.isTeardown) {
                        // THE OLD FENCE IS FOOTAGE, NOT A BILL OF MATERIALS.
                        //
                        // "The old fence does not need things to remove, just
                        // the footage and we charge a certain amount per ft,
                        // but there is nothing about line, end post etc...
                        // NO need for that. Just the $/ft, that's it."
                        //
                        // He is right, and the engine already agrees:
                        // TakeoffRefresher.refreshRun clears a teardown run's
                        // generated lines, and computeTotals charges it as
                        // teardownFlatFee + teardownRatePerFt * feet + haul.
                        // Nobody buys panels for a fence they are pulling out.
                        //
                        // This readout did not know that. It called
                        // suggestQuantities for EVERY run, so the old fence
                        // listed posts, panels and concrete in "What this job
                        // needs" while correctly billing none of them -- the
                        // screen contradicting itself about the same run.
                        //
                        // The comment below says this is reused rather than
                        // re-derived "so this can never drift from the rule the
                        // stored takeoff already follows". It reused the
                        // uncalibrated-photo rule and missed the teardown one,
                        // which is the same drift arriving by the same door.
                        //
                        // The footage still shows, because that IS the
                        // quantity: it is what the charge is worked out from,
                        // and he asked for it to appear on its own.
                        val feet = EstimateEngine.teardownLinearFeet(currentJob, listOf(r))
                        if (feet > 0f) listOf(
                            TakeoffLine(
                                label = "Old fence to take out",
                                quantity = feet.toDouble(),
                                unit = "ft",
                                group = com.fenceestimator.app.estimate.TakeoffGroup.SITE,
                            )
                        ) else emptyList()
                    } else if (TakeoffRefresher.blockedByUncalibratedPhoto(currentJob, r)) {
                        emptyList<TakeoffLine>()
                    } else {
                        EstimateEngine.suggestQuantities(
                            run = r,
                            pixelsPerFoot = currentJob.calibrationPixelsPerFoot
                                ?: SurveyViewModel.PIXELS_PER_FOOT_GRID,
                            wastePercent = currentJob.wastePercent,
                            joinAdjustment = joins.forRun(r.syncId),
                        ).takeoff
                    }
                }.getOrDefault(emptyList())
            }
            }
        }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyMap())

    /**
     * Why "What this job needs" has no panels, pickets or fabric on it.
     *
     * The readout drops any line that comes to zero, which is right -- nobody
     * wants "Pickets 0" on a vinyl fence -- but it makes "this does not apply
     * to this side" and "something is broken" look exactly the same. A gate on
     * its own genuinely has no panels, and the screen said nothing at all,
     * which reads as a fault.
     */
    enum class TakeoffNote {
        /** Nothing to explain: either there are panels, or the type has none. */
        NONE,

        /** A gate and no fence. Its own posts and hardware are listed; panels are not a thing it has. */
        GATE_ON_ITS_OWN,

        /** Nothing drawn and no footage typed, so there is nothing to work from yet. */
        NO_LENGTH_YET,

        /** The gates are as wide as the side, so there is no fence left to panel. */
        GATES_TAKE_THE_WHOLE_SIDE,
    }

    /**
     * One note per run, worked out from the run's own geometry.
     *
     * Deliberately NOT part of [takeoff] and NOT a field on TakeoffLine: that
     * type's own doc refuses display concerns because it is "part of the
     * pricing contract, mirrored by the TypeScript engine and pinned by 77
     * golden fixtures". A sentence about emptiness is exactly such a concern.
     * This costs one length and one sum per run and calls nothing in the
     * engine's pricing path.
     */
    val takeoffNotes: StateFlow<Map<Long, TakeoffNote>> =
        combine(runs, job) { rs, currentJob ->
            rs.associate { r -> r.id to noteFor(r, currentJob) }
        }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyMap())

    private fun noteFor(run: FenceRun, currentJob: Job?): TakeoffNote {
        // The old fence has no bill of materials at all -- the readout gives it
        // a footage line and nothing else, on purpose -- so there is no absence
        // here to explain.
        if (run.isTeardown) return TakeoffNote.NONE
        // An uncalibrated survey photo already has its own message elsewhere;
        // two explanations for one silence is worse than one.
        if (currentJob != null && TakeoffRefresher.blockedByUncalibratedPhoto(currentJob, run)) {
            return TakeoffNote.NONE
        }
        // Only the types that have panels, pickets or fabric to be missing.
        if (run.fenceType == com.fenceestimator.app.data.FenceType.UNIVERSAL) return TakeoffNote.NONE

        val typed = run.manualLinearFeet?.takeIf { it.isFinite() && it > 0f }
        val feet = typed ?: currentJob?.let { DrawingScale.of(it) }
            ?.let { scale ->
                FenceGeometryEngine.pixelLength(
                    FenceCodec.decodePoints(run.pointsEncoded), run.closedLoop
                ) / scale
            } ?: 0f

        val gates = FenceCodec.decodeGates(run.gatesEncoded)
        val gateFeet = gates.sumOf { it.widthFt.toDouble() }.toFloat()

        return when {
            feet <= 0f && gates.isNotEmpty() -> TakeoffNote.GATE_ON_ITS_OWN
            feet <= 0f -> TakeoffNote.NO_LENGTH_YET
            // Strictly: a side whose gates leave nothing to panel. Not an
            // error -- an opening the full width of the run is a real thing --
            // but it must not look like a missing answer.
            feet - gateFeet <= 0f -> TakeoffNote.GATES_TAKE_THE_WHOLE_SIDE
            else -> TakeoffNote.NONE
        }
    }

    /**
     * The arithmetic behind one run's post count, for the "why?" sheet.
     *
     * Null for a run [TakeoffRefresher.blockedByUncalibratedPhoto] blocks,
     * same as a run with nothing drawn yet ([EstimateEngine.explainPosts]
     * throwing on it) already returns null here -- the caller already
     * dismisses the sheet on a null answer, and a worked explanation for a
     * post count this same screen no longer shows (see [takeoff] above)
     * would be explaining a number that is not on the page.
     */
    fun postWorkings(run: FenceRun): PostWorkings? {
        val currentJob = job.value ?: return null
        if (TakeoffRefresher.blockedByUncalibratedPhoto(currentJob, run)) return null
        val pxPerFt = currentJob.calibrationPixelsPerFoot ?: SurveyViewModel.PIXELS_PER_FOOT_GRID
        return runCatching {
            // The same adjustment [takeoff] above prices with, so the sheet
            // explains the number actually billed. Without it the workings
            // would add up to a post count the estimate does not use, which
            // is worse than no explanation: it teaches a formula the product
            // does not follow.
            EstimateEngine.explainPosts(
                run,
                pxPerFt,
                joinAdjustment = EstimateEngine.joinAdjustments(runs.value, pxPerFt).forRun(run.syncId),
            )
        }.getOrNull()
    }

    /**
     * Totals have to be a real observable. They used to be a plain function
     * call, and Compose skipped recomposing the totals card when only the line
     * items changed -- which is exactly why the materials total sat at $0 and
     * "sometimes went back to 0" depending on what else happened to redraw.
     */
    /**
     * Fills in the deposit on a job that has none, once the job has a price.
     *
     * Nothing in this app ever computed a deposit. It was only ever a number
     * somebody typed, so a freshly drawn and priced job showed no deposit at
     * all until he went to the job page and set one by hand. March asked for it
     * to fill itself in (2 Oct 2026), having been told the trade-off below.
     *
     * [com.fenceestimator.app.estimate.JobMoney.depositToSeed] is the rule and it carries its own two refusals:
     * a deposit already on the job is NEVER touched, and nothing is written
     * once [com.fenceestimator.app.estimate.JobMoney.customerIsInIt] -- accepted without a pending re-approval,
     * or any money taken. Those guards are the whole reason this is safe to
     * write rather than merely offer: the auto-fill that was removed had
     * neither, and moved one customer's deposit from $9,910 to $5,730 ten
     * seconds after he signed.
     *
     * THE TRADE-OFF HE ACCEPTED: zero means both "never set" and "I want no
     * deposit", because the field is non-null and typing blank writes 0. So a
     * deposit he deliberately clears is seeded again the next time this screen
     * opens on a priced job. Telling the two apart needs a "decided" column
     * threaded through Room, CloudJob, the money scrub and backup, which is a
     * different and larger change.
     *
     * Re-reads from Room rather than trusting [job]'s snapshot: the figure it
     * writes is money, and the row can have moved since this flow last emitted.
     */
    fun seedDepositIfUnset() {
        if (session.state.value.isGuestDemo) return
        if (!TakeoffRefresher.mayReprice(session.state.value)) return
        val currentTotals = totals.value
        val orders = changeOrders.value
        viewModelScope.launch {
            val fresh = repository.getJob(jobId) ?: return@launch
            val materials = com.fenceestimator.app.estimate.JobMoney.materialsToBuy(currentTotals, orders)
            val billable =
                com.fenceestimator.app.estimate.JobMoney.billableTotal(fresh, currentTotals.grandTotal, orders)
            // A job with no deposit at all gets its first one, and it is marked
            // as the app's so it keeps following from here.
            val seed = com.fenceestimator.app.estimate.JobMoney.depositToSeed(fresh, materials, billable)
            if (seed != null) {
                repository.updateJob(fresh.copy(depositAmount = seed, depositIsAuto = true))
                return@launch
            }
            // ...and a job whose deposit is already the app's follows the new
            // price. depositToStore returns null when nothing should move, so
            // a typed deposit, an agreed one, and an unchanged figure all fall
            // out here without a write.
            val next = com.fenceestimator.app.estimate.JobMoney.depositToStore(fresh, materials, billable)
                ?: return@launch
            repository.updateJob(fresh.copy(depositAmount = next, depositIsAuto = true))
        }
    }

    /**
     * Hand a deposit somebody typed back to the price, from the estimate.
     *
     * The same write [seedDepositIfUnset] makes, with the provenance bit set
     * first -- which is the whole difference between "this figure is mine" and
     * "this figure is the app's". Refused once the customer is in it, read off
     * the row rather than off the screen's snapshot, because this is money and
     * the row can have moved since the last emission.
     */
    fun followPriceAgain() {
        if (session.state.value.isGuestDemo) return
        if (!TakeoffRefresher.mayReprice(session.state.value)) return
        val currentTotals = totals.value
        val orders = changeOrders.value
        viewModelScope.launch {
            val fresh = repository.getJob(jobId) ?: return@launch
            if (com.fenceestimator.app.estimate.JobMoney.customerIsInIt(fresh)) return@launch
            val materials = com.fenceestimator.app.estimate.JobMoney.materialsToBuy(currentTotals, orders)
            val billable =
                com.fenceestimator.app.estimate.JobMoney.billableTotal(fresh, currentTotals.grandTotal, orders)
            val want = com.fenceestimator.app.estimate.JobMoney
                .depositSuggestion(fresh, materials, billable).amount
            if (want <= 0.0) return@launch
            repository.updateJob(fresh.copy(depositAmount = want, depositIsAuto = true))
        }
    }

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
        if (session.state.value.isGuestDemo) return
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
                    // which now measures a grid drawing at this same known
                    // scale instead of counting it as nothing -- it only
                    // falls back to a real 0 ft for an uncalibrated SURVEY
                    // PHOTO, via DrawingScale.isPhotoJob, where there is no
                    // known scale to fall back to) and the office's
                    // price-job read the same scale.
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

        // Every run of the job, because the shared post at a joint is billed
        // to exactly one of them and that choice is made across runs. The
        // same call the automatic refresh (TakeoffRefresher) and the office
        // (priceJob) make, so pressing Suggest cannot produce a different
        // post count from leaving it alone.
        val joinScale = pxPerFt ?: SurveyViewModel.PIXELS_PER_FOOT_GRID
        val joins = EstimateEngine.joinAdjustments(runs.value, joinScale)
        val suggestions = EstimateEngine.suggestQuantities(
            run = run,
            pixelsPerFoot = joinScale,
            wastePercent = job.value?.wastePercent ?: 0.0,
            joinAdjustment = joins.forRun(run.syncId)
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

    /**
     * Clears the run's removed-item list so auto-added hardware comes back --
     * and brings it back NOW.
     *
     * It cleared the list and said "restored", while the lines themselves only
     * returned the next time something happened to regenerate that run. The
     * message was true about the list and false about the materials, which is
     * the same disagreement as setManualFeet in a smaller coat.
     */
    fun restoreRemovedItems(run: FenceRun) {
        if (session.state.value.isGuestDemo) return
        if (run.suppressedRolesCsv.isBlank()) return
        viewModelScope.launch {
            repository.updateFenceRun(run.copy(suppressedRolesCsv = ""))
            val landed = withTimeoutOrNull(WASTE_SETTLE_MS) {
                runs.first { list -> list.any { it.id == run.id && it.suppressedRolesCsv.isBlank() } }
            }
            landed?.firstOrNull { it.id == run.id }?.let { regenerateSuggested(it) }
            _message.tryEmit(com.fenceestimator.app.ui.components.UiMessage(R.string.evm_removed_restored))
        }
    }

    /**
     * The typed length and corner count, AND the re-pricing they earn.
     *
     * "here it shows that it's supposed to have seven line post but on the
     * details it shows that it has five each."
     *
     * This wrote the row and stopped. The "What this job needs" readout is
     * computed live from the run every time it draws, so it moved at once; the
     * priced lines are stored and are only rewritten by a regenerate, which
     * nothing asked for. The two then disagreed about the same job -- and not
     * harmlessly: post caps and concrete follow the live post count, so the
     * quote billed 9 caps and 9 bags against 7 posts' worth of posts. Two
     * posts short, on a real quote, with both numbers on the same screen.
     *
     * Footage is the bigger half of this. The length IS the price, and it goes
     * through this same function.
     *
     * Returns early when nothing moved, so re-opening the field or retyping the
     * same number does not rebuild every line on the run for an answer that
     * cannot have changed -- the rule setWastePercent already follows.
     */
    fun setManualFeet(run: FenceRun, feet: Float?, corners: Int) {
        if (session.state.value.isGuestDemo) return
        if (run.manualLinearFeet == feet && run.manualCornerCount == corners) return
        viewModelScope.launch {
            repository.updateFenceRun(run.copy(manualLinearFeet = feet, manualCornerCount = corners))
            // Waited for, not assumed: regenerateInternal reads the run's own
            // usesManualFeet and footage, and `runs` has not caught up the
            // instant the write returns. Re-pricing straight away prices the
            // PREVIOUS number, which looks like it worked and is the worse bug.
            val landed = withTimeoutOrNull(WASTE_SETTLE_MS) {
                runs.first { list ->
                    list.any { it.id == run.id && it.manualLinearFeet == feet && it.manualCornerCount == corners }
                }
            }
            val fresh = landed?.firstOrNull { it.id == run.id } ?: return@launch
            regenerateSuggested(fresh)
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
        if (session.state.value.isGuestDemo) return
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
            /* AND RE-PRICE EVERY RUN, not just this one. A new scale is the
               whole plan's scale: every run's footage is measured off it, so
               every run's posts, panels, caps and concrete move. This wrote the
               calibration and stopped, so the readouts changed on every side of
               the job and the priced lines on every side did not -- the same
               disagreement setManualFeet produced, multiplied by the number of
               sides.

               Both writes are waited for: the job, because regenerateInternal
               reads the scale out of it, and this run, because it must no
               longer look like a typed-footage run by the time it is priced. */
            val scale = pixels / actualFeet
            val landed = withTimeoutOrNull(WASTE_SETTLE_MS) {
                job.first { it?.calibrationPixelsPerFoot == scale }
                runs.first { list -> list.any { it.id == run.id && it.manualLinearFeet == null } }
            } != null
            if (landed) regenerateAll()
            _message.tryEmit(com.fenceestimator.app.ui.components.UiMessage(
                R.string.evm_scale_set, listOf("%.0f".format(java.util.Locale.US, actualFeet))
            ))
        }
    }

    /**
     * Sets the waste allowance AND re-prices, instead of only storing a number.
     *
     * "When I click waste allowances, it should auto update without having to
     * click suggest quantities again."
     *
     * It stored the percentage and stopped. Nothing re-priced, because the only
     * automatic re-pricing is SurveyViewModel.watchDrawingForRepricing, which
     * observes FENCE RUNS -- and waste lives on the JOB, so that watcher never
     * saw it. The chips moved, the materials did not, and the only way to make
     * the two agree was to press Suggest Quantities on every run by hand.
     *
     * WAITING FOR THE WRITE TO COME BACK IS THE WHOLE TRICK. regenerateInternal
     * reads `job.value` -- for the waste percentage and for the calibration
     * scale -- and `job` is a StateFlow fed by observeJob, which has not caught
     * up the instant updateJob() returns. Re-pricing straight away would price
     * against the OLD percentage, so the chips would appear to lag one press
     * behind: press 10%, see the 5% answer. That is a worse bug than the one
     * being fixed, because it looks like it works.
     *
     * If the write does not come back, nothing is re-priced rather than
     * something being priced wrongly. Suggest Quantities is still there, which
     * is exactly where he was before.
     */
    fun setWastePercent(percent: Double) {
        if (session.state.value.isGuestDemo) return
        val current = job.value ?: return
        // Pressing the chip that is already selected should not rebuild every
        // run's lines for an answer that cannot have changed.
        if (current.wastePercent == percent) return
        viewModelScope.launch {
            repository.updateJob(current.copy(wastePercent = percent))
            val landed = withTimeoutOrNull(WASTE_SETTLE_MS) {
                job.first { it?.wastePercent == percent }
            } != null
            if (landed) regenerateAll()
        }
    }

    fun regenerateAll() {
        runs.value.forEach { regenerateSuggested(it) }
    }

    fun updateLineItem(item: EstimateLineItem) {
        if (session.state.value.isGuestDemo) return
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
        if (session.state.value.isGuestDemo) return
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
        if (session.state.value.isGuestDemo) return
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
        if (session.state.value.isGuestDemo) return
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
        if (session.state.value.isGuestDemo) return
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
                    // back to the LIVE total (com.fenceestimator.app.estimate.JobMoney.documentTotal): the
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
     * com.fenceestimator.app.estimate.JobMoney.anchoredTotal). Before it existed the phone went on pushing its
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
        // One of the five money/scheduling actions this session found gated
        // only by canSeeMoney with no refusal of its own -- and the guest
        // demo deliberately holds SEE_MONEY, so that gate alone waves a
        // guest straight through to a real signature write.
        if (session.state.value.isGuestDemo) return
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

        /**
         * How long to wait for a waste change to come back through observeJob
         * before giving up on re-pricing it.
         *
         * Generous on purpose: this is a local Room write coming back through a
         * Flow, which is milliseconds, and the cost of waiting too long is a
         * short delay while the cost of giving up too early is a re-price
         * against the old percentage. A second is far beyond the former and
         * still short enough that nobody stares at it.
         */
        const val WASTE_SETTLE_MS = 1_000L
    }
}
