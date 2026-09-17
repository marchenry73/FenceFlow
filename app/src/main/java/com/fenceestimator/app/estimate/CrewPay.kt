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
        /** Hours that have been signed off. These are what [amount] is built from. */
        val hours: Double,
        val feet: Double,
        val rate: Double,
        val amount: Double,
        /**
         * Finished shifts still waiting on a manager.
         *
         * Carried separately rather than folded in or dropped. Folding it in
         * would promise pay for hours nobody has checked; dropping it silently
         * is how a crew member concludes the app lost their day.
         */
        val hoursAwaitingApproval: Double = 0.0,
        /**
         * True when work was actually approved (or, for per-foot, actually
         * built) but the rate behind it has never been set to anything but
         * the field default of zero.
         *
         * No employee row in this database currently has a rate, so without
         * this flag [amount] is always 0.0 -- and a crew member reading
         * "$0.00" after a full day cannot tell "you earned nothing" (a real,
         * if unusual, answer) from "nobody has told the app what you make"
         * (a payroll setup gap). Those are different problems and the screen
         * that shows [amount] must say which one this is.
         */
        val rateIsUnset: Boolean = false,
        /** Per-foot only: the job's whole built footage, before it is split. */
        val jobFeet: Double = feet,
        /** Per-foot only: how many PER_FOOT workers share [jobFeet] evenly. */
        val splitAmong: Int = 1,
        /**
         * Per-foot only: the job is not COMPLETED yet, so [amount] is 0 and
         * [projectedAmount] is what it will pay once it is. Footage on an open
         * job still moves (change orders, field corrections), so it is not
         * pay until the job is finished.
         */
        val awaitingCompletion: Boolean = false
    ) {
        /** What the crew member sees: the arithmetic, not just the total. */
        fun explain(): String = when (payType) {
            PayType.HOURLY ->
                "${"%.2f".format(hours)} hrs x $${"%.2f".format(rate)}/hr = $${"%.2f".format(amount)}"
            PayType.PER_FOOT ->
                (if (splitAmong > 1) "${"%.0f".format(jobFeet)} ft / $splitAmong = " else "") +
                "${"%.0f".format(feet)} ft x $${"%.2f".format(rate)}/ft = " +
                "$${"%.2f".format(if (awaitingCompletion) projectedAmount else amount)}" +
                    if (hours > 0) "  (${"%.1f".format(hours)} hrs worked)" else ""
        }

        /** Effective hourly take, so a per-foot crew can see whether the rate is fair. */
        val effectiveHourly: Double get() = if (hours > 0) amount / hours else 0.0

        /** Per-foot: what this share pays once the job is completed. */
        val projectedAmount: Double get() = feet * rate
    }

    /**
     * One PER_FOOT worker's feet on a job: the job's built footage split
     * evenly among the PER_FOOT workers who worked it.
     *
     * [perFootWorkers] below 1 (unknown, or a server answer that has not
     * arrived yet) counts as 1 -- the person asking is paid by the foot, so
     * there is at least one.
     */
    fun perFootShareFeet(jobFeet: Double, perFootWorkers: Int): Double {
        if (jobFeet <= 0.0) return 0.0
        return jobFeet / perFootWorkers.coerceAtLeast(1)
    }

    /**
     * Per-foot pay for one worker on one job. Only a COMPLETED job pays --
     * ACCEPTED means sold, not built, so its footage can still change.
     */
    fun perFootPay(jobFeet: Double, perFootWorkers: Int, rate: Double, jobCompleted: Boolean): Double =
        if (!jobCompleted || rate <= 0.0) 0.0 else perFootShareFeet(jobFeet, perFootWorkers) * rate

    fun forJob(
        employee: Employee?,
        timeEntries: List<TimeEntry>,
        runs: List<FenceRun>,
        pixelsPerFoot: Float,
        /** PER_FOOT workers sharing this job's footage (server: per_foot_crew_count). */
        perFootCrewCount: Int = 1,
        /** Job status is COMPLETED. Per-foot pay is only earned on a finished job. */
        jobCompleted: Boolean = true
    ): Earnings {
        // Approved hours only, on both sides of the figure.
        //
        // Summing raw hours here while the amount came from laborCost -- which
        // only counts approved time -- put hours and dollars on the same card
        // that contradicted each other: five hours worked, nothing earned.
        // Pay is what has been signed off, so both come from the same place.
        val approved = timeEntries.filter { it.isApproved }
        val hours = approved.sumOf { it.payableHours }
        /** Finished but not yet signed off -- shown separately so it is not simply missing. */
        val awaitingApproval = timeEntries.filter { it.isAwaitingApproval }.sumOf { it.hours }
        // A run quoted by typing its length (manualLinearFeet) has no
        // drawing to measure -- falling through to 0 ft here would pay a
        // per-foot crew nothing for a job they actually built, just because
        // nobody ever drew it on screen. CrewJobScreen's own "what you're
        // building" tally uses the same manual-length fallback for the same
        // reason; this has to match it or the two figures on one screen
        // would disagree about how much fence exists.
        val feet = runs.sumOf { run -> builtFeet(run, pixelsPerFoot) }

        if (employee == null) {
            return Earnings(PayType.HOURLY, hours, feet, 0.0, 0.0, awaitingApproval)
        }

        return when (employee.payType) {
            PayType.HOURLY -> Earnings(
                payType = PayType.HOURLY,
                hours = hours,
                feet = feet,
                rate = employee.hourlyRate,
                // Uses the rate stored on each entry, so a raise doesn't
                // retroactively change what past work cost.
                amount = approved.sumOf { it.laborCost },
                hoursAwaitingApproval = awaitingApproval,
                rateIsUnset = employee.hourlyRate <= 0.0 && hours > 0.0
            )
            PayType.PER_FOOT -> Earnings(
                payType = PayType.PER_FOOT,
                hours = hours,
                feet = perFootShareFeet(feet, perFootCrewCount),
                jobFeet = feet,
                splitAmong = perFootCrewCount.coerceAtLeast(1),
                awaitingCompletion = !jobCompleted,
                rate = employee.perFootRate,
                // Footage actually built, from the survey (or its manual-length
                // fallback) -- never what the customer was quoted. A change
                // order or a field correction moves what got built without
                // ever touching the original quote, and pay has to follow the
                // fence in the ground, not the number on the estimate.
                amount = perFootPay(feet, perFootCrewCount, employee.perFootRate, jobCompleted),
                hoursAwaitingApproval = awaitingApproval,
                rateIsUnset = employee.perFootRate <= 0.0 && feet > 0.0
            )
        }
    }

    /** Linear feet for one run: measured from the drawing, or the manual length when there is no drawing. */
    private fun builtFeet(run: FenceRun, pixelsPerFoot: Float): Double {
        val manual = run.manualLinearFeet
        if (manual != null && manual > 0f) return manual.toDouble()
        val points = FenceCodec.decodePoints(run.pointsEncoded)
        if (points.size < 2) return 0.0
        return FenceGeometryEngine.analyze(points, pixelsPerFoot, run.closedLoop).totalLinearFeet.toDouble()
    }
}
