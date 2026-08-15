package com.fenceestimator.app.ui.crew

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Directions
import androidx.compose.material.icons.filled.Map
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage
import com.fenceestimator.app.data.JobStep
import com.fenceestimator.app.data.JobStepKind
import com.fenceestimator.app.data.PhotoKind
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FenceGeometryEngine
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.IntentHelpers
import com.fenceestimator.app.ui.components.NewPhotoTarget
import com.fenceestimator.app.ui.components.PhotoFiles
import com.fenceestimator.app.ui.components.currentApp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CrewJobScreen(jobId: Long, onBack: () -> Unit, onOpenSurvey: (Long) -> Unit) {
    val app = currentApp()
    val context = LocalContext.current
    val viewModel: CrewJobViewModel = viewModel(
        key = "crew_$jobId",
        factory = GenericViewModelFactory { CrewJobViewModel(app.repository, jobId) }
    )
    val job by viewModel.job.collectAsState()
    val runs by viewModel.runs.collectAsState()
    val steps by viewModel.steps.collectAsState()
    val photos by viewModel.photos.collectAsState()
    val currentJob = job ?: return

    var pendingKind by remember { mutableStateOf(PhotoKind.BEFORE) }
    var pendingTarget by remember { mutableStateOf<NewPhotoTarget?>(null) }
    val cameraLauncher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { success ->
        if (success) pendingTarget?.let { viewModel.addPhoto(pendingKind, it.absolutePath) }
        pendingTarget = null
    }

    val walkthrough = steps.filter { it.kind == JobStepKind.WALKTHROUGH }
    val install = steps.filter { it.kind == JobStepKind.INSTALL }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Job #${currentJob.id}") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") } }
            )
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxWidth().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            item {
                Card(
                    Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)
                ) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            currentJob.customerName.ifBlank { "Customer" },
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.onPrimaryContainer
                        )
                        Text(currentJob.address, color = MaterialTheme.colorScheme.onPrimaryContainer)
                        if (currentJob.phone.isNotBlank()) {
                            Text(currentJob.phone, color = MaterialTheme.colorScheme.onPrimaryContainer)
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                            if (currentJob.address.isNotBlank()) {
                                OutlinedButton(onClick = { IntentHelpers.searchNearby(context, currentJob.address) }) {
                                    Icon(Icons.Filled.Directions, contentDescription = null)
                                    Text("  Directions")
                                }
                            }
                            OutlinedButton(onClick = { onOpenSurvey(jobId) }) {
                                Icon(Icons.Filled.Map, contentDescription = null)
                                Text("  Fence Plan")
                            }
                        }
                        if (currentJob.phone.isNotBlank()) {
                            OutlinedButton(
                                onClick = {
                                    IntentHelpers.openSmsDraft(
                                        context,
                                        currentJob.phone,
                                        "Hi ${currentJob.customerName.ifBlank { "there" }}, we're on our way to " +
                                            "${currentJob.address.ifBlank { "your property" }} now. See you shortly."
                                    )
                                },
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Icon(Icons.Filled.Send, contentDescription = null)
                                Text("  Text \"On My Way\"")
                            }
                        }
                    }
                }
            }

            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("What We're Building", style = MaterialTheme.typography.titleMedium)
                        if (runs.isEmpty()) {
                            Text(
                                "No fence runs on this job yet.",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        runs.forEach { run ->
                            val points = FenceCodec.decodePoints(run.pointsEncoded)
                            // Fall back to the grid's fixed scale rather than showing 0 ft.
                            // A crew reading "0 ft of fence" has no idea whether that means
                            // nothing was drawn or the scale was simply never set.
                            val pxPerFt = currentJob.calibrationPixelsPerFoot
                                ?: com.fenceestimator.app.ui.survey.SurveyViewModel.PIXELS_PER_FOOT_GRID
                            val geometry = FenceGeometryEngine.analyze(points, pxPerFt, run.closedLoop)
                            val gates = FenceCodec.decodeGates(run.gatesEncoded)

                            // A run quoted by typing its length has no drawing.
                            // Reporting "nothing drawn" there tells the crew the
                            // job isn't ready when it is.
                            val manual = run.manualLinearFeet
                            val usingManual = manual != null && manual > 0f
                            val feet = if (usingManual) manual!!.toDouble()
                            else geometry.totalLinearFeet.toDouble()
                            val corners = if (usingManual) run.manualCornerCount else geometry.cornerCount

                            Text(run.label.ifBlank { "Untitled run" }, fontWeight = FontWeight.Medium)
                            if (feet <= 0.0) {
                                Text(
                                    "Nothing measured for this run yet — check with the office.",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.error
                                )
                            } else {
                                Text(
                                    buildString {
                                        append(run.fenceType.name.replace("_", " "))
                                        append(" · ${"%.0f".format(feet)} ft")
                                        append(" · ${run.panelHeightFt.toInt()} ft tall")
                                        if (run.colorOrFinish.isNotBlank()) append(" · ${run.colorOrFinish}")
                                    },
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                                Text(
                                    "$corners corners · ${gates.size} gate(s) · " +
                                        "posts ${run.postSpacingFt.toInt()} ft apart",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                    }
                }
            }

            item {
                val entries by viewModel.timeEntries.collectAsState()
                val crew by viewModel.employees.collectAsState()
                TimeClockCard(
                    entries = entries,
                    onClockIn = { viewModel.clockIn() },
                    onClockOut = { viewModel.clockOut() }
                )
                val assigned = crew.firstOrNull { it.id == currentJob.assignedEmployeeId }
                if (assigned != null) {
                    val pxPerFt = currentJob.calibrationPixelsPerFoot
                        ?: com.fenceestimator.app.ui.survey.SurveyViewModel.PIXELS_PER_FOOT_GRID
                    val pay = com.fenceestimator.app.estimate.CrewPay
                        .forJob(assigned, entries, runs, pxPerFt)
                    if (pay.amount > 0.0) {
                        Card(
                            Modifier.fillMaxWidth().padding(top = 10.dp),
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.secondaryContainer
                            )
                        ) {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text("Your Pay — This Job", style = MaterialTheme.typography.titleMedium)
                                Text(
                                    "$${"%.2f".format(pay.amount)}",
                                    style = MaterialTheme.typography.headlineSmall,
                                    fontWeight = FontWeight.Bold
                                )
                                Text(pay.explain(), style = MaterialTheme.typography.bodySmall)
                                if (pay.payType == com.fenceestimator.app.data.PayType.PER_FOOT &&
                                    pay.effectiveHourly > 0.0
                                ) {
                                    Text(
                                        "Works out to $${"%.2f".format(pay.effectiveHourly)}/hr",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSecondaryContainer
                                    )
                                }
                            }
                        }
                    }
                }
            }

            item {
                StepSection(
                    title = "Walkthrough With Customer (before starting)",
                    subtitle = "Go through each item with the customer and tick it once they confirm.",
                    steps = walkthrough,
                    showVerify = true,
                    onToggle = { viewModel.toggleStep(it) },
                    onVerify = { step, v -> viewModel.setVerifiedWithCustomer(step, v) }
                )
            }

            item {
                StepSection(
                    title = "Install Steps",
                    subtitle = null,
                    steps = install,
                    showVerify = false,
                    onToggle = { viewModel.toggleStep(it) },
                    onVerify = { _, _ -> }
                )
            }

            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("Photos", style = MaterialTheme.typography.titleMedium)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            listOf(PhotoKind.BEFORE, PhotoKind.AFTER).forEach { kind ->
                                OutlinedButton(onClick = {
                                    pendingKind = kind
                                    val target = PhotoFiles.newTarget(context, "photos")
                                    pendingTarget = target
                                    cameraLauncher.launch(target.uri)
                                }) {
                                    Icon(Icons.Filled.CameraAlt, contentDescription = null)
                                    Text("  ${kind.name.lowercase().replaceFirstChar { it.uppercase() }}")
                                }
                            }
                        }
                        if (photos.isNotEmpty()) {
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                items(photos, key = { it.id }) { photo ->
                                    Box {
                                        AsyncImage(
                                            model = photo.filePath,
                                            contentDescription = null,
                                            contentScale = ContentScale.Crop,
                                            modifier = Modifier.size(90.dp).clip(RoundedCornerShape(8.dp))
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }

            item {
                val allDone = install.isNotEmpty() && install.all { it.checked }
                Button(
                    onClick = { viewModel.markJobComplete() },
                    enabled = allDone,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(if (allDone) "Mark Job Complete" else "Finish all install steps first")
                }
            }
        }
    }
}

