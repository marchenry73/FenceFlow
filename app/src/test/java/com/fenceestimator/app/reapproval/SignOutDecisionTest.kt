package com.fenceestimator.app.reapproval

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SignOutDecisionTest {

    @Test
    fun `no unsynced work always allows sign out`() {
        assertTrue(allowSignOut(hasUnsyncedWork = false, force = false))
        assertTrue(allowSignOut(hasUnsyncedWork = false, force = true))
    }

    @Test
    fun `unsynced work blocks a plain sign out`() {
        assertFalse(allowSignOut(hasUnsyncedWork = true, force = false))
    }

    // Planted-failure case: force must actually override the guard, or
    // "sign out anyway" becomes a button that does nothing -- the exact
    // silent-refusal bug this task exists to fix.
    @Test
    fun `force overrides unsynced work`() {
        assertTrue(allowSignOut(hasUnsyncedWork = true, force = true))
    }

    /**
     * Shifts the server has permanently rejected (see
     * [com.fenceestimator.app.data.UnsyncedSummary]'s blockedTimeEntries)
     * must never reach this function's [hasUnsyncedWork] as true on their
     * own -- the caller is expected to compute it from
     * [com.fenceestimator.app.data.UnsyncedSummary.isEmpty], which already
     * excludes them. This documents that composition at the boundary this
     * function actually sits behind.
     */
    @Test
    fun `a phone with only permanently-rejected shifts is allowed to sign out`() {
        val summary = com.fenceestimator.app.data.UnsyncedSummary(
            jobs = 0, files = 0, blockedTimeEntries = 2
        )
        assertTrue(allowSignOut(hasUnsyncedWork = !summary.isEmpty, force = false))
    }

    // Planted-failure case: a real unsynced job alongside blocked shifts
    // must still block a plain sign-out.
    @Test
    fun `a phone with real unsynced work and blocked shifts still blocks`() {
        val summary = com.fenceestimator.app.data.UnsyncedSummary(
            jobs = 1, files = 0, blockedTimeEntries = 2
        )
        assertFalse(allowSignOut(hasUnsyncedWork = !summary.isEmpty, force = false))
    }
}
