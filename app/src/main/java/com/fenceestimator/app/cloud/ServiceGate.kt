package com.fenceestimator.app.cloud

import android.content.Context
import com.fenceestimator.app.R
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import io.github.jan.supabase.exceptions.RestException
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
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

/**
 * What claim_device did with a claim -- the phone's reading of the two
 * `raise exception` lines in PART 3 of supabase_r8_device_keys.sql, plus
 * everything that is neither of them.
 *
 * Both of those raises set `hint` and no `details`. postgrest-kt 3.0.2 builds
 * its RestException from the response's message and details-or-hint only --
 * the SQLSTATE does not survive the trip (see the dated note on
 * isPermanentRejection in TimeEntrySyncRejection.kt, which found the same
 * thing for a different RPC). With `details` absent, the hint Postgres set
 * lands in RestException.description, not in .error -- which is the message
 * sentence, not the machine-readable word -- and nowhere does the SQLSTATE
 * itself appear. [ServiceGate] reads the hint from `.description`.
 */
sealed class ClaimOutcome {
    /** The server accepted the claim. This device now holds the login. */
    object Claimed : ClaimOutcome()
    /** hint = 'device_key_required' -- another phone holds it and this one sent no key. */
    object KeyRequired : ClaimOutcome()
    /** hint = 'device_key_invalid' -- a key was sent and the server would not take it. */
    object KeyInvalid : ClaimOutcome()
    /** No session, offline, a timeout, or a refusal that was neither hint above. */
    object Failed : ClaimOutcome()
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

    /**
     * What the last claim_device call answered, for whichever screen is
     * showing "signed in on another phone" -- so it can ask for a device key
     * only once the server has actually said it wants one, and say which of
     * the two ways that request can fail. In memory only: a key requirement
     * is asked about fresh on every attempt, never remembered from an
     * earlier sign-in or a different account on this phone.
     */
    private val _lastClaimOutcome = MutableStateFlow<ClaimOutcome?>(null)
    val lastClaimOutcome: StateFlow<ClaimOutcome?> = _lastClaimOutcome.asStateFlow()

    /**
     * The displaced latch as something the rest of the app can WATCH, rather
     * than a preference it has to remember to go and read.
     *
     * This is what makes "use this phone" stop the other phone immediately.
     * The nudge already arrives (notify-device-displaced -> FCM ->
     * [com.fenceestimator.app.notify.DeviceClaimPush.onNudge]) and the phone
     * already asks the server itself and writes [DISPLACED] when the answer is
     * a definite no. What it could not do was reach the screen: MainActivity
     * kept `displaced` in a plain `remember` recomputed only inside a
     * LaunchedEffect keyed on a counter bumped by ON_RESUME, so nothing
     * observed the preference. A crew member with the app OPEN in front of
     * them carried on typing, drawing and finishing jobs on a handset that had
     * already stopped syncing, and saw the notice only when they next
     * backgrounded the app and came back to it.
     *
     * In memory, and that is enough: the Firebase service has no
     * `android:process` in the manifest, so the nudge is handled in the same
     * process as the Activity, and the Activity comes up in that same process.
     * A process that really did die between the nudge and somebody opening the
     * app asks the server again on the way up -- MainActivity's own gate check
     * and AutoSync's re-ask both do -- so the flow is set by a fresh answer
     * rather than by a remembered one. [wasDisplaced] deliberately leaves this
     * alone; its own doc says why.
     *
     * Only ever set true by a definite server answer, because the only thing
     * that writes it is [setDisplaced] and the only caller that passes true is
     * [stillMine] on `answer == false`. Offline, a timeout and a refused call
     * all leave it exactly as it was -- the rule this whole gate is built
     * around (see the file header and [stillMine]).
     */
    private val _displacedNow = MutableStateFlow(false)
    val displacedNow: StateFlow<Boolean> = _displacedNow.asStateFlow()

    /**
     * Writes the latch to disk and to [displacedNow] in the same breath.
     *
     * One function rather than two statements at each site, so a future
     * writer cannot update the stored flag and leave the flow -- and therefore
     * the screen -- saying the opposite. The disk write is still allowed to
     * fail silently the way it always has; the flow is updated regardless,
     * because a screen that is wrong about this is worse than a preference
     * that has to be re-derived on the next pass.
     */
    private suspend fun setDisplaced(context: Context, value: Boolean) {
        runCatching { context.serviceStore.edit { it[DISPLACED] = value } }
        _displacedNow.value = value
    }

