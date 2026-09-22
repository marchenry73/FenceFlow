package com.fenceestimator.app.cloud

import io.github.jan.supabase.exceptions.HttpRequestException
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.url
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The record format, checked both directions.
 *
 * A crash report that cannot be read back is indistinguishable from no crash
 * at all -- the app looks healthy precisely because the evidence was dropped.
 * So the round trip is the thing under test, not the individual halves.
 */
class CrashReporterTest {

    @get:Rule
    val folder = TemporaryFolder()

    private fun file() = folder.newFile("pending.txt")

    @Test
    fun `a written crash reads back with every field intact`() {
        val f = file()
        CrashReporter.appendTo(f, IllegalStateException("job total went negative"), true, "job/{jobId}")

        val parsed = CrashReporter.parse(f.readText())
        assertEquals(1, parsed.size)
        assertTrue(parsed[0].fatal)
        assertEquals("job/{jobId}", parsed[0].whereAt)
        assertEquals("job total went negative", parsed[0].message)
        assertTrue(parsed[0].stack.contains("IllegalStateException"))
    }

    @Test
    fun `several crashes stay separate`() {
        val f = file()
        CrashReporter.appendTo(f, RuntimeException("first"), true, "jobs")
        CrashReporter.appendTo(f, RuntimeException("second"), false, "settings")

        val parsed = CrashReporter.parse(f.readText())
        assertEquals(2, parsed.size)
        assertEquals("first", parsed[0].message)
        assertEquals("second", parsed[1].message)
        assertTrue(parsed[0].fatal)
        assertTrue(!parsed[1].fatal)
    }

    /**
     * A phone can die mid-write. The half-record it leaves must not take the
     * intact ones down with it.
     */
    @Test
    fun `a truncated record is dropped and the rest survive`() {
        val f = file()
        CrashReporter.appendTo(f, RuntimeException("good one"), true, "jobs")
        f.appendText("garbage with no field markers at all")

        val parsed = CrashReporter.parse(f.readText())
        assertEquals(1, parsed.size)
        assertEquals("good one", parsed[0].message)
    }

    /**
     * An exception with no message must still report. Throwing NPEs and
     * IndexOutOfBounds usually arrive with a null message, and those are
     * exactly the crashes worth seeing.
     */
    @Test
    fun `a message-less exception still reports, named by its type`() {
        val f = file()
        CrashReporter.appendTo(f, NullPointerException(), true, "estimate")

        val parsed = CrashReporter.parse(f.readText())
        assertEquals(1, parsed.size)
        assertEquals("NullPointerException", parsed[0].message)
    }

    /** A runaway stack must not put a multi-megabyte row into the database. */
    @Test
    fun `an enormous stack is capped`() {
        val f = file()
        val deep = RuntimeException("x".repeat(5000))
        CrashReporter.appendTo(f, deep, true, "jobs")

        val parsed = CrashReporter.parse(f.readText())
        assertEquals(1, parsed.size)
        assertTrue("message was not capped", parsed[0].message.length <= 400)
        assertTrue("stack was not capped", parsed[0].stack.length <= 8000)
    }

    /** The crash loop guard: a phone that crashes on every launch must not fill up. */
    @Test
    fun `the pending file stops growing after the cap`() {
        val f = file()
        repeat(60) { CrashReporter.appendTo(f, RuntimeException("loop $it"), true, "jobs") }
        assertTrue("file grew past the cap", CrashReporter.parse(f.readText()).size <= 25)
    }

    /**
     * Reports upload at the NEXT launch, which may be a newer build. The row
     * must name the build that WROTE the record: four "1.502" sync failures
     * on 2026-09-18 were 1.501's queued reports flushed on 1.502's first
     * launch, and they sent an investigation after a bug the new build did
     * not have.
     */
    @Test
    fun `the build that wrote the record is what reads back`() {
        val f = file()
        CrashReporter.appendTo(
            f, RuntimeException("push time_entries: 2 of 7 rows rejected"), false, "sync",
            versionCode = 501, versionName = "1.501"
        )

        val parsed = CrashReporter.parse(f.readText())
        assertEquals(1, parsed.size)
        assertEquals(501, parsed[0].versionCode)
        assertEquals("1.501", parsed[0].versionName)
    }

