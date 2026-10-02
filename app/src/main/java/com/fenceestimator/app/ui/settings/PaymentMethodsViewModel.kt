package com.fenceestimator.app.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.cloud.SupabaseModule
import com.fenceestimator.app.cloud.SyncFailure
import com.fenceestimator.app.data.PaymentLimits
import com.fenceestimator.app.data.PaymentMethodRules
import com.fenceestimator.app.data.PaymentMethods
import com.fenceestimator.app.data.PaymentMethodsCache
import com.fenceestimator.app.data.PaymentMethodsForm
import com.fenceestimator.app.data.PaymentMethodsRefused
import com.fenceestimator.app.data.PaymentMethodsRejection
import com.fenceestimator.app.data.SettingsStore
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.query.Columns
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The phone's half of "How customers can pay you".
 *
 * Reads and writes exactly what the office reads and writes: the one key
 * `payment_methods` in `company_settings.settings`, through the same
 * `save_company_settings()` RPC, plus the sibling key `payment_limits` for the
 * receiving limit he asked for. See data/PaymentMethods.kt for why the limit is
 * a sibling and not a field inside the method.
 *
 * THE GATE IS THE SERVER'S, AND IT IS NAMED, NOT INVENTED.
 * `company_settings` carries a RESTRICTIVE select policy
 * (`company_settings_money_needs_permission`) that hands no row at all to
 * anybody without SEE_MONEY or the OWNER/MANAGER role, and
 * `save_company_settings()` refuses a write from anyone but OWNER or MANAGER.
 * A wire routing number is money, so it is behind the money shield. The screen
 * asks the same two named capabilities the rest of the app asks -- SEE_MONEY to
 * read and EDIT_CATALOG_AND_SETTINGS to write -- so the layout agrees with the
 * database instead of being the only thing standing between a crew phone and a
 * bank account. Neither is a new permission.
 *
 * "SAVED" IS ONLY SAID ABOUT WHAT IS STORED. `save_company_settings()` returns
 * nothing, so the absence of an error is not proof of a write; this reads the
 * keys back and compares them, exactly as the office page does.
 */
