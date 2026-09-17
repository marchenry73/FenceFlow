package com.fenceestimator.app.geometry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * Per-side lengths and the perimeter total for a closed loop, both read off
 * the same FenceGeometryEngine.analyze() the takeoff and the property panel
 * use -- no second formula. The closing side (last point back to the first)
 * must show up exactly once: once in the segment list, once in the total.
 */
class ClosedLoopMeasurementTest {

    private fun p(x: Float, y: Float) = FencePoint(x, y)

    // A 40x30 rectangle at 10 pixels per foot: sides of 40, 30, 40, 30 ft,
    // perimeter 140 ft.
    private val rectangle = listOf(p(0f, 0f), p(400f, 0f), p(400f, 300f), p(0f, 300f))
    private val pxPerFt = 10f

    @Test
    fun `open run has one fewer segment than points and no closing side`() {
        val result = FenceGeometryEngine.analyze(rectangle, pxPerFt, closedLoop = false)
        assertEquals(3, result.segments.size)
        assertEquals(110f, result.totalLinearFeet, 0.01f)
    }

    @Test
    fun `closed loop adds the closing side as its own segment`() {
        val result = FenceGeometryEngine.analyze(rectangle, pxPerFt, closedLoop = true)
        assertEquals(4, result.segments.size)
        val closingSegment = result.segments.last()
        assertEquals(3, closingSegment.fromIndex)
        assertEquals(0, closingSegment.toIndex)
        assertEquals(30f, closingSegment.lengthFt, 0.01f)
    }

    @Test
    fun `every side of the rectangle reports its real length`() {
        val result = FenceGeometryEngine.analyze(rectangle, pxPerFt, closedLoop = true)
        val lengths = result.segments.map { it.lengthFt }
        assertEquals(listOf(40f, 30f, 40f, 30f), lengths.map { Math.round(it).toFloat() })
    }

    @Test
    fun `perimeter total equals the sum of every side, closing side included once`() {
        val result = FenceGeometryEngine.analyze(rectangle, pxPerFt, closedLoop = true)
        val summed = result.segments.sumOf { it.lengthFt.toDouble() }.toFloat()
        assertEquals(140f, result.totalLinearFeet, 0.01f)
        assertEquals(summed, result.totalLinearFeet, 0.01f)
    }

    @Test
    fun `closing the loop is not the same total as leaving it open`() {
        val open = FenceGeometryEngine.analyze(rectangle, pxPerFt, closedLoop = false).totalLinearFeet
        val closed = FenceGeometryEngine.analyze(rectangle, pxPerFt, closedLoop = true).totalLinearFeet
        // Planted-failure guard: a bug that ignores closedLoop entirely
        // (always computing n-1 segments) would make these equal.
        assertNotEquals(open, closed)
        assertEquals(110f, open, 0.01f)
        assertEquals(140f, closed, 0.01f)
    }

    // --- Planted failure: proves this test file can actually fail. ---
    @Test
    fun `planted failure - closing side must not be double counted`() {
        val result = FenceGeometryEngine.analyze(rectangle, pxPerFt, closedLoop = true)
        // A bug that appended a duplicate closing segment on top of the
        // wraparound one already produced by the (i+1)%n indexing would
        // push this to 5 segments / ~170ft instead of 4 / 140ft.
        assertEquals(4, result.segments.size)
        assertEquals(140f, result.totalLinearFeet, 0.01f)
    }
}
