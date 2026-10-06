package com.fenceestimator.app.estimate

import com.fenceestimator.app.cloud.SessionState
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.MaterialRole
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FenceGeometryEngine

/**
 * Keeps the material takeoff in step with the drawing.
 *
 * The problem this solves, in the user's words: "payments and invoices is not
 * synchronizing with the material price after I changed the drawing."
 *
 * Labour, gate charges and teardown were all computed live from the drawn
 * footage, so they moved the moment a point did. Materials did not -- posts,
 * panels, rails and concrete were frozen at whatever "Suggest Quantities"
 * produced the last time somebody pressed it. Redraw a 200 ft fence as 300 ft
 * and the estimate charged 300 ft of labour against 200 ft of material.
 *
 * That is worse than a display bug. The contract total, the deposit, the
 * payment link and the invoice all hang off that figure, so the customer was
 * quoted and billed for material nobody was buying.
 *
 * The rules that keep this from being intrusive:
 *
 *  - **Only a phone that prices may re-price** ([mayReprice]). A crew phone
 *    holds a catalog with every price scrubbed to zero, so the product pick
 *    breaks its ties by sync id and chooses different posts and panels than
 *    the office's -- and the crew phone and the owner's then overwrote each
 *    other's quantities on every sync (161 flips on Woody and John
 *    Beaunissant, 2026-09-17..21).
 *  - **Only a drawing change re-prices** ([pricingSignature]). A sync echo
 *    that only moves a run's clock is not a change.
 *  - **Only runs that already have a takeoff are refreshed.** If nobody has
 *    pressed Suggest Quantities for a run, drawing on it does not conjure an
 *    estimate out of nowhere.
 *  - **Only auto-generated lines are replaced.** A line somebody edited is
 *    kept exactly as it is, hand-added items survive, and roles the user
 *    removed stay removed -- the same rules the Suggest button applies
 *    ([com.fenceestimator.app.data.TakeoffLineMerge]).
 *  - **A drawn run on an uncalibrated survey photo re-prices to nothing.**
 *    [EstimateEngine.footageOf] already refuses to guess a photo's scale for
 *    labour ([com.fenceestimator.app.estimate.DrawingScale.isPhotoJob]); this
 *    refresher used to have no such check for materials at all, so a photo
 *    job with no calibration billed real panels, posts and concrete measured
 *    off the grid's flat scale -- a made-up number -- while labour correctly
 *    billed zero for the identical run. See [blockedByUncalibratedPhoto].
 */
object TakeoffRefresher {

    /**
     * Whether the person on this phone may re-price an estimate: they see
     * money (their catalog carries real prices, so the product pick is the
     * office's pick) and they may edit jobs (the estimate is part of the
     * job). Crew and foremen have neither; an accountant sees money but may
     * not change jobs. Signed out is working alone on your own phone, where
     * [SessionState.permissions] is everything; signed in with a profile not
     * read yet is nothing, and so is no.
     */
    fun mayReprice(session: SessionState): Boolean = session.canSeeMoney && session.canEditJobs

    /**
     * Whether [run]'s materials cannot be honestly measured right now: it has
     * no typed footage to fall back on, so it has to be measured off the
     * drawing, and the job is a survey photo nobody has calibrated
     * ([DrawingScale.isPhotoJob]) -- there is no scale to measure it at, only
     * a guess. The grid case is deliberately not included: a grid square is
     * a known size, so [DrawingScale.PIXELS_PER_FOOT_GRID] is a fact, not a
     * guess, for it.
     *
     * Pure -- no [Repository] -- so the rule is held to a test
     * (PhotoScaleTest) with no database in the loop, the same reason
     * [pricingSignature] and [mayReprice] are pure.
     */
    fun blockedByUncalibratedPhoto(job: Job, run: FenceRun): Boolean =
        !run.usesManualFeet && job.calibrationPixelsPerFoot == null && DrawingScale.isPhotoJob(job)

