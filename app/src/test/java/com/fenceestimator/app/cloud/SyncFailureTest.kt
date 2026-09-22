package com.fenceestimator.app.cloud

import io.github.jan.supabase.exceptions.HttpRequestException
import io.ktor.client.network.sockets.ConnectTimeoutException
import io.ktor.client.plugins.HttpRequestTimeoutException
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.url
import io.ktor.http.HttpMethod
import kotlinx.serialization.SerializationException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.EOFException
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.nio.channels.UnresolvedAddressException
import javax.net.ssl.SSLHandshakeException

/**
 * Telling the phone losing its signal apart from something being wrong (see
 * [SyncFailure]).
 *
 * Most of the admin crash page on 2026-09-21 was the first kind: "HTTP request
 * to .../fence_runs?... failed with message: " with nothing after the colon,
 * several from one crew phone in one upload. Every exception here is built
 * the way the libraries on the phone build it -- postgrest-kt 3.0.2 wraps
 * whatever Ktor threw in an [HttpRequestException] and keeps only its
 * message; a server answer is a RestException ([RealRestErrors]).
 */
class SyncFailureTest {

    private val rest = RealRestErrors()

    @After
    fun close() = rest.close()

    private val base = "https://newcrgafcptspmapacrx.supabase.co/rest/v1"

    /** What KtorSupabaseHttpClient throws when the request never got an answer. */
    private fun clientFailure(path: String, said: String, method: HttpMethod = HttpMethod.Get) =
        HttpRequestException(said, HttpRequestBuilder().apply { url("$base/$path"); this.method = method })

    // --- the reports themselves -------------------------------------------

    @Test
    fun `the empty failures from 2026-09-21 are a lost connection`() {
        val reads = listOf(
            "fence_runs?company_id=eq.aba5b097-afc4-48dd-9851-b50200d5e8f4&deleted_at=not.is.null&order=sync_id.asc",
            "job_steps?company_id=eq.aba5b097-afc4-48dd-9851-b50200d5e8f4&deleted_at=not.is.null",
            "pricing_tiers?company_id=eq.aba5b097-afc4-48dd-9851-b50200d5e8f4&order=sync_id.asc.nullslast",
        )
        reads.forEach { path ->
            val e = clientFailure(path, "")
            assertTrue("sanity: this is the message the report carried", e.message!!.endsWith("failed with message: "))
            assertTrue(path, SyncFailure.isTransientNetwork(e))
        }
        assertTrue(SyncFailure.isTransientNetwork(clientFailure("rpc/crew_push_line_items", "", HttpMethod.Post)))
    }

    /** "push job_steps: 125 of 125 rows rejected" (1.509): no row was rejected; none arrived. */
    @Test
    fun `a push failure caused by a lost connection is a lost connection`() {
        val cause = clientFailure(
            "job_steps?columns=company_id%2Csync_id&on_conflict=company_id%2Csync_id", "", HttpMethod.Post
        )
        assertTrue(SyncFailure.isTransientNetwork(IllegalStateException("push job_steps: 125 of 125 rows rejected", cause)))
    }

    @Test
    fun `what CIO says as a socket is torn down is a lost connection`() {
        listOf(
            "Failed to parse HTTP response: the server prematurely closed the connection",
            "Exception in completion handler InvokeOnCompletion@4c1e2d7[job@8caf1]",
            "Connection reset by peer",
            "SSL handshake aborted: ssl=0x7b: I/O error during system call, Connection reset by peer",
            // Ktor TLS, the connection gone half way through the handshake.
            "Negotiation failed due to EOS",
        ).forEach { said ->
            assertTrue(said, SyncFailure.isTransientNetwork(clientFailure("fence_runs?select=*", said)))
        }
    }

    @Test
    fun `transport failures are recognised by type, message or not`() {
        listOf<Throwable>(
            UnknownHostException("Unable to resolve host \"newcrgafcptspmapacrx.supabase.co\""),
            // Ktor CIO's failed DNS lookup: no message at all.
            UnresolvedAddressException(),
            ConnectException("Failed to connect to /10.0.2.2:443"),
            ConnectTimeoutException("Connect timeout has expired", null),
            SocketTimeoutException(),
            HttpRequestTimeoutException("$base/jobs", 30_000L, null),
            EOFException(),
            RuntimeException("Sync failed", UnknownHostException()),
        ).forEach { e -> assertTrue(e.toString(), SyncFailure.isTransientNetwork(e)) }
    }

