package com.fenceestimator.app.ui.survey

import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitEachGesture
import com.fenceestimator.app.R
import com.fenceestimator.app.geometry.GateGeometry
import androidx.compose.material3.FilterChip
import android.graphics.Bitmap
import android.graphics.BitmapFactory
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.CloseFullscreen
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowLeft
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.OpenInFull
import androidx.compose.material.icons.filled.MyLocation
import androidx.compose.material.icons.filled.OpenWith
import androidx.compose.material.icons.filled.PanTool
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
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
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
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FenceGeometryEngine
import com.fenceestimator.app.geometry.FencePoint
import com.fenceestimator.app.geometry.GateMounting
import com.fenceestimator.app.geometry.VertexKind
import com.fenceestimator.app.ui.components.DraftNumberField
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp
import com.fenceestimator.app.ui.components.label
import com.fenceestimator.app.ui.theme.Graphite40
import com.fenceestimator.app.ui.theme.PlanColors
import com.fenceestimator.app.ui.theme.Radius
import com.fenceestimator.app.ui.theme.SafetyOrange40
import com.fenceestimator.app.ui.theme.Space
import com.fenceestimator.app.ui.theme.SteelTeal20
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.max
import kotlin.math.min

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SurveyDrawScreen(jobId: Long, onBack: () -> Unit, onGoToEstimate: (Long) -> Unit) {
    val app = currentApp()
    val viewModel: SurveyViewModel = viewModel(
        key = "survey_$jobId",
        factory = GenericViewModelFactory { SurveyViewModel(app.repository, jobId, app) }
    )
    // Attribute edits so the office knows who changed the plan and when. Only
    // for people working under someone -- an owner editing their own drawing
    // has nobody to report to, and logging that would be noise.
    val session by app.session.state.collectAsState()
    LaunchedEffect(session.role, session.email) {
        val reportsToSomeone = session.role in setOf(
            com.fenceestimator.app.cloud.UserRole.CREW,
            com.fenceestimator.app.cloud.UserRole.FOREMAN
        )
        viewModel.editorName = if (reportsToSomeone) session.email ?: "Crew" else null
        viewModel.editorRole = session.role.label
    }

    val job by viewModel.job.collectAsState()
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
    var viewZoom by remember(selectedRunId) { mutableStateOf(1f) }
    var viewPan by remember(selectedRunId) { mutableStateOf(Offset.Zero) }

    var fullScreenDrawing by rememberSaveable { mutableStateOf(false) }
    var calibrationDialogPoints by remember { mutableStateOf<Pair<FencePoint, FencePoint>?>(null) }
    var gateDialogPoint by remember { mutableStateOf<FencePoint?>(null) }
    var markerDialogPoint by remember { mutableStateOf<FencePoint?>(null) }
    val siteMarkers by viewModel.siteMarkers.collectAsState()

    val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) viewModel.importImage(context, uri)
    }

    LaunchedEffect(job?.surveyImagePath) {
        val path = job?.surveyImagePath
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
            is SurveyViewModel.SiteLocationResult.Ready -> viewModel.ensureSatelliteCalibration()
            is SurveyViewModel.SiteLocationResult.Failed -> {
                satelliteError = result.message
                satelliteOn = false
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.draw_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back)) }
                }
            )
        }
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            // Persistent, not a snackbar that scrolls away: the drawing itself
            // looks perfectly fine while this is true, so the only way anyone
            // finds out materials and price stopped following it is if the
            // warning stays on screen until the estimate is reopened.
            if (repriceFailed) {
                RepriceFailedBanner()
            }
            if (runs.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(stringResource(R.string.draw_add_run_first), modifier = Modifier.padding(Space.xl))
                }
                return@Column
            }

            // Full screen hides everything that isn't the drawing. On a phone
            // the chrome above and below eats more than half the height, which
            // is the difference between seeing a whole property and a third of
            // it. The mode buttons stay -- you still have to switch tools.
            if (!fullScreenDrawing) {
                RunSelector(runs = runs, selectedRunId = selectedRunId, onSelect = { viewModel.selectRun(it) })

                Row(modifier = Modifier.fillMaxWidth().padding(horizontal = Space.sm), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        stringResource(
                            when {
                                usingGrid && satelliteOn -> R.string.misc_survey_drawing_on_satellite
                                usingGrid -> R.string.misc_survey_drawing_on_grid
                                else -> R.string.misc_survey_drawing_on_photo
                            }
                        ),
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalAlignment = Alignment.CenterVertically) {
                        // Only offered instead of the grid, never alongside an
                        // uploaded photo -- the office's calibration rule is
                        // "only when there is no survey photo", and offering
                        // this button when a photo already exists would invite
                        // exactly the case that rule excludes.
                        if (usingGrid) {
                            FilterChip(
                                selected = satelliteOn,
                                onClick = { satelliteOn = !satelliteOn },
                                label = { Text(stringResource(R.string.sat_toggle_label)) }
                            )
                        }
                        OutlinedButton(onClick = {
                            if (usingGrid) {
                                imagePicker.launch(androidx.activity.result.PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                            } else {
                                viewModel.clearSurveyImage()
                            }
                        }) {
                            Text(stringResource(if (usingGrid) R.string.survey_upload_photo else R.string.survey_use_grid))
                        }
                    }
                }
                satelliteError?.let { message ->
                    Text(
                        message,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(horizontal = Space.sm)
                    )
                }
                // Offline with nothing cached yet: the grid still draws (it
                // always does, as the base layer -- see drawSurveyBackground)
                // so tracing is never actually blocked, but silently showing
                // the grid instead of the imagery someone asked for would look
                // like the toggle did nothing.
                if (satelliteOn && !online) {
                    Text(
                        stringResource(R.string.sat_offline_note),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = Space.sm)
                    )
                }

                if (usingGrid) {
                    val job2 = job
                    if (job2 != null) {
                        // How much ground the grid covers.
                        //
                        // A gate and a paddock are not the same drawing
                        // problem. Fixed at 400ft, one foot was about two and a
                        // half pixels on a phone, so a 20ft run could not be
                        // drawn accurately and a small drag measured forty feet.
                        Text(
                            stringResource(R.string.misc_survey_how_big),
                            style = MaterialTheme.typography.labelLarge,
                            modifier = Modifier.padding(horizontal = Space.sm, vertical = Space.xs)
                        )
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(horizontal = Space.sm),
                            horizontalArrangement = Arrangement.spacedBy(Space.sm)
                        ) {
                            SurveyViewModel.GRID_SIZES_FT.forEach { size ->
                                val selected = kotlin.math.abs(job2.gridExtentFt - size) < 0.5f
                                FilterChip(
                                    selected = selected,
                                    onClick = { viewModel.setGridExtent(size) },
                                    label = { Text(stringResource(R.string.draw_grid_size_ft, size.toInt())) },
                                    modifier = Modifier.weight(1f)
                                )
                            }
                        }
                        Text(
                            stringResource(R.string.misc_survey_keeps_length),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = Space.sm)
                        )
                        DraftNumberField(
                            stableKey = job2.id, label = stringResource(R.string.misc_survey_feet_per_square),
                            initialValue = job2.gridFeetPerSquare,
                            modifier = Modifier.fillMaxWidth().padding(horizontal = Space.sm)
                        ) { viewModel.setGridLineSpacingFt(it) }
                    }
                }
            }

            val visibleModes = remember(usingGrid) {
                buildList {
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
                    add(SurveyMode.PAN to R.string.mode_move_view)
                }
            }
            // Leaving Calibrate selected while switching to the grid would strand
            // the canvas in a mode with no button to leave it by.
            LaunchedEffect(usingGrid) {
                if (usingGrid && mode == SurveyMode.CALIBRATE) viewModel.setMode(SurveyMode.DRAW)
            }
            SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth().padding(Space.sm)) {
                visibleModes.forEachIndexed { index, (m, label) ->
                    SegmentedButton(
                        selected = mode == m,
                        onClick = { viewModel.setMode(m) },
                        shape = SegmentedButtonDefaults.itemShape(index, visibleModes.size)
                    ) { Text(stringResource(label)) }
                }
            }
            if (mode == SurveyMode.ADJUST) {
                Text(
                    stringResource(R.string.misc_survey_adjust_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = Space.sm)
                )
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
                val pxPerFt = job2.calibrationPixelsPerFoot

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

                // Running total ABOVE the drawing area, not on top of it. Put on
                // the canvas it covered part of the very surface you tap to draw,
                // and swallowed those taps.
                val liveFeet = if (points.size >= 2) {
                    FenceGeometryEngine.analyze(
                        points,
                        pxPerFt ?: SurveyViewModel.PIXELS_PER_FOOT_GRID,
                        activeRun.closedLoop
                    ).totalLinearFeet
                } else 0f
                Surface(tonalElevation = 3.dp, modifier = Modifier.fillMaxWidth()) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = Space.md, vertical = Space.sm),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(Icons.Filled.Straighten, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                        Text(
                            if (liveFeet > 0f) "  " + stringResource(R.string.misc_feet_value, String.format("%.1f", liveFeet))
                            else "  " + stringResource(R.string.misc_survey_tap_to_start),
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = androidx.compose.ui.text.font.FontWeight.Bold
                        )
                        if (liveFeet > 0f) {
                            Text(
                                "   " + stringResource(R.string.misc_survey_points_gates, points.size, gates.size),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.weight(1f)
                            )
                        } else {
                            Spacer(Modifier.weight(1f))
                        }
                        // Full screen hides everything but the drawing, which on
                        // a phone is the difference between seeing the whole
                        // property and seeing a third of it.
                        IconButton(onClick = { fullScreenDrawing = !fullScreenDrawing }) {
                            Icon(
                                if (fullScreenDrawing) Icons.Filled.CloseFullscreen else Icons.Filled.OpenInFull,
                                contentDescription = stringResource(if (fullScreenDrawing) R.string.misc_survey_exit_full_screen else R.string.misc_survey_full_screen)
                            )
                        }
                    }
                }
                val otherRuns = runs.filter { it.id != activeRun.id }
                val canvasContentSize = bitmap?.let { it.width to it.height }
                    ?: (SurveyViewModel.GRID_CANVAS_SIZE to SurveyViewModel.GRID_CANVAS_SIZE)

                // Fixes the imagery to the app's own survey-pixel canvas: the
                // content-space center is the job's site_lat/site_lon, at a
                // zoom pinned to 20 (SATELLITE_TILE_Z) so it always agrees
                // with the 20 px/ft calibration ensureSatelliteCalibration()
                // sets. Recomputed only when the coordinates actually change,
                // never when the user merely pans or zooms the SCREEN view --
                // that is viewZoom/viewPan/FitTransform's job, layered on top.
                val satelliteAnchor = remember(job2.siteLat, job2.siteLon) {
                    val lat = job2.siteLat; val lon = job2.siteLon
                    if (lat != null && lon != null) SatelliteAnchor(lat, lon) else null
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
                                        if (event.changes.size >= 2) {
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
                            .pointerInput(mode, committedPoints, bmp, activeRun.id, usingGrid, gates, siteMarkers) {
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

                                        detectDragGestures(
                                            onDragStart = { startOffset ->
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
                                                if (finalPoint != null) {
                                                    when {
                                                        idx != null -> viewModel.movePoint(idx, finalPoint)
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
                                            SurveyMode.DRAW -> viewModel.addDrawPoint(imgPoint)
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
                                            else -> {}
                                        }
                                    }
                                }
                            }
                    ) {
                        val transform = viewTransform(canvasContentSize.first, canvasContentSize.second, IntSize(size.width.toInt(), size.height.toInt()), viewZoom, viewPan)

                        drawSurveyBackground(
                            bmp, transform, canvasContentSize.first, canvasContentSize.second,
                            job2.gridFeetPerSquare, satelliteOn, satelliteAnchor, satelliteTiles
                        )

                        otherRuns.forEach { other ->
                            val otherPoints = FenceCodec.decodePoints(other.pointsEncoded)
                            if (otherPoints.size >= 2) {
                                // Faded because it isn't the run being worked on
                                // right now, not because it means anything
                                // different -- teardown vs. build still has to
                                // read correctly at a glance even dimmed.
                                val otherColor = (if (other.isTeardown) PlanColors.teardownLine else PlanColors.fenceLine)
                                    .copy(alpha = OTHER_RUN_ALPHA)
                                val canvasPts = otherPoints.map { transform.toCanvas(it) }
                                val segCount = if (other.closedLoop) otherPoints.size else otherPoints.size - 1
                                for (i in 0 until max(0, segCount)) {
                                    drawLine(otherColor, canvasPts[i], canvasPts[(i + 1) % canvasPts.size], strokeWidth = 4f)
                                }
                            }
                        }

                        val geometry = FenceGeometryEngine.analyze(points, pxPerFt ?: 1f, activeRun.closedLoop)
                        val canvasPoints = points.map { transform.toCanvas(it) }

                        // Where each gate actually sits, and how much fence it
                        // takes up. Worked out once and used for both the gaps
                        // in the fence and the gates drawn into them.
                        val gateSpans = if (pxPerFt != null && pxPerFt > 0f) {
                            gates.mapNotNull { g ->
                                GateGeometry.spanFor(g, points, activeRun.closedLoop, pxPerFt)
                                    ?.let { span -> g to span }
                            }
                        } else emptyList()

                        // A run marked as the old fence coming out is drawn in
                        // teardown's colour instead of the build colour -- same
                        // geometry, so a crew can tell "pull this out" from
                        // "build this" without a legend, on this screen or the
                        // crew's copy of it.
                        val activeLineColor = if (activeRun.isTeardown) PlanColors.teardownLine else PlanColors.fenceLine
                        val segCount = if (activeRun.closedLoop) points.size else points.size - 1
                        for (i in 0 until max(0, segCount)) {
                            val a = points[i]
                            val b = points[(i + 1) % points.size]
                            // The fence is drawn as the pieces either side of
                            // each opening rather than one line with a symbol
                            // on top, so a gate reads as a way through. It also
                            // makes an opening too wide for its run obvious:
                            // the fence either side simply is not there.
                            val onThisSegment = gateSpans
                                .filter { it.second.segmentIndex == i }
                                .map { it.second }
                            GateGeometry.segmentGaps(a, b, onThisSegment).forEach { (from, to) ->
                                drawLine(
                                    activeLineColor,
                                    transform.toCanvas(from),
                                    transform.toCanvas(to),
                                    strokeWidth = 4f
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
                        gateSpans.forEach { (gate, span) ->
                            val a = transform.toCanvas(span.start)
                            val b = transform.toCanvas(span.end)

                            // The two posts the gate hangs between. These are
                            // the things that get set in concrete, so they are
                            // what the crew is really looking for.
                            listOf(a, b).forEach { post ->
                                drawCircle(PlanColors.gate, radius = 7f, center = post)
                                drawCircle(
                                    Color.White, radius = 7f, center = post,
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
                                    drawLine(PlanColors.gate, a, tip, strokeWidth = 3f)
                                    drawArc(
                                        color = PlanColors.gate.copy(alpha = 0.35f),
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
                                    color = PlanColors.gate.toArgb()
                                    textSize = 26f
                                    textAlign = android.graphics.Paint.Align.CENTER
                                    isFakeBoldText = true
                                }
                            )
                        }

                        siteMarkers.forEach { marker ->
                            val c = transform.toCanvas(FencePoint(marker.x, marker.y))
                            val color = PlanColors.marker(marker.kind)
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

                        pendingCalibration.forEach { p ->
                            drawCircle(Color(0xFFFFD60A), radius = 10f, center = transform.toCanvas(p))
                        }
                    }

                    Column(
                        modifier = Modifier.align(Alignment.TopEnd).padding(Space.sm),
                        verticalArrangement = Arrangement.spacedBy(Space.sm)
                    ) {
                        ZoomButton(Icons.Filled.Add) { viewZoom = (viewZoom * 1.3f).coerceIn(0.25f, 12f) }
                        ZoomButton(Icons.Filled.Remove) { viewZoom = (viewZoom / 1.3f).coerceIn(0.25f, 12f) }
                        ZoomButton(Icons.Filled.MyLocation) { viewZoom = 1f; viewPan = Offset.Zero }
                    }

                    // Plain Box, not Surface. Material3's Surface deliberately
                    // swallows pointer events so clicks can't fall through to
                    // whatever is behind it -- which meant these hints ate every
                    // tap along the bottom of the drawing area. A Box with a
                    // background looks the same and lets taps through.
                    if (mode == SurveyMode.PAN) {
                        CanvasHint(Modifier.align(Alignment.BottomCenter), stringResource(R.string.survey_drag_to_move))
                    }
                    if (mode == SurveyMode.ADJUST) {
                        if (selectedPoint == null) {
                            CanvasHint(
                                Modifier.align(Alignment.BottomCenter),
                                stringResource(R.string.misc_survey_adjust_canvas_hint)
                            )
                        } else {
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
                                satelliteOn = satelliteOn,
                                satelliteAnchor = satelliteAnchor,
                                satelliteTiles = satelliteTiles,
                                baseScale = viewTransform(
                                    canvasContentSize.first, canvasContentSize.second,
                                    canvasSize, viewZoom, viewPan
                                ).scale,
                                segmentFeet = loupeSegmentFeet
                            )
                        }
                    }
                }

                val geometry = FenceGeometryEngine.analyze(points, pxPerFt ?: 1f, activeRun.closedLoop)
                Surface(tonalElevation = 2.dp) {
                    Column(Modifier.fillMaxWidth().padding(Space.md)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Filled.Straighten, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                            Text(
                                // The grid has its own known scale, so there is
                                // nothing to calibrate and nothing to warn about.
                                // Only a survey photo can be missing a scale.
                                text = when {
                                    pxPerFt != null ->
                                        "  " + stringResource(R.string.misc_survey_feet_total, String.format("%.1f", geometry.totalLinearFeet)) +
                                            "  |  " + stringResource(R.string.misc_survey_corners_count, geometry.cornerCount) +
                                            "  |  " + stringResource(R.string.misc_survey_gates_count, gates.size)
                                    usingGrid -> "  " + stringResource(R.string.misc_survey_grid_to_scale)
                                    else -> "  " + stringResource(R.string.misc_survey_tap_calibrate)
                                },
                                style = MaterialTheme.typography.bodyMedium
                            )
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = activeRun.closedLoop, onCheckedChange = { viewModel.toggleClosedLoop(it) })
                            Text(stringResource(R.string.draw_closed_perimeter))
                        }
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(Space.sm)
                        ) {
                            OutlinedButton(onClick = { viewModel.undoLast(mode) }, modifier = Modifier.weight(1f)) {
                                Icon(Icons.Filled.Undo, contentDescription = null)
                                Text(" " + stringResource(R.string.draw_undo))
                            }
                            OutlinedButton(onClick = { viewModel.clearPoints() }, modifier = Modifier.weight(1f)) {
                                Icon(Icons.Filled.Clear, contentDescription = null)
                                Text(" " + stringResource(R.string.draw_clear))
                            }
                            Button(onClick = { onGoToEstimate(jobId) }, modifier = Modifier.weight(1f)) {
                                Text(stringResource(R.string.draw_to_estimate))
                            }
                        }
                    }
                }
            }
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

    markerDialogPoint?.let { point ->
        SiteMarkerDialog(
            existing = siteMarkers,
            onConfirm = { kind, label ->
                viewModel.addSiteMarker(kind, point.x, point.y, label)
                markerDialogPoint = null
            },
            onDelete = { marker -> viewModel.deleteSiteMarker(marker) },
            onDismiss = { markerDialogPoint = null }
        )
    }
}

