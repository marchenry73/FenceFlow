package com.fenceestimator.app.cloud

import io.github.jan.supabase.exceptions.RestException
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** What `correct_time_entry` returns. Unknown keys (corrected_by) are dropped by cloudJson. */
@Serializable
private data class CorrectionRow(
    val outcome: String = "",
    val rows: Int = 0,
    @SerialName("started_at") val startedAt: String? = null,
    @SerialName("ended_at") val endedAt: String? = null,
    @SerialName("original_started_at") val originalStartedAt: String? = null,
    @SerialName("original_ended_at") val originalEndedAt: String? = null,
    @SerialName("corrected_at") val correctedAt: String? = null,
    @SerialName("correction_reason") val correctionReason: String = ""
)

/**
 * Correcting a shift's recorded hours from the phone.
 *
 * The review dialog on [com.fenceestimator.app.ui.crew.TimeApprovalScreen] has
 * always had editable Start and End fields, and the corrected values never
 * reached the cloud. [EntitySync.pushTimeEntries] sends each finished shift
 * twice -- once insert-only carrying the clock (a no-op for a row the cloud
 * already holds) and once as an update that deliberately omits
 * started_at/ended_at, so a phone can never re-assert its original times over
 * an office correction. Correct by definition for sync; fatal for a screen
 * that lets somebody type a new time into it. The pull then wrote the cloud's
 * uncorrected times back over the local row, and payroll paid the clock that
 * ran all night.
 *
 * So the correction goes through its own door instead: `correct_time_entry`,
 * a SECURITY DEFINER RPC that requires APPROVE_TIME, keeps the original
 * alongside the corrected value (preserve_original_shift), stamps
 * corrected_at/corrected_by and records the reason -- exactly what the
 * office's own correction sheet produces. See
 * `supabase_p2_correct_time_entry.sql`.
 *
 * What comes back is the SAVED row, not an acknowledgement. The whole defect
 * being fixed here is a screen showing a figure the database does not hold,
 * so the caller writes back what the server says it stored rather than what
 * it hoped it stored.
 */
object TimeCorrection {

    /**
     * Sends one correction and reports what actually happened to it.
     *
     * Never throws. Every branch below is a different sentence on the screen,
     * and the one thing none of them may be is "Approved" over a correction
     * that did not land.
     */
    suspend fun correct(
        shiftSyncId: String,
        newStartedAt: Long,
        newEndedAt: Long,
        reason: String
    ): Outcome {
        if (!SupabaseModule.hasLiveSession()) return Outcome.NotSignedIn
        val answer = runCatching {
            SupabaseModule.client.postgrest.rpc(
                "correct_time_entry",
                buildJsonObject {
                    put("shift_sync_id", shiftSyncId)
                    put("new_started_at", CloudTime.format(newStartedAt))
                    put("new_ended_at", CloudTime.format(newEndedAt))
                    put("reason", reason)
                }
            ).decodeAs<CorrectionRow>()
        }.getOrElse { return classify(it) }

        return when (answer.outcome) {
            "corrected", "unchanged" -> Outcome.Saved(
                // Read out of the answer, never echoed back from the request.
                startedAt = CloudTime.parseMillis(answer.startedAt) ?: newStartedAt,
                endedAt = CloudTime.parseMillis(answer.endedAt) ?: newEndedAt,
                originalStartedAt = CloudTime.parseMillis(answer.originalStartedAt),
                originalEndedAt = CloudTime.parseMillis(answer.originalEndedAt),
                correctedAt = CloudTime.parseMillis(answer.correctedAt),
                correctionReason = answer.correctionReason
            )
            "not_found" -> Outcome.NotInCloudYet
            // An answer this app does not recognise is not a success. Saying
            // so out loud beats treating an unknown shape as a saved payroll
            // figure, which is the exact failure this file exists to close.
            else -> Outcome.Refused("The server gave an answer this app did not understand: ${answer.outcome}")
        }
    }

    /**
     * Whether a failure was the server saying no, or the request never
     * getting there.
     *
     * Pure, and split out so a test can feed it the real exception type
     * postgrest-kt throws -- same reasoning as [classifyRowRejection] in
     * TimeEntrySyncRejection.kt. A [RestException] anywhere in the cause
     * chain means the server answered; no [RestException] at all means no
     * HTTP response happened (offline, DNS, a dropped socket, a timeout),
     * and that is the case that must never read as "saved".
     */
    fun classify(error: Throwable): Outcome {
        val rest = generateSequence(error) { it.cause }
            .filterIsInstance<RestException>()
            .firstOrNull() ?: return Outcome.Unreachable
        val sentence = rest.error.ifBlank { rest.message.orEmpty() }
        return Outcome.Refused(sentence.ifBlank { "The server refused the correction." })
    }

    /** Named Outcome, not Result, so it cannot be confused with kotlin.Result above. */
    sealed interface Outcome {
        /**
         * The server holds these times. [startedAt] and [endedAt] are what it
         * stored and the four correction fields are what the trigger derived
         * -- all of it to be written into Room, so the screen and the
         * database agree.
         */
        data class Saved(
            val startedAt: Long,
            val endedAt: Long,
            val originalStartedAt: Long?,
            val originalEndedAt: Long?,
            val correctedAt: Long?,
            val correctionReason: String
        ) : Outcome

        /**
         * The cloud has no such shift.
         *
         * Not a failure: a shift the cloud has never seen goes up on the
         * insert-only pass, which is the ONE pass that carries started_at and
         * ended_at, so the corrected times are what will land. The screen
         * says that rather than claiming the correction is already saved.
         */
        data object NotInCloudYet : Outcome

        /** No cloud at all on this phone -- one person working alone, everything local. */
        data object NotSignedIn : Outcome

        /** The server answered, and the answer was no. [detail] is its own sentence, verbatim. */
        data class Refused(val detail: String) : Outcome

        /** The request never reached the server. Nothing was saved anywhere. */
        data object Unreachable : Outcome
    }
}
