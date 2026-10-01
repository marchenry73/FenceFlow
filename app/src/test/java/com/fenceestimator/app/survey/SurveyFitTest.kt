package com.fenceestimator.app.survey

import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.estimate.DrawingFit
import com.fenceestimator.app.estimate.DrawingScale
import com.fenceestimator.app.estimate.EstimateEngine
import com.fenceestimator.app.estimate.GridBackdropPlan
import com.fenceestimator.app.estimate.PhotoFit
import com.fenceestimator.app.estimate.ScaleBasis
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FenceGeometryEngine
import com.fenceestimator.app.geometry.FencePoint
import com.fenceestimator.app.geometry.GateGeometry
import com.fenceestimator.app.geometry.GateMarker
import com.fenceestimator.app.geometry.GateMounting
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Fitting a survey photo to the drawing -- the one change here that touches the
 * relationship between pixels and feet, and therefore what a job costs.
 *
 * What is held to a test, in the order it matters:
 *
 *  1. A fit never changes a measured foot. Not the footage the labour is billed
 *     on, not the teardown footage, not a gate's width, not a corner or post
 *     count -- checked against the REAL pricing engine ([EstimateEngine]), not
 *     a copy of its arithmetic.
 *  2. A fit never gives an uncalibrated photo a scale. Null stays null, and an
 *     uncalibrated photo still bills nothing before and after.
 *  3. A fit is never mistaken for a measurement: it clears the known length, so
 *     [DrawingScale.basisOf] reads "not measured" afterwards.
 *  4. Choosing the grid never invents a scale for lines already drawn on a
 *     photo, and never touches the photo.
 *
 * The screen and view model that call these cannot be run off a device (they
 * need Android and Compose), so the rules live in [DrawingScale] / [DrawingFit]
 * where they can -- and the source-reading tests at the bottom pin that the
 * view model goes through them instead of writing a scale of its own.
 */
class SurveyFitTest {

    private val photoStoragePath = "company-1/job-1/survey/survey_1_abc.jpg"

    private fun pts(vararg xy: Float): List<FencePoint> =
        xy.toList().chunked(2).map { (x, y) -> FencePoint(x, y) }

    private fun run(
        id: Long,
        points: List<FencePoint>,
        gates: List<GateMarker> = emptyList(),
        closed: Boolean = false,
        teardown: Boolean = false
    ) = FenceRun(
        id = id,
        jobId = 1,
        fenceType = FenceType.VINYL,
        pointsEncoded = FenceCodec.encodePoints(points),
        gatesEncoded = FenceCodec.encodeGates(gates),
        closedLoop = closed,
        isTeardown = teardown
    )

    /** The three runs every footage test uses: an open side with a gate, a closed yard, and an old fence coming out. */
    private fun sampleRuns(): List<FenceRun> = listOf(
        run(
            1,
            pts(100f, 100f, 1300f, 100f, 1300f, 777f),
            gates = listOf(GateMarker(700f, 104f, 4f, GateMounting.LINE)),
        ),
        run(2, pts(200f, 900f, 1500f, 900f, 1500f, 1800f, 200f, 1800f), closed = true),
        run(3, pts(50f, 50f, 50f, 640f), teardown = true),
    )

    private fun markers() = listOf(
        DrawingFit.MarkerAt(10, 640f, 420f),
        DrawingFit.MarkerAt(11, 90f, 1750f),
    )

    private fun drawings(runs: List<FenceRun>) = runs.map {
        DrawingFit.RunDrawing(
            it.id,
            FenceCodec.decodePoints(it.pointsEncoded),
            FenceCodec.decodeGates(it.gatesEncoded),
            it.closedLoop
        )
    }

    private fun applied(runs: List<FenceRun>, plan: DrawingFit.FitPlan): List<FenceRun> = runs.map { r ->
        val moved = plan.runs.single { it.id == r.id }
        r.copy(
            pointsEncoded = FenceCodec.encodePoints(moved.points),
            gatesEncoded = FenceCodec.encodeGates(moved.gates)
        )
    }

    /** The fits worth trying: zoom in, zoom out, slide only, both, and both ends of the allowed range. */
    private val fits = listOf(
        PhotoFit(2.5f, 0f, 0f),
        PhotoFit(0.4f, 0f, 0f),
        PhotoFit(1f, 137f, -86f),
        PhotoFit(1.8f, -420f, 250f),
        PhotoFit(0.62f, 900f, 33f),
        PhotoFit(DrawingFit.MIN_SCALE, 10f, 10f),
        PhotoFit(DrawingFit.MAX_SCALE, -300f, 800f),
    )

