package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.Job
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Proves the fix for the biggest money defect the audit found: an
 * uncalibrated drawn run billed full materials and zero labour for the same
 * footage (fixtures/pricing/drawn-uncalibrated.json, tests/
 * a4-engine-parity.test.mjs FINDING 1). [EstimateEngine.suggestQuantities]
 * (materials/takeoff) measured a drawn run at the grid's fixed scale when
 * there was no calibration; [EstimateEngine.linearFeet] and
 * [EstimateEngine.teardownLinearFeet] read the job's calibration directly
 * and treated "none set" as zero feet. Fixed by making linearFeet and
 * teardownLinearFeet apply the identical [DrawingScale.PIXELS_PER_FOOT_GRID]
 * fallback the takeoff already used, instead of re-deriving their own.
 *
 * Mirrors tests/a11-uncalibrated-labour.test.mjs (TypeScript) case for case
 * and number for number -- that file's header records the exact red (pre-fix)
 * and green (post-fix) readings it verified by running the TypeScript engine
 * directly, since Gradle is reserved for the parity gate at the end of this
 * change, not for a single track to run mid-flight. This file's own
 * expected numbers were worked out by hand from the same arithmetic
 * (100 ft, the same [Job] fields, the same rates) and are not independently
 * proven green in this session; the parity gate running both engines
 * together is what closes that loop.
 */
class UncalibratedLabourTest {

    private fun vinylRun(
        pointsEncoded: String = "",
        manualLinearFeet: Float? = null,
        isTeardown: Boolean = false
    ) = FenceRun(
        jobId = 1,
        fenceType = FenceType.VINYL,
        pointsEncoded = pointsEncoded,
        manualLinearFeet = manualLinearFeet,
        isTeardown = isTeardown,
        panelWidthFt = 6f,
        postSpacingFt = 6f,
        concreteBagsPerPost = 1f
    )

    /** A straight 2000-unit line -- 100 ft at the grid's 20 px/ft fallback. */
    private val drawn2000px = "0:0,2000:0"

    @Test
    fun `uncalibrated drawn run bills labour off the same 100 ft the takeoff measures materials at`() {
        val job = Job(customerName = "Test", calibrationPixelsPerFoot = null, laborRatePerFt = 8.0, taxRatePercent = 0.0)
        val run = vinylRun(pointsEncoded = drawn2000px)

        // The takeoff (materials) side: unaffected by this change, still
        // measures the drawing at the grid's fallback scale.
        val suggestions = EstimateEngine.suggestQuantities(run, pixelsPerFoot = DrawingScale.PIXELS_PER_FOOT_GRID)
        assertEquals(100f, suggestions.geometry.totalLinearFeet)
        assertEquals(100f, suggestions.netLinearFeet)

        // FIXED: linearFeet() used to return 0f here (job.calibrationPixelsPerFoot
        // is null and the old code had no fallback at all). It now measures the
        // SAME 100 ft the takeoff above did.
        val feet = EstimateEngine.linearFeet(job, listOf(run))
        assertEquals(100f, feet)

        // FIXED: 100 ft @ $8/ft = $800 labour, not $0.
        val totals = EstimateEngine.computeTotals(job, emptyList(), feet, runs = listOf(run))
        assertEquals(800.0, totals.laborCost, 0.001)
        assertEquals(100f, totals.billableLinearFeet)
    }

    @Test
    fun `CANARY -- uncalibrated (grid fallback) and explicitly-calibrated-to-20 agree exactly`() {
        val run = vinylRun(pointsEncoded = drawn2000px)
        val uncalibrated = Job(customerName = "Test", calibrationPixelsPerFoot = null, laborRatePerFt = 8.0)
        val calibratedTo20 = uncalibrated.copy(calibrationPixelsPerFoot = DrawingScale.PIXELS_PER_FOOT_GRID)

        val feetUncalibrated = EstimateEngine.linearFeet(uncalibrated, listOf(run))
        val feetCalibrated = EstimateEngine.linearFeet(calibratedTo20, listOf(run))

        // If the fallback constant in linearFeet ever drifted from the
        // takeoff's own grid scale, this is what would catch it: not just
        // "labour is nonzero", but "labour agrees to the last unit whichever
        // way the same scale arrived".
        assertEquals(feetCalibrated, feetUncalibrated, 0f)
        assertEquals(100f, feetUncalibrated)
    }

    @Test
    fun `teardownLinearFeet gets the identical fix`() {
        val job = Job(customerName = "Test", calibrationPixelsPerFoot = null, teardownEnabled = true, teardownRatePerFt = 3.0)
        val teardownRun = vinylRun(pointsEncoded = drawn2000px, isTeardown = true)

        // FIXED: used to be 0f, same missing fallback as linearFeet.
        val teardownFeet = EstimateEngine.teardownLinearFeet(job, listOf(teardownRun))
        assertEquals(100f, teardownFeet)

        val newFenceFeet = EstimateEngine.linearFeet(job, listOf(teardownRun))
        // A teardown run is the OLD fence: it must contribute NOTHING to the
        // new-fence labour footage, or the same drawing is billed twice --
        // once as labour, once as teardown.
        assertEquals(0f, newFenceFeet)

        val totals = EstimateEngine.computeTotals(job, emptyList(), newFenceFeet, runs = listOf(teardownRun))
        // FIXED: 100 ft @ $3/ft = $300 teardown, not $0.
        assertEquals(300.0, totals.teardownCost, 0.001)
        assertEquals(0.0, totals.laborCost, 0.001)
    }

    @Test
    fun `a run with no drawing and no typed footage still measures nothing`() {
        // The fix removes the fallback's ABSENCE; it does not invent length
        // that was never drawn. A run with an empty pointsEncoded and no
        // manualLinearFeet has no length anywhere to measure.
        val job = Job(customerName = "Test", calibrationPixelsPerFoot = null, laborRatePerFt = 8.0)
        val emptyRun = vinylRun(pointsEncoded = "")

        assertEquals(0f, EstimateEngine.linearFeet(job, listOf(emptyRun)))
        assertEquals(0f, EstimateEngine.teardownLinearFeet(job, listOf(emptyRun.copy(isTeardown = true))))
    }
}
