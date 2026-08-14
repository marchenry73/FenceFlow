package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.Employee
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.PayType
import com.fenceestimator.app.data.TimeEntry
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FenceGeometryEngine

/**
 * Works out what a crew member earned on a job under either pay model.
 *
 * Hours are always recorded, even for per-foot crews -- the clock is how the
 * office sees whether a job ran long, and comparing footage against hours is
 * what tells you if a per-foot rate is actually working out.
 */
object CrewPay {

    data class Earnings(
        val payType: PayType,
        val hours: Double,
        val feet: Double,
        val rate: Double,
        val amount: Double
    ) {
        /** What the crew member sees: the arithmetic, not just the total. */
        fun explain(): String = when (payType) {
            PayType.HOURLY ->
                "${"%.2f".format(hours)} hrs x $${"%.2f".format(rate)}/hr = $${"%.2f".format(amount)}"
            PayType.PER_FOOT ->
                "${"%.0f".format(feet)} ft x $${"%.2f".format(rate)}/ft = $${"%.2f".format(amount)}" +
                    if (hours > 0) "  (${"%.1f".format(hours)} hrs worked)" else ""
        }

        /** Effective hourly take, so a per-foot crew can see whether the rate is fair. */
        val effectiveHourly: Double get() = if (hours > 0) amount / hours else 0.0
    }

    fun forJob(
        employee: Employee?,
        timeEntries: List<TimeEntry>,
        runs: List<FenceRun>,
        pixelsPerFoot: Float
    ): Earnings {
        val hours = timeEntries.filter { !it.isRunning }.sumOf { it.hours }
        val feet = runs.sumOf { run ->
            val points = FenceCodec.decodePoints(run.pointsEncoded)
            if (points.size < 2) 0.0
            else FenceGeometryEngine.analyze(points, pixelsPerFoot, run.closedLoop)
                .totalLinearFeet.toDouble()
        }

        if (employee == null) {
            return Earnings(PayType.HOURLY, hours, feet, 0.0, 0.0)
        }

        return when (employee.payType) {
            PayType.HOURLY -> Earnings(
                payType = PayType.HOURLY,
                hours = hours,
                feet = feet,
                rate = employee.hourlyRate,
                // Uses the rate stored on each entry, so a raise doesn't
                // retroactively change what past work cost.
                amount = timeEntries.filter { !it.isRunning }.sumOf { it.laborCost }
            )
            PayType.PER_FOOT -> Earnings(
                payType = PayType.PER_FOOT,
                hours = hours,
                feet = feet,
                rate = employee.perFootRate,
                amount = feet * employee.perFootRate
            )
        }
    }
}
