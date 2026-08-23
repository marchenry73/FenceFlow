package com.fenceestimator.app.cloud

import com.fenceestimator.app.BuildConfig
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.Auth
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.auth.providers.builtin.Email
import io.github.jan.supabase.auth.status.SessionStatus
import io.github.jan.supabase.createSupabaseClient
import io.github.jan.supabase.postgrest.Postgrest
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import io.github.jan.supabase.serializer.KotlinXSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Access level for a signed-in user. CREW is the restricted field role: job
 * details and progress, but no pricing, costs, margins, or company settings.
 */
/**
 * What someone is allowed to do. Ordered loosely from most to least access,
 * but permissions are declared explicitly per role rather than inferred from
 * the order -- an accountant sees money a foreman never should, while a foreman
 * schedules work an accountant never should. A ranking can't express that.
 *
 * Unknown values from the server fall back to CREW, so a role added later can
 * never accidentally grant access to an older build.
 */
enum class UserRole(val label: String, val description: String) {
    OWNER("Owner", "Everything, including deleting records and changing billing."),
    MANAGER("Manager", "Runs the work: jobs, estimates, scheduling, crew, customers."),
    SALES("Sales", "Leads, customers and estimates. No crew, costs or settings."),
    ACCOUNTANT("Accountant", "Invoices, payments, expenses and reports. Can't change jobs."),
    FOREMAN("Foreman", "Crew lead: job details, checklists, photos, clock in/out for the crew."),
    CREW("Crew", "Today's work only. No pricing, costs or customer contact details.")
}

@Serializable
data class CloudProfile(
    val id: String = "",
    @SerialName("company_id") val companyId: String? = null,
    @SerialName("full_name") val fullName: String = "",
    val role: String = "CREW",
    /** Per-person adjustments to the role, e.g. "+SEE_MONEY,-DELETE_RECORDS". */
    @SerialName("permission_overrides") val permissionOverrides: String = "",
    /** What this person said they were when joining. Not authoritative. */
    @SerialName("requested_role") val requestedRole: String = ""
) {
    val userRole: UserRole
        get() = runCatching { UserRole.valueOf(role) }.getOrDefault(UserRole.CREW)
}

/**
 * Cloud backend handle. Credentials come from local.properties via BuildConfig
 * so they aren't hardcoded in source. [isConfigured] is false when those
 * properties are missing, which lets the app keep running fully offline on the
 * local Room database instead of crashing at startup.
 */
object SupabaseModule {
    val isConfigured: Boolean =
        BuildConfig.SUPABASE_URL.isNotBlank() && BuildConfig.SUPABASE_KEY.isNotBlank()

    val client: SupabaseClient by lazy {
        createSupabaseClient(
            supabaseUrl = BuildConfig.SUPABASE_URL,
            supabaseKey = BuildConfig.SUPABASE_KEY
        ) {
            // encodeDefaults is off in kotlinx.serialization by default, which
            // silently DROPS any field whose value equals its declared default.
            // Postgres then receives null and rejects it -- that's what caused
            // 'null value in column "unit" violates not-null constraint', and it
            // would have hit every table, not just the catalog.
            defaultSerializer = KotlinXSerializer(
                Json {
                    encodeDefaults = true
                    ignoreUnknownKeys = true
                    explicitNulls = false
                }
            )
            install(Auth)
            install(Postgrest)
            install(io.github.jan.supabase.storage.Storage)
            // Live row changes, so a cleared payment reaches the phone the moment
            // Postgres commits it rather than on the next sync pass.
            install(io.github.jan.supabase.realtime.Realtime)
        }
    }

    val sessionStatus: Flow<SessionStatus> get() = client.auth.sessionStatus

    suspend fun signUp(email: String, password: String) {
        client.auth.signUpWith(Email) {
            this.email = email
            this.password = password
        }
    }

    suspend fun signIn(email: String, password: String) {
        client.auth.signInWith(Email) {
            this.email = email
            this.password = password
        }
    }

    suspend fun signOut() {
        client.auth.signOut()
    }

