package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FencePoint
import com.fenceestimator.app.ui.survey.SurveyViewModel
import org.junit.Assert.assertEquals
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
 * Was also true, until this fix, that the job's own footage
 * (EstimateEngine.linearFeet) counted EVERY uncalibrated drawn run as
 * nothing, grid or photo alike, to keep the phone and price-job pricing a
 * job one way. That was too wide a brush: a grid square is a known size, so
 * an uncalibrated GRID run has a real scale to bill labour at (the same one
 * suggestQuantities() already billed materials at), and treating it as
 * nothing just reproduced the materials-vs-labour split this whole helper
 * exists to prevent. linearFeet now bills the grid case and still refuses
 * only the PHOTO case, where there genuinely is no honest scale
 * ([DrawingScale.isPhotoJob]). The server (pricing/totals.ts footageOf)
 * cannot make that same photo/grid distinction -- its input contract carries
 * no survey-photo field -- so it still guesses the grid scale for every
 * uncalibrated job; see the comment on footageOf in totals.ts.
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
     * Pinned to price-job, on purpose. Counting a GRID run at the grid's flat
     * scale here and not in pricing/totals.ts footageOf would have the phone
     * and the office quote the same job two ways -- the failure the parity
     * gate exists for. Both move together, or neither.
     *
     * Was: "an uncalibrated drawn run still bills no footage, as price-job
     * does", asserting 0f and reading that as the two sides agreeing. That
     * agreement was accidental -- BOTH sides zeroed an uncalibrated GRID run
     * out, which was simply wrong (fixtures/pricing/drawn-uncalibrated.json:
     * full materials, zero labour, for the very same run). A grid square is
     * a known size, so there was always a real number to bill; both engines
     * now use it, and still agree.
     */
    @Test
    fun `an uncalibrated GRID run bills its flat grid footage, matching price-job`() {
        val side = FenceRun(
            jobId = 1, fenceType = FenceType.VINYL,
            pointsEncoded = FenceCodec.encodePoints(listOf(FencePoint(0f, 0f), FencePoint(2000f, 0f)))
        )
        val uncalibratedGrid = Job()
        // 2000px at the grid's flat 20px/ft fallback is 100 ft -- the same
        // fallback pricing/totals.ts footageOf applies server-side.
        assertEquals(100f, EstimateEngine.linearFeet(uncalibratedGrid, listOf(side)), 0f)
        // The drawing screen's own scale agrees for this (default) grid.
        // DrawingScale.of is extent-aware, unlike linearFeet's flat
        // fallback, so the two would read differently on a non-default grid
        // -- a separate, pre-existing gap this fix does not touch (see the
        // "Deliberately NOT DrawingScale.of" note on EstimateEngine.footageOf).
        assertEquals(20f, DrawingScale.of(uncalibratedGrid)!!, 0f)
    }

    /**
     * The photo half of the old decision was right, and stays: a survey
     * photo has no scale at all until somebody calibrates it, so linearFeet
     * still refuses rather than guessing -- the same "no answer"
     * [DrawingScale.of] gives the drawing screen for the identical job.
     *
     * price-job (pricing/totals.ts) can NOT be pinned against this one the
     * way the grid case above is: its JobRow input carries no survey-photo
     * field at all, so the server has no way to tell this job apart from an
     * uncalibrated grid job, and still guesses the grid scale for it. That
     * gap is real and open -- not proven closed by this test, which only
     * covers the phone.
     */
    @Test
    fun `an uncalibrated PHOTO run still bills no footage, same as the drawing screen`() {
        val side = FenceRun(
            jobId = 1, fenceType = FenceType.VINYL,
            pointsEncoded = FenceCodec.encodePoints(listOf(FencePoint(0f, 0f), FencePoint(2000f, 0f)))
        )
        val uncalibratedPhoto = Job(surveyImagePath = photo)
        assertEquals(0f, EstimateEngine.linearFeet(uncalibratedPhoto, listOf(side)), 0f)
        assertNull(DrawingScale.of(uncalibratedPhoto))
    }
}
