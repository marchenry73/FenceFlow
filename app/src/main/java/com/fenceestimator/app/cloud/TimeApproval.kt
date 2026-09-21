package com.fenceestimator.app.cloud

import io.github.jan.supabase.exceptions.RestException
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * What `approve_time_entry` returns.
 *
 * Deliberately has no rate, no clock and no break in it, because the RPC
 * deliberately does not return any: it answers with the decision columns and
 * nothing else, so a caller cannot accidentally become a second door onto a
 * colleague's pay. `cloudJson` drops unknown keys, so this stays valid if the
 * server ever adds one.
 */
@Serializable
private data class DecisionRow(
    val outcome: String = "",
    val rows: Int = 0,
    @SerialName("approved_at") val approvedAt: String? = null,
    @SerialName("approved_by") val approvedBy: String = "",
    @SerialName("rejected_at") val rejectedAt: String? = null,
    @SerialName("review_note") val reviewNote: String = ""
)

/**
 * Signing off -- or rejecting -- a shift from the phone.
 *
 * ## Why this is not an ordinary sync write
 *
 * A FOREMAN holds APPROVE_TIME and does NOT hold SEE_PAY, and
 * `time_entries_pay_needs_see_pay` (supabase_sec_time_entries_pay.sql) hides a
 * colleague's whole shift row from anyone without SEE_PAY. Postgres applies
 * SELECT policies to the row an UPDATE reads, and to the conflicting row an
 * INSERT ... ON CONFLICT touches, so for a foreman a colleague's shift was not
 * merely unreadable but unwritable. Measured live on 2026-09-20 in a
 * rolled-back transaction:
 *
 *  * a plain UPDATE setting approved_at affected **0 rows**, with no error --
 *    the approval simply never happened, and nothing said so;
 *  * the real push shape, [EntitySync.pushTimeEntries]' upsert on
 *    (company_id, sync_id), was refused **42501** "new row violates row-level
 *    security policy time_entries_pay_needs_see_pay";
 *  * a MANAGER, who has SEE_PAY, landed 1 row -- the positive control.
 *
 * 42501 reaches PostgREST as HTTP 403, and [isPermanentRejection] treats 403
 * as retryable on purpose, so the phone re-sent the same doomed row on every
 * sync and reported a sync failure every time. The foreman is exactly the
 * person TimeApprovalScreen exists for, and their sign-offs never reached the
 * office.
 *
 * The answer is not to widen that policy -- it is the whole of crew financial
 * privacy on this table. It is a narrow door, the same shape
 * [TimeCorrection] already uses for the clock: `approve_time_entry`, a
 * SECURITY DEFINER RPC that demands APPROVE_TIME, pins the row to the
 * caller's own company, refuses the caller's OWN shift, and returns only the
 * decision columns. See `supabase_p3_approve_time_entry.sql`.
 *
 * What comes back is the SAVED decision, not an acknowledgement, for the same
 * reason [TimeCorrection] reads its answer back: a screen showing a figure the
 * database does not hold is the defect being closed here, not a style
 * preference.
 */
object TimeApproval {

    /**
     * Sends one decision and reports what actually happened to it.
     *
     * Never throws. Every branch is a different sentence on the screen, and
     * the one thing none of them may be is "Approved" over a decision that did
     * not land.
     *
     * @param approve true to sign the shift off, false to send it back.
     * @param note the reviewer's words. Required by the server on a rejection;
     *   optional on an approval.
     */
    suspend fun decide(shiftSyncId: String, approve: Boolean, note: String): Outcome {
        if (!SupabaseModule.hasLiveSession()) return Outcome.NotSignedIn
        val answer = runCatching {
            SupabaseModule.client.postgrest.rpc(
                "approve_time_entry",
                buildJsonObject {
                    put("shift_sync_id", shiftSyncId)
                    put("approve", approve)
                    put("note", note)
                }
            ).decodeAs<DecisionRow>()
        }.getOrElse { return classify(it) }

        return when {
            answer.outcome == "not_found" -> Outcome.NotInCloudYet

            // The server raises rather than returning a decision it did not
            // write, so rows is always 1 here -- checked anyway, because the
            // whole class of bug this file closes is a write that affected
            // nothing being read as a success. See
            // memory/empty-answer-reads-as-good-news.md.
            (answer.outcome == "approved" || answer.outcome == "rejected") && answer.rows == 1 ->
                Outcome.Saved(
                    // Read out of the answer, never echoed back from the request.
                    approvedAt = CloudTime.parseMillis(answer.approvedAt),
                    approvedBy = answer.approvedBy,
                    rejectedAt = CloudTime.parseMillis(answer.rejectedAt),
                    reviewNote = answer.reviewNote
                )

            else -> Outcome.Refused(
                "The server gave an answer this app did not understand: " +
                    "${answer.outcome.ifBlank { "(nothing)" }}, ${answer.rows} rows."
            )
        }
    }

    /**
     * Whether a failure was the server saying no, or the request never getting
     * there.
     *
     * Pure, and split out so a test can feed it the real exception type
     * postgrest-kt throws -- same reasoning as [TimeCorrection.classify] and
     * [classifyRowRejection]. A [RestException] anywhere in the cause chain
     * means the server answered; no [RestException] at all means no HTTP
     * response happened (offline, DNS, a dropped socket, a timeout), and that
     * is the case that must never read as "approved".
     */
    fun classify(error: Throwable): Outcome {
        val rest = generateSequence(error) { it.cause }
            .filterIsInstance<RestException>()
            .firstOrNull() ?: return Outcome.Unreachable
        val sentence = rest.error.ifBlank { rest.message.orEmpty() }
        return Outcome.Refused(sentence.ifBlank { "The server refused the sign-off." })
    }

    /** Named Outcome, not Result, so it cannot be confused with kotlin.Result. */
    sealed interface Outcome {
        /**
         * The server holds this decision. Every field is what it stored --
         * including [approvedBy], which the server derives from the signed-in
         * person's own profile rather than accepting from the caller, so the
         * name on a sign-off is never one the signer typed.
         */
        data class Saved(
            val approvedAt: Long?,
            val approvedBy: String,
            val rejectedAt: Long?,
            val reviewNote: String
        ) : Outcome

        /**
         * The cloud has no such shift.
         *
         * Not a failure: a shift the cloud has never seen goes up on the
         * insert-only pass, which is the one pass that carries the decision
         * for a brand new row, so the sign-off is what will land with it. The
         * screen says that rather than claiming it is already saved.
         */
        data object NotInCloudYet : Outcome

        /** No cloud at all on this phone -- one person working alone, everything local. */
        data object NotSignedIn : Outcome

        /** The server answered, and the answer was no. [detail] is its own sentence, verbatim. */
        data class Refused(val detail: String) : Outcome

        /**
         * The request never reached the server. Nothing was saved anywhere,
         * and the shift stays in the queue -- which is the honest state, and
         * the reason the update pass no longer carries the decision: there is
         * never a local sign-off waiting for a later sync to smuggle up.
         */
        data object Unreachable : Outcome
    }
}
