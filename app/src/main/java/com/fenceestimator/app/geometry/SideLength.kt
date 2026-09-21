package com.fenceestimator.app.geometry

import kotlin.math.nextDown
import kotlin.math.nextUp
import kotlin.math.sqrt

/**
 * How many sides a run has: one fewer than its corners when it is open, as
 * many as its corners when it closes on itself. The same count
 * [FenceGeometryEngine.analyze] uses, so a side index means the same thing
 * here, in the takeoff and on the screen.
 */
fun sideCount(pointCount: Int, closedLoop: Boolean): Int = when {
    pointCount < 2 -> 0
    closedLoop -> pointCount
    else -> pointCount - 1
}

/**
 * The length of side [index] in feet, exactly as the takeoff measures it.
 *
 * Read through [FenceGeometryEngine.analyze] itself rather than a second
 * formula, so the number on a dimension label, the number in the "set this
 * length" dialog and the number the estimate prices are one number. It also
 * covers a closed loop's closing side (last corner back to the first), which
 * [segmentLengthPx] does not -- that gap is why the closing side used to have
 * no dimension on the plan and why tapping its chip did nothing.
 */
fun sideLengthFeet(points: List<FencePoint>, index: Int, pxPerFt: Float, closedLoop: Boolean): Float? {
    if (!pxPerFt.isFinite() || pxPerFt <= 0f) return null
    if (index !in 0 until sideCount(points.size, closedLoop)) return null
    return measuredFeet(points[index], points[(index + 1) % points.size], pxPerFt)
}

/** True when side [index] of a closed run is the one that closes the loop. */
fun isClosingSide(pointCount: Int, index: Int, closedLoop: Boolean): Boolean =
    closedLoop && pointCount >= 2 && index == pointCount - 1

/** A drawing after one side has been set to a typed length. */
data class SideLengthEdit(
    val points: List<FencePoint>,
    val gates: List<GateMarker>,
    /**
     * False when no gate had to move, so the caller can leave the stored gate
     * string byte-for-byte as it was instead of re-encoding it.
     */
    val gatesMoved: Boolean,
)

/**
 * Sets side [index] to exactly [feet], the way a tape measurement is typed in.
 *
 * **An open side** (`points[index]` to `points[index+1]`): the far corner
 * slides along the side's current heading until the side is [feet] long, and
 * everything after it follows rigidly -- every later side keeps its heading and
 * its length -- so correcting the first leg of an L does not quietly change the
 * second leg nobody touched. Earlier corners never move. On a closed loop the
 * closing side is the one that gives, as it always has.
 *
 * **The closing side** of a closed loop (last corner back to the first): the
 * first corner is where the run starts and everything was measured from, so it
 * stays; the LAST corner slides along the closing side until that side is
 * [feet] long. The side arriving at that last corner changes to meet it -- in a
 * closed shape one other side always has to give, and this is the only choice
 * that moves a single corner. Before this, the closing side's chip was on
 * screen and did nothing at all when tapped.
 *
 * **Gates ride with their side.** A gate is a loose point matched to the
 * nearest side ([GateGeometry.spanFor], the same match the plan draws with);
 * it moves with that side, staying the same fraction of the way along it. A
 * gate left behind while its fence moved would silently re-match to another
 * side on the plan the crew builds from.
 *
 * **The typed number is the number the takeoff sees.** Screen coordinates are
 * floats, and a corner placed "at" 48 ft along a diagonal can measure
 * 48.000004 ft -- which the takeoff rounds UP into a ninth 6 ft bay (an extra
 * panel, post, cap and bag) and which can tip a grand total rounded up to the
 * next ten dollars. So the far corner is landed on the float coordinates that
 * [FenceGeometryEngine.analyze] measures as exactly [feet], or, where no
 * coordinates do, the nearest ones that measure a hair UNDER it -- never over.
 * Later sides are re-landed the same way at the lengths they measured before,
 * so a side typed earlier stays exactly what was typed.
 *
 * Returns null rather than guessing: no such side, a side whose two corners
 * sit on top of each other (no heading to stretch along), a closing side on a
 * "loop" of fewer than three corners, a length or scale that is not a positive
 * number.
 */
fun setSideLength(
    points: List<FencePoint>,
    gates: List<GateMarker>,
    index: Int,
    feet: Float,
    pxPerFt: Float,
    closedLoop: Boolean,
): SideLengthEdit? {
    if (!feet.isFinite() || feet <= 0f) return null
    if (!pxPerFt.isFinite() || pxPerFt <= 0f) return null
    val n = points.size
    if (index !in 0 until sideCount(n, closedLoop)) return null
    val closing = isClosingSide(n, index, closedLoop)
    if (closing && n < 3) return null

    val moved: List<FencePoint> = if (closing) {
        val anchor = points[0]
        val heading = unitVector(anchor, points[n - 1]) ?: return null
        points.toMutableList().also { it[n - 1] = landSide(anchor, heading, feet, pxPerFt) }
    } else {
        val start = points[index]
        val heading = unitVector(start, points[index + 1]) ?: return null
        val out = ArrayList<FencePoint>(n)
        for (i in 0..index) out += points[i]
        out += landSide(start, heading, feet, pxPerFt)
        // Every later side keeps its heading and measures exactly what it
        // measured before. Translating the corners by one offset would do the
        // same in exact arithmetic; in floats it nudges each later side by a
        // rounding error, which is enough to push a typed 24' to 24.000002'.
        for (k in index + 1 until n - 1) {
            val from = points[k]
            val to = points[k + 1]
            val sideHeading = unitVector(from, to)
            out += if (sideHeading == null) out[k]
            else landSide(out[k], sideHeading, measuredFeet(from, to, pxPerFt), pxPerFt)
        }
        out
    }

    val movedGates = gates.map { gate -> followSide(gate, points, moved, closedLoop, pxPerFt) }
    return SideLengthEdit(
        points = moved,
        gates = movedGates,
        gatesMoved = movedGates != gates,
    )
}

