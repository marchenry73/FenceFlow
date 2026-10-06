package com.fenceestimator.app.ui.survey

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AssistChip
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitLongPressOrCancellation
import com.fenceestimator.app.R
import com.fenceestimator.app.ui.components.EmptyState
import com.fenceestimator.app.geometry.GateGeometry
import androidx.compose.material3.FilterChip
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.CloseFullscreen
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowLeft
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.OpenInFull
import androidx.compose.material.icons.filled.MyLocation
import androidx.compose.material.icons.filled.OpenWith
import androidx.compose.material.icons.filled.PanTool
import androidx.compose.material.icons.filled.Redo
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material.icons.filled.Straighten
import androidx.compose.material.icons.filled.Undo
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.TextButton
import androidx.compose.ui.graphics.drawscope.rotate
import com.fenceestimator.app.ui.runs.SideTypesCard
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.cloud.Satellite
import com.fenceestimator.app.cloud.SatelliteMath
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.SiteMarker
import com.fenceestimator.app.data.SiteMarkerKind
import com.fenceestimator.app.estimate.DrawingFit
import com.fenceestimator.app.estimate.DrawingScale
import com.fenceestimator.app.estimate.PhotoFit
import com.fenceestimator.app.estimate.ScaleBasis
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FenceGeometryEngine
import com.fenceestimator.app.geometry.FencePoint
import com.fenceestimator.app.geometry.GateMarker
import com.fenceestimator.app.geometry.GateMounting
import com.fenceestimator.app.geometry.GateSpan
import com.fenceestimator.app.geometry.JoinPostKind
import com.fenceestimator.app.geometry.JoinRefusal
import com.fenceestimator.app.geometry.VertexKind
import com.fenceestimator.app.geometry.angleCue
import com.fenceestimator.app.ui.components.FeetInches
import com.fenceestimator.app.ui.components.DraftNumberField
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp
import com.fenceestimator.app.ui.components.label
import com.fenceestimator.app.ui.components.labelRes
import com.fenceestimator.app.ui.theme.Graphite40
import com.fenceestimator.app.ui.theme.PlanColors
import com.fenceestimator.app.ui.theme.Radius
import com.fenceestimator.app.ui.theme.SafetyOrange40
import com.fenceestimator.app.ui.theme.Space
import com.fenceestimator.app.ui.theme.SteelTeal20
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.fenceestimator.app.ui.theme.semantic
import kotlin.math.roundToInt
import kotlin.math.max
import kotlin.math.min

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SurveyDrawScreen(
    jobId: Long,
    onBack: () -> Unit,
    onGoToEstimate: (Long) -> Unit,
    /**
     * The run to open on, from the route's `runId` query parameter
     * (com.fenceestimator.app.ui.nav.Routes.survey), or null for the old
     * "first run" behaviour.
     *
     * Default null so the job-only caller compiles and behaves unchanged.
     */
    openRunId: Long? = null
) {
    val app = currentApp()
    // Keyed on the JOB only, deliberately NOT on openRunId. The view model
    // holds this job's Undo and Redo history, and keying it on the run would
    // hand out a fresh, empty history every time the drawing was opened on a
    // different side -- so arriving from side 2's screen would throw away the
    // Undo stack for side 1.
    val viewModel: SurveyViewModel = viewModel(
        key = "survey_$jobId",
        factory = GenericViewModelFactory { SurveyViewModel(app.repository, jobId, app) }
    )
    // Attribute edits so the office knows who changed the plan and when. Only
    // for people working under someone -- an owner editing their own drawing
    // has nobody to report to, and logging that would be noise.
    val session by app.session.state.collectAsState()
    // This screen had no guest check at all before -- reached from the run
    // screen's ungated "Edit drawing" button with nothing behind it, a guest
    // could add a fence run, draw points, add gates and drop site markers.
    // The requirement is look at everything, change nothing, and a read-only
    // view of the drawing IS achievable here -- the canvas and every panel
    // below only ever READ runs/gates/siteMarkers, so nothing about routing a
    // guest away from this screen was necessary. What is refused instead:
    // the mode switcher offers only Move View (pan/zoom, itself a pure view
    // control) so the write-capable tools are never in hand rather than
    // present and silently doing nothing; the Add Run controls, the Layers
    // dialog's upload/grid/satellite actions and the closed-loop/Clear
    // controls in the property panel are refused at their own call sites
    // below. SurveyViewModel repeats every one of these as its own guard, so
    // this is the second line of defence the review asked for, not the only
    // one -- the same shape as RunEditScreen's `editable`.
    val editable = !session.isGuestDemo
    LaunchedEffect(session.role, session.email) {
        val reportsToSomeone = session.role in setOf(
            com.fenceestimator.app.cloud.UserRole.CREW,
            com.fenceestimator.app.cloud.UserRole.FOREMAN
        )
        viewModel.editorName = if (reportsToSomeone) session.email ?: "Crew" else null
        viewModel.editorRole = session.role.label
    }

    var lastTapAtMs by remember { mutableStateOf(0L) }
    var lastTapOffset by remember { mutableStateOf<Offset?>(null) }
    // The point the FIRST tap of a possible double-tap actually added, kept so
    // the second tap can take back exactly that one rather than guessing from
    // coordinates. finishSideByDoubleTap used to compare the last two points
    // for exact float equality, but the gesture accepts a second tap anywhere
    // within DOUBLE_TAP_SLOP_PX -- and the snap can move a point as well. So
    // two taps close enough to COUNT as a double-tap, yet not pixel-identical,
    // ended the side AND left the stray point behind. That is the owner's
    // report: "double click on the grid ... creates a line before opening the
    // new slide, it messes up the fence."
    var lastAddedPoint by remember { mutableStateOf<com.fenceestimator.app.geometry.FencePoint?>(null) }
    val sideFinished by viewModel.sideFinished.collectAsState()
    val job by viewModel.job.collectAsState()
    // Whether the survey photo is the background right now. A display choice,
    // remembered on this phone, that never touches the photo or the job -- see
    // SurveyViewModel.clearSurveyImage.
    val surveyShown by viewModel.surveyPhotoShown.collectAsState()
    // Warn before an approved job's drawing gets touched, not after --
    // editing it withdraws the customer's approval (docs/REAPPROVAL_RULE.md)
    // and this is the one place someone can be told what is about to happen
    // rather than discovering it once the quote silently needs re-approving.
    // Shown once per screen visit, gated on the job actually being loaded so
    // it doesn't flash for a null job on first composition.
    var shownDrawingWarning by rememberSaveable(jobId) { mutableStateOf(false) }
    var showDrawingWarningDialog by remember { mutableStateOf(false) }
    LaunchedEffect(job?.id) {
        val currentJob = job
        if (currentJob != null && !shownDrawingWarning &&
            com.fenceestimator.app.reapproval.shouldWarnBeforeEditingDrawing(
                currentJob.quoteApprovedAt, currentJob.reapprovalRequiredAt
            )
        ) {
            showDrawingWarningDialog = true
            shownDrawingWarning = true
        }
    }
    if (showDrawingWarningDialog) {
        AlertDialog(
            onDismissRequest = { showDrawingWarningDialog = false },
            title = { Text(stringResource(R.string.reapproval_warn_editing_title)) },
            text = { Text(stringResource(R.string.reapproval_warn_editing)) },
            confirmButton = {
                androidx.compose.material3.Button(onClick = { showDrawingWarningDialog = false }) {
                    Text(stringResource(R.string.reapproval_warn_editing_dismiss))
                }
            }
        )
    }
    val runs by viewModel.runs.collectAsState()
    val selectedRunId by viewModel.selectedRunId.collectAsState()
    val mode by viewModel.mode.collectAsState()
    // True when a drawing change couldn't be re-priced, so materials and the
    // estimate total are stale until someone opens the estimate to recalculate.
    val repriceFailed by viewModel.repriceFailed.collectAsState()
    // For the run a gate creates for itself when the job has no fence drawn --
    // it should carry the same defaults a hand-added run would.
    val runDefaults by app.settingsStore.profile.collectAsState(
        initial = com.fenceestimator.app.data.BusinessProfile()
    )
    val pendingCalibration by viewModel.pendingCalibrationPoints.collectAsState()
    val context = LocalContext.current

    // Lodged once per visit, before any ensureSelection can run, and keyed on
    // the run asked for rather than on `runs`: this must not be re-lodged on
    // every database emission, or hand-picking a different side on the run
    // chips would be undone by the next sync.
    //
    // The request OUTLIVES this effect inside the view model, because `runs`
    // is empty on the first frame and only fills in when Room answers -- see
    // SurveyViewModel.resolveRunSelection rule 2 for why answering an empty
    // list as though the run were missing is the original bug again.
    LaunchedEffect(openRunId) { viewModel.requestRun(openRunId) }

    LaunchedEffect(runs) { viewModel.ensureSelection() }

    var bitmap by remember { mutableStateOf<Bitmap?>(null) }
    var canvasSize by remember { mutableStateOf(IntSize.Zero) }

    // Satellite: an alternative background to the no-photo grid, for jobs
    // where the office would otherwise be the only one who could trace a
    // fence off aerial imagery. Never offered alongside an uploaded photo --
    // toggled off automatically below the moment one exists -- because the
    // office's own calibration rule (20 px/ft) only applies when there is
    // nothing else to calibrate against.
    var satelliteOn by rememberSaveable { mutableStateOf(false) }
    var satelliteError by remember { mutableStateOf<String?>(null) }
    // Tiles are cached in Satellite's own in-memory LRU (survives navigating
    // away and back); this map is just which of those this SCREEN has
    // already asked for, so the same tile is never requested twice from one
    // sitting at the canvas.
    val satelliteTiles = remember { mutableStateMapOf<String, Bitmap>() }
    val online by app.connectivity.online.collectAsState()
    /** A gate the user tapped, held until they confirm taking it off. */
    var pendingGateRemoval by remember(selectedRunId) {
        mutableStateOf<com.fenceestimator.app.geometry.GateMarker?>(null)
    }
    /** Set when Clear is tapped, held until confirmed. Same shape as gate removal below: this drawing is what the takeoff, post count, material order and price all come from, so wiping it is not a one-tap action. */
    var pendingClearPoints by remember(selectedRunId) { mutableStateOf(false) }
    /**
     * Set when Erase is tapped on the run picker row, held until confirmed.
     *
     * Keyed on the selected run like the two above: switching runs while the
     * dialog is up would otherwise leave a confirmation naming one run and a
     * selection pointing at another, and the Erase would take the wrong one.
     */
    // WHICH run is being erased, carried explicitly, and deliberately NOT keyed
    // on selectedRunId.
    //
    // This was `pendingRunErase by remember(selectedRunId)`, a plain boolean
    // meaning "erase the selected one". That is safe while the only way in is a
    // toolbar button acting on the selection, and it quietly breaks the moment
    // a long-press names a DIFFERENT run: selecting the pressed side rebuilds
    // this state and resets it to false, so the dialog never opens at all --
    // and it would have tested fine, because long-pressing the ALREADY-selected
    // side changes no key and works. The two lines below are keyed the same
    // way, so selecting on long-press also throws away his zoom and pan.
    //
    // Carrying the id means neither has to move.
    var pendingEraseRunId by remember { mutableStateOf<Long?>(null) }
    var viewZoom by remember(selectedRunId) { mutableStateOf(1f) }
    var viewPan by remember(selectedRunId) { mutableStateOf(Offset.Zero) }

    // FITTING the survey photo to the drawing. Null means not fitting. While a
    // draft is held the photo is drawn moved and zoomed under a drawing that
    // stays put, and nothing is written -- Apply hands the draft to
    // SurveyViewModel.fitSurvey, which carries the drawing and its scale
    // together so no measured foot changes; Cancel (or Back, or picking another
    // tool) just drops it. The draft is in drawing units, so it means the same
    // thing at any view zoom.
    var fitDraft by remember { mutableStateOf<PhotoFit?>(null) }
    val fitActive = fitDraft != null
    BackHandler(enabled = fitActive) { fitDraft = null }
    LaunchedEffect(mode) { fitDraft = null }

    var fullScreenDrawing by rememberSaveable { mutableStateOf(false) }
    // Grouped floating controls (the grouped-tools/layers/property-info
    // redesign): whether the Layers popup is open, whether the property
    // panel is showing its expanded detail, and which paint layers are on.
    // Fence and markers default visible so nothing changes on open unless
    // someone deliberately hides one -- these three are read only inside
    // the Canvas draw scope below and never reach the view model, so
    // hiding a layer can never touch the geometry, the takeoff or the price.
    var layersMenuOpen by remember { mutableStateOf(false) }
    var propertyPanelExpanded by remember { mutableStateOf(false) }
    var showFenceLayer by rememberSaveable { mutableStateOf(true) }
    var showMarkersLayer by rememberSaveable { mutableStateOf(true) }
    // Gates and dimension labels used to be inseparable from the fence line
    // itself (drawn inside the same showFenceLayer block); they are real,
    // independently useful things to hide -- a crew reading corner counts off
    // a busy plan wants the labels gone, someone counting openings wants only
    // the gates -- so they get their own toggles rather than riding along.
    var showGatesLayer by rememberSaveable { mutableStateOf(true) }
    var showDimensionsLayer by rememberSaveable { mutableStateOf(true) }
    var calibrationDialogPoints by remember { mutableStateOf<Pair<FencePoint, FencePoint>?>(null) }
    var gateDialogPoint by remember { mutableStateOf<FencePoint?>(null) }
    // Which segment's dimension is open for typing, if any. Lives out here
    // beside the other dialog state so the dialog itself can sit with them.
    var editingSegment by remember { mutableStateOf<Int?>(null) }
    /**
     * Snapping, on by default.
     *
     * Safe as a default because nothing here is forced: a point only moves
     * when it was already within a few degrees or a few inches of what it
     * was plainly aiming at. Aim at thirty degrees and you get thirty
     * degrees. The switch exists anyway, because a lot with no square corner
     * in it is a real thing and being argued with by a tool is worse than
     * tracing freehand.
     */
    var snapOn by rememberSaveable { mutableStateOf(true) }
    /** What the last placed point was pulled onto, so the screen can say so. */
    var lastSnap by remember { mutableStateOf<com.fenceestimator.app.geometry.SnapResult?>(null) }
    // A cue about a point on another run, or from another tool, is a cue
    // about nothing on screen.
    LaunchedEffect(mode, selectedRunId) { lastSnap = null }
    // The Snap chip used to say only "Snap" -- no label of what it does.
    // Reported as "I don't even know what that does in detail". This
    // explains it once, in place of the chip's usual (empty, at that point)
    // cue line; a real snap event explains itself better than the hint can
    // ("Square to the last side"), so the first one retires it for good.
    // Read from the device's own settings, not remembered in the composable:
    // rememberSaveable survives rotation only, so the beginner's line came
    // back on every cold start for someone who had read it months ago. True
    // until DataStore answers, so the hint never flashes on for a frame at a
    // phone that has already seen it.
    val snapIntroSeen by app.settingsStore.snapIntroSeen.collectAsState(initial = true)
    LaunchedEffect(lastSnap) {
        if (lastSnap != null && !snapIntroSeen) app.settingsStore.markSnapIntroSeen()
    }
    var markerDialogPoint by remember { mutableStateOf<FencePoint?>(null) }
    val siteMarkers by viewModel.siteMarkers.collectAsState()

    val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) viewModel.importImage(context, uri)
    }

    LaunchedEffect(job?.surveyImagePath, surveyShown) {
        // The photo is loaded only while it is the background. Hiding it (Use
        // Grid) leaves the file and the job untouched.
        val path = if (surveyShown) job?.surveyImagePath else null
        bitmap = if (path != null) {
            withContext(Dispatchers.IO) { BitmapFactory.decodeFile(path) }
        } else null
    }

    val usingGrid = bitmap == null
    LaunchedEffect(usingGrid) {
        if (usingGrid) viewModel.ensureGridCalibration()
        // A photo appearing (upload, or another device's photo syncing down)
        // must drop satellite mode -- the toggle to turn it back on
        // disappears from the UI the same moment usingGrid goes false, but
        // without this the state itself would linger and a stale set of
        // tiles could keep drawing underneath the newly-uploaded photo.
        else satelliteOn = false
    }

    // Turning satellite on needs the property placed on the map (geocoding
    // the address once, if this job has never been placed before -- mirrors
    // the office's openSatellite()) and needs the drawing pinned to exactly
    // 20 px/ft before anything gets traced on it, so a point placed before
    // the geocode lands doesn't end up measured against the wrong scale.
    LaunchedEffect(satelliteOn) {
        if (!satelliteOn) return@LaunchedEffect
        satelliteError = null
        when (val result = viewModel.ensureSiteLocation()) {
            is SurveyViewModel.SiteLocationResult.Ready ->
                // Turning satellite on pins the drawing to 400ft across. A
                // drawing that already reaches further than that cannot come
                // with it -- see ensureSatelliteCalibration -- so satellite
                // goes back off and says why, rather than silently throwing
                // the fence off the edge of the canvas.
                when (val cal = viewModel.ensureSatelliteCalibration()) {
                    is SurveyViewModel.SatelliteCalibration.Ready -> Unit
                    is SurveyViewModel.SatelliteCalibration.TooBig -> {
                        satelliteError = context.getString(
                            R.string.survey_satellite_too_big_for_scale, cal.acrossFt
                        )
                        satelliteOn = false
                    }
                }
            is SurveyViewModel.SiteLocationResult.Failed -> {
                satelliteError = result.message
                satelliteOn = false
            }
        }
    }

    // Undo's one-shot "I did nothing, here's why" event (see
    // SurveyViewModel.undoNothingToDo) -- surfaced as a snackbar so a press
    // that removes nothing is never silent. DRAWING_CHANGED gets its own
    // words: there WAS something to undo a moment ago, and it was dropped
    // because the office or another phone changed the run since. "Nothing to
    // undo on this run yet" reads as though the last edit never registered,
    // and sends people tapping Undo again or redoing work that is already
    // there. Branches on the reason enum, never on the words, the same as Redo.
    val snackbarHostState = remember { SnackbarHostState() }
    val undoNothingMessage = stringResource(R.string.draw_undo_nothing_to_undo)
    val undoChangedMessage = stringResource(R.string.draw_undo_drawing_changed)
    LaunchedEffect(Unit) {
        viewModel.undoNothingToDo.collect { reason ->
            snackbarHostState.showSnackbar(
                when (reason) {
                    com.fenceestimator.app.geometry.UndoNoneReason.DRAWING_CHANGED -> undoChangedMessage
                    com.fenceestimator.app.geometry.UndoNoneReason.NOTHING_TO_UNDO,
                    com.fenceestimator.app.geometry.UndoNoneReason.NO_RUN_SELECTED -> undoNothingMessage
                }
            )
        }
    }
    // Redo explains itself the same way. Branches on the reason enum, never
    // on the words, so a translation cannot change which message shows.
    val redoNothingMessage = stringResource(R.string.draw_redo_nothing_to_redo)
    val redoChangedMessage = stringResource(R.string.draw_redo_drawing_changed)
    LaunchedEffect(Unit) {
        viewModel.redoNothingToDo.collect { reason ->
            snackbarHostState.showSnackbar(
                when (reason) {
                    com.fenceestimator.app.geometry.RedoNoneReason.DRAWING_CHANGED -> redoChangedMessage
                    com.fenceestimator.app.geometry.RedoNoneReason.NOTHING_TO_REDO,
                    com.fenceestimator.app.geometry.RedoNoneReason.NO_RUN_SELECTED -> redoNothingMessage
                }
            )
        }
    }
    // A typed length that could not be applied says so, rather than the
    // dialog closing as though the side had been set.
    val lengthRefusedMessage = stringResource(R.string.seg_len_refused)
    LaunchedEffect(Unit) {
        viewModel.lengthRefused.collect { snackbarHostState.showSnackbar(lengthRefusedMessage) }
    }
    // A65: the calibration distance is the one number on this screen that can
    // price the WHOLE fence at zero on its own, because every side is measured
    // through it. SurveyViewModel.applyCalibration used to return silently on
    // a bad one (and let NaN past the guard entirely), so the dialog closed
    // and the scale looked set. Now it says which mistake it was.
    val calibrationRefusedTitle = stringResource(R.string.num_calibration_refused_title)
    // All four resolved up front, by hand. The snackbar is shown from a
    // suspend collect, which cannot call stringResource, so every message a
    // refusal could need has to already be a String by the time the flow
    // emits. Written out rather than built in a loop so the compiler fails
    // here if a NumberRefusal case is ever added without a sentence for it.
    val calibrationRefusedMessages: Map<SurveyViewModel.NumberRefusal, String> = mapOf(
        SurveyViewModel.NumberRefusal.BLANK to stringResource(R.string.num_blank),
        SurveyViewModel.NumberRefusal.NOT_A_NUMBER to stringResource(R.string.num_not_a_number),
        SurveyViewModel.NumberRefusal.NOT_FINITE to stringResource(R.string.num_not_finite),
        SurveyViewModel.NumberRefusal.NOT_POSITIVE to stringResource(R.string.num_not_positive)
    )
    LaunchedEffect(Unit) {
        viewModel.calibrationRefused.collect { reason ->
            val detail = calibrationRefusedMessages[reason] ?: return@collect
            snackbarHostState.showSnackbar("$calibrationRefusedTitle: $detail")
        }
    }
    // The survey photo's own refusals. Each says what happened and that nothing
    // changed, rather than a control that looks dead.
    val gridNeedsScaleMessage = fitText(
        "survey_grid_needs_scale",
        "Calibrate the photo first. What you drew on it has no scale yet, so the grid cannot measure it."
    )
    val fitRefusedMessage = fitText(
        "survey_fit_refused",
        "The fit could not be applied, so nothing was changed."
    )
    val importAlreadyMessage = fitText(
        "survey_import_already",
        "This job already has a survey photo. It stays saved with the job."
    )
    val importFailedMessage = fitText(
        "survey_import_failed",
        "That photo could not be read, so nothing was saved."
    )
    // The Layers dialog is closed first where the refusal came from it: a message
    // behind the dialog's scrim is a message nobody reads.
    LaunchedEffect(Unit) {
        viewModel.gridNeedsScale.collect {
            layersMenuOpen = false
            snackbarHostState.showSnackbar(gridNeedsScaleMessage)
        }
    }
    LaunchedEffect(Unit) {
        viewModel.fitRefused.collect { snackbarHostState.showSnackbar(fitRefusedMessage) }
    }
    LaunchedEffect(Unit) {
        viewModel.importRefused.collect { reason ->
            layersMenuOpen = false
            snackbarHostState.showSnackbar(
                when (reason) {
                    SurveyViewModel.ImportRefusal.ALREADY_HAS_SURVEY -> importAlreadyMessage
                    SurveyViewModel.ImportRefusal.COULD_NOT_READ -> importFailedMessage
                }
            )
        }
    }
    val canRedo by viewModel.canRedo.collectAsState()

    // ATTACHING ONE SIDE TO ANOTHER: the end a first tap lifted, and the
    // attach or detach waiting to be confirmed. Both live in the view model so
    // a half-made attachment survives a recomposition and dies with the
    // screen, never outliving the drawing it was aimed at.
    val joinPick by viewModel.joinPick.collectAsState()
    val joinOffer by viewModel.joinOffer.collectAsState()
    // Every refusal says which one it was, in his terms. Branches on the enum,
    // never on the words, the same rule Undo and Redo follow above, so a
    // translation cannot change which message appears.
    val joinRefusedSameRun = stringResource(R.string.attach_refused_same_run)
    val joinRefusedClosed = stringResource(R.string.attach_refused_closed_loop)
    val joinRefusedTyped = stringResource(R.string.attach_refused_typed_footage)
    val joinRefusedTeardown = stringResource(R.string.attach_refused_teardown)
    val joinRefusedAlready = stringResource(R.string.attach_refused_already)
    val joinRefusedElsewhere = stringResource(R.string.attach_refused_at_another_point)
    val joinRefusedGone = stringResource(R.string.attach_refused_not_found)
    val joinRefusedNoStorage = stringResource(R.string.attach_refused_no_storage)
    // The one refusal that carries a number: how far apart the two ends are.
    // Read from the view model inside the collector for that emit, which is
    // where it was written (SurveyViewModel.joinTooFarFeet) -- joinRefused is a
    // bare enum by design and seven of the eight messages need no payload.
    val joinTooFarTemplate = stringResource(R.string.attach_refused_too_far, "%1\$s")
    LaunchedEffect(Unit) {
        viewModel.joinRefused.collect { reason ->
            snackbarHostState.showSnackbar(
                when (reason) {
                    JoinRefusal.SAME_RUN -> joinRefusedSameRun
                    JoinRefusal.CLOSED_LOOP -> joinRefusedClosed
                    JoinRefusal.TYPED_FOOTAGE -> joinRefusedTyped
                    JoinRefusal.TEARDOWN_MISMATCH -> joinRefusedTeardown
                    JoinRefusal.ALREADY_ATTACHED -> joinRefusedAlready
                    JoinRefusal.AT_ANOTHER_POINT -> joinRefusedElsewhere
                    JoinRefusal.NOT_FOUND -> joinRefusedGone
                    JoinRefusal.NO_STORAGE -> joinRefusedNoStorage
                    JoinRefusal.TOO_FAR_APART -> joinTooFarTemplate.format(
                        FeetInches.formatCompact(viewModel.joinTooFarFeet.value)
                    )
                },
                duration = SnackbarDuration.Long
            )
        }
    }

    // "THESE TWO SIDES MEET HERE. MAKE IT ONE POST?"
    //
    // A standing offer beside the drawing, never a dialog in front of the next
    // tap. He is in a yard, one-handed, and the next thing he does is almost
    // always another tap -- a question there costs a dismissal every time he
    // traces beside a neighbour's fence, and a question dismissed by reflex is
    // one that eventually gets answered by reflex.
    //
    // ONLY THE ACTION IS A YES. A snackbar that times out, is swiped away, or is
    // pushed off by the next one attaches nothing: SnackbarResult.Dismissed
    // falls through to dismissSnapJoinOffer. And the yes itself is re-derived
    // from the database before it writes (SurveyViewModel.acceptSnapJoinOffer),
    // so a tap that arrives late lands on today's drawing or on nothing.
    val snapJoinOffer by viewModel.snapJoinOffer.collectAsState()
    val snapJoinLine = stringResource(R.string.snap_join_offer_line)
    val snapJoinAction = stringResource(R.string.snap_join_offer_action)
    LaunchedEffect(snapJoinOffer) {
        if (snapJoinOffer == null) return@LaunchedEffect
        val result = snackbarHostState.showSnackbar(
            message = snapJoinLine,
            actionLabel = snapJoinAction,
            withDismissAction = true,
            duration = SnackbarDuration.Long
        )
        if (result == SnackbarResult.ActionPerformed) viewModel.acceptSnapJoinOffer()
        else viewModel.dismissSnapJoinOffer()
    }
    // A standing offer belongs to Draw and Adjust. Anywhere else it would be a
    // question about a gesture he has stopped making.
    LaunchedEffect(mode) {
        if (mode != SurveyMode.DRAW && mode != SurveyMode.ADJUST) viewModel.dismissSnapJoinOffer()
    }
    // Leaving the tool puts down anything half-attached: a lifted end that
    // survived a trip through Draw would attach itself to whatever was tapped
    // next, which is the thing he must never have happen.
    LaunchedEffect(mode) {
        if (mode != SurveyMode.JOIN) viewModel.clearJoinPick()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.draw_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back)) }
                }
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) }
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            // Persistent, not a snackbar that scrolls away: the drawing itself
            // looks perfectly fine while this is true, so the only way anyone
            // finds out materials and price stopped following it is if the
            // warning stays on screen until the estimate is reopened.
            if (repriceFailed) {
                RepriceFailedBanner()
            }
            // Nothing drawn yet, and a way out of it.
            //
            // Erasing a run can empty a drawing that had one, and this branch
            // used to be a cul-de-sac: it said to go and add a run on the job
            // screen, a screen away, because the Add control sits below this
            // early return and so was not on offer at the one moment somebody
            // needed it most. Taking the last run off and being unable to
            // start another without leaving is worse than not being able to
            // take it off at all.
            //
            // The old fence is offered here by name for the same reason it is
            // offered on the Add control: the run is the only thing that can
            // be charged for pulling a fence out, and this is the first screen
            // anybody looking to draw one arrives at.
            //
            // No new permission. Starting a run is an edit, not a delete, and
            // this screen already offers it to everyone who can open it -- so
            // a crew phone sees these two buttons exactly as it sees the Add
            // control, and neither of them is the erase gated above.
            if (runs.isEmpty()) {
                Column(
                    modifier = Modifier.fillMaxSize().padding(Space.xl),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center
                ) {
                    EmptyState(stringResource(R.string.draw_no_runs_yet))
                    // This is the one guest path that actually writes today:
                    // the sample jobs the guest demo seeds carry no fence runs
                    // at all (GuestSeeder never creates one), so every guest
                    // opening this screen lands right here, and these two
                    // buttons were the only thing on the whole screen with no
                    // gate of any kind, neither a hidden control nor a refusal
                    // behind it -- addRun() wrote straight through. There is
                    // nothing to look at yet on a job with no drawing, so
                    // unlike the rest of this screen there is no read-only
                    // view to offer in its place; the buttons are simply not
                    // offered.
                    if (editable) {
                        Spacer(Modifier.height(Space.md))
                        Button(onClick = { viewModel.addRun(runDefaults, isTeardown = false) }) {
                            Text(stringResource(R.string.draw_add_run_new))
                        }
                        Spacer(Modifier.height(Space.sm))
                        OutlinedButton(onClick = { viewModel.addRun(runDefaults, isTeardown = true) }) {
                            Text(stringResource(R.string.draw_add_run_teardown))
                        }
                    }
                }
                return@Column
            }

            // Full screen hides the run picker above the drawing and the
            // button on to the estimate below it, and nothing else. The
            // tools, layers, zoom, the property panel and Undo/Redo all float
            // over the canvas rather than stacking beside it, so they cost no
            // height in either mode -- and Undo and Redo are what a thumb
            // reaches for most while drawing, which is exactly when full
            // screen is on. (They were hidden with the estimate button once,
            // so a slip in full screen could only be put right by leaving it.)
            if (!fullScreenDrawing) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    RunSelector(
                        runs = runs,
                        selectedRunId = selectedRunId,
                        onSelect = { viewModel.selectRun(it) },
                        modifier = Modifier.weight(1f)
                    )
                    // Two separate sides on one job, not connected -- the
                    // data model already has this (a job has many FenceRun
                    // rows and they are independent); what was missing was
                    // any way to start a second one from here. Reuses the
                    // same repository.createFenceRun path addGate already
                    // falls back to for a gate with no run yet, rather than
                    // a second way of making one.
                    //
                    // Two choices behind one button, not two buttons, because
                    // a teardown run is rare next to an ordinary one and a
                    // second always-visible icon would outweigh how often
                    // anyone taps it. The icon and content description on the
                    // trigger itself do not change, so the existing
                    // draw_add_run string (and anyone who has learned this
                    // button) still applies.
                    //
                    // Hidden for a guest the same way the empty-state buttons
                    // above are: addRun() refuses the write regardless, but a
                    // "+" that opens a menu whose choices do nothing is the
                    // fake control this wave exists to close.
                    if (editable) Box {
                        var addRunMenuExpanded by remember { mutableStateOf(false) }
                        ToolIconButton(
                            icon = Icons.Filled.Add,
                            contentDescription = stringResource(R.string.draw_add_run),
                            onClick = { addRunMenuExpanded = true }
                        )
                        DropdownMenu(
                            expanded = addRunMenuExpanded,
                            onDismissRequest = { addRunMenuExpanded = false }
                        ) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.draw_add_run_new)) },
                                onClick = {
                                    addRunMenuExpanded = false
                                    viewModel.addRun(runDefaults, isTeardown = false)
                                }
                            )
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.draw_add_run_teardown)) },
                                onClick = {
                                    addRunMenuExpanded = false
                                    viewModel.addRun(runDefaults, isTeardown = true)
                                }
                            )
                        }
                    }
                    // Taking a run off the drawing, where the run is chosen.
                    //
                    // The picker beside this is select-only, so a second run
                    // started on one drawing could be selected and drawn on but
                    // never taken off again from here. The only way to remove
                    // one was the run editor reached through the job screen,
                    // which is two navigations away from the drawing it
                    // belongs to.
                    //
                    // Offered only to someone who may delete records -- the
                    // same permission the job screen's deletes and the run
                    // editor's Delete ask, read rather than invented. Hidden
                    // rather than greyed out, the way those are: a disabled
                    // delete invites a crew member to ask the office to switch
                    // on something they should not be doing. This screen is
                    // deliberately open to crew, which is precisely why the
                    // control needs its own gate instead of relying on who can
                    // reach the screen.
                    if (session.canDelete) {
                        ToolIconButton(
                            icon = Icons.Filled.Delete,
                            contentDescription = stringResource(R.string.draw_erase_run),
                            onClick = { pendingEraseRunId = selectedRunId }
                        )
                    }
                }

                // WHAT KIND OF FENCE EACH SIDE IS, on the drawing screen.
                //
                // This card has existed, finished, since the fence-type wave:
                // it drives the same picker RunEditScreen uses, and every row
                // goes through SideTypesViewModel.setType so the spacing
                // follow, the height carry and the RE-PRICE all happen. It was
                // simply never mounted anywhere. The only way to change a
                // side's type was to leave the drawing, open the job screen's
                // run list and pick the side there -- which is why he asked
                // three separate times for it on the grid.
                //
                // Here rather than as a tap on the line itself: a run is drawn
                // faded and is not hit-testable, and making every line tappable
                // fights the Draw and Adjust tools for the same gesture. A list
                // beside the picker names every side and its type at once,
                // which is also the view that answers "which one is the 4 ft
                // again" without tapping anything.
                //
                // Collapsed unless the job is already mixed, and inside the
                // non-full-screen block, so it costs no height while drawing.
                SideTypesCard(jobId = jobId, editable = editable)

                // The teardown CHARGE, beside where the old fence is drawn.
                //
                // Marking a run as the old fence coming out bills nothing by
                // itself: a separate job-level switch decides whether the
                // teardown is charged at all, and until now it existed only on
                // the job screen. So a carefully traced teardown quietly
                // charged zero until somebody scrolled far enough down a
                // different screen to find the switch. This writes that same
                // job field -- one switch shown in two places, never a second
                // switch that could disagree with the first.
                //
                // It never moves on its own. Adding a teardown run does not
                // turn it on, because a charge that appears because a line got
                // drawn is a bill nobody decided to send.
                //
                // Only where money is visible. The job screen keeps its whole
                // teardown section behind the same capability, and a crew phone
                // draws on this screen every day.
                //
                // Shown when an old fence is drawn, or whenever the charge is
                // already on. The second half is the one that matters: a switch
                // that vanished while the charge stayed on would hide live money
                // from the only person who can turn it off.
                val teardownJob = job
                if (session.canSeeMoney && teardownJob != null &&
                    (runs.any { it.isTeardown } || teardownJob.teardownEnabled)
                ) {
                    TeardownChargeRow(
                        chargeOn = teardownJob.teardownEnabled,
                        hasTeardownRun = runs.any { it.isTeardown },
                        enabled = editable,
                        onChargeChange = { viewModel.setTeardownCharge(it) }
                    )
                }
            }

            val visibleModes = remember(usingGrid, editable) {
                buildList {
                    // Every mode but Move View can write -- Draw and Calibrate
                    // place points, Gate and Marker place or remove gates and
                    // site markers, Adjust drags and nudges them. A guest gets
                    // only the one that cannot: panning and zooming to look,
                    // never a tool in hand whose taps go nowhere.
                    if (editable) {
                        add(SurveyMode.DRAW to R.string.mode_draw)
                        // No Calibrate on the grid. The grid already knows its own
                        // scale, so the step asked people to solve a problem they did
                        // not have -- it was the single most confusing thing here.
                        // On a survey photo it is unavoidable: nothing else can tell
                        // the app how big the picture is.
                        if (!usingGrid) add(SurveyMode.CALIBRATE to R.string.mode_calibrate)
                        add(SurveyMode.GATE to R.string.mode_gate)
                        add(SurveyMode.MARKER to R.string.mode_mark_site)
                        add(SurveyMode.ADJUST to R.string.mode_adjust)
                        // Attach, and ONLY while an attachment can be kept and
                        // can travel to the office -- see
                        // SurveyViewModel.JOIN_STORAGE_READY, which lists what
                        // has to land first. Absent, not present-and-refusing:
                        // he draws in yards with no signal, and a tool that
                        // loses what it was given the moment the app closes is
                        // worse than no tool at all.
                        if (SurveyViewModel.JOIN_STORAGE_READY) {
                            add(SurveyMode.JOIN to R.string.mode_attach)
                        }
                    }
                    add(SurveyMode.PAN to R.string.mode_move_view)
                }
            }
            // Leaving Calibrate selected while switching to the grid would strand
            // the canvas in a mode with no button to leave it by.
            LaunchedEffect(usingGrid) {
                if (usingGrid && mode == SurveyMode.CALIBRATE) viewModel.setMode(SurveyMode.DRAW)
            }
            // A guest whose session turns out this way after the screen was
            // already open (a demo that starts mid-visit) must not be left
            // sitting in a write-capable mode just because visibleModes above
            // no longer offers a button to leave it by.
            LaunchedEffect(editable) {
                if (!editable && mode != SurveyMode.PAN) viewModel.setMode(SurveyMode.PAN)
            }
            val activeRun = runs.firstOrNull { it.id == selectedRunId }
            val job2 = job
            if (activeRun != null && job2 != null) {
                val committedPoints = remember(activeRun.pointsEncoded) { FenceCodec.decodePoints(activeRun.pointsEncoded) }
                val gates = remember(activeRun.gatesEncoded) { FenceCodec.decodeGates(activeRun.gatesEncoded) }
                var draftPoints by remember(activeRun.id) { mutableStateOf<List<FencePoint>?>(null) }
                // Which vertex the arrow pad nudges. A finger covers the point
                // it is moving, so fine adjustment by dragging is guesswork --
                // the arrows move it a known distance you can see.
                var selectedPoint by remember(activeRun.id) { mutableStateOf<Int?>(null) }
                val points = draftPoints ?: committedPoints
                // Not the stored calibration read raw. A grid drawing that was
                // never given one -- ensureGridCalibration, up in the
                // LaunchedEffect(usingGrid), usually fires before the job has
                // loaded on a first open and so never seeds it -- had null
                // here, and null hides every gate and every length on the plan
                // while the estimate goes on charging for them. The grid
                // always knows its own scale; only an uncalibrated photo comes
                // back null, and that still gets the tap-to-calibrate prompt.
                // Same rule the view model measures edits by, so a typed
                // length matches the label it replaces.
                val pxPerFt = SurveyViewModel.drawingScale(job2)
                // The scale the no-photo grid's own background actually draws
                // at, for drawGrid/drawSurveyBackground below -- never the
                // flat PIXELS_PER_FOOT_GRID constant on its own, the same
                // fallback-only-when-null rule every other reader of pxPerFt
                // on this screen already follows (liveFeet, totalFeetAllRuns
                // above). See the comment on drawGrid for why this matters:
                // it used to be the flat constant unconditionally, which drew
                // the wrong-size squares on every grid but the 400ft default.
                val gridPxPerFt = pxPerFt ?: SurveyViewModel.PIXELS_PER_FOOT_GRID

                // What stands behind the scale -- measured against a known
                // length, carried or fitted by eye, or nothing yet. Display
                // only: pricing reads the calibration alone, exactly as before.
                // The line never lets a fit by eye read as a measurement.
                val scaleBasis = DrawingScale.basisOf(job2)
                val unmeasuredNote = fitText(
                    "survey_scale_unmeasured",
                    "Scale NOT measured on this photo -- lengths are only as good as the fit. Use Calibrate to measure it."
                )
                val measuredNote = fitText(
                    "survey_scale_measured",
                    "Scale measured against a %s ft reference",
                    "%.1f".format(job2.calibrationKnownFeet ?: 0f)
                )
                val scaleNote: String? = when {
                    usingGrid -> null
                    scaleBasis == ScaleBasis.UNMEASURED -> unmeasuredNote
                    scaleBasis == ScaleBasis.MEASURED -> measuredNote
                    else -> null
                }

                // The magnifier loupe (see MagnifierLoupe below): where to draw
                // it (screen space), what ground it should be centered on
                // (content space), and the length of whichever segment(s) touch
                // the point currently being dragged -- set from inside the
                // Adjust-mode drag gesture further down, read here so the
                // overlay outside the Canvas can render it. Precision over
                // imagery is the whole point of this: a finger covers the exact
                // pixel it is placing, and satellite ground is the one
                // background with nothing else (a doorway, a fence post
                // already in the photo) to judge the placement against.
                var loupeScreenPos by remember(activeRun.id) { mutableStateOf<Offset?>(null) }
                var loupeContentPos by remember(activeRun.id) { mutableStateOf<FencePoint?>(null) }
                var loupeSegmentFeet by remember(activeRun.id) { mutableStateOf<List<Float>>(emptyList()) }

                // Running total, read by the floating property panel that
                // sits over the canvas rather than a bar stacked above it --
                // see PropertyInfoPanel below.
                val liveFeet = if (points.size >= 2) {
                    FenceGeometryEngine.analyze(
                        points,
                        pxPerFt ?: SurveyViewModel.PIXELS_PER_FOOT_GRID,
                        activeRun.closedLoop
                    ).totalLinearFeet
                } else 0f
                // Full geometry (corners, gate count) for the property panel.
                // Same analyze() call the Canvas draws from below -- kept as
                // its own val here because DrawScope's copy isn't reachable
                // from composables floating outside the Canvas.
                val geometry = FenceGeometryEngine.analyze(points, pxPerFt ?: 1f, activeRun.closedLoop)
                // Same analyze() call, but over the COMMITTED points only (not
                // a mid-drag draft) -- what the segment-length chips and the
                // perimeter readout in the property panel are built from, so
                // dragging a vertex doesn't flicker a list it isn't part of.
                val committedGeometry = if (pxPerFt != null && pxPerFt > 0f && committedPoints.size >= 2) {
                    FenceGeometryEngine.analyze(committedPoints, pxPerFt, activeRun.closedLoop)
                } else null
                // Every run but the one being edited, decoded once per change
                // to the runs rather than on every frame the canvas draws --
                // the fence layer below draws their lines AND their gates now,
                // which is two decodes per run per frame otherwise.
                val otherRuns = remember(runs, activeRun.id) {
                    runs.filter { it.id != activeRun.id }.map { r ->
                        OtherRunDrawing(
                            run = r,
                            points = FenceCodec.decodePoints(r.pointsEncoded),
                            gates = FenceCodec.decodeGates(r.gatesEncoded)
                        )
                    }
                }
                // Job-wide total (every run, not just the one on screen) --
                // the active run's draft points stand in for its own saved
                // ones so the total updates live while drawing, same as
                // liveFeet above.
                val totalFeetAllRuns = remember(runs, activeRun.id, points, pxPerFt, usingGrid) {
                    val scale = pxPerFt ?: SurveyViewModel.PIXELS_PER_FOOT_GRID
                    val allRunPoints = runs.map { r ->
                        val pts = if (r.id == activeRun.id) points else FenceCodec.decodePoints(r.pointsEncoded)
                        pts to r.closedLoop
                    }
                    FenceGeometryEngine.totalLinearFeetAcrossRuns(allRunPoints, scale)
                }
                // ATTACHING ONE SIDE TO ANOTHER: the shared posts to draw on
                // the plan, the ends a tap can reach while the tool is in
                // hand, and the end a first tap lifted.
                //
                // Worked out from the runs here rather than inside the draw
                // block, which runs on every frame of every pan. The shared
                // posts come from the join arithmetic itself, so the plan can
                // never draw a post the estimate is not counting -- a joint
                // whose partner run was deleted, or whose run has since been
                // closed, typed or turned into a teardown, is ignored by the
                // price and is therefore not drawn as attached either.
                val jointMarkers = remember(runs, job2) { viewModel.jointMarkers() }
                val attachTargets = remember(runs, job2, mode) {
                    if (mode == SurveyMode.JOIN) viewModel.attachableEnds() else emptyList()
                }
                val joinPickPoint = remember(runs, joinPick) {
                    val end = joinPick
                    if (end == null) null else runs.firstOrNull { it.syncId == end.runId }?.let { picked ->
                        val pts = FenceCodec.decodePoints(picked.pointsEncoded)
                        if (pts.size < 2) null else if (end.atEnd) pts.last() else pts.first()
                    }
                }
                // Hoisted out of the draw block: the theme is only readable
                // from a composable, and DrawScope is not one.
                val warningColor = MaterialTheme.semantic.warning
                val canvasContentSize = bitmap?.let { it.width to it.height }
                    ?: (SurveyViewModel.GRID_CANVAS_SIZE to SurveyViewModel.GRID_CANVAS_SIZE)
                // Read by the pinch layer below, which is created once and would
                // otherwise keep the size the canvas had on its first frame (the
                // grid's, before the photo had loaded).
                val contentSizeNow by rememberUpdatedState(canvasContentSize)

                // Fixes the imagery to the app's own survey-pixel canvas: the
                // content-space center is the job's site_lat/site_lon, at a
                // zoom pinned to 20 (SATELLITE_TILE_Z), scaled by THIS job's
                // own current drawing scale (gridPxPerFt, the same value
                // drawSurveyBackground below already draws the grid at) --
                // not a flat assumed 20 px/ft any more. Recomputed whenever
                // the coordinates OR the scale change (gridExtentFt zoomed
                // via the chips or +/- buttons, satellite on or off), never
                // when the user merely pans or zooms the SCREEN view -- that
                // is viewZoom/viewPan/FitTransform's job, layered on top. See
                // the doc on SatelliteAnchor for why this must track the
                // job's real scale rather than a hardcoded one.
                val satelliteAnchor = remember(job2.siteLat, job2.siteLon, gridPxPerFt) {
                    val lat = job2.siteLat; val lon = job2.siteLon
                    if (lat != null && lon != null) SatelliteAnchor(lat, lon, gridPxPerFt) else null
                }

                // Which imagery tiles the current view needs, fetched (or
                // pulled from Satellite's own cache) whenever the view moves
                // far enough to matter. Bucketing viewZoom/viewPan into coarse
                // steps keeps this from re-running on every single frame of a
                // pinch or drag -- tile requests are already deduplicated
                // (Satellite.fetchTile single-flights by tile key), but there
                // is no reason to even recompute the visible range that often.
                LaunchedEffect(
                    satelliteOn, satelliteAnchor, canvasSize, online,
                    (viewZoom * 10).toInt(), (viewPan.x / 24f).toInt(), (viewPan.y / 24f).toInt()
                ) {
                    val anchor = satelliteAnchor
                    if (!satelliteOn || anchor == null || !online ||
                        canvasSize.width == 0 || canvasSize.height == 0
                    ) return@LaunchedEffect
                    val transform = viewTransform(
                        canvasContentSize.first, canvasContentSize.second, canvasSize, viewZoom, viewPan
                    )
                    visibleSatelliteTiles(anchor, transform, canvasSize).forEach { (tx, ty) ->
                        val key = satelliteTileKey(tx, ty)
                        if (satelliteTiles.containsKey(key)) return@forEach
                        val cached = Satellite.cachedTile(SATELLITE_TILE_Z, tx, ty)
                        if (cached != null) {
                            satelliteTiles[key] = cached
                        } else {
                            launch {
                                Satellite.fetchTile(SATELLITE_TILE_Z, tx, ty)?.let { satelliteTiles[key] = it }
                            }
                        }
                    }
                }

                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f)
                        .padding(Space.sm)
                ) {
                    val bmp = bitmap
                    Canvas(
                        modifier = Modifier
                            .fillMaxSize()
                            .onSizeChanged { canvasSize = it }
                            // gates and siteMarkers belong in this key list: the
                            // gesture detector captures whatever these were when
                            // it was created, so leaving them out meant a gate
                            // added or moved after the fact couldn't be grabbed.
                            // Pinch to zoom, on its own layer above the drawing
                            // gestures.
                            //
                            // Only acts once a second finger is down, so a
                            // single finger still draws, drags a point and moves
                            // a gate exactly as before -- the drawing gestures
                            // below never see a two-finger event, and this never
                            // sees a one-finger one.
                            //
                            // Zoom is anchored on the point between the fingers
                            // rather than the middle of the canvas, so the bit of
                            // fence being pinched stays under them. Anchoring at
                            // the centre makes the drawing slide away while you
                            // are trying to look at something.
                            .pointerInput(Unit) {
                                awaitEachGesture {
                                    awaitFirstDown(requireUnconsumed = false)
                                    do {
                                        val event = awaitPointerEvent()
                                        val fittingNow = fitDraft
                                        if (event.changes.size >= 2 && fittingNow != null) {
                                            // FITTING the survey photo: the same two
                                            // fingers move and zoom the PHOTO under
                                            // the drawing instead of the view, with
                                            // the spot between the fingers staying
                                            // put. The draft is in drawing units, so
                                            // screen movement is divided by the view
                                            // scale. Nothing is written until Apply.
                                            val zoomChange = event.calculateZoom()
                                            val panChange = event.calculatePan()
                                            val centroid = event.calculateCentroid(useCurrent = false)
                                            val content = contentSizeNow
                                            val t = viewTransform(content.first, content.second, canvasSize, viewZoom, viewPan)
                                            val about = t.toImage(centroid)
                                            fitDraft = DrawingFit.clamp(
                                                fittingNow
                                                    .zoomedAbout(if (zoomChange > 0f) zoomChange else 1f, about.x, about.y)
                                                    .movedBy(panChange.x / t.scale, panChange.y / t.scale)
                                            )
                                            event.changes.forEach { it.consume() }
                                        } else if (event.changes.size >= 2) {
                                            val zoomChange = event.calculateZoom()
                                            val panChange = event.calculatePan()
                                            val centroid = event.calculateCentroid(useCurrent = false)
                                            // Two fingers always pan; they zoom
                                            // only when the pinch actually
                                            // changed the distance between them.
                                            //
                                            // Pan used to live inside the zoom
                                            // branch, so sliding two fingers
                                            // without pinching moved nothing and
                                            // the only way to shift the view was
                                            // to leave the drawing tool and
                                            // switch to Move View -- three taps
                                            // to nudge a line you are mid-way
                                            // through drawing.
                                            val next = if (zoomChange > 0f) {
                                                (viewZoom * zoomChange).coerceIn(0.25f, 12f)
                                            } else viewZoom
                                            val applied = next / viewZoom
                                            // Keep the centroid fixed: shift
                                            // the pan by how much that point
                                            // would otherwise have moved.
                                            viewPan = Offset(
                                                centroid.x + (viewPan.x - centroid.x) * applied + panChange.x,
                                                centroid.y + (viewPan.y - centroid.y) * applied + panChange.y
                                            )
                                            viewZoom = next
                                            event.changes.forEach { it.consume() }
                                        }
                                    } while (event.changes.any { it.pressed })
                                }
                            }
                            // LONG-PRESS A SIDE TO ERASE IT.
                            //
                            // He asked for this in these words: "Need to be able to
                            // remove fences, maybe circle it in the grid or eraser or
                            // something, whatever would be easier" -- and then chose
                            // long-press-and-confirm over the alternatives.
                            //
                            // The erase itself ALREADY EXISTED: a bin in the top tool
                            // bar, acting on the selected run, behind session.canDelete.
                            // That bar overflows, so the control was off the end of it
                            // and effectively unreachable. Nothing here is a new delete
                            // path; this is a second way to reach the same dialog, and
                            // the same viewModel.eraseRun.
                            //
                            // ITS OWN LAYER, not onLongPress on the shared
                            // detectTapGestures below. Compose does not fire onTap after
                            // a long press, so adding it there would silently swallow a
                            // slow, careful tap that today places a corner -- and in
                            // GATE and MARKER a held finger IS a placement.
                            //
                            // On a MISS it does nothing at all and consumes nothing, so
                            // every existing tap and drag behaves exactly as before. On
                            // a HIT it consumes through to the finger lift, so the tap
                            // layer below does not also drop a corner under the dialog.
                            .pointerInput(mode, runs, session.canDelete) {
                                // Only where a held finger is not already doing
                                // something: placing a gate, a marker, or a calibration
                                // point. PAN is included because that is the mode he is
                                // in when looking at the whole yard deciding what to
                                // remove.
                                val eraseMode = mode == SurveyMode.DRAW ||
                                    mode == SurveyMode.ADJUST ||
                                    mode == SurveyMode.PAN
                                if (session.canDelete && eraseMode) {
                                    awaitEachGesture {
                                        val down = awaitFirstDown(requireUnconsumed = false)
                                        val held = awaitLongPressOrCancellation(down.id) ?: return@awaitEachGesture
                                        val transform = viewTransform(
                                            canvasContentSize.first, canvasContentSize.second,
                                            canvasSize, viewZoom, viewPan,
                                        )
                                        val at = transform.toImage(held.position)
                                        // A vertex under the finger belongs to Adjust, and
                                        // a gate to the gate tools. Reach is divided by the
                                        // view scale so it stays a constant distance ON THE
                                        // SCREEN: a fixed figure in drawing units makes every
                                        // side pressable at once when zoomed out, and none of
                                        // them reachable when zoomed in.
                                        val reach = VERTEX_HIT_RADIUS_PX / transform.scale
                                        val hit = viewModel.runNearest(at, reach)
                                        if (hit != null) {
                                            pendingEraseRunId = hit.id
                                            // Swallow the rest of the gesture, including the
                                            // lift, so the tap layer below treats it as
                                            // cancelled rather than as a tap.
                                            held.consume()
                                            do {
                                                val event = awaitPointerEvent()
                                                event.changes.forEach { it.consume() }
                                            } while (event.changes.any { it.pressed })
                                        }
                                    }
                                }
                            }
                            .pointerInput(mode, committedPoints, bmp, activeRun.id, usingGrid, gates, siteMarkers, fitActive) {
                                // FITTING the survey photo: one finger slides the photo
                                // under the drawing, and nothing else on this layer may
                                // act -- a tap must not drop a corner while somebody is
                                // lining a photo up. The photo is moved by the draft in
                                // drawing units; two fingers zoom it (the layer above).
                                if (fitActive) {
                                    detectDragGestures { _, dragAmount ->
                                        val draft = fitDraft
                                        if (draft != null) {
                                            val scale = viewTransform(
                                                canvasContentSize.first, canvasContentSize.second,
                                                canvasSize, viewZoom, viewPan
                                            ).scale
                                            fitDraft = DrawingFit.clamp(
                                                draft.movedBy(dragAmount.x / scale, dragAmount.y / scale)
                                            )
                                        }
                                    }
                                    return@pointerInput
                                }
                                // Only one gesture detector is ever active at a time -- mixing a tap
                                // detector and a drag detector on the same pointer stream is a real
                                // source of flaky gesture recognition, so each mode that needs drag
                                // (Move View, Adjust) gets the canvas to itself.
                                when (mode) {
                                    SurveyMode.PAN -> detectDragGestures { _, dragAmount -> viewPan += dragAmount }
                                    // Adjust needs BOTH: drag to move roughly, tap
                                    // to select a point for the arrow pad. One
                                    // pointer stream can't run two detectors, so
                                    // the drag detector reports a tap that never
                                    // moved as a selection.
                                    SurveyMode.ADJUST -> {
                                        // Three things can be dragged: a fence
                                        // vertex, a gate, or a site marker. Gates
                                        // and markers previously had to be deleted
                                        // and re-added to move a few feet, which
                                        // also threw away the gate's width.
                                        var draggingIndex: Int? = null
                                        var draggingGate: Int? = null
                                        var draggingMarker: SiteMarker? = null
                                        var lastImagePoint: FencePoint? = null
                                        // Where the finger went down. A tap that
                                        // grabs nothing is not nothing: near a
                                        // segment it means "let me type this
                                        // length".
                                        var tapStart: Offset? = null

                                        detectDragGestures(
                                            onDragStart = { startOffset ->
                                                tapStart = startOffset
                                                val transform = viewTransform(canvasContentSize.first, canvasContentSize.second, canvasSize, viewZoom, viewPan)
                                                fun distTo(x: Float, y: Float) =
                                                    (transform.toCanvas(FencePoint(x, y)) - startOffset).getDistance()

                                                // Gates and markers sit on top of
                                                // the line, so they win a tie --
                                                // otherwise a gate placed on a
                                                // vertex could never be grabbed.
                                                val gateHit = gates.withIndex()
                                                    .minByOrNull { (_, g) -> distTo(g.x, g.y) }
                                                    ?.takeIf { (_, g) -> distTo(g.x, g.y) <= VERTEX_HIT_RADIUS_PX }
                                                val markerHit = siteMarkers
                                                    .minByOrNull { m -> distTo(m.x, m.y) }
                                                    ?.takeIf { m -> distTo(m.x, m.y) <= VERTEX_HIT_RADIUS_PX }

                                                when {
                                                    gateHit != null -> draggingGate = gateHit.index
                                                    markerHit != null -> draggingMarker = markerHit
                                                    else -> {
                                                        val nearest = committedPoints.withIndex().minByOrNull { (_, p) -> (transform.toCanvas(p) - startOffset).getDistance() }
                                                        draggingIndex = nearest?.takeIf { (_, p) -> (transform.toCanvas(p) - startOffset).getDistance() <= VERTEX_HIT_RADIUS_PX }?.index
                                                    }
                                                }
                                            },
                                            onDragEnd = {
                                                val idx = draggingIndex
                                                val finalPoint = lastImagePoint
                                                // Grabbed a point but never moved
                                                // it: that's a tap, so select it
                                                // for the arrow pad.
                                                if (idx != null && finalPoint == null) selectedPoint = idx
                                                // Grabbed nothing and never
                                                // moved: if that tap was on a
                                                // segment's dimension, open it
                                                // for editing. Checked last, so
                                                // a vertex, gate or marker
                                                // always wins.
                                                if (idx == null && draggingGate == null && draggingMarker == null &&
                                                    finalPoint == null
                                                ) {
                                                    val at = tapStart
                                                    if (at != null && committedPoints.size >= 2) {
                                                        val transform = viewTransform(
                                                            canvasContentSize.first, canvasContentSize.second,
                                                            canvasSize, viewZoom, viewPan
                                                        )
                                                        val segs = if (activeRun.closedLoop)
                                                            committedPoints.size else committedPoints.size - 1
                                                        var best: Int? = null
                                                        var bestDist = SEGMENT_LABEL_HIT_RADIUS_PX
                                                        for (i in 0 until max(0, segs)) {
                                                            val a = transform.toCanvas(committedPoints[i])
                                                            val b = transform.toCanvas(committedPoints[(i + 1) % committedPoints.size])
                                                            val mid = Offset((a.x + b.x) / 2f, (a.y + b.y) / 2f)
                                                            val d = (mid - at).getDistance()
                                                            if (d < bestDist) { bestDist = d; best = i }
                                                        }
                                                        if (best != null) editingSegment = best
                                                    }
                                                }
                                                if (finalPoint != null) {
                                                    when {
                                                        idx != null -> {
                                                            val snap = viewModel.snapForMove(
                                                        idx,
                                                        finalPoint,
                                                        snapOn,
                                                        vertexReach = screenVertexReach(
                                                            viewTransform(
                                                                canvasContentSize.first,
                                                                canvasContentSize.second,
                                                                canvasSize,
                                                                viewZoom,
                                                                viewPan
                                                            ).scale
                                                        ),
                                                    )
                                                            lastSnap = snap.takeIf { it.snapped }
                                                            viewModel.movePoint(idx, snap.point)
                                                            // Dragging an end onto another side's
                                                            // corner is the same event as drawing
                                                            // onto it, and it is how he closes a
                                                            // gap on purpose after a join was
                                                            // refused for being too far apart.
                                                            viewModel.offerJoinFromSnap(idx, snap.kind)
                                                        }
                                                        draggingGate != null ->
                                                            viewModel.moveGate(draggingGate!!, finalPoint.x, finalPoint.y)
                                                        draggingMarker != null ->
                                                            viewModel.moveSiteMarker(draggingMarker!!, finalPoint.x, finalPoint.y)
                                                    }
                                                }
                                                draggingIndex = null
                                                draggingGate = null
                                                draggingMarker = null
                                                lastImagePoint = null
                                                draftPoints = null
                                                loupeScreenPos = null
                                                loupeContentPos = null
                                                loupeSegmentFeet = emptyList()
                                            },
                                            onDragCancel = {
                                                draggingIndex = null
                                                draggingGate = null
                                                draggingMarker = null
                                                lastImagePoint = null
                                                draftPoints = null
                                                loupeScreenPos = null
                                                loupeContentPos = null
                                                loupeSegmentFeet = emptyList()
                                            }
                                        ) { change, _ ->
                                            if (draggingIndex == null && draggingGate == null && draggingMarker == null) {
                                                return@detectDragGestures
                                            }
                                            val transform = viewTransform(canvasContentSize.first, canvasContentSize.second, canvasSize, viewZoom, viewPan)
                                            val imgPoint = transform.toImage(change.position)
                                            lastImagePoint = imgPoint
                                            // Precision aid: a magnified, crosshair-marked
                                            // preview above the finger (MagnifierLoupe,
                                            // rendered outside this Canvas) plus the length
                                            // of whichever segment(s) touch the point being
                                            // moved, live, in feet -- so a corner can be
                                            // placed exactly rather than guessed at, which
                                            // matters most on ground with nothing else in
                                            // the picture to judge it against.
                                            loupeScreenPos = change.position
                                            loupeContentPos = imgPoint
                                            draggingIndex?.let { idx ->
                                                draftPoints = committedPoints.toMutableList().also { it[idx] = imgPoint }
                                                val feetPerPx = pxPerFt ?: SurveyViewModel.PIXELS_PER_FOOT_GRID
                                                val neighbors = mutableListOf<FencePoint>()
                                                if (idx > 0) neighbors += committedPoints[idx - 1]
                                                if (idx < committedPoints.size - 1) neighbors += committedPoints[idx + 1]
                                                if (activeRun.closedLoop && committedPoints.size > 2) {
                                                    if (idx == 0) neighbors += committedPoints.last()
                                                    if (idx == committedPoints.lastIndex) neighbors += committedPoints.first()
                                                }
                                                loupeSegmentFeet = neighbors.map { n ->
                                                    kotlin.math.hypot(
                                                        (imgPoint.x - n.x).toDouble(), (imgPoint.y - n.y).toDouble()
                                                    ).toFloat() / feetPerPx
                                                }
                                            } ?: run { loupeSegmentFeet = emptyList() }
                                        }
                                    }
                                    else -> detectTapGestures { tapOffset ->
                                        val transform = viewTransform(canvasContentSize.first, canvasContentSize.second, canvasSize, viewZoom, viewPan)
                                        val imgPoint = transform.toImage(tapOffset)
                                        when (mode) {
                                            SurveyMode.DRAW -> {
                                                // A SECOND TAP IN THE SAME SPOT ENDS THE SIDE.
                                                // Detected here rather than through
                                                // detectTapGestures' onDoubleTap, because
                                                // registering that makes EVERY single tap wait out
                                                // the double-tap timeout before the point appears,
                                                // and a drawing tool that lags on every point is
                                                // worse than no double tap at all. So the point is
                                                // placed immediately and the second tap takes it
                                                // back off (see finishSideByDoubleTap).
                                                val now = System.currentTimeMillis()
                                                val nearLast = lastTapOffset?.let {
                                                    (tapOffset - it).getDistance() <= DOUBLE_TAP_SLOP_PX
                                                } ?: false
                                                val quick = now - lastTapAtMs <= DOUBLE_TAP_WINDOW_MS
                                                if (quick && nearLast) {
                                                    lastTapAtMs = 0L
                                                    lastTapOffset = null
                                                    val added = lastAddedPoint
                                                    lastAddedPoint = null
                                                    viewModel.finishSideByDoubleTap(added)
                                                    return@detectTapGestures
                                                }
                                                lastTapAtMs = now
                                                lastTapOffset = tapOffset
                                                val snap = viewModel.snapForDraw(
                                                    imgPoint,
                                                    snapOn,
                                                    vertexReach = screenVertexReach(transform.scale),
                                                )
                                                lastSnap = snap.takeIf { it.snapped }
                                                viewModel.addDrawPoint(snap.point)
                                                // Remember what went in, AFTER the snap has had
                                                // its say -- the snap is what moves a point away
                                                // from where the finger landed, and that gap is
                                                // what the old equality check fell into.
                                                lastAddedPoint = snap.point
                                                // The snap has already put this point exactly on
                                                // another side's corner if it was aiming at one.
                                                // Ask whether the two sides MEET -- the half
                                                // nothing used to ask, so two ends sat on one
                                                // another and the takeoff still bought two end
                                                // posts. It is a question and nothing else:
                                                // carrying on tapping is not a yes.
                                                viewModel.offerJoinAfterDraw(snap.kind)
                                            }
                                            SurveyMode.CALIBRATE -> viewModel.tapCalibrationPoint(imgPoint) { p1, p2 ->
                                                calibrationDialogPoints = p1 to p2
                                            }
                                            SurveyMode.GATE -> {
                                                // Tap a gate that is already
                                                // there to take it off; tap
                                                // open ground to add one.
                                                val hit = gates.minByOrNull { g ->
                                                    val c = transform.toCanvas(FencePoint(g.x, g.y))
                                                    (c - tapOffset).getDistance()
                                                }?.takeIf { g ->
                                                    val c = transform.toCanvas(FencePoint(g.x, g.y))
                                                    (c - tapOffset).getDistance() <= GATE_TAP_SLOP
                                                }
                                                if (hit != null) pendingGateRemoval = hit
                                                else gateDialogPoint = imgPoint
                                            }
                                            SurveyMode.MARKER -> markerDialogPoint = imgPoint
                                            // ATTACH: tap the end of one side,
                                            // then the end of the other. The
                                            // tolerance is converted out of
                                            // screen pixels by the view's own
                                            // scale, so the target under the
                                            // finger is the same size zoomed
                                            // in and zoomed out -- in drawing
                                            // units it is 40 px of screen,
                                            // which on a 400 ft grid is about
                                            // 16 ft and on a tight one a few
                                            // inches. Tapping nothing puts
                                            // down whatever was lifted.
                                            SurveyMode.JOIN -> {
                                                val reach = if (transform.scale > 0f) {
                                                    VERTEX_HIT_RADIUS_PX / transform.scale
                                                } else VERTEX_HIT_RADIUS_PX
                                                viewModel.tapJoinEnd(imgPoint, reach)
                                            }
                                            else -> {}
                                        }
                                    }
                                }
                            }
                    ) {
                        val transform = viewTransform(canvasContentSize.first, canvasContentSize.second, IntSize(size.width.toInt(), size.height.toInt()), viewZoom, viewPan)

                        // While FITTING, the photo alone is drawn moved and zoomed by
                        // the draft; the drawing, the grid and everything on top of it
                        // keep the ordinary transform, so what is being lined up
                        // against the photo does not move.
                        val fitting = fitDraft
                        val photoTransform = if (fitting != null) {
                            FitTransform(
                                transform.scale * fitting.scale,
                                transform.offsetX + transform.scale * fitting.dx,
                                transform.offsetY + transform.scale * fitting.dy
                            )
                        } else transform
                        drawSurveyBackground(
                            bmp, photoTransform, canvasContentSize.first, canvasContentSize.second,
                            job2.gridFeetPerSquare, gridPxPerFt, satelliteOn, satelliteAnchor, satelliteTiles
                        )
                        // The visible reference for a fit: a scale grid, in real feet,
                        // over the photo. Squares of a known size are how the eye tells
                        // a photo that is the right size from one that only looks it --
                        // a house, a fence post spacing or a car in the picture can be
                        // held against them. Drawn from the job's own scale, in round
                        // numbers of feet that stay readable at the current zoom.
                        if (fitting != null && pxPerFt != null && pxPerFt > 0f) {
                            drawGrid(
                                transform, canvasContentSize.first, canvasContentSize.second,
                                DrawingFit.niceGridStepFt(FIT_GRID_MIN_SQUARE_PX / (pxPerFt * transform.scale)),
                                pxPerFt, showLabels = true, fill = false
                            )
                        }

                        // A gate at its real width, hung on real posts, drawn
                        // the same way whichever run it belongs to -- see the
                        // active run's gates further down for why it looks the
                        // way it does. [fade] is 1 for the run being edited and
                        // OTHER_RUN_ALPHA for the rest, multiplied into every
                        // colour so a faded gate keeps the same proportions
                        // (posts solid against the arc, say) as a full one.
                        fun drawGate(gate: GateMarker, span: GateSpan, fade: Float) {
                            val gateColor = PlanColors.gate.copy(alpha = PlanColors.gate.alpha * fade)
                            val a = transform.toCanvas(span.start)
                            val b = transform.toCanvas(span.end)

                            // The two posts the gate hangs between. These are
                            // the things that get set in concrete, so they are
                            // what the crew is really looking for.
                            listOf(a, b).forEach { post ->
                                drawCircle(gateColor, radius = 7f, center = post)
                                drawCircle(
                                    Color.White.copy(alpha = fade), radius = 7f, center = post,
                                    style = androidx.compose.ui.graphics.drawscope.Stroke(width = 2f)
                                )
                            }

                            // The leaf, swung open at 45 degrees, and the arc it
                            // sweeps -- the way a gate is drawn on any site plan,
                            // and the thing that shows which way it opens and
                            // what has to be kept clear for it.
                            val dx = b.x - a.x
                            val dy = b.y - a.y
                            val leafLength = kotlin.math.hypot(dx.toDouble(), dy.toDouble()).toFloat()
                            if (leafLength > 1f) {
                                val ux = dx / leafLength
                                val uy = dy / leafLength
                                val alongDegrees =
                                    Math.toDegrees(kotlin.math.atan2(uy.toDouble(), ux.toDouble())).toFloat()

                                // Which side of the fence the gate opens to.
                                //
                                // A gate swinging the wrong way into a slope, a
                                // step or a parked car is a return visit, and it
                                // is the first thing forgotten between quoting
                                // and installing. Drawn the way a site plan draws
                                // it: the leaf where it ends up, and the arc it
                                // sweeps through to get there.
                                val directions = when (gate.swing) {
                                    com.fenceestimator.app.geometry.GateSwing.IN -> listOf(1f)
                                    com.fenceestimator.app.geometry.GateSwing.OUT -> listOf(-1f)
                                    // Both ways, so both arcs are drawn.
                                    com.fenceestimator.app.geometry.GateSwing.BOTH -> listOf(1f, -1f)
                                }

                                directions.forEach { side ->
                                    val angle = Math.toRadians((alongDegrees + 45f * side).toDouble())
                                    val tip = Offset(
                                        a.x + kotlin.math.cos(angle).toFloat() * leafLength,
                                        a.y + kotlin.math.sin(angle).toFloat() * leafLength
                                    )
                                    drawLine(gateColor, a, tip, strokeWidth = 3f)
                                    drawArc(
                                        color = PlanColors.gate.copy(alpha = 0.35f * fade),
                                        startAngle = if (side > 0f) alongDegrees else alongDegrees - 45f,
                                        sweepAngle = 45f,
                                        useCenter = false,
                                        topLeft = Offset(a.x - leafLength, a.y - leafLength),
                                        size = androidx.compose.ui.geometry.Size(leafLength * 2f, leafLength * 2f),
                                        style = androidx.compose.ui.graphics.drawscope.Stroke(width = 2f)
                                    )
                                }
                            }

                            // Its width, so the plan states it rather than
                            // leaving it to be measured off the drawing.
                            val mid = Offset((a.x + b.x) / 2f, (a.y + b.y) / 2f)
                            val swingLabel = context.getString(
                                when (gate.swing) {
                                    com.fenceestimator.app.geometry.GateSwing.IN -> R.string.misc_survey_swing_in
                                    com.fenceestimator.app.geometry.GateSwing.OUT -> R.string.misc_survey_swing_out
                                    com.fenceestimator.app.geometry.GateSwing.BOTH -> R.string.misc_survey_swing_both
                                }
                            )
                            val widthText = if (gate.widthFt % 1f == 0f) gate.widthFt.toInt().toString() else gate.widthFt.toString()
                            drawContext.canvas.nativeCanvas.drawText(
                                context.getString(R.string.misc_survey_gate_width_swing, widthText, swingLabel),
                                mid.x, mid.y - 10f,
                                android.graphics.Paint().apply {
                                    color = gateColor.toArgb()
                                    textSize = 26f
                                    textAlign = android.graphics.Paint.Align.CENTER
                                    isFakeBoldText = true
                                }
                            )
                        }

                        // Fence layer: every other run's faded line and gates,
                        // the active run's own line and dimensions, its
                        // vertices, and its gates -- everything that is the
                        // fence rather than the ground it sits on. Gated by the
                        // Layers toggle so hiding it is a real hide, not a
                        // decoration; the background and the in-progress
                        // calibration dots below are unaffected because they
                        // aren't the fence.
                        if (showFenceLayer) {

                        // Every other run, gates included.
                        //
                        // These used to be drawn as a bare faded line and
                        // nothing else, and a run with no line -- a standalone
                        // gate on a run of its own -- was skipped outright. Only
                        // the selected run's gates were ever on the plan, so on
                        // a job with a back fence and a side fence, or a gate
                        // run beside a fence run, most of the gates being
                        // charged for could not be seen ("I'm not able to see
                        // the gates in the drawing"). Now each run's gates are
                        // placed by the same rule as the selected run's, and
                        // cut the same openings in its line.
                        //
                        // Faded, not selectable: tapping and dragging still act
                        // on the selected run only, and the run picker is how
                        // another run's gates are edited.
                        val otherSpans = otherRuns.map { other ->
                            GateGeometry.spansFor(other.gates, other.points, other.run.closedLoop, pxPerFt)
                        }
                        otherRuns.forEachIndexed { i, other ->
                            // Faded because it isn't the run being worked on
                            // right now, not because it means anything
                            // different -- teardown vs. build still has to
                            // read correctly at a glance even dimmed.
                            val otherColor = (if (other.run.isTeardown) PlanColors.teardownLine else PlanColors.fenceLine)
                                .copy(alpha = otherRunAlpha(viewZoom))
                            GateGeometry.fencePieces(other.points, other.run.closedLoop, otherSpans[i].map { it.second })
                                .forEach { (from, to) ->
                                    drawLine(otherColor, transform.toCanvas(from), transform.toCanvas(to), strokeWidth = 4f)
                                }
                        }
                        // Gates after every line, so one run's line can never be
                        // drawn across another run's gate. Gate colour on every
                        // run, teardown or not, the same as the selected run's
                        // gates.
                        if (showGatesLayer) otherSpans.forEach { spans ->
                            spans.forEach { (gate, span) -> drawGate(gate, span, otherRunAlpha(viewZoom)) }
                        }

                        val geometry = FenceGeometryEngine.analyze(points, pxPerFt ?: 1f, activeRun.closedLoop)
                        val canvasPoints = points.map { transform.toCanvas(it) }

                        // Where each gate actually sits, and how much fence it
                        // takes up. Worked out once and used for both the gaps
                        // in the fence and the gates drawn into them.
                        //
                        // A gate with no line to sit on -- a standalone gate
                        // sale, whose run has no corners, or a run whose
                        // corners sit on top of each other -- is drawn level
                        // at the point it was placed instead. spanFor returns
                        // null there, and that null used to be the end of it:
                        // the gate was priced and charged for and never drawn.
                        // Its span has no segment (NO_SEGMENT), so the gap
                        // cutting below never matches it. Nothing here hides a
                        // gate for being far from its line, either: one that
                        // sits well off the fence still snaps onto it. Every
                        // other run above goes through this same spansFor.
                        val gateSpans = GateGeometry.spansFor(gates, points, activeRun.closedLoop, pxPerFt)

                        // A run marked as the old fence coming out is drawn in
                        // teardown's colour instead of the build colour -- same
                        // geometry, so a crew can tell "pull this out" from
                        // "build this" without a legend, on this screen or the
                        // crew's copy of it.
                        val activeLineColor = if (activeRun.isTeardown) PlanColors.teardownLine else PlanColors.fenceLine
                        val segCount = if (activeRun.closedLoop) points.size else points.size - 1
                        // The fence is drawn as the pieces either side of each
                        // opening rather than one line with a symbol on top, so
                        // a gate reads as a way through. It also makes an
                        // opening too wide for its run obvious: the fence
                        // either side simply is not there. fencePieces is the
                        // same cut every other run's line gets above.
                        GateGeometry.fencePieces(points, activeRun.closedLoop, gateSpans.map { it.second })
                            .forEach { (from, to) ->
                                drawLine(
                                    activeLineColor,
                                    transform.toCanvas(from),
                                    transform.toCanvas(to),
                                    strokeWidth = 4f
                                )
                            }

                        // Every segment says how long it is.
                        //
                        // A fence plan without dimensions on it is a picture;
                        // with them it is a drawing somebody can build from,
                        // and it is the only way a person can see that the
                        // traced run reads 46' when the tape said 47' 6".
                        // Skipped where the segment is too short on screen to
                        // hold the text, which declutters a zoomed-out loop
                        // without needing a rule about how many to show.
                        if (showDimensionsLayer && pxPerFt != null && pxPerFt > 0f) {
                            for (i in 0 until max(0, segCount)) {
                                val a = transform.toCanvas(points[i])
                                val b = transform.toCanvas(points[(i + 1) % points.size])
                                val onScreenLen = kotlin.math.hypot((b.x - a.x).toDouble(), (b.y - a.y).toDouble()).toFloat()
                                if (onScreenLen < 56f) continue
                                // Read off the same analyze() the takeoff
                                // prices from, so the label is the takeoff's
                                // number -- and a closed loop's closing side
                                // gets its dimension too, which the old
                                // segmentLengthPx() call skipped.
                                val feet = geometry.segments.getOrNull(i)?.lengthFt ?: continue
                                val label = FeetInches.formatCompact(feet)
                                val mx = (a.x + b.x) / 2f
                                val my = (a.y + b.y) / 2f
                                // Offset off the line, on the side the line is
                                // not, so the text never sits on the fence it
                                // is measuring.
                                val nx = -(b.y - a.y) / onScreenLen
                                val ny = (b.x - a.x) / onScreenLen
                                val lx = mx + nx * 20f
                                val ly = my + ny * 20f
                                val paint = android.graphics.Paint().apply {
                                    textSize = 27f
                                    textAlign = android.graphics.Paint.Align.CENTER
                                    isAntiAlias = true
                                    isFakeBoldText = true
                                }
                                // A disc behind it, because this text lands on
                                // satellite imagery of grass, driveway and roof
                                // and has to stay readable on all three.
                                val halfWidth = paint.measureText(label) / 2f + 7f
                                drawContext.canvas.nativeCanvas.drawRoundRect(
                                    lx - halfWidth, ly - 20f, lx + halfWidth, ly + 9f, 7f, 7f,
                                    android.graphics.Paint().apply {
                                        color = android.graphics.Color.argb(214, 255, 255, 255)
                                        isAntiAlias = true
                                    }
                                )
                                drawContext.canvas.nativeCanvas.drawText(
                                    label, lx, ly,
                                    paint.apply { color = activeLineColor.toArgb() }
                                )
                            }
                        }

                        val vertexRadius = if (mode == SurveyMode.ADJUST) 14f else 11f
                        geometry.vertices.forEach { v ->
                            val c = transform.toCanvas(v.point)
                            val color = when (v.kind) {
                                VertexKind.CORNER -> SafetyOrange40
                                VertexKind.END -> Graphite40
                                VertexKind.LINE -> SteelTeal20
                            }
                            drawCircle(color, radius = vertexRadius, center = c)
                            drawCircle(Color.White, radius = vertexRadius, center = c, style = androidx.compose.ui.graphics.drawscope.Stroke(width = 2f))
                        }

                        // A gate at its real width, hung on real posts.
                        //
                        // It used to be a fixed 20-pixel square wherever it was
                        // dropped, so a 3ft walk gate and a 16ft double gate
                        // looked identical and neither took up any fence. On a
                        // plan somebody builds from, that is the difference
                        // between an opening that fits and one that does not.
                        if (showGatesLayer) gateSpans.forEach { (gate, span) -> drawGate(gate, span, 1f) }

                        // ATTACHED ENDS, and they must not look like two ends
                        // that merely touch.
                        //
                        // That is the confusion the whole feature exists to
                        // end: today two runs can already end on the identical
                        // pixel (a point placed near another run's corner is
                        // moved onto it exactly) and the estimate still counts
                        // two end posts there, with nothing on the drawing to
                        // say so either way. So an attached post is drawn as a
                        // DIFFERENT THING, not a tinted version of the same
                        // thing: nearly twice the radius of an ordinary
                        // vertex, filled in the corner-post orange, ringed in
                        // white, and carrying the number of sides that meet
                        // there. Read at arm's length in sunlight that is a
                        // badge, which is what it has to survive -- a subtle
                        // shade of a 11px dot is invisible on a phone held
                        // over a satellite photo of grass and driveway.
                        //
                        // Last in the fence layer, so neither a line nor a
                        // gate can be drawn over the one mark that says a post
                        // is shared.
                        jointMarkers.forEach { marker ->
                            val c = transform.toCanvas(marker.point)
                            drawCircle(SafetyOrange40, radius = 21f, center = c)
                            drawCircle(
                                Color.White, radius = 21f, center = c,
                                style = androidx.compose.ui.graphics.drawscope.Stroke(width = 4f)
                            )
                            // Open by more than half a foot at this drawing's
                            // own scale: the attachment stands (it is his
                            // decision, not the pixels'), and the amber ring
                            // is how he can see that the two ends have drifted
                            // apart without having to zoom in and guess.
                            if (marker.openByFeet > 0.5f) {
                                drawCircle(
                                    warningColor, radius = 27f, center = c,
                                    style = androidx.compose.ui.graphics.drawscope.Stroke(width = 3f)
                                )
                            }
                            drawContext.canvas.nativeCanvas.drawText(
                                marker.memberCount.toString(),
                                c.x, c.y + 9f,
                                android.graphics.Paint().apply {
                                    color = android.graphics.Color.WHITE
                                    textSize = 26f
                                    textAlign = android.graphics.Paint.Align.CENTER
                                    isAntiAlias = true
                                    isFakeBoldText = true
                                }
                            )
                        }

                        // While the Attach tool is in hand: a target on every
                        // free end a tap can reach, on EVERY run of the job
                        // and not only the one being edited -- the whole point
                        // is attaching one side to another, so the other
                        // side's ends have to be tappable without selecting it
                        // first. The end already lifted is bigger still and in
                        // the other colour, so it is obvious which of the two
                        // taps has happened.
                        if (mode == SurveyMode.JOIN) {
                            attachTargets.forEach { (_, point) ->
                                val c = transform.toCanvas(point)
                                drawCircle(Graphite40, radius = 15f, center = c)
                                drawCircle(
                                    Color.White, radius = 15f, center = c,
                                    style = androidx.compose.ui.graphics.drawscope.Stroke(width = 3f)
                                )
                            }
                            joinPickPoint?.let { picked ->
                                val c = transform.toCanvas(picked)
                                drawCircle(SteelTeal20, radius = 23f, center = c)
                                drawCircle(
                                    Color.White, radius = 23f, center = c,
                                    style = androidx.compose.ui.graphics.drawscope.Stroke(width = 4.5f)
                                )
                                drawCircle(Color.White, radius = 6f, center = c)
                            }
                        }

                        } // showFenceLayer

                        // Markers layer: what's already sitting on the site
                        // (the pool, the old fence, a tree) -- separate from
                        // the fence layer above because a crew reading the
                        // plan often wants one without the other, and hiding
                        // it here is a real hide of the same drawCircle/
                        // drawText calls, not a fake switch.
                        if (showMarkersLayer) {
                        siteMarkers.forEach { marker ->
                            val c = transform.toCanvas(FencePoint(marker.x, marker.y))
                            val color = PlanColors.marker(marker.kind)
                            // A SIZED MARKER IS A BOX. He asked three times for the
                            // house to be "a larger box, something that looks like a
                            // house", and it kept coming back a dot because a dot was
                            // all a SiteMarker could be -- x, y and a label, nowhere
                            // to put a size.
                            //
                            // Feet, converted here by the same scale the fence uses,
                            // so a recalibrated grid moves the house with the fence
                            // rather than leaving it the wrong size beside it.
                            val wFt = marker.widthFt
                            val hFt = marker.heightFt
                            if (wFt > 0f && hFt > 0f) {
                                val scale = gridPxPerFt
                                val halfW = (wFt * scale / 2f) * transform.scale
                                val halfH = (hFt * scale / 2f) * transform.scale
                                rotate(degrees = marker.rotationDeg, pivot = c) {
                                    drawRect(
                                        color = color.copy(alpha = 0.16f),
                                        topLeft = Offset(c.x - halfW, c.y - halfH),
                                        size = androidx.compose.ui.geometry.Size(halfW * 2, halfH * 2)
                                    )
                                    drawRect(
                                        color = color,
                                        topLeft = Offset(c.x - halfW, c.y - halfH),
                                        size = androidx.compose.ui.geometry.Size(halfW * 2, halfH * 2),
                                        style = androidx.compose.ui.graphics.drawscope.Stroke(width = 2.5f)
                                    )
                                }
                            }
                            // The dot stays, box or not: it is the thing a finger
                            // grabs to move the marker, and a box with no handle is
                            // a box he cannot pick up.
                            drawCircle(color, radius = 13f, center = c)
                            drawCircle(Color.White, radius = 13f, center = c, style = androidx.compose.ui.graphics.drawscope.Stroke(width = 2.5f))
                            drawContext.canvas.nativeCanvas.drawText(
                                marker.label.ifBlank { context.getString(markerShortLabelRes(marker.kind)) },
                                c.x + 18f,
                                c.y + 5f,
                                android.graphics.Paint().apply {
                                    this.color = color.toArgb()
                                    textSize = 26f
                                    isAntiAlias = true
                                    isFakeBoldText = true
                                }
                            )
                        }
                        } // showMarkersLayer

                        pendingCalibration.forEach { p ->
                            drawCircle(PlanColors.calibrationPoint, radius = 10f, center = transform.toCanvas(p))
                        }
                    }

                    // TOP-CENTER: the grouped mode tools -- Draw, Calibrate,
                    // Gate, Mark Site, Adjust, Move View -- floating above the
                    // canvas instead of pinned in a full-width row beneath the
                    // top bar. Same viewModel.setMode(m) call as before, just
                    // relocated so switching tools no longer costs the
                    // drawing a fixed strip of height. Stays visible in full
                    // screen too -- "the mode buttons stay" -- because
                    // floating over the canvas has always meant it costs
                    // nothing to keep on screen.
                    Column(
                        modifier = Modifier.align(Alignment.TopCenter).padding(top = Space.sm),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        ModeToolGroup(
                            visibleModes = visibleModes,
                            mode = mode,
                            onSelect = { viewModel.setMode(it) }
                        )
                        // Undo/Redo, under the mode switcher.
                        //
                        // This band is the only place on the canvas nothing
                        // else can reach: the bottom band belongs to
                        // PropertyInfoPanel, which is an opaque Surface up to
                        // 360dp wide and, expanded, tall -- that is what used
                        // to paint over these two at BOTTOM-START, reported as
                        // "the undo setting or forward one is hidden under the
                        // draw the fence line". The right edge is the view
                        // controls above and NudgePad below. So they sit here,
                        // costing this column one 48dp row and nothing else,
                        // and they cannot be covered in any orientation or at
                        // any panel state rather than merely usually not.
                        Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                            ToolIconButton(
                                icon = Icons.Filled.Undo,
                                contentDescription = stringResource(R.string.draw_undo),
                                // The snap cue describes the last point placed;
                                // once that point is gone it describes nothing.
                                // Undo takes back the last change of any kind
                                // (a history, see UndoHistory), so it no longer
                                // needs to know which tool is in hand.
                                onClick = { lastSnap = null; viewModel.undoLast() }
                            )
                            // Dimmed when there is nothing to redo but still
                            // pressable, so a press explains why (the same as
                            // Undo) instead of doing nothing.
                            ToolIconButton(
                                icon = Icons.Filled.Redo,
                                contentDescription = stringResource(R.string.draw_redo),
                                dimmed = !canRedo,
                                dimmedStateDescription = stringResource(R.string.draw_redo_nothing_to_redo),
                                onClick = { lastSnap = null; viewModel.redo() }
                            )
                        }
                        // Angle lock, where it is used: a one-tap switch to
                        // draw freely, and what the last point was locked
                        // to. Both used to live only inside the property
                        // panel, which is collapsed by default -- so a point
                        // that jumped to square said nothing unless the panel
                        // happened to be open.
                        if (mode == SurveyMode.DRAW || mode == SurveyMode.ADJUST) {
                            SnapStrip(
                                snapOn = snapOn,
                                onSnapChange = { snapOn = it; lastSnap = null },
                                lastSnap = lastSnap,
                                showIntro = !snapIntroSeen
                            )
                        }
                        // Plain Box, not Surface, inside CanvasHint below --
                        // Material3's Surface swallows pointer events so
                        // clicks can't fall through to whatever is behind it,
                        // which used to eat every tap along the strip these
                        // hints sat on.
                        if (mode == SurveyMode.PAN) {
                            CanvasHint(text = stringResource(R.string.survey_drag_to_move))
                        }
                        if (mode == SurveyMode.ADJUST && selectedPoint == null) {
                            CanvasHint(text = stringResource(R.string.misc_survey_adjust_canvas_hint))
                        }
                        // Attach says which of the two taps it is waiting for,
                        // because a tool whose first tap looks like nothing
                        // happened is a tool people tap twice on the same end.
                        if (mode == SurveyMode.JOIN) {
                            CanvasHint(
                                modifier = Modifier.widthIn(max = 320.dp),
                                text = if (joinPick == null) {
                                    stringResource(R.string.attach_hint_first)
                                } else {
                                    stringResource(R.string.attach_hint_second)
                                }
                            )
                        }
                        // A scale nobody measured against this photo -- carried from
                        // the drawing, or fitted by eye -- says so, in amber, for as
                        // long as the photo is on screen. A fit by eye and a
                        // measurement are different things and must never read alike.
                        if (fitDraft == null && !usingGrid && scaleBasis == ScaleBasis.UNMEASURED) {
                            CanvasHint(
                                modifier = Modifier.widthIn(max = 320.dp),
                                text = unmeasuredNote,
                                textColor = MaterialTheme.semantic.warning
                            )
                        }
                        // The fit controls, while a fit is being lined up. Apply is
                        // off until the photo has actually been moved.
                        fitDraft?.let { draft ->
                            FitBar(
                                hint = fitText(
                                    "survey_fit_hint",
                                    "Drag to move the photo, pinch to zoom it, until it lines up with your drawing."
                                ),
                                effect = fitText(
                                    "survey_fit_effect",
                                    "Every length you drew stays exactly as it is. The scale is carried across, but it will read as fitted by eye, not measured."
                                ),
                                applyText = fitText("survey_fit_apply", "Apply fit"),
                                resetText = fitText("survey_fit_reset", "Reset"),
                                cancelText = stringResource(R.string.action_cancel),
                                applyEnabled = !draft.isIdentity,
                                onApply = {
                                    if (!draft.isIdentity) {
                                        // The view follows the photo, so what is on screen
                                        // does not jump when the drawing is carried across.
                                        val (zoomAfter, panAfter) = viewAfterFit(
                                            canvasContentSize.first, canvasContentSize.second,
                                            canvasSize, viewZoom, viewPan, draft
                                        )
                                        viewModel.fitSurvey(draft)
                                        viewZoom = zoomAfter
                                        viewPan = panAfter
                                    }
                                    fitDraft = null
                                },
                                onReset = { fitDraft = PhotoFit.IDENTITY },
                                onCancel = { fitDraft = null }
                            )
                        }
                    }

                    // TOP-END: view controls only -- full screen, layers,
                    // zoom in, zoom out, recentre. Five 48dp buttons with
                    // 8dp gaps is 272dp of the right edge, which is the
                    // reason Undo/Redo are NOT in here: seven of them came
                    // to 392dp, and NudgePad (BOTTOM-END, about 192dp while
                    // Adjust has a point selected) meets that on any phone
                    // under about 590dp of canvas -- worse than the overlap
                    // being fixed. In landscape, which nothing locks out,
                    // the column did not fit the canvas at all and the last
                    // buttons were simply off screen. Undo/Redo live in the
                    // TOP-CENTER group instead; see the comment there.
                    //
                    // This column stays visible in full screen -- it ignores
                    // fullScreenDrawing. Only the estimate button below hides
                    // there; leaving the drawing is not a drawing control.
                    Column(
                        modifier = Modifier.align(Alignment.TopEnd).padding(Space.sm),
                        verticalArrangement = Arrangement.spacedBy(Space.sm)
                    ) {
                        ToolIconButton(
                            icon = if (fullScreenDrawing) Icons.Filled.CloseFullscreen else Icons.Filled.OpenInFull,
                            contentDescription = stringResource(
                                if (fullScreenDrawing) R.string.misc_survey_exit_full_screen else R.string.misc_survey_full_screen
                            ),
                            onClick = { fullScreenDrawing = !fullScreenDrawing }
                        )
                        ToolIconButton(
                            icon = Icons.Filled.Layers,
                            contentDescription = stringResource(R.string.misc_survey_layers_button),
                            onClick = { layersMenuOpen = true }
                        )
                        ZoomButton(Icons.Filled.Add) { viewZoom = (viewZoom * 1.3f).coerceIn(0.25f, 12f) }
                        ZoomButton(Icons.Filled.Remove) { viewZoom = (viewZoom / 1.3f).coerceIn(0.25f, 12f) }
                        ZoomButton(Icons.Filled.MyLocation) { viewZoom = 1f; viewPan = Offset.Zero }
                    }


                    // BOTTOM-START: the way on to the estimate, kept away
                    // from Clear on purpose -- Clear lives inside the
                    // property panel below, a deliberate extra tap so a
                    // thumb reaching for the estimate can never land on the
                    // destructive one by accident. Undo/Redo moved out of
                    // this row to the TOP-CENTER group; see there.
                    Row(
                        modifier = Modifier.align(Alignment.BottomStart).padding(Space.sm),
                        horizontalArrangement = Arrangement.spacedBy(Space.sm),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        if (!fullScreenDrawing) {
                            Surface(
                                tonalElevation = 3.dp,
                                shape = androidx.compose.foundation.shape.RoundedCornerShape(Radius.md),
                                onClick = { onGoToEstimate(jobId) }
                            ) {
                                Text(
                                    stringResource(R.string.draw_to_estimate),
                                    modifier = Modifier.padding(horizontal = Space.md, vertical = Space.sm + Space.xs),
                                    style = MaterialTheme.typography.labelLarge,
                                    color = MaterialTheme.colorScheme.primary
                                )
                            }
                        }
                    }

                    // BOTTOM-CENTER: property information. Collapsed to a
                    // one-line readout by default so it never competes with
                    // the fence for space; tap it for everything that used to
                    // sit in the panel stacked underneath the drawing --
                    // segment lengths, snap, closed perimeter, and Clear.
                    PropertyInfoPanel(
                        modifier = Modifier.align(Alignment.BottomCenter).padding(Space.sm),
                        expanded = propertyPanelExpanded,
                        onToggleExpanded = { propertyPanelExpanded = !propertyPanelExpanded },
                        liveFeet = liveFeet,
                        totalFeetAllRuns = totalFeetAllRuns,
                        showJobTotal = runs.size > 1,
                        cornerCount = geometry.cornerCount,
                        gateCount = gates.size,
                        pxPerFt = pxPerFt,
                        usingGrid = usingGrid,
                        committedPoints = committedPoints,
                        committedGeometry = committedGeometry,
                        closedLoop = activeRun.closedLoop,
                        onClosedLoopChange = { viewModel.toggleClosedLoop(it) },
                        snapOn = snapOn,
                        onSnapChange = { snapOn = it; lastSnap = null },
                        lastSnap = lastSnap,
                        onSegmentClick = { editingSegment = it },
                        onClear = { pendingClearPoints = true },
                        // This panel sits outside the mode switcher -- its
                        // segment chips, closed-perimeter checkbox and Clear
                        // button are reachable whatever tool is selected, so
                        // restricting visibleModes to Move View alone does not
                        // reach them. Guarded here for the same reason.
                        editable = editable,
                        scaleNote = scaleNote
                    )

                    // NudgePad -- unchanged, still bottom-end, still only
                    // while Adjust mode has a point selected; the hint for
                    // the unselected case moved to the top group above.
                    if (mode == SurveyMode.ADJUST && selectedPoint != null) {
                        NudgePad(
                            modifier = Modifier.align(Alignment.BottomEnd),
                            onNudge = { dx, dy ->
                                val idx = selectedPoint ?: return@NudgePad
                                val p = committedPoints.getOrNull(idx) ?: return@NudgePad
                                // One tap = one foot, in the drawing's own
                                // units, so the step means the same thing at
                                // any zoom.
                                val step = pxPerFt ?: SurveyViewModel.PIXELS_PER_FOOT_GRID
                                viewModel.movePoint(idx, FencePoint(p.x + dx * step, p.y + dy * step))
                            },
                            onDone = { selectedPoint = null }
                        )
                    }

                    // The magnifier loupe: shown only while an Adjust-mode
                    // drag is actually moving a vertex, gate or marker (see
                    // where loupeScreenPos is set/cleared above), positioned
                    // above the finger so the finger itself never covers the
                    // exact pixel being placed.
                    loupeScreenPos?.let { pos ->
                        val density = LocalDensity.current
                        val loupeSizePx = with(density) { LOUPE_SIZE_DP.toPx() }
                        Box(
                            modifier = Modifier.offset {
                                androidx.compose.ui.unit.IntOffset(
                                    (pos.x - loupeSizePx / 2f).toInt(),
                                    (pos.y - loupeSizePx - LOUPE_VERTICAL_GAP_PX).toInt()
                                )
                            }
                        ) {
                            MagnifierLoupe(
                                centerContent = loupeContentPos ?: FencePoint(0f, 0f),
                                bmp = bmp,
                                contentW = canvasContentSize.first,
                                contentH = canvasContentSize.second,
                                gridFeetPerSquare = job2.gridFeetPerSquare,
                                pxPerFt = gridPxPerFt,
                                satelliteOn = satelliteOn,
                                satelliteAnchor = satelliteAnchor,
                                satelliteTiles = satelliteTiles,
                                baseScale = viewTransform(
                                    canvasContentSize.first, canvasContentSize.second,
                                    canvasSize, viewZoom, viewPan
                                ).scale,
                                segmentFeet = loupeSegmentFeet,
                                runs = runs,
                                activeRunId = activeRun.id,
                            )
                        }
                    }
                }

            }
        }
    }

    editingSegment?.let { index ->
        val current = viewModel.segmentFeet(index)
        if (current == null) {
            editingSegment = null
        } else {
            SegmentLengthDialog(
                currentFeet = current,
                closingSide = viewModel.isClosingSide(index),
                onConfirm = { feet ->
                    viewModel.setSegmentLengthFeet(index, feet)
                    editingSegment = null
                },
                onDismiss = { editingSegment = null }
            )
        }
    }

    calibrationDialogPoints?.let { (p1, p2) ->
        CalibrationDialog(
            onConfirm = { feet ->
                viewModel.applyCalibration(p1, p2, feet)
                calibrationDialogPoints = null
            },
            onDismiss = { calibrationDialogPoints = null }
        )
    }

    gateDialogPoint?.let { point ->
        GateWidthDialog(
            onConfirm = { widthFt, mounting, swing ->
                viewModel.addGate(point.x, point.y, widthFt, mounting, swing, runDefaults)
                gateDialogPoint = null
            },
            onDismiss = { gateDialogPoint = null }
        )
    }

    // Confirmed rather than instant: a gate carries posts, hardware, concrete
    // and its own charge, so removing one moves the price. A stray tap must not
    // quietly re-quote the job.
    pendingGateRemoval?.let { gate ->
        AlertDialog(
            onDismissRequest = { pendingGateRemoval = null },
            title = { Text(stringResource(R.string.draw_remove_gate_title)) },
            text = {
                Text(stringResource(R.string.misc_survey_remove_gate_text, "%.0f".format(gate.widthFt)))
            },
            confirmButton = {
                Button(onClick = {
                    viewModel.removeGate(gate)
                    pendingGateRemoval = null
                }) { Text(stringResource(R.string.draw_remove)) }
            },
            dismissButton = {
                OutlinedButton(onClick = { pendingGateRemoval = null }) { Text(stringResource(R.string.draw_keep)) }
            }
        )
    }

    // Confirmed for the same reason gate removal is: every point and gate on
    // this run is what the takeoff, post count, material order and price are
    // built from, and a stray tap here used to wipe all of it in one go.
    if (pendingClearPoints) {
        AlertDialog(
            onDismissRequest = { pendingClearPoints = false },
            title = { Text(stringResource(R.string.draw_clear_title)) },
            text = { Text(stringResource(R.string.draw_clear_text)) },
            confirmButton = {
                Button(onClick = {
                    viewModel.clearPoints()
                    pendingClearPoints = false
                }) { Text(stringResource(R.string.draw_clear)) }
            },
            dismissButton = {
                OutlinedButton(onClick = { pendingClearPoints = false }) { Text(stringResource(R.string.draw_keep)) }
            }
        )
    }

    // ATTACHING: what it does to the fence, before it happens.
    //
    // This is the answer to what he asked for weeks ago -- "I want to be able
    // to see that in the grid" -- and it is the half that makes the control
    // worth having: a post, a cap and that post's concrete come off the order,
    // and two end posts become one corner post. Said in his terms, with the
    // numbers, from the same arithmetic that will price it.
    joinOffer?.let { offer ->
        JoinOfferDialog(
            offer = offer,
            runs = runs,
            onConfirm = { viewModel.confirmJoinOffer() },
            onDismiss = { viewModel.clearJoinPick() }
        )
    }

    // DOUBLE TAPPED TO FINISH A SIDE: carry on, or start a separate one.
    //
    // Both answers are ordinary, so neither is the default and neither is
    // hidden behind the other. Dismissing is the same as "continue", because
    // that is what the drawing already shows: the side is still selected and
    // the next tap extends it, exactly as before this dialog existed.
    sideFinished?.let { finished ->
        AlertDialog(
            onDismissRequest = { viewModel.dismissSideFinished() },
            title = {
                Text(
                    stringResource(
                        R.string.side_finished_title,
                        FeetInches.formatCompact(finished.feet)
                    )
                )
            },
            confirmButton = {
                TextButton(onClick = { viewModel.startNewSideAfterFinish(runDefaults) }) {
                    Text(stringResource(R.string.side_finished_new))
                }
            },
            dismissButton = {
                TextButton(onClick = { viewModel.dismissSideFinished() }) {
                    Text(stringResource(R.string.side_finished_continue))
                }
            }
        )
    }

    // Asked, not assumed -- and asked with what it costs spelled out, because
    // this is the one control on the drawing screen that cannot be walked back
    // with Undo.
    //
    // The permission is read again here rather than trusted to the button that
    // set the flag. A permission read once further up a screen and acted on
    // further down survives the screen being recomposed with a different
    // session -- a sign-out, or a role change pushed down while the drawing is
    // open. The run editor's own delete repeats its gate on its dialog for the
    // same reason.
    if (pendingEraseRunId != null && session.canDelete) {
        val eraseTarget = runs.firstOrNull { it.id == pendingEraseRunId }
        if (eraseTarget == null) {
            // The run went while the dialog was up (a sync from the office,
            // another phone). There is nothing left to name, and erasing
            // whatever the selection landed on instead would be a delete
            // nobody confirmed.
            pendingEraseRunId = null
        } else {
            val eraseName = eraseTarget.label.takeIf { it.isNotBlank() }
                ?: stringResource(R.string.misc_survey_untitled)
            AlertDialog(
                onDismissRequest = { pendingEraseRunId = null },
                title = { Text(stringResource(R.string.draw_erase_run_title)) },
                text = { Text(stringResource(R.string.draw_erase_run_body, eraseName)) },
                confirmButton = {
                    // Red is spent only on what Undo cannot take back, the same
                    // rule the job list and the run editor follow, so the colour
                    // keeps meaning one thing across the app.
                    Button(
                        onClick = {
                            val target = eraseTarget.id
                            pendingEraseRunId = null
                            // The snap cue describes the last point placed on
                            // the run that is about to go.
                            lastSnap = null
                            // BY ID. The dialog may be naming a side he
                            // long-pressed, which is not the selected one.
                            viewModel.eraseRun(target)
                        },
                        colors = androidx.compose.material3.ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.error,
                            contentColor = MaterialTheme.colorScheme.onError
                        )
                    ) { Text(stringResource(R.string.draw_erase)) }
                },
                dismissButton = {
                    OutlinedButton(onClick = { pendingEraseRunId = null }) {
                        Text(stringResource(R.string.action_cancel))
                    }
                }
            )
        }
    }

    markerDialogPoint?.let { point ->
        SiteMarkerDialog(
            existing = siteMarkers,
            onConfirm = { kind, label, w, h, rot ->
                viewModel.addSiteMarker(kind, point.x, point.y, label, w, h, rot)
                markerDialogPoint = null
            },
            onDelete = { marker -> viewModel.deleteSiteMarker(marker) },
            onDismiss = { markerDialogPoint = null }
        )
    }

    if (layersMenuOpen) {
        // The dialog sits outside the drawing block above, so it works out
        // for itself what kind of job this is.
        val dialogJob = job
        val dialogBasis = dialogJob?.let { DrawingScale.basisOf(it) } ?: ScaleBasis.GRID
        LayersDialog(
            isPhotoJob = dialogBasis != ScaleBasis.GRID,
            surveyOnThisPhone = dialogJob?.surveyImagePath != null,
            surveyShown = surveyShown,
            onShowSurvey = { viewModel.showSurveyPhoto() },
            fitAvailable = !usingGrid &&
                (dialogBasis == ScaleBasis.MEASURED || dialogBasis == ScaleBasis.UNMEASURED),
            fitNeedsScale = !usingGrid && dialogBasis == ScaleBasis.NONE,
            onFitPhoto = {
                layersMenuOpen = false
                fitDraft = PhotoFit.IDENTITY
            },
            usingGrid = usingGrid,
            satelliteOn = satelliteOn,
            onSatelliteToggle = { satelliteOn = it },
            satelliteError = satelliteError,
            online = online,
            job2 = job,
            onSetGridExtent = { viewModel.setGridExtent(it) },
            onSetGridSpacing = { viewModel.setGridLineSpacingFt(it) },
            onUploadPhoto = {
                imagePicker.launch(androidx.activity.result.PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
            },
            onUseGrid = { viewModel.clearSurveyImage() },
            showFenceLayer = showFenceLayer,
            onShowFenceLayerChange = { showFenceLayer = it },
            showGatesLayer = showGatesLayer,
            onShowGatesLayerChange = { showGatesLayer = it },
            showDimensionsLayer = showDimensionsLayer,
            onShowDimensionsLayerChange = { showDimensionsLayer = it },
            showMarkersLayer = showMarkersLayer,
            onShowMarkersLayerChange = { showMarkersLayer = it },
            onDismiss = { layersMenuOpen = false },
            editable = editable
        )
    }
}

