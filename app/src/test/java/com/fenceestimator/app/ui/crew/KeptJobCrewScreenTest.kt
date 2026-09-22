package com.fenceestimator.app.ui.crew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * A job kept on the phone after its person was taken off it opens on the crew
 * screen so a running shift can be clocked out -- and nothing else there may
 * pretend the job can still be worked. The stage buttons were still offered,
 * the server refused them (42501), and the refusal reached the screen in the
 * server's English. The design's "request access" way back in was missing.
 */
class KeptJobCrewScreenTest {

    // ---- the refusal, in the phone's own words ----

    @Test
    fun `the crew-scope guard's refusal is recognised, through the cause chain`() {
        assertTrue(isNotYourJobRefusal(RuntimeException("This job is not assigned to you.")))
        assertTrue(isNotYourJobRefusal(RuntimeException("rpc failed", RuntimeException("This job is not assigned to you."))))
    }

    @Test
    fun `other stage refusals are still shown as the server wrote them -- canary`() {
        assertFalse(isNotYourJobRefusal(RuntimeException("That job is not approved yet.")))
        assertFalse(isNotYourJobRefusal(RuntimeException("Unknown stage")))
    }

    @Test
    fun `the sentence matched is the one the SQL raises`() {
        val sql = listOf(File("../supabase_crew_job_scope.sql"), File("supabase_crew_job_scope.sql")).first { it.exists() }.readText()
        val raised = Regex("""raise exception '([^']*not assigned to you[^']*)' using errcode = '42501'""").find(sql)
        assertTrue("crew_job_guard no longer raises the sentence isNotYourJobRefusal matches", raised != null)
        assertTrue(isNotYourJobRefusal(RuntimeException(raised!!.groupValues[1])))
    }

    // ---- the screen ----

    private val screen = File("src/main/java/com/fenceestimator/app/ui/crew/CrewJobScreen.kt").readText()
    private val vm = File("src/main/java/com/fenceestimator/app/ui/crew/CrewJobViewModel.kt").readText()

    @Test
    fun `a kept job is known from the job row itself`() {
        assertTrue(screen.contains("val kept = currentJob.accessEndedAt != null"))
    }

    @Test
    fun `the stage card, checklists, sign-off, photos and complete are all inside the not-kept block`() {
        val start = screen.indexOf("if (!kept) {")
        assertTrue("no not-kept block", start > 0)
        // The block closes where the LazyColumn's own items end.
        val block = screen.substring(start, screen.indexOf("private fun TimeClockCard("))
        for (piece in listOf("JobStageCard(", "StepSection(", "FinalSignOffCard(", "cameraLauncher.launch(", "viewModel.markJobComplete()")) {
            assertTrue("$piece is offered on a kept job", block.contains(piece))
        }
        // Each appears exactly once in the screen body, so none survives outside the block.
        val body = screen.substring(0, screen.indexOf("private fun TimeClockCard("))
        for (piece in listOf("JobStageCard(", "FinalSignOffCard(", "viewModel.markJobComplete()")) {
            assertEquals("$piece appears outside the not-kept block", 1, Regex(Regex.escape(piece)).findAll(body).count())
        }
    }

    @Test
    fun `clock-out stays, clock-in does not, and the way back in is offered`() {
        assertTrue(screen.contains("allowClockIn = !kept"))
        assertTrue(screen.contains("} else if (allowClockIn) {"))
        assertTrue(screen.contains("onClick = onOpenRequestAccess"))
        val main = File("src/main/java/com/fenceestimator/app/MainActivity.kt").readText()
        assertTrue("MainActivity does not wire the crew screen's request access", main.contains("onOpenRequestAccess = { navController.navigate(Routes.REQUEST_ACCESS) }"))
    }

    @Test
    fun `a refused stage move on a job no longer theirs is said in the phone's words`() {
        assertTrue(vm.contains("if (isNotYourJobRefusal(e)) UiMessage(R.string.crew_stage_not_yours)"))
    }
}
