package com.fenceestimator.app.cloud

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/**
 * Telling "no signal" apart from a real fault.
 *
 * A crew in a back yard with no bars is normal and self-correcting. Reporting
 * that as a sync failure trains people to ignore the message, and then they
 * miss the one time something is actually wrong. This is matched on exception
 * text because the failure arrives from several layers with no common type, so
 * it is worth checking the matching actually works.
 */
class OfflineMessagingTest {

    /** Mirrors AutoSync.looksLikeNoSignal, which is private. */
    private fun looksLikeNoSignal(error: Throwable): Boolean {
        val text = generateSequence(error) { it.cause }
            .mapNotNull { "${it::class.simpleName} ${it.message}" }
            .joinToString(" ")
            .lowercase()
        return listOf(
            "unable to resolve host", "failed to connect", "timeout", "timed out",
            "no address associated", "network is unreachable", "unknownhost",
            "connectexception", "sockettimeout", "connect timeout", "software caused connection abort"
        ).any { it in text }
    }

    @Test
    fun `no DNS while offline reads as no signal`() {
        val e = UnknownHostException("Unable to resolve host \"newcrgafcptspmapacrx.supabase.co\"")
        assertTrue(looksLikeNoSignal(e))
    }

    @Test
    fun `connection refused reads as no signal`() {
        assertTrue(looksLikeNoSignal(ConnectException("Failed to connect to /10.0.2.2:443")))
    }

    @Test
    fun `a socket timeout reads as no signal`() {
        assertTrue(looksLikeNoSignal(SocketTimeoutException("timeout")))
    }

    @Test
    fun `an unreachable network reads as no signal`() {
        assertTrue(looksLikeNoSignal(IOException("Network is unreachable")))
    }

    @Test
    fun `a wrapped network failure is still recognised through the cause chain`() {
        val wrapped = RuntimeException("Sync failed", UnknownHostException("Unable to resolve host"))
        assertTrue(looksLikeNoSignal(wrapped))
    }

    @Test
    fun `a real server error is NOT treated as no signal`() {
        // This one must reach the user as a genuine failure -- it will not fix
        // itself by walking to the truck.
        val e = IllegalStateException("null value in column \"unit\" violates not-null constraint")
        assertFalse(looksLikeNoSignal(e))
    }

    @Test
    fun `a permission error is NOT treated as no signal`() {
        assertFalse(looksLikeNoSignal(IllegalStateException("new row violates row-level security policy")))
    }

    @Test
    fun `the offline message promises the work is kept`() {
        val state = SyncState(phase = SyncPhase.WAITING_FOR_SIGNAL, hasUnsyncedWork = true)
        assertTrue(
            "the message must say the work is safe, which is the actual worry",
            state.message.contains("saved on this phone", ignoreCase = true)
        )
    }

    @Test
    fun `a successful sync clears the unsynced flag`() {
        val state = SyncState(phase = SyncPhase.OK, hasUnsyncedWork = false)
        assertFalse(state.hasUnsyncedWork)
        assertTrue(state.message.contains("backed up", ignoreCase = true))
    }
}
