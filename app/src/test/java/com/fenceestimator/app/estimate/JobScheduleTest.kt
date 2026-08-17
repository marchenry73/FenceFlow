package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar

/**
 * A crew needs to know whether they are finishing tonight or coming back.
 *
 * "Eighteen estimated hours" does not answer that. "Day two of three" does, and
 * it is what decides whether they start hanging gates, whether the customer
 * gets a phone call, and whether the next customer's date is still good.
 */
class JobScheduleTest {

    private val workday = 8.0

    private fun day(year: Int, month: Int, dayOfMonth: Int): Long =
        Calendar.getInstance().apply {
            set(year, month - 1, dayOfMonth, 9, 0, 0)
            set(Calendar.MILLISECOND, 0)
        }.timeInMillis

    private fun job(hours: Double, start: Long?, status: JobStatus = JobStatus.ACCEPTED) = Job(
        customerName = "Test",
        estimatedDurationHours = hours,
        scheduledDate = start,
        status = status
    )

    @Test
    fun `a short job is one day`() {
        val plan = JobSchedule.plan(job(6.0, day(2026, 8, 20)), workday, day(2026, 8, 20))
        assertEquals(1, plan.totalDays)
        assertTrue(plan.isFinalDay)
        assertTrue(plan.crewSummary.contains("finish today"))
    }

    @Test
    fun `half a day over still costs a whole day`() {
        // Nine hours is two days on site, because the crew have to turn up for
        // the second one whether it is an hour or eight.
        assertEquals(2, JobSchedule.plan(job(9.0, day(2026, 8, 20)), workday).totalDays)
    }

    @Test
    fun `the middle of a job says it will not finish today`() {
        val plan = JobSchedule.plan(job(24.0, day(2026, 8, 20)), workday, day(2026, 8, 21))
        assertEquals(3, plan.totalDays)
        assertEquals(2, plan.dayNumber)
        assertFalse(plan.isFinalDay)
        assertTrue(plan.crewSummary.contains("not expected to finish today"))
    }

    @Test
    fun `the last day says so`() {
        val plan = JobSchedule.plan(job(24.0, day(2026, 8, 20)), workday, day(2026, 8, 22))
        assertEquals(3, plan.dayNumber)
        assertTrue(plan.isFinalDay)
        assertTrue(plan.crewSummary.contains("expected to finish today"))
    }

    @Test
    fun `an unscheduled job has no day number`() {
        val plan = JobSchedule.plan(job(24.0, null), workday)
        assertEquals(0, plan.dayNumber)
        assertNull(plan.expectedFinish)
    }

    // ---- running over ----

    @Test
    fun `a job is not overrunning on its final day`() {
        assertFalse(JobSchedule.hasOverrun(job(24.0, day(2026, 8, 20)), workday, day(2026, 8, 22)))
    }

    @Test
    fun `a job past its finish date is overrunning`() {
        assertTrue(JobSchedule.hasOverrun(job(24.0, day(2026, 8, 20)), workday, day(2026, 8, 23)))
        assertEquals(1, JobSchedule.daysOverrun(job(24.0, day(2026, 8, 20)), workday, day(2026, 8, 23)))
    }

    @Test
    fun `a finished job is never overrunning`() {
        // It ran late, but it is done -- nothing downstream is waiting on it.
        val done = job(24.0, day(2026, 8, 20), JobStatus.COMPLETED)
        assertFalse(JobSchedule.hasOverrun(done, workday, day(2026, 8, 30)))
    }

    // ---- who gets pushed ----

    @Test
    fun `the next scheduled job is the one affected`() {
        val running = job(24.0, day(2026, 8, 20))
        val all = listOf(
            running,
            job(8.0, day(2026, 8, 25)).copy(id = 2, customerName = "Later"),
            job(8.0, day(2026, 8, 23)).copy(id = 3, customerName = "Next")
        )
        val next = JobSchedule.nextAffected(running, all, workday)
        assertEquals("Next", next?.customerName)
    }

    @Test
    fun `a job scheduled before this one is not downstream of it`() {
        val running = job(24.0, day(2026, 8, 20))
        val all = listOf(running, job(8.0, day(2026, 8, 18)).copy(id = 2, customerName = "Earlier"))
        assertNull(JobSchedule.nextAffected(running, all, workday))
    }

    @Test
    fun `an already finished job cannot be pushed`() {
        val running = job(24.0, day(2026, 8, 20))
        val all = listOf(
            running,
            job(8.0, day(2026, 8, 23), JobStatus.COMPLETED).copy(id = 2, customerName = "Done"),
            job(8.0, day(2026, 8, 24)).copy(id = 3, customerName = "Real next")
        )
        assertEquals("Real next", JobSchedule.nextAffected(running, all, workday)?.customerName)
    }
}
