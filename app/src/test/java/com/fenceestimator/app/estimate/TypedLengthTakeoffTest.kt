package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.MaterialRole
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FenceGeometryEngine
import com.fenceestimator.app.geometry.FencePoint
import com.fenceestimator.app.geometry.setSideLength
import com.fenceestimator.app.geometry.sideLengthFeet
import com.fenceestimator.app.geometry.stretchSegment
import com.fenceestimator.app.ui.components.FeetInches
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Type a length into the drawing, and the estimate prices that length.
 *
 * Walks the app's own path end to end: the text typed into the dialog is
 * parsed by [FeetInches.parse], the side is set by [setSideLength] (what
 * SurveyViewModel.setSegmentLengthFeet calls), the points go through
 * [FenceCodec] into the stored run exactly as Room holds them, and the
 * takeoff reads them back through [EstimateEngine] -- the same entry points
 * the estimate screen, the totals and the material list use. The number on
 * the plan's dimension label is read off the same run, so the test proves the
 * shown length and the priced length are one number.
 */
class TypedLengthTakeoffTest {

    private val gridPxPerFt = 20f
    private fun p(x: Float, y: Float) = FencePoint(x, y)
    private fun job() = Job(customerName = "Test", calibrationPixelsPerFoot = gridPxPerFt)

    private fun storedRun(points: List<FencePoint>, closed: Boolean = false) = FenceRun(
        jobId = 1,
        fenceType = FenceType.VINYL,
        pointsEncoded = FenceCodec.encodePoints(points),
        closedLoop = closed,
        panelWidthFt = 6f,
        postSpacingFt = 6f,
        concreteBagsPerPost = 1f
    )

    /** What the plan's label and the segment chip show for side [i] of a stored run. */
    private fun shownFeet(run: FenceRun, i: Int): Float =
        FenceGeometryEngine.analyze(FenceCodec.decodePoints(run.pointsEncoded), gridPxPerFt, run.closedLoop)
            .segments[i].lengthFt

    /** Type [text] into side [index] and store the result, as the app does. */
    private fun type(text: String, points: List<FencePoint>, index: Int, closed: Boolean = false): FenceRun {
        val feet = FeetInches.parse(text)!!
        val edit = setSideLength(points, emptyList(), index, feet, gridPxPerFt, closed)!!
        return storedRun(edit.points, closed)
    }

    @Test
    fun `typing 47' 6 inches makes the takeoff exactly 47_5 feet`() {
        val run = type("47' 6\"", listOf(p(1000f, 1000f), p(1937.3f, 1000f)), 0)

        val linear = EstimateEngine.linearFeet(job(), listOf(run))
        assertEquals(47.5f, linear, 0f)

        val suggestions = EstimateEngine.suggestQuantities(run, gridPxPerFt)
        assertEquals(47.5f, suggestions.geometry.totalLinearFeet, 0f)
        val fenceLength = suggestions.takeoff.first { it.label == "Fence length" }.quantity
        assertEquals(47.5, fenceLength, 0.0)

        // The label on the plan is the same number, and reads back as typed.
        assertEquals(linear, shownFeet(run, 0), 0f)
        assertEquals("47'6\"", FeetInches.formatCompact(shownFeet(run, 0)))
        assertEquals("47' 6\"", FeetInches.format(shownFeet(run, 0)))
    }

    @Test
    fun `a typed 48 foot diagonal buys eight six-foot panels, not nine`() {
        // A diagonal where plain float arithmetic lands the corner a hair past
        // 48 ft (see the planted failure below).
        val run = type("48'", listOf(p(2508.652f, 394.14835f), p(2190.7705f, 304.57584f)), 0)

        val linear = EstimateEngine.linearFeet(job(), listOf(run))
        assertTrue("measured $linear", linear <= 48f)
        assertEquals(48f, linear, 1e-4f)
        assertEquals(linear, shownFeet(run, 0), 0f)
        assertEquals("48'", FeetInches.formatCompact(linear))

        val s = EstimateEngine.suggestQuantities(run, gridPxPerFt)
        assertEquals(8.0, s.entries.filter { it.role == MaterialRole.PANEL }.sumOf { it.quantity }, 0.0)
        // 8 bays on an open run: 9 posts, two of them ends.
        assertEquals(
            9.0,
            s.entries.filter { it.role in setOf(MaterialRole.LINE_POST, MaterialRole.END_POST) }.sumOf { it.quantity },
            0.0
        )
    }

    // --- Planted failure: the same diagonal through the old slide orders a ninth panel. ---
    @Test
    fun `planted failure - the old slide turned a typed 48 feet into nine panels`() {
        val points = listOf(p(2508.652f, 394.14835f), p(2190.7705f, 304.57584f))
        val old = storedRun(stretchSegment(points, 0, 48f * gridPxPerFt)!!)
        val linear = EstimateEngine.linearFeet(job(), listOf(old))
        assertTrue("expected the old slide to overshoot, got $linear", linear > 48f)
        val s = EstimateEngine.suggestQuantities(old, gridPxPerFt)
        assertEquals(9.0, s.entries.filter { it.role == MaterialRole.PANEL }.sumOf { it.quantity }, 0.0)
    }

    @Test
    fun `both legs typed on an L add up exactly in the takeoff`() {
        val ell = listOf(p(1000f, 1000f), p(1937.3f, 1000f), p(1937.3f, 1612.25f))
        val secondLeg = type("24'", ell, 1)
        val both = type("36'", FenceCodec.decodePoints(secondLeg.pointsEncoded), 0)
        assertEquals(36f, shownFeet(both, 0), 0f)
        assertEquals(24f, shownFeet(both, 1), 0f)
        assertEquals(60f, EstimateEngine.linearFeet(job(), listOf(both)), 0f)
        // 60 ft of 6 ft panels is ten panels, not eleven.
        val s = EstimateEngine.suggestQuantities(both, gridPxPerFt)
        assertEquals(10.0, s.entries.filter { it.role == MaterialRole.PANEL }.sumOf { it.quantity }, 0.0)
    }

    @Test
    fun `the closing side of a loop can be typed and the perimeter follows`() {
        // A 40 x 30 yard at 20 px/ft; the tape says the closing side is 31' 3".
        val yard = listOf(p(1000f, 1000f), p(1800f, 1000f), p(1800f, 1600f), p(1000f, 1600f))
        val run = type("31' 3\"", yard, 3, closed = true)
        assertEquals(31.25f, shownFeet(run, 3), 0f)
        assertEquals(
            31.25f,
            sideLengthFeet(FenceCodec.decodePoints(run.pointsEncoded), 3, gridPxPerFt, closedLoop = true)!!,
            0f
        )
        val sides = (0..3).sumOf { shownFeet(run, it).toDouble() }.toFloat()
        assertEquals(sides, EstimateEngine.linearFeet(job(), listOf(run)), 1e-3f)
        // The first corner -- where the run starts -- has not moved.
        assertEquals(yard[0], FenceCodec.decodePoints(run.pointsEncoded)[0])
    }
}
