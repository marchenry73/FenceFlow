package com.fenceestimator.app.geometry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Cutting one side in two so part of it can be a different height
 * ([RunSplit]).
 *
 * THE PROPERTY THAT MATTERS IS CONSERVATION. A cut is meant to change a height
 * and nothing else, so the two pieces together have to measure exactly what the
 * one side measured. Footage is what the price is made of: a cut that loses or
 * invents a foot moves the quote, and it moves it quietly -- the plan still
 * draws, the takeoff still runs, and the only sign is a total that is no longer
 * the total he gave the customer. Every case below asserts the sum.
 */
class RunSplitTest {

    private val pxPerFt = 10f
    private fun p(x: Float, y: Float) = FencePoint(x, y)
    private fun gate(x: Float, y: Float, w: Float) = GateMarker(x, y, w)

    /** Straight 20 ft side, left to right. */
    private val straight = listOf(p(0f, 0f), p(200f, 0f))

    /** An L: 10 ft east, then 10 ft south. */
    private val ell = listOf(p(0f, 0f), p(100f, 0f), p(100f, 100f))

    /** A closed 10 ft square: 40 ft of fence, the fourth side drawn by the flag. */
    private val square = listOf(p(0f, 0f), p(100f, 0f), p(100f, 100f), p(0f, 100f))

    @Test
    fun `a straight side cuts where he asked, and the two pieces add back up`() {
        val plan = RunSplit.plan(straight, emptyList(), false, atFeet = 8f, pixelsPerFoot = pxPerFt)
        assertTrue("a plain cut on a plain side was refused", plan.ok)
        assertEquals(8f, plan.firstFeet, 0.01f)
        assertEquals(12f, plan.secondFeet, 0.01f)
        assertEquals(20f, plan.firstFeet + plan.secondFeet, 0.01f)
        // The pieces MEET: the far one starts where the near one ends, so the
        // takeoff has no gap to not bill.
        assertEquals(plan.first.last(), plan.second.first())
        assertEquals(p(80f, 0f), plan.first.last())
    }

    @Test
    fun `cutting past the corner of an L keeps the corner on the near piece`() {
        val plan = RunSplit.plan(ell, emptyList(), false, atFeet = 15f, pixelsPerFoot = pxPerFt)
        assertTrue(plan.ok)
        assertEquals(listOf(p(0f, 0f), p(100f, 0f), p(100f, 50f)), plan.first)
        assertEquals(listOf(p(100f, 50f), p(100f, 100f)), plan.second)
        assertEquals(20f, plan.firstFeet + plan.secondFeet, 0.01f)
    }

    @Test
    fun `a cut that lands on a corner uses the corner instead of adding a point beside it`() {
        // 10 ft is exactly the L's corner. A new point a hair away from an
        // existing one reads as a stray vertex on the plan and classifies as a
        // 0-degree line post -- a post billed for a bend that is not there.
        val plan = RunSplit.plan(ell, emptyList(), false, atFeet = 10f, pixelsPerFoot = pxPerFt)
        assertTrue(plan.ok)
        assertEquals(2, plan.first.size)
        assertEquals(2, plan.second.size)
        assertEquals(listOf(p(0f, 0f), p(100f, 0f)), plan.first)
        assertEquals(listOf(p(100f, 0f), p(100f, 100f)), plan.second)
        assertEquals(20f, plan.firstFeet + plan.secondFeet, 0.01f)
    }

    @Test
    fun `just off a corner still snaps to it, and the far side of the snap too`() {
        val near = RunSplit.plan(ell, emptyList(), false, atFeet = 9.9f, pixelsPerFoot = pxPerFt)
        val past = RunSplit.plan(ell, emptyList(), false, atFeet = 10.1f, pixelsPerFoot = pxPerFt)
        assertEquals("a cut 0.1 ft short of the corner added a point", 2, near.first.size)
        assertEquals("a cut 0.1 ft past the corner added a point", 2, past.first.size)
        // Snapped, so BOTH report the corner's distance rather than the asked-for
        // one. That is the honest reading: the cut is at the corner.
        assertEquals(10f, near.firstFeet, 0.01f)
        assertEquals(10f, past.firstFeet, 0.01f)
    }

    @Test
    fun `a closed loop cuts into two open sides and the perimeter survives`() {
        val plan = RunSplit.plan(square, emptyList(), true, atFeet = 15f, pixelsPerFoot = pxPerFt)
        assertTrue(plan.ok)
        // A loop cut ONCE is one line, not two: the far piece has to carry the
        // closing stretch itself, by ending back at the first point.
        assertEquals(p(0f, 0f), plan.second.last())
        assertEquals(15f, plan.firstFeet, 0.01f)
        assertEquals(25f, plan.secondFeet, 0.01f)
        assertEquals(
            "the square's 40 ft perimeter did not survive the cut",
            40f, plan.firstFeet + plan.secondFeet, 0.01f
        )
    }

    @Test
    fun `a loop cut on the closing stretch itself still conserves the perimeter`() {
        // 35 ft is on the fourth wall, the one drawn by the flag rather than by
        // a point. SegmentErase deliberately knows nothing about that stretch;
        // this has to.
        val plan = RunSplit.plan(square, emptyList(), true, atFeet = 35f, pixelsPerFoot = pxPerFt)
        assertTrue(plan.ok)
        assertEquals(35f, plan.firstFeet, 0.01f)
        assertEquals(5f, plan.secondFeet, 0.01f)
        assertEquals(40f, plan.firstFeet + plan.secondFeet, 0.01f)
        assertEquals(p(0f, 0f), plan.second.last())
    }