    // ---- 1. a fit never changes a measured foot ---------------------------

    @Test
    fun `a fit leaves the footage the labour is billed on exactly where it was`() {
        val job = Job(surveyStoragePath = photoStoragePath, calibrationPixelsPerFoot = 12.5f, calibrationKnownFeet = 40f)
        val runs = sampleRuns()
        val before = EstimateEngine.linearFeet(job, runs)
        val teardownBefore = EstimateEngine.teardownLinearFeet(job, runs)
        // Positive control: there IS footage to move. A zero here would make every
        // comparison below true by accident.
        assertTrue("sample drawing must bill real footage", before > 400f)
        assertTrue("sample drawing must have a teardown run to carry", teardownBefore > 40f)

        fits.forEach { fit ->
            val plan = DrawingFit.plan(drawings(runs), markers(), job.calibrationPixelsPerFoot, fit)
            assertNotNull("a usable scale and an applicable fit must plan: $fit", plan)
            val after = DrawingFit.jobAfter(job, fit)
            val movedRuns = applied(runs, plan!!)
            assertEquals("built footage moved under $fit", before, EstimateEngine.linearFeet(after, movedRuns), before * 1e-4f)
            assertEquals("teardown footage moved under $fit", teardownBefore, EstimateEngine.teardownLinearFeet(after, movedRuns), teardownBefore * 1e-4f)
            // And the job's own calibration is what the plan says it is.
            assertEquals(plan.calibrationPixelsPerFoot, after.calibrationPixelsPerFoot!!, 1e-3f)
        }
    }

    @Test
    fun `a fit leaves every count the takeoff buys from exactly where it was`() {
        val job = Job(surveyStoragePath = photoStoragePath, calibrationPixelsPerFoot = 12.5f, calibrationKnownFeet = 40f)
        val runs = sampleRuns().filterNot { it.isTeardown }
        fits.forEach { fit ->
            val plan = DrawingFit.plan(drawings(runs), markers(), job.calibrationPixelsPerFoot, fit)!!
            val newCal = plan.calibrationPixelsPerFoot
            applied(runs, plan).zip(runs).forEach { (movedRun, oldRun) ->
                val was = EstimateEngine.suggestQuantities(oldRun, 12.5f)
                val now = EstimateEngine.suggestQuantities(movedRun, newCal)
                assertEquals("corners under $fit", was.geometry.cornerCount, now.geometry.cornerCount)
                assertEquals("ends under $fit", was.geometry.endCount, now.geometry.endCount)
                // Every quantity the takeoff buys -- posts, panels, concrete, hardware -- is a
                // whole number and must match exactly. The one line that is a LENGTH (the fence
                // length itself) carries float noise in the seventh digit and is compared with a
                // tolerance, which is the only reason this is not a plain list equality.
                assertEquals("entries under $fit", was.entries.map { it.role }, now.entries.map { it.role })
                was.entries.zip(now.entries).forEach { (a, b) ->
                    assertEquals("quantity of ${a.role} under $fit", a.quantity, b.quantity, 1e-3)
                }
                assertEquals("takeoff lines under $fit", was.takeoff.map { it.label }, now.takeoff.map { it.label })
                was.takeoff.zip(now.takeoff).forEach { (a, b) ->
                    assertEquals("${a.label} under $fit", a.quantity, b.quantity, 1e-3)
                }
            }
        }
    }

    @Test
    fun `a gate keeps its width in feet and its place on its side`() {
        val points = pts(100f, 100f, 1300f, 100f, 1300f, 777f)
        val gate = GateMarker(700f, 104f, 4f, GateMounting.LINE)
        val before = GateGeometry.spanFor(gate, points, false, 12.5f)!!
        fits.forEach { fit ->
            val p = DrawingFit.pointAfter(gate.x, gate.y, fit)
            val movedGate = gate.copy(x = p.x, y = p.y)
            val movedPoints = points.map { DrawingFit.pointAfter(it.x, it.y, fit) }
            val newCal = DrawingFit.calibrationAfter(12.5f, fit)!!
            val after = GateGeometry.spanFor(movedGate, movedPoints, false, newCal)!!
            fun feet(s: com.fenceestimator.app.geometry.GateSpan, ppf: Float) =
                kotlin.math.hypot((s.end.x - s.start.x).toDouble(), (s.end.y - s.start.y).toDouble()).toFloat() / ppf
            assertEquals("width under $fit", feet(before, 12.5f), feet(after, newCal), 1e-3f)
            assertEquals("segment under $fit", before.segmentIndex, after.segmentIndex)
        }
    }

