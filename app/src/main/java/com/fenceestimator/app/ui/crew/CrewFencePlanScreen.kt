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
import com.fenceestimator.app.estimate.DrawingScale
import com.fenceestimator.app.estimate.PlanExtent
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
        // Read-only, so never re-pricing. This screen builds the drawing's
        // view model only to read the drawing, and its init used to start the
        // takeoff refresh on the crew's phone -- whose catalog has every price
        // scrubbed, so it picked different products and pushed its own
        // quantities over the office's on every sync.
        factory = GenericViewModelFactory {
            SurveyViewModel(app.repository, jobId, app, repriceOnDrawingChange = false)
        }
    )
    val job by viewModel.job.collectAsState()
    val runs by viewModel.runs.collectAsState()
    val markers by viewModel.siteMarkers.collectAsState()
    val topBar: @Composable () -> Unit = {
        TopAppBar(
            title = { Text(stringResource(R.string.crew_fence_plan)) },
            navigationIcon = {
                IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
            }
        )
    }
    // A job not yet in the local database and a job that never arrives look
    // the same to `job ?: return` -- a bare back arrow, no clue which one it
    // is. This waits out a slow cold start before calling it missing.
    if (job == null) {
        val loadTimedOut = com.fenceestimator.app.ui.components.rememberLoadTimedOut()
        Scaffold(topBar = topBar) { padding ->
            com.fenceestimator.app.ui.components.LoadingOrMissing(
                stillLoading = !loadTimedOut,
                notFoundText = stringResource(R.string.misc_crew_plan_not_on_phone),
                modifier = Modifier.padding(padding)
            )
        }
        return
    }
    val currentJob = job!!

    Scaffold(
        topBar = topBar
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(Space.screen),
            verticalArrangement = Arrangement.spacedBy(Space.section)
        ) {
            item {
                Text(
                    stringResource(R.string.crew_plan_read_only),
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

            // A run is on the plan when it has a fence line OR a gate. Only
            // lines counted once, so a gate sold on its own -- a run with no
            // corners -- was never drawn, and a job whose only run was that
            // gate showed no plan at all while its card said there was a gate
            // to hang.
            val drawn = runs.filter { PlanExtent.hasSomethingToDraw(it) }
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
                    stringResource(R.string.crew_plan_debris_rule),
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
            // The drawing's scale, the one the drawing screen measures at
            // (DrawingScale.of) -- what turns a gate's width in feet into a
            // width on the plan.
            val drawingScale = DrawingScale.of(job)
            // A gate with no fence line under it, laid level at its real width
            // where it was placed, exactly as the drawing screen lays it. Per
            // run, so each is drawn in its run's turn below.
            val standaloneByRun = runs.map { PlanExtent.standaloneGateSpans(listOf(it), drawingScale) }
            // Fitted to the fence lines, as it always was, and to both posts
            // of every gate standing on its own. With no scale (a photo nobody
            // has calibrated) such a gate has no width to draw, so its marker
            // alone is fitted and drawn.
            val allPoints = runs.flatMap { run ->
                val points = FenceCodec.decodePoints(run.pointsEncoded)
                if (points.size >= 2) points
                else FenceCodec.decodeGates(run.gatesEncoded).map { FencePoint(it.x, it.y) }
            } + standaloneByRun.flatten().flatMap { (_, span) -> listOf(span.start, span.end) }
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
                // The scale the drawing screen draws at (SurveyViewModel.drawingScale),
                // so a square here is the square the office drew on. The raw
                // calibration fell back to a flat 20 units per foot, which on
                // an uncalibrated grid of any other size drew the squares at
                // the wrong spacing.
                val pxPerFoot = SurveyViewModel.drawingScale(job) ?: SurveyViewModel.PIXELS_PER_FOOT_GRID
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

                runs.forEachIndexed { runIndex, run ->
                    val points = FenceCodec.decodePoints(run.pointsEncoded)

                    if (points.size >= 2) {
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
                    }

                    // A gate standing on its own: the opening at its real
                    // width and the two posts it hangs between, which are what
                    // the crew sets in concrete. Under the gate's own marker,
                    // drawn next, so it reads as the same gate as every other.
                    standaloneByRun[runIndex].forEach { (_, span) ->
                        val from = place(span.start)
                        val to = place(span.end)
                        drawLine(PlanColors.gate, from, to, strokeWidth = 6f)
                        drawCircle(PlanColors.gate, radius = 9f, center = from)
                        drawCircle(PlanColors.gate, radius = 9f, center = to)
                    }

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
    // Only runs with a line put a line on the plan; a gate-only run is here
    // for its gate, which the gate dot already explains. On such a job that
    // dot IS the plan's explanation, so its label is translated like every
    // other one here -- it was the last English word left on a Spanish or
    // French crew phone's plan.
    val lined = remember(runs) { runs.filter { FenceCodec.decodePoints(it.pointsEncoded).size >= 2 } }
    val hasBuildLine = remember(lined) { lined.any { !it.isTeardown } }
    val hasTeardownLine = remember(lined) { lined.any { it.isTeardown } }
    val presentMarkerKinds = remember(markers) { markers.map { it.kind }.distinct() }

    Column(verticalArrangement = Arrangement.spacedBy(Space.xs)) {
        Row(horizontalArrangement = Arrangement.spacedBy(Space.lg)) {
            if (hasBuildLine) LegendDot(PlanColors.fenceLine, stringResource(R.string.crew_plan_legend_build))
            if (hasTeardownLine) LegendDot(PlanColors.teardownLine, stringResource(R.string.crew_plan_legend_teardown))
            LegendDot(PlanColors.gate, stringResource(R.string.crew_plan_legend_gate))
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
    // Same scale as the drawing screen's dimensions (see PlanCanvas above).
    val pxPerFt = SurveyViewModel.drawingScale(job) ?: SurveyViewModel.PIXELS_PER_FOOT_GRID
    val geometry = if (points.size >= 2) FenceGeometryEngine.analyze(points, pxPerFt, run.closedLoop) else null
    val feet = if (usingManual) manual!!.toDouble() else geometry?.totalLinearFeet?.toDouble() ?: 0.0
    val corners = if (usingManual) run.manualCornerCount else geometry?.cornerCount ?: 0

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(Space.card), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Text(run.label.ifBlank { stringResource(R.string.crew_plan_run_untitled) }, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)

            if (feet <= 0.0) {
                Text(
                    stringResource(R.string.crew_plan_not_measured),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error
                )
                return@Column
            }

            SpecRow(stringResource(R.string.crew_plan_spec_type), run.fenceType.label())
            SpecRow(
                stringResource(R.string.crew_plan_spec_length),
                "${"%.0f".format(feet)} ft" +
                    if (usingManual) stringResource(R.string.crew_plan_measured_on_site) else ""
            )
            SpecRow(stringResource(R.string.crew_plan_spec_height), "${run.panelHeightFt.toInt()} ft")
            if (run.colorOrFinish.isNotBlank())
                SpecRow(stringResource(R.string.crew_plan_spec_color), run.colorOrFinish)
            SpecRow(stringResource(R.string.crew_plan_spec_spacing), "${run.postSpacingFt.toInt()} ft")
            SpecRow(
                stringResource(R.string.crew_plan_spec_concrete),
                stringResource(R.string.crew_plan_bags_per_post, run.concreteBagsPerPost.toString())
            )
            SpecRow(stringResource(R.string.crew_plan_spec_corners), corners.toString())
            if (geometry != null)
                SpecRow(stringResource(R.string.crew_plan_spec_ends), geometry.endCount.toString())
            SpecRow(stringResource(R.string.crew_plan_spec_gates), gates.size.toString())
            if (gates.isNotEmpty()) {
                Text(
                    stringResource(
                        R.string.crew_plan_gate_widths,
                        gates.joinToString(", ") { "${"%.0f".format(it.widthFt)} ft" }
                    ),
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
                stringResource(R.string.crew_plan_watch_out),
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
    // The request had no job left to go with (see the send below), so it was
    // not saved -- and the card must not say it was.
    var jobGone by remember { mutableStateOf(false) }
    val scope = androidx.compose.runtime.rememberCoroutineScope()

    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
    ) {
        Column(Modifier.padding(Space.card), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Text(
                stringResource(
                    when {
                        jobGone -> R.string.crew_plan_not_sent
                        sent -> R.string.crew_plan_change_requested
                        else -> R.string.crew_plan_something_wrong
                    }
                ),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSecondaryContainer
            )
            Text(
                stringResource(
                    when {
                        jobGone -> R.string.crew_plan_job_gone
                        sent -> R.string.crew_plan_office_has_it
                        else -> R.string.crew_plan_ask_office
                    }
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSecondaryContainer
            )
            // Asking again would only fail the same way: the job is not coming
            // back to this screen.
            if (!sent && !jobGone) {
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
                        // Read now: the dialog, and the state behind these
                        // boxes, is gone by the time the save runs.
                        val summary = what.trim()
                        val detail = why.trim()
                        showDialog = false
                        scope.launch {
                            // A job the sync removed while this screen was
                            // open has no row for the request to hang off:
                            // the insert hit the foreign key and took the
                            // app down. Skipped instead -- see OrphanRows.
                            // "Sent" only once it is saved: this used to be
                            // set whatever happened, so a request thrown away
                            // here read "Change requested ... the office has
                            // it" to the person who asked.
                            val saved = com.fenceestimator.app.cloud.skipIfOrphaned {
                                app.repository.requestPlanChange(
                                    jobId = jobId,
                                    summary = summary,
                                    detail = detail,
                                    by = session.email.orEmpty(),
                                    role = session.role.label
                                )
                            }
                            if (saved == null) {
                                jobGone = true
                                return@launch
                            }
                            sent = true
                            app.autoSync.requestSync()
                        }
                    }
                ) { Text(stringResource(R.string.crew_send_request)) }
            },
            dismissButton = {
                OutlinedButton(onClick = { showDialog = false }) { Text(stringResource(R.string.action_cancel)) }
            }
        )
    }
}
