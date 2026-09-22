package com.fenceestimator.app.geometry

import com.fenceestimator.app.data.Job
import com.fenceestimator.app.ui.survey.SurveyViewModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The scale the drawing screen measures by, and the case that hid every gate.
 *
 * The screen read the job's stored calibration raw. A grid drawing (no survey
 * photo) that was never given one -- the seeding call runs before the job has
 * loaded on a first open, so it usually never lands -- came back null, and a
 * null scale draws no gates and no lengths at all, while the estimate kept
 * charging for those gates. A grid always knows its own scale; only a photo
 * nobody has calibrated genuinely has none.
 */
class DrawingScaleTest {

    private val photo = "/data/user/0/app/files/surveys/survey_1.jpg"

    @Test
    fun `a grid drawing with no calibration measures at the grid's own scale`() {
        assertEquals(
            SurveyViewModel.unitsPerFoot(400f),
            SurveyViewModel.drawingScale(null, null, 400f)!!,
            0.0001f
        )
        assertEquals(
            SurveyViewModel.unitsPerFoot(25f),
            SurveyViewModel.drawingScale(null, null, 25f)!!,
            0.0001f
        )
    }

    @Test
    fun `the default grid falls back to the scale the estimate prices at`() {
        // The estimate side (EstimateViewModel, TakeoffRefresher) falls back to
        // PIXELS_PER_FOOT_GRID for an uncalibrated job. On the default 400 ft
        // grid that is the same number, so the lengths the drawing now shows
        // are the lengths the takeoff is priced from.
        assertEquals(
            SurveyViewModel.PIXELS_PER_FOOT_GRID,
            SurveyViewModel.drawingScale(Job())!!,
            0.0001f
        )
    }

    @Test
    fun `a stored calibration always wins`() {
        // Grid or photo, a scale someone set by hand is the scale.
        assertEquals(37.5f, SurveyViewModel.drawingScale(37.5f, null, 400f)!!, 0.0001f)
        assertEquals(37.5f, SurveyViewModel.drawingScale(37.5f, photo, 400f)!!, 0.0001f)
    }

    @Test
    fun `an uncalibrated photo has no scale`() {
        // Nothing can say how big a photo is. It must stay null so the screen
        // asks for a calibration instead of printing invented lengths.
        assertNull(SurveyViewModel.drawingScale(null, photo, 400f))
        assertNull(SurveyViewModel.drawingScale(Job(surveyImagePath = photo)))
    }

    @Test
    fun `a stored scale that is not a positive number counts as none`() {
        // Measuring by zero makes every length infinite; by a negative, every
        // gate backwards. The grid still has its own scale to fall back on; a
        // photo still has nothing.
        for (bad in listOf(0f, -20f, Float.NaN, Float.POSITIVE_INFINITY)) {
            assertEquals(
                "grid with a stored scale of $bad",
                SurveyViewModel.unitsPerFoot(400f),
                SurveyViewModel.drawingScale(bad, null, 400f)!!,
                0.0001f
            )
            assertNull("photo with a stored scale of $bad", SurveyViewModel.drawingScale(bad, photo, 400f))
        }
    }

    @Test
    fun `the Job overload reads the same three fields`() {
        val job = Job(calibrationPixelsPerFoot = null, surveyImagePath = null, gridExtentFt = 100f)
        assertEquals(
            SurveyViewModel.drawingScale(null, null, 100f)!!,
            SurveyViewModel.drawingScale(job)!!,
            0.0001f
        )
    }

    @Test
    fun `gates on an uncalibrated grid job are drawn again`() {
        // Called the way the screen calls it: the job's scale straight into
        // spansFor. With the raw calibration (null) this list was empty -- the
        // gate existed, was priced, and was not on the plan.
        val job = Job()
        val fence = listOf(FencePoint(0f, 0f), FencePoint(2000f, 0f))
        val gates = listOf(GateMarker(1000f, 0f, 4f))

        assertEquals(
            "the bug: the raw stored calibration draws nothing",
            0,
            GateGeometry.spansFor(gates, fence, false, job.calibrationPixelsPerFoot).size
        )

        val spans = GateGeometry.spansFor(gates, fence, false, SurveyViewModel.drawingScale(job))
        assertEquals(1, spans.size)
        val span = spans.single().second
        val widthPx = kotlin.math.hypot(
            (span.end.x - span.start.x).toDouble(), (span.end.y - span.start.y).toDouble()
        ).toFloat()
        assertEquals("a 4 ft gate at 20 units per foot", 80f, widthPx, 0.01f)
    }
}
