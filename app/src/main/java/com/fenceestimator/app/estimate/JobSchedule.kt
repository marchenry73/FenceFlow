package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.Job
import java.util.Calendar
import java.util.concurrent.TimeUnit

/**
 * How many days a job takes, and whether today is meant to be the last one.
 *
 * "Estimated hours" on its own does not answer the question a crew actually
 * has, which is whether they are finishing tonight or coming back tomorrow.
 * Eighteen hours means nothing at a fence line; "day two of three" means
 * everything -- it decides whether they start the gates, whether the customer
 * gets told, and whether the next customer's date is still good.
 *
 * Days come from the company's own working hours, because a schedule built on
 * somebody else's numbers is a schedule that slips.
 */
object JobSchedule {

    data class Plan(
        val totalDays: Int,
        /** 1-based. Zero when the job is not scheduled or the day is outside it. */
        val dayNumber: Int,
        val isFinalDay: Boolean,
        val isScheduledToday: Boolean,
        /** Midnight on the day this job is expected to finish. */
        val expectedFinish: Long?
    ) {
        /** What to tell the crew, in the terms they think in. */
        val crewSummary: String
            get() = when {
                totalDays <= 1 -> "One day. Expected to finish today."
                dayNumber <= 0 -> "$totalDays days of work."
                isFinalDay -> "Day $dayNumber of $totalDays -- expected to finish today."
                else -> "Day $dayNumber of $totalDays -- not expected to finish today."
            }
    }

    /**
     * @param workdayHours the company's own working day, less breaks.
     */
    fun plan(job: Job, workdayHours: Double, today: Long = System.currentTimeMillis()): Plan {
        val perDay = workdayHours.coerceAtLeast(1.0)
        // Rounded up, because half a day of remaining work is still a day the
        // crew have to turn up for.
        val totalDays = Math.ceil(job.estimatedDurationHours / perDay).toInt().coerceAtLeast(1)

        val start = job.scheduledDate ?: return Plan(totalDays, 0, false, false, null)

        val startDay = startOfDay(start)
        val todayDay = startOfDay(today)
        val elapsed = TimeUnit.MILLISECONDS.toDays(todayDay - startDay).toInt()
        val dayNumber = if (elapsed in 0 until totalDays) elapsed + 1 else 0

        return Plan(
            totalDays = totalDays,
            dayNumber = dayNumber,
            isFinalDay = dayNumber == totalDays,
            isScheduledToday = todayDay == startDay,
            expectedFinish = addDays(startDay, totalDays - 1)
        )
    }

    /**
     * True when the expected finish has passed and the job is not done.
     *
     * The moment worth catching, because it is the moment the NEXT customer's
     * date stops being true -- and nobody finds that out until the crew fail to
     * turn up.
     */
    fun hasOverrun(job: Job, workdayHours: Double, today: Long = System.currentTimeMillis()): Boolean {
        if (job.status == com.fenceestimator.app.data.JobStatus.COMPLETED) return false
        val finish = plan(job, workdayHours, today).expectedFinish ?: return false
        return startOfDay(today) > finish
    }

    /** Days past the expected finish, for wording the message to the next customer. */
    fun daysOverrun(job: Job, workdayHours: Double, today: Long = System.currentTimeMillis()): Int {
        val finish = plan(job, workdayHours, today).expectedFinish ?: return 0
        val over = TimeUnit.MILLISECONDS.toDays(startOfDay(today) - finish).toInt()
        return over.coerceAtLeast(0)
    }

    /**
     * The next job that would be hit by this one running long.
     *
     * Only jobs scheduled AFTER this one and not yet finished. A job already
     * completed cannot be pushed, and one scheduled earlier is not downstream
     * of this delay.
     */
    fun nextAffected(overrunning: Job, all: List<Job>, workdayHours: Double): Job? {
        val finish = plan(overrunning, workdayHours).expectedFinish ?: return null
        return all
            .filter { it.id != overrunning.id }
            .filter { it.status != com.fenceestimator.app.data.JobStatus.COMPLETED }
            .filter { (it.scheduledDate ?: Long.MAX_VALUE) > finish }
            .minByOrNull { it.scheduledDate ?: Long.MAX_VALUE }
    }

    fun startOfDay(millis: Long): Long = Calendar.getInstance().apply {
        timeInMillis = millis
        set(Calendar.HOUR_OF_DAY, 0)
        set(Calendar.MINUTE, 0)
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
    }.timeInMillis

    fun addDays(millis: Long, days: Int): Long = Calendar.getInstance().apply {
        timeInMillis = millis
        add(Calendar.DAY_OF_YEAR, days)
    }.timeInMillis
}
