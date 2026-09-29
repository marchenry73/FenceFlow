package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FencePoint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The bug this wave was sent to fix: TakeoffRefresher re-measured a run's
 * MATERIALS at the grid's flat scale on every drawing change with no photo
 * check at all -- `job.calibrationPixelsPerFoot ?: DrawingScale.PIXELS_PER_FOOT_GRID`,
 * no `DrawingScale.isPhotoJob` anywhere -- even though
 * [EstimateEngine.footageOf] already refused to guess a photo's scale for
 * LABOUR. An uncalibrated survey photo job therefore got real materials and
 * zero labour: the exact split the earlier uncalibrated-labour fix
 * (UncalibratedLabourTest) existed to remove, reproduced in the one case it
 * did not cover.
 *
 * [TakeoffRefresher.blockedByUncalibratedPhoto] is the fix: the same rule
 * `footageOf` already applies, pulled out pure so it can be pinned with no
 * [com.fenceestimator.app.data.Repository] in the loop, the same reason
 * [TakeoffRefresher.mayReprice] and [TakeoffRefresher.pricingSignature] are
 * pure.
 *
 * Keyed on `Job.surveyStoragePath`, not `Job.surveyImagePath`. Two existing
 * tests (DrawingScaleSharedTest's "an uncalibrated PHOTO run still bills no
 * footage" and LinearFeetTest's "an uncalibrated PHOTO drawing still counts
 * as nothing") both key their photo case on `surveyImagePath`, the
 * phone-local field -- which is not even a column in the live `jobs` table
 * (verified against the live schema, not assumed: `survey_storage_path` is
 * `text`, nullable; `survey_image_path` does not exist there at all). A
 * device that took the photo has both fields; a second phone or the office,
 * which only ever see `survey_storage_path`, do not -- so nothing before
 * this file pinned the leg that actually reaches them. Every case below sets
 * `surveyStoragePath` and leaves `surveyImagePath` null, the shape a second
 * phone or the office actually see (mirrors DrawingScaleSharedTest's own "a
 * photo job whose photo has not downloaded yet is still a photo job").
 */
class PhotoScaleTest {

    private val storagePath = "co-1/job-1/survey.jpg"

    private fun drawnRun(manualLinearFeet: Float? = null) = FenceRun(
        jobId = 1,
        fenceType = FenceType.VINYL,
        pointsEncoded = FenceCodec.encodePoints(listOf(FencePoint(0f, 0f), FencePoint(2000f, 0f))),
        manualLinearFeet = manualLinearFeet,
        panelWidthFt = 6f,
        postSpacingFt = 6f,
        concreteBagsPerPost = 1f
    )

    @Test
    fun `an uncalibrated photo job blocks a drawn run's materials, keyed on the travelling field`() {
        val job = Job(customerName = "Test", surveyStoragePath = storagePath, calibrationPixelsPerFoot = null)
        assertTrue(TakeoffRefresher.blockedByUncalibratedPhoto(job, drawnRun()))

        // The device-local field is genuinely absent -- this is what the
        // OFFICE and a SECOND phone see, not the device that took the photo.
        assertEquals(null, job.surveyImagePath)
    }

    @Test
    fun `a calibrated photo is never blocked, however it was calibrated`() {
        val job = Job(customerName = "Test", surveyStoragePath = storagePath, calibrationPixelsPerFoot = 12f)
        assertFalse(TakeoffRefresher.blockedByUncalibratedPhoto(job, drawnRun()))
    }

    @Test
    fun `an uncalibrated GRID job (no photo at all) is never blocked -- CANARY, must stay untouched`() {
        val job = Job(customerName = "Test", surveyStoragePath = null, calibrationPixelsPerFoot = null)
        assertFalse(job.surveyImagePath != null || job.surveyStoragePath != null)
        assertFalse(TakeoffRefresher.blockedByUncalibratedPhoto(job, drawnRun()))
    }

    @Test
    fun `typed footage is never blocked, calibrated or not, photo or grid`() {
        val uncalibratedPhoto = Job(customerName = "Test", surveyStoragePath = storagePath, calibrationPixelsPerFoot = null)
        assertFalse(TakeoffRefresher.blockedByUncalibratedPhoto(uncalibratedPhoto, drawnRun(manualLinearFeet = 100f)))

        // Zero or negative typed footage is not really "typed" -- same rule
        // resolveGeometry itself applies (manual != null && manual > 0f).
        assertTrue(TakeoffRefresher.blockedByUncalibratedPhoto(uncalibratedPhoto, drawnRun(manualLinearFeet = 0f)))
    }

    /**
     * Closes the actual gap the two existing tests left open: both of them
     * key their "uncalibrated photo bills no footage" case on
     * `surveyImagePath`. This proves the identical property holds for
     * `surveyStoragePath` alone -- the shape the office and a second phone
     * are actually in.
     */
    @Test
    fun `EstimateEngine linearFeet also refuses an uncalibrated photo keyed on surveyStoragePath alone`() {
        val job = Job(customerName = "Test", surveyStoragePath = storagePath, calibrationPixelsPerFoot = null, laborRatePerFt = 8.0)
        val run = drawnRun()

        assertEquals(0f, EstimateEngine.linearFeet(job, listOf(run)))
        val totals = EstimateEngine.computeTotals(job, emptyList(), 0f, runs = listOf(run))
        assertEquals(0.0, totals.laborCost, 0.001)
    }

    @Test
    fun `CANARY -- the identical run on an uncalibrated GRID job still bills its flat footage`() {
        // If blockedByUncalibratedPhoto or linearFeet's own photo check ever
        // widened to catch the grid case too, this is what would catch it:
        // grid jobs must keep pricing exactly as UncalibratedLabourTest and
        // DrawingScaleSharedTest already pin.
        val job = Job(customerName = "Test", surveyStoragePath = null, calibrationPixelsPerFoot = null, laborRatePerFt = 8.0)
        val run = drawnRun()

        assertFalse(TakeoffRefresher.blockedByUncalibratedPhoto(job, run))
        assertEquals(100f, EstimateEngine.linearFeet(job, listOf(run)))
        assertEquals(100f, EstimateEngine.suggestQuantities(run, pixelsPerFoot = DrawingScale.PIXELS_PER_FOOT_GRID).netLinearFeet)
    }
}