/**
 * The short name a marker carries on the canvas and in the already-marked list.
 *
 * The old-fence marker no longer reads as plainly "Old fence" here. A marker is
 * a note pinned to a spot: it has no length, it is not part of any run, and it
 * charges nothing. Being paid to pull an old fence out needs a teardown run --
 * a drawn run whose footage feeds the teardown charge. The two sat beside each
 * other under names that read the same, so the obvious-looking way to record an
 * old fence was the one that bills zero, and nothing on screen said so.
 *
 * The enum value stays. Jobs already carry markers placed for a legitimate
 * note-only reason -- a neighbour's fence on the line, a fence somebody else is
 * clearing -- and dropping the value would silently turn every one of those
 * into an obstacle.
 *
 * Only the old fence is named here. The other eight come from the shared
 * marker-name table this app already keeps, so a marker kind added later is
 * named in one place instead of two, and a copy of that table living in this
 * file could not drift out of step with the original.
 *
 * The shared table still calls this kind plainly "Old fence", which is what
 * the crew's read-only plan and the job sheet show. Repointing it at the same
 * string this override uses would settle the wording everywhere and make this
 * whole function redundant -- it is left here rather than done there because
 * that table is shared with screens outside this change.
 */
private fun markerShortLabelRes(kind: SiteMarkerKind): Int =
    if (kind == SiteMarkerKind.EXISTING_FENCE) R.string.misc_marker_old_fence_note
    else kind.labelRes()

