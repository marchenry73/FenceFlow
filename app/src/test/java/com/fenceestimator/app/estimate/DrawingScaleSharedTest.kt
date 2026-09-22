package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FencePoint
import com.fenceestimator.app.ui.survey.SurveyViewModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The drawing's scale, worked out in one place ([DrawingScale]) for the
 * drawing screen, the crew plan and the Suggest button alike.
 *
 * The bug it closes: Suggest seeded a flat 20 units per foot onto any grid
 * job without a calibration, whatever the grid's size. On a 100 ft grid the
 * drawing is at 80 units per foot, so the seed quartered the scale and every
 * side then measured four times its length -- on the plan and in the takeoff.
 *
 * And the rule it deliberately does NOT change yet: the job's own footage
 * (EstimateEngine.linearFeet) still counts an uncalibrated drawn run as
 * nothing, because price-job does exactly that (pricing/totals.ts footageOf)
 * and the phone and the office must price a job one way.
 */
class DrawingScaleSharedTest {

    private val photo = "/data/user/0/app/files/surveys/survey_1.jpg"

    @Test
    fun `Suggest seeds the grid's own scale, not a flat 20`() {
        val hundredFootGrid = Job(gridExtentFt = 100f)
        assertEquals(80f, DrawingScale.calibrationToSeed(hundredFootGrid)!!, 0.0001f)
        // The default grid comes out where it always did.
        assertEquals(20f, DrawingScale.calibrationToSeed(Job())!!, 0.0001f)

        // A 50 ft side as drawn on the 100 ft grid: 4000 units.
        val side = FenceRun(
            jobId = 1, fenceType = FenceType.VINYL,
            pointsEncoded = FenceCodec.encodePoints(listOf(FencePoint(0f, 0f), FencePoint(4000f, 0f)))
        )
        val seeded = hundredFootGrid.copy(calibrationPixelsPerFoot = DrawingScale.calibrationToSeed(hundredFootGrid))
        assertEquals(50f, EstimateEngine.linearFeet(seeded, listOf(side)), 0.01f)

        // Planted failure: the old flat 20 read the same side as 200 ft.
        val oldSeed = hundredFootGrid.copy(calibrationPixelsPerFoot = SurveyViewModel.PIXELS_PER_FOOT_GRID)
        assertEquals(200f, EstimateEngine.linearFeet(oldSeed, listOf(side)), 0.01f)
    }

    @Test
    fun `nothing is seeded over a real calibration or onto an uncalibrated photo`() {
        assertNull(DrawingScale.calibrationToSeed(Job(calibrationPixelsPerFoot = 37.5f)))
        assertNull("a photo has no size the app can know", DrawingScale.calibrationToSeed(Job(surveyImagePath = photo)))
        // A stored scale that is not a positive number is no scale at all.
        assertEquals(20f, DrawingScale.calibrationToSeed(Job(calibrationPixelsPerFoot = 0f))!!, 0.0001f)
    }

    @Test
    fun `a photo job whose photo has not downloaded yet is still a photo job`() {
        // A second phone: the job, and its storage path, have synced; the
        // image file has not (the download runs at the end of a pass, and not
        // at all offline).
        val notDownloaded = Job(surveyStoragePath = "co-1/job-1/survey.jpg", gridExtentFt = 100f)
        assertNull("nothing honest to seed -- ask for a calibration", DrawingScale.calibrationToSeed(notDownloaded))
        assertNull(DrawingScale.of(notDownloaded))
        // A calibration still wins wherever the photo is.
        assertEquals(12f, DrawingScale.of(notDownloaded.copy(calibrationPixelsPerFoot = 12f))!!, 0.0001f)
        // Planted failure: judged on the local file alone -- the old rule --
        // this reads as a 100 ft grid, and Suggest stored 80 units per foot as
        // the photo's calibration, pushed it, and every device and price-job
        // measured the photo at it.
        val localFileOnly = if (notDownloaded.surveyImagePath == null) DrawingScale.unitsPerFoot(notDownloaded.gridExtentFt) else null
        assertEquals(80f, localFileOnly!!, 0.0001f)
    }

    @Test
    fun `the drawing screen reads the same rule`() {
        val jobs = listOf(
            Job(), Job(gridExtentFt = 25f), Job(calibrationPixelsPerFoot = 37.5f),
            Job(surveyImagePath = photo), Job(surveyImagePath = photo, calibrationPixelsPerFoot = 12f),
            Job(calibrationPixelsPerFoot = Float.NaN)
        )
        jobs.forEach { job ->
            assertEquals(DrawingScale.of(job), SurveyViewModel.drawingScale(job))
        }
        assertEquals(80f, DrawingScale.of(Job(gridExtentFt = 100f))!!, 0.0001f)
        assertNull(DrawingScale.of(Job(surveyImagePath = photo)))
    }

    /**
     * Pinned to price-job, on purpose. Counting this run at the grid's scale
     * here and not in pricing/totals.ts would have the phone and the office
     * quote the same job two ways -- the failure the parity gate exists for.
     * Both move together, or neither.
     */
    @Test
    fun `an uncalibrated drawn run still bills no footage, as price-job does`() {
        val side = FenceRun(
            jobId = 1, fenceType = FenceType.VINYL,
            pointsEncoded = FenceCodec.encodePoints(listOf(FencePoint(0f, 0f), FencePoint(2000f, 0f)))
        )
        val uncalibratedGrid = Job()
        assertEquals(0f, EstimateEngine.linearFeet(uncalibratedGrid, listOf(side)), 0f)
        // ...while the drawing screen shows it at 100 ft. Seeding the scale
        // (what Suggest now does) is what makes the two agree.
        assertNotEquals(0f, DrawingScale.of(uncalibratedGrid)!!, 0f)
        val seeded = uncalibratedGrid.copy(calibrationPixelsPerFoot = DrawingScale.calibrationToSeed(uncalibratedGrid))
        assertEquals(100f, EstimateEngine.linearFeet(seeded, listOf(side)), 0.01f)
    }
}
