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

    /**
     * The rates a job is costed against. Defaults match a typical crew, but
     * every company works at its own pace -- a schedule built on someone
     * else's numbers is a schedule that slips -- so all of it is editable in
     * Settings and carried here rather than hardcoded.
     */
    data class Rates(
        val feetPerDay: Double = 125.0,
        val workdayHours: Double = 8.0,
        val breakHoursPerDay: Double = 1.0,
        val hoursPerGate: Double = 1.5,
        val hoursPerTree: Double = 0.25,
        val hoursPerObstacle: Double = 0.5,
        val hoursPerCorner: Double = 0.4,
        val setupHours: Double = 1.0,
        val teardownHoursPerFoot: Double = 0.02
    ) {
        /** Hours of actual installing in a day, once breaks are taken out. */
        val installHoursPerDay: Double
            get() = (workdayHours - breakHoursPerDay).coerceAtLeast(1.0)
    }

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
        val teardownHours: Double,
        val obstacleHours: Double = 0.0,
        val trees: Int = 0,
        val obstacles: Int = 0,
        /** Install hours per day after breaks, used to turn hours into days. */
        val installHoursPerDay: Double = 7.0
    ) {
        /** Working days, counting only the hours a crew actually installs in. */
        val days: Double get() = totalHours / installHoursPerDay.coerceAtLeast(1.0)

        fun summary(): String = buildString {
            append("${"%.2f".format(totalHours)} hrs")
            if (days > 1.2) append(" (~${"%.1f".format(days)} days)")
            append(" — ${"%.0f".format(feet)} ft")
            if (corners > 0) append(", $corners corners")
            if (gates > 0) append(", $gates gate${if (gates == 1) "" else "s"}")
            if (trees > 0) append(", $trees tree${if (trees == 1) "" else "s"}")
            if (obstacles > 0) append(", $obstacles obstacle${if (obstacles == 1) "" else "s"}")
            if (teardownHours > 0) append(", teardown")
        }
    }

    /**
     * @param markers site markers on this job. Trees and obstacles on the fence
     *   line are real hours -- a tree the crew has to work around or clear is
     *   not free, and pretending it is produces a schedule that slips on the
     *   first job with a hedge in the way.
     */
    fun estimate(
        job: Job,
        runs: List<FenceRun>,
        pixelsPerFoot: Float,
        rates: Rates = Rates(),
        markers: List<com.fenceestimator.app.data.SiteMarker> = emptyList()
    ): Breakdown {
        var feet = 0.0
        var corners = 0
        var gates = 0
        var weightedFenceHours = 0.0

        runs.forEach { run ->
            // Typed-in footage counts the same as a drawing. This used to look
            // at the drawing only, so a run quoted by typing its length produced
            // no hours at all -- and changing that length changed nothing.
            // Smart-cast rather than !!: the two branches are decided by the
            // same condition, and a later edit that separated them would turn
            // those assertions into a crash.
            val manual = run.manualLinearFeet?.takeIf { it > 0f }
            val points = FenceCodec.decodePoints(run.pointsEncoded)

            val geometry = if (manual == null) {
                if (points.size < 2) return@forEach
                FenceGeometryEngine.analyze(points, pixelsPerFoot, run.closedLoop)
            } else null

            val runFeet = manual?.toDouble() ?: geometry?.totalLinearFeet?.toDouble() ?: return@forEach
            val runGates = FenceCodec.decodeGates(run.gatesEncoded).size

            feet += runFeet
            corners += geometry?.cornerCount ?: run.manualCornerCount
            gates += runGates

            // Scale this run's footage against this company's own rate, weighted
            // by how labour-intensive its fence type is.
            weightedFenceHours +=
                (runFeet / rates.feetPerDay.coerceAtLeast(1.0)) *
                    rates.installHoursPerDay * typeFactor(run.fenceType)
        }

        // Only markers that actually cost time. A house or a driveway is drawn
        // for orientation; a tree or a slope is work.
        val trees = markers.count { it.kind == com.fenceestimator.app.data.SiteMarkerKind.TREE }
        val obstacles = markers.count {
            it.kind in setOf(
                com.fenceestimator.app.data.SiteMarkerKind.OBSTACLE,
                com.fenceestimator.app.data.SiteMarkerKind.SLOPE,
                com.fenceestimator.app.data.SiteMarkerKind.EXISTING_FENCE
            )
        }

        val cornerHours = corners * rates.hoursPerCorner
        val gateHours = gates * rates.hoursPerGate
        val obstacleHours = trees * rates.hoursPerTree + obstacles * rates.hoursPerObstacle
        val teardownHours = if (job.teardownEnabled) feet * rates.teardownHoursPerFoot else 0.0

        val raw = if (feet <= 0.0) 0.0
        else rates.setupHours + weightedFenceHours + cornerHours + gateHours +
            obstacleHours + teardownHours
        // Two decimals. A figure like 12.833333 hours reads as false precision
        // on an estimate that is a rule of thumb to begin with.
        val total = kotlin.math.round(raw * 100.0) / 100.0

        return Breakdown(
            totalHours = total,
            feet = feet,
            corners = corners,
            gates = gates,
            obstacleHours = obstacleHours,
            trees = trees,
            obstacles = obstacles,
            installHoursPerDay = rates.installHoursPerDay,
            fenceHours = weightedFenceHours,
            cornerHours = cornerHours,
            gateHours = gateHours,
            teardownHours = teardownHours
        )
    }
}