    @Test
    fun `gates go with the side their centre is on`() {
        val gates = listOf(gate(40f, 0f, 3f), gate(160f, 0f, 4f))
        val plan = RunSplit.plan(straight, gates, false, atFeet = 10f, pixelsPerFoot = pxPerFt)
        assertTrue(plan.ok)
        assertEquals(listOf(gates[0]), plan.firstGates)
        assertEquals(listOf(gates[1]), plan.secondGates)
        // Not one lost between them: a gate that fell off would take its posts,
        // its hardware and its price with it.
        assertEquals(gates.size, plan.firstGates.size + plan.secondGates.size)
    }

    @Test
    fun `a cut inside a gate says so and does NOT move itself`() {
        val wide = gate(100f, 0f, 4f)
        val plan = RunSplit.plan(straight, listOf(wide), false, atFeet = 10f, pixelsPerFoot = pxPerFt)
        assertTrue(plan.ok)
        assertNotNull("the cut fell inside a 4 ft opening and nothing said so", plan.cutsThroughGate)
        // THE NUMBER HE TYPED IS THE NUMBER HE GETS. Sliding the cut to the
        // gate's edge would move the footage a few feet with no mention.
        assertEquals(10f, plan.firstFeet, 0.01f)
        assertEquals(10f, plan.secondFeet, 0.01f)
        // And the gate is whole, on one side.
        assertEquals(1, plan.firstGates.size + plan.secondGates.size)
    }

    @Test
    fun `a cut clear of every gate reports no gate`() {
        val plan = RunSplit.plan(
            straight, listOf(gate(40f, 0f, 3f)), false, atFeet = 12f, pixelsPerFoot = pxPerFt
        )
        assertTrue(plan.ok)
        assertNull(plan.cutsThroughGate)
    }

    @Test
    fun `corner distances are the corners and not the far end`() {
        assertEquals(listOf(10f), RunSplit.cornerDistancesFeet(ell, false, pxPerFt))
        // A straight side has no corner to offer.
        assertTrue(RunSplit.cornerDistancesFeet(straight, false, pxPerFt).isEmpty())
        // A closed square: three corners reachable, the fourth IS the start.
        assertEquals(
            listOf(10f, 20f, 30f),
            RunSplit.cornerDistancesFeet(square, true, pxPerFt)
        )
    }

    @Test
    fun `an uncalibrated drawing is refused rather than measured as zero`() {
        for (bad in listOf(0f, -4f, Float.NaN)) {
            val plan = RunSplit.plan(straight, emptyList(), false, atFeet = 8f, pixelsPerFoot = bad)
            assertFalse("pixelsPerFoot=$bad produced a usable plan", plan.ok)
            assertEquals(RunSplit.Refusal.NOT_MEASURABLE, plan.refusal)
        }
    }

    @Test
    fun `a cut off the end of the side is refused, both ends`() {
        for (at in listOf(0f, 0.1f, 20f, 25f, 19.9f)) {
            val plan = RunSplit.plan(straight, emptyList(), false, atFeet = at, pixelsPerFoot = pxPerFt)
            assertFalse("a cut at $at ft on a 20 ft side produced a usable plan", plan.ok)
            assertEquals(RunSplit.Refusal.TOO_SHORT, plan.refusal)
        }
    }

    @Test
    fun `a typed side splits into the figure he asked for and the rest`() {
        val plan = RunSplit.planTyped(totalFeet = 100f, atFeet = 40f)
        assertTrue(plan.ok)
        assertEquals(40f, plan.firstFeet, 0.001f)
        assertEquals(60f, plan.secondFeet, 0.001f)
        assertEquals(100f, plan.firstFeet + plan.secondFeet, 0.001f)

        assertFalse(RunSplit.planTyped(100f, 0f).ok)
        assertFalse(RunSplit.planTyped(100f, 100f).ok)
        assertFalse(RunSplit.planTyped(0.5f, 0.25f).ok)
        assertFalse(RunSplit.planTyped(Float.NaN, 10f).ok)
    }

    @Test
    fun `the far piece is named beside the side it came from, and never over it`() {
        assertEquals("Side 1 part 2", RunSplit.splitLabel("Side 1", listOf("Side 1", "Side 2")))
        // Split again: part 3, not a second part 2 sharing a name with the first.
        assertEquals(
            "Side 1 part 3",
            RunSplit.splitLabel("Side 1", listOf("Side 1", "Side 1 part 2"))
        )
        // Case and padding do not make a name free.
        assertEquals(
            "Side 1 part 3",
            RunSplit.splitLabel("Side 1", listOf("  side 1 PART 2  "))
        )
        // An unnamed side still produces a readable name rather than " part 2".
        assertEquals("Side part 2", RunSplit.splitLabel("   ", emptyList()))
    }

    @Test
    fun `POSITIVE CONTROL -- a refusal is not silently a plan, and ok is not always true`() {
        // Every test above that asserts a refusal would also pass if `ok` were
        // hard-wired false, and every test that asserts a plan would pass if it
        // were hard-wired true. Both directions asserted here, on one side, so
        // neither reading can be a constant.
        val good = RunSplit.plan(straight, emptyList(), false, 8f, pxPerFt)
        val bad = RunSplit.plan(straight, emptyList(), false, 800f, pxPerFt)
        assertTrue(good.ok)
        assertFalse(bad.ok)
        // A refused plan carries nothing to act on. Returning the whole side as
        // `first` with an empty `second` would read as a successful no-op cut.
        assertTrue(bad.first.isEmpty())
        assertTrue(bad.second.isEmpty())
    }
}
