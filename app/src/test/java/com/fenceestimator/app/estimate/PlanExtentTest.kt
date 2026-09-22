package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FencePoint
import com.fenceestimator.app.geometry.GateGeometry
import com.fenceestimator.app.geometry.GateMarker
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * A plan that is one gate sold on its own still draws.
 *
 * One gate is one point: the customer PDF's "is there anything to fit" check
 * (maxX > minX || maxY > minY) refused it and the contract went out with no
 * plan, and the crew plan kept only runs with a line, so a job whose only run
 * was the gate showed no canvas at all. The drawing screen lays such a gate
 * level at its real width ([GateGeometry.standaloneSpan]); [PlanExtent] fits
 * the plan to its two posts the same way, and leaves every other plan's box
 * exactly as it was.
 */
class PlanExtentTest {

    /** A 100 ft grid: 80 units per foot, so the scale is the grid's own, not a flat 20. */
    private val gridJob = Job(gridExtentFt = 100f)

    private fun run(points: List<FencePoint> = emptyList(), gates: List<GateMarker> = emptyList(), closed: Boolean = false) =
        FenceRun(
            jobId = 1, fenceType = FenceType.VINYL,
            pointsEncoded = FenceCodec.encodePoints(points),
            gatesEncoded = FenceCodec.encodeGates(gates),
            closedLoop = closed
        )

    private val gateOnly = run(gates = listOf(GateMarker(4000f, 4000f, widthFt = 4f)))

    @Test
    fun `a plan that is one standalone gate has a box as wide as the gate`() {
        val scale = DrawingScale.of(gridJob)
        assertEquals(80f, scale!!, 0.0001f)
        val spans = PlanExtent.standaloneGateSpans(listOf(gateOnly), scale)
        assertEquals(1, spans.size)
        assertEquals(GateGeometry.NO_SEGMENT, spans.single().second.segmentIndex)

        // What the PDF has always fitted to: the gate's own marker.
        val marker = listOf(FencePoint(4000f, 4000f))
        val box = PlanExtent.bounds(marker, spans.map { it.second })
        assertNotNull("a gate-only plan has something to draw", box)
        assertEquals("4 ft at 80 units per foot", 320f, box!!.maxX - box.minX, 0.001f)
        assertEquals(3840f, box.minX, 0.001f)
        assertEquals(4160f, box.maxX, 0.001f)
        assertEquals(0f, box.maxY - box.minY, 0.001f)

        // Planted failure: without the gate's posts it is one point -- the
        // box the old check refused, and the plan that never printed.
        assertNull(PlanExtent.bounds(marker, emptyList()))
    }

    @Test
    fun `a plan whose gates sit on a line fits exactly as it did`() {
        val line = listOf(FencePoint(0f, 0f), FencePoint(4000f, 0f), FencePoint(4000f, 3000f))
        val fenced = run(points = line, gates = listOf(GateMarker(2000f, 10f, widthFt = 4f)))
        val spans = PlanExtent.standaloneGateSpans(listOf(fenced), DrawingScale.of(gridJob))
        assertTrue("a gate on a line is placed on the line, not standing alone", spans.isEmpty())
        val fitted = line + FencePoint(2000f, 10f)
        assertEquals(
            PlanExtent.Bounds(0f, 0f, 4000f, 3000f),
            PlanExtent.bounds(fitted, spans.map { it.second })
        )
    }

    @Test
    fun `a gate beside a fence widens the box only by its own posts`() {
        val line = listOf(FencePoint(0f, 0f), FencePoint(1000f, 0f))
        val runs = listOf(run(points = line), run(gates = listOf(GateMarker(1500f, 500f, widthFt = 5f))))
        val spans = PlanExtent.standaloneGateSpans(runs, 20f)
        assertEquals(1, spans.size)
        val box = PlanExtent.bounds(line, spans.map { it.second })!!
        // 5 ft at 20 units per foot: posts at 1450 and 1550.
        assertEquals(PlanExtent.Bounds(0f, 0f, 1550f, 500f), box)
    }

    @Test
    fun `with no scale a standalone gate has no width to fit`() {
        // A photo nobody has calibrated: the drawing refuses to size a gate
        // too, rather than guess.
        val uncalibratedPhoto = Job(surveyImagePath = "/data/user/0/app/files/surveys/survey_1.jpg")
        assertNull(DrawingScale.of(uncalibratedPhoto))
        assertTrue(PlanExtent.standaloneGateSpans(listOf(gateOnly), DrawingScale.of(uncalibratedPhoto)).isEmpty())
    }

    @Test
    fun `a run is on the plan with a line or with a gate`() {
        assertTrue(PlanExtent.hasSomethingToDraw(gateOnly))
        assertTrue(PlanExtent.hasSomethingToDraw(run(points = listOf(FencePoint(0f, 0f), FencePoint(10f, 0f)))))
        assertFalse(PlanExtent.hasSomethingToDraw(run()))
        assertFalse("one corner and no gate is nothing to draw", PlanExtent.hasSomethingToDraw(run(points = listOf(FencePoint(0f, 0f)))))
        // Planted failure: the crew plan's old rule, lines only, drops the gate.
        assertFalse(FenceCodec.decodePoints(gateOnly.pointsEncoded).size >= 2)
    }

    // ---- the two callers ----

    private fun source(path: String): String =
        listOf(File("src/main/java/com/fenceestimator/app/$path"), File("app/src/main/java/com/fenceestimator/app/$path"))
            .first { it.isFile }.readText()

    @Test
    fun `the crew plan keeps gate-only runs and sizes their gates like the drawing`() {
        val src = source("ui/crew/CrewFencePlanScreen.kt")
        assertTrue(
            "the crew plan filters runs by something other than PlanExtent.hasSomethingToDraw",
            src.contains("val drawn = runs.filter { PlanExtent.hasSomethingToDraw(it) }")
        )
        val canvas = src.substringAfter("private fun PlanCanvas(").substringBefore("private fun Legend(")
        assertTrue(canvas.contains("DrawingScale.of(job)"))
        assertTrue(canvas.contains("PlanExtent.standaloneGateSpans(listOf(it), drawingScale)"))
        assertTrue("a standalone gate's posts are not fitted", canvas.contains("listOf(span.start, span.end)"))
        assertFalse(
            "gate-only runs are skipped before their gates are drawn",
            canvas.contains("if (points.size < 2) return@forEach")
        )
    }

    @Test
    fun `the customer PDF fits a standalone gate's posts`() {
        val src = source("estimate/PdfExporter.kt")
        assertTrue(src.contains("PlanExtent.standaloneGateSpans(drawableRuns, DrawingScale.of(job))"))
        assertTrue(src.contains("standalone = standaloneGates.map { it.second }"))
        assertFalse("the one-point box check is back", src.contains("if (maxX > minX || maxYv > minY)"))
    }
}
