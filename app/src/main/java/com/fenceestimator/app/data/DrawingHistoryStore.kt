package com.fenceestimator.app.data

import android.content.Context
import com.fenceestimator.app.geometry.DrawingSnapshot
import com.fenceestimator.app.geometry.RedoHistory
import com.fenceestimator.app.geometry.RedoStep
import com.fenceestimator.app.geometry.UndoHistory
import com.fenceestimator.app.geometry.UndoStep
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File

/**
 * UNDO THAT SURVIVES LEAVING THE DRAWING.
 *
 * "Undo across the whole page still only reaches back to the start of this
 * visit, not across leaving the drawing and returning to it."
 *
 * [UndoHistory] and [RedoHistory] live in SurveyViewModel as StateFlows, so
 * they die with the ViewModel -- which is every time the drawing screen
 * closes. Walk out to the estimate and back and the mistake you wanted back
 * is unreachable, even though the drawing it belongs to is untouched.
 *
 * WHY A FILE AND NOT A TABLE. A Room migration on a live app carrying real
 * job money is a cost, and this does not earn it: an undo stack is screen
 * state, not business data. It never syncs, nothing queries across it, and it
 * needs no referential integrity -- a step for a run that has gone is
 * discarded on load here, and would be refused anyway by the guard below.
 * One small JSON file per job, beside the survey photos and signatures that
 * already live in filesDir, does the whole job with no schema to migrate.
 *
 * WHY THIS IS SAFE TO PERSIST AT ALL, which was the real question. Every step
 * carries [UndoStep.expected] -- the drawing that edit left behind -- and
 * UndoHistory.plan refuses to act unless the run still matches it exactly. So
 * a drawing that changed while the screen was closed (a sync from the office,
 * another phone) does not get an old drawing pasted over it: the step is
 * reported DRAWING_CHANGED and dropped. Persisting cannot resurrect a stale
 * edit, only a still-valid one.
 *
 * And an Undo still goes through editRun/commitEdit like any other edit, so a
 * job with a customer approval gets the same withdrawal warning it would for
 * any drawing change. Persisting the history does not route around that.
 *
 * THE GEOMETRY PACKAGE STAYS PURE. Its only imports are kotlin.math, and that
 * is deliberate -- it is the layer that can be tested off a device. So the
 * serialisable shapes are mirrored HERE rather than annotating the real ones.
 * The cost is this file; the benefit is that geometry keeps no dependency on
 * kotlinx.serialization or Android.
 *
 * AND SO DOES THIS FILE, ALMOST. Every function below takes a plain [File]
 * directory, so the whole thing is testable off a device; the Context-taking
 * overloads are two lines that only resolve filesDir. This project's bugs have
 * consistently been in the half that needed a phone to exercise, and an undo
 * stack that silently fails to round-trip is exactly that kind of bug.
 */
object DrawingHistoryStore {

    /**
     * The directory name.
     *
     * DataOwnership.wipeEverything references THIS CONSTANT rather than
     * repeating the string, so the wipe list cannot drift away from it. A
     * company's drawing history surviving onto the next user of the phone is
     * the same failure as the backup table list that sat thirteen tables
     * behind what the app actually owned.
     */
    const val DIR = "drawing_history"

    // ---- the serialisable mirror of the pure types -------------------------

    @Serializable
    private data class SnapJson(val points: String, val gates: String, val closed: Boolean)

    @Serializable
    private data class StepJson(val restore: SnapJson, val expected: SnapJson)

    @Serializable
    private data class HistoryJson(
        val undo: Map<String, List<StepJson>> = emptyMap(),
        val redo: Map<String, List<StepJson>> = emptyMap(),
    )

    private fun DrawingSnapshot.toJson() = SnapJson(pointsEncoded, gatesEncoded, closedLoop)
    private fun SnapJson.toDomain() = DrawingSnapshot(points, gates, closed)

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    // ---- the testable core, on a plain directory ---------------------------

