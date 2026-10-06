package com.fenceestimator.app.ui.survey

import android.content.Context
import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
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
import com.fenceestimator.app.geometry.JoinCandidateRun
import com.fenceestimator.app.geometry.JoinDecision
import com.fenceestimator.app.geometry.JoinEffect
import com.fenceestimator.app.geometry.JoinEnd
import com.fenceestimator.app.geometry.JoinRefusal
import com.fenceestimator.app.geometry.JointMarker
import com.fenceestimator.app.geometry.RunJoinGesture
import com.fenceestimator.app.geometry.DrawingSnapshot
import com.fenceestimator.app.geometry.RedoHistory
import com.fenceestimator.app.geometry.RedoNoneReason
import com.fenceestimator.app.geometry.RedoPlan
import com.fenceestimator.app.geometry.UndoHistory
import com.fenceestimator.app.geometry.UndoNoneReason
import com.fenceestimator.app.geometry.UndoPlan
import kotlinx.coroutines.Dispatchers
import com.fenceestimator.app.cloud.CrashReporter
import com.fenceestimator.app.estimate.DrawingFit
import com.fenceestimator.app.estimate.DrawingScale
import com.fenceestimator.app.estimate.GridBackdropPlan
import com.fenceestimator.app.estimate.PhotoFit
import com.fenceestimator.app.estimate.TakeoffRefresher
import com.fenceestimator.app.ui.runs.RunTypeChange
import kotlinx.coroutines.NonCancellable
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

enum class SurveyMode { DRAW, CALIBRATE, GATE, MARKER, ADJUST, JOIN, PAN }

/**
 * An attachment (or a detachment) waiting for him to say yes, and what it does
 * to the materials if he does.
 *
 * Held as one object so the confirmation cannot show figures worked out from a
 * different drawing than the one the write will act on: the decision, the
 * ends, the effect and the approval question are all taken in the same breath
 * (SurveyViewModel.tapJoinEnd).
 *
 * [effect] is null when the attachment changes no material at all -- two
 * teardown runs bill no posts, and a run with nothing measurable drawn has no
 * post to give up. Null has to be SAID, not rounded down to zero: a
 * confirmation that claims a saving it cannot deliver is the fake feature this
 * whole thing was told not to be.
 */
