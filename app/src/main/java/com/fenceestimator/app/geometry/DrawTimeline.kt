package com.fenceestimator.app.geometry

/**
 * ONE UNDO TIMELINE FOR THE WHOLE DRAWING.
 *
 * HIS WORDS: "Also I want to be able to undo that, and redo that too, I want
 * those things to work flawlessly."
 *
 * WHAT WAS THERE BEFORE, AND WHY IT COULD NOT BE FLAWLESS. [UndoHistory] keeps
 * a stack PER RUN and Undo acts on the SELECTED run. So:
 *
 *   - Undo after editing side B, with side A selected, takes back something
 *     you did to A minutes ago -- or says there is nothing to undo while the
 *     thing you just did sits on screen.
 *   - A whole-drawing move is in no stack at all. It could not be: putting
 *     back one run's snapshot would move that side home and leave the rest
 *     where they were, which is a drawing in two places.
 *   - Deleting a side is not undoable, because the stack is keyed by a run id
 *     that no longer exists.
 *
 * Those are three faces of one thing: the history is keyed by the wrong
 * subject. The subject of "undo the last thing I did" is THE DRAWING.
 *
 * WHAT THIS IS. A single ordered list of edits, newest last, each one
 * describing a change and carrying what is needed to put it back. Undo takes
 * the last edit, whatever it touched; redo puts it forward again. The pure
 * part -- ordering, staleness, bounds -- lives here and is tested off device.
 * APPLYING an edit needs the database, so the caller does that; this module
 * never touches a repository.
 *
 * STALENESS IS THE WHOLE GAME, and it is why each edit records what it WROTE
 * as well as what to restore. Between doing a thing and undoing it the office
 * can edit the same job, or another phone can. Pasting a remembered drawing
 * over newer work is worse than refusing, so an edit whose subject no longer
 * looks the way this timeline left it is dropped rather than applied. That is
 * the rule [UndoHistory] already followed per run; it holds here across every
 * kind of edit.
 *
 * EVERY FIELD IS A PRIMITIVE OR A [DrawingSnapshot], deliberately: no Room
 * entity, no repository type. That keeps the file compilable and testable
 * without Android, which is how the geometry in this package is already
 * written, and it stops the history quietly growing a dependency on a schema
 * that changes.
 */

/** Which kind of thing an edit touched, for a message that names it. */
enum class DrawSubject { SIDE, GATE, MARKER, WHOLE_DRAWING }

/**
 * Everything needed to re-create a side that was deleted.
 *
 * Only the fields that make it the same side on the plan and in the takeoff.
 * A restored side gets a NEW row; its sync id is kept so the cloud copy is
 * the same record rather than a second one beside it.
 */
data class DeletedSide(
    val syncId: String,
    val label: String,
    val pointsEncoded: String,
    val gatesEncoded: String,
    val closedLoop: Boolean,
    val isTeardown: Boolean,
    val sortOrder: Int,
    val startJoint: String,
    val endJoint: String,
)

/** Everything needed to put back a site marker that was removed. */
data class DeletedMarker(
    val syncId: String,
    val kindName: String,
    val x: Float,
    val y: Float,
    val label: String,
    val widthFt: Float,
    val heightFt: Float,
    val rotationDeg: Float,
)

/**
 * One thing the owner did, and how to undo it.
 *
 * `before` is what to put back; `after` is what the edit left behind, so the
 * timeline can tell whether anything has touched the subject since.
 */
sealed interface DrawEdit {
    val subject: DrawSubject

    /** A side's points, gates or closed flag changed. */
    data class SideChanged(
        val runId: Long,
        val before: DrawingSnapshot,
        val after: DrawingSnapshot,
    ) : DrawEdit {
        override val subject: DrawSubject
            get() = if (before.gatesEncoded != after.gatesEncoded &&
                before.pointsEncoded == after.pointsEncoded
            ) DrawSubject.GATE else DrawSubject.SIDE
    }

    /** A side was deleted. Undo re-creates it. */
    data class SideDeleted(val runId: Long, val side: DeletedSide) : DrawEdit {
        override val subject get() = DrawSubject.SIDE
    }

