package com.fenceestimator.app.cloud

import io.github.jan.supabase.exceptions.BadRequestRestException
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
}
