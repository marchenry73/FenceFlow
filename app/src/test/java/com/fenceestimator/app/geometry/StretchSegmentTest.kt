package com.fenceestimator.app.geometry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import kotlin.math.sqrt

/**
 * Typing an exact length into the drawing.
 *
 * The rule that matters: correcting one segment must not silently change a
 * measurement the user did not touch. So the rest of the run slides rigidly
 * rather than the next corner being dragged out of place.
 */
class StretchSegmentTest {

    private fun p(x: Float, y: Float) = FencePoint(x, y)
    private fun len(a: FencePoint, b: FencePoint) =
        sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y))

    @Test
    fun `a horizontal segment takes the length it is given`() {
        val pts = listOf(p(0f, 0f), p(100f, 0f))
        val out = stretchSegment(pts, 0, 250f)!!
        assertEquals(0f, out[0].x, 0.001f)
        assertEquals(250f, out[1].x, 0.001f)
        assertEquals(0f, out[1].y, 0.001f)
    }

    @Test
    fun `direction is preserved on a diagonal`() {
        val pts = listOf(p(0f, 0f), p(30f, 40f))   // length 50, 3-4-5
        val out = stretchSegment(pts, 0, 100f)!!
        assertEquals(100f, len(out[0], out[1]), 0.001f)
        // Same heading: doubling the length doubles both components.
        assertEquals(60f, out[1].x, 0.001f)
        assertEquals(80f, out[1].y, 0.001f)
    }

    @Test
    fun `every later segment keeps its own length and heading`() {
        // An L: 100 across, then 60 down. Lengthen the first leg and the
        // corner must travel with it -- the second leg is still 60.
        val pts = listOf(p(0f, 0f), p(100f, 0f), p(100f, 60f))
        val out = stretchSegment(pts, 0, 150f)!!
        assertEquals(150f, len(out[0], out[1]), 0.001f)
        assertEquals(60f, len(out[1], out[2]), 0.001f)
        assertEquals(150f, out[2].x, 0.001f)
        assertEquals(60f, out[2].y, 0.001f)
    }

    @Test
    fun `earlier points never move`() {
        val pts = listOf(p(5f, 5f), p(105f, 5f), p(105f, 65f), p(205f, 65f))
        val out = stretchSegment(pts, 1, 30f)!!
        assertEquals(5f, out[0].x, 0.001f)
        assertEquals(5f, out[0].y, 0.001f)
        assertEquals(105f, out[1].x, 0.001f)
        assertEquals(5f, out[1].y, 0.001f)
    }

    @Test
    fun `shortening works the same way as lengthening`() {
        val pts = listOf(p(0f, 0f), p(100f, 0f), p(100f, 50f))
        val out = stretchSegment(pts, 0, 40f)!!
        assertEquals(40f, len(out[0], out[1]), 0.001f)
        assertEquals(50f, len(out[1], out[2]), 0.001f)
        assertEquals(40f, out[2].x, 0.001f)
    }

    @Test
    fun `a segment with no direction is refused rather than guessed`() {
        // Two points on top of each other: there is no heading to stretch
        // along, and picking one would put the fence somewhere arbitrary.
        assertNull(stretchSegment(listOf(p(10f, 10f), p(10f, 10f)), 0, 50f))
    }

    @Test
    fun `impossible requests are refused`() {
        val pts = listOf(p(0f, 0f), p(100f, 0f))
        assertNull("no such segment", stretchSegment(pts, 1, 50f))
        assertNull("negative index", stretchSegment(pts, -1, 50f))
        assertNull("zero length", stretchSegment(pts, 0, 0f))
        assertNull("negative length", stretchSegment(pts, 0, -20f))
        assertNull("empty run", stretchSegment(emptyList(), 0, 50f))
        assertNull("one point is not a segment", stretchSegment(listOf(p(0f, 0f)), 0, 50f))
    }

    @Test
    fun `the total changes by exactly the amount asked for`() {
        val pts = listOf(p(0f, 0f), p(100f, 0f), p(100f, 60f), p(0f, 60f))
        val before = (0 until pts.size - 1).sumOf { len(pts[it], pts[it + 1]).toDouble() }
        val out = stretchSegment(pts, 0, 130f)!!
        val after = (0 until out.size - 1).sumOf { len(out[it], out[it + 1]).toDouble() }
        assertEquals(before + 30.0, after, 0.001)
    }

    @Test
    fun `segment length reads back what was set`() {
        val pts = listOf(p(0f, 0f), p(3f, 4f), p(3f, 20f))
        assertEquals(5f, segmentLengthPx(pts, 0)!!, 0.001f)
        assertEquals(16f, segmentLengthPx(pts, 1)!!, 0.001f)
        assertNull(segmentLengthPx(pts, 2))
        val out = stretchSegment(pts, 0, 12.5f)!!
        assertEquals(12.5f, segmentLengthPx(out, 0)!!, 0.001f)
        assertNotNull(segmentLengthPx(out, 1))
        assertEquals(16f, segmentLengthPx(out, 1)!!, 0.001f)
    }
}
