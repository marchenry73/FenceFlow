package com.fenceestimator.app.geometry

import com.fenceestimator.app.ui.survey.SurveyViewModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The grid's scale, and the promise that changing it does not change any
 * measurement.
 *
 * Drawn points are stored in canvas units, so the scale and the points have to
 * move together. Change one without the other and every fence on that drawing
 * is silently repriced -- a 20ft run reading as 320ft, or the reverse, with
 * nothing on screen saying anything happened.
 */
class GridScaleTest {

    private val canvas = SurveyViewModel.GRID_CANVAS_SIZE.toFloat()

    @Test
    fun `the canvas spans exactly the size chosen`() {
        for (extent in SurveyViewModel.GRID_SIZES_FT) {
            val unitsPerFoot = SurveyViewModel.unitsPerFoot(extent)
            assertEquals(
                "a $extent ft grid should measure $extent ft across",
                extent,
                canvas / unitsPerFoot,
                0.01f
            )
        }
    }

    @Test
    fun `a smaller grid gives more room per foot`() {
        // The whole point. At 400ft a foot is a couple of pixels on a phone; at
        // 25ft the same foot is sixteen times bigger.
        val big = SurveyViewModel.unitsPerFoot(400f)
        val small = SurveyViewModel.unitsPerFoot(25f)
        assertEquals(16f, small / big, 0.01f)
        assertTrue(small > big)
    }

    @Test
    fun `the default still measures what it always did`() {
        // Existing drawings were made at 20 units per foot on a 400ft grid.
        // Changing that would reprice every job already drawn.
        assertEquals(
            SurveyViewModel.PIXELS_PER_FOOT_GRID,
            SurveyViewModel.unitsPerFoot(400f),
            0.001f
        )
    }

    @Test
    fun `rescaling points keeps the run exactly as long as it was`() {
        // A 20ft run drawn on the 400ft grid.
        val before = SurveyViewModel.unitsPerFoot(400f)
        val drawn = listOf(FencePoint(0f, 0f), FencePoint(20f * before, 0f))
        assertEquals(20f, FenceGeometryEngine.analyze(drawn, before).totalLinearFeet, 0.01f)

        // Switch to the 25ft grid: points scale by the same ratio the scale did.
        val after = SurveyViewModel.unitsPerFoot(25f)
        val ratio = after / before
        val moved = drawn.map { FencePoint(it.x * ratio, it.y * ratio) }

        assertEquals(
            "the fence must still be 20 ft after changing grid size",
            20f,
            FenceGeometryEngine.analyze(moved, after).totalLinearFeet,
            0.01f
        )
    }

    @Test
    fun `forgetting to move the points is what would reprice the job`() {
        // Stated as a test because it is the failure this design exists to
        // avoid: keep the points, change only the scale, and a 20ft fence
        // becomes 320ft with nothing on screen to say so.
        val before = SurveyViewModel.unitsPerFoot(400f)
        val after = SurveyViewModel.unitsPerFoot(25f)
        val drawn = listOf(FencePoint(0f, 0f), FencePoint(20f * before, 0f))

        val unmoved = FenceGeometryEngine.analyze(drawn, after).totalLinearFeet
        assertEquals(1.25f, unmoved, 0.01f)
        assertTrue("this is the wrong answer, and the point of the test", unmoved != 20f)
    }

    @Test
    fun `a 20 ft run fills a useful part of a small grid`() {
        // The complaint in numbers: on the 400ft grid a 20ft run covers 5% of
        // the canvas and cannot be drawn accurately; on the 25ft grid it covers
        // 80%.
        val onBig = (20f * SurveyViewModel.unitsPerFoot(400f)) / canvas
        val onSmall = (20f * SurveyViewModel.unitsPerFoot(25f)) / canvas
        assertEquals(0.05f, onBig, 0.001f)
        assertEquals(0.80f, onSmall, 0.001f)
    }

    @Test
    fun `a nonsensical size falls back rather than dividing by zero`() {
        assertEquals(SurveyViewModel.PIXELS_PER_FOOT_GRID, SurveyViewModel.unitsPerFoot(0f), 0.001f)
        assertEquals(SurveyViewModel.PIXELS_PER_FOOT_GRID, SurveyViewModel.unitsPerFoot(-10f), 0.001f)
    }
}
