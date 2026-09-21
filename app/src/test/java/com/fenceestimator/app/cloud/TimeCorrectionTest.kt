package com.fenceestimator.app.cloud

import io.github.jan.supabase.exceptions.BadRequestRestException
import io.github.jan.supabase.exceptions.RestException
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
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/**
 * "The correction was not sent" and "the correction was refused" are
 * different sentences on a payroll screen, and getting them the wrong way
 * round is how a foreman is told a shift is approved over hours nobody holds.
 *
 * Fed the REAL exception types postgrest-kt 3.0.2 throws, built the way
 * `PostgrestImpl.parseErrorResponse` builds them -- same construction as
 * [TimeEntryPushDecisionTest], for the same reason: a hand-rolled
 * [RestException] would prove only that the test author can read the
 * classifier.
 */
class TimeCorrectionTest {

    private val client = HttpClient(CIO)

    @After
    fun tearDown() = client.close()

    private val refusal =
        "Correcting a shift's hours needs APPROVE_TIME. What the clock says is payroll."

    @OptIn(InternalAPI::class)
    private fun response(status: HttpStatusCode): HttpResponse {
        val requestData = HttpRequestData(
            Url("https://example.supabase.co/rest/v1/rpc/correct_time_entry"),
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

    /** errcode 42501 reaches PostgREST as HTTP 403 -- the guard's own refusal. */
    private fun realForbidden(): RestException =
        UnknownRestException(refusal, response(HttpStatusCode.Forbidden), "details")

    @Test
    fun `the library really exposes what the classifier reads`() {
        val error = realForbidden()
        assertEquals(403, error.statusCode)
        assertEquals(refusal, error.error)
    }

    @Test
    fun `a permission refusal is shown as the server's own sentence`() {
        val result = TimeCorrection.classify(realForbidden())
        assertTrue("a 403 is the server answering, not a dead connection", result is TimeCorrection.Outcome.Refused)
        assertEquals(refusal, (result as TimeCorrection.Outcome.Refused).detail)
    }

    @Test
    fun `a check-constraint refusal is a refusal too, verbatim`() {
        val sentence = "Say why the hours are being changed. The crew member reads this."
        val result = TimeCorrection.classify(
            BadRequestRestException(sentence, response(HttpStatusCode.BadRequest), "details")
        )
        assertEquals(sentence, (result as TimeCorrection.Outcome.Refused).detail)
    }

    @Test
    fun `still a refusal when something wraps it`() {
        val wrapped = RuntimeException("correct_time_entry failed", realForbidden())
        assertEquals(refusal, (TimeCorrection.classify(wrapped) as TimeCorrection.Outcome.Refused).detail)
    }

    @Test
    fun `no HTTP answer at all is unreachable, never a refusal`() {
        // Offline, DNS, a dropped socket, a timeout: the server said nothing,
        // so nothing was saved and the shift must stay unapproved.
        assertTrue(
            TimeCorrection.classify(IOException("Unable to resolve host")) is TimeCorrection.Outcome.Unreachable
        )
    }

    @Test
    fun `an unreachable failure stays unreachable through a wrapper`() {
        val wrapped = RuntimeException("rpc failed", IOException("connection reset"))
        assertTrue(TimeCorrection.classify(wrapped) is TimeCorrection.Outcome.Unreachable)
    }

    /**
     * Planted failure: without the [RestException] test the classifier could
     * only be telling everything apart by accident. This asserts the two
     * branches really do split on whether the server answered, by feeding
     * the SAME message through both.
     */
    @Test
    fun `PLANTED FAILURE -- the same message answered and unanswered must not classify alike`() {
        val answered = TimeCorrection.classify(realForbidden())
        val unanswered = TimeCorrection.classify(RuntimeException(refusal))
        assertTrue(answered is TimeCorrection.Outcome.Refused)
        assertTrue(
            "an exception carrying the server's words but no HTTP response is NOT a refusal",
            unanswered is TimeCorrection.Outcome.Unreachable
        )
    }

    @Test
    fun `a refusal with no words still says something`() {
        val silent = UnknownRestException("", response(HttpStatusCode.Forbidden), "details")
        val detail = (TimeCorrection.classify(silent) as TimeCorrection.Outcome.Refused).detail
        assertTrue("a blank refusal must not reach the screen blank", detail.isNotBlank())
    }
}
