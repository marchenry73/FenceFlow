package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.TimeEntry
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * What a sync pass does with the jobs a crew phone keeps after its person was
 * taken off them ([JobHoldPlan.keepsHeld]):
 *  - nothing is pushed for one -- not even on a pass whose money question
 *    failed, which used to try to INSERT every kept job into the real table
 *    and fail the whole pass on the refusal;
 *  - one holding an unsent edit is work waiting, and the sync card must say
 *    so rather than "everything is backed up";
 *  - one the office has since deleted is forgotten like any tombstoned job
 *    ([keptJobsToForget]) -- but never while it holds a shift the cloud may
 *    not have, because forgetting a job takes its shifts with it.
 */
class KeptJobsTest {

    private fun job(syncId: String, heldAt: Long? = null) =
        Job(id = syncId.hashCode().toLong(), syncId = syncId, updatedAt = 1_000L, lastSyncedAt = 1_000L, accessEndedAt = heldAt)

    private val held = job("held", heldAt = 500L)
    private val visible = job("visible")

    // ---- keepsHeld ----

    @Test
    fun `an unanswered question keeps what was held held, and hides nothing new`() {
        val nothing = JobHoldPlan()
        assertTrue(nothing.keepsHeld(held))
        assertFalse(nothing.keepsHeld(visible))
    }

    @Test
    fun `hidden this pass is kept -- brought back, or everything back, is not`() {
        assertTrue(JobHoldPlan(hide = setOf("visible")).keepsHeld(visible))
        assertFalse(JobHoldPlan(unhide = setOf("held")).keepsHeld(held))
        assertFalse(JobHoldPlan(unhideAll = true).keepsHeld(held))
        // Planted failure: bringing back a different job leaves this one kept.
        assertTrue(JobHoldPlan(unhide = setOf("someone-else")).keepsHeld(held))
    }

    // ---- keptJobsToForget ----

    private val deleted = setOf("held")
    private fun shift(syncId: String, jobId: Long, running: Boolean = false) =
        TimeEntry(syncId = syncId, jobId = jobId, startedAt = 100L, endedAt = if (running) null else 200L)

    @Test
    fun `a kept job the office deleted, with no shift on it, is forgotten on the server's word`() {
        assertEquals(listOf(held), keptJobsToForget(listOf(held), deleted, emptyMap(), shiftsInCloud = null))
    }

    @Test
    fun `not one the office did not delete -- canary`() {
        assertTrue(keptJobsToForget(listOf(held), emptySet(), emptyMap(), emptySet()).isEmpty())
    }

    @Test
    fun `a running shift keeps it -- someone is on the clock there`() {
        val shifts = mapOf(held.id to listOf(shift("s1", held.id, running = true)))
        assertTrue(keptJobsToForget(listOf(held), deleted, shifts, setOf("s1")).isEmpty())
    }

    @Test
    fun `a finished shift the crew door does not show keeps it -- once it shows, the job goes`() {
        val shifts = mapOf(held.id to listOf(shift("s1", held.id), shift("s2", held.id)))
        assertTrue(keptJobsToForget(listOf(held), deleted, shifts, setOf("s1")).isEmpty())
        assertEquals(listOf(held), keptJobsToForget(listOf(held), deleted, shifts, setOf("s1", "s2")))
    }

    @Test
    fun `a failed read of the crew door keeps every job with a shift`() {
        val shifts = mapOf(held.id to listOf(shift("s1", held.id)))
        assertTrue(keptJobsToForget(listOf(held), deleted, shifts, shiftsInCloud = null).isEmpty())
    }

    @Test
    fun `ids are compared as uuids, whatever their case`() {
        val upper = job("AB-CD", heldAt = 1L)
        val shifts = mapOf(upper.id to listOf(shift("S-1", upper.id)))
        assertEquals(listOf(upper), keptJobsToForget(listOf(upper), setOf("ab-cd"), shifts, setOf("s-1")))
    }

    // ---- the answer deleted_job_sync_ids() comes back as ----

    private fun json(s: String): JsonElement = Json.parseToJsonElement(s)

    @Test
    fun `a set of uuids reads as the ids, in either shape PostgREST may use`() {
        assertEquals(setOf("a", "b"), parseSyncIdSet(json("""["a","b"]""")))
        assertEquals(setOf("a"), parseSyncIdSet(json("""[{"deleted_job_sync_ids":"a"}]""")))
        assertEquals(emptySet<String>(), parseSyncIdSet(json("[]")))
    }

    @Test
    fun `a shape this build cannot read is null, never an empty set`() {
        assertNull(parseSyncIdSet(json("""{"a":1}""")))
        assertNull(parseSyncIdSet(json("""[1,2]""")))
        assertNull(parseSyncIdSet(json("""[{"a":"x","b":"y"}]""")))
        assertNull(parseSyncIdSet(json("null")))
    }

    // ---- wired into the pass ----

    private val sync = File("src/main/java/com/fenceestimator/app/cloud/JobSync.kt").readText()

    @Test
    fun `the push loop skips every kept job before it can reach the insert branch`() {
        val loop = sync.indexOf("for (job in localJobs) {", sync.indexOf("val keptNow = "))
        assertTrue("the push loop is not after keptNow", loop > 0)
        val head = sync.substring(loop, sync.indexOf("val cloudJob = cloudBySyncId[job.syncId]", loop))
        assertTrue("the push loop no longer skips kept jobs", head.contains("if (holds.keepsHeld(job)) continue"))
    }

    @Test
    fun `a kept job's unsent edit is counted as held back`() {
        val block = sync.substring(sync.indexOf("val keptNow = "), sync.indexOf("for (job in localJobs) {", sync.indexOf("val keptNow = ")))
        assertTrue(block.contains("heldBack += keptNow.count"))
        assertTrue(block.contains("jobHoldsUnpushedEdit(it)"))
    }

    @Test
    fun `a deleted kept job is only forgotten through keptJobsToForget, and only on a scoped answer`() {
        val block = sync.substring(sync.indexOf("val keptNow = "), sync.indexOf("heldBack += keptNow.count"))
        assertTrue(block.contains("access is JobScope.Scoped"))
        assertTrue(block.contains("JobAccess.deletedAmong("))
        assertTrue(block.contains("for (job in keptJobsToForget("))
        assertEquals("one delete, inside the keptJobsToForget loop", 1, Regex("deleteJobLocallyOnly").findAll(block).count())
    }
}