    // Planted-failure case: a record written with no build stamp (the format
    // before this field existed) must still read back, with the version left
    // empty for the upload to fill in -- not dropped, and not invented.
    @Test
    fun `a record with no build stamp still parses, version left for upload`() {
        val f = file()
        CrashReporter.appendTo(f, RuntimeException("old format"), true, "jobs")

        val parsed = CrashReporter.parse(f.readText())
        assertEquals(1, parsed.size)
        assertEquals(0, parsed[0].versionCode)
        assertEquals("", parsed[0].versionName)
    }

    /**
     * Neither kind says anything about the app. A lost connection is the
     * phone (most of the admin page on 2026-09-21); a cancellation is the
     * person leaving the screen ("The coroutine scope left the composition",
     * reported as a quote-link failure on 1.279).
     */
    @Test
    fun `a lost connection or a cancellation is never written`() {
        val deadSpot = HttpRequestException(
            "", HttpRequestBuilder().apply { url("https://example.supabase.co/rest/v1/fence_runs?select=*") }
        )
        assertFalse(CrashReporter.isWorthReporting(deadSpot))
        assertFalse(CrashReporter.isWorthReporting(java.net.UnknownHostException("Unable to resolve host")))
        assertFalse(CrashReporter.isWorthReporting(kotlinx.coroutines.CancellationException("The coroutine scope left the composition")))

        assertTrue(CrashReporter.isWorthReporting(IllegalStateException("FOREIGN KEY constraint failed (code 787)")))
        RealRestErrors().use { rest ->
            assertTrue(CrashReporter.isWorthReporting(rest.of(400, "violates not-null constraint")))
        }
    }

    /**
     * One pass a minute filed 157 identical "push time_entries: 2 of 7 rows
     * rejected" rows, and filled the pending file so a real crash behind them
     * was dropped. The same failure in the same place is written once per run.
     */
    @Test
    fun `the same failure in the same place is written once per run`() {
        val where = "test-" + java.util.UUID.randomUUID()
        assertTrue(CrashReporter.firstThisRun(where, RuntimeException("push time_entries: 2 of 7 rows rejected")))
        assertFalse(CrashReporter.firstThisRun(where, RuntimeException("push time_entries: 3 of 9 rows rejected")))
        // Somewhere else, or something else, is its own report.
        assertTrue(CrashReporter.firstThisRun("$where-b", RuntimeException("push time_entries: 2 of 7 rows rejected")))
        assertTrue(CrashReporter.firstThisRun(where, RuntimeException("push job_steps: 1 of 4 rows rejected")))
    }

    @Test
    fun `occurrences of one bug share a signature`() {
        assertEquals(
            CrashReporter.signature("sync", "Unexpected JSON token at offset 1636: at path \$[1].correction_reason"),
            CrashReporter.signature("sync", "Unexpected JSON token at offset 686: at path \$[4].correction_reason")
        )
        assertEquals(
            CrashReporter.signature("sync", "HTTP request to https://x.supabase.co/rest/v1/fence_runs?company_id=eq.aba5b097-afc4-48dd-9851-b50200d5e8f4 (GET) failed"),
            CrashReporter.signature("sync", "HTTP request to https://x.supabase.co/rest/v1/fence_runs?company_id=eq.11111111-2222-3333-4444-555555555555 (GET) failed")
        )
        assertFalse(
            CrashReporter.signature("sync", "push time_entries: 2 of 7 rows rejected") ==
                CrashReporter.signature("sync", "push job_steps: 2 of 7 rows rejected")
        )
    }

    /**
     * postgrest-kt 3.0.2 puts the request headers in every RestException's
     * message, Authorization: Bearer included, so each refused row sent a
     * live access token to app_errors. It never reaches the file.
     */
    @Test
    fun `the access token never reaches the file`() {
        val token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjcmV3LTEyMyIsInJvbGUiOiJhdXRoZW50aWNhdGVkIn0.c2lnbmF0dXJlLXZhbHVl"
        val f = file()
        CrashReporter.appendTo(
            f,
            RuntimeException(
                "new row violates row-level security policy\nHeaders: [Authorization=[Bearer $token], apikey=[sb_publishable_2Wmw]]"
            ),
            false, "sync"
        )
        val text = f.readText()
        assertFalse("the token was written", text.contains(token))
        val parsed = CrashReporter.parse(text).single()
        assertTrue(parsed.message.contains("Bearer <redacted>"))
        assertTrue("the public key is left alone", parsed.message.contains("sb_publishable_2Wmw"))
        assertFalse(parsed.stack.contains(token))
    }

