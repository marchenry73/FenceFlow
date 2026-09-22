package com.fenceestimator.app.ui.crew

import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.TimeEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * A shift sent back, or its hours corrected, is about the person's pay --
 * whichever job it was worked on. The card used to need the job to still be
 * theirs, so someone moved off a job as lead, or taken off it altogether
 * (kept on the phone, Job.accessEndedAt), was never told the office had sent
 * back the day they worked there. The job-shaped items (today's job, a lapsed
 * locate, a plan change answered) keep the job boundary: those are about the
 * work, and the work is no longer theirs.
 */
class CrewOwnShiftsTest {

    private val now = 1_758_500_000_000L
    private val me = 9L

    /** Job 1 is mine. Job 2 was mine, and is now someone else's (or kept after I was taken off). */
    private val mine = Job(id = 1L, customerName = "Mine", assignedEmployeeId = me, status = JobStatus.ACCEPTED)
    private val taken = Job(
        id = 2L, customerName = "Taken off", assignedEmployeeId = 42L, status = JobStatus.ACCEPTED,
        scheduledDate = now, locateTicketNo = "T1", locateExpiresAt = now - 86_400_000L, accessEndedAt = now - 1_000L
    )

    private fun build(shifts: List<TimeEntry>) = CrewAttention.build(
        myEmployeeId = me, myEmail = "", jobs = listOf(mine, taken), timeEntries = shifts,
        fieldChanges = emptyList(), now = now
    )

    @Test
    fun `my shift sent back on a job I was taken off still reaches me`() {
        val items = build(listOf(TimeEntry(syncId = "s1", jobId = 2L, employeeId = me, rejectedAt = now, reviewNote = "No clock-out")))
        assertEquals(listOf(CrewAttentionItem.Kind.SHIFT_SENT_BACK), items.map { it.kind })
        assertEquals(2L, items.single().jobId)
        assertEquals("No clock-out", items.single().detail)
    }

    @Test
    fun `my hours corrected on a job I was taken off still reach me, with the shift id to answer it`() {
        val items = build(listOf(TimeEntry(syncId = "s2", jobId = 2L, employeeId = me, correctedAt = now, correctionReason = "Lunch")))
        assertEquals(listOf(CrewAttentionItem.Kind.HOURS_CORRECTED), items.map { it.kind })
        assertEquals("s2", items.single().shiftSyncId)
    }

    @Test
    fun `someone else's answered shift on that job is still none of mine -- canary for the employee filter`() {
        val items = build(listOf(
            TimeEntry(syncId = "o1", jobId = 2L, employeeId = 42L, rejectedAt = now),
            TimeEntry(syncId = "o2", jobId = 2L, employeeId = 42L, correctedAt = now)
        ))
        assertTrue(items.isEmpty())
    }

    @Test
    fun `the work on a job I was taken off still says nothing -- no locate, no today`() {
        // taken is scheduled today with an expired locate: loud, and not mine.
        val items = build(emptyList())
        assertFalse(items.any { it.jobId == 2L })
    }

    @Test
    fun `the view model reads my answered shifts from every job, and names kept jobs`() {
        val vm = File("src/main/java/com/fenceestimator/app/ui/crew/CrewAttentionViewModel.kt").readText()
        assertTrue("own answered shifts are no longer read", vm.contains("repository.observeReviewedShifts("))
        assertTrue("items on a kept job lose their name", vm.contains("repository.observeHeldJobs()"))
        val daos = File("src/main/java/com/fenceestimator/app/data/Daos.kt").readText()
        val q = daos.substring(daos.indexOf("fun observeRunning()"), daos.indexOf("fun observeReviewedForEmployee("))
        assertTrue("the query is not by person", q.contains("WHERE employeeId = :employeeId"))
        assertFalse("the query is narrowed to one job", q.contains("jobId"))
    }

    @Test
    fun `the home list shows the crew card whenever it has something, not only when a job is listed`() {
        val src = File("src/main/java/com/fenceestimator/app/ui/jobs/JobsListScreen.kt").readText()
        assertTrue(src.contains("if (isCrewRole && (jobs.isNotEmpty() || crewAttentionItems.isNotEmpty()))"))
    }
}
