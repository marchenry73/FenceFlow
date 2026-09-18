package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.TimeEntry
import io.github.jan.supabase.exceptions.RestException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The two pure classifiers behind the time-entries sync fix: which shifts
 * the server will never accept (known locally, no network needed), and
 * which server refusals are permanent rather than a network blip.
 */
class TimeEntrySyncRejectionTest {

    private fun shift(employeeId: Long? = null, endedAt: Long? = 1_000L) = TimeEntry(
        jobId = 1L,
        employeeId = employeeId,
        startedAt = 0L,
        endedAt = endedAt
    )

    @Test
    fun `a finished shift with no employee needs a worker`() {
        assertTrue(needsWorkerAssignment(shift(employeeId = null)))
    }

    @Test
    fun `a finished shift with an employee does not`() {
        assertFalse(needsWorkerAssignment(shift(employeeId = 7L)))
    }

    // Planted-failure case: a RUNNING shift with no employee must not be
    // flagged. pushTimeEntries never sends running shifts at all, so
    // flagging one here would tag a clock-in nobody has finished yet as
    // broken before it ever could be.
    @Test
    fun `a running shift with no employee is not flagged`() {
        assertFalse(needsWorkerAssignment(shift(employeeId = null, endedAt = null)))
    }

    private fun restError(statusCode: Int, message: String = "boom") =
        RestException(message, "description", statusCode, message)

    @Test
    fun `a 400 is permanent`() {
        assertTrue(isPermanentRejection(restError(400)))
    }

    @Test
    fun `a 404 is permanent`() {
        assertTrue(isPermanentRejection(restError(404)))
    }

    @Test
    fun `a 401 is not permanent -- signing in again can fix it`() {
        assertFalse(isPermanentRejection(restError(401)))
    }

    @Test
    fun `a 403 is not permanent either`() {
        assertFalse(isPermanentRejection(restError(403)))
    }

    // Planted-failure case: a 5xx must never be treated as permanent, or one
    // flaky server response would tattoo a good row as broken forever.
    @Test
    fun `a 500 is not permanent`() {
        assertFalse(isPermanentRejection(restError(500)))
    }

    @Test
    fun `a plain IO failure with no HTTP status is not permanent`() {
        assertFalse(isPermanentRejection(java.io.IOException("unable to resolve host")))
    }

    @Test
    fun `a wrapped rest exception is still found through the cause chain`() {
        val wrapped = RuntimeException("push time_entries failed", restError(400))
        assertTrue(isPermanentRejection(wrapped))
    }

    @Test
    fun `the server's own message survives for display`() {
        val error = restError(400, message = "This shift is not linked to a crew member.")
        assertEquals("This shift is not linked to a crew member.", permanentRejectionDetail(error))
    }

    @Test
    fun `no detail for a non-permanent error`() {
        assertNull(permanentRejectionDetail(restError(500)))
    }
}
