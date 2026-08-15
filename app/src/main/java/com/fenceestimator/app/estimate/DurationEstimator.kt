package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FenceGeometryEngine

/**
 * Works out how long a job should take, anchored to the contractor's own
 * benchmark: 125 ft of standard fence in 8 hours.
 *
 * Everything else scales from that and is then adjusted for the things that
 * actually slow a crew down -- corners, gates, teardown, and fence types that
 * are more work per foot. It is a starting number the user can overwrite, not
 * a promise.
 */
object DurationEstimator {

    /** The contractor's benchmark: 125 ft in an 8-hour day. */
    private const val BASELINE_FEET = 125.0
    private const val BASELINE_HOURS = 8.0

    /** Each corner means extra layout, bracing, and a deeper hole. */
    private const val HOURS_PER_CORNER = 0.4

    /** Hanging and squaring a gate is slow work relative to its width. */
    private const val HOURS_PER_GATE = 1.0

    /** Pulling an old fence and hauling it off, per foot. */
    private const val TEARDOWN_HOURS_PER_FOOT = 0.02

    /** Mobilising, unloading, and the final walkthrough, regardless of size. */
    private const val SETUP_HOURS = 1.0

    /**
     * How much slower each type is per foot than the baseline. Wood is built
     * stick by stick on site; vinyl and aluminum panels drop in.
     */
    private fun typeFactor(type: FenceType): Double = when (type) {
        FenceType.VINYL, FenceType.ALUMINUM -> 1.0
        FenceType.CHAIN_LINK -> 0.9
        FenceType.SPLIT_RAIL -> 0.8
        FenceType.WOOD, FenceType.COMPOSITE -> 1.3
        FenceType.ORNAMENTAL_IRON -> 1.4
        FenceType.UNIVERSAL -> 1.0
    }

    data class Breakdown(
        val totalHours: Double,
        val feet: Double,
        val corners: Int,
        val gates: Int,
        val fenceHours: Double,
        val cornerHours: Double,
        val gateHours: Double,
        val teardownHours: Double
    ) {
        /** Crews work in days, not decimals -- 8-hour days, rounded up. */
        val days: Double get() = totalHours / 8.0

        fun summary(): String = buildString {
            append("${"%.2f".format(totalHours)} hrs")
            if (days > 1.2) append(" (~${"%.1f".format(days)} days)")
            append(" — ${"%.0f".format(feet)} ft")
            if (corners > 0) append(", $corners corners")
            if (gates > 0) append(", $gates gate${if (gates == 1) "" else "s"}")
            if (teardownHours > 0) append(", teardown")
        }
    }

    fun estimate(job: Job, runs: List<FenceRun>, pixelsPerFoot: Float): Breakdown {
        var feet = 0.0
        var corners = 0
        var gates = 0
        var weightedFenceHours = 0.0

        runs.forEach { run ->
            // Typed-in footage counts the same as a drawing. This used to look
            // at the drawing only, so a run quoted by typing its length produced
            // no hours at all -- and changing that length changed nothing.
            val manual = run.manualLinearFeet
            val usingManual = manual != null && manual > 0f

            val points = FenceCodec.decodePoints(run.pointsEncoded)
            if (!usingManual && points.size < 2) return@forEach

            val geometry = if (usingManual) null
            else FenceGeometryEngine.analyze(points, pixelsPerFoot, run.closedLoop)

            val runFeet = if (usingManual) manual!!.toDouble()
            else geometry!!.totalLinearFeet.toDouble()
            val runGates = FenceCodec.decodeGates(run.gatesEncoded).size

            feet += runFeet
            corners += if (usingManual) run.manualCornerCount else geometry!!.cornerCount
            gates += runGates

            // Scale this run's footage against the baseline rate, weighted by
            // how labour-intensive its fence type is.
            weightedFenceHours += (runFeet / BASELINE_FEET) * BASELINE_HOURS * typeFactor(run.fenceType)
        }

        val cornerHours = corners * HOURS_PER_CORNER
        val gateHours = gates * HOURS_PER_GATE
        val teardownHours = if (job.teardownEnabled) feet * TEARDOWN_HOURS_PER_FOOT else 0.0

        val raw = if (feet <= 0.0) 0.0
        else SETUP_HOURS + weightedFenceHours + cornerHours + gateHours + teardownHours
        // Two decimals. A figure like 12.833333 hours reads as false precision
        // on an estimate that is a rule of thumb to begin with.
        val total = kotlin.math.round(raw * 100.0) / 100.0

        return Breakdown(
            totalHours = total,
            feet = feet,
            corners = corners,
            gates = gates,
            fenceHours = weightedFenceHours,
            cornerHours = cornerHours,
            gateHours = gateHours,
            teardownHours = teardownHours
        )
    }
}
