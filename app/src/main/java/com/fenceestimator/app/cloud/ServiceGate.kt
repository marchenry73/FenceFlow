package com.fenceestimator.app.cloud

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Whether this company is entitled to use the app.
 *
 * The database has decided this since the beginning -- `my_service_status`
 * weighs the subscription, the trial and the grace period, and gets the
 * judgement right -- and nothing ever asked it. Access control that is written
 * down and never consulted is not access control.
 *
 * ## Why this fails open when it cannot tell
 *
 * A locked-out crew standing in a yard is a real cost to a real customer. So
 * the gate closes only on a definite answer: a company is blocked when the
 * server said to block it, never because the phone could not ask.
 *
 * That is not the hole it sounds like. Row Level Security still refuses every
 * read and write to a suspended company's data, server-side, whatever the app
 * believes -- so an unpaid company with no signal has access to what is already
 * on that phone and nothing else, until the moment it reconnects. Closing that
 * last gap would mean bricking working crews over dead zones, which costs
 * paying customers far more than it saves.
 *
 * The last answer is remembered, so a phone that has been told "blocked" stays
 * blocked offline. Only never having been told opens the gate.
 */
private val Context.serviceStore by preferencesDataStore(name = "service_status")

@Serializable
data class ServiceStatus(
    val allowed: Boolean = true,
    @SerialName("subscription_status") val subscriptionStatus: String = "",
    /** What to tell the user. Written by the database so it stays consistent. */
    val reason: String = "",
    @SerialName("grace_ends_at") val graceEndsAt: String? = null
)

object ServiceGate {

    private val ALLOWED = booleanPreferencesKey("allowed")
    private val REASON = stringPreferencesKey("reason")
    private val STATUS = stringPreferencesKey("status")
    private val CHECKED_AT = longPreferencesKey("checked_at")

    /**
     * Asks the server, remembers the answer, and returns it.
     *
     * @return null when the question could not be asked at all -- offline, not
     *   signed in, or the call failed. Null is "unknown", never "blocked".
     */
    suspend fun refresh(context: Context): ServiceStatus? = withContext(Dispatchers.IO) {
        if (!SupabaseModule.isConfigured) return@withContext null
        val signedIn = runCatching { SupabaseModule.currentUserEmail() }.getOrNull()
        if (signedIn == null) return@withContext null

        val answer = runCatching {
            SupabaseModule.client.postgrest
                .rpc("my_service_status")
                .decodeList<ServiceStatus>()
                .firstOrNull()
        }.getOrNull() ?: return@withContext null

        runCatching {
            context.serviceStore.edit { prefs ->
                prefs[ALLOWED] = answer.allowed
                prefs[REASON] = answer.reason
                prefs[STATUS] = answer.subscriptionStatus
                prefs[CHECKED_AT] = System.currentTimeMillis()
            }
        }
        answer
    }

    /**
     * The last answer this phone was given, or null if it has never had one.
     *
     * Used at startup so a company already told it was blocked stays blocked
     * without waiting for the network, and so one that was fine keeps working
     * in a dead zone.
     */
    suspend fun remembered(context: Context): ServiceStatus? {
        val prefs = runCatching { context.serviceStore.data.first() }.getOrNull() ?: return null
        if (prefs[CHECKED_AT] == null) return null
        return ServiceStatus(
            allowed = prefs[ALLOWED] ?: true,
            subscriptionStatus = prefs[STATUS].orEmpty(),
            reason = prefs[REASON].orEmpty()
        )
    }

    /** Forgotten on sign-out, so the next account is judged on its own terms. */
    suspend fun clear(context: Context) {
        runCatching { context.serviceStore.edit { it.clear() } }
    }
}
