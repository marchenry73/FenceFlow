package com.fenceestimator.app.geometry

import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.roundToInt
import kotlin.math.sqrt

/** A vertex of the drawn fence line, in survey-image pixel space. */
data class FencePoint(val x: Float, val y: Float)

/**
 * A gate placed at an exact point on the drawing -- not required to sit on
 * the fence line itself, so it can mark a walk gate, drive gate, or opening
 * anywhere on the property.
 */
/**
 * Where a gate is hung, which decides what it is built from.
 *
 * This is not cosmetic -- the three cases need genuinely different material,
 * and guessing wrong is a truck coming back from the yard. A wall-hung gate
 * needs no concrete at all, which is the single biggest difference.
 */
enum class GateMounting {
    /**
     * Hung off a wall. The hinge side bolts through a blank post: holes are
     * drilled through the econo stiffener into the post, so it needs plugs to
     * close them and no concrete, since nothing is set in the ground.
     */
    WALL,

    /** Hung in the fence line, set in concrete like any other post. */
    LINE,

    /**
     * In the line, with the rest of the fence carrying on to a wall -- so the
     * run terminates twice and needs a second end post.
     */
    LINE_TO_WALL
}

/**
 * Which way a gate opens.
 *
 * Worth recording because it decides where the hinges go, and because a gate
 * that swings the wrong way into a slope, a step or a car is a return visit.
 * It is also the first thing a customer asks about and the first thing
 * forgotten between quoting and installing.
 */
enum class GateSwing {
    /** Opens into the property. The usual choice, and the safer one near a road. */
    IN,
    /** Opens outward, away from the property. */
    OUT,
    /** Opens either way. Common on paddock and double gates. */
    BOTH
}

data class GateMarker(
    val x: Float,
    val y: Float,
    val widthFt: Float,
    /** Defaults to the commonest case so older saved gates read sensibly. */
    val mounting: GateMounting = GateMounting.LINE,
    /** Which way it opens. Older gates were saved without one; IN is the norm. */
    val swing: GateSwing = GateSwing.IN
)

/** Encodes/decodes the point list and gate list to compact strings for Room storage. */
object FenceCodec {
    fun encodePoints(points: List<FencePoint>): String =
        points.joinToString(",") { "${it.x}:${it.y}" }

    fun decodePoints(raw: String): List<FencePoint> {
        if (raw.isBlank()) return emptyList()
        return raw.split(",").mapNotNull { pair ->
            val parts = pair.split(":")
            if (parts.size != 2) return@mapNotNull null
            val x = parts[0].toFloatOrNull() ?: return@mapNotNull null
            val y = parts[1].toFloatOrNull() ?: return@mapNotNull null
            FencePoint(x, y)
        }
    }

    fun encodeGates(gates: List<GateMarker>): String =
        gates.joinToString(",") { "${it.x}:${it.y}:${it.widthFt}:${it.mounting.name}:${it.swing.name}" }

    /**
     * Reads both the old three-part form and the four-part form with mounting.
     *
     * Every gate already drawn was saved without a mounting, and refusing to
     * parse those would silently empty the gate list on jobs that are already
     * quoted. A gate with no recorded mounting is read as LINE, which is what
     * the estimate already assumed when it charged concrete for every gate.
     */
    fun decodeGates(raw: String): List<GateMarker> {
        if (raw.isBlank()) return emptyList()
        return raw.split(",").mapNotNull { entry ->
            val parts = entry.split(":")
            if (parts.size < 3) return@mapNotNull null
            val x = parts[0].toFloatOrNull() ?: return@mapNotNull null
            val y = parts[1].toFloatOrNull() ?: return@mapNotNull null
            val w = parts[2].toFloatOrNull() ?: return@mapNotNull null
            val mounting = parts.getOrNull(3)
                ?.let { name -> runCatching { GateMounting.valueOf(name) }.getOrNull() }
                ?: GateMounting.LINE
            // Same reasoning as mounting above: gates saved before swing was
            // recorded read as IN rather than being dropped.
            val swing = parts.getOrNull(4)
                ?.let { name -> runCatching { GateSwing.valueOf(name) }.getOrNull() }
                ?: GateSwing.IN
            GateMarker(x, y, w, mounting, swing)
        }
    }
}

