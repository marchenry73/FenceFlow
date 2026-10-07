package com.fenceestimator.app.geometry

import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.hypot

/**
 * A curved fence, as the points a curved fence is actually built from.
 *
 * "Need to be able to add fences that are curved even though we're going to be
 * barely use that option."
 *
 * A curve does not need a new kind of run, a new column or a word of new
 * pricing. A fence that follows a curve is built as a series of short straight
 * bays -- that is what the panels are -- so a curve IS a polyline, and the
 * engine already prices polylines correctly: it measures their length, spaces
 * posts along it, and counts the vertices.
 *
 * THE ONE THING THAT MUST NOT HAPPEN is a vertex turning
 * [FenceGeometryEngine.CORNER_ANGLE_THRESHOLD_DEGREES] or more, because that
 * vertex stops being a line post and becomes a CORNER post -- a different
 * catalog row at a different price, silently, on a run that looks smooth. So
 * this does not take a segment count: it takes the sharpest turn it is allowed
 * to produce, and subdivides until it is under it. A curve generated here is
 * all line posts by construction, and [sharpestTurnDegrees] lets a caller or a
 * test prove it rather than trust it.
 *
 * Pure, and in the geometry package rather than the ViewModel, so the maths can
 * be tested off-device -- which is where this project's bugs have consistently
 * NOT been.
 */
object CurvedRun {

    /** Fewer than this and a gentle curve reads as a chamfer. */
    private const val MIN_SEGMENTS = 6

    /**
     * Enough to keep every turn small on any curve a fence line plausibly
     * follows, and a hard stop on the subdivision loop. At 128 segments a
     * 180-degree bow turns about 1.4 degrees per vertex.
     */
    private const val MAX_SEGMENTS = 128

    /**
     * The points of a curve that starts at [start], ends at [end] and passes
     * THROUGH [through].
     *
     * Three taps, which is the least a curve can be described in: where it
     * starts, where it ends, and how far it bows out. [through] is a point on
     * the curve itself rather than a control point, because nobody standing in
     * a garden thinks in control points -- he taps where the fence actually has
     * to run.
     *
     * The returned list INCLUDES both ends, so it can be appended to a run
     * whose last point is [start] by dropping the first element.
     *
     * A quadratic Bezier is used because it is the only curve through three
     * points that is always defined: a circular arc through three points fails
     * when they are collinear, which is exactly what a near-straight bow is,
     * and that is a real thing to draw.
     */
    fun through(
        start: FencePoint,
        through: FencePoint,
        end: FencePoint,
        maxTurnDegrees: Float = FenceGeometryEngine.CORNER_ANGLE_THRESHOLD_DEGREES - 3f,
    ): List<FencePoint> {
        // B(t) = (1-t)^2*A + 2(1-t)t*P + t^2*B. At t = 0.5 that is
        // (A + 2P + B) / 4, so to pass through C at the midpoint:
        //     P = (4C - A - B) / 2
        val cx = (4f * through.x - start.x - end.x) / 2f
        val cy = (4f * through.y - start.y - end.y) / 2f

        var segments = MIN_SEGMENTS
        var points = sample(start, FencePoint(cx, cy), end, segments)
        // Subdivide until no vertex turns far enough to be billed as a corner.
        // Doubling rather than stepping: a curve needing 40 segments should not
        // be found by trying 7, 8, 9...
        while (segments < MAX_SEGMENTS && sharpestTurnDegrees(points) >= maxTurnDegrees) {
            segments = (segments * 2).coerceAtMost(MAX_SEGMENTS)
            points = sample(start, FencePoint(cx, cy), end, segments)
        }
        return points
    }

    /** The sharpest turn at any interior vertex, in degrees. 0 for a straight line. */
    fun sharpestTurnDegrees(points: List<FencePoint>): Float {
        if (points.size < 3) return 0f
        var worst = 0f
        for (i in 1 until points.size - 1) {
            val inAngle = atan2(
                (points[i].y - points[i - 1].y).toDouble(),
                (points[i].x - points[i - 1].x).toDouble(),
            )
            val outAngle = atan2(
                (points[i + 1].y - points[i].y).toDouble(),
                (points[i + 1].x - points[i].x).toDouble(),
            )
            var turn = outAngle - inAngle
            while (turn > Math.PI) turn -= 2 * Math.PI
            while (turn < -Math.PI) turn += 2 * Math.PI
            val deg = Math.toDegrees(abs(turn)).toFloat()
            if (deg > worst) worst = deg
        }
        return worst
    }

    /** Straight-line length through the points, in drawing units. */
    fun length(points: List<FencePoint>): Float {
        var total = 0f
        for (i in 1 until points.size) {
            total += hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
        }
        return total
    }

    private fun sample(
        a: FencePoint,
        control: FencePoint,
        b: FencePoint,
        segments: Int,
    ): List<FencePoint> {
        val out = ArrayList<FencePoint>(segments + 1)
        for (i in 0..segments) {
            val t = i.toFloat() / segments
            val u = 1f - t
            out.add(
                FencePoint(
                    u * u * a.x + 2f * u * t * control.x + t * t * b.x,
                    u * u * a.y + 2f * u * t * control.y + t * t * b.y,
                )
            )
        }
        return out
    }
}
