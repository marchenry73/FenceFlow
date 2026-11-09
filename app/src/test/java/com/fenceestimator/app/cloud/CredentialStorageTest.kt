package com.fenceestimator.app.cloud

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * THE REFRESH TOKEN MUST NOT BE WRITTEN IN CLEAR TEXT.
 *
 * MEASURED 7 Nov 2026 by opening auth-kt-release.aar 3.0.2 out of the Gradle
 * cache: installing Auth with no override gets SettingsSessionManager, which
 * keeps the whole session -- refresh token included -- in multiplatform-
 * settings, i.e. plain SharedPreferences XML. So every FenceFlow handset had
 * been holding a credential worth a password until it is revoked, readable
 * from any backup or rooted phone.
 *
 * [EncryptedSessionManager] replaces that default and [SignedInProfiles]
 * stores the sign-in screen's faces the same way, each token through
 * [DeviceCipher] -- AES/GCM against a key that cannot leave the Android
 * Keystore.
 *
 * ------------------------------------------------------------------
 * WHY THIS FILE READS SOURCE INSTEAD OF RUNNING THE CODE
 * ------------------------------------------------------------------
 * All three classes are platform-bound: the Keystore, a Context and
 * SharedPreferences. This module has no Robolectric and no androidTest source
 * set, and the project's phone cannot currently be reached for an instrumented
 * run. Pretending otherwise would mean shipping these untested.
 *
 * So this pins the PROPERTIES that would regress silently and expensively, in
 * the same way GuestPrefsRestoreTest pins SettingsStore's three entry points.
 * It is honest about being a source check: it cannot prove the cipher works,
 * only that nothing has started writing credentials around it. The day this
 * module gains Robolectric, these should be replaced with the real thing.
 *
 * Comments are stripped before every check, because a must-not-contain test
 * that reads comments passes on its own prose -- that has produced a false
 * green on this project before.
 */
class CredentialStorageTest {

    private fun source(path: String): String {
        val f = File(path)
        assertTrue("$path is gone or was moved", f.exists())
        return f.readText()
    }

    /** Line and block comments removed, so a sentence about a call is not the call. */
    private fun code(text: String): String =
        text.replace(Regex("""/\*[\s\S]*?\*/"""), " ").replace(Regex("""//[^\n]*"""), " ")

    private val sessionPath = "src/main/java/com/fenceestimator/app/cloud/EncryptedSessionManager.kt"
    private val profilesPath = "src/main/java/com/fenceestimator/app/cloud/SignedInProfiles.kt"
    private val modulePath = "src/main/java/com/fenceestimator/app/cloud/SupabaseModule.kt"
    private val appPath = "src/main/java/com/fenceestimator/app/FenceEstimatorApp.kt"
    private val cipherPath = "src/main/java/com/fenceestimator/app/cloud/DeviceCipher.kt"

    @Test
    fun `the supabase client installs our session manager, not the plaintext default`() {
        // Without this one line, auth-kt stores the session as plain XML and
        // every other check in this file is guarding an unused class.
        val module = code(source(modulePath))
        assertTrue(
            "SupabaseModule no longer installs EncryptedSessionManager: the session " +
                "falls back to auth-kt's SettingsSessionManager, which writes the " +
                "refresh token to SharedPreferences in clear text",
            module.contains("sessionManager = EncryptedSessionManager(")
        )
    }

    @Test
    fun `the context it needs is set before anything can reach the client`() {
        // SupabaseModule.client is `by lazy`; if appContext is still null at
        // first touch the manager cannot be built and the library's plaintext
        // default silently wins.
        val app = code(source(appPath))
        assertTrue(
            "FenceEstimatorApp no longer sets SupabaseModule.appContext",
            app.contains("SupabaseModule.appContext = applicationContext")
        )
        val onCreate = app.substringAfter("override fun onCreate()")
        val setAt = onCreate.indexOf("SupabaseModule.appContext")
        assertTrue("appContext is not set inside onCreate", setAt >= 0)
        assertTrue(
            "appContext is set too late in onCreate -- startIfPossible() can reach " +
                "the Supabase client, and a null context there means plaintext storage",
            setAt < onCreate.indexOf("startIfPossible()")
        )
    }