    /** A side was created -- by drawing it, or by an erase that split one in two. */
    data class SideAdded(val runId: Long, val side: DeletedSide) : DrawEdit {
        override val subject get() = DrawSubject.SIDE
    }

    /** A marker moved. */
    data class MarkerMoved(
        val markerId: Long,
        val beforeX: Float,
        val beforeY: Float,
        val afterX: Float,
        val afterY: Float,
    ) : DrawEdit {
        override val subject get() = DrawSubject.MARKER
    }

    /** A marker was removed. Undo puts it back. */
    data class MarkerDeleted(val markerId: Long, val marker: DeletedMarker) : DrawEdit {
        override val subject get() = DrawSubject.MARKER
    }

    /**
     * Everything moved by the same offset.
     *
     * Undone by its own negation rather than by a snapshot of every side:
     * see [WholeDrawingMove.putBack], which also says why that is right to
     * within a float rounding step and not to the last digit.
     */
    data class WholeMoved(val dx: Float, val dy: Float) : DrawEdit {
        override val subject get() = DrawSubject.WHOLE_DRAWING
    }
}

/** Why nothing was undone or redone, so the screen can say which. */
enum class TimelineRefusal {
    /** The timeline is empty. */
    NOTHING,

    /**
     * The subject of the last edit has changed since this timeline wrote it
     * -- the office edited the same job, or another phone did. Putting the
     * remembered state back would paste over newer work.
     */
    CHANGED_SINCE,
}

/** What a press should do. */
sealed interface TimelinePlan {
    data class Apply(val edit: DrawEdit) : TimelinePlan
    data class Nothing(val why: TimelineRefusal) : TimelinePlan
}

/**
 * The drawing's history: what has been done, and what has been undone.
 *
 * Immutable, like [UndoHistory] before it, so a state flow can hold it and
 * two screens cannot see different pasts.
 */
