package com.fenceestimator.app.geometry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Redo, to match Undo ([UndoHistory]). The guarantees:
 *  - Undo then Redo puts back EXACTLY the drawing that was there -- the same
 *    stored strings, gates included with their width, mounting and swing;
 *  - any other edit clears what there is to redo, including an edit the
 *    screen never saw (a sync from the office);
 *  - it is per run, and a press with nothing to redo says why.
 *
 * [DrawHistoryStore] replays the view model's own sequence -- edit and record,
 * plan, restore, record -- over plain values, so the protocol is proved here
 * without Room, coroutines or Compose.
 */
class RedoHistoryTest {

    private fun p(x: Float, y: Float) = FencePoint(x, y)

    private fun snapshot(points: List<FencePoint>, gates: String = "", closed: Boolean = false) =
        DrawingSnapshot(FenceCodec.encodePoints(points), gates, closed)

    // Three corners, and two gates: one in the current format, one saved in
    // the old three-part form with no mounting or swing.
    private val drawing = DrawingSnapshot(
        pointsEncoded = "1000.0:1000.0,1937.3:1000.0,1937.3:1612.25",
        gatesEncoded = "1400.0:1000.0:4.0:WALL:OUT,1937.3:1300.0:12.5",
        closedLoop = false
    )

    private val wallGate get() = FenceCodec.decodeGates(drawing.gatesEncoded).first()
    private val oldFormatGate get() = FenceCodec.decodeGates(drawing.gatesEncoded).last()

    // ------------------------------------------------------------ round trips

    @Test
    fun `undo a point, redo it, and the drawing is exactly what it was`() {
        val s = DrawHistoryStore(mapOf(1L to drawing))
        s.addDrawPoint(1, p(2400f, 1612.25f))
        val drawn = s.runs[1]!!
        s.undo(1)
        assertEquals(drawing, s.runs[1])
        s.redo(1)
        assertEquals(drawn, s.runs[1])
    }

    @Test
    fun `undo a gate removal, redo it, and it comes back byte for byte -- old format and all`() {
        val s = DrawHistoryStore(mapOf(1L to drawing))
        s.removeGate(1, wallGate)
        // Removing one gate re-encodes the one left in today's five-part form...
        assertEquals("1937.3:1300.0:12.5:LINE:IN", s.runs[1]!!.gatesEncoded)
        val removed = s.runs[1]!!
        s.undo(1)
        // ...and Undo puts back the very string that was there. Not "decodes
        // the same": the three-part gate is not silently rewritten.
        assertEquals(drawing.gatesEncoded, s.runs[1]!!.gatesEncoded)
        assertEquals(drawing, s.runs[1])
        s.redo(1)
        assertEquals(removed, s.runs[1])
    }

    @Test
    fun `a mixed run of undos redoes back in reverse order to the last edit`() {
        val s = DrawHistoryStore(mapOf(1L to drawing))
        val seen = mutableListOf(s.runs[1]!!)
        s.addGate(1, GateMarker(1200f, 1000f, 5f)); seen += s.runs[1]!!
        s.addDrawPoint(1, p(2400f, 1612.25f)); seen += s.runs[1]!!
        s.moveGate(1, 0, 1450f, 1000f); seen += s.runs[1]!!
        s.toggleClosedLoop(1, true); seen += s.runs[1]!!
        repeat(4) { s.undo(1) }
        assertEquals(drawing, s.runs[1])
        assertEquals(4, s.redoHistory.depth(1))
        // Each redo steps forward through exactly the states the edits made.
        for (i in 1 until seen.size) {
            s.redo(1)
            assertEquals("after redo forward to state $i", seen[i], s.runs[1])
        }
        assertEquals(0, s.redoHistory.depth(1))
        s.redo(1)
        assertEquals(RedoNoneReason.NOTHING_TO_REDO, s.lastRedoNone)
        assertEquals(seen.last(), s.runs[1])
    }

    @Test
    fun `undo after a redo keeps what is still left to redo`() {
        val s = DrawHistoryStore(mapOf(1L to drawing))
        s.addDrawPoint(1, p(2400f, 1612.25f))
        s.addDrawPoint(1, p(2400f, 2000f))
        val latest = s.runs[1]!!
        s.undo(1); s.undo(1)
        s.redo(1)
        s.undo(1)
        s.redo(1); s.redo(1)
        assertEquals(latest, s.runs[1])
    }

    @Test
    fun `a closed loop round trips with its closing flag`() {
        val loop = snapshot(listOf(p(0f, 0f), p(400f, 0f), p(400f, 300f), p(0f, 300f)), closed = true)
        val s = DrawHistoryStore(mapOf(7L to loop))
        s.movePoint(7, 2, p(450f, 350f))
        val moved = s.runs[7]!!
        s.undo(7)
        assertEquals(loop, s.runs[7])
        s.redo(7)
        assertEquals(moved, s.runs[7])
        assertTrue(s.runs[7]!!.closedLoop)
    }

    // --------------------------------------------------- edits clear the stack

    @Test
    fun `a new edit clears the redo stack`() {
        val s = DrawHistoryStore(mapOf(1L to drawing))
        s.addDrawPoint(1, p(2400f, 1612.25f))
        s.undo(1)
        s.addDrawPoint(1, p(2100f, 1612.25f))
        s.redo(1)
        assertEquals(RedoNoneReason.NOTHING_TO_REDO, s.lastRedoNone)
        assertTrue(s.runs[1]!!.pointsEncoded.endsWith("2100.0:1612.25"))
    }

