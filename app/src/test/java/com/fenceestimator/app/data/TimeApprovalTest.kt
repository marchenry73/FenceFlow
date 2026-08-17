package com.fenceestimator.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A finished shift is a claim until somebody signs off on it.
 *
 * Hours become pay and become job cost. Both are wrong if a clock ran through
 * lunch or nobody clocked out until the next morning -- neither is dishonesty,
 * both are what happens on a site, and both are why the figure is checked
 * before it counts.
 */
class TimeApprovalTest {

    private val hour = 3_600_000L
    private val start = 1_700_000_000_000L

    private fun shift(
        hours: Double = 8.0,
        approved: Boolean = false,
        rejected: Boolean = false,
        running: Boolean = false,
        rate: Double = 25.0
    ) = TimeEntry(
        jobId = 1,
        startedAt = start,
        endedAt = if (running) null else start + (hours * hour).toLong(),
        hourlyRate = rate,
        approvedAt = if (approved) start else null,
        rejectedAt = if (rejected) start else null
    )

    @Test
    fun `a running shift is not waiting for anything yet`() {
        val running = shift(running = true)
        assertTrue(running.isRunning)
        assertFalse(running.isAwaitingApproval)
    }

    @Test
    fun `clocking out puts the shift in the queue`() {
        val done = shift()
        assertFalse(done.isRunning)
        assertTrue(done.isAwaitingApproval)
    }

    @Test
    fun `unapproved hours are worth nothing yet`() {
        val pending = shift(hours = 8.0)
        // The hours worked are still recorded and visible...
        assertEquals(8.0, pending.hours, 0.001)
        // ...but nothing counts towards pay or job cost until signed off.
        assertEquals(0.0, pending.payableHours, 0.001)
        assertEquals(0.0, pending.laborCost, 0.001)
    }

    @Test
    fun `the reviewer sees what it would cost if approved`() {
        // Zero payable but a real claimed figure -- otherwise the person
        // approving it is deciding blind.
        assertEquals(200.0, shift(hours = 8.0, rate = 25.0).claimedCost, 0.001)
    }

    @Test
    fun `approving makes the hours count`() {
        val approved = shift(hours = 8.0, approved = true)
        assertEquals(8.0, approved.payableHours, 0.001)
        assertEquals(200.0, approved.laborCost, 0.001)
        assertFalse(approved.isAwaitingApproval)
    }

    @Test
    fun `a shift sent back does not pay and does not sit in the queue`() {
        val rejected = shift(rejected = true)
        assertTrue(rejected.isRejected)
        assertFalse(rejected.isAwaitingApproval)
        assertEquals(0.0, rejected.payableHours, 0.001)
    }

    @Test
    fun `approving a previously rejected shift wins`() {
        // The repository clears rejectedAt on approval; this pins the reading
        // even if both timestamps are somehow present.
        val both = shift(approved = true, rejected = true)
        assertTrue(both.isApproved)
        assertFalse(both.isRejected)
        assertTrue(both.payableHours > 0.0)
    }

    @Test
    fun `correcting the times changes what is owed`() {
        // The common real case: eight hours claimed, an hour of it was lunch.
        val corrected = shift(hours = 8.0, approved = true)
            .copy(endedAt = start + 7 * hour)
        assertEquals(7.0, corrected.payableHours, 0.001)
        assertEquals(175.0, corrected.laborCost, 0.001)
    }
}