    /**
     * Everything about a run that changes what it costs in material -- the
     * whole row minus the fields that are identity, bookkeeping or
     * presentation.
     *
     * The whole row rather than a hand-picked list, because listing fields by
     * hand makes every new spec field one the re-pricing silently ignores.
     * But the old version subtracted only the label and sort order, and so
     * kept `updatedAt` in: a pull that wrote the cloud's clock onto a run
     * this phone had just pushed (the server's touch_updated_at moves it)
     * looked like a drawing change, and re-priced -- over the quantities the
     * owner was typing on the Estimate screen, which sits on top of the
     * drawing screen and keeps its view model alive. Any other device's push
     * did the same.
     *
     * Subtracted: the Room id, the job id and the sync id (identity -- a
     * run's own never changes, and nothing is priced from it except the line
     * ids it seeds, which follow it anyway); `updatedAt` (the sync clock);
     * the label and sort order (shown, never priced); and the build template
     * it was copied from (provenance: the spec was copied onto the run's own
     * columns, which ARE compared).
     */
    fun pricingSignature(run: FenceRun): String =
        run.copy(
            id = 0L,
            syncId = "",
            jobId = 0L,
            label = "",
            sortOrder = 0,
            buildTemplateSyncId = null,
            updatedAt = 0L
        ).toString()

    /**
     * Rebuilds the takeoff for [run] if it has one.
     *
     * @param mayReprice the answer [mayReprice] gave for the person on this
     *   phone, asked by the caller at the moment of re-pricing. Required, with
     *   no default, so a new caller has to answer it rather than inherit a
     *   yes.
     * @return true if line items were actually rewritten.
     */
    /**
     * @param priceUnpriced price a run that has NO lines yet, instead of
     *   leaving it alone. Opt-in, and only the drawing screen's watcher asks
     *   for it -- see the guard below for what it costs elsewhere.
     */
    suspend fun refreshRun(
        repository: Repository,
        run: FenceRun,
        mayReprice: Boolean,
        priceUnpriced: Boolean = false,
    ): Boolean {
        if (!mayReprice) return false

        val takeoffLines = repository.getLineItems(run.jobId)
            .filter { it.fenceRunId == run.id && it.role != MaterialRole.NONE }

        // A teardown run is the OLD fence. Nobody is buying panels for it --
        // its cost is the teardown charge, not a bill of materials. Marking a
        // run as teardown therefore clears the materials it accumulated while
        // it was mistaken for new work, which is also what un-inflates an
        // estimate that counted the old fence as fence to build. The
        // generated ones: a line somebody typed a number into is theirs.
        if (run.isTeardown) {
            if (takeoffLines.none { it.isAutoGenerated }) return false
            return !repository.replaceAutoGeneratedLineItemsForRun(run.id, emptyList()).unchanged
        }

        // Never invent an estimate for a run nobody has priced yet. A run
        // whose every line was edited by hand HAS been priced, and still
        // gains the lines a new gate needs.
        //
        // EXCEPT WHILE HE IS DRAWING IT. "I want the suggest quantities to
        // already be calculating as I'm drawing, and when I'm done, it can be
        // ready." The watcher on the drawing screen already re-prices every run
        // whose shape changed -- but a side he has just drawn has no lines yet,
        // so it fell out HERE and he had to press Suggest Quantities once per
        // run before the automatic pricing would follow it at all.
        //
        // Opt-in rather than simply deleting the guard, because the guard is
        // right everywhere else: a job nobody has chosen to price should not
        // quietly grow a bill of materials because something touched a row.
        // Drawing a side IS choosing to price it, which is what makes the
        // drawing screen the one place this flips.
        //
        // Everything below still applies -- an uncalibrated photo still blocks
        // it, an empty catalog still blocks it, and a teardown run still gets
        // no materials. This decides WHEN to start pricing, never what the
        // price is.
        if (takeoffLines.isEmpty() && !priceUnpriced) return false

        val job = repository.getJob(run.jobId) ?: return false

        // An uncalibrated survey photo has no honest scale to measure this
        // run's materials at (see blockedByUncalibratedPhoto). Clearing the
        // generated lines rather than leaving whatever the last good
        // calibration priced: a total that quietly stops updating still
        // reads as right, and this run is not right until it is calibrated.
        // A hand-edited line is untouched either way -- only auto-generated
        // ones are ever replaced.
        if (blockedByUncalibratedPhoto(job, run)) {
            if (takeoffLines.none { it.isAutoGenerated }) return false
            return !repository.replaceAutoGeneratedLineItemsForRun(run.id, emptyList()).unchanged
        }

        val catalog = repository.getAllMaterialItems().filter { it.isActive }
        if (catalog.isEmpty()) return false

        // The job's calibration, or the grid's fixed 20 px/ft -- the same
        // fallback price-job applies (load.ts buildPricingInput), so the
        // office re-pricing this job reaches the same takeoff.
        val pixelsPerFoot = job.calibrationPixelsPerFoot ?: DrawingScale.PIXELS_PER_FOOT_GRID

        // The joints the owner has made between this run's ends and other
        // runs' ends. EVERY run of the job, not just this one: two sides at
        // one joint share ONE post, and which run is BILLED for it is decided
        // across runs (the taller fence first), so a call that saw only this
        // run would let every member keep its own post -- which is what the
        // office stopped doing at engine 2026.10.8, and the two must agree.
        val joins = EstimateEngine.joinAdjustments(repository.getFenceRuns(run.jobId), pixelsPerFoot)
        val suggestions = EstimateEngine.suggestQuantities(
            run = run,
            pixelsPerFoot = pixelsPerFoot,
            wastePercent = job.wastePercent,
            joinAdjustment = joins.forRun(run.syncId)
        )
        val built = EstimateEngine.buildLineItems(
            jobId = run.jobId,
            fenceRunId = run.id,
            run = run,
            suggestions = suggestions,
            catalog = catalog,
            preferredManufacturerId = job.preferredManufacturerId
        )
        if (built.items.isEmpty()) return false

        // The merge keeps edited lines, carries supplier quotes, and writes
        // nothing when the rebuild matches what is there -- the replace is a
        // delete-and-insert, and an equal rebuild still churned the cloud,
        // the audit log and every other phone: movement with no information
        // in it, which is how "the price kept changing by itself" felt even
        // when the numbers came back the same.
        return !repository.replaceAutoGeneratedLineItemsForRun(run.id, built.items).unchanged
    }

