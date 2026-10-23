package com.fenceestimator.app.cloud

import com.fenceestimator.app.BuildConfig
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.query.Columns
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
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * THE PLATFORM CONSOLE'S POWERS, FROM THE PHONE.
 *
 * The same calls website/admin.html makes, and nothing more: nine functions,
 * one column update and one invitation. They are listed in one file so the
 * whole of what an admin can do from here can be read at once -- if a power
 * is not in this file, the app does not have it.
 *
 * NOTHING HERE IS A PERMISSION CHECK. Every function below is SECURITY
 * DEFINER behind is_platform_admin(), which since
 * supabase_r7_admin_second_factor.sql requires a session that did password AND
 * the authenticator (aal2), read from auth.sessions.aal first and the signed
 * claim second. So a call from a phone that has not stepped up comes back
 * empty or refused, by the database, not by this file. [AdminGate] decides
 * what to SHOW; this decides nothing. The two are deliberately separate so a
 * mistake in the screen cannot become a mistake in what is allowed.
 *
 * EVERY CALL RETURNS A Result. An admin screen that renders an empty list for
 * "refused" and for "there are none" would be the same bug this project keeps
 * meeting -- an empty answer reading as good news. The failures are carried
 * back so the screen can say which it is.
 */
object AdminRepository {

    @Serializable
    data class Company(
        val id: String,
        val name: String = "",
        val email: String = "",
        @SerialName("subscription_status") val subscriptionStatus: String? = null,
        val suspended: Boolean = false,
        @SerialName("trial_ends_at") val trialEndsAt: String? = null,
        @SerialName("days_left") val daysLeft: Int? = null,
        /** The server's own verdict on whether their office opens today. */
        val allowed: Boolean = false,
        val people: Long = 0,
        val jobs: Long = 0,
        @SerialName("last_active") val lastActive: String? = null,
        @SerialName("admin_notes") val adminNotes: String = "",
        @SerialName("subscription_plan") val subscriptionPlan: String? = null,
        @SerialName("billing_email") val billingEmail: String? = null,
        @SerialName("monthly_price") val monthlyPrice: Double? = null,
        /**
         * HOW ALIVE THIS COMPANY IS -- the same three counts the web console
         * shows, over the same thirty days.
         *
         * people and jobs above are totals EVER, and a total never goes down,
         * so a company that stopped in August reads exactly like one that used
         * it this morning. Three counts rather than one because they fail
         * differently: last_seen_at is written by the PHONE, so a company that
         * only opens the office website reads as nobody-seen.
         *
         * Default 0 so a build talking to a database without the columns shows
         * "no" rather than crashing on a missing key -- and [health] answers
         * Unknown in that case rather than Dormant, because absent data is not
         * a verdict. See supabase_r25_company_health.sql.
         */
        @SerialName("active_people_30d") val activePeople30d: Long = 0,
        @SerialName("jobs_30d") val jobs30d: Long = 0,
        @SerialName("quotes_30d") val quotes30d: Long = 0,
        @SerialName("joined_at") val joinedAt: String? = null,
    ) {
        /** Active / Quiet / Dormant, by the console's own rule. */
        val health: Health
            get() = when {
                joinedAt == null -> Health.NOT_STARTED
                jobs30d > 0 || quotes30d > 0 -> Health.ACTIVE
                activePeople30d > 0 -> Health.QUIET
                else -> Health.DORMANT
            }
    }

    /**
     * What "using it" means, in one word.
     *
     * NOT_STARTED is its own answer rather than Dormant: a company invited and
     * never signed in has nothing to measure, Status already says Invited, and
     * a red word there would make the list look alarming about the one state
     * that is nobody's fault yet.
     */
    enum class Health { ACTIVE, QUIET, DORMANT, NOT_STARTED }

    @Serializable
    data class Release(
        /** Needed by admin_promote_release / admin_demote_release. */
        val id: String = "",
        @SerialName("version_code") val versionCode: Int = 0,
        @SerialName("version_name") val versionName: String = "",
        val notes: String = "",
        val audience: String = "",
        @SerialName("is_mandatory") val isMandatory: Boolean = false,
        @SerialName("download_url") val downloadUrl: String? = null,
    )

