package com.fenceestimator.app.ui.crew

import com.fenceestimator.app.data.FieldChange
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.TimeEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The crew half of notifications, built entirely from what a phone already
 * has on it -- see CrewAttention.kt's own doc comment for why this is a
 * closed list of four kinds rather than a filtered slice of the office's
 * fourteen. Every test here plants a case that WOULD show up if the scoping
 * were wrong, per the audit-blind-spot rule: a check that only ever tests
 * the true positives proves nothing about the false ones.
 */
class CrewAttentionTest {

    private val now = 1_700_000_000_000L
    private val day = 86_400_000L

    private fun job(
        id: Long = 1L,
        assignedEmployeeId: Long? = 9L,
        status: JobStatus = JobStatus.ACCEPTED,
        scheduledDate: Long? = null,
        locateExpiresAt: Long? = null,
        locateTicketNo: String = ""
    ) = Job(
        id = id,
        customerName = "Test Job $id",
        assignedEmployeeId = assignedEmployeeId,
        status = status,
        scheduledDate = scheduledDate,
        locateExpiresAt = locateExpiresAt,
        locateTicketNo = locateTicketNo
    )

    // ---- no identity: must not guess ----

    @Test
    fun `no employee id means no items, however loud the data is`() {
        val loudJob = job(scheduledDate = now, locateExpiresAt = now - day, locateTicketNo = "A1")
        val items = CrewAttention.build(
            myEmployeeId = null,
            myEmail = "me@crew.test",
            jobs = listOf(loudJob),
            timeEntries = listOf(TimeEntry(jobId = 1L, employeeId = 9L, rejectedAt = now)),
            fieldChanges = emptyList(),
            now = now
        )
        assertTrue(items.isEmpty())
    }

    // ---- job assigned today ----

    @Test
    fun `a job assigned to me today appears`() {
        val items = CrewAttention.build(
            myEmployeeId = 9L, myEmail = "",
            jobs = listOf(job(scheduledDate = now)),
            timeEntries = emptyList(), fieldChanges = emptyList(), now = now
        )
        assertEquals(1, items.size)
        assertEquals(CrewAttentionItem.Kind.JOB_TODAY, items.single().kind)
    }

    @Test
    fun `a job assigned to someone else does not appear -- canary for the scoping filter`() {
        val items = CrewAttention.build(
            myEmployeeId = 9L, myEmail = "",
            jobs = listOf(job(assignedEmployeeId = 42L, scheduledDate = now)),
            timeEntries = emptyList(), fieldChanges = emptyList(), now = now
        )
        assertTrue("a job assigned to a different employee must never appear", items.isEmpty())
    }

    @Test
    fun `a job scheduled tomorrow does not appear today`() {
        val items = CrewAttention.build(
            myEmployeeId = 9L, myEmail = "",
            jobs = listOf(job(scheduledDate = now + day)),
            timeEntries = emptyList(), fieldChanges = emptyList(), now = now
        )
        assertTrue(items.isEmpty())
    }

    @Test
    fun `a completed job scheduled today does not appear -- nothing left to do`() {
        val items = CrewAttention.build(
            myEmployeeId = 9L, myEmail = "",
            jobs = listOf(job(scheduledDate = now, status = JobStatus.COMPLETED)),
            timeEntries = emptyList(), fieldChanges = emptyList(), now = now
        )
        assertTrue(items.isEmpty())
    }

    // ---- 811 locate expired ----

    @Test
    fun `an expired locate on my job appears`() {
        val items = CrewAttention.build(
            myEmployeeId = 9L, myEmail = "",
            jobs = listOf(job(locateTicketNo = "A1", locateExpiresAt = now - day)),
            timeEntries = emptyList(), fieldChanges = emptyList(), now = now
        )
        assertEquals(1, items.size)
        assertEquals(CrewAttentionItem.Kind.LOCATE_EXPIRED, items.single().kind)
    }

    @Test
    fun `a locate that has not expired yet does not appear`() {
        val items = CrewAttention.build(
            myEmployeeId = 9L, myEmail = "",
            jobs = listOf(job(locateTicketNo = "A1", locateExpiresAt = now + day)),
            timeEntries = emptyList(), fieldChanges = emptyList(), now = now
        )
        assertTrue(items.isEmpty())
    }

    @Test
    fun `no ticket at all is not treated as expired`() {
        val items = CrewAttention.build(
            myEmployeeId = 9L, myEmail = "",
            jobs = listOf(job(locateTicketNo = "", locateExpiresAt = null)),
            timeEntries = emptyList(), fieldChanges = emptyList(), now = now
        )
        assertTrue(items.isEmpty())
    }

    // ---- shift sent back ----