/**
 * The name the marker picker offers, which for the old fence is longer than the
 * canvas could carry.
 *
 * On the canvas a label sits beside a dot and competes with the fence line for
 * room, so it stays short. On a chip in the picker there is width to spend, and
 * the distinction worth spending it on is that this marks an old fence nobody
 * is being paid to remove -- which is the choice being made at that moment.
 * Every other kind reads the same in both places.
 */
private fun markerPickerLabelRes(kind: SiteMarkerKind): Int =
    if (kind == SiteMarkerKind.EXISTING_FENCE) R.string.draw_marker_old_fence_chip
    else markerShortLabelRes(kind)

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun SiteMarkerDialog(
    existing: List<SiteMarker>,
    // Carries the box too. A dialog that collects three numbers and hands
    // back two of them is a dialog whose fields do nothing.
    onConfirm: (SiteMarkerKind, String, Float, Float, Float) -> Unit,
    onDelete: (SiteMarker) -> Unit,
    onDismiss: () -> Unit
) {
    var kind by remember { mutableStateOf(SiteMarkerKind.OBSTACLE) }
    var label by remember { mutableStateOf("") }
    // Typed in FEET. Blank means no box, which is every marker that is not a
    // building: a tree does not have a width worth drawing.
    var wFt by remember { mutableStateOf("") }
    var hFt by remember { mutableStateOf("") }
    var rotDeg by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.draw_mark_spot)) },
        text = {
            Column {
                Text(
                    stringResource(R.string.misc_survey_whats_here),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(Modifier.height(Space.sm))
                androidx.compose.foundation.layout.FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(Space.sm)
                ) {
                    SiteMarkerKind.values().forEach { k ->
                        androidx.compose.material3.FilterChip(
                            selected = kind == k,
                            onClick = { kind = k },
                            label = { Text(stringResource(markerPickerLabelRes(k))) }
                        )
                    }
                }
                // Said only while the old fence is the chosen kind, so the
                // other eight are not lectured about teardown pricing.
                //
                // This is the line that keeps a marker from being mistaken for
                // the billable thing. The picker and the teardown run read
                // almost identically, and of the two only the run can be
                // charged for; somebody recording an old fence the obvious way
                // got no money for removing it and no warning either. So the
                // marker says what it is not, and says where the charge lives.
                if (kind == SiteMarkerKind.EXISTING_FENCE) {
                    Spacer(Modifier.height(Space.sm))
                    Text(
                        stringResource(R.string.draw_marker_old_fence_not_charged),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error
                    )
                }
                // THE SIZE, for the kinds that have one. A house, a pool and a
                // driveway are shapes on the ground; a tree, a slope or a buried
                // utility is a spot. Offering width and height on all nine would
                // be asking how wide an easement is.
                //
                // Left blank it stays a point, which is what every marker drawn
                // before today is.
                if (kind in BOXABLE_MARKERS) {
                    Spacer(Modifier.height(Space.sm))
                    Text(
                        stringResource(R.string.draw_marker_size_hint),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Spacer(Modifier.height(Space.xs))
                    Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                        OutlinedTextField(
                            value = wFt, onValueChange = { wFt = it.filter { c -> c.isDigit() || c == '.' } },
                            label = { Text(stringResource(R.string.draw_marker_width_ft)) },
                            singleLine = true, modifier = Modifier.weight(1f)
                        )
                        OutlinedTextField(
                            value = hFt, onValueChange = { hFt = it.filter { c -> c.isDigit() || c == '.' } },
                            label = { Text(stringResource(R.string.draw_marker_depth_ft)) },
                            singleLine = true, modifier = Modifier.weight(1f)
                        )
                        OutlinedTextField(
                            value = rotDeg, onValueChange = { rotDeg = it.filter { c -> c.isDigit() || c == '.' } },
                            label = { Text(stringResource(R.string.draw_marker_turn_deg)) },
                            singleLine = true, modifier = Modifier.weight(1f)
                        )
                    }
                }
                Spacer(Modifier.height(Space.sm))
                OutlinedTextField(
                    value = label, onValueChange = { label = it },
                    label = { Text(stringResource(R.string.draw_note_optional)) },
                    modifier = Modifier.fillMaxWidth()
                )
                if (existing.isNotEmpty()) {
                    Spacer(Modifier.height(Space.md))
                    Text(stringResource(R.string.draw_already_marked), style = MaterialTheme.typography.labelLarge)
                    existing.forEach { marker ->
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                            Text(
                                marker.label.ifBlank { stringResource(markerShortLabelRes(marker.kind)) },
                                modifier = Modifier.weight(1f),
                                style = MaterialTheme.typography.bodyMedium
                            )
                            IconButton(onClick = { onDelete(marker) }) {
                                Icon(Icons.Filled.Clear, contentDescription = stringResource(R.string.misc_survey_remove_marker))
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { Button(onClick = {
            onConfirm(
                kind, label,
                wFt.toFloatOrNull() ?: 0f,
                hFt.toFloatOrNull() ?: 0f,
                rotDeg.toFloatOrNull() ?: 0f
            )
        }) { Text(stringResource(R.string.draw_add_marker)) } },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } }
    )
}

/**
 * What a run is called in the attach wording: its own name, or "Untitled", and
 * its fence type -- exactly as the run picker names it, so the confirmation and
 * the picker cannot call the same side two different things.
 */
@Composable
private fun joinRunName(runs: List<FenceRun>, syncId: String): String {
    val untitled = stringResource(R.string.misc_survey_untitled)
    val run = runs.firstOrNull { it.syncId == syncId } ?: return untitled
    return "${run.label.ifBlank { untitled }} (${run.fenceType.label()})"
}

/**
 * "Attach these two ends?", with what it does to the materials.
 *
 * Every figure comes off [JoinOffer.effect], which the view model took from the
 * join arithmetic by running it twice -- on the drawing as it is, and on the
 * drawing as it would be -- so this cannot drift from what the estimate will
 * eventually charge. Three things it refuses to do:
 *
 *  - claim a saving when there is none. A tear-out side bills no posts, so
 *    attaching two of them changes no material; [JoinOffer.effect] is null and
 *    the wording says so instead of printing a confident zero.
 *  - imply the price has moved. While SurveyViewModel.JOIN_PRICING_READY is
 *    false no engine reads an attachment, so the dialog says the materials and
 *    the price do not change today. A control that quietly changes a price and
 *    a control that quietly changes nothing are the same lie.
 *  - let an approved quote be re-cut silently. [JoinOffer.approvalAtRisk] is
 *    the same predicate the screen's edit warning uses, and it is said here,
 *    before the attachment, in the words of what happens to the customer.
 */
@Composable
private fun JoinOfferDialog(
    offer: JoinOffer,
    runs: List<FenceRun>,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit
) {
    val effect = offer.effect
    val members = offer.memberRunIds
    val warning = MaterialTheme.semantic.warning
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                stringResource(
                    if (offer.detach) R.string.attach_detach_title else R.string.attach_title
                )
            )
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                if (offer.detach) {
                    val freed = offer.end
                    Text(
                        stringResource(
                            R.string.attach_detach_body,
                            if (freed == null) stringResource(R.string.misc_survey_untitled)
                            else joinRunName(runs, freed.runId)
                        )
                    )
                } else if (members.size == 2) {
                    Text(
                        stringResource(
                            R.string.attach_body_two,
                            joinRunName(runs, members[0]),
                            joinRunName(runs, members[1])
                        )
                    )
                } else {
                    Text(stringResource(R.string.attach_body_many, members.size))
                }

                if (effect == null) {
                    Text(stringResource(R.string.attach_no_material))
                } else {
                    // The sign is already flipped for a detach, so the count
                    // is read without it and the two directions have their own
                    // words rather than a minus sign to interpret.
                    val posts = kotlin.math.abs(effect.postsSaved)
                    if (offer.detach) {
                        Text(
                            if (posts == 1) stringResource(R.string.attach_detach_effect_one)
                            else stringResource(R.string.attach_detach_effect_many, posts)
                        )
                    } else {
                        Text(
                            if (posts == 1) stringResource(R.string.attach_effect_one)
                            else stringResource(R.string.attach_effect_many, posts)
                        )
                        Text(
                            stringResource(
                                if (effect.kind == JoinPostKind.CORNER) R.string.attach_kind_corner
                                else R.string.attach_kind_line,
                                effect.memberCount
                            )
                        )
                        Text(
                            stringResource(
                                R.string.attach_billed,
                                joinRunName(runs, effect.ownerRunId)
                            )
                        )
                        // Attaching now CLOSES the gap, so the old wording --
                        // "attaching them moves neither one; line them up with
                        // Adjust" -- became untrue the day that landed.
                        // .attach_gap, which said exactly that, is retired here:
                        // this names the side that MOVES, how far, and what that
                        // does to its footage, because footage is labour. A gap
                        // too wide to close never reaches this dialog at all:
                        // tapJoinEnd refuses it as TOO_FAR_APART.
                        val closer = offer.gapCloser
                        if (!offer.detach) {
                            if (closer == null) {
                                Text(stringResource(R.string.attach_already_together))
                            } else {
                                Text(
                                    stringResource(
                                        R.string.attach_moves,
                                        joinRunName(runs, closer.end.runId),
                                        FeetInches.formatCompact(closer.distanceFeet)
                                    ),
                                    color = warning
                                )
                                Text(
                                    stringResource(
                                        R.string.attach_moves_keeps_length,
                                        joinRunName(runs, closer.end.runId),
                                        FeetInches.formatCompact(closer.runFeetBefore)
                                    ),
                                    color = warning
                                )
                            }
                        } else {
                            // Detaching is the opposite of attaching about the
                            // POST, not about the drawing. Said before it
                            // happens rather than discovered afterwards.
                            Text(stringResource(R.string.attach_detach_keeps_drawing))
                        }
                    }
                }

                if (!SurveyViewModel.JOIN_PRICING_READY) {
                    Text(stringResource(R.string.attach_price_later))
                }
                if (offer.approvalAtRisk) {
                    Text(stringResource(R.string.attach_approved_warning), color = warning)
                }
            }
        },
        confirmButton = {
            Button(onClick = onConfirm) {
                Text(
                    stringResource(
                        if (offer.detach) R.string.attach_detach_action else R.string.attach_action
                    )
                )
            }
        },
        dismissButton = {
            OutlinedButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
        }
    )
}

