package com.fenceestimator.app.cloud

import com.fenceestimator.app.BuildConfig
import io.github.jan.supabase.auth.auth
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
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
private data class PaymentLinkResponse(val url: String? = null, val error: String? = null)

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
        data class Ok(val url: String) : Result
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

        val client = HttpClient(CIO)
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
                parsed?.url != null -> Result.Ok(parsed.url)
                parsed?.error != null -> Result.Failed(parsed.error)
                else -> Result.Failed("Payments aren't set up yet. Add your Stripe key in Supabase.")
            }
        } catch (e: Exception) {
            Result.Failed(e.message ?: "Couldn't reach the payment service.")
        } finally {
            client.close()
        }
    }
}
