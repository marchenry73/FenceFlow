package com.fenceestimator.app.cloud

import io.github.jan.supabase.exceptions.BadRequestRestException
import io.github.jan.supabase.exceptions.NotFoundRestException
import io.github.jan.supabase.exceptions.RestException
import io.github.jan.supabase.exceptions.UnauthorizedRestException
import io.github.jan.supabase.exceptions.UnknownRestException
import io.ktor.client.HttpClient
import io.ktor.client.call.HttpClientCall
import io.ktor.client.engine.cio.CIO
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.client.statement.HttpResponse
import io.ktor.client.utils.EmptyContent
import io.ktor.http.Headers
import io.ktor.http.HttpMethod
import io.ktor.http.HttpProtocolVersion
import io.ktor.http.HttpStatusCode
import io.ktor.http.Url
import io.ktor.util.Attributes
import io.ktor.util.date.GMTDate
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.InternalAPI
import kotlinx.coroutines.Job
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The push path's decision, fed the REAL exception type postgrest-kt 3.0.2
 * throws for an HTTP 400 -- not a hand-built RestException.
 *
 * [BadRequestRestException] is final and only constructible from a live ktor
 * [HttpResponse], the way the library builds it in
 * `PostgrestImpl.parseErrorResponse` (read from the 3.0.2 bytecode: only a
 * 400 becomes this type; 401 is Unauthorized, 404 NotFound, everything else
 * Unknown; the arguments are `body.message, response, body.details ?:
 * body.hint`). So the response is built the way ktor itself builds one from
 * engine data, with no network: HttpClientCall(client, requestData,
 * responseData). The status the classifier reads is then the library's own
 * `statusCode`, filled from that response exactly as on the phone.
 */
class TimeEntryPushDecisionTest {

    private val client = HttpClient(CIO)

    @After
    fun tearDown() = client.close()

    private val serverSentence =
        "This shift is not linked to a crew member. Assign the job to somebody, or pick who is working, and clock in again."

    @OptIn(InternalAPI::class)
    private fun response(status: HttpStatusCode): HttpResponse {
        val requestData = HttpRequestData(
            Url("https://example.supabase.co/rest/v1/time_entries?on_conflict=company_id%2Csync_id"),
            HttpMethod.Post,
            Headers.Empty,
            EmptyContent,
            Job(),
            Attributes()
        )
        val responseData = HttpResponseData(
            status,
            GMTDate(),
            Headers.Empty,
            HttpProtocolVersion.HTTP_1_1,
            ByteReadChannel.Empty,
            Job()
        )
        return HttpClientCall(client, requestData, responseData).response
    }

    /** Built with the same three arguments parseErrorResponse passes. */
    private fun realBadRequest(): BadRequestRestException =
        BadRequestRestException(serverSentence, response(HttpStatusCode.BadRequest), "details")

    @Test
    fun `the library really exposes the status the classifier reads`() {
        val error: RestException = realBadRequest()
        assertEquals(400, error.statusCode)
        assertEquals(serverSentence, error.error)
    }

    @Test
    fun `a real 400 is permanent`() {
        assertTrue(isPermanentRejection(realBadRequest()))
    }

    @Test
    fun `the push path blocks the row and keeps the server's sentence`() {
        val decision = classifyRowRejection(realBadRequest())
        assertTrue("a real 400 must never be counted as a sync failure", decision is RowRejection.Permanent)
        assertEquals(serverSentence, (decision as RowRejection.Permanent).detail)
    }

    @Test
    fun `still permanent when something wraps it`() {
        val wrapped = RuntimeException("push time_entries failed", realBadRequest())
        assertTrue(classifyRowRejection(wrapped) is RowRejection.Permanent)
        assertEquals(serverSentence, permanentRejectionDetail(wrapped))
    }

    /**
     * A refused ROW is not "not ours to send": pushAll's step wrapper must
     * not file it as a silent permission skip either, or nobody ever hears.
     */
    @Test
    fun `a refused row is not mistaken for a permission skip`() {
        assertFalse(isNotOursToSync(realBadRequest()))
    }

    // Planted-failure cases, each through the same real construction path.

    @Test
    fun `a real 401 stays a retry -- signing in again can fix it`() {
        val error = UnauthorizedRestException("JWT expired", response(HttpStatusCode.Unauthorized), "details")
        assertEquals(401, error.statusCode)
        assertTrue(classifyRowRejection(error) is RowRejection.Retry)
    }