    @Test
    fun `the session is encrypted before it is stored, and never stored otherwise`() {
        val body = code(source(sessionPath))
        assertTrue(
            "saveSession no longer encrypts",
            body.contains("DeviceCipher.encrypt(")
        )
        // Every write of the session key must be of a value that came from the
        // cipher. A putString of the serialized session itself would be the
        // whole defect, restored.
        val writes = Regex("""putString\(KEY,\s*([A-Za-z0-9_]+)\)""")
            .findAll(body).map { it.groupValues[1] }.toList()
        assertTrue("no putString(KEY, ...) found; has the storage changed shape?", writes.isNotEmpty())
        for (w in writes) {
            assertFalse(
                "the session is stored from `$w`, which is not the cipher's output -- " +
                    "if that is the serialized session this writes the refresh token in clear text",
                w == "plain" || w == "json" || w == "session"
            )
        }
    }

    @Test
    fun `a missing keystore writes nothing rather than falling back to clear text`() {
        // "Just this once" plaintext is how the thing this replaces comes back.
        val body = code(source(sessionPath))
        assertTrue(
            "EncryptedSessionManager no longer refuses when the cipher is unavailable",
            body.contains("if (blob == null)")
        )
        val profiles = code(source(profilesPath))
        assertTrue(
            "SignedInProfiles no longer refuses when the cipher is unavailable, so a " +
                "phone with no Keystore would store refresh tokens in clear text",
            profiles.contains("DeviceCipher.encrypt(plain) ?: return")
        )
    }

    @Test
    fun `the upgrade migrates the old plaintext session instead of signing everyone out`() {
        // A manager that just found nothing would log out every contractor on
        // update -- in a yard, without their password. Worse than the exposure.
        val body = code(source(sessionPath))
        assertTrue(
            "the migration from auth-kt's plaintext store is gone: updating now signs " +
                "every contractor out",
            body.contains("migrateLegacySession")
        )
        // Re-save BEFORE clearing, or a process killed between the two loses
        // the session from both stores.
        val migrate = body.substringAfter("private suspend fun migrateLegacySession")
            .substringBefore("private fun saveSessionBlocking")
        val saved = migrate.indexOf("saveSessionBlocking")
        val cleared = migrate.indexOf("clearLegacy")
        assertTrue("the migration no longer re-saves and clears", saved >= 0 && cleared >= 0)
        assertTrue(
            "the migration clears the plaintext BEFORE re-saving it encrypted; a process " +
                "killed in between would lose the session from both stores",
            saved < cleared
        )
    }

    @Test
    fun `profiles are remembered where the token rotates, not only at sign-in`() {
        // Supabase retires the old refresh token on every refresh. A profile
        // captured only at sign-in holds a token that is dead within the hour,
        // and it dies on the one tap that was meant to be instant.
        val body = code(source(sessionPath))
        val save = body.substringAfter("override suspend fun saveSession")
            .substringBefore("override suspend fun loadSession")
        assertTrue(
            "the face is no longer remembered from saveSession, so the stored refresh " +
                "token falls behind every rotation and tap-to-sign-in dies silently",
            save.contains("profiles.remember(")
        )
    }

    @Test
    fun `signing out drops the credential and keeps the face`() {
        val module = code(source(modulePath))
        val signOut = module.substringAfter("suspend fun signOut()")
        assertTrue(
            "signOut no longer forgets the stored token: a crew handset keeps a " +
                "standing session for whoever signed out of it",
            signOut.contains("forgetToken(")
        )
        assertTrue(
            "the token is forgotten after the sign-out, by which point the user is no " +
                "longer known",
            signOut.indexOf("forgetToken(") < signOut.indexOf("client.auth.signOut()")
        )
    }

    @Test
    fun `the keystore key is not exportable and does not block a cold start`() {
        val cipher = code(source(cipherPath))
        assertTrue("the key is no longer an AndroidKeyStore key", cipher.contains("AndroidKeyStore"))
        assertTrue("GCM is gone", cipher.contains("AES/GCM/NoPadding"))
        // The app must read its own session when the process starts, before
        // any prompt could be shown; a key demanding authentication would lock
        // the phone out of its own sync.
        assertTrue(
            "the key now requires user authentication, which the cold-start session read " +
                "cannot satisfy",
            cipher.contains("setUserAuthenticationRequired(false)")
        )
    }

    @Test
    fun `the cipher answers null instead of throwing on the startup path`() {
        // A Keystore key can genuinely disappear (restores, some OEM
        // upgrades). Throwing here takes the app down before a screen draws.
        val cipher = code(source(cipherPath))
        assertTrue("encrypt no longer swallows failures", cipher.contains("}.getOrNull()"))
        assertFalse(
            "the cipher throws on failure; this runs while the app is starting",
            cipher.contains("getOrThrow()")
        )
    }
}
