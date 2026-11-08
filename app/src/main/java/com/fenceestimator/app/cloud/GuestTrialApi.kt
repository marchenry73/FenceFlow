package com.fenceestimator.app.cloud

import android.content.Context
import android.provider.Settings
import com.fenceestimator.app.BuildConfig
import com.fenceestimator.app.guest.GuestSession
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * ONE GUEST DEMO PER DEVICE -- the phone's half.
 *
 * The countdown used to be a constant in this app's own DataStore, so deleting
 * FenceFlow and reinstalling it started a fresh demo, for ever. The server now
 * keeps one row per device (supabase_r73_guest_device_trial.sql) and this asks
 * it whether this handset may have one, and for how long.
 *
 * WHAT IS SENT. ANDROID_ID and nothing else -- no account, no name, no
 * location, no company. The server hashes it with a secret this app never
 * holds before storing it, so the row cannot be turned back into a device.
 *
 * WHY ANDROID_ID. It survives deleting the app, clearing its data and
 * reinstalling, because it is keyed to this app's signing key and the device.
 * It does NOT survive a factory reset, and nothing available to a sideloaded
 * app does: Play Integrity's device recall is the only sanctioned way, and it
 * requires distribution through Google Play. Checked 7 Nov 2026 and parked by
 * the owner, who would rather ship than wait for a Play migration.
 *
 * NO SESSION. A guest has not signed in, so there is no user token to send.
 * The anon key goes in both headers and the function is deployed with
 * verify_jwt = false (supabase/config.toml), because a gateway that demanded
 * a login would refuse every first-run device before the function ran and the
 * demo would simply never start.
 *
 * FAILS OPEN, DELIBERATELY AND BRIEFLY. A phone with no signal cannot be told
 * whether it has had its demo, and refusing everyone in a dead spot would cost
 * more real customers than it saves. So no answer means the SHORT demo
 * ([GuestSession.OFFLINE_DURATION_MS]), and the minutes used are reported the
 * first time the phone does reach the server, which subtracts them from the
 * full window rather than starting a new one.
 */
object GuestTrialApi {

    /**
     * What this device may have.
     *
     * @param allowed false only when the server said this device has already
     *   had its demo. A failure to ask is not a refusal -- see [online].
     * @param grantedMs how long the demo runs. The full window when the server
     *   granted it, the short one when it could not be reached.
     * @param online whether the answer came from the server. False means the
     *   grant is provisional and the time used must be reported later.
     */
    data class Grant(
        val allowed: Boolean,
        val grantedMs: Long,
        val online: Boolean,
    )

    /** The refusal, so the two places that build one cannot disagree. */
    private val REFUSED = Grant(allowed = false, grantedMs = 0L, online = true)

    /** The unverified demo given when the server cannot be reached. */
    private val OFFLINE = Grant(
        allowed = true, grantedMs = GuestSession.OFFLINE_DURATION_MS, online = false,
    )

    /**
     * The device's ANDROID_ID, lower-case.
     *
     * Blank when the platform has nothing for us, which does happen on a
     * handful of devices and on some emulators. A blank id is NOT sent: the
     * server would refuse it as malformed, and sending one would also mean
     * every such device shared a single trial row.
     */
    fun deviceId(context: Context): String =
        runCatching {
            Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
                .orEmpty().trim().lowercase()
        }.getOrDefault("")

    /**
     * Asks whether this device may start a demo.
     *
     * @param offlineMsUsed how long an unverified demo has already run on this
     *   handset, so the server can subtract it from the full window instead of
     *   granting a second one. Zero on a first, online start.
     */
    suspend fun claim(context: Context, offlineMsUsed: Long = 0L): Grant =
        withContext(Dispatchers.IO) {
            val device = deviceId(context)
            // No identifier means no way to tell this phone from any other, so
            // there is nothing to look up. The short demo is the honest answer:
            // it is what any unverifiable device gets.
            if (device.isBlank()) return@withContext OFFLINE

            val http = HttpClient(CIO) {
                install(HttpTimeout) {
                    requestTimeoutMillis = 15_000
                    connectTimeoutMillis = 8_000
                    socketTimeoutMillis = 15_000
                }
            }
            try {
                val payload = buildJsonObject {
                    put("device_id", device)
                    put("offline_ms_used", offlineMsUsed.coerceAtLeast(0L))
                    put("app_version", BuildConfig.VERSION_NAME)
                }
                val response = http
                    .post("${BuildConfig.SUPABASE_URL}/functions/v1/guest-trial") {
                        header("Authorization", "Bearer ${BuildConfig.SUPABASE_KEY}")
                        header("apikey", BuildConfig.SUPABASE_KEY)
                        contentType(ContentType.Application.Json)
                        setBody(payload.toString())
                    }
                val obj = runCatching {
                    Json.parseToJsonElement(response.bodyAsText()).jsonObject
                }.getOrNull() ?: return@withContext OFFLINE

                // An answer we cannot read is not a refusal. `allowed` absent
                // means the function returned an error shape (not configured,
                // read failed, a bad request) -- none of which is this device
                // being told it has had its turn, and treating them as one
                // would lock people out whenever the server had a bad minute.
                val allowed = obj["allowed"]?.jsonPrimitive?.contentOrNull()
                    ?: return@withContext OFFLINE

                if (allowed != "true") return@withContext REFUSED

                val granted = obj["remainingMs"]?.jsonPrimitive?.contentOrNull()
                    ?.toLongOrNull()?.coerceAtLeast(0L)
                // Allowed with no usable figure: take the short demo rather
                // than the full one. Guessing high is the expensive direction.
                    ?: return@withContext OFFLINE

                if (granted <= 0L) REFUSED
                else Grant(allowed = true, grantedMs = granted, online = true)
            } catch (e: Exception) {
                // Any network failure at all. Not a refusal.
                OFFLINE
            } finally {
                runCatching { http.close() }
            }
        }

    /**
     * Null-safe content.
     *
     * Declared INSIDE the object, the way HoaLetterApi and TrashBin declare
     * theirs, rather than as a top-level extension: kotlinx.serialization
     * already ships a `JsonPrimitive.contentOrNull` PROPERTY, and a top-level
     * function of the same name in the same package invites the compiler to
     * resolve `.contentOrNull()` as "read the property, then call its result".
     */
    private fun kotlinx.serialization.json.JsonPrimitive.contentOrNull(): String? =
        runCatching { content }.getOrNull()
}