/** A vertex classified by how sharply the fence line bends there. */
enum class VertexKind { END, LINE, CORNER }

data class ClassifiedVertex(
    val index: Int,
    val point: FencePoint,
    val kind: VertexKind,
    val turnDegrees: Float
)

data class SegmentResult(
    val fromIndex: Int,
    val toIndex: Int,
    val lengthFt: Float
)

data class FenceGeometryResult(
    val totalLinearFeet: Float,
    val segments: List<SegmentResult>,
    val vertices: List<ClassifiedVertex>,
    val cornerCount: Int,
    val endCount: Int,
    val lineVertexCount: Int
)

/**
 * Computes real-world lengths and classifies each interior vertex as a corner
 * (sharp direction change -> needs a corner post) or a straight line point
 * (needs only a standard line post), given a pixels-per-foot calibration.
 */
object FenceGeometryEngine {
    /** Interior turn angles beyond this are treated as a corner post, not a line post. */
    const val CORNER_ANGLE_THRESHOLD_DEGREES = 15f

    /**
     * How long the drawn line is on screen, before any scale is applied.
     *
     * The raw measurement, which is what lets a known real-world length be
     * turned back into a scale: if this line is 480 pixels and the fence is
     * really 120 feet, then the drawing is at 4 pixels per foot, and every
     * other run and gate on the same drawing is now correct too.
     */
    fun pixelLength(points: List<FencePoint>, closedLoop: Boolean = false): Float {
        if (points.size < 2) return 0f
        var total = 0f
        val n = points.size
        val segmentCount = if (closedLoop) n else n - 1
        for (i in 0 until segmentCount) {
            val a = points[i]
            val b = points[(i + 1) % n]
            // sqrt(dx*dx + dy*dy), not hypot: the server port has to land on
            // the same float, and hypot's extra-precision path is not
            // something every runtime reproduces bit for bit.
            val dx = (b.x - a.x).toDouble()
            val dy = (b.y - a.y).toDouble()
            total += sqrt(dx * dx + dy * dy).toFloat()
        }
        return total
    }

    fun analyze(points: List<FencePoint>, pixelsPerFoot: Float, closedLoop: Boolean = false): FenceGeometryResult {
        if (points.size < 2 || pixelsPerFoot <= 0f) {
            return FenceGeometryResult(0f, emptyList(), emptyList(), 0, 0, 0)
        }

        val segments = mutableListOf<SegmentResult>()
        var totalPixels = 0f
        val n = points.size
        val segmentCount = if (closedLoop) n else n - 1
        for (i in 0 until segmentCount) {
            val a = points[i]
            val b = points[(i + 1) % n]
            // Same sqrt form as pixelLength, for the same reason.
            val dx = (b.x - a.x).toDouble()
            val dy = (b.y - a.y).toDouble()
            val distPx = sqrt(dx * dx + dy * dy).toFloat()
            totalPixels += distPx
            segments.add(SegmentResult(i, (i + 1) % n, distPx / pixelsPerFoot))
        }

        val vertices = mutableListOf<ClassifiedVertex>()
        for (i in 0 until n) {
            val isEndpoint = !closedLoop && (i == 0 || i == n - 1)
            if (isEndpoint) {
                vertices.add(ClassifiedVertex(i, points[i], VertexKind.END, 0f))
                continue
            }
            val prevIdx = (i - 1 + n) % n
            val nextIdx = (i + 1) % n
            val prev = points[prevIdx]
            val curr = points[i]
            val next = points[nextIdx]

            val angleIn = atan2((curr.y - prev.y).toDouble(), (curr.x - prev.x).toDouble())
            val angleOut = atan2((next.y - curr.y).toDouble(), (next.x - curr.x).toDouble())
            var turnRad = angleOut - angleIn
            while (turnRad > Math.PI) turnRad -= 2 * Math.PI
            while (turnRad < -Math.PI) turnRad += 2 * Math.PI
            val turnDeg = Math.toDegrees(abs(turnRad)).toFloat()

            val kind = if (turnDeg >= CORNER_ANGLE_THRESHOLD_DEGREES) VertexKind.CORNER else VertexKind.LINE
            vertices.add(ClassifiedVertex(i, points[i], kind, turnDeg))
        }

        val totalFeet = totalPixels / pixelsPerFoot
        return FenceGeometryResult(
            totalLinearFeet = totalFeet,
            segments = segments,
            vertices = vertices,
            cornerCount = vertices.count { it.kind == VertexKind.CORNER },
            endCount = vertices.count { it.kind == VertexKind.END },
            lineVertexCount = vertices.count { it.kind == VertexKind.LINE }
        )
    }