/**
 * Says plainly that the numbers stopped following the drawing.
 *
 * The canvas gives no other sign of this -- the line is still there, still
 * editable, still looks correct -- so without this the first anyone learns
 * that materials and price went stale is a customer questioning an estimate
 * that quietly stopped matching what got drawn.
 */
@Composable
private fun RepriceFailedBanner() {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.errorContainer
    ) {
        Text(
            stringResource(R.string.field_polish_reprice_failed),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onErrorContainer,
            maxLines = 2,
            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth().padding(horizontal = Space.screen, vertical = Space.sm)
        )
    }
}

/**
 * The teardown charge, on the screen where the old fence gets drawn.
 *
 * A labelled switch on purpose, and not something that follows the drawing.
 * Whether a run IS the old fence and whether anybody is being PAID to take it
 * out are two different facts, and keeping them apart is what lets an old fence
 * be drawn for the plan's sake on a job where the customer is clearing it
 * themselves. Money never moves because a line was drawn.
 *
 * The off state says what off costs, because that is the exact mistake this
 * control exists to catch: a fully drawn teardown that charges nothing. The on
 * state says where the amounts come from, so nobody reads this switch as having
 * set a price -- it decides whether the teardown is charged, and the rates and
 * the haul fee are still typed on the job sheet.
 */