private fun markerShortLabelRes(kind: SiteMarkerKind): Int = when (kind) {
    SiteMarkerKind.EXISTING_FENCE -> R.string.misc_marker_old_fence
    SiteMarkerKind.HOUSE -> R.string.misc_marker_house
    SiteMarkerKind.POOL -> R.string.misc_marker_pool
    SiteMarkerKind.DRIVEWAY -> R.string.misc_marker_driveway
    SiteMarkerKind.EASEMENT -> R.string.misc_marker_easement
    SiteMarkerKind.UTILITY -> R.string.misc_marker_utility
    SiteMarkerKind.TREE -> R.string.misc_marker_tree
    SiteMarkerKind.SLOPE -> R.string.misc_marker_slope
    SiteMarkerKind.OBSTACLE -> R.string.misc_marker_obstacle
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun SiteMarkerDialog(
    existing: List<SiteMarker>,
    onConfirm: (SiteMarkerKind, String) -> Unit,
    onDelete: (SiteMarker) -> Unit,
    onDismiss: () -> Unit
) {
    var kind by remember { mutableStateOf(SiteMarkerKind.OBSTACLE) }
    var label by remember { mutableStateOf("") }

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
                            label = { Text(stringResource(markerShortLabelRes(k))) }
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
        confirmButton = { Button(onClick = { onConfirm(kind, label) }) { Text(stringResource(R.string.draw_add_marker)) } },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } }
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