data class JoinOffer(
    /** True when this takes a shared post apart; false when it makes one. */
    val detach: Boolean,
    /** For an attach, the post both ends go to. For a detach, the post being broken up. */
    val decision: JoinDecision,
    /** The end being freed. Null unless [detach]. */
    val end: JoinEnd?,
    /** What the order loses (attach) or gains back (detach); null when nothing moves. */
    val effect: JoinEffect?,
    /** The sync ids of every run that meets at the post, lowest first. */
    val memberRunIds: List<String>,
    /** True when a customer approval is on the line and he has to be told first. */
    val approvalAtRisk: Boolean,
    /**
     * The corner this attach will MOVE so the two ends become one point, or
     * null when nothing moves (both ends are already on one point, which is
     * every join made from a draw snap).
     *
     * His words, on seeing the first version: "When I attach them together, I
     * need to see the line move there too so there is no confusion, need it to
     * be more seamless than that." So an attach now closes the gap, the dialog
     * names the side that moves and the footage it gains or loses, and a gap
     * too wide to close is refused outright
     * ([com.fenceestimator.app.geometry.JoinRefusal.TOO_FAR_APART]) rather
     * than recorded as a join across the yard.
     *
     * Always null on a detach: taking a post apart puts no corner back. See
     * [confirmJoinOffer].
     */
    val gapCloser: RunJoinGesture.JoinGapCloser? = null,
)

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
                                // priceUnpriced: a side he has JUST DRAWN has no
                                // lines yet, and without this it falls out of
                                // refreshRun and never gets priced until he
                                // presses Suggest Quantities once by hand. On
                                // the drawing screen, drawing a side is asking
                                // for it to be priced.
                                runCatching {
                                    TakeoffRefresher.refreshRun(
                                        repository, run, mayReprice, priceUnpriced = true,
                                    )
                                }
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

    /**
     * Whether the person on this phone may delete records, read from the session
     * the app already keeps.
     *
     * The same capability the run editor's Delete and the job screen's four
     * deletes ask for, so "crew never delete anything" is one rule rather than a
     * rule per screen. Asked here as well as on the screen because this screen
     * stays open across a role change: the office can move somebody while the
     * drawing is in front of them.
     *
     * Unknown counts as no. A view model built outside the app has no session to
     * ask, and guessing generously is how a crew phone briefly became an owner.
     */
    private fun viewerMayDelete(): Boolean {
        val session = (appContext.applicationContext as? com.fenceestimator.app.FenceEstimatorApp)
            ?.session?.state?.value
            ?: return false
        return session.canDelete
    }

    /**
     * Whether the person on this phone is allowed to see money at all.
     *
     * Asked before the teardown charge is switched, and it has to be asked
     * here and not only where the switch is drawn. The drawing screen is open
     * to crew all day and stays open across a role change, so a control drawn
     * while money was visible can still be tapped a moment after it stopped
     * being. Nothing further down catches that: the database holds the
     * teardown amounts against a caller who cannot see money -- the flat fee,
     * the per-foot rate and the haul fee are all refused -- but it does not
     * hold this flag, which was read off the live guard rather than taken from
     * a migration file in the repo. So this check is the only one there is.
     *
     * Unknown counts as no, the same as the two guards above it.
     */
    private fun viewerMaySeeMoney(): Boolean {
        val session = (appContext.applicationContext as? com.fenceestimator.app.FenceEstimatorApp)
            ?.session?.state?.value
            ?: return false
        return session.canSeeMoney
    }

    /**
     * Whether this phone is in the guest demo -- signed out, in the sample
     * company, not any real business's own data. Read the same way the two
     * guards above read theirs.
     *
     * This screen had no guest check at all before: the fence line, its
     * gates and its site markers were open to a visitor to draw on with
     * nothing refusing the write, the only thing standing between a guest
     * and a real change being whichever button happened to be hidden.
     *
     * Unknown counts as YES here, the opposite default from the two guards
     * above. Those ask "may I", where a wrong guess grants something; this
     * asks "must I refuse", where a wrong guess should also refuse. A view
     * model built outside the app has no session to ask, and the safe answer
     * to a question it cannot answer is still whichever one blocks the write.
     */
    private fun viewerIsGuestDemo(): Boolean {
        val session = (appContext.applicationContext as? com.fenceestimator.app.FenceEstimatorApp)
            ?.session?.state?.value
            ?: return true
        return session.isGuestDemo
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
        // A standing "these two meet -- one post?" offer belongs to the side he
        // was drawing. Switching sides puts it away rather than leaving it
        // hanging over a drawing he is no longer looking at.
        _snapJoinOffer.value = null
    }

    /**
     * The run the route asked the drawing to open on, until it is honoured.
     *
     * Held here and not in the screen because [ensureSelection] runs again on
     * every emission of [runs] (SurveyDrawScreen's
     * `LaunchedEffect(runs) { ensureSelection() }`), and the first few of
     * those arrive before Room has answered. Cleared the moment the request
     * is either satisfied or found to be unsatisfiable, so that selecting a
     * different side by hand afterwards is not undone by the next sync
     * emission dragging the selection back to the run the route named.
     */
    private var requestedRunId: Long? = null

    /**
     * Asks the drawing to open on a particular run. Called once per visit,
     * from the route's run id ([com.fenceestimator.app.ui.nav.Routes.survey]).
     *
     * Null, zero or a negative id is no request -- the job-only route, which
     * JobDetailScreen still uses, lands here with nothing and keeps the
     * original "first run" behaviour exactly.
     */
    fun requestRun(id: Long?) {
        requestedRunId = id?.takeIf { it > 0L }
    }

    /**
     * Settles which run is selected, from [resolveRunSelection] -- see that
     * function for the rules and for the bug they fix. The decision is pure
     * and lives in the companion so plain node can check it; this half only
     * reads the flows and writes the result back.
     */
    fun ensureSelection() {
        val decision = resolveRunSelection(
            runIds = runs.value.map { it.id },
            currentSelection = _selectedRunId.value,
            requestedRunId = requestedRunId
        )
        if (!decision.requestStillPending) requestedRunId = null
        _selectedRunId.value = decision.selectedRunId
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
     * Frees a joint whose corner has just stopped being where it was.
     *
     * UNDO CANNOT LEAVE A JOINT ON A CORNER THAT IS NOT THERE. [DrawingSnapshot]
     * carries the points, the gates and the closed flag and nothing else -- it
     * is deliberately the stored strings, byte for byte, so that Redo puts back
     * exactly what Undo took. Which means Undo and Redo restore a drawing
     * WITHOUT restoring the joints. Undo the very point a join was made on and
     * the joint stays recorded at the run's first or last point -- which is now
     * a DIFFERENT corner. The arithmetic would bill a shared post for a corner
     * nobody drew, at a place the crew would not find one.
     *
     * So: an end whose point is not the same point after the restore is freed.
     * Only THIS run's end is freed, which is enough -- an id held by one end is
     * read as a free end everywhere ([jointIdsOf]'s note,
     * RunJoinGesture.liveJointOf, RunJoinArithmetic.isLive) -- so the partner is
     * left harmlessly stranded and the job goes back to its own end posts. That
     * is a post MORE in the ground, which is today's price and the only
     * direction this is allowed to fail in.
     *
     * An end whose point is unchanged keeps its joint, so undoing a gate, or a
     * drag at the other end of the run, does not quietly take a corner post
     * apart.
     *
     * THROUGH [writeJointIds], not through a copy of the run, because there is
     * ONE write path for a joint and tests/a59 check 7 holds it there. Which
     * also means the office hears about it the same way it hears about a
     * Detach, and the price follows the same way: both are right. An undone
     * corner IS a detached corner.
     *
     * NOT a substitute for Detach: this is the narrow case of a corner ceasing
     * to exist, not a way to un-attach one that is still drawn.
     */
    private suspend fun freeJointsAtVanishedEnds(before: FenceRun, after: FenceRun) {
        val joints = jointIdsOf(after)
        if (joints.first.isBlank() && joints.second.isBlank()) return
        val was = FenceCodec.decodePoints(before.pointsEncoded)
        val now = FenceCodec.decodePoints(after.pointsEncoded)
        fun same(a: FencePoint?, b: FencePoint?): Boolean =
            a != null && b != null && a.x == b.x && a.y == b.y
        val writes = buildList {
            if (joints.first.isNotBlank() && !same(was.firstOrNull(), now.firstOrNull())) {
                add(JoinEnd(after.syncId, false) to "")
            }
            if (joints.second.isNotBlank() && !same(was.lastOrNull(), now.lastOrNull())) {
                add(JoinEnd(after.syncId, true) to "")
            }
        }
        if (writes.isEmpty()) return
        writeJointIds(writes)
        // The partner run keeps a joint nothing else holds, so IT loses a
        // shared post too -- and its own row never changed, so the signature
        // watcher will never look at it. Same reason confirmJoinOffer does
        // this; see [repriceEveryRun].
        repriceEveryRun()
    }

    /**
     * Runs [change] against a fresh read of run [runId], behind
     * [drawingWrites]. [onMissing] fires when the run no longer exists.
     *
     * The one door every ordinary drawing edit goes through -- see
     * [commitEdit] -- which makes it the one place a guest's write needs
     * refusing to close all of addDrawPoint, movePoint, setSegmentLengthFeet,
     * undoLast, redo, clearPoints and toggleClosedLoop at once, the same way
     * JobDetailViewModel.update() closes its own funnel in one place.
     * [onMissing] rather than a silent return: a guest calling Undo or Redo
     * still deserves the same "nothing happened" event a genuinely missing
     * run would raise, not a button that looks dead.
     */
    private fun editRun(runId: Long?, onMissing: () -> Unit = {}, change: suspend (FenceRun) -> Unit) {
        if (viewerIsGuestDemo()) {
            onMissing()
            return
        }
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

    /** Why a chosen survey photo was not taken in -- said out loud, never a button that looks dead. */
    enum class ImportRefusal { ALREADY_HAS_SURVEY, COULD_NOT_READ }

    // -----------------------------------------------------------------------
    // A65's types, declared HERE in the class body and not inside the
    // companion object with the pure functions that return them.
    //
    // That is deliberate and it is not style. A classifier declared inside a
    // companion object is `SurveyViewModel.Companion.NumberRefusal`, and
    // whether `SurveyViewModel.NumberRefusal` also resolves to it is not
    // something this sandbox can settle -- Gradle cannot be run here tonight,
    // and there was no other companion-nested type in the whole of
    // app/src/main to copy a working answer from. ImportRefusal directly above
    // IS such a working answer: it sits in the class body and
    // SurveyDrawScreen refers to it as `SurveyViewModel.ImportRefusal`, which
    // compiles today. So these follow it rather than betting on a rule nothing
    // here can check. The functions stay in the companion, because they have
    // to be callable without an instance.
    // -----------------------------------------------------------------------

    /**
     * What [ensureSelection] decided, and whether the run the caller ASKED for
     * is still outstanding.
     *
     * [requestStillPending] is the part that matters and the part that is easy
     * to get wrong. The runs list arrives empty on the first frame and fills
     * in a moment later from Room, so "the run you asked for is not in this
     * list" has two completely different meanings depending on whether the
     * list has loaded yet, and answering them the same way is what would put
     * the drawing back on run 1.
     */
    data class RunSelection(val selectedRunId: Long?, val requestStillPending: Boolean)

    /** Why a typed number was refused. One reason per refusal, so the screen can say which. */
    enum class NumberRefusal {
        /** The box is empty, or mid-edit and holding nothing yet. */
        BLANK,

        /** Not a number at all: "5ft", "5'", "six". */
        NOT_A_NUMBER,

        /**
         * NaN or +/-Infinity.
         *
         * Its own reason and not folded into [NOT_A_NUMBER] because these
         * three DO parse. Kotlin's String.toFloatOrNull defers to
         * java.lang.Float.parseFloat, whose accepted grammar includes the
         * literals "NaN", "Infinity" and "-Infinity" -- so the gate width
         * dialog's old `text.toFloatOrNull()?.let { onConfirm(it) }` accepted
         * all three and handed them straight to the drawing.
         */
        NOT_FINITE,

        /** Zero or negative, where only a positive number means anything. */
        NOT_POSITIVE,
    }

    /**
     * A number typed into a field, or the reason it cannot be used. Exactly
     * one of [value] and [refusal] is non-null.
     */
    data class NumberEntry(val value: Float?, val refusal: NumberRefusal?)

    private val _importRefused = MutableSharedFlow<ImportRefusal>(extraBufferCapacity = 1)
    val importRefused: SharedFlow<ImportRefusal> = _importRefused

    /**
     * Whether the survey photo is the background right now, as opposed to the
     * grid. A DISPLAY choice, remembered on this phone only -- see
     * [clearSurveyImage] -- so it survives leaving the screen, and it never
     * touches the photo or the job.
     */
    private val hideSurveyKey = "hide_survey_$jobId"
    private val backdropPrefs by lazy { appContext.getSharedPreferences(BACKDROP_PREFS, Context.MODE_PRIVATE) }
    private val _surveyPhotoShown = MutableStateFlow(
        !runCatching { backdropPrefs.getBoolean(hideSurveyKey, false) }.getOrDefault(false)
    )
    val surveyPhotoShown: StateFlow<Boolean> = _surveyPhotoShown

    private fun rememberSurveyShown(show: Boolean) {
        _surveyPhotoShown.value = show
        runCatching { backdropPrefs.edit().putBoolean(hideSurveyKey, !show).apply() }
    }

    /**
     * Takes a survey photo in as THE survey for this job.
     *
     * One survey per job, and a second is refused ([ImportRefusal.ALREADY_HAS_SURVEY]) --
     * judged by [DrawingScale.hasSavedSurvey], so a reference to a file that is
     * gone, with nothing in storage, does not lock a job out of ever having one.
     * This used to replace the photo quietly, and a replacement does not
     * survive: it is stored on this phone and uploaded only while the job has no
     * stored photo ([com.fenceestimator.app.cloud.JobFileUploader]), so the new
     * one never reached the cloud while the old one stayed there -- the office
     * and every other phone kept the old picture under a drawing traced on the
     * new one, and the unsynced-work check never noticed. Nothing here can fix
     * that from this side, so it is not offered.
     *
     * A photo that could not be copied does not become the job's survey: a path
     * to a file that is not there would turn the job into a photo job with no
     * photo.
     *
     * The calibration is cleared with the new photo, as it always was -- a new
     * photo has no scale until it is calibrated. (Whether that null SURVIVES a
     * sync is not decided here; see the findings in the report that came with
     * this change.)
     */
    fun importImage(context: Context, uri: Uri) {
        if (viewerIsGuestDemo()) return
        viewModelScope.launch {
            val before = job.value ?: repository.getJob(jobId) ?: return@launch
            if (DrawingScale.hasSavedSurvey(before) { File(it).exists() }) {
                _importRefused.tryEmit(ImportRefusal.ALREADY_HAS_SURVEY)
                return@launch
            }
            val saved = withContext(Dispatchers.IO) {
                val dir = File(context.filesDir, "surveys").apply { mkdirs() }
                val outFile = File(dir, "survey_${jobId}_${UUID.randomUUID()}.jpg")
                val copied = runCatching {
                    context.contentResolver.openInputStream(uri)?.use { input ->
                        FileOutputStream(outFile).use { output -> input.copyTo(output) }
                    }
                }.isSuccess
                if (copied && outFile.exists() && outFile.length() > 0L) {
                    outFile
                } else {
                    runCatching { outFile.delete() }
                    null
                }
            }
            if (saved == null) {
                _importRefused.tryEmit(ImportRefusal.COULD_NOT_READ)
                return@launch
            }
            // Read again: a sync can land the cloud's photo while the bytes were copying.
            val current = repository.getJob(jobId)
            if (current == null || DrawingScale.hasSavedSurvey(current) { File(it).exists() }) {
                runCatching { saved.delete() }
                if (current != null) _importRefused.tryEmit(ImportRefusal.ALREADY_HAS_SURVEY)
                return@launch
            }
            repository.updateJob(
                current.copy(
                    surveyImagePath = saved.absolutePath,
                    calibrationPixelsPerFoot = null,
                    calibrationKnownFeet = null
                )
            )
            rememberSurveyShown(true)
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
     * How far from a corner a point may land and still be taken as that corner.
     *
     * [snapDrawPoint]'s own default is 26 DRAWING units, despite the name. That
     * is a fixed distance on the plan, so it shrinks on screen the further out
     * he is zoomed: about three and a half screen pixels with a 400 ft grid in
     * view. Nobody can hit three pixels on purpose, which is why the offer to
     * share a post so rarely appeared -- the snap it rides on never fired.
     *
     * So the screen passes what its own transform says 18 screen pixels are
     * worth right now, and this clamps it at both ends:
     *
     *  - never SMALLER than the old 26, so zoomed in is no worse than before;
     *  - never larger than [VERTEX_SNAP_MAX_FT] of real distance, so zoomed
     *    right out it cannot reach across the yard and grab a corner he was
     *    nowhere near. At a 400 ft grid the screen figure alone would be about
     *    7 ft; the clamp is what keeps that honest.
     *
     * Null (the default) keeps the old fixed behaviour, which is what every
     * caller without a view transform -- and every test -- still gets.
     */
    private fun vertexReachOf(fromScreen: Float?): Float {
        val floor = com.fenceestimator.app.geometry.DEFAULT_VERTEX_SNAP_PX
        if (fromScreen == null || fromScreen <= 0f) return floor
        val scale = editScale()
        val ceiling = if (scale > 0f)
            com.fenceestimator.app.geometry.VERTEX_SNAP_MAX_FT * scale
        else Float.MAX_VALUE
        return fromScreen.coerceIn(floor, maxOf(floor, ceiling))
    }

    /**
     * Where a newly drawn point should go: on a corner it was aiming at, on
     * a square heading, on a whole foot, or exactly where the finger was.
     */
    fun snapForDraw(
        candidate: FencePoint,
        enabled: Boolean,
        vertexReach: Float? = null,
    ): com.fenceestimator.app.geometry.SnapResult {
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
            vertexSnapPx = vertexReachOf(vertexReach),
        )
    }

    /**
     * The same rules for a vertex being dragged rather than added. The
     * heading is judged against the segment arriving at this point, which is
     * the one the person can see moving under their finger.
     */
    fun snapForMove(
        index: Int,
        candidate: FencePoint,
        enabled: Boolean,
        vertexReach: Float? = null,
    ): com.fenceestimator.app.geometry.SnapResult {
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
            vertexSnapPx = vertexReachOf(vertexReach),
            avoid = avoid,
        )
    }

    /**
     * Adds a point that has already been snapped. Nothing here moves the
     * points already on the run -- a snap only ever positions the new one.
     */
    fun addDrawPoint(point: FencePoint) {
        if (!writablePointOrDropped(point, "addDrawPoint")) return
        editRun(_selectedRunId.value) { run ->
            val points = FenceCodec.decodePoints(run.pointsEncoded) + point
            writePoints(run, points)
        }
    }

    /**
     * Refuses a non-finite coordinate before it can be persisted, and says so
     * in the log. See [isWritablePoint] for what one costs.
     *
     * Dropped rather than reported to the screen, on purpose, and this is the
     * one guard in A65 with no user-facing message. A NaN or Infinity
     * coordinate is not something a person can type -- every point comes from
     * a tap mapped through the canvas transform, so a non-finite one means
     * the transform itself was degenerate (a zero scale, a collapsed
     * viewport) for that frame. There is no action for the user to take and
     * nothing for a message to tell them to do; the honest behaviour is to
     * not record the tap. The log line is for whoever is reading a crash
     * report and wondering why a corner did not appear.
     */
    private fun writablePointOrDropped(point: FencePoint, where: String): Boolean {
        if (isWritablePoint(point.x, point.y)) return true
        android.util.Log.w("SurveyViewModel", "$where refused a non-finite point: ${point.x},${point.y}")
        return false
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
        if (!writablePointOrDropped(point, "movePoint")) return
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
                    // A corner that has just stopped existing cannot go on
                    // billing a shared post. See [freeJointsAtVanishedEnds].
                    freeJointsAtVanishedEnds(run, restored)
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
                    // Redo moves the same corners Undo did, so it frees the
                    // same joints. See [freeJointsAtVanishedEnds].
                    freeJointsAtVanishedEnds(run, restored)
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

    /**
     * Takes the whole drawing off this run.
     *
     * Neither this nor [toggleClosedLoop] clears the run's joint ids, and that
     * is safe rather than overlooked: the join arithmetic counts a shared post
     * only while every member has a free end to give
     * (RunJoinArithmetic.isLive), and a run with no points and a run that
     * closes on itself both have none -- so the post goes back to being two
     * end posts on its own, at today's price, the moment this lands. Clearing
     * the ids outright would be tidier and is what docs/JOINING_RUNS.md 7.4.5
     * asks for, but it cannot be undone from here: DrawingSnapshot carries
     * points, gates and the closed flag only, so an id this wiped would not
     * come back with the drawing. That belongs with the wave that widens the
     * snapshot.
     */
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

    // -----------------------------------------------------------------------
    // ATTACHING ONE SIDE TO ANOTHER
    //
    // His words: "for the grid, I'm not able to attach the fence to the other
    // ones", and the rule that governs it: "it would not be a corner post if I
    // drew it on the other side until I connect it to that one." So this is
    // two deliberate taps -- the end of one side, then the end of the other --
    // and never a thing the app notices because two points landed together.
    // The arithmetic, the refusals and the materials figures are all in
    // RunJoinGesture (geometry/FenceGeometry.kt), which is pure; this half
    // holds what the finger is in the middle of doing and the one door the
    // write goes through.
    //
    // WHY NOT "DRAG AN END ONTO ANOTHER AND CONFIRM", the obvious alternative:
    //
    //  1. The ends he needs to attach are ALREADY on top of one another. A
    //     point placed within 26 px of another run's corner is moved onto that
    //     corner exactly (snapDrawPoint, SnapKind.VERTEX), across every run on
    //     the job, and has been for months -- so for the drawings he has, there
    //     is no drag left to make. Confirm-on-snap would mean dragging an end
    //     away and back to get a question asked about it.
    //  2. That snap fires constantly, including when he is tracing beside a
    //     neighbour's fence. A dialog on every snap is a dialog he learns to
    //     dismiss, and whichever way the dismissal falls is wrong: "always
    //     attach" is inferring a join from proximity, which is the one thing he
    //     said not to do, and "never attach" makes the question noise.
    //  3. A drag cannot say T. Three sides meeting at one post is a third end
    //     joining a post that already exists; a tap can pick that post, a drag
    //     onto one of two coincident ends cannot say which.
    //  4. A drag already means something here -- move this corner -- and one
    //     pointer stream cannot run a drag detector and a tap detector at once
    //     (see the gesture block in SurveyDrawScreen).
    //
    // Detaching is the same gesture in reverse and ONE tap: tap a shared post
    // and the only thing offered is Detach. That matters more than it looks,
    // because Undo cannot take an attachment back -- DrawingSnapshot
    // (geometry/DrawHistory.kt) carries points, gates and the closed flag and
    // nothing else, and that file is not this wave's to change. Detach IS the
    // undo, which is why it is one tap and not buried.
    // -----------------------------------------------------------------------

    /**
     * The end a first tap lifted, waiting for a second tap. Null when nothing
     * is half-attached.
     */
    private val _joinPick = MutableStateFlow<JoinEnd?>(null)
    val joinPick: StateFlow<JoinEnd?> = _joinPick

    /**
     * The attach or detach waiting to be confirmed, with what it does to the
     * materials, or null. Nothing is written until [confirmJoinOffer].
     */
    private val _joinOffer = MutableStateFlow<JoinOffer?>(null)
    val joinOffer: StateFlow<JoinOffer?> = _joinOffer

    /**
     * "That cannot be attached, and here is why" -- a one-shot event, because
     * a refusal is not a state the screen sits in. Same shape as
     * [lengthRefused] and [undoNothingToDo]: a tap that does nothing still
     * says something rather than looking broken.
     */
    private val _joinRefused = MutableSharedFlow<JoinRefusal>(extraBufferCapacity = 1)
    val joinRefused: SharedFlow<JoinRefusal> = _joinRefused

    private val _joinTooFarFeet = MutableStateFlow(0f)

    /**
     * How far apart the two ends were when [JoinRefusal.TOO_FAR_APART] was
     * raised, in feet, so the refusal can say the distance back to him.
     *
     * Only meaningful while handling that one refusal; written immediately
     * before the emit (see [tapJoinEnd]). Kept beside the event rather than in
     * it because [joinRefused] is a bare enum by design -- every other refusal
     * has a fixed sentence, and widening the event for one of them would make
     * the other seven carry a payload that means nothing.
     */
    val joinTooFarFeet: StateFlow<Float> = _joinTooFarFeet

    /**
     * Every run of this job as the attach gesture reads it.
     *
     * Every run, never a subset: the shared post is billed to the tallest
     * member, so an answer worked out from two runs can name the wrong owner.
     */
    private fun joinCandidates(): List<JoinCandidateRun> = runs.value.map { candidateOf(it) }

    /**
     * The height that decides which run is billed the shared post: the taller
     * post is the one that has to be built, and a taller post can carry a
     * shorter panel but not the reverse (docs/JOINING_RUNS.md 2.4, Q1).
     *
     * Chain link keeps its height in fabricHeightFt and split rail has none,
     * so this is not simply panelHeightFt. Note that it is a different
     * question from the one EstimateEngine's catalog choice asks -- that reads
     * panelHeightFt even on a chain-link run, deliberately, because no
     * chain-link post row declares a height. This is "which post is taller in
     * the ground", not "which catalog row gets picked".
     */
    private fun joinHeightOf(run: FenceRun): Float = when (run.fenceType) {
        FenceType.CHAIN_LINK -> run.fabricHeightFt
        FenceType.SPLIT_RAIL -> 0f
        else -> run.panelHeightFt
    }

    /**
     * The joint ids recorded at this run's first and last point: start, end.
     *
     * ---------------------------------------------------------------------
     * THE READ SEAM, and the one place a STORED value is judged usable.
     * ---------------------------------------------------------------------
     * [FenceRun.startJoint] and [FenceRun.endJoint] (schema 50,
     * supabase_a32_join_runs.sql) hold a uuid, or blank for a free end. Blank,
     * never null, for the reason the columns are text: the phone's JSON drops
     * nulls (explicitNulls = false in cloudJson), so a null would be LEFT OUT
     * of the upsert body and the office would go on pricing two runs as
     * attached after he had pulled them apart. The empty string travels.
     *
     * VALIDATE ON READ, NOT ON WRITE. Neither column carries a CHECK and
     * neither ever will: fence_runs upserts are batched, and one row the table
     * refuses fails the WHOLE batch, so no run for the company would sync at
     * all. The database therefore takes any text and this function decides
     * what it means -- anything that is not a uuid is read as blank, which is
     * a FREE end. That is the right direction to fail in: a free end is one
     * more post in the ground, which is today's price, never one fewer.
     * (The other half of the same rule is RunJoinGesture.liveJointOf, which
     * reads an id no OTHER run of the job holds as blank too, so a joint
     * naming nothing -- its partner deleted, or not synced down yet -- is also
     * a free end.)
     */
    private fun jointIdsOf(run: FenceRun): Pair<String, String> {
        // Length first: UUID.fromString accepts short, non-canonical forms
        // ("1-1-1-1-1"), and a joint id is only ever one this app generated
        // with UUID.randomUUID().toString().
        fun usable(stored: String): String =
            if (stored.length == 36 && runCatching { UUID.fromString(stored) }.isSuccess) stored else ""
        return usable(run.startJoint) to usable(run.endJoint)
    }

    /**
     * Writes a joint id onto run ends, or blanks them to take a post apart.
     *
     * ---------------------------------------------------------------------
     * THE WRITE SEAM. It writes.
     * ---------------------------------------------------------------------
     * Through [Repository.setRunJointIds], which is the fence-run dao and the
     * same `updatedAt` bump [Repository.updateFenceRun] gives every other run
     * edit -- a join rides the run's own row up, so there is no second write
     * path and no joint table. (The one that existed, [RunJoin] at schema 48,
     * is inert and untouched -- docs/JOINING_RUNS.md 11.1.)
     *
     * ONE transaction over every end, because a half-written attachment is an
     * id alone on one end -- which reads as a free end everywhere
     * (RunJoinGesture.liveJointOf, RunJoinArithmetic.isLive), so the failure
     * is a post too many rather than a post too few, but it is still a lie on
     * the plan.
     *
     * Returns true ONLY when a row actually changed, so [confirmJoinOffer]
     * raises [JoinRefusal.NO_STORAGE] rather than reporting an attachment that
     * is not there. False covers an empty list, a run that left the job while
     * the confirmation was up (and [skipIfOrphaned] covers the job itself
     * going, which would otherwise hit the foreign key), and an end already
     * carrying exactly the value asked for.
     *
     * WHAT THIS STILL DOES NOT DO, and neither is in this file:
     *  - It does not reach the office. `fence_runs.start_joint` /
     *    `end_joint` do not exist in Postgres yet (supabase_a32_join_runs.sql
     *    is unapplied), so EntitySync.JOIN_COLUMNS_LIVE is false and the keys
     *    are left out of the push -- see that constant for why sending them
     *    before the column exists would stop EVERY run syncing, and why the
     *    Attach tool must stay off until it is true.
     *  - price-job/index.ts needs the two names in RUN_COLUMNS, or the office
     *    reads no joint and the two engines price one job two ways.
     */
    private suspend fun writeJointIds(writes: List<Pair<JoinEnd, String>>): Boolean {
        if (writes.isEmpty()) return false
        val kept = com.fenceestimator.app.cloud.skipIfOrphaned {
            repository.setRunJointIds(
                jobId,
                writes.map { (end, jointId) -> Triple(end.runId, end.atEnd, jointId) }
            )
        } ?: false
        if (kept) noteJoinChange(writes)
        return kept
    }

    /**
     * Records who attached or detached, when there is somebody to report to.
     *
     * The same shape as [noteFootageChange]: only when [editorName] is set (an
     * owner's own phone has nobody to report to), and skipped rather than
     * crashed if the job went while the drawing was open. A join takes a post
     * out of the ground, so the office hearing about it from the field is the
     * same need footage has -- even while the price does not move yet
     * ([JOIN_PRICING_READY]).
     */
    private suspend fun noteJoinChange(writes: List<Pair<JoinEnd, String>>) {
        val name = editorName ?: return
        val attaching = writes.any { it.second.isNotBlank() }
        val labels = repository.getFenceRuns(jobId)
            .filter { run -> writes.any { it.first.runId == run.syncId } }
            .map { it.label.ifBlank { "Fence run" } }
        if (labels.isEmpty()) return
        com.fenceestimator.app.cloud.skipIfOrphaned {
            repository.recordFieldChange(
                FieldChange(
                    jobId = jobId,
                    summary = if (attaching) "Attached: ${labels.joinToString(" + ")}"
                    else "Detached: ${labels.joinToString(" + ")}",
                    detail = if (attaching)
                        "These sides now share one post on the plan."
                    else
                        "These sides no longer share a post — each has its own end post again.",
                    changedBy = name,
                    changedByRole = editorRole.orEmpty()
                )
            )
        }
    }

    /**
     * The shared posts to draw on the plan, from the join arithmetic itself,
     * so the drawing can never show a post the estimate is not counting.
     *
     * A plain function rather than a flow: it is pure and cheap, the screen
     * already remembers it against the runs and the scale, and a flow here
     * would be a second copy of the runs to keep in step.
     */
    fun jointMarkers(): List<JointMarker> = RunJoinGesture.markers(joinCandidates(), editScale())

    /**
     * Every end a tap may attach, with the point to draw a target at.
     *
     * Only wanted while the Attach tool is in hand, so the screen asks for it
     * then: a closed perimeter and a typed-footage run have no free end and
     * are not offered one, which is better than a target that refuses when it
     * is tapped.
     */
    fun attachableEnds(): List<Pair<JoinEnd, FencePoint>> =
        RunJoinGesture.attachableEnds(joinCandidates())

    /**
     * A tap in Attach mode, in drawing coordinates, with [radius] in the same
     * units (the screen divides its own tolerance by the view's scale, so the
     * target is the same size under the finger at any zoom).
     *
     * Tapping empty ground puts down whatever was picked up -- the way out of
     * a half-made attachment is the gesture people try first.
     */
    fun tapJoinEnd(at: FencePoint, radius: Float) {
        if (viewerIsGuestDemo()) return
        val candidates = joinCandidates()
        val hit = RunJoinGesture.endNear(candidates, at, radius)
        if (hit == null) {
            clearJoinPick()
            return
        }
        val first = _joinPick.value
        if (first == null) {
            // A shared post offers one thing: taking it apart again.
            val joint = RunJoinGesture.liveJointOf(candidates, hit)
            if (joint.isNotBlank()) {
                _joinOffer.value = JoinOffer(
                    detach = true,
                    decision = JoinDecision(null, joint, RunJoinGesture.endsAtJoint(candidates, joint)),
                    end = hit,
                    effect = RunJoinGesture.effectOfDetaching(candidates, hit, editScale()),
                    memberRunIds = RunJoinGesture.runsAtJoint(candidates, joint),
                    approvalAtRisk = approvalAtRisk(),
                )
            } else {
                _joinPick.value = hit
            }
            return
        }
        // The same end again: put it down.
        if (first == hit) {
            clearJoinPick()
            return
        }
        val decision = RunJoinGesture.decide(candidates, first, hit, UUID.randomUUID().toString())
        val refusal = decision.refusal
        if (refusal != null) {
            // The pick stays up: he aimed at the wrong end, not at the wrong
            // side, and making him start again would be the tool arguing.
            _joinRefused.tryEmit(refusal)
            return
        }
        // ATTACHED MEANS ONE POINT. A join made here can be between two ends
        // that are nowhere near each other, and until now it recorded them as
        // one post and left the plan showing a gap -- which is exactly the
        // confusion he came back about. So the gap is closed as part of
        // attaching, and a gap too wide to be a tracing error is refused
        // instead: closing THAT would drag a corner across the yard and move a
        // side's footage, its labour and possibly a panel, which is a redraw
        // and not what two taps asked for. He has a way to do it on purpose --
        // drag the end over, where the snap lands it exactly on the corner and
        // the offer comes to him there.
        // NO DISTANCE LIMIT. There was one, of CLOSE_GAP_MAX_FT, and the reason
        // written here for it was that moving the end "changes the side's
        // footage, its labour and possibly a panel, which is a redraw and not
        // what two taps asked for". That reason died when attaching started
        // SLIDING THE WHOLE SIDE instead of stretching one corner: the side
        // keeps its length and its labour however far it travels, so a 40 ft
        // attach costs exactly what a 4 inch one costs.
        //
        // What the limit was really protecting against -- a joint recorded
        // between two ends that are nowhere near each other -- cannot happen
        // through this path any more either, because the ends are brought
        // together before the joint is written rather than the joint being
        // honoured across a gap.
        //
        // The distance is still named in the dialog before he agrees to it, and
        // it is one Undo if it was not what he meant. March asked for this
        // directly (2 Oct 2026) after the limit refused a corner he wanted.
        val gapCloser = RunJoinGesture.gapCloserFor(candidates, decision, editScale())
        _joinOffer.value = JoinOffer(
            detach = false,
            decision = decision,
            end = null,
            effect = RunJoinGesture.effectOfAttaching(candidates, decision, editScale()),
            memberRunIds = RunJoinGesture.runsAtJoint(
                RunJoinGesture.withDecisionApplied(candidates, decision), decision.jointId
            ),
            approvalAtRisk = approvalAtRisk(),
            gapCloser = gapCloser,
        )
    }

    /** Drops the half-made attachment and any offer waiting on it. */
    fun clearJoinPick() {
        _joinPick.value = null
        _joinOffer.value = null
    }

    // -----------------------------------------------------------------------
    // THE OFFER WHERE THE SNAP ALREADY LANDED
    //
    // "Make it easier to connect the sides when I draw." The snap has done the
    // hard half for months: a point placed within reach of another run's
    // corner is moved onto it EXACTLY ([snapTargets] collects across every run
    // of the job). What was missing is that nothing asked whether the two
    // sides now MEET -- so on his own job two sides had their ends on the
    // identical point and the takeoff still bought two end posts.
    //
    // WHY A STANDING OFFER AND NOT A DIALOG. He is in a yard, one-handed, in
    // sunlight, and the next thing he does is almost always another tap. A
    // dialog in front of that tap is worse than no offer at all: it costs a
    // dismissal every time he traces beside a neighbour's fence, and a
    // question he dismisses by reflex is a question that eventually gets
    // answered by reflex too. So the offer sits beside the drawing, one tap
    // takes it, and anything else leaves it.
    //
    // CARRYING ON DRAWING IS NOT A YES. The offer is dropped by the next
    // drawing edit, by changing run, by leaving Draw and Adjust, and by
    // leaving the screen. Nothing it carries can write; [acceptSnapJoinOffer]
    // re-reads the runs and re-derives the whole decision from scratch, so a
    // yes that arrives a moment late lands on today's drawing or on nothing.
    //
    // WHY NOT "JOINED -- UNDO". Because that attaches first and asks after,
    // and the rule is that nothing joins without him saying so. A post coming
    // off the order on a timer, in a yard, on a phone he may have put in his
    // pocket, is the same mistake as inferring a join from proximity, only
    // faster.
    // -----------------------------------------------------------------------

    /**
     * The side he has just finished with a double tap, and its footage.
     *
     * Null when no question is on the table. Non-null puts the continue /
     * start-a-new-one choice in front of him.
     */
    private val _sideFinished = MutableStateFlow<SideFinished?>(null)
    val sideFinished: StateFlow<SideFinished?> = _sideFinished

    /** A finished side: which run, and how long it came out. */
    data class SideFinished(val runId: Long, val feet: Float)

    /**
     * Ends the side he is drawing, after a second tap in the same spot.
     *
     * NOTHING ended a side before this. Every tap in DRAW appended to the
     * selected run, so a tap meant to start a new fence silently extended the
     * old one, and the only way to begin another was the "+" menu, which the
     * full-screen drawing hides.
     *
     * The first tap of the pair has ALREADY added its point -- taps are applied
     * the moment they land, because waiting out a double-tap timeout before
     * drawing anything makes every single point feel broken. So the second tap
     * takes that duplicate back off before asking anything. If it is not a
     * duplicate (he moved between taps, or the snap put the second somewhere
     * else) nothing is removed and the side simply ends where it is.
     *
     * A side of fewer than two points is not a side, so no question is asked:
     * there is nothing to continue and nothing to separate from.
     */
    fun finishSideByDoubleTap(addedByFirstTap: FencePoint? = null) {
        val run = selectedRun() ?: return
        val points = FenceCodec.decodePoints(run.pointsEncoded)
        if (points.isEmpty()) return

        // TAKE BACK THE POINT THE FIRST TAP ADDED -- the one the SCREEN says it
        // added, not one inferred from coordinates.
        //
        // This compared the last two points for exact float equality and removed
        // the last only if they matched to the bit. But the gesture accepts a
        // second tap anywhere within DOUBLE_TAP_SLOP_PX, and snapForDraw can
        // move a point away from the finger as well. So a double-tap that was
        // close enough to COUNT ended the side and LEFT THE STRAY POINT, which
        // is a short segment hanging off the fence -- reported as "it creates a
        // line before opening the new slide, it messes up the fence".
        //
        // Worse, that leftover is how a run ends up with points and no length,
        // which until engine 2026.10.12 billed two end posts for a fence that
        // was not there. One tap, four posts on the quote.
        //
        // The screen knows exactly which point it put in: it is the value it
        // passed to addDrawPoint, after the snap. Comparing against THAT is
        // exact because it is the same value travelling back, not a second
        // measurement of the same intention.
        if (addedByFirstTap != null) {
            editRun(run.id) { fresh ->
                val pts = FenceCodec.decodePoints(fresh.pointsEncoded).toMutableList()
                val last = pts.lastOrNull()
                if (last != null && last.x == addedByFirstTap.x && last.y == addedByFirstTap.y) {
                    pts.removeAt(pts.size - 1)
                    writePoints(fresh, pts)
                }
            }
        }
        val kept = FenceCodec.decodePoints(
            runs.value.firstOrNull { it.id == run.id }?.pointsEncoded ?: run.pointsEncoded
        )
        if (kept.size < 2) return
        _sideFinished.value = SideFinished(run.id, footageOfPoints(kept))
    }

    /** He is carrying on with the same side. */
    fun dismissSideFinished() { _sideFinished.value = null }

    /**
     * He wants the next thing he draws to be its OWN side, not a continuation.
     *
     * Goes through [addRun] so the new side inherits the job's type, spacing
     * and heights exactly as one added from the job screen does, and becomes
     * the selected run, so his next tap starts it.
     */
    fun startNewSideAfterFinish(defaults: BusinessProfile?) {
        // INHERIT WHAT HE WAS DRAWING.
        //
        // This said isTeardown = false outright. Marking out an OLD fence to
        // tear down is a multi-side job exactly as a new fence is, so the
        // second side of a teardown silently became a NEW FENCE run: labelled
        // "Side 2" instead of "Old fence 2", and priced for the posts, panels
        // and concrete he is REMOVING rather than installing. Every side after
        // the first, on every teardown he double-tapped his way around.
        //
        // Read before the state is cleared, because clearing it is what loses
        // the answer.
        val finishedId = _sideFinished.value?.runId
        val wasTeardown = finishedId
            ?.let { id -> runs.value.firstOrNull { it.id == id } }
            ?.isTeardown
            ?: false
        _sideFinished.value = null
        addRun(defaults, isTeardown = wasTeardown)
    }

    /** Straight-line length through a run's points, in feet, at the edit scale. */
    private fun footageOfPoints(points: List<FencePoint>): Float {
        val scale = editScale()
        if (scale <= 0f || points.size < 2) return 0f
        var total = 0f
        for (i in 1 until points.size) {
            val dx = points[i].x - points[i - 1].x
            val dy = points[i].y - points[i - 1].y
            total += kotlin.math.hypot(dx.toDouble(), dy.toDouble()).toFloat()
        }
        return total / scale
    }

    private val _snapJoinOffer = MutableStateFlow<RunJoinGesture.SnapJoinOffer?>(null)

    /**
     * "These two sides meet here -- make it one post?", or null.
     *
     * Raised by [offerJoinFromSnap] after a point was drawn or dragged onto
     * another run's free end, and taken by [acceptSnapJoinOffer]. Carries no
     * authority: it is a question, and until it is answered the drawing and
     * the price are exactly what they were.
     */
    val snapJoinOffer: StateFlow<RunJoinGesture.SnapJoinOffer?> = _snapJoinOffer

    /** Puts the offer away without attaching anything. */
    fun dismissSnapJoinOffer() {
        _snapJoinOffer.value = null
    }

    /**
     * Asks whether the point just placed made two sides meet, and raises the
     * offer if it did.
     *
     * Called by the screen straight after [addDrawPoint] or [movePoint], with
     * the [SnapKind] the snap reported. Only a VERTEX snap is even asked
     * about: a heading snap and a whole-foot snap do not land ON anything, so
     * there is no other side to be one post with.
     *
     * Deliberately asked AFTER the write rather than inside the snap. The snap
     * is pure and is called while a finger is still down (the drag preview
     * asks it every frame); an offer raised from there would flicker under the
     * finger and would be computed against a drawing that is not saved yet.
     * Asked here, the runs it reads are the runs the price will read.
     *
     * Reads the drawing back out of the repository rather than trusting
     * [runs], whose flow may be a beat behind its own write -- the offer names
     * a specific pair of ends and a specific point, and a stale read is how it
     * would come to name the wrong one.
     */
    fun offerJoinFromSnap(index: Int, kind: com.fenceestimator.app.geometry.SnapKind) {
        _snapJoinOffer.value = null
        if (!JOIN_STORAGE_READY) return
        if (kind != com.fenceestimator.app.geometry.SnapKind.VERTEX) return
        if (viewerIsGuestDemo()) return
        val runId = _selectedRunId.value ?: return
        viewModelScope.launch {
            // Behind [drawingWrites], the same lock every drawing edit holds,
            // so this read happens AFTER the point that prompted it has landed.
            // The screen calls addDrawPoint/movePoint and this one after it, but
            // both are coroutines and neither waits for the other -- without the
            // lock the offer would sometimes be worked out from the drawing as
            // it was a moment ago, and would name the wrong corner.
            val fresh = drawingWrites.withLock {
                withContext(Dispatchers.IO) { repository.getFenceRuns(jobId) }
            }
            val selected = fresh.firstOrNull { it.id == runId } ?: return@launch
            val candidates = fresh.map { candidateOf(it) }
            val me = candidates.firstOrNull { it.runId == selected.syncId } ?: return@launch
            // LAST_POINT resolves against the FRESH run, not against the
            // screen's copy: a point that was just added is the run's last, and
            // asking the database which index that is cannot be a beat behind
            // its own write.
            val at = if (index == LAST_POINT) me.points.lastIndex else index
            // Only an END of the selected run can be joined -- a bend in the
            // middle has nowhere to be stored and is already a corner post.
            val movingEnd = RunJoinGesture.endAtVertex(me, at) ?: return@launch
            _snapJoinOffer.value = RunJoinGesture.offerFromSnap(
                runs = candidates,
                movingEnd = movingEnd,
                newJointId = UUID.randomUUID().toString(),
                pxPerFt = editScale(),
            )
        }
    }

    /**
     * The same question after a point was ADDED rather than dragged.
     *
     * The screen knows it drew a point; it does not know, without racing its
     * own write, which index that point ended up at. [LAST_POINT] says "the
     * run's last point, whatever index that is now" and is resolved inside
     * [offerJoinFromSnap] against the fresh read.
     */
    fun offerJoinAfterDraw(kind: com.fenceestimator.app.geometry.SnapKind) =
        offerJoinFromSnap(LAST_POINT, kind)

    /**
     * Takes the standing offer: writes the joint, and nothing else.
     *
     * NO POINT MOVES HERE, and that is not an omission. The snap put the two
     * ends on one point before the offer was ever raised -- that is condition
     * (1) of [RunJoinGesture.offerFromSnap], checked by exact equality -- so
     * the line has already moved, he has already watched it move, and the
     * footage change was the drawing edit he made, not a surprise the join
     * sprang afterwards. An attach from this path costs 0.00 ft by
     * construction, which is why nothing is said about feet.
     *
     * THE WHOLE DECISION IS RE-DERIVED from a fresh read, against the ends the
     * offer named. If either end has moved, been deleted, closed its loop,
     * turned into a teardown or gained a joint since the offer appeared, the
     * answer is no and the refusal says which -- rather than writing a joint
     * for a corner that is no longer there.
     */
    fun acceptSnapJoinOffer() {
        val offer = _snapJoinOffer.value ?: return
        _snapJoinOffer.value = null
        if (viewerIsGuestDemo()) return
        viewModelScope.launch {
            val fresh = withContext(Dispatchers.IO) { repository.getFenceRuns(jobId) }
            val candidates = fresh.map { candidateOf(it) }
            val decision = RunJoinGesture.decide(
                candidates, offer.movingEnd, offer.targetEnd, offer.decision.jointId
            )
            val refusal = decision.refusal
            if (refusal != null) {
                _joinRefused.tryEmit(refusal)
                return@launch
            }
            // Still one point? The offer was raised because they were, and
            // this is an attach that promises to move nothing -- so if the
            // drawing has moved underneath it, the promise is void and the
            // honest answer is to say the side is not where it was.
            val a = RunJoinGesture.pointOf(candidates, offer.movingEnd)
            val b = RunJoinGesture.pointOf(candidates, offer.targetEnd)
            if (a == null || b == null || a.x != b.x || a.y != b.y) {
                _joinRefused.tryEmit(com.fenceestimator.app.geometry.JoinRefusal.NOT_FOUND)
                return@launch
            }
            val writes = decision.ends.map { it to decision.jointId }
            val kept = drawingWrites.withLock { writeJointIds(writes) }
            if (!kept) {
                _joinRefused.tryEmit(com.fenceestimator.app.geometry.JoinRefusal.NO_STORAGE)
                return@launch
            }
            repriceEveryRun()
        }
    }

    /** One run as the join layer reads it. Shared by every path that asks. */
    private fun candidateOf(run: FenceRun): JoinCandidateRun {
        val joints = jointIdsOf(run)
        return JoinCandidateRun(
            runId = run.syncId,
            points = FenceCodec.decodePoints(run.pointsEncoded),
            closedLoop = run.closedLoop,
            typedFootage = run.usesManualFeet,
            isTeardown = run.isTeardown,
            heightFt = joinHeightOf(run),
            sortOrder = run.sortOrder,
            startJointId = joints.first,
            endJointId = joints.second,
        )
    }

    /**
     * Carries out the offer on the table, or says why it could not be kept.
     *
     * The refusal when there is no storage is deliberate and loud. An
     * attachment that lived only in this screen's memory would be gone the
     * moment he backed out of the drawing, and one kept only on this phone
     * would never reach the office that prices the job -- so it is refused
     * rather than accepted and quietly lost. See [writeJointIds].
     */
    fun confirmJoinOffer() {
        val offer = _joinOffer.value ?: return
        if (viewerIsGuestDemo()) {
            clearJoinPick()
            return
        }
        val writes: List<Pair<JoinEnd, String>> = if (offer.detach) {
            val end = offer.end
            if (end == null) emptyList() else listOf(end to "")
        } else {
            offer.decision.ends.map { it to offer.decision.jointId }
        }
        clearJoinPick()
        if (writes.isEmpty()) {
            // A detach offer with no end on it: the run went while the
            // confirmation was up. Nothing to free, and saying "cannot be
            // saved" would name the wrong reason.
            _joinRefused.tryEmit(JoinRefusal.NOT_FOUND)
            return
        }
        viewModelScope.launch {
            val kept = drawingWrites.withLock { writeJointIds(writes) }
            if (!kept) {
                _joinRefused.tryEmit(JoinRefusal.NO_STORAGE)
                return@launch
            }
            // THE LINE MOVES, and it moves AFTER the joint is stored, never
            // before. A move written first and a joint write that then failed
            // would leave a corner dragged across the drawing with nothing
            // attached -- a line that moved for no reason, which is worse than
            // the gap. This order can only fail the other way: an attachment
            // whose gap did not close, which is precisely today's behaviour and
            // the safe direction (one post too few is never billed).
            //
            // Through the ordinary drawing door either way, so it is ONE Undo
            // step, it re-prices like any other drawing edit, and the office
            // hears about the footage the same way it hears about a dragged
            // corner.
            //
            // WHICH door depends on whether the OTHER end of the side being
            // moved is already standing at a shared post.
            //
            //   far end free   -> slide the whole side. Its length is
            //                     unchanged, which is what he asked for: the
            //                     line moves over and the footage does not
            //                     budge.
            //   far end joined -> move ONLY the tapped corner. Both of this
            //                     side's corners are now fixed to real posts,
            //                     so the side genuinely IS a different length;
            //                     stretching it is the honest answer.
            //
            // Sliding in the second case drags the far corner off the post it
            // shares with its neighbour. The joint id is untouched, so the
            // takeoff goes on deducting ONE shared post while the plan shows
            // two ends apart -- closing the corner he tapped by opening one he
            // did not, and billing a post, a cap and a bag of concrete short.
            // With the old distance cap gone that gap can be many feet.
            //
            // This is what moveJoinedEnd was written for. When the slide
            // replaced it, it became unreachable and took this case with it.
            offer.gapCloser?.let { closer ->
                if (farEndIsJoined(closer)) moveJoinedEnd(closer) else slideRunToMeet(closer)
            }
            // Every run of the job, not just the rows written. A detach writes
            // ONE end blank and a T-join writes only the two ends tapped, so
            // the run that was the post's OWNER can keep a corner post in its
            // stored line items for a post that no longer exists, or lose one
            // it has just gained -- its own row never changed, so the signature
            // watcher ([watchDrawingForRepricing]) never sees it move. This is
            // the same answer [repriceAfterScaleChange] gives for the same
            // reason: a join is rare, a job is small, and a member missed here
            // is a stale price on a customer's quote.
            repriceEveryRun()
        }
    }

    /**
     * Moves the corner an attach promised to move, as an ordinary edit.
     *
     * Through [editRun] and [writePoints], so it is one Undo step, it reports
     * the footage change to the office like any other drag, and the takeoff
     * re-prices from it the way it re-prices from a finger.
     *
     * Re-reads and re-checks rather than trusting the figures in the offer: the
     * end has to still be at the point the offer measured from, or this is a
     * corner being dragged somewhere nobody asked for. Silent when it is not --
     * the joint is already stored and honoured, so the drawing keeps its gap
     * and that is the state the app was in before today.
     */
    /**
     * Slides the WHOLE side across so its end lands on the corner it is
     * attaching to, keeping its length and its heading.
     *
     * [moveJoinedEnd] below stretches the one corner instead, which is what
     * this used to do and is almost never what he means. A side is a measured
     * thing: 74 ft of fence with its far end where he put it. Dragging one
     * corner 2 ft to close a gap makes it 76 ft, and labour is billed by the
     * foot, so the quote moved because two corners were tidied up. Sliding
     * moves the far end too and the footage does not change at all -- which is
     * why nothing here reports a footage difference.
     *
     * Every point is checked before any is written: a slide that would push a
     * corner off the drawable area is refused whole rather than applied
     * partly, because half a slid side is a shape nobody drew.
     *
     * Through [editRun] and [writePoints] like any other drawing edit, so it is
     * ONE Undo step and the office hears about it the same way.
     */
    /**
     * Whether the end of the moving run that is NOT being tapped already
     * stands at a shared post.
     *
     * The tapped end is free by construction -- gapCloserFor only ever offers
     * to move an end that is -- but it says nothing about the other one, and a
     * side in the middle of a chain has both ends joined. Read off the run's
     * own [FenceRun.startJoint]/[endJoint], which is where a join is recorded.
     */
    private fun farEndIsJoined(closer: RunJoinGesture.JoinGapCloser): Boolean {
        val target = runs.value.firstOrNull { it.syncId == closer.end.runId } ?: return false
        // Tapped the END, so the far end is the START, and the other way round.
        val farJoint = if (closer.end.atEnd) target.startJoint else target.endJoint
        return farJoint.isNotBlank()
    }

    private fun slideRunToMeet(closer: RunJoinGesture.JoinGapCloser) {
        val target = runs.value.firstOrNull { it.syncId == closer.end.runId } ?: return
        editRun(target.id) { run ->
            val points = FenceCodec.decodePoints(run.pointsEncoded)
            val index = if (closer.end.atEnd) points.lastIndex else 0
            if (index !in points.indices) return@editRun
            val at = points[index]
            // The end has to still be where the offer measured from, or this is
            // a side being shoved somewhere nobody asked for.
            if (at.x != closer.from.x || at.y != closer.from.y) return@editRun
            val dx = closer.to.x - closer.from.x
            val dy = closer.to.y - closer.from.y
            val slid = points.map { FencePoint(it.x + dx, it.y + dy) }
            if (slid.any { !isWritablePoint(it.x, it.y) }) return@editRun

            // THE GATES HAVE TO COME WITH IT.
            //
            // A GateMarker is a loose plan point, matched to its side at READ
            // time by projecting onto the nearest segment (GateGeometry.spanFor,
            // clamped to the ends). Moving the fence and leaving the gates where
            // they were therefore does not leave them behind in a visible way --
            // it slides each one ALONG the fence by the component of the move
            // parallel to that side, clamps one near a corner onto the corner,
            // and on a multi-segment run can re-match it to a different side
            // altogether. The drawing, the crew plan and the PDF all read
            // gatesEncoded, so the crew builds from the wrong opening.
            //
            // SideLength.kt's followSide exists for the general case, where each
            // corner moves differently. This is a pure translation: every point
            // shifts by the same offset, so every gate does too, and the gate's
            // position along its side is preserved exactly.
            val gates = FenceCodec.decodeGates(run.gatesEncoded)
            val slidGates = gates.map { it.copy(x = it.x + dx, y = it.y + dy) }
            writePoints(run, slid.toMutableList(), FenceCodec.encodeGates(slidGates))
        }
    }

    private fun moveJoinedEnd(closer: RunJoinGesture.JoinGapCloser) {
        val target = runs.value.firstOrNull { it.syncId == closer.end.runId } ?: return
        editRun(target.id) { run ->
            val points = FenceCodec.decodePoints(run.pointsEncoded).toMutableList()
            val index = if (closer.end.atEnd) points.lastIndex else 0
            if (index !in points.indices) return@editRun
            val at = points[index]
            if (at.x != closer.from.x || at.y != closer.from.y) return@editRun
            if (!isWritablePoint(closer.to.x, closer.to.y)) return@editRun
            points[index] = closer.to
            writePoints(run, points)
        }
    }

    /**
     * Re-prices every run's materials, for a change that moved a price without
     * moving the row the watcher follows.
     *
     * [watchDrawingForRepricing] compares each run's own
     * [TakeoffRefresher.pricingSignature], so it only ever refreshes the rows
     * that changed. That is right for a drag and wrong for a join: the shared
     * post is billed to ONE member chosen across runs, so attaching or
     * detaching can change what a run that was not written owes.
     *
     * Same gate, same failure banner and same reporting as every other
     * re-price ([viewerMayReprice], [repriceAfterScaleChange]) -- a crew phone
     * still may not re-price, and a failure still says so on the canvas rather
     * than leaving the materials quietly behind the drawing.
     */
    private suspend fun repriceEveryRun() {
        if (!repriceOnDrawingChange || !viewerMayReprice()) return
        withContext(Dispatchers.IO) {
            repository.getFenceRuns(jobId).forEach { run ->
                runCatching { TakeoffRefresher.refreshRun(repository, run, true) }
                    .onSuccess { _repriceFailed.value = false }
                    .onFailure { e ->
                        CrashReporter.report(appContext, "survey-reprice", e)
                        _repriceFailed.value = true
                    }
            }
        }
    }

    /**
     * Whether this job has a customer approval that an attachment would
     * withdraw -- the same predicate the drawing screen's edit warning uses,
     * so the two cannot come to disagree.
     *
     * A job that already needs re-approval has had its warning; a job that was
     * never approved has nothing to lose.
     */
    private fun approvalAtRisk(): Boolean {
        val current = job.value ?: return false
        return com.fenceestimator.app.reapproval.shouldWarnBeforeEditingDrawing(
            current.quoteApprovedAt, current.reapprovalRequiredAt
        )
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

    private val _calibrationRefused = MutableSharedFlow<NumberRefusal>(extraBufferCapacity = 1)

    /**
     * A typed calibration distance that could not be used, and why -- so the
     * dialog can say which mistake it was instead of closing as though the
     * scale had been set. The counterpart of [lengthRefused].
     */
    val calibrationRefused: SharedFlow<NumberRefusal> = _calibrationRefused

    fun applyCalibration(p1: FencePoint, p2: FencePoint, knownFeet: Float) {
        if (viewerIsGuestDemo()) return
        val current = job.value ?: return
        // The guard here used to be `knownFeet <= 0f`, which NaN walks
        // straight through: `NaN <= 0f` is false. So a NaN distance stored a
        // NaN calibration, and an Infinity one stored exactly 0.0
        // (distPx / Infinity), and either prices the whole fence at $0 --
        // FenceGeometryEngine.analyze returns an empty result whenever
        // pixelsPerFoot <= 0f. See [isUsableCalibration].
        //
        // Checked BEFORE the division, so the reason reported is the one the
        // person can act on: "that is not a distance", not the arithmetic
        // consequence of it two lines later.
        checkPositive(knownFeet)?.let {
            _calibrationRefused.tryEmit(it)
            return
        }
        val distPx = kotlin.math.hypot((p2.x - p1.x).toDouble(), (p2.y - p1.y).toDouble()).toFloat()
        if (distPx <= 0f || !distPx.isFinite()) {
            // The two taps landed on the same spot, or on a frame whose
            // transform was degenerate. Nothing typed was wrong, so this is
            // reported as "not a number" rather than blamed on the distance.
            _calibrationRefused.tryEmit(NumberRefusal.NOT_A_NUMBER)
            return
        }
        val pxPerFt = distPx / knownFeet
        // Belt and braces, and not redundant: both inputs can be finite and
        // positive and still divide to something that is not (a huge distance
        // over a tiny known length overflows to Infinity). Nothing may be
        // stored in this column that DrawingScale.of would then refuse to
        // measure by, because that combination is exactly the state that
        // prices at $0 with the send button NOT blocked.
        if (!isUsableCalibration(pxPerFt)) {
            _calibrationRefused.tryEmit(NumberRefusal.NOT_FINITE)
            return
        }
        viewModelScope.launch {
            repository.updateJob(current.copy(calibrationPixelsPerFoot = pxPerFt, calibrationKnownFeet = knownFeet))
            // A new scale is a new drawing as far as Undo and Redo are concerned.
            clearDrawingHistory()
            repriceAfterScaleChange()
        }
    }

    /**
     * Re-prices every run's materials after the job's SCALE changed.
     *
     * [watchDrawingForRepricing] follows the runs, and a recalibration does not
     * touch a run: it changes what every point measures from the job row. So
     * the labour footage followed it at once (it is read from the job live) and
     * the stored materials did not -- the posts, panels and concrete stayed at
     * what the old scale measured until some run next changed. Recalibrating a
     * photo is exactly the "fix the scale and the quote follows" case, so it
     * asks for the same refresh a drawing change gets, from the same code, for
     * the same people ([viewerMayReprice]) and with the same failure banner.
     * [TakeoffRefresher.refreshRun] still declines a run nobody has priced.
     */
    private suspend fun repriceAfterScaleChange() = repriceEveryRun()

    val siteMarkers: StateFlow<List<SiteMarker>> = repository.observeSiteMarkers(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    fun addSiteMarker(
        kind: SiteMarkerKind, x: Float, y: Float, label: String,
        widthFt: Float = 0f, heightFt: Float = 0f, rotationDeg: Float = 0f
    ) {
        if (viewerIsGuestDemo()) return
        viewModelScope.launch {
            repository.addSiteMarker(SiteMarker(
                jobId = jobId, kind = kind, x = x, y = y, label = label,
                // Negatives would draw a box inside out; zero is the point it
                // has always been, so the floor is zero rather than a refusal.
                widthFt = widthFt.coerceAtLeast(0f),
                heightFt = heightFt.coerceAtLeast(0f),
                // Any angle is legal, but 370 degrees is 10 and storing 370
                // makes every later comparison harder than it needs to be.
                rotationDeg = ((rotationDeg % 360f) + 360f) % 360f
            ))
        }
    }

    fun deleteSiteMarker(marker: SiteMarker) {
        if (viewerIsGuestDemo()) return
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
        if (viewerIsGuestDemo()) return
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
     *
     * [isTeardown] is what lets the old fence be drawn at all: the Add button
     * on the drawing screen offers a choice of this or a plain new run, so the
     * old fence coming out gets its own run -- colored differently on the
     * canvas (see FenceRun.isTeardown) and excluded from the new fence's
     * footage -- right where the rest of the layout is drawn, instead of
     * needing a typed-in length on a different screen.
     */
    fun addRun(defaults: BusinessProfile? = null, isTeardown: Boolean = false) {
        if (viewerIsGuestDemo()) return
        viewModelScope.launch {
            drawingWrites.withLock { createBlankRun(defaults, isTeardown) }
        }
    }

    private suspend fun createBlankRun(defaults: BusinessProfile?, isTeardown: Boolean = false): FenceRun? {
        // Read the job's runs out of the DATABASE, not from the [runs] flow.
        // This runs inside [drawingWrites], which exists precisely because the
        // screen's copy of a row can be a moment old -- and a sortOrder taken
        // from a stale list is a sortOrder that ties with a run already there,
        // which is the bug being fixed (see [nextSortOrder]).
        val siblings = repository.getFenceRuns(jobId)
        val base = FenceRun(
            jobId = jobId,
            isTeardown = isTeardown,
            // Was left at the entity default of 0, tying with run 1 and
            // leaving the order of the two to a random UUID. See
            // [nextSortOrder]; identical to FenceRunListViewModel.addRun.
            sortOrder = nextSortOrder(siblings.map { it.sortOrder }),
            // Was left blank, which the drawing screen renders as
            // "Untitled (Vinyl)" -- several rows reading the same thing, in an
            // order that moved. See [nextQuickRunLabel].
            label = nextQuickRunLabel(siblings.map { it.label }, isTeardown),
            // Inherit the job's own last type instead of the entity default of
            // VINYL. A yard is almost always one material, so the second side
            // should not have to be told what the first one was -- and on the
            // job that IS mixed, being wrong on side two is one tap to fix
            // rather than a wrong price nobody notices.
            //
            // Teardown sides are excluded inside defaultTypeFor: on "pull the
            // wood out, put vinyl in", the old fence's type is the one answer
            // guaranteed wrong.
            fenceType = RunTypeChange.defaultTypeFor(siblings)
        )
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
     * Turns the teardown charge on or off for this job.
     *
     * The same job field the job screen's teardown section writes, through the
     * same repository call, so the drawing screen and the job screen are two
     * views of one switch and can never disagree about whether the old fence is
     * being charged for. Nothing else is touched: the flat fee, the per-foot
     * rate, the haul fee and the typed teardown length are still only set where
     * they always were, and this decides only whether any of them are charged.
     *
     * Read fresh out of the database rather than from the screen's copy. The
     * whole job row is written back, and the copy a screen is holding can be a
     * moment old -- long enough for this write to put a stale customer name or a
     * stale rate back over something typed on the job screen or landed by a sync.
     *
     * A switch flicked to where it already sits writes nothing. Every write
     * stamps the job's clock and jobs sync last-edit-wins on it, so re-saving an
     * unchanged row would make this phone look newer than an office change that
     * has not come down yet -- the same reason an edit that changes no geometry
     * stops before touching the database.
     *
     * Asks [viewerMaySeeMoney] before writing anything rather than trusting
     * the screen that hides the switch, for the reason set out there. Do not
     * read that as a mirror of a server guarantee: the database refuses the
     * teardown amounts to a caller who cannot see money but leaves this flag
     * writable, so the app-side check is the whole of it.
     */
    fun setTeardownCharge(enabled: Boolean) {
        // The guest demo carries SEE_MONEY on purpose (see
        // SessionState.GUEST_READ_ONLY) so a visitor can see what the app
        // shows a real company -- which means viewerMaySeeMoney() alone
        // would have let a guest flip this. Asked separately, same as every
        // other write on this screen.
        if (viewerIsGuestDemo()) return
        if (!viewerMaySeeMoney()) return
        viewModelScope.launch {
            val current = repository.getJob(jobId) ?: return@launch
            if (current.teardownEnabled == enabled) return@launch
            repository.updateJob(current.copy(teardownEnabled = enabled))
        }
    }

    /**
     * Takes the selected fence run off this drawing: its line, its gates and the
     * material lines that were priced from it.
     *
     * Goes through the repository call the run editor's Delete already uses, on
     * purpose. That one path removes the row here AND queues the deletion for the
     * cloud, where the sync stamps the row rather than removing it -- which is
     * what puts the run in the trash instead of destroying it, and what stops
     * another phone reading its absence as work that was never uploaded and
     * pushing it straight back. A quick local-only delete written here instead
     * would be exactly that bug.
     *
     * What happens to Undo: this run's undo and redo steps go with it. Every one
     * of them describes a drawing that no longer exists, and an Undo that put
     * back a run the rest of the app has already stamped as deleted would be
     * worse than no Undo at all -- a fence on the canvas that the estimate, the
     * office and every other phone agree is gone.
     *
     * Only this run's history, though. [clearDrawingHistory] empties every run's
     * and exists for a change to the whole drawing, such as a new scale; erasing
     * one run is not that, and reaching for it would throw away the undo steps
     * belonging to the runs that are staying.
     *
     * Asks [viewerMayDelete] before writing anything rather than trusting the
     * caller, and re-reads the row under the drawing lock so an erase cannot
     * land between another edit's read and its write.
     */
    fun eraseSelectedRun() {
        if (!viewerMayDelete()) return
        val runId = _selectedRunId.value ?: return
        eraseRun(runId)
    }

    /**
     * Erases a run BY ID, rather than whichever one happens to be selected.
     *
     * Long-pressing a side on the drawing erases the side under the finger, and
     * that is very often not the selected one. eraseSelectedRun() read
     * `_selectedRunId` at the moment Erase was tapped, so pointing it at a
     * long-pressed run would have meant selecting that run first -- which the
     * drawing screen cannot afford: `pendingRunErase`, `viewZoom` and `viewPan`
     * are all `remember(selectedRunId)`, so changing the selection resets the
     * dialog flag to false (the dialog would never open) and throws away his
     * zoom and pan. The id travels instead.
     *
     * The permission is asked here as well as in eraseSelectedRun. Two entry
     * points, two checks: a guard that lives only on the path you happened to
     * read is a guard the other path does not have.
     */
    fun eraseRun(runId: Long) {
        if (!viewerMayDelete()) return
        viewModelScope.launch {
            drawingWrites.withLock {
                // Confirms the run still belongs to this job before removing it,
                // the same check every other edit here makes: a stale selection
                // must never reach across to another job's drawing.
                val run = repository.getFenceRun(runId)?.takeIf { it.jobId == jobId }
                    ?: return@withLock
                repository.deleteFenceRun(run)
                _undo.update { it.forget(run.id) }
                _redo.update { it.afterEdit(run.id) }
                // Moves the selection now rather than waiting for the runs flow
                // to emit. In between, the screen holds a selected id with no row
                // behind it and draws nothing at all -- a blank canvas that reads
                // as the whole job having been wiped.
                //
                // ONLY when the erased run was the selected one. Erasing a side
                // he long-pressed somewhere else must not move the selection out
                // from under the side he is working on.
                if (_selectedRunId.value == run.id) {
                    _selectedRunId.value = repository.getFenceRuns(jobId).firstOrNull()?.id
                }
            }
        }
    }

    /**
     * The run whose fence line passes nearest [p], within [reach], or null.
     *
     * NEAREST, not the first within reach: where two sides cross or run close
     * together, taking the first match erases whichever happens to sit earlier
     * in the list, which from the outside looks like the app deleting the wrong
     * fence at random. Teardown runs are included -- an old fence marked for
     * removal is a side he may equally want rid of.
     */
    fun runNearest(p: FencePoint, reach: Float): FenceRun? {
        var best: FenceRun? = null
        var bestDistance = reach
        for (run in runs.value) {
            val pts = FenceCodec.decodePoints(run.pointsEncoded)
            for (i in 1 until pts.size) {
                val d = distanceToSegment(p, pts[i - 1], pts[i])
                if (d <= bestDistance) {
                    bestDistance = d
                    best = run
                }
            }
        }
        return best
    }

    /** Perpendicular distance from [p] to the segment [a]..[b], in drawing units. */
    private fun distanceToSegment(p: FencePoint, a: FencePoint, b: FencePoint): Float {
        val dx = b.x - a.x
        val dy = b.y - a.y
        val lengthSq = dx * dx + dy * dy
        // A zero-length segment -- two coincident points, which a double-tap
        // could once leave behind -- is just the distance to the point.
        if (lengthSq <= 0f) return kotlin.math.hypot(p.x - a.x, p.y - a.y)
        val t = (((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq).coerceIn(0f, 1f)
        return kotlin.math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
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
        if (viewerIsGuestDemo()) return
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
        // Runs unasked, from a LaunchedEffect the moment the screen opens --
        // no button behind it at all, so a guest reaches this whether or not
        // anything else on the screen is gated. Nothing downstream actually
        // needs the seed: DrawingScale.of() already falls back to computing
        // the grid's own scale from gridExtentFt when calibrationPixelsPerFoot
        // is null, so refusing the write here costs a guest's rendering
        // nothing.
        if (viewerIsGuestDemo()) return
        val current = job.value ?: return
        // A photo job, not merely a job whose photo file is on this phone. This
        // asked only about the local file, so on a phone the photo had not
        // reached yet -- the download runs at the end of a sync pass, and not
        // at all offline -- a job whose photo is in cloud storage read as a
        // grid job and was given the grid's scale, which then travelled to the
        // office and priced the photo at a number nobody measured. The same
        // question DrawingScale.calibrationToSeed asks for Suggest.
        if (DrawingScale.isPhotoJob(current)) return
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
        if (viewerIsGuestDemo()) return
        val current = job.value ?: return
        // A photo job by either field -- see ensureGridCalibration. Resizing a
        // grid rewrites the scale, and a photo's scale is not the grid's to rewrite.
        if (DrawingScale.isPhotoJob(current)) return
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
                    gridFeetPerSquare = gridFeetPerSquareFor(extentFt)
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
     * (`if (DrawingScale.isPhotoJob(current)) return`) is what makes this
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
        if (DrawingScale.isPhotoJob(current)) return SatelliteCalibration.Ready
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

    /**
     * Puts the no-photo grid back on its OWN scale, undoing a hand
     * calibration -- by handing [gridExtentFt][Job.gridExtentFt] straight
     * back to [setGridExtent], the SAME path every other grid-scale change
     * already goes through, rather than writing a number of its own.
     *
     * This used to write the flat [PIXELS_PER_FOOT_GRID] constant directly,
     * unconditionally, with no check for a survey photo either. On any job
     * whose grid extent was not the 400ft default that is wrong by
     * construction -- 400ft is the one extent PIXELS_PER_FOOT_GRID is
     * actually correct for -- and it is exactly the shape of a live
     * data point found while closing this file's grid-extent/calibration
     * split: one job carries grid_extent_ft 25 with calibration_pixels_per_foot
     * 20, where a fresh calibration for a 25ft grid is 320. Nothing is drawn
     * on that job, so nothing about its price is touched by this fix -- this
     * only stops the function that most plausibly wrote that pair from being
     * able to write it again. Going through [setGridExtent] instead means: a
     * survey photo is left alone (its own guard), and anything actually
     * drawn under the old, wrong number is rescaled by the ratio back to its
     * real-world length -- so a job with real geometry on it neither moves
     * price nor keeps a stale calibration, either way.
     */
    fun resetGridCalibration() {
        if (viewerIsGuestDemo()) return
        val current = job.value ?: return
        setGridExtent(current.gridExtentFt)
    }

    /** Purely a display setting (how far apart gridlines are drawn) -- never affects calibration or existing points. */
    fun setGridLineSpacingFt(feet: Float) {
        if (viewerIsGuestDemo()) return
        val current = job.value ?: return
        viewModelScope.launch {
            repository.updateJob(current.copy(gridFeetPerSquare = feet.coerceAtLeast(0.5f)))
        }
    }

    /**
     * "Use Grid" in the layers menu (SurveyDrawScreen's `onUseGrid`): draw on
     * the grid instead of the survey photo. THE PHOTO IS NOT REMOVED.
     *
     * The name is historical -- GuestReadOnlyTest pins it -- and it is the
     * BACKGROUND that is cleared here, never the survey. The photo stays saved
     * with the job on this phone and in the cloud; [showSurveyPhoto] brings it
     * back, and neither choice touches it.
     *
     * Why this stopped clearing the photo. It used to write
     * `surveyImagePath = null` and leave `surveyStoragePath` alone. Those are
     * two fields and only the second TRAVELS, so the next sync pass downloaded
     * the photo again and "Use Grid" came back undone, with the drawing
     * unaligned to the picture ("I said use grid only, and when I got out and
     * I came back to the page, it brought back the survey picture"). The fix
     * proposed for that -- clear the travelling path too -- cannot work from
     * this side on an owner's phone: a null is dropped from the update it sends
     * (explicitNulls = false) and the row the server hands back is merged over
     * the phone's, so the path returns with the next push (SurveyNullsDoNotTravelTest
     * runs both). The crew door is different -- it sends an explicit null for a
     * key the phone changed -- but a choice that only holds on one kind of phone
     * is not a choice. And the owner asked for the survey to be SAVED, not
     * discarded. So the choice is made where it can be kept: a display setting,
     * remembered on this phone ([surveyPhotoShown]), that survives leaving the
     * screen.
     *
     * The one write this can make is a scale, and [DrawingScale.gridBackdropPlan]
     * decides it: a job that already has a scale keeps it untouched; a job with
     * no scale and nothing drawn on the photo gets the grid's own scale for its
     * own extent (the number every grid job starts with) so it is left able to
     * measure what is drawn on the grid; and a job with lines already drawn on
     * an uncalibrated photo is REFUSED ([gridNeedsScale]), because giving those
     * photo-pixel lines the grid's scale would price a made-up length.
     *
     * The choice is written first and the scale second, so a phone killed in
     * between is left on the grid with no scale (quotes nothing, asks for one)
     * and never on the photo with a scale nobody measured.
     */
    fun clearSurveyImage() {
        if (viewerIsGuestDemo()) return
        viewModelScope.launch {
            val current = repository.getJob(jobId) ?: return@launch
            val drawn = repository.getFenceRuns(jobId).any { FenceCodec.decodePoints(it.pointsEncoded).isNotEmpty() }
            when (val plan = DrawingScale.gridBackdropPlan(current, drawn)) {
                is GridBackdropPlan.NeedsScale -> _gridNeedsScale.tryEmit(Unit)
                is GridBackdropPlan.Allowed -> {
                    rememberSurveyShown(false)
                    val seed = plan.seed
                    if (seed != null) {
                        repository.updateJob(
                            current.copy(calibrationPixelsPerFoot = seed, calibrationKnownFeet = null)
                        )
                        // A new scale is a new drawing as far as Undo and Redo are concerned.
                        clearDrawingHistory()
                    }
                }
            }
        }
    }

    private val _gridNeedsScale = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    /** "Use Grid" refused: lines are drawn on a photo that has no scale yet. See [clearSurveyImage]. */
    val gridNeedsScale: SharedFlow<Unit> = _gridNeedsScale

    /**
     * "Show survey photo": the survey is the background again. A display
     * choice only -- nothing is written to the job, the drawing or the photo.
     */
    fun showSurveyPhoto() {
        if (viewerIsGuestDemo()) return
        rememberSurveyShown(true)
    }

    private val _fitRefused = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    /** A fit that was not applied, so the screen can say nothing changed. See [fitSurvey]. */
    val fitRefused: SharedFlow<Unit> = _fitRefused

    /**
     * Applies a fitted survey photo: the drawing and its scale move TOGETHER,
     * so not one measured foot changes. See [DrawingFit] for the rule and the
     * reasoning, and [DrawingFit.plan] for the footage check this refuses to
     * write without.
     *
     * What is written, in this order, under [drawingWrites] and out of reach of
     * the screen closing: every run's points and gates, every site marker,
     * and last the job's calibration. This is NOT one database transaction (the
     * repository exposes none across runs, markers and the job -- the same as
     * [setGridExtent]), and no order makes it safe to be interrupted: a phone
     * killed part-way is left with a drawing and a scale that are out of step,
     * whichever is written first. The window is a handful of local writes; the
     * order is only the one the rest of the drawing code already uses (drawing,
     * then the scale it is measured by).
     *
     * Refused, and nothing written, for a guest; for a job that is not a photo
     * job (the grid is resized with [setGridExtent]); and for a photo with no
     * scale, because a fit carries the drawing's scale across and has none to
     * carry -- it never invents one.
     *
     * Like every drawing edit this withdraws nothing by itself: the footage the
     * customer approved is unchanged, which is the point of the fit.
     */
    fun fitSurvey(fit: PhotoFit) {
        if (viewerIsGuestDemo()) return
        viewModelScope.launch {
            // The writes below must run to the end even if the screen is closed
            // while they do, or the drawing is left a different size from its scale.
            withContext(NonCancellable) {
                drawingWrites.withLock {
                    val current = repository.getJob(jobId)
                    if (current == null || !DrawingScale.isPhotoJob(current)) {
                        _fitRefused.tryEmit(Unit)
                        return@withLock
                    }
                    val runsNow = repository.getFenceRuns(jobId)
                    val markersNow = repository.getSiteMarkers(jobId)
                    val plan = DrawingFit.plan(
                        runs = runsNow.map { run ->
                            DrawingFit.RunDrawing(
                                run.id,
                                FenceCodec.decodePoints(run.pointsEncoded),
                                FenceCodec.decodeGates(run.gatesEncoded),
                                run.closedLoop
                            )
                        },
                        markers = markersNow.map { DrawingFit.MarkerAt(it.id, it.x, it.y) },
                        calibrationPixelsPerFoot = current.calibrationPixelsPerFoot,
                        fit = fit
                    )
                    if (plan == null) {
                        _fitRefused.tryEmit(Unit)
                        return@withLock
                    }

                    // Every run is about to be rewritten; nothing on any of them
                    // can be undone or redone onto the carried drawing.
                    clearDrawingHistory()
                    runsNow.forEach { run ->
                        val moved = plan.runs.firstOrNull { it.id == run.id } ?: return@forEach
                        if (moved.points.isEmpty() && moved.gates.isEmpty()) return@forEach
                        repository.updateFenceRun(
                            run.copy(
                                pointsEncoded = FenceCodec.encodePoints(moved.points),
                                gatesEncoded = if (moved.gates.isEmpty()) run.gatesEncoded
                                else FenceCodec.encodeGates(moved.gates)
                            )
                        )
                    }
                    markersNow.forEach { marker ->
                        val moved = plan.markers.firstOrNull { it.id == marker.id } ?: return@forEach
                        repository.updateSiteMarker(marker.copy(x = moved.x, y = moved.y))
                    }
                    // Last, and from the freshest row: the scale that goes with the
                    // drawing just written, and the known length cleared because the
                    // scale was carried across, not measured against this photo.
                    val latest = repository.getJob(jobId) ?: return@withLock
                    repository.updateJob(DrawingFit.jobAfter(latest, fit))

                    // The office sees a fit made from a crew phone, the way it sees a
                    // length change: the footage did not move, but the scale's basis did.
                    val name = editorName
                    if (name != null) {
                        com.fenceestimator.app.cloud.skipIfOrphaned {
                            repository.recordFieldChange(
                                FieldChange(
                                    jobId = jobId,
                                    summary = "Survey photo fitted to the drawing",
                                    detail = "Every length is unchanged. The scale was carried across " +
                                        "from the drawing, not measured on the photo.",
                                    changedBy = name,
                                    changedByRole = editorRole.orEmpty()
                                )
                            )
                        }
                    }
                }
            }
        }
    }

    companion object {
        /** The phone's own record of which background each job is drawn on. See [surveyPhotoShown]. */
        private const val BACKDROP_PREFS = "survey_backdrop"

        /**
         * Whether an attachment between two sides can be KEPT, and therefore
         * whether the Attach tool is offered at all.
         *
         * FALSE, and it has to stay false until BOTH of these are true. A tool
         * that cannot keep what it is given is worse than no tool: he would
         * attach four corners in a yard with no signal, close the app, and
         * find the fence in pieces again with nothing to say why.
         *
         *  1. A joint can be stored AND SYNCED. The PHONE half is now done:
         *     [FenceRun.startJoint] / [FenceRun.endJoint], the schema 50
         *     migration ([SchemaV50]), [Repository.setRunJointIds], the read
         *     at [jointIdsOf] and the write at [writeJointIds], and both
         *     EntitySync pull sites. The CLOUD half is NOT: the two columns do
         *     not exist in Postgres -- supabase_a32_join_runs.sql is written
         *     and unapplied (probed read-only, 1 Oct 2026) -- so
         *     EntitySync.JOIN_COLUMNS_LIVE is false and a joint cannot leave
         *     the handset.
         *
         *     THAT IS NOT MERELY "IT DOES NOT TRAVEL YET". fence_runs pushes a
         *     run only when the phone's clock beats the cloud's. A join made
         *     while JOIN_COLUMNS_LIVE is false pushes the run WITHOUT it, the
         *     cloud's clock then leads, and the run never pushes again on its
         *     own -- so that join is stranded on the phone for good, silently,
         *     and the office keeps pricing two posts. Apply the SQL and flip
         *     JOIN_COLUMNS_LIVE in the same change, then this.
         *
         *     Still outstanding either way: `start_joint` and `end_joint` in
         *     RUN_COLUMNS in price-job/index.ts, or the office reads no joint
         *     and the two engines price one job two ways.
         *  2. PART A of supabase_a56_join_reapproval_fingerprint.sql is live.
         *     Until it is, the re-approval fingerprint cannot see a joint
         *     (verified from pg_proc again on 1 Oct 2026 -- neither column name
         *     appears in any reapp_ function; docs/JOINING_RUNS.md 11.2), so
         *     attaching two runs on an APPROVED quote takes a post off the
         *     customer's agreed price and leaves the approval standing. Her
         *     price would move behind her back, which is the one rule this
         *     product does not walk past. ([JOIN_PRICING_READY] being false
         *     means no engine reads a joint today, so nothing is moving yet --
         *     but the fingerprint has to be able to see one BEFORE the tool
         *     ships, not after, because the first joint made is the one whose
         *     approval would stand wrongly.)
         *
         * Flipping this is the whole of turning the tool on; everything behind
         * it -- the decision at RunJoinGesture.decide, the read at
         * [jointIdsOf], the write at [writeJointIds] -- is written.
         * tests/a57-join-gesture-decision.test.mjs held it false while
         * FenceRun carried no joint field, so it could not be flipped ahead of
         * (1) by accident; now that the field exists, that check reads the
         * other way and must be retired with the rest of its section 2 (see
         * tests/a59-join-storage-roundtrip.test.mjs, which replaces it and
         * pins this flag to EntitySync.JOIN_COLUMNS_LIVE instead).
         */
        // TRUE since 2026-10-02. Both preconditions above were checked against
        // the LIVE database, not the repo .sql files, each probe with a positive
        // control and a canary that had to come back false:
        //
        //  1. price-job/index.ts selects start_joint and end_joint (its own
        //     JOIN_COLUMNS_LIVE is true), so the office reads the joint and the
        //     two engines price one job one way.
        //  2. PART A of supabase_a56_join_reapproval_fingerprint.sql is live and
        //     the fingerprint really does reach it. The
        //     chain is reapproval_on_drawing_change (an enabled AFTER INSERT OR
        //     UPDATE OR DELETE trigger on fence_runs) -> reapp_on_run_change ->
        //     reapp_job_takeoff -> reapp_row_takeoff, and reapp_row_takeoff is
        //     the function that reads start_joint.
        //
        //     Worth writing down because it nearly read as a blocker: asking
        //     whether reapp_job_takeoff calls reapp_RUN_takeoff returns FALSE.
        //     It does not -- it calls reapp_ROW_takeoff directly, and
        //     reapp_run_takeoff is a separate entry point not on this path.
        //     Checking the one intermediate and stopping there would have
        //     declared the fingerprint blind and withheld this tool for no
        //     reason. Read who calls whom, not whether one expected hop exists.
        //
        // Flipped in the SAME build as EntitySync.JOIN_COLUMNS_LIVE, never
        // ahead of it, for the stranding reason in that flag's own note.
        //
        // The write seam this turns on is [writeJointIds], read back by
        // [jointIdsOf]; both were already written and were answering false /
        // empty while this was off. tests/a59-join-storage-roundtrip.test.mjs
        // pins this flag to EntitySync.JOIN_COLUMNS_LIVE and to price-job's
        // RUN_COLUMNS, so neither can move without the others.
        const val JOIN_STORAGE_READY = true

        /**
         * "The point just added, whichever index that turned out to be."
         * See [offerJoinAfterDraw].
         */
        const val LAST_POINT = -1

        /**
         * Whether the ESTIMATE reads attachments yet.
         *
         * TRUE since engine version 2026.10.8. Both pricing engines now call
         * the join arithmetic: [EstimateEngine.joinAdjustments] feeds
         * RunJoinArithmetic.adjust on the phone, and priceJob does the same in
         * supabase/functions/_shared/pricing (its port is joins.ts). Two sides
         * at one joint share ONE post, so an attachment takes a post, its cap
         * and its concrete off the job and turns the two end posts that met
         * into one corner post -- a different catalog row at a different
         * price.
         *
         * SO THE CONFIRMATION MUST NOT SAY THE PRICE DOES NOT CHANGE any
         * more: `attach_price_later` in SurveyDrawScreen's JoinOfferDialog is
         * behind this flag and goes with it. A control that changes a price
         * nobody is told about and a control that changes nothing while
         * implying it does are the same lie pointing opposite ways, and this
         * flag is which way round it is.
         *
         * tests/a57-join-gesture-decision.test.mjs check 2h holds this flag to
         * the engine files themselves (comment-stripped), so it cannot drift
         * from what the engines actually do.
         *
         * SEPARATE FROM [JOIN_STORAGE_READY], which is still false: the price
         * half being ready does not put the Attach tool in front of anyone.
         * The tool waits on EntitySync.JOIN_COLUMNS_LIVE, because a join made
         * before the phone can send it is stranded on the handset for good.
         */
        const val JOIN_PRICING_READY = true

        /**
         * Units per foot on the no-photo grid, for a job that has not chosen a
         * size. Kept as the old fixed value so existing drawings measure
         * exactly what they always did. Lives in [DrawingScale] now, so the
         * estimate side reads the same number without reaching into a view
         * model; kept here so every existing caller still compiles unchanged.
         */
        const val PIXELS_PER_FOOT_GRID = DrawingScale.PIXELS_PER_FOOT_GRID

        /**
         * Grid sizes to choose from, in feet across -- the quick picks. Not a
         * ceiling any more: [zoomGridExtent] below reaches past the last of
         * these with no top of its own, so this list only has to cover the
         * common cases, not every case.
         *
         * A gate and a paddock are not the same drawing problem. At 400ft one
         * foot is about two and a half pixels on a phone and a 20ft run cannot
         * be drawn accurately; at 25ft the same run fills the screen.
         *
         * 400ft used to be the top of this list, which meant a job bigger than
         * that had nowhere to grow -- the fence kept running off the edge of
         * the grid with no size left to pick. 1000 and 2000 were added for
         * that (paddock and acreage jobs); 5000 and 10000 (roughly a mile and
         * two miles across) extend the same idea to a whole property line.
         * [setGridExtent] and [DrawingScale.unitsPerFoot] both work off a
         * plain ratio and have no ceiling of their own baked in -- the limit
         * was always this list, not the math underneath it.
         */
        val GRID_SIZES_FT = listOf(25f, 50f, 100f, 200f, 400f, 1000f, 2000f, 5000f, 10000f)

        /**
         * Floor for [zoomGridExtent]'s zoom-in direction -- the smallest quick
         * pick above. Below this a 20ft run stops being distinguishable from a
         * point on a phone screen (see the class doc on [GRID_SIZES_FT]); there
         * is no matching ceiling on the way out, which is the point of D1.
         */
        val MIN_GRID_EXTENT_FT = GRID_SIZES_FT.first()

        /**
         * The grid extent [ensureSatelliteCalibration] pins the drawing to
         * the MOMENT satellite turns on -- GRID_CANVAS_SIZE / this ==
         * PIXELS_PER_FOOT_GRID by construction, the same scale the office's
         * satellite tool starts at. Still exactly 400 (see
         * [GridExtentTest][com.fenceestimator.app.survey.GridExtentTest],
         * which pins this number and must keep passing).
         *
         * D1's OTHER half is what happens after that: this used to also be
         * where satellite's zoom stopped, full stop, because SatelliteAnchor
         * (SurveyDrawScreen.kt) hardcoded PIXELS_PER_FOOT_GRID as the scale
         * it draws imagery at -- correct only when gridExtentFt was exactly
         * this constant, wrong (silently mis-registering the photo against
         * whatever was drawn) the moment someone used the grid's own
         * "unlimited zoom" (+/- buttons, chips) while satellite was the
         * active background, which nothing ever prevented. SatelliteAnchor
         * now takes this job's real current scale instead, so satellite's
         * zoom genuinely follows the grid's -- as far as [satelliteCanFullyCover]
         * below says imagery can actually be fetched for. This constant
         * itself is UNCHANGED: it is still where satellite starts, not a
         * ceiling any more.
         */
        const val SATELLITE_CANVAS_EXTENT_FT = 400f

        /**
         * How many z=[SATELLITE_TILE_Z]
         * imagery tiles it would take to cover an [extentFt]-wide square of
         * ground centered on [siteLat] -- the real, latitude-dependent
         * question "how far can satellite actually see here", answered from
         * the same facts SurveyDrawScreen's SatelliteAnchor draws with
         * (SatelliteMath.feetPerPx, a fact of the Web Mercator projection
         * and latitude alone, and the app's own fixed tile-fetch zoom), not
         * a guessed number. Zero Compose, zero Android, so this can be
         * pinned by [SatelliteExtentTest][com.fenceestimator.app.survey.SatelliteExtentTest]
         * without a device -- the actual on-screen crop when the count runs
         * past budget (SurveyDrawScreen's visibleSatelliteTiles takes
         * whichever tiles come first in raster order once
         * [MAX_SATELLITE_TILES_FOR_EXTENT] is reached, not an even sample)
         * is not something this function claims to predict, and is not
         * something a plain JVM test can watch happen either -- see the
         * caveat on [maxSatelliteExtentFt].
         *
         * +1 tile of margin on each axis: the anchor centers the canvas on
         * the site's lat/lon, which essentially never lands exactly on a
         * z=20 tile boundary, so an [extentFt]-wide square straddles one
         * extra tile on every side beyond the plain division.
         *
         * Returns [Int.MAX_VALUE] (never "fits") for a non-finite or
         * non-positive feet-per-tile, or for a tile-per-axis count so large
         * that squaring it would overflow a 32-bit Int and silently wrap
         * back to a small or negative number that would wrongly read as
         * "fits". Both only happen as |[siteLat]| approaches 90 -- not a
         * real site this app is ever pointed at -- but a function with no
         * caller-checked precondition should not let an unrealistic input
         * turn into a falsely reassuring answer; [SatelliteExtentTest] pins
         * this specifically.
         */
        fun satelliteTilesNeeded(extentFt: Float, siteLat: Double): Int {
            if (extentFt <= 0f || !extentFt.isFinite()) return 0
            val feetPerTile = 256.0 *
                com.fenceestimator.app.cloud.SatelliteMath.feetPerPx(
                    siteLat, SATELLITE_TILE_Z
                )
            if (feetPerTile <= 0.0 || !feetPerTile.isFinite()) return Int.MAX_VALUE
            val acrossExact = kotlin.math.ceil(extentFt / feetPerTile) + 1.0
            // sqrt(Int.MAX_VALUE) is ~46340.95 -- anything at or past that
            // would overflow Int the moment it is squared below, so it is
            // turned into "does not fit" here instead of into whatever a
            // wrapped 32-bit multiply happens to produce.
            if (!acrossExact.isFinite() || acrossExact > 46_340.0) return Int.MAX_VALUE
            val across = acrossExact.toInt()
            return across * across
        }

        /**
         * The actual fetch ceiling [satelliteTilesNeeded] is measured
         * against -- SurveyDrawScreen.MAX_SATELLITE_TILES, duplicated as a
         * name (not a number) here so this file never has to guess it: if
         * that constant ever changes, this reference changes with it rather
         * than silently reading a stale copy the way two independently
         * hand-typed 64s could.
         */
        private val MAX_SATELLITE_TILES_FOR_EXTENT = MAX_SATELLITE_TILES

        /**
         * Whether satellite imagery can fully cover an [extentFt]-wide grid
         * at [siteLat] within the phone's own fetch budget
         * ([MAX_SATELLITE_TILES_FOR_EXTENT]) -- the honest question behind
         * "can the zoom-out button on satellite actually do anything here".
         * [extentFt] at or below [SATELLITE_CANVAS_EXTENT_FT] is always what
         * satellite already starts at and is not re-checked by anything
         * that calls this; this only matters once a grid zoomed out PAST
         * that default is asked to keep showing satellite too.
         */
        fun satelliteCanFullyCover(extentFt: Float, siteLat: Double): Boolean =
            satelliteTilesNeeded(extentFt, siteLat) <= MAX_SATELLITE_TILES_FOR_EXTENT

        /**
         * The largest extent, in feet, satellite imagery can fully cover at
         * [siteLat] before [MAX_SATELLITE_TILES_FOR_EXTENT] runs out --
         * what [LayersDialog][com.fenceestimator.app.ui.survey.LayersDialog]
         * tells a person once they have zoomed the grid out past it, so the
         * imagery thinning out or stopping reads as a stated limit rather
         * than an unexplained, silently cropped picture.
         *
         * A closed form, not a search: [satelliteTilesNeeded]'s tile count
         * per axis is `ceil(extentFt / feetPerTile) + 1`, which is at most
         * `floor(sqrt(MAX_SATELLITE_TILES_FOR_EXTENT))` exactly when
         * `extentFt <= (that - 1) * feetPerTile` -- ceil(x) <= n, for integer
         * n, iff x <= n. [SatelliteExtentTest] checks this formula against
         * [satelliteCanFullyCover] directly rather than trusting the algebra.
         *
         * Deliberately NOT a claim about what a person actually SEES at that
         * exact number -- SurveyDrawScreen's tile fetch takes whichever
         * tiles a raster scan reaches first once the budget is hit, not an
         * even crop, and which corner that leaves un-photographed depends on
         * where the canvas falls relative to tile boundaries. This number is
         * the honest "imagery is complete up to about here", not a promise
         * about the shape of what happens one foot past it -- that shape has
         * never been looked at on a device, and this file cannot look.
         *
         * A negative or non-finite result (only possible at |lat| >= 90, see
         * [satelliteTilesNeeded]) falls back to [SATELLITE_CANVAS_EXTENT_FT]
         * rather than handing a caller a number that cannot be drawn.
         */
        fun maxSatelliteExtentFt(siteLat: Double): Float {
            val feetPerTile = 256.0 *
                com.fenceestimator.app.cloud.SatelliteMath.feetPerPx(
                    siteLat, SATELLITE_TILE_Z
                )
            if (feetPerTile <= 0.0 || !feetPerTile.isFinite()) return SATELLITE_CANVAS_EXTENT_FT
            val maxAcross = kotlin.math.floor(kotlin.math.sqrt(MAX_SATELLITE_TILES_FOR_EXTENT.toDouble()))
            val result = ((maxAcross - 1.0) * feetPerTile).toFloat()
            return if (result.isFinite() && result > 0f) result else SATELLITE_CANVAS_EXTENT_FT
        }

        /** Units per foot for a grid covering [extentFt] across. See [DrawingScale.unitsPerFoot]. */
        fun unitsPerFoot(extentFt: Float): Float = DrawingScale.unitsPerFoot(extentFt)

        /**
         * The next grid extent when zooming the GRID (not satellite) out or
         * in by one step -- D1's "keep finding grid" control, distinct from
         * [GRID_SIZES_FT]'s fixed quick-pick chips.
         *
         * Doubles (zooming out, [factor] = 2) or halves (zooming in, [factor]
         * = 0.5) the CURRENT extent rather than stepping through a fixed
         * list, so it has no top: every tap finds a bigger grid than the last,
         * forever, which is what "unlimited" means here. The only floor is
         * [MIN_GRID_EXTENT_FT], zooming in, for the same accuracy reason
         * [GRID_SIZES_FT] starts at 25ft rather than 1ft.
         *
         * A pure function of the current extent and nothing else -- no job,
         * no side effect -- so [GridExtentTest] can pin the doubling/halving
         * relationship without a database. The caller still goes through
         * [setGridExtent] to apply the result, which is what actually
         * rescales the drawing and keeps every measured length unchanged;
         * this only decides what number to ask it for.
         *
         * Guards against a non-finite result (an extent so large that
         * doubling it overflows Float to infinity) by returning [current]
         * unchanged rather than asking [setGridExtent] to calibrate against
         * infinity -- not reachable from the UI in practice (it would take
         * on the order of a hundred taps from the largest quick pick), but a
         * function with no caller-supplied ceiling should not trust the
         * caller to stop tapping.
         */
        fun zoomGridExtent(current: Float, factor: Float): Float {
            val base = if (current.isFinite() && current > 0f) current else MIN_GRID_EXTENT_FT
            val next = base * factor
            if (!next.isFinite() || next <= 0f) return base
            return next.coerceAtLeast(MIN_GRID_EXTENT_FT)
        }

        /**
         * The real-world size of one grid square for a grid covering
         * [extentFt] across -- squares that read sensibly at any size: about
         * twenty across, so a 25ft grid gets roughly 1ft squares and a 400ft
         * grid gets 20ft ones, and (the point of D1) a 10000ft grid gets
         * 500ft ones rather than either vanishing into a solid colour or
         * needing to draw 400 lines to stay "1ft apart".
         *
         * [setGridExtent] writes this alongside calibrationPixelsPerFoot every
         * time the extent changes, which is what keeps it meaningful: paired
         * with [unitsPerFoot], one square is always
         * `gridFeetPerSquareFor(extentFt) * unitsPerFoot(extentFt)` ==
         * `GRID_CANVAS_SIZE / 20` canvas units, a constant independent of
         * extentFt -- see [GridExtentTest]. That constant is also what bounds
         * SurveyDrawScreen's drawGrid to a fixed number of lines per axis
         * under ordinary use (it does not depend on this function once
         * someone hand-types a spacing of their own, which is why drawGrid
         * carries its own explicit ceiling too).
         *
         * Extracted out of [setGridExtent] so the ratio can be pinned by a
         * plain unit test without a repository or a job.
         */
        fun gridFeetPerSquareFor(extentFt: Float): Float = (extentFt / 20f).coerceAtLeast(0.5f)

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

        // ------------------------------------------------------------------
        // A65: which run the drawing opens on, and what a typed number has to
        // be before it is allowed to reach a priced row.
        //
        // Everything in this block is PURE -- no repository, no Context, no
        // clock -- for one reason: tests/a65-run-selection-and-input-guards
        // .test.mjs transcribes these rules and runs them in plain node,
        // because this sandbox cannot run Gradle and the Kotlin unit tests
        // with it. A rule that lives inside a composable or behind a
        // suspend repository call is a rule nothing off-device can check,
        // and "bugs live where tests don't" is how both of the findings
        // below survived to reach a real quote.
        // ------------------------------------------------------------------

        /**
         * Which run the drawing screen should have selected.
         *
         * THE BUG THIS EXISTS TO FIX. "Next: Draw This Fence" and "Edit the
         * Drawing" on RunEditScreen used to navigate with the JOB id alone
         * (Routes.survey(jobId)), so a fresh SurveyViewModel opened with
         * selectedRunId = null and the old ensureSelection took
         * runs.firstOrNull(). Somebody who had just named and typed up side 2
         * tapped the button on side 2's own screen, got the drawing with side
         * 1 selected, and every corner they then placed was appended to side
         * 1's polyline. Side 1's footage jumped, side 2 stayed empty, and the
         * quote stopped describing the yard -- with nothing on screen saying
         * which run was taking the taps.
         *
         * So the route now carries an optional run id (Routes.survey(jobId,
         * runId)) and it arrives here as [requestedRunId]. The rules, in
         * order:
         *
         *  1. Asked-for run is in the list -> select it, request satisfied.
         *  2. Asked-for run and the list is EMPTY -> change nothing and keep
         *     the request pending. The list has not loaded; selecting
         *     "firstOrNull" here would pick null and then rule 4 would latch
         *     run 1 the instant the real list arrived, which is the original
         *     bug wearing a route parameter.
         *  3. Asked-for run, list is loaded, run is NOT in it -> the request
         *     is dead (run deleted on another phone, or a route hand-typed
         *     against the wrong job) and is dropped rather than retried
         *     forever. Falls through to rule 4, which is the old behaviour,
         *     because a drawing with nothing selected takes no taps at all
         *     and that is worse than the wrong run being selected visibly.
         *  4. No request: keep the current selection if it still exists,
         *     otherwise the first run. Byte-for-byte the old rule -- the
         *     job-only route (JobDetailScreen's "Survey", the only other
         *     caller) must behave exactly as it did.
         *
         * A [requestedRunId] of 0 or less is no request at all: 0 is what
         * NavType.LongType hands back for the argument's default when the
         * query parameter is absent, and a Room id is always >= 1.
         */
        fun resolveRunSelection(
            runIds: List<Long>,
            currentSelection: Long?,
            requestedRunId: Long?
        ): RunSelection {
            val asked = requestedRunId?.takeIf { it > 0L }
            if (asked != null) {
                if (runIds.contains(asked)) return RunSelection(asked, requestStillPending = false)
                // Rule 2: the list has not arrived yet. Hold the request and
                // leave the selection exactly where it was.
                if (runIds.isEmpty()) return RunSelection(currentSelection, requestStillPending = true)
                // Rule 3: loaded, and the run is genuinely not here. Fall
                // through, request spent.
            }
            val keepable = currentSelection?.takeIf { runIds.contains(it) }
            return RunSelection(keepable ?: runIds.firstOrNull(), requestStillPending = false)
        }

        /**
         * The sort order a newly created run must get: one past the highest
         * already on the job.
         *
         * THE SECOND HALF OF THE SAME BUG. FenceRunDao orders every read
         * `ORDER BY sortOrder ASC, syncId ASC` (data/Daos.kt), and
         * [createBlankRun] used to leave sortOrder at its entity default of 0
         * (data/Entities.kt's FenceRun). So a run added from the drawing
         * screen TIED with run 1 on sortOrder and the tie was broken by
         * syncId -- a random UUID. The run list therefore re-shuffled itself
         * whenever a run was added, and "the first run" (rule 4 above, and
         * the old ensureSelection on its own) meant a different row from one
         * visit to the next.
         *
         * Identical to FenceRunListViewModel.addRun's `nextOrder`, which has
         * always been right, and deliberately written the same way round so
         * the two cannot drift: a job must not have two ideas of what order
         * its sides go in depending on which screen made them.
         *
         * `-1 + 1 == 0` keeps the very first run on a job at sortOrder 0,
         * which is what every drawing already in the database has.
         */
        fun nextSortOrder(existingSortOrders: List<Int>): Int =
            (existingSortOrders.maxOrNull() ?: -1) + 1

        /**
         * A name for a run created from the drawing screen that a person can
         * actually tell apart.
         *
         * THE THIRD HALF. [createBlankRun] left [FenceRun.label] at its
         * entity default of "" and the drawing screen renders a blank label
         * as "Untitled (Vinyl)" (SurveyDrawScreen's runTitle). Add three
         * sides from the drawing and the picker reads "Untitled (Vinyl)"
         * three times, in an order that moves -- so there was no way to tell
         * from the screen which row was about to take the next tap. Naming
         * them is half of the selection fix: carrying the right run through
         * the route is useless if the user cannot see which one is selected.
         *
         * The smallest free number, not a count: deleting side 2 of three and
         * adding again gives "Side 2" back rather than a second "Side 4".
         * Compared case-insensitively and trimmed, because these are matched
         * against labels a person has typed by hand.
         *
         * ENGLISH, not a string resource, deliberately. This value is
         * PERSISTED to fence_runs.label and pushed to the cloud, where the
         * office and every other phone read it -- a localised default would
         * mean the stored name of a side depended on the language of the
         * handset that happened to create it, and two phones on one job would
         * disagree about what the side is called. FenceRunListViewModel
         * .duplicateRun makes the same call for the same reason ("Copy").
         * The user renames it the moment they care; nothing is priced from it.
         */
        fun nextQuickRunLabel(existingLabels: List<String>, isTeardown: Boolean): String {
            val stem = if (isTeardown) "Old fence" else "Side"
            val taken = existingLabels.map { it.trim().lowercase() }.toSet()
            var n = 1
            while (taken.contains("$stem $n".lowercase())) n++
            return "$stem $n"
        }

        /**
         * Reads a typed measurement that has to be a positive, finite number
         * of feet (or inches) before anything is allowed to price from it.
         *
         * THE SECOND FINDING. A gate width or a panel width of 0, -1, NaN or
         * Infinity reaches the takeoff, the takeoff produces no usable
         * quantity for the panel, line-post, cap and concrete rows, and the
         * office commit then DELETES those priced lines and nulls the
         * contract total. The number that caused it is three screens away
         * from the damage, which is why this refuses at the keyboard instead:
         * by the time a quote has lost its panel lines there is nothing on
         * screen connecting that to a gate width somebody typed.
         *
         * The ordering of the checks is the message quality. "0" and "" are
         * different mistakes with different fixes, and so are "5ft" and
         * "Infinity"; one lumped "that number is no good" would leave a
         * person retyping the same thing.
         *
         * A comma is read as a decimal point before parsing, the same as
         * DraftNumberField already does and for the same reason: a Spanish or
         * French keyboard offers a comma, parseFloat reads only a dot, and
         * "8,5" otherwise looked accepted and saved nothing.
         *
         * KNOWN AND ACCEPTED: parseFloat also allows a trailing type suffix,
         * so "5f" and "5d" read as 5.0 and a hex literal like "0x1p3" reads
         * as 8.0. Left alone -- somebody typing "5f" for five feet getting
         * five feet is the answer they wanted, and the refusals that cost
         * money are the four above, not this.
         */
        fun readPositiveMeasure(raw: String): NumberEntry {
            val trimmed = raw.trim().replace(',', '.')
            if (trimmed.isEmpty()) return NumberEntry(null, NumberRefusal.BLANK)
            val parsed = trimmed.toFloatOrNull()
                ?: return NumberEntry(null, NumberRefusal.NOT_A_NUMBER)
            if (!parsed.isFinite()) return NumberEntry(null, NumberRefusal.NOT_FINITE)
            if (parsed <= 0f) return NumberEntry(null, NumberRefusal.NOT_POSITIVE)
            return NumberEntry(parsed, null)
        }

        /**
         * [readPositiveMeasure] for an already-parsed Float -- what
         * DraftNumberField hands its callers.
         *
         * DraftNumberField (ui/components/DraftFields.kt) parses for itself
         * and pushes `0f` for a blank box, by a deliberate decision made for
         * a different field: a markup percentage wiped out to leave it at
         * nothing used to stay at 15%, and the blank box said otherwise. That
         * is right for a markup and wrong for a panel width, where 0 is not a
         * value a fence can have -- clearing the box wiped the panel and
         * line-post lines out of a vinyl, aluminium or ornamental quote,
         * every keystroke saved as it was typed.
         *
         * So the shared field is left exactly as it is -- narrowing it would
         * change every screen that uses it, including the markup it was
         * written for -- and the refusal is applied at the call site that
         * needs it (ui/runs/RunEditScreen.kt's PositiveNumberField). BLANK
         * and a typed zero are indistinguishable by the time they get here,
         * and both are refused, so nothing is lost by not telling them apart.
         */
        fun checkPositive(value: Float): NumberRefusal? = when {
            !value.isFinite() -> NumberRefusal.NOT_FINITE
            value <= 0f -> NumberRefusal.NOT_POSITIVE
            else -> null
        }

        /**
         * [checkPositive] for a field where zero is a real answer -- concrete
         * bags per post (a wall-hung gate takes none) and picket gap (a
         * privacy fence has none). Only non-finite and negative are refused.
         */
        fun checkNonNegative(value: Float): NumberRefusal? = when {
            !value.isFinite() -> NumberRefusal.NOT_FINITE
            value < 0f -> NumberRefusal.NOT_POSITIVE
            else -> null
        }

        /**
         * Whether a point is safe to write into fence_runs.points_encoded.
         *
         * FenceCodec.encodePoints writes "${x}:${y}" and decodePoints reads it
         * back with toFloatOrNull -- and both ends of that round-trip handle
         * "NaN" and "Infinity" perfectly happily (see [NumberRefusal
         * .NOT_FINITE]). So one non-finite coordinate persists, syncs to the
         * cloud, and poisons every length measured from the run it sits on.
         * FenceGeometryEngine.analyze cannot defend against it either: its
         * guard is `pixelsPerFoot <= 0f`, which says nothing about the points.
         *
         * Refused here, at the one function every point write goes through,
         * rather than in the codec: the codec is also what READS drawings
         * that are already in the database, and a job that already carries a
         * bad point needs its drawing shown so it can be repaired, not
         * silently emptied.
         */
        fun isWritablePoint(x: Float, y: Float): Boolean = x.isFinite() && y.isFinite()

        /**
         * Whether a stored pixels-per-foot calibration can be measured by.
         *
         * [applyCalibration] guarded `knownFeet <= 0f`, which NaN slips
         * straight through -- `NaN <= 0f` is false -- so a NaN known-distance
         * stored a NaN calibration, and an Infinity one stored exactly 0.0
         * (distPx / Infinity). Both then price the whole fence at $0:
         * FenceGeometryEngine.analyze returns an empty result for
         * `pixelsPerFoot <= 0f`, so every side measures zero feet.
         *
         * Same rule as DrawingScale.of's own `it > 0f && it.isFinite()`, and
         * written to match it on purpose.
         */
        fun isUsableCalibration(pixelsPerFoot: Float?): Boolean =
            pixelsPerFoot != null && pixelsPerFoot > 0f && pixelsPerFoot.isFinite()

        /** Long enough that dragging a corner re-prices once, not once per frame. */
        private const val REPRICE_DEBOUNCE_MS = 700L
        /** Virtual canvas size (width == height) used when there's no survey photo -- 400ft x 400ft of drawable area. */
        const val GRID_CANVAS_SIZE = DrawingScale.GRID_CANVAS_SIZE
        /** Below this, a footage change is someone nudging a corner, not a real change. */
        const val MIN_REPORTABLE_FEET = 3f
    }
}