    fun roundFeet(feet: Float): Float = (feet * 10f).roundToInt() / 10f
}

/**
 * Sets one segment to an exact length by sliding the rest of the run.
 *
 * The tape says 47' 6" and the drawing says 46-ish, because a finger on a
 * satellite tile is not a measuring instrument. This is how the drawing is
 * told the real number.
 *
 * Segment [index] runs from `points[index]` to `points[index+1]`. Its END
 * point moves along the segment's existing direction until the length is
 * [newLengthPx], and every point after it moves by exactly the same offset.
 * The rest of the run therefore keeps its shape: a corrected first segment
 * carries the whole fence with it rather than distorting the corner beyond
 * it, which is the behaviour anyone who has used a CAD tool expects and the
 * only one that does not quietly change a second measurement the user never
 * touched.
 *
 * Returns null rather than guessing when the request has no answer:
 *  - an index that is not a real segment,
 *  - a segment whose two ends sit on top of each other, so there is no
 *    direction to stretch along,
 *  - a length that is zero or negative.
 *
 * A closed loop's implied closing segment is not editable here: its length
 * is whatever the other segments leave over, and pretending otherwise would
 * move the run's start point out from under everything.
 */
fun stretchSegment(
    points: List<FencePoint>,
    index: Int,
    newLengthPx: Float,
): List<FencePoint>? {
    if (index < 0 || index + 1 >= points.size) return null
    if (!newLengthPx.isFinite() || newLengthPx <= 0f) return null

    val a = points[index]
    val b = points[index + 1]
    val dx = b.x - a.x
    val dy = b.y - a.y
    val current = sqrt(dx * dx + dy * dy)
    if (current <= 0.0001f) return null

    val ux = dx / current
    val uy = dy / current
    val shiftX = ux * newLengthPx - dx
    val shiftY = uy * newLengthPx - dy

    return points.mapIndexed { i, p ->
        if (i <= index) p else FencePoint(p.x + shiftX, p.y + shiftY)
    }
}

/** The straight-line length of segment [index], in pixels, or null if there isn't one. */
fun segmentLengthPx(points: List<FencePoint>, index: Int): Float? {
    if (index < 0 || index + 1 >= points.size) return null
    val a = points[index]
    val b = points[index + 1]
    return sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y))
}

/** What, if anything, a placed point was pulled onto. */
enum class SnapKind { NONE, VERTEX, ANGLE, LENGTH, ANGLE_AND_LENGTH }

/**
 * A placed point after snapping, and what it was snapped to.
 *
 * The kind travels with the point so the screen can say WHY it moved. A
 * point that silently jumps is a bug; a point that jumps and says "90°" is
 * a tool.
 */
data class SnapResult(
    val point: FencePoint,
    val kind: SnapKind,
    /** Degrees clockwise from east, when an angle was locked. */
    val lockedAngleDeg: Float? = null,
    /** The segment's length in feet after snapping, when a length was rounded. */
    val lengthFt: Float? = null,
) {
    val snapped: Boolean get() = kind != SnapKind.NONE
}

/**
 * Pulls a point being placed onto whatever it was obviously aiming at.
 *
 * Three things, in the order they matter:
 *
 * 1. **An existing corner.** Within reach of a vertex -- this run's or any
 *    other run's on the job -- the point lands exactly on it. Two runs that
 *    meet at a corner have to meet at ONE point, or the takeoff counts two
 *    posts where the crew will set one.
 *
 * 2. **A sensible angle.** Fences are square far more often than not.
 *    Candidate headings are multiples of 45 degrees on the screen's own axes
 *    -- which is what a north-up satellite tile of a subdivision gives you --
 *    AND multiples of 45 relative to the previous segment, which is what a
 *    property line running at some arbitrary bearing gives you. The nearer of
 *    the two wins.
 *
 * 3. **A whole foot.** Once the heading is fixed, a length within a few
 *    inches of a round number becomes that number. Fences get built to whole
 *    feet; 46.97' is a tracing artifact, not a measurement.
 *
 * Everything here snaps only when the point is ALREADY close to the target.
 * Nothing is forced: aim at 30 degrees and you get 30 degrees. That is what
 * makes it safe to leave switched on, and it is the difference between a
 * tool that helps and one you have to keep turning off.
 */
