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

    /**
     * The old slide still overshoots -- and as of 23 Oct 2026 that overshoot
     * no longer reaches the panel count.
     *
     * THIS TEST USED TO ASSERT NINE PANELS, and it was right to: a typed 48 ft
     * run through the old slide landed the corner a hair past 48, and
     * `ceil(48.00000x / 6)` is 9. That was the planted failure proving the
     * typed-length path above is load-bearing.
     *
     * [EstimateEngine.COUNT_TOLERANCE_FT] now absorbs exactly that hair, so
     * the old slide buys eight panels too. The canary did not rot -- what it
     * planted was FLOAT NOISE, and float noise is the thing the tolerance was
     * added to defend against, so a second line of defence grew in front of
     * it. Asserted here rather than deleted, because "the old slide's
     * overshoot is smaller than a thousandth of a foot" is a fact about the
     * slide worth pinning, and because a planted failure that silently stops
     * firing is how a suite comes to prove nothing.
     *
     * THE CANARY IS REPLANTED BELOW with an overshoot the tolerance must NOT
     * absorb. If that half ever reads eight, the tolerance has grown big
     * enough to swallow real fence.
     */
    @Test
    fun `planted failure - the old slide overshoots, and that overshoot is now float noise`() {
        val points = listOf(p(2508.652f, 394.14835f), p(2190.7705f, 304.57584f))
        val old = storedRun(stretchSegment(points, 0, 48f * gridPxPerFt)!!)
        val linear = EstimateEngine.linearFeet(job(), listOf(old))

        // Still the wrong way to set a length: it does not land on the number.
        assertTrue("expected the old slide to overshoot, got $linear", linear > 48f)
        // And the overshoot is under a thousandth of a foot -- a hundredth of
        // an inch -- which is what makes it noise rather than fence.
        assertTrue(
            "the old slide overshot by ${linear - 48f} ft, which is more than the count " +
                "tolerance absorbs; this test's reasoning no longer holds",
            linear - 48f <= EstimateEngine.COUNT_TOLERANCE_FT
        )
        assertEquals(
            8.0,
            EstimateEngine.suggestQuantities(old, gridPxPerFt)
                .entries.filter { it.role == MaterialRole.PANEL }.sumOf { it.quantity },
            0.0
        )
    }

    /**
     * The replanted canary: an overshoot that is REAL fence still buys the
     * next panel.
     *
     * 48.05 ft is six tenths of an inch past eight bays. A tape can read it,
     * so it must be charged. This is the half that proves the tolerance has
     * not quietly become a licence to round real footage away.
     */
    @Test
    fun `planted failure - an overshoot bigger than the tolerance still buys the ninth panel`() {
        val run = type("48' 1\"", listOf(p(1000f, 1000f), p(1962f, 1000f)), 0)
        val linear = EstimateEngine.linearFeet(job(), listOf(run))
        assertTrue("expected just over 48 ft, got $linear", linear > 48f)
        assertTrue(
            "this case must sit OUTSIDE the tolerance to mean anything, overshoot ${linear - 48f} ft",
            linear - 48f > EstimateEngine.COUNT_TOLERANCE_FT
        )
        assertEquals(
            9.0,
            EstimateEngine.suggestQuantities(run, gridPxPerFt)
                .entries.filter { it.role == MaterialRole.PANEL }.sumOf { it.quantity },
            0.0
        )
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
