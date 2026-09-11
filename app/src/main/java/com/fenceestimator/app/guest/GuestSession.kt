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
    /** Five minutes, exactly as the owner asked for. */
    const val DURATION_MS: Long = 5 * 60 * 1000L

    fun isActive(profile: BusinessProfile): Boolean = profile.guestSessionStartedAt != 0L

    /** Milliseconds left, floored at zero. Meaningless (and unused) when [isActive] is false. */
    fun remainingMs(profile: BusinessProfile, nowMs: Long = System.currentTimeMillis()): Long {
        if (!isActive(profile)) return 0L
        val elapsed = nowMs - profile.guestSessionStartedAt
        return (DURATION_MS - elapsed).coerceAtLeast(0L)
    }

    fun isExpired(profile: BusinessProfile, nowMs: Long = System.currentTimeMillis()): Boolean =
        isActive(profile) && remainingMs(profile, nowMs) <= 0L

    /** "4:32" style countdown for the banner -- honest down to the second, never hidden. */
    fun formatRemaining(remainingMs: Long): String {
        val totalSeconds = (remainingMs / 1000L).coerceAtLeast(0L)
        val minutes = totalSeconds / 60
        val seconds = totalSeconds % 60
        return "%d:%02d".format(minutes, seconds)
    }
}
