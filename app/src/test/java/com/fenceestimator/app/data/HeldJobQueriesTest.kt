package com.fenceestimator.app.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Where a job its person was taken off ([Job.accessEndedAt]) shows up, held
 * to JobDao's queries -- Room runs no annotation processor off device, so the
 * SQL text is what can be checked here:
 *  - not in the job list or the schedule;
 *  - still in getAll, which sync, the uploaders and the sign-out guard read
 *    (its shifts must go up, its unsent edits must still count);
 *  - still openable by id (a running shift on it can be clocked out);
 *  - hidden and brought back without moving updatedAt, and hidden once --
 *    "kept since" does not creep forward on every pass.
 */
class HeldJobQueriesTest {

    private val daos = File("src/main/java/com/fenceestimator/app/data/Daos.kt").readText()

    /** The @Query text on JobDao's function [name]. */
    private fun queryOf(name: String, text: String = daos): String {
        val jobDao = text.substring(text.indexOf("interface JobDao"), text.indexOf("interface FenceRunDao"))
        val fn = Regex("""fun $name\(""").find(jobDao) ?: error("JobDao.$name is gone")
        val query = Regex("""@Query\(\s*"([^"]*)"""").findAll(jobDao.substring(0, fn.range.first)).lastOrNull()
            ?: error("JobDao.$name has no @Query")
        return query.groupValues[1]
    }

    private fun hidesHeld(query: String) = query.contains("accessEndedAt IS NULL")

    @Test
    fun `the list and the schedule leave held jobs out`() {
        assertTrue(hidesHeld(queryOf("observeAll")))
        assertTrue(hidesHeld(queryOf("getScheduledBetween")))
        assertTrue(hidesHeld(queryOf("getVisible")))
        assertTrue(queryOf("observeHeld").contains("accessEndedAt IS NOT NULL"))
    }

    @Test
    fun `sync and opening by id still see them`() {
        assertFalse("getAll hides held jobs -- their shifts would stop uploading", queryOf("getAll").contains("accessEndedAt"))
        assertFalse(queryOf("getById").contains("accessEndedAt"))
        assertFalse(queryOf("observeById").contains("accessEndedAt"))
    }

    @Test
    fun `hiding and bringing back are bookkeeping, and the first time is kept`() {
        val mark = queryOf("markAccessEnded")
        assertTrue("a second pass would move the hide time forward", mark.contains("AND accessEndedAt IS NULL"))
        for (fn in listOf("markAccessEnded", "clearAccessEnded", "clearAllAccessEnded")) {
            assertFalse("$fn moves updatedAt -- every held job would read as edited here", queryOf(fn).contains("updatedAt"))
        }
    }

    // Planted failure: the list query as it was before is caught.
    @Test
    fun `the old job list query would be caught`() {
        val planted = daos.replace(
            "SELECT * FROM jobs WHERE accessEndedAt IS NULL ORDER BY updatedAt DESC",
            "SELECT * FROM jobs ORDER BY updatedAt DESC"
        )
        assertFalse(hidesHeld(queryOf("observeAll", planted)))
    }
}
