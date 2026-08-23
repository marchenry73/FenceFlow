package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FencePoint
import com.fenceestimator.app.geometry.GateMarker
import com.fenceestimator.app.geometry.GateMounting
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The minimum job charge is a floor under the whole invoice, and it holds no
 * matter what the job is made of.
 *
 * The reported failure was a gate-only job billed under the minimum. The
 * engine was never the problem -- the floor here has always been
 * unconditional -- the job's minimum had been silently zeroed by a sync
 * that did not carry every pricing field. These tests pin the engine half
 * so a regression on either side is caught by name.
 */
class MinimumChargeTest {

    /** A run that is nothing but one gate opening: fence footage equals gate width. */
    private fun gateOnlyRun(widthFt: Float) = FenceRun(
        jobId = 1, fenceType = FenceType.VINYL, manualLinearFeet = widthFt,
        pointsEncoded = FenceCodec.encodePoints(
            listOf(FencePoint(0f, 0f), FencePoint(widthFt * 20f, 0f))
        ),
        gatesEncoded = FenceCodec.encodeGates(
            listOf(GateMarker(widthFt * 10f, 0f, widthFt, GateMounting.LINE))
        )
    )

    private fun job(minimum: Double) = Job(
        customerName = "Test", laborRatePerFt = 10.0, taxRatePercent = 0.0,
        markupPercent = 0.0, gateRatePerFt = 20.0, minimumJobCharge = minimum
    )

    private fun totals(minimum: Double, runs: List<FenceRun>): EstimateEngine.Totals {
        val j = job(minimum)
        return EstimateEngine.computeTotals(j, emptyList(), EstimateEngine.linearFeet(j, runs), emptyList(), runs)
    }

    @Test
    fun `a gate-only job still pays the minimum charge`() {
        val runs = listOf(gateOnlyRun(4f))
        val t = totals(200.0, runs)
        // 4 ft of gate at $20 is $80 of work; the fence footage is all gate,
        // so no labour footage remains. The invoice is still the $200 floor.
        assertEquals(80.0, t.gateCharge, 0.01)
        assertEquals(0.0, t.laborCost, 0.01)
        assertEquals(200.0, t.grandTotal, 0.01)
    }

    @Test
    fun `a gate-only job above the minimum is charged as itself`() {
        val runs = listOf(gateOnlyRun(20f))
        val t = totals(200.0, runs)
        assertEquals(400.0, t.gateCharge, 0.01)
        assertEquals(400.0, t.grandTotal, 0.01)
    }

    @Test
    fun `no minimum means the job prices as built`() {
        val runs = listOf(gateOnlyRun(4f))
        assertEquals(80.0, totals(0.0, runs).grandTotal, 0.01)
    }
}
