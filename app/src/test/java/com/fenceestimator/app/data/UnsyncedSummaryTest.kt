package com.fenceestimator.app.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [UnsyncedSummary.isEmpty] is what [Repository.hasUnsyncedWork] gates
 * sign-out on. Shifts the server has permanently rejected (blockedTimeEntries)
 * must never count towards it -- a retry cannot fix them, so treating them
 * like real unsynced work would make signing out impossible forever over a
 * row nobody can act on except from the Time screen's Fix action.
 */
class UnsyncedSummaryTest {

    @Test
    fun `blocked time entries alone do not count as unsynced work`() {
        val summary = UnsyncedSummary(jobs = 0, files = 0, blockedTimeEntries = 5)
        assertTrue("permanently-rejected shifts must never block sign-out", summary.isEmpty)
    }

    // Planted-failure case: real unsynced work (a job or a file) must still
    // count, even alongside a pile of blocked shifts -- proving isEmpty
    // wasn't just hard-coded to true.
    @Test
    fun `real unsynced work still counts alongside blocked time entries`() {
        val summary = UnsyncedSummary(jobs = 1, files = 0, blockedTimeEntries = 5)
        assertFalse(summary.isEmpty)
    }

    @Test
    fun `no unsynced work and no blocked shifts is empty`() {
        assertTrue(UnsyncedSummary(jobs = 0, files = 0).isEmpty)
    }
}
