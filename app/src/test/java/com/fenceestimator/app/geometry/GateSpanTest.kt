package com.fenceestimator.app.geometry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
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

    @Test
    fun `a gate far off its line is still drawn on it`() {
        // Real jobs have gates stored 6 to 43 ft off their line (an old grid
        // rescale moved the fence and not the gates). Nothing may hide one for
        // the distance: 43 ft off, it still snaps onto the fence it belongs to.
        val span = GateGeometry.spanFor(gate(500f, 430f, 5f), run, false, scale)!!
        assertEquals(0, span.segmentIndex)
        assertEquals(500f, span.centre.x, 0.01f)
        assertEquals(0f, span.centre.y, 0.01f)
    }

    // ---- a gate with no fence to sit in ----

    @Test
    fun `a gate on a run with no corners still gets a span, the way the plan asks`() {
        // A standalone gate sale: the run has no points at all. The plan asks
        // spanFor and falls back to standaloneSpan. Before the fallback that
        // null was the end of it, and the gate was charged for but never drawn.
        val g = gate(300f, 400f, 5f)
        assertNull(GateGeometry.spanFor(g, emptyList(), false, scale))
        assertNotNull(GateGeometry.spanFor(g, emptyList(), false, scale) ?: GateGeometry.standaloneSpan(g, scale))
    }

    @Test
    fun `a standalone gate takes its own width, centred where it was placed`() {
        val span = GateGeometry.standaloneSpan(gate(300f, 400f, 5f), scale)!!
        val width = kotlin.math.hypot(
            (span.end.x - span.start.x).toDouble(), (span.end.y - span.start.y).toDouble()
        ).toFloat()
        assertEquals("5 ft at 10 px/ft is 50 px", 50f, width, 0.01f)
        assertEquals(300f, span.centre.x, 0.01f)
        assertEquals(400f, span.centre.y, 0.01f)
        // Laid level, half each side of the point it was placed at.
        assertEquals(275f, span.start.x, 0.01f)
        assertEquals(325f, span.end.x, 0.01f)
        assertEquals(400f, span.start.y, 0.01f)
        assertEquals(400f, span.end.y, 0.01f)
        assertEquals(GateGeometry.NO_SEGMENT, span.segmentIndex)
    }

    @Test
    fun `a standalone gate cuts no fence`() {
        // It belongs to no segment. Put through the plan's own per-segment
        // filter it matches nothing, so no fence is cut and -1 is never used
        // as an index.
        val standalone = GateGeometry.standaloneSpan(gate(500f, 0f, 5f), scale)!!
        assertTrue(standalone.segmentIndex < 0)
        val onThisSegment = listOf(standalone).filter { it.segmentIndex == 0 }
        val pieces = GateGeometry.segmentGaps(p(0f, 0f), p(1000f, 0f), onThisSegment)
        assertEquals("one unbroken fence", 1, pieces.size)
    }

    @Test
    fun `no width or no scale means no standalone span`() {
        assertNull(GateGeometry.standaloneSpan(gate(300f, 400f, 0f), scale))
        assertNull(GateGeometry.standaloneSpan(gate(300f, 400f, -3f), scale))
        assertNull(GateGeometry.standaloneSpan(gate(300f, 400f, 5f), 0f))
        assertNull(GateGeometry.standaloneSpan(gate(300f, 400f, 5f), -10f))
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

    // ---- every run's gates, not only the selected run's ----
    //
    // The plan used to work out spans for the selected run alone. Every other
    // run was a bare faded line, and a run with no line at all was skipped, so
    // on a job with more than one run most gates were invisible. spansFor and
    // fencePieces are what the plan now calls for every run, selected or not.

    @Test
    fun `every run on a job gets its gates, the gate-only one included`() {
        // A back fence with a walk gate, and a standalone double gate on a run
        // of its own -- the job the owner could not see the gates on. Each run
        // goes through spansFor exactly as the plan calls it.
        val backFence = run to listOf(gate(500f, 0f, 4f))
        val gateOnlyRun = emptyList<FencePoint>() to listOf(gate(300f, 800f, 12f))

        val onBackFence = GateGeometry.spansFor(backFence.second, backFence.first, closedLoop = false, pixelsPerFoot = scale)
        val onGateOnly = GateGeometry.spansFor(gateOnlyRun.second, gateOnlyRun.first, closedLoop = false, pixelsPerFoot = scale)

        assertEquals(1, onBackFence.size)
        assertEquals("snapped onto its fence", 0, onBackFence.single().second.segmentIndex)
        assertEquals(1, onGateOnly.size)
        assertEquals("laid level where it stands", GateGeometry.NO_SEGMENT, onGateOnly.single().second.segmentIndex)
        assertEquals(300f, onGateOnly.single().second.centre.x, 0.01f)
        assertEquals(800f, onGateOnly.single().second.centre.y, 0.01f)
    }

    @Test
    fun `spansFor pairs each span with the gate it came from`() {
        // The plan labels each opening with its own gate's width and swing, so
        // the pairing must survive -- two gates must not swap labels.
        val walk = GateMarker(300f, 0f, 4f, swing = GateSwing.OUT)
        val drive = GateMarker(700f, 0f, 12f, swing = GateSwing.BOTH)
        val spans = GateGeometry.spansFor(listOf(walk, drive), run, false, scale)
        assertEquals(listOf(walk, drive), spans.map { it.first })
        assertEquals(300f, spans[0].second.centre.x, 0.01f)
        assertEquals(700f, spans[1].second.centre.x, 0.01f)
    }

    @Test
    fun `spansFor gives the same span spanFor or standaloneSpan would`() {
        // One rule for every run: nothing about going through the list may
        // place a gate differently from placing it by hand.
        val onLine = gate(500f, 30f, 5f)
        val alone = gate(200f, 200f, 5f)
        assertEquals(
            GateGeometry.spanFor(onLine, run, false, scale),
            GateGeometry.spansFor(listOf(onLine), run, false, scale).single().second
        )
        assertEquals(
            GateGeometry.standaloneSpan(alone, scale),
            GateGeometry.spansFor(listOf(alone), emptyList(), false, scale).single().second
        )
    }

    @Test
    fun `no scale gives no spans rather than made-up ones`() {
        val gates = listOf(gate(500f, 0f, 5f))
        assertTrue(GateGeometry.spansFor(gates, run, false, null).isEmpty())
        assertTrue(GateGeometry.spansFor(gates, run, false, 0f).isEmpty())
        assertTrue(GateGeometry.spansFor(gates, run, false, -4f).isEmpty())
    }

    @Test
    fun `a gate with no width is left out, not drawn as a dot`() {
        val spans = GateGeometry.spansFor(listOf(gate(500f, 0f, 0f), gate(300f, 0f, 4f)), run, false, scale)
        assertEquals(1, spans.size)
        assertEquals(4f, spans.single().first.widthFt, 0.001f)
    }

    // ---- the cut a whole run's line gets ----

    private fun lengthOf(pieces: List<Pair<FencePoint, FencePoint>>) = pieces.sumOf {
        kotlin.math.hypot((it.second.x - it.first.x).toDouble(), (it.second.y - it.first.y).toDouble())
    }

    @Test
    fun `a run with no gates is its sides, unbroken`() {
        val corner = listOf(p(0f, 0f), p(1000f, 0f), p(1000f, 500f))
        val pieces = GateGeometry.fencePieces(corner, closedLoop = false, spans = emptyList())
        assertEquals("one piece per side", 2, pieces.size)
        assertEquals(1500.0, lengthOf(pieces), 0.01)
    }

    @Test
    fun `fencePieces cuts each opening out of the side it is on`() {
        val corner = listOf(p(0f, 0f), p(1000f, 0f), p(1000f, 1000f))
        val spans = GateGeometry.spansFor(listOf(gate(1000f, 500f, 4f)), corner, false, scale).map { it.second }
        val pieces = GateGeometry.fencePieces(corner, false, spans)
        // The first side untouched, the second split around 40 px of gate.
        assertEquals(3, pieces.size)
        assertEquals(2000.0 - 40.0, lengthOf(pieces), 0.01)
    }

    @Test
    fun `the closing side of a loop is cut too`() {
        // A square loop with the gate on the side that closes it (last corner
        // back to the first) -- the side a hand-written loop most easily skips.
        val square = listOf(p(0f, 0f), p(1000f, 0f), p(1000f, 1000f), p(0f, 1000f))
        val spans = GateGeometry.spansFor(listOf(gate(0f, 500f, 5f)), square, true, scale).map { it.second }
        assertEquals("matched to the closing side", 3, spans.single().segmentIndex)
        val pieces = GateGeometry.fencePieces(square, true, spans)
        assertEquals(4000.0 - 50.0, lengthOf(pieces), 0.01)
    }

    @Test
    fun `a standalone gate cuts no run's line`() {
        val alone = GateGeometry.standaloneSpan(gate(500f, 0f, 5f), scale)!!
        val pieces = GateGeometry.fencePieces(run, false, listOf(alone))
        assertEquals(1, pieces.size)
        assertEquals(1000.0, lengthOf(pieces), 0.01)
    }

    @Test
    fun `a run with fewer than two corners has no line to draw`() {
        // A gate-only run: its gates still draw (see above) but there is no
        // fence to cut, and nothing may index past the end of its points.
        assertTrue(GateGeometry.fencePieces(emptyList(), false, emptyList()).isEmpty())
        assertTrue(GateGeometry.fencePieces(emptyList(), true, emptyList()).isEmpty())
        assertTrue(GateGeometry.fencePieces(listOf(p(5f, 5f)), false, emptyList()).isEmpty())
        assertTrue(GateGeometry.fencePieces(listOf(p(5f, 5f)), true, emptyList()).isEmpty())
    }
}