/**
 * Moves [gate] with the side it belongs to: by the displacement of the point
 * the same fraction of the way along that side. A side that did not move
 * leaves its gate exactly where it was.
 */
private fun followSide(
    gate: GateMarker,
    before: List<FencePoint>,
    after: List<FencePoint>,
    closedLoop: Boolean,
    pxPerFt: Float,
): GateMarker {
    val side = GateGeometry.spanFor(gate, before, closedLoop, pxPerFt)?.segmentIndex ?: return gate
    val n = before.size
    val a0 = before[side]
    val b0 = before[(side + 1) % n]
    val a1 = after[side]
    val b1 = after[(side + 1) % n]
    if (a0 == a1 && b0 == b1) return gate

    val sx = (b0.x - a0.x).toDouble()
    val sy = (b0.y - a0.y).toDouble()
    val lengthSquared = sx * sx + sy * sy
    val t = if (lengthSquared <= 0.0) 0.0
    else (((gate.x - a0.x) * sx + (gate.y - a0.y) * sy) / lengthSquared).coerceIn(0.0, 1.0)
    val dx = (1.0 - t) * (a1.x - a0.x) + t * (b1.x - b0.x)
    val dy = (1.0 - t) * (a1.y - a0.y) + t * (b1.y - b0.y)
    return gate.copy(x = (gate.x + dx).toFloat(), y = (gate.y + dy).toFloat())
}

/** Heading from [a] to [b] as a unit vector, or null when they coincide. */
private fun unitVector(a: FencePoint, b: FencePoint): Pair<Double, Double>? {
    val dx = b.x.toDouble() - a.x.toDouble()
    val dy = b.y.toDouble() - a.y.toDouble()
    val length = sqrt(dx * dx + dy * dy)
    if (length < MIN_HEADING_PX) return null
    return (dx / length) to (dy / length)
}

/** One side measured in feet by the takeoff's own arithmetic (see [sideLengthFeet]). */
private fun measuredFeet(a: FencePoint, b: FencePoint, pxPerFt: Float): Float =
    FenceGeometryEngine.analyze(listOf(a, b), pxPerFt).totalLinearFeet

/**
 * The corner [feet] away from [anchor] along [heading], placed on the float
 * coordinates the takeoff measures as exactly [feet] -- or, where none do, the
 * closest ones that measure less. Among equally good candidates, the one
 * nearest the true point wins, so the heading is kept to within a few
 * millionths of a pixel.
 *
 * The search only ever looks a handful of representable floats either side of
 * the true point: the correction is far below anything visible, and the
 * search widens only in the pathological case where nothing nearby measures
 * at or under the target.
 */
internal fun landSide(anchor: FencePoint, heading: Pair<Double, Double>, feet: Float, pxPerFt: Float): FencePoint {
    val (ux, uy) = heading
    val lengthPx = feet.toDouble() * pxPerFt.toDouble()
    val idealX = anchor.x.toDouble() + ux * lengthPx
    val idealY = anchor.y.toDouble() + uy * lengthPx
    val seedX = idealX.toFloat()
    val seedY = idealY.toFloat()
    val target = feet.toDouble()

    var radius = LANDING_RADIUS_ULPS
    while (true) {
        var best: FencePoint? = null
        var bestShortfall = Double.MAX_VALUE
        var bestDeviation = Double.MAX_VALUE
        val xs = floatsAround(seedX, radius)
        val ys = floatsAround(seedY, radius)
        for (x in xs) for (y in ys) {
            val candidate = FencePoint(x, y)
            val measured = measuredFeet(anchor, candidate, pxPerFt).toDouble()
            if (measured > target) continue
            val shortfall = target - measured
            val ddx = x - idealX
            val ddy = y - idealY
            val deviation = ddx * ddx + ddy * ddy
            if (shortfall < bestShortfall || (shortfall == bestShortfall && deviation < bestDeviation)) {
                best = candidate
                bestShortfall = shortfall
                bestDeviation = deviation
            }
        }
        if (best != null) return best
        // Nothing within reach measures at or under the target, which only a
        // degenerate scale could cause. Widen, and give up (on the plain
        // rounded point) rather than loop for ever.
        if (radius >= MAX_LANDING_RADIUS_ULPS) return FencePoint(seedX, seedY)
        radius *= 4
    }
}

/** [v] and the [radius] representable floats either side of it, in order. */
private fun floatsAround(v: Float, radius: Int): List<Float> {
    val below = ArrayList<Float>(radius)
    var d = v
    repeat(radius) { d = d.nextDown(); below += d }
    val above = ArrayList<Float>(radius)
    var u = v
    repeat(radius) { u = u.nextUp(); above += u }
    return below.asReversed() + v + above
}

/** How far either side of the true corner, in representable floats, the landing looks first. */
private const val LANDING_RADIUS_ULPS = 6

/** Where the landing gives up widening. */
private const val MAX_LANDING_RADIUS_ULPS = 96

/** Below this many pixels two corners are the same corner and there is no heading between them. */
private const val MIN_HEADING_PX = 1e-4