    /** What happened when a side's fence type changed. See [refreshAfterTypeChange]. */
    enum class TypeChangeResult {
        /** Nobody has priced this side yet, or this phone may not price. Nothing was owed. */
        NOT_PRICED,
        /** The side was re-priced from its new type's catalog rows. */
        REPRICED,
        /** Already in step -- the rebuild matched what was there. */
        UNCHANGED,
        /**
         * **Nothing in the catalog prices this type, so the old type's lines
         * were CLEARED.** The one case that has to be surfaced: see below.
         */
        CLEARED_NOTHING_PRICED
    }

    /**
     * Re-prices one side because its FENCE TYPE changed, and says what it did.
     *
     * WHY THIS EXISTS RATHER THAN A SECOND CALL TO [refreshRun]. Two reasons,
     * and the second is the whole point of the function.
     *
     * **1. Nothing re-priced a type change at all.** The only watcher in the
     * app is `SurveyViewModel.watchDrawingForRepricing`, and it lives on the
     * DRAWING screen; the type picker lives on RunEditScreen, whose view model
     * writes the row and stops. [pricingSignature] is the whole row, so
     * `fenceType` IS in it and the watcher WOULD have caught the change -- but
     * only if the drawing screen happened to be open at the time, and it
     * establishes its baseline from the first emission it sees, so a change
     * made on another screen is already baked in by the time it opens. So
     * changing a side from Vinyl to Wood left the vinyl panels, vinyl posts
     * and vinyl caps priced on it until somebody pressed Suggest Quantities.
     * Every surface said Wood. The money said vinyl.
     *
     * **2. An empty rebuild must not leave the OLD type's lines standing.**
     * [refreshRun] returns false on `built.items.isEmpty()`, which is right
     * for a drawing that moved (a catalog with nothing in it should not wipe
     * an estimate because a corner was dragged) and WRONG here: a wood side
     * carrying vinyl panel lines is not a stale display, it is a quote for a
     * fence nobody is building. Cleared instead, the same treatment this file
     * already gives an uncalibrated photo and a teardown run, and the caller
     * is told so it can say so on screen.
     *
     * Read against the live catalog on 2 Oct 2026 (read-only): all seven
     * buildable types hold rows for every role their takeoff asks for, so
     * [TypeChangeResult.CLEARED_NOTHING_PRICED] is not reachable on his data
     * today. It is reachable on a company that has only loaded one type's
     * price list, which is every company on its first week.
     */
    suspend fun refreshAfterTypeChange(
        repository: Repository,
        run: FenceRun,
        mayReprice: Boolean
    ): TypeChangeResult {
        if (!mayReprice) return TypeChangeResult.NOT_PRICED
        val priced = repository.getLineItems(run.jobId)
            .filter { it.fenceRunId == run.id && it.role != MaterialRole.NONE }
        // Same refusal as everywhere else: never invent an estimate for a side
        // nobody has priced. Changing the type of an unpriced side is free.
        if (priced.isEmpty()) return TypeChangeResult.NOT_PRICED

        val rewritten = refreshRun(repository, run, mayReprice = true)
        if (rewritten) return TypeChangeResult.REPRICED

        // refreshRun said no. It says no for three reasons, and only one of
        // them is "nothing to do": an equal rebuild. The other two -- an empty
        // build and a teardown/uncalibrated clear -- are told apart by
        // re-reading. A teardown or blocked side has already been cleared by
        // refreshRun itself, so a surviving auto-generated line here means the
        // rebuild produced nothing and the OLD type's lines are still standing.
        val after = repository.getLineItems(run.jobId)
            .filter { it.fenceRunId == run.id && it.role != MaterialRole.NONE }
        val stale = after.filter { it.isAutoGenerated }
        if (stale.isEmpty()) return TypeChangeResult.UNCHANGED

        val job = repository.getJob(run.jobId)
        val catalog = repository.getAllMaterialItems().filter { it.isActive }
        val pixelsPerFoot = job?.calibrationPixelsPerFoot ?: DrawingScale.PIXELS_PER_FOOT_GRID
        val rebuilt = if (job == null || catalog.isEmpty()) {
            emptyList()
        } else {
            val joins = EstimateEngine.joinAdjustments(repository.getFenceRuns(run.jobId), pixelsPerFoot)
            EstimateEngine.buildLineItems(
                jobId = run.jobId,
                fenceRunId = run.id,
                run = run,
                suggestions = EstimateEngine.suggestQuantities(
                    run = run,
                    pixelsPerFoot = pixelsPerFoot,
                    wastePercent = job.wastePercent,
                    joinAdjustment = joins.forRun(run.syncId)
                ),
                catalog = catalog,
                preferredManufacturerId = job.preferredManufacturerId
            ).items
        }
        if (rebuilt.isNotEmpty()) return TypeChangeResult.UNCHANGED
        repository.replaceAutoGeneratedLineItemsForRun(run.id, emptyList())
        return TypeChangeResult.CLEARED_NOTHING_PRICED
    }

    /**
     * The footage a run currently represents, used to decide whether the
     * drawing actually moved. Typed-in footage wins over the drawing, matching
     * how every other total on the job is worked out.
     */
    fun footageOf(run: FenceRun, pixelsPerFoot: Float?): Float {
        val manual = run.manualLinearFeet
        if (manual != null && manual > 0f) return manual
        val pxPerFt = pixelsPerFoot ?: DrawingScale.PIXELS_PER_FOOT_GRID
        return FenceGeometryEngine.analyze(
            FenceCodec.decodePoints(run.pointsEncoded), pxPerFt, run.closedLoop
        ).totalLinearFeet
    }
}
