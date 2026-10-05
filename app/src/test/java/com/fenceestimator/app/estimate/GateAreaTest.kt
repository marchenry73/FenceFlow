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
 * What a gate area is built from depends on where the gate hangs.
 *
 * Getting this wrong is a truck going back to the yard, so each case is pinned
 * separately. The wall case is the one the old code got most wrong: it charged
 * concrete for every gate, including gates that are bolted to a wall and never
 * touch the ground.
 */
class GateAreaTest {

    /** A 100 ft straight run with one gate of the given mounting. */
    private fun runWithGate(mounting: GateMounting, widthFt: Float = 4f): FenceRun {
        val points = FenceCodec.encodePoints(
            listOf(
                com.fenceestimator.app.geometry.FencePoint(0f, 0f),
                com.fenceestimator.app.geometry.FencePoint(2000f, 0f)
            )
        )
        return FenceRun(
            jobId = 1,
            fenceType = FenceType.VINYL,
            pointsEncoded = points,
            gatesEncoded = FenceCodec.encodeGates(listOf(GateMarker(500f, 0f, widthFt, mounting)))
        )
    }

    private fun qty(run: FenceRun, role: MaterialRole): Double =
        EstimateEngine.suggestQuantities(run, pixelsPerFoot = 20f)
            .entries.filter { it.role == role }.sumOf { it.quantity }

    // ---- every gate ----

    @Test
    fun `every gate takes one econo stiffener`() {
        GateMounting.values().forEach { mounting ->
            assertTrue(
                "missing stiffener for $mounting",
                qty(runWithGate(mounting), MaterialRole.STIFFENER) >= 1.0
            )
        }
    }

    // ---- hung on a wall ----

    @Test
    fun `a wall-hung gate needs a blank post and an end post`() {
        val run = runWithGate(GateMounting.WALL)
        assertEquals(1.0, qty(run, MaterialRole.BLANK_POST), 0.001)
        assertTrue(qty(run, MaterialRole.END_POST) >= 1.0)
    }

    @Test
    fun `a gate with no fence drawn still gets its hardware`() {
        // A standalone gate sale is a real job. The run it lives on has no
        // fence points at all -- the takeoff must still carry the gate's
        // posts, stiffener and concrete rather than refusing until fence
        // exists.
        val run = FenceRun(
            jobId = 1,
            fenceType = FenceType.VINYL,
            gatesEncoded = FenceCodec.encodeGates(
                listOf(GateMarker(500f, 0f, 4f, GateMounting.LINE))
            )
        )
        //
        // RE-AIMED, not relaxed: the two posts at the opening are billed as
        // GATE_POST now rather than END_POST (EstimateEngine.gateAreaEntries,
        // GateMounting.LINE), because a post standing at an opening is not an
        // end of a fence -- and the owner's catalog prices GATE_POST rows that
        // nothing could reach while the takeoff asked for END_POST. So the pin
        // moved END_POST 2.0 -> 0.0 with a GATE_POST 2.0 taking its place. The
        // gate still stands exactly two posts; they are a different catalog row.
        //
        // Zero END_POST is doubly right here: this run has no fence line at
        // all, so there is no end of one to bill. Cross-checked against
        // fixtures/pricing/gate-only-run.json (engine 2026.10.8, the same
        // shape) and the TypeScript port run live on it:
        // posts {line 0, corner 0, end 0, gate 2, total 2}, POST_CAP 2.
        // STILL TWO POSTS, now of two kinds. The hinge post carries the gate;
        // the latch post is a BLANK because there is no fence line for it to be
        // the end of -- which is the second half of his rule, and the half this
        // test caught missing: "an end post if it is connected to the fence, or
        // a blank if disconnected."
        // RE-AIMED AGAIN, 5 Oct 2026. Everything above describes the rule this
        // test held until the owner replaced it, in these words: "if a gate is
        // a stand alone and nothing else, it should be 2 blank post and the
        // gate, and the hardwares." So the hinge post is no longer a GATE_POST
        // here: with nothing to attach to, BOTH posts are blanks.
        //
        // The money does not move. BLANK_POST has no catalog row anywhere and
        // falls back to GATE_POST, so this run priced $426.97 before the change
        // and $426.97 after it; what moved is which row the takeoff asks for,
        // and the count of posts stayed at two throughout.
        //
        // This gate is mounted LINE. The WALL case is NOT this case and has its
        // own test below -- that distinction is the whole correction.
        assertEquals("nothing to attach to, so no gate post", 0.0, qty(run, MaterialRole.GATE_POST), 0.001)
        assertEquals("a gate on its own stands on two blanks", 2.0, qty(run, MaterialRole.BLANK_POST), 0.001)
        assertEquals("no fence line, so no end of one", 0.0, qty(run, MaterialRole.END_POST), 0.001)
        // Teeth kept: a standalone gate sale is not refused for want of fence.
        // Two posts in the ground, a cap on each, its stiffener and its concrete.
        assertEquals(2.0, qty(run, MaterialRole.POST_CAP), 0.001)
        assertTrue(qty(run, MaterialRole.STIFFENER) >= 1.0)
        // BOTH posts are in the ground, so both take a bag: hinge + latch.
        // Not ">= 1.0" -- that weaker form is what let a wall gate silently
        // start billing three bags for two posts, one of which is bolted to a
        // wall and set in nothing.
        assertEquals("two posts in the ground, two lots of concrete", 3.0, qty(run, MaterialRole.CONCRETE_BAG), 0.001)
        assertEquals("nothing is bolted to anything", 0.0, qty(run, MaterialRole.HOLE_PLUG), 0.001)
    }

