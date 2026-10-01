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

    /**
     * Sum of every run's linear feet, for the map's "total feet drawn" readout.
     *
     * Kept separate from [analyze] (which is per-run) rather than folded into
     * the survey screen itself, so the job-wide total is a pure function of
     * points and can be unit tested without a Composable, a ViewModel or a
     * database row.
     */
    fun totalLinearFeetAcrossRuns(runs: List<Pair<List<FencePoint>, Boolean>>, pixelsPerFoot: Float): Float {
        if (pixelsPerFoot <= 0f) return 0f
        return runs.sumOf { (points, closedLoop) ->
            if (points.size < 2) 0.0 else analyze(points, pixelsPerFoot, closedLoop).totalLinearFeet.toDouble()
        }.toFloat()
    }
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
 *
 * The drawing screen no longer calls this: it uses [setSideLength], which
 * does the same slide, also handles the closing side, carries gates with
 * their side, and lands the corner on coordinates the takeoff measures as the
 * typed length rather than a rounding error above it.
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
    /**
     * What a locked angle was square to: the map's own axes, or the side
     * drawn before this one. Null when no angle was locked.
     */
    val angleReference: AngleReference? = null,
    /**
     * When the angle was locked to the previous side, how far the fence turns
     * there: 0 is straight on, 90 is a square corner, 45 and 135 the two
     * diagonals, 180 doubling back. Null otherwise.
     *
     * "120° locked" means nothing to someone standing in a yard; "square to
     * the last side" is the thing they were aiming for, and saying it back is
     * what makes the jump read as the tool working.
     */
    val turnDeg: Float? = null,
) {
    val snapped: Boolean get() = kind != SnapKind.NONE
}

/** What an angle lock was measured against. */
enum class AngleReference {
    /** Horizontal, vertical or diagonal on the drawing itself -- north-up on satellite. */
    MAP,

    /** Relative to the side drawn before this one. */
    PREVIOUS_SIDE,
}

/**
 * What a locked angle should be called, worked out without any words so the
 * screen maps it to a translated string and never branches on display text.
 */
sealed class AngleCue {
    /** Carries straight on from the previous side. */
    object StraightOn : AngleCue()

    /** Square (90 degrees) to the previous side. */
    object Square : AngleCue()

    /** Turns this many degrees from the previous side (45, 135, 180). */
    data class Turn(val degrees: Int) : AngleCue()

    /** Horizontal on the drawing. */
    object MapHorizontal : AngleCue()

    /** Vertical on the drawing. */
    object MapVertical : AngleCue()

    /** A 45-degree diagonal on the drawing. */
    object MapDiagonal : AngleCue()
}

