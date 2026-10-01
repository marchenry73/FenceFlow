package com.fenceestimator.app.survey

import com.fenceestimator.app.geometry.FenceGeometryEngine
import com.fenceestimator.app.geometry.FencePoint
import com.fenceestimator.app.ui.survey.SurveyViewModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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

    // ---- THE SPLIT: office pricing's flat fallback vs. this job's own grid
    // extent, and why a null calibration must never coexist with a non-
    // default extent -- D1's unbounded sizes only made the possible error on
    // that state bigger, they did not create it. ----
    //
    // EstimateEngine.footageOf (labour) and the real server (pricing/totals.ts)
    // both fall back to the FLAT DrawingScale.PIXELS_PER_FOOT_GRID (20) for an
    // uncalibrated GRID run -- deliberately, so the two engines agree
    // (UncalibratedLabourTest, tests/a17-photo-uncalibrated-pricing.test.mjs
    // section 3's canary). This job's own drawing scale (DrawingScale.of,
    // read by SurveyViewModel/SurveyDrawScreen) falls back to this EXTENT's
    // own scale instead (unitsPerFoot(gridExtentFt)). The two fallbacks are
    // identical only at the 400ft default; SurveyViewModel must therefore
    // never leave a job with calibrationPixelsPerFoot null at any other
    // extent, or pricing and the drawing disagree about the same geometry.

    private fun surveyViewModelSource(): String =
        listOf(
            File("src/main/java/com/fenceestimator/app/ui/survey/SurveyViewModel.kt"),
            File("app/src/main/java/com/fenceestimator/app/ui/survey/SurveyViewModel.kt")
        ).first { it.isFile }.readText()

    @Test
    fun `the possible error on a null-calibration job was fivefold, D1 raises it to twenty-fivefold and beyond`() {
        // The flat fallback both pricing engines use.
        val officeFlatPxPerFt = SurveyViewModel.PIXELS_PER_FOOT_GRID
        // The old top of GRID_SIZES_FT, before 5000/10000 were added for D1
        // (see the class doc on GRID_SIZES_FT): the paddock/acreage sizes
        // 1000 and 2000 already existed, so 2000ft was already the worst case
        // on the "too big" side.
        val oldWorstExtent = 2000f
        val oldWorstDrawingPxPerFt = SurveyViewModel.unitsPerFoot(oldWorstExtent)
        assertEquals(
            "2000ft used to be the extent furthest from the office's flat 20 px/ft",
            5f,
            officeFlatPxPerFt / oldWorstDrawingPxPerFt,
            0.01f
        )

        // D1's new top of the list, and the floor at the other end -- both
        // unchanged by D1 on the small-extent side (MIN_GRID_EXTENT_FT was
        // already 25ft), but now reachable without limit past 10000ft since
        // zoomGridExtent has no ceiling of its own.
        val newWorstExtent = SurveyViewModel.GRID_SIZES_FT.last() // 10000f
        val newWorstDrawingPxPerFt = SurveyViewModel.unitsPerFoot(newWorstExtent)
        assertEquals(
            "10000ft is where D1's own 'twenty-fivefold' figure comes from",
            25f,
            officeFlatPxPerFt / newWorstDrawingPxPerFt,
            0.01f
        )

        val floorExtent = SurveyViewModel.MIN_GRID_EXTENT_FT // 25ft
        val floorDrawingPxPerFt = SurveyViewModel.unitsPerFoot(floorExtent)
        assertEquals(
            "the small-extent side is worth naming too: the floor was never raised by D1, " +
                "and is already a sixteenfold gap on its own",
            16f,
            floorDrawingPxPerFt / officeFlatPxPerFt,
            0.01f
        )

        // "and beyond": zoomGridExtent has no ceiling, so a job zoomed out
        // past the largest quick pick makes the gap worse without limit.
        val pastTheList = SurveyViewModel.zoomGridExtent(newWorstExtent, 2f) // 20000ft
        val pastTheListRatio = officeFlatPxPerFt / SurveyViewModel.unitsPerFoot(pastTheList)
        assertTrue(
            "one more zoom-out past the biggest quick pick must already exceed the twenty-fivefold figure",
            pastTheListRatio > 25f
        )
    }

    @Test
    fun `the live drift this guards against -- grid 25, calibration 20 -- is not the null case, but proves the two fields can disagree`() {
        // A real row, queried read-only from the live database (2026-09-29,
        // project newcrgafcptspmapacrx, positive control 19 non-deleted
        // jobs): grid_extent_ft = 25, calibration_pixels_per_foot = 20,
        // survey_storage_path = null (a grid job, nothing drawn on it).
        // A FRESH calibration for a 25ft grid is 320, not 20 -- proof the two
        // columns can drift apart in the live data, not just in theory.
        val liveGridExtentFt = 25f
        val liveStoredCalibration = 20f
        val freshCalibrationForThatExtent = SurveyViewModel.unitsPerFoot(liveGridExtentFt)
        assertEquals(320f, freshCalibrationForThatExtent, 0.01f)
        assertTrue(
            "the row's stored calibration does not match what a fresh one would be -- the drift is real",
            kotlin.math.abs(freshCalibrationForThatExtent - liveStoredCalibration) > 0.01f
        )
        // It is NOT, however, a violation of the null-calibration invariant:
        // the stored value is a real, non-null number, so DrawingScale.of --
        // the actual function both the drawing screen and (via
        // job.calibrationPixelsPerFoot) office pricing read -- returns that
        // SAME stored 20 for this row, not the fresh 320. Pricing and the
        // drawing agree with EACH OTHER on this job; they just do not agree
        // with what a brand new 25ft grid would calibrate to. That is
        // exactly why option (b) -- never let calibration go null at a
        // non-default extent, rather than teaching the server to recompute
        // it from gridExtentFt -- is the safe one: recomputing from
        // gridExtentFt on a row shaped like this one would silently swap in
        // a DIFFERENT number (320) for the one already on record (20),
        // moving a price on a live row the moment anything got drawn on it.
        val actualScale = SurveyViewModel.drawingScale(
            calibrationPixelsPerFoot = liveStoredCalibration,
            surveyImagePath = null,
            gridExtentFt = liveGridExtentFt
        )
        assertTrue("DrawingScale.of must answer for a job with a real stored calibration", actualScale != null)
        assertEquals(
            "DrawingScale.of must take the stored value as-is here, not recompute it from gridExtentFt -- " +
                "that recomputation is exactly what option (a) would have to do, and exactly what would move this row's price",
            liveStoredCalibration,
            actualScale!!,
            0.01f
        )
    }

    /**
     * The body of the function whose signature starts with [signature], by brace
     * balance -- so a check about ONE function cannot be satisfied (or tripped)
     * by the text of the function written after it. The two tests below used to
     * cut from the signature to the companion object, which swept in everything
     * declared in between.
     */
    private fun bodyOf(src: String, signature: String): String {
        val at = src.indexOf(signature)
        assertTrue("could not find $signature -- it was renamed or removed; move this test with it", at >= 0)
        val open = src.indexOf('{', at)
        var depth = 0
        for (i in open until src.length) {
            if (src[i] == '{') depth++
            else if (src[i] == '}') {
                depth--
                if (depth == 0) return src.substring(open, i + 1)
            }
        }
        throw AssertionError("braces never balanced for $signature -- the file may be mid-edit")
    }

    /**
     * "Use Grid" used to seed the grid's scale only when no storage path existed and
     * wrote a NULL calibration otherwise, and it dropped the photo's local path while
     * the travelling one stayed -- so the next sync downloaded the photo straight
     * back. It no longer removes anything: it hides the photo, and the one write it
     * may make (a scale) is decided by DrawingScale.gridBackdropPlan, which is held
     * to behaviour tests in SurveyFitTest rather than to this text.
     *
     * What is pinned here is that clearSurveyImage still goes through that plan and
     * does not write a scale of its own -- the number it seeds is whatever the plan
     * says, which is the grid's own scale for this job's own extent.
     */
    @Test
    fun `clearSurveyImage takes any scale it writes from the grid backdrop plan, not a number of its own`() {
        val body = bodyOf(surveyViewModelSource(), "fun clearSurveyImage() {")
        assertTrue(
            "clearSurveyImage must ask DrawingScale.gridBackdropPlan what, if anything, to write",
            body.contains("DrawingScale.gridBackdropPlan(")
        )
        assertTrue(
            "the seed must be the plan's own (the grid's scale for this job's own extent)",
            body.contains("plan.seed")
        )
        assertFalse(
            "a number typed here instead of the plan's would be a second grid scale that can drift " +
                "(the live grid-25 / calibration-20 drift came from exactly that)",
            body.contains("unitsPerFoot(") || body.contains("PIXELS_PER_FOOT_GRID")
        )
        assertTrue(
            "a seeded scale carries no known length -- it was not measured",
            body.contains("calibrationKnownFeet = null")
        )
        // The same, in behaviour: the plan's seed IS unitsPerFoot of the job's own extent.
        val plan = com.fenceestimator.app.estimate.DrawingScale.gridBackdropPlan(
            com.fenceestimator.app.data.Job(surveyStoragePath = "co/job/survey/x.jpg", gridExtentFt = 100f),
            anythingDrawn = false
        )
        assertEquals(
            com.fenceestimator.app.estimate.GridBackdropPlan.Allowed(seed = SurveyViewModel.unitsPerFoot(100f)),
            plan
        )
    }

    @Test
    fun `clearSurveyImage planted failure -- an unconditional null calibration must be caught`() {
        // The exact pre-fix line: calibration written null no matter what,
        // with no seed and no photo-elsewhere guard. If clearSurveyImage
        // regresses to this, the null-calibration invariant this file exists
        // to protect breaks again, silently, the next time a job's grid
        // extent is not the 400ft default.
        val plantedOld = "calibrationPixelsPerFoot = null, calibrationKnownFeet = null"
        val body = bodyOf(surveyViewModelSource(), "fun clearSurveyImage() {")
        assertFalse(
            "the check above must go red if clearSurveyImage regresses to the old unconditional-null write",
            body.contains(plantedOld)
        )
        // Teeth: confirm the assertion really can fail, against a hand-built
        // copy of the old body.
        val oldBody = """
            fun clearSurveyImage() {
                if (viewerIsGuestDemo()) return
                val current = job.value ?: return
                viewModelScope.launch {
                    repository.updateJob(current.copy(surveyImagePath = null, $plantedOld))
                    clearDrawingHistory()
                }
            }
        """.trimIndent()
        assertTrue(
            "the planted-failure body must actually contain the pattern being checked for, " +
                "or this test proves nothing",
            oldBody.contains(plantedOld)
        )
    }

    @Test
    fun `resetGridCalibration goes through setGridExtent, not a hardcoded flat constant`() {
        val body = surveyViewModelSource()
            .substringAfter("fun resetGridCalibration() {")
            .substringBefore("fun setGridLineSpacingFt(feet: Float) {")
        assertTrue(
            "resetGridCalibration must hand this job's own extent back to setGridExtent -- the same rescale-" +
                "and-recalibrate path every other grid-scale change uses",
            body.contains("setGridExtent(current.gridExtentFt)")
        )
        assertFalse(
            "the planted failure this guards against: writing the flat PIXELS_PER_FOOT_GRID constant directly, " +
                "independent of gridExtentFt -- the exact shape of the live grid-25/calibration-20 drift",
            body.contains("calibrationPixelsPerFoot = PIXELS_PER_FOOT_GRID")
        )
    }
}
