package com.fenceestimator.app.geometry

import kotlin.math.hypot

/**
 * Erasing ONE WALL of a side, rather than the whole side.
 *
 * "When erasing the fence, it should only erase one side and if I want to erase
 * the other side, same thing."
 *
 * In this app a "side" is a RUN, and a run is a polyline -- an L or a U is one
 * run with two or three walls. Long-press erase removed the whole run, so
 * pressing any wall of an L took both.
 *
 * WHAT IT COSTS, decided by the owner: erasing a wall from the MIDDLE leaves
 * two separate fences, and they are billed as two. That is what is physically
 * there, and it means the total can go UP after an erase -- four end posts
 * where there were two, with their caps and concrete. Correct, and worth
 * saying out loud before he presses it.
 *
 * A gate on the erased wall goes with it, also his decision. The alternative --
 * shuffling it onto a neighbouring wall -- would silently re-price it against a
 * different side, and he might never see where it went.
 *
 * Pure, so the splitting and the gate reassignment can be driven off-device.
 * Every arm of this changes a quote.
 */
object SegmentErase {

    /**
     * What erasing segment [index] does. Segment i runs from points[i] to
     * points[i + 1].
     *
     * [keep] replaces the original run's points. [split] is a NEW run when the
     * erase cut the line in two, and empty otherwise. Gates are divided the
     * same way, and [removed] are the ones that were on the erased wall.
     */
    data class Plan(
        val keep: List<FencePoint>,
        val split: List<FencePoint>,
        val keptGates: List<GateMarker>,
        val splitGates: List<GateMarker>,
        val removed: List<GateMarker>,
        /** Nothing worth keeping is left: the caller should delete the run. */
        val eraseWholeRun: Boolean,
    ) {
        val splitsInTwo: Boolean get() = split.size >= 2
    }

    fun plan(points: List<FencePoint>, gates: List<GateMarker>, index: Int): Plan {
        val lastSegment = points.size - 2
        if (points.size < 2 || index < 0 || index > lastSegment) {
            // Nothing to erase. Returning the input unchanged rather than
            // throwing: a stray press must not be able to crash the drawing.
            return Plan(points, emptyList(), gates, emptyList(), emptyList(), false)
        }

        // A single wall IS the whole side.
        if (points.size == 2) {
            return Plan(emptyList(), emptyList(), emptyList(), emptyList(), gates, true)
        }

        val keep: List<FencePoint>
        val split: List<FencePoint>
        when (index) {
            // First wall: drop the first point and the side simply starts later.
            0 -> { keep = points.drop(1); split = emptyList() }
            // Last wall: drop the last point.
            lastSegment -> { keep = points.dropLast(1); split = emptyList() }
            // A wall in the middle leaves TWO fences.
            else -> { keep = points.take(index + 1); split = points.drop(index + 1) }
        }

        // Each gate belongs to the wall it sits nearest. Gates on the erased
        // wall go; the rest follow whichever piece their wall ended up on.
        val kept = ArrayList<GateMarker>()
        val moved = ArrayList<GateMarker>()
        val gone = ArrayList<GateMarker>()
        for (g in gates) {
            when (val owner = nearestSegment(points, g)) {
                index -> gone.add(g)
                else -> if (split.isNotEmpty() && owner > index) moved.add(g) else kept.add(g)
            }
        }

        val keepUsable = keep.size >= 2
        return Plan(
            keep = if (keepUsable) keep else emptyList(),
            split = split,
            keptGates = if (keepUsable) kept else emptyList(),
            splitGates = moved,
            // A gate whose piece of fence did not survive goes with it, rather
            // than being silently re-matched to the other piece.
            removed = if (keepUsable) gone else gone + kept,
            eraseWholeRun = !keepUsable && split.size < 2,
        )
    }

    /** Index of the segment a gate sits nearest, or -1 when there are none. */
    fun nearestSegment(points: List<FencePoint>, gate: GateMarker): Int {
        var best = -1
        var bestDistance = Float.MAX_VALUE
        for (i in 0 until points.size - 1) {
            val d = distanceToSegment(gate.x, gate.y, points[i], points[i + 1])
            if (d < bestDistance) { bestDistance = d; best = i }
        }
        return best
    }

    private fun distanceToSegment(px: Float, py: Float, a: FencePoint, b: FencePoint): Float {
        val dx = b.x - a.x
        val dy = b.y - a.y
        val lengthSq = dx * dx + dy * dy
        if (lengthSq <= 0f) return hypot(px - a.x, py - a.y)
        val t = (((px - a.x) * dx + (py - a.y) * dy) / lengthSq).coerceIn(0f, 1f)
        return hypot(px - (a.x + t * dx), py - (a.y + t * dy))
    }
}