@Composable
private fun TeardownChargeRow(
    chargeOn: Boolean,
    hasTeardownRun: Boolean,
    enabled: Boolean = true,
    onChargeChange: (Boolean) -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Space.md, vertical = Space.xs)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                stringResource(R.string.draw_teardown_charge),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f)
            )
            // Visibly dimmed rather than a switch that flips on screen and
            // then silently does not stick -- SurveyViewModel.setTeardownCharge
            // refuses a guest regardless, but a live-looking switch whose tap
            // is swallowed is exactly the fake control this wave exists to
            // close.
            Switch(checked = chargeOn, onCheckedChange = onChargeChange, enabled = enabled)
        }
        if (chargeOn) {
            Text(
                stringResource(R.string.draw_teardown_charge_on),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        } else if (hasTeardownRun) {
            Text(
                stringResource(R.string.draw_teardown_charge_off),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error
            )
        }
    }
}

@Composable
private fun ZoomButton(icon: androidx.compose.ui.graphics.vector.ImageVector, onClick: () -> Unit) {
    Surface(tonalElevation = 3.dp, shape = androidx.compose.foundation.shape.CircleShape) {
        IconButton(onClick = onClick) { Icon(icon, contentDescription = null) }
    }
}

/**
 * A single floating icon control, same visual language as [ZoomButton].
 * Used for full screen, Layers, Undo and Redo -- keeping every floating control
 * the same shape is what makes a handful of buttons over the canvas read
 * as a deliberate group rather than clutter that happens to be nearby.
 */
