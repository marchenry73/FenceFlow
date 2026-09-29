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

    private fun job(pixelsPerFoot: Float? = null, surveyImagePath: String? = null) =
        Job(customerName = "Test", calibrationPixelsPerFoot = pixelsPerFoot, surveyImagePath = surveyImagePath)

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
    fun `an uncalibrated GRID drawing measures at the grid's own scale rather than nothing`() {
        // Was: "an uncalibrated drawing counts as nothing rather than
        // guessing", asserting 0f here on the theory that no calibration
        // means no scale worth trusting at all. That was half right and half
        // wrong. A GRID drawing (no survey photo) DOES have a real scale --
        // the grid square is a known size, not a guess -- and
        // suggestQuantities() was already measuring this exact run's
        // MATERIALS off that same grid fallback. Refusing to bill LABOUR for
        // it left one run fully priced for materials and zero for labour on
        // the same estimate (fixtures/pricing/drawn-uncalibrated.json),
        // which is the bug this fix closes. The photo half of the old
        // decision was correct and is kept below.
        val drawn = run(points = listOf(0f to 0f, 200f to 0f))
        // 200px at the grid's 20px/ft fallback is 10 ft.
        assertEquals(10f, EstimateEngine.linearFeet(job(pixelsPerFoot = null), listOf(drawn)))
    }

    @Test
    fun `an uncalibrated PHOTO drawing still counts as nothing rather than guessing`() {
        // This is the half of the old decision that was RIGHT and stays: a
        // survey photo has no scale at all until somebody calibrates it
        // against something of known length (DrawingScale.isPhotoJob) -- so,
        // unlike the grid case above, there is no honest number to measure
        // this run at, and guessing would price labour off a made-up scale.
        val drawn = run(points = listOf(0f to 0f, 200f to 0f))
        assertEquals(
            0f,
            EstimateEngine.linearFeet(job(pixelsPerFoot = null, surveyImagePath = "/data/survey.jpg"), listOf(drawn))
        )
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
