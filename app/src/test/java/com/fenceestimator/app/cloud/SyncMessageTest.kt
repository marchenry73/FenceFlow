package com.fenceestimator.app.cloud

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the app says when it is not backing up.
 *
 * Two very different situations shared one sentence. Telling somebody who IS
 * signed in to "sign in" reads as the app being broken, and hides the actual
 * step -- they have no company yet, so there is nowhere for the work to go.
 */
class SyncMessageTest {

    @Test
    fun `not signed in is told to sign in`() {
        val state = SyncState(phase = SyncPhase.OFFLINE_ONLY, signedInWithoutCompany = false)
        assertTrue(state.message.contains("Sign in", ignoreCase = true))
    }

    @Test
    fun `signed in with no company is not told to sign in again`() {
        val state = SyncState(phase = SyncPhase.OFFLINE_ONLY, signedInWithoutCompany = true)
        assertFalse(
            "telling someone already signed in to sign in reads as a broken app",
            state.message.contains("Sign in to back up", ignoreCase = true)
        )
        assertTrue(state.message.contains("company", ignoreCase = true))
    }

    @Test
    fun `a failure never suggests the work is gone`() {
        // The fear when a sync fails is that the day's work is lost. It never
        // is, and the message has to say so before anything technical.
        val failed = SyncState(phase = SyncPhase.FAILED, lastError = "timeout")
        assertTrue(failed.message.contains("safe on this phone", ignoreCase = true))

        val noSignal = SyncState(phase = SyncPhase.WAITING_FOR_SIGNAL)
        assertTrue(noSignal.message.contains("saved on this phone", ignoreCase = true))
    }
}
