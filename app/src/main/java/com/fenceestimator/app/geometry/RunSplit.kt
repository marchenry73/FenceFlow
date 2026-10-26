package com.fenceestimator.app.geometry

import kotlin.math.abs
import kotlin.math.sqrt

/**
 * CUTTING ONE SIDE IN TWO, so part of it can be a different height.
 *
 * "I need to mark a side or a part of a side as a 4ft, and the other part as
 * 6ft." Height lives on the RUN (FenceRun.panelHeightFt), and a run is one
 * polyline, so until now a side was one height end to end. The fix is not a
 * per-segment height -- that would mean a second height everywhere a height is
 * read: in the engine, in the server's port of it, on the pull sheet, the crew
 * plan, the quote page and the contract email. It is letting him cut the side
 * where the height changes. Two runs, each with its own height, and every one
 * of those surfaces already loops over runs.
 *
 * BY DISTANCE, not by corner. [SegmentErase] already splits a run at a corner
 * and divides the gates, and the drawing uses it for erase. But the case he is
 * describing is the common one: a single straight side, the first 40 ft at 6 ft
 * and the rest at 4 ft. A straight side has no corner to cut at, so a corner
 * picker would not answer the question at all. A distance does, and a corner is
 * only a distance that already has a point on it -- [cornerDistancesFeet] hands
 * those out so they can be offered as one-tap shortcuts.
 *
 * THE CUT POINT IS A REAL POINT, carried by both halves, so the two sides meet
 * rather than leaving a gap the takeoff would not bill. Within [VERTEX_SNAP_FT]
 * of an existing corner the cut uses that corner instead of adding a
 * near-duplicate a hair away from it, which would read as a stray vertex on the
 * plan and classify as a 0-degree line post.
 *
 * GATES GO WITH THE SIDE THEIR CENTRE IS ON, because a gate is stored as a
 * point and a width ([GateMarker]) with nothing tying it to a stretch of line.
 * When the cut falls inside a gate's opening the plan says so
 * ([Plan.cutsThroughGate]) and the cut is NOT moved: the number he typed is the
 * number he gets, and the caller can tell him which side kept the gate.
 * Silently sliding the cut to the gate's edge would move his footage by a few
 * feet without saying so, and the footage is what the price is made of.
 */
object RunSplit {

    /**
     * No piece shorter than this. Not a fencing rule -- a guard against a run
     * whose points sit on top of each other, which measures zero and would
     * price as a side with no length. It also keeps [VERTEX_SNAP_FT] from ever
     * snapping the cut onto the first or last point, which is the other way to
     * produce that empty piece.
     */
    const val MIN_PIECE_FT = 0.5f

    /** A cut this close to an existing corner uses that corner. */
    const val VERTEX_SNAP_FT = 0.25f

    enum class Refusal {
        /** Fewer than two points, or no usable pixels-per-foot calibration. */
        NOT_MEASURABLE,

        /** The cut is off the end of the side, or would leave a piece with no length. */
        TOO_SHORT,
    }

    data class Plan(
        /** Replaces the original run's points. */
        val first: List<FencePoint>,
        /** The new run's points. Its first point is [first]'s last. */
        val second: List<FencePoint>,
        val firstGates: List<GateMarker>,
        val secondGates: List<GateMarker>,
        val firstFeet: Float,
        val secondFeet: Float,
        /**
         * The cut landed inside this gate's opening. The gate still belongs
         * wholly to one side (whichever its centre is on) and the cut has NOT
         * been moved; this is here so the caller can say which side kept it.
         */
        val cutsThroughGate: GateMarker?,
        val refusal: Refusal?,
    ) {
        val ok: Boolean get() = refusal == null && first.size >= 2 && second.size >= 2
    }

    /** How many drawn segments a run has. A closed loop has one more than it has corners. */
    fun segmentCount(points: List<FencePoint>, closedLoop: Boolean): Int = when {
        points.size < 2 -> 0
        closedLoop -> points.size
        else -> points.size - 1
    }

    private fun lenPx(a: FencePoint, b: FencePoint): Float {
        // sqrt rather than hypot, for the reason FenceGeometryEngine gives: the
        // server's port of the engine has to land on the same float.
        val dx = (b.x - a.x).toDouble()
        val dy = (b.y - a.y).toDouble()
        return sqrt(dx * dx + dy * dy).toFloat()
    }

    private fun usable(pixelsPerFoot: Float): Boolean =
        pixelsPerFoot > 0f && pixelsPerFoot.isFinite()

    /** The whole side's length -- the figure a cut distance is measured against. */
    fun totalFeet(points: List<FencePoint>, closedLoop: Boolean, pixelsPerFoot: Float): Float =
        if (!usable(pixelsPerFoot)) 0f
        else FenceGeometryEngine.pixelLength(points, closedLoop) / pixelsPerFoot

