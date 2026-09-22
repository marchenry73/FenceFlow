package com.fenceestimator.app.ui.jobs

import com.fenceestimator.app.cloud.AccessRequestStatus
import com.fenceestimator.app.cloud.AssignmentKind
import com.fenceestimator.app.cloud.JobAccessRequest
import com.fenceestimator.app.cloud.JobAssignment
import com.fenceestimator.app.cloud.JobScope
import com.fenceestimator.app.cloud.RequestableJob
import com.fenceestimator.app.data.Employee
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The on-screen half of "crew see the jobs they are on, and ask for the
 * rest" (JobScopeUi.kt). The rule every screen starts from: only a definite
 * Scoped answer changes anything, so a phone on a server without
 * supabase_crew_job_scope.sql -- or one that has not asked yet -- shows the
 * job list exactly as it always has.
 */
class JobScopeUiTest {

    // ---- the job list --------------------------------------------------

    @Test
    fun `no scope answer changes nothing -- no notice, no request row`() {
        listOf(JobScope.Unknown, JobScope.NotDeployed, JobScope.SeesAll).forEach { scope ->
            val home = scopedHome(scope, visibleJobs = 0, keptJobs = 0)
            assertEquals("$scope", ScopedNotice.NONE, home.notice)
            assertFalse("$scope", home.offerRequestAccess)
            assertFalse("$scope", home.showKept)
        }
    }

    @Test
    fun `a scoped, linked crew member with jobs gets the request row and no notice`() {
        val home = scopedHome(JobScope.Scoped(linked = true, visible = 3, pendingRequests = 0), visibleJobs = 3, keptJobs = 0)
        assertEquals(ScopedNotice.NONE, home.notice)
        assertTrue(home.offerRequestAccess)
    }

    @Test
    fun `not linked says so in words and offers no asking -- the server would refuse it`() {
        val home = scopedHome(JobScope.Scoped(linked = false, visible = 0, pendingRequests = 0), visibleJobs = 0, keptJobs = 0)
        assertEquals(ScopedNotice.NOT_LINKED, home.notice)
        assertFalse(home.offerRequestAccess)
    }

    @Test
    fun `not linked is said even while the phone still shows jobs`() {
        // Before the sync that hides them, the list is not the answer.
        val home = scopedHome(JobScope.Scoped(linked = false, visible = 0, pendingRequests = 0), visibleJobs = 5, keptJobs = 0)
        assertEquals(ScopedNotice.NOT_LINKED, home.notice)
    }

    @Test
    fun `linked with nothing on the server is none assigned, with work not yet here it is on the way`() {
        val none = scopedHome(JobScope.Scoped(linked = true, visible = 0, pendingRequests = 0), visibleJobs = 0, keptJobs = 0)
        assertEquals(ScopedNotice.NONE_ASSIGNED, none.notice)
        // Planted failure: the same empty phone, but the server says two.
        val coming = scopedHome(JobScope.Scoped(linked = true, visible = 2, pendingRequests = 0), visibleJobs = 0, keptJobs = 0)
        assertEquals(ScopedNotice.ON_THE_WAY, coming.notice)
    }

    @Test
    fun `kept jobs always show, whatever the scope says now`() {
        assertTrue(scopedHome(JobScope.Unknown, visibleJobs = 0, keptJobs = 1).showKept)
        assertTrue(scopedHome(JobScope.Scoped(true, 1, 0), visibleJobs = 1, keptJobs = 2).showKept)
        assertFalse(scopedHome(JobScope.Scoped(true, 1, 0), visibleJobs = 1, keptJobs = 0).showKept)
    }

    // ---- the request list ----------------------------------------------

    private fun request(
        id: String = "r1",
        job: String = "j1",
        status: AccessRequestStatus = AccessRequestStatus.PENDING,
        note: String = ""
    ) = JobAccessRequest(
        id = id, jobSyncId = job, requestedBy = "me", employeeSyncId = "e1", reason = "",
        status = status, createdAt = 1L, decidedBy = null, decidedAt = null, decisionNote = note
    )

    private fun requestable(
        job: String = "j1",
        name: String = "Hernandez",
        address: String = "12 Oak St",
        status: AccessRequestStatus? = null,
        mine: JobAccessRequest? = null
    ) = RequestableJob(
        jobSyncId = job, customerName = name, address = address, scheduledDate = null,
        status = "ACCEPTED", productionStage = null, myRequestStatus = status, myRequestAt = null, myRequest = mine
    )

    @Test
    fun `never asked -- the button, no chip`() {
        val row = requestRowOf(requestable())
        assertTrue(row.canAsk)
        assertNull(row.chip)
        assertNull(row.withdrawId)
    }

    @Test
    fun `waiting -- the chip, no second ask, and Withdraw with the request's id`() {
        val row = requestRowOf(requestable(status = AccessRequestStatus.PENDING, mine = request(id = "r9")))
        assertEquals(AccessRequestStatus.PENDING, row.chip)
        assertFalse(row.canAsk)
        assertEquals("r9", row.withdrawId)
    }

    @Test
    fun `waiting but the request itself could not be read -- no Withdraw that would fail`() {
        val row = requestRowOf(requestable(status = AccessRequestStatus.PENDING, mine = null))
        assertFalse(row.canAsk)
        assertNull(row.withdrawId)
    }

