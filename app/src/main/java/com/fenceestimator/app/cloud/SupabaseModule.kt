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
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Access level for a signed-in user. CREW is the restricted field role: job
 * details and progress, but no pricing, costs, margins, or company settings.
 */
enum class UserRole { OWNER, MANAGER, CREW }

@Serializable
data class CloudProfile(
    val id: String = "",
    @SerialName("company_id") val companyId: String? = null,
    @SerialName("full_name") val fullName: String = "",
    val role: String = "CREW"
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
            install(Auth)
            install(Postgrest)
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

    fun currentUserId(): String? = client.auth.currentUserOrNull()?.id

    /** The signed-in user's company + role, or null if they haven't joined a company yet. */
    suspend fun fetchProfile(): CloudProfile? {
        val uid = currentUserId() ?: return null
        return client.postgrest.from("profiles")
            .select { filter { eq("id", uid) } }
            .decodeSingleOrNull<CloudProfile>()
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
    suspend fun joinCompany(companyId: String, memberName: String) {
        client.postgrest.rpc(
            "join_company",
            buildJsonObject {
                put("target_company_id", companyId)
                put("member_name", memberName)
            }
        )
    }
}
