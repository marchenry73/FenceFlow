package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.Job
import org.junit.Assert.assertEquals
import org.junit.Test

/** The old fence is not always the new fence; the typed length wins when given. */
class TeardownFeetTest {
    private fun run(feet: Float) = FenceRun(
        jobId = 1, fenceType = FenceType.VINYL, manualLinearFeet = feet,
        panelWidthFt = 6f, postSpacingFt = 6f
    )
    private fun job(teardownFeet: Double) = Job(
        customerName = "Test", laborRatePerFt = 10.0, taxRatePercent = 0.0,
        teardownEnabled = true, teardownRatePerFt = 5.0, teardownFlatFee = 0.0,
        trashHaulFee = 0.0, markupPercent = 0.0, minimumJobCharge = 0.0,
        teardownFeet = teardownFeet
    )

    @Test
    fun `typed teardown length is what gets charged`() {
        val runs = listOf(run(100f))
        val t = EstimateEngine.computeTotals(job(60.0), emptyList(), EstimateEngine.linearFeet(job(60.0), runs), emptyList(), runs)
        assertEquals(300.0, t.teardownCost, 0.01)
    }

    @Test
    fun `zero means the same as the new fence, as every job assumed before`() {
        val runs = listOf(run(100f))
        val t = EstimateEngine.computeTotals(job(0.0), emptyList(), EstimateEngine.linearFeet(job(0.0), runs), emptyList(), runs)
        assertEquals(500.0, t.teardownCost, 0.01)
    }
}