    @Test
    fun `a real 503 stays a retry`() {
        val error = UnknownRestException("upstream unavailable", response(HttpStatusCode.ServiceUnavailable), "details")
        assertEquals(503, error.statusCode)
        assertTrue(classifyRowRejection(error) is RowRejection.Retry)
    }

    // ---- the transient 4xx that used to tattoo a shift (2026-09-21) ----

    /** What postgrest-kt throws for PGRST205 mid-migration: its own NotFound type. */
    @Test
    fun `a real 404 is a retry, not a mark`() {
        val error = NotFoundRestException(
            "Could not find the table 'public.time_entries' in the schema cache",
            response(HttpStatusCode.NotFound), "details"
        )
        assertEquals(404, error.statusCode)
        assertTrue(classifyRowRejection(error) is RowRejection.Retry)
    }

    @Test
    fun `a real 429 is a retry, not a mark`() {
        val error = UnknownRestException("rate limit exceeded", response(HttpStatusCode.TooManyRequests), "details")
        assertEquals(429, error.statusCode)
        assertTrue(classifyRowRejection(error) is RowRejection.Retry)
    }

    @Test
    fun `a real 408 is a retry, not a mark`() {
        val error = UnknownRestException("request timeout", response(HttpStatusCode.RequestTimeout), "details")
        assertTrue(classifyRowRejection(error) is RowRejection.Retry)
    }

    // Planted-failure case: a real 409 (23503/23505) still marks the shift --
    // the narrowing did not quietly make every 4xx a retry.
    @Test
    fun `a real 409 still marks the shift`() {
        val error = UnknownRestException("duplicate key value violates unique constraint", response(HttpStatusCode.Conflict), "details")
        assertEquals(409, error.statusCode)
        assertTrue(classifyRowRejection(error) is RowRejection.Permanent)
    }

    /**
     * The 23502 the update pass earned on every shift from 1.470: a real 400,
     * so it WAS marked -- and before 2026-09-21 that mark was for ever. The
     * classification is unchanged; what changed is that the mark it produces
     * expires, so a shift wrongly marked this way goes back up by itself.
     */
    @Test
    fun `the update pass's 23502 marks, and the mark expires`() {
        val error = BadRequestRestException(
            "null value in column \"started_at\" of relation \"time_entries\" violates not-null constraint",
            response(HttpStatusCode.BadRequest), "Failing row contains (...)"
        )
        val decision = classifyRowRejection(error)
        assertTrue(decision is RowRejection.Permanent)
        val markedAt = 1_800_000_000_000L
        val marked = com.fenceestimator.app.data.TimeEntry(jobId = 1L, startedAt = 0L, endedAt = 1L).copy(
            syncBlockedReason = TimeEntrySyncBlock.SERVER_REJECTED.name,
            syncBlockedAt = markedAt,
            syncBlockedDetail = (decision as RowRejection.Permanent).detail
        )
        assertFalse(isDueForPush(marked, markedAt + 60_000L))
        assertTrue(isDueForPush(marked, markedAt + SERVER_REJECTED_RETRY_AFTER_MS))
    }

    // ---- the worker-change PATCH ----

    /** 42501 from guard_time_entry_write_permission arrives as a 403 -- postgrest-kt's Unknown type. */
    @Test
    fun `a real 403 on the worker PATCH is marked with the guard's sentence`() {
        val guard = "Changing who worked a shift, or which job it is against, needs SCHEDULE_AND_ASSIGN. Whose hours these are is payroll."
        val error = UnknownRestException(guard, response(HttpStatusCode.Forbidden), "details")
        assertEquals(403, error.statusCode)
        val decision = classifyWorkerChangeRejection(error)
        assertTrue(decision is RowRejection.Permanent)
        assertEquals(guard, (decision as RowRejection.Permanent).detail)
        // Planted: the same exception on the ordinary row path is still a retry.
        assertTrue(classifyRowRejection(error) is RowRejection.Retry)
    }

    @Test
    fun `a real 401 on the worker PATCH stays a retry`() {
        val error = UnauthorizedRestException("JWT expired", response(HttpStatusCode.Unauthorized), "details")
        assertTrue(classifyWorkerChangeRejection(error) is RowRejection.Retry)
    }

    @Test
    fun `a real 23514 on the worker PATCH is marked`() {
        val error = BadRequestRestException(
            "That crew member is not on this company. The shift was not changed.",
            response(HttpStatusCode.BadRequest), "details"
        )
        val decision = classifyWorkerChangeRejection(error)
        assertTrue(decision is RowRejection.Permanent)
        assertEquals("That crew member is not on this company. The shift was not changed.",
            (decision as RowRejection.Permanent).detail)
    }
}