    @Serializable
    data class ErrorGroup(
        val message: String = "",
        @SerialName("where_at") val whereAt: String = "",
        val occurrences: Long = 0,
        @SerialName("last_seen") val lastSeen: String? = null,
        /** How many handsets, and how many companies, have hit it. */
        val devices: Long = 0,
        val companies: Long = 0,
        @SerialName("first_seen") val firstSeen: String? = null,
        /**
         * The newest build this was seen on -- or the word "office".
         *
         * The office web app files its failures to the same table with
         * version_name 'office' and no version code, so this is NOT always a
         * version number and must never be compared as one. [isOffice] is the
         * only test that should be applied to it.
         */
        @SerialName("latest_version") val latestVersion: String? = null,
        @SerialName("any_unseen") val anyUnseen: Boolean = true,
    ) {
        /** Came from the office website, not from a phone. */
        val isOffice: Boolean get() = latestVersion.equals("office", ignoreCase = true)
    }

    /**
     * One job where the two pricing engines disagreed about a total.
     *
     * Read straight from the table, the way the console reads it: pricing_drift
     * carries one policy and it is the platform operator's, so this returns
     * nothing at all to anybody else rather than relying on the screen to hide
     * it.
     */
    @Serializable
    data class Drift(
        val id: String = "",
        @SerialName("job_sync_id") val jobSyncId: String = "",
        @SerialName("office_total") val officeTotal: Double = 0.0,
        @SerialName("phone_total") val phoneTotal: Double = 0.0,
        @SerialName("office_engine") val officeEngine: String = "",
        @SerialName("phone_engine") val phoneEngine: String = "",
        @SerialName("noted_at") val notedAt: String? = null,
        @SerialName("seen_at") val seenAt: String? = null,
    ) {
        /** What the disagreement is worth, which is the number worth sorting on. */
        val gap: Double get() = kotlin.math.abs(officeTotal - phoneTotal)
    }

    @Serializable
    data class SignInAttemptGroup(
        val email: String = "",
        val attempts: Long = 0,
        @SerialName("last_at") val lastAt: String? = null,
    )

    /** A company in the recycle bin: removed, with everything of theirs intact. */
    @Serializable
    data class RemovedCompany(
        val id: String = "",
        val name: String = "",
        val email: String? = null,
        @SerialName("removed_at") val removedAt: String? = null,
        val people: Long = 0,
        val jobs: Long = 0,
    )

    /** One client's conversation, as the console's Email clients screen lists them. */
    @Serializable
    data class ClientEmailThread(
        @SerialName("company_id") val companyId: String = "",
        @SerialName("company_name") val companyName: String? = null,
        @SerialName("to_email") val toEmail: String = "",
        val messages: Long = 0,
        @SerialName("sent_count") val sentCount: Long = 0,
        @SerialName("failed_count") val failedCount: Long = 0,
        @SerialName("unconfirmed_count") val unconfirmedCount: Long = 0,
        @SerialName("last_at") val lastAt: String? = null,
        @SerialName("last_subject") val lastSubject: String? = null,
    )

    /** One message in that conversation. */
    @Serializable
    data class ClientEmail(
        val id: Long = 0,
        @SerialName("created_at") val createdAt: String? = null,
        @SerialName("to_email") val toEmail: String = "",
        val subject: String = "",
        val body: String = "",
        @SerialName("send_state") val sendState: String = "",
        @SerialName("send_error") val sendError: String? = null,
        @SerialName("sent_by_email") val sentByEmail: String? = null,
    )

    private suspend fun <T> io(block: suspend () -> T): Result<T> =
        withContext(Dispatchers.IO) { runCatching { block() } }

    // -------------------------------------------------------- who is asking

    @Serializable
    private data class AdminFlag(
        @SerialName("is_platform_admin") val isPlatformAdmin: Boolean = false,
    )

