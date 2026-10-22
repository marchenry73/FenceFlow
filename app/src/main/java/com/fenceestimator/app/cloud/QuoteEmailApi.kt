package com.fenceestimator.app.cloud

import com.fenceestimator.app.BuildConfig
import io.github.jan.supabase.auth.auth
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.HttpRequestTimeoutException
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.UUID

/**
 * SENDS THE QUOTE FROM FENCEFLOW ITSELF, RATHER THAN HANDING IT TO A MAIL APP.
 *
 * The phone's "Email the quote" button used to fire an ACTION_SENDTO intent:
 * a mail app opened with a draft in it, and that was the end of what this app
 * could know. It could not say whether it was sent, so it deliberately did not
 * stamp quote_sent_at -- see the comment on that button, which records exactly
 * why stamping on a mere launch would be a claim the screen cannot support.
 *
 * This goes through mail-send with from_account_id = "fenceflow", which is the
 * same path the office uses: Resend, under the company's own name, replies
 * coming back to them. Because the function answers only once the provider has
 * taken the message, the send IS knowable here, and the stamp is honest.
 *
 * WHAT GOES IN THE EMAIL: the quote LINK, not an attached PDF. The page owns
 * every figure and shows what the job says today; a PDF freezes the numbers at
 * the moment it was made, so a re-price afterwards leaves the customer holding
 * a document that disagrees with the job. That is the whole reason the quote is
 * a link in the first place.
 *
 * IT DOES NOT FALL BACK BY ITSELF. If this fails, the caller is told why and
 * the mail-app handoff is still there to be chosen. Silently opening a mail app
 * after the customer was told the quote had been sent would be worse than the
 * failure.
 */
object QuoteEmailApi {

    sealed interface Result {
        /** The provider took it. [state] is mail-send's own word for what happened. */
        data class Sent(val state: String) : Result
        /** Not sent, and this is why, in words worth showing. */
        data class Failed(val why: String) : Result
    }

    private val json = Json { ignoreUnknownKeys = true }

    /**
     * @param jobSyncId   links the thread to the job, as the office does
     * @param to          the customer's address
     * @param subject     already-translated subject line
     * @param body        plain text; mail-send builds the HTML from it
     */
    suspend fun send(
        jobSyncId: String,
        to: String,
        subject: String,
        body: String,
    ): Result = withContext(Dispatchers.IO) {
        if (!SupabaseModule.isConfigured) {
            return@withContext Result.Failed("Cloud isn't set up on this build.")
        }
        if (to.isBlank()) return@withContext Result.Failed("This job has no customer email.")
        val token = SupabaseModule.client.auth.currentSessionOrNull()?.accessToken
            ?: return@withContext Result.Failed("This phone isn't signed in to FenceFlow.")

        val client = HttpClient(CIO) {
            install(HttpTimeout) {
                requestTimeoutMillis = 30_000
                connectTimeoutMillis = 15_000
                socketTimeoutMillis = 30_000
            }
        }
        try {
            val payload = buildJsonObject {
                // One per attempt. mail-send never sends the same one twice,
                // so a retry after a timeout cannot double-send.
                put("client_send_id", UUID.randomUUID().toString())
                put("from_account_id", "fenceflow")
                put("to", JsonArray(listOf(JsonPrimitive(to.trim()))))
                put("subject", subject)
                put("text", body)
                put("job_sync_id", jobSyncId)
            }
            val response = client.post("${BuildConfig.SUPABASE_URL}/functions/v1/mail-send") {
                header("Authorization", "Bearer $token")
                header("apikey", BuildConfig.SUPABASE_KEY)
                contentType(ContentType.Application.Json)
                setBody(payload.toString())
            }
            val text = response.bodyAsText()
            val obj = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull()

            // `state` is what mail-send says to go by, not the HTTP code --
            // its own header says so, and names all four answers:
            //
            //   "sent"     it went. A duplicate answer carries this too, which
            //              is the right verdict: the message is in their inbox
            //              from the first attempt, it simply did not go twice.
            //   "sending"  it MAY have gone (the connection dropped after the
            //              message was on its way, or Resend never answered).
            //              The header is explicit that this must never be
            //              reported as a failure -- a second attempt could
            //              double it -- so it says to check Sent instead.
            //   "failed"   certainly not sent, with `message` saying why.
            //   absent     refused before anything was recorded or sent.
            //
            // The words come from `message`, not `error`: a refusal's body is
            // {error_code, message, detail?}, and reading a key that is never
            // there would show him "refused" with nothing to act on in place
            // of "20 an hour reached" or "no mailbox".
            val state = obj?.get("state")?.jsonPrimitive?.contentOrNullSafe()
            val why = obj?.get("message")?.jsonPrimitive?.contentOrNullSafe()?.takeIf { it.isNotBlank() }
                ?: obj?.get("send_error")?.jsonPrimitive?.contentOrNullSafe()?.takeIf { it.isNotBlank() }
                ?: obj?.get("error_code")?.jsonPrimitive?.contentOrNullSafe()?.takeIf { it.isNotBlank() }
            when {
                state == "sent" -> Result.Sent(state)
                state == "sending" -> Result.Failed(
                    "Couldn't confirm it went out. Check Sent before sending it again."
                )
                why != null -> Result.Failed(why)
                state != null -> Result.Failed("The mail service answered \"$state\".")
                else -> Result.Failed("The mail service replied ${response.status.value}.")
            }
        } catch (e: HttpRequestTimeoutException) {
            // No answer is NOT a failure to send: it may have gone. Say so
            // rather than inviting a second attempt that could double it.
            Result.Failed("Timed out waiting for the mail service. It may still have gone out -- check before sending again.")
        } catch (e: Exception) {
            Result.Failed(shownError(e, "Couldn't reach the mail service."))
        } finally {
            client.close()
        }
    }

    /** `content` throws on a JsonNull; this keeps a null answer a null. */
    private fun kotlinx.serialization.json.JsonPrimitive.contentOrNullSafe(): String? =
        runCatching { content }.getOrNull()
}
