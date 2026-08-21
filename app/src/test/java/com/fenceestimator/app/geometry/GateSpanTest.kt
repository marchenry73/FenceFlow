package com.fenceestimator.app.geometry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A gate taking up the fence it actually takes up.
 *
 * It used to be drawn as a fixed little square wherever it was dropped, so a
 * 3ft walk gate and a 16ft double gate looked identical and neither occupied
 * any width. On a plan somebody builds from, that is the difference between an
 * opening that fits and one that does not.
 */
class GateSpanTest {

    private fun p(x: Float, y: Float) = FencePoint(x, y)

    /** A horizontal run 100ft long at 10 pixels per foot. */
    private val run = listOf(p(0f, 0f), p(1000f, 0f))
    private val scale = 10f

    private fun gate(x: Float, y: Float, widthFt: Float) = GateMarker(x, y, widthFt)

    @Test
    fun `a five foot gate takes five feet of fence`() {
        val span = GateGeometry.spanFor(gate(500f, 0f, 5f), run, closedLoop = false, pixelsPerFoot = scale)!!
        val width = kotlin.math.hypot(
            (span.end.x - span.start.x).toDouble(), (span.end.y - span.start.y).toDouble()
        ).toFloat()
        assertEquals("5 ft at 10 px/ft is 50 px", 50f, width, 0.01f)
    }

    @Test
    fun `a sixteen foot gate takes sixteen feet, not the same as a five`() {
        val small = GateGeometry.spanFor(gate(500f, 0f, 5f), run, false, scale)!!
        val big = GateGeometry.spanFor(gate(500f, 0f, 16f), run, false, scale)!!
        fun widthOf(s: GateSpan) = kotlin.math.hypot(
            (s.end.x - s.start.x).toDouble(), (s.end.y - s.start.y).toDouble()
        ).toFloat()
        assertEquals(160f, widthOf(big), 0.01f)
        assertTrue("a double gate must not look like a walk gate", widthOf(big) > widthOf(small))
    }

    @Test
    fun `the gate is centred on where it was dropped`() {
        val span = GateGeometry.spanFor(gate(500f, 0f, 5f), run, false, scale)!!
        assertEquals(500f, span.centre.x, 0.01f)
        assertEquals(475f, span.start.x, 0.01f)
        assertEquals(525f, span.end.x, 0.01f)
    }

    @Test
    fun `a gate dropped beside the line snaps onto it`() {
        // People do not tap exactly on a 4px line. Dropped 30px off the fence,
        // the gate still belongs to the fence.
        val span = GateGeometry.spanFor(gate(500f, 30f, 5f), run, false, scale)!!
        assertEquals(0f, span.centre.y, 0.01f)
        assertEquals(500f, span.centre.x, 0.01f)
    }

    @Test
    fun `a gate lies along the fence, not across it`() {
        // A vertical run: the gate must run vertically too, or it reads as a
        // barrier across the fence rather than an opening in it.
        val vertical = listOf(p(0f, 0f), p(0f, 1000f))
        val span = GateGeometry.spanFor(gate(0f, 500f, 5f), vertical, false, scale)!!
        assertEquals("no sideways drift", 0f, span.start.x, 0.01f)
        assertEquals(475f, span.start.y, 0.01f)
        assertEquals(525f, span.end.y, 0.01f)
    }

    @Test
    fun `the gate picks the nearest run when several are close`() {
        val corner = listOf(p(0f, 0f), p(1000f, 0f), p(1000f, 1000f))
        // Much nearer the second, vertical, segment.
        val span = GateGeometry.spanFor(gate(990f, 500f, 4f), corner, false, scale)!!
        assertEquals(1, span.segmentIndex)
    }

    @Test
    fun `no scale means no span, rather than a made-up one`() {
        assertNull(GateGeometry.spanFor(gate(500f, 0f, 5f), run, false, 0f))
    }

    @Test
    fun `no line means no span`() {
        assertNull(GateGeometry.spanFor(gate(500f, 0f, 5f), listOf(p(0f, 0f)), false, scale))
    }

    // ---- the gap the gate leaves in the fence ----

    @Test
    fun `fence is drawn either side of the opening`() {
        val span = GateGeometry.spanFor(gate(500f, 0f, 5f), run, false, scale)!!
        val pieces = GateGeometry.segmentGaps(p(0f, 0f), p(1000f, 0f), listOf(span))

        assertEquals("two stretches of fence", 2, pieces.size)
        assertEquals(0f, pieces[0].first.x, 0.01f)
        assertEquals(475f, pieces[0].second.x, 0.01f)
        assertEquals(525f, pieces[1].first.x, 0.01f)
        assertEquals(1000f, pieces[1].second.x, 0.01f)
    }

    @Test
    fun `a run with no gates is one unbroken fence`() {
        val pieces = GateGeometry.segmentGaps(p(0f, 0f), p(1000f, 0f), emptyList())
        assertEquals(1, pieces.size)
        assertEquals(0f, pieces[0].first.x, 0.01f)
        assertEquals(1000f, pieces[0].second.x, 0.01f)
    }

    @Test
    fun `two gates leave three stretches of fence`() {
        val a = GateGeometry.spanFor(gate(300f, 0f, 4f), run, false, scale)!!
        val b = GateGeometry.spanFor(gate(700f, 0f, 4f), run, false, scale)!!
        val pieces = GateGeometry.segmentGaps(p(0f, 0f), p(1000f, 0f), listOf(b, a))
        assertEquals(3, pieces.size)
        // Sorted by position even though they were passed out of order.
        assertTrue(pieces[0].second.x < pieces[1].first.x)
    }

    @Test
    fun `overlapping gates do not redraw fence across an opening`() {
        // Two wide gates dropped almost on top of each other. Handled without
        // the second one putting fence back over the first one's opening.
        val a = GateGeometry.spanFor(gate(500f, 0f, 20f), run, false, scale)!!
        val b = GateGeometry.spanFor(gate(520f, 0f, 20f), run, false, scale)!!
        val pieces = GateGeometry.segmentGaps(p(0f, 0f), p(1000f, 0f), listOf(a, b))
        pieces.forEach { (from, to) ->
            assertTrue("a stretch of fence must never run backwards", to.x >= from.x)
        }
    }

    @Test
    fun `a gate wider than its fence leaves no fence at all`() {
        // Worth showing rather than hiding: an opening too wide for the run it
        // is on should be visible as exactly that.
        val shortRun = listOf(p(0f, 0f), p(30f, 0f))
        val span = GateGeometry.spanFor(gate(15f, 0f, 10f), shortRun, false, scale)!!
        val pieces = GateGeometry.segmentGaps(p(0f, 0f), p(30f, 0f), listOf(span))
        val remaining = pieces.sumOf {
            kotlin.math.hypot((it.second.x - it.first.x).toDouble(), (it.second.y - it.first.y).toDouble())
        }
        assertEquals("100 px of gate on a 30 px run leaves nothing", 0.0, remaining, 0.01)
    }
}
