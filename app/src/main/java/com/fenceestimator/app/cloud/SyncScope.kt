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
 * anyone signed in with a profile row, and a thrown error when the request
 * could not be made, when no identity is attached, or when this database holds
 * no profile for that id. Every throw is folded into [MoneyScope.UNKNOWN]; the
 * two real answers are trusted as given.
 *
 * [onCouldNotAsk] is handed the throwable when there is one, so the REASON
 * survives the fold -- see [askScopeWith]. It defaults to doing nothing, which
 * is right for a caller that only wants the answer; AutoSync passes a reporter
 * because the first sync after signing in on a new phone is the one that most
 * often cannot ask, and it was the one nobody could explain.
 */
suspend fun askMoneyScope(onCouldNotAsk: (Throwable) -> Unit = {}): MoneyScope =
    askScopeWith(onCouldNotAsk) {
        SupabaseModule.client.postgrest.rpc("can_see_pay").decodeAs<Boolean>()
    }

/**
 * The ask, with the REASON kept.
 *
 * `can_see_pay()` tells three causes apart and says which in its message:
 * `auth.uid()` was null (the phone's token had not attached yet), there is no
 * `profiles` row for that id (an account still being linked to its company),
 * or the request never reached the database at all. Every one of them folds to
 * [MoneyScope.UNKNOWN], which is correct -- none of them is a "no" -- but
 * [foldPayAnswer] then dropped the throwable, so all three looked identical
 * from the phone.
 *
 * That is the fact B2 needs. An UNKNOWN pass does no job work at all, which is
 * why signing in on a second phone can sit on an empty list; which of the
 * three causes it is decides whether the fix is a wait, a retry or a repair,
 * and until now it was never recorded. See
 * memory/flag-written-for-no-reader.md -- same shape, other way round: a
 * reason nobody wrote down rather than one nobody read.
 *
 * Separated from the RPC so the reporting contract can be tested with a fake
 * answer instead of a network call, and kept `internal` so only this file's
 * two doors use it.
 */
internal suspend fun askScopeWith(
    onCouldNotAsk: (Throwable) -> Unit,
    ask: suspend () -> Boolean,
): MoneyScope {
    val answer = runCatching { ask() }
    // Reported whatever it is, cancellations included: deciding which
    // failures are worth keeping is CrashReporter's job and it already drops
    // those and lost connections, so a dead spot files nothing while "no
    // profile row for <uid>" files once.
    answer.exceptionOrNull()?.let(onCouldNotAsk)
    return foldPayAnswer(answer)
}

/**
 * Asks the server, once per sync pass, whether this account may see what a
 * PERSON is paid -- the four pay columns on `employees` -- which is a
 * different door than [askMoneyScope]'s job money.
 *
 * `can_see_employee_pay()` answers with exactly
 * `coalesce(has_permission('SEE_PAY'), false)` -- the same SHAPE as
 * `can_see_pay()`, which asks `SEE_MONEY`: a real true or false for anyone
 * signed in with a profile, and a thrown error when the request could not be
 * made or when there is no identity to judge (r59).
 *
 * `SEE_PAY`, NOT `SEE_EMPLOYEE_PAY`. This doc said the latter for as long as
 * the function has existed, and no role in `has_permission()` grants a
 * permission by that name -- so a reader who trusts this line and rewrites the
 * function from it takes payroll away from every owner, manager and accountant
 * at once. That happened on 30 Oct 2026 while fixing r59, and
 * tests/a16-payrate-permission-fix.test.mjs caught it in one line because its
 * POSITIVE CONTROL asserts an ACCOUNTANT reads true. The authority for both
 * doors is `supabase_can_see_pay_restored.sql`; read the live function, never
 * the comment about it. Folded the same way,
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
 * (belt-and-suspenders -- the RPC drops the same keys server-side regardless,
 * and [CREW_WRITABLE_JOB_KEYS] already leaves them out), and as the field
 * list [Repository.forgetMoney] resets to [Job]'s own defaults the moment
 * this phone is confirmed [MoneyScope.DENIED].
 */
