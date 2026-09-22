package com.fenceestimator.app.geometry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Undo as a history ([UndoHistory]). The owner's report was "I'm not able to
 * undo a modification on the drawing": Undo only ever dropped the last point
 * or gate, so after a drag or a typed length it deleted the far corner of the
 * run and left the change standing, and closing the loop could not be undone
 * at all. The guarantees now:
 *  - Undo puts back EXACTLY the drawing from before the last change, whatever
 *    that change was -- the same stored strings, the closed flag included;
 *  - it walks back one change per press, and Redo walks forward again;
 *  - it is per run, bounded, emptied by a change to the whole drawing, and it
 *    never pastes an old drawing over a change it did not make.
 *
 * Driven through [DrawHistoryStore], which runs the view model's own edit
 * bodies -- the same geometry and encoding -- so what is proved is what the
 * app does, not what a hand-built history would do.
 */
class UndoHistoryTest {

    private fun p(x: Float, y: Float) = FencePoint(x, y)

    private fun snapshot(points: List<FencePoint>, gates: String = "", closed: Boolean = false) =
        DrawingSnapshot(FenceCodec.encodePoints(points), gates, closed)

    /** 10 pixels per foot, so the first side below is 20 ft. */
    private val scale = 10f

    // Four corners in a step shape, open, with a 4 ft gate on the last side.
    private val corners = listOf(p(0f, 0f), p(200f, 0f), p(200f, 100f), p(400f, 100f))
    private val run = snapshot(corners, gates = "300.0:100.0:4.0:LINE:IN")

    // -------------------------------------------------- the reported failures

    @Test
    fun `moving a middle corner then undoing puts back exactly the old points`() {
        val s = DrawHistoryStore(mapOf(1L to run))
        s.movePoint(1, 1, p(220f, 30f))
        assertEquals(p(220f, 30f), s.points(1)[1])

        s.undo(1)

        assertEquals(run, s.runs[1])
        assertEquals(corners, s.points(1))
        // The far corner nobody touched is still there.
        assertEquals(4, s.points(1).size)
        assertEquals(p(400f, 100f), s.points(1).last())
    }

    // --- Planted failure: proves the move-then-undo expectation has teeth. ---
    @Test
    fun `planted failure - the old drop-the-last-point undo fails move then undo`() {
        val s = DrawHistoryStore(mapOf(1L to run))
        s.movePoint(1, 1, p(220f, 30f))
        // What Undo used to do, whatever the last change was: drop the last
        // point (the since-removed planUndo/applyUndo pair did exactly this).
        val oldUndo = s.points(1).dropLast(1)

        s.undo(1)
        val correct = s.points(1)

        // The old result is not the drawing from before the move: it has lost
        // the far corner nobody touched...
        assertEquals(3, oldUndo.size)
        assertNotEquals(correct, oldUndo)
        // ...and still has the move it was meant to take back.
        assertEquals(p(220f, 30f), oldUndo[1])
        // The real undo is the drawing from before the move.
        assertEquals(corners, correct)
    }

    @Test
    fun `a typed length then undo restores every later corner and the gate`() {
        val s = DrawHistoryStore(mapOf(1L to run))
        assertTrue(s.setSegmentLengthFeet(1, 0, 25f, scale))
        val typed = s.points(1)
        // Every corner after the typed side travelled with it, and the gate
        // on the last side was carried along too -- all in one edit.
        for (i in 1..3) assertNotEquals("corner $i should have moved", corners[i], typed[i])
        assertNotEquals(run.gatesEncoded, s.runs[1]!!.gatesEncoded)
        assertEquals(1, s.undoHistory.depth(1))

        s.undo(1)

        // One press puts all of it back, byte for byte. (The old undo would
        // have left three corners, two of them still moved, and the gate
        // where the typed length had carried it.)
        assertEquals(run, s.runs[1])
    }

    @Test
    fun `closing the loop then undoing reopens it`() {
        val s = DrawHistoryStore(mapOf(1L to run))
        s.toggleClosedLoop(1, true)
        assertTrue(s.runs[1]!!.closedLoop)

        s.undo(1)

        assertFalse(s.runs[1]!!.closedLoop)
        assertEquals(run, s.runs[1])
    }

    @Test
    fun `opening a closed loop then undoing closes it again`() {
        val loop = run.copy(closedLoop = true)
        val s = DrawHistoryStore(mapOf(1L to loop))
        s.toggleClosedLoop(1, false)
        s.undo(1)
        assertEquals(loop, s.runs[1])
    }

    // ------------------------------------------------------------ round trips

