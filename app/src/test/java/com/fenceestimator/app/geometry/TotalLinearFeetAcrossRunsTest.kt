package com.fenceestimator.app.geometry

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The map's "total feet drawn" readout sums every run, not just the one
 * currently selected. Kept as its own pure test so the sum can't silently
 * drift back to counting only the active run -- see
 * FenceGeometryEngine.totalLinearFeetAcrossRuns.
 */
class TotalLinearFeetAcrossRunsTest {

    private fun p(x: Float, y: Float) = FencePoint(x, y)

    @Test
    fun `sums linear feet across multiple open runs`() {
        // 10 px/ft: a 100ft run and a 50ft run.
        val runA = listOf(p(0f, 0f), p(1000f, 0f)) to false
        val runB = listOf(p(0f, 0f), p(500f, 0f)) to false
        val total = FenceGeometryEngine.totalLinearFeetAcrossRuns(listOf(runA, runB), 10f)
        assertEquals(150f, total, 0.01f)
    }

    @Test
    fun `closed loop run counts the closing segment`() {
        // A 10x10ft square (in feet) at 10 px/ft -> 100px per side, 4 sides closed = 40ft.
        val square = listOf(p(0f, 0f), p(100f, 0f), p(100f, 100f), p(0f, 100f)) to true
        val total = FenceGeometryEngine.totalLinearFeetAcrossRuns(listOf(square), 10f)
        assertEquals(40f, total, 0.01f)
    }

    @Test
    fun `runs with fewer than two points contribute nothing`() {
        val empty = emptyList<FencePoint>() to false
        val single = listOf(p(0f, 0f)) to false
        val real = listOf(p(0f, 0f), p(100f, 0f)) to false
        val total = FenceGeometryEngine.totalLinearFeetAcrossRuns(listOf(empty, single, real), 10f)
        assertEquals(10f, total, 0.01f)
    }

    @Test
    fun `zero or negative scale yields zero rather than dividing by it`() {
        val run = listOf(p(0f, 0f), p(100f, 0f)) to false
        assertEquals(0f, FenceGeometryEngine.totalLinearFeetAcrossRuns(listOf(run), 0f), 0.0f)
        assertEquals(0f, FenceGeometryEngine.totalLinearFeetAcrossRuns(listOf(run), -5f), 0.0f)
    }
}
