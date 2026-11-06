package com.fenceestimator.app.data

import com.fenceestimator.app.cloud.SyncPhase
import com.fenceestimator.app.cloud.UnsyncedReason
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The money figure must say "--" when the phone's copy is known to be short,
 * and must NOT when it is not. Both halves matter: hiding a correct figure is
 * as wrong as showing an incomplete one.
 *
 * The reported bug (6 Nov 2026): the owner's phone showed $105k owed and a
 * second phone in the same company showed $8,000, then $35,000, then $80,000.
 * Both logins are handed identical rows by the server; the difference was how
 * much had arrived, and every total is rebuilt from what is in Room.
 */
class HomeFiguresTest {

    private val SYNCED = 1_762_000_000_000L

    // ---- the three states that must blank the figure ----------------------

    @Test
    fun `a pass in flight is incomplete`() {
        assertTrue(HomeFigures.incomplete(true, SyncPhase.SYNCING, SYNCED, null))
        // ...even when a pass has finished before: more rows are arriving as
        // the figure is being read.
        assertTrue(HomeFigures.incomplete(true, SyncPhase.SYNCING, SYNCED, UnsyncedReason.JOBS_HELD_BACK))
    }

    @Test
    fun `a finished pass that could not confirm access is incomplete`() {
        // THE REPORTED BUG. On UNKNOWN the job half of the pass does not run at
        // all, so jobs, the catalog and the line items are all skipped -- and
        // the phase is OK, which is what made it look final.
        assertTrue(
            HomeFigures.incomplete(true, SyncPhase.OK, SYNCED, UnsyncedReason.ACCESS_NOT_CONFIRMED)
        )
    }

    @Test
    fun `a phone that cannot finish a sync still shows its figure`() {
        // THE 1.871 AND 1.873 BUG, now pinned the right way round. This used
        // to assert the opposite. lastSyncedAt is in memory and null on every
        // cold start until a pass FINISHES, so "no pass has finished" is true
        // for ever on any phone that cannot complete one -- and the figure was
        // blank for ever. Stale is not short.
        assertFalse(HomeFigures.incomplete(true, SyncPhase.IDLE, null, null))
        assertFalse(HomeFigures.incomplete(true, SyncPhase.FAILED, null, null))
        assertFalse(HomeFigures.incomplete(true, SyncPhase.WAITING_FOR_SIGNAL, null, null))
    }

    // ---- and the states that must NOT ------------------------------------

    @Test
    fun `work held back does not make the FIGURE wrong`() {
        // JOBS_HELD_BACK and RECORDS_HELD_BACK are about the PUSH: this phone
        // has work the cloud has not taken. The pull happened, so the total is
        // complete and blanking it would hide a correct number.
        assertFalse(HomeFigures.incomplete(true, SyncPhase.OK, SYNCED, UnsyncedReason.JOBS_HELD_BACK))
        assertFalse(HomeFigures.incomplete(true, SyncPhase.OK, SYNCED, UnsyncedReason.RECORDS_HELD_BACK))
    }

    @Test
    fun `a clean finished pass is complete`() {
        assertFalse(HomeFigures.incomplete(true, SyncPhase.OK, SYNCED, null))
    }

    @Test
    fun `working alone is never incomplete`() {
        // The state every phone is in before anybody signs up: the local copy
        // IS the business. This is the half a careless fix breaks -- it would
        // put "--" over the one figure a solo contractor has.
        assertFalse(HomeFigures.incomplete(true, SyncPhase.OFFLINE_ONLY, null, null))
        assertFalse(HomeFigures.incomplete(true, SyncPhase.SIGNED_OUT, null, null))
        assertFalse(
            HomeFigures.incomplete(true, SyncPhase.OFFLINE_ONLY, null, UnsyncedReason.ACCESS_NOT_CONFIRMED)
        )
    }

    @Test
    fun `a phase that has synced before is trusted again once idle`() {
        // Idle AFTER a finished pass is the ordinary resting state. If this
        // read as incomplete the figure would be "--" most of the time.
        assertFalse(HomeFigures.incomplete(true, SyncPhase.IDLE, SYNCED, null))
    }

    // ---- the reason is read on OK and nowhere else ------------------------

    @Test
    fun `a stale reason on another phase does not blank the figure`() {
        // unsyncedReason is only meaningful on OK: every other phase can carry
        // an earlier pass's answer through a copy(). Reading it elsewhere would
        // be a stale reason wearing a current banner, and would leave "--" on
        // the screen long after the pass that caused it.
        assertFalse(
            HomeFigures.incomplete(true, SyncPhase.IDLE, SYNCED, UnsyncedReason.ACCESS_NOT_CONFIRMED)
        )
    }

    // ---- every phase is decided, so a new one cannot slip through unseen --

    @Test
    fun `every sync phase has an answer`() {
        for (phase in SyncPhase.entries) {
            // Called for its total absence of exceptions, and so that adding a
            // phase to the enum makes somebody look at this file.
            HomeFigures.incomplete(true, phase, SYNCED, null)
            HomeFigures.incomplete(true, phase, null, UnsyncedReason.ACCESS_NOT_CONFIRMED)
        }
        assertTrue(SyncPhase.entries.size >= 7)
    }

    // ---- the regression that shipped in 1.871 ----------------------------

    @Test
    fun `a phone that is NOT signed in is never incomplete, whatever the phase`() {
        // SHIPPED BROKEN IN 1.871 and found on the owner's own phone: the
        // figure read "--" and stayed there. The exemption named OFFLINE_ONLY
        // and SIGNED_OUT, but a signed-out phone can sit in IDLE or
        // WAITING_FOR_SIGNAL, which fell through to the lastSyncedAt test --
        // and a phone that is not signed in never completes a sync, so
        // lastSyncedAt is null for ever. It hid a correct number for ever,
        // which is the exact failure the exemption existed to prevent.
        for (phase in SyncPhase.entries) {
            assertFalse(
                "a signed-out phone reads as incomplete on phase " + phase,
                HomeFigures.incomplete(false, phase, null, null)
            )
            assertFalse(
                "a signed-out phone reads as incomplete on phase " + phase + " with a reason",
                HomeFigures.incomplete(false, phase, null, UnsyncedReason.ACCESS_NOT_CONFIRMED)
            )
        }
    }

    @Test
    fun `being signed in is what makes the other states mean anything`() {
        // The control for the test above: the SAME inputs, signed in, must
        // still read incomplete -- otherwise that test would pass on a
        // function that always answered false.
        // Only the two states that genuinely mean the copy is short.
        assertTrue(HomeFigures.incomplete(true, SyncPhase.SYNCING, null, null))
        assertTrue(HomeFigures.incomplete(true, SyncPhase.OK, null, UnsyncedReason.ACCESS_NOT_CONFIRMED))
    }
}
