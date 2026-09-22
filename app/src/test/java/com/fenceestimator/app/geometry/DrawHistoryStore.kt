package com.fenceestimator.app.geometry

/**
 * SurveyViewModel's drawing edits, Undo and Redo, replayed over plain values.
 *
 * Each method here is the body of the view model method of the same name,
 * with the database swapped for [runs]: the same decode and re-encode, the
 * same geometry call, the same history bookkeeping in the same order
 * (`commitEdit`: stop if nothing changed, else empty Redo, write, record the
 * Undo step). Shared by
 * [UndoHistoryTest] and [RedoHistoryTest] so both prove the protocol the app
 * actually runs -- a test that drove the histories some other way could pass
 * while the screen stayed broken.
 *
 * Not a test itself, so the test runner leaves it alone.
 */
internal class DrawHistoryStore(initial: Map<Long, DrawingSnapshot>) {
    val runs = initial.toMutableMap()
    var undoHistory = UndoHistory()
    var redoHistory = RedoHistory()
    var lastUndoNone: UndoNoneReason? = null
    var lastRedoNone: RedoNoneReason? = null

    fun points(runId: Long): List<FencePoint> = FenceCodec.decodePoints(runs.getValue(runId).pointsEncoded)
    fun gates(runId: Long): List<GateMarker> = FenceCodec.decodeGates(runs.getValue(runId).gatesEncoded)

    // ------------------------------------------------------------- the edits

    /** SurveyViewModel.commitEdit. */
    fun commitEdit(runId: Long, after: DrawingSnapshot) {
        val before = runs.getValue(runId)
        if (before == after) return
        redoHistory = redoHistory.afterEdit(runId)
        runs[runId] = after
        undoHistory = undoHistory.record(runId, before, after)
    }

    /** SurveyViewModel.writePoints. */
    private fun writePoints(runId: Long, points: List<FencePoint>, gatesEncoded: String = runs.getValue(runId).gatesEncoded) {
        commitEdit(runId, runs.getValue(runId).copy(pointsEncoded = FenceCodec.encodePoints(points), gatesEncoded = gatesEncoded))
    }

    fun addDrawPoint(runId: Long, point: FencePoint) {
        writePoints(runId, points(runId) + point)
    }

    fun movePoint(runId: Long, index: Int, point: FencePoint) {
        val moved = points(runId).toMutableList()
        if (index !in moved.indices) return
        moved[index] = point
        writePoints(runId, moved)
    }

    /** Returns false where the view model would report the length as refused. */
    fun setSegmentLengthFeet(runId: Long, index: Int, feet: Float, pxPerFt: Float): Boolean {
        val run = runs.getValue(runId)
        val edit = setSideLength(
            points = FenceCodec.decodePoints(run.pointsEncoded),
            gates = FenceCodec.decodeGates(run.gatesEncoded),
            index = index,
            feet = feet,
            pxPerFt = pxPerFt,
            closedLoop = run.closedLoop,
        ) ?: return false
        writePoints(
            runId, edit.points,
            gatesEncoded = if (edit.gatesMoved) FenceCodec.encodeGates(edit.gates) else run.gatesEncoded
        )
        return true
    }

    fun clearPoints(runId: Long) {
        commitEdit(runId, runs.getValue(runId).copy(pointsEncoded = "", gatesEncoded = ""))
    }

    fun toggleClosedLoop(runId: Long, closed: Boolean) {
        commitEdit(runId, runs.getValue(runId).copy(closedLoop = closed))
    }

    fun addGate(runId: Long, gate: GateMarker) {
        commitEdit(runId, runs.getValue(runId).copy(gatesEncoded = FenceCodec.encodeGates(gates(runId) + gate)))
    }

    fun moveGate(runId: Long, index: Int, x: Float, y: Float) {
        val list = gates(runId).toMutableList()
        if (index !in list.indices) return
        list[index] = list[index].copy(x = x, y = y)
        commitEdit(runId, runs.getValue(runId).copy(gatesEncoded = FenceCodec.encodeGates(list)))
    }

    fun removeGate(runId: Long, gate: GateMarker) {
        val list = gates(runId).toMutableList()
        if (!list.remove(gate)) return
        commitEdit(runId, runs.getValue(runId).copy(gatesEncoded = FenceCodec.encodeGates(list)))
    }

    /** SurveyViewModel.clearDrawingHistory -- a rescale, a calibration, a new background. */
    fun drawingWideEdit() {
        undoHistory = undoHistory.afterDrawingWideEdit()
        redoHistory = redoHistory.afterDrawingWideEdit()
    }

    /** A change arriving from elsewhere (sync), which the screen never hooked. */
    fun externalChange(runId: Long, change: (DrawingSnapshot) -> DrawingSnapshot) {
        runs[runId] = change(runs.getValue(runId))
    }

    // ------------------------------------------------------- undo and redo

    /** SurveyViewModel.undoLast. A null [runId] is "no run selected". */
    fun undo(runId: Long?) {
        if (runId == null || runId !in runs) {
            lastUndoNone = UndoNoneReason.NO_RUN_SELECTED
            return
        }
        val current = runs.getValue(runId)
        when (val plan = undoHistory.plan(runId, current)) {
            is UndoPlan.Restore -> {
                runs[runId] = plan.snapshot
                undoHistory = undoHistory.afterUndo(runId)
                redoHistory = redoHistory.afterUndo(runId, current, plan.snapshot)
            }
            is UndoPlan.None -> {
                if (plan.reason == UndoNoneReason.DRAWING_CHANGED) undoHistory = undoHistory.forget(runId)
                lastUndoNone = plan.reason
            }
        }
    }

    /** SurveyViewModel.redo. */
    fun redo(runId: Long?) {
        val current = runId?.let { runs[it] }
        when (val plan = redoHistory.plan(runId, current)) {
            is RedoPlan.Restore -> {
                runs[runId!!] = plan.snapshot
                redoHistory = redoHistory.afterRedo(runId)
                undoHistory = undoHistory.record(runId, current!!, plan.snapshot)
            }
            is RedoPlan.None -> {
                if (plan.reason == RedoNoneReason.DRAWING_CHANGED) redoHistory = redoHistory.afterEdit(runId!!)
                lastRedoNone = plan.reason
            }
        }
    }
}