/** How to describe this snap's angle lock, or null when no angle was locked. */
fun SnapResult.angleCue(): AngleCue? {
    val heading = lockedAngleDeg ?: return null
    return when (angleReference) {
        AngleReference.PREVIOUS_SIDE -> when (val turn = turnDeg?.let { kotlin.math.round(it).toInt() }) {
            null -> null
            0 -> AngleCue.StraightOn
            90 -> AngleCue.Square
            else -> AngleCue.Turn(turn)
        }
        AngleReference.MAP, null -> when (((kotlin.math.round(heading).toInt() % 360) + 360) % 360) {
            0, 180 -> AngleCue.MapHorizontal
            90, 270 -> AngleCue.MapVertical
            45, 135, 225, 315 -> AngleCue.MapDiagonal
            else -> null
        }
    }
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
 *
 * Only the point being placed ever moves. Every corner already on the
 * drawing is an input here and nothing else: a vertex snap copies an existing
 * corner's position, it never shifts that corner to meet the new one.
 *
 * Never onto the point it starts from. [previous] -- and anything in [avoid],
 * which a drag passes as the moving corner's other neighbour -- is left out
 * of the corners to join, because landing exactly on it makes a side with no
 * length and no heading, which the takeoff then counts as an extra post.
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
    avoid: List<FencePoint> = emptyList(),
): SnapResult {
    val neighbours = listOfNotNull(previous) + avoid
    val joinable = if (neighbours.isEmpty()) otherVertices else otherVertices.filter { v ->
        neighbours.none { nb -> abs(nb.x - v.x) < SAME_CORNER_PX && abs(nb.y - v.y) < SAME_CORNER_PX }
    }
    // 1. An existing corner wins outright.
    val nearestVertex = joinable.minByOrNull { v ->
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
    // Each remembers what it is square to, so the screen can say "square to
    // the last side" rather than an absolute bearing nobody was aiming at.
    val candidates = mutableListOf<LockCandidate>()
    for (k in 0 until 8) candidates += LockCandidate(k * 45f, AngleReference.MAP, null)
    if (beforePrevious != null) {
        val px = previous.x - beforePrevious.x
        val py = previous.y - beforePrevious.y
        if (sqrt(px * px + py * py) > 0.001f) {
            val prevHeading = Math.toDegrees(atan2(py.toDouble(), px.toDouble())).toFloat()
            for (k in 0 until 8) {
                val turn = (if (k <= 4) k else 8 - k) * 45f
                candidates += LockCandidate(prevHeading + k * 45f, AngleReference.PREVIOUS_SIDE, turn)
            }
        }
    }

    // `<=`, so on a tie the later candidate -- the previous side's -- wins:
    // a heading that is both vertical and square to the last side is
    // reported as the latter, which is the one being aimed at.
    var locked: LockCandidate? = null
    var bestDelta = angleToleranceDeg
    for (c in candidates) {
        val delta = abs(angleDifference(headingDeg, c.headingDeg))
        if (delta <= bestDelta) {
            bestDelta = delta
            locked = c
        }
    }
    val lockedAngle = locked?.headingDeg

    val finalHeadingDeg = lockedAngle ?: headingDeg

    // 3. A whole foot, measured along whatever heading we ended up with.
    val distFt = distPx / pxPerFt
    val roundedFt = kotlin.math.round(distFt)
    val lengthLocked = roundedFt >= 1f && abs(distFt - roundedFt) <= lengthSnapFt
    val finalDistPx = if (lengthLocked) roundedFt * pxPerFt else distPx

    if (lockedAngle == null && !lengthLocked) return SnapResult(candidate, SnapKind.NONE)

    val rad = Math.toRadians(finalHeadingDeg.toDouble())
    val point = if (lengthLocked) {
        // A side reported as "rounded to 48'" has to measure 48' in the
        // takeoff, not 48.000004' -- the takeoff rounds bays UP, so that
        // hair is a ninth panel. Landed the way a typed length is.
        landSide(previous, kotlin.math.cos(rad) to kotlin.math.sin(rad), roundedFt, pxPerFt)
    } else {
        FencePoint(
            previous.x + (kotlin.math.cos(rad) * finalDistPx).toFloat(),
            previous.y + (kotlin.math.sin(rad) * finalDistPx).toFloat(),
        )
    }
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
        angleReference = locked?.reference,
        turnDeg = locked?.turnDeg,
    )
}

/** One heading an angle lock could choose, and what it is square to. */
private data class LockCandidate(
    val headingDeg: Float,
    val reference: AngleReference,
    /** Turn from the previous side, for [AngleReference.PREVIOUS_SIDE] only. */
    val turnDeg: Float?,
)

/** Two corners closer than this, in drawing pixels, are the same corner. */
private const val SAME_CORNER_PX = 0.01f

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

// ===========================================================================
// JOINED RUNS: the post arithmetic at a join.
// ===========================================================================

/**
 * What stands in the ground where two or more runs are joined.
 *
 * [CORNER] is a post that takes a pull from more than one direction, [LINE]
 * is a post the fence passes straight through. The two are separate catalog
 * rows at separate prices, which is the whole reason the kind matters: the
 * count of posts is the same either way.
 */
enum class JoinPostKind { LINE, CORNER }

/**
 * Why a joint was left out of the arithmetic. A joint that is ignored changes
 * nothing, so the price is whatever it would be with no joint recorded.
 */
enum class JoinIgnoredReason {
    /**
     * Fewer than two of the joint's ends belong to a run that bills posts.
     * Covers a joint id recorded on only one end (the partner run deleted or
     * not synced yet), and ends belonging to a teardown run, a closed run, or a
     * run with nothing measurable drawn or typed.
     */
    FEWER_THAN_TWO_LIVE_RUNS,