fun snapDrawPoint(
    candidate: FencePoint,
    previous: FencePoint?,
    beforePrevious: FencePoint?,
    otherVertices: List<FencePoint>,
    pxPerFt: Float,
    vertexSnapPx: Float = 26f,
    angleToleranceDeg: Float = 7f,
    lengthSnapFt: Float = 0.35f,
): SnapResult {
    // 1. An existing corner wins outright.
    val nearestVertex = otherVertices.minByOrNull { v ->
        val dx = v.x - candidate.x
        val dy = v.y - candidate.y
        dx * dx + dy * dy
    }
    if (nearestVertex != null) {
        val dx = nearestVertex.x - candidate.x
        val dy = nearestVertex.y - candidate.y
        if (sqrt(dx * dx + dy * dy) <= vertexSnapPx) {
            return SnapResult(nearestVertex, SnapKind.VERTEX)
        }
    }

    if (previous == null || pxPerFt <= 0f) return SnapResult(candidate, SnapKind.NONE)

    val vx = candidate.x - previous.x
    val vy = candidate.y - previous.y
    val distPx = sqrt(vx * vx + vy * vy)
    // Nowhere to point: a zero-length segment has no heading to correct.
    if (distPx < 0.001f) return SnapResult(candidate, SnapKind.NONE)

    val headingDeg = Math.toDegrees(atan2(vy.toDouble(), vx.toDouble())).toFloat()

    // 2. Candidate headings: the screen's axes, and the previous segment's.
    val candidates = mutableListOf<Float>()
    for (k in 0 until 8) candidates += k * 45f
    if (beforePrevious != null) {
        val px = previous.x - beforePrevious.x
        val py = previous.y - beforePrevious.y
        if (sqrt(px * px + py * py) > 0.001f) {
            val prevHeading = Math.toDegrees(atan2(py.toDouble(), px.toDouble())).toFloat()
            for (k in 0 until 8) candidates += prevHeading + k * 45f
        }
    }

    var lockedAngle: Float? = null
    var bestDelta = angleToleranceDeg
    for (c in candidates) {
        val delta = abs(angleDifference(headingDeg, c))
        if (delta <= bestDelta) {
            bestDelta = delta
            lockedAngle = c
        }
    }

    val finalHeadingDeg = lockedAngle ?: headingDeg

    // 3. A whole foot, measured along whatever heading we ended up with.
    val distFt = distPx / pxPerFt
    val roundedFt = kotlin.math.round(distFt)
    val lengthLocked = roundedFt >= 1f && abs(distFt - roundedFt) <= lengthSnapFt
    val finalDistPx = if (lengthLocked) roundedFt * pxPerFt else distPx

    if (lockedAngle == null && !lengthLocked) return SnapResult(candidate, SnapKind.NONE)

    val rad = Math.toRadians(finalHeadingDeg.toDouble())
    val point = FencePoint(
        previous.x + (kotlin.math.cos(rad) * finalDistPx).toFloat(),
        previous.y + (kotlin.math.sin(rad) * finalDistPx).toFloat(),
    )
    val kind = when {
        lockedAngle != null && lengthLocked -> SnapKind.ANGLE_AND_LENGTH
        lockedAngle != null -> SnapKind.ANGLE
        else -> SnapKind.LENGTH
    }
    return SnapResult(
        point = point,
        kind = kind,
        lockedAngleDeg = lockedAngle?.let { normaliseDeg(it) },
        lengthFt = if (lengthLocked) roundedFt else null,
    )
}

/** Signed smallest difference between two headings, in the range (-180, 180]. */
private fun angleDifference(a: Float, b: Float): Float {
    var d = (a - b) % 360f
    if (d > 180f) d -= 360f
    if (d <= -180f) d += 360f
    return d
}

/** Any heading expressed in [0, 360). */
private fun normaliseDeg(d: Float): Float {
    var v = d % 360f
    if (v < 0f) v += 360f
    return v
}