    fun currentUserEmail(): String? = client.auth.currentUserOrNull()?.email

    /**
     * Whether a request made right now would carry the user's token.
     *
     * supabase-kt sends the anon key when it has no session -- and after a
     * failed token refresh, or during startup before the stored session has
     * loaded, there is a window where the app still remembers who it belongs
     * to but has no token. A sync in that window goes out anonymous: every
     * write is refused by RLS and every read comes back empty. The crash
     * reporter caught exactly this -- an upsert with the publishable key in
     * the Authorization header.
     */
    fun hasLiveSession(): Boolean =
        runCatching { client.auth.currentAccessTokenOrNull() }.getOrNull()?.isNotBlank() == true

    /** Asks for a fresh token; quiet on failure, the next attempt retries. */
    suspend fun tryRefreshSession() {
        runCatching { client.auth.refreshCurrentSession() }
    }

    fun currentUserId(): String? = client.auth.currentUserOrNull()?.id

    /** The signed-in user's company + role, or null if they haven't joined a company yet. */
    suspend fun fetchProfile(): CloudProfile? {
        val uid = currentUserId() ?: return null
        return client.postgrest.from("profiles")
            .select { filter { eq("id", uid) } }
            .decodeSingleOrNull<CloudProfile>()
    }

    /** Everyone in this company, so their access can be set individually. */
    suspend fun fetchTeam(companyId: String): List<CloudProfile> =
        client.postgrest.from("profiles")
            .select { filter { eq("company_id", companyId) } }
            .decodeList<CloudProfile>()

    /**
     * Changes one person's access.
     *
     * The database has the final say: profiles_manage only permits this for a
     * caller holding MANAGE_ACCESS, and never on their own row. So a phone with
     * a modified build cannot grant itself anything -- the update is simply
     * rejected. Hiding the screen is a courtesy to honest people, not the lock.
     */
    suspend fun updateMemberAccess(userId: String, role: UserRole, overrides: String) {
        client.postgrest.from("profiles").update(
            buildJsonObject {
                put("role", role.name)
                put("permission_overrides", overrides)
            }
        ) {
            filter { eq("id", userId) }
        }
    }

    /** Creates a new company and makes the current user its OWNER. */
    suspend fun createCompany(companyName: String, ownerName: String) {
        client.postgrest.rpc(
            "create_company_with_owner",
            buildJsonObject {
                put("company_name", companyName)
                put("owner_name", ownerName)
            }
        )
    }

    /**
     * Tells the backend which phone this is, so pushes can reach it. Safe to
     * call repeatedly -- the server upserts on the token.
     */
    suspend fun registerDeviceToken(token: String) {
        client.postgrest.rpc(
            "register_device_token",
            buildJsonObject { put("device_token", token) }
        )
    }

    /** Attaches the current user to an existing company as CREW, using the company id as an invite code. */
    /**
     * Joins a company, stating a role rather than choosing one.
     *
     * The requested role is recorded but never applied -- the server puts
     * everyone in as CREW regardless. Letting the joiner pick would mean anyone
     * holding the invite code could join as a manager and read the money. The
     * owner sees what they said they were and confirms it in one tap, which is
     * also better than a list of unnamed crew rows nobody can identify.
     */
    /**
     * Claims a company FenceFlow set up, using the one-time code sent with it.
     *
     * This is how a new customer becomes the owner of their own company
     * without anybody at FenceFlow handling their password. They make their
     * own account, then this attaches it to the company already waiting.
     */
    suspend fun claimCompanySetup(setupCode: String, ownerName: String) {
        client.postgrest.rpc(
            "claim_company_setup",
            buildJsonObject {
                put("setup_code", setupCode.trim().uppercase())
                put("owner_name", ownerName.trim())
            }
        )
    }

    suspend fun joinCompany(companyId: String, memberName: String, requestedRole: UserRole?) {
        client.postgrest.rpc(
            "join_company",
            buildJsonObject {
                put("target_company_id", companyId)
                put("member_name", memberName)
                put("requested_role_in", requestedRole?.name ?: "")
            }
        )
    }
}