    /**
     * Both ends of ONE run carry this joint id. Closing a run on itself is
     * what closedLoop is for, and the closed-loop arithmetic (no free ends,
     * one fewer position in the estimate) is not the same as a joint's, so a
     * joint is not allowed to stand in for it.
     */
    SAME_RUN_TWICE,
}

/**
 * One run, reduced to exactly what the join arithmetic reads.
 *
 * Deliberately not a FenceRun: this file is pure geometry and the FenceRun
 * entity belongs to the data layer. A caller builds one of these per run of
 * the job.
 *
 * @param id the run's stable identity (its sync id). Must be unique in the list.
 * @param geometry the SAME geometry the run's posts are counted from
 *   (resolveGeometry in the engine): a typed-footage run arrives with no
 *   vertices, a closed run with no ends, a run with nothing measurable with
 *   neither. The arithmetic trusts it and does not re-measure.
 * @param heightFt the run's fence height. The taller run is billed the shared
 *   post, because that is the post that has to be built for it.
 * @param sortOrder the run's position on the job, the tie-break between equal heights.
 * @param startJointId the joint the run's FIRST point belongs to; blank is not joined.
 * @param endJointId the joint the run's LAST point belongs to; blank is not joined.
 *   Any non-blank text is taken as a joint id here. Deciding that a stored value
 *   is not a usable one (not a uuid, names no other run) and blanking it first is
 *   the reader's job, so that bad data falls back to today's price.
 */
data class JoinableRun(
    val id: String,
    val geometry: FenceGeometryResult,
    val heightFt: Float,
    val sortOrder: Int,
    val isTeardown: Boolean = false,
    val startJointId: String = "",
    val endJointId: String = "",
)

/**
 * How a run's own post counts move because of the joints it takes part in.
 *
 * These are DELTAS, to be added to the counts the run already has after
 * computePostCounts has finished, never fed into it. computePostCounts carves
 * its corner and end posts out of one fixed estimate (the line posts are
 * whatever is left), so changing the end count BEFORE it runs hands the same
 * number straight back as extra line posts and the total does not move.
 *
 * Gate posts never appear here: a join does not touch them.
 */
data class RunPostAdjustment(
    val runId: String,
    val linePostsDelta: Int = 0,
    val cornerPostsDelta: Int = 0,
    val endPostsDelta: Int = 0,
) {
    /** What the run's total post count (and so its caps and concrete) moves by. */
    val totalPostsDelta: Int get() = linePostsDelta + cornerPostsDelta + endPostsDelta

    /** What the run's terminal post count (corner + end + gate) moves by. */
    val terminalPostsDelta: Int get() = cornerPostsDelta + endPostsDelta

    val isZero: Boolean get() = linePostsDelta == 0 && cornerPostsDelta == 0 && endPostsDelta == 0
}

/** One shared post: where it is, what kind it is, and which run is billed for it. */
data class JoinedPost(
    val jointId: String,
    val kind: JoinPostKind,
    /** The run whose own post counts keep the shared post. Every other member gives its end post up. */
    val ownerRunId: String,
    /** Every run that meets here, owner included, sorted by run id. */
    val memberRunIds: List<String>,
) {
    /** How many run ends meet here. */
    val degree: Int get() = memberRunIds.size
}

data class IgnoredJoint(val jointId: String, val reason: JoinIgnoredReason)

/**
 * The whole job's answer. [perRun] holds ONLY the runs that change, so an
 * empty map is the guarantee that nothing moves: a job with no joints gets
 * [JoinAdjustment.NONE] back from [RunJoinArithmetic.adjust].
 */
data class JoinAdjustment(
    val perRun: Map<String, RunPostAdjustment>,
    val posts: List<JoinedPost>,
    val ignored: List<IgnoredJoint>,
) {
    /** The adjustment for one run; a run no joint touches gets a zero one. */
    fun forRun(runId: String): RunPostAdjustment = perRun[runId] ?: RunPostAdjustment(runId)

    /** True when no run's posts move at all. */
    val changesNothing: Boolean get() = perRun.isEmpty()

    /** Posts the job no longer builds, summed over every run. Zero when nothing is joined. */
    val postsSaved: Int
        get() {
            var saved = 0
            for (adj in perRun.values) saved -= adj.totalPostsDelta
            return saved
        }

    companion object {
        val NONE = JoinAdjustment(emptyMap(), emptyList(), emptyList())
    }
}

