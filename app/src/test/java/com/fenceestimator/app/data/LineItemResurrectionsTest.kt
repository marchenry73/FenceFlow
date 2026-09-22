package com.fenceestimator.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The ids a regenerate just wrote under a sync id the cloud may hold
 * deleted: spared by the reaper until the push has revived them, and no
 * longer.
 *
 * The bug: a role that left the takeoff was tombstoned; when it came back
 * under the same deterministic id, DeletionReaper.reap saw the cloud
 * tombstone and deleted the brand-new local line, about 1.5 s after Suggest
 * Quantities, and the price dropped with it. Repository.reapLineItems now
 * deletes only [LineItemResurrections.reapable] of what the cloud says is
 * tombstoned -- reading the waiting ids from their own table
 * (pending_resurrections) in the same transaction as the delete, so neither
 * a dead process nor a regenerate landing mid-reap can take a line back.
 *
 * The table itself needs a device to test; the rule it feeds is pure and is
 * held here, with the regenerate that fills it (TakeoffLineMerge.Plan.revive).
 */
class LineItemResurrectionsTest {

    private val tombstonedInCloud = listOf("gate-panel", "hinge-set", "old-line-somebody-deleted")

    @Test
    fun `a line waiting to be revived is spared, and only that line`() {
        val waiting = setOf("gate-panel", "hinge-set")
        assertEquals(listOf("old-line-somebody-deleted"), LineItemResurrections.reapable(tombstonedInCloud, waiting))

        // Planted failure: with nothing waiting -- the old reaper -- every one
        // of them is reaped, the two just written included.
        assertEquals(tombstonedInCloud, LineItemResurrections.reapable(tombstonedInCloud, emptySet()))
    }

    @Test
    fun `once the revival is pushed, a later tombstone is a real delete again`() {
        // confirmPushed removes the ids from the table; what the reaper then
        // reads is what is left.
        val afterPush = setOf("gate-panel", "hinge-set") - setOf("gate-panel", "hinge-set")
        assertEquals(tombstonedInCloud, LineItemResurrections.reapable(tombstonedInCloud, afterPush))
    }

    @Test
    fun `a waiting id the cloud has not tombstoned changes nothing`() {
        // A new line waiting for its first push: nothing to spare it from.
        assertTrue(LineItemResurrections.reapable(emptyList(), setOf("brand-new")).isEmpty())
        assertEquals(listOf("hinge-set"), LineItemResurrections.reapable(listOf("hinge-set"), setOf("brand-new")))
    }
}
