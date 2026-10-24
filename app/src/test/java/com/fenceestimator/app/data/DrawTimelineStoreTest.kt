package com.fenceestimator.app.data

import com.fenceestimator.app.geometry.DeletedMarker
import com.fenceestimator.app.geometry.DeletedSide
import com.fenceestimator.app.geometry.DrawEdit
import com.fenceestimator.app.geometry.DrawTimeline
import com.fenceestimator.app.geometry.DrawingSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * THE UNDO TIMELINE SURVIVES CLOSING THE DRAWING.
 *
 * Undo that forgets the moment you leave the screen is not the Undo anybody
 * means. These run the real store against a real directory, because the thing
 * that goes wrong with a file is never the data class -- it is the file.
 */
class DrawTimelineStoreTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private val JOB = 42L
    private val LIVE = setOf(1L, 2L)

    private fun snap(points: String, gates: String = "", closed: Boolean = false) =
        DrawingSnapshot(pointsEncoded = points, gatesEncoded = gates, closedLoop = closed)

    private fun side(syncId: String = "s1") = DeletedSide(
        syncId = syncId, label = "Side 1", pointsEncoded = "0:0,10:0", gatesEncoded = "",
        closedLoop = false, isTeardown = false, sortOrder = 3,
        startJoint = "j1", endJoint = "j2",
    )

    private fun marker(syncId: String = "m1") = DeletedMarker(
        syncId = syncId, kindName = "TREE", x = 12.5f, y = -3.25f, label = "Oak",
        widthFt = 4f, heightFt = 6f, rotationDeg = 45f,
    )

    private fun save(t: DrawTimeline) = DrawTimelineStore.saveTo(tmp.root, JOB, t)
    private fun load(live: Set<Long> = LIVE) = DrawTimelineStore.loadFrom(tmp.root, JOB, live)

    @Test
    fun `every kind of edit comes back exactly as it went in`() {
        // All six, because the `when` in the store is exhaustive and a kind
        // that serialises to nothing would be an Undo that silently forgets
        // one sort of thing -- the hardest kind of bug to notice.
        val t = DrawTimeline(
            past = listOf(
                DrawEdit.SideChanged(1L, snap("0:0,10:0"), snap("0:0,20:0", "5:0:4:LINE:LEFT", true)),
                DrawEdit.SideDeleted(3L, side("gone")),
                DrawEdit.SideAdded(1L, side("added")),
                DrawEdit.MarkerMoved(7L, 1.5f, 2.5f, 3.5f, 4.5f),
                DrawEdit.MarkerDeleted(8L, marker()),
                DrawEdit.WholeMoved(120.5f, -40.25f),
            ),
            future = listOf(DrawEdit.SideChanged(2L, snap("0:5,10:5"), snap("0:5,30:5"))),
        )
        save(t)
        // Run 3 is absent from LIVE on purpose: that is what makes the
        // SideDeleted step applicable, so this load keeps all six.
        val back = load()
        assertEquals("every past step should survive the round trip", t.past, back.past)
        assertEquals("and the redo side too", t.future, back.future)
    }

    @Test
    fun `a step for a side that no longer exists is dropped`() {
        // Otherwise the file grows for ever with steps that can never apply,
        // and Undo spends its presses refusing them.
        save(DrawTimeline(past = listOf(
            DrawEdit.SideChanged(1L, snap("a"), snap("b")),
            DrawEdit.SideChanged(99L, snap("c"), snap("d")),   // deleted since
        )))
        val back = load()
        assertEquals(1, back.past.size)
        assertEquals(1L, (back.past.single() as DrawEdit.SideChanged).runId)
    }

    @Test
    fun `undoing a delete is kept only while the side is still gone`() {
        // Restoring a side that something has already put back would create a
        // second copy of it.
        save(DrawTimeline(past = listOf(DrawEdit.SideDeleted(5L, side()))))
        assertEquals("5 is not live, so the step is still usable", 1, load(setOf(1L)).past.size)
        assertEquals("5 is back, so the step must go", 0, load(setOf(1L, 5L)).past.size)
    }

    @Test
    fun `a whole-drawing move is never pruned`() {
        // It has no subject to check: it touched every row, and putting it
        // back is a translation rather than a restore.
        save(DrawTimeline(past = listOf(DrawEdit.WholeMoved(10f, 10f))))
        assertEquals(1, load(emptySet()).past.size)
    }

    @Test
    fun `an empty timeline leaves no file behind`() {
        save(DrawTimeline(past = listOf(DrawEdit.WholeMoved(1f, 1f))))
        assertTrue(DrawTimelineStore.fileIn(tmp.root, JOB).exists())
        save(DrawTimeline())
        assertFalse(
            "an empty file per job is litter, and absent means the same thing",
            DrawTimelineStore.fileIn(tmp.root, JOB).exists(),
        )
    }

    @Test
    fun `an unreadable file costs the history and not the drawing`() {
        DrawTimelineStore.fileIn(tmp.root, JOB).writeText("{ this is not json")
        val back = load()
        assertFalse(back.canUndo)
        assertFalse(back.canRedo)
    }

    @Test
    fun `the legacy per-run file is deleted rather than migrated`() {
        // A per-run stack cannot become one ordered timeline: the thing it
        // never recorded is the order edits happened in across sides, which is
        // the whole reason for the new shape. Inventing an order would make
        // Undo take back something other than the last thing done.
        val legacy = DrawingHistoryStore.fileIn(tmp.root, JOB)
        legacy.writeText("""{"undo":{"1":[]},"redo":{}}""")
        assertTrue(legacy.exists())
        load()
        assertFalse("the old file can never be read again, so it should not linger", legacy.exists())
    }

    @Test
    fun `CANARY -- the round trip can actually fail`() {
        // If this file's comparisons were vacuous (an empty timeline compared
        // against an empty timeline), every test above would pass while the
        // store did nothing. So: save one thing, assert what comes back is
        // NOT something else.
        save(DrawTimeline(past = listOf(DrawEdit.WholeMoved(7f, 8f))))
        val back = load()
        assertEquals(DrawEdit.WholeMoved(7f, 8f), back.past.single())
        assertFalse(
            "THE CANARY DID NOT FIRE: a different move compared equal",
            back.past.single() == DrawEdit.WholeMoved(8f, 7f),
        )
    }
}