@Composable
private fun ZoomButton(icon: androidx.compose.ui.graphics.vector.ImageVector, onClick: () -> Unit) {
    Surface(tonalElevation = 3.dp, shape = androidx.compose.foundation.shape.CircleShape) {
        IconButton(onClick = onClick) { Icon(icon, contentDescription = null) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RunSelector(runs: List<FenceRun>, selectedRunId: Long?, onSelect: (Long) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val selected = runs.firstOrNull { it.id == selectedRunId }
    val untitled = stringResource(R.string.misc_survey_untitled)
    ExposedDropdownMenuBox(
        expanded = expanded, onExpandedChange = { expanded = it },
        modifier = Modifier.fillMaxWidth().padding(horizontal = Space.sm, vertical = Space.xs)
    ) {
        OutlinedTextField(
            value = selected?.let { "${it.label.ifBlank { untitled }} (${it.fenceType.label()})" } ?: "",
            onValueChange = {}, readOnly = true,
            label = { Text(stringResource(R.string.draw_editing_run)) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor()
        )
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            runs.forEach { run ->
                DropdownMenuItem(
                    text = { Text("${run.label.ifBlank { untitled }} (${run.fenceType.label()})") },
                    onClick = { onSelect(run.id); expanded = false }
                )
            }
        }
    }
}

@Composable
private fun CalibrationDialog(onConfirm: (Float) -> Unit, onDismiss: () -> Unit) {
    var text by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.draw_known_distance)) },
        text = {
            Column {
                Text(stringResource(R.string.draw_distance_question))
                Spacer(Modifier.height(Space.sm))
                OutlinedTextField(value = text, onValueChange = { text = it }, label = { Text(stringResource(R.string.draw_feet)) })
            }
        },
        confirmButton = {
            Button(onClick = { text.replace(',', '.').toFloatOrNull()?.let(onConfirm) }) { Text(stringResource(R.string.draw_set_scale)) }
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
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.draw_gate)) },
        text = {
            Column {
                Text(stringResource(R.string.draw_gate_width_question))
                Spacer(Modifier.height(Space.sm))
                OutlinedTextField(value = text, onValueChange = { text = it }, label = { Text(stringResource(R.string.draw_feet)) })
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
            Button(onClick = { text.replace(',', '.').toFloatOrNull()?.let { onConfirm(it, mounting, swing) } }) { Text(stringResource(R.string.draw_add_gate)) }
        },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } }
    )
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

