package com.fenceestimator.app.geometry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * UNDO TAKES BACK THE LAST THING YOU DID -- whichever side it was on.
 *
 * "I want to be able to undo that, and redo that too, I want those things to
 * work flawlessly."
 *
 * The old history kept a stack PER RUN and undid the SELECTED run, so the
 * answer to "take back what I just did" depended on which side happened to be
 * selected. These tests are written against the behaviour he asked for, and
 * the first one FAILS for the old design by construction -- that is the point
 * of it.
 */
class DrawTimelineTest {

    private fun snap(points: String, gates: String = "", closed: Boolean = false) =
        DrawingSnapshot(pointsEncoded = points, gatesEncoded = gates, closedLoop = closed)

    /** A drawing we can answer "how does it look now" from. */
    private class World {
        val sides = mutableMapOf<Long, DrawingSnapshot?>()
        val markers = mutableMapOf<Long, Pair<Float, Float>?>()
        fun side(id: Long): DrawingSnapshot? = sides[id]
        fun marker(id: Long): Pair<Float, Float>? = markers[id]
    }

    private fun DrawTimeline.undoIn(w: World) = planUndo(w::side, w::marker)
    private fun DrawTimeline.redoIn(w: World) = planRedo(w::side, w::marker)

    @Test
    fun `undo takes back the last edit even when it was on a different side`() {
        // THE WHOLE REASON THIS EXISTS. Edit side 1, then side 2. Undo must
        // offer side 2's edit -- the last thing done -- with no notion of
        // which side is "selected" anywhere in the question.
        val w = World()
        val a0 = snap("0:0,10:0"); val a1 = snap("0:0,20:0")
        val b0 = snap("0:5,10:5"); val b1 = snap("0:5,30:5")
        w.sides[1L] = a1
        w.sides[2L] = b1

        val t = DrawTimeline()
            .record(DrawEdit.SideChanged(1L, a0, a1))
            .record(DrawEdit.SideChanged(2L, b0, b1))

        val plan = t.undoIn(w)
        assertTrue("undo refused: $plan", plan is TimelinePlan.Apply)
        val edit = (plan as TimelinePlan.Apply).edit
        assertEquals("undo must offer the LAST edit, which was side 2",
            DrawEdit.SideChanged(2L, b0, b1), edit)

        // And the one before it is still reachable underneath.
        w.sides[2L] = b0
        val next = t.afterUndo().undoIn(w)
        assertEquals(DrawEdit.SideChanged(1L, a0, a1), (next as TimelinePlan.Apply).edit)
    }

    @Test
    fun `redo puts back exactly what undo took, and new work clears it`() {
        val w = World()
        val before = snap("0:0,10:0"); val after = snap("0:0,20:0")
        w.sides[1L] = after
        var t = DrawTimeline().record(DrawEdit.SideChanged(1L, before, after))

        t = t.afterUndo()
        w.sides[1L] = before
        assertTrue(t.canRedo)
        assertTrue("redo should be offered", t.redoIn(w) is TimelinePlan.Apply)

        // Doing something NEW while a redo is pending clears it: the drawing
        // has gone somewhere else, so the undone thing is no longer ahead.
        val other = snap("0:0,30:0")
        t = t.record(DrawEdit.SideChanged(1L, before, other))
        assertFalse("new work must clear the redo side", t.canRedo)
    }

    @Test
    fun `an edit that changed nothing is never recorded`() {
        // A corner dragged back to where it started, a length retyped the
        // same. Recorded, it would make Undo appear to do nothing, which
        // reads as broken.
        val same = snap("0:0,10:0")
        assertFalse(DrawTimeline().record(DrawEdit.SideChanged(1L, same, same)).canUndo)
        assertFalse(DrawTimeline().record(DrawEdit.MarkerMoved(7L, 1f, 2f, 1f, 2f)).canUndo)
        assertFalse("a zero move is not a move",
            DrawTimeline().record(DrawEdit.WholeMoved(0f, 0f)).canUndo)
        assertFalse("a non-finite move is not a move",
            DrawTimeline().record(DrawEdit.WholeMoved(Float.NaN, 1f)).canUndo)
    }

