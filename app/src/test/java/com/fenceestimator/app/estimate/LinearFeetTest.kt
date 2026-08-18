package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FencePoint
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Footage used to be worked out separately by the home screen, the job screen
 * and the estimate screen. Three copies of one rule is three chances for the
 * home total to stop matching the job it was added up from, which reads to a
 * contractor as the app making numbers up.
 *
 * These pin the shared rule, so a change to it has to be deliberate.
 */
class LinearFeetTest {

    private fun job(pixelsPerFoot: Float? = null) =
        Job(customerName = "Test", calibrationPixelsPerFoot = pixelsPerFoot)

    private fun run(
        feet: Float? = null,
        points: List<Pair<Float, Float>> = emptyList(),
        closed: Boolean = false
    ) = FenceRun(
        jobId = 1,
        fenceType = FenceType.VINYL,
        manualLinearFeet = feet,
        pointsEncoded = FenceCodec.encodePoints(points.map { (x, y) -> FencePoint(x, y) }),
        closedLoop = closed
    )

    @Test
    fun `typed-in footage is used as given`() {
        assertEquals(100f, EstimateEngine.linearFeet(job(), listOf(run(feet = 100f))))
    }

    @Test
    fun `runs add up`() {
        val total = EstimateEngine.linearFeet(
            job(), listOf(run(feet = 100f), run(feet = 60f), run(feet = 40f))
        )
        assertEquals(200f, total)
    }

    @Test
    fun `a drawn run is measured against the calibration`() {
        // 200px at 2px per foot is 100 feet.
        val drawn = run(points = listOf(0f to 0f, 200f to 0f))
        assertEquals(100f, EstimateEngine.linearFeet(job(pixelsPerFoot = 2f), listOf(drawn)))
    }

    @Test
    fun `typed-in footage beats the drawing`() {
        // Somebody measured on site and typed it in; that wins over the sketch.
        val both = run(feet = 90f, points = listOf(0f to 0f, 200f to 0f))
        assertEquals(90f, EstimateEngine.linearFeet(job(pixelsPerFoot = 2f), listOf(both)))
    }

    @Test
    fun `an uncalibrated drawing counts as nothing rather than guessing`() {
        // Half-set-up job: better it reads as incomplete than as a wrong number
        // that somebody quotes off.
        val drawn = run(points = listOf(0f to 0f, 200f to 0f))
        assertEquals(0f, EstimateEngine.linearFeet(job(pixelsPerFoot = null), listOf(drawn)))
    }

    @Test
    fun `zero typed-in footage falls through to the drawing`() {
        // A cleared field is not an assertion that the fence is zero feet long.
        val drawn = run(feet = 0f, points = listOf(0f to 0f, 200f to 0f))
        assertEquals(100f, EstimateEngine.linearFeet(job(pixelsPerFoot = 2f), listOf(drawn)))
    }

    @Test
    fun `no runs is zero, not a crash`() {
        assertEquals(0f, EstimateEngine.linearFeet(job(), emptyList()))
    }
}