    @Test
    fun `undo then redo round trips`() {
        val s = DrawHistoryStore(mapOf(1L to run))
        s.movePoint(1, 1, p(220f, 30f))
        val moved = s.runs[1]!!

        s.undo(1)
        assertEquals(run, s.runs[1])
        s.redo(1)
        assertEquals(moved, s.runs[1])
        // And the redone move can itself be undone again.
        s.undo(1)
        assertEquals(run, s.runs[1])
    }

    @Test
    fun `every kind of edit walks back one press at a time`() {
        val s = DrawHistoryStore(mapOf(1L to run))
        val seen = mutableListOf(s.runs[1]!!)
        s.addDrawPoint(1, p(400f, 300f)); seen += s.runs[1]!!
        s.movePoint(1, 2, p(210f, 110f)); seen += s.runs[1]!!
        assertTrue(s.setSegmentLengthFeet(1, 0, 22f, scale)); seen += s.runs[1]!!
        s.addGate(1, GateMarker(100f, 0f, 5f, GateMounting.WALL, GateSwing.OUT)); seen += s.runs[1]!!
        s.moveGate(1, 1, 120f, 0f); seen += s.runs[1]!!
        s.removeGate(1, s.gates(1).first()); seen += s.runs[1]!!
        s.toggleClosedLoop(1, true); seen += s.runs[1]!!
        s.clearPoints(1); seen += s.runs[1]!!
        assertEquals(seen.size - 1, s.undoHistory.depth(1))

        for (i in seen.size - 2 downTo 0) {
            s.undo(1)
            assertEquals("after undo back to state $i", seen[i], s.runs[1])
        }
        s.undo(1)
        assertEquals(UndoNoneReason.NOTHING_TO_UNDO, s.lastUndoNone)
        assertEquals(run, s.runs[1])
    }

    @Test
    fun `clear then undo brings the whole run back`() {
        val s = DrawHistoryStore(mapOf(1L to run))
        s.clearPoints(1)
        assertEquals("", s.runs[1]!!.pointsEncoded)
        s.undo(1)
        // Clear used to be final: the old Undo found nothing on the run.
        assertEquals(run, s.runs[1])
    }

    @Test
    fun `a gate placed on a new gate-only run undoes back to the empty run`() {
        val empty = DrawingSnapshot("", "", false)
        val s = DrawHistoryStore(mapOf(3L to empty))
        s.addGate(3, GateMarker(4000f, 4000f, 4f))
        s.undo(3)
        assertEquals(empty, s.runs[3])
    }

    @Test
    fun `a new edit after an undo clears redo but keeps the older undo steps`() {
        val s = DrawHistoryStore(mapOf(1L to run))
        s.movePoint(1, 1, p(220f, 30f))
        val moved = s.runs[1]!!
        s.toggleClosedLoop(1, true)
        s.undo(1)
        s.addGate(1, GateMarker(100f, 0f, 3f))

        s.redo(1)
        assertEquals(RedoNoneReason.NOTHING_TO_REDO, s.lastRedoNone)
        s.undo(1)
        assertEquals(moved, s.runs[1])
        s.undo(1)
        assertEquals(run, s.runs[1])
    }

    @Test
    fun `an edit that changes nothing is not a step`() {
        // An Undo that then visibly did nothing would look broken.
        val s = DrawHistoryStore(mapOf(1L to run))
        s.toggleClosedLoop(1, false)
        s.movePoint(1, 1, corners[1])
        assertEquals(0, s.undoHistory.depth(1))
        s.undo(1)
        assertEquals(UndoNoneReason.NOTHING_TO_UNDO, s.lastUndoNone)
    }

    @Test
    fun `an edit that changes nothing leaves redo where it was`() {
        val s = DrawHistoryStore(mapOf(1L to run))
        s.movePoint(1, 1, p(220f, 30f))
        val moved = s.runs[1]!!
        s.undo(1)
        assertEquals(1, s.redoHistory.depth(1))

        // The corner Undo just put back is dragged and let go exactly where it
        // sits, and the loop is "opened" when it already was.
        s.movePoint(1, 1, corners[1])
        s.toggleClosedLoop(1, false)
        assertEquals(run, s.runs[1])
        assertEquals(1, s.redoHistory.depth(1))

        // Positive control: commitEdit used to empty Redo before asking whether
        // anything had changed, and that alone takes this Redo away.
        assertEquals(
            RedoPlan.None(RedoNoneReason.NOTHING_TO_REDO),
            s.redoHistory.afterEdit(1).plan(1, s.runs[1])
        )

        s.redo(1)
        assertNull(s.lastRedoNone)
        assertEquals(moved, s.runs[1])
    }

    // ------------------------------------------------------------------ scope

