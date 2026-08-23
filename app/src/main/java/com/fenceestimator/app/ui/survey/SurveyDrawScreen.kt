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
import androidx.compose.foundation.layout.padding
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.max
import kotlin.math.min

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SurveyDrawScreen(jobId: Long, onBack: () -> Unit, onGoToEstimate: (Long) -> Unit) {
    val app = currentApp()
    val viewModel: SurveyViewModel = viewModel(
        key = "survey_$jobId",
        factory = GenericViewModelFactory { SurveyViewModel(app.repository, jobId) }
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
    val pendingCalibration by viewModel.pendingCalibrationPoints.collectAsState()
    val context = LocalContext.current

    LaunchedEffect(runs) { viewModel.ensureSelection() }

    var bitmap by remember { mutableStateOf<Bitmap?>(null) }
    var canvasSize by remember { mutableStateOf(IntSize.Zero) }
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
            if (runs.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(stringResource(R.string.draw_add_run_first), modifier = Modifier.padding(24.dp))
                }
                return@Column
            }

            // Full screen hides everything that isn't the drawing. On a phone
            // the chrome above and below eats more than half the height, which
            // is the difference between seeing a whole property and a third of
            // it. The mode buttons stay -- you still have to switch tools.
            if (!fullScreenDrawing) {
                RunSelector(runs = runs, selectedRunId = selectedRunId, onSelect = { viewModel.selectRun(it) })

                Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        stringResource(if (usingGrid) R.string.misc_survey_drawing_on_grid else R.string.misc_survey_drawing_on_photo),
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
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
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
                        )
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                            horizontalArrangement = Arrangement.spacedBy(6.dp)
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
                            modifier = Modifier.padding(horizontal = 8.dp)
                        )
                        DraftNumberField(
                            stableKey = job2.id, label = stringResource(R.string.misc_survey_feet_per_square),
                            initialValue = job2.gridFeetPerSquare,
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp)
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
            SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth().padding(8.dp)) {
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
                    modifier = Modifier.padding(horizontal = 8.dp)
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
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
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

                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f)
                        .padding(8.dp)
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
                                            },
                                            onDragCancel = {
                                                draggingIndex = null
                                                draggingGate = null
                                                draggingMarker = null
                                                lastImagePoint = null
                                                draftPoints = null
                                            }
                                        ) { change, _ ->
                                            if (draggingIndex == null && draggingGate == null && draggingMarker == null) {
                                                return@detectDragGestures
                                            }
                                            val transform = viewTransform(canvasContentSize.first, canvasContentSize.second, canvasSize, viewZoom, viewPan)
                                            val imgPoint = transform.toImage(change.position)
                                            lastImagePoint = imgPoint
                                            draggingIndex?.let { idx ->
                                                draftPoints = committedPoints.toMutableList().also { it[idx] = imgPoint }
                                            }
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

                        if (bmp != null) {
                            drawImage(
                                image = bmp.asImageBitmap(),
                                dstOffset = androidx.compose.ui.unit.IntOffset(transform.offsetX.toInt(), transform.offsetY.toInt()),
                                dstSize = IntSize((bmp.width * transform.scale).toInt(), (bmp.height * transform.scale).toInt())
                            )
                        } else {
                            drawGrid(transform, canvasContentSize.first, canvasContentSize.second, job2.gridFeetPerSquare)
                        }

                        otherRuns.forEach { other ->
                            val otherPoints = FenceCodec.decodePoints(other.pointsEncoded)
                            if (otherPoints.size >= 2) {
                                val canvasPts = otherPoints.map { transform.toCanvas(it) }
                                val segCount = if (other.closedLoop) otherPoints.size else otherPoints.size - 1
                                for (i in 0 until max(0, segCount)) {
                                    drawLine(OtherRunLineColor, canvasPts[i], canvasPts[(i + 1) % canvasPts.size], strokeWidth = 4f)
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
                                    FenceLineColor,
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
                                VertexKind.CORNER -> CornerVertexColor
                                VertexKind.END -> EndVertexColor
                                VertexKind.LINE -> LineVertexColor
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
                                drawCircle(GateMarkerColor, radius = 7f, center = post)
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
                                    drawLine(GateMarkerColor, a, tip, strokeWidth = 3f)
                                    drawArc(
                                        color = GateMarkerColor.copy(alpha = 0.35f),
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
                                    color = android.graphics.Color.parseColor("#B23800")
                                    textSize = 26f
                                    textAlign = android.graphics.Paint.Align.CENTER
                                    isFakeBoldText = true
                                }
                            )
                        }

                        siteMarkers.forEach { marker ->
                            val c = transform.toCanvas(FencePoint(marker.x, marker.y))
                            val color = markerColor(marker.kind)
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
                        modifier = Modifier.align(Alignment.TopEnd).padding(8.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp)
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

                }

                val geometry = FenceGeometryEngine.analyze(points, pxPerFt ?: 1f, activeRun.closedLoop)
                Surface(tonalElevation = 2.dp) {
                    Column(Modifier.fillMaxWidth().padding(12.dp)) {
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
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
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
                viewModel.addGate(point.x, point.y, widthFt, mounting, swing)
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

private fun markerColor(kind: SiteMarkerKind): Color = when (kind) {
    SiteMarkerKind.EXISTING_FENCE -> Color(0xFF8A93A3)
    SiteMarkerKind.HOUSE -> Color(0xFF1E2A3D)
    SiteMarkerKind.POOL -> Color(0xFF0EA5E9)
    SiteMarkerKind.DRIVEWAY -> Color(0xFF6B7280)
    SiteMarkerKind.EASEMENT -> Color(0xFFD946EF)
    SiteMarkerKind.UTILITY -> Color(0xFFEF4444)
    SiteMarkerKind.TREE -> Color(0xFF16A34A)
    SiteMarkerKind.SLOPE -> Color(0xFFF59E0B)
    SiteMarkerKind.OBSTACLE -> Color(0xFFB23800)
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
                Spacer(Modifier.height(8.dp))
                androidx.compose.foundation.layout.FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    SiteMarkerKind.values().forEach { k ->
                        androidx.compose.material3.FilterChip(
                            selected = kind == k,
                            onClick = { kind = k },
                            label = { Text(stringResource(markerShortLabelRes(k))) }
                        )
                    }
                }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = label, onValueChange = { label = it },
                    label = { Text(stringResource(R.string.draw_note_optional)) },
                    modifier = Modifier.fillMaxWidth()
                )
                if (existing.isNotEmpty()) {
                    Spacer(Modifier.height(12.dp))
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
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)
    ) {
        OutlinedTextField(
            value = selected?.let { "${it.label.ifBlank { untitled }} (${it.fenceType.name.replace("_", " ")})" } ?: "",
            onValueChange = {}, readOnly = true,
            label = { Text(stringResource(R.string.draw_editing_run)) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor()
        )
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            runs.forEach { run ->
                DropdownMenuItem(
                    text = { Text("${run.label.ifBlank { untitled }} (${run.fenceType.name.replace("_", " ")})") },
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
                Spacer(Modifier.height(8.dp))
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
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(value = text, onValueChange = { text = it }, label = { Text(stringResource(R.string.draw_feet)) })
                Spacer(Modifier.height(16.dp))

                // Asked here rather than left to the estimate, because it
                // changes what gets loaded on the truck: a wall-hung gate takes
                // a blank post and plugs and no concrete at all.
                Text(stringResource(R.string.draw_gate_hanging), style = MaterialTheme.typography.titleSmall)
                Spacer(Modifier.height(4.dp))
                GateMountingChoice(selected = mounting, onSelect = { mounting = it })

                Spacer(Modifier.height(16.dp))
                // Asked while somebody is standing at the opening looking at it.
                // A gate that swings into a slope, a step or where a car parks
                // is a return visit, and this is the detail that gets lost
                // between quoting and installing.
                Text(stringResource(R.string.draw_gate_swing), style = MaterialTheme.typography.titleSmall)
                Spacer(Modifier.height(4.dp))
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
                modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                androidx.compose.material3.RadioButton(
                    selected = selected == value,
                    onClick = { onSelect(value) }
                )
                Column(Modifier.padding(start = 4.dp)) {
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
                modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                androidx.compose.material3.RadioButton(
                    selected = selected == value,
                    onClick = { onSelect(value) }
                )
                Column(Modifier.padding(start = 4.dp)) {
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

// Matches the app's Graphite/SafetyOrange/SteelTeal theme -- these used to be a leftover
// "organic" green from before the redesign, which visually clashed and made it hard to pick
// out calibration/gate markers against the drawn line, especially zoomed in.
private val FenceLineColor = Color(0xFF0E8C7B)
private val OtherRunLineColor = Color(0x660E8C7B)
private val CornerVertexColor = Color(0xFFFF5A1F)
private val EndVertexColor = Color(0xFF1E2A3D)
private val LineVertexColor = Color(0xFF07473D)
private val GateMarkerColor = Color(0xFFB23800)

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
    val minorColor = Color(0xFFE2DFD5)
    val majorColor = Color(0xFFC9C4B5)
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
            .padding(8.dp)
            .background(
                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.9f),
                androidx.compose.foundation.shape.RoundedCornerShape(8.dp)
            )
            .padding(horizontal = 12.dp, vertical = 6.dp)
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
        modifier = modifier.padding(8.dp),
        tonalElevation = 6.dp,
        shape = androidx.compose.foundation.shape.RoundedCornerShape(12.dp)
    ) {
        Column(
            Modifier.padding(6.dp),
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