@Composable
private fun ToolIconButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    contentDescription: String,
    /**
     * Drawn greyed out while staying pressable -- for a control that has
     * nothing to do right now but should still explain why when pressed.
     */
    dimmed: Boolean = false,
    /** What a screen reader says about the dimmed state, since it is not "disabled". */
    dimmedStateDescription: String? = null,
    onClick: () -> Unit
) {
    Surface(tonalElevation = 3.dp, shape = androidx.compose.foundation.shape.CircleShape) {
        IconButton(
            onClick = onClick,
            modifier = if (dimmed && dimmedStateDescription != null) {
                Modifier.semantics { stateDescription = dimmedStateDescription }
            } else Modifier
        ) {
            Icon(
                icon,
                contentDescription = contentDescription,
                tint = if (dimmed) MaterialTheme.colorScheme.onSurface.copy(alpha = DIMMED_ICON_ALPHA)
                       else androidx.compose.material3.LocalContentColor.current
            )
        }
    }
}

/** Material's own alpha for content that is not available right now. */
private const val DIMMED_ICON_ALPHA = 0.38f

/**
 * Snapping, floated where the drawing happens: a chip to turn it off and
 * trace freely (one tap, not "open the panel, find the checkbox"), and a
 * plain line saying what the last point was locked to -- "Square to the last
 * side", "Horizontal on the map", "Rounded to 48'". A point that jumps and
 * says why is a tool; one that jumps silently is a bug.
 *
 * The cue sits in a [CanvasHint], which lets taps fall through to the
 * drawing; only the chip itself takes touches.
 *
 * [showIntro] adds a fourth line, ahead of the other three, that says what
 * the chip actually does -- "locks the side you're drawing to straight, 90
 * degrees, or 45 degrees off the previous side," in the words the chip's
 * owner used when he said he didn't know. Shown until the first real snap
 * explains itself instead (see where the caller clears it).
 */
@Composable
private fun SnapStrip(
    snapOn: Boolean,
    onSnapChange: (Boolean) -> Unit,
    lastSnap: com.fenceestimator.app.geometry.SnapResult?,
    showIntro: Boolean = false,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Surface(
            modifier = Modifier.padding(top = Space.xs),
            tonalElevation = 4.dp,
            shape = androidx.compose.foundation.shape.RoundedCornerShape(Radius.md)
        ) {
            FilterChip(
                selected = snapOn,
                onClick = { onSnapChange(!snapOn) },
                label = { Text(stringResource(R.string.snap_toggle)) },
                leadingIcon = if (snapOn) {
                    { Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(18.dp)) }
                } else null,
                // FilterChip already reports selected / not selected to a
                // screen reader, which is exactly on / off here.
                modifier = Modifier.padding(horizontal = Space.xs)
            )
        }
        when {
            lastSnap != null -> CanvasHint(
                text = snapWords(lastSnap),
                textColor = MaterialTheme.semantic.success
            )
            !snapOn -> CanvasHint(text = stringResource(R.string.snap_off_note))
            showIntro -> CanvasHint(text = stringResource(R.string.snap_intro_hint))
        }
    }
}

/**
 * The tool switcher (Draw, Calibrate, Gate, Mark Site, Adjust, Move View),
 * floating over the canvas instead of pinned in a full-width row beneath
 * the top bar -- the exact same viewModel.setMode(m) call as before, just
 * relocated so switching tools no longer reserves a fixed strip of height
 * the drawing never gets back. Horizontally scrollable so a phone too
 * narrow to show all six never has to shrink one to fit -- there is more
 * room to scroll than there ever was to squeeze labels into one screen
 * width.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ModeToolGroup(
    visibleModes: List<Pair<SurveyMode, Int>>,
    mode: SurveyMode,
    onSelect: (SurveyMode) -> Unit
) {
    Surface(tonalElevation = 4.dp, shape = androidx.compose.foundation.shape.RoundedCornerShape(Radius.md)) {
        SingleChoiceSegmentedButtonRow(
            modifier = Modifier.horizontalScroll(rememberScrollState()).padding(Space.xs)
        ) {
            visibleModes.forEachIndexed { index, (m, label) ->
                SegmentedButton(
                    selected = mode == m,
                    onClick = { onSelect(m) },
                    shape = SegmentedButtonDefaults.itemShape(index, visibleModes.size)
                ) { Text(stringResource(label)) }
            }
        }
    }
}

/**
 * Property information, out of the way when drawing.
 *
 * Collapsed, it is one line -- the running total (or, before there's a
 * scale, why there isn't one yet), corners and gates -- read at a glance
 * with no tap needed, which is what used to take a whole bar above the
 * canvas. Expanded, it holds everything that used to be a panel stacked
 * underneath the drawing: the tappable segment-length list, snap and its
 * explanation, closed perimeter, and Clear -- Clear deliberately last and
 * set apart by real space from Undo and the estimate button, which float
 * elsewhere, so a thumb reaching for either of those can never land on the
 * destructive one instead.
 */
@Composable
private fun PropertyInfoPanel(
    modifier: Modifier = Modifier,
    expanded: Boolean,
    onToggleExpanded: () -> Unit,
    liveFeet: Float,
    totalFeetAllRuns: Float,
    showJobTotal: Boolean,
    cornerCount: Int,
    gateCount: Int,
    pxPerFt: Float?,
    usingGrid: Boolean,
    committedPoints: List<FencePoint>,
    committedGeometry: com.fenceestimator.app.geometry.FenceGeometryResult?,
    closedLoop: Boolean,
    onClosedLoopChange: (Boolean) -> Unit,
    snapOn: Boolean,
    onSnapChange: (Boolean) -> Unit,
    lastSnap: com.fenceestimator.app.geometry.SnapResult?,
    onSegmentClick: (Int) -> Unit,
    onClear: () -> Unit,
    editable: Boolean = true,
    /**
     * What stands behind the scale while a survey photo is showing -- measured
     * against a known length, or not -- one line, always visible, so a number
     * that was fitted by eye is never read as one that was measured. Null on
     * the grid, whose scale needs no such line.
     */
    scaleNote: String? = null
) {
    Surface(
        modifier = modifier.widthIn(max = 360.dp),
        tonalElevation = 4.dp,
        shape = androidx.compose.foundation.shape.RoundedCornerShape(Radius.md),
        onClick = onToggleExpanded
    ) {
        Column(Modifier.padding(horizontal = Space.md, vertical = Space.sm)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Filled.Straighten, contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp)
                )
                Text(
                    "  " + when {
                        // The grid has its own known scale, so there is
                        // nothing to calibrate and nothing to warn about.
                        // Only a survey photo can be missing a scale.
                        pxPerFt != null && liveFeet > 0f ->
                            stringResource(R.string.misc_survey_feet_total, String.format("%.1f", liveFeet)) +
                                "  |  " + stringResource(R.string.misc_survey_corners_count, cornerCount) +
                                "  |  " + stringResource(R.string.misc_survey_gates_count, gateCount) +
                                // Job-wide total, only when there's more than
                                // one run -- with a single run it would just
                                // repeat the number already shown.
                                if (showJobTotal) "  |  " + stringResource(
                                    R.string.misc_survey_feet_total_job,
                                    String.format("%.1f", totalFeetAllRuns)
                                ) else ""
                        usingGrid -> stringResource(R.string.misc_survey_grid_to_scale)
                        pxPerFt == null -> stringResource(R.string.misc_survey_tap_calibrate)
                        else -> stringResource(R.string.misc_survey_tap_to_start)
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = androidx.compose.ui.text.font.FontWeight.Bold
                )
                Spacer(Modifier.weight(1f))
                Icon(
                    if (expanded) Icons.Filled.KeyboardArrowDown else Icons.Filled.KeyboardArrowUp,
                    contentDescription = stringResource(
                        if (expanded) R.string.misc_survey_panel_collapse else R.string.misc_survey_panel_expand
                    )
                )
            }
            if (scaleNote != null) {
                Text(
                    scaleNote,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            if (expanded) {
                Spacer(Modifier.height(Space.sm))
                // Every segment, tappable, in order.
                //
                // The dimensions on the canvas can be tapped too, but a label
                // on a zoomed-out drawing is a small target for somebody
                // standing in a yard holding a tape in the other hand. This
                // row is the reliable way in: it does not need aim, it works
                // one-handed, and it makes the feature findable at all.
                if (committedPoints.size >= 2 && pxPerFt != null && pxPerFt > 0f && committedGeometry != null) {
                    Text(
                        stringResource(R.string.seg_len_row_title),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Row(
                        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(Space.sm)
                    ) {
                        // committedGeometry.segments already wraps the last
                        // index back to 0 when closedLoop is set (same
                        // FenceGeometryEngine.analyze() the totals and the
                        // takeoff use), so the closing side gets its own chip
                        // here instead of being silently skipped.
                        for (seg in committedGeometry.segments) {
                            AssistChip(
                                onClick = { onSegmentClick(seg.fromIndex) },
                                enabled = editable,
                                label = {
                                    Text(
                                        stringResource(
                                            R.string.seg_len_chip,
                                            seg.fromIndex + 1,
                                            FeetInches.formatCompact(seg.lengthFt)
                                        )
                                    )
                                }
                            )
                        }
                    }
                    Spacer(Modifier.height(Space.sm))
                    if (closedLoop) {
                        Text(
                            stringResource(
                                R.string.misc_survey_perimeter_total,
                                String.format("%.1f", committedGeometry.totalLinearFeet)
                            ),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Spacer(Modifier.height(Space.sm))
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = snapOn, onCheckedChange = onSnapChange)
                    Column(modifier = Modifier.weight(1f)) {
                        Text(stringResource(R.string.snap_toggle))
                        // Says what the last point was pulled onto, so a
                        // point that moved under the finger is explained
                        // rather than mysterious. Falls back to what
                        // snapping does, so the switch is not a word with no
                        // meaning attached.
                        Text(
                            lastSnap?.let { snapWords(it) } ?: stringResource(R.string.snap_help),
                            style = MaterialTheme.typography.bodySmall,
                            color = if (lastSnap != null) MaterialTheme.semantic.success
                                    else MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = closedLoop, onCheckedChange = onClosedLoopChange, enabled = editable)
                    Text(stringResource(R.string.draw_closed_perimeter))
                }
                Spacer(Modifier.height(Space.sm))
                // Set apart from Snap and Closed Perimeter above by real
                // space, not just color -- Clear wipes every point and gate
                // on this run (it still opens the same confirmation below),
                // so it must never be the first thing a thumb finds inside
                // this panel.
                //
                // Hidden rather than disabled for a guest, the same
                // convention the run editor's own delete follows: a greyed
                // Clear invites asking the office to switch on something that
                // was never meant to be theirs to press.
                if (editable) {
                    OutlinedButton(onClick = onClear, modifier = Modifier.align(Alignment.End)) {
                        Icon(Icons.Filled.Clear, contentDescription = null)
                        Text(" " + stringResource(R.string.draw_clear))
                    }
                }
            }
        }
    }
}

/**
 * The Layers control: what paints as the background (the grid, satellite
 * imagery, or an uploaded photo) and whether the fence or the site markers
 * paint on top of it. Every control here is the same one that used to sit
 * permanently above the canvas -- the grid-size chips, the feet-per-square
 * field, the satellite toggle and its error/offline notes, the upload/use-
 * grid button -- just asked for instead of shown, plus the two new
 * show/hide switches for the fence and marker layers.
 */
@Composable
private fun LayersDialog(
    usingGrid: Boolean,
    satelliteOn: Boolean,
    onSatelliteToggle: (Boolean) -> Unit,
    satelliteError: String?,
    online: Boolean,
    job2: com.fenceestimator.app.data.Job?,
    onSetGridExtent: (Float) -> Unit,
    onSetGridSpacing: (Float) -> Unit,
    onUploadPhoto: () -> Unit,
    onUseGrid: () -> Unit,
    showFenceLayer: Boolean,
    onShowFenceLayerChange: (Boolean) -> Unit,
    showGatesLayer: Boolean,
    onShowGatesLayerChange: (Boolean) -> Unit,
    showDimensionsLayer: Boolean,
    onShowDimensionsLayerChange: (Boolean) -> Unit,
    showMarkersLayer: Boolean,
    onShowMarkersLayerChange: (Boolean) -> Unit,
    onDismiss: () -> Unit,
    /**
     * Background and scale all write to the job (or, for a photo, start a new
     * one) -- the four show/hide layer switches below do not, so they stay
     * enabled regardless.
     */
    editable: Boolean = true,
    /** The job has a survey photo, whether or not its file has reached this phone. */
    isPhotoJob: Boolean = false,
    /** The survey's file is on this phone, so it can be shown. */
    surveyOnThisPhone: Boolean = true,
    /** The survey is the background right now (false: the grid was chosen). */
    surveyShown: Boolean = true,
    onShowSurvey: () -> Unit = {},
    /** A photo is showing and has a scale to carry across, so it can be fitted. */
    fitAvailable: Boolean = false,
    /** A photo is showing but has no scale yet, so there is nothing to carry across. */
    fitNeedsScale: Boolean = false,
    onFitPhoto: () -> Unit = {}
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.misc_survey_layers_button)) },
        text = {
            // Scrollable: on the grid, this can hold the background choice,
            // grid-size chips, the feet-per-square field and both layer
            // switches at once -- more than a short phone screen guarantees
            // an AlertDialog room for without it.
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(Space.sm)
            ) {
                Text(
                    stringResource(R.string.misc_survey_layers_background),
                    style = MaterialTheme.typography.titleSmall
                )
                if (usingGrid && !isPhotoJob) {
                    Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                        // Only offered instead of the grid, never alongside an
                        // uploaded photo -- the office's calibration rule is
                        // "only when there is no survey photo", and offering
                        // this button when a photo already exists would invite
                        // exactly the case that rule excludes.
                        FilterChip(
                            selected = !satelliteOn,
                            onClick = { onSatelliteToggle(false) },
                            enabled = editable,
                            label = { Text(stringResource(R.string.misc_survey_layers_grid)) }
                        )
                        FilterChip(
                            selected = satelliteOn,
                            onClick = { onSatelliteToggle(true) },
                            enabled = editable,
                            label = { Text(stringResource(R.string.sat_toggle_label)) }
                        )
                    }
                    satelliteError?.let { message ->
                        Text(message, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    }
                    // Offline with nothing cached yet: the grid still draws
                    // (it always does, as the base layer) so tracing is never
                    // actually blocked, but silently showing the grid instead
                    // of the imagery someone asked for would look like the
                    // toggle did nothing.
                    if (satelliteOn && !online) {
                        Text(
                            stringResource(R.string.sat_offline_note),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    OutlinedButton(onClick = onUploadPhoto, enabled = editable) { Text(stringResource(R.string.survey_upload_photo)) }
                    if (job2 != null) {
                        Spacer(Modifier.height(Space.xs))
                        // How much ground the grid covers.
                        //
                        // A gate and a paddock are not the same drawing
                        // problem. Fixed at 400ft, one foot was about two and
                        // a half pixels on a phone, so a 20ft run could not be
                        // drawn accurately and a small drag measured forty
                        // feet.
                        Text(stringResource(R.string.misc_survey_how_big), style = MaterialTheme.typography.labelLarge)
                        Row(
                            modifier = Modifier.horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(Space.sm)
                        ) {
                            SurveyViewModel.GRID_SIZES_FT.forEach { size ->
                                val selected = kotlin.math.abs(job2.gridExtentFt - size) < 0.5f
                                FilterChip(
                                    selected = selected,
                                    onClick = { onSetGridExtent(size) },
                                    enabled = editable,
                                    label = { Text(stringResource(R.string.draw_grid_size_ft, size.toInt())) }
                                )
                            }
                        }
                        Text(
                            stringResource(R.string.misc_survey_keeps_length),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        // D1: "unlimited grid -- draw bigger, zoom out and
                        // keep finding grid." The chip row above is a fixed
                        // list of quick picks and always will be; this is the
                        // control with no top, one double/halve per tap
                        // (SurveyViewModel.zoomGridExtent). It goes through
                        // the same onSetGridExtent the chips use, so a job's
                        // drawing is rescaled and its measured lengths held
                        // fixed exactly the way picking a chip already does --
                        // this never touches calibration on its own, only
                        // asks setGridExtent for a bigger or smaller number.
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                            IconButton(
                                onClick = {
                                    onSetGridExtent(SurveyViewModel.zoomGridExtent(job2.gridExtentFt, 0.5f))
                                },
                                enabled = editable && job2.gridExtentFt > SurveyViewModel.MIN_GRID_EXTENT_FT
                            ) { Icon(Icons.Filled.Remove, contentDescription = "Smaller grid") }
                            Text(
                                stringResource(R.string.draw_grid_size_ft, job2.gridExtentFt.toInt()),
                                style = MaterialTheme.typography.titleSmall
                            )
                            IconButton(
                                onClick = {
                                    onSetGridExtent(SurveyViewModel.zoomGridExtent(job2.gridExtentFt, 2f))
                                },
                                enabled = editable
                            ) { Icon(Icons.Filled.Add, contentDescription = "Bigger grid") }
                        }
                        // D1's other half: satellite's own zoom now genuinely
                        // follows the same +/- buttons and chips above (see
                        // the doc on SatelliteAnchor in this file) -- but only
                        // as far as imagery can actually be FETCHED for. Past
                        // that, SurveyDrawScreen's own tile budget
                        // (MAX_SATELLITE_TILES) is what stops it, the same
                        // safety valve that already exists for a slow
                        // connection, and the grid shows through the rest --
                        // the same honest fallback already used while imagery
                        // is loading or the phone is offline (see
                        // sat_offline_note above). This just says so, with a
                        // real number computed from this job's own site
                        // latitude, instead of leaving the picture stop
                        // filling in with no explanation.
                        //
                        // sat_extent_note, not a Kotlin literal: this used to
                        // be hardcoded English because the owner of
                        // strings_satellite.xml hadn't been this track. It now
                        // is, so the note is a real resource in all three
                        // locales (see that file). This is also not a corner
                        // case -- SATELLITE_CANVAS_EXTENT_FT is 400ft and the
                        // grid's own zoom-out button doubles it to 800ft on
                        // the very first press, which already exceeds the
                        // ~776ft (at this job's latitude) the 64-tile budget
                        // can fully cover -- so most sites show this note the
                        // first time anyone zooms satellite out at all.
                        if (satelliteOn) {
                            val lat = job2.siteLat
                            val extent = job2.gridExtentFt
                            if (lat != null &&
                                extent > SurveyViewModel.SATELLITE_CANVAS_EXTENT_FT &&
                                !SurveyViewModel.satelliteCanFullyCover(extent, lat)
                            ) {
                                val reachFt = SurveyViewModel.maxSatelliteExtentFt(lat).toInt()
                                Text(
                                    stringResource(R.string.sat_extent_note, reachFt),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                        DraftNumberField(
                            stableKey = job2.id, label = stringResource(R.string.misc_survey_feet_per_square),
                            initialValue = job2.gridFeetPerSquare,
                            enabled = editable,
                            modifier = Modifier.fillMaxWidth()
                        ) { onSetGridSpacing(it) }
                    }
                } else if (usingGrid) {
                    // The job HAS a survey photo and the grid is the background.
                    // The grid-size and satellite controls are not offered: they
                    // rescale and rewrite the job's scale, and a photo job's scale
                    // is not the grid's to rewrite. The photo is saved either way.
                    Text(
                        fitText(
                            "survey_photo_saved_note",
                            "The survey photo stays saved with this job. Choosing the grid only hides it on this phone."
                        ),
                        style = MaterialTheme.typography.bodyMedium
                    )
                    if (surveyOnThisPhone && !surveyShown) {
                        OutlinedButton(onClick = onShowSurvey, enabled = editable) {
                            Text(fitText("survey_show_photo", "Show survey photo"))
                        }
                    } else {
                        Text(
                            fitText(
                                "survey_photo_not_here",
                                "This phone cannot show the survey photo right now. It is still saved with the job."
                            ),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                } else {
                    Text(stringResource(R.string.misc_survey_drawing_on_photo), style = MaterialTheme.typography.bodyMedium)
                    OutlinedButton(onClick = onUseGrid, enabled = editable) { Text(stringResource(R.string.survey_use_grid)) }
                    Text(
                        fitText(
                            "survey_photo_saved_note",
                            "The survey photo stays saved with this job. Choosing the grid only hides it on this phone."
                        ),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    // Fitting: line the photo up with what is drawn, and carry the
                    // scale with it. Needs a scale to carry; a photo with none is
                    // calibrated (Calibrate mode), never fitted into one.
                    OutlinedButton(onClick = onFitPhoto, enabled = editable && fitAvailable) {
                        Text(fitText("survey_fit_open", "Fit photo to drawing"))
                    }
                    if (fitNeedsScale) {
                        Text(
                            fitText(
                                "survey_fit_needs_scale",
                                "This photo has no scale yet, so there is nothing to carry across. Use Calibrate first."
                            ),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }

                Spacer(Modifier.height(Space.xs))
                Text(
                    stringResource(R.string.misc_survey_layers_show_section),
                    style = MaterialTheme.typography.titleSmall
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = showFenceLayer, onCheckedChange = onShowFenceLayerChange)
                    Text(stringResource(R.string.misc_survey_layers_fence))
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = showGatesLayer, onCheckedChange = onShowGatesLayerChange)
                    Text(stringResource(R.string.misc_survey_layers_gates))
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = showDimensionsLayer, onCheckedChange = onShowDimensionsLayerChange)
                    Text(stringResource(R.string.misc_survey_layers_dimensions))
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = showMarkersLayer, onCheckedChange = onShowMarkersLayerChange)
                    Text(stringResource(R.string.misc_survey_layers_markers))
                }
            }
        },
        confirmButton = {
            Button(onClick = onDismiss) { Text(stringResource(R.string.action_done)) }
        }
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RunSelector(runs: List<FenceRun>, selectedRunId: Long?, onSelect: (Long) -> Unit, modifier: Modifier = Modifier) {
    var expanded by remember { mutableStateOf(false) }
    val selected = runs.firstOrNull { it.id == selectedRunId }
    val untitled = stringResource(R.string.misc_survey_untitled)
    // Once a teardown run is deselected, label and fence type alone don't say
    // which run it was -- "Back Yard (Vinyl)" reads exactly like every other
    // run. This badge is what tells them apart in the picker itself.
    val teardownBadge = stringResource(R.string.draw_run_teardown_badge)
    // @Composable because FenceType.label() is: it reads a string resource, so
    // this cannot be a plain local function.
    @Composable
    fun runLabel(run: FenceRun): String {
        val base = "${run.label.ifBlank { untitled }} (${run.fenceType.label()})"
        return if (run.isTeardown) "$base · $teardownBadge" else base
    }
    ExposedDropdownMenuBox(
        expanded = expanded, onExpandedChange = { expanded = it },
        modifier = modifier.padding(horizontal = Space.sm, vertical = Space.xs)
    ) {
        OutlinedTextField(
            value = selected?.let { runLabel(it) } ?: "",
            onValueChange = {}, readOnly = true,
            label = { Text(stringResource(R.string.draw_editing_run)) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor()
        )
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            runs.forEach { run ->
                DropdownMenuItem(
                    text = { Text(runLabel(run)) },
                    onClick = { onSelect(run.id); expanded = false }
                )
            }
        }
    }
}

@Composable
private fun CalibrationDialog(onConfirm: (Float) -> Unit, onDismiss: () -> Unit) {
    var text by remember { mutableStateOf("") }
    // A65 finding 2, the half the first pass left behind. The Set scale button
    // was still
    //   text.replace(',', '.').toFloatOrNull()?.let(onConfirm)
    // which is the same two-directional wrong the gate dialog above was fixed
    // for: it did NOTHING for "5ft", "5'" or "5 feet" (the let simply did not
    // run, so the dialog sat there and the button looked dead with no reason
    // on screen), and it handed 0, a negative number, "NaN" and "Infinity"
    // straight to [SurveyViewModel.applyCalibration].
    //
    // applyCalibration does refuse all four -- checkPositive before the
    // division, then isUsableCalibration on the quotient -- so nothing bad was
    // ever STORED by this road. What was missing is the half that costs
    // nothing and is the whole point of refusing at the keyboard: saying so
    // while the person is still looking at the number they typed, instead of
    // raising the refusal from a view model two screens of state away. Same
    // evaluation as the gate dialog, same shared sentences, so a measurement
    // typed with its unit on it is described the same way wherever it is typed.
    val entry = SurveyViewModel.readPositiveMeasure(text)
    val refusalText = entry.refusal?.let { stringResource(numberRefusalMessage(it)) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.draw_known_distance)) },
        text = {
            Column {
                Text(stringResource(R.string.draw_distance_question))
                Spacer(Modifier.height(Space.sm))
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    label = { Text(stringResource(R.string.draw_feet)) },
                    // An empty box on first open is not a mistake yet, so the
                    // BLANK refusal is not shouted at somebody who has not
                    // typed anything -- the button is disabled either way.
                    isError = refusalText != null && text.isNotBlank(),
                    // Always supplied, rendering nothing when there is no
                    // refusal, so the dialog does not jump as the message
                    // appears and disappears while they retype. Same reason as
                    // GateWidthDialog's.
                    supportingText = {
                        if (refusalText != null && text.isNotBlank()) {
                            Text(refusalText, color = MaterialTheme.colorScheme.error)
                        }
                    }
                )
            }
        },
        confirmButton = {
            Button(
                enabled = entry.value != null,
                onClick = { entry.value?.let(onConfirm) }
            ) { Text(stringResource(R.string.draw_set_scale)) }
        },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } }
    )
}

