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
data class GateMarker(
    val x: Float,
    val y: Float,
    val widthFt: Float
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
        gates.joinToString(",") { "${it.x}:${it.y}:${it.widthFt}" }

    fun decodeGates(raw: String): List<GateMarker> {
        if (raw.isBlank()) return emptyList()
        return raw.split(",").mapNotNull { triple ->
            val parts = triple.split(":")
            if (parts.size != 3) return@mapNotNull null
            val x = parts[0].toFloatOrNull() ?: return@mapNotNull null
            val y = parts[1].toFloatOrNull() ?: return@mapNotNull null
            val w = parts[2].toFloatOrNull() ?: return@mapNotNull null
            GateMarker(x, y, w)
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
