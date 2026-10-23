package com.fenceestimator.app.cloud

import io.github.jan.supabase.postgrest.postgrest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * THE EMAILS SENT AND RECEIVED ABOUT ONE JOB, ON THE PHONE.
 *
 * "I don't see the past emails that I have sent, I don't have any history, I
 * always want to see them." The history exists and always has: nineteen sent
 * messages on his company at the time he said it, and the office shows them
 * in a Sent folder and in a panel on each job. What has never shown a single
 * one is THE PHONE -- nothing in this app read mail at all -- and the phone
 * is what he carries.
 *
 * NOTHING NEW ON THE SERVER. mail_for_job() already exists, is already
 * granted to authenticated, and is what the office's own job panel calls. Two
 * of his jobs came back with seven and six threads the moment it was asked.
 *
 * READ ONLY, and that is a decision rather than a shortcut. Replying from
 * here would need the compose window, attachments, drafts and the rate
 * ledger; what he asked for is to SEE them. A list that is honest about being
 * a list beats a mail client that is half of one.
 *
 * WHO SEES IT IS THE SERVER'S ANSWER, NOT THIS FILE'S. mail_for_job runs
 * under the caller's own rights, so a login with no mail access gets an empty
 * list and the section simply does not appear. The screen never decides who
 * is allowed to read a company's mail; it draws what came back.
 */
object JobMail {

    /**
     * One conversation, as mail_for_job returns it.
     *
     * Every field is defaulted: this is a server function that has gained
     * columns before and will again, and a phone that refuses to decode a row
     * because a column it does not use appeared is a phone showing no history
     * at all.
     */
    @Serializable
    data class Thread(
        val id: String = "",
        val subject: String = "",
        @SerialName("last_message_at") val lastMessageAt: String? = null,
        @SerialName("message_count") val messageCount: Int = 0,
        @SerialName("unread_count") val unreadCount: Int = 0,
        @SerialName("has_attachments") val hasAttachments: Boolean = false,
        val snippet: String = "",
        /** Everyone on the thread, as addresses. */
        val participants: List<String> = emptyList(),
    ) {
        /** What to call it when the subject line is empty, which a quote reply can be. */
        val title: String get() = subject.ifBlank { "(no subject)" }
    }

    /**
     * The conversations on this job, newest first, or a failure.
     *
     * Capped at 30. Not because more would be slow, but because a job with
     * two hundred emails on a phone screen is a list nobody scrolls -- and an
     * unbounded read is the shape that truncates at a thousand with no error
     * anywhere.
     */
    suspend fun forJob(jobSyncId: String, limit: Int = 30): Result<List<Thread>> =
        withContext(Dispatchers.IO) {
            runCatching {
                if (!SupabaseModule.isConfigured) return@runCatching emptyList()
                SupabaseModule.client.postgrest.rpc(
                    "mail_for_job",
                    buildJsonObject {
                        put("p_job_sync_id", jobSyncId)
                        put("p_limit", limit)
                    }
                ).decodeList<Thread>()
            }
        }
}
