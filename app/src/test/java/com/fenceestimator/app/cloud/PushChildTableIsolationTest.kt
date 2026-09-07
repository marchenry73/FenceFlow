package com.fenceestimator.app.cloud

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * `pushJobChildren` used to run six upserts plus the field_changes push back
 * to back inside ONE function, all reachable by ONE throw: the first
 * refusal -- a DENIED phone's line items, once the crew-money policy flips
 * -- threw before punch list, steps, markers or plan-change requests ever
 * got a turn. A crew member's whole day of field work sat on their handset
 * over a table they were never sending in the first place.
 *
 * Reads the source rather than running `pushAll` -- there is no seam this
 * test suite can use to fake the Supabase client (see PullFiltersDeletedTest
 * for the same tradeoff on the pull side, and why: no mocking library is on
 * the test classpath, and `pushAll` talks to a real, lazily-created
 * SupabaseClient). What has to be true structurally: each child table is
 * pushed through its own `step(...)` call inside `pushAll`, not a sequence
 * of upserts sharing one try -- `step` itself already catches per call, so
 * one refusal cannot reach the next statement.
 */
class PushChildTableIsolationTest {

    private fun pushAllSource(): String {
        val source = File("src/main/java/com/fenceestimator/app/cloud/EntitySync.kt").readText()
        val start = source.indexOf("suspend fun pushAll(")
        assertTrue("could not find pushAll in EntitySync.kt -- if it moved, move this test with it", start >= 0)
        val end = source.indexOf("private data class JobChildRows", start)
        assertTrue("could not find the end of pushAll", end > start)
        return source.substring(start, end)
    }

    @Test
    fun `every job-child table pushes through its own step`() {
        val body = pushAllSource()
        listOf(
            "line items", "expenses", "punch list", "change orders",
            "job steps", "site markers", "field changes"
        ).forEach { table ->
            assertTrue(
                "\"$table\" is not pushed through its own step(\"$table\") in pushAll -- " +
                    "one refused table must never be able to stop the others",
                body.contains("step(\"$table\")")
            )
        }
    }

    @Test
    fun `pushJobChildren is gone as a single all-or-nothing function`() {
        val source = File("src/main/java/com/fenceestimator/app/cloud/EntitySync.kt").readText()
        assertTrue(
            "pushJobChildren has come back as a single function -- see this file's class doc " +
                "for why that strands punch list, steps, markers and plan-change requests behind " +
                "one refusal",
            !source.contains("private suspend fun pushJobChildren(")
        )
    }
}
