package com.fenceestimator.app.geometry

import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.roundToInt

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
            total += hypot((b.x - a.x).toDouble(), (b.y - a.y).toDouble()).toFloat()
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
            val distPx = hypot((b.x - a.x).toDouble(), (b.y - a.y).toDouble()).toFloat()
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
