package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.jobHoldsUnpushedEdit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The sign-out warning counts a job as "not backed up" by
 * [jobHoldsUnpushedEdit]. Only a PUSH used to stamp [Job.lastSyncedAt], and a
 * job the office made is never pushed from a phone, so every such job counted
 * on every phone for ever -- the warning that protects a signature taken with
 * no signal cried wolf on every handset, and the button people learned to tap
 * was "sign out anyway".
 *
 * Fed the real pull mappers ([toLocalJob], [mergeOnto]) rather than a
 * hand-built Job, so a pull that stops stamping fails here.
 */
class PulledJobUnsyncedTest {

    private val officeEditedAt = "2026-09-20T14:05:06.631429+00:00"

    private fun officeJob() = CloudJob(
        syncId = "job-office-1",
        companyId = "co-1",
        customerName = "Made in the office",
        updatedAt = officeEditedAt
    )

    // ---- a job pulled fresh ----

    @Test
    fun `a job pulled from the office and left alone is not unsynced work`() {
        val pulled = officeJob().toLocalJob()
        assertEquals(officeJob().updatedAtMillis(), pulled.lastSyncedAt)
        assertFalse(jobHoldsUnpushedEdit(pulled))
    }

    // Planted failure: the same row without the pull's stamp -- exactly what
    // every older build wrote -- does count. Proves the stamp is the thing
    // making the difference, not something else about the fixture.
    @Test
    fun `the same job without the pull's stamp counts -- the reported bug`() {
        assertTrue(jobHoldsUnpushedEdit(officeJob().toLocalJob().copy(lastSyncedAt = null)))
    }

    @Test
    fun `editing it on this phone after the pull makes it count`() {
        val pulled = officeJob().toLocalJob()
        // What Repository.updateJob writes: the edit, and the device clock.
        val edited = pulled.copy(phone = "555-0100", updatedAt = pulled.updatedAt + 60_000L)
        assertTrue(jobHoldsUnpushedEdit(edited))
    }

    @Test
    fun `a job made on this phone and never pushed still counts`() {
        assertTrue(jobHoldsUnpushedEdit(Job(customerName = "Made here", updatedAt = 5_000L)))
    }

    @Test
    fun `a job pushed from here after its last edit does not`() {
        assertFalse(jobHoldsUnpushedEdit(Job(customerName = "Pushed", updatedAt = 5_000L, lastSyncedAt = 6_000L)))
    }

    // ---- a newer office edit merged onto a job already here ----

    @Test
    fun `a newer office edit merged onto the phone leaves the job in step`() {
        val local = Job(id = 7, syncId = "job-office-1", customerName = "Old", updatedAt = 1_000L, lastSyncedAt = null)
        val merged = officeJob().mergeOnto(local)
        assertFalse(jobHoldsUnpushedEdit(merged))
        // ... and the next edit here is owed again.
        assertTrue(jobHoldsUnpushedEdit(merged.copy(updatedAt = merged.updatedAt + 1)))
    }

    @Test
    fun `the crew phone's merge is stamped the same way`() {
        val local = Job(id = 7, syncId = "job-office-1", customerName = "Old", updatedAt = 1_000L, lastSyncedAt = 500L)
        assertFalse(jobHoldsUnpushedEdit(officeJob().mergeOnto(local, keepMoney = true)))
    }

    // ---- repairing jobs an older build pulled ----

    @Test
    fun `a job an older build pulled and nobody touched is repaired`() {
        val cloud = officeJob()
        val legacy = cloud.toLocalJob().copy(id = 9, lastSyncedAt = null)
        val stamp = pulledCopySyncStamp(legacy, cloud.updatedAtMillis())
        assertEquals(legacy.updatedAt, stamp)
        assertFalse(jobHoldsUnpushedEdit(legacy.copy(lastSyncedAt = stamp)))
    }

    // Planted failure: a job edited on this phone since the pull must never be
    // vouched for, or the repair would hide exactly the work the warning is for.
    @Test
    fun `a job edited here since the pull is never stamped as synced`() {
        val cloud = officeJob()
        val edited = cloud.toLocalJob().copy(lastSyncedAt = null, updatedAt = cloud.updatedAtMillis() + 90_000L)
        assertNull(pulledCopySyncStamp(edited, cloud.updatedAtMillis()))
        assertTrue(jobHoldsUnpushedEdit(edited))
    }

    @Test
    fun `a job pushed from here and pulled back by an older build is repaired`() {
        val cloud = officeJob()
        // The push stamped the device clock a moment before the server's.
        val pulledBack = cloud.toLocalJob().copy(lastSyncedAt = cloud.updatedAtMillis() - 400L)
        assertTrue("fixture: counted before the repair", jobHoldsUnpushedEdit(pulledBack))
        assertEquals(cloud.updatedAtMillis(), pulledCopySyncStamp(pulledBack, cloud.updatedAtMillis()))
    }

    @Test
    fun `a job already in step is left alone`() {
        val cloud = officeJob()
        assertNull(pulledCopySyncStamp(cloud.toLocalJob(), cloud.updatedAtMillis()))
    }

    @Test
    fun `an unreadable cloud clock vouches for nothing`() {
        assertNull(pulledCopySyncStamp(Job(customerName = "x", updatedAt = 0L, lastSyncedAt = null), 0L))
    }
}