    @Test
    fun `undo is per run`() {
        val other = snapshot(listOf(p(0f, 0f), p(100f, 0f)))
        val s = DrawHistoryStore(mapOf(1L to run, 2L to other))
        s.movePoint(1, 1, p(220f, 30f))
        s.addDrawPoint(2, p(100f, 100f))
        val otherAfter = s.runs[2]!!

        s.undo(1)
        assertEquals(run, s.runs[1])
        assertEquals("undoing run 1 left run 2 alone", otherAfter, s.runs[2])
        assertEquals(1, s.undoHistory.depth(2))

        // Run 1 has nothing left, and run 2's step is not offered in its place.
        s.undo(1)
        assertEquals(UndoNoneReason.NOTHING_TO_UNDO, s.lastUndoNone)
        assertEquals(run, s.runs[1])
        assertEquals(otherAfter, s.runs[2])

        s.undo(2)
        assertEquals(other, s.runs[2])
    }

    @Test
    fun `a step recorded on one run is never offered to another`() {
        val after = run.copy(closedLoop = true)
        val h = UndoHistory().record(1, run, after)
        // Even when run 2 happens to look exactly like run 1's latest drawing.
        assertEquals(UndoPlan.None(UndoNoneReason.NOTHING_TO_UNDO), h.plan(2, after))
        assertEquals(UndoPlan.Restore(run), h.plan(1, after))
    }

    @Test
    fun `a drawing-wide change clears every run`() {
        val other = snapshot(listOf(p(0f, 0f), p(100f, 0f)))
        val s = DrawHistoryStore(mapOf(1L to run, 2L to other))
        s.movePoint(1, 1, p(220f, 30f))
        s.addDrawPoint(2, p(100f, 100f))
        val one = s.runs[1]!!
        val two = s.runs[2]!!

        s.drawingWideEdit()

        assertEquals(0, s.undoHistory.depth(1))
        assertEquals(0, s.undoHistory.depth(2))
        s.undo(1)
        assertEquals(UndoNoneReason.NOTHING_TO_UNDO, s.lastUndoNone)
        assertEquals(one, s.runs[1])
        assertEquals(two, s.runs[2])
    }

    @Test
    fun `an edit the screen never saw is not overwritten by undo`() {
        val s = DrawHistoryStore(mapOf(1L to run))
        s.movePoint(1, 1, p(220f, 30f))
        // The office moved another corner and it synced down.
        s.externalChange(1) { it.copy(pointsEncoded = "0.0:0.0,220.0:30.0,200.0:100.0,500.0:100.0") }

        s.undo(1)

        assertEquals(UndoNoneReason.DRAWING_CHANGED, s.lastUndoNone)
        assertEquals("0.0:0.0,220.0:30.0,200.0:100.0,500.0:100.0", s.runs[1]!!.pointsEncoded)
        // The stale history is dropped, so the next press says "nothing".
        assertEquals(0, s.undoHistory.depth(1))
        s.undo(1)
        assertEquals(UndoNoneReason.NOTHING_TO_UNDO, s.lastUndoNone)
    }

    @Test
    fun `no run selected, or a fresh screen, explains itself`() {
        val s = DrawHistoryStore(mapOf(1L to run))
        s.undo(null)
        assertEquals(UndoNoneReason.NO_RUN_SELECTED, s.lastUndoNone)
        // A run that no longer exists is the same as no selection.
        s.undo(99)
        assertEquals(UndoNoneReason.NO_RUN_SELECTED, s.lastUndoNone)
        assertEquals(UndoPlan.None(UndoNoneReason.NO_RUN_SELECTED), UndoHistory().plan(1, null))
        // The history starts empty each time the screen opens (a job reload):
        // nothing to undo, and nothing from before to restore.
        assertEquals(UndoPlan.None(UndoNoneReason.NOTHING_TO_UNDO), UndoHistory().plan(1, run))
    }

    @Test
    fun `the stack is bounded and keeps the newest steps`() {
        fun state(i: Int) = DrawingSnapshot("$i.0:0.0", "", false)
        val total = UndoHistory.MAX_STEPS + 25
        var h = UndoHistory()
        for (i in 0 until total) h = h.record(1, state(i), state(i + 1))
        assertEquals(UndoHistory.MAX_STEPS, h.depth(1))
        // The newest step is on top...
        assertEquals(UndoPlan.Restore(state(total - 1)), h.plan(1, state(total)))
        // ...and walking all the way down stops at the oldest one kept.
        var current = state(total)
        repeat(UndoHistory.MAX_STEPS) {
            current = (h.plan(1, current) as UndoPlan.Restore).snapshot
            h = h.afterUndo(1)
        }
        assertEquals(state(25), current)
        assertEquals(UndoPlan.None(UndoNoneReason.NOTHING_TO_UNDO), h.plan(1, current))
    }
}
