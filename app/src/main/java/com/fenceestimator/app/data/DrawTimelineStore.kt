package com.fenceestimator.app.data

import android.content.Context
import com.fenceestimator.app.geometry.DeletedMarker
import com.fenceestimator.app.geometry.DeletedSide
import com.fenceestimator.app.geometry.DrawEdit
import com.fenceestimator.app.geometry.DrawTimeline
import com.fenceestimator.app.geometry.DrawingSnapshot
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File

/**
 * THE DRAWING'S UNDO TIMELINE, KEPT ACROSS VISITS.
 *
 * [DrawTimeline] lives in SurveyViewModel as a StateFlow, so it died with the
 * screen. Undo that forgets the moment you leave the drawing is not the Undo
 * anybody means -- his words were that it should "work flawlessly" -- and the
 * run it belongs to has not moved just because the screen closed. This keeps
 * one file per job, the way [DrawingHistoryStore] did for the per-run stacks
 * it replaces.
 *
 * THE OLD FILES ARE DROPPED, NOT MIGRATED. A per-run stack cannot be turned
 * into one ordered timeline: the thing it never recorded is the ORDER edits
 * happened in across sides, which is the entire reason for the new shape.
 * Inventing an order would make Undo take back something other than the last
 * thing done, which is the bug being fixed. So a legacy file is deleted on the
 * first load, and the cost is that Undo reaches back only to this visit on the
 * first open after the update.
 *
 * STALENESS IS NOT THIS FILE'S JOB. Pasting a remembered drawing over newer
 * work is refused by [DrawTimeline.planUndo], which compares each edit against
 * the drawing as it is NOW -- and that is the right place, because the office
 * can edit the same job while this file sits on disk. All this does is prune
 * what can obviously never apply (a side that no longer exists) so the file
 * does not grow for ever.
 *
 * ANYTHING UNREADABLE COMES BACK EMPTY. A corrupt or hand-edited file must
 * cost the undo history, never the drawing.
 */
object DrawTimelineStore {

    /**
     * The same directory the per-run history used, so DataOwnership's wipe
     * list already covers it: a company's drawing history surviving onto the
     * next user of the phone is the failure the wipe list exists to prevent,
     * and a new directory it did not know about would reopen it.
     */
    const val DIR = DrawingHistoryStore.DIR

    // ---- the serialisable mirror of the pure types -------------------------

    @Serializable
    private data class SnapJson(val points: String, val gates: String, val closed: Boolean)

    @Serializable
    private data class SideJson(
        val syncId: String, val label: String, val points: String, val gates: String,
        val closed: Boolean, val teardown: Boolean, val sortOrder: Int,
        val startJoint: String, val endJoint: String,
    )

    @Serializable
    private data class MarkerJson(
        val syncId: String, val kind: String, val x: Float, val y: Float,
        val label: String, val widthFt: Float, val heightFt: Float, val rotationDeg: Float,
    )

    /**
     * One edit, flat, with a [kind] tag.
     *
     * Flat and nullable rather than kotlinx polymorphism on purpose: the
     * discriminator stays a plain string this file controls, so a rename in
     * the sealed interface cannot quietly change the on-disk format of
     * everybody's saved history.
     */
    @Serializable
    private data class EditJson(
        val kind: String,
        val runId: Long = 0L,
        val markerId: Long = 0L,
        val before: SnapJson? = null,
        val after: SnapJson? = null,
        val side: SideJson? = null,
        val marker: MarkerJson? = null,
        val dx: Float = 0f,
        val dy: Float = 0f,
        val beforeX: Float = 0f,
        val beforeY: Float = 0f,
        val afterX: Float = 0f,
        val afterY: Float = 0f,
    )

    @Serializable
    private data class TimelineJson(
        val past: List<EditJson> = emptyList(),
        val future: List<EditJson> = emptyList(),
    )

    private const val SIDE_CHANGED = "sideChanged"
    private const val SIDE_DELETED = "sideDeleted"
    private const val SIDE_ADDED = "sideAdded"
    private const val MARKER_MOVED = "markerMoved"
    private const val MARKER_DELETED = "markerDeleted"
    private const val WHOLE_MOVED = "wholeMoved"

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    private fun DrawingSnapshot.toJson() = SnapJson(pointsEncoded, gatesEncoded, closedLoop)
    private fun SnapJson.toDomain() = DrawingSnapshot(points, gates, closed)

    private fun DeletedSide.toJson() = SideJson(
        syncId, label, pointsEncoded, gatesEncoded, closedLoop, isTeardown, sortOrder,
        startJoint, endJoint,
    )

    private fun SideJson.toDomain() = DeletedSide(
        syncId = syncId, label = label, pointsEncoded = points, gatesEncoded = gates,
        closedLoop = closed, isTeardown = teardown, sortOrder = sortOrder,
        startJoint = startJoint, endJoint = endJoint,
    )

    private fun DeletedMarker.toJson() = MarkerJson(
        syncId, kindName, x, y, label, widthFt, heightFt, rotationDeg,
    )

    private fun MarkerJson.toDomain() = DeletedMarker(
        syncId = syncId, kindName = kind, x = x, y = y, label = label,
        widthFt = widthFt, heightFt = heightFt, rotationDeg = rotationDeg,
    )

