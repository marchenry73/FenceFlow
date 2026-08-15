package com.fenceestimator.app.ui.jobs

import android.app.DatePickerDialog
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Construction
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Event
import androidx.compose.material.icons.filled.Inventory
import androidx.compose.material.icons.filled.Map
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.Receipt
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.foundation.layout.Spacer
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
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
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.ChangeOrder
import com.fenceestimator.app.data.Employee
import com.fenceestimator.app.data.Expense
import com.fenceestimator.app.data.ExpenseCategory
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.HoaApprovalStatus
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobPhoto
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.Manufacturer
import com.fenceestimator.app.cloud.PaymentsApi
import com.fenceestimator.app.ui.components.StageAction
import com.fenceestimator.app.data.PaymentStatus
import com.fenceestimator.app.data.PermitStatus
import com.fenceestimator.app.data.PunchListItem
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FenceGeometryEngine
import com.fenceestimator.app.data.PhotoKind
import com.fenceestimator.app.data.PricingTier
import com.fenceestimator.app.ui.components.AddressAutocompleteField
import com.fenceestimator.app.ui.components.DraftNumberField
import com.fenceestimator.app.ui.components.DraftTextField
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.IntentHelpers
import com.fenceestimator.app.ui.components.NewPhotoTarget
import com.fenceestimator.app.ui.components.PhotoFiles
import com.fenceestimator.app.ui.components.ProjectStatus
import com.fenceestimator.app.ui.components.TemplateFiller
import com.fenceestimator.app.ui.components.currentApp
import com.fenceestimator.app.ui.runs.FenceRunListViewModel
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun JobDetailScreen(
    jobId: Long,
    onBack: () -> Unit,
    onOpenSurvey: (Long) -> Unit,
    onOpenEstimate: (Long) -> Unit,
    onOpenRun: (Long) -> Unit,
    onOpenInventory: (Long) -> Unit,
    onOpenCrewView: (Long) -> Unit,
    onDeleted: () -> Unit
) {
    val app = currentApp()
    val context = LocalContext.current
    val viewModel: JobDetailViewModel = viewModel(
        key = "job_detail_$jobId",
        factory = GenericViewModelFactory { JobDetailViewModel(app.repository, jobId) }
    )
    val runsViewModel: FenceRunListViewModel = viewModel(
        key = "job_runs_$jobId",
        factory = GenericViewModelFactory { FenceRunListViewModel(app.repository, jobId) }
    )
    val job by viewModel.job.collectAsState()
    val runs by runsViewModel.runs.collectAsState()
    val pricingTiers by viewModel.pricingTiers.collectAsState()
    val manufacturers by viewModel.manufacturers.collectAsState()
    val photos by viewModel.photos.collectAsState()
    val employees by viewModel.employees.collectAsState()
    val expenses by viewModel.expenses.collectAsState()
    val punchList by viewModel.punchList.collectAsState()
    val changeOrders by viewModel.changeOrders.collectAsState()
    val timeEntries by viewModel.timeEntries.collectAsState()
    val profile by app.settingsStore.profile.collectAsState(initial = BusinessProfile())
    val session by app.session.state.collectAsState()
    val currentJob = job ?: return

    var showAddRunDialog by remember { mutableStateOf(false) }

    val listState = rememberLazyListState()
    val scope = androidx.compose.runtime.rememberCoroutineScope()

    // The order of the sections below, in one place. Some are hidden from crew
    // accounts, so a hardcoded index would land on the wrong card for them.
    // Only needs to run as far as the last section anything scrolls to.
    val sectionOrder = remember(session.canSeeMoney) {
        buildList {
            add(SECTION_PROGRESS); add("customer"); add("actions"); add("crew-view"); add("inventory"); add("runs")
            if (session.canSeeMoney) { add("pricing"); add("tier"); add("teardown") }
            add(SECTION_SCHEDULE)
            if (session.canSeeMoney) add("order")
            add(SECTION_HOA)
            if (session.canSeeMoney) { add("change-orders"); add(SECTION_PAYMENT) }
        }
    }
    fun scrollTo(key: String) {
        val index = sectionOrder.indexOf(key)
        if (index >= 0) scope.launch { listState.animateScrollToItem(index) }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(currentJob.customerName.ifBlank { "New Job" }) },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                }
            )
        }
    ) { padding ->
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxWidth().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            item(key = SECTION_PROGRESS) {
                SectionCard(title = "Project Progress") {
                    ProjectProgressSection(
                        job = currentJob,
                        punchListClear = punchList.isEmpty(),
                        profile = profile,
                        onGoToStage = { action ->
                            when (action) {
                                StageAction.DRAW -> onOpenSurvey(jobId)
                                StageAction.ESTIMATE -> onOpenEstimate(jobId)
                                StageAction.CREW_VIEW -> onOpenCrewView(jobId)
                                // These live further down this same screen, so
                                // take them there instead of naming a section
                                // and leaving them to hunt for it.
                                StageAction.PAYMENT -> scrollTo(SECTION_PAYMENT)
                                StageAction.HOA -> scrollTo(SECTION_HOA)
                                StageAction.SCHEDULE -> scrollTo(SECTION_SCHEDULE)
                                StageAction.NONE -> Unit
                            }
                        }
                    )
                }
            }
            item { SectionCard(title = "Customer") { CustomerFields(currentJob, viewModel) } }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedButton(
                        onClick = { onOpenSurvey(jobId) },
                        modifier = Modifier.weight(1f)
                    ) {
                        Icon(Icons.Filled.Map, contentDescription = null)
                        Text("  Survey & Draw")
                    }
                    if (session.canSeeMoney) {
                        Button(
                            onClick = { onOpenEstimate(jobId) },
                            modifier = Modifier.weight(1f)
                        ) {
                            Icon(Icons.Filled.Receipt, contentDescription = null)
                            Text("  Estimate")
                        }
                    }
                }
            }
            item {
                Button(onClick = { onOpenCrewView(jobId) }, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Filled.Construction, contentDescription = null)
                    Text("  Open Job-Day Crew View")
                }
            }
            item {
                OutlinedButton(onClick = { onOpenInventory(jobId) }, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Filled.Inventory, contentDescription = null)
                    Text("  Job-Day Inventory & Tools Checklist")
                }
            }
            item {
                SectionCard(title = "Fence Runs") {
                    if (runs.isEmpty()) {
                        Text(
                            "No fence runs yet. Add one for each section of fence (they can be different types).",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    runs.forEach { run ->
                        FenceRunRow(
                            run = run,
                            onClick = { onOpenRun(run.id) },
                            onDuplicate = { runsViewModel.duplicateRun(run) { } }
                        )
                    }
                    OutlinedButton(onClick = { showAddRunDialog = true }, modifier = Modifier.fillMaxWidth()) {
                        Icon(Icons.Filled.Add, contentDescription = null)
                        Text("  Add Fence Run")
                    }
                }
            }
            if (session.canSeeMoney) {
                item { SectionCard(title = "Pricing") { PricingFields(currentJob, viewModel) } }
                item { SectionCard(title = "Pricing Tier & Discount") { TierFields(currentJob, pricingTiers, viewModel) } }
                item { SectionCard(title = "Teardown of Existing Fence") { TeardownFields(currentJob, viewModel) } }
            }
            item(key = SECTION_SCHEDULE) {
                SectionCard(title = "Schedule & Crew") {
                    ScheduleFields(currentJob, runs, timeEntries, viewModel)
                    CrewFields(currentJob, employees, viewModel)
                }
            }
            if (session.canSeeMoney) {
                item {
                    SectionCard(title = "Order Materials") {
                        OrderFields(currentJob, manufacturers, profile, runs, viewModel)
                    }
                }
            }
            item(key = SECTION_HOA) { SectionCard(title = "HOA Approval & Permits") { HoaFields(currentJob, runs, profile, viewModel) } }
            if (session.canSeeMoney) {
                item { SectionCard(title = "Change Orders (extra work)") { ChangeOrdersSection(changeOrders, session.canEditCatalogAndSettings, viewModel) } }
                item(key = SECTION_PAYMENT) { SectionCard(title = "Payment & Invoice") { PaymentFields(currentJob, profile, viewModel) } }
                item { SectionCard(title = "Job Expenses") { ExpensesSection(expenses, session.canEditCatalogAndSettings, viewModel) } }
            }
            item { SectionCard(title = "Punch List / Callbacks") { PunchListSection(punchList, session.canEditCatalogAndSettings, viewModel) } }
            item {
                SectionCard(title = "Before / After Photos") {
                    PhotosSection(photos, session.canEditCatalogAndSettings, viewModel)
                }
            }
            item { SectionCard(title = "Ask for a Review") { ReviewRequestFields(currentJob, profile, viewModel) } }
            item { StatusSelector(currentJob, viewModel) }
            if (session.canEditCatalogAndSettings) {
                item {
                    OutlinedButton(
                        onClick = { viewModel.delete(onDeleted) },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Icon(Icons.Filled.Delete, contentDescription = null)
                        Text("  Delete Job")
                    }
                }
            }
        }
    }

    if (showAddRunDialog) {
        AddRunDialog(
            onConfirm = { label, type ->
                runsViewModel.addRun(label, type, profile) { id -> onOpenRun(id) }
                showAddRunDialog = false
            },
            onDismiss = { showAddRunDialog = false }
        )
    }
}

