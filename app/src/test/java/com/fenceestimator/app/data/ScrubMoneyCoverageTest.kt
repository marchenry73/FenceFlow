package com.fenceestimator.app.data

import com.fenceestimator.app.cloud.MONEY_KEYS
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * [JobDao.scrubMoney] -- what Repository.forgetMoney runs the moment a phone
 * is confirmed DENIED -- resets every [MONEY_KEYS] column that [Job] holds.
 *
 * The two lists are kept side by side by hand, and they drifted: accepted_total
 * joined MONEY_KEYS with the price stability change and the scrub was never
 * told, so a phone demoted to crew kept every customer's accepted price on
 * disk -- and the crew adoption merges with keepMoney, which then held it for
 * good. This reads the query out of Daos.kt and fails for any money column
 * with a Job field that the query does not set.
 */
class ScrubMoneyCoverageTest {

    /**
     * The SQL of JobDao.scrubMoney's @Query, string pieces joined.
     *
     * COMMENTS ARE STRIPPED FIRST, and that is not tidiness. This rebuilds the
     * query from every quoted run between @Query( and the function, so a
     * comment in that block containing a quoted phrase was spliced into the
     * SQL -- and because the pieces are joined with no separator, it glued
     * itself to the front of the next column name. On 22 Oct that turned
     * `depositIsAuto = 0` into `...figuredepositIsAuto = 0`, the word boundary
     * went, and this file reported a money column as unscrubbed when the
     * scrub was right. An alarm that cries breach over a comment is worse than
     * no alarm: the next real one gets argued with.
     */
    private fun scrubQuery(source: String): String {
        val at = source.indexOf("suspend fun scrubMoney(): Int")
        assertTrue("JobDao.scrubMoney not found in Daos.kt -- if it moved, move this test with it", at > 0)
        val queryStart = source.lastIndexOf("@Query(", at)
        val body = source.substring(queryStart, at)
            .lines().joinToString("\n") { it.substringBefore("//") }
        return Regex("\"([^\"]*)\"").findAll(body).joinToString("") { it.groupValues[1] }
    }

    private fun camel(key: String): String =
        key.split('_').mapIndexed { i, part -> if (i == 0) part else part.replaceFirstChar { it.uppercase() } }.joinToString("")

    /** The MONEY_KEYS columns that exist on [Job], as its field names. */
    private val jobMoneyFields: List<String> by lazy {
        val fields = Job::class.java.declaredFields.map { it.name }.toSet()
        MONEY_KEYS.map(::camel).filter { it in fields }
    }

    private fun unscrubbed(query: String): List<String> =
        jobMoneyFields.filterNot { Regex("\\b$it\\s*=").containsMatchIn(query) }

    @Test
    fun `every money column the job holds is reset by the scrub`() {
        val query = scrubQuery(File("src/main/java/com/fenceestimator/app/data/Daos.kt").readText())
        assertTrue("parsed nothing -- the parser, not the query, is broken", query.startsWith("UPDATE jobs SET"))
        assertTrue("the money columns were not found on Job -- the name mapping is broken", jobMoneyFields.size >= 20)
        assertTrue("acceptedTotal is a money column the scrub must reset", "acceptedTotal" in jobMoneyFields)
        assertTrue(
            "JobDao.scrubMoney leaves money on a demoted phone: ${unscrubbed(query)}",
            unscrubbed(query).isEmpty()
        )
    }

    @Test
    fun `CANARY a quoted phrase in a comment cannot fake a missing column`() {
        // The exact shape that fired on 22 Oct: a comment between the string
        // pieces, carrying a quoted phrase, directly above a column line.
        val fake = """
            @Query(
                "UPDATE jobs SET " +
                    // a comment saying "somebody chose this figure" about it
                    "depositAmount = 0.0"
            )
            suspend fun scrubMoney(): Int
        """.trimIndent()
        val q = scrubQuery(fake)
        assertFalse("the comment's words reached the SQL", q.contains("somebody"))
        assertTrue("the column after the comment lost its word boundary: " + q,
            Regex("\\bdepositAmount\\s*=").containsMatchIn(q))
    }

    @Test
    fun `the check sees a column missing from the scrub -- planted failure`() {
        val query = scrubQuery(File("src/main/java/com/fenceestimator/app/data/Daos.kt").readText())
        // The query as it was before this fix: no acceptedTotal.
        val before = query.replace(Regex("acceptedTotal\\s*=\\s*NULL,\\s*"), "")
        assertFalse(before.contains("acceptedTotal"))
        assertTrue(unscrubbed(before) == listOf("acceptedTotal"))
    }
}
