package com.fenceestimator.app.cloud

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.IOException

/**
 * The access RPCs answer in SQLSTATEs (supabase_crew_job_scope.sql, PART 3),
 * but postgrest-kt 3.0.2 drops the SQLSTATE and keeps only the server's
 * sentence and the HTTP status. So [classifyAccessFailure] reads the sentence
 * first and the status second, and this test holds the sentences to the SQL
 * file itself, both ways round:
 *  - every phrase the phone keys on is still raised under its SQLSTATE, and
 *  - every refusal PART 3 raises is recognised as the refusal its SQLSTATE
 *    means -- so rewording a message, or adding one, fails here in seconds
 *    instead of showing a crew member "something went wrong" for "your login
 *    is not linked".
 *
 * Every exception is the library's real type, built as it builds them.
 */
class JobAccessRefusalTest {

    private val errors = RealRestErrors()

    @After
    fun tearDown() = errors.close()

    /** The HTTP status PostgREST gives each SQLSTATE PART 3 raises, for a signed-in caller. */
    private val statusFor = mapOf("42501" to 403, "23514" to 400, "22023" to 400, "23503" to 409, "54000" to 413)

    /** What each SQLSTATE means to the phone (the file's own header lists them). */
    private fun expectedFor(code: String, message: String): AccessRefusal = when (code) {
        // Raised only when auth.uid() is null -- signing in fixes it, not the office.
        "42501" -> if ("sign in" in message.lowercase()) AccessRefusal.SIGNED_OUT else AccessRefusal.NOT_ALLOWED
        "23514" -> AccessRefusal.NOT_LINKED
        "22023" -> AccessRefusal.NOTHING_TO_ASK
        "23503" -> AccessRefusal.NOT_FOUND
        "54000" -> AccessRefusal.LIMIT_REACHED
        else -> error("PART 3 raises $code, which the phone has no refusal for: \"$message\"")
    }

    private fun repoRoot(): File =
        listOf(File(".."), File("."))
            .firstOrNull { File(it, "supabase_crew_job_scope.sql").isFile }
            ?: error("could not find supabase_crew_job_scope.sql from ${File(".").absolutePath}")

    /** Every `raise exception '...' using errcode = '...'` in PART 3, as (message, code). */
    private fun part3Raises(): List<Pair<String, String>> {
        val sql = File(repoRoot(), "supabase_crew_job_scope.sql").readText()
        val start = sql.indexOf("-- PART 3")
        val end = sql.indexOf("-- PART 4")
        assertTrue("PART 3 / PART 4 headers moved in supabase_crew_job_scope.sql", start in 0 until end)
        val raise = Regex("""raise exception '((?:[^']|'')*)'\s*using errcode = '(\w+)'""", RegexOption.IGNORE_CASE)
        return raise.findAll(sql.substring(start, end)).map { it.groupValues[1].replace("''", "'") to it.groupValues[2] }.toList()
    }

    /** Whether some raise under a SQLSTATE meaning [refusal] carries [phrase]. */
    private fun raisedUnder(raises: List<Pair<String, String>>, phrase: String, refusal: AccessRefusal): Boolean =
        raises.any { (message, code) -> phrase in message.lowercase() && expectedFor(code, message) == refusal }

    // ---- held to the SQL file ----

    @Test
    fun `PART 3 still raises every refusal the phone knows about`() {
        val raises = part3Raises()
        assertTrue("found only ${raises.size} raises in PART 3 -- the parser is not seeing the file", raises.size >= 10)
        for ((phrase, refusal) in ACCESS_REFUSAL_PHRASES) {
            assertTrue(
                "\"$phrase\" ($refusal) is no longer raised under its SQLSTATE in supabase_crew_job_scope.sql " +
                    "PART 3 -- update ACCESS_REFUSAL_PHRASES in JobAccess.kt with the new wording",
                raisedUnder(raises, phrase, refusal)
            )
        }
    }