    /**
     * Is the signed-in account a platform admin?
     *
     * Read from the server, never guessed from an email address or a role.
     * An ordinary owner reading this sees their own row and `false`, which is
     * the right answer and not an error.
     *
     * A FAILED LOOKUP IS NOT A `false`. It comes back as a failed Result, and
     * [AdminGate] is only told `true` when the server actually said so. The
     * console learned this the hard way (admin.html:1916): treating a network
     * blip as "not staff" signs the real admin out and costs him his password
     * and his code again.
     */
    suspend fun isPlatformAdmin(): Result<Boolean> = io {
        val uid = SupabaseModule.client.auth.currentSessionOrNull()?.user?.id
            ?: error("not signed in")
        SupabaseModule.client.postgrest.from("profiles")
            .select(Columns.list("is_platform_admin")) { filter { eq("id", uid) } }
            .decodeSingleOrNull<AdminFlag>()
            ?.isPlatformAdmin ?: false
    }

    // ---------------------------------------------------------------- read

    /** How many history rows one tap asks for. */
    const val HISTORY_PAGE: Long = 25

    /**
     * One line of a company's history: who changed what, and when.
     *
     * The same audit_log rows the console's Audit log shows, read for ONE
     * company -- which is the question somebody actually has when they have
     * that company's dialog open. Only the columns the screen prints: the row
     * also carries a record id and a company id, and neither is anything a
     * person reads.
     */
    @Serializable
    data class AuditEntry(
        val at: String? = null,
        @SerialName("actor_email") val actorEmail: String = "",
        @SerialName("table_name") val tableName: String = "",
        val action: String = "",
        val field: String? = null,
        @SerialName("old_value") val oldValue: String? = null,
        @SerialName("new_value") val newValue: String? = null,
        val label: String? = null,
    )

    /**
     * A page of one company's history, newest first.
     *
     * PAGED, and not merely limited: audit_log gains a row for every field
     * changed, so it is the table most likely to pass a thousand rows for a
     * busy company -- and a read that asks for everything gets exactly a
     * thousand back with no error and no sign that there was more. [offset]
     * is how the screen asks for the next page rather than re-reading the
     * first.
     */
    suspend fun companyHistory(
        companyId: String,
        offset: Long = 0,
        limit: Long = HISTORY_PAGE,
    ): Result<List<AuditEntry>> = io {
        SupabaseModule.client.postgrest.from("audit_log")
            .select(
                Columns.list("at", "actor_email", "table_name", "action", "field", "old_value", "new_value", "label")
            ) {
                filter { eq("company_id", companyId) }
                order("at", io.github.jan.supabase.postgrest.query.Order.DESCENDING)
                range(offset, offset + limit - 1)
            }
            .decodeList<AuditEntry>()
    }

    /** Every fence company on the platform, with the server's own verdicts. */
    suspend fun companies(): Result<List<Company>> = io {
        SupabaseModule.client.postgrest.rpc("admin_companies").decodeList<Company>()
    }

    /**
     * How many there are. Separate from [companies] because the console shows
     * the count beside a list it may have paged, and a list of 50 says nothing
     * about whether there are 51.
     */
    suspend fun companiesCount(): Result<Long> = io {
        SupabaseModule.client.postgrest.rpc("admin_companies_count").decodeAs<Long>()
    }

    /** The releases table, newest first -- the same rows publish-release writes. */
    suspend fun releases(): Result<List<Release>> = io {
        SupabaseModule.client.postgrest.rpc("admin_releases").decodeList<Release>()
    }

    /** Crashes and background failures, grouped, over the last [days]. */
    suspend fun errorSummary(days: Int = 14): Result<List<ErrorGroup>> = io {
        SupabaseModule.client.postgrest
            .rpc("admin_error_summary", buildJsonObject { put("days", days) })
            .decodeList<ErrorGroup>()
    }

    /** Failed sign-ins, grouped by address: the signal for someone being locked out. */
    suspend fun signInAttempts(days: Int = 7, limit: Int = 20): Result<List<SignInAttemptGroup>> = io {
        SupabaseModule.client.postgrest.rpc(
            "admin_sign_in_attempt_groups",
            buildJsonObject { put("p_days", days); put("p_limit", limit) }
        ).decodeList<SignInAttemptGroup>()
    }