    /**
     * How far along the side each corner sits, so the caller can offer them as
     * one-tap cut points. The far END is not a corner and is left out -- a cut
     * there leaves nothing on the other piece.
     */
    fun cornerDistancesFeet(
        points: List<FencePoint>,
        closedLoop: Boolean,
        pixelsPerFoot: Float,
    ): List<Float> {
        if (points.size < 3 || !usable(pixelsPerFoot)) return emptyList()
        val segs = segmentCount(points, closedLoop)
        val out = ArrayList<Float>()
        var acc = 0f
        for (i in 0 until segs) {
            acc += lenPx(points[i], points[(i + 1) % points.size])
            // The end of the last segment is the end of the side, not a corner.
            if (i < segs - 1) out.add(acc / pixelsPerFoot)
        }
        return out
    }

    /** How far along the side a gate's centre sits, in feet, or null if unmeasurable. */
    fun gateDistanceFeet(
        points: List<FencePoint>,
        closedLoop: Boolean,
        pixelsPerFoot: Float,
        gate: GateMarker,
    ): Float? {
        if (points.size < 2 || !usable(pixelsPerFoot)) return null
        val owner = nearestSegment(points, closedLoop, gate) ?: return null
        var acc = 0f
        for (i in 0 until owner) acc += lenPx(points[i], points[(i + 1) % points.size])
        val a = points[owner]
        val b = points[(owner + 1) % points.size]
        return (acc + projectionPx(gate, a, b)) / pixelsPerFoot
    }

    /**
     * Which segment a gate sits nearest.
     *
     * Unlike [SegmentErase.nearestSegment] this counts a closed loop's closing
     * segment, which is drawn by the flag and not by a point -- a gate on that
     * stretch would otherwise be handed to whichever other wall happened to be
     * next nearest.
     */
    fun nearestSegment(points: List<FencePoint>, closedLoop: Boolean, gate: GateMarker): Int? {
        val segs = segmentCount(points, closedLoop)
        if (segs <= 0) return null
        var best = 0
        var bestDistance = Float.MAX_VALUE
        for (i in 0 until segs) {
            val d = distanceToSegment(gate, points[i], points[(i + 1) % points.size])
            if (d < bestDistance) {
                bestDistance = d
                best = i
            }
        }
        return best
    }

    /** How far along a -> b the gate's centre projects, in pixels, clamped to the segment. */
    private fun projectionPx(gate: GateMarker, a: FencePoint, b: FencePoint): Float {
        val dx = b.x - a.x
        val dy = b.y - a.y
        val lengthSq = dx * dx + dy * dy
        if (lengthSq <= 0f) return 0f
        val t = (((gate.x - a.x) * dx + (gate.y - a.y) * dy) / lengthSq).coerceIn(0f, 1f)
        return t * sqrt(lengthSq.toDouble()).toFloat()
    }

    private fun distanceToSegment(gate: GateMarker, a: FencePoint, b: FencePoint): Float {
        val dx = b.x - a.x
        val dy = b.y - a.y
        val lengthSq = dx * dx + dy * dy
        if (lengthSq <= 0f) return lenPx(FencePoint(gate.x, gate.y), a)
        val t = (((gate.x - a.x) * dx + (gate.y - a.y) * dy) / lengthSq).coerceIn(0f, 1f)
        return lenPx(FencePoint(gate.x, gate.y), FencePoint(a.x + t * dx, a.y + t * dy))
    }

