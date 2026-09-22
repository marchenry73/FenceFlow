package com.fenceestimator.app.ui.jobs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The gates on the home screen, the settings route and the job screen that
 * live in composables, where no unit test can call them. Read from the
 * source, the way HeldJobQueriesTest holds the DAO's SQL, so the next edit
 * cannot quietly put back what the owner asked to be taken away: a price on
 * a crew phone's job row, a "+" that makes jobs the office never receives, a
 * Settings entry only the owner can reach, a lead picker offered to people
 * the server refuses.
 *
 * Every checker is also run once on the line or block it replaced, which it
 * must fail -- a check that cannot fail proves nothing.
 */
class CrewAccessUiGatesTest {

    private fun src(rel: String): String {
        val bases = listOf(
            File("src/main/java/com/fenceestimator/app"),
            File("app/src/main/java/com/fenceestimator/app")
        )
        val base = bases.firstOrNull { it.isDirectory } ?: error("could not locate sources from ${File(".").absolutePath}")
        // Line endings follow the checkout (core.autocrlf), not the code.
        return File(base, rel).readText().replace("\r\n", "\n")
    }

    /** From [marker] to the brace that closes the one it opens (or the first one after it). */
    private fun block(text: String, marker: String, from: Int = 0): String {
        val start = text.indexOf(marker, from)
        require(start >= 0) { "marker not found: $marker" }
        val open = text.indexOf('{', start)
        var depth = 0
        for (i in open until text.length) {
            when (text[i]) {
                '{' -> depth++
                '}' -> if (--depth == 0) return text.substring(start, i + 1)
            }
        }
        error("unbalanced after $marker")
    }

    private fun allBlocks(text: String, marker: String): List<String> {
        val out = mutableListOf<String>()
        var at = text.indexOf(marker)
        while (at >= 0) {
            out += block(text, marker, at)
            at = text.indexOf(marker, at + marker.length)
        }
        return out
    }

    /** `trailingText =` lines that put money on a row without asking [gate] first. */
    private fun ungatedPrices(text: String, gate: String): List<String> =
        text.lines().map { it.trim() }
            .filter { it.startsWith("trailingText =") && "Money." in it && gate !in it }

    // ---- money on job rows ---------------------------------------------

    @Test
    fun `no job row in the list shows a price without SEE_MONEY`() {
        assertEquals(emptyList<String>(), ungatedPrices(src("ui/jobs/JobsListScreen.kt"), "session.canSeeMoney"))
    }

    @Test
    fun `no row in This Week shows a price without SEE_MONEY`() {
        assertEquals(emptyList<String>(), ungatedPrices(src("ui/jobs/HomeDashboard.kt"), "showMoney"))
    }

    @Test
    fun `the price checker catches the line it replaced -- planted failure`() {
        val before = "                        trailingText = Money.short(jobTotals[job.id] ?: 0.0),"
        assertEquals(1, ungatedPrices(before, "session.canSeeMoney").size)
    }

    // ---- the top bar and the "+" ---------------------------------------

    @Test
    fun `the new-job button is only for someone who can make a job`() {
        val fab = block(src("ui/jobs/JobsListScreen.kt"), "floatingActionButton = {")
        assertTrue(fab.indexOf("session.canEditJobs") in 0 until fab.indexOf("FloatingActionButton("))
    }

    @Test
    fun `the new-job checker fails an ungated button -- planted failure`() {
        val before = "floatingActionButton = {\n FloatingActionButton(onClick = {}) { }\n }"
        val fab = block(before, "floatingActionButton = {")
        assertFalse(fab.indexOf("session.canEditJobs") in 0 until fab.indexOf("FloatingActionButton("))
    }

    @Test
    fun `the customers icon is behind customer contact`() {
        val gated = block(src("ui/jobs/JobsListScreen.kt"), "if (session.canSeeCustomerContact) {")
        assertTrue("onOpenCustomers" in gated)
    }

    @Test
    fun `Settings is in the menu for everyone -- no catalog gate around it`() {
        val text = src("ui/jobs/JobsListScreen.kt")
        assertTrue(text.contains("R.string.jobs_settings"))
        val gates = allBlocks(text, "if (session.canEditCatalogAndSettings) {")
        assertTrue("expected the catalog item's gate", gates.any { "jobs_materials_catalog" in it })
        gates.forEach { assertFalse("Settings is inside a catalog gate", "R.string.jobs_settings" in it) }
    }

    @Test
    fun `the settings checker catches the menu it replaced -- planted failure`() {
        val before = """
            if (session.canEditCatalogAndSettings) {
                DropdownMenu(expanded = moreOpen) {
                    DropdownMenuItem(text = { Text(stringResource(R.string.jobs_materials_catalog)) })
                    DropdownMenuItem(text = { Text(stringResource(R.string.jobs_settings)) })
                }
            }
        """.trimIndent()
        assertTrue(allBlocks(before, "if (session.canEditCatalogAndSettings) {").any { "R.string.jobs_settings" in it })
    }

    // ---- routes ----------------------------------------------------------

    @Test
    fun `the settings route opens a screen for everyone, never a wall`() {
        val settings = block(src("MainActivity.kt"), "composable(Routes.SETTINGS) {")
        assertTrue("PersonalSettingsScreen(" in settings)
        // The full screen is still there for the people who may change the company's settings.
        assertTrue(Regex("(?<![A-Za-z.])SettingsScreen\\(").containsMatchIn(settings))
        assertTrue("session.canEditCatalogAndSettings" in settings)
        assertFalse("AccessGuard(" in settings)
    }

    @Test
    fun `answering access requests is behind SCHEDULE_AND_ASSIGN, asking is not walled`() {
        val main = src("MainActivity.kt")
        val answer = block(main, "composable(Routes.ACCESS_REQUESTS) {")
        assertTrue("session.canScheduleAndAssign" in answer)
        assertTrue("AccessRequestsScreen(" in answer)
        val ask = block(main, "composable(Routes.REQUEST_ACCESS) {")
        assertTrue("RequestAccessScreen(" in ask)
        assertFalse("AccessGuard(" in ask)
    }

    // ---- the job screen ----------------------------------------------------

    @Test
    fun `the lead picker is only editable with SCHEDULE_AND_ASSIGN`() {
        val text = src("ui/jobs/JobDetailScreen.kt")
        val call = text.substring(text.indexOf("CrewFields(\n"), text.indexOf("JobCrewSection("))
        assertTrue(Regex("editable\\s*=\\s*session\\.canScheduleAndAssign\\s*,").containsMatchIn(call))
        assertFalse("canEditJobs" in call.substringAfter("editable").substringBefore(","))
    }

    @Test
    fun `the date moves only with SCHEDULE_AND_ASSIGN`() {
        val text = src("ui/jobs/JobDetailScreen.kt")
        assertTrue(Regex("canMoveDate\\s*=\\s*session\\.canScheduleAndAssign\\s*,").containsMatchIn(text))
    }
}