    @Test
    fun `the footage guard inside plan has teeth -- a transform that forgets the scale is caught`() {
        // The failure the guard exists for: points moved, calibration NOT divided by the
        // same factor. Measured with the same engine plan() uses, the footage moves by
        // exactly the zoom factor -- far outside the tolerance -- so plan() would refuse.
        val runs = drawings(sampleRuns().filterNot { it.isTeardown })
        val fit = PhotoFit(2f, 0f, 0f)
        val movedPoints = runs.map { r -> r.points.map { DrawingFit.pointAfter(it.x, it.y, fit) } to r.closedLoop }
        val wrong = FenceGeometryEngine.totalLinearFeetAcrossRuns(movedPoints, 12.5f)
        val right = FenceGeometryEngine.totalLinearFeetAcrossRuns(runs.map { it.points to it.closedLoop }, 12.5f)
        assertEquals("forgetting the scale halves the footage under a 2x fit", right / 2f, wrong, right * 1e-4f)
        assertTrue(kotlin.math.abs(wrong - right) > maxOf(0.01f, right * 1e-5f))
        // And the real plan, which divides the calibration too, is inside the tolerance.
        val plan = DrawingFit.plan(runs, markers(), 12.5f, fit)!!
        assertEquals(plan.feetBefore, plan.feetAfter, maxOf(0.01f, plan.feetBefore * 1e-5f))
    }

    @Test
    fun `the one live photo job fits without moving its price basis`() {
        // Read-only from the live database, 2026-10-01: the only job with a survey photo
        // has grid_extent_ft 100, calibration_pixels_per_foot 80 (8000 / 100, the grid's
        // own scale), calibration_known_feet NULL, four runs with points. Nobody measured
        // that scale against the photo, and it prices today. Fitting it must neither move
        // its footage nor pretend the scale was ever measured.
        val live = Job(
            surveyStoragePath = photoStoragePath,
            gridExtentFt = 100f,
            calibrationPixelsPerFoot = 80f,
            calibrationKnownFeet = null
        )
        assertEquals(ScaleBasis.UNMEASURED, DrawingScale.basisOf(live))
        val runs = listOf(run(1, pts(400f, 400f, 4400f, 400f, 4400f, 2800f)))
        val before = EstimateEngine.linearFeet(live, runs)
        assertEquals(80f, before, 0.1f) // 4000 + 2400 units at 80 per foot
        val fit = PhotoFit(0.37f, 312f, 40f)
        val plan = DrawingFit.plan(drawings(runs), emptyList(), live.calibrationPixelsPerFoot, fit)!!
        val after = DrawingFit.jobAfter(live, fit)
        assertEquals(before, EstimateEngine.linearFeet(after, applied(runs, plan)), 0.01f)
        assertEquals("still not measured afterwards", ScaleBasis.UNMEASURED, DrawingScale.basisOf(after))
    }

    @Test
    fun `a fit anywhere in the allowed range is never refused and never moves the footage`() {
        // The footage guard inside plan() must hold on every legitimate fit -- a refusal here
        // would be a fit the owner lined up by eye and the app threw away -- and the fit must
        // not move the footage beyond the float noise the engine itself has. Fixed seed, wide
        // ranges: coordinates to 8000, calibrations 1 to 400 px/ft, scale 0.1x to 10x,
        // translations of +/-10000, one to four runs of two to forty points, open and closed.
        val rnd = java.util.Random(20261001L)
        repeat(3000) { i ->
            val runs = (0 until 1 + rnd.nextInt(4)).map { id ->
                val n = 2 + rnd.nextInt(39)
                DrawingFit.RunDrawing(
                    id.toLong(),
                    (0 until n).map { FencePoint(rnd.nextFloat() * 8000f, rnd.nextFloat() * 8000f) },
                    emptyList(),
                    rnd.nextBoolean()
                )
            }
            val calibration = 1f + rnd.nextFloat() * 399f
            val scale = Math.exp(Math.log(0.1) + rnd.nextDouble() * Math.log(100.0)).toFloat()
                .coerceIn(DrawingFit.MIN_SCALE, DrawingFit.MAX_SCALE)
            val fit = PhotoFit(scale, (rnd.nextFloat() - 0.5f) * 20000f, (rnd.nextFloat() - 0.5f) * 20000f)
            val plan = DrawingFit.plan(runs, emptyList(), calibration, fit)
            assertNotNull("fit #$i was refused: $fit at $calibration px/ft", plan)
            assertEquals("footage moved on fit #$i", plan!!.feetBefore, plan.feetAfter, plan.feetBefore * 2e-5f + 0.01f)
        }
    }

