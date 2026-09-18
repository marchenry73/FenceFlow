package com.fenceestimator.app.cloud

import org.junit.Assert.assertEquals
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
}
