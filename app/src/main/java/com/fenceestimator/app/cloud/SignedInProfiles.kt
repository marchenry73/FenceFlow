package com.fenceestimator.app.cloud

import android.content.Context
import io.github.jan.supabase.auth.user.UserSession
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The faces on the sign-in screen: who has signed in on this handset before.
 *
 * The owner asked for this to work "like Facebook" -- the people who use this
 * phone are listed, and tapping one signs them in. On a two-man crew that is
 * the difference between passing the phone over and typing an email and a
 * password on a fence line in the rain.
 *
 * ------------------------------------------------------------------
 * WHAT IS STORED, AND WHY IT IS ENCRYPTED
 * ------------------------------------------------------------------
 * Tapping a face signs somebody in, so this necessarily holds a REFRESH TOKEN
 * per profile, and a refresh token is worth a password until it is revoked.
 * Every one goes through [DeviceCipher] -- AES/GCM against a key that cannot
 * leave the Android Keystore -- so the file is useless off the device.
 *
 * That is not an extra precaution bolted onto a convenience: before this,
 * supabase-kt's default kept the SIGNED-IN session, refresh token and all, in
 * plain SharedPreferences XML (see [EncryptedSessionManager]). Listing more
 * accounts without fixing that would have multiplied an existing hole. With
 * both in place the phone ends up safer than it was with one account.
 *
 * ------------------------------------------------------------------
 * A SIGN-OUT KEEPS THE FACE AND DROPS THE TOKEN
 * ------------------------------------------------------------------
 * [forgetToken] leaves the profile listed but makes tapping it ask for the
 * password. That is what the word "sign out" means to the person pressing it,
 * and it is the answer to the crew-phone problem: one of this company's own
 * logins is a CREW account in the owner's own company, and a handset that
 * holds a standing OWNER session is the thing least worth shipping. Switching
 * between accounts nobody signed out of stays instant.
 *
 * ------------------------------------------------------------------
 * TOKENS ROTATE
 * ------------------------------------------------------------------
 * Supabase issues a new refresh token on every refresh and retires the old
 * one. A stored token that is not updated therefore goes stale on its own and
 * fails at the worst moment -- the tap that was supposed to be instant. So
 * [remember] is called on every session the app sees, not only at sign-in,
 * and it overwrites. A tap that fails anyway falls back to the password box
 * with the email filled in, which is a slower sign-in rather than a dead end.
 */
class SignedInProfiles(
    private val context: Context,
    private val json: Json = Json { ignoreUnknownKeys = true },
) {

    /** What the sign-in screen draws. Carries no token: see [tokenFor]. */
    data class Face(
        val userId: String,
        val email: String,
        val displayName: String,
        val lastUsedAt: Long,
        /** False once this profile has been signed out of: tapping asks for the password. */
        val canTapToSignIn: Boolean,
    )

    @Serializable
    private data class Stored(
        val userId: String,
        val email: String,
        val displayName: String = "",
        val lastUsedAt: Long = 0L,
        val refreshToken: String? = null,
    )

    private val prefs by lazy { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }

    /** Most recently used first, which is the order a phone's owner expects. */
    suspend fun faces(): List<Face> = withContext(Dispatchers.IO) {
        read().sortedByDescending { it.lastUsedAt }.map {
            Face(
                userId = it.userId,
                email = it.email,
                displayName = it.displayName,
                lastUsedAt = it.lastUsedAt,
                canTapToSignIn = !it.refreshToken.isNullOrBlank(),
            )
        }
    }

    /**
     * Records (or refreshes) the profile this session belongs to.
     *
     * Called for every session the app sees, because tokens rotate -- see the
     * class comment. A session with no user or no refresh token is ignored
     * rather than stored as a face that cannot be tapped.
     */
    suspend fun remember(session: UserSession, displayName: String = "") {
        withContext(Dispatchers.IO) {
            val user = session.user ?: return@withContext
            val id = user.id
            val email = user.email.orEmpty()
            val token = session.refreshToken
            if (id.isBlank() || email.isBlank() || token.isBlank()) return@withContext
            val now = System.currentTimeMillis()
            val others = read().filterNot { it.userId == id }
            val existing = read().firstOrNull { it.userId == id }
            write(
                others + Stored(
                    userId = id,
                    email = email,
                    // A name already known is kept when this call has none, so
                    // a plain token refresh cannot blank the label.
                    displayName = displayName.ifBlank { existing?.displayName.orEmpty() },
                    lastUsedAt = now,
                    refreshToken = token,
                )
            )
        }
    }

    /** The token to sign this profile back in with, or null once signed out. */
    suspend fun tokenFor(userId: String): String? = withContext(Dispatchers.IO) {
        read().firstOrNull { it.userId == userId }?.refreshToken?.takeIf { it.isNotBlank() }
    }

    /** Signing out: the face stays, the credential goes. */
    suspend fun forgetToken(userId: String) {
        withContext(Dispatchers.IO) {
            write(read().map { if (it.userId == userId) it.copy(refreshToken = null) else it })
        }
    }

    /** "Not my account": the profile goes entirely. */
    suspend fun remove(userId: String) {
        withContext(Dispatchers.IO) { write(read().filterNot { it.userId == userId }) }
    }

    // ------------------------------------------------------------------
    // Storage. One encrypted blob, so a half-written list cannot exist.
    // ------------------------------------------------------------------

    private fun read(): List<Stored> = runCatching {
        val blob = prefs.getString(KEY, null) ?: return emptyList()
        val plain = DeviceCipher.decrypt(blob) ?: return emptyList()
        json.decodeFromString(kotlinx.serialization.builtins.ListSerializer(Stored.serializer()), plain)
    }.getOrDefault(emptyList())

    private fun write(list: List<Stored>) {
        runCatching {
            val trimmed = list.sortedByDescending { it.lastUsedAt }.take(MAX_FACES)
            val plain = json.encodeToString(
                kotlinx.serialization.builtins.ListSerializer(Stored.serializer()), trimmed
            )
            // No Keystore, nothing written. Storing refresh tokens in clear
            // text "just this once" is exactly the thing this class exists to
            // avoid; the cost of refusing is that the face is not remembered.
            val blob = DeviceCipher.encrypt(plain) ?: return
            prefs.edit().putString(KEY, blob).apply()
        }
    }

    private companion object {
        const val PREFS = "fenceflow_profiles"
        const val KEY = "profiles_v1"
        /**
         * Enough for a crew and the office, and a bound on how many live
         * credentials one handset can accumulate. The oldest drops off.
         */
        const val MAX_FACES = 8
    }
}