/**
 * A run's post counts as computePostCounts leaves them, for applying a
 * [RunPostAdjustment] in one place. Gate posts are carried through untouched.
 */
data class RunPostTally(
    val linePosts: Int,
    val cornerPosts: Int,
    val endPosts: Int,
    val gatePosts: Int,
) {
    val terminalPosts: Int get() = cornerPosts + endPosts + gatePosts
    val totalPosts: Int get() = linePosts + cornerPosts + endPosts + gatePosts

    fun adjustedBy(adjustment: RunPostAdjustment): RunPostTally = RunPostTally(
        linePosts = linePosts + adjustment.linePostsDelta,
        cornerPosts = cornerPosts + adjustment.cornerPostsDelta,
        endPosts = endPosts + adjustment.endPostsDelta,
        gatePosts = gatePosts,
    )
}

/**
 * The post arithmetic for runs the owner has explicitly joined.
 *
 * ---------------------------------------------------------------------------
 * STATUS: NOT YET REACHED BY THE ENGINE.
 * ---------------------------------------------------------------------------
 * Nothing calls [adjust] today. EstimateEngine.kt, the server takeoff
 * (supabase/functions/_shared/pricing/takeoff.ts) and every screen price a job
 * exactly as they did before this code existed, because no joint is stored
 * anywhere a job is read from: FenceRun has no joint field, and the start_joint
 * and end_joint columns proposed in supabase_a32_join_runs.sql are written but
 * not applied. [JoinableRun.startJointId] and [JoinableRun.endJointId] mirror
 * those two columns (text, blank for a free end). This file only decides what
 * the numbers WOULD be. It is exercised by
 * tests/a33-join-arithmetic-posts.test.mjs, which runs a line-for-line
 * transcription of it and checks that against a stored snapshot of this file's
 * compiled output; the test does not compile or run this file itself.
 *
 * The two call sites that will reach it:
 *
 *  1. EstimateEngine.suggestQuantities. It prices one run at a time, so the
 *     job-level caller (the one that loops the job's runs) calls [adjust] ONCE
 *     with every run of the job, then hands each run its own
 *     [JoinAdjustment.forRun] as a new optional argument defaulting to zero.
 *     suggestQuantities adds it to the counts right after computePostCounts,
 *     before anything reads them. explainPosts takes the same argument so the
 *     post-workings dialog explains the number actually billed.
 *  2. The server takeoff, in priceJob (pricing/index.ts), the same way: once
 *     over all runs before the per-run loop, then into suggestQuantities. The
 *     server needs a TypeScript port of this object; the transcription in the
 *     a33 test is the shape of it.
 *
 * Both engines and the parity fixtures move together when that happens. No
 * fixture changes for a job with no joint, because a job with no joint gets a
 * zero adjustment (see the zero-joints rule below).
 *
 * THE MODEL, decided by the owner: a join is an explicit fact he creates, and
 * is never inferred from coordinates. Two points on identical coordinates are
 * not evidence (the other fence may be a neighbour's). So nothing here reads
 * where a point is to decide WHETHER runs are joined; the only thing read for
 * that is the joint ids. Points are read afterwards, for one thing only: how
 * sharply a two-run join turns, which decides line post or corner post.
 *
 * THE ARITHMETIC. Every open run's estimate is bays + 1 positions, one at each
 * end, so two runs that meet count the shared position twice. A joint where
 * [JoinedPost.degree] run ends meet is ONE post in the ground:
 *
 *     posts at the joint, before   degree end posts, one per member
 *     posts at the joint, after    1 post, of the joint's [JoinPostKind]
 *     owner                        its end post becomes that post: end -1, line or corner +1
 *     every other member           its end post goes: end -1
 *
 * so the job's end posts fall by degree, its corner (or line) posts rise by
 * one, and its total falls by degree - 1.
 *
 * KIND. Two runs: the same rule a bend inside one run already follows, so
 * joining two runs prices as drawing them as one polyline does: a turn of
 * [FenceGeometryEngine.CORNER_ANGLE_THRESHOLD_DEGREES] or more is a corner, less
 * is a line post. A run with no drawing (typed footage) has no angle to read
 * and counts as a corner. Three or more runs: always a corner. A post that
 * several runs leave from is not a pass-through however the angles fall, and
 * calling a T a line post because two of its legs happen to be collinear would
 * be the lightest post on the job holding the heaviest load.
 *
 * OWNER. The post has to be billed to exactly one run (each run has its own
 * lines). The taller run, so the post built is the one the taller fence needs;
 * equal heights go to the lower sort order; then the lower id, so the answer
 * never depends on list order.
 *
 * WHAT IS IGNORED (an ignored joint changes nothing; see [IgnoredJoint]): a
 * teardown run is the old fence and bills nothing, so it neither owns a post
 * nor gives one up; a closed run and a run with nothing measurable have no free
 * end to give; a joint left with fewer than two such ends has nothing to
 * merge; a joint holding both ends of one run is not a way to close it.
 *
 * ZERO JOINTS. No run carries a joint id: the loop below finds no joint and
 * returns [JoinAdjustment.NONE] before any geometry is read. This is the
 * additivity guarantee a quoted job depends on, and it is asserted explicitly
 * in the a33 test.
 *
 * NOT DONE HERE, on purpose, because they are not post counts: how the shared
 * post is priced when the joined runs are different fence types or colours (it
 * is billed to the owner's run, in the owner's catalog), and per-run rounding
 * of panels and of concrete bags, which a join does not touch.
 */
