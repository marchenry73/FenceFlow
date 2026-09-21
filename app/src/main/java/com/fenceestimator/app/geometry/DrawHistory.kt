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
 * What the drawing is after [plan] has been applied to [before] -- the same
 * change Undo has always made (drop the last point, or the last gate) -- or
 * null when the plan removes nothing.
 *
 * Pulled out of the view model so the pair "Undo did this, Redo undid it" can
 * be proved round-trip in a unit test rather than trusted.
 */
fun applyUndo(before: DrawingSnapshot, plan: UndoPlan): DrawingSnapshot? = when (plan) {
    UndoPlan.RemoveLastPoint -> {
        val points = FenceCodec.decodePoints(before.pointsEncoded)
        if (points.isEmpty()) null
        else before.copy(pointsEncoded = FenceCodec.encodePoints(points.dropLast(1)))
    }
    UndoPlan.RemoveLastGate -> {
        val gates = FenceCodec.decodeGates(before.gatesEncoded)
        if (gates.isEmpty()) null
        else before.copy(gatesEncoded = FenceCodec.encodeGates(gates.dropLast(1)))
    }
    is UndoPlan.None -> null
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
 * Redo, to match Undo ([planUndo]).
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
         * Enough for any real drawing -- Undo can only take back points and
         * gates that exist -- while keeping a runaway session from holding an
         * unbounded list of whole-run strings in memory.
         */
        const val MAX_STEPS = 200
    }
}
