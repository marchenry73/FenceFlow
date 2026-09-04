package com.fenceestimator.app.ui.crew

import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import kotlinx.coroutines.launch
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.R
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.SiteMarker
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FenceGeometryEngine
import com.fenceestimator.app.geometry.FencePoint
import com.fenceestimator.app.ui.components.EmptyState
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp
import com.fenceestimator.app.ui.components.label
import com.fenceestimator.app.ui.survey.SurveyViewModel
import com.fenceestimator.app.ui.theme.PlanColors
import com.fenceestimator.app.ui.theme.Radius
import com.fenceestimator.app.ui.theme.Space

/**
 * The fence plan as the crew needs it: what to build and where, with nothing
 * they can accidentally change.
 *
 * The crew used to be sent to the full drawing screen, where a stray tap moves
 * a corner or drops a new point -- and the drawing is what the estimate, the
 * post count and the material order were all built from. Reading it and editing
 * it are different jobs, so this is a separate screen with no edit tools at all.
 * Prices are absent by design; the crew's own pay lives on the job screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CrewFencePlanScreen(jobId: Long, onBack: () -> Unit) {
    val app = currentApp()
    val viewModel: SurveyViewModel = viewModel(
        key = "crew_plan_$jobId",
        factory = GenericViewModelFactory { SurveyViewModel(app.repository, jobId, app) }
    )
    val job by viewModel.job.collectAsState()
    val runs by viewModel.runs.collectAsState()
    val markers by viewModel.siteMarkers.collectAsState()
    val currentJob = job ?: return

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.crew_fence_plan)) },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                }
            )
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(Space.screen),
            verticalArrangement = Arrangement.spacedBy(Space.section)
        ) {
            item {
                Text(
                    "Read only. If the line needs to move, ask -- do not build it different.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            // Asking, rather than changing it and telling them afterwards.
            //
            // The crew standing at the fence line often DO know better than the
            // drawing. But footage drives the estimate, the post count and the
            // material order, so a change made on site and discovered later is
            // a job that has quietly stopped matching what the customer agreed
            // to pay. Asking costs a few minutes; finding out at invoicing
            // costs the difference.
            item { RequestChangeCard(jobId = jobId) }

            val drawn = runs.filter { FenceCodec.decodePoints(it.pointsEncoded).size >= 2 }
            if (drawn.isNotEmpty()) {
                item { PlanCanvas(currentJob, drawn, markers) }
                item { Legend(drawn, markers) }
            }

            // Empty and broken look identical on a bare list -- this is the
            // difference between "nothing to build yet" and a sync that never
            // arrived, same wording the job screen uses for the same gap.
            if (runs.isEmpty()) {
                item { EmptyState(stringResource(R.string.misc_crew_no_runs)) }
            } else {
                items(runs.size) { index ->
                    RunCard(currentJob, runs[index])
                }
            }

            if (markers.isNotEmpty()) {
                item { MarkersCard(markers) }
            }

            item {
                Text(
                    "Leaves and loose debris are ours to clear. Anything needing a tool — " +
                        "bushes, planters, sheds, limbs, old posts — is the customer's, or it " +
                        "goes on a change order. Don't remove it without checking.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

/**
 * Draws every run to fit the screen. The scale is derived from the drawing's
 * own bounds rather than the survey image, so the plan is legible on a phone
 * regardless of where on the canvas the fence was drawn.
 */