    suspend fun deviceId(context: Context): String {
        val existing = runCatching {
            context.serviceStore.data.first()[DEVICE_ID]
        }.getOrNull()
        if (!existing.isNullOrBlank()) return existing
        val made = java.util.UUID.randomUUID().toString()
        runCatching { context.serviceStore.edit { it[DEVICE_ID] = made } }
        return made
    }

    /**
     * Runs claim_device and says what happened, rather than throwing the
     * answer away -- the one place [claimThisDevice] and [reclaim] both call,
     * so a refusal is read the same way whichever one asked, and a caller
     * that passes no key gets exactly today's one-argument call.
     */
    private suspend fun attemptClaim(context: Context, keyCode: String?): ClaimOutcome {
        if (!SupabaseModule.hasLiveSession()) return ClaimOutcome.Failed
        val id = deviceId(context)
        val result = runCatching {
            SupabaseModule.client.postgrest.rpc(
                "claim_device",
                kotlinx.serialization.json.buildJsonObject {
                    put("device_id", kotlinx.serialization.json.JsonPrimitive(id))
                    keyCode?.filterNot { it.isWhitespace() }?.takeIf { it.isNotEmpty() }?.let {
                        put("key_code", kotlinx.serialization.json.JsonPrimitive(it))
                    }
                }
            )
        }
        if (result.isSuccess) return ClaimOutcome.Claimed
        val hint = generateSequence(result.exceptionOrNull()) { it.cause }
            .filterIsInstance<RestException>()
            .firstOrNull()
            ?.description
        return when (hint) {
            "device_key_required" -> ClaimOutcome.KeyRequired
            "device_key_invalid" -> ClaimOutcome.KeyInvalid
            else -> ClaimOutcome.Failed
        }
    }

    /** Called once the person is signed in: this phone takes the login. */
    suspend fun claimThisDevice(context: Context, keyCode: String? = null): ClaimOutcome {
        val outcome = attemptClaim(context, keyCode)
        _lastClaimOutcome.value = outcome
        // A REFUSAL keeps DISPLACED; anything else clears it.
        //
        // This used to clear it right after the runCatching no matter what came
        // back, so offline, a thrown exception and a deliberate refusal all
        // looked identical -- and a refused claim, which is the entire point of
        // device_key_required, said this phone was fine.
        //
        // Failed still clears it, deliberately, and that is not the same
        // oversight. DISPLACED halts AutoSync outright, so leaving it set after
        // a claim that merely did not land -- a dropped socket, a 5xx -- stops
        // every sync pass on a phone whose screen looks completely normal, with
        // nothing on it saying why. A refusal is different: there the block
        // screen is shown, so the flag matches what the person is being told.
        if (outcome is ClaimOutcome.Claimed || outcome is ClaimOutcome.Failed) {
            setDisplaced(context, false)
        }
        return outcome
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
        setDisplaced(context, !answer)
        return answer
    }

    /**
     * The stored latch, as stored. Deliberately does NOT touch [displacedNow].
     *
     * It is tempting to copy the disk value into the flow here, since AutoSync
     * asks this question on every pass and that would prime the flow after a
     * cold start. It is wrong, for two reasons.
     *
     * The flow drives the block screen, and the stored flag is a REMEMBERED
     * answer, not a current one. AutoSync's guard reads this and then re-asks
     * the server; priming the flow first would put "Signed in on another
     * phone" on screen for the length of that one RPC, every pass, on a phone
     * whose latch was merely stale -- a flash of a frightening sentence that
     * is then taken away, which is worse than the silence it replaced.
     *
     * And it is not needed. Nothing is lost after a cold start: the process
     * that handled the nudge is the process the Activity comes up in (the
     * Firebase service has no `android:process`), so the flow is already set
     * in the case the push covers; and a process that really did die is
     * opening, which runs both MainActivity's own check and AutoSync's
     * re-ask, each of which moves the flow on a DEFINITE answer through
     * [setDisplaced]. The invariant stated on [displacedNow] -- only ever set
     * true by a definite server answer -- is kept by leaving this alone.
     */
    suspend fun wasDisplaced(context: Context): Boolean =
        runCatching { context.serviceStore.data.first()[DISPLACED] }.getOrNull() ?: false

