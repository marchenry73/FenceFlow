package com.fenceestimator.app.geometry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

/**
 * Typing a tape measurement into a side of the drawing ([setSideLength]).
 *
 * The rules an estimator relies on:
 *  - the side measures what was typed, in the takeoff's own arithmetic --
 *    exactly, or a hair under where floats cannot hit it, NEVER over (the
 *    takeoff rounds bays up, so a hair over is a whole extra panel);
 *  - nothing typed earlier moves: earlier corners stay put and later sides
 *    keep their heading and their measured length;
 *  - a closed loop's closing side can be typed too;
 *  - gates ride along with the side they sit on.
 */
class TypedSideLengthTest {

    private fun p(x: Float, y: Float) = FencePoint(x, y)

    /** A side measured exactly as the takeoff measures it. */
    private fun side(points: List<FencePoint>, i: Int, pxPerFt: Float, closed: Boolean = false): Float =
        FenceGeometryEngine.analyze(points, pxPerFt, closed).segments[i].lengthFt

    private fun headingDeg(a: FencePoint, b: FencePoint) =
        Math.toDegrees(atan2((b.y - a.y).toDouble(), (b.x - a.x).toDouble()))

    // ------------------------------------------------------------ exactness

    @Test
    fun `a typed length is the number the takeoff measures`() {
        // 47' 6" on the 20 px/ft grid, along a horizontal side.
        val pts = listOf(p(1000f, 1000f), p(1937.3f, 1000f))
        val edit = setSideLength(pts, emptyList(), 0, 47.5f, 20f, closedLoop = false)!!
        assertEquals(47.5f, side(edit.points, 0, 20f), 0f)
        assertEquals(47.5f, FenceGeometryEngine.analyze(edit.points, 20f).totalLinearFeet, 0f)
        // And the dialog's own read-back is the same number.
        assertEquals(47.5f, sideLengthFeet(edit.points, 0, 20f, closedLoop = false)!!, 0f)
    }

    @Test
    fun `a typed length never measures over what was typed, at any heading or scale`() {
        var cases = 0
        var exact = 0
        for (scale in floatArrayOf(20f, 13.7f, 2.5f)) {
            for (anchor in listOf(p(37.25f, 4012.8f), p(2508.652f, 394.14835f), p(7811.1f, 6203.9f))) {
                for (deg in 0 until 360 step 7) {
                    val rad = Math.toRadians(deg.toDouble())
                    val far = p((anchor.x + cos(rad) * 400).toFloat(), (anchor.y + sin(rad) * 400).toFloat())
                    for (feet in floatArrayOf(48f, 47.5f, 24f, 47.541668f, 12.25f)) {
                        val out = setSideLength(listOf(anchor, far), emptyList(), 0, feet, scale, false)!!
                        val measured = side(out.points, 0, scale)
                        cases++
                        if (measured == feet) exact++
                        assertTrue("$feet ft at $deg° / $scale px/ft measured $measured -- over", measured <= feet)
                        // Under by at most one representable coordinate step:
                        // five ten-thousandths of a foot (six thousandths of an
                        // inch) even at a coarse photo scale far from the
                        // origin. Invisible, and on the safe side.
                        assertEquals("$feet ft at $deg° / $scale px/ft", feet, measured, 5e-4f)
                        // Heading kept. (The worst case -- a short side far
                        // from the origin, where floats are coarsest -- is a
                        // few thousandths of a degree.)
                        assertEquals(headingDeg(anchor, far), headingDeg(out.points[0], out.points[1]), 1e-2)
                    }
                }
            }
        }
        // Exact far more often than not; the rest are the float grid being
        // coarser than the target, and land just under.
        assertTrue("only $exact of $cases landed exactly", exact * 2 > cases)
    }

    // --- Planted failure: proves the "never over" check above has teeth. ---
    @Test
    fun `planted failure - the plain slide measures over the typed length where the landing does not`() {
        // A diagonal where sliding the corner by plain float arithmetic
        // (the old stretchSegment) measures 48.000004 ft in the takeoff.
        val a = p(2508.652f, 394.14835f)
        val b = p(2190.7705f, 304.57584f)
        val naive = stretchSegment(listOf(a, b), 0, 48f * 20f)!!
        val naiveFeet = side(naive, 0, 20f)
        assertTrue("the old slide was expected to overshoot here, got $naiveFeet", naiveFeet > 48f)
        // Why it matters: the takeoff rounds bays up, so 6 ft panels become 9.
        assertEquals(9, kotlin.math.ceil(naiveFeet / 6f).toInt())

        val landed = setSideLength(listOf(a, b), emptyList(), 0, 48f, 20f, false)!!
        val landedFeet = side(landed.points, 0, 20f)
        assertTrue("landed at $landedFeet", landedFeet <= 48f)
        assertEquals(8, kotlin.math.ceil(landedFeet / 6f).toInt())
    }

