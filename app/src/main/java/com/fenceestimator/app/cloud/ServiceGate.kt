package com.fenceestimator.app.cloud

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
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
    /** Which plan was bought -- shapes what the app shows. Blank means a
     *  hand-granted company from before plans existed: full access. */
    @SerialName("subscription_plan") val plan: String = "",
    /** What to tell the user. Written by the database so it stays consistent. */
    val reason: String = "",
    @SerialName("grace_ends_at") val graceEndsAt: String? = null,
    /** Days left on a live trial; null for everyone else. */
    @SerialName("trial_days_left") val trialDaysLeft: Int? = null
)

/**
 * What a plan includes. The server enforces the parts that matter -- seats in
 * join_company, card payments in create-payment-link -- this shapes the UI so
 * a Solo owner is never shown a door the server will slam.
 */
data class Entitlements(
    val pipeline: Boolean,
    val reports: Boolean,
    val timeAndCrew: Boolean,
    val cardPayments: Boolean,
    /** Profit, margins, cost breakdowns -- the money intelligence Pro is sold on. */
    val advancedReports: Boolean,
    /** The Monday-morning business digest notification. */
    val digest: Boolean,
) {
    companion object {
        val FULL = Entitlements(
            pipeline = true, reports = true, timeAndCrew = true,
            cardPayments = true, advancedReports = true, digest = true,
        )
        /** Crew runs the whole operation; Pro reads the business. */
        val CREW = FULL.copy(advancedReports = false, digest = false)
        val SOLO = Entitlements(
            pipeline = false, reports = false, timeAndCrew = false,
            cardPayments = false, advancedReports = false, digest = false,
        )
        fun of(plan: String): Entitlements = when (plan.lowercase()) {
            "solo" -> SOLO
            "crew" -> CREW
            else -> FULL   // Pro, and hand-granted companies with no plan label
        }
    }
}

object ServiceGate {

    private val ALLOWED = booleanPreferencesKey("allowed")
    private val REASON = stringPreferencesKey("reason")
    private val STATUS = stringPreferencesKey("status")
    private val PLAN = stringPreferencesKey("plan")
    private val CHECKED_AT = longPreferencesKey("checked_at")
    private val TRIAL_DAYS = intPreferencesKey("trial_days")

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

        // Knowing who you are is not the same as holding a token.
        //
        // Without this the question went out anonymous, and the gate answers an
        // anonymous caller with no rows at all -- which arrives here as null and
        // is indistinguishable from "could not ask", so the app opened. That is
        // exactly what happened when a suspended company was locked out of the
        // website and walked straight into the phone: same server, same answer,
        // one client never actually asked.
        if (!SupabaseModule.hasLiveSession()) {
            SupabaseModule.tryRefreshSession()
            if (!SupabaseModule.hasLiveSession()) return@withContext null
        }

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
                prefs[PLAN] = answer.plan
                prefs[CHECKED_AT] = System.currentTimeMillis()
                prefs[TRIAL_DAYS] = answer.trialDaysLeft ?: -1
            }
        }
        answer
    }

    /**
     * Asks until the question can actually be asked.
     *
     * At sign-in and at cold start there is a window where the app knows whose
     * it is but has no token yet. A single attempt inside that window answers
     * "could not ask" -- which keeps the app open, and then nothing asks again
     * until the next launch. So a company switched off mid-week went on working
     * on a phone that never closed. Attempts stop the moment the server gives a
     * definite answer, so the normal case is still one call.
     */
    suspend fun refreshWhenPossible(context: Context, attempts: Int = 4): ServiceStatus? {
        repeat(attempts) { i ->
            refresh(context)?.let { return it }
            if (i < attempts - 1) delay(1500L * (i + 1))
        }
        return null
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
            plan = prefs[PLAN].orEmpty(),
            reason = prefs[REASON].orEmpty(),
            trialDaysLeft = prefs[TRIAL_DAYS]?.takeIf { it >= 0 }
        )
    }

    /** Forgotten on sign-out, so the next account is judged on its own terms. */
    suspend fun clear(context: Context) {
        runCatching { context.serviceStore.edit { it.clear() } }
    }
}
