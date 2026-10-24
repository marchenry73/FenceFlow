package com.fenceestimator.app.cloud

import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.util.UUID

/**
 * SENDING THE QUOTE LATER.
 *
 * HIS WORDS: "I also want to be able to schedule an email from the app too,
 * also on the website, on both."
 *
 * A scheduled email is a row in mail_drafts with a time on it. mail-send's
 * scheduled sweep finds the ones that are due and sends each through the
 * ordinary FenceFlow path, so a quote that goes out at eight in the morning is
 * the same letter, with the same guarantees, as one sent by thumb at eleven at
 * night -- which is the hour this feature exists to avoid sending at.
 *
 * WHY THE PHONE WRITES A ROW RATHER THAN CALLING A FUNCTION. The row IS the
 * queue: it is visible in the office's drafts list, cancellable there, and
 * carries its own send id. A function would have to invent somewhere to keep
 * all three.
 *
 * THE SEND ID IS MINTED HERE, when the email is SCHEDULED, and that is the
 * whole reason a scheduled send cannot go twice: mail-send refuses to send the
 * same client_send_id twice, so a sweep that dies after handing the letter to
 * the provider carries the same id when it is retried and can only report what
 * already happened. Minting it at send time would give the retry a fresh
 * identity and a second copy to the customer.
 *
 * NO PAYMENT LINK IS EVER QUEUED, and the caller is the one that enforces it
 * by passing a body without one. A Stripe link is locked to the amount it was
 * made for, so a link queued tonight can be asking for the wrong money by the
 * morning -- one re-price is all it takes. The customer still gets the quote
 * button and pays on the quote page, where the figure is read live every time
 * it is opened.
 *
 * RLS DOES THE AUTHORISING, not this file: mail_drafts accepts a row only from
 * its own author, in their own company, and only when can_use_company_mail()
 * says they may send at all -- which refuses CREW outright and requires
 * SEE_MONEY of everyone else. So a crew phone cannot queue mail even though
 * this code is on it.
 */
@Serializable
data class CloudScheduledMail(
    @SerialName("company_id") val companyId: String,
    @SerialName("author_id") val authorId: String,
    /**
     * "new" rather than "reply": the sweep refuses a reply, because mail-send
     * threads one by the MESSAGE being answered and mail_drafts records only
     * the thread. A quote is a new letter anyway.
     */
    val kind: String = "new",
    @SerialName("to_text") val toText: String,
    val subject: String,
    val body: String,
    @SerialName("job_sync_id") val jobSyncId: String?,
    @SerialName("send_at") val sendAt: String,
    @SerialName("client_send_id") val clientSendId: String,
    /** True for a quote: it carries buttons whose urls would bury the letter. */
    @SerialName("hide_cta_url") val hideCtaUrl: Boolean,
    /**
     * The job whose quote this is. The sweep stamps quote_sent_at and moves the
     * job out of DRAFT when the letter actually goes -- the screen does that by
     * hand and is long gone by then, and a quote that went out while the job
     * still read "not sent" would leave the follow-up rules counting from
     * nothing.
     */
    @SerialName("quote_send_for") val quoteSendFor: String?,
)

object ScheduledMailApi {

    sealed interface Result {
        /** Queued. [sendAtMillis] is the moment it is due, for the message on screen. */
        data class Ok(val sendAtMillis: Long) : Result
        data class Failed(val reason: String) : Result
    }

    /**
     * Queues the quote for [sendAtMillis].
     *
     * Refusals are worded for the yard, not for a log: every one of them is
     * something he can act on without knowing what a row is.
     */
    suspend fun scheduleQuote(
        companyId: String?,
        toAddress: String,
        subject: String,
        body: String,
        jobSyncId: String,
        sendAtMillis: Long,
        nowMillis: Long,
    ): Result {
        if (!SupabaseModule.isConfigured) return Result.Failed("Cloud isn't set up on this build.")
        val company = companyId?.takeIf { it.isNotBlank() }
            ?: return Result.Failed("This phone isn't signed in to a company yet.")
        val uid = SupabaseModule.client.auth.currentSessionOrNull()?.user?.id
            ?: return Result.Failed(
                "This phone isn't signed in to FenceFlow. Open Account and sign in, then try again."
            )
        if (toAddress.isBlank()) return Result.Failed("There is no email address on this job to send to.")
        // A minute of slack, for the same reason the office keeps one: a time
        // that is already past reads as late rather than scheduled, and the
        // sweep would send it on its very next pass anyway.
        if (sendAtMillis < nowMillis + 60_000L) {
            return Result.Failed("Pick a time at least a minute from now.")
        }
        // Not a hard rule anywhere, but a row sitting in the queue for a year
        // is a letter nobody remembers writing.
        if (sendAtMillis > nowMillis + 365L * 24 * 60 * 60 * 1000) {
            return Result.Failed("That is more than a year away.")
        }

        val row = CloudScheduledMail(
            companyId = company,
            authorId = uid,
            toText = toAddress.trim(),
            subject = subject,
            body = body,
            jobSyncId = jobSyncId.takeIf { it.isNotBlank() },
            sendAt = CloudTime.format(sendAtMillis),
            clientSendId = UUID.randomUUID().toString(),
            hideCtaUrl = true,
            quoteSendFor = jobSyncId.takeIf { it.isNotBlank() },
        )

        return runCatching {
            SupabaseModule.client.postgrest.from("mail_drafts").insert(row)
            Result.Ok(sendAtMillis) as Result
        }.getOrElse { e ->
            // RLS refusing this is the expected failure for a crew phone, and
            // it should read as a permission, not as a breakage.
            val said = e.message.orEmpty()
            Result.Failed(
                if (said.contains("row-level security", ignoreCase = true) ||
                    said.contains("violates", ignoreCase = true)
                ) "This account isn't allowed to send company mail."
                else "Could not queue the email. Check the connection and try again."
            )
        }
    }
}
