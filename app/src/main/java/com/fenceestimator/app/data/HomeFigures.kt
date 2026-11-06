package com.fenceestimator.app.data

import com.fenceestimator.app.cloud.SyncPhase
import com.fenceestimator.app.cloud.UnsyncedReason

/**
 * Whether the money figures on the home screen are built from a local copy
 * that is KNOWN to be short.
 *
 * WHY THIS EXISTS. The owner's phone showed $105k owed and a second phone in
 * the same company showed $8,000, then $35,000, then $80,000 (6 Nov 2026).
 * Measured first: both logins are handed identical rows by the server -- 13
 * jobs, 473 line items, 24 payments each -- so it was never a permissions or a
 * scoping problem.
 *
 * The totals are recomputed ON THE PHONE from whatever jobs, line items, runs
 * and change orders are in Room. That makes an incomplete copy
 * indistinguishable from a cheaper business: there is no error and no gap, just
 * a smaller number. And commit 0cf2ab7 describes how the copy comes to be
 * short -- on a fresh sign-in askMoneyScope() can answer UNKNOWN, and on
 * UNKNOWN the job half of the pass does not run at all, so jobs, the catalog
 * and the line items are all skipped. It retries three times (4s, 8s, 12s) and
 * then falls back to a heartbeat: 60s with the app open, fifteen minutes in a
 * pocket. Each recovery brings more rows down, and every total is rebuilt from
 * what has arrived so far.
 *
 * So the screen has to ask whether the copy can be trusted yet and draw "--"
 * when it cannot, which the hero and the tile both already do for a null.
 *
 * Pure, and in its own file, so it can be tested without Compose. The decision
 * used to be one inline expression at the call site -- `phase == SYNCING` --
 * which is why it only ever covered one of the three states, and why even in
 * that state the number was drawn ALONGSIDE the "not final yet" note rather
 * than instead of it.
 */
object HomeFigures {

    /**
     * True when the figures must not be shown as final.
     *
     * @param phase the sync phase.
     * @param lastSyncedAt when a pass last FINISHED, or null if none ever has.
     * @param reason why work is unsynced. Only meaningful on [SyncPhase.OK] --
     *   every other phase can be carrying an earlier pass's answer through a
     *   copy(), so reading it elsewhere would be a stale reason wearing a
     *   current banner. This reads it on OK and nowhere else.
     */
    fun incomplete(
        signedIn: Boolean,
        phase: SyncPhase,
        lastSyncedAt: Long?,
        reason: UnsyncedReason?
    ): Boolean {
        // NOT SIGNED IN MEANS NOTHING IS MISSING. This phone's local copy is
        // the whole business; there is no server copy for it to be short of.
        //
        // This is first because the phase alone is not enough to tell, and
        // getting that wrong shipped in 1.871: the exemption named
        // OFFLINE_ONLY and SIGNED_OUT, but a signed-out phone can sit in IDLE
        // or WAITING_FOR_SIGNAL, which fell through to the lastSyncedAt test
        // below -- and a phone that is not signed in never completes a sync,
        // so lastSyncedAt is null for ever and the figure read "--" for ever.
        // It was hiding a correct number, which is the exact failure the
        // exemption existed to prevent.
        if (!signedIn) return false
        return incompleteWhileSignedIn(phase, lastSyncedAt, reason)
    }

    private fun incompleteWhileSignedIn(
        phase: SyncPhase,
        lastSyncedAt: Long?,
        reason: UnsyncedReason?
    ): Boolean =
        when (phase) {
            // WORKING ALONE IS NOT INCOMPLETE. A phone that is signed out, or
            // has never been signed in, holds all there is to hold: its local
            // copy IS the business. Blanking the figure here would hide a
            // number that is correct, which is its own kind of lie -- and it is
            // the state every phone is in before anybody signs up.
            SyncPhase.OFFLINE_ONLY, SyncPhase.SIGNED_OUT -> false

            // A pass is in flight: more rows are arriving as the figure is read.
            SyncPhase.SYNCING -> true

            // A pass finished. It is still short in exactly one case: it could
            // not confirm what the account may see, so the half that moves jobs
            // and prices DID NOT RUN. That is the reported bug.
            SyncPhase.OK -> reason == UnsyncedReason.ACCESS_NOT_CONFIRMED

            // Idle, failed, or waiting for a signal. Trustworthy only once a
            // pass has actually finished at least once; before that the copy is
            // whatever a part-finished sign-in left behind.
            else -> lastSyncedAt == null
        }
}
