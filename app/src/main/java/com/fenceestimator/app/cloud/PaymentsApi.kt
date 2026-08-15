package com.fenceestimator.app.cloud

import com.fenceestimator.app.BuildConfig
import io.github.jan.supabase.auth.auth
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpRequestTimeoutException
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
private data class PaymentLinkRequest(
    val jobSyncId: String,
    val amountCents: Long,
    val kind: String,
    val description: String
)

@Serializable
private data class PaymentLinkResponse(
    val url: String? = null,
    val error: String? = null,
    /** True when this link will charge a real card. */
    val livemode: Boolean = false
)

/**
 * Asks the backend to create a Stripe payment link for a job.
 *
 * The Stripe secret key lives only in the Edge Function's secrets -- it is
 * never in this app, never in the database, and never on a phone. All the app
 * ever receives back is a public checkout URL to hand to the customer.
 *
 * Note this is a payment for physical work, which Google Play explicitly
 * allows to be processed outside Play Billing. The FenceFlow subscription is a
 * different matter and stays on the website.
 */
object PaymentsApi {

    private val json = Json { ignoreUnknownKeys = true }

    /** Money kinds a contractor asks for, in the order a job usually goes. */
    enum class Kind(val wire: String, val label: String) {
        DEPOSIT("deposit", "Deposit"),
        PROGRESS("progress", "Progress payment"),
        FINAL("final", "Final balance")
    }

    sealed interface Result {
        /** @param liveMode true when this link charges a real card, not a test one. */
        data class Ok(val url: String, val liveMode: Boolean) : Result
        data class Failed(val reason: String) : Result
    }

    suspend fun createPaymentLink(
        jobSyncId: String,
        amountDollars: Double,
        kind: Kind,
        description: String
    ): Result = withContext(Dispatchers.IO) {
        if (!SupabaseModule.isConfigured) {
            return@withContext Result.Failed("Cloud isn't set up on this build.")
        }
        // Worded so it is obvious this came from the phone, not the server --
        // two different causes that used to produce near-identical messages.
        val token = SupabaseModule.client.auth.currentSessionOrNull()?.accessToken
            ?: return@withContext Result.Failed(
                "This phone isn't signed in to FenceFlow. Open Account and sign in, then try again."
            )
        if (amountDollars < 0.50) {
            return@withContext Result.Failed("Amount has to be at least $0.50.")
        }

        // Round in cents. Doing the multiply in floating point and truncating
        // is how a $100.00 charge becomes $99.99.
        val cents = Math.round(amountDollars * 100.0)

        // A generous timeout on purpose. A backend function that hasn't run in a
        // while has to cold-start before it even reaches Stripe, and the default
        // socket timeout was short enough to give up first -- which looked
        // exactly like the button doing nothing.
        val client = HttpClient(CIO) {
            install(HttpTimeout) {
                requestTimeoutMillis = 60_000
                connectTimeoutMillis = 20_000
                socketTimeoutMillis = 60_000
            }
        }
        try {
            val body = json.encodeToString(
                PaymentLinkRequest.serializer(),
                PaymentLinkRequest(jobSyncId, cents, kind.wire, description)
            )
            val response = client.post("${BuildConfig.SUPABASE_URL}/functions/v1/create-payment-link") {
                header("Authorization", "Bearer $token")
                header("apikey", BuildConfig.SUPABASE_KEY)
                contentType(ContentType.Application.Json)
                setBody(body)
            }
            val text = response.bodyAsText()
            val parsed = runCatching { json.decodeFromString(PaymentLinkResponse.serializer(), text) }.getOrNull()

            when {
                parsed?.url != null -> Result.Ok(parsed.url, parsed.livemode)
                parsed?.error != null -> Result.Failed(parsed.error)
                // Include the status and body so an unexpected reply is
                // diagnosable instead of collapsing into a generic sentence.
                else -> Result.Failed(
                    "Payment service replied ${response.status.value}: ${text.take(200).ifBlank { "(empty)" }}"
                )
            }
        } catch (e: HttpRequestTimeoutException) {
            Result.Failed("Timed out waiting for the payment service. Try once more -- the first request after a quiet spell is the slow one.")
        } catch (e: Exception) {
            Result.Failed("${e::class.simpleName}: ${e.message ?: "couldn't reach the payment service"}")
        } finally {
            client.close()
        }
    }
}
