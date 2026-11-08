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
     * How long a guest demo lasts when the server granted it. The single
     * source of this number on the phone, and it must agree with FULL_MS in
     * supabase/functions/guest-trial -- the server is what actually decides,
     * and this is the fallback used before the first answer arrives.
     *
     * Fifteen minutes, the owner's decision on 7 Nov 2026, replacing the hour
     * he chose earlier. The reason recorded for the hour still stands and is
     * worth knowing when this is next revisited: five minutes "was not long
     * enough to walk through a job, draw a fence and look at the money, which
     * is the whole point of the demo."
     */
    const val DURATION_MS: Long = 15 * 60 * 1000L

    /**
     * What the phone may award itself with no signal, when the server cannot
     * be asked whether this device has already had its demo.
     *
     * Shorter on purpose: an unverified demo is the one somebody could repeat
     * by staying offline, so it is worth less. The server subtracts whatever
     * was used here from the full window the first time the phone reaches it,
     * so airplane mode does not buy extra minutes.
     */
    const val OFFLINE_DURATION_MS: Long = 5 * 60 * 1000L

    /**
     * The window THIS device was actually given, which is not a constant: 15
     * minutes online, 5 offline, or the remainder of 15 for a phone that
     * started offline and has since reached the server.
     *
     * Falls back to [DURATION_MS] for a demo started before the grant was
     * stored, so an in-flight demo on an updating phone keeps running instead
     * of ending the instant the app restarts.
     */
    fun grantedMs(profile: BusinessProfile): Long =
        if (profile.guestSessionGrantedMs > 0L) profile.guestSessionGrantedMs else DURATION_MS

    /**
     * The duration in whole minutes, for the one sentence that tells a visitor
     * how long they have before their demo is cleared.
     *
     * Derived, never written out again -- and in MINUTES, not hours. This was
     * (DURATION_MS / 3_600_000).coerceAtLeast(1), which floors a 15-minute
     * demo to 1 and makes every caption in all three languages promise an
     * hour. The warning that used to sit here was earned: "when the length
     * changed the constant moved and all three captions went on promising the
     * old figure." A sentence with no number in it cannot be left behind.
     */
    val durationMinutes: Int get() = (DURATION_MS / 60_000L).toInt().coerceAtLeast(1)

    fun isActive(profile: BusinessProfile): Boolean = profile.guestSessionStartedAt != 0L

    /** Milliseconds left, floored at zero. Meaningless (and unused) when [isActive] is false. */
    fun remainingMs(profile: BusinessProfile, nowMs: Long = System.currentTimeMillis()): Long {
        if (!isActive(profile)) return 0L
        val elapsed = nowMs - profile.guestSessionStartedAt
        // Against what this device was GRANTED, not against the constant: a
        // phone that started offline has five minutes, not fifteen, and
        // counting it down from fifteen would hand it the window the server
        // deliberately withheld.
        return (grantedMs(profile) - elapsed).coerceAtLeast(0L)
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