@Composable
private fun GateWidthDialog(
    onConfirm: (Float, GateMounting, com.fenceestimator.app.geometry.GateSwing) -> Unit,
    onDismiss: () -> Unit
) {
    var text by remember { mutableStateOf("5") }
    var mounting by remember { mutableStateOf(GateMounting.LINE) }
    var swing by remember { mutableStateOf(com.fenceestimator.app.geometry.GateSwing.IN) }

    // A65 finding 2. The Add button used to be
    //   text.replace(',', '.').toFloatOrNull()?.let { onConfirm(it, ...) }
    // which is wrong in two opposite directions at once:
    //
    //  - It ACCEPTED 0, a negative number, and (because parseFloat's grammar
    //    includes those literals) "NaN", "Infinity" and "-Infinity". All five
    //    went straight into the drawing, and a non-finite or zero gate width
    //    takes the panel, line post, cap and concrete lines off the quote and
    //    nulls the contract total when the office next commits it.
    //  - It silently did NOTHING for "5ft" or 5 with a quote mark after it,
    //    which is how a person actually writes a measurement. The let simply
    //    did not run: the dialog sat there, the button appeared dead, and
    //    nothing said why.
    //
    // Now evaluated on every keystroke so the reason is on screen before the
    // button is pressed, and the button is disabled rather than inert, so
    // "nothing happened" is never the answer.
    val entry = SurveyViewModel.readPositiveMeasure(text)
    val refusalText = entry.refusal?.let { stringResource(numberRefusalMessage(it)) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.draw_gate)) },
        text = {
            Column {
                Text(stringResource(R.string.draw_gate_width_question))
                Spacer(Modifier.height(Space.sm))
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    label = { Text(stringResource(R.string.draw_feet)) },
                    isError = refusalText != null,
                    // Always supplied, rendering nothing when there is no
                    // refusal, rather than a nullable composable lambda: the
                    // slot then reserves its line either way, so the dialog
                    // does not jump as the message appears and disappears
                    // under the person's thumb while they retype.
                    supportingText = {
                        if (refusalText != null) {
                            Text(
                                refusalText + " " + stringResource(R.string.num_gate_width_refused),
                                color = MaterialTheme.colorScheme.error
                            )
                        }
                    }
                )
                Spacer(Modifier.height(Space.lg))

                // Asked here rather than left to the estimate, because it
                // changes what gets loaded on the truck: a wall-hung gate takes
                // a blank post and plugs and no concrete at all.
                Text(stringResource(R.string.draw_gate_hanging), style = MaterialTheme.typography.titleSmall)
                Spacer(Modifier.height(Space.xs))
                GateMountingChoice(selected = mounting, onSelect = { mounting = it })

                Spacer(Modifier.height(Space.lg))
                // Asked while somebody is standing at the opening looking at it.
                // A gate that swings into a slope, a step or where a car parks
                // is a return visit, and this is the detail that gets lost
                // between quoting and installing.
                Text(stringResource(R.string.draw_gate_swing), style = MaterialTheme.typography.titleSmall)
                Spacer(Modifier.height(Space.xs))
                GateSwingChoice(selected = swing, onSelect = { swing = it })
            }
        },
        confirmButton = {
            Button(
                enabled = entry.value != null,
                onClick = { entry.value?.let { onConfirm(it, mounting, swing) } }
            ) { Text(stringResource(R.string.draw_add_gate)) }
        },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } }
    )
}

/**
 * The sentence for each way a typed number can be refused.
 *
 * One mapping, in one place, shared by the gate width dialog, the calibration
 * refusal and RunEditScreen's spec fields, so the same mistake is described
 * the same way wherever it is made. Each reason gets its OWN sentence on
 * purpose: "0" and "" and "5ft" are three different mistakes with three
 * different fixes, and a single "invalid number" leaves a person retyping
 * exactly what they typed the first time.
 */
internal fun numberRefusalMessage(refusal: SurveyViewModel.NumberRefusal): Int = when (refusal) {
    SurveyViewModel.NumberRefusal.BLANK -> R.string.num_blank
    SurveyViewModel.NumberRefusal.NOT_A_NUMBER -> R.string.num_not_a_number
    SurveyViewModel.NumberRefusal.NOT_FINITE -> R.string.num_not_finite
    SurveyViewModel.NumberRefusal.NOT_POSITIVE -> R.string.num_not_positive
}

/**
 * Which way the gate opens, and why it is worth a question.
 *
 * Not cosmetic: it decides which side the hinges go on, and it is what the
 * customer asks about. Getting it wrong is a gate that fouls a slope, a step
 * or a parked car, which is a return visit with a post to reset.
 */
