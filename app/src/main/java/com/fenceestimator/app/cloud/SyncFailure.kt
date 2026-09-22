package com.fenceestimator.app.cloud

import io.github.jan.supabase.exceptions.HttpRequestException
import io.github.jan.supabase.exceptions.RestException

/**
 * Whether a failure is the phone losing its connection, rather than anything
 * being wrong.
 *
 * The admin crash page on 2026-09-21 was mostly this: "HTTP request to
 * .../fence_runs?... failed with message: " -- with nothing after the colon --
 * from one crew phone, several in one upload, every one of them a sync pass
 * that ran while the phone had no signal. postgrest-kt 3.0.2 wraps whatever
 * the HTTP client threw in an [HttpRequestException] and keeps only its
 * message, never the exception itself; Ktor's CIO engine reports a failed DNS
 * lookup as an UnresolvedAddressException with no message at all, so the
 * commonest "no bars" failure there is arrives as an empty sentence. The old
 * phrase test (AutoSync.looksLikeNoSignal) had nothing to match and filed each
 * one as a crash, so real faults sat under a pile of dead spots.
 *
 * Deliberately narrow in what it forgives:
 *  - An answer from the server ([RestException], any status) is never a lost
 *    connection. A 4xx or 5xx with a sentence is something to look at.
 *  - An [HttpRequestException] counts only when what the client said is
 *    empty or names the transport ("Failed to parse HTTP response: the
 *    server prematurely closed the connection", Ktor's "Exception in
 *    completion handler" as a socket is torn down). Anything else it wraps --
 *    a request body that would not serialize, say -- is still reported.
 *  - Phrases are read off the ERROR, never the request: the URL is cut away
 *    first, because every upsert URL carries column names and on_conflict=,
 *    and a phrase that matched a query string would forgive everything.
 *  - Certificate failures (a wrong clock, a captive portal) are not on the
 *    list. They do not clear by themselves, and somebody should hear of one.
 */
internal object SyncFailure {

    /** Transport failures by type, matched on the simple name so no engine class is pulled in. */
    private val TRANSPORT_TYPES = setOf(
        "UnknownHostException",
        // Ktor CIO's failed DNS lookup. No message, ever.
        "UnresolvedAddressException",
        "ConnectException",
        "NoRouteToHostException",
        "PortUnreachableException",
        "SocketException",
        "SocketTimeoutException",
        "ConnectTimeoutException",
        "HttpRequestTimeoutException",
        "EOFException",
        "ClosedReceiveChannelException",
        "ClosedSendChannelException",
        "ClosedByteChannelException",
        "ClosedWriteChannelException",
    )

    /** What a lost or dropped connection says, in any of the layers that can say it. */
    private val TRANSPORT_PHRASES = listOf(
        "unable to resolve host",
        "no address associated",
        "unknownhost",
        "failed to connect",
        "connection refused",
        "connection reset",
        "connection abort",
        "connection closed",
        "connection was closed",
        "prematurely closed",
        "broken pipe",
        "network is unreachable",
        "software caused connection abort",
        "failed to parse http response",
        "unexpected end of stream",
        "chunked stream has ended unexpectedly",
        "exception in completion handler",
        // Ktor's own TLS (the CIO engine does not use the platform's) when
        // the connection drops mid-handshake: EOS is end of stream. Only
        // this one -- a handshake refused for a certificate or a protocol
        // says something else, and is reported (see the class doc).
        "negotiation failed due to eos",
        // An HTTP/2 stream torn down (OkHttp's words). Carried over from the
        // sign-in classifier this one replaced (looksLikeNoNetwork), so
        // nothing it used to forgive is reported now.
        "stream was reset",
        "timeout",
        "timed out",
    )

    /**
     * The transport failures that happen before a single byte of the request
     * leaves the phone: no DNS answer, no route, the connection refused or
     * never made. A subset of [TRANSPORT_TYPES] -- a timeout or a connection
     * dropped half way is NOT one of these, since a smaller request might
     * have got through.
     */
    private val NEVER_SENT_TYPES = setOf(
        "UnknownHostException",
        "UnresolvedAddressException",
        "ConnectException",
        "NoRouteToHostException",
        "PortUnreachableException",
        // Ktor's: the connection was never made, whatever the body's size.
        "ConnectTimeoutException",
    )

