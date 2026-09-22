package com.fenceestimator.app.estimate

import com.fenceestimator.app.cloud.SessionState
import com.fenceestimator.app.data.FenceRun
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
    suspend fun refreshRun(repository: Repository, run: FenceRun, mayReprice: Boolean): Boolean {
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
        if (takeoffLines.isEmpty()) return false

        val job = repository.getJob(run.jobId) ?: return false
        val catalog = repository.getAllMaterialItems().filter { it.isActive }
        if (catalog.isEmpty()) return false

        // The job's calibration, or the grid's fixed 20 px/ft -- the same
        // fallback price-job applies (load.ts buildPricingInput), so the
        // office re-pricing this job reaches the same takeoff.
        val pixelsPerFoot = job.calibrationPixelsPerFoot ?: DrawingScale.PIXELS_PER_FOOT_GRID

        val suggestions = EstimateEngine.suggestQuantities(
            run = run,
            pixelsPerFoot = pixelsPerFoot,
            wastePercent = job.wastePercent
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
