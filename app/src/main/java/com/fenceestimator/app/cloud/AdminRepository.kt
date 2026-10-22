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
    )

    @Serializable
    data class SignInAttemptGroup(
        val email: String = "",
        val attempts: Long = 0,
        @SerialName("last_at") val lastAt: String? = null,
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
