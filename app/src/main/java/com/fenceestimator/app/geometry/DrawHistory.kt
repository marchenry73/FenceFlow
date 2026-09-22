package com.fenceestimator.app.geometry

/**
 * A run's drawing exactly as it is stored: the two encoded strings and whether
 * the run closes on itself.
 *
 * Held as the stored strings rather than as decoded lists on purpose. Redo has
 * to put back EXACTLY what Undo took away, and the strings are the only form
 * that is exact by construction: a gate saved in the old three-part form, or a
 * coordinate the office wrote with a trailing zero, comes back byte for byte
 * instead of being re-encoded into something that merely decodes the same.
 * Anything short of that and "undo, then redo" is a small, silent edit.
 */
data class DrawingSnapshot(
    val pointsEncoded: String,
    val gatesEncoded: String,
    val closedLoop: Boolean,
)

/**
 * One step Undo can take back: the drawing to [restore] -- the run as it was
 * just before the edit -- valid only while the run still looks exactly like
 * [expected], the drawing that edit left behind.
 */
data class UndoStep(val restore: DrawingSnapshot, val expected: DrawingSnapshot)

/** What pressing Undo should do next, and why not when it does nothing. */
sealed class UndoPlan {
    /** Put this drawing back on the run. */
    data class Restore(val snapshot: DrawingSnapshot) : UndoPlan()

    /** Nothing to undo, with a machine-readable reason for the UI to explain. */
    data class None(val reason: UndoNoneReason) : UndoPlan()
}

enum class UndoNoneReason {
    /** No fence run is selected at all -- draw or pick one first. */
    NO_RUN_SELECTED,

    /** Nothing has been changed on this run since the screen opened (or since the last drawing-wide change). */
    NOTHING_TO_UNDO,

    /**
     * There was something to undo, but the drawing has changed since in a way
     * this screen did not make -- a sync from the office, another phone.
     * Putting the old drawing back now would paste it over newer work, so the
     * history is stale and is dropped instead.
     */
    DRAWING_CHANGED,
}

/**
 * Undo, as a real history rather than a guess.
 *
 * Undo used to be "drop the last point, or the last gate, depending on the
 * tool in hand". That is only right when the last thing done was adding a
 * point or a gate. Drag a middle corner, or type a length for the first side,
 * and Undo took away the far corner of the run -- a change nobody made --
 * while the move itself stayed. Closing the loop could never be undone at all.
 *
 * So every change to a run's drawing now records the run as it was just
 * before ([record]), and Undo puts exactly that back: the same points, the
 * same gates, the same closed-loop flag. Whatever the edit was, Undo is its
 * inverse, which is the only meaning the button can have to somebody who just
 * made a mistake.
 *
 * Kept per run, the same as [RedoHistory]: edits on the back fence and the
 * side fence are two separate histories, and neither can be undone onto the
 * wrong run.
 *
 * Every step also records the drawing its edit produced ([UndoStep.expected]),
 * and Undo only acts while the run still matches it exactly. That is the same
 * guard Redo has, for the same reason: an edit this screen never saw (a sync
 * from the office) would otherwise be silently overwritten by an old drawing.
 *
 * Edits and Redo push, Undo pops, a change to the whole drawing empties it.
 */
data class UndoHistory(val stacks: Map<Long, List<UndoStep>> = emptyMap()) {

    /**
     * Record a change on [runId] that turned [before] into [after] -- an
     * ordinary edit, or a Redo putting an undone edit back.
     *
     * A change that changed nothing (closing a loop that was already closed, a
     * drag that ended where it began) is not a step: an Undo that then did
     * nothing visible would look broken, and would cost a press to get past.
     */
    fun record(runId: Long, before: DrawingSnapshot, after: DrawingSnapshot): UndoHistory {
        if (before == after) return this
        val stack = (stacks[runId].orEmpty() + UndoStep(restore = before, expected = after))
            .takeLast(MAX_STEPS)
        return copy(stacks = stacks + (runId to stack))
    }

    /** Remove the step a successful Undo just used. */
    fun afterUndo(runId: Long): UndoHistory {
        val stack = stacks[runId] ?: return this
        val rest = stack.dropLast(1)
        return copy(stacks = if (rest.isEmpty()) stacks - runId else stacks + (runId to rest))
    }

    /**
     * Drop everything on [runId] -- when its history turned out to be stale
     * ([UndoNoneReason.DRAWING_CHANGED]). Every older step was built on top of
     * the drawing that has now been replaced, so none of them is safe either.
     */
    fun forget(runId: Long): UndoHistory =
        if (runId in stacks) copy(stacks = stacks - runId) else this

    /** A change to the whole drawing -- its scale, its background -- clears every run. */
    fun afterDrawingWideEdit(): UndoHistory = if (stacks.isEmpty()) this else UndoHistory()

    /** How many steps [runId] could undo, for tests and nothing else. */
    fun depth(runId: Long): Int = stacks[runId]?.size ?: 0

