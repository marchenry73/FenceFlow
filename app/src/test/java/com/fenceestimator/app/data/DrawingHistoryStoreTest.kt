package com.fenceestimator.app.data

import com.fenceestimator.app.geometry.DrawingSnapshot
import com.fenceestimator.app.geometry.RedoHistory
import com.fenceestimator.app.geometry.UndoHistory
import com.fenceestimator.app.geometry.UndoNoneReason
import com.fenceestimator.app.geometry.UndoPlan
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * UNDO HAS TO COME BACK EXACTLY, OR IT IS A SILENT EDIT.
 *
 * The whole premise of [DrawingSnapshot] is that it holds the drawing as the
 * STORED STRINGS rather than decoded lists, so that Redo puts back byte for
 * byte what Undo took away -- a gate in the old three-part form, a coordinate
 * the office wrote with a trailing zero. Persisting that history to a file is
 * a new chance to lose exactly that property: anything that re-encodes,
 * trims, normalises or mangles a character turns "undo then redo" into a
 * small invisible change to a customer's drawing.
 *
 * So the first test here is byte-exactness against deliberately awkward
 * content, and it is the one that matters most.
 */
class DrawingHistoryStoreTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun snap(p: String, g: String, c: Boolean) = DrawingSnapshot(p, g, c)

    /** Content chosen to break a careless codec, not to look realistic. */
    private val awkward = listOf(
        "12.5,30.0;48.75,30.0;48.75,0.0",          // ordinary
        "0.0,0.0;100.00,0.0",                       // a trailing zero that must survive
        "",                                          // empty is a real value: a run with no points
        "4.0|LINE|LEFT,6.0|WALL|RIGHT",             // the pipe form
        "4.0,LINE,LEFT",                             // the old three-part form
        "x\"quote\"x",                               // quotes, which JSON must escape
        "a\\backslash\\b",                           // backslashes
        "line1\nline2",                               // a newline inside the value
        "comma,semi;colon",                          // the delimiters themselves
        "unicode é’— and emoji 🙂", // non-ASCII
        "   leading and trailing   ",                 // whitespace that must NOT be trimmed
    )

    @Test
    fun `every snapshot round-trips byte for byte`() {
        val undo = awkward.foldIndexed(UndoHistory()) { i, h, s ->
            h.record(runId = 1L, before = snap(s, s, i % 2 == 0), after = snap(s + "!", s, i % 2 == 0))
        }
        DrawingHistoryStore.saveTo(tmp.root, jobId = 7L, undo = undo, redo = RedoHistory())
        val (back, _) = DrawingHistoryStore.loadFrom(tmp.root, 7L, setOf(1L))

        assertEquals("the stack changed depth", undo.depth(1L), back.depth(1L))
        val a = undo.stacks.getValue(1L)
        val b = back.stacks.getValue(1L)
        for (i in a.indices) {
            assertEquals("restore.pointsEncoded differs at step $i", a[i].restore.pointsEncoded, b[i].restore.pointsEncoded)
            assertEquals("restore.gatesEncoded differs at step $i",  a[i].restore.gatesEncoded,  b[i].restore.gatesEncoded)
            assertEquals("restore.closedLoop differs at step $i",    a[i].restore.closedLoop,    b[i].restore.closedLoop)
            assertEquals("expected differs at step $i",              a[i].expected,              b[i].expected)
        }
        // And the whole object, so a field added to DrawingSnapshot later and
        // forgotten in the codec fails here rather than silently dropping.
        assertEquals(a, b)
    }

    /**
     * A CONTROL. Without it every assertion above would pass against a codec
     * that wrote nothing and a loader that returned the input.
     */
    @Test
    fun `the file is really written and really read back`() {
        val f = DrawingHistoryStore.fileIn(tmp.root, 7L)
        assertFalse("nothing should exist before saving", f.exists())

        val undo = UndoHistory().record(1L, snap("a", "b", false), snap("c", "d", true))
        DrawingHistoryStore.saveTo(tmp.root, 7L, undo, RedoHistory())
        assertTrue("no file was written", f.exists())
        assertTrue("the file is empty", f.length() > 0)

        // Proof the loader reads the FILE: change it on disk and watch the
        // answer change.
        val (first, _) = DrawingHistoryStore.loadFrom(tmp.root, 7L, setOf(1L))
        assertEquals(1, first.depth(1L))
        f.writeText("{}")
        val (second, _) = DrawingHistoryStore.loadFrom(tmp.root, 7L, setOf(1L))
        assertEquals("the loader is not reading the file", 0, second.depth(1L))
    }

    @Test
    fun `the redo stack survives too, and the two do not get swapped`() {
        val undo = UndoHistory().record(1L, snap("undo-restore", "ug", false), snap("undo-expected", "ug", false))
        val redo = RedoHistory().afterUndo(1L, snap("redo-restore", "rg", true), snap("redo-expected", "rg", true))
        DrawingHistoryStore.saveTo(tmp.root, 7L, undo, redo)
        val (u, r) = DrawingHistoryStore.loadFrom(tmp.root, 7L, setOf(1L))

        assertEquals("undo-restore", u.stacks.getValue(1L).single().restore.pointsEncoded)
        assertEquals("redo-restore", r.stacks.getValue(1L).single().restore.pointsEncoded)
    }

    /**
     * A run deleted while the screen was closed leaves steps that can never
     * apply. Keeping them would grow the file for ever and hand plan() a run
     * that is not there.
     */
    @Test
    fun `steps for runs that no longer exist are dropped on load`() {
        var undo = UndoHistory()
        undo = undo.record(1L, snap("keep", "", false), snap("keep2", "", false))
        undo = undo.record(99L, snap("gone", "", false), snap("gone2", "", false))
        DrawingHistoryStore.saveTo(tmp.root, 7L, undo, RedoHistory())

        val (back, _) = DrawingHistoryStore.loadFrom(tmp.root, 7L, liveRunIds = setOf(1L))
        assertEquals("the live run's history was lost", 1, back.depth(1L))
        assertEquals("a deleted run's history survived", 0, back.depth(99L))
    }

    @Test
    fun `a corrupt file costs the history and never throws`() {
        val f = DrawingHistoryStore.fileIn(tmp.root, 7L)
        for (junk in listOf("", "not json at all", "{\"undo\":", "[1,2,3]", "{\"undo\":{\"abc\":[]}}")) {
            f.writeText(junk)
            val (u, r) = DrawingHistoryStore.loadFrom(tmp.root, 7L, setOf(1L))
            assertEquals("junk <$junk> should give an empty undo", 0, u.depth(1L))
            assertEquals("junk <$junk> should give an empty redo", 0, r.depth(1L))
        }
    }

    @Test
    fun `an empty history deletes the file rather than littering one per job`() {
        val f = DrawingHistoryStore.fileIn(tmp.root, 7L)
        DrawingHistoryStore.saveTo(tmp.root, 7L, UndoHistory().record(1L, snap("a","",false), snap("b","",false)), RedoHistory())
        assertTrue(f.exists())
        DrawingHistoryStore.saveTo(tmp.root, 7L, UndoHistory(), RedoHistory())
        assertFalse("an empty history should leave no file", f.exists())
    }

    @Test
    fun `each job keeps its own history`() {
        DrawingHistoryStore.saveTo(tmp.root, 1L, UndoHistory().record(1L, snap("job1","",false), snap("x","",false)), RedoHistory())
        DrawingHistoryStore.saveTo(tmp.root, 2L, UndoHistory().record(1L, snap("job2","",false), snap("x","",false)), RedoHistory())
        assertEquals("job1", DrawingHistoryStore.loadFrom(tmp.root, 1L, setOf(1L)).first.stacks.getValue(1L).single().restore.pointsEncoded)
        assertEquals("job2", DrawingHistoryStore.loadFrom(tmp.root, 2L, setOf(1L)).first.stacks.getValue(1L).single().restore.pointsEncoded)
    }

    /**
     * THE REASON PERSISTING IS SAFE AT ALL, asserted rather than assumed.
     *
     * A step is only usable while the run still matches the drawing that edit
     * left behind. So a drawing changed while the screen was closed -- synced
     * in from the office, edited on another phone -- must be refused, not
     * pasted over. If this ever stops holding, persisted undo becomes a way
     * to silently overwrite newer work.
     */
    @Test
    fun `a reloaded step refuses to apply once the drawing has moved on`() {
        val before = snap("1,1;2,2", "", false)
        val after  = snap("1,1;2,2;3,3", "", false)
        DrawingHistoryStore.saveTo(tmp.root, 7L, UndoHistory().record(1L, before, after), RedoHistory())
        val (back, _) = DrawingHistoryStore.loadFrom(tmp.root, 7L, setOf(1L))

        // The run still looks as that edit left it: the step applies.
        val good = back.plan(1L, after)
        assertTrue("a valid step should restore, got $good", good is UndoPlan.Restore)
        assertEquals(before, (good as UndoPlan.Restore).snapshot)

        // Somebody else has since changed it: refused, with the honest reason.
        val moved = snap("1,1;2,2;9,9", "", false)
        val stale = back.plan(1L, moved)
        assertTrue("a stale step must not restore, got $stale", stale is UndoPlan.None)
        assertEquals(UndoNoneReason.DRAWING_CHANGED, (stale as UndoPlan.None).reason)

        // CONTROL: those two plans really are different answers, so the test
        // above is discriminating rather than agreeing with itself.
        assertNotEquals(good, stale)
    }
}
