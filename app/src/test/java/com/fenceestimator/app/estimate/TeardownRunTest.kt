package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.Job
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The old fence coming out is not the new fence going in.
 *
 * Wrong in either direction costs real money: charge teardown on the new
 * line and a short replacement of a long old fence under-bills the removal;
 * suggest materials along a teardown run and the order sheet buys posts for
 * a fence that is being torn down.
 */
class TeardownRunTest {

    private fun run(feet: Float, teardown: Boolean = false) = FenceRun(
        jobId = 1, fenceType = FenceType.VINYL, manualLinearFeet = feet,
        isTeardown = teardown, panelWidthFt = 6f, postSpacingFt = 6f
    )

    private val job = Job(
        customerName = "Test", laborRatePerFt = 10.0, taxRatePercent = 0.0,
        teardownEnabled = true, teardownRatePerFt = 5.0,
        teardownFlatFee = 0.0, trashHaulFee = 0.0, markupPercent = 0.0,
        minimumJobCharge = 0.0
    )

    @Test
    fun `a teardown run is not part of the new fence's footage`() {
        val runs = listOf(run(100f), run(60f, teardown = true))
        assertEquals(100f, EstimateEngine.linearFeet(job, runs))
        assertEquals(60f, EstimateEngine.teardownFeet(job, runs))
    }

    @Test
    fun `teardown is charged on the old fence's own length once drawn`() {
        val runs = listOf(run(100f), run(60f, teardown = true))
        val totals = EstimateEngine.computeTotals(
            job, emptyList(), EstimateEngine.linearFeet(job, runs), emptyList(), runs
        )
        // 60 ft of removal at $5, not 100.
        assertEquals(300.0, totals.teardownCost, 0.01)
    }

    /** No drawn teardown keeps every existing job pricing exactly as before. */
    @Test
    fun `without a teardown run the charge still follows the new fence`() {
        val runs = listOf(run(100f))
        val totals = EstimateEngine.computeTotals(
            job, emptyList(), EstimateEngine.linearFeet(job, runs), emptyList(), runs
        )
        assertEquals(500.0, totals.teardownCost, 0.01)
    }

    @Test
    fun `a teardown run suggests no materials`() {
        val s = EstimateEngine.suggestQuantities(run(60f, teardown = true), pixelsPerFoot = 0f)
        assertTrue("materials suggested for a fence being removed", s.entries.isEmpty())
        assertEquals(60f, s.netLinearFeet)
    }
}
