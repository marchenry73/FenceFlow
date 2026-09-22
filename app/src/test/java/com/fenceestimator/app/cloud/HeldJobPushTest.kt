package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.Job
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * What a phone sends for a job its person is no longer on: nothing but its
 * shifts. Its children would be refused row by row by the crew-scope
 * policies on every pass, so they wait on the phone ([mayPushJobChildren],
 * pushFenceRuns), and a refusal of the job row itself is one job held back,
 * not a failed sync ([isNotOursToSync]).
 */
class HeldJobPushTest {

    private val errors = RealRestErrors()

    @After
    fun tearDown() = errors.close()

    private val job = Job(syncId = "j1", updatedAt = 2_000L, lastSyncedAt = 2_000L)
    private val held = job.copy(accessEndedAt = 3_000L)
    private val cloudOlder = mapOf("j1" to (1_000L to false))
    private val cloudNewer = mapOf("j1" to (9_000L to false))

    // ---- mayPushJobChildren ----

    @Test
    fun `a held job's children stay on the phone, whatever else is true`() {
        for (scope in MoneyScope.values()) {
            assertFalse(mayPushJobChildren(held, cloudOlder, scope))
            assertFalse(mayPushJobChildren(held, null, scope))
        }
        // Planted failure: the same job not held goes up.
        assertTrue(mayPushJobChildren(job, cloudOlder, MoneyScope.DENIED))
    }

    @Test
    fun `the job clock still holds back a stale copy`() {
        assertFalse(mayPushJobChildren(job, cloudNewer, MoneyScope.ALLOWED))
        assertTrue(mayPushJobChildren(job, cloudOlder, MoneyScope.ALLOWED))
    }

    @Test
    fun `missing from the crew door is not this phone's to send, missing from the real table is`() {
        val absent = emptyMap<String, Pair<Long, Boolean>>()
        assertFalse(mayPushJobChildren(job, absent, MoneyScope.DENIED))
        assertTrue(mayPushJobChildren(job, absent, MoneyScope.ALLOWED))
    }

    // A failed read is not "the cloud has none of these".
    @Test
    fun `a failed read pushes as it always did`() {
        assertTrue(mayPushJobChildren(job, null, MoneyScope.DENIED))
        assertTrue(mayPushJobChildren(job, null, MoneyScope.ALLOWED))
    }

    // ---- mayPushJobRuns ----

    @Test
    fun `a held job's runs stay on the phone, whatever else is true`() {
        for (scope in MoneyScope.values()) {
            assertFalse(mayPushJobRuns(held, cloudOlder, scope))
            assertFalse(mayPushJobRuns(held, null, scope))
        }
        // Planted failure: the same job not held goes up.
        assertTrue(mayPushJobRuns(job, cloudOlder, MoneyScope.DENIED))
    }

    @Test
    fun `a job the crew door did not return sends no runs from a crew phone -- the real table's absence still does`() {
        val absent = emptyMap<String, Pair<Long, Boolean>>()
        assertFalse(mayPushJobRuns(job, absent, MoneyScope.DENIED))
        assertFalse(mayPushJobRuns(job, absent, MoneyScope.UNKNOWN))
        assertTrue(mayPushJobRuns(job, absent, MoneyScope.ALLOWED))
    }

    @Test
    fun `a failed read sends runs as it always did`() {
        for (scope in MoneyScope.values()) assertTrue(mayPushJobRuns(job, null, scope))
    }

    @Test
    fun `runs keep their own clock -- a newer job row never holds a redrawn run back`() {
        // mayPushJobChildren holds children back here; the runs must not be,
        // or the pull puts the cloud's older run over the new drawing.
        assertFalse(mayPushJobChildren(job, cloudNewer, MoneyScope.DENIED))
        assertTrue(mayPushJobRuns(job, cloudNewer, MoneyScope.DENIED))
        assertTrue(mayPushJobRuns(job, cloudNewer, MoneyScope.ALLOWED))
    }

    @Test
    fun `the fence-run push asks mayPushJobRuns, with the pass's own crew-door read`() {
        val source = File("src/main/java/com/fenceestimator/app/cloud/EntitySync.kt").readText()
        val start = source.indexOf("private suspend fun pushFenceRuns(")
        assertTrue(start >= 0)
        val body = source.substring(start, source.indexOf("pagedList<CloudFenceRun>", start))
        assertTrue("pushFenceRuns no longer filters jobs through mayPushJobRuns", body.contains("mayPushJobRuns(it, cloudTouchedAt, scope)"))
        assertTrue(
            "pushAll no longer hands the fence-run push the crew-door read",
            source.contains("pushFenceRuns(repository, companyId, scope, rows?.cloudTouchedAt)")
        )
    }

    @Test
    fun `shifts on a held job still go up -- a worked shift is always paid`() {
        val source = File("src/main/java/com/fenceestimator/app/cloud/EntitySync.kt").readText()
        val start = source.indexOf("private suspend fun pushTimeEntries(")
        val end = source.indexOf("private const val NEEDS_WORKER_DETAIL", start)
        assertTrue(start in 0 until end)
        assertFalse(
            "pushTimeEntries filters on accessEndedAt -- shifts on a job the person was taken off would never upload",
            source.substring(start, end).contains("accessEndedAt")
        )
    }

    // ---- isNotOursToSync ----

    @Test
    fun `a 42501 raised with its own sentence is a refusal, held back -- not a failed sync`() {
        // What crew_job_guard raises for a job the caller cannot see: 403, and
        // none of the words isNotOursToSync used to look for.
        assertTrue(isNotOursToSync(errors.of(403, "This job is not assigned to you.", rpc = "crew_save_job")))
        assertTrue(isNotOursToSync(RuntimeException("push failed", errors.of(403, "Not allowed to write jobs", rpc = "crew_save_job"))))
    }

    @Test
    fun `other failures are still failures`() {
        assertFalse(isNotOursToSync(errors.of(400, "invalid input syntax for type uuid", rpc = "crew_save_job")))
        assertFalse(isNotOursToSync(errors.of(500, "canceling statement due to statement timeout", rpc = "crew_save_job")))
        assertFalse(isNotOursToSync(errors.of(404, "Could not find the function public.crew_save_job(row_in) in the schema cache", rpc = "crew_save_job")))
    }
}
