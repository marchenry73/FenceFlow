package com.fenceestimator.app.cloud

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The strings here are copied out of the live database, not invented.
 *
 * The bug this guards against was invisible: `Instant.parse` rejects a numeric
 * offset on Android's java.time, every call site swallowed the exception, and
 * the failure looked exactly like "the server sent no date". The result was a
 * phone that pushed forever and never pulled.
 */
class CloudTimeTest {

    /** Exactly what `select updated_at from jobs` returned over PostgREST. */
    @Test
    fun `postgres timestamptz with a numeric offset parses`() {
        val millis = CloudTime.parseMillis("2026-08-16T04:05:06.631429+00:00")
        assertNotNull("a real server timestamp must not read as 'no date'", millis)
        assertEquals(1786853106631L, millis)
    }

    /** What the app itself writes, via Instant.toString(). */
    @Test
    fun `the Z form we send up still parses`() {
        assertEquals(1786853106631L, CloudTime.parseMillis("2026-08-16T04:05:06.631Z"))
    }

    /** Postgres' own text output uses a space and a two-digit offset. */
    @Test
    fun `space separated with a two digit offset parses`() {
        assertEquals(1786853106631L, CloudTime.parseMillis("2026-08-16 04:05:06.631+00"))
    }

    @Test
    fun `a non-UTC offset is honoured rather than assumed`() {
        // 04:05:06 at -04:00 is 08:05:06 UTC -- four hours later, not the same instant.
        val eastern = CloudTime.parseMillis("2026-08-16T04:05:06.631-04:00")!!
        val utc = CloudTime.parseMillis("2026-08-16T04:05:06.631Z")!!
        assertEquals(4 * 60 * 60 * 1000L, eastern - utc)
    }

    /** A bare timestamp is UTC, because that is what the server keeps. */
    @Test
    fun `a timestamp with no zone is read as UTC`() {
        assertEquals(
            CloudTime.parseMillis("2026-08-16T04:05:06.631Z"),
            CloudTime.parseMillis("2026-08-16 04:05:06.631")
        )
    }

    @Test
    fun `whole seconds parse`() {
        assertEquals(1786853106000L, CloudTime.parseMillis("2026-08-16T04:05:06+00:00"))
    }

    @Test
    fun `genuinely absent stays absent`() {
        assertNull(CloudTime.parseMillis(null))
        assertNull(CloudTime.parseMillis(""))
        assertNull(CloudTime.parseMillis("   "))
        assertNull(CloudTime.parseMillis("not a date"))
    }

    @Test
    fun `what we write is what we can read back`() {
        val now = 1786853106631L
        assertEquals(now, CloudTime.parseMillis(CloudTime.format(now)))
    }
}