@Composable
private fun TimeClockCard(
    entries: List<com.fenceestimator.app.data.TimeEntry>,
    onClockIn: () -> Unit,
    onClockOut: () -> Unit
) {
    val running = entries.firstOrNull { it.isRunning }
    val timeFormat = remember { java.text.SimpleDateFormat("h:mm a", java.util.Locale.US) }
    val totalHours = entries.filter { !it.isRunning }.sumOf { it.hours }

    // Re-reads the clock every second so a running shift visibly ticks up
    // rather than looking frozen.
    var nowTick by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(running?.id) {
        while (running != null) {
            nowTick = System.currentTimeMillis()
            kotlinx.coroutines.delay(1000)
        }
    }

    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (running != null) MaterialTheme.colorScheme.tertiaryContainer
            else MaterialTheme.colorScheme.surface
        )
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Time Clock", style = MaterialTheme.typography.titleMedium)

            if (running != null) {
                val elapsed = ((nowTick - running.startedAt).coerceAtLeast(0L)) / 1000
                val h = elapsed / 3600
                val m = (elapsed % 3600) / 60
                val s = elapsed % 60
                Text(
                    String.format(java.util.Locale.US, "%d:%02d:%02d", h, m, s),
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    "On the clock since ${timeFormat.format(java.util.Date(running.startedAt))}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Button(onClick = onClockOut, modifier = Modifier.fillMaxWidth()) { Text("Clock Out") }
            } else {
                Button(onClick = onClockIn, modifier = Modifier.fillMaxWidth()) { Text("Clock In") }
            }

            if (totalHours > 0.0) {
                Text(
                    "Logged on this job: ${"%.2f".format(totalHours)} hours",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium
                )
            }
            entries.filter { !it.isRunning }.take(5).forEach { entry ->
                Text(
                    "${timeFormat.format(java.util.Date(entry.startedAt))} - " +
                        "${entry.endedAt?.let { timeFormat.format(java.util.Date(it)) } ?: ""}  " +
                        "(${"%.2f".format(entry.hours)} h)",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun StepSection(
    title: String,
    subtitle: String?,
    steps: List<JobStep>,
    showVerify: Boolean,
    onToggle: (JobStep) -> Unit,
    onVerify: (JobStep, Boolean) -> Unit
) {
    val done = steps.count { it.checked }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            subtitle?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (steps.isNotEmpty()) {
                Text("$done of ${steps.size} done", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                LinearProgressIndicator(
                    progress = { done.toFloat() / steps.size },
                    modifier = Modifier.fillMaxWidth()
                )
            }
            steps.forEach { step ->
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    Checkbox(checked = step.checked, onCheckedChange = { onToggle(step) })
                    Column(Modifier.weight(1f)) {
                        Text(
                            step.description,
                            style = MaterialTheme.typography.bodyMedium,
                            textDecoration = if (step.checked) TextDecoration.LineThrough else null,
                            color = if (step.checked) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface
                        )
                        if (showVerify) {
                            FilterChip(
                                selected = step.verifiedWithCustomer,
                                onClick = { onVerify(step, !step.verifiedWithCustomer) },
                                label = { Text(if (step.verifiedWithCustomer) "Customer confirmed" else "Mark confirmed") }
                            )
                        }
                    }
                }
            }
        }
    }
}
