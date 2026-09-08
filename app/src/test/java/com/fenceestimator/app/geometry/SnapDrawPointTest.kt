package com.fenceestimator.app.geometry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * Placing a point on a fence drawing.
 *
 * The rule the whole thing rests on: snapping happens only when the point
 * was already close to the target. A tool that forces a fence square is a
 * tool that gets switched off and never switched back on.
 */
class SnapDrawPointTest {

    private val pxPerFt = 20f
    private fun p(x: Float, y: Float) = FencePoint(x, y)

    private fun snap(
        candidate: FencePoint,
        previous: FencePoint? = null,
        beforePrevious: FencePoint? = null,
        others: List<FencePoint> = emptyList(),
    ) = snapDrawPoint(candidate, previous, beforePrevious, others, pxPerFt)

    private fun dist(a: FencePoint, b: FencePoint) =
        sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y))

    // ---------------------------------------------------------------- vertex

    @Test
    fun `a point placed near an existing corner lands exactly on it`() {
        // Two runs meeting at a corner have to meet at ONE point, or the
        // takeoff sets two posts where the crew will set one.
        val corner = p(500f, 300f)
        val r = snap(p(512f, 308f), previous = p(0f, 0f), others = listOf(corner))
        assertEquals(SnapKind.VERTEX, r.kind)
        assertEquals(corner, r.point)
    }

    @Test
    fun `a corner beyond reach is left alone`() {
        val corner = p(500f, 300f)
        val candidate = p(560f, 360f)
        val r = snap(candidate, previous = p(0f, 0f), others = listOf(corner))
        assertTrue("should not have snapped to a corner 85px away", r.kind != SnapKind.VERTEX)
    }

    @Test
    fun `the nearest corner wins when several are in reach`() {
        val near = p(500f, 300f)
        val far = p(516f, 300f)
        val r = snap(p(504f, 300f), previous = p(0f, 0f), others = listOf(far, near))
        assertEquals(near, r.point)
    }

    @Test
    fun `a corner beats an angle`() {
        // Aiming at both a perfect 90 and an existing corner: the corner is
        // the one that has to be exact.
        val corner = p(100f, 4f)
        val r = snap(p(100f, 2f), previous = p(0f, 0f), others = listOf(corner))
        assertEquals(SnapKind.VERTEX, r.kind)
        assertEquals(corner, r.point)
    }

    // ----------------------------------------------------------------- angle

    @Test
    fun `a nearly horizontal run is pulled square`() {
        // 200px across, 9px down -- about 2.6 degrees off. Aiming at square.
        val r = snap(p(200f, 9f), previous = p(0f, 0f))
        assertTrue(r.kind == SnapKind.ANGLE || r.kind == SnapKind.ANGLE_AND_LENGTH)
        assertEquals(0f, r.point.y, 0.01f)
        assertEquals(0f, r.lockedAngleDeg!!, 0.01f)
    }

    @Test
    fun `a deliberately angled run is left exactly where it was put`() {
        // 30 degrees is nowhere near a multiple of 45, and 9.5 ft is nowhere
        // near a whole foot, so nothing at all should move. (Both halves
        // matter: the first draft of this test happened to sit at exactly
        // 10 ft and the LENGTH snap fired, correctly, which is a real case
        // covered on its own below.)
        val candidate = p(164.5f, 95f)
        val r = snap(candidate, previous = p(0f, 0f))
        assertEquals(SnapKind.NONE, r.kind)
        assertEquals(candidate, r.point)
    }

    @Test
    fun `an angled run at a whole foot keeps its angle and takes the round length`() {
        // 30 degrees, 10.0 ft. The heading is left alone; only the length is
        // tidied, and the point stays on the same ray out of the corner.
        val r = snap(p(173.2f, 100f), previous = p(0f, 0f))
        assertEquals(SnapKind.LENGTH, r.kind)
        assertNull("the heading was never near a lock angle", r.lockedAngleDeg)
        assertEquals(10f, r.lengthFt!!, 0.001f)
        val headingBefore = Math.toDegrees(Math.atan2(100.0, 173.2)).toFloat()
        val headingAfter = Math.toDegrees(Math.atan2(r.point.y.toDouble(), r.point.x.toDouble())).toFloat()
        assertEquals(headingBefore, headingAfter, 0.01f)
    }

    @Test
    fun `snapping preserves the distance the user reached out`() {
        val previous = p(0f, 0f)
        val candidate = p(200f, 9f)
        val before = dist(previous, candidate)
        val r = snapDrawPoint(candidate, previous, null, emptyList(), pxPerFt, lengthSnapFt = 0f)
        assertEquals("only the heading should change", before, dist(previous, r.point), 0.01f)
    }

    @Test
    fun `a forty-five is a lock angle too`() {
        val r = snap(p(100f, 96f), previous = p(0f, 0f))
        assertNotNull(r.lockedAngleDeg)
        assertEquals(45f, r.lockedAngleDeg!!, 0.01f)
        assertEquals(r.point.x, r.point.y, 0.01f)
    }

    @Test
    fun `a square turn off a slanted property line locks to the line, not the screen`() {
        // Previous segment runs at 30 degrees. A turn that is nearly 90 to
        // THAT should lock to 120 absolute -- the screen's own axes are not
        // the only thing a fence is square to.
        val beforePrev = p(0f, 0f)
        val prev = p(173.2f, 100f)                 // 30 degrees
        val candidate = p(prev.x - 47f, prev.y + 84f)  // roughly 120 degrees
        val r = snap(candidate, previous = prev, beforePrevious = beforePrev)
        assertNotNull("should have locked to the previous line's square", r.lockedAngleDeg)
        assertEquals(120f, r.lockedAngleDeg!!, 0.5f)
    }

    // ---------------------------------------------------------------- length

    @Test
    fun `a length a few inches off a whole foot becomes that whole foot`() {
        // 199.4px at 20px/ft is 9.97 ft. That is a tracing artifact.
        val r = snap(p(199.4f, 0f), previous = p(0f, 0f))
        assertEquals(10f, r.lengthFt!!, 0.001f)
        assertEquals(200f, r.point.x, 0.01f)
    }

    @Test
    fun `a length genuinely between feet is left alone`() {
        // 9.5 ft is half a foot from either neighbour: a real measurement.
        val r = snapDrawPoint(p(190f, 0f), p(0f, 0f), null, emptyList(), pxPerFt)
        assertNull("9.5 ft should not be rounded", r.lengthFt)
    }

    @Test
    fun `angle and length lock together and both are reported`() {
        val r = snap(p(199.4f, 8f), previous = p(0f, 0f))
        assertEquals(SnapKind.ANGLE_AND_LENGTH, r.kind)
        assertEquals(0f, r.lockedAngleDeg!!, 0.01f)
        assertEquals(10f, r.lengthFt!!, 0.001f)
        assertEquals(200f, r.point.x, 0.01f)
        assertEquals(0f, r.point.y, 0.01f)
    }

    @Test
    fun `a run shorter than a foot is never rounded to zero`() {
        // Rounding 0.4 ft to zero would put the point on top of the previous
        // one, which is a segment with no heading and no length.
        val r = snap(p(8f, 0f), previous = p(0f, 0f))
        assertNull(r.lengthFt)
        assertTrue(dist(p(0f, 0f), r.point) > 1f)
    }

    // ------------------------------------------------------------ edge cases

    @Test
    fun `the very first point of a run has nothing to snap to`() {
        val candidate = p(37f, 91f)
        val r = snap(candidate, previous = null)
        assertEquals(SnapKind.NONE, r.kind)
        assertEquals(candidate, r.point)
    }

    @Test
    fun `a point dropped on top of the previous one is left alone`() {
        val prev = p(50f, 50f)
        val r = snap(p(50f, 50f), previous = prev)
        assertEquals(SnapKind.NONE, r.kind)
    }

    @Test
    fun `an uncalibrated drawing still snaps to corners but not to feet`() {
        val corner = p(100f, 100f)
        val r = snapDrawPoint(p(105f, 103f), p(0f, 0f), null, listOf(corner), pxPerFt = 0f)
        assertEquals(SnapKind.VERTEX, r.kind)
        val far = snapDrawPoint(p(200f, 9f), p(0f, 0f), null, emptyList(), pxPerFt = 0f)
        assertEquals("without a scale there is no whole foot to find", SnapKind.NONE, far.kind)
    }

    @Test
    fun `nothing moves further than it had to`() {
        // Whatever the snap, the point should never travel more than the
        // tolerances allow -- a bigger jump than that is the user losing
        // control of where they put it.
        val prev = p(0f, 0f)
        val candidate = p(200f, 9f)
        val r = snap(candidate, previous = prev)
        assertTrue(
            "snapped point moved ${dist(candidate, r.point)}px, which is too far to be a correction",
            dist(candidate, r.point) < 30f
        )
    }

    @Test
    fun `locked angles are reported in a readable range`() {
        val r = snap(p(-200f, 6f), previous = p(0f, 0f))
        assertNotNull(r.lockedAngleDeg)
        assertTrue("got ${r.lockedAngleDeg}", r.lockedAngleDeg!! >= 0f && r.lockedAngleDeg!! < 360f)
        assertEquals(180f, r.lockedAngleDeg!!, 0.01f)
    }

    @Test
    fun `tolerance is respected at its edge`() {
        val prev = p(0f, 0f)
        // Just inside 7 degrees of horizontal.
        val inside = p(200f, (200.0 * Math.tan(Math.toRadians(6.5))).toFloat())
        assertTrue(snapDrawPoint(inside, prev, null, emptyList(), pxPerFt, lengthSnapFt = 0f).kind == SnapKind.ANGLE)
        // Just outside.
        val outside = p(200f, (200.0 * Math.tan(Math.toRadians(8.0))).toFloat())
        assertEquals(SnapKind.NONE, snapDrawPoint(outside, prev, null, emptyList(), pxPerFt, lengthSnapFt = 0f).kind)
    }

    @Test
    fun `a right angle off a horizontal run locks cleanly`() {
        val beforePrev = p(0f, 0f)
        val prev = p(200f, 0f)
        val r = snap(p(203f, 120f), previous = prev, beforePrevious = beforePrev)
        assertNotNull(r.lockedAngleDeg)
        assertEquals(200f, r.point.x, 0.01f)
        assertTrue("should run straight down from the corner", abs(r.point.y - 120f) < 6f)
    }
}