    // ------------------------------------------------------- the rest follows

    @Test
    fun `earlier corners never move, not even by a rounding error`() {
        val pts = listOf(p(5.3f, 5.7f), p(105.1f, 5.7f), p(105.1f, 65.9f), p(205.4f, 91.2f))
        val out = setSideLength(pts, emptyList(), 1, 30f, 20f, false)!!
        assertEquals(pts[0], out.points[0])
        assertEquals(pts[1], out.points[1])
    }

    @Test
    fun `every later side keeps its heading and never grows`() {
        // A zig-zag of five sides at awkward headings; retype the second.
        val pts = listOf(
            p(812.4f, 1733.9f), p(1196.2f, 1650.1f), p(1333.7f, 2011.6f),
            p(1901.3f, 2102.8f), p(2045.9f, 1799.4f), p(2710.2f, 1811.7f)
        )
        for (scale in floatArrayOf(20f, 13.7f, 2.5f)) {
            val before = (0 until pts.size - 1).map { side(pts, it, scale) }
            val out = setSideLength(pts, emptyList(), 1, 36f, scale, false)!!
            val after = (0 until pts.size - 1).map { side(out.points, it, scale) }
            assertEquals(before[0], after[0], 0f)
            assertTrue(after[1] <= 36f)
            for (k in 2 until pts.size - 1) {
                assertTrue("side $k grew from ${before[k]} to ${after[k]} at $scale", after[k] <= before[k])
                assertEquals("side $k at $scale", before[k], after[k], 5e-4f)
                assertEquals(headingDeg(pts[k], pts[k + 1]), headingDeg(out.points[k], out.points[k + 1]), 1e-3)
            }
        }
    }

    @Test
    fun `a side typed earlier stays exactly what was typed when an earlier side is retyped`() {
        // The workflow that matters: type the second leg, then the first. The
        // second must still read what was typed, or it drifts upward and
        // buys a bay nobody drew.
        val pts = listOf(p(1000f, 1000f), p(1937.3f, 1000f), p(1937.3f, 1500f))
        val first = setSideLength(pts, emptyList(), 1, 24f, 20f, false)!!
        assertEquals(24f, side(first.points, 1, 20f), 0f)
        val second = setSideLength(first.points, emptyList(), 0, 36f, 20f, false)!!
        assertEquals(36f, side(second.points, 0, 20f), 0f)
        assertEquals(24f, side(second.points, 1, 20f), 0f)
        assertEquals(60f, FenceGeometryEngine.analyze(second.points, 20f).totalLinearFeet, 0f)
    }

    // ------------------------------------------------------------ closed loops

    // A 40 x 30 rectangle at 10 px/ft: sides 40, 30, 40 and the closing 30.
    private val rectangle = listOf(p(0f, 0f), p(400f, 0f), p(400f, 300f), p(0f, 300f))

    @Test
    fun `on a loop, retyping an ordinary side lets the closing side give`() {
        val out = setSideLength(rectangle, emptyList(), 0, 50f, 10f, closedLoop = true)!!
        assertEquals(rectangle[0], out.points[0])
        assertEquals(50f, side(out.points, 0, 10f, true), 0f)
        assertEquals(30f, side(out.points, 1, 10f, true), 0f)
        assertEquals(40f, side(out.points, 2, 10f, true), 0f)
        assertNotEquals("the closing side is the one that gives", 30f, side(out.points, 3, 10f, true))
    }

    @Test
    fun `the closing side can be typed and moves only the last corner`() {
        val out = setSideLength(rectangle, emptyList(), 3, 35f, 10f, closedLoop = true)!!
        assertEquals(35f, side(out.points, 3, 10f, true), 0f)
        assertEquals(35f, sideLengthFeet(out.points, 3, 10f, closedLoop = true)!!, 0f)
        // First three corners exactly where they were.
        for (i in 0..2) assertEquals(rectangle[i], out.points[i])
        // The last corner slid along the closing side (straight down the y axis).
        assertEquals(0f, out.points[3].x, 0f)
        assertEquals(350f, out.points[3].y, 0f)
        // The side before it is the one that changed to meet it.
        assertNotEquals(40f, side(out.points, 2, 10f, true))
        // Perimeter is the sum of the sides, closing side included once.
        val sum = (0..3).sumOf { side(out.points, it, 10f, true).toDouble() }.toFloat()
        assertEquals(sum, FenceGeometryEngine.analyze(out.points, 10f, true).totalLinearFeet, 1e-3f)
    }

