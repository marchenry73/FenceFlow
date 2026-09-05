package com.fenceestimator.app.ui.employees

import com.fenceestimator.app.BuildConfig
import com.fenceestimator.app.cloud.SupabaseModule
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
private data class InviteCrewRequest(val name: String, val email: String, val role: String? = null)

@Serializable
private data class InviteCrewResponse(
    val sent: Boolean = false,
    val error: String? = null,
    /** Returned on a 503 -- the team code to hand over by hand when no mail path is set up. */
    val code: String? = null
)

/**
 * Sends the invite-crew email when someone is added from the phone with an
 * email address -- "crew added from the phone should get the invite email"
 * -- so a manager filling out the crew list at the truck does not also have
 * to find a laptop and open the dashboard to invite them.
 *
 * Modelled on PaymentsApi.kt (same bearer-token pattern, its own short-lived
 * HttpClient) rather than reusing it: PaymentsApi is Stripe-specific and
 * belongs to a different feature, and invite-crew's request/response shape
 * has nothing in common with a payment link.
 */
object InviteCrewApi {
    private val json = Json { ignoreUnknownKeys = true }

    sealed interface Result {
        /** The invite email went out. */
        data object Emailed : Result
        /** No mail path was available server-side; here is the code to hand over instead. */
        data class NeedsCode(val code: String, val sentence: String) : Result
        data class Failed(val reason: String) : Result
    }

    suspend fun invite(name: String, email: String, role: String): Result = withContext(Dispatchers.IO) {
        if (!SupabaseModule.isConfigured) return@withContext Result.Failed("Cloud isn't set up on this build.")
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
            val body = json.encodeToString(
                InviteCrewRequest.serializer(),
                InviteCrewRequest(name, email, role.ifBlank { null })
            )
            val response = client.post("${BuildConfig.SUPABASE_URL}/functions/v1/invite-crew") {
                header("Authorization", "Bearer $token")
                header("apikey", BuildConfig.SUPABASE_KEY)
                contentType(ContentType.Application.Json)
                setBody(body)
            }
            val text = response.bodyAsText()
            val parsed = runCatching { json.decodeFromString(InviteCrewResponse.serializer(), text) }.getOrNull()
            when {
                parsed?.sent == true -> Result.Emailed
                response.status.value == 503 && !parsed?.code.isNullOrBlank() ->
                    Result.NeedsCode(parsed!!.code!!, parsed.error.orEmpty())
                parsed?.error != null -> Result.Failed(parsed.error)
                else -> Result.Failed("Invite service replied ${response.status.value}.")
            }
        } catch (e: HttpRequestTimeoutException) {
            Result.Failed("Timed out reaching the invite service.")
        } catch (e: Exception) {
            Result.Failed(e.message ?: "Couldn't reach the invite service.")
        } finally {
            client.close()
        }
    }
}