    // ---- 2. a fit never gives an uncalibrated photo a scale ---------------

    @Test
    fun `a fit never writes a scale where there was none`() {
        val uncalibrated = listOf(
            Job(surveyStoragePath = photoStoragePath),
            Job(surveyImagePath = "/data/user/0/app/files/surveys/survey_1.jpg"),
            Job(surveyStoragePath = photoStoragePath, calibrationPixelsPerFoot = 0f),
            Job(surveyStoragePath = photoStoragePath, calibrationPixelsPerFoot = -4f),
            Job(surveyStoragePath = photoStoragePath, calibrationPixelsPerFoot = Float.NaN),
            Job(surveyStoragePath = photoStoragePath, calibrationPixelsPerFoot = Float.POSITIVE_INFINITY),
        )
        val runs = sampleRuns()
        uncalibrated.forEach { job ->
            fits.forEach { fit ->
                assertNull("no plan without a usable scale: $job", DrawingFit.plan(drawings(runs), markers(), job.calibrationPixelsPerFoot, fit))
                assertEquals("the job comes back unchanged: $job", job, DrawingFit.jobAfter(job, fit))
            }
        }
        // Null in, null out.
        assertNull(DrawingFit.calibrationAfter(null, PhotoFit(2f, 0f, 0f)))
        // And the engine still refuses the job it refused before, with the very same runs.
        val noScale = Job(surveyStoragePath = photoStoragePath)
        assertEquals(0f, EstimateEngine.linearFeet(noScale, runs), 0f)
        assertEquals(0f, EstimateEngine.linearFeet(DrawingFit.jobAfter(noScale, PhotoFit(2f, 5f, 5f)), runs), 0f)
    }

    @Test
    fun `a fit that cannot be carried out is refused rather than approximated`() {
        val runs = drawings(sampleRuns())
        listOf(
            PhotoFit(0f, 0f, 0f), PhotoFit(-1f, 0f, 0f), PhotoFit(Float.NaN, 0f, 0f),
            PhotoFit(1f, Float.NaN, 0f), PhotoFit(1f, 0f, Float.POSITIVE_INFINITY),
            PhotoFit(DrawingFit.MIN_SCALE / 2f, 0f, 0f), PhotoFit(DrawingFit.MAX_SCALE * 2f, 0f, 0f),
        ).forEach { fit ->
            assertFalse("not applicable: $fit", DrawingFit.isApplicable(fit))
            assertNull("no plan for $fit", DrawingFit.plan(runs, markers(), 12.5f, fit))
        }
        // clamp() always lands somewhere applicable.
        listOf(PhotoFit(0f, 1f, 1f), PhotoFit(99f, 1f, 1f), PhotoFit(Float.NaN, 1f, 1f)).forEach {
            assertTrue(DrawingFit.isApplicable(DrawingFit.clamp(it)))
        }
    }

    // ---- 3. a fit is never mistaken for a measurement ---------------------

    @Test
    fun `a fit clears the known length because the scale was carried, not measured`() {
        val measured = Job(surveyStoragePath = photoStoragePath, calibrationPixelsPerFoot = 12.5f, calibrationKnownFeet = 40f)
        assertEquals(ScaleBasis.MEASURED, DrawingScale.basisOf(measured))
        val fitted = DrawingFit.jobAfter(measured, PhotoFit(2f, 10f, 10f))
        assertNull("known length must go: the photo was not measured at this scale", fitted.calibrationKnownFeet)
        assertEquals(6.25f, fitted.calibrationPixelsPerFoot!!, 1e-4f)
        assertEquals(ScaleBasis.UNMEASURED, DrawingScale.basisOf(fitted))
    }