class PaymentMethodsViewModel(
    private val settingsStore: SettingsStore,
    private val appScope: CoroutineScope
) : ViewModel() {

    sealed interface Status {
        /** No server read has succeeded yet on this phone. The form stays locked. */
        data object Unknown : Status
        /** Showing what the server holds. */
        data object Loaded : Status
        /** Showing the last copy this phone read; the server could not be reached. */
        data object Offline : Status
        /** Saved on this phone and not yet on the server. Still unsent. */
        data object Pending : Status
        /** Saved, read back, and the read-back matched. */
        data object Saved : Status
        /** Refused before anything was written. Nothing was sent. */
        data class Refused(val rejection: PaymentMethodsRejection) : Status
        /** The server took the write but the read-back disagreed, or failed. */
        data object VerifyFailed : Status
        /**
         * The server answered and said no. Not a dead spot, so it is NOT
         * queued: it would be refused again on every retry.
         * save_company_settings() is OWNER/MANAGER only.
         */
        data object ServerRefused : Status
    }

    private val _status = MutableStateFlow<Status>(Status.Unknown)
    val status: StateFlow<Status> = _status.asStateFlow()

    private val _methods = MutableStateFlow(PaymentMethods())
    val methods: StateFlow<PaymentMethods> = _methods.asStateFlow()

    private val _limits = MutableStateFlow(PaymentLimits())
    val limits: StateFlow<PaymentLimits> = _limits.asStateFlow()

    /** True once a real read has succeeded here, so the form may be edited. */
    private val _editable = MutableStateFlow(false)
    val editable: StateFlow<Boolean> = _editable.asStateFlow()

    private var busy = false

    /**
     * Show the cached copy at once -- he may be in the yard with no signal --
     * then try the server and correct it.
     */
    fun load(companyId: String?) {
        viewModelScope.launch {
            val cached = settingsStore.paymentMethods.first()
            applyCache(cached)
            if (cached.pending) {
                // There is an unsent edit. Try to send it before reading, or
                // the read would show him the older server copy as though his
                // save had never happened.
                flushPending(companyId)
                return@launch
            }
            refresh(companyId)
        }
    }

    private fun applyCache(cached: PaymentMethodsCache) {
        _methods.value = PaymentMethodRules.canon(PaymentMethodRules.parseOrNull(cached.methodsJson))
        _limits.value = PaymentMethodRules.canonLimits(PaymentMethodRules.parseOrNull(cached.limitsJson))
        _editable.value = cached.loaded
        _status.value = when {
            cached.pending -> Status.Pending
            cached.loaded -> Status.Offline
            else -> Status.Unknown
        }
    }

    /** One read of the two keys. Null means the read FAILED -- never "nothing stored". */
    private suspend fun readStored(companyId: String): Pair<JsonElement?, JsonElement?>? =
        runCatching {
            val row = SupabaseModule.client.postgrest.from("company_settings")
                .select(
                    Columns.raw(
                        "payment_methods:settings->payment_methods," +
                            "payment_limits:settings->payment_limits"
                    )
                ) { filter { eq("company_id", companyId) } }
                .decodeSingleOrNull<JsonObject>()
            (row?.get("payment_methods")) to (row?.get("payment_limits"))
        }.getOrNull()

    private suspend fun refresh(companyId: String?) {
        if (companyId == null || !SupabaseModule.isConfigured) return
        val got = readStored(companyId)
        if (got == null) {
            // A failed read must never be treated as "the company set nothing
            // up". If we have never had a good read, the form stays locked.
            _status.value = if (_editable.value) Status.Offline else Status.Unknown
            return
        }
        val (methodsJson, limitsJson) = got
        _methods.value = PaymentMethodRules.canon(methodsJson)
        _limits.value = PaymentMethodRules.canonLimits(limitsJson)
        _editable.value = true
        _status.value = Status.Loaded
        withContext(NonCancellable) {
            settingsStore.cachePaymentMethods(
                methodsJson = methodsJson?.toString() ?: "",
                limitsJson = limitsJson?.toString() ?: ""
            )
        }
    }

    /** The exact text a customer would read, for the confirm step. */
    fun preview(form: PaymentMethodsForm) =
        PaymentMethodRules.fromForm(form).map { (methods, limits) ->
            PaymentMethodRules.publicView(methods) to limits
        }

    /** Validate without writing, so the confirm sheet is never opened on bad input. */
    fun check(form: PaymentMethodsForm): PaymentMethodsRejection? =
        PaymentMethodRules.fromForm(form).exceptionOrNull()
            ?.let { (it as? PaymentMethodsRefused)?.rejection }

    /**
     * Write it. Local first and uncancellable, then the server, then a read-back
     * that has to agree before the word "Saved" is used.
     *
     * The local write is never gated on the server: he is in the yard, and a
     * detail typed with no signal must survive. It is flagged unsent until a
     * flush succeeds.
     */
    fun save(companyId: String?, form: PaymentMethodsForm) {
        if (busy || !_editable.value) return
        val built = PaymentMethodRules.fromForm(form)
        val refused = built.exceptionOrNull()
        if (refused != null) {
            // fromForm only ever fails with PaymentMethodsRefused. If it ever
            // failed with something else, say "could not store it" rather than
            // naming a reason that was not the reason: a refusal message that
            // blames the wrong box sends him to fix a field that is fine.
            val rejection = (refused as? PaymentMethodsRefused)?.rejection
            _status.value = if (rejection != null) Status.Refused(rejection) else Status.VerifyFailed
            return
        }
        val (methods, limits) = built.getOrThrow()
        val methodsJson = PaymentMethodRules.toStoredJson(methods)
        val limitsJson = PaymentMethodRules.limitsToStoredJson(limits)
        busy = true
        appScope.launch {
            try {
                _methods.value = methods
                _limits.value = limits

                // LOCAL FIRST, and recorded as unsent. He is in the yard: if
                // the app is killed, the phone is put in a pocket or the signal
                // goes while the request is in flight, what he typed is already
                // on the handset and flagged to be sent. Pushing first and
                // writing afterwards lost the edit in exactly those cases --
                // the save would simply never have happened, with nothing on
                // screen having said so.
                withContext(NonCancellable) {
                    settingsStore.savePaymentMethodsPending(methodsJson.toString(), limitsJson.toString())
                }
                _status.value = Status.Pending

                when (val sent = push(companyId, methodsJson, limitsJson)) {
                    PushResult.VERIFIED -> {
                        withContext(NonCancellable) {
                            settingsStore.savePaymentMethodsSynced(methodsJson.toString(), limitsJson.toString())
                        }
                        _status.value = Status.Saved
                    }
                    // Both left exactly as written above: on the phone, flagged
                    // unsent, and retried on the next open or on "Send it now".
                    PushResult.UNREACHABLE, PushResult.READBACK_UNKNOWN ->
                        _status.value = Status.Pending
                    PushResult.VERIFY_FAILED, PushResult.SERVER_REFUSED -> {
                        // The server ANSWERED: what came back is not what was
                        // sent, or it said no outright. Retrying would be
                        // refused again every time while the screen claimed it
                        // was on its way, so clear the outbox and say what
                        // happened. Then re-read, so what he sees is what is
                        // really stored rather than what he typed. The outbox
                        // is cleared WITHOUT marking his rejected values
                        // synced, which would have left the phone presenting
                        // them as the company's stored details.
                        withContext(NonCancellable) { settingsStore.clearPaymentMethodsPending() }
                        _status.value =
                            if (sent == PushResult.SERVER_REFUSED) Status.ServerRefused else Status.VerifyFailed
                        refresh(companyId)
                    }
                }
            } finally {
                busy = false
            }
        }
    }

    /** Try again to send an edit that only ever reached this phone. */
    fun flushPending(companyId: String?) {
        if (busy) return
        busy = true
        appScope.launch {
            try {
                val cached = settingsStore.paymentMethods.first()
                if (!cached.pending) return@launch
                val methodsJson = PaymentMethodRules.parseOrNull(cached.methodsJson) as? JsonObject
                val limitsJson = PaymentMethodRules.parseOrNull(cached.limitsJson) as? JsonObject
                if (methodsJson == null || limitsJson == null) return@launch
                when (push(companyId, methodsJson, limitsJson)) {
                    PushResult.VERIFIED -> {
                        withContext(NonCancellable) {
                            settingsStore.savePaymentMethodsSynced(cached.methodsJson, cached.limitsJson)
                        }
                        _methods.value = PaymentMethodRules.canon(methodsJson)
                        _limits.value = PaymentMethodRules.canonLimits(limitsJson)
                        _editable.value = true
                        _status.value = Status.Saved
                    }
                    // Still unsent, still queued.
                    PushResult.UNREACHABLE, PushResult.READBACK_UNKNOWN ->
                        _status.value = Status.Pending
                    // The server answered and will answer the same way again:
                    // stop retrying, and do not mark the rejected values as the
                    // company's stored details.
                    PushResult.VERIFY_FAILED -> {
                        withContext(NonCancellable) { settingsStore.clearPaymentMethodsPending() }
                        _status.value = Status.VerifyFailed
                        refresh(companyId)
                    }
                    PushResult.SERVER_REFUSED -> {
                        withContext(NonCancellable) { settingsStore.clearPaymentMethodsPending() }
                        _status.value = Status.ServerRefused
                    }
                }
            } finally {
                busy = false
            }
        }
    }

    /**
     * [READBACK_UNKNOWN] is kept apart from [VERIFY_FAILED] on purpose, and the
     * difference decides whether his edit is kept in the outbox.
     *
     *  - [VERIFY_FAILED]: the read-back SUCCEEDED and came back different. The
     *    write landed as something else or was ignored. Retrying sends the same
     *    thing again, so the outbox is cleared and the screen says so.
     *  - [READBACK_UNKNOWN]: the read-back itself FAILED, so whether the write
     *    landed is simply not known. The edit STAYS in the outbox and is sent
     *    again later -- the write is a whole-key overwrite, so sending it twice
     *    is harmless, whereas clearing it would be the silent loss this panel
     *    exists to avoid. An empty answer is not good news.
     */
    private enum class PushResult { VERIFIED, UNREACHABLE, VERIFY_FAILED, READBACK_UNKNOWN, SERVER_REFUSED }

    /**
     * ONE write: one `save_company_settings` call carrying the two keys, each
     * WHOLE. Never a write to the `companies` row -- every member of a company
     * can read that row, crew included -- and never a partial method object,
     * because the RPC merges with `||`, which is shallow, so a partial one
     * erases the methods it left out.
     */
    private suspend fun push(
        companyId: String?,
        methodsJson: JsonObject,
        limitsJson: JsonObject
    ): PushResult {
        if (companyId == null || !SupabaseModule.isConfigured) return PushResult.UNREACHABLE
        val wrote = runCatching {
            SupabaseModule.client.postgrest.rpc(
                "save_company_settings",
                buildJsonObject {
                    put(
                        "new_settings",
                        buildJsonObject {
                            put("payment_methods", methodsJson)
                            put("payment_limits", limitsJson)
                        }
                    )
                }
            )
        }
        // A dead spot and a refusal are different answers and must not share a
        // path. Queueing a refusal as "not sent yet" would retry it on every
        // visit, forever, while telling him it is on its way: the server will
        // refuse it every time (save_company_settings is OWNER/MANAGER only).
        // SyncFailure.isTransientNetwork is the app's existing test, and it
        // treats ANY answer from the server -- any RestException, any status --
        // as not a lost connection.
        wrote.exceptionOrNull()?.let {
            return if (SyncFailure.isTransientNetwork(it)) PushResult.UNREACHABLE
            else PushResult.SERVER_REFUSED
        }
        // The read-back FAILING is not the same answer as the read-back
        // DISAGREEING. See PushResult.
        val back = readStored(companyId) ?: return PushResult.READBACK_UNKNOWN
        val sameMethods = PaymentMethodRules.same(back.first, methodsJson)
        val sameLimits = PaymentMethodRules.sameLimits(back.second, limitsJson)
        return if (sameMethods && sameLimits) PushResult.VERIFIED else PushResult.VERIFY_FAILED
    }
}
