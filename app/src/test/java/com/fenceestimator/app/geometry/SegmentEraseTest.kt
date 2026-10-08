package com.fenceestimator.app.geometry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Erasing one wall of a side. Every arm of this changes a quote, which is why
 * it is a pure function with its own tests rather than logic inside a drag
 * handler nothing can run.
 */
class SegmentEraseTest {

    // A U: A-B-C-D, three walls.
    private val u = listOf(
        FencePoint(0f, 0f), FencePoint(0f, 100f),
        FencePoint(100f, 100f), FencePoint(100f, 0f),
    )
    private fun gateOn(x: Float, y: Float) = GateMarker(x, y, 4f, GateMounting.LINE)

    @Test
    fun `erasing the first wall shortens the side, it does not split it`() {
        val p = SegmentErase.plan(u, emptyList(), 0)
        assertEquals(listOf(u[1], u[2], u[3]), p.keep)
        assertTrue(p.split.isEmpty())
        assertFalse(p.splitsInTwo)
    }

    @Test
    fun `erasing the last wall shortens the side`() {
        val p = SegmentErase.plan(u, emptyList(), 2)
        assertEquals(listOf(u[0], u[1], u[2]), p.keep)
        assertTrue(p.split.isEmpty())
    }

    @Test
    fun `erasing a middle wall leaves TWO fences`() {
        // The owner's decision, and the expensive one: two sides means four end
        // posts where there were two. It is what is physically there.
        val p = SegmentErase.plan(u, emptyList(), 1)
        assertEquals(listOf(u[0], u[1]), p.keep)
        assertEquals(listOf(u[2], u[3]), p.split)
        assertTrue(p.splitsInTwo)
    }

    @Test
    fun `a side that is one wall is erased whole`() {
        val single = listOf(FencePoint(0f, 0f), FencePoint(100f, 0f))
        val p = SegmentErase.plan(single, emptyList(), 0)
        assertTrue(p.eraseWholeRun)
        assertTrue(p.keep.isEmpty())
    }

    @Test
    fun `a gate on the erased wall goes with it`() {
        // His decision. Moving it to a neighbouring wall would silently
        // re-price it against a different side.
        val onMiddle = gateOn(50f, 100f)
        val p = SegmentErase.plan(u, listOf(onMiddle), 1)
        assertEquals(listOf(onMiddle), p.removed)
        assertTrue(p.keptGates.isEmpty())
        assertTrue(p.splitGates.isEmpty())
    }

    @Test
    fun `a gate on a surviving wall follows the piece its wall ended up on`() {
        val onFirst = gateOn(0f, 50f)     // wall 0, stays with keep
        val onLast = gateOn(100f, 50f)    // wall 2, goes to the split
        val p = SegmentErase.plan(u, listOf(onFirst, onLast), 1)
        assertEquals(listOf(onFirst), p.keptGates)
        assertEquals(listOf(onLast), p.splitGates)
        assertTrue(p.removed.isEmpty())
    }

    @Test
    fun `erasing the first wall of an L leaves a usable side, not a stray point`() {
        // Two points minimum: one point is not a fence, and a run holding one
        // is the zero-length shape that billed a gate four posts.
        val l = listOf(FencePoint(0f, 0f), FencePoint(0f, 100f), FencePoint(100f, 100f))
        val p = SegmentErase.plan(l, emptyList(), 0)
        assertEquals(2, p.keep.size)
        assertFalse(p.eraseWholeRun)
    }

    @Test
    fun `a press outside the segments changes nothing`() {
        // A stray press must not be able to erase something, or crash.
        for (bad in listOf(-1, 3, 99)) {
            val p = SegmentErase.plan(u, emptyList(), bad)
            assertEquals("index $bad", u, p.keep)
            assertFalse("index $bad", p.eraseWholeRun)
            assertTrue("index $bad", p.removed.isEmpty())
        }
    }

    @Test
    fun `gates are assigned to the wall they actually sit on`() {
        // The control. If nearestSegment were wrong, every gate assertion above
        // would pass or fail for the wrong reason.
        assertEquals(0, SegmentErase.nearestSegment(u, gateOn(0f, 50f)))
        assertEquals(1, SegmentErase.nearestSegment(u, gateOn(50f, 100f)))
        assertEquals(2, SegmentErase.nearestSegment(u, gateOn(100f, 50f)))
    }

    @Test
    fun `no gate is lost or duplicated by a split`() {
        // Whatever the arrangement, every gate ends up in exactly one bucket.
        val gates = listOf(gateOn(0f, 50f), gateOn(50f, 100f), gateOn(100f, 50f), gateOn(0f, 10f))
        for (i in 0..2) {
            val p = SegmentErase.plan(u, gates, i)
            val total = p.keptGates.size + p.splitGates.size + p.removed.size
            assertEquals("segment $i lost or duplicated a gate", gates.size, total)
        }
    }
}