    @Test
    fun `a shift of mine sent back appears, carrying the office's reason`() {
        val items = CrewAttention.build(
            myEmployeeId = 9L, myEmail = "",
            jobs = listOf(job()),
            timeEntries = listOf(
                TimeEntry(jobId = 1L, employeeId = 9L, rejectedAt = now, reviewNote = "Forgot to clock out")
            ),
            fieldChanges = emptyList(), now = now
        )
        assertEquals(1, items.size)
        assertEquals(CrewAttentionItem.Kind.SHIFT_SENT_BACK, items.single().kind)
        assertEquals("Forgot to clock out", items.single().detail)
    }

    @Test
    fun `a shift sent back for someone else does not appear -- canary for the employee filter`() {
        val items = CrewAttention.build(
            myEmployeeId = 9L, myEmail = "",
            jobs = listOf(job()),
            timeEntries = listOf(TimeEntry(jobId = 1L, employeeId = 42L, rejectedAt = now)),
            fieldChanges = emptyList(), now = now
        )
        assertTrue(items.isEmpty())
    }

    @Test
    fun `an approved shift is not a sent-back shift`() {
        val items = CrewAttention.build(
            myEmployeeId = 9L, myEmail = "",
            jobs = listOf(job()),
            timeEntries = listOf(TimeEntry(jobId = 1L, employeeId = 9L, approvedAt = now)),
            fieldChanges = emptyList(), now = now
        )
        assertTrue(items.isEmpty())
    }

    // ---- plan change answered ----

    @Test
    fun `my approved plan change appears with approved true`() {
        val items = CrewAttention.build(
            myEmployeeId = 9L, myEmail = "me@crew.test",
            jobs = listOf(job()),
            timeEntries = emptyList(),
            fieldChanges = listOf(
                FieldChange(
                    jobId = 1L, isRequest = true, changedBy = "me@crew.test",
                    approvedAt = now, decisionNote = "Go ahead"
                )
            ),
            now = now
        )
        assertEquals(1, items.size)
        val item = items.single()
        assertEquals(CrewAttentionItem.Kind.PLAN_CHANGE_ANSWERED, item.kind)
        assertEquals(true, item.approved)
        assertEquals("Go ahead", item.detail)
    }

    @Test
    fun `email match is case-insensitive, since a login and a typed request may differ in case`() {
        val items = CrewAttention.build(
            myEmployeeId = 9L, myEmail = "Me@Crew.Test",
            jobs = listOf(job()),
            timeEntries = emptyList(),
            fieldChanges = listOf(
                FieldChange(jobId = 1L, isRequest = true, changedBy = "me@crew.test", rejectedAt = now)
            ),
            now = now
        )
        assertEquals(1, items.size)
        assertEquals(false, items.single().approved)
    }

    @Test
    fun `someone else's plan change does not appear -- canary for the changedBy filter`() {
        val items = CrewAttention.build(
            myEmployeeId = 9L, myEmail = "me@crew.test",
            jobs = listOf(job()),
            timeEntries = emptyList(),
            fieldChanges = listOf(
                FieldChange(jobId = 1L, isRequest = true, changedBy = "someone.else@crew.test", approvedAt = now)
            ),
            now = now
        )
        assertTrue(items.isEmpty())
    }

    @Test
    fun `a report is not a request and never appears here, answered or not`() {
        val items = CrewAttention.build(
            myEmployeeId = 9L, myEmail = "me@crew.test",
            jobs = listOf(job()),
            timeEntries = emptyList(),
            fieldChanges = listOf(
                FieldChange(jobId = 1L, isRequest = false, changedBy = "me@crew.test", acknowledgedAt = now)
            ),
            now = now
        )
        assertTrue(items.isEmpty())
    }

    @Test
    fun `a request still waiting on an answer does not appear -- nothing to tell them yet`() {
        val items = CrewAttention.build(
            myEmployeeId = 9L, myEmail = "me@crew.test",
            jobs = listOf(job()),
            timeEntries = emptyList(),
            fieldChanges = listOf(
                FieldChange(jobId = 1L, isRequest = true, changedBy = "me@crew.test")
            ),
            now = now
        )
        assertTrue(items.isEmpty())
    }

    // ---- keys change when the underlying fact changes ----

    @Test
    fun `a second rejection of the same shift produces a different key than the first`() {
        fun keyFor(rejectedAt: Long) = CrewAttention.build(
            myEmployeeId = 9L, myEmail = "",
            jobs = listOf(job()),
            timeEntries = listOf(TimeEntry(syncId = "s1", jobId = 1L, employeeId = 9L, rejectedAt = rejectedAt)),
            fieldChanges = emptyList(), now = now
        ).single().key

        val firstKey = keyFor(now)
        val secondKey = keyFor(now + day)
        assertTrue(
            "a dismissal of the first rejection must not silently cover a later, different one",
            firstKey != secondKey
        )
    }
}
