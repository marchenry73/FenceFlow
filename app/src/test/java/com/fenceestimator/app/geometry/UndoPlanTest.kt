package com.fenceestimator.app.geometry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * planUndo() is the pure decision Undo makes: which one thing goes next, or
 * why nothing does. Exercised directly here -- no ViewModel, no Room, no
 * Compose -- so a regression in the decision itself fails a test instead of
 * only showing up as "the button did nothing" in the field.
 */
class UndoPlanTest {

    @Test
    fun `undo after placing a point removes the point`() {
        val plan = planUndo(gateMode = false, hasSelectedRun = true, pointCount = 3, gateCount = 0)
        assertEquals(UndoPlan.RemoveLastPoint, plan)
    }

    @Test
    fun `undo after placing a gate in gate mode removes the gate`() {
        val plan = planUndo(gateMode = true, hasSelectedRun = true, pointCount = 3, gateCount = 1)
        assertEquals(UndoPlan.RemoveLastGate, plan)
    }

    @Test
    fun `undo in gate mode with no gates falls back to the last point`() {
        // Placing a gate right after drawing, with nothing to unpick but the
        // point drawn a moment ago -- Undo must not do nothing here.
        val plan = planUndo(gateMode = true, hasSelectedRun = true, pointCount = 2, gateCount = 0)
        assertEquals(UndoPlan.RemoveLastPoint, plan)
    }

    @Test
    fun `undo with only gates left removes a gate regardless of mode`() {
        val plan = planUndo(gateMode = false, hasSelectedRun = true, pointCount = 0, gateCount = 2)
        assertEquals(UndoPlan.RemoveLastGate, plan)
    }

    @Test
    fun `repeated undo walks a run back to nothing without getting stuck`() {
        var points = 4
        val gates = 0
        var guard = 0
        while (points > 0 || gates > 0) {
            val plan = planUndo(gateMode = false, hasSelectedRun = true, pointCount = points, gateCount = gates)
            when (plan) {
                UndoPlan.RemoveLastPoint -> points -= 1
                UndoPlan.RemoveLastGate -> throw AssertionError("no gates left to remove")
                is UndoPlan.None -> throw AssertionError("should not run out while points remain")
            }
            guard++
            assertTrue("undo did not terminate", guard <= 10)
        }
        assertEquals(0, points)
        // One more press once everything is gone must report why, not repeat.
        val finalPlan = planUndo(gateMode = false, hasSelectedRun = true, pointCount = 0, gateCount = 0)
        assertEquals(UndoPlan.None(UndoNoneReason.NOTHING_ON_RUN), finalPlan)
    }

    @Test
    fun `undo with no run selected explains why instead of doing nothing silently`() {
        val plan = planUndo(gateMode = false, hasSelectedRun = false, pointCount = 5, gateCount = 5)
        assertEquals(UndoPlan.None(UndoNoneReason.NO_RUN_SELECTED), plan)
    }

    @Test
    fun `undo on a closed loop with two points left still removes a point`() {
        // Closed-loop runs need at least 3 points to mean anything, but
        // Undo must keep working below that -- it's what gets a
        // mis-closed loop back to editable, not just "closed loop with too
        // few points" limbo.
        val plan = planUndo(gateMode = false, hasSelectedRun = true, pointCount = 2, gateCount = 0)
        assertEquals(UndoPlan.RemoveLastPoint, plan)
    }

    // --- Planted failure: proves this test file can actually fail. ---
    @Test
    fun `planted failure - undo must not report None while points remain`() {
        val plan = planUndo(gateMode = false, hasSelectedRun = true, pointCount = 1, gateCount = 0)
        // A broken planUndo that always returned None (the exact "nothing
        // happens" bug being fixed here) would pass every test above that
        // only checks the reason enum loosely, so assert the concrete type.
        assertTrue("expected RemoveLastPoint, got $plan", plan is UndoPlan.RemoveLastPoint)
    }
}