    // --------------------------------------------------------------- write

    /** A new fence company. [contactEmail] may be blank; the console allows it. */
    suspend fun createCompany(name: String, contactEmail: String?): Result<Unit> = io {
        SupabaseModule.client.postgrest.rpc(
            "admin_create_company",
            buildJsonObject {
                put("company_name", name)
                put("contact_email", contactEmail?.takeIf { it.isNotBlank() })
            }
        )
        Unit
    }

    // ------------------------------------------------- company access
    //
    // THROUGH THE RPCs, not through an UPDATE on companies.
    //
    // updateCompany below can write suspended / subscription_status /
    // trial_ends_at directly, and for a platform admin protect_billing_columns
    // lets that through -- so it would appear to work. These three go through
    // the same audited functions the console uses instead, for two reasons:
    // admin_suspend records a reason and a HOLD flag that a bare column write
    // has no way to express (and a HOLD is the difference between "pay and
    // you're back" and "paying will not help"), and every one of them raises
    // rather than silently changing nothing if the caller is not an admin --
    // where an UPDATE a policy filters out is zero rows and no error at all.

    /**
     * Give a company [days] more trial, exactly as the console's button does.
     *
     * The server's own expression is
     * `greatest(coalesce(trial_ends_at, now()), now()) + days`, which is what
     * makes this work on a trial that ended weeks ago: it restarts from NOW
     * rather than from the old end date, so "one more day" is a day from this
     * moment and not a date still in the past. It also sets the status back to
     * trialing and lifts a suspension.
     */
    suspend fun extendTrial(companyId: String, days: Int = 14): Result<Unit> = io {
        SupabaseModule.client.postgrest.rpc(
            "admin_extend_trial",
            buildJsonObject { put("target", companyId); put("days", days) }
        )
        Unit
    }

    /**
     * Switch a company off.
     *
     * [hold] is not a severity dial. A plain suspension is a billing matter
     * and the office offers them a plan; a HOLD says paying will NOT lift it,
     * and the office stops offering -- my_service_status answers
     * can_self_serve = false for it. Taking money from somebody who will still
     * be locked out afterwards is the thing that flag exists to prevent.
     */
    suspend fun suspendCompany(companyId: String, note: String?, hold: Boolean): Result<Unit> = io {
        SupabaseModule.client.postgrest.rpc(
            "admin_suspend",
            buildJsonObject {
                put("target", companyId)
                put("note", note?.takeIf { it.isNotBlank() })
                put("hold", hold)
            }
        )
        Unit
    }

    /** Lift a suspension. Plan and billing are left exactly as they were. */
    suspend fun unsuspendCompany(companyId: String): Result<Unit> = io {
        SupabaseModule.client.postgrest.rpc(
            "admin_unsuspend",
            buildJsonObject { put("target", companyId) }
        )
        Unit
    }

    // ------------------------------------------------- which service sends
    //
    // PLATFORM-WIDE, one row, and a change here moves every company's
    // FenceFlow mail at once -- which is why it is an admin function with the
    // second factor behind it, and why the screen asks before it flips.
    // A company's OWN connected mailbox is untouched either way; this only
    // decides what "FenceFlow mail" means.

