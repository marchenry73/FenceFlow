package com.fenceestimator.app.cloud

import com.fenceestimator.app.BuildConfig
import io.github.jan.supabase.auth.auth
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * SENDING THE HOA PACKET FROM FENCEFLOW, rather than through the phone's own
 * mail app.
 *
 * MARCH, 6 Nov 2026: "when I do the HOA, it pulls up my gmail. It should only
 * send the email to the HOA. Also I want to have the choice to either open the
 * app or send the email, just incase customer already have their own email
 * they want to send it with."
 *
 * The existing button hands the letter to whatever mail app the phone has, so
 * it goes out of a personal Gmail and the association's reply lands there too.
 * This is the other choice: the server sends the same packet, from the
 * company's own address, with reply-to set to the company inbox -- so the reply
 * comes back somewhere the business can see it.
 *
 * TWO RECIPIENTS, and the default is unchanged. "customer" sends it to the
 * homeowner to forward, which is what hoa-letter has always done and why it
 * exists: an architectural-review request has to come from the person who owns
 * the lot, and many boards will not act on one sent by the contractor. "hoa"
 * sends the same packet straight to the address on the job, for the
 * associations that do accept it from the installer.
 *
 * THE ANSWER IS READ OUT OF THE BODY, not off the HTTP code, and the ADDRESS
 * comes back from the server rather than being assumed here. The phone says
 * "Sent to <address>" on the strength of what the server reports, because a
 * caller that inferred it would eventually tell somebody the letter went to
 * the association when it went to the customer.
 */
object HoaLetterApi {

    private val json = Json { ignoreUnknownKeys = true }

    enum class Recipient(val wire: String) { CUSTOMER("customer"), HOA("hoa") }

    sealed interface Result {
        /** It went. [to] is the address the SERVER used. */
        data class Sent(val to: String, val recipient: String, val pdfAttached: Boolean) : Result
        /** It did not go, and [message] is in words a person can act on. */
        data class Failed(val message: String) : Result
    }

    suspend fun send(jobSyncId: String, recipient: Recipient): Result = withContext(Dispatchers.IO) {
        if (!SupabaseModule.isConfigured) {
            return@withContext Result.Failed("Cloud isn't set up on this build.")
        }
        val token = SupabaseModule.client.auth.currentSessionOrNull()?.accessToken
            ?: return@withContext Result.Failed("This phone isn't signed in to FenceFlow.")

        // Its own client with explicit timeouts, the same shape QuoteEmailApi
        // uses: hoa-letter builds a PDF before it sends, so it is one of the
        // slower calls in the app and must not hang on a default.
        val http = HttpClient(CIO) {
            install(HttpTimeout) {
                requestTimeoutMillis = 60_000
                connectTimeoutMillis = 15_000
                socketTimeoutMillis = 60_000
            }
        }
        try {
            val payload = buildJsonObject {
                put("job_sync_id", jobSyncId)
                put("recipient", recipient.wire)
            }
            val response = http
                .post("${BuildConfig.SUPABASE_URL}/functions/v1/hoa-letter") {
                    header("Authorization", "Bearer $token")
                    header("apikey", BuildConfig.SUPABASE_KEY)
                    contentType(ContentType.Application.Json)
                    setBody(payload.toString())
                }
            val body = response.bodyAsText()
            val obj = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull()

            val sent = obj?.get("sent")?.jsonPrimitive?.contentOrNull() == "true"
            if (sent) {
                Result.Sent(
                    to = obj?.get("to")?.jsonPrimitive?.contentOrNull().orEmpty(),
                    recipient = obj?.get("recipient")?.jsonPrimitive?.contentOrNull().orEmpty(),
                    pdfAttached = obj?.get("pdf_attached")?.jsonPrimitive?.contentOrNull() == "true"
                )
            } else {
                // The server's own sentence, never a status code. hoa-letter
                // answers {error: "..."} for every refusal it makes -- no
                // customer email, no HOA email, nothing drawn, a sandbox
                // company, mail not configured -- and each of those names the
                // thing to go and fix.
                Result.Failed(
                    obj?.get("error")?.jsonPrimitive?.contentOrNull()?.takeIf { it.isNotBlank() }
                        ?: "The HOA letter could not be sent. Try again in a moment."
                )
            }
        } catch (e: Exception) {
            // No signal, or the request never completed. Deliberately NOT
            // reported as "not sent": the letter may already be on its way,
            // and a second tap on a confident failure is how a board gets the
            // same packet twice.
            Result.Failed("Could not reach FenceFlow to send it. Check Sent before trying again.")
        } finally {
            http.close()
        }
    }

    private fun kotlinx.serialization.json.JsonPrimitive.contentOrNull(): String? =
        runCatching { content }.getOrNull()
}