    @Test
    fun `an edit the screen never saw still stops redo pasting over it`() {
        val s = DrawHistoryStore(mapOf(1L to drawing))
        s.addDrawPoint(1, p(2400f, 1612.25f))
        s.undo(1)
        // The office moved a corner and it synced down.
        s.externalChange(1) { it.copy(pointsEncoded = "1000.0:1000.0,1950.0:1000.0") }
        s.redo(1)
        assertEquals(RedoNoneReason.DRAWING_CHANGED, s.lastRedoNone)
        assertEquals("1000.0:1000.0,1950.0:1000.0", s.runs[1]!!.pointsEncoded)
        // And the stale step is gone, so the next press says "nothing".
        assertEquals(0, s.redoHistory.depth(1))
    }

    @Test
    fun `closing the loop after an undo counts as an edit`() {
        val s = DrawHistoryStore(mapOf(1L to drawing))
        s.addDrawPoint(1, p(2400f, 1612.25f))
        s.undo(1)
        s.externalChange(1) { it.copy(closedLoop = true) }
        s.redo(1)
        assertEquals(RedoNoneReason.DRAWING_CHANGED, s.lastRedoNone)
    }

    @Test
    fun `a drawing-wide change clears every run`() {
        val h = RedoHistory()
            .afterUndo(1, drawing, drawing.copy(pointsEncoded = ""))
            .afterUndo(2, drawing, drawing.copy(gatesEncoded = ""))
            .afterDrawingWideEdit()
        assertEquals(0, h.depth(1))
        assertEquals(0, h.depth(2))
    }

    // --- Planted failure: redo must not survive an edit. ---
    @Test
    fun `planted failure - a history that ignored edits would redo over new work`() {
        val before = drawing
        val after = drawing.copy(pointsEncoded = "1000.0:1000.0,1937.3:1000.0")
        val edited = after.copy(pointsEncoded = after.pointsEncoded + ",5.0:5.0")
        val history = RedoHistory().afterUndo(1, before, after)
        // Had the view model forgotten afterEdit, only the snapshot comparison
        // stands between Redo and the new point -- and it holds:
        assertEquals(RedoPlan.None(RedoNoneReason.DRAWING_CHANGED), history.plan(1, edited))
        // While on the undone drawing itself, Redo is offered.
        assertEquals(RedoPlan.Restore(before), history.plan(1, after))
    }

    // ------------------------------------------------------------------ scope

    @Test
    fun `redo is per run`() {
        val other = snapshot(listOf(p(0f, 0f), p(100f, 0f), p(100f, 100f)))
        val s = DrawHistoryStore(mapOf(1L to drawing, 2L to other))
        s.addDrawPoint(1, p(2400f, 1612.25f))
        val drawn = s.runs[1]!!
        s.addDrawPoint(2, p(0f, 100f))
        s.undo(1)
        s.undo(2)
        s.toggleClosedLoop(2, true)
        // Editing run 2 did not throw away run 1's redo.
        s.redo(1)
        assertEquals(drawn, s.runs[1])
        s.redo(2)
        assertEquals(RedoNoneReason.NOTHING_TO_REDO, s.lastRedoNone)
    }

    @Test
    fun `no run selected explains itself`() {
        val s = DrawHistoryStore(mapOf(1L to drawing))
        s.addDrawPoint(1, p(2400f, 1612.25f))
        s.undo(1)
        s.redo(null)
        assertEquals(RedoNoneReason.NO_RUN_SELECTED, s.lastRedoNone)
        assertEquals(RedoPlan.None(RedoNoneReason.NO_RUN_SELECTED), s.redoHistory.plan(1, null))
    }

    @Test
    fun `nothing undone means nothing to redo`() {
        assertEquals(RedoPlan.None(RedoNoneReason.NOTHING_TO_REDO), RedoHistory().plan(1, drawing))
    }

    @Test
    fun `the history is bounded`() {
        var h = RedoHistory()
        repeat(RedoHistory.MAX_STEPS + 25) { i ->
            h = h.afterUndo(1, drawing.copy(pointsEncoded = "$i.0:0.0"), drawing)
        }
        assertEquals(RedoHistory.MAX_STEPS, h.depth(1))
    }

    // --- Planted failure: proves the exactness check can tell a gate apart. ---
    @Test
    fun `planted failure - putting back a default gate would be caught`() {
        // A tempting shortcut: re-add the removed gate from its position and
        // width alone. It decodes to a gate in the same place -- and is still
        // wrong, because the old string form is gone, and for the wall gate
        // the mounting and outward swing would be gone too.
        val s = DrawHistoryStore(mapOf(1L to drawing))
        val removed = oldFormatGate
        s.removeGate(1, removed)
        val shortcut = FenceCodec.encodeGates(
            FenceCodec.decodeGates(s.runs[1]!!.gatesEncoded) + GateMarker(removed.x, removed.y, removed.widthFt)
        )
        // The shortcut differs from the real drawing (old-format string)...
        assertNotEquals(drawing.gatesEncoded, shortcut)
        // ...and for the wall gate would lose mounting and swing outright.
        assertNotEquals(wallGate, GateMarker(wallGate.x, wallGate.y, wallGate.widthFt))
        // The real undo is exact, and so is an undo after a redo.
        s.undo(1)
        assertEquals(drawing.gatesEncoded, s.runs[1]!!.gatesEncoded)
        s.redo(1)
        s.undo(1)
        assertEquals(drawing.gatesEncoded, s.runs[1]!!.gatesEncoded)
    }
}
