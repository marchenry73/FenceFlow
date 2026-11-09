package com.fenceestimator.app.cloud

import android.content.Context
import io.github.jan.supabase.auth.SessionManager
import io.github.jan.supabase.auth.user.UserSession
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import java.io.File

/**
 * Where this phone keeps the signed-in session, encrypted.
 *
 * REPLACING A PLAINTEXT DEFAULT, not adding a layer. supabase-kt installs
 * SettingsSessionManager when Auth is installed with no override, and that
 * keeps the session in multiplatform-settings -- SharedPreferences, plain XML
 * in the app's data directory. MEASURED 7 Nov 2026 against
 * auth-kt-release.aar 3.0.2. So every FenceFlow handset has been holding its
 * contractor's REFRESH TOKEN in clear text. That token is worth a password
 * until it is revoked: a backup, a rooted phone or a handset that changes
 * hands gives somebody else that account.
 *
 * ------------------------------------------------------------------
 * THE UPGRADE MUST NOT SIGN EVERYBODY OUT
 * ------------------------------------------------------------------
 * A manager that simply found no encrypted session would log out every
 * contractor the moment they updated -- in a yard, on a truck, without their
 * password to hand. That is a worse day than the exposure it fixes.
 *
 * So the first load MIGRATES: it looks through this app's own shared_prefs
 * files for a stored value that deserialises as a UserSession, re-saves it
 * encrypted, and removes the plaintext.
 *
 * WHY A SCAN AND NOT THE LIBRARY'S KEY. The alternative was to construct a
 * SettingsSessionManager and let it find its own file. That reaches into
 * library internals whose construction order is not ours to rely on, and it
 * would fail silently by signing people out -- the exact outcome this is
 * avoiding. A scan needs no internals: a value is ours if it parses as a
 * UserSession, and nothing else in this app's preferences does.
 *
 * Every failure here answers null rather than throwing. The caller is the
 * Supabase client starting up, and an exception on this path takes the app
 * down before a screen draws.
 */
class EncryptedSessionManager(
    private val context: Context,
    /** Lenient, because the library's own shape may gain fields we do not model. */
    private val json: Json = Json { ignoreUnknownKeys = true },
    /**
     * The faces on the sign-in screen. Updated from here rather than from the
     * sign-in form because Supabase ROTATES the refresh token on every
     * refresh: a profile captured only at sign-in holds a token that is dead
     * within the hour, and it dies on the one tap that was meant to be
     * instant. Every session the library persists comes through
     * [saveSession], so this is the one place the stored token cannot fall
     * behind.
     */
    private val profiles: SignedInProfiles = SignedInProfiles(context),
) : SessionManager {

    private val prefs by lazy {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    override suspend fun saveSession(session: UserSession) {
        withContext(Dispatchers.IO) {
            runCatching {
                val plain = json.encodeToString(UserSession.serializer(), session)
                val blob = DeviceCipher.encrypt(plain)
                if (blob == null) {
                    // The Keystore is unavailable. Storing the session in clear
                    // text "just this once" is how the thing this class exists
                    // to stop comes back, so nothing is written: the account
                    // stays signed in for this process and asks again next
                    // launch.
                    return@runCatching
                }
                prefs.edit().putString(KEY, blob).apply()
            }
            // After the session is safely stored, never instead of it: a
            // failure to remember a face must not cost somebody their login.
            runCatching { profiles.remember(session) }
        }
    }

    override suspend fun loadSession(): UserSession? = withContext(Dispatchers.IO) {
        runCatching {
            prefs.getString(KEY, null)
                ?.let { DeviceCipher.decrypt(it) }
                ?.let { json.decodeFromString(UserSession.serializer(), it) }
        }.getOrNull() ?: migrateLegacySession()
    }

    override suspend fun deleteSession() {
        withContext(Dispatchers.IO) {
            runCatching { prefs.edit().remove(KEY).apply() }
            // The plaintext copy too, in case a session was written by the old
            // manager after this one first ran -- a downgrade and re-upgrade,
            // or a restore from a backup taken before the update.
            runCatching { forEachLegacySession { file, key, _ -> clearLegacy(file, key) } }
        }
    }

    /**
     * The one-time move from the library's plaintext store.
     *
     * Re-saves encrypted BEFORE clearing the plaintext, so a process killed
     * between the two leaves the session readable by the old path rather than
     * gone from both.
     */
    private suspend fun migrateLegacySession(): UserSession? {
        var found: UserSession? = null
        runCatching {
            forEachLegacySession { file, key, session ->
                if (found == null) {
                    found = session
                    saveSessionBlocking(session)
                    clearLegacy(file, key)
                }
            }
        }
        return found
    }

    private fun saveSessionBlocking(session: UserSession) {
        runCatching {
            val plain = json.encodeToString(UserSession.serializer(), session)
            DeviceCipher.encrypt(plain)?.let { prefs.edit().putString(KEY, it).apply() }
        }
    }

    private fun clearLegacy(file: String, key: String) {
        runCatching {
            context.getSharedPreferences(file, Context.MODE_PRIVATE)
                .edit().remove(key).apply()
        }
    }

    /**
     * Every stored string in this app's preferences that is actually a
     * UserSession, with the file and key it was found under.
     *
     * Our own file is skipped: its value is ciphertext and would never parse,
     * but skipping it says so rather than relying on that.
     */
    private inline fun forEachLegacySession(
        action: (file: String, key: String, session: UserSession) -> Unit,
    ) {
        val dir = File(context.applicationInfo.dataDir, "shared_prefs")
        val files = dir.listFiles { f: File -> f.name.endsWith(".xml") } ?: return
        for (f in files) {
            val name = f.name.removeSuffix(".xml")
            if (name == PREFS) continue
            val sp = runCatching {
                context.getSharedPreferences(name, Context.MODE_PRIVATE)
            }.getOrNull() ?: continue
            val all = runCatching { sp.all }.getOrNull() ?: continue
            for ((k, v) in all) {
                val text = v as? String ?: continue
                // Cheap reject before attempting a parse: a session is a JSON
                // object carrying an access token.
                if (!text.startsWith("{") || !text.contains("access_token")) continue
                val session = runCatching {
                    json.decodeFromString(UserSession.serializer(), text)
                }.getOrNull() ?: continue
                action(name, k, session)
            }
        }
    }

    private companion object {
        /** Ours, and deliberately not the library's, so the two cannot collide. */
        const val PREFS = "fenceflow_session"
        const val KEY = "session_v1"
    }
}