    /**
     * Cut the side [atFeet] from its start.
     *
     * Both pieces come back OPEN, a closed loop included: a loop cut once is
     * one line, not two, so the far piece carries the loop's closing stretch
     * explicitly by ending back at the first point. The perimeter is the same
     * either way, which is what keeps the price the same across a cut that was
     * only meant to change a height.
     */
    fun plan(
        points: List<FencePoint>,
        gates: List<GateMarker>,
        closedLoop: Boolean,
        atFeet: Float,
        pixelsPerFoot: Float,
    ): Plan {
        val nothing = Plan(
            first = emptyList(), second = emptyList(),
            firstGates = emptyList(), secondGates = emptyList(),
            firstFeet = 0f, secondFeet = 0f, cutsThroughGate = null,
            refusal = Refusal.NOT_MEASURABLE,
        )
        if (points.size < 2 || !usable(pixelsPerFoot) || !atFeet.isFinite()) return nothing

        val total = totalFeet(points, closedLoop, pixelsPerFoot)
        if (total <= 2f * MIN_PIECE_FT) return nothing.copy(refusal = Refusal.TOO_SHORT)
        if (atFeet < MIN_PIECE_FT || atFeet > total - MIN_PIECE_FT) {
            return nothing.copy(refusal = Refusal.TOO_SHORT)
        }

        val n = points.size
        val segs = segmentCount(points, closedLoop)
        val atPx = atFeet * pixelsPerFoot

        // Which segment the cut falls on, and how far into it.
        var cutSegment = segs - 1
        var intoPx = 0f
        var acc = 0f
        for (i in 0 until segs) {
            val l = lenPx(points[i], points[(i + 1) % n])
            if (acc + l >= atPx || i == segs - 1) {
                cutSegment = i
                intoPx = atPx - acc
                break
            }
            acc += l
        }
        val a = points[cutSegment]
        val b = points[(cutSegment + 1) % n]
        val segLen = lenPx(a, b)
        val t = if (segLen <= 0f) 0f else (intoPx / segLen).coerceIn(0f, 1f)

        // Snapped to a corner, or a new point mid-wall. MIN_PIECE_FT is wider
        // than VERTEX_SNAP_FT, so neither branch can land on the first or the
        // last point and leave a piece with nothing in it.
        val snapPx = VERTEX_SNAP_FT * pixelsPerFoot
        val atStartCorner = intoPx <= snapPx
        val atEndCorner = (segLen - intoPx) <= snapPx

        val first: List<FencePoint>
        val second: List<FencePoint>
        // Where the boundary sits along cutSegment, for dividing that segment's
        // gates: 0 when the cut snapped back to the segment's start corner, 1
        // when it snapped forward to its end corner.
        val boundaryT: Float
        when {
            atStartCorner -> {
                first = points.take(cutSegment + 1)
                second = points.drop(cutSegment).let { if (closedLoop) it + points[0] else it }
                boundaryT = 0f
            }
            atEndCorner -> {
                val v = cutSegment + 1
                first = points.take(v + 1)
                second = points.drop(v).let { if (closedLoop) it + points[0] else it }
                boundaryT = 1f
            }
            else -> {
                val cut = FencePoint(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
                first = points.take(cutSegment + 1) + cut
                second = (listOf(cut) + points.drop(cutSegment + 1))
                    .let { if (closedLoop) it + points[0] else it }
                boundaryT = t
            }
        }

        // A side with one point is not a side. Only reachable from points that
        // disagree with the calibration they came with; returning the input
        // untouched beats throwing out of the drawing.
        if (first.size < 2 || second.size < 2) return nothing.copy(refusal = Refusal.TOO_SHORT)

        val near = ArrayList<GateMarker>()
        val far = ArrayList<GateMarker>()
        var through: GateMarker? = null
        for (g in gates) {
            val owner = nearestSegment(points, closedLoop, g)
            val mine = when {
                owner == null -> true
                owner < cutSegment -> true
                owner > cutSegment -> false
                // On the cut's own wall: whichever side of the boundary the
                // gate's centre projects to.
                else -> {
                    val gt = if (segLen <= 0f) 0f
                    else (projectionPx(g, a, b) / segLen).coerceIn(0f, 1f)
                    gt <= boundaryT
                }
            }
            if (mine) near.add(g) else far.add(g)
            if (through == null && g.widthFt > 0f) {
                val d = gateDistanceFeet(points, closedLoop, pixelsPerFoot, g)
                if (d != null && abs(d - atFeet) < g.widthFt / 2f) through = g
            }
        }

        return Plan(
            first = first,
            second = second,
            firstGates = near,
            secondGates = far,
            firstFeet = FenceGeometryEngine.pixelLength(first, false) / pixelsPerFoot,
            secondFeet = FenceGeometryEngine.pixelLength(second, false) / pixelsPerFoot,
            cutsThroughGate = through,
            refusal = null,
        )
    }

    /**
     * What to call the far piece.
     *
     * "Side 1 part 2" beside "Side 1", rather than the next free "Side N" the
     * drawing screen hands out for a brand new side. The two halves of one side
     * ARE one side as far as he is concerned, and calling them "Side 1" and
     * "Side 4" makes the pair unreadable on the list, on the pull sheet and on
     * the customer's quote. The original is left named what he named it: a cut
     * meant to change a height has no business renaming his work.
     */
    fun splitLabel(original: String, taken: List<String>): String {
        val stem = original.trim().ifBlank { "Side" }
        val lower = taken.map { it.trim().lowercase() }.toSet()
        var n = 2
        while (lower.contains("$stem part $n".lowercase())) n++
        return "$stem part $n"
    }

    /** What a cut does to a side whose footage was TYPED rather than drawn. */
    data class TypedPlan(val firstFeet: Float, val secondFeet: Float, val refusal: Refusal?) {
        val ok: Boolean get() = refusal == null
    }

    /**
     * A side with FenceRun.manualLinearFeet set has no drawing to cut, so the
     * cut is arithmetic on the figure he typed: this much, and the rest. It is
     * offered because it is the likeliest case of all -- he knows the side is
     * 100 ft and that 40 of it is the low fence, and has drawn nothing.
     */
    fun planTyped(totalFeet: Float, atFeet: Float): TypedPlan {
        if (!totalFeet.isFinite() || !atFeet.isFinite() || totalFeet <= 2f * MIN_PIECE_FT) {
            return TypedPlan(0f, 0f, Refusal.TOO_SHORT)
        }
        if (atFeet < MIN_PIECE_FT || atFeet > totalFeet - MIN_PIECE_FT) {
            return TypedPlan(0f, 0f, Refusal.TOO_SHORT)
        }
        return TypedPlan(atFeet, totalFeet - atFeet, null)
    }
}