object RunJoinArithmetic {

    /** One end of one run that carries a joint id. */
    private class JoinMember(val run: JoinableRun, val atEnd: Boolean)

    /**
     * @param runs EVERY run of the job. The owner of a post is chosen across
     *   runs, so a caller that passes a subset gets the wrong owner.
     */
    fun adjust(runs: List<JoinableRun>): JoinAdjustment {
        val byJoint = LinkedHashMap<String, MutableList<JoinMember>>()
        for (run in runs) {
            if (run.startJointId.isNotBlank()) {
                byJoint.getOrPut(run.startJointId) { mutableListOf() }.add(JoinMember(run, false))
            }
            if (run.endJointId.isNotBlank()) {
                byJoint.getOrPut(run.endJointId) { mutableListOf() }.add(JoinMember(run, true))
            }
        }
        // Zero joints: nothing to look at, nothing moves.
        if (byJoint.isEmpty()) return JoinAdjustment.NONE

        val deltas = HashMap<String, IntArray>()
        val posts = mutableListOf<JoinedPost>()
        val ignored = mutableListOf<IgnoredJoint>()

        for (jointId in byJoint.keys.sorted()) {
            val members = byJoint.getValue(jointId)
            val live = members.filter { isLive(it.run) }

            if (live.size < 2) {
                ignored.add(IgnoredJoint(jointId, JoinIgnoredReason.FEWER_THAN_TWO_LIVE_RUNS))
                continue
            }
            if (hasSameRunTwice(live)) {
                ignored.add(IgnoredJoint(jointId, JoinIgnoredReason.SAME_RUN_TWICE))
                continue
            }

            val owner = ownerOf(live)
            val kind = kindOf(live)
            for (member in live) {
                if (member === owner) {
                    if (kind == JoinPostKind.CORNER) bump(deltas, member.run.id, 0, 1, -1)
                    else bump(deltas, member.run.id, 1, 0, -1)
                } else {
                    bump(deltas, member.run.id, 0, 0, -1)
                }
            }
            posts.add(
                JoinedPost(
                    jointId = jointId,
                    kind = kind,
                    ownerRunId = owner.run.id,
                    memberRunIds = live.map { it.run.id }.sorted(),
                )
            )
        }

        val perRun = LinkedHashMap<String, RunPostAdjustment>()
        for (runId in deltas.keys.sorted()) {
            val cell = deltas.getValue(runId)
            val adjustment = RunPostAdjustment(runId, cell[0], cell[1], cell[2])
            if (!adjustment.isZero) perRun[runId] = adjustment
        }
        return JoinAdjustment(perRun, posts, ignored)
    }

