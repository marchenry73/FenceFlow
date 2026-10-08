package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.MaterialRole
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.GateMarker
import com.fenceestimator.app.geometry.GateMounting
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE POSTS THE TAKEOFF LISTS ARE THE POSTS THE QUOTE BILLS.
 *
 * Two separate answers to "how many posts" live in this engine, and they are
 * both right about different questions:
 *
 *   - computePostCounts is the GROUND: line + corner + end + gate posts, and
 *     a gate contributes two of them (one for LATCHES_TO_WALL, three for
 *     LINE_TO_WALL). It is what the concrete and the caps are worked out from.
 *   - gateAreaEntries is the ORDER: the hinge side is a GATE_POST, the latch
 *     side an END_POST where a fence reaches it and a BLANK_POST where nothing
 *     does. It is what the line items are priced from.
 *
 * The takeoff used to print the first split above line items built from the
 * second, so a fence with two ends and two line gates read "End posts 2, Gate
 * posts 2" over "End Post x4, Gate Post x2". One screen, two answers, and the
 * smaller one is the one somebody orders from.
 *
 * It prints the second split now. These tests pin the thing that makes that
 * safe: the two agree on the TOTAL, for every mounting. A new mounting that
 * bills a post the count does not know about fails here instead of quietly
 * putting a post in the ground that nobody buys, or buying one that never
 * goes in.
 */
class PostCountsMatchTheBillTest {

    private val POST_ROLES = listOf(
        MaterialRole.LINE_POST, MaterialRole.CORNER_POST,
        MaterialRole.END_POST, MaterialRole.GATE_POST, MaterialRole.BLANK_POST
    )

    private fun run(feet: Float, gates: List<GateMarker> = emptyList()) = FenceRun(
        jobId = 1,
        fenceType = FenceType.VINYL,
        manualLinearFeet = feet,
        gatesEncoded = FenceCodec.encodeGates(gates),
        panelWidthFt = 6f,
        postSpacingFt = 6f,
    )

    private fun suggestions(r: FenceRun) = EstimateEngine.suggestQuantities(r, pixelsPerFoot = 0f)

    private fun billedPosts(r: FenceRun): Double =
        suggestions(r).entries.filter { it.role in POST_ROLES }.sumOf { it.quantity }

    private fun takeoff(r: FenceRun, labelStartsWith: String): Double =
        suggestions(r).takeoff.firstOrNull { it.label.startsWith(labelStartsWith) }?.quantity ?: 0.0

    private fun gate(mounting: GateMounting) = GateMarker(0f, 0f, 4f, mounting)

    /**
     * Every mounting, against a fence and standing on its own. Each case is
     * named so a failure says which mounting broke rather than just a number.
     */
    @Test
    fun `the ground and the order agree on the total, for every mounting`() {
        val cases = mutableListOf<Pair<String, FenceRun>>()
        cases += "plain fence, no gate" to run(96f)
        for (m in GateMounting.values()) {
            cases += "$m on a fence" to run(96f, listOf(gate(m)))
            cases += "$m with no fence drawn" to run(0f, listOf(gate(m)))
            cases += "two of $m on a fence" to run(96f, listOf(gate(m), gate(m)))
        }
        for ((name, r) in cases) {
            val total = takeoff(r, "Total posts")
            val billed = billedPosts(r)
            assertEquals(
                "$name: the takeoff totals $total posts and the quote bills $billed",
                total, billed, 0.001
            )
        }
    }

    /**
     * A CONTROL. Without this, the test above passes just as happily if the
     * takeoff totalled nothing and the bill billed nothing -- which is exactly
     * the shape of failure this repo keeps finding, an empty answer reading as
     * good news. Every case must put real posts in the ground.
     */
    @Test
    fun `every case counts some posts`() {
        for (m in GateMounting.values()) {
            val onFence = billedPosts(run(96f, listOf(gate(m))))
            assertTrue("$m on a fence billed $onFence posts", onFence >= 3.0)
            val alone = billedPosts(run(0f, listOf(gate(m))))
            assertTrue("$m standing alone billed $alone posts", alone >= 1.0)
        }
    }

    /**
     * His own example, 7 Oct 2026: "End posts 4 (2 gate)". Two fence ends plus
     * the latch post of each of two line-mounted gates.
     */
    @Test
    fun `end posts count the latch posts and the label says how many`() {
        val twoGates = run(96f, listOf(gate(GateMounting.LINE), gate(GateMounting.LINE)))
        val line = suggestions(twoGates).takeoff.first { it.label.startsWith("End posts") }
        assertEquals("End posts (2 gate)", line.label)
        assertEquals(4.0, line.quantity, 0.001)

        // One post per gate carries the gate; the stiffener is not one of them.
        assertEquals(2.0, takeoff(twoGates, "Gate posts"), 0.001)
    }

    /** No gate, no parenthetical: a plain fence's label stays plain. */
    @Test
    fun `a fence with no gate says just End posts`() {
        val plain = run(96f)
        val line = suggestions(plain).takeoff.first { it.label.startsWith("End posts") }
        assertEquals("End posts", line.label)
        assertEquals(2.0, line.quantity, 0.001)
    }

    /**
     * A gate standing on nothing buys two blank posts and no end posts -- there
     * is no fence for either to be the end of. The label must not claim a gate
     * share of a count that is zero, because the zero line is dropped from the
     * takeoff entirely and startsWith("End posts") would then match nothing.
     */
    @Test
    fun `a standalone gate lists blanks and no ends`() {
        val alone = run(0f, listOf(gate(GateMounting.LINE)))
        val labels = suggestions(alone).takeoff.map { it.label }
        assertTrue("saw $labels", labels.none { it.startsWith("End posts") })
        assertEquals(2.0, takeoff(alone, "Blank posts"), 0.001)
    }
}