/** Alpha applied to another run's line so the one being worked on stands out; 0x66 of 0xFF. */
private const val OTHER_RUN_ALPHA = 0.4f

/** Screen-space tap tolerance for grabbing a vertex in Adjust mode, independent of zoom level. */
private const val VERTEX_HIT_RADIUS_PX = 40f

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

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawGrid(transform: FitTransform, contentW: Int, contentH: Int, gridLineSpacingFt: Float) {
    drawRect(
        Color(0xFFF6F4EF),
        topLeft = Offset(transform.offsetX, transform.offsetY),
        size = androidx.compose.ui.geometry.Size(contentW * transform.scale, contentH * transform.scale)
    )
    val stepUnits = (gridLineSpacingFt.coerceAtLeast(0.5f)) * SurveyViewModel.PIXELS_PER_FOOT_GRID
    // Shared with the crew's copy of this grid via PlanColors, so a square
    // means the same thing measured off either screen.
    val minorColor = PlanColors.grid
    val majorColor = PlanColors.gridMajor
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
        y += stepUnits
        lineIndex++
    }
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
private fun CanvasHint(modifier: Modifier = Modifier, text: String) {
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
            color = MaterialTheme.colorScheme.onSurfaceVariant
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
 * The zoom satellite imagery is always fetched and placed at. Fixed, not the
 * same thing as viewZoom (the on-screen pinch/+-/- zoom, which scales
 * FitTransform and is free to change at any time): if this changed too,
 * every already-placed point would need to be re-projected or it would
 * drift relative to the ground under it. 20 is also the office's own
 * starting zoom (SAT.z = 20 in openSatellite()) and the one satFeetPerPx
 * needs to agree with SurveyViewModel.PIXELS_PER_FOOT_GRID (20) for the
 * satellite-to-survey-pixel scale to come out to a clean 1.0 ratio budget --
 * see SatelliteAnchor.
 */
private const val SATELLITE_TILE_Z = 20

/** A hard ceiling on tiles fetched for one view -- an extreme zoom-out on a
 *  slow connection must not queue hundreds of downloads at once. */
private const val MAX_SATELLITE_TILES = 64

private fun satelliteTileKey(x: Int, y: Int) = "$SATELLITE_TILE_Z/$x/$y"

/**
 * Fixes the satellite imagery to the app's own survey-pixel canvas.
 *
 * The content-space center (GRID_CANVAS_SIZE/2, GRID_CANVAS_SIZE/2) is
 * pinned to the job's own site latitude/longitude; from there, converting
 * between a Web Mercator pixel (what SatelliteMath and the tile grid speak)
 * and a survey pixel (what every point, gate and marker on this screen is
 * stored in) is one scale factor: how many survey pixels (20 per foot) one
 * Web Mercator pixel covers at this latitude and zoom. That is exactly
 * SatelliteMath.feetPerPx(lat, z) * PIXELS_PER_FOOT_GRID -- the same
 * arithmetic satPointsToRunSpace in website/dashboard.html does when it
 * converts a traced lat/lon point into the run's own pixel space.
 */
private class SatelliteAnchor(lat: Double, lon: Double) {
    private val centerWorld = SatelliteMath.world(lat, lon, SATELLITE_TILE_Z)
    private val surveyPxPerWorldPx =
        SatelliteMath.feetPerPx(lat, SATELLITE_TILE_Z) * SurveyViewModel.PIXELS_PER_FOOT_GRID
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
    satelliteOn: Boolean,
    satelliteAnchor: SatelliteAnchor?,
    satelliteTiles: Map<String, Bitmap>
) {
    if (bmp != null) {
        drawImage(
            image = bmp.asImageBitmap(),
            dstOffset = androidx.compose.ui.unit.IntOffset(transform.offsetX.toInt(), transform.offsetY.toInt()),
            dstSize = IntSize((bmp.width * transform.scale).toInt(), (bmp.height * transform.scale).toInt())
        )
        return
    }
    drawGrid(transform, contentW, contentH, gridFeetPerSquare)
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
    satelliteOn: Boolean,
    satelliteAnchor: SatelliteAnchor?,
    satelliteTiles: Map<String, Bitmap>,
    baseScale: Float,
    segmentFeet: List<Float>
) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier
                .size(LOUPE_SIZE_DP)
                .clip(androidx.compose.foundation.shape.CircleShape)
                .background(Color(0xFFF6F4EF))
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
                    bmp, localTransform, contentW, contentH, gridFeetPerSquare,
                    satelliteOn, satelliteAnchor, satelliteTiles
                )
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