    /**
     * A run can give up an end post only if it has free ends to give: not the
     * old fence, and open with something measurable. An open run's geometry
     * always has exactly two ends; a closed run, an unmeasurable run and a run
     * with no drawing and no typed footage have none.
     */
    private fun isLive(run: JoinableRun): Boolean = !run.isTeardown && run.geometry.endCount >= 2

    private fun hasSameRunTwice(live: List<JoinMember>): Boolean {
        for (i in live.indices) {
            for (j in i + 1 until live.size) {
                if (live[i].run.id == live[j].run.id) return true
            }
        }
        return false
    }

    private fun ownerOf(live: List<JoinMember>): JoinMember {
        var best = live[0]
        for (i in 1 until live.size) {
            if (outranks(live[i].run, best.run)) best = live[i]
        }
        return best
    }

    /** Taller first, then lower sort order, then lower id. */
    private fun outranks(a: JoinableRun, b: JoinableRun): Boolean {
        if (a.heightFt != b.heightFt) return a.heightFt > b.heightFt
        if (a.sortOrder != b.sortOrder) return a.sortOrder < b.sortOrder
        return a.id < b.id
    }

    private fun kindOf(live: List<JoinMember>): JoinPostKind {
        if (live.size >= 3) return JoinPostKind.CORNER
        // The two ends in a fixed order, so the answer cannot depend on list order.
        val firstIsZero = live[0].run.id < live[1].run.id
        val first = if (firstIsZero) live[0] else live[1]
        val second = if (firstIsZero) live[1] else live[0]
        val turn = turnDegrees(first, second) ?: return JoinPostKind.CORNER
        return if (turn >= FenceGeometryEngine.CORNER_ANGLE_THRESHOLD_DEGREES) JoinPostKind.CORNER else JoinPostKind.LINE
    }

    /**
     * How far the fence turns where two runs meet: 0 is straight on, 90 a
     * square corner. Measured exactly as analyze measures a bend inside one
     * run, using the direction INTO the joint along the first run and OUT of
     * it along the second, so it does not matter which end of either run was
     * drawn first. Null when there is nothing to measure.
     */
    private fun turnDegrees(first: JoinMember, second: JoinMember): Float? {
        val a = endAndNeighbour(first) ?: return null
        val b = endAndNeighbour(second) ?: return null
        val aEnd = a.first
        val aNext = a.second
        val bEnd = b.first
        val bNext = b.second
        // A side with no length has no heading.
        if (aEnd.x == aNext.x && aEnd.y == aNext.y) return null
        if (bEnd.x == bNext.x && bEnd.y == bNext.y) return null

        val angleIn = atan2((aEnd.y - aNext.y).toDouble(), (aEnd.x - aNext.x).toDouble())
        val angleOut = atan2((bNext.y - bEnd.y).toDouble(), (bNext.x - bEnd.x).toDouble())
        var turnRad = angleOut - angleIn
        while (turnRad > Math.PI) turnRad -= 2 * Math.PI
        while (turnRad < -Math.PI) turnRad += 2 * Math.PI
        val turnDeg = Math.toDegrees(abs(turnRad)).toFloat()
        if (!turnDeg.isFinite()) return null
        return turnDeg
    }

    /** The point at this end of the run and the point next to it, or null when the run has no drawing. */
    private fun endAndNeighbour(member: JoinMember): Pair<FencePoint, FencePoint>? {
        val vertices = member.run.geometry.vertices
        if (vertices.size < 2) return null
        return if (member.atEnd) {
            Pair(vertices[vertices.size - 1].point, vertices[vertices.size - 2].point)
        } else {
            Pair(vertices[0].point, vertices[1].point)
        }
    }

    private fun bump(deltas: MutableMap<String, IntArray>, runId: String, line: Int, corner: Int, end: Int) {
        val cell = deltas.getOrPut(runId) { IntArray(3) }
        cell[0] += line
        cell[1] += corner
        cell[2] += end
    }
}