val MONEY_KEYS: Set<String> = setOf(
    "tax_rate_percent", "markup_percent", "discount_percent",
    "labor_rate_per_ft", "labor_flat_fee", "minimum_job_charge", "minimum_labor_charge",
    "teardown_flat_fee", "teardown_rate_per_ft", "gate_rate_per_ft", "trash_haul_fee",
    "deposit_amount", "deposit_is_auto", "amount_paid", "refunded_amount", "refunded_at", "refund_reason",
    "payment_status", "is_invoiced", "payments_from_processor",
    "contract_total", "signed_contract_total", "tip_amount",
    "payment_link_url", "payment_link_amount",
    "pricing_tier_name", "supplier_quote_reference",
    "quote_token", "quote_sent_at", "quote_viewed_at",
    // What the customer agreed to pay (the server change that adds
    // jobs.accepted_total adds it to job_money_columns() too). It is a price, so crew never
    // read it and never send it -- and the phone never sends it at all: the
    // server stamps it at acceptance. See Job.acceptedTotal.
    "accepted_total"
)

/**
 * The only `jobs` columns a phone WITHOUT EDIT_JOBS (crew, foreman) may send
 * through `crew_save_job`. A verbatim copy of `public.crew_writable_job_columns()`;
 * `JobSyncCrewDoorTest` finds the supabase_*.sql file that defines it, reads
 * its array, and fails the moment the two lists differ -- so change both
 * together.
 *
 * An allowlist, not "everything minus [MONEY_KEYS]". The phone used to send
 * its whole local row, and the RPC wrote every key it was given, so a crew
 * phone holding an older copy of a job blanked the office's notes, HOA and
 * permit details, and wrote priced_by = '' over a real pricing record
 * (job 10b0407f, 2026-09-21) -- and a customer name typed into the crew
 * phone's editable Customer card moved updated_at with nothing behind it, so
 * the pull then wrote a blank name back over the phone (job 4598150b). What a
 * crew member legitimately changes from the field is this list: finishing the
 * job, the held-up report, the locate ticket, the closing sign-off and the
 * drawing they made. Nothing else.
 *
 * `status` is on it only so a crew phone can mark a job COMPLETED; the server
 * drops any other value, and [buildCrewSaveJobPayload] never sends one.
 */
val CREW_WRITABLE_JOB_KEYS: Set<String> = setOf(
    "status",
    "blocked_reason", "blocked_at", "customer_must_clear", "customer_notified_at", "overrun_reason",
    "locate_ticket_no", "locate_called_at", "locate_dig_after", "locate_expires_at", "locate_notes",
    "teardown_feet", "final_sign_off_storage_path", "final_sign_off_at",
    "survey_storage_path", "calibration_pixels_per_foot", "calibration_known_feet",
    "grid_extent_ft", "grid_feet_per_square", "site_lat", "site_lon"
)

/**
 * Added to [CREW_WRITABLE_JOB_KEYS] only for a caller holding
 * SCHEDULE_AND_ASSIGN (a foreman), the same condition `crew_save_job` applies
 * server-side. A crew phone without it must not send a duration at all: the
 * job screen used to write its own computed hours on open, and a crew
 * handset pushed 93.33 hours over the office's 4 on job 4598150b.
 *
 * When and who, too. Scheduling and assigning is what the FOREMAN role is
 * for, and crew_save_job let it move both until the allowlist went in and
 * dropped them for everyone without EDIT_JOBS -- foremen could no longer
 * reschedule or reassign anywhere (supabase_crew_job_scope.sql's
 * crew_strip_assignment had kept exactly these for SCHEDULE_AND_ASSIGN).
 * The server lets the same keys through for the same permission
 * (supabase_r6_crew_writes.sql), plus the never-written assigned_employee_id.
 */
val CREW_SCHEDULER_JOB_KEYS: Set<String> = setOf(
    "estimated_duration_hours", "duration_manually_set",
    "scheduled_date", "assigned_employee_sync_id"
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
