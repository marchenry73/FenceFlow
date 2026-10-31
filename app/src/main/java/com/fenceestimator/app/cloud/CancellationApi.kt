package com.fenceestimator.app.cloud

import io.github.jan.supabase.postgrest.postgrest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * CANCELLING A JOB FROM THE PHONE, and what it costs to do so.
 *
 * The rule is supabase_r45_job_cancellation.sql and it lives in the database:
 * $1 a foot on every cancellation for the work that will not happen, plus the
 * material when it was ordered, and a refund that is never negative. NOTHING
 * HERE COMPUTES ANY OF IT. The figures are read from
 * `job_cancellation_terms`, the same function the office reads, so the two
 * halves cannot come to different answers about what a cancellation costs.
 *
 * THROUGH THE SERVER, NOT THE ENTITY PUSH. [Job.cancelledAt] and its two
 * companions are read-only on the phone -- `toCloud` leaves them out on
 * purpose -- so a handset that has only ever read them cannot send a stale
 * copy back over a cancellation made in the office. That means the phone's own
 * cancel has to write where the office writes, which is here, and then let the
 * next pull bring the result home.
 *
 * Every call is the caller's OWN session: RLS and company_allowed hold exactly
 * as they do for any other request this app makes, and
 * `job_cancellation_terms` is additionally scoped by money_scope_company_id(),
 * so a crew account gets NO ROW rather than a row of zeroes. That distinction
 * is kept all the way to the screen: [Terms] is null for "you cannot see this
 * job's money", which is not the same answer as "nothing is kept", and showing
 * a zero would be a lie that costs the owner.
 */
object CancellationApi {

    /** What a cancellation keeps and what goes back, straight from r45. */
    @Serializable
    data class Terms(
        @SerialName("materials_ordered") val materialsOrdered: Boolean = false,
        @SerialName("material_quoted") val materialQuoted: Double = 0.0,
        @SerialName("material_cost") val materialCost: Double = 0.0,
        val feet: Double = 0.0,
        val inconvenience: Double = 0.0,
        val retained: Double = 0.0,
        val paid: Double = 0.0,
        @SerialName("refund_due") val refundDue: Double = 0.0,
        /**
         * True while the customer is still inside the three business days the
         * contract gives them, in which case r61 has already set [retained] and
         * [inconvenience] to zero and [refundDue] to the whole of [paid].
         *
         * Read ONLY to explain those figures on screen. The window is computed
         * server-side (`cooling_off_deadline`), like every other number here --
         * a phone that worked out its own three days would disagree with the
         * office the first time a holiday fell in between.
         *
         * Defaulted false, so a server that has not had r61 applied decodes
         * exactly as before and the dialog says nothing extra.
         */
        @SerialName("within_cooling_off") val withinCoolingOff: Boolean = false,
        /**
         * When that window shuts, as the server computed it. Null before r61,
         * and null for a job with no signature on record -- there is nothing to
         * be within three days OF.
         */
        @SerialName("cooling_off_ends_at") val coolingOffEndsAt: String? = null,
    )

    sealed interface TermsResult {
        data class Ok(val terms: Terms) : TermsResult

        /**
         * The function answered, with no row. That is the SEE_MONEY gate, not
         * an error and not a zero: this account may not see this job's money.
         */
        data object NotVisible : TermsResult

        /** Could not ask at all -- no signal, refused, or the server is unwell. */
        data class Failed(val message: String?) : TermsResult
    }

    /**
     * What cancelling this job would keep and refund, or why that cannot be
     * said. Reads only; nothing is written and nothing is cancelled.
     */
    suspend fun terms(jobSyncId: String): TermsResult = withContext(Dispatchers.IO) {
        if (jobSyncId.isBlank()) return@withContext TermsResult.Failed(null)
        runCatching {
            SupabaseModule.client.postgrest
                .rpc("job_cancellation_terms", buildJsonObject { put("jsync", jobSyncId) })
                .decodeList<Terms>()
        }.fold(
            onSuccess = { rows ->
                // A set-returning function answers a LIST. Empty is the gate,
                // and it must not be read as a Terms() full of zeroes.
                rows.firstOrNull()?.let { TermsResult.Ok(it) } ?: TermsResult.NotVisible
            },
            onFailure = { TermsResult.Failed(it.message) },
        )
    }

    sealed interface CancelResult {
        data object Ok : CancelResult

        /** The server refused, or could not be reached. */
        data class Failed(val message: String?) : CancelResult
    }

    /**
     * Marks the job cancelled, now.
     *
     * The STATUS IS NOT TOUCHED, which is r45's decision and the reason these
     * are columns at all: an older build reads an unknown status as DRAFT and
     * would push that back, undoing the cancellation. A date cannot be undone
     * by a build that has never heard of it.
     *
     * cancelled_by is left to the server's own `auth.uid()` default rather
     * than sent from here, so the record names whoever's session actually made
     * the request and cannot be dressed up as somebody else.
     */
    suspend fun cancel(companyId: String, jobSyncId: String, reason: String): CancelResult =
        withContext(Dispatchers.IO) {
            if (companyId.isBlank() || jobSyncId.isBlank()) return@withContext CancelResult.Failed(null)
            runCatching {
                SupabaseModule.client.postgrest.from("jobs").update(
                    buildJsonObject {
                        put("cancelled_at", CloudTime.format(System.currentTimeMillis()))
                        // Blank means "none given", stored as a blank rather
                        // than a null so the column reads the same way the
                        // phone's own String does.
                        put("cancellation_reason", reason.trim())
                    }
                ) {
                    filter {
                        eq("company_id", companyId)
                        eq("sync_id", jobSyncId)
                    }
                }
            }.fold(
                onSuccess = { CancelResult.Ok },
                onFailure = { CancelResult.Failed(it.message) },
            )
        }
}
