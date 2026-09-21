package com.fenceestimator.app.geometry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Redo, to match Undo ([planUndo]). The guarantees:
 *  - Undo then Redo puts back EXACTLY the drawing that was there -- the same
 *    stored strings, gates included with their width, mounting and swing;
 *  - any other edit clears what there is to redo, including an edit the
 *    screen never saw (a sync from the office);
 *  - it is per run, and a press with nothing to redo says why.
 *
 * [Store] below replays the view model's own sequence -- plan, apply, write,
 * record -- over plain values, so the protocol is proved here without Room,
 * coroutines or Compose.
 */
class RedoHistoryTest {

    private fun p(x: Float, y: Float) = FencePoint(x, y)

    private fun snapshot(points: List<FencePoint>, gates: String = "", closed: Boolean = false) =
        DrawingSnapshot(FenceCodec.encodePoints(points), gates, closed)

    /** The view model's undo and redo, over an in-memory "database". */
    private class Store(initial: Map<Long, DrawingSnapshot>) {
        val runs = initial.toMutableMap()
        var history = RedoHistory()
        var lastUndoNone: UndoNoneReason? = null
        var lastRedoNone: RedoNoneReason? = null

        fun undo(runId: Long, gateMode: Boolean = false) {
            val before = runs[runId] ?: return
            val plan = planUndo(
                gateMode = gateMode,
                hasSelectedRun = true,
                pointCount = FenceCodec.decodePoints(before.pointsEncoded).size,
                gateCount = FenceCodec.decodeGates(before.gatesEncoded).size
            )
            if (plan is UndoPlan.None) { lastUndoNone = plan.reason; return }
            val after = applyUndo(before, plan)!!
            runs[runId] = after
            history = history.afterUndo(runId, before, after)
        }

        fun redo(runId: Long?) {
            when (val plan = history.plan(runId, runId?.let { runs[it] })) {
                is RedoPlan.Restore -> {
                    runs[runId!!] = plan.snapshot
                    history = history.afterRedo(runId)
                }
                is RedoPlan.None -> {
                    if (plan.reason == RedoNoneReason.DRAWING_CHANGED) history = history.afterEdit(runId!!)
                    lastRedoNone = plan.reason
                }
            }
        }

        /** Any ordinary edit made through the screen. */
        fun edit(runId: Long, change: (DrawingSnapshot) -> DrawingSnapshot) {
            runs[runId] = change(runs.getValue(runId))
            history = history.afterEdit(runId)
        }

        /** A change arriving from elsewhere (sync), which the screen never hooked. */
        fun externalChange(runId: Long, change: (DrawingSnapshot) -> DrawingSnapshot) {
            runs[runId] = change(runs.getValue(runId))
        }
    }

    // Three corners, and two gates: one in the current format, one saved in
    // the old three-part form with no mounting or swing.
    private val drawing = DrawingSnapshot(
        pointsEncoded = "1000.0:1000.0,1937.3:1000.0,1937.3:1612.25",
        gatesEncoded = "1400.0:1000.0:4.0:WALL:OUT,1937.3:1300.0:12.5",
        closedLoop = false
    )

    // ------------------------------------------------------------ round trips

    @Test
    fun `undo a point, redo it, and the drawing is exactly what it was`() {
        val s = Store(mapOf(1L to drawing))
        s.undo(1)
        assertEquals("1000.0:1000.0,1937.3:1000.0", s.runs[1]!!.pointsEncoded)
        s.redo(1)
        assertEquals(drawing, s.runs[1])
    }

    @Test
    fun `undo a gate, redo it, and it comes back byte for byte -- old format and all`() {
        val s = Store(mapOf(1L to drawing))
        s.undo(1, gateMode = true)
        s.undo(1, gateMode = true)
        assertEquals("", s.runs[1]!!.gatesEncoded)
        s.redo(1)
        s.redo(1)
        // Not "decodes the same": the very same string, so the three-part
        // gate is not silently rewritten into a four-part one by a redo.
        assertEquals(drawing.gatesEncoded, s.runs[1]!!.gatesEncoded)
        assertEquals(drawing, s.runs[1])
    }

    @Test
    fun `a mixed run of undos redoes back in reverse order to the original`() {
        val s = Store(mapOf(1L to drawing))
        val seen = mutableListOf(s.runs[1]!!)
        s.undo(1, gateMode = true); seen += s.runs[1]!!
        s.undo(1); seen += s.runs[1]!!
        s.undo(1, gateMode = true); seen += s.runs[1]!!
        s.undo(1); seen += s.runs[1]!!
        assertEquals(4, s.history.depth(1))
        // Each redo steps back through exactly the states undo passed through.
        for (i in seen.size - 2 downTo 0) {
            s.redo(1)
            assertEquals("after redo back to state $i", seen[i], s.runs[1])
        }
        assertEquals(0, s.history.depth(1))
        s.redo(1)
        assertEquals(RedoNoneReason.NOTHING_TO_REDO, s.lastRedoNone)
        assertEquals(drawing, s.runs[1])
    }

    @Test
    fun `undo after a redo keeps what is still left to redo`() {
        val s = Store(mapOf(1L to drawing))
        s.undo(1); s.undo(1)
        s.redo(1)
        s.undo(1)
        s.redo(1); s.redo(1)
        assertEquals(drawing, s.runs[1])
    }

