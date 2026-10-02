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
/**
 * The reach [snapDrawPoint] uses when the caller does not name one: 26 units
 * on the PLAN, not on the screen, which is what the parameter's name has
 * always implied and never meant.
 */
const val DEFAULT_VERTEX_SNAP_PX = 26f

/**
 * The furthest a vertex snap may ever reach in real distance, however far out
 * the drawing is zoomed. A screen-relative reach is what makes the snap
 * hittable; this is what stops it reaching across the yard for a corner he was
 * nowhere near, where the snap would be moving his line rather than helping it.
 */
const val VERTEX_SNAP_MAX_FT = 3.0f

fun snapDrawPoint(
    candidate: FencePoint,
    previous: FencePoint?,
    beforePrevious: FencePoint?,
    otherVertices: List<FencePoint>,
    pxPerFt: Float,
    vertexSnapPx: Float = DEFAULT_VERTEX_SNAP_PX,
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
 * STATUS: BOTH PRICING ENGINES NOW CALL THIS. The gesture that makes a joint
 * is still switched off.
 * ---------------------------------------------------------------------------
 * [adjust] is reached from both engines, at engine version 2026.10.8:
 *
 *  1. EstimateEngine.joinAdjustments calls it ONCE with every run of the job
 *     (the owner of a shared post is chosen across runs), and the caller hands
 *     each run its own [JoinAdjustment.forRun] to
 *     EstimateEngine.suggestQuantities as an optional argument defaulting to
 *     null. suggestQuantities passes it to computePostCounts, which applies it
 *     at the END of the counts -- never into them, see [RunPostAdjustment].
 *     explainPosts takes the same argument so the post-workings dialog
 *     explains the number actually billed.
 *  2. priceJob (supabase/functions/_shared/pricing/index.ts) does the same for
 *     the office: once over all runs before the per-run loop, then into
 *     suggestQuantities (takeoff.ts). Its port of this object is
 *     supabase/functions/_shared/pricing/joins.ts, and a line-for-line one:
 *     tests/a61-corner-post-pricing.test.mjs runs the port against the same
 *     transcription tests/a33-join-arithmetic-posts.test.mjs holds against a
 *     frozen snapshot of THIS file's compiled output, so neither port can
 *     drift alone.
 *
 * Storage: [FenceRun.startJoint] and [FenceRun.endJoint] exist on the phone
 * (Room schema 50), and [JoinableRun.startJointId] / [JoinableRun.endJointId]
 * mirror them. The Postgres half, start_joint and end_joint on fence_runs, is
 * written in supabase_a32_join_runs.sql and NOT APPLIED, so no joint reaches
 * the office yet and price-job does not select the columns
 * (JOIN_COLUMNS_LIVE there, false until they exist -- PostgREST refuses a
 * select naming an unknown column and would take every job's pricing down).
 * Neither is supabase_a56_join_reapproval_fingerprint.sql applied, the
 * follow-up that teaches the re-approval fingerprint and the drawing snapshot
 * to see a joint; its PART A has to be live before anyone can attach two runs
 * on a job that may be approved, or the post count moves without withdrawing
 * the customer's approval (docs/JOINING_RUNS.md 11.2 and 11.5). The attach
 * gesture itself is behind SurveyViewModel.JOIN_STORAGE_READY.
 *
 * NO PRICE HAS MOVED YET, and that is arithmetic rather than hope: no run
 * anywhere carries a joint id (nothing was backfilled, deliberately), so the
 * loop below finds no joint and returns [JoinAdjustment.NONE] before it reads
 * any geometry. No recorded parity fixture carries a joint either.
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

    /**
     * Who owns the post where runs meet: the SHORTER side owns the shared post where the heights differ.
     * A post has to be tall enough for the tallest panel on it, so "shorter
     * wins" is only ever reached at a height CHANGE -- and there the fence
     * steps DOWN onto the short post rather than leaving a tall one standing
     * proud of the low side. Equal heights never reach it, and fall through to
     * sort order and then id, which is what keeps the answer independent of
     * list order.
     */
    private fun outranks(a: JoinableRun, b: JoinableRun): Boolean {
        if (a.heightFt != b.heightFt) return a.heightFt < b.heightFt
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

// ===========================================================================
// ATTACHING ONE SIDE TO ANOTHER: the gesture, not the price.
// ===========================================================================

/**
 * One end of one run's line: the run's sync id, and which end of it.
 *
 * The end, never a vertex number, for the same reason the two columns are
 * named start_joint and end_joint: inserting or deleting a point in the middle
 * of a run slides every vertex number along, and the first and last point stay
 * the first and last.
 */
data class JoinEnd(val runId: String, val atEnd: Boolean)

/**
 * Why two ends may not be attached, or an attachment not recorded.
 *
 * Every one of these is refused at WRITE time, before anything is stored. That
 * is the half of the rule [RunJoinArithmetic] does not carry: the arithmetic
 * has to re-check eligibility on every price anyway (a run can be closed,
 * typed or turned into a teardown long after it was attached), so these exist
 * to stop a nonsense attachment being made, not to keep the price honest.
 * docs/JOINING_RUNS.md 11.1, "refuse on write, honour on read".
 */
enum class JoinRefusal {
    /** One of the two runs is not on this job any more. */
    NOT_FOUND,

    /** Both ends belong to one run, or that run's other end is already at this post. */
    SAME_RUN,

    /** One run is a closed perimeter: it has no free ends to attach. */
    CLOSED_LOOP,

    /** One run is quoted from typed-in footage: there is no drawn end to attach. */
    TYPED_FOOTAGE,

    /** One is the old fence coming out and the other the new one going in. */
    TEARDOWN_MISMATCH,

    /** They are already at one post. Nothing to do. */
    ALREADY_ATTACHED,

    /**
     * Both ends already meet other runs, at two different posts. Attaching
     * would merge two posts into one, which is a bigger change than the one
     * being asked for, so one end gets detached first -- deliberately.
     */
    AT_ANOTHER_POINT,

    /**
     * There is nowhere to keep it. FenceRun carries no joint field and no
     * cloud column exists, so an attachment could not survive the app closing
     * or travel to the office. See SurveyViewModel.JOIN_STORAGE_READY.
     */
    NO_STORAGE,

    /**
     * The two ends are too far apart in the yard to be made one point.
     *
     * ATTACHED MEANS ONE POINT -- his words, on seeing the first version:
     * "When I attach them together, I need to see the line move there too so
     * there is no confusion." So attaching now closes the gap
     * ([RunJoinGesture.gapCloserFor]). A gap wider than
     * [RunJoinGesture.CLOSE_GAP_MAX_FT] is refused rather than closed, because
     * closing it would drag a corner across the yard and change that side's
     * footage, its labour and possibly a panel -- a redraw, not a tidy-up, and
     * not what a tap on two ends asked for.
     *
     * THIS IS NOT HYPOTHETICAL. Probed read-only on 2 Oct 2026: one live joint
     * holds two ends 4425 drawing units apart -- 110.6 ft at that job's own
     * calibration -- both runs open and measurable, so the arithmetic counts
     * ONE shared corner post while the plan shows two ends 110 ft apart. That
     * joint was made by the path this refusal now closes.
     *
     * The way through is the way he already knows: drag the end over (the draw
     * snap puts it exactly on the other corner, [snapDrawPoint]) and the offer
     * comes to him there.
     */
    TOO_FAR_APART,
}

/** What [RunJoinGesture.decide] decided: the post both ends go to, or why not. */
data class JoinDecision(
    val refusal: JoinRefusal?,
    /** The joint id to write to both ends. Blank unless [allowed]. */
    val jointId: String = "",
    /** The ends to write it to: the two tapped, in the order given. Empty unless [allowed]. */
    val ends: List<JoinEnd> = emptyList(),
) {
    val allowed: Boolean get() = refusal == null
}

/**
 * One run of one job, reduced to what the attach gesture reads.
 *
 * Deliberately not a FenceRun: this file is pure geometry and the entity
 * belongs to the data layer. [startJointId] and [endJointId] mirror the
 * start_joint and end_joint columns (text, blank for a free end); until those
 * exist they are blank for every run and nothing here can find a joint.
 *
 * Every function below takes EVERY run of ONE job. Two runs of different jobs
 * can never be compared here because they are never in the same list; that is
 * the check planJoin made with jobId and this layer makes by construction.
 */
data class JoinCandidateRun(
    /**
     * The run's sync id, never its local row id: it is the tie-break when two
     * members are the same height and the same sort order, so two phones have
     * to agree on it, and it is what the joint columns will be read beside.
     */
    val runId: String,
    val points: List<FencePoint>,
    val closedLoop: Boolean,
    /** True when the run is quoted from typed footage, so it has no drawn ends. */
    val typedFootage: Boolean,
    val isTeardown: Boolean,
    /** fabric_height_ft for chain link, panel_height_ft otherwise; the taller run is billed the post. */
    val heightFt: Float,
    val sortOrder: Int,
    val startJointId: String = "",
    val endJointId: String = "",
) {
    /** The joint id this run records at one side, blank for a free end. */
    fun jointIdAt(atEnd: Boolean): String = if (atEnd) endJointId else startJointId

    /** The point at that side, or null when the run has no drawn line. */
    fun pointAt(atEnd: Boolean): FencePoint? =
        if (points.size < 2) null else if (atEnd) points.last() else points.first()

    /** Whether a finger may attach this run's ends: a drawn, open, typed-free run. */
    val attachable: Boolean get() = points.size >= 2 && !closedLoop && !typedFootage
}

/**
 * A post on the plan where two or more sides are attached: where to draw it,
 * how many ends meet there, and whether they are still in the same place.
 *
 * Only ever built for a joint the post arithmetic counts
 * ([JoinAdjustment.posts]), so the plan cannot show a shared post the price
 * does not believe in.
 */
data class JointMarker(
    val jointId: String,
    val point: FencePoint,
    val kind: JoinPostKind,
    /** How many run ends meet here: 2 for a corner of two sides, 3 for a T. */
    val memberCount: Int,
    /** The ends are this far apart, in feet. 0 when they sit on one another. */
    val openByFeet: Float,
    /** The ends meeting here, lowest run id first. */
    val ends: List<JoinEnd>,
)

/**
 * What attaching two ends takes off the order, or what detaching puts back.
 *
 * Deltas, and positive means "no longer needed": [postsSaved] of 1 is one post
 * fewer in the ground. [RunJoinGesture.effectOfDetaching] flips the sign, so
 * one piece of wording serves both directions.
 *
 * Every figure here comes out of [RunJoinArithmetic] -- the same arithmetic the
 * engine will use when it reads joints -- run twice, once on the drawing as it
 * is and once on the drawing as it would be, and subtracted. Nothing here is a
 * second opinion about the post count.
 */
data class JoinEffect(
    val postsSaved: Int,
    /** One cap per post (POST_CAP follows the total), so this tracks [postsSaved]. */
    val postCapsSaved: Int,
    /** End posts that stop being end posts. */
    val endPostsRemoved: Int,
    val cornerPostsAdded: Int,
    val linePostsAdded: Int,
    val kind: JoinPostKind,
    /** The run billed the shared post: tallest, then lowest sort order, then lowest id. */
    val ownerRunId: String,
    val memberCount: Int,
    /** How far apart the ends are now, in feet. Attaching does not move either one. */
    val gapFeet: Float,
)

/**
 * The attach gesture: which end a finger hit, whether it may be attached to
 * another, and what that does to the materials.
 *
 * ---------------------------------------------------------------------------
 * A JOIN IS SOMETHING THE OWNER SAYS, NEVER SOMETHING THE APP NOTICES.
 * ---------------------------------------------------------------------------
 * His rule, in his words: "it would not be a corner post if I drew it on the
 * other side until I connect it to that one." Two points on identical
 * coordinates are not attached -- the drawing tool already copies a corner's
 * exact position when a point is placed near one ([snapDrawPoint]), and the
 * other fence may be a neighbour's. So nothing here reads a coordinate to
 * decide WHETHER ends are attached. Coordinates are read for three things,
 * all of them after the fact: which end a tap was nearest ([endNear]), how far
 * apart attached ends have drifted ([JointMarker.openByFeet]), and how sharply
 * the fence turns at the post, which decides line or corner and is
 * [RunJoinArithmetic]'s job, not this object's.
 *
 * ---------------------------------------------------------------------------
 * STATUS: NOTHING HERE IS STORED YET.
 * ---------------------------------------------------------------------------
 * [JoinCandidateRun.startJointId] and [JoinCandidateRun.endJointId] come from
 * columns that do not exist (see the header of [RunJoinArithmetic]), so every
 * run reaches this object with both blank, [markers] is empty on every job, and
 * [decide] can only ever be asked about two free ends. The drawing screen does
 * not offer the tool while that is true (SurveyViewModel.JOIN_STORAGE_READY).
 */
object RunJoinGesture {

    /**
     * Every end a finger may attach, with the point to draw it at.
     *
     * A closed perimeter and a typed-footage run are left out because they have
     * no free end to give, which is the same reason the price ignores them
     * (1.4). A teardown run IS included: an old fence drawn in two pieces is a
     * real thing to attach, and refusing it would refuse the thing rather than
     * the mistake. Mixing a teardown end with a new-fence end is what
     * [JoinRefusal.TEARDOWN_MISMATCH] is for.
     */
    fun attachableEnds(runs: List<JoinCandidateRun>): List<Pair<JoinEnd, FencePoint>> {
        val out = mutableListOf<Pair<JoinEnd, FencePoint>>()
        for (run in runs) {
            if (!run.attachable) continue
            for (atEnd in listOf(false, true)) {
                val point = run.pointAt(atEnd) ?: continue
                out.add(Pair(JoinEnd(run.runId, atEnd), point))
            }
        }
        return out
    }

    /**
     * The attachable end nearest a tap and within [radius] of it, or null.
     *
     * [at] and [radius] are both in the drawing's own pixel space, so the
     * caller divides a screen tolerance by the view's scale and the target
     * stays the same size under the finger at any zoom.
     *
     * A run of one point has no end here at all: its single point is both ends
     * and attaching it would make a post on a run with no length.
     */
    fun endNear(runs: List<JoinCandidateRun>, at: FencePoint, radius: Float): JoinEnd? {
        if (radius <= 0f) return null
        var best: JoinEnd? = null
        var bestDistance = radius
        for ((end, point) in attachableEnds(runs)) {
            val dx = (point.x - at.x).toDouble()
            val dy = (point.y - at.y).toDouble()
            val distance = sqrt(dx * dx + dy * dy).toFloat()
            if (distance > bestDistance) continue
            // Strictly nearer to replace one already found, so a tie between
            // two ends sitting on one another is broken by run order and never
            // by which happened to be looked at first.
            if (best == null || distance < bestDistance) {
                best = end
                bestDistance = distance
            }
        }
        return best
    }

    fun runOf(runs: List<JoinCandidateRun>, end: JoinEnd): JoinCandidateRun? =
        runs.firstOrNull { it.runId == end.runId }

    fun pointOf(runs: List<JoinCandidateRun>, end: JoinEnd): FencePoint? =
        runOf(runs, end)?.pointAt(end.atEnd)

    // -----------------------------------------------------------------------
    // OFFERING THE CORNER WHERE THE SNAP ALREADY LANDED
    //
    // His words: "make it easier to connect the sides when I draw." The hard
    // half was already done and had been for months -- [snapDrawPoint] pulls a
    // point being placed onto an existing corner from ANY run of the job
    // (SurveyViewModel.snapTargets collects across runs on purpose), so the
    // two ends he wants to connect are already on one another, to the last
    // decimal. PROVEN on his own job: two sides had their ends on the
    // identical point and the app still billed two end posts, because nothing
    // had RECORDED them as joined.
    //
    // So this is not a new gesture. It is a question asked at the one moment
    // the answer is obvious, about a point that is already in the right place.
    //
    // IT IS AN OFFER AND NOTHING ELSE. [JoinRefusal] and [decide] still decide
    // whether it may be taken, [SnapJoinOffer] carries no authority to write,
    // and carrying on drawing is not a yes -- the view model drops the offer on
    // the next edit. The rule this layer has always had is unchanged: a join is
    // something he says, never something the app notices. What is new is that
    // the app now notices he is probably about to say it.
    // -----------------------------------------------------------------------

    /**
     * The widest gap, in feet, that attaching may close by moving a corner.
     *
     * ATTACHED MEANS ONE POINT (see [JoinRefusal.TOO_FAR_APART]), so attaching
     * closes the gap -- but only a gap that is a tracing error rather than a
     * real distance. Two feet is the line: it is shorter than the shortest
     * panel this app quotes and shorter than one post spacing, so a corner
     * moved that far is being tidied onto the corner it was aiming at. Beyond
     * it the two ends are in different places in the yard, and moving one is a
     * redraw -- it changes that side's footage, therefore its labour, and he
     * asked for neither by tapping two ends.
     *
     * A snap-made offer never reaches this: the snap has already put the two
     * ends on one point, so its gap is 0.0 ft by construction.
     */
    const val CLOSE_GAP_MAX_FT = 2.0f

    /**
     * The two ends a drawn or dragged point landed on, offered as one post.
     *
     * [movingEnd] is the end HE just placed -- the one under his finger, the
     * one the snap moved, the one he can see. [targetEnd] is the other run's
     * free end it landed on, which does not move and never has: a vertex snap
     * copies an existing corner's position and never shifts that corner
     * ([snapDrawPoint]'s own contract).
     */
    data class SnapJoinOffer(
        val decision: JoinDecision,
        val movingEnd: JoinEnd,
        val targetEnd: JoinEnd,
        /** Where both ends now are. The same point, to the last decimal. */
        val at: FencePoint,
        /** What it takes off the order, or null when it changes no material. */
        val effect: JoinEffect?,
    )

    /**
     * The corner an attach is about to move, where to, and what that costs in
     * feet -- or null when nothing needs to move.
     *
     * [runFeetBefore] and [runFeetAfter] are the whole run's measured footage,
     * not the one side's, because that is what the labour is charged on.
     */
    data class JoinGapCloser(
        val end: JoinEnd,
        val from: FencePoint,
        val to: FencePoint,
        val distanceFeet: Float,
        val runFeetBefore: Float,
        val runFeetAfter: Float,
    )

    /**
     * Whether this end is the FIRST or LAST point of its run, and which.
     *
     * Null for a vertex in the middle of a run, which is a bend inside that
     * run and not an end at all. A middle corner cannot be joined and must not
     * be offered: the storage is two columns, start_joint and end_joint, so
     * there is nowhere to record it -- and the post is already a corner post
     * there, so there is nothing to save either.
     */
    fun endAtVertex(run: JoinCandidateRun, index: Int): JoinEnd? {
        if (!run.attachable) return null
        if (index == 0) return JoinEnd(run.runId, false)
        if (index == run.points.lastIndex) return JoinEnd(run.runId, true)
        return null
    }

    /**
     * The offer to raise after a point was drawn or dragged, or null.
     *
     * [runs] must already carry the placed point, so [movingEnd] reports where
     * the snap actually put it. Everything below is a reason to stay silent:
     *
     *  1. **The two ends must be on ONE point, exactly.** Float equality, on
     *     purpose, and it is the whole filter between a VERTEX snap and the
     *     other two. A vertex snap RETURNS the existing corner's own
     *     coordinates, so the two are bit-identical; a heading snap and a
     *     whole-foot snap land on a point computed from an angle and a
     *     distance, which does not come out bit-identical to an existing
     *     corner except by accident. A tolerance here would start offering
     *     joins for ends that are merely near, which is proximity deciding a
     *     join -- the one thing he said never to do.
     *  2. **The target must be another run's END.** Not a bend in the middle
     *     (nowhere to store it, nothing to save), and not this run's own
     *     earlier corner -- that is closing a loop, which [decide] refuses as
     *     SAME_RUN and which has its own control on the screen.
     *  3. **The target must be FREE.** An end already at a post would be a T,
     *     and a snap cannot say T: three ends at one post are coincident, so
     *     "the end I landed on" does not name which post member he meant.
     *     That is what the Attach tool's two deliberate taps are for.
     *  4. **[decide] has the last word.** Teardown against new, a closed loop,
     *     typed footage, already attached -- re-derived here rather than
     *     re-written, so the offer can never be made for something the write
     *     would refuse.
     *
     * Returns the FIRST qualifying partner in run order. There can be more than
     * one only when two other runs already have free ends on the identical
     * point, which is the T case (3) says a snap cannot resolve -- so the order
     * is made deterministic by run id and the offer is honest about naming one
     * pair, not a crowd.
     */
    fun offerFromSnap(
        runs: List<JoinCandidateRun>,
        movingEnd: JoinEnd,
        newJointId: String,
        pxPerFt: Float,
    ): SnapJoinOffer? {
        val movingRun = runOf(runs, movingEnd) ?: return null
        if (!movingRun.attachable) return null
        // The end he just placed must itself be free: landing a second side on
        // a corner that is already a shared post is the T case again.
        if (liveJointOf(runs, movingEnd).isNotBlank()) return null
        val at = movingRun.pointAt(movingEnd.atEnd) ?: return null

        for (candidate in runs.sortedBy { it.runId }) {
            if (candidate.runId == movingRun.runId) continue
            if (!candidate.attachable) continue
            for (atEnd in listOf(false, true)) {
                val other = JoinEnd(candidate.runId, atEnd)
                val point = candidate.pointAt(atEnd) ?: continue
                // (1) One point, exactly.
                if (point.x != at.x || point.y != at.y) continue
                // (3) Free.
                if (liveJointOf(runs, other).isNotBlank()) continue
                // (4) The write's own rules.
                val decision = decide(runs, movingEnd, other, newJointId)
                if (!decision.allowed) continue
                return SnapJoinOffer(
                    decision = decision,
                    movingEnd = movingEnd,
                    targetEnd = other,
                    at = at,
                    effect = effectOfAttaching(runs, decision, pxPerFt),
                )
            }
        }
        return null
    }

    /**
     * Which corner an attach must move so the two ends become one point, where
     * to, and what it does to that run's footage. Null when nothing moves.
     *
     * WHICH END MOVES, and why it is not a coin toss:
     *
     *  - **The FREE end moves.** An end already at a shared post cannot be the
     *    one that moves: it would leave the OTHER members of that post standing
     *    where they are, re-opening the post it was already at to close a
     *    different one. So a third side reaching an existing corner walks to
     *    the corner, never the other way round.
     *  - **Both free: the one he picked up first.** The screen's own words are
     *    "Tap the end of a side to attach it", then "Now tap the end it joins"
     *    -- the first is the thing being attached and the second is where it is
     *    going, which is also what "attach A to B" means in English. The
     *    first-tapped end is the one already drawn highlighted under his finger
     *    (the pick marker), so the corner that moves is the corner he can see.
     *
     * Null when the two ends are already on one point -- which is every join
     * made from a snap -- so a join that moves nothing says nothing about
     * movement.
     *
     * Refusing a gap wider than [CLOSE_GAP_MAX_FT] is NOT this function's job:
     * it reports the move honestly at any distance and the caller refuses
     * ([JoinRefusal.TOO_FAR_APART]), so the distance that is allowed lives in
     * exactly one place and the figures shown are the real ones.
     */
    fun gapCloserFor(
        runs: List<JoinCandidateRun>,
        decision: JoinDecision,
        pxPerFt: Float,
    ): JoinGapCloser? {
        if (!decision.allowed || decision.ends.size != 2) return null
        val first = decision.ends[0]
        val second = decision.ends[1]
        val firstAtPost = liveJointOf(runs, first).isNotBlank()
        val secondAtPost = liveJointOf(runs, second).isNotBlank()
        // Both already at posts is AT_ANOTHER_POINT and never reaches here.
        val moving = if (firstAtPost && !secondAtPost) second else first
        val anchor = if (moving == first) second else first

        val movingRun = runOf(runs, moving) ?: return null
        val from = movingRun.pointAt(moving.atEnd) ?: return null
        val to = pointOf(runs, anchor) ?: return null
        if (from.x == to.x && from.y == to.y) return null
        if (pxPerFt <= 0f) return null

        val dx = (to.x - from.x).toDouble()
        val dy = (to.y - from.y).toDouble()
        val movedFt = (sqrt(dx * dx + dy * dy) / pxPerFt).toFloat()

        val before = movingRun.points
        val after = before.toMutableList()
        val index = if (moving.atEnd) after.lastIndex else 0
        if (index !in after.indices) return null
        after[index] = to
        return JoinGapCloser(
            end = moving,
            from = from,
            to = to,
            distanceFeet = movedFt,
            runFeetBefore = FenceGeometryEngine.analyze(before, pxPerFt, movingRun.closedLoop).totalLinearFeet,
            runFeetAfter = FenceGeometryEngine.analyze(after, pxPerFt, movingRun.closedLoop).totalLinearFeet,
        )
    }

    /**
     * The post this end is at, or blank.
     *
     * Live only when the id is held by the ends of at least two DIFFERENT runs,
     * which is the rule the arithmetic applies (1.4) and the rule the retired
     * table's queries carried: an id left on one end -- its partner deleted, or
     * not synced down yet -- is a free end, and a free end is today's price.
     */
    fun liveJointOf(runs: List<JoinCandidateRun>, end: JoinEnd): String {
        val run = runOf(runs, end) ?: return ""
        val id = run.jointIdAt(end.atEnd)
        if (id.isBlank()) return ""
        return if (runsAtJoint(runs, id).size >= 2) id else ""
    }

    /** The distinct runs holding this joint id at either end, lowest id first. */
    fun runsAtJoint(runs: List<JoinCandidateRun>, jointId: String): List<String> {
        if (jointId.isBlank()) return emptyList()
        val ids = LinkedHashSet<String>()
        for (run in runs) {
            if (run.startJointId == jointId || run.endJointId == jointId) ids.add(run.runId)
        }
        return ids.sorted()
    }

    /** Every end holding this joint id, lowest run id first, start before end. */
    fun endsAtJoint(runs: List<JoinCandidateRun>, jointId: String): List<JoinEnd> {
        if (jointId.isBlank()) return emptyList()
        val out = mutableListOf<JoinEnd>()
        for (run in runs.sortedBy { it.runId }) {
            if (run.startJointId == jointId) out.add(JoinEnd(run.runId, false))
            if (run.endJointId == jointId) out.add(JoinEnd(run.runId, true))
        }
        return out
    }

    /**
     * Whether two tapped ends may be attached, and to which post.
     *
     * The refusals, in order, are planJoin's own (data/RunJoin.kt), re-homed
     * here as docs/JOINING_RUNS.md 11.1 asks: they are the right rules and only
     * their storage was wrong. Two differences, both deliberate:
     *
     *  - the same-job check is by construction, not a field: [runs] is one
     *    job's runs, so two jobs can never be compared.
     *  - an id held by only one end counts as blank ([liveJointOf]), so a
     *    half-synced attachment does not block a real one.
     *
     * [newJointId] is used only when both ends are free. When one end is
     * already at a post the other joins THAT post, which is how a third side
     * reaches an existing corner (a T) in one write instead of three.
     */
    fun decide(
        runs: List<JoinCandidateRun>,
        a: JoinEnd,
        b: JoinEnd,
        newJointId: String,
    ): JoinDecision {
        val runA = runOf(runs, a)
        val runB = runOf(runs, b)
        if (runA == null || runB == null) return JoinDecision(JoinRefusal.NOT_FOUND)
        if (runA.runId == runB.runId) return JoinDecision(JoinRefusal.SAME_RUN)
        if (runA.closedLoop || runB.closedLoop) return JoinDecision(JoinRefusal.CLOSED_LOOP)
        if (runA.typedFootage || runB.typedFootage) return JoinDecision(JoinRefusal.TYPED_FOOTAGE)
        if (runA.isTeardown != runB.isTeardown) return JoinDecision(JoinRefusal.TEARDOWN_MISMATCH)

        val jointA = liveJointOf(runs, a)
        val jointB = liveJointOf(runs, b)
        if (jointA.isNotBlank() && jointA == jointB) return JoinDecision(JoinRefusal.ALREADY_ATTACHED)
        if (jointA.isNotBlank() && jointB.isNotBlank()) return JoinDecision(JoinRefusal.AT_ANOTHER_POINT)

        val ends = listOf(a, b)
        if (jointA.isNotBlank()) {
            return if (runB.jointIdAt(!b.atEnd) == jointA) JoinDecision(JoinRefusal.SAME_RUN)
            else JoinDecision(null, jointA, ends)
        }
        if (jointB.isNotBlank()) {
            return if (runA.jointIdAt(!a.atEnd) == jointB) JoinDecision(JoinRefusal.SAME_RUN)
            else JoinDecision(null, jointB, ends)
        }
        if (newJointId.isBlank()) return JoinDecision(JoinRefusal.NOT_FOUND)
        return JoinDecision(null, newJointId, ends)
    }

    /**
     * The runs with a joint id written at one end -- the drawing as it WOULD be.
     *
     * Pure, so the confirmation can be shown the real arithmetic's answer
     * before anything is written and the write itself has one list of rows to
     * save. Writing a blank id is a detach.
     */
    fun withJointAt(
        runs: List<JoinCandidateRun>,
        end: JoinEnd,
        jointId: String,
    ): List<JoinCandidateRun> = runs.map { run ->
        if (run.runId != end.runId) run
        else if (end.atEnd) run.copy(endJointId = jointId)
        else run.copy(startJointId = jointId)
    }

    /** The runs with a decision's joint id written at both of its ends. */
    fun withDecisionApplied(
        runs: List<JoinCandidateRun>,
        decision: JoinDecision,
    ): List<JoinCandidateRun> {
        if (!decision.allowed) return runs
        var out = runs
        for (end in decision.ends) out = withJointAt(out, end, decision.jointId)
        return out
    }

    /**
     * The posts the plan should draw as shared, from the arithmetic itself.
     *
     * Built from [JoinAdjustment.posts], so a recorded joint the price IGNORES
     * -- one member left after its partner was deleted, a run since closed,
     * typed or made a teardown -- is not drawn as a shared post. The drawing
     * must not show a post the estimate is not counting: that is the confusion
     * this whole feature exists to end.
     */
    fun markers(runs: List<JoinCandidateRun>, pxPerFt: Float): List<JointMarker> {
        val adjustment = RunJoinArithmetic.adjust(runs.map { toJoinable(it, pxPerFt) })
        if (adjustment.posts.isEmpty()) return emptyList()
        val out = mutableListOf<JointMarker>()
        for (post in adjustment.posts) {
            val ends = endsAtJoint(runs, post.jointId).filter { post.memberRunIds.contains(it.runId) }
            val points = ends.mapNotNull { pointOf(runs, it) }
            val point = points.firstOrNull() ?: continue
            out.add(
                JointMarker(
                    jointId = post.jointId,
                    point = point,
                    kind = post.kind,
                    memberCount = post.degree,
                    openByFeet = if (pxPerFt > 0f) widestGapPx(points) / pxPerFt else 0f,
                    ends = ends,
                )
            )
        }
        return out
    }

    /**
     * What attaching the two ends of a decision would do to the materials, or
     * null when it would do nothing at all.
     *
     * Null is a real answer and the wording must say so rather than claim a
     * saving: two teardown runs bill no posts, so attaching them changes no
     * material, and an end whose run has nothing measurable drawn has no post
     * to give up. The attachment is still worth recording -- it is his drawing,
     * and the run may be drawn properly a minute later -- but nothing comes off
     * the order today.
     */
    fun effectOfAttaching(
        runs: List<JoinCandidateRun>,
        decision: JoinDecision,
        pxPerFt: Float,
    ): JoinEffect? {
        if (!decision.allowed) return null
        val after = withDecisionApplied(runs, decision)
        return effectBetween(runs, after, decision.jointId, decision.ends, pxPerFt, 1)
    }

    /**
     * What detaching one end would put back, or null when it changes nothing.
     *
     * The same arithmetic read the other way round: the "after" drawing is the
     * one with this end freed, and the sign is flipped so the caller can say
     * "puts back 1 post" with the same figures.
     */
    fun effectOfDetaching(
        runs: List<JoinCandidateRun>,
        end: JoinEnd,
        pxPerFt: Float,
    ): JoinEffect? {
        val jointId = liveJointOf(runs, end)
        if (jointId.isBlank()) return null
        val ends = endsAtJoint(runs, jointId)
        val after = withJointAt(runs, end, "")
        return effectBetween(after, runs, jointId, ends, pxPerFt, -1)
    }

    /** The widest distance between any two of these points, in drawing pixels. */
    private fun widestGapPx(points: List<FencePoint>): Float {
        var widest = 0f
        for (i in points.indices) {
            for (j in i + 1 until points.size) {
                val dx = (points[i].x - points[j].x).toDouble()
                val dy = (points[i].y - points[j].y).toDouble()
                val d = sqrt(dx * dx + dy * dy).toFloat()
                if (d > widest) widest = d
            }
        }
        return widest
    }

    /**
     * The difference the arithmetic makes between two drawings, as savings.
     *
     * The figures are the "after" drawing minus the "before" one, so attaching
     * (which passes them in that order) gives positive savings and detaching
     * (which passes them the other way round, with a sign of -1) gives negative
     * ones. The post described -- its kind, its owner, how many ends meet at it
     * -- is always the one that EXISTS in the second list, which is the post
     * being created when attaching and the post being broken up when detaching.
     *
     * Null when the two drawings price the same: the joint is one the
     * arithmetic ignores, and nothing may be claimed for it.
     */
    private fun effectBetween(
        before: List<JoinCandidateRun>,
        after: List<JoinCandidateRun>,
        jointId: String,
        ends: List<JoinEnd>,
        pxPerFt: Float,
        sign: Int,
    ): JoinEffect? {
        val wasAdjustment = RunJoinArithmetic.adjust(before.map { toJoinable(it, pxPerFt) })
        val isAdjustment = RunJoinArithmetic.adjust(after.map { toJoinable(it, pxPerFt) })
        val post = isAdjustment.posts.firstOrNull { it.jointId == jointId } ?: return null
        val saved = isAdjustment.postsSaved - wasAdjustment.postsSaved
        if (saved == 0) return null

        var endPosts = 0
        var cornerPosts = 0
        var linePosts = 0
        for (runId in post.memberRunIds) {
            val was = wasAdjustment.forRun(runId)
            val now = isAdjustment.forRun(runId)
            endPosts += was.endPostsDelta - now.endPostsDelta
            cornerPosts += now.cornerPostsDelta - was.cornerPostsDelta
            linePosts += now.linePostsDelta - was.linePostsDelta
        }

        return JoinEffect(
            postsSaved = saved * sign,
            postCapsSaved = saved * sign,
            endPostsRemoved = endPosts * sign,
            cornerPostsAdded = cornerPosts * sign,
            linePostsAdded = linePosts * sign,
            kind = post.kind,
            ownerRunId = post.ownerRunId,
            memberCount = post.degree,
            gapFeet = if (pxPerFt > 0f) widestGapPx(ends.mapNotNull { pointOf(after, it) }) / pxPerFt else 0f,
        )
    }

    /**
     * The arithmetic's view of one run.
     *
     * The geometry is [FenceGeometryEngine.analyze], the same call the takeoff
     * measures a run with, so eligibility here is decided by exactly what the
     * price decides it by: a closed run and a run of fewer than two points come
     * back with no ends, and a typed-footage run is handed no points at all,
     * as the engine's own resolveGeometry hands it none.
     */
    private fun toJoinable(run: JoinCandidateRun, pxPerFt: Float): JoinableRun = JoinableRun(
        id = run.runId,
        geometry = if (run.typedFootage) FenceGeometryEngine.analyze(emptyList(), pxPerFt, false)
        else FenceGeometryEngine.analyze(run.points, pxPerFt, run.closedLoop),
        heightFt = run.heightFt,
        sortOrder = run.sortOrder,
        isTeardown = run.isTeardown,
        startJointId = run.startJointId,
        endJointId = run.endJointId,
    )
}
