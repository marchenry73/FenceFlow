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

    /**
     * The text of the nearest `if`/`else if` guarding a `Button` whose
     * `onClick` is [onClickTarget], found by searching backwards from that
     * reference through [body]. Anchoring on whether the guard MENTIONS
     * `allowClockIn` -- rather than matching the guard's exact text -- is
     * what survives a legitimate change like the crew track's own `editable`
     * (guest) term joining this condition: that term changed the literal
     * source of `} else if (allowClockIn) {`, but not the thing this test is
     * actually about, which is whether `allowClockIn` still gates the
     * button at all. This repo has had a source-text probe rot or crash on
     * a missing anchor three times already, so a miss here throws with a
     * message naming what could not be found, instead of quietly reporting
     * a guard that is actually still present as absent.
     */
    private fun conditionGuarding(body: String, onClickTarget: String, label: String): String {
        val clickAt = body.indexOf("onClick = $onClickTarget")
        assertTrue(
            "`onClick = $onClickTarget` was not found in $label -- has the control been renamed or removed?",
            clickAt > 0
        )
        val windowStart = (clickAt - 600).coerceAtLeast(0)
        val window = body.substring(windowStart, clickAt)
        val guard = Regex("""(?:else\s+)?if\s*\(([^()]{1,160}?)\)""").findAll(window).lastOrNull()
        assertTrue(
            "no `if (...)` guarding `onClick = $onClickTarget` was found in the " +
                "${clickAt - windowStart} characters before it in $label -- the button may no " +
                "longer sit directly inside the condition that decides whether it is shown",
            guard != null
        )
        return guard!!.groupValues[1]
    }

    @Test
    fun `clock-out stays, clock-in does not, and the way back in is offered`() {
        assertTrue(
            "TimeClockCard is no longer wired from !kept at the call site",
            screen.contains("allowClockIn = !kept")
        )

        // Clock-out stays: ending a running shift must not additionally be
        // turned off by allowClockIn (kept-ness) -- only by editable (the
        // guest demo).
        val clockOutGuard = conditionGuarding(screen, "onClockOut", "CrewJobScreen")
        assertFalse(
            "Clock Out's guard (\"$clockOutGuard\") now mentions allowClockIn -- a kept job " +
                "(where clock-in is disallowed) would also lose the ability to end a running shift",
            clockOutGuard.contains("allowClockIn")
        )

        // Clock-in does not: starting a new shift must still be refused once
        // allowClockIn is false, whatever else joins that condition.
        val clockInGuard = conditionGuarding(screen, "onClockIn", "CrewJobScreen")
        assertTrue(
            "Clock In's guard (\"$clockInGuard\") no longer mentions allowClockIn -- a kept job " +
                "could offer starting a new shift on a job this person is off",
            clockInGuard.contains("allowClockIn")
        )

        assertTrue(
            "the way back in (request access) is no longer wired on the kept-job screen",
            screen.contains("onClick = onOpenRequestAccess")
        )
        val main = File("src/main/java/com/fenceestimator/app/MainActivity.kt").readText()
        assertTrue(
            "MainActivity does not wire the crew screen's request access",
            main.contains("onOpenRequestAccess = { navController.navigate(Routes.REQUEST_ACCESS) }")
        )
    }

    @Test
    fun `a refused stage move on a job no longer theirs is said in the phone's words`() {
        assertTrue(vm.contains("if (isNotYourJobRefusal(e)) UiMessage(R.string.crew_stage_not_yours)"))
    }
}