    /**
     * EXHAUSTIVE BY CONSTRUCTION. A `when` over the sealed [DrawEdit] does not
     * compile until every kind is handled, so a new kind of edit cannot be
     * recorded in the view model and then silently fail to persist -- which is
     * precisely the sort of hole that only shows up as "my undo forgot things"
     * weeks later.
     */
    private fun DrawEdit.toJson(): EditJson = when (this) {
        is DrawEdit.SideChanged -> EditJson(
            kind = SIDE_CHANGED, runId = runId, before = before.toJson(), after = after.toJson(),
        )
        is DrawEdit.SideDeleted -> EditJson(kind = SIDE_DELETED, runId = runId, side = side.toJson())
        is DrawEdit.SideAdded -> EditJson(kind = SIDE_ADDED, runId = runId, side = side.toJson())
        is DrawEdit.MarkerMoved -> EditJson(
            kind = MARKER_MOVED, markerId = markerId,
            beforeX = beforeX, beforeY = beforeY, afterX = afterX, afterY = afterY,
        )
        is DrawEdit.MarkerDeleted -> EditJson(
            kind = MARKER_DELETED, markerId = markerId, marker = marker.toJson(),
        )
        is DrawEdit.WholeMoved -> EditJson(kind = WHOLE_MOVED, dx = dx, dy = dy)
    }

    /** Null for anything this file cannot make sense of, which is then dropped. */
    private fun EditJson.toDomain(): DrawEdit? = when (kind) {
        SIDE_CHANGED -> {
            val b = before?.toDomain()
            val a = after?.toDomain()
            if (b == null || a == null) null else DrawEdit.SideChanged(runId, b, a)
        }
        SIDE_DELETED -> side?.toDomain()?.let { DrawEdit.SideDeleted(runId, it) }
        SIDE_ADDED -> side?.toDomain()?.let { DrawEdit.SideAdded(runId, it) }
        MARKER_MOVED -> DrawEdit.MarkerMoved(markerId, beforeX, beforeY, afterX, afterY)
        MARKER_DELETED -> marker?.toDomain()?.let { DrawEdit.MarkerDeleted(markerId, it) }
        WHOLE_MOVED -> DrawEdit.WholeMoved(dx, dy)
        else -> null
    }

    /**
     * Can this edit still possibly apply, given which runs exist?
     *
     * Only the obviously-impossible is dropped. A side edit whose run has been
     * deleted can never apply again; a step that DELETED a side can only apply
     * while that side is still gone. Markers are not checked here -- this file
     * is not told which exist -- and do not need to be: the runtime staleness
     * check refuses them.
     */
    private fun DrawEdit.couldStillApply(liveRunIds: Set<Long>): Boolean = when (this) {
        is DrawEdit.SideChanged -> runId in liveRunIds
        is DrawEdit.SideAdded -> runId in liveRunIds
        is DrawEdit.SideDeleted -> runId !in liveRunIds
        is DrawEdit.MarkerMoved -> true
        is DrawEdit.MarkerDeleted -> true
        is DrawEdit.WholeMoved -> true
    }

    // ---- the testable core, on a plain directory ---------------------------

    fun fileIn(dir: File, jobId: Long): File = File(dir.apply { mkdirs() }, "$jobId.timeline.json")

    /**
     * The timeline for [jobId], pruned of what can never apply.
     *
     * Deletes the legacy per-run file as a side effect: it can never be read
     * again (see the note at the top about why it is not migrated), and
     * leaving it would keep one dead file per job on the phone for ever.
     */
    fun loadFrom(dir: File, jobId: Long, liveRunIds: Set<Long>): DrawTimeline {
        runCatching { DrawingHistoryStore.fileIn(dir, jobId).delete() }
        val f = fileIn(dir, jobId)
        if (!f.exists()) return DrawTimeline()
        val parsed = runCatching { json.decodeFromString<TimelineJson>(f.readText()) }.getOrNull()
            ?: return DrawTimeline()
        fun rebuild(src: List<EditJson>) =
            src.mapNotNull { it.toDomain() }.filter { it.couldStillApply(liveRunIds) }
        return DrawTimeline(past = rebuild(parsed.past), future = rebuild(parsed.future))
    }

    /**
     * Writes [timeline] for [jobId], or deletes the file when it is empty: an
     * empty file per job on a phone with hundreds of jobs is litter, and "no
     * file" and "empty timeline" mean the same thing on load.
     *
     * Temp file then rename, so a process death mid-write leaves the previous
     * good timeline rather than a truncated one that parses to nothing.
     *
     * Failure is swallowed on purpose: a full disk must not take down the
     * drawing screen. The cost of losing this is that Undo reaches back only
     * as far as this visit.
     */
    fun saveTo(dir: File, jobId: Long, timeline: DrawTimeline) {
        runCatching {
            val f = fileIn(dir, jobId)
            if (timeline.past.isEmpty() && timeline.future.isEmpty()) {
                f.delete()
                return@runCatching
            }
            val body = TimelineJson(
                past = timeline.past.map { it.toJson() },
                future = timeline.future.map { it.toJson() },
            )
            val tmp = File(f.parentFile, f.name + ".tmp")
            tmp.writeText(json.encodeToString(body))
            if (!tmp.renameTo(f)) {
                f.delete()
                tmp.renameTo(f)
            }
        }
    }

    // ---- what the view model calls ----------------------------------------

    private fun dirFor(context: Context) = File(context.filesDir, DIR)

    fun load(context: Context, jobId: Long, liveRunIds: Set<Long>): DrawTimeline =
        loadFrom(dirFor(context), jobId, liveRunIds)

    fun save(context: Context, jobId: Long, timeline: DrawTimeline) =
        saveTo(dirFor(context), jobId, timeline)
}
