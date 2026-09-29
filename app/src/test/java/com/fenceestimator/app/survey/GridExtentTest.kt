package com.fenceestimator.app.survey

import com.fenceestimator.app.geometry.FenceGeometryEngine
import com.fenceestimator.app.geometry.FencePoint
import com.fenceestimator.app.ui.survey.SurveyViewModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * D1: "Unlimited grid -- draw bigger, zoom out and keep finding grid. Make it
 * look good." Pins the relationship the drawing SCALE is built on before and
 * after that change, so a later edit to the grid cannot silently reprice a
 * job the way [GridScaleTest][com.fenceestimator.app.geometry.GridScaleTest]
 * already guards for the fixed chip sizes.
 *
 * The relationship, in one place (see also the doc on
 * [SurveyViewModel.setGridExtent] and [com.fenceestimator.app.estimate.DrawingScale]):
 *
 * - `unitsPerFoot(extentFt) = GRID_CANVAS_SIZE / extentFt` is the ONLY thing
 *   that ever becomes `calibrationPixelsPerFoot`, and calibrationPixelsPerFoot
 *   is the ONLY number pricing (EstimateEngine, the server's totals.ts) or a
 *   drawn length is ever measured by. Nothing added for D1 changes this
 *   formula or feeds it a new input.
 * - [SurveyViewModel.zoomGridExtent] only ever produces a NEW extentFt to
 *   hand to the existing [SurveyViewModel.setGridExtent] -- the same function
 *   the fixed-size chips already call, which rescales every point, gate and
 *   site marker by the ratio the scale changed by so real-world length is
 *   unchanged (proven by GridScaleTest for the chip case; proven again below
 *   for the zoomed case, since the input is now unbounded rather than one of
 *   nine fixed numbers).
 * - [SurveyViewModel.gridFeetPerSquareFor] is display-only: it drives what
 *   SurveyDrawScreen draws as a background gridline, never calibration or a
 *   stored point. Zooming out can therefore never change what a job measures
 *   or costs -- it only changes which lines get drawn where behind it, which
 *   this file also pins.
 */
class GridExtentTest {

    private val canvas = SurveyViewModel.GRID_CANVAS_SIZE.toFloat()

    // ---- the quick-pick list no longer tops out at 2000 ft ----

    @Test
    fun `the quick-pick list now reaches past the old 2000 ft ceiling`() {
        assertTrue(SurveyViewModel.GRID_SIZES_FT.contains(5000f))
        assertTrue(SurveyViewModel.GRID_SIZES_FT.contains(10000f))
        assertEquals(
            "the list is still read top-to-bottom by the chip row -- keep it sorted",
            SurveyViewModel.GRID_SIZES_FT.sorted(),
            SurveyViewModel.GRID_SIZES_FT
        )
    }

    @Test
    fun `the zoom-in floor is exactly the smallest quick pick, not a separate number`() {
        assertEquals(SurveyViewModel.GRID_SIZES_FT.first(), SurveyViewModel.MIN_GRID_EXTENT_FT, 0.0001f)
    }

    // ---- zoomGridExtent: the actually-unlimited control ----

    @Test
    fun `zooming out doubles the current extent, with no ceiling of its own`() {
        var extent = SurveyViewModel.GRID_SIZES_FT.last() // 10000f, the biggest quick pick
        repeat(12) {
            val next = SurveyViewModel.zoomGridExtent(extent, 2f)
            assertEquals(extent * 2f, next, 0.01f)
            assertTrue("must stay a usable number to hand back to setGridExtent", next.isFinite() && next > 0f)
            extent = next
        }
        // Twelve doublings from 10000 ft is comfortably past any real property
        // line and still an ordinary, finite float -- "unlimited" in the sense
        // D1 asks for, not a special-cased huge constant.
        assertEquals(10000f * (1 shl 12), extent, 1f)
    }

    @Test
    fun `zooming in halves the current extent, floored at the smallest quick pick`() {
        var extent = 100f
        val seen = mutableListOf(extent)
        repeat(10) {
            extent = SurveyViewModel.zoomGridExtent(extent, 0.5f)
            seen += extent
        }
        assertEquals(
            "halving must stop finding a smaller grid once the floor is hit, not overshoot past it",
            SurveyViewModel.MIN_GRID_EXTENT_FT,
            extent,
            0.0001f
        )
        // Strictly non-increasing the whole way down -- it never overshoots
        // below the floor and bounces back up.
        for (i in 1 until seen.size) {
            assertTrue(seen[i] <= seen[i - 1] + 0.0001f)
        }
    }

    @Test
    fun `bad input never produces a non-finite or non-positive extent`() {
        for (bad in listOf(0f, -50f, Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY)) {
            for (factor in listOf(2f, 0.5f)) {
                val result = SurveyViewModel.zoomGridExtent(bad, factor)
                assertTrue("zoomGridExtent($bad, $factor) must be finite and positive, was $result", result.isFinite() && result > 0f)
            }
        }
    }

    @Test
    fun `zooming out from near Float's ceiling holds steady instead of overflowing to infinity`() {
        // Any float this size is already meaningless as a foot count (bigger
        // than the solar system); the guarantee being tested is narrower --
        // the function must not hand setGridExtent an infinite or NaN
        // calibration, which unitsPerFoot would turn into a zero or NaN scale.
        val nearCeiling = Float.MAX_VALUE / 1.5f
        val result = SurveyViewModel.zoomGridExtent(nearCeiling, 2f)
        assertTrue(result.isFinite())
        assertEquals(
            "the planted failure: doubling this DOES overflow to Infinity, which is exactly why the guard exists",
            Float.POSITIVE_INFINITY,
            nearCeiling * 2f,
            0f
        )
        assertEquals(nearCeiling, result, 0f)
    }

    // ---- the extent/scale relationship, extended to the new large sizes ----

    @Test
    fun `the canvas still spans exactly the chosen extent at the new large sizes`() {
        // GridScaleTest already pins this for the original list; this is the
        // same assertion for the two sizes D1 adds, so the relationship is on
        // record before anything about the grid's rendering changes.
        for (extent in listOf(5000f, 10000f)) {
            assertEquals(extent, canvas / SurveyViewModel.unitsPerFoot(extent), 0.01f)
        }
    }

    @Test
    fun `a square's real size stays constant across every extent -- what keeps a zoomed-out grid meaningful`() {
        // gridFeetPerSquareFor(extentFt) * unitsPerFoot(extentFt) is the
        // canvas-unit width of one square. If this were not constant, "zoom
        // out and keep finding grid" would eventually draw either a solid
        // colour (squares too small to see) or one giant square with no
        // structure (squares too big to see) -- squares that stop meaning
        // anything, which is the exact failure D1 names.
        val expectedSquareUnits = SurveyViewModel.GRID_CANVAS_SIZE / 20f
        val extents = SurveyViewModel.GRID_SIZES_FT +
            listOf(
                SurveyViewModel.zoomGridExtent(SurveyViewModel.GRID_SIZES_FT.last(), 2f),
                SurveyViewModel.zoomGridExtent(SurveyViewModel.GRID_SIZES_FT.last(), 4f)
            )
        for (extent in extents) {
            val squareUnits = SurveyViewModel.gridFeetPerSquareFor(extent) * SurveyViewModel.unitsPerFoot(extent)
            assertEquals(
                "a grid square should always be about 1/20th of the canvas, at $extent ft",
                expectedSquareUnits,
                squareUnits,
                0.5f
            )
        }
    }

    // ---- zooming out and back preserves everything already drawn ----

    @Test
    fun `zooming the grid out twice and back in twice returns to the same extent and the same measured length`() {
        // The same proof GridScaleTest gives for a fixed chip pick, repeated
        // for zoomGridExtent's unbounded input: this is what
        // SurveyViewModel.setGridExtent actually does on every call (rescale
        // drawn points by the ratio the scale changed by), replayed here by
        // hand so the guarantee is checked independent of the database.
        val startExtent = 2000f
        var scale = SurveyViewModel.unitsPerFoot(startExtent)
        // A 20ft run, drawn on the 2000ft grid.
        var points = listOf(FencePoint(0f, 0f), FencePoint(20f * scale, 0f))
        assertEquals(20f, FenceGeometryEngine.analyze(points, scale).totalLinearFeet, 0.01f)

        var extent = startExtent
        val steps = listOf(2f, 2f, 0.5f, 0.5f) // out, out, in, in
        for (factor in steps) {
            val nextExtent = SurveyViewModel.zoomGridExtent(extent, factor)
            val nextScale = SurveyViewModel.unitsPerFoot(nextExtent)
            val ratio = nextScale / scale
            points = points.map { FencePoint(it.x * ratio, it.y * ratio) }
            extent = nextExtent
            scale = nextScale
            assertEquals(
                "the run must still read 20 ft after zooming to $extent ft",
                20f,
                FenceGeometryEngine.analyze(points, scale).totalLinearFeet,
                0.01f
            )
        }
        assertEquals("two zoom-outs and two zoom-ins land back where it started", startExtent, extent, 0.01f)
    }

    @Test
    fun `forgetting to rescale the points on a zoom is what would reprice the job`() {
        // Stated as a failure, the same way GridScaleTest states its matching
        // case: the risk this design exists to avoid is changing the scale
        // without moving the points that were measured against the old one.
        // 2000 ft -> 4000 ft halves the scale (4 units/ft -> 2 units/ft), so
        // an unmoved 80-unit line reads as DOUBLE its real length at the new
        // scale: 40 ft instead of the 20 ft it was actually drawn.
        val before = SurveyViewModel.unitsPerFoot(2000f)
        val after = SurveyViewModel.unitsPerFoot(SurveyViewModel.zoomGridExtent(2000f, 2f)) // 4000 ft
        val drawn = listOf(FencePoint(0f, 0f), FencePoint(20f * before, 0f))
        val unmoved = FenceGeometryEngine.analyze(drawn, after).totalLinearFeet
        assertEquals(40f, unmoved, 0.01f)
        assertTrue("this is the wrong answer, and the point of the test", unmoved != 20f)
    }

    // ---- satellite's own fixed scale is untouched by any of the above ----

    @Test
    fun `satellite stays pinned at 400 ft -- D1 only removes the ceiling on the grid background`() {
        assertEquals(400f, SurveyViewModel.SATELLITE_CANVAS_EXTENT_FT, 0.0001f)
        assertEquals(SurveyViewModel.PIXELS_PER_FOOT_GRID, SurveyViewModel.unitsPerFoot(SurveyViewModel.SATELLITE_CANVAS_EXTENT_FT), 0.0001f)
    }

    // ---- the rendering fix and its performance bound, read from source ----
    //
    // drawGrid is a private DrawScope extension in a Composable file -- there
    // is no way to execute it off a device (see the CLAUDE.md note on modules
    // that cannot be unit-tested). These read the source text instead, the
    // same technique PlanExtentTest already uses for CrewFencePlanScreen and
    // PdfExporter: not proof the file compiles, but a durable, specific guard
    // against the exact bug and the exact hazard this change addresses
    // reappearing unnoticed.

    private fun surveyDrawScreenSource(): String =
        listOf(
            File("src/main/java/com/fenceestimator/app/ui/survey/SurveyDrawScreen.kt"),
            File("app/src/main/java/com/fenceestimator/app/ui/survey/SurveyDrawScreen.kt")
        ).first { it.isFile }.readText()

    @Test
    fun `drawGrid spaces lines by this job's own scale, not the flat legacy constant`() {
        val src = surveyDrawScreenSource()
        val body = src.substringAfter("private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawGrid(")
            .substringBefore("private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawGridLabel(")
        assertTrue(
            "drawGrid must take the job's own scale as a parameter",
            body.contains("pxPerFt: Float")
        )
        assertTrue(
            "spacing must be computed from that scale (safePxPerFt), not SurveyViewModel.PIXELS_PER_FOOT_GRID directly",
            body.contains("coerceAtLeast(0.5f) * safePxPerFt")
        )
        assertTrue(
            "the planted failure this guards against: spacing computed from the flat constant regardless of extent",
            !body.contains("gridLineSpacingFt.coerceAtLeast(0.5f)) * SurveyViewModel.PIXELS_PER_FOOT_GRID")
        )
    }

    @Test
    fun `drawGrid bounds how many lines it can draw per axis, independent of extent or typed-in spacing`() {
        val src = surveyDrawScreenSource()
        assertTrue(
            "a named, fixed ceiling must exist -- see the doc on MAX_GRID_LINES_PER_AXIS for why",
            src.contains("private const val MAX_GRID_LINES_PER_AXIS")
        )
        val body = src.substringAfter("private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawGrid(")
            .substringBefore("private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawGridLabel(")
        assertTrue(
            "the requested spacing must be widened, never narrowed, when it would exceed the line budget",
            body.contains("minStepForBudget")
        )
    }

    @Test
    fun `the grid-size chips are still driven by GRID_SIZES_FT and the zoom control by zoomGridExtent`() {
        val src = surveyDrawScreenSource()
        assertTrue(src.contains("SurveyViewModel.GRID_SIZES_FT.forEach"))
        assertTrue(src.contains("SurveyViewModel.zoomGridExtent(job2.gridExtentFt, 2f)"))
        assertTrue(src.contains("SurveyViewModel.zoomGridExtent(job2.gridExtentFt, 0.5f)"))
    }
}