    // --- what must still be reported --------------------------------------

    /** The server answered. A 4xx or 5xx is something to look at, whatever words it used. */
    @Test
    fun `an answer from the server is never a lost connection`() {
        assertFalse(
            SyncFailure.isTransientNetwork(
                rest.of(400, "This shift is not linked to a crew member. Assign the job to somebody, or pick who is working, and clock in again.")
            )
        )
        // Even one that says "timeout": the server is there and said something.
        assertFalse(SyncFailure.isTransientNetwork(rest.of(500, "canceling statement due to statement timeout")))
        assertFalse(
            SyncFailure.isTransientNetwork(
                IllegalStateException("push time_entries: 2 of 7 rows rejected", rest.of(400, "violates not-null constraint"))
            )
        )
        // An answer anywhere in the chain wins over a wrapper that reads like
        // weather: the server was reached, so the connection was not the problem.
        assertFalse(
            SyncFailure.isTransientNetwork(
                IOException("sync step timed out", rest.of(500, "canceling statement due to statement timeout"))
            )
        )
    }

    /**
     * A decoding error quotes the JSON it choked on, and a customer's note
     * that says "timed out" must not turn a real bug into weather.
     */
    @Test
    fun `a decoding error is reported whatever the data says`() {
        val e = SerializationException(
            "Unexpected JSON token at offset 1636: Expected string literal but 'null' literal was found at path: " +
                "\$[1].correction_reason\nJSON input: .....\"notes\":\"gate timed out, connection reset\",\"correction_reason\":null....."
        )
        assertFalse(SyncFailure.isTransientNetwork(e))
    }

    /** Every upsert URL carries column names and on_conflict=; a phrase in the request must not count. */
    @Test
    fun `the request is never read for phrases`() {
        val e = clientFailure(
            "jobs?columns=timeout_minutes%2Cconnection_reset_note&on_conflict=company_id%2Csync_id",
            "Illegal input: Field 'sync_id' is required for type with serial name 'CloudJob'",
            HttpMethod.Post
        )
        assertFalse(SyncFailure.isTransientNetwork(e))
        val io = IOException("Could not write body for https://x.supabase.co/rest/v1/timeout_log?on_conflict=connection_reset")
        assertFalse(SyncFailure.isTransientNetwork(io))
    }

    @Test
    fun `a certificate failure is reported, since it does not clear by itself`() {
        val e = SSLHandshakeException(
            "java.security.cert.CertPathValidatorException: Trust anchor for certification path not found."
        )
        assertFalse(SyncFailure.isTransientNetwork(e))
    }

    @Test
    fun `an ordinary bug is reported`() {
        assertFalse(SyncFailure.isTransientNetwork(IllegalStateException("null value in column \"unit\" violates not-null constraint")))
        assertFalse(SyncFailure.isTransientNetwork(NullPointerException()))
    }

    // --- choosing the one to report --------------------------------------

    /**
     * It used to take the first failure that was not a refusal, and on a
     * patchy connection that was the dead spot -- the real fault behind it
     * never mentioned.
     */
    @Test
    fun `a real fault behind a dead spot is the one reported`() {
        val deadSpot = clientFailure("fence_runs?select=*", "")
        val refusal = rest.of(403, "new row violates row-level security policy for table \"payment_records\"")
        val real = rest.of(400, "null value in column \"employee_sync_id\" of relation \"time_entries\" violates not-null constraint")
        assertSame(real, SyncFailure.toReport(listOf(deadSpot, refusal, real)))
    }

    @Test
    fun `a pass that only lost its connection, or was only refused, reports nothing`() {
        val deadSpot = clientFailure("fence_runs?select=*", "")
        val refusal = rest.of(403, "new row violates row-level security policy for table \"material_items\"")
        assertNull(SyncFailure.toReport(listOf(deadSpot, clientFailure("job_steps?select=*", ""))))
        assertNull(SyncFailure.toReport(listOf(refusal, deadSpot)))
        assertNull(SyncFailure.toReport(emptyList()))
    }

    // --- when a failed chunk may skip the row-by-row retry -----------------

