package com.fenceestimator.app.ui.survey

import android.content.Context
import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FieldChange
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.data.SiteMarker
import com.fenceestimator.app.data.SiteMarkerKind
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FenceGeometryEngine
import com.fenceestimator.app.geometry.FencePoint
import com.fenceestimator.app.geometry.GateMarker
import com.fenceestimator.app.geometry.GateMounting
import com.fenceestimator.app.geometry.GateSwing
import com.fenceestimator.app.geometry.DrawingSnapshot
import com.fenceestimator.app.geometry.RedoHistory
import com.fenceestimator.app.geometry.RedoNoneReason
import com.fenceestimator.app.geometry.RedoPlan
import com.fenceestimator.app.geometry.UndoHistory
import com.fenceestimator.app.geometry.UndoNoneReason
import com.fenceestimator.app.geometry.UndoPlan
import kotlinx.coroutines.Dispatchers
import com.fenceestimator.app.cloud.CrashReporter
import com.fenceestimator.app.estimate.DrawingScale
import com.fenceestimator.app.estimate.TakeoffRefresher
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

enum class SurveyMode { DRAW, CALIBRATE, GATE, MARKER, ADJUST, PAN }

class SurveyViewModel(
    private val repository: Repository,
    private val jobId: Long,
    private val appContext: Context,
    /**
     * Whether this screen may re-price the takeoff when the drawing moves.
     *
     * False for the crew's read-only plan (CrewFencePlanScreen), which built
     * this view model only to read the drawing -- and so, through init,
     * started the re-pricing watcher on crew phones. A crew catalog has every
     * price scrubbed to zero, the product pick breaks the tie by sync id, and
     * the crew's takeoff chose different posts and panels than the office's:
     * the two phones then overwrote each other's quantities on every sync
     * (audit 2026-09-17..21, 161 flips on Woody and John Beaunissant). Even
     * when true, [TakeoffRefresher.mayReprice] is asked again at the moment of
     * re-pricing, because the drawing screen is open to crew too.
     */
    private val repriceOnDrawingChange: Boolean = true
) : ViewModel() {
    val job: StateFlow<Job?> = repository.observeJob(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    val runs: StateFlow<List<FenceRun>> = repository.observeFenceRuns(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    private val _repriceFailed = MutableStateFlow(false)

    /**
     * True when the last drawing change could not be re-priced -- the drawing
     * itself saved fine, but materials and the estimate total did not follow
     * it, and the canvas gives no other sign of that. Cleared the moment a
     * refresh succeeds, so this only ever reflects the most recent attempt.
     */
    val repriceFailed: StateFlow<Boolean> = _repriceFailed

    /**
     * Re-prices a run's materials when its drawing changes.
     *
     * Watching the runs rather than hooking every mutation is deliberate:
     * points, gates, the closed-loop toggle, Clear and typed-in footage all
     * change the takeoff, and five separate hooks is five chances to miss one.
     *
     * Debounced, because dragging a corner emits on every frame and each pass
     * rewrites line items. The first emission is the initial load, not an edit,
     * so it only establishes the baseline.
     *
     * [TakeoffRefresher] declines to act on runs that have never been priced,
     * so this cannot invent an estimate for a job nobody has estimated.
     *
     * Only on a phone that prices ([TakeoffRefresher.mayReprice]), asked at
     * the moment of re-pricing rather than once at start: the drawing screen
     * is open to crew, and a role can change while the screen is open.
     */
    @kotlinx.coroutines.FlowPreview
    private fun watchDrawingForRepricing() {
        viewModelScope.launch {
            var lastSeen: Map<Long, String>? = null
            repository.observeFenceRuns(jobId)
                .map { runs -> runs.associate { it.id to TakeoffRefresher.pricingSignature(it) } }
                .debounce(REPRICE_DEBOUNCE_MS)
                .collect { current ->
                    val previous = lastSeen
                    lastSeen = current
                    if (previous == null) return@collect
                    val movedRunIds = current.filter { (id, sig) -> previous[id] != null && previous[id] != sig }.keys
                    if (movedRunIds.isEmpty()) return@collect
                    val mayReprice = viewerMayReprice()
                    if (!mayReprice) return@collect
                    withContext(Dispatchers.IO) {
                        movedRunIds.forEach { id ->
                            repository.getFenceRun(id)?.let { run ->
                                // Swallowing this used to mean the drawing kept
                                // updating while the materials and price quietly
                                // stopped following it, with nothing on screen
                                // to say so. Now a failure is reported the same
                                // way other background failures are (see
                                // CrashReporter usage elsewhere) and flagged so
                                // the drawing screen can say so too -- cleared
                                // the moment a later refresh actually succeeds.
                                runCatching { TakeoffRefresher.refreshRun(repository, run, mayReprice) }
                                    .onSuccess { _repriceFailed.value = false }
                                    .onFailure { e ->
                                        CrashReporter.report(appContext, "survey-reprice", e)
                                        _repriceFailed.value = true
                                    }
                            }
                        }
                    }
                }
        }
    }

    /**
     * Whether the person on this phone may re-price, read from the session
     * the app already keeps. Unknown counts as no: a view model built outside
     * the app has no session to ask, and guessing generously is how a crew
     * phone briefly became an owner.
     */
    private fun viewerMayReprice(): Boolean {
        val session = (appContext.applicationContext as? com.fenceestimator.app.FenceEstimatorApp)
            ?.session?.state?.value
            ?: return false
        return TakeoffRefresher.mayReprice(session)
    }

    init {
        // The crew plan reads the drawing and must never re-price it; see
        // [repriceOnDrawingChange].
        if (repriceOnDrawingChange) watchDrawingForRepricing()
    }

    private val _selectedRunId = MutableStateFlow<Long?>(null)
    val selectedRunId: StateFlow<Long?> = _selectedRunId

    fun selectRun(id: Long) {
        _selectedRunId.value = id
    }

    fun ensureSelection() {
        if (_selectedRunId.value == null || runs.value.none { it.id == _selectedRunId.value }) {
            _selectedRunId.value = runs.value.firstOrNull()?.id
        }
    }

    /**
     * One drawing change at a time, each against the row as it is in the
     * database right now.
     *
     * Every edit here used to read the run from [runs] -- the copy the screen
     * last saw -- and write the whole row back from a coroutine. Two taps
     * inside one database round trip could each start from the same copy, and
     * the second write quietly threw away the first. Undo followed by Redo is
     * exactly that shape, and Redo has to put back the precise drawing Undo
     * took away, so edits are now queued behind this lock and each one reads
     * the run afresh ([editRun]).
     */
    private val drawingWrites = Mutex()

    /**
     * What Undo can put back, per run. See [UndoHistory].
     *
     * Every change to a run's drawing goes through [commitEdit], which records
     * the run as it was a moment before; Undo restores exactly that. Held in
     * this view model and nowhere else, so it starts empty each time the
     * drawing screen opens -- reopening a job cannot restore a drawing from an
     * earlier visit, or from another run, over what is there now.
     */
    private val _undo = MutableStateFlow(UndoHistory())

    /** What Redo can put back, per run. See [RedoHistory]. */
    private val _redo = MutableStateFlow(RedoHistory())

    /**
     * Whether Redo would do something right now, so the button can look
     * available or not. It stays pressable either way and explains itself when
     * there is nothing to redo, the same as Undo.
     */
    val canRedo: StateFlow<Boolean> = combine(_redo, runs, _selectedRunId) { history, current, id ->
        val run = current.firstOrNull { it.id == id }
        run != null && history.plan(run.id, run.drawingSnapshot()) is RedoPlan.Restore
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), false)

    private val _redoNothingToDo = MutableSharedFlow<RedoNoneReason>(extraBufferCapacity = 1)

    /** Redo's "I did nothing, and here is why" -- the counterpart of [undoNothingToDo]. */
    val redoNothingToDo: SharedFlow<RedoNoneReason> = _redoNothingToDo

    private val _lengthRefused = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    /**
     * A typed length that could not be applied -- a side whose two corners sit
     * on top of each other has no heading to stretch along. Said out loud
     * rather than closing the dialog as though it had worked.
     */
    val lengthRefused: SharedFlow<Unit> = _lengthRefused

    private fun FenceRun.drawingSnapshot() = DrawingSnapshot(pointsEncoded, gatesEncoded, closedLoop)

    /**
     * Runs [change] against a fresh read of run [runId], behind
     * [drawingWrites]. [onMissing] fires when the run no longer exists.
     */
    private fun editRun(runId: Long?, onMissing: () -> Unit = {}, change: suspend (FenceRun) -> Unit) {
        if (runId == null) {
            onMissing()
            return
        }
        viewModelScope.launch {
            drawingWrites.withLock {
                val fresh = repository.getFenceRun(runId)
                if (fresh == null || fresh.jobId != jobId) onMissing() else change(fresh)
            }
        }
    }

    /**
     * Writes [updated] over [run] as one step Undo can take back.
     *
     * The one door every ordinary drawing edit goes through -- a point added,
     * a corner dragged, a length typed, a gate placed, moved or removed, the
     * loop closed or opened, the run cleared. Undo used to be hooked to none
     * of them: it guessed, dropping the last point or gate, so undoing a drag
     * or a typed length took away a corner nobody had touched and left the
     * change itself in place. Routing every edit through here is what makes
     * "Undo takes back the last change" true for all of them, including ones
     * added later.
     *
     * [run] must be the fresh read [editRun] handed in -- the drawing as it is
     * in the database right now -- because that is what Undo will put back.
     * Called inside [drawingWrites], so nothing can land between the read and
     * this write.
     *
     * An edit that changes nothing -- a corner dragged back to where it sat,
     * the loop "closed" when it already was -- is not an edit, and stops here
     * before touching anything. [UndoHistory.record] already refused to make
     * it a step, but the Redo stack used to be emptied first regardless, so
     * undo, then a drag that went nowhere, and the Redo that was offered a
     * moment ago said there was nothing to redo. Nor is it written: every
     * write stamps `updatedAt`, and fence runs sync last-edit-wins on that
     * clock, so re-saving an unchanged drawing would make this phone's copy
     * look newer than an office change that has not come down yet.
     */
    private suspend fun commitEdit(run: FenceRun, updated: FenceRun) {
        val before = run.drawingSnapshot()
        val after = updated.drawingSnapshot()
        if (before == after) return
        _redo.update { it.afterEdit(run.id) }
        repository.updateFenceRun(updated)
        // Recorded as exactly what was written, so the next Undo can tell
        // whether anything else has touched the run since.
        _undo.update { it.record(run.id, before, after) }
    }

    /**
     * A change to the whole drawing -- its scale, its background -- after which
     * no run's history applies: an old drawing put back onto a new scale is a
     * different length from the one it was drawn at.
     */
    private fun clearDrawingHistory() {
        _undo.update { it.afterDrawingWideEdit() }
        _redo.update { it.afterDrawingWideEdit() }
    }

    private val _mode = MutableStateFlow(SurveyMode.DRAW)
    val mode: StateFlow<SurveyMode> = _mode

    private val _pendingCalibrationPoints = MutableStateFlow<List<FencePoint>>(emptyList())
    val pendingCalibrationPoints: StateFlow<List<FencePoint>> = _pendingCalibrationPoints

    fun setMode(m: SurveyMode) {
        _mode.value = m
        _pendingCalibrationPoints.value = emptyList()
    }

    fun importImage(context: Context, uri: Uri) {
        viewModelScope.launch {
            val savedPath = withContext(Dispatchers.IO) {
                val dir = File(context.filesDir, "surveys").apply { mkdirs() }
                val outFile = File(dir, "survey_${jobId}_${UUID.randomUUID()}.jpg")
                context.contentResolver.openInputStream(uri)?.use { input ->
                    FileOutputStream(outFile).use { output -> input.copyTo(output) }
                }
                outFile.absolutePath
            }
            val current = job.value ?: repository.getJob(jobId) ?: return@launch
            repository.updateJob(
                current.copy(
                    surveyImagePath = savedPath,
                    calibrationPixelsPerFoot = null,
                    calibrationKnownFeet = null
                )
            )
            clearDrawingHistory()
        }
    }

    private fun selectedRun(): FenceRun? = runs.value.firstOrNull { it.id == _selectedRunId.value }

    /**
     * The scale edits here are measured at: the one the drawing is shown at
     * ([drawingScale]), so a typed length, a snap to a whole foot and the
     * footage reported to the office all agree with the dimension printed on
     * the plan. These used to fall back to [PIXELS_PER_FOOT_GRID] on their
     * own, which is the same number for a grid of the default size but not
     * for a grid of another size that was never given a calibration. That
     * default is still what an uncalibrated photo gets, as it always did --
     * the plan shows no lengths there to disagree with.
     */
    private fun editScale(): Float = job.value?.let { drawingScale(it) } ?: PIXELS_PER_FOOT_GRID

    /**
     * Every corner already on this job, from every run, so a point being
     * placed can land exactly on one.
     *
     * Across runs on purpose. A back fence and a side fence that meet share
     * one corner post; if the two runs each keep their own corner a few
     * inches apart, the takeoff sets two posts and the crew arrives with a
     * spare. [exceptRunId] and [exceptIndex] leave out the point currently
     * being dragged, which must not snap to where it already is.
     */
    private fun snapTargets(exceptRunId: Long?, exceptIndex: Int?): List<FencePoint> =
        runs.value.flatMap { r ->
            val pts = FenceCodec.decodePoints(r.pointsEncoded)
            if (r.id == exceptRunId && exceptIndex != null)
                pts.filterIndexed { i, _ -> i != exceptIndex }
            else pts
        }

    /**
     * Where a newly drawn point should go: on a corner it was aiming at, on
     * a square heading, on a whole foot, or exactly where the finger was.
     */
    fun snapForDraw(candidate: FencePoint, enabled: Boolean): com.fenceestimator.app.geometry.SnapResult {
        val run = selectedRun()
            ?: return com.fenceestimator.app.geometry.SnapResult(candidate, com.fenceestimator.app.geometry.SnapKind.NONE)
        if (!enabled) return com.fenceestimator.app.geometry.SnapResult(candidate, com.fenceestimator.app.geometry.SnapKind.NONE)
        val pts = FenceCodec.decodePoints(run.pointsEncoded)
        return com.fenceestimator.app.geometry.snapDrawPoint(
            candidate = candidate,
            previous = pts.lastOrNull(),
            beforePrevious = pts.getOrNull(pts.size - 2),
            otherVertices = snapTargets(run.id, pts.size),
            pxPerFt = editScale(),
        )
    }

    /**
     * The same rules for a vertex being dragged rather than added. The
     * heading is judged against the segment arriving at this point, which is
     * the one the person can see moving under their finger.
     */
    fun snapForMove(index: Int, candidate: FencePoint, enabled: Boolean): com.fenceestimator.app.geometry.SnapResult {
        val run = selectedRun()
            ?: return com.fenceestimator.app.geometry.SnapResult(candidate, com.fenceestimator.app.geometry.SnapKind.NONE)
        if (!enabled) return com.fenceestimator.app.geometry.SnapResult(candidate, com.fenceestimator.app.geometry.SnapKind.NONE)
        val pts = FenceCodec.decodePoints(run.pointsEncoded)
        // The corner's other neighbour (and, round a closed loop, the one the
        // wrap-around makes) must not be a corner to join either: dropping
        // the dragged corner exactly onto it makes a side of no length.
        val avoid = buildList {
            pts.getOrNull(index + 1)?.let { add(it) }
            if (run.closedLoop && pts.size >= 3) {
                if (index == 0) add(pts.last())
                if (index == pts.lastIndex) add(pts.first())
            }
        }
        return com.fenceestimator.app.geometry.snapDrawPoint(
            candidate = candidate,
            previous = pts.getOrNull(index - 1),
            beforePrevious = pts.getOrNull(index - 2),
            otherVertices = snapTargets(run.id, index),
            pxPerFt = editScale(),
            avoid = avoid,
        )
    }

    /**
     * Adds a point that has already been snapped. Nothing here moves the
     * points already on the run -- a snap only ever positions the new one.
     */
    fun addDrawPoint(point: FencePoint) {
        editRun(_selectedRunId.value) { run ->
            val points = FenceCodec.decodePoints(run.pointsEncoded) + point
            writePoints(run, points)
        }
    }

    /**
     * Sets one segment to the length the tape actually says.
     *
     * A finger on a satellite tile is not a measuring instrument: a run
     * traced at arm's length is a few feet out, every time, and until now
     * the only correction was to drag the corner and watch a number until
     * it looked right. This is the other half of the tool -- the drawing is
     * told the measurement rather than asked to approximate it.
     *
     * The end of the segment slides along its existing heading and the rest
     * of the run travels with it, so correcting the first leg of an L does
     * not silently change the second leg the user never touched. Everything
     * downstream follows from the persisted points: the takeoff, the
     * materials and the price all recompute off this one edit, which is the
     * whole reason the drawing is worth being exact about.
     *
     * The geometry is [com.fenceestimator.app.geometry.setSideLength]: it also
     * covers a closed loop's closing side (whose chip used to do nothing when
     * tapped), carries gates along with the side they sit on, and lands the
     * corner where the takeoff measures the typed number -- not a rounding
     * error above it, which the takeoff would round up into an extra bay.
     *
     * A request with no answer -- a side with no heading, a length of zero --
     * writes nothing and is reported through [lengthRefused], so the screen
     * can say so instead of closing the dialog as though it had worked.
     */
    fun setSegmentLengthFeet(index: Int, feet: Float) {
        val pxPerFt = editScale()
        if (!feet.isFinite() || feet <= 0f || pxPerFt <= 0f) {
            _lengthRefused.tryEmit(Unit)
            return
        }
        editRun(_selectedRunId.value, onMissing = { _lengthRefused.tryEmit(Unit) }) { run ->
            val edit = com.fenceestimator.app.geometry.setSideLength(
                points = FenceCodec.decodePoints(run.pointsEncoded),
                gates = FenceCodec.decodeGates(run.gatesEncoded),
                index = index,
                feet = feet,
                pxPerFt = pxPerFt,
                closedLoop = run.closedLoop,
            )
            if (edit == null) {
                _lengthRefused.tryEmit(Unit)
                return@editRun
            }
            // One Undo step for the whole edit -- the side, every later corner
            // that travelled with it and any gate carried along -- because
            // writePoints records the run exactly as it was before all of it.
            writePoints(
                run, edit.points,
                // Left byte-for-byte alone when no gate moved, so an edit
                // that did not touch the gates does not rewrite them.
                gatesEncoded = if (edit.gatesMoved) FenceCodec.encodeGates(edit.gates) else run.gatesEncoded
            )
        }
    }

    /**
     * How long side [index] currently is, in feet -- measured by the same
     * FenceGeometryEngine.analyze the takeoff uses, closing side included --
     * or null if there is no such side.
     */
    fun segmentFeet(index: Int): Float? {
        val run = selectedRun() ?: return null
        val pxPerFt = editScale()
        return com.fenceestimator.app.geometry.sideLengthFeet(
            FenceCodec.decodePoints(run.pointsEncoded), index, pxPerFt, run.closedLoop
        )
    }

    /** True when side [index] of the selected run is the one closing its loop. */
    fun isClosingSide(index: Int): Boolean {
        val run = selectedRun() ?: return false
        return com.fenceestimator.app.geometry.isClosingSide(
            FenceCodec.decodePoints(run.pointsEncoded).size, index, run.closedLoop
        )
    }

    /**
     * Moves a single already-placed vertex -- for fixing a point without redrawing the whole run.
     *
     * One call is one Undo step. The screen calls this once per gesture, when
     * the finger lifts (the drag itself only moves a draft on screen), and
     * once per arrow-pad tap -- so Undo takes back a whole drag, not a frame of
     * it, and one nudge at a time.
     */
    fun movePoint(index: Int, point: FencePoint) {
        editRun(_selectedRunId.value) { run ->
            val points = FenceCodec.decodePoints(run.pointsEncoded).toMutableList()
            if (index !in points.indices) return@editRun
            points[index] = point
            writePoints(run, points)
        }
    }

    /**
     * One-shot events the Undo button can't express as state -- specifically
     * "I did nothing, and here is why" -- so a press that removes nothing
     * still tells the user something instead of looking broken. See
     * [UndoNoneReason].
     */
    private val _undoNothingToDo = MutableSharedFlow<UndoNoneReason>(extraBufferCapacity = 1)
    val undoNothingToDo: SharedFlow<UndoNoneReason> = _undoNothingToDo

    /**
     * Takes back the last change to the selected run, whatever it was.
     *
     * Undo used to guess instead of remember: it dropped the last point, or
     * the last gate while the gate tool was in hand. That was right only when
     * the last thing done was adding one. After dragging a middle corner or
     * typing a length, it deleted the run's far corner -- a change nobody made
     * -- and left the real one standing; closing or opening the loop could
     * never be undone at all.
     *
     * Now every edit records the drawing as it was just before ([commitEdit]),
     * and Undo puts back exactly that: the points, the gates and the closed
     * flag, byte for byte, the same way [redo] restores. What it replaced goes
     * onto the Redo stack, so Undo and Redo walk back and forth through the
     * same states.
     *
     * Only while the run still looks exactly as the last edit here left it.
     * If it has changed some other way since (synced in from the office), the
     * history is stale and is dropped rather than pasted over newer work --
     * the same rule Redo follows.
     */
    fun undoLast() {
        editRun(
            _selectedRunId.value,
            onMissing = { _undoNothingToDo.tryEmit(UndoNoneReason.NO_RUN_SELECTED) }
        ) { run ->
            val current = run.drawingSnapshot()
            when (val plan = _undo.value.plan(run.id, current)) {
                is UndoPlan.Restore -> {
                    val restored = run.copy(
                        pointsEncoded = plan.snapshot.pointsEncoded,
                        gatesEncoded = plan.snapshot.gatesEncoded,
                        closedLoop = plan.snapshot.closedLoop
                    )
                    repository.updateFenceRun(restored)
                    // A footage change is reported whichever way it goes, as
                    // it always was when Undo took a point away. A gate-only
                    // step moves no footage and so reports nothing, as before.
                    noteFootageChange(run, measure(run), measure(restored))
                    _undo.update { it.afterUndo(run.id) }
                    // [plan.snapshot] is byte-for-byte what was just written,
                    // which is what lets Redo tell whether anything has
                    // touched the run since.
                    _redo.update { it.afterUndo(run.id, current, plan.snapshot) }
                }
                is UndoPlan.None -> {
                    if (plan.reason == UndoNoneReason.DRAWING_CHANGED) {
                        _undo.update { it.forget(run.id) }
                    }
                    _undoNothingToDo.tryEmit(plan.reason)
                }
            }
        }
    }

    /**
     * Puts back what the last Undo took away, exactly -- the same points, the
     * same gates with the same width, mounting and swing, in the same order.
     *
     * Only while nothing else has touched the run since. Any other edit, here
     * or synced in from elsewhere, clears what there is to redo; a Redo that
     * pasted an old drawing over newer work would be worse than none. A press
     * with nothing to redo says why ([redoNothingToDo]), the same as Undo.
     */
    fun redo() {
        editRun(
            _selectedRunId.value,
            onMissing = { _redoNothingToDo.tryEmit(RedoNoneReason.NO_RUN_SELECTED) }
        ) { run ->
            when (val plan = _redo.value.plan(run.id, run.drawingSnapshot())) {
                is RedoPlan.Restore -> {
                    val restored = run.copy(
                        pointsEncoded = plan.snapshot.pointsEncoded,
                        gatesEncoded = plan.snapshot.gatesEncoded,
                        closedLoop = plan.snapshot.closedLoop
                    )
                    repository.updateFenceRun(restored)
                    // Same footage report Undo made when it took the point away.
                    noteFootageChange(run, measure(run), measure(restored))
                    _redo.update { it.afterRedo(run.id) }
                    // A redone edit is an edit again, so Undo can take it back
                    // -- recorded directly rather than through commitEdit,
                    // which would also empty what is left to redo.
                    _undo.update { it.record(run.id, run.drawingSnapshot(), restored.drawingSnapshot()) }
                }
                is RedoPlan.None -> {
                    if (plan.reason == RedoNoneReason.DRAWING_CHANGED) {
                        _redo.update { it.afterEdit(run.id) }
                    }
                    _redoNothingToDo.tryEmit(plan.reason)
                }
            }
        }
    }

    fun clearPoints() {
        editRun(_selectedRunId.value) { run ->
            // One Undo step brings the whole run back -- every point and gate
            // Clear took, which is what makes a mistaken Clear recoverable.
            commitEdit(run, run.copy(pointsEncoded = "", gatesEncoded = ""))
        }
    }

    fun toggleClosedLoop(closed: Boolean) {
        editRun(_selectedRunId.value) { run ->
            commitEdit(run, run.copy(closedLoop = closed))
        }
    }

    /**
     * Who is editing, so a change made in the field can be attributed. Null on
     * an owner's own phone, where there is nobody to report to.
     */
    var editorName: String? = null
    var editorRole: String? = null

    /**
     * Writes new points (and, when given, a new gate string) onto [run] as
     * one Undo step ([commitEdit]) and reports the footage change. Called from
     * inside [editRun], so [run] is the row as it is in the database now.
     */
    private suspend fun writePoints(
        run: FenceRun,
        points: List<FencePoint>,
        gatesEncoded: String = run.gatesEncoded
    ) {
        val before = measure(run, FenceCodec.decodePoints(run.pointsEncoded))
        commitEdit(
            run,
            run.copy(pointsEncoded = FenceCodec.encodePoints(points), gatesEncoded = gatesEncoded)
        )
        val after = measure(run, points)
        noteFootageChange(run, before, after)
    }

    private fun measure(run: FenceRun): Float = measure(run, FenceCodec.decodePoints(run.pointsEncoded))

    private fun measure(run: FenceRun, points: List<FencePoint>): Float {
        if (points.size < 2) return 0f
        val pxPerFt = editScale()
        return FenceGeometryEngine.analyze(points, pxPerFt, run.closedLoop).totalLinearFeet
    }

    /**
     * Records a footage change so the office sees it.
     *
     * Only worth logging when the length actually moved by something that
     * changes an order -- a foot of drift while nudging a corner is noise, and
     * a log full of noise is a log nobody reads. Footage drives the estimate,
     * the post count and the material order, so a real change the office never
     * hears about is a job that stops matching what the customer agreed to pay.
     */
    private suspend fun noteFootageChange(run: FenceRun, before: Float, after: Float) {
        val name = editorName ?: return
        if (kotlin.math.abs(after - before) < MIN_REPORTABLE_FEET) return

        // A job the sync removed while the drawing was open took its runs
        // with it, so the note has nothing to describe -- and inserting it hit
        // the foreign key and crashed. Skipped instead (see OrphanRows).
        com.fenceestimator.app.cloud.skipIfOrphaned {
            repository.recordFieldChange(
                FieldChange(
                    jobId = jobId,
                    summary = "${run.label.ifBlank { "Fence run" }}: " +
                        "${"%.0f".format(before)} ft → ${"%.0f".format(after)} ft",
                    detail = if (after > before)
                        "Longer than planned — the estimate and material order may need redoing."
                    else
                        "Shorter than planned — there may be material left over.",
                    changedBy = name,
                    changedByRole = editorRole.orEmpty()
                )
            )
        }
    }

    fun tapCalibrationPoint(point: FencePoint, onNeedDistance: (FencePoint, FencePoint) -> Unit) {
        val pts = _pendingCalibrationPoints.value + point
        if (pts.size < 2) {
            _pendingCalibrationPoints.value = pts
        } else {
            _pendingCalibrationPoints.value = emptyList()
            onNeedDistance(pts[0], pts[1])
        }
    }

    fun applyCalibration(p1: FencePoint, p2: FencePoint, knownFeet: Float) {
        val current = job.value ?: return
        val distPx = kotlin.math.hypot((p2.x - p1.x).toDouble(), (p2.y - p1.y).toDouble()).toFloat()
        if (distPx <= 0f || knownFeet <= 0f) return
        val pxPerFt = distPx / knownFeet
        viewModelScope.launch {
            repository.updateJob(current.copy(calibrationPixelsPerFoot = pxPerFt, calibrationKnownFeet = knownFeet))
            // A new scale is a new drawing as far as Undo and Redo are concerned.
            clearDrawingHistory()
        }
    }

    val siteMarkers: StateFlow<List<SiteMarker>> = repository.observeSiteMarkers(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    fun addSiteMarker(kind: SiteMarkerKind, x: Float, y: Float, label: String) {
        viewModelScope.launch {
            repository.addSiteMarker(SiteMarker(jobId = jobId, kind = kind, x = x, y = y, label = label))
        }
    }

    fun deleteSiteMarker(marker: SiteMarker) {
        viewModelScope.launch { repository.deleteSiteMarker(marker) }
    }

    /**
     * Places a gate at an exact point -- it does not need to sit on the drawn
     * fence line, and it does not need a fence at all.
     *
     * A standalone gate sale is a real job. This used to bail out when no run
     * existed, which silently threw the gate away: nothing on the grid, no
     * materials, no charge -- indistinguishable from a missed tap. Now a gate
     * placed on an empty job gets a run of its own to live on, built from the
     * same defaults a hand-added run would get, and that run becomes the
     * selection so the gate is drawn and the next action lands on it.
     */
    fun addGate(
        x: Float,
        y: Float,
        widthFt: Float,
        mounting: GateMounting = GateMounting.LINE,
        swing: GateSwing = GateSwing.IN,
        runDefaults: BusinessProfile? = null
    ) {
        viewModelScope.launch {
            drawingWrites.withLock {
                val targetId = selectedRun()?.id ?: runs.value.firstOrNull()?.id
                val run = if (targetId != null) {
                    repository.getFenceRun(targetId)?.takeIf { it.jobId == jobId } ?: return@withLock
                } else {
                    createBlankRun(runDefaults) ?: return@withLock
                }
                val gates = FenceCodec.decodeGates(run.gatesEncoded) + GateMarker(x, y, widthFt, mounting, swing)
                // On a gate-only run just created above, the drawing before is
                // the empty run, so Undo takes the gate back off and leaves the
                // run -- what the old "remove the last gate" Undo did too.
                commitEdit(run, run.copy(gatesEncoded = FenceCodec.encodeGates(gates)))
            }
        }
    }

    /**
     * Starts a second, independent fence run on this job -- the same
     * repository.createFenceRun a job already has many of ([FenceRun] rows
     * are independent by design), reached through the same helper [addGate]
     * uses to give a stray gate somewhere to live, rather than a second way
     * of making one. Selects the new run so drawing lands on it immediately.
     *
     * Unlike FenceRunListViewModel.addRun (the job screen's "Add Fence Run",
     * with its own label/type/template picker), this is a quick add from
     * inside the drawing itself -- an untitled run with the crew's saved
     * defaults, renamed and typed later wherever a run's own details are
     * edited.
     */
    fun addRun(defaults: BusinessProfile? = null) {
        viewModelScope.launch {
            drawingWrites.withLock { createBlankRun(defaults) }
        }
    }

    private suspend fun createBlankRun(defaults: BusinessProfile?): FenceRun? {
        val base = FenceRun(jobId = jobId)
        val created = if (defaults == null) base else base.copy(
            panelWidthFt = defaults.defaultPanelWidthFt,
            panelHeightFt = defaults.defaultPanelHeightFt,
            postSpacingFt = defaults.defaultPostSpacingFt,
            concreteBagsPerPost = defaults.defaultConcreteBagsPerPost
        )
        val id = repository.createFenceRun(created)
        _selectedRunId.value = id
        return repository.getFenceRun(id)
    }

    /**
     * Moves an already-placed gate. Previously a gate in the wrong spot had to
     * be deleted and re-added, which loses its width and is a poor trade for
     * something you nudge a few feet.
     *
     * Called once per drag, when the finger lifts, so a whole drag is one Undo
     * step (see [movePoint]).
     */
    fun moveGate(index: Int, x: Float, y: Float) {
        editRun(_selectedRunId.value) { run ->
            val gates = FenceCodec.decodeGates(run.gatesEncoded).toMutableList()
            if (index !in gates.indices) return@editRun
            gates[index] = gates[index].copy(x = x, y = y)
            commitEdit(run, run.copy(gatesEncoded = FenceCodec.encodeGates(gates)))
        }
    }

    /** Moves a site marker, for the same reason gates can be moved. */
    fun moveSiteMarker(marker: SiteMarker, x: Float, y: Float) {
        viewModelScope.launch {
            repository.updateSiteMarker(marker.copy(x = x, y = y))
        }
    }

    fun removeGate(gate: GateMarker) {
        editRun(_selectedRunId.value) { run ->
            val gates = FenceCodec.decodeGates(run.gatesEncoded).toMutableList()
            if (!gates.remove(gate)) return@editRun
            commitEdit(run, run.copy(gatesEncoded = FenceCodec.encodeGates(gates)))
        }
    }

    /**
     * With no survey photo, drawing happens on a fixed-scale virtual grid
     * instead -- so the scale is known automatically and there's no
     * tap-two-points calibration step. The calibration is a fixed constant
     * ([PIXELS_PER_FOOT_GRID]), set once and never touched again by display
     * changes -- so changing how the grid *looks* (gridline spacing, zoom)
     * can never silently rescale a line you already drew.
     */
    fun ensureGridCalibration() {
        val current = job.value ?: return
        if (current.surveyImagePath != null) return
        // Only seed a scale when there isn't one. This used to force the grid
        // default back on every visit, which silently threw away any scale the
        // user set by hand -- so calibrating on the grid never stuck.
        if (current.calibrationPixelsPerFoot == null) {
            viewModelScope.launch {
                repository.updateJob(
                    current.copy(
                        calibrationPixelsPerFoot = unitsPerFoot(current.gridExtentFt),
                        calibrationKnownFeet = null
                    )
                )
            }
        }
    }

    /**
     * Changes how much ground the grid covers, keeping what is already drawn
     * exactly the length it is.
     *
     * The points are stored in canvas units, so changing the scale without
     * moving them would silently reprice the job -- a 20ft fence would become
     * a 320ft one on a tighter grid. Everything drawn is therefore multiplied
     * by the same ratio the scale changed by, which leaves every measurement
     * identical and simply makes the drawing fill more of the screen.
     *
     * Gate positions are in the same canvas space as the points, so they are
     * scaled by the same ratio. They used to be written back unscaled while
     * this comment said they moved: a gate is matched to whichever side is
     * nearest its stored point, so on a rescaled drawing it re-matched to some
     * other side, or clamped to the end of one -- on the plan the crew builds
     * from. (Turning satellite on rescales to 400 ft, so any job drawn on
     * another grid size hit this.)
     */
    fun setGridExtent(extentFt: Float) {
        val current = job.value ?: return
        if (current.surveyImagePath != null) return
        if (extentFt <= 0f) return

        // The same scale the drawing is shown at ([drawingScale]); never
        // null here, since a job with a photo returned above.
        val before = drawingScale(current) ?: return
        val after = unitsPerFoot(extentFt)
        if (before <= 0f || kotlin.math.abs(before - after) < 0.0001f) {
            viewModelScope.launch { repository.updateJob(current.copy(gridExtentFt = extentFt)) }
            return
        }
        val ratio = after / before

        viewModelScope.launch {
          drawingWrites.withLock {
            // Every run is about to be rewritten; nothing on any of them can
            // be undone or redone onto the rescaled drawing.
            clearDrawingHistory()
            repository.getFenceRuns(current.id).forEach { run ->
                val points = FenceCodec.decodePoints(run.pointsEncoded)
                val gates = FenceCodec.decodeGates(run.gatesEncoded)
                if (points.isEmpty() && gates.isEmpty()) return@forEach
                repository.updateFenceRun(
                    run.copy(
                        pointsEncoded = FenceCodec.encodePoints(
                            points.map { FencePoint(it.x * ratio, it.y * ratio) }
                        ),
                        gatesEncoded = if (gates.isEmpty()) run.gatesEncoded
                        else FenceCodec.encodeGates(gates.map { it.copy(x = it.x * ratio, y = it.y * ratio) })
                    )
                )
            }
            // Site markers are in the same canvas space and would otherwise
            // end up somewhere else in the yard.
            repository.getSiteMarkers(current.id).forEach { marker ->
                repository.updateSiteMarker(marker.copy(x = marker.x * ratio, y = marker.y * ratio))
            }
            repository.updateJob(
                current.copy(
                    gridExtentFt = extentFt,
                    calibrationPixelsPerFoot = after,
                    // Squares that read sensibly at this size: about twenty
                    // across, so a 25ft grid gets roughly 1ft squares and a
                    // 400ft grid gets 20ft ones.
                    gridFeetPerSquare = (extentFt / 20f).coerceAtLeast(0.5f)
                )
            )
          }
        }
    }

    /** What came of trying to place the job on a map. */
    sealed interface SiteLocationResult {
        data class Ready(val lat: Double, val lon: Double) : SiteLocationResult
        data class Failed(val message: String) : SiteLocationResult
    }

    /**
     * Places the job on a map, geocoding its address at most once.
     *
     * Mirrors the office's openSatellite() (website/dashboard.html): if the
     * job already carries site_lat/site_lon -- because either side has
     * geocoded it before -- that is used as-is; otherwise the address is
     * looked up through quote-map's `action=geocode` (the same keyless
     * Census-then-Esri lookup the office uses) and the result is written
     * back onto the job, so satellite mode never has to ask again for a
     * property that hasn't moved.
     */
    suspend fun ensureSiteLocation(): SiteLocationResult {
        val current = job.value ?: repository.getJob(jobId)
            ?: return SiteLocationResult.Failed("This job hasn't finished loading yet.")
        val lat = current.siteLat
        val lon = current.siteLon
        if (lat != null && lon != null) return SiteLocationResult.Ready(lat, lon)
        if (current.address.isBlank()) {
            return SiteLocationResult.Failed("This job has no address yet, so there is nowhere to look.")
        }
        return when (val geocoded = com.fenceestimator.app.cloud.Satellite.geocode(current.address)) {
            is com.fenceestimator.app.cloud.Satellite.GeocodeResult.Ok -> {
                repository.updateJob(current.copy(siteLat = geocoded.lat, siteLon = geocoded.lon))
                SiteLocationResult.Ready(geocoded.lat, geocoded.lon)
            }
            is com.fenceestimator.app.cloud.Satellite.GeocodeResult.Failed ->
                SiteLocationResult.Failed(geocoded.reason)
        }
    }

    /**
     * Forces the drawing onto the office's satellite scale -- exactly 20
     * pixels per foot -- the moment satellite mode turns on. 400ft is not a
     * suggestion here: GRID_CANVAS_SIZE / 400 is exactly
     * PIXELS_PER_FOOT_GRID, which is the same pixels-per-foot
     * SatelliteAnchor (SurveyDrawScreen.kt) assumes when it places imagery
     * into this canvas -- so this can never drift from what the satellite
     * background actually draws at.
     *
     * Reuses [setGridExtent] rather than writing calibration directly, so
     * anything already drawn on a differently-scaled grid is rescaled by the
     * same ratio and keeps the real-world length it was measured at --
     * exactly what changing the grid size already guarantees. Its own guard
     * (`if (current.surveyImagePath != null) return`) is what makes this
     * satisfy the office's rule: satellite only ever sets calibration when
     * there is no survey photo to calibrate against instead.
     *
     * Refuses, rather than rescaling, when what is already drawn would not
     * fit a 400ft canvas. [setGridExtent] keeps a drawing's real-world
     * length by scaling its coordinates by the ratio of the two grids -- so
     * coming down from the 1000ft and 2000ft grid sizes (added for acreage
     * jobs) multiplies every point by 2.5 or 5, and a fence that genuinely
     * measures more than 400ft across lands outside GRID_CANVAS_SIZE
     * entirely: off the drawing, with no way back but redrawing it. A big
     * job cannot be traced on satellite at the office's scale, and saying
     * so is the only honest answer.
     *
     * The test is the drawing's own reach, not the grid size: a 60ft fence
     * sitting on a 2000ft grid still fits at 400ft and is allowed through.
     */
    suspend fun ensureSatelliteCalibration(): SatelliteCalibration {
        val current = job.value ?: return SatelliteCalibration.Ready
        if (current.surveyImagePath != null) return SatelliteCalibration.Ready
        val before = drawingScale(current) ?: return SatelliteCalibration.Ready
        val after = unitsPerFoot(SATELLITE_CANVAS_EXTENT_FT)
        if (before > 0f && after > before) {
            val reach = drawnCanvasReach(current.id)
            if (reach > 0f && reach * (after / before) > GRID_CANVAS_SIZE) {
                return SatelliteCalibration.TooBig(
                    kotlin.math.ceil((reach / before).toDouble()).toInt()
                )
            }
        }
        setGridExtent(SATELLITE_CANVAS_EXTENT_FT)
        return SatelliteCalibration.Ready
    }

    /** Whether the drawing can be put on the office's satellite scale. */
    sealed interface SatelliteCalibration {
        data object Ready : SatelliteCalibration
        /** [acrossFt]: how far the drawing already reaches, in feet. */
        data class TooBig(val acrossFt: Int) : SatelliteCalibration
    }

    /**
     * How far anything drawn on this job reaches from the canvas origin, in
     * canvas units -- points, gates and site markers, since [setGridExtent]
     * rescales all three and all three can be pushed off the canvas.
     */
    private suspend fun drawnCanvasReach(jobId: Long): Float {
        var reach = 0f
        repository.getFenceRuns(jobId).forEach { run ->
            FenceCodec.decodePoints(run.pointsEncoded).forEach {
                reach = maxOf(reach, kotlin.math.abs(it.x), kotlin.math.abs(it.y))
            }
            FenceCodec.decodeGates(run.gatesEncoded).forEach {
                reach = maxOf(reach, kotlin.math.abs(it.x), kotlin.math.abs(it.y))
            }
        }
        repository.getSiteMarkers(jobId).forEach {
            reach = maxOf(reach, kotlin.math.abs(it.x), kotlin.math.abs(it.y))
        }
        return reach
    }

    /** Puts the no-photo grid back on its default scale after a hand calibration. */
    fun resetGridCalibration() {
        val current = job.value ?: return
        viewModelScope.launch {
            repository.updateJob(
                current.copy(calibrationPixelsPerFoot = PIXELS_PER_FOOT_GRID, calibrationKnownFeet = null)
            )
            clearDrawingHistory()
        }
    }

    /** Purely a display setting (how far apart gridlines are drawn) -- never affects calibration or existing points. */
    fun setGridLineSpacingFt(feet: Float) {
        val current = job.value ?: return
        viewModelScope.launch {
            repository.updateJob(current.copy(gridFeetPerSquare = feet.coerceAtLeast(0.5f)))
        }
    }

    /** Switches a run back to photo mode by clearing the survey image (drawing starts over). */
    fun clearSurveyImage() {
        val current = job.value ?: return
        viewModelScope.launch {
            repository.updateJob(current.copy(surveyImagePath = null, calibrationPixelsPerFoot = null, calibrationKnownFeet = null))
            clearDrawingHistory()
        }
    }

    companion object {
        /**
         * Units per foot on the no-photo grid, for a job that has not chosen a
         * size. Kept as the old fixed value so existing drawings measure
         * exactly what they always did. Lives in [DrawingScale] now, so the
         * estimate side reads the same number without reaching into a view
         * model; kept here so every existing caller still compiles unchanged.
         */
        const val PIXELS_PER_FOOT_GRID = DrawingScale.PIXELS_PER_FOOT_GRID

        /**
         * Grid sizes to choose from, in feet across.
         *
         * A gate and a paddock are not the same drawing problem. At 400ft one
         * foot is about two and a half pixels on a phone and a 20ft run cannot
         * be drawn accurately; at 25ft the same run fills the screen.
         *
         * 400ft used to be the top of this list, which meant a job bigger than
         * that had nowhere to grow -- the fence kept running off the edge of
         * the grid with no size left to pick. Not truly unbounded (that needs
         * a typed-in extent, not a chip row) but 1000 and 2000 cover anything
         * a paddock or acreage job is likely to need; [setGridExtent] and
         * [DrawingScale.unitsPerFoot] both work off a plain ratio and have no
         * ceiling of their own baked in.
         */
        val GRID_SIZES_FT = listOf(25f, 50f, 100f, 200f, 400f, 1000f, 2000f)

        /**
         * The grid extent whose calibration works out to exactly 20 px/ft
         * (GRID_CANVAS_SIZE / this == PIXELS_PER_FOOT_GRID) -- the scale the
         * office's satellite tool always traces at, independent of the
         * user's own grid-size choice. See [ensureSatelliteCalibration].
         */
        const val SATELLITE_CANVAS_EXTENT_FT = 400f

        /** Units per foot for a grid covering [extentFt] across. See [DrawingScale.unitsPerFoot]. */
        fun unitsPerFoot(extentFt: Float): Float = DrawingScale.unitsPerFoot(extentFt)

        /**
         * The scale a drawing is measured at, in canvas units per foot, or
         * null when it genuinely has none yet.
         *
         * A stored calibration always wins. Without one, a grid drawing (no
         * survey photo) still has a scale: the grid's own, [unitsPerFoot] of
         * its extent -- the value [ensureGridCalibration] would have seeded
         * and the one [setGridExtent] rescales from. The drawing screen used
         * to read the stored calibration raw, so a grid job that was never
         * given one drew no gates and no lengths at all, while the estimate
         * went on pricing those same gates. Only a photo nobody has
         * calibrated has no answer: the app cannot know how big the picture
         * is, and the screen asks for a calibration instead.
         *
         * The rule itself is [DrawingScale.of], in the estimate package, so
         * Suggest seeds the scale this screen is already drawing at rather
         * than a constant of its own (which rescaled every non-400 ft grid).
         */
        fun drawingScale(calibrationPixelsPerFoot: Float?, surveyImagePath: String?, gridExtentFt: Float): Float? =
            DrawingScale.of(calibrationPixelsPerFoot, surveyImagePath, gridExtentFt)

        /** [drawingScale] for [job]. */
        fun drawingScale(job: Job): Float? = DrawingScale.of(job)

        /** Long enough that dragging a corner re-prices once, not once per frame. */
        private const val REPRICE_DEBOUNCE_MS = 700L
        /** Virtual canvas size (width == height) used when there's no survey photo -- 400ft x 400ft of drawable area. */
        const val GRID_CANVAS_SIZE = DrawingScale.GRID_CANVAS_SIZE
        /** Below this, a footage change is someone nudging a corner, not a real change. */
        const val MIN_REPORTABLE_FEET = 3f
    }
}
