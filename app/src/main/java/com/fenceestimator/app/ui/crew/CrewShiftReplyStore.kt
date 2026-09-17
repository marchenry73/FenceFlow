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
 * The server is the record. CrewAttentionRow asks my_shift_answer
 * (supabase_shift_answer_readback.sql) when online, so a second phone or a
 * reinstall learns an answer given elsewhere and fills this cache.
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