    /**
     * The file on a phone was written by the build it ran before this one,
     * which did not redact: 29 of the 80 app_errors rows from 2026-09-18 to
     * 09-21 carried a live bearer token. Those records are cleaned on the way
     * up, so the fixed build's first launch does not send them as they are.
     */
    @Test
    fun `a record an older build wrote goes up without its token`() {
        val token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjcmV3LTEyMyIsInJvbGUiOiJhdXRoZW50aWNhdGVkIn0.c2lnbmF0dXJlLXZhbHVl"
        val said = "new row violates row-level security policy for table \"payment_records\"\n" +
            "URL: https://x.supabase.co/rest/v1/payment_records\nHeaders: [Authorization=[Bearer $token], apikey=[sb_publishable_2Wmw]]"
        // Byte for byte what 1.502 appended: eight fields, no redaction, no time.
        val sep = Char(1)
        val written = listOf(
            "NONFATAL", "sync", said, "io.github.jan.supabase.exceptions.UnknownRestException: $said\n\tat x.y(Z.kt:1)",
            "crew@example.com", "co-1", "502", "1.502"
        ).joinToString(sep.toString()) + "\n---8<---\n"
        val parsed = CrashReporter.parse(written).single()
        assertTrue("sanity: the old record does hold the token", parsed.message.contains(token) && parsed.stack.contains(token))

        val sent = CrashReporter.forUpload(parsed, "co-now", "now@example.com", 520, "1.520", "Android 15, Relndoo P30")
        assertFalse("the token went up in the message", sent.message.contains(token))
        assertFalse("the token went up in the stack", sent.stack.contains(token))
        assertTrue(sent.message.contains("Bearer <redacted>"))
        assertTrue("the rest of what the server said is kept", sent.message.contains("row-level security policy"))
        // The rest of the record is the record's own, as before.
        assertEquals(502, sent.versionCode)
        assertEquals("1.502", sent.versionName)
        assertEquals("crew@example.com", sent.email)
        assertEquals("co-1", sent.companyId)
        assertEquals("Android 15, Relndoo P30", sent.android)
    }

    /**
     * app_errors.at is when the row ARRIVED: seven 1.512 startup crashes all
     * read 19:32:13, the moment of the upload, and looked like one burst.
     * When it happened is kept with the record and put on top of the stack.
     */
    @Test
    fun `when it happened travels with the record and tops the uploaded stack`() {
        val at = java.time.Instant.parse("2026-09-21T19:05:41Z").toEpochMilli()
        val f = file()
        CrashReporter.appendTo(f, RuntimeException("boom"), true, "", versionCode = 512, versionName = "1.512", recordedAt = at)
        val parsed = CrashReporter.parse(f.readText()).single()
        assertEquals(at, parsed.recordedAt)
        val uploaded = CrashReporter.stackWithTime(parsed.stack, parsed.recordedAt)
        assertTrue(uploaded, uploaded.startsWith("Happened at 2026-09-21T19:05:41Z"))
        assertTrue(uploaded.endsWith(parsed.stack))
        // A record from before the field existed goes up as it was.
        assertEquals(parsed.stack, CrashReporter.stackWithTime(parsed.stack, 0L))
        // And it is never sent as a column: app_errors has none, and an
        // unknown column fails the whole insert.
        val json = kotlinx.serialization.json.Json.encodeToString(CloudError.serializer(), parsed)
        assertFalse(json, json.contains("recorded"))
    }

    /** A run of sync notes must not fill the file so the crash that matters is thrown away. */
    @Test
    fun `sync notes cannot crowd out a fatal crash`() {
        val f = file()
        repeat(40) { CrashReporter.appendTo(f, RuntimeException("note $it"), false, "sync") }
        val notes = CrashReporter.parse(f.readText()).size
        assertTrue("notes took every place ($notes)", notes < 20)
        CrashReporter.appendTo(f, RuntimeException("Unable to create application"), true, "")
        val all = CrashReporter.parse(f.readText())
        assertEquals(notes + 1, all.size)
        assertTrue(all.last().fatal)
    }
}