    @Test
    fun `a side the office changed since is refused, not pasted over`() {
        // The rule that matters most. Between doing a thing and undoing it,
        // the office can edit the same job. Putting the remembered drawing
        // back would destroy newer work.
        val w = World()
        val before = snap("0:0,10:0"); val after = snap("0:0,20:0")
        val t = DrawTimeline().record(DrawEdit.SideChanged(1L, before, after))

        w.sides[1L] = snap("0:0,99:0")        // somebody else moved it
        val plan = t.undoIn(w)
        assertTrue(plan is TimelinePlan.Nothing)
        assertEquals(TimelineRefusal.CHANGED_SINCE, (plan as TimelinePlan.Nothing).why)
    }

    @Test
    fun `a step that can never apply is dropped so the ones under it are reachable`() {
        // Without this, one stale step at the top makes Undo say "changed
        // since" for ever while perfectly good steps sit behind it.
        val w = World()
        val a0 = snap("0:0,10:0"); val a1 = snap("0:0,20:0")
        val b0 = snap("0:5,10:5"); val b1 = snap("0:5,30:5")
        var t = DrawTimeline()
            .record(DrawEdit.SideChanged(1L, a0, a1))
            .record(DrawEdit.SideChanged(2L, b0, b1))

        w.sides[1L] = a1
        w.sides[2L] = snap("0:5,77:5")        // side 2 changed elsewhere
        assertTrue(t.undoIn(w) is TimelinePlan.Nothing)

        t = t.dropTop()
        val plan = t.undoIn(w)
        assertTrue("side 1's step should now be reachable", plan is TimelinePlan.Apply)
        assertEquals(DrawEdit.SideChanged(1L, a0, a1), (plan as TimelinePlan.Apply).edit)
    }

    @Test
    fun `deleting a side is undoable, and only while it is still gone`() {
        val w = World()
        val side = DeletedSide(
            syncId = "s1", label = "Side 1", pointsEncoded = "0:0,10:0", gatesEncoded = "",
            closedLoop = false, isTeardown = false, sortOrder = 0, startJoint = "", endJoint = "",
        )
        val t = DrawTimeline().record(DrawEdit.SideDeleted(1L, side))

        w.sides[1L] = null
        assertTrue("a deleted side should be restorable", t.undoIn(w) is TimelinePlan.Apply)

        // Something put it back already -- a sync, another phone. Undoing now
        // would create a second copy of the same side.
        w.sides[1L] = snap("0:0,10:0")
        assertTrue("restoring over a side that is already back must be refused",
            t.undoIn(w) is TimelinePlan.Nothing)
    }

    @Test
    fun `a marker move is undone only while it sits where the edit left it`() {
        val w = World()
        val t = DrawTimeline().record(DrawEdit.MarkerMoved(5L, 0f, 0f, 100f, 50f))
        w.markers[5L] = 100f to 50f
        assertTrue(t.undoIn(w) is TimelinePlan.Apply)
        w.markers[5L] = 7f to 7f
        assertTrue(t.undoIn(w) is TimelinePlan.Nothing)
        w.markers[5L] = null                   // deleted since
        assertTrue(t.undoIn(w) is TimelinePlan.Nothing)
    }

    @Test
    fun `a whole-drawing move is on the timeline like anything else`() {
        // It was in NO history before, because a per-run stack could only put
        // one side back and leave the rest moved.
        val w = World()
        val t = DrawTimeline().record(DrawEdit.WholeMoved(120f, -40f))
        assertTrue(t.canUndo)
        val plan = t.undoIn(w)
        assertEquals(DrawEdit.WholeMoved(120f, -40f), (plan as TimelinePlan.Apply).edit)
    }