@Composable
private fun FenceRunRow(run: FenceRun, onClick: () -> Unit, onDuplicate: () -> Unit) {
    Card(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f)) {
                Text(run.label.ifBlank { "Untitled run" }, fontWeight = FontWeight.Medium)
                Text(
                    run.fenceType.name.replace("_", " "),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            IconButton(onClick = onDuplicate) {
                Icon(Icons.Filled.ContentCopy, contentDescription = "Duplicate run")
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AddRunDialog(onConfirm: (String, FenceType) -> Unit, onDismiss: () -> Unit) {
    var label by remember { mutableStateOf("") }
    var type by remember { mutableStateOf(FenceType.VINYL) }
    var expanded by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add Fence Run") },
        text = {
            Column {
                OutlinedTextField(
                    value = label, onValueChange = { label = it },
                    label = { Text("Label (e.g. \"Back Yard\")") },
                    modifier = Modifier.fillMaxWidth()
                )
                androidx.compose.foundation.layout.Spacer(Modifier.height(8.dp))
                ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
                    OutlinedTextField(
                        value = type.name.replace("_", " "), onValueChange = {}, readOnly = true,
                        label = { Text("Fence type") },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
                        modifier = Modifier.fillMaxWidth().menuAnchor()
                    )
                    DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                        FenceType.values().filter { it != FenceType.UNIVERSAL }.forEach { t ->
                            DropdownMenuItem(
                                text = { Text(t.name.replace("_", " ")) },
                                onClick = { type = t; expanded = false }
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = { onConfirm(label.ifBlank { type.name.replace("_", " ") }, type) }) { Text("Add") }
        },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text("Cancel") } }
    )
}

@Composable
private fun SectionCard(title: String, content: @Composable () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

@Composable
private fun CustomerFields(job: Job, viewModel: JobDetailViewModel) {
    DraftTextField(
        stableKey = job.id, initialValue = job.customerName, label = "Customer name",
        modifier = Modifier.fillMaxWidth()
    ) { viewModel.update { j -> j.copy(customerName = it) } }
    AddressAutocompleteField(
        stableKey = job.id, initialValue = job.address, label = "Property address",
        modifier = Modifier.fillMaxWidth()
    ) { viewModel.update { j -> j.copy(address = it) } }
    DraftTextField(
        stableKey = job.id, initialValue = job.phone, label = "Phone",
        keyboardType = KeyboardType.Phone, modifier = Modifier.fillMaxWidth()
    ) { viewModel.update { j -> j.copy(phone = it) } }
    DraftTextField(
        stableKey = job.id, initialValue = job.email, label = "Email",
        keyboardType = KeyboardType.Email, modifier = Modifier.fillMaxWidth()
    ) { viewModel.update { j -> j.copy(email = it) } }
    DraftTextField(
        stableKey = job.id, initialValue = job.notes, label = "Notes",
        minLines = 2, modifier = Modifier.fillMaxWidth()
    ) { viewModel.update { j -> j.copy(notes = it) } }
    DraftTextField(
        stableKey = job.id, initialValue = job.referralSource, label = "How did they hear about us?",
        modifier = Modifier.fillMaxWidth()
    ) { viewModel.update { j -> j.copy(referralSource = it) } }
}

@Composable
private fun PricingFields(job: Job, viewModel: JobDetailViewModel) {
    // Markup and labor are rewritten when a pricing tier is applied, so these
    // must re-seed on a tier change or they'd display stale numbers.
    val tierKey = "${job.id}-${job.pricingTierName}"
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        DraftNumberField(
            stableKey = job.id, label = "Tax rate (%)", initialValue = job.taxRatePercent.toFloat(),
            modifier = Modifier.weight(1f)
        ) { viewModel.update { j -> j.copy(taxRatePercent = it.toDouble()) } }
        DraftNumberField(
            stableKey = tierKey, label = "Markup (%)", initialValue = job.markupPercent.toFloat(),
            modifier = Modifier.weight(1f)
        ) { viewModel.update { j -> j.copy(markupPercent = it.toDouble()) } }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        DraftNumberField(
            stableKey = tierKey, label = "Labor $/ft", initialValue = job.laborRatePerFt.toFloat(),
            modifier = Modifier.weight(1f)
        ) { viewModel.update { j -> j.copy(laborRatePerFt = it.toDouble()) } }
        DraftNumberField(
            stableKey = tierKey, label = "Labor flat fee ($)", initialValue = job.laborFlatFee.toFloat(),
            modifier = Modifier.weight(1f)
        ) { viewModel.update { j -> j.copy(laborFlatFee = it.toDouble()) } }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun StatusSelector(job: Job, viewModel: JobDetailViewModel) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = job.status.name, onValueChange = {}, readOnly = true,
            label = { Text("Status") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor()
        )
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            JobStatus.values().forEach { status ->
                DropdownMenuItem(
                    text = { Text(status.name) },
                    onClick = { viewModel.setStatus(status); expanded = false }
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TierFields(job: Job, tiers: List<PricingTier>, viewModel: JobDetailViewModel) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = job.pricingTierName.ifBlank { "Custom" }, onValueChange = {}, readOnly = true,
            label = { Text("Apply pricing tier") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor()
        )
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            tiers.forEach { tier ->
                DropdownMenuItem(text = { Text(tier.name) }, onClick = { viewModel.applyTier(tier); expanded = false })
            }
        }
    }
    // Keyed on the tier name as well as the job: applying a tier rewrites these
    // values, and a field keyed only on job.id would keep showing the old
    // numbers because the draft is seeded once and never re-read.
    val tierKey = "${job.id}-${job.pricingTierName}"
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        DraftNumberField(
            stableKey = tierKey, label = "Discount (%)", initialValue = job.discountPercent.toFloat(),
            modifier = Modifier.weight(1f)
        ) { viewModel.update { j -> j.copy(discountPercent = it.toDouble()) } }
        DraftNumberField(
            stableKey = job.id, label = "Minimum job charge ($)", initialValue = job.minimumJobCharge.toFloat(),
            modifier = Modifier.weight(1f)
        ) { viewModel.update { j -> j.copy(minimumJobCharge = it.toDouble()) } }
    }
    if (job.pricingTierName.isNotBlank()) {
        Text(
            "${job.pricingTierName}: labor \$${"%.2f".format(job.laborRatePerFt)}/ft · " +
                "markup ${"%.0f".format(job.markupPercent)}%" +
                if (job.discountPercent > 0) " · discount ${"%.0f".format(job.discountPercent)}%" else "",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.primary
        )
    }
}

@Composable
private fun TeardownFields(job: Job, viewModel: JobDetailViewModel) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Include teardown of existing fence", modifier = Modifier.weight(1f))
        Switch(checked = job.teardownEnabled, onCheckedChange = { viewModel.update { j -> j.copy(teardownEnabled = it) } })
    }
    if (job.teardownEnabled) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            DraftNumberField(
                stableKey = job.id, label = "Teardown flat fee ($)", initialValue = job.teardownFlatFee.toFloat(),
                modifier = Modifier.weight(1f)
            ) { viewModel.update { j -> j.copy(teardownFlatFee = it.toDouble()) } }
            DraftNumberField(
                stableKey = job.id, label = "Teardown \$/ft", initialValue = job.teardownRatePerFt.toFloat(),
                modifier = Modifier.weight(1f)
            ) { viewModel.update { j -> j.copy(teardownRatePerFt = it.toDouble()) } }
        }
    }
}

