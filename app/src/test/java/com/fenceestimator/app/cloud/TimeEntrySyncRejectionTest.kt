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

    /**
     * Was `a 404 is permanent`, and that was the bug. PostgREST 404s a write
     * only when the TABLE is missing -- PGRST205 while the schema cache
     * catches up with a migration -- and that marked every shift pushed in
     * the window as rejected, with Discard beside each.
     */
    @Test
    fun `a 404 is a retry -- the table is missing, not the row wrong`() {
        assertFalse(isPermanentRejection(restError(404)))
    }

    @Test
    fun `a 429 rate limit is a retry`() {
        assertFalse(isPermanentRejection(restError(429)))
        assertTrue(classifyRowRejection(restError(429)) is RowRejection.Retry)
    }

    @Test
    fun `a 408 timeout and a 425 too-early are retries`() {
        assertFalse(isPermanentRejection(restError(408)))
        assertFalse(isPermanentRejection(restError(425)))
    }

    // Planted-failure cases: narrowing must not have turned into "no 4xx is
    // ever permanent". These are the statuses a refused ROW actually arrives
    // as (23502/23514/P0001 -> 400, 23503/23505 -> 409), and they must still
    // mark the shift -- the expiry below is what makes a wrong guess cheap.
    @Test
    fun `a 409 and a 422 are still permanent`() {
        assertTrue(isPermanentRejection(restError(409)))
        assertTrue(isPermanentRejection(restError(422)))
    }

    @Test
    fun `no detail is offered for a 429 either`() {
        assertNull(permanentRejectionDetail(restError(429, "rate limit exceeded")))
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

    // ---- a SERVER_REJECTED mark expires ----

    private val hour = 60 * 60 * 1000L
    private val now = 1_800_000_000_000L

    private fun marked(reason: TimeEntrySyncBlock, at: Long?, detail: String = "refused") =
        shift(employeeId = 3L).copy(syncBlockedReason = reason.name, syncBlockedAt = at, syncBlockedDetail = detail)

    @Test
    fun `an unmarked shift is always due`() {
        assertTrue(isDueForPush(shift(employeeId = 3L), now))
    }

    @Test
    fun `a fresh SERVER_REJECTED mark holds the shift back`() {
        assertFalse(isDueForPush(marked(TimeEntrySyncBlock.SERVER_REJECTED, now - hour), now))
    }

    @Test
    fun `the mark expires at the window, not a millisecond before`() {
        val window = SERVER_REJECTED_RETRY_AFTER_MS
        assertFalse(isDueForPush(marked(TimeEntrySyncBlock.SERVER_REJECTED, now - window + 1), now))
        assertTrue(isDueForPush(marked(TimeEntrySyncBlock.SERVER_REJECTED, now - window), now))
    }

    /**
     * The shifts 1.502-1.508 tattooed with their own update pass's 23502.
     * Marked on 2026-09-18; the first sync of a fixed build must send them
     * again rather than leave them for a person to find.
     */
    @Test
    fun `a shift the old update pass marked is due again on the first sync of a fixed build`() {
        val markedOn0918 = java.time.Instant.parse("2026-09-18T19:40:00Z").toEpochMilli()
        val firstSyncAfterUpdate = java.time.Instant.parse("2026-09-21T13:00:00Z").toEpochMilli()
        val tattooed = marked(
            TimeEntrySyncBlock.SERVER_REJECTED, markedOn0918,
            detail = "null value in column \"started_at\" of relation \"time_entries\" violates not-null constraint"
        )
        assertTrue(isDueForPush(tattooed, firstSyncAfterUpdate))
    }

    @Test
    fun `a mark with no time, or a time ahead of the clock, is not left to rot`() {
        assertTrue(isDueForPush(marked(TimeEntrySyncBlock.SERVER_REJECTED, null), now))
        // The phone's clock was moved back after the mark was written.
        assertTrue(isDueForPush(marked(TimeEntrySyncBlock.SERVER_REJECTED, now + 3 * hour), now))
    }

    // Planted-failure case: expiry is for guesses about the server, and
    // NEEDS_WORKER is not a guess -- it is known locally, and sending it would
    // be the same refused insert on a loop. However old, it stays held.
    @Test
    fun `a NEEDS_WORKER mark never expires into a send`() {
        assertFalse(isDueForPush(marked(TimeEntrySyncBlock.NEEDS_WORKER, now - 1000 * hour), now))
    }

    // ---- the one write a stored shift ever gets again ----

    @Test
    fun `a shift nobody re-assigned earns no PATCH`() {
        // The whole point: the push no longer rewrites every shift on every
        // sync. If this returned a patch, it would -- and every write
        // re-stamps the shift's pay rate server-side.
        assertNull(workerChangeToSend(shift(employeeId = 3L), "3b1e0c2a-cloud-id"))
    }

    @Test
    fun `a Fix earns exactly one column, the worker`() {
        val fixed = shift(employeeId = 3L).copy(workerChangedAt = now)
        val patch = workerChangeToSend(fixed, "3b1e0c2a-cloud-id")
        assertEquals(CloudTimeEntryWorkerPatch(employeeSyncId = "3b1e0c2a-cloud-id"), patch)
    }

    @Test
    fun `a Fix whose worker resolves to nobody sends nothing`() {
        val fixed = shift(employeeId = 7L).copy(workerChangedAt = now)
        assertNull(workerChangeToSend(fixed, null))
        assertNull(workerChangeToSend(fixed, "   "))
    }

    // ---- the worker PATCH's own refusal rule ----

    @Test
    fun `a 403 on a worker change is marked with the server's sentence`() {
        val guard = "Changing who worked a shift, or which job it is against, needs SCHEDULE_AND_ASSIGN."
        val decision = classifyWorkerChangeRejection(restError(403, guard))
        assertTrue(decision is RowRejection.Permanent)
        assertEquals(guard, (decision as RowRejection.Permanent).detail)
    }

    // Planted-failure case: the special rule is for the worker PATCH only.
    // The ordinary row path must still treat 403 as a retry, or every shift
    // pushed while a session was being refreshed would be marked.
    @Test
    fun `the ordinary row path still retries a 403`() {
        assertTrue(classifyRowRejection(restError(403)) is RowRejection.Retry)
    }

    @Test
    fun `a 401 on a worker change is still a retry`() {
        assertTrue(classifyWorkerChangeRejection(restError(401)) is RowRejection.Retry)
    }
}
