package com.fenceestimator.app.geometry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.cos
import kotlin.math.sin

/**
 * Angle lock while drawing ([snapDrawPoint]): straight on, square and 45
 * relative to the side before, and horizontal / vertical on the plan --
 * within a small tolerance, saying what it locked to, and never moving a
 * corner that is already on the drawing.
 *
 * The broader snapping rules (corners, whole feet, the "never forced"
 * contract) are pinned in SnapDrawPointTest; this file covers what the
 * estimator reads back and the guarantees added with it.
 */
class AngleLockTest {

    private val pxPerFt = 20f
    private fun p(x: Float, y: Float) = FencePoint(x, y)

    /** A point [lengthPx] from [from] at [deg] degrees (clockwise from east, y down). */
    private fun at(from: FencePoint, deg: Double, lengthPx: Double): FencePoint {
        val r = Math.toRadians(deg)
        return p((from.x + cos(r) * lengthPx).toFloat(), (from.y + sin(r) * lengthPx).toFloat())
    }

    // A property line running at 30 degrees: the side before the one being drawn.
    private val start = p(1000f, 1000f)
    private val corner = at(start, 30.0, 300.0)

    private fun drawFromCorner(deg: Double, lengthPx: Double = 257.0) = snapDrawPoint(
        candidate = at(corner, deg, lengthPx),
        previous = corner,
        beforePrevious = start,
        otherVertices = listOf(start, corner),
        pxPerFt = pxPerFt,
        lengthSnapFt = 0f, // isolate the angle from the whole-foot rounding
    )

    // ------------------------------------------------ relative to the last side

    @Test
    fun `carrying on nearly straight locks straight on`() {
        val r = drawFromCorner(33.5)
        assertEquals(SnapKind.ANGLE, r.kind)
        assertEquals(30f, r.lockedAngleDeg!!, 0.01f)
        assertEquals(AngleReference.PREVIOUS_SIDE, r.angleReference)
        assertEquals(0f, r.turnDeg!!, 0f)
        assertEquals(AngleCue.StraightOn, r.angleCue())
    }

    @Test
    fun `a nearly square turn locks square to the last side`() {
        val r = drawFromCorner(30.0 + 90.0 - 4.0)
        assertEquals(120f, r.lockedAngleDeg!!, 0.01f)
        assertEquals(AngleReference.PREVIOUS_SIDE, r.angleReference)
        assertEquals(90f, r.turnDeg!!, 0f)
        assertEquals(AngleCue.Square, r.angleCue())
    }

    @Test
    fun `the other way round is square too`() {
        val r = drawFromCorner(30.0 - 90.0 + 3.0)
        assertEquals(300f, r.lockedAngleDeg!!, 0.01f)
        assertEquals(90f, r.turnDeg!!, 0f)
        assertEquals(AngleCue.Square, r.angleCue())
    }

    @Test
    fun `a nearly forty-five degree turn locks to forty-five`() {
        val r = drawFromCorner(30.0 + 45.0 + 5.0)
        assertEquals(75f, r.lockedAngleDeg!!, 0.01f)
        assertEquals(45f, r.turnDeg!!, 0f)
        assertEquals(AngleCue.Turn(45), r.angleCue())
    }

    @Test
    fun `the lock is to the line, so the side comes out exactly square`() {
        val r = drawFromCorner(30.0 + 90.0 + 5.5)
        val before = Math.toDegrees(Math.atan2((corner.y - start.y).toDouble(), (corner.x - start.x).toDouble()))
        val after = Math.toDegrees(Math.atan2((r.point.y - corner.y).toDouble(), (r.point.x - corner.x).toDouble()))
        assertEquals(90.0, after - before, 1e-3)
    }

    @Test
    fun `tolerance is respected at its edge for a relative angle`() {
        // Measured on the side of 120 away from the plan's own 135, so the
        // only lock in reach is the relative one.
        val inside = drawFromCorner(30.0 + 90.0 - 6.5)
        assertEquals(SnapKind.ANGLE, inside.kind)
        assertEquals(AngleCue.Square, inside.angleCue())
        assertEquals(SnapKind.NONE, drawFromCorner(30.0 + 90.0 - 8.0).kind)
    }

    // --- Planted failure: an angle nowhere near a lock must stay free. ---
    @Test
    fun `planted failure - twenty degrees off square is drawn exactly where it was put`() {
        // 100 degrees: 20 off square to the last side, 10 off the plan's vertical.
        val candidate = at(corner, 30.0 + 90.0 - 20.0, 257.0)
        val r = snapDrawPoint(candidate, corner, start, emptyList(), pxPerFt, lengthSnapFt = 0f)
        assertEquals(SnapKind.NONE, r.kind)
        assertEquals(candidate, r.point)
        assertNull(r.angleCue())
    }

    // ------------------------------------------------------------ on the plan

    @Test
    fun `the first side locks horizontal on the plan`() {
        val r = snapDrawPoint(p(1300f, 1012f), p(1000f, 1000f), null, emptyList(), pxPerFt, lengthSnapFt = 0f)
        assertEquals(AngleReference.MAP, r.angleReference)
        assertNull(r.turnDeg)
        assertEquals(AngleCue.MapHorizontal, r.angleCue())
        assertEquals(1000f, r.point.y, 0.01f)
    }

