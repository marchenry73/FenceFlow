package com.fenceestimator.app.ui.survey

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
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
import androidx.compose.material.icons.filled.Clear
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
import androidx.compose.runtime.setValue
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
    val job by viewModel.job.collectAsState()
    val runs by viewModel.runs.collectAsState()
    val selectedRunId by viewModel.selectedRunId.collectAsState()
    val mode by viewModel.mode.collectAsState()
    val pendingCalibration by viewModel.pendingCalibrationPoints.collectAsState()
    val context = LocalContext.current

    LaunchedEffect(runs) { viewModel.ensureSelection() }

    var bitmap by remember { mutableStateOf<Bitmap?>(null) }
    var canvasSize by remember { mutableStateOf(IntSize.Zero) }
    var viewZoom by remember(selectedRunId) { mutableStateOf(1f) }
    var viewPan by remember(selectedRunId) { mutableStateOf(Offset.Zero) }

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
                title = { Text("Survey & Draw") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                }
            )
        }
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            if (runs.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("Add a fence run on the job screen first, then come back to draw it here.", modifier = Modifier.padding(24.dp))
                }
                return@Column
            }

            RunSelector(runs = runs, selectedRunId = selectedRunId, onSelect = { viewModel.selectRun(it) })

            Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (usingGrid) "Drawing on a scaled grid (no survey photo)" else "Drawing on your uploaded survey",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                OutlinedButton(onClick = {
                    if (usingGrid) {
                        imagePicker.launch(androidx.activity.result.PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                    } else {
                        viewModel.clearSurveyImage()
                    }
                }) {
                    Text(if (usingGrid) "Upload Photo" else "Use Grid Instead")
                }
            }

            if (usingGrid) {
                val job2 = job
                if (job2 != null) {
                    DraftNumberField(
                        stableKey = job2.id, label = "Gridline spacing (ft) -- display only, won't resize your drawing",
                        initialValue = job2.gridFeetPerSquare,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp)
                    ) { viewModel.setGridLineSpacingFt(it) }
                }
            }

            val visibleModes = remember(usingGrid) {
                buildList {
                    add(SurveyMode.DRAW to "Draw")
                    // No Calibrate on the grid. The grid already knows its own
                    // scale, so the step asked people to solve a problem they did
                    // not have -- it was the single most confusing thing here.
                    // On a survey photo it is unavoidable: nothing else can tell
                    // the app how big the picture is.
                    if (!usingGrid) add(SurveyMode.CALIBRATE to "Calibrate")
                    add(SurveyMode.GATE to "Gate")
                    add(SurveyMode.MARKER to "Mark Site")
                    add(SurveyMode.ADJUST to "Adjust")
                    add(SurveyMode.PAN to "Move View")
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
                    ) { Text(label) }
                }
            }
            if (mode == SurveyMode.ADJUST) {
                Text(
                    "Drag an existing point to move it -- calibration and other modes still work at any zoom.",
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
                val points = draftPoints ?: committedPoints
                val pxPerFt = job2.calibrationPixelsPerFoot
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
                            .pointerInput(mode, committedPoints, bmp, activeRun.id, usingGrid) {
                                // Only one gesture detector is ever active at a time -- mixing a tap
                                // detector and a drag detector on the same pointer stream is a real
                                // source of flaky gesture recognition, so each mode that needs drag
                                // (Move View, Adjust) gets the canvas to itself.
                                when (mode) {
                                    SurveyMode.PAN -> detectDragGestures { _, dragAmount -> viewPan += dragAmount }
                                    SurveyMode.ADJUST -> {
                                        var draggingIndex: Int? = null
                                        var lastImagePoint: FencePoint? = null
                                        detectDragGestures(
                                            onDragStart = { startOffset ->
                                                val transform = viewTransform(canvasContentSize.first, canvasContentSize.second, canvasSize, viewZoom, viewPan)
                                                val nearest = committedPoints.withIndex().minByOrNull { (_, p) -> (transform.toCanvas(p) - startOffset).getDistance() }
                                                draggingIndex = nearest?.takeIf { (_, p) -> (transform.toCanvas(p) - startOffset).getDistance() <= VERTEX_HIT_RADIUS_PX }?.index
                                            },
                                            onDragEnd = {
                                                val idx = draggingIndex
                                                val finalPoint = lastImagePoint
                                                if (idx != null && finalPoint != null) viewModel.movePoint(idx, finalPoint)
                                                draggingIndex = null
                                                lastImagePoint = null
                                                draftPoints = null
                                            },
                                            onDragCancel = {
                                                draggingIndex = null
                                                lastImagePoint = null
                                                draftPoints = null
                                            }
                                        ) { change, _ ->
                                            val idx = draggingIndex ?: return@detectDragGestures
                                            val transform = viewTransform(canvasContentSize.first, canvasContentSize.second, canvasSize, viewZoom, viewPan)
                                            val imgPoint = transform.toImage(change.position)
                                            lastImagePoint = imgPoint
                                            draftPoints = committedPoints.toMutableList().also { it[idx] = imgPoint }
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
                                            SurveyMode.GATE -> gateDialogPoint = imgPoint
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

                        val segCount = if (activeRun.closedLoop) points.size else points.size - 1
                        for (i in 0 until max(0, segCount)) {
                            val a = canvasPoints[i]
                            val b = canvasPoints[(i + 1) % canvasPoints.size]
                            drawLine(FenceLineColor, a, b, strokeWidth = 4f)
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

                        gates.forEach { gate ->
                            val c = transform.toCanvas(FencePoint(gate.x, gate.y))
                            drawRect(
                                GateMarkerColor,
                                topLeft = Offset(c.x - 10f, c.y - 10f),
                                size = androidx.compose.ui.geometry.Size(20f, 20f)
                            )
                            drawRect(
                                Color.White,
                                topLeft = Offset(c.x - 10f, c.y - 10f),
                                size = androidx.compose.ui.geometry.Size(20f, 20f),
                                style = androidx.compose.ui.graphics.drawscope.Stroke(width = 2f)
                            )
                        }

                        siteMarkers.forEach { marker ->
                            val c = transform.toCanvas(FencePoint(marker.x, marker.y))
                            val color = markerColor(marker.kind)
                            drawCircle(color, radius = 13f, center = c)
                            drawCircle(Color.White, radius = 13f, center = c, style = androidx.compose.ui.graphics.drawscope.Stroke(width = 2.5f))
                            drawContext.canvas.nativeCanvas.drawText(
                                marker.label.ifBlank { markerShortLabel(marker.kind) },
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

                    if (mode == SurveyMode.PAN) {
                        Surface(
                            modifier = Modifier.align(Alignment.BottomCenter).padding(8.dp),
                            tonalElevation = 3.dp
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(8.dp)) {
                                Icon(Icons.Filled.OpenWith, contentDescription = null)
                                Text("  Drag to move the view")
                            }
                        }
                    }
                    if (mode == SurveyMode.ADJUST) {
                        Surface(
                            modifier = Modifier.align(Alignment.BottomCenter).padding(8.dp),
                            tonalElevation = 3.dp
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(8.dp)) {
                                Icon(Icons.Filled.PanTool, contentDescription = null)
                                Text("  Drag a highlighted point to move it")
                            }
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
                                        "  ${String.format("%.1f", geometry.totalLinearFeet)} ft total  |  ${geometry.cornerCount} corners  |  ${gates.size} gate(s)"
                                    usingGrid -> "  Draw the fence line -- the grid is already to scale"
                                    else -> "  Tap Calibrate, then tap two points a known distance apart"
                                },
                                style = MaterialTheme.typography.bodyMedium
                            )
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = activeRun.closedLoop, onCheckedChange = { viewModel.toggleClosedLoop(it) })
                            Text("Closed perimeter (no open ends)")
                        }
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            OutlinedButton(onClick = { viewModel.undoLastPoint() }, modifier = Modifier.weight(1f)) {
                                Icon(Icons.Filled.Undo, contentDescription = null)
                                Text(" Undo")
                            }
                            OutlinedButton(onClick = { viewModel.clearPoints() }, modifier = Modifier.weight(1f)) {
                                Icon(Icons.Filled.Clear, contentDescription = null)
                                Text(" Clear")
                            }
                            Button(onClick = { onGoToEstimate(jobId) }, modifier = Modifier.weight(1f)) {
                                Text("To Estimate")
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
            onConfirm = { widthFt ->
                viewModel.addGate(point.x, point.y, widthFt)
                gateDialogPoint = null
            },
            onDismiss = { gateDialogPoint = null }
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

private fun markerShortLabel(kind: SiteMarkerKind): String = when (kind) {
    SiteMarkerKind.EXISTING_FENCE -> "Old fence"
    SiteMarkerKind.HOUSE -> "House"
    SiteMarkerKind.POOL -> "Pool"
    SiteMarkerKind.DRIVEWAY -> "Driveway"
    SiteMarkerKind.EASEMENT -> "Easement"
    SiteMarkerKind.UTILITY -> "Utility"
    SiteMarkerKind.TREE -> "Tree"
    SiteMarkerKind.SLOPE -> "Slope"
    SiteMarkerKind.OBSTACLE -> "Obstacle"
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
        title = { Text("Mark this spot") },
        text = {
            Column {
                Text(
                    "What's here? This shows on the plan so the crew knows what to work around.",
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
                            label = { Text(markerShortLabel(k)) }
                        )
                    }
                }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = label, onValueChange = { label = it },
                    label = { Text("Note (optional)") },
                    modifier = Modifier.fillMaxWidth()
                )
                if (existing.isNotEmpty()) {
                    Spacer(Modifier.height(12.dp))
                    Text("Already marked:", style = MaterialTheme.typography.labelLarge)
                    existing.forEach { marker ->
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                            Text(
                                marker.label.ifBlank { markerShortLabel(marker.kind) },
                                modifier = Modifier.weight(1f),
                                style = MaterialTheme.typography.bodyMedium
                            )
                            IconButton(onClick = { onDelete(marker) }) {
                                Icon(Icons.Filled.Clear, contentDescription = "Remove marker")
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { Button(onClick = { onConfirm(kind, label) }) { Text("Add Marker") } },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text("Cancel") } }
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
    ExposedDropdownMenuBox(
        expanded = expanded, onExpandedChange = { expanded = it },
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)
    ) {
        OutlinedTextField(
            value = selected?.let { "${it.label.ifBlank { "Untitled" }} (${it.fenceType.name.replace("_", " ")})" } ?: "",
            onValueChange = {}, readOnly = true,
            label = { Text("Editing run") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor()
        )
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            runs.forEach { run ->
                DropdownMenuItem(
                    text = { Text("${run.label.ifBlank { "Untitled" }} (${run.fenceType.name.replace("_", " ")})") },
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
        title = { Text("Known distance") },
        text = {
            Column {
                Text("What is the real-world distance between the two points you tapped, in feet?")
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(value = text, onValueChange = { text = it }, label = { Text("Feet") })
            }
        },
        confirmButton = {
            Button(onClick = { text.toFloatOrNull()?.let(onConfirm) }) { Text("Set Scale") }
        },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text("Cancel") } }
    )
}

@Composable
private fun GateWidthDialog(onConfirm: (Float) -> Unit, onDismiss: () -> Unit) {
    var text by remember { mutableStateOf("5") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Gate width") },
        text = {
            Column {
                Text("How wide is this gate opening, in feet? It'll be placed right where you tapped.")
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(value = text, onValueChange = { text = it }, label = { Text("Feet") })
            }
        },
        confirmButton = {
            Button(onClick = { text.toFloatOrNull()?.let(onConfirm) }) { Text("Add Gate") }
        },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text("Cancel") } }
    )
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