    @Test
    fun `a closed loop round trips with its closing flag`() {
        val loop = snapshot(listOf(p(0f, 0f), p(400f, 0f), p(400f, 300f), p(0f, 300f)), closed = true)
        val s = Store(mapOf(7L to loop))
        s.undo(7)
        s.redo(7)
        assertEquals(loop, s.runs[7])
        assertTrue(s.runs[7]!!.closedLoop)
    }

    // --------------------------------------------------- edits clear the stack

    @Test
    fun `a new edit clears the redo stack`() {
        val s = Store(mapOf(1L to drawing))
        s.undo(1)
        s.edit(1) { it.copy(pointsEncoded = it.pointsEncoded + ",2100.0:1612.25") }
        s.redo(1)
        assertEquals(RedoNoneReason.NOTHING_TO_REDO, s.lastRedoNone)
        assertTrue(s.runs[1]!!.pointsEncoded.endsWith("2100.0:1612.25"))
    }

    @Test
    fun `an edit the screen never saw still stops redo pasting over it`() {
        val s = Store(mapOf(1L to drawing))
        s.undo(1)
        // The office moved a corner and it synced down.
        s.externalChange(1) { it.copy(pointsEncoded = "1000.0:1000.0,1950.0:1000.0") }
        s.redo(1)
        assertEquals(RedoNoneReason.DRAWING_CHANGED, s.lastRedoNone)
        assertEquals("1000.0:1000.0,1950.0:1000.0", s.runs[1]!!.pointsEncoded)
        // And the stale step is gone, so the next press says "nothing".
        assertEquals(0, s.history.depth(1))
    }

    @Test
    fun `closing the loop after an undo counts as an edit`() {
        val s = Store(mapOf(1L to drawing))
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
        val after = applyUndo(before, UndoPlan.RemoveLastPoint)!!
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
        val s = Store(mapOf(1L to drawing, 2L to other))
        s.undo(1)
        s.undo(2)
        s.edit(2) { it.copy(closedLoop = true) }
        // Editing run 2 did not throw away run 1's redo.
        s.redo(1)
        assertEquals(drawing, s.runs[1])
        s.redo(2)
        assertEquals(RedoNoneReason.NOTHING_TO_REDO, s.lastRedoNone)
    }

    @Test
    fun `no run selected explains itself`() {
        val s = Store(mapOf(1L to drawing))
        s.undo(1)
        s.redo(null)
        assertEquals(RedoNoneReason.NO_RUN_SELECTED, s.lastRedoNone)
        assertEquals(RedoPlan.None(RedoNoneReason.NO_RUN_SELECTED), s.history.plan(1, null))
    }

    @Test
    fun `nothing undone means nothing to redo`() {
        assertEquals(RedoPlan.None(RedoNoneReason.NOTHING_TO_REDO), RedoHistory().plan(1, drawing))
    }

    @Test
    fun `applying an undo that removes nothing gives nothing`() {
        val empty = DrawingSnapshot("", "", false)
        assertNull(applyUndo(empty, UndoPlan.RemoveLastPoint))
        assertNull(applyUndo(empty, UndoPlan.RemoveLastGate))
        assertNull(applyUndo(drawing, UndoPlan.None(UndoNoneReason.NOTHING_ON_RUN)))
    }

    @Test
    fun `undo removes what the old undo removed`() {
        // The same change the view model always made: drop the last point, or
        // the last gate -- and nothing else.
        val noPoint = applyUndo(drawing, UndoPlan.RemoveLastPoint)!!
        assertEquals(FenceCodec.decodePoints(drawing.pointsEncoded).dropLast(1), FenceCodec.decodePoints(noPoint.pointsEncoded))
        assertEquals(drawing.gatesEncoded, noPoint.gatesEncoded)
        val noGate = applyUndo(drawing, UndoPlan.RemoveLastGate)!!
        assertEquals(FenceCodec.decodeGates(drawing.gatesEncoded).dropLast(1), FenceCodec.decodeGates(noGate.gatesEncoded))
        assertEquals(drawing.pointsEncoded, noGate.pointsEncoded)
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
    fun `planted failure - a redo that put back a default gate would be caught`() {
        // A tempting shortcut: re-add the removed gate from its position and
        // width alone. It decodes to a gate in the same place -- and is still
        // wrong, because the wall mount and outward swing are gone.
        val s = Store(mapOf(1L to drawing))
        s.undo(1, gateMode = true)
        val removed = FenceCodec.decodeGates(drawing.gatesEncoded).last()
        val firstGate = FenceCodec.decodeGates(drawing.gatesEncoded).first()
        val shortcut = FenceCodec.encodeGates(
            FenceCodec.decodeGates(s.runs[1]!!.gatesEncoded) + GateMarker(removed.x, removed.y, removed.widthFt)
        )
        // The shortcut differs from the real drawing (old-format string)...
        assertNotEquals(drawing.gatesEncoded, shortcut)
        // ...and for the first gate would lose mounting and swing outright.
        assertNotEquals(firstGate, GateMarker(firstGate.x, firstGate.y, firstGate.widthFt))
        // The real redo is exact.
        s.redo(1)
        assertEquals(drawing.gatesEncoded, s.runs[1]!!.gatesEncoded)
    }
}