    // --- Planted failure: the closing side used to have no length at all. ---
    @Test
    fun `planted failure - the old segment read-back has no closing side, the new one does`() {
        // segmentLengthPx is what the dialog and the plan labels used to read,
        // and it returns nothing for the closing side -- so tapping that chip
        // silently did nothing. sideLengthFeet must return the real length.
        assertNull(segmentLengthPx(rectangle, 3))
        assertEquals(30f, sideLengthFeet(rectangle, 3, 10f, closedLoop = true)!!, 0f)
        assertTrue(isClosingSide(rectangle.size, 3, closedLoop = true))
        assertFalse(isClosingSide(rectangle.size, 3, closedLoop = false))
    }

    @Test
    fun `a two-corner loop has no closing side to type`() {
        val pts = listOf(p(0f, 0f), p(100f, 0f))
        assertNull(setSideLength(pts, emptyList(), 1, 5f, 10f, closedLoop = true))
        // Its first side is still an ordinary side.
        assertNotNull(setSideLength(pts, emptyList(), 0, 5f, 10f, closedLoop = true))
    }

    // ------------------------------------------------------------------ gates

    // An L: 100 ft across, then 60 ft down, at 10 px/ft.
    private val ell = listOf(p(0f, 0f), p(1000f, 0f), p(1000f, 600f))

    @Test
    fun `a gate on a later side rides along with it`() {
        val gate = GateMarker(1000f, 300f, 4f, GateMounting.WALL, GateSwing.OUT)
        val out = setSideLength(ell, listOf(gate), 0, 150f, 10f, false)!!
        assertTrue(out.gatesMoved)
        val moved = out.gates.single()
        assertEquals(1500f, moved.x, 0.01f)
        assertEquals(300f, moved.y, 0.01f)
        // Everything but the position is untouched.
        assertEquals(gate.widthFt, moved.widthFt, 0f)
        assertEquals(gate.mounting, moved.mounting)
        assertEquals(gate.swing, moved.swing)
        // And the plan still hangs it on the second side.
        assertEquals(1, GateGeometry.spanFor(moved, out.points, false, 10f)!!.segmentIndex)
    }

    // --- Planted failure: proves following the side matters. ---
    @Test
    fun `planted failure - a gate left behind re-matches to a different side`() {
        val gate = GateMarker(1000f, 300f, 4f)
        val out = setSideLength(ell, listOf(gate), 0, 150f, 10f, false)!!
        // The gate where it was, on the new drawing: nearer the first side now.
        assertEquals(0, GateGeometry.spanFor(gate, out.points, false, 10f)!!.segmentIndex)
        // The followed gate stays on the side it was placed on.
        assertEquals(1, GateGeometry.spanFor(out.gates.single(), out.points, false, 10f)!!.segmentIndex)
    }

    @Test
    fun `a gate on the typed side stays the same fraction of the way along it`() {
        val gate = GateMarker(250f, 0f, 4f)            // a quarter of the way along 100 ft
        val out = setSideLength(ell, listOf(gate), 0, 200f, 10f, false)!!
        assertEquals(500f, out.gates.single().x, 0.01f) // a quarter of 200 ft
        assertEquals(0, GateGeometry.spanFor(out.gates.single(), out.points, false, 10f)!!.segmentIndex)
    }

    @Test
    fun `gates on sides that did not move are left exactly alone`() {
        val upstream = GateMarker(500f, 0f, 4f)
        val out = setSideLength(ell, listOf(upstream), 1, 80f, 10f, false)!!
        assertFalse(out.gatesMoved)
        assertEquals(upstream, out.gates.single())
    }

    // --------------------------------------------------------------- refusals

    @Test
    fun `requests with no answer are refused rather than guessed`() {
        val pts = listOf(p(0f, 0f), p(100f, 0f), p(100f, 50f))
        assertNull("no such side", setSideLength(pts, emptyList(), 2, 5f, 10f, false))
        assertNull("negative index", setSideLength(pts, emptyList(), -1, 5f, 10f, false))
        assertNull("zero length", setSideLength(pts, emptyList(), 0, 0f, 10f, false))
        assertNull("negative length", setSideLength(pts, emptyList(), 0, -3f, 10f, false))
        assertNull("not a number", setSideLength(pts, emptyList(), 0, Float.NaN, 10f, false))
        assertNull("no scale", setSideLength(pts, emptyList(), 0, 5f, 0f, false))
        assertNull("one corner", setSideLength(listOf(p(0f, 0f)), emptyList(), 0, 5f, 10f, false))
        assertNull(
            "corners on top of each other have no heading",
            setSideLength(listOf(p(10f, 10f), p(10f, 10f)), emptyList(), 0, 5f, 10f, false)
        )
    }

    @Test
    fun `side count matches the takeoff`() {
        assertEquals(0, sideCount(1, closedLoop = true))
        assertEquals(3, sideCount(4, closedLoop = false))
        assertEquals(4, sideCount(4, closedLoop = true))
        assertEquals(
            FenceGeometryEngine.analyze(rectangle, 10f, true).segments.size,
            sideCount(rectangle.size, closedLoop = true)
        )
    }
}
