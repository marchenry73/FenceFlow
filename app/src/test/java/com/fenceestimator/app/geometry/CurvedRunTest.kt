package com.fenceestimator.app.geometry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A curved fence must be all LINE posts.
 *
 * A curve is built as short straight bays, so it is a polyline and the engine
 * already prices it: length, spacing, vertex counts. The one way that goes
 * wrong is a vertex turning CORNER_ANGLE_THRESHOLD_DEGREES or more, because
 * that vertex silently becomes a CORNER post -- a different catalog row at a
 * different price, on a run that looks perfectly smooth.
 *
 * So CurvedRun does not take a segment count. It subdivides until every turn is
 * under the threshold, and these tests are what say it actually does.
 */
class CurvedRunTest {

    private val threshold = FenceGeometryEngine.CORNER_ANGLE_THRESHOLD_DEGREES

    @Test
    fun `a gentle bow turns no vertex into a corner post`() {
        val pts = CurvedRun.through(
            FencePoint(0f, 0f), FencePoint(500f, 120f), FencePoint(1000f, 0f),
        )
        assertTrue("a curve must not contain a corner", CurvedRun.sharpestTurnDegrees(pts) < threshold)
    }

    @Test
    fun `a hard half-circle bow still turns no vertex into a corner post`() {
        // The case that breaks a fixed segment count: bow the curve out as far
        // as its own width and a six-segment sample turns about 30 degrees a
        // vertex -- every one of them a corner post.
        val pts = CurvedRun.through(
            FencePoint(0f, 0f), FencePoint(500f, 900f), FencePoint(1000f, 0f),
        )
        assertTrue(
            "sharpest turn was ${CurvedRun.sharpestTurnDegrees(pts)}",
            CurvedRun.sharpestTurnDegrees(pts) < threshold,
        )
    }

    @Test
    fun `it subdivides more for a sharper curve, not a fixed number of segments`() {
        val gentle = CurvedRun.through(FencePoint(0f, 0f), FencePoint(500f, 40f), FencePoint(1000f, 0f))
        val sharp = CurvedRun.through(FencePoint(0f, 0f), FencePoint(500f, 900f), FencePoint(1000f, 0f))
        assertTrue(
            "sharp=${sharp.size} gentle=${gentle.size}",
            sharp.size > gentle.size,
        )
    }

    @Test
    fun `the curve starts and ends exactly where he tapped`() {
        // The ends are joints: a curve that lands near its end rather than on
        // it leaves a gap at a shared post, which the takeoff then bills as two
        // free ends.
        val a = FencePoint(10f, 20f)
        val b = FencePoint(900f, 430f)
        val pts = CurvedRun.through(a, FencePoint(400f, 300f), b)
        assertEquals(a.x, pts.first().x, 0.001f)
        assertEquals(a.y, pts.first().y, 0.001f)
        assertEquals(b.x, pts.last().x, 0.001f)
        assertEquals(b.y, pts.last().y, 0.001f)
    }

    @Test
    fun `it passes through the point he tapped, not near it`() {
        // The middle tap is a point ON the fence, not a control point: he taps
        // where the fence actually has to run, so that is where it must go.
        val through = FencePoint(500f, 300f)
        val pts = CurvedRun.through(FencePoint(0f, 0f), through, FencePoint(1000f, 0f))
        val mid = pts[pts.size / 2]
        assertEquals("the curve missed the point he tapped", through.x, mid.x, 1.0f)
        assertEquals("the curve missed the point he tapped", through.y, mid.y, 1.0f)
    }

    @Test
    fun `three points in a line give a straight run, not a crash`() {
        // A near-straight bow is a real thing to draw, and it is exactly the
        // case where a circular arc through three points is undefined. The
        // quadratic Bezier is chosen for this.
        val pts = CurvedRun.through(FencePoint(0f, 0f), FencePoint(500f, 0f), FencePoint(1000f, 0f))
        assertTrue(pts.size >= 2)
        assertEquals(0f, CurvedRun.sharpestTurnDegrees(pts), 0.001f)
        assertEquals(1000f, CurvedRun.length(pts), 0.5f)
    }

    @Test
    fun `the curve is longer than the straight line it replaces`() {
        // Fence is sold by the foot, and a curve around a flower bed is more
        // fence than the chord across it. If this ever came out shorter, the
        // curve would be under-billing the material it needs.
        val a = FencePoint(0f, 0f)
        val b = FencePoint(1000f, 0f)
        val pts = CurvedRun.through(a, FencePoint(500f, 300f), b)
        assertTrue(
            "curve ${CurvedRun.length(pts)} should exceed chord 1000",
            CurvedRun.length(pts) > 1000f,
        )
    }

    @Test
    fun `sharpestTurnDegrees reports a right angle as a right angle`() {
        // The control for the tests above: if this measured turns wrongly, every
        // "no corner" assertion would pass against a curve full of corners.
        val square = listOf(FencePoint(0f, 0f), FencePoint(100f, 0f), FencePoint(100f, 100f))
        assertEquals(90f, CurvedRun.sharpestTurnDegrees(square), 0.01f)
        assertTrue(
            "a right angle must read as a corner",
            CurvedRun.sharpestTurnDegrees(square) >= threshold,
        )
    }
}
