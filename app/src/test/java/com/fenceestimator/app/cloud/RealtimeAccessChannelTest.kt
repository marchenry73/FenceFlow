package com.fenceestimator.app.cloud

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The change feed on job_assignments / job_access_requests lives on its own
 * channel, and only once the server has those tables.
 *
 * Realtime sets up every table a channel names in one join, and one table
 * that does not exist fails the join -- so the two new tables on the main
 * channel, on a database supabase_crew_job_scope.sql has not reached (which
 * is production until it is applied), would silently stop the feed for jobs,
 * payments and shifts on every phone. Source-read, because the thing being
 * guarded is where a table name is written, not anything that runs off
 * device.
 */
class RealtimeAccessChannelTest {

    private val source = File("src/main/java/com/fenceestimator/app/cloud/RealtimeWatcher.kt").readText()

    /**
     * The table names inside `val <name> = listOf(...)`. Line comments are
     * dropped first: LIVE_TABLES carries a comment with a closing bracket in
     * it, and cutting there hid every name after it -- which the planted
     * failure below caught.
     */
    private fun listNamed(text: String, name: String): List<String> {
        val code = text.replace(Regex("//[^\n]*"), "")
        val start = code.indexOf("val $name = listOf(")
        assertTrue("RealtimeWatcher no longer declares $name", start >= 0)
        val body = code.substring(start, code.indexOf(')', start))
        return Regex("\"([a-z_]+)\"").findAll(body).map { it.groupValues[1] }.toList()
    }

    private val accessTables = setOf("job_assignments", "job_access_requests")

    @Test
    fun `the new tables are never on the main channel`() {
        val live = listNamed(source, "LIVE_TABLES")
        assertTrue("LIVE_TABLES looks empty -- the parser is not reading it", live.size >= 5)
        assertTrue(
            "job_assignments / job_access_requests joined LIVE_TABLES: on a database without them the whole " +
                "change feed fails to join",
            live.none { it in accessTables }
        )
    }

    @Test
    fun `they are watched on a channel of their own, only once deployed`() {
        assertEquals(accessTables, listNamed(source, "ACCESS_TABLES").toSet())
        val start = source.indexOf("private suspend fun listenForAccess(")
        assertTrue(start >= 0)
        val body = source.substring(start, source.indexOf("private suspend fun listen(", start))
        assertTrue("the access feed does not wait for a server that has the tables", body.contains("isDeployed"))
        assertTrue("the access feed shares the main channel's topic", body.contains("\"company-\$companyId-access\""))
        assertTrue("a join that never completes is waited on for ever", body.contains("withTimeoutOrNull"))
    }

    // Planted failure: the extractor sees the tables when they are there.
    @Test
    fun `a main channel that named them would be caught`() {
        val planted = source.replace("\"sync_signals\"", "\"sync_signals\", \"job_assignments\"")
        assertFalse(listNamed(planted, "LIVE_TABLES").none { it in accessTables })
    }
}
