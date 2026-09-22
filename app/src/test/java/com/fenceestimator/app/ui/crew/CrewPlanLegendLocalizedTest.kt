package com.fenceestimator.app.ui.crew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Every dot in the crew plan's legend says what it is in the crew's own
 * language.
 *
 * The legend is the whole explanation of a plan drawn from one standalone
 * gate: there is no line on such a plan, so the gate dot is the only thing
 * the legend has left to say. That one label was an English literal while
 * "Fence line & posts" and "Fence coming out" beside it were translated, so
 * a Spanish or French crew phone showed a single English word -- on the one
 * screen that carries the site rules.
 *
 * Read from source, because a Compose legend has no seam to call: what is
 * checked is that no LegendDot in the file is handed a literal. The key
 * itself is covered twice over elsewhere -- the build cannot resolve
 * R.string for a key missing from values/, and StringResourceSanityTest
 * refuses a key that is in one language and not another.
 */
class CrewPlanLegendLocalizedTest {

    private fun screenSource(): String {
        // Unit tests usually run with the module as the working directory;
        // fall back to the repo layout when run from the root.
        val bases = listOf(
            File("src/main/java/com/fenceestimator/app/ui/crew/CrewFencePlanScreen.kt"),
            File("app/src/main/java/com/fenceestimator/app/ui/crew/CrewFencePlanScreen.kt")
        )
        val file = bases.firstOrNull { it.isFile }
            ?: error("could not locate CrewFencePlanScreen.kt from ${File(".").absolutePath}")
        return file.readText()
    }

    /**
     * The argument text of every LegendDot CALL in [source]. The declaration
     * (`fun LegendDot(...)`) is not a call and is left out -- it is the one
     * place the word appears with a `label: String` parameter rather than a
     * value.
     */
    private fun legendDotCalls(source: String): List<String> {
        val calls = mutableListOf<String>()
        val token = "LegendDot("
        var from = 0
        while (true) {
            val at = source.indexOf(token, from)
            if (at < 0) break
            from = at + token.length
            if (at >= 4 && source.regionMatches(at - 4, "fun ", 0, 4)) continue
            var depth = 1
            var i = from
            var inString = false
            while (i < source.length && depth > 0) {
                val c = source[i]
                when {
                    inString && c == '\\' -> i++
                    c == '"' -> inString = !inString
                    !inString && c == '(' -> depth++
                    !inString && c == ')' -> depth--
                }
                i++
            }
            calls += source.substring(from, i - 1)
        }
        return calls
    }

    /** [args] split on the commas that separate arguments, not the ones inside them. */
    private fun topLevelArgs(args: String): List<String> {
        val out = mutableListOf<String>()
        var depth = 0
        var inString = false
        var start = 0
        var i = 0
        while (i < args.length) {
            val c = args[i]
            when {
                inString && c == '\\' -> i++
                c == '"' -> inString = !inString
                !inString && (c == '(' || c == '{' || c == '[') -> depth++
                !inString && (c == ')' || c == '}' || c == ']') -> depth--
                !inString && c == ',' && depth == 0 -> {
                    out += args.substring(start, i)
                    start = i + 1
                }
            }
            i++
        }
        out += args.substring(start)
        return out.map { it.trim() }
    }

    /** The label argument of each call: what the crew actually reads off the dot. */
    private fun labels(source: String): List<String> =
        legendDotCalls(source).map {
            val parts = topLevelArgs(it)
            assertEquals("a LegendDot call with ${parts.size} arguments: $it", 2, parts.size)
            parts[1]
        }

    @Test
    fun `the reader finds calls and tells a literal from a lookup`() {
        // A positive control: without it, a reader that silently found
        // nothing would let every assertion below pass on an empty list.
        val sample = """
            private fun LegendDot(color: Color, label: String) { }
            LegendDot(PlanColors.fenceLine, stringResource(R.string.crew_plan_legend_build))
            LegendDot(PlanColors.gate, "Gate")
            pair.forEach { kind -> LegendDot(PlanColors.marker(kind), kind.label()) }
        """.trimIndent()
        assertEquals(
            listOf("stringResource(R.string.crew_plan_legend_build)", "\"Gate\"", "kind.label()"),
            labels(sample)
        )
    }

    @Test
    fun `every legend dot is labelled from the resources`() {
        val source = screenSource()
        val labels = labels(source)
        // The legend has a build dot, a teardown dot, a gate dot and the
        // marker kinds. Fewer than four means the reader lost its footing,
        // not that the legend shrank.
        assertTrue("found only ${labels.size} LegendDot calls", labels.size >= 4)
        val literal = labels.filter { !it.contains("stringResource(") && !it.endsWith(".label()") }
        assertTrue("legend labels that are not looked up: $literal", literal.isEmpty())
    }

    @Test
    fun `the gate dot names the gate string`() {
        val source = screenSource()
        val gate = legendDotCalls(source)
            .map { topLevelArgs(it) }
            .filter { it[0] == "PlanColors.gate" }
        assertEquals("one gate dot in the legend, found ${gate.size}", 1, gate.size)
        assertEquals("stringResource(R.string.crew_plan_legend_gate)", gate[0][1])
    }
}
