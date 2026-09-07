package com.fenceestimator.app.cloud

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * `crew_save_job` raises 42501 when this account may not write jobs at all.
 * Left uncaught, that one refusal threw out of the push loop: every job
 * after it was skipped, the pull never ran, and the raw policy text reached
 * the screen. A refusal is one job held back for retry, counted so the
 * phone never says "everything is backed up" over it.
 *
 * Source-read, for the reason PushChildTableIsolationTest gives.
 */
class CrewSaveJobRefusalTest {

    private fun crewDoor(): String {
        val source = File("src/main/java/com/fenceestimator/app/cloud/JobSync.kt").readText()
        val call = source.indexOf("\"crew_save_job\"")
        assertTrue("crew_save_job is no longer called from JobSync", call >= 0)
        val start = source.lastIndexOf("val accepted", call)
        assertTrue("the crew_save_job call no longer feeds `accepted`", start in 0 until call)
        val end = source.indexOf("if (accepted)", call)
        assertTrue("the accepted check after crew_save_job is gone", end > call)
        return source.substring(start, end)
    }

    @Test
    fun `a refusal from the pen is caught and classified, not thrown out of the pass`() {
        val door = crewDoor()
        assertTrue("crew_save_job is not wrapped in runCatching", door.contains("runCatching"))
        assertTrue(
            "a refusal is not told apart from a real failure (isNotOursToSync)",
            door.contains("isNotOursToSync(")
        )
        assertTrue("a real failure must still propagate", door.contains("throw e"))
        assertTrue("a refused job is not counted as held back", door.contains("heldBack++"))
    }

    @Test
    fun `held-back jobs travel on the result`() {
        val r = SyncResult(uploaded = 2, downloaded = 0, heldBack = 3)
        assertEquals(3, r.heldBack)
        assertEquals(0, SyncResult(0, 0).heldBack)
    }

    @Test
    fun `the auto sync counts held-back jobs as work not yet backed up`() {
        val source = File("src/main/java/com/fenceestimator/app/cloud/AutoSync.kt").readText()
        val at = source.indexOf("val somethingHeldBack")
        assertTrue(at >= 0)
        val expr = source.substring(at, source.indexOf("SyncState(", at))
        assertTrue(
            "somethingHeldBack ignores JobSync's heldBack count",
            expr.contains("heldBack > 0")
        )
    }
}