    /**
     * What Undo would do on [runId] if it looks like [current] right now.
     *
     * [current] is null when the run does not exist (deleted, or never
     * loaded), which is reported the same as no selection: there is nothing
     * on screen for Undo to act on.
     */
    fun plan(runId: Long?, current: DrawingSnapshot?): UndoPlan {
        if (runId == null || current == null) return UndoPlan.None(UndoNoneReason.NO_RUN_SELECTED)
        val top = stacks[runId]?.lastOrNull() ?: return UndoPlan.None(UndoNoneReason.NOTHING_TO_UNDO)
        if (top.expected != current) return UndoPlan.None(UndoNoneReason.DRAWING_CHANGED)
        return UndoPlan.Restore(top.restore)
    }

    companion object {
        /**
         * The same bound Redo has. Far more presses than anybody makes to
         * back out of a mistake, while keeping a long session from holding an
         * unbounded list of whole-run strings in memory. Past it, the OLDEST
         * steps go -- the recent ones are the ones anybody wants back.
         */
        const val MAX_STEPS = RedoHistory.MAX_STEPS
    }
}

/**
 * One step Redo can take back: the drawing to [restore], valid only while the
 * run still looks exactly like [expected] -- the drawing the Undo left behind.
 */
data class RedoStep(val restore: DrawingSnapshot, val expected: DrawingSnapshot)

/** What pressing Redo should do next, and why not when it does nothing. */
sealed class RedoPlan {
    /** Put this drawing back on the run. */
    data class Restore(val snapshot: DrawingSnapshot) : RedoPlan()

    /** Nothing to redo, with a machine-readable reason for the UI to explain. */
    data class None(val reason: RedoNoneReason) : RedoPlan()
}

enum class RedoNoneReason {
    /** No fence run is selected at all. */
    NO_RUN_SELECTED,

    /** Nothing has been undone on this run since the last change. */
    NOTHING_TO_REDO,

    /**
     * Something was undone, but the drawing has changed since -- here, on
     * another phone, or in the office. Redoing now would paste an old drawing
     * over newer work, so the history is stale and is dropped instead.
     */
    DRAWING_CHANGED,
}

/**
 * Redo, to match Undo ([UndoHistory]).
 *
 * Kept per run: undoing on the back fence and then on the side fence leaves
 * two separate things to redo, each on its own run, and neither can be redone
 * onto the wrong one.
 *
 * Every step records the drawing Undo produced ([RedoStep.expected]), and Redo
 * only acts while the run still matches it exactly. That one comparison is what
 * makes "a new edit clears the redo stack" hold for every edit, including ones
 * this screen never sees -- a sync from the office, a grid rescale -- rather
 * than only for the edits somebody remembered to hook up. The view model still
 * clears the stack on its own edits ([afterEdit]) so the button greys out at
 * once instead of on the next press.
 *
 * Undo pushes, Redo pops, anything else empties that run's stack.
 */
data class RedoHistory(val stacks: Map<Long, List<RedoStep>> = emptyMap()) {

    /** Record an Undo on [runId] that turned [before] into [after]. */
    fun afterUndo(runId: Long, before: DrawingSnapshot, after: DrawingSnapshot): RedoHistory {
        val stack = (stacks[runId].orEmpty() + RedoStep(restore = before, expected = after))
            .takeLast(MAX_STEPS)
        return copy(stacks = stacks + (runId to stack))
    }

    /** Any change to [runId] other than an Undo or a Redo: nothing on it can be redone any more. */
    fun afterEdit(runId: Long): RedoHistory =
        if (runId in stacks) copy(stacks = stacks - runId) else this

    /** A change to the whole drawing -- its scale, its background -- clears every run. */
    fun afterDrawingWideEdit(): RedoHistory = if (stacks.isEmpty()) this else RedoHistory()

    /** Remove the step a successful Redo just used. */
    fun afterRedo(runId: Long): RedoHistory {
        val stack = stacks[runId] ?: return this
        val rest = stack.dropLast(1)
        return copy(stacks = if (rest.isEmpty()) stacks - runId else stacks + (runId to rest))
    }

    /** How many steps [runId] could redo, for tests and nothing else. */
    fun depth(runId: Long): Int = stacks[runId]?.size ?: 0

    /**
     * What Redo would do on [runId] if it looks like [current] right now.
     *
     * [current] is null when the run does not exist (deleted, or never
     * loaded), which is reported the same as no selection: there is nothing
     * on screen for Redo to act on.
     */
    fun plan(runId: Long?, current: DrawingSnapshot?): RedoPlan {
        if (runId == null || current == null) return RedoPlan.None(RedoNoneReason.NO_RUN_SELECTED)
        val top = stacks[runId]?.lastOrNull() ?: return RedoPlan.None(RedoNoneReason.NOTHING_TO_REDO)
        if (top.expected != current) return RedoPlan.None(RedoNoneReason.DRAWING_CHANGED)
        return RedoPlan.Restore(top.restore)
    }

    companion object {
        /**
         * Enough for any real drawing -- Redo can only hold what Undo took
         * back, and Undo is bounded the same way ([UndoHistory.MAX_STEPS]) --
         * while keeping a runaway session from holding an unbounded list of
         * whole-run strings in memory.
         */
        const val MAX_STEPS = 200
    }
}
