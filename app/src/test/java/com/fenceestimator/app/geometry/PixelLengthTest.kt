package com.fenceestimator.app.geometry

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The measurement behind "make the drawing match the length I measured".
 *
 * Typing a length used to fix the quote for one run and leave the drawing at
 * whatever scale it happened to be -- so the fence was priced right while the
 * plan the crew builds from, the gates marked on it, and every other run
 * sharing that drawing stayed wrong.
 *
 * Working the scale out instead means one measured run corrects the whole
 * plan. Which also means an error here misprices every job drawn on it, so the
 * arithmetic is pinned.
 */
class PixelLengthTest {

    private fun p(x: Float, y: Float) = FencePoint(x, y)

    @Test
    fun `a straight line is its own length`() {
        assertEquals(200f, FenceGeometryEngine.pixelLength(listOf(p(0f, 0f), p(200f, 0f))), 0.01f)
    }

    @Test
    fun `segments add up`() {
        val line = listOf(p(0f, 0f), p(100f, 0f), p(100f, 50f))
        assertEquals(150f, FenceGeometryEngine.pixelLength(line), 0.01f)
    }

    @Test
    fun `a diagonal is measured properly, not as its sides`() {
        // 3-4-5. Measuring a diagonal as dx + dy is the classic way to make a
        // fence line read 40% longer than it is.
        assertEquals(5f, FenceGeometryEngine.pixelLength(listOf(p(0f, 0f), p(3f, 4f))), 0.01f)
    }

    @Test
    fun `a closed loop includes the side back to the start`() {
        // A square yard: four sides, not three.
        val square = listOf(p(0f, 0f), p(10f, 0f), p(10f, 10f), p(0f, 10f))
        assertEquals(40f, FenceGeometryEngine.pixelLength(square, closedLoop = true), 0.01f)
        assertEquals(30f, FenceGeometryEngine.pixelLength(square, closedLoop = false), 0.01f)
    }

    @Test
    fun `too few points measure nothing rather than crashing`() {
        assertEquals(0f, FenceGeometryEngine.pixelLength(emptyList()), 0.01f)
        assertEquals(0f, FenceGeometryEngine.pixelLength(listOf(p(5f, 5f))), 0.01f)
    }

    @Test
    fun `the scale that comes out of it is the one the app stores`() {
        // The whole point: a line drawn 480px long, measured on site at 120ft,
        // is a drawing at 4 pixels per foot.
        val drawn = listOf(p(0f, 0f), p(480f, 0f))
        val pixels = FenceGeometryEngine.pixelLength(drawn)
        val measuredFeet = 120f

        val pixelsPerFoot = pixels / measuredFeet
        assertEquals(4f, pixelsPerFoot, 0.001f)

        // And measuring the same line back with that scale returns the length
        // that was typed -- which is what "the drawing matches" means.
        assertEquals(
            measuredFeet,
            FenceGeometryEngine.analyze(drawn, pixelsPerFoot).totalLinearFeet,
            0.01f
        )
    }

    @Test
    fun `correcting the scale corrects a different run on the same drawing`() {
        // The reason this is worth doing at all. One run is measured on site;
        // a second run on the same plan was never measured, and comes out right
        // anyway because the whole drawing now has a true scale.
        val measured = listOf(p(0f, 0f), p(480f, 0f))
        val other = listOf(p(0f, 0f), p(240f, 0f))

        val pixelsPerFoot = FenceGeometryEngine.pixelLength(measured) / 120f

        assertEquals(
            60f,
            FenceGeometryEngine.analyze(other, pixelsPerFoot).totalLinearFeet,
            0.01f
        )
    }
}