@Composable
private fun GateSwingChoice(
    selected: com.fenceestimator.app.geometry.GateSwing,
    onSelect: (com.fenceestimator.app.geometry.GateSwing) -> Unit
) {
    val options = listOf(
        Triple(
            com.fenceestimator.app.geometry.GateSwing.IN,
            stringResource(R.string.misc_gate_opens_inward),
            stringResource(R.string.misc_gate_opens_inward_detail)
        ),
        Triple(
            com.fenceestimator.app.geometry.GateSwing.OUT,
            stringResource(R.string.misc_gate_opens_outward),
            stringResource(R.string.misc_gate_opens_outward_detail)
        ),
        Triple(
            com.fenceestimator.app.geometry.GateSwing.BOTH,
            stringResource(R.string.misc_gate_opens_both),
            stringResource(R.string.misc_gate_opens_both_detail)
        )
    )
    Column {
        options.forEach { (value, label, detail) ->
            Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = Space.xs),
                verticalAlignment = Alignment.CenterVertically
            ) {
                androidx.compose.material3.RadioButton(
                    selected = selected == value,
                    onClick = { onSelect(value) }
                )
                Column(Modifier.padding(start = Space.xs)) {
                    Text(label, style = MaterialTheme.typography.bodyMedium)
                    Text(
                        detail,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }
}

/** The three builds a gate area can be, with what each one costs you in material. */
@Composable
private fun GateMountingChoice(selected: GateMounting, onSelect: (GateMounting) -> Unit) {
    val options = listOf(
        Triple(GateMounting.LINE, stringResource(R.string.misc_gate_mount_line), stringResource(R.string.misc_gate_mount_line_detail)),
        Triple(GateMounting.LINE_TO_WALL, stringResource(R.string.misc_gate_mount_line_to_wall), stringResource(R.string.misc_gate_mount_line_to_wall_detail)),
        Triple(GateMounting.WALL, stringResource(R.string.misc_gate_mount_wall), stringResource(R.string.misc_gate_mount_wall_detail))
    )
    Column {
        options.forEach { (value, label, detail) ->
            Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = Space.xs),
                verticalAlignment = Alignment.CenterVertically
            ) {
                androidx.compose.material3.RadioButton(
                    selected = selected == value,
                    onClick = { onSelect(value) }
                )
                Column(Modifier.padding(start = Space.xs)) {
                    Text(label, style = MaterialTheme.typography.bodyMedium)
                    Text(
                        detail,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }
}

// Fence, gate and vertex colours used to be named again right here -- a
// leftover "organic" green from before the redesign that clashed and made it
// hard to pick calibration/gate markers out from the drawn line, especially
// zoomed in. They now come from PlanColors (fence/gate/teardown) or straight
// off the theme (the per-vertex-kind dots), so this drawing and the crew's
// read-only copy of the same plan are never one accidental hex digit apart.

/** Alpha applied to another run's line and gates so the one being worked on stands out; 0x66 of 0xFF. */
private const val OTHER_RUN_ALPHA = 0.4f

/** Zoom at which the other sides have reached full strength. */
private const val OTHER_RUN_SOLID_ZOOM = 3f

/**
 * How strongly the sides he is NOT working on are drawn.
 *
 * Faded is right when the whole yard is in view: it is what keeps the side
 * under his finger legible on a crowded plan. It is wrong the moment he zooms
 * in, which he only does to line one side up against another -- and at 0.4
 * alpha the thing he is aiming at is the faintest thing on screen ("on the
 * zoom, I am not able to see the line of the other fence for more accuracy").
 *
 * So the fade lifts with the zoom and is gone by [OTHER_RUN_SOLID_ZOOM]. The
 * selected run stays distinguishable by its own weight and its vertices, not
 * by everything else being washed out.
 */
private fun otherRunAlpha(zoom: Float): Float {
    if (zoom <= 1f) return OTHER_RUN_ALPHA
    if (zoom >= OTHER_RUN_SOLID_ZOOM) return 1f
    val t = (zoom - 1f) / (OTHER_RUN_SOLID_ZOOM - 1f)
    return OTHER_RUN_ALPHA + (1f - OTHER_RUN_ALPHA) * t
}

/**
 * A run that is on the plan but not the one being edited, with its points and
 * gates already decoded -- the fence layer draws both for every such run, and
 * decoding them on every frame the canvas draws would be wasted work.
 */
private data class OtherRunDrawing(
    val run: FenceRun,
    val points: List<FencePoint>,
    val gates: List<GateMarker>
)

/** Screen-space tap tolerance for grabbing a vertex in Adjust mode, independent of zoom level. */
/** How long after a tap a second one still counts as a double tap. */
private const val DOUBLE_TAP_WINDOW_MS = 320L

/** How far apart two taps may be and still be the same spot, in screen pixels. */
private const val DOUBLE_TAP_SLOP_PX = 44f

/**
 * Markers that are a SHAPE on the ground rather than a spot on it.
 *
 * A house, a pool and a driveway have a footprint he can measure and would
 * want drawn to scale. A tree, a slope, an easement, a buried utility or an
 * obstacle is a place -- asking how wide an easement is would be asking a
 * question with no answer, and a form that asks unanswerable questions is a
 * form people stop filling in.
 */
private val BOXABLE_MARKERS = setOf(
    SiteMarkerKind.HOUSE, SiteMarkerKind.POOL, SiteMarkerKind.DRIVEWAY
)

private const val VERTEX_HIT_RADIUS_PX = 40f

/**
 * The snap reach, in screen pixels, turned into drawing units by the live
 * view transform. Smaller than [VERTEX_HIT_RADIUS_PX] on purpose: 40 is the
 * reach of a deliberate tap on a corner, and a snap that fired that far out
 * while drawing would keep dragging points onto corners he was only passing.
 *
 * Returns null when there is no usable scale, which [SurveyViewModel] reads
 * as "use the old fixed reach".
 */
private const val VERTEX_SNAP_SCREEN_PX = 18f

private fun screenVertexReach(scale: Float): Float? =
    if (scale > 0f) VERTEX_SNAP_SCREEN_PX / scale else null

/**
 * How near a segment's midpoint a tap has to land to mean "edit this
 * length". Wider than a vertex's radius because the target is a small label
 * rather than a dot, and because missing it costs nothing: the tap does
 * nothing, where missing a vertex would have dragged it.
 */
private const val SEGMENT_LABEL_HIT_RADIUS_PX = 56f

/** How near a tap has to land to count as hitting a gate, in screen pixels. */
private const val GATE_TAP_SLOP = 48f

private data class FitTransform(val scale: Float, val offsetX: Float, val offsetY: Float) {
    fun toCanvas(p: FencePoint): Offset = Offset(p.x * scale + offsetX, p.y * scale + offsetY)
    fun toImage(p: Offset): FencePoint = FencePoint((p.x - offsetX) / scale, (p.y - offsetY) / scale)
}

private fun fitTransform(contentW: Int, contentH: Int, canvasSize: IntSize): FitTransform {
    if (contentW == 0 || contentH == 0 || canvasSize.width == 0 || canvasSize.height == 0) {
        return FitTransform(1f, 0f, 0f)
    }
    val scale = min(canvasSize.width.toFloat() / contentW, canvasSize.height.toFloat() / contentH)
    val offsetX = (canvasSize.width - contentW * scale) / 2f
    val offsetY = (canvasSize.height - contentH * scale) / 2f
    return FitTransform(scale, offsetX, offsetY)
}

/** The base fit-to-screen transform, further scaled by [zoom] (around the screen center) and shifted by [pan]. */
private fun viewTransform(contentW: Int, contentH: Int, canvasSize: IntSize, zoom: Float, pan: Offset): FitTransform {
    val base = fitTransform(contentW, contentH, canvasSize)
    val scale = base.scale * zoom
    val centerX = canvasSize.width / 2f
    val centerY = canvasSize.height / 2f
    val offsetX = centerX - (centerX - base.offsetX) * zoom + pan.x
    val offsetY = centerY - (centerY - base.offsetY) * zoom + pan.y
    return FitTransform(scale, offsetX, offsetY)
}

/**
 * The view (zoom and pan) that shows a drawing exactly as it was on screen
 * while [fit] was being lined up, once that fit has been applied.
 *
 * Applying a fit puts the photo back at its own origin and carries the drawing
 * instead (see [DrawingFit]), which is the same picture seen through a view
 * that has the fit folded in: a point that was at `p` is now at `(p - t) / f`,
 * and `view(p) == viewAfter((p - t) / f)` exactly when `viewAfter = view after
 * scaling by f and shifting by t`. So the screen does not jump.
 */
private fun viewAfterFit(
    contentW: Int,
    contentH: Int,
    canvasSize: IntSize,
    zoom: Float,
    pan: Offset,
    fit: PhotoFit
): Pair<Float, Offset> {
    val before = viewTransform(contentW, contentH, canvasSize, zoom, pan)
    val base = fitTransform(contentW, contentH, canvasSize)
    val zoomAfter = zoom * fit.scale
    val wantedX = before.offsetX + before.scale * fit.dx
    val wantedY = before.offsetY + before.scale * fit.dy
    val centerX = canvasSize.width / 2f
    val centerY = canvasSize.height / 2f
    return zoomAfter to Offset(
        wantedX - (centerX - (centerX - base.offsetX) * zoomAfter),
        wantedY - (centerY - (centerY - base.offsetY) * zoomAfter)
    )
}

/**
 * Wording for the survey-photo controls: the string resource called [name] if
 * it exists, otherwise [fallback] (English).
 *
 * Looked up by name rather than referenced as `R.string.x`, because a reference
 * to a resource that is not in all three locales fails the whole build, and
 * the strings.xml files these belong in are edited by other work in flight.
 * Until they are added (the names and the three wordings are listed in the
 * hand-over for this change) the controls read in English; once they are,
 * Spanish and French phones pick them up with no further code change. The
 * fallback is a real, complete sentence -- never a key shown to the user.
 *
 * [args] are formatted into whichever text is used, so a resource and its
 * fallback take the same arguments in the same order.
 */
@Composable
private fun fitText(name: String, fallback: String, vararg args: Any): String {
    val context = LocalContext.current
    val id = remember(name) { context.resources.getIdentifier(name, "string", context.packageName) }
    return when {
        id != 0 && args.isEmpty() -> context.getString(id)
        id != 0 -> context.getString(id, *args)
        args.isEmpty() -> fallback
        else -> String.format(fallback, *args)
    }
}

/**
 * The controls shown while a survey photo is being fitted: what to do, what
 * will and will not change, and Cancel / Reset / Apply. A plain Surface, unlike
 * the hints around it, because these ARE meant to take the touch.
 */
@Composable
private fun FitBar(
    hint: String,
    effect: String,
    applyText: String,
    resetText: String,
    cancelText: String,
    applyEnabled: Boolean,
    onApply: () -> Unit,
    onReset: () -> Unit,
    onCancel: () -> Unit
) {
    // The right edge is left clear (end = 64dp): the view-control column floats
    // there, drawn after this, and would sit on top of the Apply button on a
    // narrow phone. The buttons share the width and wrap their words rather than
    // overflowing, because the longer Spanish and French labels do not fit three
    // across at their natural size. Judged on a real screen, not by this code.
    val compact = androidx.compose.foundation.layout.PaddingValues(horizontal = Space.sm)
    Surface(
        modifier = Modifier.padding(top = Space.xs, end = 64.dp).widthIn(max = 300.dp),
        tonalElevation = 4.dp,
        shape = androidx.compose.foundation.shape.RoundedCornerShape(Radius.md)
    ) {
        Column(Modifier.padding(horizontal = Space.md, vertical = Space.sm)) {
            Text(
                hint,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = androidx.compose.ui.text.font.FontWeight.Bold
            )
            Text(
                effect,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(Space.sm))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(Space.xs),
                verticalAlignment = Alignment.CenterVertically
            ) {
                OutlinedButton(onClick = onCancel, modifier = Modifier.weight(1f), contentPadding = compact) {
                    Text(cancelText)
                }
                OutlinedButton(onClick = onReset, enabled = applyEnabled, modifier = Modifier.weight(1f), contentPadding = compact) {
                    Text(resetText)
                }
                Button(onClick = onApply, enabled = applyEnabled, modifier = Modifier.weight(1.3f), contentPadding = compact) {
                    Text(applyText)
                }
            }
        }
    }
}

/**
 * A hard ceiling on gridlines drawn per axis, independent of extent, of
 * gridLineSpacingFt, and of the device this runs on.
 *
 * contentW/contentH are fixed (GRID_CANVAS_SIZE), so the number of lines
 * drawn is contentW / stepUnits. Before D1 that was self-limiting by
 * accident: gridFeetPerSquare is set to extentFt/20 every time the extent
 * changes ([SurveyViewModel.setGridExtent]), so at the CORRECT per-job scale
 * (extentFt/20 feet * 8000/extentFt units/ft = 400 units, always) that ratio
 * already comes out to a constant ~20 lines per axis at any extent -- the
 * "squares stay meaningful" property D1 asks for falls straight out of that
 * arithmetic. But gridLineSpacingFt can also be typed in by hand
 * (setGridLineSpacingFt, floor 0.5ft, no ceiling), and D1 removes the other
 * half of that ceiling too (zoomGridExtent has no top). 0.5ft of spacing on
 * an extent zoomed out several times over would ask this loop for millions
 * of lines and hang the frame -- not a hypothetical once both inputs are
 * genuinely unbounded, so the bound is enforced here directly rather than
 * trusted to stay small by construction.
 */
private const val MAX_GRID_LINES_PER_AXIS = 200

/**
 * The smallest a square of the fit reference grid is allowed to be on screen,
 * in pixels, before the grid steps up to the next round number of feet. Small
 * enough to hold a few squares across a house, and the same 64 that drawGrid
 * needs before it will put a distance label on a line -- so a reference grid
 * is always a labelled one.
 */
private const val FIT_GRID_MIN_SQUARE_PX = 64f

/**
 * Draws the no-photo grid: the background rectangle, then vertical and
 * horizontal lines every [gridLineSpacingFt] feet (every fifth one heavier,
 * matching [PlanColors.gridMajor]'s doc), labelled with their distance from
 * the canvas's own top-left corner once they are far enough apart on screen
 * to hold a label without crowding.
 *
 * [pxPerFt] is the scale THIS job actually measures its drawing at
 * ([SurveyViewModel.drawingScale] / [com.fenceestimator.app.estimate.DrawingScale.of]),
 * which is what turns [gridLineSpacingFt] (real feet) into canvas units here.
 * Before D1 this used the flat, legacy [SurveyViewModel.PIXELS_PER_FOOT_GRID]
 * constant unconditionally -- correct only on the 400ft default, where that
 * constant and the job's real scale are the same number by construction. On
 * every other grid size the two diverge (a 2000ft grid measures at 4
 * units/ft, not 20), so a "100 ft" square was actually drawn 5x too far
 * apart -- wrong on every grid this screen already shipped (1000ft, 2000ft),
 * and exactly backwards for D1, which is asking for MORE grid sizes to be
 * legible, not fewer. [CrewFencePlanScreen]'s read-only copy of this same
 * grid already carries this fix, with the identical reasoning in its own
 * comment; this was this screen's matching half.
 *
 * This is purely cosmetic. Nothing here writes calibrationPixelsPerFoot or a
 * stored point -- [SurveyViewModel.setGridExtent] and the transform used to
 * place a tap are the only things that do that, and neither changes with
 * this fix -- so no existing job's measured footage or price moves. What
 * moves is only which lines get drawn where in the background picture, i.e.
 * whether the square someone is eyeballing a distance against is honestly
 * the size the "feet per square" field claims.
 */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawGrid(
    transform: FitTransform,
    contentW: Int,
    contentH: Int,
    gridLineSpacingFt: Float,
    pxPerFt: Float,
    showLabels: Boolean = true,
    /**
     * Paint the opaque background first. Off only for the reference grid shown
     * over a survey photo while it is being fitted, which has to leave the
     * photo showing through.
     */
    fill: Boolean = true
) {
    if (fill) {
        drawRect(
            PlanColors.canvasBackground,
            topLeft = Offset(transform.offsetX, transform.offsetY),
            size = androidx.compose.ui.geometry.Size(contentW * transform.scale, contentH * transform.scale)
        )
    }
    val safePxPerFt = if (pxPerFt.isFinite() && pxPerFt > 0f) pxPerFt else SurveyViewModel.PIXELS_PER_FOOT_GRID
    val wantedStepUnits = gridLineSpacingFt.coerceAtLeast(0.5f) * safePxPerFt
    val minStepForBudget = contentW / MAX_GRID_LINES_PER_AXIS.toFloat()
    // Only ever WIDENS the gap versus what was asked for, never narrows it --
    // so this can make an extreme combination coarser than gridLineSpacingFt
    // claims, but never draws MORE than what a normal extent already would.
    val stepUnits = if (wantedStepUnits.isFinite() && wantedStepUnits >= minStepForBudget) wantedStepUnits else minStepForBudget
    // Shared with the crew's copy of this grid via PlanColors, so a square
    // means the same thing measured off either screen.
    val minorColor = PlanColors.grid
    val majorColor = PlanColors.gridMajor
    // Below this on-screen gap a label would overlap its neighbour, so it is
    // left off rather than drawn crowded -- the same "too small to hold it"
    // rule the fence-segment length labels below already use.
    val canLabel = showLabels && stepUnits * transform.scale >= 64f
    var lineIndex = 0
    var x = 0f
    while (x <= contentW) {
        val cx = x * transform.scale + transform.offsetX
        val isMajor = lineIndex % 5 == 0
        drawLine(
            if (isMajor) majorColor else minorColor,
            Offset(cx, transform.offsetY), Offset(cx, transform.offsetY + contentH * transform.scale),
            strokeWidth = if (isMajor) 1.5f else 0.75f
        )
        if (isMajor && canLabel && x > 0f) {
            drawGridLabel(x / safePxPerFt, cx + 4f, transform.offsetY + 16f, majorColor)
        }
        x += stepUnits
        lineIndex++
    }
    lineIndex = 0
    var y = 0f
    while (y <= contentH) {
        val cy = y * transform.scale + transform.offsetY
        val isMajor = lineIndex % 5 == 0
        drawLine(
            if (isMajor) majorColor else minorColor,
            Offset(transform.offsetX, cy), Offset(transform.offsetX + contentW * transform.scale, cy),
            strokeWidth = if (isMajor) 1.5f else 0.75f
        )
        if (isMajor && canLabel && y > 0f) {
            drawGridLabel(y / safePxPerFt, transform.offsetX + 4f, cy - 6f, majorColor)
        }
        y += stepUnits
        lineIndex++
    }
}

/**
 * A small distance readout beside a major gridline -- "1,000 ft" -- so a
 * zoomed-out grid reads as a ruler instead of an unlabelled lattice where
 * nobody can tell a square's real size by eye any more. Distance is from the
 * canvas's own fixed top-left corner (content-space origin), the same
 * reference every point, gate and marker on this screen is already stored
 * against -- a ruler mark, not a claim about where any particular fence
 * starts.
 *
 * Never drawn inside [MagnifierLoupe]'s 130dp circle ([showLabels] is false
 * there): there is no room for text at that size, and the loupe's own
 * crosshair already says what it needs to.
 */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawGridLabel(distanceFt: Float, x: Float, y: Float, color: Color) {
    val label = "%,d ft".format(distanceFt.roundToInt())
    val paint = android.graphics.Paint().apply {
        textSize = 22f
        isAntiAlias = true
        this.color = color.toArgb()
    }
    // A light backing so the label stays legible over satellite imagery too,
    // the same reasoning as the segment-length labels below.
    val halfWidth = paint.measureText(label) / 2f
    drawContext.canvas.nativeCanvas.drawRoundRect(
        x - 3f, y - 18f, x + halfWidth * 2f + 3f, y + 4f, 6f, 6f,
        android.graphics.Paint().apply {
            this.color = android.graphics.Color.argb(200, 255, 255, 255)
            isAntiAlias = true
        }
    )
    drawContext.canvas.nativeCanvas.drawText(label, x, y, paint)
}

/**
 * A caption over the drawing area that does not steal touches.
 *
 * Material3's Surface installs a pointer-input handler so clicks cannot fall
 * through to whatever sits behind it. Useful for a card; wrong for a hint
 * floating over the surface someone is drawing on, where it silently ate every
 * tap that landed on it.
 */
@Composable
private fun CanvasHint(
    modifier: Modifier = Modifier,
    text: String,
    /** Defaults to the theme's muted text colour; the snap cue uses success. */
    textColor: Color = Color.Unspecified
) {
    Box(
        modifier
            .padding(Space.sm)
            .background(
                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.9f),
                androidx.compose.foundation.shape.RoundedCornerShape(Radius.sm)
            )
            .padding(horizontal = Space.md, vertical = Space.sm)
    ) {
        Text(
            text,
            style = MaterialTheme.typography.bodySmall,
            color = if (textColor != Color.Unspecified) textColor else MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

/**
 * Arrow pad for moving the selected point one foot at a time.
 *
 * Dragging is fine for roughing a line in, but a fingertip covers the very
 * point it is moving, so the last few inches are guesswork. The arrows move a
 * known distance you can watch happen, which is what makes a drawing accurate
 * enough to order material from.
 */
@Composable
private fun NudgePad(
    modifier: Modifier = Modifier,
    onNudge: (Float, Float) -> Unit,
    onDone: () -> Unit
) {
    Surface(
        modifier = modifier.padding(Space.sm),
        tonalElevation = 6.dp,
        shape = androidx.compose.foundation.shape.RoundedCornerShape(Radius.md)
    ) {
        Column(
            Modifier.padding(Space.sm),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                stringResource(R.string.misc_nudge_per_tap),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            IconButton(onClick = { onNudge(0f, -1f) }) {
                Icon(Icons.Filled.KeyboardArrowUp, contentDescription = stringResource(R.string.misc_nudge_up))
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { onNudge(-1f, 0f) }) {
                    Icon(Icons.Filled.KeyboardArrowLeft, contentDescription = stringResource(R.string.misc_nudge_left))
                }
                IconButton(onClick = onDone) {
                    Icon(Icons.Filled.Check, contentDescription = stringResource(R.string.action_done))
                }
                IconButton(onClick = { onNudge(1f, 0f) }) {
                    Icon(Icons.Filled.KeyboardArrowRight, contentDescription = stringResource(R.string.misc_nudge_right))
                }
            }
            IconButton(onClick = { onNudge(0f, 1f) }) {
                Icon(Icons.Filled.KeyboardArrowDown, contentDescription = stringResource(R.string.misc_nudge_down))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Satellite background
//
// The office can trace a fence over satellite imagery on the dashboard
// (website/dashboard.html, openSatellite/satWorld/satUnworld/satFeetPerPx);
// this section is the phone's equivalent background renderer. It draws INTO
// the exact same survey-pixel content space every other background already
// uses (bitmap photo, or the no-photo grid) so every gesture, every drawn
// point, gate and marker, and every other run's faded line above keeps
// working completely unchanged -- satellite only ever changes what gets
// painted behind them.
// ---------------------------------------------------------------------------

/**
 * The zoom satellite imagery is always FETCHED at. Fixed, not the same thing
 * as viewZoom (the on-screen pinch/+-/- zoom, which scales FitTransform and
 * is free to change at any time): if this changed too, every already-placed
 * point would need to be re-projected or it would drift relative to the
 * ground under it. 20 is also the office's own starting zoom (SAT.z = 20 in
 * openSatellite()).
 *
 * This does NOT mean satellite is pinned to one canvas scale any more --
 * see [SatelliteAnchor]. Not private: [SurveyViewModel.satelliteTilesNeeded]
 * needs the same zoom to answer "how far can satellite actually see here",
 * and duplicating the number would let the two silently drift apart.
 */
const val SATELLITE_TILE_Z = 20

/**
 * A hard ceiling on tiles fetched for one view -- an extreme zoom-out on a
 * slow connection must not queue hundreds of downloads at once.
 *
 * D1's other half (zooming satellite past its 400ft default, not just the
 * grid) turns this from "a safety valve that never mattered" into the ACTUAL
 * limit on how far satellite can see: [SurveyViewModel.satelliteTilesNeeded]
 * counts how many z=[SATELLITE_TILE_Z] tiles an extent needs and compares it
 * to this same number, so the two can never disagree about where satellite
 * imagery runs out. Not private for that reason.
 */
const val MAX_SATELLITE_TILES = 64

private fun satelliteTileKey(x: Int, y: Int) = "$SATELLITE_TILE_Z/$x/$y"

/**
 * Fixes the satellite imagery to the app's own survey-pixel canvas.
 *
 * The content-space center (GRID_CANVAS_SIZE/2, GRID_CANVAS_SIZE/2) is
 * pinned to the job's own site latitude/longitude; from there, converting
 * between a Web Mercator pixel (what SatelliteMath and the tile grid speak)
 * and a survey pixel (what every point, gate and marker on this screen is
 * stored in) is one scale factor: how many survey pixels one Web Mercator
 * pixel covers at this latitude and zoom. That is exactly
 * SatelliteMath.feetPerPx(lat, z) * [unitsPerFoot] -- the same arithmetic
 * satPointsToRunSpace in website/dashboard.html does when it converts a
 * traced lat/lon point into the run's own pixel space, except THIS scale is
 * now the job's own current drawing scale rather than always the flat 20.
 *
 * D1 (grid): this used to hardcode SurveyViewModel.PIXELS_PER_FOOT_GRID (20)
 * here unconditionally -- correct only when the job's grid happened to be at
 * exactly the 400ft SATELLITE_CANVAS_EXTENT_FT default, because
 * GRID_CANVAS_SIZE/400 == PIXELS_PER_FOOT_GRID by construction (see the doc
 * on SurveyViewModel.SATELLITE_CANVAS_EXTENT_FT). The grid's own "unlimited
 * zoom" (SurveyViewModel.zoomGridExtent) reaches its +/- buttons and chips
 * whether or not satellite happens to be the active background -- nothing
 * on this screen ever disabled them for satellite -- so as soon as someone
 * pressed "+" or picked a chip while looking at satellite, [setGridExtent]
 * correctly rescaled every drawn point to keep its real length (that part
 * was never wrong) while the OLD fixed-20 anchor kept drawing the imagery
 * at the 400ft scale regardless. The picture never visibly moved -- the
 * exact "control that appears to work but doesn't" shape -- and, worse, the
 * fence line silently stopped lining up with the ground under it, because
 * the canvas the points now lived in no longer matched the canvas the
 * imagery was drawn into. Passing this job's real [unitsPerFoot] instead
 * closes both: the imagery now visibly follows the SAME zoom the grid
 * already had unlimited, and it can never again drift out of registration
 * with what is actually drawn, because both read the one scale
 * ([SurveyViewModel.drawingScale]) that setGridExtent is the only writer of.
 *
 * What this does NOT change: satellite tiles are still fetched at the fixed
 * [SATELLITE_TILE_Z]=20 -- each tile still covers the same, fixed amount of
 * real ground (a fact of the Web Mercator projection and latitude, not of
 * this app's canvas). Zooming the grid out just means each of those
 * fixed-size tiles now covers FEWER survey pixels, so more of them are
 * needed to fill the same view -- which is exactly "zooming out" and costs
 * nothing extra in code, but is bounded by [MAX_SATELLITE_TILES]: see
 * [SurveyViewModel.satelliteTilesNeeded] and [SurveyViewModel.maxSatelliteExtentFt]
 * for where that bound actually bites, and the note shown in [LayersDialog]
 * for how a person is told about it rather than left with a silently
 * cropped picture.
 */
private class SatelliteAnchor(lat: Double, lon: Double, unitsPerFoot: Float) {
    private val centerWorld = SatelliteMath.world(lat, lon, SATELLITE_TILE_Z)
    private val surveyPxPerWorldPx =
        SatelliteMath.feetPerPx(lat, SATELLITE_TILE_Z) * unitsPerFoot
    private val centerContent = SurveyViewModel.GRID_CANVAS_SIZE / 2.0

    /** A Web Mercator pixel coordinate (e.g. a tile corner) -> survey-pixel content space. */
    fun worldToContent(wx: Double, wy: Double): Offset = Offset(
        (centerContent + (wx - centerWorld.x) * surveyPxPerWorldPx).toFloat(),
        (centerContent + (wy - centerWorld.y) * surveyPxPerWorldPx).toFloat()
    )

    /** The inverse of [worldToContent]. Returns a plain Pair -- Compose's Offset is Float-only and this needs Double precision. */
    fun contentToWorld(cx: Double, cy: Double): Pair<Double, Double> = Pair(
        centerWorld.x + (cx - centerContent) / surveyPxPerWorldPx,
        centerWorld.y + (cy - centerContent) / surveyPxPerWorldPx
    )

    /** Side length, in survey-space pixels, of one 256x256 imagery tile. Always square: the scale above is isotropic. */
    fun tileContentSpan(): Double = 256.0 * surveyPxPerWorldPx
}

/** Which z=20 imagery tiles are needed to cover what [transform] currently shows, clamped to the valid tile grid. */
private fun visibleSatelliteTiles(anchor: SatelliteAnchor, transform: FitTransform, canvasSize: IntSize): List<Pair<Int, Int>> {
    if (canvasSize.width <= 0 || canvasSize.height <= 0) return emptyList()
    val topLeft = transform.toImage(Offset(0f, 0f))
    val bottomRight = transform.toImage(Offset(canvasSize.width.toFloat(), canvasSize.height.toFloat()))
    val (wx0, wy0) = anchor.contentToWorld(topLeft.x.toDouble(), topLeft.y.toDouble())
    val (wx1, wy1) = anchor.contentToWorld(bottomRight.x.toDouble(), bottomRight.y.toDouble())
    val maxIndex = (1 shl SATELLITE_TILE_Z) - 1
    val tx0 = Math.floor(min(wx0, wx1) / 256.0).toInt().coerceIn(0, maxIndex)
    val tx1 = Math.floor(max(wx0, wx1) / 256.0).toInt().coerceIn(0, maxIndex)
    val ty0 = Math.floor(min(wy0, wy1) / 256.0).toInt().coerceIn(0, maxIndex)
    val ty1 = Math.floor(max(wy0, wy1) / 256.0).toInt().coerceIn(0, maxIndex)
    val tiles = mutableListOf<Pair<Int, Int>>()
    for (tx in tx0..tx1) {
        for (ty in ty0..ty1) {
            tiles += tx to ty
            if (tiles.size >= MAX_SATELLITE_TILES) return tiles
        }
    }
    return tiles
}

/**
 * The one place any background (photo, no-photo grid, or satellite) gets
 * drawn -- used by both the main canvas and [MagnifierLoupe], so the loupe
 * is provably showing the same picture at a tighter zoom rather than a
 * separate rendering of anything.
 *
 * The grid is always drawn first when there is no photo, satellite tiles
 * layered on top of it rather than instead of it: a tile that hasn't loaded
 * yet (or a phone with no signal at all -- satelliteTiles is simply never
 * populated when offline, see the fetch effect in SurveyDrawScreen) leaves
 * the grid showing through instead of a blank void, which is what "offline
 * shows the grid as today" means in practice.
 */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawSurveyBackground(
    bmp: Bitmap?,
    transform: FitTransform,
    contentW: Int,
    contentH: Int,
    gridFeetPerSquare: Float,
    pxPerFt: Float,
    satelliteOn: Boolean,
    satelliteAnchor: SatelliteAnchor?,
    satelliteTiles: Map<String, Bitmap>,
    showGridLabels: Boolean = true
) {
    if (bmp != null) {
        drawImage(
            image = bmp.asImageBitmap(),
            dstOffset = androidx.compose.ui.unit.IntOffset(transform.offsetX.toInt(), transform.offsetY.toInt()),
            dstSize = IntSize((bmp.width * transform.scale).toInt(), (bmp.height * transform.scale).toInt())
        )
        return
    }
    drawGrid(transform, contentW, contentH, gridFeetPerSquare, pxPerFt, showGridLabels)
    if (satelliteOn && satelliteAnchor != null) {
        val viewport = IntSize(size.width.toInt(), size.height.toInt())
        visibleSatelliteTiles(satelliteAnchor, transform, viewport).forEach { (tx, ty) ->
            val tileBmp = satelliteTiles[satelliteTileKey(tx, ty)] ?: return@forEach
            val topLeftContent = satelliteAnchor.worldToContent(tx * 256.0, ty * 256.0)
            val topLeftScreen = transform.toCanvas(FencePoint(topLeftContent.x, topLeftContent.y))
            val span = (satelliteAnchor.tileContentSpan() * transform.scale).toInt().coerceAtLeast(1)
            drawImage(
                image = tileBmp.asImageBitmap(),
                dstOffset = androidx.compose.ui.unit.IntOffset(topLeftScreen.x.toInt(), topLeftScreen.y.toInt()),
                dstSize = IntSize(span, span)
            )
        }
    }
}

/** How large the loupe circle is drawn on screen. */
private val LOUPE_SIZE_DP = 130.dp

/** How much closer than the current view the loupe zooms in. */
private const val LOUPE_ZOOM_FACTOR = 3f

/** Gap, in raw pixels, between the top of the loupe and the finger it hovers above. */
private const val LOUPE_VERTICAL_GAP_PX = 28f

/**
 * A magnified, crosshair-marked preview of the ground directly under a
 * dragging finger.
 *
 * A fingertip covers the exact pixel it is placing, which is guesswork on
 * any background but is worst on satellite imagery -- a photo or the grid
 * both carry other cues nearby (a printed dimension, a gridline count), a
 * satellite tile often has nothing but open ground. Positioned above the
 * touch point (see where this is placed in SurveyDrawScreen) so the finger
 * never covers what it is showing, and it is not a separate rendering of
 * anything -- [drawSurveyBackground] is the same function the main canvas
 * uses, just handed a tighter, differently-centered transform, which is what
 * makes it trustworthy: what lines up here is what lines up on the real
 * drawing.
 */
@Composable
private fun MagnifierLoupe(
    centerContent: FencePoint,
    bmp: Bitmap?,
    contentW: Int,
    contentH: Int,
    gridFeetPerSquare: Float,
    pxPerFt: Float,
    satelliteOn: Boolean,
    satelliteAnchor: SatelliteAnchor?,
    satelliteTiles: Map<String, Bitmap>,
    baseScale: Float,
    segmentFeet: List<Float>,
    /** Every run on the job, so the loupe shows what he is aiming AT. */
    runs: List<FenceRun>,
    activeRunId: Long,
) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier
                .size(LOUPE_SIZE_DP)
                .clip(androidx.compose.foundation.shape.CircleShape)
                .background(PlanColors.canvasBackground)
                .border(2.dp, MaterialTheme.colorScheme.primary, androidx.compose.foundation.shape.CircleShape)
        ) {
            Canvas(Modifier.fillMaxSize()) {
                val scale = baseScale * LOUPE_ZOOM_FACTOR
                val localTransform = FitTransform(
                    scale = scale,
                    offsetX = size.width / 2f - centerContent.x * scale,
                    offsetY = size.height / 2f - centerContent.y * scale
                )
                drawSurveyBackground(
                    bmp, localTransform, contentW, contentH, gridFeetPerSquare, pxPerFt,
                    satelliteOn, satelliteAnchor, satelliteTiles,
                    // No room for a distance label in a 130dp circle -- see
                    // drawGridLabel's doc.
                    showGridLabels = false
                )
                // THE FENCE ITSELF.
                //
                // "When I use the adjust one I don't see the fence in the zoom
                // so I can know where to drop it."
                //
                // The loupe drew the photo, the grid and a crosshair, and
                // stopped -- so the one thing he was aiming AT was the one
                // thing missing. A magnified aerial photo with a crosshair on
                // it tells you where your finger is and nothing about where the
                // line wants to go.
                //
                // Drawn UNDER the crosshair, so the point being dragged stays
                // the thing you can see. The active run reads solid and the
                // others faint, the same way the main canvas separates them, so
                // the loupe does not invent a second visual language for the
                // same drawing.
                for (r in runs) {
                    val pts = FenceCodec.decodePoints(r.pointsEncoded)
                    if (pts.size < 2) continue
                    val isActive = r.id == activeRunId
                    val colour = if (r.isTeardown) PlanColors.teardownLine else PlanColors.fenceLine
                    for (i in 1 until pts.size) {
                        drawLine(
                            color = if (isActive) colour else colour.copy(alpha = 0.35f),
                            start = localTransform.toCanvas(pts[i - 1]),
                            end = localTransform.toCanvas(pts[i]),
                            strokeWidth = if (isActive) 4f else 2.5f,
                        )
                    }
                    // The corners, so he can see what he is landing ON -- the
                    // commonest reason to be in Adjust at all is putting a
                    // corner back where the tape says it is.
                    if (isActive) {
                        for (pt in pts) {
                            drawCircle(colour, radius = 5f, center = localTransform.toCanvas(pt))
                        }
                    }
                }

                // A crosshair at the loupe's exact centre -- always the point
                // being dragged, by construction of localTransform above.
                val c = Offset(size.width / 2f, size.height / 2f)
                drawLine(SafetyOrange40, Offset(c.x - 16f, c.y), Offset(c.x + 16f, c.y), strokeWidth = 2.5f)
                drawLine(SafetyOrange40, Offset(c.x, c.y - 16f), Offset(c.x, c.y + 16f), strokeWidth = 2.5f)
                drawCircle(Color.White, radius = 4f, center = c, style = androidx.compose.ui.graphics.drawscope.Stroke(width = 1.5f))
            }
        }
        // Live length of whichever segment(s) touch the point being dragged --
        // a corner shared by two segments shows both, since moving it changes
        // both. Empty (nothing shown) while dragging a gate or a marker,
        // neither of which is part of the fence line.
        if (segmentFeet.isNotEmpty()) {
            // Resolved once here (a @Composable context) rather than inside
            // the joinToString transform below, which runs as a plain
            // non-Composable lambda and cannot call stringResource itself.
            val feetTemplate = stringResource(R.string.misc_feet_value)
            Surface(
                tonalElevation = 4.dp,
                shape = androidx.compose.foundation.shape.RoundedCornerShape(Radius.sm),
                modifier = Modifier.padding(top = Space.xs)
            ) {
                Text(
                    segmentFeet.joinToString(" / ") { String.format(feetTemplate, String.format("%.1f", it)) },
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = Space.sm, vertical = 2.dp)
                )
            }
        }
    }
}

/**
 * Type the measurement the tape actually gave.
 *
 * Opens already holding the segment's current length, selected, so the
 * common case is: tap the dimension, type the real number, done. The field
 * takes feet and inches in whatever form comes out of a person's head --
 * `47' 6"`, `47 6`, `47.5` -- because a drawing tool that only accepts one
 * punctuation is a drawing tool that makes its user do arithmetic first.
 *
 * The hint is a worked example rather than an instruction. Nobody reads
 * "enter a length in decimal feet"; everybody understands `47' 6"`.
 */
@Composable
private fun SegmentLengthDialog(
    currentFeet: Float,
    /**
     * The side that closes a loop moves differently -- its last corner slides
     * and the side before it gives -- so the dialog says so rather than
     * promising the rest of the run keeps its shape.
     */
    closingSide: Boolean = false,
    onConfirm: (Float) -> Unit,
    onDismiss: () -> Unit,
) {
    var text by remember { mutableStateOf(FeetInches.format(currentFeet)) }
    val parsed = FeetInches.parse(text)
    // Refused rather than guessed at: a length the parser could not read
    // must not become a silent zero in the middle of somebody's fence.
    val valid = parsed != null && parsed > 0f

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.seg_len_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                Text(
                    stringResource(R.string.seg_len_current, FeetInches.format(currentFeet)),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    singleLine = true,
                    isError = text.isNotBlank() && !valid,
                    label = { Text(stringResource(R.string.seg_len_label)) },
                    supportingText = {
                        Text(
                            if (text.isNotBlank() && !valid) stringResource(R.string.seg_len_unreadable)
                            else stringResource(R.string.seg_len_hint)
                        )
                    }
                )
                Text(
                    stringResource(
                        if (closingSide) R.string.seg_len_explains_closing else R.string.seg_len_explains
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        },
        confirmButton = {
            Button(enabled = valid, onClick = { parsed?.let(onConfirm) }) {
                Text(stringResource(R.string.action_save))
            }
        },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } }
    )
}

/**
 * What just happened to a point, in a few words.
 *
 * A point that jumps under the finger with no explanation reads as the app
 * misbehaving. The same jump with "90° locked" beside it reads as the tool
 * doing its job, and it also teaches the feature: nobody reads the manual,
 * but everybody reads the line that appeared when the thing moved.
 */
@Composable
private fun snapWords(result: com.fenceestimator.app.geometry.SnapResult): String {
    // Said relative to what the person was aiming at -- "square to the last
    // side", not "120° locked", which is a bearing nobody on site thinks in.
    // The bare bearing is kept only as a fallback for a lock with no cue.
    val angle = when (val cue = result.angleCue()) {
        com.fenceestimator.app.geometry.AngleCue.StraightOn -> stringResource(R.string.snap_turn_straight)
        com.fenceestimator.app.geometry.AngleCue.Square -> stringResource(R.string.snap_turn_square)
        is com.fenceestimator.app.geometry.AngleCue.Turn -> stringResource(R.string.snap_turn_deg, cue.degrees)
        com.fenceestimator.app.geometry.AngleCue.MapHorizontal -> stringResource(R.string.snap_map_horizontal)
        com.fenceestimator.app.geometry.AngleCue.MapVertical -> stringResource(R.string.snap_map_vertical)
        com.fenceestimator.app.geometry.AngleCue.MapDiagonal -> stringResource(R.string.snap_map_diagonal)
        null -> result.lockedAngleDeg?.let { stringResource(R.string.snap_angle, it.roundToInt()) }
    }
    val length = result.lengthFt?.let {
        stringResource(R.string.snap_length, FeetInches.formatCompact(it))
    }
    return when (result.kind) {
        com.fenceestimator.app.geometry.SnapKind.VERTEX -> stringResource(R.string.snap_joined)
        com.fenceestimator.app.geometry.SnapKind.ANGLE -> angle.orEmpty()
        com.fenceestimator.app.geometry.SnapKind.LENGTH -> length.orEmpty()
        com.fenceestimator.app.geometry.SnapKind.ANGLE_AND_LENGTH ->
            stringResource(R.string.snap_both, angle.orEmpty(), length.orEmpty())
        com.fenceestimator.app.geometry.SnapKind.NONE -> ""
    }
}
