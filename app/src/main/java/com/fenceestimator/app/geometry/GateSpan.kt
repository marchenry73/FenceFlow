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
    /**
     * Which segment of the run it landed on, for anything that needs to know.
     * [GateGeometry.NO_SEGMENT] (-1) for a gate standing on its own with no
     * fence line under it ([GateGeometry.standaloneSpan]) -- never a valid
     * index, so anything matching spans to segments simply never matches it.
     */
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

    /** [GateSpan.segmentIndex] for a gate that sits on no segment at all. */
    const val NO_SEGMENT = -1

    /**
     * The opening a gate makes when there is no fence line for it to sit in:
     * a standalone gate sale, on a run with no corners.
     *
     * [spanFor] has nothing to snap to there and returns null, and the plan
     * drew gates only from [spanFor] -- so a gate sold on its own was priced,
     * listed and charged for, and never appeared on the drawing. With no fence
     * to point along, it is laid level, its full width centred on exactly the
     * point it was placed at, the way a gate is drawn on a blank site plan.
     *
     * The span belongs to no segment ([NO_SEGMENT]), so no fence is cut around
     * it.
     *
     * @return null when there is no scale to measure with, or no width to
     *   draw -- the same refusals [spanFor] makes.
     */
    fun standaloneSpan(gate: GateMarker, pixelsPerFoot: Float): GateSpan? {
        if (pixelsPerFoot <= 0f || gate.widthFt <= 0f) return null
        val halfWidth = (gate.widthFt * pixelsPerFoot) / 2f
        return GateSpan(
            start = FencePoint(gate.x - halfWidth, gate.y),
            end = FencePoint(gate.x + halfWidth, gate.y),
            centre = FencePoint(gate.x, gate.y),
            segmentIndex = NO_SEGMENT
        )
    }

    /**
     * Every gate on one run, paired with the opening it makes -- worked out
     * once and used both for the gaps cut in that run's fence and for the
     * gates drawn into them.
     *
     * The plan used to do this for the selected run only. Every other run was
     * drawn as a bare faded line and a run with no line at all was skipped,
     * so on a job with a back fence and a side fence, or a standalone gate on
     * a run of its own, most of the gates being charged for were not on the
     * drawing. One function for every run means they are all placed by the
     * same rule.
     *
     * A gate with no line under it -- a gate-only run, or a run whose corners
     * sit on top of each other -- is laid level where it was placed
     * ([standaloneSpan]) rather than dropped.
     *
     * @param pixelsPerFoot null or not positive when the drawing has no scale
     *   yet. Nothing can be drawn at its true width then, so the list is empty.
     */
    fun spansFor(
        gates: List<GateMarker>,
        points: List<FencePoint>,
        closedLoop: Boolean,
        pixelsPerFoot: Float?
    ): List<Pair<GateMarker, GateSpan>> {
        if (pixelsPerFoot == null || pixelsPerFoot <= 0f) return emptyList()
        return gates.mapNotNull { gate ->
            (spanFor(gate, points, closedLoop, pixelsPerFoot) ?: standaloneSpan(gate, pixelsPerFoot))
                ?.let { span -> gate to span }
        }
    }

    /**
     * The stretches of fence still standing on a whole run once its gates have
     * cut their openings: [segmentGaps] for every side, the closing side of a
     * closed loop included.
     *
     * Shared by the selected run and every other run on the plan, so an
     * opening reads as a way through on all of them rather than only on the
     * one being edited. A standalone span belongs to no side ([NO_SEGMENT]),
     * so it cuts nothing.
     */
    fun fencePieces(
        points: List<FencePoint>,
        closedLoop: Boolean,
        spans: List<GateSpan>
    ): List<Pair<FencePoint, FencePoint>> {
        val segmentCount = if (closedLoop) points.size else points.size - 1
        val pieces = mutableListOf<Pair<FencePoint, FencePoint>>()
        for (i in 0 until max(0, segmentCount)) {
            val a = points[i]
            val b = points[(i + 1) % points.size]
            pieces += segmentGaps(a, b, spans.filter { it.segmentIndex == i })
        }
        return pieces
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
