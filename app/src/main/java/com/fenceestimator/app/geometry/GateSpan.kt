package com.fenceestimator.app.geometry

import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * Where a gate actually sits on the fence line, and how much of it it takes up.
 *
 * A gate used to be drawn as a fixed little square wherever it was dropped, so
 * a 3ft walk gate and a 16ft double gate looked identical and neither occupied
 * any real width. On a plan somebody builds from, that is the difference
 * between a gap that fits and one that does not -- and it is the drawing the
 * crew works to.
 *
 * A gate is stored as a loose point near the line rather than as a position
 * along it, so the first job is finding which run of fence it belongs to.
 */
data class GateSpan(
    /** Where the gate opening starts, in the drawing's own coordinates. */
    val start: FencePoint,
    /** Where it ends. [start] to [end] is exactly the gate's width. */
    val end: FencePoint,
    /** The point on the line the gate was matched to. */
    val centre: FencePoint,
    /** Which segment of the run it landed on, for anything that needs to know. */
    val segmentIndex: Int
)

object GateGeometry {

    /**
     * Works out the opening a gate makes in the fence.
     *
     * The gate is snapped to the nearest point on the line and then extended
     * along that segment's direction by its own width -- half each side of
     * where it was placed. So a 5ft gate takes exactly 5ft of fence, pointing
     * the way the fence points, which is what makes it read as part of the
     * fence rather than a sticker on top of it.
     *
     * @param pixelsPerFoot the drawing's scale. Without it there is no way to
     *   turn a width in feet into a width on the plan.
     * @return null when there is no line to sit on, or no scale to measure
     *   with. A gate that cannot be placed truthfully is better not drawn as a
     *   span at all.
     */
    fun spanFor(
        gate: GateMarker,
        points: List<FencePoint>,
        closedLoop: Boolean,
        pixelsPerFoot: Float
    ): GateSpan? {
        if (points.size < 2 || pixelsPerFoot <= 0f || gate.widthFt <= 0f) return null

        val n = points.size
        val segmentCount = if (closedLoop) n else n - 1

        var bestIndex = -1
        var bestPoint = FencePoint(gate.x, gate.y)
        var bestDistance = Float.MAX_VALUE

        for (i in 0 until segmentCount) {
            val a = points[i]
            val b = points[(i + 1) % n]
            val projected = closestPointOnSegment(gate.x, gate.y, a, b)
            val distance = hypot((projected.x - gate.x).toDouble(), (projected.y - gate.y).toDouble()).toFloat()
            if (distance < bestDistance) {
                bestDistance = distance
                bestPoint = projected
                bestIndex = i
            }
        }
        if (bestIndex < 0) return null

        val a = points[bestIndex]
        val b = points[(bestIndex + 1) % n]
        val dx = b.x - a.x
        val dy = b.y - a.y
        val length = hypot(dx.toDouble(), dy.toDouble()).toFloat()
        // A segment with no length has no direction to lay a gate along.
        if (length <= 0f) return null

        val ux = dx / length
        val uy = dy / length
        val halfWidth = (gate.widthFt * pixelsPerFoot) / 2f

        return GateSpan(
            start = FencePoint(bestPoint.x - ux * halfWidth, bestPoint.y - uy * halfWidth),
            end = FencePoint(bestPoint.x + ux * halfWidth, bestPoint.y + uy * halfWidth),
            centre = bestPoint,
            segmentIndex = bestIndex
        )
    }

    /** The point on segment a-b closest to (px, py). */
    fun closestPointOnSegment(px: Float, py: Float, a: FencePoint, b: FencePoint): FencePoint {
        val dx = b.x - a.x
        val dy = b.y - a.y
        val lengthSquared = dx * dx + dy * dy
        if (lengthSquared <= 0f) return a
        // How far along the segment the perpendicular lands, clamped so a gate
        // dropped past the end of a run sits at the end rather than off it.
        val t = (((px - a.x) * dx + (py - a.y) * dy) / lengthSquared).coerceIn(0f, 1f)
        return FencePoint(a.x + dx * t, a.y + dy * t)
    }

    /**
     * Splits one fence segment around the gates that interrupt it.
     *
     * The fence is drawn as the pieces either side of each opening rather than
     * as one line with a gate symbol laid over it. That is what makes a gate
     * read as a way through instead of a decoration -- and it makes an opening
     * too wide for its run visible, because the fence either side disappears.
     *
     * @return the stretches of fence still standing on this segment, in order.
     */
    fun segmentGaps(
        a: FencePoint,
        b: FencePoint,
        spansOnSegment: List<GateSpan>
    ): List<Pair<FencePoint, FencePoint>> {
        val length = hypot((b.x - a.x).toDouble(), (b.y - a.y).toDouble()).toFloat()
        if (length <= 0f) return emptyList()
        if (spansOnSegment.isEmpty()) return listOf(a to b)

        val ux = (b.x - a.x) / length
        val uy = (b.y - a.y) / length
        fun distanceAlong(p: FencePoint) = (p.x - a.x) * ux + (p.y - a.y) * uy
        fun pointAt(d: Float) = FencePoint(a.x + ux * d, a.y + uy * d)

        // Openings in the order they occur, clamped to the segment so a gate
        // hanging off the end does not produce a piece of fence with a negative
        // length.
        val openings = spansOnSegment
            .map { span ->
                val from = distanceAlong(span.start)
                val to = distanceAlong(span.end)
                min(from, to).coerceIn(0f, length) to max(from, to).coerceIn(0f, length)
            }
            .sortedBy { it.first }

        val pieces = mutableListOf<Pair<FencePoint, FencePoint>>()
        var cursor = 0f
        for ((from, to) in openings) {
            if (from > cursor) pieces.add(pointAt(cursor) to pointAt(from))
            // Overlapping gates must not walk the cursor backwards, or the
            // fence would be drawn back over an opening already made.
            cursor = max(cursor, to)
        }
        if (cursor < length) pieces.add(pointAt(cursor) to b)
        return pieces
    }
}
