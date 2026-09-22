package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.jobHoldsUnpushedEdit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What a job row on this phone becomes straight after it has been pushed
 * ([jobAfterPush]), and the two pull mappings fixed alongside it: created_at
 * on a first pull ([toLocalJob]) and the accepted price ([acceptedTotalToAdopt],
 * [mergeOnto]).
 *
 * The push bug: the phone kept its own edit time (T1) after a push while the
 * server stamped the row with its own later clock (S). EntitySync's child
 * gate -- push a job's line items only when `cloud updated_at <= local
 * updatedAt` -- then held this job's line items back for the rest of the same
 * pass, and the pull wrote the cloud's older quantities over the fresh ones.
 * The gate predicate is restated here as [childGatePasses] so a test can hold
 * the result to it.
 */
class JobPushAdoptionTest {

    private val serverStamp = "2026-09-21T20:37:58.123+00:00"
    private val serverMillis = CloudTime.parseMillis(serverStamp)!!

    /** EntitySync.collectJobChildRows: `cloudAt <= job.updatedAt`, or the children wait. */
    private fun childGatePasses(cloudUpdatedAt: Long, local: Job) = cloudUpdatedAt <= local.updatedAt

    // The copy that was pushed: edited on this phone five seconds before the
    // server stamped it, device clock behind or not.
    private fun pushed() = Job(
        id = 7,
        syncId = "job-1",
        customerName = "Jane Homeowner",
        notes = "gate sticks",
        amountPaid = 500.0,
        updatedAt = serverMillis - 5_000,
        lastSyncedAt = serverMillis - 60_000
    )

    private fun returned(
        customerName: String = "Jane Homeowner",
        notes: String = "gate sticks",
        updatedAt: String? = serverStamp
    ) = CloudJob(
        syncId = "job-1",
        companyId = "co-1",
        customerName = customerName,
        notes = notes,
        amountPaid = 500.0,
        updatedAt = updatedAt
    )

    // ---- nothing typed while the push was in flight ----

    @Test
    fun `the pushed row takes the server's clock, so this job's line items go up this pass`() {
        val after = jobAfterPush(pushed(), current = pushed(), returned = returned(), keepMoney = false)
        assertNotNull(after)
        assertEquals(serverMillis, after!!.updatedAt)
        assertEquals(serverMillis, after.lastSyncedAt)
        assertTrue("the child gate still holds this job's line items back", childGatePasses(serverMillis, after))
        assertFalse("the adopted row is not in step with the cloud", jobHoldsUnpushedEdit(after))
    }

    @Test
    fun `the old stamp-only settle failed the child gate -- planted failure`() {
        // What updateJobSyncStamp alone left behind: updatedAt still T1.
        val oldSettle = pushed().copy(lastSyncedAt = System.currentTimeMillis())
        assertFalse(childGatePasses(serverMillis, oldSettle))
    }

    @Test
    fun `a value the server put back comes down with the push, not a pass later`() {
        // protect_customer_identity holds the name for a phone without
        // EDIT_JOBS. The phone must end up holding what the server kept, not
        // the name it sent, or it believes an edit landed that never did.
        val typed = pushed().copy(customerName = "Typed on the crew phone")
        val after = jobAfterPush(typed, current = typed, returned = returned(customerName = ""), keepMoney = true)!!
        assertEquals("", after.customerName)
    }

    @Test
    fun `the crew door's money-free row never scrubs the phone's money`() {
        // jobs_crew carries no money columns; they decode to CloudJob's zeros.
        val crewRow = returned().copy(amountPaid = 0.0)
        val after = jobAfterPush(pushed(), current = pushed(), returned = crewRow, keepMoney = true)!!
        assertEquals(500.0, after.amountPaid, 0.001)
        // Planted: without keepMoney the same row would zero it.
        assertEquals(0.0, jobAfterPush(pushed(), pushed(), crewRow, keepMoney = false)!!.amountPaid, 0.001)
    }

    // ---- an edit typed while the push was in flight ----

    @Test
    fun `an edit typed during the push is neither overwritten nor vouched for`() {
        val current = pushed().copy(notes = "typed during the push", updatedAt = pushed().updatedAt + 100)
        val after = jobAfterPush(pushed(), current, returned(notes = "gate sticks"), keepMoney = false)!!
        assertEquals("typed during the push", after.notes)
        assertTrue("the in-flight edit was marked as synced", jobHoldsUnpushedEdit(after))
        assertEquals(pushed().updatedAt, after.lastSyncedAt)
        // Strictly newer than the server's clock, so the next pass pushes it
        // rather than pulling the cloud's copy over it -- even with this
        // device clock behind the server (current.updatedAt < S here).
        assertTrue(current.updatedAt < serverMillis)
        assertTrue(after.updatedAt > serverMillis)
    }

    @Test
    fun `merging the returned row over an in-flight edit would lose it -- planted failure`() {
        val current = pushed().copy(notes = "typed during the push", updatedAt = pushed().updatedAt + 100)
        assertNotEquals("typed during the push", returned(notes = "gate sticks").mergeOnto(current).notes)
    }

    @Test
    fun `a returned row with no readable clock vouches for nothing`() {
        assertNull(jobAfterPush(pushed(), pushed(), returned(updatedAt = null), keepMoney = false))
        assertNull(jobAfterPush(pushed(), pushed(), returned(updatedAt = "not a time"), keepMoney = false))
    }

    // ---- created_at on a first pull ----

    @Test
    fun `a freshly pulled job keeps the cloud's creation time`() {
        // 4598150b was created 2026-08-18; a phone pulled it on 09-18, stamped
        // it with the pull time, and the next ordinary edit sent that back.
        val created = "2026-08-18T20:39:30.289+00:00"
        val pulled = CloudJob(syncId = "4598150b", companyId = "co-1", createdAt = created, updatedAt = serverStamp)
            .toLocalJob()
        assertEquals(CloudTime.parseMillis(created), pulled.createdAt)
    }

    @Test
    fun `without the mapping a pull would stamp the moment of the pull -- planted failure`() {
        val created = CloudTime.parseMillis("2026-08-18T20:39:30.289+00:00")!!
        // Job's own default, which is what toLocalJob used to leave in place:
        // the moment of the pull, not the moment the job was made.
        val defaulted = Job(syncId = "4598150b")
        assertNotEquals(created, defaulted.createdAt)
    }

    @Test
    fun `a pull with no creation time still gets one`() {
        val before = System.currentTimeMillis()
        val pulled = CloudJob(syncId = "j", companyId = "c", updatedAt = serverStamp).toLocalJob()
        assertTrue(pulled.createdAt >= before)
    }

    // ---- the accepted price on the way down ----

    @Test
    fun `an accepted price the server stamped is taken`() {
        assertEquals(3620.0, acceptedTotalToAdopt(local = null, cloud = 3620.0)!!, 0.001)
        assertEquals(9710.0, acceptedTotalToAdopt(local = 3620.0, cloud = 9710.0)!!, 0.001)
    }

    @Test
    fun `a matching or missing cloud figure changes nothing`() {
        assertNull(acceptedTotalToAdopt(local = 3620.0, cloud = 3620.0))
        // Null is "not stamped yet" (or a database without the column), never
        // "the customer un-accepted": it must not erase a figure a drawn
        // signature froze here before its push landed.
        assertNull(acceptedTotalToAdopt(local = 3620.0, cloud = null))
    }

    @Test
    fun `mergeOnto keeps the accepted price through the money-free door and on a null`() {
        val local = pushed().copy(acceptedTotal = 3620.0)
        val stamped = returned().copy(acceptedTotal = 9710.0)
        assertEquals(9710.0, stamped.mergeOnto(local).acceptedTotal!!, 0.001)
        assertEquals(3620.0, stamped.mergeOnto(local, keepMoney = true).acceptedTotal!!, 0.001)
        assertEquals(3620.0, returned().mergeOnto(local).acceptedTotal!!, 0.001)
    }
}
