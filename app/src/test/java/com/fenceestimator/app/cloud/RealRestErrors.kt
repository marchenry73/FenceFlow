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

/**
 * The exceptions postgrest-kt 3.0.2 really throws, built the way
 * `PostgrestImpl.parseErrorResponse` builds them -- read from the 3.0.2
 * bytecode: 400 is BadRequest, 401 Unauthorized, 404 NotFound, anything else
 * Unknown, each given `body.message, response, body.details ?: body.hint`,
 * and the SQLSTATE `code` dropped. So a classifier tested against these reads
 * exactly the status and sentence it will read on a phone, with no network:
 * the response is made from engine data the way ktor itself makes one (the
 * same construction as TimeEntryPushDecisionTest).
 *
 * The URL is an RPC's, on purpose: the library appends it to the message, and
 * a phrase test must never match the request instead of the answer.
 */
class RealRestErrors : AutoCloseable {

    private val client = HttpClient(CIO)

    override fun close() = client.close()

    @OptIn(InternalAPI::class)
    private fun response(status: HttpStatusCode, rpc: String): HttpResponse {
        val requestData = HttpRequestData(
            Url("https://example.supabase.co/rest/v1/rpc/$rpc"),
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

    /** What the library throws for [status] with the server's [message] (and [details]). */
    fun of(status: Int, message: String, details: String? = null, rpc: String = "request_job_access"): RestException {
        val code = HttpStatusCode.fromValue(status)
        val r = response(code, rpc)
        return when (status) {
            400 -> BadRequestRestException(message, r, details)
            401 -> UnauthorizedRestException(message, r, details)
            404 -> NotFoundRestException(message, r, details)
            else -> UnknownRestException(message, r, details)
        }
    }
}