    /**
     * "Use this phone" on the signed-in-elsewhere screen: takes the login back
     * for this handset, the same claim a fresh sign-in makes here (newest
     * wins), so it gives nobody a seat they did not already have -- the other
     * phone is the one that stops, until it signs in or claims again.
     *
     * Kept apart from [claimThisDevice] because this one runs from a button
     * tap and only changes what the phone remembers -- DISPLACED, CLAIMED_FOR
     * -- once it knows the claim actually reached the server and was
     * accepted; [claimThisDevice] runs at sign-in, where the next check
     * re-asks regardless. Both now go through [attemptClaim] and both record
     * what happened in [lastClaimOutcome], so a caller here that wants more
     * than "did it work" -- specifically, whether a device key is needed or
     * was wrong -- reads that rather than getting only this Boolean.
     *
     * @param keyCode what the office read out, when [lastClaimOutcome] was
     *   [ClaimOutcome.KeyRequired] or [ClaimOutcome.KeyInvalid] on an earlier
     *   attempt. Sent as claim_device's second argument; left out (or blank)
     *   makes exactly the one-argument call this always made before keys
     *   existed.
     * @return true only when the server accepted the claim.
     */
    suspend fun reclaim(context: Context, keyCode: String? = null): Boolean = withContext(Dispatchers.IO) {
        if (!SupabaseModule.hasLiveSession()) {
            SupabaseModule.tryRefreshSession()
            if (!SupabaseModule.hasLiveSession()) {
                _lastClaimOutcome.value = ClaimOutcome.Failed
                return@withContext false
            }
        }
        val userId = SupabaseModule.currentUserId() ?: run {
            _lastClaimOutcome.value = ClaimOutcome.Failed
            return@withContext false
        }
        val outcome = attemptClaim(context, keyCode)
        _lastClaimOutcome.value = outcome
        if (outcome !is ClaimOutcome.Claimed) return@withContext false
        runCatching {
            context.serviceStore.edit {
                it[DISPLACED] = false
                it[CLAIMED_FOR] = userId
            }
        }
        // Kept as one edit so the two facts land together, which is why this
        // does not go through setDisplaced -- but the flow still has to be
        // told, or the screen this button is on would stay up after the claim
        // it just made succeeded.
        _displacedNow.value = false
        true
    }

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
            //
            // The outcome is READ, not discarded. It used to return true here
            // whatever came back, so a claim the server REFUSED for want of a
            // device key still opened the app fully unblocked -- AutoSync and
            // all -- and the block screen carrying the key field appeared only
            // on the next resume, when stillMine finally contradicted it. The
            // one case the whole feature exists for was the case that got a
            // free foreground cycle.
            val outcome = claimThisDevice(context)
            // Recorded only when the SERVER actually answered.
            //
            // This line used to run unconditionally, and that is the whole of
            // "signing in on another phone does not sync and keeps saying it
            // has not reached the cloud". [ClaimOutcome.Failed] is defined two
            // hundred lines up as "No session, offline, a timeout, or a
            // refusal that was neither hint" -- a question that was never
            // answered. Writing CLAIMED_FOR on it told this install it had
            // claimed this account when it had not, and because the branch
            // above only ever claims while `claimedFor != userId`, that was
            // PERMANENT: the phone never attempted a claim again for as long
            // as the app stayed installed. Every later check fell through to
            // stillMine, which correctly reported whichever handset really
            // did hold the login, DISPLACED latched true, and
            // AutoSync.runSync returned at its displaced guard on every pass
            // for ever. The phone somebody had just signed in on never
            // synced, and the sync card kept whatever sentence it last had,
            // because that guard copies only the phase and the error and
            // leaves hasUnsyncedWork and unsyncedReason alone.
            //
            // The window is not exotic. attemptClaim returns Failed the
            // instant there is no live token, and the first check after a
            // sign-in runs in exactly that window often enough that the owner
            // reported this twice.
            //
            // Claimed, KeyRequired and KeyInvalid are all definite answers
            // from the server and all still record, so a phone the server
            // refused does not retry the claim behind the block screen that
            // is already asking for its device key.
            if (outcome !is ClaimOutcome.Failed) {
                runCatching { context.serviceStore.edit { it[CLAIMED_FOR] = userId } }
            }
            // A refusal blocks. Anything ELSE -- including a failure -- still
            // returns true, deliberately: a crew member in a dead spot must
            // not be thrown out of the app because a call did not land. Only
            // a definite no from the server is a no.
            return outcome !is ClaimOutcome.KeyRequired && outcome !is ClaimOutcome.KeyInvalid
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
                reason = context.getString(R.string.gate_offline_too_long),
                trialDaysLeft = null
            )
        }

        val allowed = prefs[ALLOWED] ?: true
        val age = System.currentTimeMillis() - checkedAt

        // A remembered YES and a remembered NO are not worth the same.
        //
        // Failing open for a month offline is deliberate: a crew in a dead spot
        // keeps working. Failing CLOSED on a month-old no is a different thing
        // entirely -- it locks a working crew out on the strength of a fact
        // nobody has been able to re-check, and the person holding the phone
        // has no way to argue with it.
        //
        // This happened. A crew handset sat on "Your trial has ended" long
        // after the company was active and paying, because its session had
        // lapsed, the gate refuses to ask without one, and the stored answer
        // was the last thing anybody had told it. The owner's phone had since
        // asked again and moved on; the crew's could not.
        //
        // So a stale NO decays into "could not check" rather than staying a
        // verdict. The screen still stops them -- this does not hand the
        // product to a cancelled company -- but it stops them with the truth,
        // which is that this phone needs to reach the server, and that is
        // something a person can actually act on.
        if (!allowed && age > BLOCK_TRUST_MS) {
            return ServiceStatus(
                allowed = false,
                subscriptionStatus = prefs[STATUS].orEmpty(),
                plan = prefs[PLAN].orEmpty(),
                reason = context.getString(R.string.gate_block_unconfirmed),
                trialDaysLeft = null,
                subscribed = prefs[SUBSCRIBED] ?: false
            )
        }

        return ServiceStatus(
            allowed = allowed,
            subscriptionStatus = prefs[STATUS].orEmpty(),
            plan = prefs[PLAN].orEmpty(),
            reason = prefs[REASON].orEmpty(),
            trialDaysLeft = prefs[TRIAL_DAYS]?.takeIf { it >= 0 },
            subscribed = prefs[SUBSCRIBED] ?: false
        )
    }

    /** Thirty days without one successful check. */
    private const val OFFLINE_TRUST_MS = 30L * 24 * 60 * 60 * 1000

    /**
     * How long a remembered NO stays a verdict rather than a question.
     *
     * Deliberately far shorter than [OFFLINE_TRUST_MS]. Trusting a yes for a
     * month costs a company one month of a product they may have cancelled.
     * Trusting a no for a month costs a paying crew a month of work they are
     * entitled to, and they cannot tell why.
     */
    private const val BLOCK_TRUST_MS = 2L * 24 * 60 * 60 * 1000

    /** Forgotten on sign-out, so the next account is judged on its own terms. */
    suspend fun clear(context: Context) {
        runCatching { context.serviceStore.edit { it.clear() } }
        _lastClaimOutcome.value = null
        _displacedNow.value = false
    }

    /**
     * Everything this store holds ABOUT AN ACCOUNT, forgotten -- and nothing
     * about this handset.
     *
     * Called from [DataOwnership.onSignedOut], which is the one place every
     * sign-out in the app converges on. Before this existed, [clear] was
     * reached from exactly two screens -- the held-work sign-out and the
     * signed-in-elsewhere sign-out, both in MainActivity -- and the Sign out
     * button everybody actually uses (AccountViewModel.signOut) called
     * SupabaseModule.signOut() and nothing else. So [CLAIMED_FOR], [DISPLACED]
     * and the whole remembered service verdict survived an ordinary sign-out
     * into the next person's session on that phone: signing back in found
     * `claimedFor == userId` already true, never claimed, and was told by
     * device_still_mine that another handset holds the login -- which by then
     * was perfectly true, because the login had been used elsewhere in the
     * meantime.
     *
     * [DEVICE_ID] is deliberately kept, which is the whole reason this is not
     * just a call to [clear]. It is this install's identity, not the account's:
     * claim_device matches on it, notify-device-displaced addresses the
     * displaced handset by it, and a company that requires a device key for a
     * second phone (supabase_r8_device_keys.sql) would otherwise challenge
     * this handset again every single time somebody signed out and back in on
     * it, because a brand-new random id looks like a brand-new phone.
     *
     * Named keys rather than `clear()` minus one, so adding a key to this file
     * is a decision about whether it belongs to the account or to the
     * handset, instead of a silent default either way.
     */
    suspend fun forgetAccount(context: Context) {
        runCatching {
            context.serviceStore.edit { prefs ->
                prefs.remove(ALLOWED)
                prefs.remove(REASON)
                prefs.remove(STATUS)
                prefs.remove(PLAN)
                prefs.remove(CHECKED_AT)
                prefs.remove(TRIAL_DAYS)
                prefs.remove(SUBSCRIBED)
                prefs.remove(DISPLACED)
                prefs.remove(CLAIMED_FOR)
            }
        }
        _lastClaimOutcome.value = null
        _displacedNow.value = false
    }
}
