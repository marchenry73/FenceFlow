package com.fenceestimator.app.ui.crew

import android.content.Context

/**
 * What THIS crew member said about a specific hours correction, kept on the
 * phone.
 *
 * `acknowledge_my_shift` and `dispute_my_shift` (see supabase_shift_dispute.sql)
 * are what actually record an answer -- the moment either RPC returns
 * touched = true, the server has it. What lives here is only this device's
 * own memory of having already asked, so:
 *   1. the same correction cannot be answered twice from this phone, and
 *   2. the answer can be shown back without another round trip.
 *
 * Same shape as [CrewAttentionAckStore] and for the same reason: there is no
 * local Room column for correction_seen_at / correction_disputed_at /
 * dispute_note, because time_entries has not been extended to sync them down
 * from Supabase. There is nowhere durable and synced to read "already
 * answered" back from, so a reinstall forgets it and a second device has no
 * way to know one of them already replied -- calling either RPC again from
 * another device is harmless (acknowledge is a no-op past the first call;
 * dispute just overwrites its own note and timestamp), but the UI on that
 * other device would wrongly offer the choice again. Fixing that for real
 * needs the columns this store stands in for.
 *
 * Keyed by [CrewAttentionItem.key], not just the shift's id, so a shift the
 * office corrects AGAIN -- a new correctedAt, a new key -- is answerable
 * again instead of staying stuck on a stale "you already replied".
 *
 * Unlike [CrewAttentionAckStore], this carries no cap on how many keys it
 * keeps. That store bounds itself because JOB_TODAY and LOCATE_EXPIRED can
 * fire most days for a phone that is never reinstalled; an hours correction
 * a crew member has to answer is rare by comparison, so the growth this
 * would need to guard against does not happen in practice.
 */
class CrewShiftReplyStore(context: Context) {

    private val prefs = context.applicationContext
        .getSharedPreferences("crew_shift_reply", Context.MODE_PRIVATE)

    sealed class Reply {
        /** They said the corrected hours are right. */
        object Accepted : Reply()

        /** They said the corrected hours are wrong, and why. */
        data class Disputed(val note: String) : Reply()
    }

    /** Null means this phone has not sent an answer for this exact correction. */
    fun answerFor(key: String): Reply? {
        val raw = prefs.getString(key, null) ?: return null
        return if (raw == ACCEPTED_MARKER) Reply.Accepted
        else Reply.Disputed(raw.removePrefix(DISPUTED_PREFIX))
    }

    /** Call only after `acknowledge_my_shift` has actually returned touched = true. */
    fun recordAccepted(key: String) {
        prefs.edit().putString(key, ACCEPTED_MARKER).apply()
    }

    /** Call only after `dispute_my_shift` has actually returned touched = true. */
    fun recordDisputed(key: String, note: String) {
        prefs.edit().putString(key, DISPUTED_PREFIX + note).apply()
    }

    companion object {
        private const val ACCEPTED_MARKER = "accepted"
        private const val DISPUTED_PREFIX = "disputed:"
    }
}
