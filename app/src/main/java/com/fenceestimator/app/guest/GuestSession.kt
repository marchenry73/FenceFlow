package com.fenceestimator.app.guest

import com.fenceestimator.app.data.BusinessProfile

/**
 * The guest countdown, as pure math over [BusinessProfile.guestSessionStartedAt].
 *
 * Deliberately stateless: the start time lives in SettingsStore (so it
 * survives the process being killed), and this object only ever answers
 * "given that start time and the current clock, where are we." Nothing here
 * remembers anything between calls, so there is no separate copy of the
 * clock that could drift from the one actually persisted.
 */
object GuestSession {
    /**
     * How long a guest demo lasts. The single source of this number.
     *
     * An hour, which is what the owner asked for after trying the first
     * version: five minutes was not long enough to walk through a job, draw a
     * fence and look at the money, which is the whole point of the demo.
     *
     * Every other statement of the duration is derived from this constant --
     * see [durationHours] for why the sentences that describe it must not spell
     * it out again.
     */
    const val DURATION_MS: Long = 60 * 60 * 1000L

    /**
     * The duration in whole hours, for the one sentence that tells a visitor
     * how long they have before their demo is cleared.
     *
     * Derived, never written out again. The last change to the duration left
     * the constant and three translated captions disagreeing, because the
     * captions each spelled the number out in their own file and nobody edits
     * those three files together. A caption that asks for this instead cannot
     * be left behind, because there is no number in it to forget.
     */
    val durationHours: Int get() = (DURATION_MS / 3_600_000L).toInt().coerceAtLeast(1)

    fun isActive(profile: BusinessProfile): Boolean = profile.guestSessionStartedAt != 0L

    /** Milliseconds left, floored at zero. Meaningless (and unused) when [isActive] is false. */
    fun remainingMs(profile: BusinessProfile, nowMs: Long = System.currentTimeMillis()): Long {
        if (!isActive(profile)) return 0L
        val elapsed = nowMs - profile.guestSessionStartedAt
        return (DURATION_MS - elapsed).coerceAtLeast(0L)
    }

    fun isExpired(profile: BusinessProfile, nowMs: Long = System.currentTimeMillis()): Boolean =
        isActive(profile) && remainingMs(profile, nowMs) <= 0L

    /**
     * Countdown text for the banner -- honest down to the second, never hidden.
     *
     * Hours are shown as hours once there is one. The minutes-and-seconds form
     * was written for a five-minute demo; left alone, an hour-long one opens on
     * "60:00", which reads as a broken clock rather than as an hour.
     */
    fun formatRemaining(remainingMs: Long): String {
        val totalSeconds = (remainingMs / 1000L).coerceAtLeast(0L)
        val hours = totalSeconds / 3600
        val minutes = (totalSeconds % 3600) / 60
        val seconds = totalSeconds % 60
        return if (hours > 0) "%d:%02d:%02d".format(hours, minutes, seconds)
        else "%d:%02d".format(minutes, seconds)
    }
}
