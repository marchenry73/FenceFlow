package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.Job

/**
 * Whether it is safe, and legal, to put a post hole in the ground.
 *
 * A utility locate has three dates that matter: when it was called in, the
 * earliest anyone may dig, and when it stops being valid. Digging outside that
 * window is the most expensive mistake available in fencing -- a struck gas
 * line is an evacuation, a struck fibre is a five-figure invoice, and both
 * land on the contractor rather than the utility.
 *
 * Every contractor knows this. What they lose track of is the date, on the
 * third job of a busy fortnight, when the ticket was called two weeks ago and
 * nobody remembers whether it is still good.
 *
 * The wait and the validity period differ by state and by utility, so both are
 * recorded from what the locate service actually said rather than calculated
 * from a rule this app invented. A confidently wrong "clear to dig" would be
 * worse than no feature at all.
 */
object LocateTicket {

    enum class State {
        /** No ticket recorded. Not a judgement -- some jobs need no digging. */
        NONE,

        /** Called in, but the wait has not elapsed. Nobody may dig yet. */
        WAITING,

        /** Within the window. Marks are good and digging is allowed. */
        CLEAR,

        /** Past its expiry. It has to be called again before any digging. */
        EXPIRED
    }

    fun stateOf(job: Job, now: Long = System.currentTimeMillis()): State = when {
        job.locateTicketNo.isBlank() -> State.NONE
        job.locateExpiresAt?.let { it <= now } == true -> State.EXPIRED
        job.locateDigAfter?.let { it > now } == true -> State.WAITING
        else -> State.CLEAR
    }

    /** Whole days until expiry; negative once past. Null when there is no expiry. */
    fun daysUntilExpiry(job: Job, now: Long = System.currentTimeMillis()): Int? =
        job.locateExpiresAt?.let { ((it - now) / 86_400_000L).toInt() }

    /**
     * True when the ticket is still valid but not for much longer.
     *
     * Worth saying before the crew is standing in the yard rather than after.
     */
    fun expiringSoon(job: Job, now: Long = System.currentTimeMillis()): Boolean {
        if (stateOf(job, now) != State.CLEAR) return false
        val days = daysUntilExpiry(job, now) ?: return false
        return days <= EXPIRY_WARNING_DAYS
    }

    /**
     * What to tell somebody, in the words that matter to them.
     *
     * Written for whoever is about to dig, not for whoever filed the ticket.
     */
    fun message(job: Job, now: Long = System.currentTimeMillis()): String =
        when (stateOf(job, now)) {
            State.NONE -> "No utility locate on this job. Call 811 before anyone digs."
            State.WAITING ->
                "Locate called in, but the wait is not up yet. Nobody digs before the " +
                    "date below -- that wait is the law, not a guideline."
            State.EXPIRED ->
                "This locate has expired. It has to be called in again before any " +
                    "digging. Marks on the ground may no longer be accurate."
            State.CLEAR -> {
                val days = daysUntilExpiry(job, now)
                when {
                    days == null -> "Clear to dig."
                    days <= 0 -> "Clear to dig -- but this ticket expires today."
                    days <= EXPIRY_WARNING_DAYS ->
                        "Clear to dig. Expires in $days day${if (days == 1) "" else "s"} -- " +
                            "call it in again if the job runs past that."
                    else -> "Clear to dig."
                }
            }
        }

    /**
     * Whether a job should be held back from being scheduled or started.
     *
     * Deliberately not a hard block anywhere in the app. Some jobs genuinely
     * need no digging -- a gate rehung on existing posts, a panel replaced --
     * and an app that refuses to let a contractor work is an app they stop
     * using. It warns loudly and lets them decide.
     */
    fun shouldWarnBeforeDigging(job: Job, now: Long = System.currentTimeMillis()): Boolean =
        stateOf(job, now) != State.CLEAR

    /** Below this many days remaining, say so before somebody is on site. */
    const val EXPIRY_WARNING_DAYS = 3
}