@Composable
private fun ScheduleFields(
    job: Job,
    runs: List<FenceRun>,
    timeEntries: List<com.fenceestimator.app.data.TimeEntry>,
    viewModel: JobDetailViewModel
) {
    val context = LocalContext.current
    val dateFormat = remember { SimpleDateFormat("EEE, MMM d, yyyy", Locale.US) }

    Button(
        onClick = {
            val cal = Calendar.getInstance()
            job.scheduledDate?.let { cal.timeInMillis = it }
            DatePickerDialog(
                context,
                { _, year, month, day ->
                    val chosen = Calendar.getInstance()
                    chosen.set(year, month, day, 8, 0, 0)
                    viewModel.update { j -> j.copy(scheduledDate = chosen.timeInMillis) }
                },
                cal.get(Calendar.YEAR), cal.get(Calendar.MONTH), cal.get(Calendar.DAY_OF_MONTH)
            ).show()
        },
        modifier = Modifier.fillMaxWidth()
    ) {
        Icon(Icons.Filled.Event, contentDescription = null)
        Text("  " + (job.scheduledDate?.let { "Scheduled: ${dateFormat.format(Date(it))}" } ?: "Set Job Date"))
    }

    val pxPerFt = job.calibrationPixelsPerFoot
        ?: com.fenceestimator.app.ui.survey.SurveyViewModel.PIXELS_PER_FOOT_GRID
    val estimate = remember(job, runs) {
        com.fenceestimator.app.estimate.DurationEstimator.estimate(job, runs, pxPerFt)
    }

    DraftNumberField(
        stableKey = job.id, label = "Estimated duration (hours)", initialValue = job.estimatedDurationHours.toFloat(),
        modifier = Modifier.fillMaxWidth()
    ) { viewModel.update { j -> j.copy(estimatedDurationHours = it.toDouble()) } }

    if (estimate.totalHours > 0.0) {
        Text(
            "Calculated: ${estimate.summary()}",
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium
        )
        Text(
            "Based on 125 ft per 8-hour day, adjusted for fence type, corners, gates and teardown.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        OutlinedButton(
            onClick = {
                viewModel.update { j -> j.copy(estimatedDurationHours = estimate.totalHours) }
            },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Use calculated ${"%.1f".format(estimate.totalHours)} hours")
        }
    } else {
        Text(
            "Draw the fence on the Survey screen and the app will work out how long it should take.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }

    // Once time has been clocked, show planned against actual so the estimate
    // improves with each job instead of staying a guess.
    val loggedHours = timeEntries.filter { !it.isRunning }.sumOf { it.hours }
    if (loggedHours > 0.0) {
        val planned = if (job.estimatedDurationHours > 0) job.estimatedDurationHours else estimate.totalHours
        val diff = loggedHours - planned
        Text(
            "Actually took ${"%.1f".format(loggedHours)} hrs" +
                if (planned > 0) " — ${if (diff > 0) "${"%.1f".format(diff)} over" else "${"%.1f".format(-diff)} under"} the estimate" else "",
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
            color = if (diff > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
        )
    }

    val scheduledDate = job.scheduledDate
    if (scheduledDate != null) {
        OutlinedButton(
            onClick = {
                IntentHelpers.addToCalendar(
                    context = context,
                    title = "Fence Install -- ${job.customerName.ifBlank { "Customer" }}",
                    description = job.notes,
                    location = job.address,
                    startMillis = scheduledDate,
                    durationHours = job.estimatedDurationHours
                )
            },
            modifier = Modifier.fillMaxWidth()
        ) {
            Icon(Icons.Filled.CalendarMonth, contentDescription = null)
            Text("  Add to Calendar")
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CrewFields(job: Job, employees: List<Employee>, viewModel: JobDetailViewModel) {
    var expanded by remember { mutableStateOf(false) }
    val selected = employees.firstOrNull { it.id == job.assignedEmployeeId }

    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = selected?.name ?: "Unassigned", onValueChange = {}, readOnly = true,
            label = { Text("Assigned crew member") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor()
        )
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            DropdownMenuItem(
                text = { Text("Unassigned") },
                onClick = { viewModel.update { j -> j.copy(assignedEmployeeId = null) }; expanded = false }
            )
            employees.forEach { e ->
                DropdownMenuItem(
                    text = { Text(e.name.ifBlank { "Unnamed" } + if (e.role.isNotBlank()) " · ${e.role}" else "") },
                    onClick = { viewModel.update { j -> j.copy(assignedEmployeeId = e.id) }; expanded = false }
                )
            }
            if (employees.isEmpty()) {
                DropdownMenuItem(text = { Text("No crew added yet -- see Employees in Settings") }, onClick = { expanded = false })
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OrderFields(
    job: Job,
    manufacturers: List<Manufacturer>,
    profile: BusinessProfile,
    runs: List<FenceRun>,
    viewModel: JobDetailViewModel
) {
    val context = LocalContext.current
    var expanded by remember { mutableStateOf(false) }
    val selected = manufacturers.firstOrNull { it.id == job.preferredManufacturerId }
        ?: manufacturers.firstOrNull { it.id == profile.preferredManufacturerId }

    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = selected?.name ?: "No manufacturer selected", onValueChange = {}, readOnly = true,
            label = { Text("Order from") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor()
        )
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            manufacturers.forEach { m ->
                DropdownMenuItem(text = { Text(m.name) }, onClick = { viewModel.update { j -> j.copy(preferredManufacturerId = m.id) }; expanded = false })
            }
        }
    }
    if (selected?.hours?.isNotBlank() == true || selected?.address?.isNotBlank() == true) {
        Text(
            listOfNotNull(selected.address.takeIf { it.isNotBlank() }, selected.hours.takeIf { it.isNotBlank() }).joinToString(" · "),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
    Button(
        onClick = {
            val to = selected?.email.orEmpty()
            val runSummary = runs.joinToString("\n") { "- ${it.label.ifBlank { it.fenceType.name }}: ${it.fenceType.name.replace("_", " ")}" }
            val body = TemplateFiller.fillOrderTemplate(
                template = profile.orderEmailTemplate,
                customerName = job.customerName,
                address = job.address,
                lineItems = runSummary,
                total = "See attached estimate",
                businessName = profile.businessName
            )
            IntentHelpers.openEmailDraft(context, to, "New Order -- ${job.customerName.ifBlank { "Customer" }}, ${job.address}", body)
        },
        enabled = selected != null,
        modifier = Modifier.fillMaxWidth()
    ) {
        Text(if (selected == null) "Add a manufacturer first" else "Email Order to ${selected.name}")
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HoaFields(job: Job, runs: List<FenceRun>, profile: BusinessProfile, viewModel: JobDetailViewModel) {
    val context = LocalContext.current
    DraftTextField(stableKey = job.id, initialValue = job.hoaName, label = "HOA name", modifier = Modifier.fillMaxWidth()) {
        viewModel.update { j -> j.copy(hoaName = it) }
    }
    DraftTextField(stableKey = job.id, initialValue = job.hoaEmail, label = "HOA email", keyboardType = KeyboardType.Email, modifier = Modifier.fillMaxWidth()) {
        viewModel.update { j -> j.copy(hoaEmail = it) }
    }
    var hoaExpanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = hoaExpanded, onExpandedChange = { hoaExpanded = it }) {
        OutlinedTextField(
            value = job.hoaApprovalStatus.name.replace("_", " "), onValueChange = {}, readOnly = true,
            label = { Text("HOA approval status") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = hoaExpanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor()
        )
        DropdownMenu(expanded = hoaExpanded, onDismissRequest = { hoaExpanded = false }) {
            HoaApprovalStatus.values().forEach { status ->
                DropdownMenuItem(
                    text = { Text(status.name.replace("_", " ")) },
                    onClick = { viewModel.update { j -> j.copy(hoaApprovalStatus = status) }; hoaExpanded = false }
                )
            }
        }
    }
    Button(
        onClick = {
            val firstRun = runs.firstOrNull()
            val body = TemplateFiller.fillHoaTemplate(
                template = profile.hoaEmailTemplate,
                address = job.address,
                fenceType = firstRun?.fenceType?.name?.replace("_", " ") ?: "",
                height = firstRun?.panelHeightFt?.toString() ?: "",
                material = firstRun?.colorOrFinish ?: "",
                businessName = profile.businessName,
                phone = profile.phone
            )
            IntentHelpers.openEmailDraft(context, job.hoaEmail, "Fence Installation Approval Request -- ${job.address}", body)
            viewModel.update { j -> if (j.hoaApprovalStatus == HoaApprovalStatus.NOT_REQUIRED) j.copy(hoaApprovalStatus = HoaApprovalStatus.PENDING) else j }
        },
        enabled = job.hoaEmail.isNotBlank(),
        modifier = Modifier.fillMaxWidth()
    ) {
        Text("Send HOA Approval Request")
    }

    androidx.compose.foundation.layout.Spacer(Modifier.height(4.dp))
    Text("Permit", style = MaterialTheme.typography.titleSmall)
    DraftTextField(stableKey = job.id, initialValue = job.permitNumber, label = "Permit number", modifier = Modifier.fillMaxWidth()) {
        viewModel.update { j -> j.copy(permitNumber = it) }
    }
    var permitExpanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = permitExpanded, onExpandedChange = { permitExpanded = it }) {
        OutlinedTextField(
            value = job.permitStatus.name.replace("_", " "), onValueChange = {}, readOnly = true,
            label = { Text("Permit status") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = permitExpanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor()
        )
        DropdownMenu(expanded = permitExpanded, onDismissRequest = { permitExpanded = false }) {
            PermitStatus.values().forEach { status ->
                DropdownMenuItem(
                    text = { Text(status.name.replace("_", " ")) },
                    onClick = { viewModel.update { j -> j.copy(permitStatus = status) }; permitExpanded = false }
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PaymentFields(job: Job, profile: BusinessProfile, viewModel: JobDetailViewModel) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = job.paymentStatus.name.replace("_", " "), onValueChange = {}, readOnly = true,
            label = { Text("Payment status") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor()
        )
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            PaymentStatus.values().forEach { status ->
                DropdownMenuItem(
                    text = { Text(status.name.replace("_", " ")) },
                    onClick = { viewModel.update { j -> j.copy(paymentStatus = status) }; expanded = false }
                )
            }
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        DraftNumberField(
            stableKey = job.id,
            label = "Deposit amount ($)", initialValue = job.depositAmount.toFloat(),
            modifier = Modifier.weight(1f)
        ) { viewModel.update { j -> j.copy(depositAmount = it.toDouble()) } }
        DraftNumberField(
            stableKey = job.id, label = "Total paid so far ($)", initialValue = job.amountPaid.toFloat(),
            modifier = Modifier.weight(1f)
        ) { viewModel.update { j -> j.copy(amountPaid = it.toDouble()) } }
    }

    // A deposit that doesn't cover materials means buying the customer's fence
    // with your own money, so offer the covering figure in one tap.
    val materialCost by viewModel.materialCost.collectAsState()
    val suggested = viewModel.suggestedDeposit()
    if (suggested > 0.0 && job.depositAmount < materialCost) {
        OutlinedButton(
            onClick = { viewModel.applySuggestedDeposit() },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Set deposit to $${"%.0f".format(suggested)} (covers materials)")
        }
        Text(
            "Materials on this estimate come to $${"%.2f".format(materialCost)}. " +
                "Rounded up to the next \$10.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
    val context = LocalContext.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var creatingLink by remember { mutableStateOf(false) }
    var linkError by remember { mutableStateOf<String?>(null) }

    val balanceDue = (job.amountPaid).let { paid ->
        // Deposit is what we can bill for with confidence before the estimate is final.
        if (job.depositAmount > paid) job.depositAmount - paid else 0.0
    }
    val squareReady = profile.squareAccessToken.isNotBlank() && profile.squareLocationId.isNotBlank()

    // Stripe runs through the backend, so there is no key on this phone to set
    // up and nothing to leak if the phone is lost. Ask for the balance if we
    // know one, otherwise the deposit.
    val requestAmount = if (balanceDue > 0.0) balanceDue else job.depositAmount
    Button(
        onClick = {
            scope.launch {
                creatingLink = true
                linkError = null
                val result = PaymentsApi.createPaymentLink(
                    jobSyncId = job.syncId,
                    amountDollars = requestAmount,
                    kind = if (balanceDue > 0.0 && job.amountPaid > 0.0) PaymentsApi.Kind.FINAL
                    else PaymentsApi.Kind.DEPOSIT,
                    description = "Fence installation - ${job.address.ifBlank { job.customerName }}"
                )
                creatingLink = false
                when (result) {
                    is PaymentsApi.Result.Ok -> viewModel.update { j ->
                        j.copy(paymentLinkUrl = result.url, paymentLinkAmount = requestAmount)
                    }
                    is PaymentsApi.Result.Failed -> linkError = result.reason
                }
            }
        },
        enabled = !creatingLink && requestAmount >= 0.50,
        modifier = Modifier.fillMaxWidth()
    ) {
        Text(
            when {
                creatingLink -> "Creating link..."
                requestAmount >= 0.50 -> "Request $${"%.2f".format(requestAmount)} by Card"
                else -> "Request Payment by Card"
            }
        )
    }
    // This has to sit right under the button, outside the Square block below.
    // It used to live inside it, so with Square unconfigured a failed request
    // printed nothing at all and the button looked simply dead.
    linkError?.let { problem ->
        Text(
            problem,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.error
        )
    }
    Text(
        "Creates a Stripe checkout link. The money goes to your Stripe account -- " +
            "FenceFlow never holds it, and the card details never touch this phone.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
    if (requestAmount < 0.50) {
        Text(
            "Set a deposit amount below and the link will bill that exact figure.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }

    if (squareReady) {
        Button(
            onClick = {
                scope.launch {
                    creatingLink = true
                    linkError = null
                    val amount = if (balanceDue > 0.0) balanceDue else job.depositAmount
                    val result = com.fenceestimator.app.payments.SquarePayments.createPaymentLink(
                        token = profile.squareAccessToken.trim(),
                        locationId = profile.squareLocationId.trim(),
                        amount = amount,
                        description = "Fence installation - ${job.address.ifBlank { job.customerName }}",
                        buyerEmail = job.email.takeIf { it.isNotBlank() }
                    )
                    creatingLink = false
                    result.fold(
                        onSuccess = { link -> viewModel.update { j -> j.copy(paymentLinkUrl = link.url) } },
                        onFailure = { linkError = it.message }
                    )
                }
            },
            enabled = !creatingLink && (balanceDue > 0.0 || job.depositAmount > 0.0),
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(
                when {
                    creatingLink -> "Creating link..."
                    balanceDue > 0.0 -> "Create Square Link for $${"%.2f".format(balanceDue)}"
                    else -> "Create Square Payment Link"
                }
            )
        }
        if (balanceDue <= 0.0 && job.depositAmount <= 0.0) {
            Text(
                "Set a deposit amount below and the link will bill that exact figure.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        linkError?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
    }

    DraftTextField(
        stableKey = job.id, initialValue = job.paymentLinkUrl,
        label = "Payment link",
        modifier = Modifier.fillMaxWidth()
    ) { viewModel.update { j -> j.copy(paymentLinkUrl = it) } }
    Text(
        "Filled in by the button above, or paste any link you already use " +
            "(PayPal, Venmo, Square). Money goes straight to your own account.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
    // A Stripe link is locked to the amount it was made for. Once the price
    // moves, sending the old one charges the customer the wrong total, so say
    // so loudly rather than letting it go out quietly.
    val linkIsStale = job.paymentLinkUrl.isNotBlank() &&
        job.paymentLinkAmount > 0.0 &&
        kotlin.math.abs(job.paymentLinkAmount - requestAmount) > 0.005
    if (linkIsStale) {
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
        ) {
            Column(Modifier.padding(12.dp)) {
                Text(
                    "This link still bills $${"%.2f".format(job.paymentLinkAmount)}, " +
                        "but the amount due is now $${"%.2f".format(requestAmount)}.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onErrorContainer
                )
                Text(
                    "Tap Request by Card again to replace it before you send anything.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onErrorContainer
                )
            }
        }
        Spacer(Modifier.height(8.dp))
    }

    if (job.paymentLinkUrl.isNotBlank()) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedButton(
                onClick = {
                    // Naming the amount in the message means the customer can
                    // check it against the estimate before they tap anything.
                    val amountText = if (job.paymentLinkAmount > 0.0) " for $${"%.2f".format(job.paymentLinkAmount)}" else ""
                    val body = "Hi ${job.customerName.ifBlank { "there" }}, here's the payment link$amountText " +
                        "for your fence at ${job.address}:\n\n${job.paymentLinkUrl}"
                    IntentHelpers.openSmsDraft(context, job.phone, body)
                },
                enabled = job.phone.isNotBlank() && !linkIsStale,
                modifier = Modifier.weight(1f)
            ) { Text("Text Link") }
            Button(
                onClick = {
                    val amountText = if (job.paymentLinkAmount > 0.0) " for $${"%.2f".format(job.paymentLinkAmount)}" else ""
                    val body = "Hi ${job.customerName.ifBlank { "there" }},\n\nHere's the payment link$amountText " +
                        "for your fence at ${job.address}:\n\n${job.paymentLinkUrl}\n\nThank you!"
                    IntentHelpers.openEmailDraft(context, job.email, "Payment link for your fence", body)
                },
                enabled = job.email.isNotBlank() && !linkIsStale,
                modifier = Modifier.weight(1f)
            ) { Text("Email Link") }
        }
    }

    androidx.compose.foundation.layout.Spacer(Modifier.height(4.dp))
    DraftNumberField(
        stableKey = job.id, label = "Tip ($) -- goes 100% to the installer",
        initialValue = job.tipAmount.toFloat(),
        modifier = Modifier.fillMaxWidth()
    ) { viewModel.update { j -> j.copy(tipAmount = it.toDouble()) } }
    if (job.tipAmount > 0.0) {
        Text(
            "$${"%.2f".format(job.tipAmount)} tip recorded. This is tracked separately from the contract and is not counted as company revenue in reports.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }

    if (job.isInvoiced) {
        Text(
            "Invoice has been generated for this job.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    } else {
        Text(
            "Use \"Generate & Share Invoice\" on the Estimate screen once the job is complete.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

@Composable
private fun ExpensesSection(expenses: List<Expense>, canDelete: Boolean, viewModel: JobDetailViewModel) {
    var showAdd by remember { mutableStateOf(false) }
    val total = expenses.sumOf { it.amount }

    if (expenses.isEmpty()) {
        Text(
            "No expenses logged for this job yet (fuel, equipment rental, permit fees, etc).",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    } else {
        expenses.forEach { expense ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(Modifier.weight(1f)) {
                    Text(expense.description.ifBlank { expense.category.name.replace("_", " ") }, fontWeight = FontWeight.Medium)
                    Text(
                        expense.category.name.replace("_", " "),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Text("$${String.format("%.2f", expense.amount)}")
                if (canDelete) {
                    IconButton(onClick = { viewModel.deleteExpense(expense) }) {
                        Icon(Icons.Filled.Close, contentDescription = "Remove expense")
                    }
                }
            }
        }
        Text("Total expenses: $${String.format("%.2f", total)}", fontWeight = FontWeight.Medium)
    }
    OutlinedButton(onClick = { showAdd = true }, modifier = Modifier.fillMaxWidth()) {
        Icon(Icons.Filled.Add, contentDescription = null)
        Text("  Add Expense")
    }

    if (showAdd) {
        AddExpenseDialog(
            onConfirm = { category, description, amount ->
                viewModel.addExpense(category, description, amount)
                showAdd = false
            },
            onDismiss = { showAdd = false }
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AddExpenseDialog(onConfirm: (ExpenseCategory, String, Double) -> Unit, onDismiss: () -> Unit) {
    var category by remember { mutableStateOf(ExpenseCategory.OTHER) }
    var description by remember { mutableStateOf("") }
    var amountText by remember { mutableStateOf("") }
    var expanded by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add Expense") },
        text = {
            Column {
                ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
                    OutlinedTextField(
                        value = category.name.replace("_", " "), onValueChange = {}, readOnly = true,
                        label = { Text("Category") },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
                        modifier = Modifier.fillMaxWidth().menuAnchor()
                    )
                    DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                        ExpenseCategory.values().forEach { c ->
                            DropdownMenuItem(text = { Text(c.name.replace("_", " ")) }, onClick = { category = c; expanded = false })
                        }
                    }
                }
                androidx.compose.foundation.layout.Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = description, onValueChange = { description = it },
                    label = { Text("Description") }, modifier = Modifier.fillMaxWidth()
                )
                androidx.compose.foundation.layout.Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = amountText, onValueChange = { amountText = it },
                    label = { Text("Amount ($)") },
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            Button(onClick = { onConfirm(category, description, amountText.toDoubleOrNull() ?: 0.0) }) { Text("Add") }
        },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text("Cancel") } }
    )
}

@Composable
/** Button wording for where a step gets finished, or null if it's finished right here. */
private fun stageDestination(action: StageAction): String? = when (action) {
    StageAction.DRAW -> "Go to Draw"
    StageAction.ESTIMATE -> "Go to Estimate"
    StageAction.CREW_VIEW -> "Go to Crew View"
    StageAction.PAYMENT -> "Go to Payment"
    StageAction.HOA -> "Go to HOA & Permits"
    StageAction.SCHEDULE -> "Go to Scheduling"
    StageAction.NONE -> null
}

@Composable
private fun ProjectProgressSection(
    job: Job,
    punchListClear: Boolean,
    profile: BusinessProfile,
    onGoToStage: (StageAction) -> Unit
) {
    val context = LocalContext.current
    val jobComplete = job.status == JobStatus.COMPLETED && punchListClear
    val stages = remember(job, punchListClear) { ProjectStatus.stages(job, jobComplete) }

    var openStage by remember { mutableStateOf<com.fenceestimator.app.ui.components.ProjectStage?>(null) }

    val doneCount = stages.count { it.done }
    Text(
        "$doneCount of ${stages.size} steps done",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
    androidx.compose.material3.LinearProgressIndicator(
        progress = { doneCount.toFloat() / stages.size },
        modifier = Modifier.fillMaxWidth()
    )

    stages.forEach { stage ->
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .clickable { openStage = stage }
                .padding(vertical = 2.dp)
        ) {
            Icon(
                if (stage.done) Icons.Filled.CheckCircle else Icons.Filled.RadioButtonUnchecked,
                contentDescription = null,
                tint = when {
                    stage.done -> MaterialTheme.colorScheme.primary
                    stage.current -> MaterialTheme.colorScheme.secondary
                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                }
            )
            Text(
                "  ${stage.label}",
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (stage.current) FontWeight.SemiBold else FontWeight.Normal,
                color = if (stage.done || stage.current) MaterialTheme.colorScheme.onSurface
                    else MaterialTheme.colorScheme.onSurfaceVariant
            )
            if (stage.current) {
                Text(
                    "NEXT",
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.secondary
                )
            }
        }
    }

    openStage?.let { stage ->
        AlertDialog(
            onDismissRequest = { openStage = null },
            title = { Text(stage.label) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        if (stage.done) "Done." else if (stage.current) "This is your next step." else "Not done yet.",
                        fontWeight = FontWeight.Medium,
                        color = if (stage.done) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.onSurface
                    )
                    Text(stage.guidance, style = MaterialTheme.typography.bodyMedium)
                }
            },
            // Every step knows where it gets done; taking you there beats
            // describing it and leaving you to find the screen yourself.
            confirmButton = {
                val destination = stageDestination(stage.action)
                if (destination != null && !stage.done) {
                    Button(onClick = { openStage = null; onGoToStage(stage.action) }) {
                        Text(destination)
                    }
                } else {
                    Button(onClick = { openStage = null }) { Text("Got it") }
                }
            },
            dismissButton = {
                if (stageDestination(stage.action) != null && !stage.done) {
                    OutlinedButton(onClick = { openStage = null }) { Text("Close") }
                }
            }
        )
    }
    Text(
        "Send the customer a plain-language update of exactly this progress.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlinedButton(
            onClick = {
                IntentHelpers.openSmsDraft(context, job.phone, ProjectStatus.asMessage(job, jobComplete, profile.businessName))
            },
            enabled = job.phone.isNotBlank(),
            modifier = Modifier.weight(1f)
        ) { Text("Text Update") }
        OutlinedButton(
            onClick = {
                IntentHelpers.openEmailDraft(
                    context, job.email, "Update on your fence project",
                    ProjectStatus.asMessage(job, jobComplete, profile.businessName)
                )
            },
            enabled = job.email.isNotBlank(),
            modifier = Modifier.weight(1f)
        ) { Text("Email Update") }
    }
}

@Composable
private fun ChangeOrdersSection(orders: List<ChangeOrder>, canDelete: Boolean, viewModel: JobDetailViewModel) {
    var showAdd by remember { mutableStateOf(false) }
    var editingOrder by remember { mutableStateOf<ChangeOrder?>(null) }
    var signingOrder by remember { mutableStateOf<ChangeOrder?>(null) }
    val dateFormat = remember { SimpleDateFormat("MMM d, yyyy", Locale.US) }
    val totals by viewModel.contractTotal.collectAsState()

    // The running total sits here on purpose. The quote lives on the Estimate
    // screen, so approving extra work here appeared to change nothing at all.
    if (orders.isNotEmpty()) {
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
        ) {
            Column(Modifier.padding(12.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("Extra work approved", color = MaterialTheme.colorScheme.onSecondaryContainer)
                    Text(
                        "+$${"%.2f".format(totals.changeOrderCost)}" +
                            if (totals.changeOrderFeet > 0) "  (+${"%.0f".format(totals.changeOrderFeet)} ft)" else "",
                        fontWeight = FontWeight.Medium,
                        color = MaterialTheme.colorScheme.onSecondaryContainer
                    )
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("New contract total", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSecondaryContainer)
                    Text(
                        "$${"%.2f".format(totals.grandTotal)}",
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onSecondaryContainer
                    )
                }
                Text(
                    "Extra feet are billed at your labor rate, so the total can rise by more than the cost you typed.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSecondaryContainer
                )
            }
        }
        Spacer(Modifier.height(8.dp))
    }

    if (orders.isEmpty()) {
        Text(
            "If the customer adds work after the estimate (another 30 ft, an extra gate), log it here and have them sign. " +
                "That signed, dated record is what protects you if they dispute the final bill.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    } else {
        orders.forEach { order ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(order.description.ifBlank { "Extra work" }, fontWeight = FontWeight.Medium)
                            Text(
                                buildString {
                                    if (order.additionalFeet > 0) append("+${"%.0f".format(order.additionalFeet)} ft  ·  ")
                                    append("$${"%.2f".format(order.additionalCost)}")
                                    append("  ·  ${dateFormat.format(Date(order.createdAt))}")
                                },
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        IconButton(onClick = { editingOrder = order }) {
                            Icon(Icons.Filled.Edit, contentDescription = "Edit change order")
                        }
                        if (canDelete) {
                            IconButton(onClick = { viewModel.deleteChangeOrder(order) }) {
                                Icon(Icons.Filled.Close, contentDescription = "Remove change order")
                            }
                        }
                    }
                    if (order.materialCost > 0) {
                        Text(
                            "Includes $${"%.2f".format(order.materialCost)} of materials",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    if (order.isSigned) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            AsyncImage(
                                model = order.signatureImagePath,
                                contentDescription = null,
                                modifier = Modifier.height(36.dp).weight(1f)
                            )
                            Text(
                                order.signedAt?.let { "Signed ${dateFormat.format(Date(it))}" }.orEmpty(),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    } else {
                        Button(onClick = { signingOrder = order }, modifier = Modifier.fillMaxWidth()) {
                            Text("Get Customer Signature")
                        }
                    }
                }
            }
        }
        val signedTotal = orders.filter { it.isSigned }.sumOf { it.additionalCost }
        Text("Approved extra work: $${"%.2f".format(signedTotal)}", fontWeight = FontWeight.Medium)
    }

    OutlinedButton(onClick = { showAdd = true }, modifier = Modifier.fillMaxWidth()) {
        Icon(Icons.Filled.Add, contentDescription = null)
        Text("  Add Change Order")
    }

    editingOrder?.let { order ->
        AddChangeOrderDialog(
            existing = order,
            onConfirm = { description, feet, cost, materials ->
                viewModel.updateChangeOrder(order, description, feet, cost, materials)
                editingOrder = null
            },
            onDismiss = { editingOrder = null }
        )
    }

    if (showAdd) {
        AddChangeOrderDialog(
            onConfirm = { description, feet, cost, materials ->
                viewModel.addChangeOrder(description, feet, cost, materials)
                showAdd = false
            },
            onDismiss = { showAdd = false }
        )
    }

    signingOrder?.let { order ->
        com.fenceestimator.app.ui.components.SignaturePadDialog(
            onSave = { path -> viewModel.signChangeOrder(order, path); signingOrder = null },
            onDismiss = { signingOrder = null }
        )
    }
}

@Composable
private fun AddChangeOrderDialog(
    existing: ChangeOrder? = null,
    onConfirm: (String, Double, Double, Double) -> Unit,
    onDismiss: () -> Unit
) {
    var description by remember { mutableStateOf(existing?.description ?: "") }
    var feetText by remember { mutableStateOf(existing?.additionalFeet?.takeIf { it > 0 }?.toString() ?: "") }
    var costText by remember { mutableStateOf(existing?.additionalCost?.takeIf { it > 0 }?.toString() ?: "") }
    var materialText by remember { mutableStateOf(existing?.materialCost?.takeIf { it > 0 }?.toString() ?: "") }

    val cost = costText.toDoubleOrNull() ?: 0.0
    val materials = materialText.toDoubleOrNull() ?: 0.0
    val materialsTooHigh = materials > cost && cost > 0.0

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (existing == null) "Additional Work Authorization" else "Edit Change Order") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                OutlinedTextField(
                    value = description, onValueChange = { description = it },
                    label = { Text("What's being added?") }, minLines = 2, modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = feetText, onValueChange = { feetText = it },
                    label = { Text("Additional feet (optional)") },
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = costText, onValueChange = { costText = it },
                    label = { Text("Total charged to customer ($)") },
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = materialText, onValueChange = { materialText = it },
                    label = { Text("Of that, extra materials ($)") },
                    isError = materialsTooHigh,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth()
                )
                Text(
                    if (materialsTooHigh)
                        "Materials are more than you're charging -- this change order loses money."
                    else
                        "Materials you have to buy for this extra work. Kept separate so the " +
                            "suggested deposit covers it instead of you fronting it.",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (materialsTooHigh) MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.onSurfaceVariant
                )
                if (existing?.signatureImagePath != null) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "Changing the feet, the cost, or the materials clears the customer's " +
                            "signature -- they signed for the old figures, so it has to be signed again.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    onConfirm(
                        description,
                        feetText.toDoubleOrNull() ?: 0.0,
                        cost,
                        materials
                    )
                },
                enabled = description.isNotBlank()
            ) { Text(if (existing == null) "Add" else "Save") }
        },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text("Cancel") } }
    )
}

@Composable
private fun PunchListSection(items: List<PunchListItem>, canDelete: Boolean, viewModel: JobDetailViewModel) {
    var newItemText by remember { mutableStateOf("") }

    if (items.isEmpty()) {
        Text(
            "No punch-list items. Track anything the customer wants fixed after the install here.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    } else {
        items.forEach { item ->
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = item.resolved, onCheckedChange = { viewModel.togglePunchListItem(item) })
                Text(
                    item.description,
                    modifier = Modifier.weight(1f),
                    style = if (item.resolved) MaterialTheme.typography.bodyMedium.copy(color = MaterialTheme.colorScheme.onSurfaceVariant) else MaterialTheme.typography.bodyMedium
                )
                if (canDelete) {
                    IconButton(onClick = { viewModel.deletePunchListItem(item) }) {
                        Icon(Icons.Filled.Close, contentDescription = "Remove item")
                    }
                }
            }
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = newItemText, onValueChange = { newItemText = it },
            label = { Text("New callback item") }, modifier = Modifier.weight(1f)
        )
        Button(onClick = {
            if (newItemText.isNotBlank()) {
                viewModel.addPunchListItem(newItemText)
                newItemText = ""
            }
        }) { Text("Add") }
    }
}

@Composable
private fun ReviewRequestFields(job: Job, profile: BusinessProfile, viewModel: JobDetailViewModel) {
    val context = LocalContext.current
    val body = TemplateFiller.fillReviewTemplate(
        template = profile.reviewRequestTemplate,
        customerName = job.customerName,
        businessName = profile.businessName
    )
    Text(
        "Send once the job is finished and the customer is happy.",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlinedButton(
            onClick = { IntentHelpers.openSmsDraft(context, job.phone, body) },
            enabled = job.phone.isNotBlank(),
            modifier = Modifier.weight(1f)
        ) {
            Icon(Icons.Filled.Star, contentDescription = null)
            Text("  Text")
        }
        Button(
            onClick = { IntentHelpers.openEmailDraft(context, job.email, "Thanks from ${profile.businessName.ifBlank { "us" }}!", body) },
            enabled = job.email.isNotBlank(),
            modifier = Modifier.weight(1f)
        ) {
            Text("Email")
        }
    }
}

@Composable
private fun PhotosSection(photos: List<JobPhoto>, canDelete: Boolean, viewModel: JobDetailViewModel) {
    val context = LocalContext.current
    var pendingKind by remember { mutableStateOf(PhotoKind.BEFORE) }
    var pendingTarget by remember { mutableStateOf<NewPhotoTarget?>(null) }

    val cameraLauncher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { success ->
        if (success) pendingTarget?.let { viewModel.addPhoto(pendingKind, it.absolutePath) }
        pendingTarget = null
    }
    val galleryLauncher = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) viewModel.addPhoto(pendingKind, PhotoFiles.copyFrom(context, uri, "photos"))
    }

    PhotoKind.values().forEach { kind ->
        Text(kind.name.lowercase().replaceFirstChar { it.uppercase() }, style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = {
                pendingKind = kind
                val target = PhotoFiles.newTarget(context, "photos")
                pendingTarget = target
                cameraLauncher.launch(target.uri)
            }) {
                Icon(Icons.Filled.CameraAlt, contentDescription = null)
                Text(" Camera")
            }
            OutlinedButton(onClick = {
                pendingKind = kind
                galleryLauncher.launch(androidx.activity.result.PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
            }) {
                Icon(Icons.Filled.PhotoLibrary, contentDescription = null)
                Text(" Gallery")
            }
        }
        val kindPhotos = photos.filter { it.kind == kind }
        if (kindPhotos.isNotEmpty()) {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(kindPhotos, key = { it.id }) { photo ->
                    Box {
                        AsyncImage(
                            model = photo.filePath,
                            contentDescription = null,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.size(90.dp).clip(RoundedCornerShape(8.dp))
                        )
                        if (canDelete) {
                            IconButton(onClick = { viewModel.deletePhoto(photo) }, modifier = Modifier.size(24.dp)) {
                                Icon(Icons.Filled.Close, contentDescription = "Remove photo", tint = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                }
            }
        }
    }
}


/**
 * Stable ids for the sections that Project Progress can jump to. They are the
 * LazyColumn item keys and the entries in `sectionOrder`; both have to agree,
 * so they live here rather than as loose strings at either site.
 */
private const val SECTION_PROGRESS = "progress"
private const val SECTION_SCHEDULE = "schedule"
private const val SECTION_HOA = "hoa"
private const val SECTION_PAYMENT = "payment"
