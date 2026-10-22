package com.fenceestimator.app.cloud

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE TOKEN NEVER REACHES THE SCREEN.
 *
 * On 2026-10-22 the Admin console showed a permission failure on
 * mail_platform_settings and, under it, the whole request: the URL, every
 * header, and `Authorization=[Bearer eyJ...]` -- a live access token, in red,
 * on a phone that was then photographed. The crash-report path had been
 * redacted for weeks (CrashReporterTest covers it); the screen path had not.
 *
 * The message below is the real one, shortened only in the middle of the
 * token. Every check is paired with a planted failure, because "the output
 * does not contain the token" is a test that passes just as well when the
 * function returns the empty string.
 */
class ShownErrorTest {

    /** A real postgrest-kt 3.0.2 message, as photographed. */
    private val leak =
        "permission denied for table mail_platform_settings (Grant the required privileges " +
            "to the current role with: GRANT SELECT ON public.mail_platform_settings TO authenticated;) " +
            "URL: https://newcrgafcptspmapacrx.supabase.co/rest/v1/mail_platform_settings?id=eq.1&select=sender_provider " +
            "Headers: [Authorization=[Bearer eyJhbGciOiJIUzI1NiIsImtpZCI6IjgxZjQ4ZGM5.eyJpc3MiOiJodHRwczov.kVFUkKL_K7CAcdwQ], " +
            "Content-Type=[application/json], Prefer=[], Accept-Profile=[public]]"

    @Test
    fun `the access token is not in what the person is shown`() {
        val shown = shownError(IllegalStateException(leak), "fallback")
        assertFalse("the bearer token is still on screen", shown.contains("Bearer ey"))
        assertFalse("a bare JWT is still on screen", shown.contains("eyJhbGciOiJIUzI1NiIs"))
        assertFalse("the Authorization header is still on screen", shown.contains("Authorization"))
    }

    @Test
    fun `PLANTED FAILURE the raw message really did carry the token`() {
        // Without this the check above would pass against any string at all,
        // including an empty one, and prove nothing about the redaction.
        assertTrue("the fixture no longer carries a token, so this file guards nothing",
            leak.contains("Bearer ey"))
    }

    @Test
    fun `the reason survives, because an error nobody can read is a dead end`() {
        val shown = shownError(IllegalStateException(leak), "fallback")
        assertTrue("the actual reason was thrown away with the plumbing: $shown",
            shown.contains("permission denied for table mail_platform_settings"))
        assertFalse("the URL is still shown, which is where the token lives", shown.contains("URL:"))
    }

    @Test
    fun `the server's own sentence is preferred over the request dump`() {
        RealRestErrors().use { errors ->
            val e = errors.of(403, "Only owners can change this.", "stack-depth-limit")
            val shown = shownError(e, "fallback")
            assertTrue("the server's sentence is gone: $shown", shown.contains("Only owners can change this."))
            assertFalse("the request URL is still being shown", shown.contains("supabase.co"))
        }
    }

    @Test
    fun `a wrapped RestException is still found`() {
        RealRestErrors().use { errors ->
            val wrapped = RuntimeException("sync failed", errors.of(403, "Only owners can change this."))
            assertTrue(shownError(wrapped, "fallback").contains("Only owners can change this."))
        }
    }

    @Test
    fun `nothing readable falls back to the caller's sentence, never to blank`() {
        assertEquals("Could not read the mail sender.",
            shownError(IllegalStateException(""), "Could not read the mail sender."))
        assertEquals("Could not read the mail sender.",
            shownError(null, "Could not read the mail sender."))
        // A message that is ONLY plumbing leaves nothing to say.
        assertEquals("fallback", shownError(IllegalStateException("URL: https://x/y"), "fallback"))
    }

    @Test
    fun `an ordinary message is passed through unchanged`() {
        assertEquals("The download did not finish.",
            shownError(IllegalStateException("The download did not finish."), "fallback"))
    }

    @Test
    fun `a surprise wall of text cannot push the buttons off the screen`() {
        val shown = shownError(IllegalStateException("x".repeat(5000)), "fallback")
        assertTrue("a 5000-character message is being rendered in full", shown.length <= 300)
    }

    @Test
    fun `CANARY the redaction is the report path's, not a second copy`() {
        // Called, not copied: if CrashReporter.redact ever stops redacting,
        // this fails here too rather than the two drifting apart silently.
        assertFalse(CrashReporter.redact("Authorization=[Bearer eyJabc.def.ghi]").contains("eyJabc"))
    }
}