    @Test
    fun `the first side locks vertical on the plan`() {
        val r = snapDrawPoint(p(1011f, 1300f), p(1000f, 1000f), null, emptyList(), pxPerFt, lengthSnapFt = 0f)
        assertEquals(AngleCue.MapVertical, r.angleCue())
        assertEquals(1000f, r.point.x, 0.01f)
    }

    @Test
    fun `a diagonal on the plan is called a diagonal`() {
        val r = snapDrawPoint(p(1200f, 1190f), p(1000f, 1000f), null, emptyList(), pxPerFt, lengthSnapFt = 0f)
        assertEquals(AngleCue.MapDiagonal, r.angleCue())
    }

    @Test
    fun `square to the last side wins the tie with vertical on the plan`() {
        // Last side horizontal; new side nearly vertical. Both readings give
        // the same heading -- the cue names the one being aimed at.
        val r = snapDrawPoint(p(1303f, 1300f), p(1300f, 1000f), p(1000f, 1000f), emptyList(), pxPerFt, lengthSnapFt = 0f)
        assertEquals(AngleReference.PREVIOUS_SIDE, r.angleReference)
        assertEquals(AngleCue.Square, r.angleCue())
        assertEquals(1300f, r.point.x, 0.01f)
    }

    // ---------------------------------------------------- committed corners

    @Test
    fun `snapping never moves a corner that is already on the drawing`() {
        val committed = listOf(p(1000f, 1000f), p(1300f, 1000f), p(1300f, 1300f), p(700.5f, 1290.25f))
        val copy = committed.map { it.copy() }
        // A spread of taps: some join a corner, some lock an angle, some a length.
        for (dx in -40..40 step 8) for (dy in -40..40 step 8) {
            val r = snapDrawPoint(
                p(1000f + dx, 1300f + dy), committed.last(), committed[committed.size - 2],
                committed, pxPerFt
            )
            // The inputs are untouched...
            assertEquals(copy, committed)
            // ...and a corner snap copies an existing corner rather than
            // producing somewhere new for it.
            if (r.kind == SnapKind.VERTEX) assertTrue(r.point in committed)
        }
    }

    @Test
    fun `a tap on the previous corner never makes a side with no length`() {
        val prev = p(1300f, 1000f)
        val r = snapDrawPoint(p(1304f, 1003f), prev, p(1000f, 1000f), listOf(p(1000f, 1000f), prev), pxPerFt)
        assertNotEquals(SnapKind.VERTEX, r.kind)
        assertNotEquals(prev, r.point)
    }

    // --- Planted failure: without the exclusion, the same tap lands ON the corner. ---
    @Test
    fun `planted failure - the same corner under another name is still joinable`() {
        // Offered as a plain corner (not as the previous point), the very same
        // position is joined -- which is what the exclusion above prevents.
        val prev = p(1300f, 1000f)
        val r = snapDrawPoint(p(1304f, 1003f), p(900f, 900f), null, listOf(prev), pxPerFt)
        assertEquals(SnapKind.VERTEX, r.kind)
        assertEquals(prev, r.point)
    }

    @Test
    fun `a dragged corner does not join the neighbour it is connected to`() {
        val next = p(1300f, 1300f)
        val r = snapDrawPoint(
            p(1296f, 1297f), p(1000f, 1000f), null, listOf(next), pxPerFt, avoid = listOf(next)
        )
        assertNotEquals(SnapKind.VERTEX, r.kind)
    }

    @Test
    fun `closing a loop by tapping the first corner still joins it`() {
        val first = p(1000f, 1000f)
        val r = snapDrawPoint(
            p(1006f, 1004f), p(1300f, 1300f), p(1300f, 1000f),
            listOf(first, p(1300f, 1000f), p(1300f, 1300f)), pxPerFt
        )
        assertEquals(SnapKind.VERTEX, r.kind)
        assertEquals(first, r.point)
    }

    // ------------------------------------------- a rounded foot is a real foot

    /** The old arithmetic for placing a rounded length: plain cos/sin in floats. */
    private fun oldRoundedPoint(from: FencePoint, deg: Double, feet: Float): FencePoint {
        val r = Math.toRadians(deg)
        return p(from.x + (cos(r) * feet * pxPerFt).toFloat(), from.y + (sin(r) * feet * pxPerFt).toFloat())
    }

    private fun feet(a: FencePoint, b: FencePoint) =
        FenceGeometryEngine.analyze(listOf(a, b), pxPerFt).totalLinearFeet

    @Test
    fun `a side rounded to a whole foot never measures over it in the takeoff`() {
        val from = p(2508.652f, 394.14835f)
        var oldOvershoots = 0
        for (tenth in 0 until 3600 step 13) {
            val deg = tenth / 10.0
            // Aim at 47.9 ft: the snap rounds it to 48.
            val r = snapDrawPoint(at(from, deg, 47.9 * pxPerFt), from, null, emptyList(), pxPerFt)
            if (r.lengthFt == null) continue
            assertEquals(48f, r.lengthFt!!, 0f)
            val measured = feet(from, r.point)
            assertTrue("rounded to 48 but measures $measured at $deg°", measured <= 48f)
            assertEquals(48f, measured, 1e-4f)
            if (feet(from, oldRoundedPoint(from, r.lockedAngleDeg?.toDouble() ?: deg, 48f)) > 48f) oldOvershoots++
        }
        // Planted failure: the arithmetic this replaced does overshoot here,
        // so the assertion above is testing something real.
        assertTrue("expected the old placement to overshoot somewhere", oldOvershoots > 0)
    }
}