    /**
     * EntitySync's upsert stops retrying a failed chunk row by row only when
     * the request never left the phone: the 125 doomed single requests of
     * "push job_steps: 125 of 125 rows rejected" (1.509) were a dead spot.
     */
    @Test
    fun `a request that never left the phone skips the row-by-row retry`() {
        listOf<Throwable>(
            // The 1.509 chunk: Ktor CIO's failed DNS lookup, nothing after the colon.
            clientFailure("job_steps?columns=company_id%2Csync_id&on_conflict=company_id%2Csync_id", "", HttpMethod.Post),
            UnresolvedAddressException(),
            UnknownHostException("Unable to resolve host \"newcrgafcptspmapacrx.supabase.co\""),
            ConnectException("Failed to connect to /10.0.2.2:443"),
            ConnectTimeoutException("Connect timeout has expired", null),
            IOException("Network is unreachable"),
            RuntimeException("push failed", UnknownHostException()),
        ).forEach { e -> assertTrue(e.toString(), SyncFailure.neverReachedServer(e)) }
    }

    /**
     * A 200-row chunk that outlasts the client's ten-second request timeout
     * on a slow upload link fails that way every pass, while each row alone
     * gets through. Skipping the single rows for it left the table never
     * syncing, with nothing reported (the pass read "waiting for signal").
     * Neither is a connection dropped half way through the request.
     */
    @Test
    fun `a timeout or a connection dropped mid-request still goes row by row`() {
        listOf<Throwable>(
            HttpRequestTimeoutException("$base/fence_runs", 10_000L, null),
            SocketTimeoutException("Socket timeout has expired"),
            clientFailure("fence_runs?on_conflict=company_id%2Csync_id", "Request timeout has expired [request_timeout=10000 ms]", HttpMethod.Post),
            clientFailure("fence_runs?on_conflict=company_id%2Csync_id", "Failed to parse HTTP response: the server prematurely closed the connection", HttpMethod.Post),
            clientFailure("fence_runs?on_conflict=company_id%2Csync_id", "Connection reset by peer", HttpMethod.Post),
            EOFException(),
        ).forEach { e ->
            assertTrue("sanity: still a lost connection for reporting -- $e", SyncFailure.isTransientNetwork(e))
            assertFalse(e.toString(), SyncFailure.neverReachedServer(e))
        }
        // Nor, of course, does anything the server answered.
        assertFalse(SyncFailure.neverReachedServer(rest.of(400, "violates not-null constraint")))
        assertFalse(SyncFailure.neverReachedServer(IllegalStateException("Illegal input: Field 'sync_id' is required")))
    }

    /** Both of EntitySync's chunk loops ask the narrow question, never the wide one. */
    @Test
    fun `EntitySync skips the single rows only for a request that never left the phone`() {
        val src = listOf(
            java.io.File("src/main/java/com/fenceestimator/app/cloud/EntitySync.kt"),
            java.io.File("app/src/main/java/com/fenceestimator/app/cloud/EntitySync.kt")
        ).first { it.isFile }.readText()
        assertFalse("a chunk still gives up on any transient failure",
            src.contains("if (SyncFailure.isTransientNetwork(it)) throw it"))
        assertEquals("upsert and the time_entries push", 2,
            Regex("""if \(SyncFailure\.neverReachedServer\(it\)\) throw it""").findAll(src).count())
    }

    /**
     * The sign-in and token-refresh classifier is this one. As a phrase list
     * of its own it had nothing to match in an empty "failed with message: ",
     * so an offline token refresh read as signed out and AutoSync told a phone
     * that was only out of signal to sign in again.
     */
    @Test
    fun `an offline token refresh reads as no network, not as signed out`() {
        val refresh = HttpRequestException(
            "",
            HttpRequestBuilder().apply {
                url("https://newcrgafcptspmapacrx.supabase.co/auth/v1/token?grant_type=refresh_token")
                method = HttpMethod.Post
            }
        )
        assertTrue(looksLikeNoNetwork(refresh))
        assertTrue(looksLikeNoNetwork(UnknownHostException("Unable to resolve host")))
        // A refresh token the server turned down is being signed out.
        assertFalse(looksLikeNoNetwork(rest.of(400, "Invalid Refresh Token: Refresh Token Not Found")))
        assertFalse(looksLikeNoNetwork(rest.of(400, "Invalid login credentials")))
    }

    @Test
    fun `what the client said is read after the request line`() {
        assertEquals(
            "failed to parse http response: the server prematurely closed the connection",
            SyncFailure.clientDetail(
                clientFailure("fence_runs?select=timeout", "Failed to parse HTTP response: the server prematurely closed the connection").message
            )
        )
        assertEquals("", SyncFailure.clientDetail(clientFailure("fence_runs?select=*", "").message))
    }
}