    @Test
    fun `a wall-hung gate with no fence is bolted to the wall, not standing alone`() {
        // THE CASE THAT HAD NO TEST, AND THEREFORE BROKE.
        //
        // On 5 Oct 2026 the "two blank posts" rule was applied to every
        // mounting whenever no fence was drawn. That is right for LINE and
        // LINE_TO_WALL, which describe how a gate meets a fence, and WRONG for
        // WALL, which describes how it meets a WALL -- something that is still
        // there when no fence is. The result billed a second bag of concrete
        // for a post that is bolted up rather than set in the ground, and
        // dropped the four hole plugs that hold the gate on: an overcharge and
        // a missing part at the same time.
        //
        // A fixture DID cover this case -- gate-only-run-wall-mount, added in
        // the same commit as the bug -- and parity stayed green at 87 of 87
        // throughout. That is not a hole in the fixture set, it is what parity
        // is FOR: it proves the Kotlin and TypeScript engines agree, and they
        // agreed perfectly on the wrong answer, because the same mistake was
        // written into both. A fixture recorded from the engine can only ever
        // pin what the engine already does.
        //
        // So the thing that caught it was ConcreteBagsTest -- a hand-written
        // assertion about what the ANSWER should be, by someone who knew a
        // wall-hung gate is set in nothing. Nothing would have caught the
        // missing plugs. Hence this test, which asserts the answer rather than
        // the agreement.
        val run = FenceRun(
            jobId = 1,
            fenceType = FenceType.VINYL,
            gatesEncoded = FenceCodec.encodeGates(
                listOf(GateMarker(500f, 0f, 4f, GateMounting.WALL))
            )
        )
        // Two blank posts, as the owner asked -- reached the other way, because
        // the latch post falls to a blank when there is no fence to be the end
        // of, and the hinge post was always a blank bolted through the wall.
        assertEquals("hinge bolted to the wall, latch with nothing to end",
            2.0, qty(run, MaterialRole.BLANK_POST), 0.001)
        assertEquals("no fence line, so no end of one", 0.0, qty(run, MaterialRole.END_POST), 0.001)
        assertEquals(0.0, qty(run, MaterialRole.GATE_POST), 0.001)
        // The difference from a gate standing on its own, and the point of the
        // test: it IS bolted to a wall, so it keeps its plugs, and only ONE
        // post is in the ground, so it takes only one bag.
        assertEquals("the bolts it hangs on", 4.0, qty(run, MaterialRole.HOLE_PLUG), 0.001)
        assertEquals("one post in the ground, one bag", 1.0, qty(run, MaterialRole.CONCRETE_BAG), 0.001)
    }

    @Test
    fun `a wall-hung gate needs four hole plugs`() {
        // Four 5/8" holes drilled through the stiffener into the blank post.
        assertEquals(4.0, qty(runWithGate(GateMounting.WALL), MaterialRole.HOLE_PLUG), 0.001)
    }

    @Test
    fun `a wall-hung gate adds no concrete of its own`() {
        // Nothing in the gate area is set in the ground. The run's own posts
        // still take concrete; what must not appear is the gate's two bags.
        val wall = qty(runWithGate(GateMounting.WALL), MaterialRole.CONCRETE_BAG)
        val line = qty(runWithGate(GateMounting.LINE), MaterialRole.CONCRETE_BAG)
        assertEquals("the wall gate should be exactly two bags lighter", 2.0, line - wall, 0.001)
    }

    // ---- hung in the line ----

    @Test
    fun `a gate in the line takes an end post and two bags`() {
        val run = runWithGate(GateMounting.LINE)
        assertTrue(qty(run, MaterialRole.END_POST) >= 1.0)
        val bags = qty(run, MaterialRole.CONCRETE_BAG)
        val noGateBags = EstimateEngine.suggestQuantities(
            runWithGate(GateMounting.WALL), pixelsPerFoot = 20f
        ).entries.filter { it.role == MaterialRole.CONCRETE_BAG }.sumOf { it.quantity }
        assertEquals(2.0, bags - noGateBags, 0.001)
    }

    @Test
    fun `a gate in the line needs no blank post or plugs`() {
        val run = runWithGate(GateMounting.LINE)
        assertEquals(0.0, qty(run, MaterialRole.BLANK_POST), 0.001)
        assertEquals(0.0, qty(run, MaterialRole.HOLE_PLUG), 0.001)
    }

    // ---- in the line, fence carries on to a wall ----

    @Test
    fun `a run carrying on to a wall takes a second end post`() {
        val oneEnd = qty(runWithGate(GateMounting.LINE), MaterialRole.END_POST)
        val twoEnds = qty(runWithGate(GateMounting.LINE_TO_WALL), MaterialRole.END_POST)
        assertEquals("the second termination needs its own end post", 1.0, twoEnds - oneEnd, 0.001)
    }

    // ---- storage ----

    @Test
    fun `mounting survives a save and reload`() {
        val gates = listOf(
            GateMarker(1f, 2f, 4f, GateMounting.WALL),
            GateMarker(3f, 4f, 5f, GateMounting.LINE_TO_WALL)
        )
        val decoded = FenceCodec.decodeGates(FenceCodec.encodeGates(gates))
        assertEquals(gates, decoded)
    }

    @Test
    fun `gates drawn before mounting existed still load`() {
        // The old three-part form. Refusing it would silently empty the gate
        // list on every job already quoted.
        val decoded = FenceCodec.decodeGates("100.0:200.0:4.0")
        assertEquals(1, decoded.size)
        assertEquals(4f, decoded[0].widthFt)
        assertEquals(GateMounting.LINE, decoded[0].mounting)
    }
}
