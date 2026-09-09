package com.fenceestimator.app.cloud

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Time entries were the one job child still read from the base table on
 * every scope. `time_entries_read` is "same company", so a crew phone pulled
 * every colleague's shift with its hourly rate attached, and the rate landed
 * in Room -- the exact thing stage two exists to stop, on the one table the
 * stage-two commit forgot.
 *
 * Reads the source, for the reason PushChildTableIsolationTest gives: there
 * is no seam for faking the Supabase client in this suite. What has to be
 * true structurally: the read is gated on scope, DENIED reads the money-free
 * view, and no branch copies `row.hourlyRate` without asking ALLOWED first.
 */
class TimeEntriesScopeTest {

    private fun timeEntriesSection(): String {
        val source = File("src/main/java/com/fenceestimator/app/cloud/EntitySync.kt").readText()
        // Anchored on the table NAME, not on the call shape. The read used to
        // be a chained from("time_entries_crew"); it is now that same name
        // handed to the paged reader. Anchoring on the name survives either.
        val start = source.indexOf("\"time_entries_crew\"")
        assertTrue(
            "pullJobChildren no longer reads time_entries_crew for a DENIED phone -- " +
                "the base table carries every colleague's pay rate",
            start >= 0
        )
        val end = source.indexOf("\"job_steps\"", start)
        assertTrue("could not find the job_steps read that follows time entries", end > start)
        // Back up to the guard that opens the block.
        val guard = source.lastIndexOf("if (scope != MoneyScope.UNKNOWN)", start)
        assertTrue("the time_entries read is not inside an UNKNOWN guard", guard >= 0)
        return source.substring(guard, end)
    }

    @Test
    fun `an UNKNOWN phone does not read time entries at all`() {
        val section = timeEntriesSection()
        // The guard found by lastIndexOf must belong to this block, not to the
        // change-orders block above it: no other table read may sit between.
        val between = section.substringBefore("from(\"time_entries_crew\")")
        assertFalse(
            "another table's read sits between the UNKNOWN guard and the time_entries read; " +
                "time entries have lost their own guard",
            between.contains("\"change_orders") || between.contains("\"estimate_line_items")
        )
    }

    @Test
    fun `a DENIED phone reads the view and an ALLOWED phone the table`() {
        val section = timeEntriesSection()
        assertTrue(section.contains("if (scope == MoneyScope.DENIED)"))
        // The base table is still the ALLOWED branch. Written as an else on the
        // table name now rather than a second from(), so match the name.
        assertTrue(section.contains("\"time_entries\""))
    }

    @Test
    fun `no branch copies a cloud hourly rate without asking ALLOWED first`() {
        val section = timeEntriesSection()
        val bare = Regex("""hourlyRate\s*=\s*row\.hourlyRate""")
        assertFalse(
            "a time-entry branch copies row.hourlyRate unconditionally -- on a DENIED phone " +
                "that is a colleague's pay rate landing in Room",
            bare.containsMatchIn(section)
        )
        assertTrue(
            "the ALLOWED gate on hourlyRate is gone",
            section.contains("if (scope == MoneyScope.ALLOWED) row.hourlyRate")
        )
    }
}
