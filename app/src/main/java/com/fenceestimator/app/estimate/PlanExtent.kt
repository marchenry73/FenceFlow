package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FencePoint
import com.fenceestimator.app.geometry.GateGeometry
import com.fenceestimator.app.geometry.GateMarker
import com.fenceestimator.app.geometry.GateSpan

/**
 * How much room a plan takes up, for the two places that shrink one to fit:
 * the customer's PDF (PdfExporter) and the crew's read-only plan
 * (CrewFencePlanScreen).
 *
 * Both fitted the box to the points they had -- the fence line's corners,
 * and on the PDF the gate markers too -- and a gate sold on its own has no
 * corners: one gate is one point, a box with no size. So the PDF's
 * "is there anything to fit" check refused it and the contract went out with
 * no plan, and the crew plan dropped every run without a line and showed no
 * canvas at all. The drawing screen lays such a gate level at its real width
 * ([GateGeometry.standaloneSpan]); a gate HAS width, so its two posts are
 * what gives the box its size here too.
 *
 * Pure -- no Android, no database -- so PlanExtentTest holds it to that.
 */
object PlanExtent {

    /** The smallest box around a plan, in the drawing's own coordinates. */
    data class Bounds(val minX: Float, val minY: Float, val maxX: Float, val maxY: Float)

    /** Whether [run] puts anything on a plan: a fence line, or a gate standing on its own. */
    fun hasSomethingToDraw(run: FenceRun): Boolean =
        FenceCodec.decodePoints(run.pointsEncoded).size >= 2 ||
            FenceCodec.decodeGates(run.gatesEncoded).isNotEmpty()

    /**
     * Every gate on [runs] with no fence line under it -- a gate-only run, or
     * a run whose corners sit on top of each other -- laid out exactly as the
     * drawing screen lays it ([GateGeometry.spansFor], which falls back to
     * [GateGeometry.standaloneSpan]). A gate that sits on a line is not here:
     * its place is on the line, which is already in the box.
     *
     * @param pixelsPerFoot the drawing's scale ([DrawingScale.of]). Null for a
     *   photo nobody has calibrated: a width in feet has no size on the plan
     *   then, and the list is empty -- the same refusal the drawing makes.
     */
    fun standaloneGateSpans(runs: List<FenceRun>, pixelsPerFoot: Float?): List<Pair<GateMarker, GateSpan>> =
        runs.flatMap { run ->
            GateGeometry.spansFor(
                FenceCodec.decodeGates(run.gatesEncoded),
                FenceCodec.decodePoints(run.pointsEncoded),
                run.closedLoop,
                pixelsPerFoot
            ).filter { (_, span) -> span.segmentIndex == GateGeometry.NO_SEGMENT }
        }

    /**
     * The box around [fitted] -- whatever points the caller has always fitted
     * its plan to, unchanged -- widened to take in both posts of every
     * [standalone] gate. Null when the lot covers no length and no area (no
     * points, or one), which is the caller's "nothing to draw".
     *
     * With no standalone gates this is exactly the box of [fitted], so every
     * plan that already drew draws the same as before.
     */
    fun bounds(fitted: List<FencePoint>, standalone: List<GateSpan>): Bounds? {
        val all = fitted + standalone.flatMap { listOf(it.start, it.end) }
        if (all.isEmpty()) return null
        val box = Bounds(
            minX = all.minOf { it.x },
            minY = all.minOf { it.y },
            maxX = all.maxOf { it.x },
            maxY = all.maxOf { it.y }
        )
        return box.takeIf { it.maxX > it.minX || it.maxY > it.minY }
    }
}