    @Test
    fun `every refusal PART 3 raises is recognised as what its SQLSTATE means`() {
        for ((message, code) in part3Raises()) {
            val error = errors.of(statusFor.getValue(code), message)
            assertEquals("\"$message\" ($code)", expectedFor(code, message), classifyAccessFailure(error))
        }
    }

    // Planted failures: both checks above can fail.
    @Test
    fun `a phrase the SQL does not raise is caught by the first check`() {
        assertFalse(raisedUnder(part3Raises(), "your crew record is missing", AccessRefusal.NOT_LINKED))
        // ...and a real phrase under the wrong meaning is caught too.
        assertFalse(raisedUnder(part3Raises(), "not linked to a crew member", AccessRefusal.NOT_FOUND))
    }

    @Test
    fun `a reworded not-linked message would be caught by the second check`() {
        // 23514 is a plain 400, the same status as 22023: without its sentence
        // there is nothing to tell it by, which is exactly what the check sees.
        val reworded = errors.of(400, "Ask the office to give your login a crew record.")
        assertNotEquals(AccessRefusal.NOT_LINKED, classifyAccessFailure(reworded))
    }

    // ---- the classifier itself ----

    @Test
    fun `a limit is not mistaken for already having the job`() {
        val limit = errors.of(413, "You already have 20 requests waiting. Wait for the office to answer some.")
        assertEquals(AccessRefusal.LIMIT_REACHED, classifyAccessFailure(limit))
        // Same sentence, status withheld: the order of the phrases still gets it right.
        assertEquals(AccessRefusal.LIMIT_REACHED, classifyAccessFailure(errors.of(500, limit.error)))
    }

    @Test
    fun `the status answers when the sentence is one the phone has never seen`() {
        assertEquals(AccessRefusal.NOT_ALLOWED, classifyAccessFailure(errors.of(403, "new wording")))
        assertEquals(AccessRefusal.NOT_FOUND, classifyAccessFailure(errors.of(409, "new wording")))
        assertEquals(AccessRefusal.LIMIT_REACHED, classifyAccessFailure(errors.of(413, "new wording")))
        assertEquals(AccessRefusal.SIGNED_OUT, classifyAccessFailure(errors.of(401, "JWT expired")))
    }

    @Test
    fun `a database without the change says the feature is not there`() {
        val missing = errors.of(
            404,
            "Could not find the function public.request_job_access(p_job_sync_id, p_reason) in the schema cache",
            details = "Searched for the function public.request_job_access with parameters p_job_sync_id, p_reason"
        )
        assertEquals(AccessRefusal.NOT_AVAILABLE, classifyAccessFailure(missing))
        assertEquals(
            AccessRefusal.NOT_AVAILABLE,
            classifyAccessFailure(errors.of(404, "Could not find the table 'public.job_access_requests' in the schema cache"))
        )
    }

    @Test
    fun `no signal is a connection problem, a server error is not`() {
        assertEquals(AccessRefusal.NO_CONNECTION, classifyAccessFailure(IOException("Unable to resolve host example.supabase.co")))
        assertEquals(AccessRefusal.FAILED, classifyAccessFailure(errors.of(500, "canceling statement due to statement timeout")))
        assertEquals(AccessRefusal.FAILED, classifyAccessFailure(errors.of(400, "invalid input syntax for type uuid: \"x\"")))
    }

    // The library appends the URL to every message, and every access call's
    // URL names its RPC. Only the server's own words may decide anything.
    @Test
    fun `the request's URL never decides the answer`() {
        val blank = errors.of(500, "", rpc = "request_job_access")
        assertTrue("the URL is in the message, or this test proves nothing", blank.message.orEmpty().contains("request_job_access"))
        assertEquals(AccessRefusal.FAILED, classifyAccessFailure(blank))
    }

    @Test
    fun `wrapped, it is still read`() {
        val wrapped = RuntimeException("request failed",
            errors.of(400, "Your login is not linked to a crew member yet. Ask the office to link it."))
        assertEquals(AccessRefusal.NOT_LINKED, classifyAccessFailure(wrapped))
    }
}