@Composable
private fun PlanCanvas(job: Job, runs: List<FenceRun>, markers: List<SiteMarker>) {
    Card(Modifier.fillMaxWidth()) {
        Box(
            Modifier.fillMaxWidth().aspectRatio(1.1f)
                .padding(Space.md)
                .clip(RoundedCornerShape(Radius.sm))
                // White, like the drawing surface the plan was made on, so the
                // crew are looking at the same picture rather than a recoloured
                // version of it.
                .background(androidx.compose.ui.graphics.Color.White)
        ) {
            val allPoints = runs.flatMap { FenceCodec.decodePoints(it.pointsEncoded) }
            if (allPoints.isEmpty()) return@Box

            val minX = allPoints.minOf { it.x }
            val maxX = allPoints.maxOf { it.x }
            val minY = allPoints.minOf { it.y }
            val maxY = allPoints.maxOf { it.y }
            // Guard against a perfectly straight run, where one span is zero and
            // would divide the scale to infinity.
            val spanX = (maxX - minX).coerceAtLeast(1f)
            val spanY = (maxY - minY).coerceAtLeast(1f)

            Canvas(Modifier.fillMaxSize()) {
                val pad = 32f
                val usableW = (size.width - pad * 2).coerceAtLeast(1f)
                val usableH = (size.height - pad * 2).coerceAtLeast(1f)
                val scale = minOf(usableW / spanX, usableH / spanY)

                // Centre whatever is left over, so the plan sits in the middle
                // instead of hugging a corner.
                val offsetX = pad + (usableW - spanX * scale) / 2f
                val offsetY = pad + (usableH - spanY * scale) / 2f

                fun place(p: FencePoint) = Offset(
                    offsetX + (p.x - minX) * scale,
                    offsetY + (p.y - minY) * scale
                )

                // The same grid the plan was drawn on.
                //
                // Without it the crew were reading a bare outline while the
                // office was looking at a scaled drawing -- the same fence, but
                // no shared way to say "about two squares past the corner".
                // Spacing comes from the job so both views agree on what a
                // square means.
                val feetPerSquare = job.gridFeetPerSquare.coerceAtLeast(0.5f)
                val pxPerFoot = job.calibrationPixelsPerFoot
                    ?: com.fenceestimator.app.ui.survey.SurveyViewModel.PIXELS_PER_FOOT_GRID
                val squarePx = feetPerSquare * pxPerFoot * scale
                if (squarePx > 6f) {
                    var gx = offsetX
                    while (gx <= size.width) {
                        drawLine(PlanColors.grid, Offset(gx, 0f), Offset(gx, size.height), strokeWidth = 1f)
                        gx += squarePx
                    }
                    var gy = offsetY
                    while (gy <= size.height) {
                        drawLine(PlanColors.grid, Offset(0f, gy), Offset(size.width, gy), strokeWidth = 1f)
                        gy += squarePx
                    }
                }

                runs.forEach { run ->
                    val points = FenceCodec.decodePoints(run.pointsEncoded)
                    if (points.size < 2) return@forEach

                    // Teardown reads differently from a run being built, the
                    // same as it does on the drawing screen -- the crew needs
                    // to tell "pull this out" from "build this" from the plan
                    // itself, not by asking.
                    val lineColor = if (run.isTeardown) PlanColors.teardownLine else PlanColors.fenceLine
                    val count = if (run.closedLoop) points.size else points.size - 1
                    for (i in 0 until count) {
                        drawLine(
                            color = lineColor,
                            start = place(points[i]),
                            end = place(points[(i + 1) % points.size]),
                            strokeWidth = 6f
                        )
                    }
                    // Every vertex is a post the crew has to set, so mark them.
                    points.forEach { drawCircle(lineColor, radius = 9f, center = place(it)) }

                    FenceCodec.decodeGates(run.gatesEncoded).forEach { gate ->
                        val at = place(FencePoint(gate.x, gate.y))
                        drawCircle(PlanColors.gate, radius = 16f, center = at)
                        drawCircle(Color.White, radius = 16f, center = at, style = Stroke(width = 4f))
                    }
                }

                markers.forEach { marker ->
                    val at = place(FencePoint(marker.x, marker.y))
                    drawCircle(PlanColors.marker(marker.kind), radius = 13f, center = at)
                    drawCircle(Color.White, radius = 13f, center = at, style = Stroke(width = 3f))
                }
            }
        }
    }
}

/**
 * What the colours on [PlanCanvas] mean, for exactly what is on this job.
 *
 * Site markers used to share one generic amber dot regardless of kind, so
 * this said "Watch out" and left the crew to work out what from the canvas
 * alone. The canvas now draws a pool, a tree and a utility line in three
 * different colours -- the same three the office sees while drawing -- so
 * the legend has to say which is which or it stops explaining what it is
 * next to.
 */
@Composable
private fun Legend(runs: List<FenceRun>, markers: List<SiteMarker>) {
    val hasBuildLine = remember(runs) { runs.any { !it.isTeardown } }
    val hasTeardownLine = remember(runs) { runs.any { it.isTeardown } }
    val presentMarkerKinds = remember(markers) { markers.map { it.kind }.distinct() }

    Column(verticalArrangement = Arrangement.spacedBy(Space.xs)) {
        Row(horizontalArrangement = Arrangement.spacedBy(Space.lg)) {
            if (hasBuildLine) LegendDot(PlanColors.fenceLine, "Fence line & posts")
            if (hasTeardownLine) LegendDot(PlanColors.teardownLine, "Fence coming out")
            LegendDot(PlanColors.gate, "Gate")
        }
        // Two per row rather than one long row, so this stays legible on a
        // 360dp phone even on a job with several kinds of marker on it.
        presentMarkerKinds.chunked(2).forEach { pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(Space.lg)) {
                pair.forEach { kind -> LegendDot(PlanColors.marker(kind), kind.label()) }
            }
        }
    }
}

@Composable
private fun LegendDot(color: Color, label: String) {
    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
        Box(
            Modifier.padding(end = 6.dp)
                .size(12.dp)
                .clip(RoundedCornerShape(50))
                .background(color)
        )
        Text(label, style = MaterialTheme.typography.bodySmall)
    }
}

