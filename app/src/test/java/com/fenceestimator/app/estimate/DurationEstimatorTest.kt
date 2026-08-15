package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.SiteMarker
import com.fenceestimator.app.data.SiteMarkerKind
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.GateMarker
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The duration drives what a customer is promised and whether a date is
 * accepted, so the arithmetic is worth pinning down.
 */
class DurationEstimatorTest {

    private val job = Job(customerName = "Test")

    private fun run(feet: Float, corners: Int = 0, gates: List<GateMarker> = emptyList()) =
        FenceRun(
            jobId = 1,
            fenceType = FenceType.VINYL,
            manualLinearFeet = feet,
            manualCornerCount = corners,
            gatesEncoded = FenceCodec.encodeGates(gates)
        )

    @Test
    fun `breaks come out of the working day`() {
        val rates = DurationEstimator.Rates(workdayHours = 8.0, breakHoursPerDay = 1.0)
        assertEquals(7.0, rates.installHoursPerDay, 0.001)
    }

    @Test
    fun `a gate costs the configured hour and a half`() {
        val plain = DurationEstimator.estimate(job, listOf(run(100f)), 0f)
        val withGate = DurationEstimator.estimate(
            job, listOf(run(100f, gates = listOf(GateMarker(0f, 0f, 4f)))), 0f
        )
        // The gate opening also comes out of the fence footage, so compare the
        // gate line specifically rather than the total.
        assertEquals(1.5, withGate.gateHours, 0.001)
        assertEquals(0.0, plain.gateHours, 0.001)
    }

    @Test
    fun `three gates cost four and a half hours`() {
        val gates = listOf(
            GateMarker(0f, 0f, 4f), GateMarker(1f, 1f, 4f), GateMarker(2f, 2f, 4f)
        )
        val result = DurationEstimator.estimate(job, listOf(run(200f, gates = gates)), 0f)
        assertEquals(4.5, result.gateHours, 0.001)
        assertEquals(3, result.gates)
    }

    @Test
    fun `a tree costs fifteen minutes and an obstacle half an hour`() {
        val markers = listOf(
            SiteMarker(jobId = 1, kind = SiteMarkerKind.TREE),
            SiteMarker(jobId = 1, kind = SiteMarkerKind.TREE),
            SiteMarker(jobId = 1, kind = SiteMarkerKind.OBSTACLE)
        )
        val result = DurationEstimator.estimate(
            job, listOf(run(100f)), 0f, DurationEstimator.Rates(), markers
        )
        assertEquals(2, result.trees)
        assertEquals(1, result.obstacles)
        assertEquals(0.25 * 2 + 0.5, result.obstacleHours, 0.001)
    }

    @Test
    fun `a house marker is orientation, not work`() {
        val markers = listOf(
            SiteMarker(jobId = 1, kind = SiteMarkerKind.HOUSE),
            SiteMarker(jobId = 1, kind = SiteMarkerKind.DRIVEWAY)
        )
        val result = DurationEstimator.estimate(
            job, listOf(run(100f)), 0f, DurationEstimator.Rates(), markers
        )
        assertEquals(0.0, result.obstacleHours, 0.001)
    }

    @Test
    fun `a faster crew finishes the same fence in less time`() {
        val slow = DurationEstimator.estimate(
            job, listOf(run(500f)), 0f, DurationEstimator.Rates(feetPerDay = 100.0)
        )
        val fast = DurationEstimator.estimate(
            job, listOf(run(500f)), 0f, DurationEstimator.Rates(feetPerDay = 250.0)
        )
        assertTrue("a faster crew should take fewer hours", fast.totalHours < slow.totalHours)
    }

    @Test
    fun `days are counted in install hours, not clock hours`() {
        // 7 install hours a day, so 14 hours of work is two days -- not 14/8.
        val rates = DurationEstimator.Rates(workdayHours = 8.0, breakHoursPerDay = 1.0)
        val result = DurationEstimator.estimate(job, listOf(run(1000f)), 0f, rates)
        assertEquals(result.totalHours / 7.0, result.days, 0.001)
    }

    @Test
    fun `typed footage produces hours even with nothing drawn`() {
        val result = DurationEstimator.estimate(job, listOf(run(150f)), 0f)
        assertTrue("typed footage must produce hours", result.totalHours > 0.0)
        assertEquals(150.0, result.feet, 0.001)
    }

    @Test
    fun `no work means no hours`() {
        val result = DurationEstimator.estimate(job, emptyList(), 0f)
        assertEquals(0.0, result.totalHours, 0.001)
    }

    @Test
    fun `hours are rounded to two decimals`() {
        val result = DurationEstimator.estimate(job, listOf(run(137f, corners = 3)), 0f)
        assertEquals(result.totalHours, kotlin.math.round(result.totalHours * 100) / 100.0, 0.0)
    }
}