data class DrawTimeline(
    val past: List<DrawEdit> = emptyList(),
    val future: List<DrawEdit> = emptyList(),
) {
    val canUndo: Boolean get() = past.isNotEmpty()
    val canRedo: Boolean get() = future.isNotEmpty()

    /**
     * Records an edit.
     *
     * DOING SOMETHING NEW EMPTIES THE REDO SIDE, which is what every editor
     * does and the only honest answer: once the drawing has gone somewhere
     * else, the thing that was undone is no longer ahead of it.
     *
     * An edit that changed nothing is not recorded -- a corner dragged back
     * to where it started, a length retyped the same. Recording it would make
     * Undo appear to do nothing, which reads as broken.
     */
    fun record(edit: DrawEdit): DrawTimeline {
        if (isNoOp(edit)) return this
        return copy(past = (past + edit).takeLast(MAX_STEPS), future = emptyList())
    }

    /**
     * What Undo should do, given how the drawing looks NOW.
     *
     * [currentSide] answers "what does this run's drawing look like at the
     * moment", [currentMarker] the same for a marker, and either may return
     * null for "it is not there any more". The caller owns those reads; this
     * only decides.
     */
    fun planUndo(
        currentSide: (Long) -> DrawingSnapshot?,
        currentMarker: (Long) -> Pair<Float, Float>?,
    ): TimelinePlan {
        val edit = past.lastOrNull() ?: return TimelinePlan.Nothing(TimelineRefusal.NOTHING)
        return if (stillAsWeLeftIt(edit, currentSide, currentMarker)) {
            TimelinePlan.Apply(edit)
        } else {
            TimelinePlan.Nothing(TimelineRefusal.CHANGED_SINCE)
        }
    }

    /** What Redo should do. Same staleness rule, read the other way round. */
    fun planRedo(
        currentSide: (Long) -> DrawingSnapshot?,
        currentMarker: (Long) -> Pair<Float, Float>?,
    ): TimelinePlan {
        val edit = future.lastOrNull() ?: return TimelinePlan.Nothing(TimelineRefusal.NOTHING)
        return if (undoneAsWeLeftIt(edit, currentSide, currentMarker)) {
            TimelinePlan.Apply(edit)
        } else {
            TimelinePlan.Nothing(TimelineRefusal.CHANGED_SINCE)
        }
    }

    /** After an undo has actually been applied. */
    fun afterUndo(): DrawTimeline {
        val edit = past.lastOrNull() ?: return this
        return DrawTimeline(past = past.dropLast(1), future = future + edit)
    }

    /** After a redo has actually been applied. */
    fun afterRedo(): DrawTimeline {
        val edit = future.lastOrNull() ?: return this
        return DrawTimeline(past = past + edit, future = future.dropLast(1))
    }

    /**
     * A refused step is forgotten rather than left to be refused for ever.
     *
     * Once the office has edited the same side, that step can never apply
     * again; keeping it would make Undo say "changed since" at every press
     * while the steps underneath it -- which may be perfectly applicable --
     * stay out of reach behind it.
     */
    fun dropTop(): DrawTimeline =
        if (past.isEmpty()) this else copy(past = past.dropLast(1))

    /** Same, for a redo that can never apply. */
    fun dropNext(): DrawTimeline =
        if (future.isEmpty()) this else copy(future = future.dropLast(1))

    /**
     * Everything is forgotten when the drawing's SCALE changes.
     *
     * An old drawing put back onto a new scale is a different length from the
     * one it was drawn at, so every step in the history describes feet that no
     * longer exist. [UndoHistory.afterDrawingWideEdit] made the same call.
     */
    fun forgetAll(): DrawTimeline = if (past.isEmpty() && future.isEmpty()) this else DrawTimeline()

    private fun isNoOp(edit: DrawEdit): Boolean = when (edit) {
        is DrawEdit.SideChanged -> edit.before == edit.after
        is DrawEdit.MarkerMoved -> edit.beforeX == edit.afterX && edit.beforeY == edit.afterY
        is DrawEdit.WholeMoved -> !WholeDrawingMove.isUsableOffset(edit.dx, edit.dy)
        else -> false
    }

    /** Does the drawing still look the way this edit left it? */
    private fun stillAsWeLeftIt(
        edit: DrawEdit,
        currentSide: (Long) -> DrawingSnapshot?,
        currentMarker: (Long) -> Pair<Float, Float>?,
    ): Boolean = when (edit) {
        is DrawEdit.SideChanged -> currentSide(edit.runId) == edit.after
        // The side this edit deleted must still be absent. If something has
        // put it back, undoing the delete would create a second copy.
        is DrawEdit.SideDeleted -> currentSide(edit.runId) == null
        is DrawEdit.SideAdded -> currentSide(edit.runId) != null
        is DrawEdit.MarkerMoved ->
            currentMarker(edit.markerId)?.let { (x, y) -> x == edit.afterX && y == edit.afterY } == true
        is DrawEdit.MarkerDeleted -> currentMarker(edit.markerId) == null
        // A whole-drawing move leaves nothing to compare against -- it touched
        // every row, and the putBack is a translation rather than a restore,
        // so there is no remembered state to be stale. The move itself is
        // refused by WholeDrawingMove.plan if the drawing cannot take it.
        is DrawEdit.WholeMoved -> true
    }

    /** Does the drawing still look the way UNDOING this edit left it? */
    private fun undoneAsWeLeftIt(
        edit: DrawEdit,
        currentSide: (Long) -> DrawingSnapshot?,
        currentMarker: (Long) -> Pair<Float, Float>?,
    ): Boolean = when (edit) {
        is DrawEdit.SideChanged -> currentSide(edit.runId) == edit.before
        is DrawEdit.SideDeleted -> currentSide(edit.runId) != null
        is DrawEdit.SideAdded -> currentSide(edit.runId) == null
        is DrawEdit.MarkerMoved ->
            currentMarker(edit.markerId)?.let { (x, y) -> x == edit.beforeX && y == edit.beforeY } == true
        is DrawEdit.MarkerDeleted -> currentMarker(edit.markerId) != null
        is DrawEdit.WholeMoved -> true
    }

    companion object {
        /**
         * How far back Undo reaches.
         *
         * The same figure the per-run history used, now across the whole
         * drawing rather than per side -- so in practice it reaches FURTHER
         * back through one side's edits than the old stack did, not less.
         */
        const val MAX_STEPS = UndoHistory.MAX_STEPS
    }
}