    @Test
    fun `the scale basis tells measured, fitted-by-eye, none and grid apart`() {
        assertEquals(ScaleBasis.GRID, DrawingScale.basisOf(Job()))
        assertEquals(ScaleBasis.GRID, DrawingScale.basisOf(Job(gridExtentFt = 25f, calibrationPixelsPerFoot = 320f)))
        assertEquals(ScaleBasis.NONE, DrawingScale.basisOf(Job(surveyStoragePath = photoStoragePath)))
        assertEquals(ScaleBasis.NONE, DrawingScale.basisOf(Job(surveyImagePath = "/x.jpg", calibrationPixelsPerFoot = 0f)))
        assertEquals(ScaleBasis.UNMEASURED, DrawingScale.basisOf(Job(surveyImagePath = "/x.jpg", calibrationPixelsPerFoot = 80f)))
        assertEquals(ScaleBasis.UNMEASURED, DrawingScale.basisOf(Job(surveyImagePath = "/x.jpg", calibrationPixelsPerFoot = 80f, calibrationKnownFeet = 0f)))
        assertEquals(ScaleBasis.MEASURED, DrawingScale.basisOf(Job(surveyImagePath = "/x.jpg", calibrationPixelsPerFoot = 12.5f, calibrationKnownFeet = 40f)))
        // A photo that has synced but not downloaded to this phone is still a photo job.
        assertEquals(ScaleBasis.MEASURED, DrawingScale.basisOf(Job(surveyStoragePath = photoStoragePath, calibrationPixelsPerFoot = 12.5f, calibrationKnownFeet = 40f)))
    }

    @Test
    fun `a survey counts as saved when it is in storage or its file is really here, not for a dangling path`() {
        val here = setOf("/data/user/0/app/files/surveys/survey_1_a.jpg")
        val exists = { p: String -> p in here }
        // Saved in cloud storage, whether or not this phone has the file.
        assertTrue(DrawingScale.hasSavedSurvey(Job(surveyStoragePath = photoStoragePath), exists))
        // Saved as a file on this phone.
        assertTrue(DrawingScale.hasSavedSurvey(Job(surveyImagePath = here.first()), exists))
        // A local path to a file that is gone, with nothing in storage: nothing is saved, so the job
        // must not be locked out of ever taking a photo again...
        assertFalse(DrawingScale.hasSavedSurvey(Job(surveyImagePath = "/data/user/0/app/files/surveys/gone.jpg"), exists))
        // ...though it is still a photo job as far as SCALE goes: pricing never relaxes.
        assertTrue(DrawingScale.isPhotoJob(Job(surveyImagePath = "/data/user/0/app/files/surveys/gone.jpg")))
        // No survey at all.
        assertFalse(DrawingScale.hasSavedSurvey(Job(), exists))
        // A dangling local path does not hide a real storage path.
        assertTrue(DrawingScale.hasSavedSurvey(Job(surveyImagePath = "/gone.jpg", surveyStoragePath = photoStoragePath), exists))
    }

    @Test
    fun `reading the basis does not change what anything is priced at`() {
        // Display only: the engine still prices off the calibration alone.
        val unmeasured = Job(surveyStoragePath = photoStoragePath, calibrationPixelsPerFoot = 80f)
        val measured = unmeasured.copy(calibrationKnownFeet = 40f)
        val runs = sampleRuns()
        assertEquals(EstimateEngine.linearFeet(measured, runs), EstimateEngine.linearFeet(unmeasured, runs), 0f)
        assertTrue(EstimateEngine.linearFeet(unmeasured, runs) > 0f)
    }

    // ---- 4. choosing the grid never invents a scale, and never touches the photo

    @Test
    fun `choosing the grid keeps any scale the job already has`() {
        val keeps = listOf(
            Job(), // a grid job already has the grid's own scale
            Job(surveyStoragePath = photoStoragePath, calibrationPixelsPerFoot = 12.5f, calibrationKnownFeet = 40f),
            Job(surveyStoragePath = photoStoragePath, calibrationPixelsPerFoot = 80f), // unmeasured, e.g. the live job
        )
        keeps.forEach { job ->
            listOf(false, true).forEach { drawn ->
                assertEquals(GridBackdropPlan.Allowed(seed = null), DrawingScale.gridBackdropPlan(job, drawn))
            }
        }
    }

    @Test
    fun `choosing the grid on an empty uncalibrated photo seeds the grid's own scale, once`() {
        val plan = DrawingScale.gridBackdropPlan(Job(surveyStoragePath = photoStoragePath, gridExtentFt = 100f), anythingDrawn = false)
        assertEquals(GridBackdropPlan.Allowed(seed = 80f), plan)
        // The default grid comes out where it always did.
        assertEquals(
            GridBackdropPlan.Allowed(seed = 20f),
            DrawingScale.gridBackdropPlan(Job(surveyImagePath = "/x.jpg"), anythingDrawn = false)
        )
    }