    /**
     * Which service carries FenceFlow mail: "resend" or "brevo".
     *
     * THROUGH THE RPC, NOT THE TABLE. This read a row off
     * mail_platform_settings directly until 2026-10-22, and had therefore
     * never once worked: that table is service-role only -- no grant to
     * authenticated, RLS on, not one policy -- and the panel showed
     * "permission denied for table mail_platform_settings" with the whole
     * failing request, access token included, printed under it.
     *
     * The error helpfully suggested GRANT SELECT ... TO authenticated. Taking
     * that advice would give every signed-in user of every fence company a
     * read of the platform's own mail configuration, and break
     * tests/a25-tenant-isolation.test.mjs, which lists this table among the
     * six no tenant login may touch. The database knows about privileges, not
     * about who ought to have them.
     *
     * admin_mail_sender() is the twin of admin_set_mail_sender() below: same
     * is_platform_admin() guard, same second factor. See
     * supabase_r27_admin_mail_sender_read.sql.
     */
    suspend fun mailSender(): Result<String> = io {
        // Null when the server refuses -- which is also what it returns if the
        // settings row is missing. Either way "resend" is what the platform
        // actually falls back to, so the panel shows the truth rather than a
        // blank it would have to explain.
        // decodeAs<JsonElement>(), not decodeAs<String>(): the function
        // returns NULL to a refused caller and to a missing settings row,
        // and decodeAs cannot be given a nullable type -- its parameter is
        // bounded to Any, so String? does not compile.
        val answer = SupabaseModule.client.postgrest.rpc("admin_mail_sender").decodeAs<JsonElement>()
        (answer as? JsonPrimitive)?.contentOrNull ?: "resend"
    }

    /**
     * Switch it. The server refuses anything but the two it knows, and refuses
     * anyone who is not a platform admin on an AAL2 session -- so this cannot
     * quietly do nothing the way a policy-filtered UPDATE would.
     */
    suspend fun setMailSender(provider: String): Result<Unit> = io {
        SupabaseModule.client.postgrest.rpc(
            "admin_set_mail_sender",
            buildJsonObject { put("provider", provider) }
        )
        Unit
    }

    // SenderRow was the shape of the direct table read that mailSender() no
    // longer does. Deleted with it: a row class nobody decodes is a claim
    // that something still reads that table.

    /**
     * Change a company's plan, price, billing address or notes.
     *
     * A DIRECT WRITE, as the web console does it. There is no RPC for this
     * and none is needed: protect_billing_columns() on the companies table
     * waves a platform admin through and quietly reverts these columns for
     * anybody else, so the database is the gate here exactly as it is behind
     * every admin_* function on this screen.
     *
     * Only the keys the caller passes are sent. Null means "leave it", and
     * the screen decides what a blank box means per field -- a blank price is
     * not a price of zero, and a blank billing address is not an instruction
     * to wipe where invoices go.
     *
     * NOTE ON PRICE. Stripe owns what a company is actually charged:
     * stripe-webhook overwrites monthly_price from the subscription on every
     * event. Typing a figure here records a note that the next webhook will
     * correct, and charges nobody anything. Taking money off a bill is a
     * Stripe discount, not a number in this box.
     */
    suspend fun updateCompany(
        companyId: String,
        plan: String? = null,
        monthlyPrice: Double? = null,
        billingEmail: String? = null,
        adminNotes: String? = null,
    ): Result<Unit> = io {
        val patch = buildJsonObject {
            plan?.let { put("subscription_plan", it) }
            monthlyPrice?.let { put("monthly_price", it) }
            billingEmail?.let { put("billing_email", it) }
            adminNotes?.let { put("admin_notes", it) }
        }
        if (patch.isEmpty()) return@io Unit
        SupabaseModule.client.postgrest.from("companies")
            .update(patch) { filter { eq("id", companyId) } }
        Unit
    }

    /**
     * Hand a limited release to EVERY company.
     *
     * The one control that matters after a staged rollout, and the reason it
     * belongs on a phone: when the build turns out fine you are rarely at a
     * desk. The server decides whether it may happen -- admin_promote_release
     * is behind is_platform_admin() like everything else here.
     */
    suspend fun promoteRelease(releaseId: String): Result<Unit> = io {
        SupabaseModule.client.postgrest.rpc(
            "admin_promote_release",
            buildJsonObject { put("target_id", releaseId) }
        )
        Unit
    }

    /**
     * Jobs the two engines priced differently, newest first.
     *
     * Capped at 100 rather than read whole: PostgREST truncates an unpaged
     * read at a thousand rows with no error of any kind, and a screen that
     * silently stopped at a thousand would be worse than one that says it
     * shows the hundred most recent.
     */
    suspend fun drift(limit: Int = 100): Result<List<Drift>> = io {
        SupabaseModule.client.postgrest.from("pricing_drift")
            .select(Columns.raw("id,job_sync_id,office_total,phone_total,office_engine,phone_engine,noted_at,seen_at")) {
                order("noted_at", io.github.jan.supabase.postgrest.query.Order.DESCENDING)
                limit(limit.toLong())
            }
            .decodeList<Drift>()
    }

