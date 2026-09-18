package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.Employee
import com.fenceestimator.app.data.TimeEntry
import io.github.jan.supabase.exceptions.RestException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pure classifiers behind the time-entries sync fix: which shifts the
 * server will never accept (known locally, no network needed), which server
 * refusals are permanent rather than a network blip, what the push path does
 * with one, and who the Fix picker may offer.
 */
class TimeEntrySyncRejectionTest {

    private fun shift(employeeId: Long? = null, endedAt: Long? = 1_000L) = TimeEntry(
        jobId = 1L,
        employeeId = employeeId,
        startedAt = 0L,
        endedAt = endedAt
    )

    /** The employees this phone holds, by local id, with their cloud sync ids. */
    private val crew = mapOf(3L to "3b1e0c2a-cloud-id")

    // ---- what will actually be sent ----

    @Test
    fun `a finished shift with no employee needs a worker`() {
        val entry = shift(employeeId = null)
        assertNull(resolveEmployeeSyncId(entry, crew))
        assertTrue(needsWorkerAssignment(entry, resolveEmployeeSyncId(entry, crew)))
    }

    /**
     * The case that failed on every sync for a week. The shift HAS an
     * employeeId, so the old `employeeId == null` test let it through; but
     * that employee is not on this phone, so it resolved to nothing, went up
     * as employee_sync_id "" and was refused with the same sentence every
     * time.
     */
    @Test
    fun `a finished shift whose employee this phone no longer holds needs a worker`() {
        val entry = shift(employeeId = 7L)
        assertNotNull("the fixture must carry an employeeId, or it only re-tests the old rule", entry.employeeId)
        assertNull(resolveEmployeeSyncId(entry, crew))
        assertTrue(needsWorkerAssignment(entry, resolveEmployeeSyncId(entry, crew)))
    }

    @Test
    fun `an employee whose own sync id is blank counts as nobody`() {
        val entry = shift(employeeId = 7L)
        val blank = mapOf(7L to "  ")
        assertNull(resolveEmployeeSyncId(entry, blank))
        assertTrue(needsWorkerAssignment(entry, resolveEmployeeSyncId(entry, blank)))
    }

    @Test
    fun `a finished shift with an employee the cloud can be told about does not`() {
        val entry = shift(employeeId = 3L)
        assertEquals("3b1e0c2a-cloud-id", resolveEmployeeSyncId(entry, crew))
        assertFalse(needsWorkerAssignment(entry, resolveEmployeeSyncId(entry, crew)))
    }

    // Planted-failure case: a RUNNING shift must not be flagged, resolved or
    // not. pushTimeEntries never sends running shifts at all, so flagging one
    // here would tag a clock-in nobody has finished yet as broken before it
    // ever could be.
    @Test
    fun `a running shift is never flagged`() {
        assertFalse(needsWorkerAssignment(shift(employeeId = null, endedAt = null), null))
        assertFalse(needsWorkerAssignment(shift(employeeId = 7L, endedAt = null), null))
    }

    // ---- who the Fix picker may offer ----

    @Test
    fun `an employee with a sync id can be picked`() {
        assertTrue(canBeSentAsWorker(Employee(name = "Ana")))
    }

    // Planted-failure case: a blank sync id is exactly the value the server
    // refuses, so offering this person would put the shift straight back.
    @Test
    fun `an employee with a blank sync id cannot`() {
        assertFalse(canBeSentAsWorker(Employee(name = "Ghost", syncId = "")))
        assertFalse(canBeSentAsWorker(Employee(name = "Ghost", syncId = "   ")))
    }

    // ---- permanent or not ----

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

    // ---- the push path's decision ----

    @Test
    fun `a permanent refusal becomes a block carrying the server's sentence`() {
        val decision = classifyRowRejection(restError(400, "That crew member is not on this company."))
        assertTrue(decision is RowRejection.Permanent)
        assertEquals("That crew member is not on this company.", (decision as RowRejection.Permanent).detail)
    }

    // Planted-failure cases: the two kinds of error that must stay retries,
    // and be counted, or a dropped socket would silently strand a good shift.
    @Test
    fun `a 500 stays a retry`() {
        assertTrue(classifyRowRejection(restError(500)) is RowRejection.Retry)
    }

    @Test
    fun `an IO failure stays a retry, cause intact`() {
        val cause = java.io.IOException("unable to resolve host")
        val decision = classifyRowRejection(cause)
        assertTrue(decision is RowRejection.Retry)
        assertTrue((decision as RowRejection.Retry).cause === cause)
    }
}