    @Test
    fun `choosing the grid is refused for lines already drawn on an uncalibrated photo`() {
        // Those points are in the photo's own pixels. The grid's scale would price a made-up length.
        val plan = DrawingScale.gridBackdropPlan(Job(surveyStoragePath = photoStoragePath, gridExtentFt = 100f), anythingDrawn = true)
        assertEquals(GridBackdropPlan.NeedsScale, plan)
        assertEquals(GridBackdropPlan.NeedsScale, DrawingScale.gridBackdropPlan(Job(surveyImagePath = "/x.jpg", calibrationPixelsPerFoot = 0f), anythingDrawn = true))
    }

    // ---- the gestures --------------------------------------------------------

    @Test
    fun `zooming about a point keeps the photo under that point where it was`() {
        val start = PhotoFit(1.3f, 40f, -25f)
        listOf(2f, 0.5f, 1.07f).forEach { factor ->
            val cx = 640f
            val cy = 410f
            // The photo pixel under (cx, cy) before...
            val q = ((cx - start.dx) / start.scale) to ((cy - start.dy) / start.scale)
            val next = start.zoomedAbout(factor, cx, cy)
            assertEquals(start.scale * factor, next.scale, 1e-4f)
            // ...is under it after.
            assertEquals(cx, next.scale * q.first + next.dx, 1e-2f)
            assertEquals(cy, next.scale * q.second + next.dy, 1e-2f)
        }
        // A nonsense factor leaves the fit alone.
        assertEquals(start, start.zoomedAbout(Float.NaN, 1f, 1f))
        assertEquals(start, start.zoomedAbout(0f, 1f, 1f))
        assertEquals(start, start.zoomedAbout(-2f, 1f, 1f))
    }

    @Test
    fun `an untouched or negligible draft is the identity, so Apply stays off`() {
        assertTrue(PhotoFit.IDENTITY.isIdentity)
        assertTrue(PhotoFit(1.00001f, 0.2f, -0.2f).isIdentity)
        assertFalse(PhotoFit(1.01f, 0f, 0f).isIdentity)
        assertFalse(PhotoFit(1f, 3f, 0f).isIdentity)
        assertFalse(PhotoFit(1f, 0f, 3f).isIdentity)
        // Moving and moving back is the identity again.
        assertTrue(PhotoFit.IDENTITY.movedBy(40f, -12f).movedBy(-40f, 12f).isIdentity)
    }

    @Test
    fun `a fit round-trips -- fitting and fitting back lands where it started`() {
        val runs = drawings(sampleRuns())
        val fit = PhotoFit(1.9f, -210f, 66f)
        val plan = DrawingFit.plan(runs, markers(), 12.5f, fit)!!
        // The inverse of "photo at scale s, offset d" is "photo at 1/s, offset -d/s".
        val back = PhotoFit(1f / fit.scale, -fit.dx / fit.scale, -fit.dy / fit.scale)
        val again = DrawingFit.plan(plan.runs, plan.markers, plan.calibrationPixelsPerFoot, back)!!
        assertEquals(12.5f, again.calibrationPixelsPerFoot, 1e-3f)
        runs.zip(again.runs).forEach { (a, b) ->
            a.points.zip(b.points).forEach { (p, q) ->
                assertEquals(p.x, q.x, 0.05f)
                assertEquals(p.y, q.y, 0.05f)
            }
        }
    }

    @Test
    fun `the reference grid steps in round numbers and never below the minimum asked for`() {
        assertEquals(1f, DrawingFit.niceGridStepFt(0.2f), 0f)
        assertEquals(1f, DrawingFit.niceGridStepFt(Float.NaN), 0f)
        assertEquals(2f, DrawingFit.niceGridStepFt(1.1f), 0f)
        assertEquals(5f, DrawingFit.niceGridStepFt(3.4f), 0f)
        assertEquals(10f, DrawingFit.niceGridStepFt(7f), 0f)
        assertEquals(20f, DrawingFit.niceGridStepFt(11f), 0f)
        assertEquals(50f, DrawingFit.niceGridStepFt(26f), 0f)
        assertEquals(100f, DrawingFit.niceGridStepFt(100f), 0f)
        assertEquals(200f, DrawingFit.niceGridStepFt(101f), 0f)
        listOf(0.5f, 1f, 1.5f, 4f, 9.9f, 10f, 33f, 480f, 12345f).forEach {
            assertTrue("step for $it", DrawingFit.niceGridStepFt(it) >= it || it <= 1f)
        }
    }
}