    /**
     * The global audit log, newest first.
     *
     * READ STRAIGHT OFF THE TABLE, not through an RPC, because the table
     * already answers the right question for this caller: `audit_log` carries
     * an `audit_log_admin_read` policy whose whole condition is
     * `is_platform_admin()`. An ordinary owner reading the same table sees
     * their own company's rows through the other policy, which is correct and
     * is also why this cannot be used to build a non-admin screen by mistake.
     *
     * Paged for the reason [drift] is capped: PostgREST truncates an unpaged
     * read at a thousand rows with NO error, and audit_log grows one row per
     * field changed, so it meets that cap sooner than anything else here. A
     * screen that silently stopped at a thousand would read as "that is all
     * there is".
     */
    suspend fun auditLog(limit: Int = 50, offset: Int = 0): Result<List<AuditEntry>> = io {
        SupabaseModule.client.postgrest.from("audit_log")
            .select(
                // The same columns [companyHistory] reads, through the same
                // model: one table, one shape. Asking for more here would
                // mean a second AuditEntry, and two models for one table is
                // how two screens come to disagree about what a row holds.
                Columns.list("at", "actor_email", "table_name", "action", "field", "old_value", "new_value", "label")
            ) {
                order("at", io.github.jan.supabase.postgrest.query.Order.DESCENDING)
                range(offset.toLong(), (offset + limit - 1).toLong())
            }
            .decodeList<AuditEntry>()
    }

    /**
     * The recycle bin: companies removed, with everything of theirs still here.
     *
     * Through the RPC rather than the table, because `admin_removed_companies`
     * also counts their people and their jobs -- the two figures that make
     * "restore" a decision rather than a guess.
     */
    suspend fun removedCompanies(): Result<List<RemovedCompany>> = io {
        SupabaseModule.client.postgrest.rpc("admin_removed_companies")
            .decodeList<RemovedCompany>()
    }

    /** Put a removed company back, exactly as it was. */
    suspend fun restoreCompany(companyId: String): Result<Unit> = io {
        SupabaseModule.client.postgrest.rpc(
            "admin_restore_company",
            buildJsonObject { put("p_company_id", companyId) }
        )
        Unit
    }

    /**
     * Who has been written to, newest conversation first.
     *
     * The same function the console's Email clients screen reads, so the two
     * cannot come to disagree about what was said to whom -- including the
     * ordering, which lives in SQL rather than in either client.
     */
    suspend fun clientEmailThreads(limit: Int = 50): Result<List<ClientEmailThread>> = io {
        SupabaseModule.client.postgrest.rpc(
            "admin_client_email_threads",
            buildJsonObject { put("p_limit", limit); put("p_offset", 0) }
        ).decodeList<ClientEmailThread>()
    }

    /** One client's conversation, oldest first so it reads downwards. */
    suspend fun clientEmailThread(companyId: String, limit: Int = 200): Result<List<ClientEmail>> = io {
        SupabaseModule.client.postgrest.rpc(
            "admin_client_email_thread",
            buildJsonObject {
                put("p_company_id", companyId); put("p_limit", limit); put("p_offset", 0)
            }
        ).decodeList<ClientEmail>()
    }

    /** Stop a group of errors being reported again until it recurs. */
    suspend fun markErrorsSeen(message: String, whereAt: String): Result<Unit> = io {
        SupabaseModule.client.postgrest.rpc(
            "admin_mark_errors_seen",
            buildJsonObject { put("msg", message); put("wh", whereAt) }
        )
        Unit
    }

