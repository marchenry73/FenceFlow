package com.fenceestimator.app.notify

import android.content.Context
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.data.isWon
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Tells you when a job has run past the time it was supposed to take.
 *
 * A job overrunning is the earliest signal that something is wrong -- the crew
 * hit rock, the yard was longer than measured, someone didn't show. Left
 * unflagged, the first anyone hears is the customer ringing to ask why the
 * fence isn't finished. Flagged the same afternoon, it's a phone call and a
 * rescheduled morning.
 *
 * Deliberately quiet: one notification per job per day. A crew that gets
 * pinged every fifteen minutes about the same job stops reading any of them,
 * and then the alert that mattered goes unread too.
 */
class OverdueWatcher(
    private val scope: CoroutineScope,
    private val repository: Repository,
    private val context: Context
) {

    /** jobId -> the day (epoch-day) we last warned about it. */
    private val warnedOn = mutableMapOf<Long, Long>()

    fun start() {
        scope.launch {
            while (true) {
                runCatching { checkOnce() }
                delay(CHECK_INTERVAL_MS)
            }
        }
    }

    /** Exposed so the app can check immediately on launch rather than waiting an hour. */
    suspend fun checkOnce() {
        if (!Notifications.hasPermission(context)) return

        val now = System.currentTimeMillis()
        val today = now / DAY_MS

        repository.getAllJobs().forEach { job ->
            val due = overdueSince(job, now) ?: return@forEach
            if (warnedOn[job.id] == today) return@forEach
            warnedOn[job.id] = today

            val hoursOver = ((now - due) / 3_600_000.0)
            Notifications.show(
                context = context,
                id = OVERDUE_NOTIFICATION_BASE + job.id.toInt(),
                title = "Running late: ${job.customerName.ifBlank { "job #${job.id}" }}",
                body = buildString {
                    append("Should have finished ")
                    append(
                        if (hoursOver < 24) "${"%.0f".format(hoursOver)} hours ago"
                        else "${"%.0f".format(hoursOver / 24)} day(s) ago"
                    )
                    append(". ")
                    append(
                        if (job.overrunReason.isBlank() && job.blockedReason.isBlank())
                            "Note what held it up so the customer can be told."
                        else "Held up: ${job.overrunReason.ifBlank { job.blockedReason }.take(60)}"
                    )
                },
                channelId = Notifications.CHANNEL_CREW
            )
        }
    }

    /**
     * When this job should have been done, or null if it isn't late.
     *
     * Only scheduled, accepted work counts. A draft estimate with a date on it
     * isn't late -- nobody promised to build it yet -- and a job already marked
     * complete obviously isn't either.
     */
    private fun overdueSince(job: Job, now: Long): Long? {
        if (job.status == JobStatus.COMPLETED) return null
        if (!job.status.isWon) return null
        val scheduled = job.scheduledDate ?: return null

        val allowedMs = (job.estimatedDurationHours.coerceAtLeast(1.0) * 3_600_000L).toLong()
        // Measure from the start of the scheduled day. The date carries no time
        // of day, and assuming midnight would call every job late by breakfast.
        val startOfWork = scheduled + WORKDAY_START_MS
        val due = startOfWork + allowedMs
        return if (now > due) due else null
    }

    private companion object {
        const val CHECK_INTERVAL_MS = 60 * 60 * 1000L
        const val DAY_MS = 24 * 60 * 60 * 1000L
        /** Assume work starts at 8am on the scheduled day. */
        const val WORKDAY_START_MS = 8 * 60 * 60 * 1000L
        /** Offset so overdue alerts can't collide with other notification ids. */
        const val OVERDUE_NOTIFICATION_BASE = 900_000
    }
}