    /** What the same failures say, in the layers that put it in words. A subset of [TRANSPORT_PHRASES]. */
    private val NEVER_SENT_PHRASES = listOf(
        "unable to resolve host",
        "no address associated",
        "unknownhost",
        "failed to connect",
        "connection refused",
        "network is unreachable",
    )

    /** Only one of these is ever worth a report: see [toReport]. */
    fun isTransientNetwork(error: Throwable): Boolean {
        val chain = generateSequence(error) { it.cause }.take(MAX_CAUSES).toList()
        // The server answered. Whatever it said is not a dead spot.
        if (chain.any { it is RestException }) return false
        return chain.any { e ->
            when {
                e is HttpRequestException -> {
                    val said = clientDetail(e.message)
                    said.isBlank() || TRANSPORT_PHRASES.any { it in said }
                }
                e::class.java.simpleName in TRANSPORT_TYPES -> true
                // Only I/O failures are read for phrases. A decoding error
                // quotes the JSON it choked on, and a customer's note that
                // says "timed out" must not turn a real bug into weather.
                e is java.io.IOException -> {
                    val text = withoutRequest(e.message).lowercase()
                    TRANSPORT_PHRASES.any { it in text }
                }
                else -> false
            }
        }
    }

    /**
     * Whether the request never reached the server at all, so sending the
     * same rows again one at a time can only fail the same way.
     *
     * Narrower than [isTransientNetwork] on purpose. EntitySync's upsert
     * retries a failed 200-row chunk row by row, and stops doing that only on
     * this answer: 125 doomed single requests after a dead-spot chunk were
     * "125 of 125 rows rejected" (job_steps, 1.509). A timeout, or a
     * connection dropped mid-request, is different -- a chunk too big for the
     * client's ten-second request timeout on a slow upload link fails the
     * same way every pass, and only the single rows get through. Stopping on
     * those too left the table never syncing, and nothing reported it.
     *
     * An empty "failed with message: " counts: it is Ktor CIO's failed DNS
     * lookup (see the class doc), the commonest no-bars failure there is.
     */
    fun neverReachedServer(error: Throwable): Boolean {
        val chain = generateSequence(error) { it.cause }.take(MAX_CAUSES).toList()
        if (chain.any { it is RestException }) return false
        return chain.any { e ->
            when {
                e is HttpRequestException -> {
                    val said = clientDetail(e.message)
                    said.isBlank() || NEVER_SENT_PHRASES.any { it in said }
                }
                e::class.java.simpleName in NEVER_SENT_TYPES -> true
                e is java.io.IOException -> {
                    val text = withoutRequest(e.message).lowercase()
                    NEVER_SENT_PHRASES.any { it in text }
                }
                else -> false
            }
        }
    }

    /**
     * The one failure from a sync pass worth writing down, or null.
     *
     * Skips refusals ([isNotOursToSync] -- the server saying a table is none
     * of this phone's business) and lost connections, in that order of
     * everything that failed -- so a real fault is found even when a dead
     * spot happened to fail first. It used to take simply the first
     * non-refusal, and on a patchy connection that was the dead spot, with
     * the real fault behind it never mentioned.
     */
    fun toReport(errors: List<Throwable>): Throwable? =
        errors.firstOrNull { !isNotOursToSync(it) && !isTransientNetwork(it) }

    /**
     * What the HTTP client itself said: the part after "failed with
     * message: ". Everything before it is the request line, URL included.
     */
    internal fun clientDetail(message: String?): String =
        message.orEmpty().substringAfter(CLIENT_SAID, missingDelimiterValue = message.orEmpty())
            .trim().lowercase()

    /** The message with any URL -- and the "URL:" block postgrest-kt appends -- cut away. */
    private fun withoutRequest(message: String?): String =
        message.orEmpty()
            .substringBefore("\nURL:")
            .replace(Regex("""https?://\S+"""), " ")

    private const val CLIENT_SAID = "failed with message:"

    /** Enough to reach the real cause through any wrapper this app throws. */
    private const val MAX_CAUSES = 12
}