    /**
     * Change a company's billing or standing.
     *
     * A direct column update, exactly as the console does it -- and exactly as
     * guarded: protect_billing_columns() does NOT call is_platform_admin(), it
     * inlines its own lookup, which is why supabase_r7 had to point it at the
     * shared gate as well. Without that, every billing column here would still
     * be on the password-only rule.
     *
     * Only the fields the console can change are accepted. Anything not passed
     * is left alone rather than written as null, so this can never blank a
     * column by omission.
     */
    suspend fun updateCompany(
        id: String,
        suspended: Boolean? = null,
        subscriptionStatus: String? = null,
        trialEndsAt: String? = null,
        adminNotes: String? = null,
    ): Result<Unit> = io {
        val patch: JsonObject = buildJsonObject {
            suspended?.let { put("suspended", it) }
            subscriptionStatus?.let { put("subscription_status", it) }
            trialEndsAt?.let { put("trial_ends_at", it) }
            adminNotes?.let { put("admin_notes", it) }
        }
        if (patch.isEmpty()) return@io Unit
        SupabaseModule.client.postgrest.from("companies").update(patch) {
            filter { eq("id", id) }
        }
        Unit
    }

    /**
     * Invite a company's owner. The Edge Function mints the invitation and
     * sends it; this only asks.
     *
     * A plain Ktor POST rather than functions-kt, because this project does
     * not depend on functions-kt -- InviteCrewApi, PaymentsApi and Satellite
     * all call Edge Functions this way, and adding a module for one call is
     * not worth the build weight.
     */
    suspend fun inviteCompany(companyId: String, email: String): Result<Unit> = io {
        if (!SupabaseModule.isConfigured) error("Cloud isn't set up on this build.")
        val token = SupabaseModule.client.auth.currentSessionOrNull()?.accessToken
            ?: error("This phone isn't signed in to FenceFlow.")

        val http = HttpClient(CIO) {
            install(HttpTimeout) {
                requestTimeoutMillis = 30_000
                connectTimeoutMillis = 15_000
                socketTimeoutMillis = 30_000
            }
        }
        try {
            val response = http.post("${BuildConfig.SUPABASE_URL}/functions/v1/invite-company") {
                header("Authorization", "Bearer $token")
                header("apikey", BuildConfig.SUPABASE_KEY)
                contentType(ContentType.Application.Json)
                setBody(
                    buildJsonObject {
                        put("company_id", companyId)
                        put("email", email)
                    }.toString()
                )
            }
            if (response.status.value !in 200..299) {
                // The body carries the reason; a bare status code sends him
                // looking in the wrong place.
                error("Invite service replied ${response.status.value}: ${response.bodyAsText().take(200)}")
            }
            Unit
        } finally {
            http.close()
        }
    }

    // ------------------------------------------------------- the second factor

    /**
     * What this session has done, and what it could reach. See [AdminGate].
     *
     * `authenticatorAssuranceLevel` is a plain property, not a suspending
     * call: it reads the claims already in the session rather than asking the
     * server. Returned as the lower-case strings the gate speaks ("aal1",
     * "aal2") so that nothing but this file knows the library's enum.
     */
    fun assuranceLevel(): Result<Pair<String?, String?>> = runCatching {
        val level = SupabaseModule.client.auth.mfa.getAuthenticatorAssuranceLevel()
        level.current.name.lowercase() to level.next.name.lowercase()
    }

    /**
     * Step this session up with a code from the authenticator he already uses
     * for the console -- the same enrolled factor, so there is nothing new to
     * set up.
     *
     * Verifying against the FIRST verified TOTP factor, which is what
     * admin.html does too. An account with two would need a chooser; none has.
     *
     * The factors are RE-READ from the server rather than taken from
     * `verifiedFactors` on the session: a factor enrolled on the console a
     * minute ago is not in a session token minted before it.
     */
    suspend fun verifyTotp(code: String): Result<Unit> = io {
        val mfa = SupabaseModule.client.auth.mfa
        val factor = mfa.retrieveFactorsForCurrentUser()
            .firstOrNull { it.factorType == "totp" && it.isVerified }
            ?: error("No authenticator is enrolled on this account. Enrol one on the console first.")
        // Positional, as the library declares it: (factorId, code). The
        // channel and saveSession arguments keep their defaults.
        mfa.createChallengeAndVerify(factor.id, code.trim())
        Unit
    }
}
