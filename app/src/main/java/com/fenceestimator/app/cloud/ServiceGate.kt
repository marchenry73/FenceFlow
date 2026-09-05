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
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
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
    @SerialName("trial_days_left") val trialDaysLeft: Int? = null,
    /**
     * True once the owner has picked a plan during the trial -- a card is on
     * file and will be charged when the trial ends, rather than the trial
     * simply lapsing with nothing chosen. Changes what [trialDaysLeft] means
     * to show: "your trial ends" reads as a threat to someone who has
     * already committed to a plan and is just waiting for their start date,
     * so the banner asks my_service_status for this rather than guessing it
     * from subscriptionStatus, which the server may not have flipped to
     * "active" yet while the trial clock still has days left on it.
     */
    @SerialName("subscribed") val subscribed: Boolean = false
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
    private val SUBSCRIBED = booleanPreferencesKey("subscribed")

    /**
     * This install's own id, made once and kept.
     *
     * Not the FCM token, which changes on its own, and not the Android id,
     * which is shared across a user's apps. This only has to be stable for as
     * long as the app is installed and different from every other handset,
     * which a random uuid written down once satisfies exactly.
     */
    private val DEVICE_ID = stringPreferencesKey("device_id")

    /** Set when the login was taken over by another phone. */
    private val DISPLACED = booleanPreferencesKey("displaced")

    /** Which account this install last took the login for. */
    private val CLAIMED_FOR = stringPreferencesKey("claimed_for")

    suspend fun deviceId(context: Context): String {
        val existing = runCatching {
            context.serviceStore.data.first()[DEVICE_ID]
        }.getOrNull()
        if (!existing.isNullOrBlank()) return existing
        val made = java.util.UUID.randomUUID().toString()
        runCatching { context.serviceStore.edit { it[DEVICE_ID] = made } }
        return made
    }

    /** Called once the person is signed in: this phone takes the login. */
    suspend fun claimThisDevice(context: Context) {
        if (!SupabaseModule.hasLiveSession()) return
        val id = deviceId(context)
        runCatching {
            SupabaseModule.client.postgrest.rpc(
                "claim_device",
                kotlinx.serialization.json.buildJsonObject {
                    put("device_id", kotlinx.serialization.json.JsonPrimitive(id))
                }
            )
        }
        runCatching { context.serviceStore.edit { it[DISPLACED] = false } }
    }

    /**
     * Whether this phone still holds the login, or another one took it.
     *
     * Only ever false on a definite answer from the server. Offline, or any
     * failure, leaves it true -- a crew member in a dead spot must not be
     * thrown out of the app on a guess.
     */
    suspend fun stillMine(context: Context): Boolean {
        if (!SupabaseModule.hasLiveSession()) return true
        val id = deviceId(context)
        val answer = runCatching {
            SupabaseModule.client.postgrest.rpc(
                "device_still_mine",
                kotlinx.serialization.json.buildJsonObject {
                    put("device_id", kotlinx.serialization.json.JsonPrimitive(id))
                }
            ).decodeAs<Boolean>()
        }.getOrNull() ?: return true
        runCatching { context.serviceStore.edit { it[DISPLACED] = !answer } }
        return answer
    }

    suspend fun wasDisplaced(context: Context): Boolean =
        runCatching { context.serviceStore.data.first()[DISPLACED] }.getOrNull() ?: false

    /**
     * Does this phone hold the login? Claiming it if this is a fresh sign-in here.
     *
     * The ordering matters and I had it backwards. Checking first and claiming
     * only if the check passed meant the SECOND phone to sign in looked at the
     * first phone's claim, saw it was not its own, and blocked ITSELF -- so
     * somebody signing in on a new handset was locked out while the old one
     * carried on. Exactly the reverse of what was intended, and the reverse of
     * what anybody replacing a lost phone would expect.
     *
     * A sign-in on this device always wins. Only a device that has already
     * claimed for this account goes on to check whether it still holds it,
     * which is the case where somebody else has taken over since.
     */
    suspend fun holdsLogin(context: Context): Boolean {
        val userId = SupabaseModule.currentUserId() ?: return true
        val claimedFor = runCatching {
            context.serviceStore.data.first()[CLAIMED_FOR]
        }.getOrNull()

        if (claimedFor != userId) {
            // First check since signing in on this phone, for this account.
            claimThisDevice(context)
            runCatching { context.serviceStore.edit { it[CLAIMED_FOR] = userId } }
            return true
        }
        return stillMine(context)
    }

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
                prefs[SUBSCRIBED] = answer.subscribed
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
        val checkedAt = prefs[CHECKED_AT] ?: return null

        // Working offline is normal. Working offline for a month is not.
        //
        // This gate deliberately fails open so a crew in a dead spot keeps
        // working -- but "open" with no end to it is also how somebody cancels
        // and then simply stays in aeroplane mode. After this long without a
        // single successful check, the phone stops assuming and asks for a
        // connection. Long enough to cover a holiday, a broken handset or a
        // fortnight on a rural site; short enough that it is not a way to use
        // the product for nothing.
        val stale = System.currentTimeMillis() - checkedAt > OFFLINE_TRUST_MS
        if (stale) {
            return ServiceStatus(
                allowed = false,
                subscriptionStatus = prefs[STATUS].orEmpty(),
                plan = prefs[PLAN].orEmpty(),
                reason = "This phone hasn't been able to check your account in a while. " +
                    "Connect to the internet once and everything comes straight back.",
                trialDaysLeft = null
            )
        }

        return ServiceStatus(
            allowed = prefs[ALLOWED] ?: true,
            subscriptionStatus = prefs[STATUS].orEmpty(),
            plan = prefs[PLAN].orEmpty(),
            reason = prefs[REASON].orEmpty(),
            trialDaysLeft = prefs[TRIAL_DAYS]?.takeIf { it >= 0 },
            subscribed = prefs[SUBSCRIBED] ?: false
        )
    }

    /** Thirty days without one successful check. */
    private const val OFFLINE_TRUST_MS = 30L * 24 * 60 * 60 * 1000

    /** Forgotten on sign-out, so the next account is judged on its own terms. */
    suspend fun clear(context: Context) {
        runCatching { context.serviceStore.edit { it.clear() } }
    }
}
