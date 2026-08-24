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
        assertEquals(2.0, qty(run, MaterialRole.END_POST), 0.001)
        assertTrue(qty(run, MaterialRole.STIFFENER) >= 1.0)
        assertTrue(qty(run, MaterialRole.CONCRETE_BAG) >= 1.0)
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