    @Test
    fun `declined -- the chip, the office's note, and ask again`() {
        val row = requestRowOf(
            requestable(status = AccessRequestStatus.DENIED, mine = request(status = AccessRequestStatus.DENIED, note = " Full crew already "))
        )
        assertEquals(AccessRequestStatus.DENIED, row.chip)
        assertEquals("Full crew already", row.note)
        assertTrue(row.canAsk)
    }

    @Test
    fun `an old decline's note never sits beside a newer waiting ask -- planted failure`() {
        // The list says PENDING (the newest ask); the full request read in a
        // second query is still the old DENIED one.
        val stale = request(id = "old", status = AccessRequestStatus.DENIED, note = "No")
        val row = requestRowOf(requestable(status = AccessRequestStatus.PENDING, mine = stale))
        assertEquals("", row.note)
        assertNull("a withdraw aimed at a decided request", row.withdrawId)
    }

    @Test
    fun `a request for another job never supplies this row's id`() {
        val row = requestRowOf(requestable(job = "j1", status = AccessRequestStatus.PENDING, mine = request(job = "j2")))
        assertNull(row.withdrawId)
    }

    @Test
    fun `let in once and since taken off, or withdrawn -- ask afresh, no chip`() {
        listOf(AccessRequestStatus.APPROVED, AccessRequestStatus.WITHDRAWN).forEach { s ->
            val row = requestRowOf(requestable(status = s, mine = request(status = s)))
            assertTrue("$s", row.canAsk)
            assertNull("$s", row.chip)
        }
    }

    @Test
    fun `search matches a name or a street, ignoring case and spaces`() {
        val rows = listOf(
            requestable(job = "a", name = "Hernandez", address = "12 Oak St"),
            requestable(job = "b", name = "Woody", address = "4 Pine Ave")
        )
        assertEquals(listOf("a"), filterRequestable(rows, "  hern ").map { it.jobSyncId })
        assertEquals(listOf("b"), filterRequestable(rows, "PINE").map { it.jobSyncId })
        assertEquals(2, filterRequestable(rows, "   ").size)
        assertTrue(filterRequestable(rows, "Maple").isEmpty())
    }

    // ---- "Also on this job" --------------------------------------------

    private fun assignment(
        id: String, emp: String, kind: AssignmentKind = AssignmentKind.CREW, at: Long = 1L, ended: Long? = null
    ) = JobAssignment(id = id, jobSyncId = "j1", employeeSyncId = emp, kind = kind, assignedBy = null, assignedAt = at, endedAt = ended)

    @Test
    fun `adding someone sends everyone already on the crew list too -- set_job_crew replaces it`() {
        val current = listOf(assignment("a1", "ana"), assignment("a2", "ben"))
        assertEquals(setOf("ana", "ben", "cy"), crewAfterAdding(current, "cy").toSet())
    }

    @Test
    fun `sending only the new person would end the others -- planted failure`() {
        val current = listOf(assignment("a1", "ana"), assignment("a2", "ben"))
        val sent = crewAfterAdding(current, "cy")
        assertTrue("ana would be taken off", "ana" in sent)
        assertTrue("ben would be taken off", "ben" in sent)
    }

    @Test
    fun `ended rows and access grants are not the crew list's to carry`() {
        val current = listOf(
            assignment("a1", "ana"),
            assignment("a2", "gone", ended = 5L),
            assignment("a3", "guest", kind = AssignmentKind.ACCESS)
        )
        assertEquals(listOf("ana", "cy"), crewAfterAdding(current, "cy"))
    }

    @Test
    fun `adding someone already there sends them once`() {
        assertEquals(listOf("ana"), crewAfterAdding(listOf(assignment("a1", "ana")), "ana"))
    }

    @Test
    fun `also on this job leaves out the lead, the ended, and repeats, oldest first`() {
        val rows = listOf(
            assignment("a1", "lead", at = 1L),
            assignment("a2", "ben", at = 30L),
            assignment("a3", "ana", kind = AssignmentKind.ACCESS, at = 20L),
            assignment("a4", "gone", at = 10L, ended = 11L),
            assignment("a5", "ben", kind = AssignmentKind.ACCESS, at = 40L)
        )
        assertEquals(listOf("ana", "ben"), extraCrewOf(rows, leadSyncId = "lead").map { it.employeeSyncId })
    }

    @Test
    fun `who can be added -- active, synced, not the lead, not already on it`() {
        val employees = listOf(
            Employee(id = 1, syncId = "lead", name = "Lead"),
            Employee(id = 2, syncId = "ana", name = "ana"),
            Employee(id = 3, syncId = "ben", name = "Ben"),
            Employee(id = 4, syncId = "old", name = "Old", isActive = false),
            Employee(id = 5, syncId = "", name = "No id"),
            Employee(id = 6, syncId = "cy", name = "Cy")
        )
        val onIt = listOf(assignment("a1", "ben"), assignment("a2", "cy", ended = 9L))
        assertEquals(listOf("ana", "cy"), addableCrew(employees, leadEmployeeId = 1, assignments = onIt).map { it.syncId })
    }
}
