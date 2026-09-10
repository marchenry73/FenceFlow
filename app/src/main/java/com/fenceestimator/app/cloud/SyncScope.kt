package com.fenceestimator.app.cloud

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.Json

/**
 * Whether this phone's signed-in user may be handed money this pass.
 *
 * Three states, not two, because a failed question is not the same as a "no."
 * The app used to decide with `withPay.isEmpty()` -- treating an empty answer
 * as "not allowed" -- and an empty answer also means the request failed for
 * any other reason. When that happened the phone replaced real rates with
 * zeros and pushed them back over the truth: a real hourly rate on this
 * database went from 25 to 0 that way. See
 * memory/empty-answer-reads-as-good-news.md.
 *
 * [UNKNOWN] must never collapse into [ALLOWED] or [DENIED] anywhere in this
 * codebase. A pass that gets [UNKNOWN] skips every money-bearing table in
 * both directions and reports the sync as incomplete, never as "everything
 * is backed up."
 */
enum class MoneyScope { ALLOWED, DENIED, UNKNOWN }

/**
 * Asks the server, once per sync pass, rather than inferring anything from an
 * empty result.
 *
 * `can_see_pay()` (supabase_can_see_pay_patch.sql) answers with exactly
 * `coalesce(has_permission('SEE_MONEY'), false)` -- a real true or false for
 * anyone signed in, and a thrown error only when the request itself could not
 * be made (no signal, no session, the RPC missing on an old database). Only
 * the second case is folded into [MoneyScope.UNKNOWN]; the two real answers
 * are trusted as given.
 */
suspend fun askMoneyScope(): MoneyScope = foldPayAnswer(runCatching {
    SupabaseModule.client.postgrest.rpc("can_see_pay").decodeAs<Boolean>()
})

/**
 * Asks the server, once per sync pass, whether this account may see what a
 * PERSON is paid -- the four pay columns on `employees` -- which is a
 * different door than [askMoneyScope]'s job money.
 *
 * `can_see_employee_pay()` answers with exactly
 * `coalesce(has_permission('SEE_EMPLOYEE_PAY'), false)`, the same shape as
 * `can_see_pay()`: a real true or false for anyone signed in, and a thrown
 * error only when the request itself could not be made. Folded the same way,
 * for the same reason -- an empty answer here must read as "could not ask,"
 * not as "not allowed," or a dead spot on an owner's phone would scrub every
 * cached hourly rate exactly the way it once did for job money. See
 * [askMoneyScope]'s doc and memory/empty-answer-reads-as-good-news.md.
 */
suspend fun askEmployeePayScope(): MoneyScope = foldPayAnswer(runCatching {
    SupabaseModule.client.postgrest.rpc("can_see_employee_pay").decodeAs<Boolean>()
})

/**
 * The one fold both [askMoneyScope] and [askEmployeePayScope] use to turn a
 * `Result<Boolean>` into a [MoneyScope] -- pulled out so the rule that a
 * thrown error becomes [MoneyScope.UNKNOWN], never [MoneyScope.DENIED], is
 * written once and is directly testable without standing up a fake network
 * call for two RPCs that only differ in name.
 */
internal fun foldPayAnswer(result: Result<Boolean>): MoneyScope = result.fold(
    onSuccess = { canSeePay -> if (canSeePay) MoneyScope.ALLOWED else MoneyScope.DENIED },
    onFailure = { MoneyScope.UNKNOWN }
)

/**
 * Every `jobs` column `job_money_columns()` holds back from a caller without
 * SEE_MONEY, copied verbatim from supabase_crew_money_shield_patch.sql's A1
 * (`job_money_columns()`) -- this is the one list the views, the RPCs, the
 * hold trigger and this set all have to agree on.
 *
 * Two of these -- `quote_token` and `quote_viewed_at` -- are deliberately
 * NOT [CloudJob] fields at all: the quote token is fetched by
 * `JobDetailScreen.fetchQuoteToken` through its own single-column select,
 * which returns nothing for a non-SEE_MONEY caller once the base table is
 * gated, and the button that uses it is already behind `canSeeMoney`. See
 * [SyncScopeTest] for the test that keeps this list and [CloudJob]'s real
 * money fields in agreement.
 *
 * Used two ways: filtered out of the JSON this phone sends `crew_save_job`
 * (belt-and-suspenders -- the RPC drops the same keys server-side regardless),
 * and as the field list [Repository.forgetMoney] resets to [Job]'s own
 * defaults the moment this phone is confirmed [MoneyScope.DENIED].
 */
val MONEY_KEYS: Set<String> = setOf(
    "tax_rate_percent", "markup_percent", "discount_percent",
    "labor_rate_per_ft", "labor_flat_fee", "minimum_job_charge",
    "teardown_flat_fee", "teardown_rate_per_ft", "gate_rate_per_ft", "trash_haul_fee",
    "deposit_amount", "amount_paid", "refunded_amount", "refunded_at", "refund_reason",
    "payment_status", "is_invoiced", "payments_from_processor",
    "contract_total", "signed_contract_total", "tip_amount",
    "payment_link_url", "payment_link_amount",
    "pricing_tier_name", "supplier_quote_reference",
    "quote_token", "quote_sent_at", "quote_viewed_at"
)

/**
 * The two [MONEY_KEYS] with no [CloudJob] counterpart -- see the doc on
 * [MONEY_KEYS] for why. Named here, rather than left as a bare difference in
 * a test, so the gap is something this file asserts on purpose instead of
 * something a reader has to rediscover.
 */
internal val MONEY_KEYS_NOT_ON_CLOUD_JOB: Set<String> = setOf("quote_token", "quote_viewed_at")

/**
 * Matches the Supabase client's own encoder (see `SupabaseModule.client`'s
 * `defaultSerializer`): `encodeDefaults = true` so a field merely equal to its
 * Kotlin default (an empty string, a zero) still travels -- otherwise
 * clearing a field back to blank would silently fail to sync, because the
 * RPCs on the other end only touch a column whose key is actually present in
 * the payload. `ignoreUnknownKeys` and `explicitNulls = false` for the same
 * reason the client uses them: a view or an RPC response missing a column
 * this build doesn't know about yet must decode, not throw.
 */
internal val SyncJson = Json {
    encodeDefaults = true
    ignoreUnknownKeys = true
    explicitNulls = false
}

private val Context.moneyScopeStore by preferencesDataStore(name = "money_scope")

/**
 * Remembers the last DEFINITE answer [askMoneyScope] gave, per signed-in
 * user, so the next pass can tell a door FLIPPING from a door that has simply
 * been the same for months.
 *
 * [MoneyScope.UNKNOWN] is never written here -- it is "could not ask," not an
 * answer, and writing it would let a network hiccup erase the phone's memory
 * of which side of the door it was actually on.
 */
object MoneyScopeMemory {
    private fun key(uid: String) = stringPreferencesKey("money_scope_last_$uid")

    /** @return the last ALLOWED/DENIED answer for [uid], or null if this phone has never had one. */
    suspend fun last(context: Context, uid: String): MoneyScope? {
        val stored = context.moneyScopeStore.data.first()[key(uid)] ?: return null
        return runCatching { MoneyScope.valueOf(stored) }.getOrNull()
    }

    suspend fun remember(context: Context, uid: String, scope: MoneyScope) {
        if (scope == MoneyScope.UNKNOWN) return
        context.moneyScopeStore.edit { prefs -> prefs[key(uid)] = scope.name }
    }
}