    fun fileIn(dir: File, jobId: Long): File = File(dir.apply { mkdirs() }, "$jobId.json")

    /**
     * The history for [jobId], with any step belonging to a run not in
     * [liveRunIds] discarded.
     *
     * The pruning matters: a run deleted while the screen was closed leaves
     * steps that can never apply, and keeping them would grow the file for
     * ever. Anything unreadable comes back as empty histories -- a corrupt
     * file must cost the undo stack, never the drawing.
     */
    fun loadFrom(dir: File, jobId: Long, liveRunIds: Set<Long>): Pair<UndoHistory, RedoHistory> {
        val f = fileIn(dir, jobId)
        if (!f.exists()) return UndoHistory() to RedoHistory()
        val parsed = runCatching { json.decodeFromString<HistoryJson>(f.readText()) }.getOrNull()
            ?: return UndoHistory() to RedoHistory()

        fun <T> rebuild(src: Map<String, List<StepJson>>, make: (DrawingSnapshot, DrawingSnapshot) -> T): Map<Long, List<T>> {
            val out = mutableMapOf<Long, List<T>>()
            for ((key, steps) in src) {
                // A key that is not a Long is dropped rather than crashing the
                // screen: a hand-edited or half-written file is not worth a
                // crash when the honest fallback is "no history".
                val runId = key.toLongOrNull() ?: continue
                if (runId !in liveRunIds || steps.isEmpty()) continue
                out[runId] = steps.map { make(it.restore.toDomain(), it.expected.toDomain()) }
            }
            return out
        }

        return UndoHistory(rebuild(parsed.undo) { r, e -> UndoStep(restore = r, expected = e) }) to
               RedoHistory(rebuild(parsed.redo) { r, e -> RedoStep(restore = r, expected = e) })
    }

    /**
     * Writes [undo] and [redo] for [jobId], or deletes the file when both are
     * empty -- an empty file per job on a phone with hundreds of jobs is
     * litter, and "no file" and "empty history" mean the same thing on load.
     *
     * Written to a temp file and renamed, so a process death mid-write leaves
     * the previous good history rather than a truncated one that parses to
     * nothing.
     *
     * Failure is swallowed on purpose: a full disk must not take down the
     * drawing screen. The cost of losing this is that Undo reaches back only
     * as far as it did before this file existed.
     */
    fun saveTo(dir: File, jobId: Long, undo: UndoHistory, redo: RedoHistory) {
        runCatching {
            val f = fileIn(dir, jobId)
            if (undo.stacks.isEmpty() && redo.stacks.isEmpty()) { f.delete(); return@runCatching }
            val body = HistoryJson(
                undo = undo.stacks.entries.associate { (id, steps) ->
                    id.toString() to steps.map { StepJson(it.restore.toJson(), it.expected.toJson()) }
                },
                redo = redo.stacks.entries.associate { (id, steps) ->
                    id.toString() to steps.map { StepJson(it.restore.toJson(), it.expected.toJson()) }
                },
            )
            val tmp = File(f.parentFile, f.name + ".tmp")
            tmp.writeText(json.encodeToString(body))
            if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
        }
    }

    /** Forget one job's history -- the job was deleted. */
    fun forgetIn(dir: File, jobId: Long) { runCatching { fileIn(dir, jobId).delete() } }

    // ---- the two lines that need a phone -----------------------------------

    private fun dirFor(context: Context) = File(context.filesDir, DIR)

    fun load(context: Context, jobId: Long, liveRunIds: Set<Long>) =
        loadFrom(dirFor(context), jobId, liveRunIds)

    fun save(context: Context, jobId: Long, undo: UndoHistory, redo: RedoHistory) =
        saveTo(dirFor(context), jobId, undo, redo)

    fun forget(context: Context, jobId: Long) = forgetIn(dirFor(context), jobId)
}
