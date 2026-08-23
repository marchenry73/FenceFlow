package com.fenceestimator.app.ui.crew

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.ui.res.stringResource
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
import com.fenceestimator.app.R
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
    val finalWalkthrough = steps.filter { it.kind == JobStepKind.FINAL_WALKTHROUGH }
    val install = steps.filter { it.kind == JobStepKind.INSTALL }

    // Whether they are finishing tonight or coming back.
    //
    // Estimated hours does not answer that, and it is the question that decides
    // whether the crew start hanging gates at four o clock or pack up clean for
    // tomorrow. Working day comes from the company settings, less breaks --
    // a schedule built on somebody else numbers is a schedule that slips.
    val crewProfile by app.settingsStore.profile.collectAsState(
        initial = com.fenceestimator.app.data.BusinessProfile()
    )
    val dayPlan = com.fenceestimator.app.estimate.JobSchedule.plan(
        job = currentJob,
        workdayHours = (crewProfile.workdayHours - crewProfile.breakHoursPerDay).coerceAtLeast(1.0)
    )

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.crew_job_number, currentJob.id)) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back)) } }
            )
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxWidth().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            // First thing on the screen, because it changes how the day is
            // worked. Knowing at eight in the morning that this is day two of
            // three is the difference between pacing the work and finding out
            // at five that the gates are not going on today.
            // Before anything else on the crew's screen.
            //
            // This is the one thing on this page that can cost more than the
            // job is worth, and the crew are the people actually putting holes
            // in the ground -- so it goes above the day plan, not below it.
            // Silent when the ticket is fine: a warning that shows every day
            // is one nobody reads on the day it matters.
            if (com.fenceestimator.app.estimate.LocateTicket.shouldWarnBeforeDigging(currentJob) ||
                com.fenceestimator.app.estimate.LocateTicket.expiringSoon(currentJob)
            ) {
                item {
                    Card(
                        Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(
                            containerColor =
                                if (com.fenceestimator.app.estimate.LocateTicket.stateOf(currentJob) ==
                                    com.fenceestimator.app.estimate.LocateTicket.State.CLEAR
                                ) MaterialTheme.colorScheme.tertiaryContainer
                                else MaterialTheme.colorScheme.errorContainer
                        )
                    ) {
                        Column(Modifier.padding(14.dp)) {
                            Text(
                                stringResource(R.string.misc_crew_before_you_dig),
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.Bold
                            )
                            Text(
                                com.fenceestimator.app.estimate.LocateTicket.message(currentJob),
                                style = MaterialTheme.typography.bodyMedium
                            )
                            if (currentJob.locateNotes.isNotBlank()) {
                                Text(
                                    stringResource(R.string.misc_crew_marked, currentJob.locateNotes),
                                    style = MaterialTheme.typography.bodySmall
                                )
                            }
                        }
                    }
                }
            }

            item {
                Card(
                    Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = if (dayPlan.isFinalDay || dayPlan.totalDays <= 1)
                            MaterialTheme.colorScheme.secondaryContainer
                        else MaterialTheme.colorScheme.tertiaryContainer
                    )
                ) {
                    Column(Modifier.padding(14.dp)) {
                        Text(
                            dayPlan.crewSummary,
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.Bold
                        )
                        if (!dayPlan.isFinalDay && dayPlan.totalDays > 1) {
                            Text(
                                stringResource(R.string.misc_crew_back_tomorrow),
                                style = MaterialTheme.typography.bodySmall
                            )
                        }
                    }
                }
            }

            item {
                Card(
                    Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)
                ) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            currentJob.customerName.ifBlank { stringResource(R.string.section_customer) },
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
                                    Text("  " + stringResource(R.string.crew_directions))
                                }
                            }
                            OutlinedButton(onClick = { onOpenSurvey(jobId) }) {
                                Icon(Icons.Filled.Map, contentDescription = null)
                                Text("  " + stringResource(R.string.crew_fence_plan))
                            }
                        }
                        if (currentJob.phone.isNotBlank()) {
                            OutlinedButton(
                                onClick = {
                                    IntentHelpers.openSmsDraft(
                                        context,
                                        currentJob.phone,
                                        context.getString(
                                            R.string.misc_crew_on_my_way_sms,
                                            currentJob.customerName.ifBlank { context.getString(R.string.misc_crew_fallback_there) },
                                            currentJob.address.ifBlank { context.getString(R.string.misc_crew_fallback_your_property) }
                                        )
                                    )
                                },
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Icon(Icons.Filled.Send, contentDescription = null)
                                Text("  " + stringResource(R.string.crew_text_on_my_way))
                            }
                        }
                    }
                }
            }

            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(stringResource(R.string.crew_what_building), style = MaterialTheme.typography.titleMedium)
                        if (runs.isEmpty()) {
                            Text(
                                stringResource(R.string.misc_crew_no_runs),
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

                            Text(run.label.ifBlank { stringResource(R.string.misc_crew_untitled_run) }, fontWeight = FontWeight.Medium)
                            if (feet <= 0.0) {
                                Text(
                                    stringResource(R.string.misc_crew_nothing_measured),
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.error
                                )
                            } else {
                                val feetText = stringResource(R.string.misc_feet_value, "%.0f".format(feet))
                                val tallText = stringResource(R.string.misc_crew_feet_tall, run.panelHeightFt.toInt())
                                Text(
                                    buildString {
                                        append(run.fenceType.name.replace("_", " "))
                                        append(" · $feetText")
                                        append(" · $tallText")
                                        if (run.colorOrFinish.isNotBlank()) append(" · ${run.colorOrFinish}")
                                    },
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                                Text(
                                    stringResource(
                                        R.string.misc_crew_run_details,
                                        corners, gates.size, run.postSpacingFt.toInt()
                                    ),
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
                    if (pay.amount > 0.0 || pay.hoursAwaitingApproval > 0.0) {
                        Card(
                            Modifier.fillMaxWidth().padding(top = 10.dp),
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.secondaryContainer
                            )
                        ) {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(stringResource(R.string.crew_your_pay), style = MaterialTheme.typography.titleMedium)
                                Text(
                                    "$${"%.2f".format(pay.amount)}",
                                    style = MaterialTheme.typography.headlineSmall,
                                    fontWeight = FontWeight.Bold
                                )
                                Text(pay.explain(), style = MaterialTheme.typography.bodySmall)
                                // Said plainly rather than left as a gap. Hours
                                // that are simply missing from the total read as
                                // the app having lost the day worked.
                                if (pay.hoursAwaitingApproval > 0.0) {
                                    Text(
                                        stringResource(
                                            R.string.misc_crew_hours_awaiting,
                                            "%.2f".format(pay.hoursAwaitingApproval)
                                        ),
                                        style = MaterialTheme.typography.bodySmall,
                                        fontWeight = FontWeight.Medium,
                                        color = MaterialTheme.colorScheme.onSecondaryContainer
                                    )
                                }
                                if (pay.payType == com.fenceestimator.app.data.PayType.PER_FOOT &&
                                    pay.effectiveHourly > 0.0
                                ) {
                                    Text(
                                        stringResource(R.string.misc_crew_works_out_hourly, "%.2f".format(pay.effectiveHourly)),
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
                    title = stringResource(R.string.crew_walkthrough),
                    subtitle = stringResource(R.string.misc_crew_walkthrough_subtitle),
                    steps = walkthrough,
                    onToggle = { viewModel.toggleStep(it) }
                )
            }

            item {
                StepSection(
                    title = stringResource(R.string.crew_install_steps),
                    subtitle = null,
                    steps = install,
                    onToggle = { viewModel.toggleStep(it) }
                )
            }

            item {
                StepSection(
                    title = stringResource(R.string.misc_crew_final_walkthrough_title),
                    subtitle = stringResource(R.string.misc_crew_final_walkthrough_subtitle),
                    steps = finalWalkthrough,
                    onToggle = { viewModel.toggleStep(it) }
                )
            }

            item {
                FinalSignOffCard(
                    job = currentJob,
                    steps = finalWalkthrough,
                    onSign = { path -> viewModel.captureFinalSignOff(path) }
                )
            }

            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(stringResource(R.string.crew_photos), style = MaterialTheme.typography.titleMedium)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            listOf(PhotoKind.BEFORE, PhotoKind.AFTER).forEach { kind ->
                                OutlinedButton(onClick = {
                                    pendingKind = kind
                                    val target = PhotoFiles.newTarget(context, "photos")
                                    pendingTarget = target
                                    cameraLauncher.launch(target.uri)
                                }) {
                                    Icon(Icons.Filled.CameraAlt, contentDescription = null)
                                    Text("  " + stringResource(if (kind == PhotoKind.BEFORE) R.string.misc_photo_before else R.string.misc_photo_after))
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
                    Text(stringResource(if (allDone) R.string.crew_mark_complete else R.string.crew_finish_steps_first))
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
            Text(stringResource(R.string.crew_time_clock), style = MaterialTheme.typography.titleMedium)

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
                    stringResource(R.string.misc_crew_on_clock_since, timeFormat.format(java.util.Date(running.startedAt))),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Button(onClick = onClockOut, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.crew_clock_out)) }
            } else {
                Button(onClick = onClockIn, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.crew_clock_in)) }
            }

            if (totalHours > 0.0) {
                Text(
                    stringResource(R.string.misc_crew_logged_hours, "%.2f".format(totalHours)),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium
                )
            }
            entries.filter { !it.isRunning }.take(5).forEach { entry ->
                Text(
                    stringResource(
                        R.string.misc_crew_time_range,
                        timeFormat.format(java.util.Date(entry.startedAt)),
                        entry.endedAt?.let { timeFormat.format(java.util.Date(it)) } ?: ""
                    ) + "  " + stringResource(R.string.misc_crew_hours_paren, "%.2f".format(entry.hours)),
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
    onToggle: (JobStep) -> Unit
) {
    val done = steps.count { it.checked }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            subtitle?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (steps.isNotEmpty()) {
                Text(stringResource(R.string.crew_progress, done, steps.size), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
                        // One tick per item, deliberately. Ticking a box and
                        // then separately marking it "confirmed" was two
                        // confirmations for one fact, so people did one or the
                        // other and neither meant anything. The customer
                        // signature at the end is what makes it binding.
                    }
                }
            }
        }
    }
}


/**
 * The customer's signature closing the job out.
 *
 * Held back until the closing checklist is actually done, because a signature
 * collected before anyone walked the fence records nothing except that someone
 * held out a phone.
 */
@Composable
private fun FinalSignOffCard(
    job: com.fenceestimator.app.data.Job,
    steps: List<JobStep>,
    onSign: (String) -> Unit
) {
    var showPad by remember { mutableStateOf(false) }
    val remaining = steps.count { !it.checked }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(stringResource(R.string.crew_sign_off_title), style = MaterialTheme.typography.titleMedium)

            if (job.finalSignOffImagePath != null) {
                Text(
                    stringResource(R.string.misc_crew_signed_off),
                    style = MaterialTheme.typography.bodyMedium
                )
                coil.compose.AsyncImage(
                    model = job.finalSignOffImagePath,
                    contentDescription = stringResource(R.string.misc_crew_sign_off_signature_desc),
                    modifier = Modifier.height(60.dp)
                )
            } else {
                Text(
                    if (remaining > 0)
                        stringResource(R.string.misc_crew_finish_remaining, remaining)
                    else
                        stringResource(R.string.misc_crew_walkthrough_done),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Button(
                    onClick = { showPad = true },
                    enabled = remaining == 0,
                    modifier = Modifier.fillMaxWidth()
                ) { Text(stringResource(R.string.crew_sign_off_button)) }
            }
        }
    }

    if (showPad) {
        com.fenceestimator.app.ui.components.SignaturePadDialog(
            onSave = { path -> onSign(path); showPad = false },
            onDismiss = { showPad = false }
        )
    }
}
