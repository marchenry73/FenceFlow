package com.fenceestimator.app.ui.crew

import com.fenceestimator.app.cloud.JobScope
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Extra crew and people let in on a request are on a job without being its
 * lead, so the lead column alone never told them their job was today or its
 * locate had lapsed. Once the server scopes a crew phone to its own jobs,
 * every job it sent counts as theirs (CrewAttention.jobsMineByScope) -- but
 * only when that can be trusted, or one phone would be told about the whole
 * yard.
 */
class CrewAttentionScopeTest {

    private val now = 1_758_500_000_000L
    private val synced = now - 1_000L

    private fun job(id: Long, lead: Long? = 42L, lastSyncedAt: Long? = synced) = Job(
        id = id, customerName = "Job $id", assignedEmployeeId = lead,
        status = JobStatus.ACCEPTED, scheduledDate = now, lastSyncedAt = lastSyncedAt
    )

    private val scoped = JobScope.Scoped(linked = true, visible = 2, pendingRequests = 0)

    @Test
    fun `a scoped crew member's phone counts every job the server sent as theirs`() {
        val jobs = listOf(job(1), job(2))
        assertEquals(setOf(1L, 2L), CrewAttention.jobsMineByScope(scoped, jobs))
    }

    @Test
    fun `extra crew hear that their job is today -- the lead test alone said nothing`() {
        val jobs = listOf(job(1, lead = 42L))
        val leadOnly = CrewAttention.build(9L, "", jobs, emptyList(), emptyList(), now = now)
        assertTrue("planted failure: the lead test alone finds nothing", leadOnly.isEmpty())
        val withScope = CrewAttention.build(
            9L, "", jobs, emptyList(), emptyList(), now = now,
            alsoMine = CrewAttention.jobsMineByScope(JobScope.Scoped(true, 1, 0), jobs)
        )
        assertEquals(CrewAttentionItem.Kind.JOB_TODAY, withScope.single().kind)
    }

    @Test
    fun `no scope, or a server without it, stays on the lead test`() {
        val jobs = listOf(job(1), job(2))
        listOf(JobScope.Unknown, JobScope.NotDeployed, JobScope.SeesAll).forEach {
            assertTrue("$it", CrewAttention.jobsMineByScope(it, jobs).isEmpty())
        }
    }

    @Test
    fun `a login with no crew record is on nothing`() {
        val jobs = listOf(job(1))
        assertTrue(CrewAttention.jobsMineByScope(JobScope.Scoped(linked = false, visible = 0, pendingRequests = 0), jobs).isEmpty())
        // Even with a count that would otherwise vouch for the phone: an
        // unlinked answer is never read as "every job here is theirs".
        assertTrue(CrewAttention.jobsMineByScope(JobScope.Scoped(linked = false, visible = 5, pendingRequests = 0), jobs).isEmpty())
    }

    @Test
    fun `more jobs on the phone than the server says -- the hiding has not happened, trust nothing`() {
        // The whole company still on the phone: three jobs, the server says two.
        val jobs = listOf(job(1), job(2), job(3))
        assertTrue(CrewAttention.jobsMineByScope(scoped, jobs).isEmpty())
    }

    @Test
    fun `a job made here and never sent is not the server's to vouch for`() {
        val jobs = listOf(job(1), job(2, lastSyncedAt = null))
        assertEquals(setOf(1L), CrewAttention.jobsMineByScope(scoped, jobs))
    }
}