    @Test
    fun `the timeline is bounded, keeping the most recent`() {
        var t = DrawTimeline()
        val n = DrawTimeline.MAX_STEPS + 25
        repeat(n) { i ->
            t = t.record(DrawEdit.SideChanged(1L, snap("0:0,$i:0"), snap("0:0,${i + 1}:0")))
        }
        assertEquals(DrawTimeline.MAX_STEPS, t.past.size)
        val newest = t.past.last() as DrawEdit.SideChanged
        assertEquals("the newest edit must survive", snap("0:0,$n:0"), newest.after)
    }

    @Test
    fun `a deleted side takes its steps with it, but not the step that deleted it`() {
        // Without this, Undo would refuse once per orphaned step before
        // reaching work it can actually take back -- several presses that
        // appear to do nothing.
        val gone = DeletedSide(
            syncId = "s9", label = "Side 9", pointsEncoded = "0:0,10:0", gatesEncoded = "",
            closedLoop = false, isTeardown = false, sortOrder = 0, startJoint = "", endJoint = "",
        )
        val t = DrawTimeline()
            .record(DrawEdit.SideChanged(1L, snap("0:0,10:0"), snap("0:0,20:0")))
            .record(DrawEdit.SideChanged(2L, snap("0:5,10:5"), snap("0:5,30:5")))
            .record(DrawEdit.SideDeleted(1L, gone))
            .record(DrawEdit.WholeMoved(5f, 5f))

        val after = t.forgetRun(1L)
        assertEquals("side 1's edit should be gone, the rest kept", 3, after.past.size)
        assertTrue("the step that DELETED side 1 is how it comes back",
            after.past.any { it is DrawEdit.SideDeleted })
        assertTrue("another side's work is untouched",
            after.past.any { it is DrawEdit.SideChanged && it.runId == 2L })
        assertFalse("side 1's own edit must be gone",
            after.past.any { it is DrawEdit.SideChanged && it.runId == 1L })
        assertTrue("a whole-drawing move belongs to no side",
            after.past.any { it is DrawEdit.WholeMoved })
        assertSame("forgetting a side with no steps changes nothing", after, after.forgetRun(1L))
    }

    @Test
    fun `a scale change forgets everything`() {
        // An old drawing put back onto a new scale is a different length from
        // the one it was drawn at.
        val t = DrawTimeline()
            .record(DrawEdit.SideChanged(1L, snap("0:0,10:0"), snap("0:0,20:0")))
            .afterUndo()
        assertTrue(t.canRedo)
        val cleared = t.forgetAll()
        assertFalse(cleared.canUndo)
        assertFalse(cleared.canRedo)
    }

    @Test
    fun `CANARY -- a per-run history fails the cross-side case`() {
        // The old shape, in miniature: a stack per run, undo asking only the
        // selected one. If this cannot show the difference, the first test in
        // this file is not testing anything.
        val perRun = mutableMapOf<Long, MutableList<DrawEdit>>()
        fun record(runId: Long, e: DrawEdit) { perRun.getOrPut(runId) { mutableListOf() }.add(e) }
        record(1L, DrawEdit.SideChanged(1L, snap("a"), snap("b")))
        record(2L, DrawEdit.SideChanged(2L, snap("c"), snap("d")))

        // Side 1 is selected; the last thing actually done was on side 2.
        val selected = 1L
        val offered = perRun[selected]?.lastOrNull()
        assertEquals(
            "THE CANARY DID NOT FIRE: a per-run stack offered the right edit",
            DrawEdit.SideChanged(1L, snap("a"), snap("b")), offered
        )
        // ...which is NOT the last thing done. That is the bug.
        val timeline = DrawTimeline()
            .record(DrawEdit.SideChanged(1L, snap("a"), snap("b")))
            .record(DrawEdit.SideChanged(2L, snap("c"), snap("d")))
        assertEquals(
            "the timeline must offer side 2's edit, the one actually last",
            DrawEdit.SideChanged(2L, snap("c"), snap("d")), timeline.past.last()
        )
        assertNull("sanity: nothing was recorded for a third side", perRun[3L])
    }
}