/** The spec for one run, in the terms a crew works in. No prices. */
@Composable
private fun RunCard(job: Job, run: FenceRun) {
    val points = FenceCodec.decodePoints(run.pointsEncoded)
    val gates = FenceCodec.decodeGates(run.gatesEncoded)
    val manual = run.manualLinearFeet
    val usingManual = manual != null && manual > 0f

    // Honour typed-in footage. Reading "no fence line drawn" on a run that was
    // quoted by typing its length tells the crew the job isn't ready when it is.
    val pxPerFt = job.calibrationPixelsPerFoot ?: SurveyViewModel.PIXELS_PER_FOOT_GRID
    val geometry = if (points.size >= 2) FenceGeometryEngine.analyze(points, pxPerFt, run.closedLoop) else null
    val feet = if (usingManual) manual!!.toDouble() else geometry?.totalLinearFeet?.toDouble() ?: 0.0
    val corners = if (usingManual) run.manualCornerCount else geometry?.cornerCount ?: 0

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(Space.card), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Text(run.label.ifBlank { "Fence run" }, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)

            if (feet <= 0.0) {
                Text(
                    "Nothing measured for this run yet — check with the office before starting.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error
                )
                return@Column
            }

            SpecRow("Type", run.fenceType.label())
            SpecRow("Length", "${"%.0f".format(feet)} ft" + if (usingManual) "  (measured on site)" else "")
            SpecRow("Height", "${run.panelHeightFt.toInt()} ft")
            if (run.colorOrFinish.isNotBlank()) SpecRow("Color", run.colorOrFinish)
            SpecRow("Post spacing", "${run.postSpacingFt.toInt()} ft")
            SpecRow("Concrete", "${run.concreteBagsPerPost} bag(s) per post")
            SpecRow("Corners", corners.toString())
            if (geometry != null) SpecRow("Ends", geometry.endCount.toString())
            SpecRow("Gates", gates.size.toString())
            if (gates.isNotEmpty()) {
                Text(
                    "Gate widths: " + gates.joinToString(", ") { "${"%.0f".format(it.widthFt)} ft" },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun SpecRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun MarkersCard(markers: List<SiteMarker>) {
    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
    ) {
        Column(Modifier.padding(Space.card), verticalArrangement = Arrangement.spacedBy(Space.xs)) {
            Text(
                "Watch out on site",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onErrorContainer
            )
            markers.forEach { marker ->
                Text(
                    "•  ${marker.kind.label()}" +
                        if (marker.label.isNotBlank()) " — ${marker.label}" else "",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onErrorContainer
                )
            }
        }
    }
}

/**
 * The crew asking the office to change the plan.
 *
 * Deliberately a request and not an edit. The crew at the fence line often know
 * something the drawing does not -- the yard is longer, there is a tree nobody
 * saw, the gate wants to be on the other side. But footage drives the estimate,
 * the post count and the material order, so a change made on site and noticed
 * later is a job that has quietly stopped matching what the customer signed.
 *
 * Sent with what they would do and why, because "can we move the gate" without
 * a reason just produces a phone call to ask why.
 */
@Composable
private fun RequestChangeCard(jobId: Long) {
    val app = currentApp()
    val session by app.session.state.collectAsState()
    var showDialog by remember { mutableStateOf(false) }
    var sent by remember { mutableStateOf(false) }
    val scope = androidx.compose.runtime.rememberCoroutineScope()

    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
    ) {
        Column(Modifier.padding(Space.card), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Text(
                if (sent) "Change requested" else "Something not right?",
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSecondaryContainer
            )
            Text(
                if (sent)
                    "The office has it. Carry on with the rest of the job while you wait."
                else
                    "Ask the office before building it different. They will see it straight away.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSecondaryContainer
            )
            if (!sent) {
                OutlinedButton(
                    onClick = { showDialog = true },
                    modifier = Modifier.fillMaxWidth()
                ) { Text(stringResource(R.string.crew_ask_change_plan)) }
            }
        }
    }

    if (showDialog) {
        var what by remember { mutableStateOf("") }
        var why by remember { mutableStateOf("") }

        AlertDialog(
            onDismissRequest = { showDialog = false },
            title = { Text(stringResource(R.string.crew_ask_change_plan)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(Space.row)) {
                    OutlinedTextField(
                        value = what,
                        onValueChange = { what = it },
                        label = { Text(stringResource(R.string.crew_what_should_change)) },
                        placeholder = { Text(stringResource(R.string.crew_change_example)) },
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = why,
                        onValueChange = { why = it },
                        label = { Text(stringResource(R.string.crew_change_why)) },
                        placeholder = { Text(stringResource(R.string.crew_change_why_example)) },
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            },
            confirmButton = {
                Button(
                    enabled = what.isNotBlank(),
                    onClick = {
                        scope.launch {
                            app.repository.requestPlanChange(
                                jobId = jobId,
                                summary = what.trim(),
                                detail = why.trim(),
                                by = session.email.orEmpty(),
                                role = session.role.label
                            )
                            app.autoSync.requestSync()
                        }
                        sent = true
                        showDialog = false
                    }
                ) { Text(stringResource(R.string.crew_send_request)) }
            },
            dismissButton = {
                OutlinedButton(onClick = { showDialog = false }) { Text(stringResource(R.string.action_cancel)) }
            }
        )
    }
}
