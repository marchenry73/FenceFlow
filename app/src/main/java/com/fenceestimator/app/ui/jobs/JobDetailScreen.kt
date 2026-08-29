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
import androidx.compose.material.icons.filled.Timeline
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Straighten
import androidx.compose.material.icons.filled.AttachMoney
import androidx.compose.material.icons.filled.Sell
import androidx.compose.material.icons.filled.LocalShipping
import androidx.compose.material.icons.filled.Gavel
import androidx.compose.material.icons.filled.EditNote
import androidx.compose.material.icons.filled.Payments
import androidx.compose.material.icons.filled.ReceiptLong
import androidx.compose.material.icons.filled.ChangeCircle
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.StarRate
import androidx.compose.foundation.background
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Button
import androidx.compose.foundation.layout.Spacer
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
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
import androidx.compose.material3.TextButton
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage
import com.fenceestimator.app.R
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
import com.fenceestimator.app.estimate.JobMoney
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
import com.fenceestimator.app.ui.components.describes
import com.fenceestimator.app.ui.components.label
import com.fenceestimator.app.ui.components.labelRes
import com.fenceestimator.app.ui.runs.FenceRunListViewModel
import kotlinx.coroutines.launch
import com.fenceestimator.app.cloud.SupabaseModule
import io.github.jan.supabase.postgrest.postgrest
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
    /** The live contract figures, so the signature check compares against what the estimate says now. */
    val jobTotals by viewModel.contractTotal.collectAsState()
    val allJobs by viewModel.allJobs.collectAsState()
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
    // Who answers plan-change requests. It was never set, so decisions were
    // recorded with a blank name and the cannot-approve-your-own check had
    // nothing to compare against.
    androidx.compose.runtime.LaunchedEffect(profile.ownerName, session.email) {
        viewModel.decidedByName = profile.ownerName.ifBlank { session.email.orEmpty() }
    }
    val currentJob = job ?: return

    var showAddRunDialog by remember { mutableStateOf(false) }

    val listState = rememberLazyListState()
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var confirmDeleteJob by remember { mutableStateOf(false) }

    // The order of the sections below, in one place. Some are hidden from crew
    // accounts, so a hardcoded index would land on the wrong card for them.
    // Only needs to run as far as the last section anything scrolls to.
    val sectionOrder = remember(session.canSeeMoney) {
        buildList {
            add(SECTION_PROGRESS); add("customer"); add("actions"); add("crew-view"); add("inventory"); add("runs")
            if (session.canSeeMoney) { add("pricing"); add("tier"); add("teardown") }
            add(SECTION_SCHEDULE)
            if (session.canSeeMoney) add("order")
            add(SECTION_LOCATE)
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
                title = { Text(currentJob.customerName.ifBlank { stringResource(R.string.jd_new_job) }) },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back)) }
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
                SectionCard(title = stringResource(R.string.section_progress), icon = Icons.Filled.Timeline) {
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
            item { SectionCard(title = stringResource(R.string.section_customer), icon = Icons.Filled.Person) { CustomerFields(currentJob, viewModel) } }
            item {
                // Everything already saves as you type -- this is here because
                // an app with no Save button leaves people unsure whether their
                // work is safe, and they leave the screen expecting to lose it.
                Card(
                    Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.secondaryContainer
                    )
                ) {
                    Row(
                        Modifier.fillMaxWidth().padding(12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            stringResource(R.string.jd_saved_automatically),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSecondaryContainer
                        )
                        Button(onClick = { app.autoSync.requestSync(); onBack() }) {
                            Text(stringResource(R.string.jd_save_and_close))
                        }
                    }
                }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedButton(
                        onClick = { onOpenSurvey(jobId) },
                        modifier = Modifier.weight(1f)
                    ) {
                        Icon(Icons.Filled.Map, contentDescription = null)
                        Text("  " + stringResource(R.string.survey_title))
                    }
                    if (session.canSeeMoney) {
                        Button(
                            onClick = { onOpenEstimate(jobId) },
                            modifier = Modifier.weight(1f)
                        ) {
                            Icon(Icons.Filled.Receipt, contentDescription = null)
                            Text("  " + stringResource(R.string.estimate_title))
                        }
                    }
                }
            }
            // The sales moment happens in the driveway, not at the office desk.
            // This hands the customer their quote page -- the itemised quote,
            // their fence in 3D, and the Approve button -- through whatever
            // app they actually answer. Money-gated like the estimate: the
            // link shows sell prices, so crew do not get to send it.
            if (session.canSeeMoney) item {
                // Snapshot the delegated property once; the coroutine below
                // outlives this composition and must not race a null.
                val j = job ?: return@item
                val shareFailed = stringResource(R.string.jd_quote_link_failed)
                val chooser = stringResource(R.string.jd_send_quote_chooser)
                val bodyTemplate = stringResource(R.string.jd_quote_link_body)
                OutlinedButton(
                    onClick = {
                        scope.launch {
                            val url = runCatching {
                                val token = SupabaseModule.client.postgrest.from("jobs")
                                    .select(io.github.jan.supabase.postgrest.query.Columns.list("quote_token")) {
                                        filter { eq("sync_id", j.syncId) }
                                    }
                                    .decodeSingleOrNull<QuoteTokenRow>()?.quoteToken
                                token?.let { "https://marchenry73.github.io/FenceFlow/quote.html?t=" + it }
                            }.getOrNull()
                            if (url == null) {
                                android.widget.Toast.makeText(context, shareFailed,
                                    android.widget.Toast.LENGTH_LONG).show()
                            } else {
                                IntentHelpers.shareText(
                                    context = context,
                                    subject = chooser,
                                    body = bodyTemplate.format(
                                        j.customerName.ifBlank { "there" }, url),
                                    chooserTitle = chooser
                                )
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Icon(Icons.Filled.Star, contentDescription = null)
                    Text("  " + stringResource(R.string.jd_send_quote_to_customer))
                }
            }
            item {
                Button(onClick = { onOpenCrewView(jobId) }, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Filled.Construction, contentDescription = null)
                    Text("  " + stringResource(R.string.jd_open_crew_view))
                }
            }
            item {
                OutlinedButton(onClick = { onOpenInventory(jobId) }, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Filled.Inventory, contentDescription = null)
                    Text("  " + stringResource(R.string.jd_inventory_checklist))
                }
            }
            item {
                SectionCard(title = stringResource(R.string.section_fence_runs), icon = Icons.Filled.Straighten) {
                    if (runs.isEmpty()) {
                        Text(
                            stringResource(R.string.jd_no_runs),
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
                        Text("  " + stringResource(R.string.jd_add_fence_run))
                    }
                }
            }
            if (session.canSeeMoney) {
                item { SectionCard(title = stringResource(R.string.section_pricing), icon = Icons.Filled.AttachMoney) { PricingFields(currentJob, viewModel) } }
                item { SectionCard(title = stringResource(R.string.jd_section_tier), icon = Icons.Filled.Sell) { TierFields(currentJob, pricingTiers, viewModel) } }
                item { SectionCard(title = stringResource(R.string.jd_section_teardown), icon = Icons.Filled.Construction) { TeardownFields(currentJob, viewModel) } }
            }
            item(key = SECTION_SCHEDULE) {
                SectionCard(title = stringResource(R.string.section_schedule_crew), icon = Icons.Filled.Event) {
                    ScheduleFields(currentJob, runs, timeEntries, profile, viewModel)
                    CrewFields(currentJob, employees, viewModel)
                }
            }
            if (session.canSeeMoney) {
                item {
                    SectionCard(title = stringResource(R.string.section_order_materials), icon = Icons.Filled.LocalShipping) {
                        OrderFields(currentJob, manufacturers, profile, runs, viewModel)
                    }
                }
            }
            // Directly above HOA and permits, because they are the same kind of
            // thing: the paperwork that has to be right before anyone starts.
            item(key = SECTION_LOCATE) { LocateSection(currentJob, viewModel) }
            item(key = SECTION_HOA) { SectionCard(title = stringResource(R.string.section_hoa_permits), icon = Icons.Filled.Gavel) { HoaFields(currentJob, runs, profile, viewModel) } }
            if (session.canSeeMoney) {
                item { SectionCard(title = stringResource(R.string.section_change_orders), icon = Icons.Filled.EditNote) { ChangeOrdersSection(changeOrders, session.canDelete, viewModel) } }
                // Above the money, because a job running over is the thing
                // that has to be dealt with today -- the invoice can wait.
                item(key = "overrun") {
                    OverrunSection(
                        job = currentJob,
                        allJobs = allJobs,
                        workdayHours = (profile.workdayHours - profile.breakHoursPerDay)
                            .coerceAtLeast(1.0),
                        viewModel = viewModel
                    )
                }
                item(key = SECTION_PAYMENT) {
                    SectionCard(title = stringResource(R.string.section_payment), icon = Icons.Filled.Payments) {
                        StaleSignatureBanner(
                            job = currentJob,
                            contractTotal = jobTotals.grandTotal,
                            linearFeet = jobTotals.billableLinearFeet,
                            onGetNewSignature = { onOpenEstimate(currentJob.id) }
                        )
                        PaymentFields(currentJob, profile, viewModel)
                    }
                }
                item { SectionCard(title = stringResource(R.string.section_expenses), icon = Icons.Filled.ReceiptLong) { ExpensesSection(expenses, session.canDelete, viewModel) } }
            }
            item {
                val changes by viewModel.fieldChanges.collectAsState()
                SectionCard(
                    title = stringResource(R.string.jd_section_field_changes) +
                        if (changes.any { !it.isAcknowledged }) "  ●" else ""
                , icon = Icons.Filled.ChangeCircle
                ) {
                    FieldChangesSection(changes, session.canApprovePlanChanges, viewModel)
                }
            }
            item {
                SectionCard(title = stringResource(R.string.jd_section_held_up), icon = Icons.Filled.Block) {
                    JobBlockedSection(currentJob, profile, viewModel)
                }
            }
            item { SectionCard(title = stringResource(R.string.section_punch_list), icon = Icons.Filled.Checklist) { PunchListSection(punchList, session.canDelete, viewModel) } }
            item {
                SectionCard(title = stringResource(R.string.section_photos), icon = Icons.Filled.PhotoCamera) {
                    PhotosSection(photos, session.canDelete, viewModel)
                }
            }
            item { SectionCard(title = stringResource(R.string.section_review), icon = Icons.Filled.StarRate) { ReviewRequestFields(currentJob, profile, viewModel) } }
            item { StatusSelector(currentJob, viewModel) }
            // Owner only, and behind a typed confirmation. Deleting a job takes
            // its signed change orders, its payment record and its photos with
            // it -- exactly the evidence you would need in a dispute.
            if (session.canDelete) {
                item {
                    OutlinedButton(
                        onClick = { confirmDeleteJob = true },
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.outlinedButtonColors(
                            contentColor = MaterialTheme.colorScheme.error
                        )
                    ) {
                        Icon(Icons.Filled.Delete, contentDescription = null)
                        Text("  " + stringResource(R.string.jd_delete_job))
                    }
                }
            } else {
                item {
                    Text(
                        stringResource(R.string.jd_only_owner_deletes),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
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

    if (confirmDeleteJob) {
        ConfirmDeleteJobDialog(
            job = currentJob,
            onConfirm = { confirmDeleteJob = false; viewModel.delete(onDeleted) },
            onDismiss = { confirmDeleteJob = false }
        )
    }
}

/**
 * Deleting a job takes its estimate, its signed change orders, its payment
 * record and its photos with it, and none of it comes back. So the confirmation
 * spells out what goes and makes you type the customer's name -- a dialog you
 * can dismiss with a reflex tap is not a safeguard.
 */
@Composable
private fun MoneyLine(label: String, amount: Double, bold: Boolean = false) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(
            label,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal,
            color = MaterialTheme.colorScheme.onSecondaryContainer
        )
        Text(
            "$${"%.2f".format(amount)}",
            fontWeight = if (bold) FontWeight.Bold else FontWeight.Medium,
            color = MaterialTheme.colorScheme.onSecondaryContainer
        )
    }
}

@Composable
private fun ConfirmDeleteJobDialog(job: Job, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    val expected = job.customerName.trim().ifBlank { stringResource(R.string.jd_delete_word) }
    var typed by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.jd_delete_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(stringResource(R.string.jd_delete_also_deletes))
                Text(
                    stringResource(R.string.jd_delete_bullets),
                    style = MaterialTheme.typography.bodyMedium
                )
                Text(
                    stringResource(R.string.jd_delete_decline_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                OutlinedTextField(
                    value = typed,
                    onValueChange = { typed = it },
                    label = { Text(stringResource(R.string.jd_type_to_confirm, expected)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            Button(
                onClick = onConfirm,
                enabled = typed.trim().equals(expected, ignoreCase = true),
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.error,
                    contentColor = MaterialTheme.colorScheme.onError
                )
            ) { Text(stringResource(R.string.jd_delete_permanently)) }
        },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text(stringResource(R.string.jd_keep_it)) } }
    )
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
                Text(run.label.ifBlank { stringResource(R.string.jd_untitled_run) }, fontWeight = FontWeight.Medium)
                Text(
                    run.fenceType.label(),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            IconButton(onClick = onDuplicate) {
                Icon(Icons.Filled.ContentCopy, contentDescription = stringResource(R.string.jd_duplicate_run))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AddRunDialog(onConfirm: (String, FenceType) -> Unit, onDismiss: () -> Unit) {
    val context = LocalContext.current
    var label by remember { mutableStateOf("") }
    var type by remember { mutableStateOf(FenceType.VINYL) }
    var expanded by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.jd_add_fence_run)) },
        text = {
            Column {
                OutlinedTextField(
                    value = label, onValueChange = { label = it },
                    label = { Text(stringResource(R.string.jd_run_label_hint)) },
                    modifier = Modifier.fillMaxWidth()
                )
                androidx.compose.foundation.layout.Spacer(Modifier.height(8.dp))
                ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
                    OutlinedTextField(
                        value = type.label(), onValueChange = {}, readOnly = true,
                        label = { Text(stringResource(R.string.jd_fence_type)) },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
                        modifier = Modifier.fillMaxWidth().menuAnchor()
                    )
                    DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                        FenceType.values().filter { it != FenceType.UNIVERSAL }.forEach { t ->
                            DropdownMenuItem(
                                text = { Text(t.label()) },
                                onClick = { type = t; expanded = false }
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = { onConfirm(label.ifBlank { context.getString(type.labelRes()) }, type) }) { Text(stringResource(R.string.action_add)) }
        },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } }
    )
}

@Composable
private fun SectionCard(
    title: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector? = null,
    content: @Composable () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = androidx.compose.foundation.shape.RoundedCornerShape(14.dp),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            // A job is a long screen. The icon is what lets somebody scrolling
            // for the payment section find it by shape instead of reading every
            // heading on the way past.
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (icon != null) {
                    androidx.compose.foundation.layout.Box(
                        Modifier
                            .padding(end = 12.dp)
                            .size(34.dp)
                            .background(
                                MaterialTheme.colorScheme.secondaryContainer,
                                androidx.compose.foundation.shape.RoundedCornerShape(10.dp)
                            ),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            icon,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSecondaryContainer,
                            modifier = Modifier.size(19.dp)
                        )
                    }
                }
                Text(
                    title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold
                )
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            content()
        }
    }
}

@Composable
private fun CustomerFields(job: Job, viewModel: JobDetailViewModel) {
    DraftTextField(
        stableKey = job.id, initialValue = job.customerName, label = stringResource(R.string.field_customer_name),
        modifier = Modifier.fillMaxWidth()
    ) { viewModel.update { j -> j.copy(customerName = it) } }
    AddressAutocompleteField(
        stableKey = job.id, initialValue = job.address, label = stringResource(R.string.field_address),
        modifier = Modifier.fillMaxWidth()
    ) { viewModel.update { j -> j.copy(address = it) } }
    DraftTextField(
        stableKey = job.id, initialValue = job.phone, label = stringResource(R.string.field_phone),
        keyboardType = KeyboardType.Phone, modifier = Modifier.fillMaxWidth()
    ) { viewModel.update { j -> j.copy(phone = it) } }
    DraftTextField(
        stableKey = job.id, initialValue = job.email, label = stringResource(R.string.field_email),
        keyboardType = KeyboardType.Email, modifier = Modifier.fillMaxWidth()
    ) { viewModel.update { j -> j.copy(email = it) } }
    DraftTextField(
        stableKey = job.id, initialValue = job.notes, label = stringResource(R.string.field_notes),
        minLines = 2, modifier = Modifier.fillMaxWidth()
    ) { viewModel.update { j -> j.copy(notes = it) } }
    DraftTextField(
        stableKey = job.id, initialValue = job.referralSource, label = stringResource(R.string.field_referral),
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
            stableKey = job.id, label = stringResource(R.string.jd_tax_rate), initialValue = job.taxRatePercent.toFloat(),
            modifier = Modifier.weight(1f)
        ) { viewModel.update { j -> j.copy(taxRatePercent = it.toDouble()) } }
        DraftNumberField(
            stableKey = tierKey, label = stringResource(R.string.jd_markup_pct), initialValue = job.markupPercent.toFloat(),
            modifier = Modifier.weight(1f)
        ) { viewModel.update { j -> j.copy(markupPercent = it.toDouble()) } }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        DraftNumberField(
            stableKey = tierKey, label = stringResource(R.string.jd_labor_per_ft), initialValue = job.laborRatePerFt.toFloat(),
            modifier = Modifier.weight(1f)
        ) { viewModel.update { j -> j.copy(laborRatePerFt = it.toDouble()) } }
        DraftNumberField(
            stableKey = tierKey, label = stringResource(R.string.jd_labor_flat_fee), initialValue = job.laborFlatFee.toFloat(),
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
            value = statusLabel(job.status), onValueChange = {}, readOnly = true,
            label = { Text(stringResource(R.string.jd_status)) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor()
        )
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            JobStatus.values().forEach { status ->
                DropdownMenuItem(
                    text = { Text(statusLabel(status)) },
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
            value = job.pricingTierName.ifBlank { stringResource(R.string.jd_tier_custom) }, onValueChange = {}, readOnly = true,
            label = { Text(stringResource(R.string.jd_apply_tier)) },
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
            stableKey = tierKey, label = stringResource(R.string.jd_discount_pct), initialValue = job.discountPercent.toFloat(),
            modifier = Modifier.weight(1f)
        ) { viewModel.update { j -> j.copy(discountPercent = it.toDouble()) } }
        DraftNumberField(
            stableKey = job.id, label = stringResource(R.string.jd_min_job_charge), initialValue = job.minimumJobCharge.toFloat(),
            modifier = Modifier.weight(1f)
        ) { viewModel.update { j -> j.copy(minimumJobCharge = it.toDouble()) } }
    }
    if (job.pricingTierName.isNotBlank()) {
        Text(
            stringResource(
                R.string.jd_tier_summary,
                job.pricingTierName,
                "%.2f".format(job.laborRatePerFt),
                "%.0f".format(job.markupPercent)
            ) +
                if (job.discountPercent > 0) " · " + stringResource(R.string.jd_tier_summary_discount, "%.0f".format(job.discountPercent)) else "",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.primary
        )
    }
}

@Composable
private fun TeardownFields(job: Job, viewModel: JobDetailViewModel) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.jd_include_teardown), modifier = Modifier.weight(1f))
        Switch(checked = job.teardownEnabled, onCheckedChange = { viewModel.update { j -> j.copy(teardownEnabled = it) } })
    }
    if (job.teardownEnabled) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            DraftNumberField(
                stableKey = job.id, label = stringResource(R.string.jd_teardown_flat_fee), initialValue = job.teardownFlatFee.toFloat(),
                modifier = Modifier.weight(1f)
            ) { viewModel.update { j -> j.copy(teardownFlatFee = it.toDouble()) } }
            DraftNumberField(
                stableKey = job.id, label = stringResource(R.string.jd_teardown_per_ft), initialValue = job.teardownRatePerFt.toFloat(),
                modifier = Modifier.weight(1f)
            ) { viewModel.update { j -> j.copy(teardownRatePerFt = it.toDouble()) } }
        }
        DraftNumberField(
            stableKey = job.id, label = stringResource(R.string.jd_haul_fee), initialValue = job.trashHaulFee.toFloat(),
            modifier = Modifier.fillMaxWidth()
        ) { viewModel.update { j -> j.copy(trashHaulFee = it.toDouble()) } }
        // The old fence is not always the new fence. Typed rather than drawn:
        // the owner knows it is 80 ft without tracing it, and a separate
        // drawing layer was more ceremony than the answer deserves.
        DraftNumberField(
            stableKey = job.id, label = stringResource(R.string.jd_teardown_length),
            initialValue = job.teardownFeet.toFloat(),
            modifier = Modifier.fillMaxWidth()
        ) { viewModel.update { j -> j.copy(teardownFeet = it.toDouble()) } }
        Text(
            stringResource(R.string.jd_teardown_note),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }

    Spacer(Modifier.height(12.dp))
    Text(stringResource(R.string.jd_gates), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
    DraftNumberField(
        stableKey = job.id, label = stringResource(R.string.jd_gate_rate),
        initialValue = job.gateRatePerFt.toFloat(),
        modifier = Modifier.fillMaxWidth()
    ) { viewModel.update { j -> j.copy(gateRatePerFt = it.toDouble()) } }
    Text(
        stringResource(
            R.string.jd_gate_note,
            "%.0f".format(job.gateRatePerFt),
            "%.0f".format(job.gateRatePerFt * 5)
        ),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
}

@Composable
private fun ScheduleFields(
    job: Job,
    runs: List<FenceRun>,
    timeEntries: List<com.fenceestimator.app.data.TimeEntry>,
    profile: BusinessProfile,
    viewModel: JobDetailViewModel
) {
    val context = LocalContext.current
    val dateFormat = remember { SimpleDateFormat("EEE, MMM d, yyyy", Locale.US) }

    val dateButtonLabel = job.scheduledDate?.let { stringResource(R.string.jd_scheduled_on, dateFormat.format(Date(it))) }
        ?: stringResource(R.string.jd_set_job_date)
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
        Text("  " + dateButtonLabel)
    }

    val pxPerFt = job.calibrationPixelsPerFoot
        ?: com.fenceestimator.app.ui.survey.SurveyViewModel.PIXELS_PER_FOOT_GRID
    val markers by viewModel.siteMarkers.collectAsState()
    val rates = remember(profile) {
        com.fenceestimator.app.estimate.DurationEstimator.Rates(
            feetPerDay = profile.feetPerDay,
            workdayHours = profile.workdayHours,
            breakHoursPerDay = profile.breakHoursPerDay,
            hoursPerGate = profile.hoursPerGate,
            hoursPerTree = profile.hoursPerTree,
            hoursPerObstacle = profile.hoursPerObstacle,
            hoursPerCorner = profile.hoursPerCorner,
            setupHours = profile.setupHours,
            teardownHoursPerFoot = profile.teardownHoursPerFoot
        )
    }
    val estimate = remember(job, runs, rates, markers) {
        com.fenceestimator.app.estimate.DurationEstimator.estimate(job, runs, pxPerFt, rates, markers)
    }

    // Keep the stored duration in step with the footage until someone types
    // their own. Without this, changing the length left the hours frozen.
    LaunchedEffect(estimate.totalHours, job.durationManuallySet) {
        if (!job.durationManuallySet &&
            estimate.totalHours > 0.0 &&
            kotlin.math.abs(estimate.totalHours - job.estimatedDurationHours) > 0.005
        ) {
            viewModel.update { j -> j.copy(estimatedDurationHours = estimate.totalHours) }
        }
    }

    DraftNumberField(
        stableKey = job.id, label = stringResource(R.string.jd_est_duration), initialValue = job.estimatedDurationHours.toFloat(),
        modifier = Modifier.fillMaxWidth()
    ) { viewModel.update { j -> j.copy(estimatedDurationHours = it.toDouble(), durationManuallySet = true) } }
    if (job.durationManuallySet) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                stringResource(R.string.jd_duration_manual),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f)
            )
            TextButton(onClick = {
                viewModel.update { j ->
                    j.copy(durationManuallySet = false, estimatedDurationHours = estimate.totalHours)
                }
            }) { Text(stringResource(R.string.jd_recalculate)) }
        }
    }

    if (estimate.totalHours > 0.0) {
        Text(
            stringResource(R.string.jd_calculated, estimate.summary()),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium
        )
        // Say plainly when one day isn't enough. Booking a customer for a date
        // the work can't finish by is a promise broken before the crew arrives.
        if (estimate.days > 1.05) {
            Card(
                Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
            ) {
                Text(
                    stringResource(
                        R.string.jd_multi_day,
                        "%.1f".format(estimate.days),
                        "%.1f".format(estimate.installHoursPerDay)
                    ),
                    modifier = Modifier.padding(12.dp),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onErrorContainer
                )
            }
        }
        Text(
            stringResource(R.string.jd_duration_basis),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        OutlinedButton(
            onClick = {
                viewModel.update { j -> j.copy(estimatedDurationHours = estimate.totalHours) }
            },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(stringResource(R.string.jd_use_calculated, "%.1f".format(estimate.totalHours)))
        }
    } else {
        Text(
            stringResource(R.string.jd_draw_to_estimate_duration),
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
            stringResource(R.string.jd_actually_took, "%.1f".format(loggedHours)) +
                if (planned > 0) " — " + (
                    if (diff > 0) stringResource(R.string.jd_over_estimate, "%.1f".format(diff))
                    else stringResource(R.string.jd_under_estimate, "%.1f".format(-diff))
                ) else "",
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
            color = if (diff > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
        )
    }

    val scheduledDate = job.scheduledDate
    if (scheduledDate != null) {
        val calendarTitle = stringResource(
            R.string.jd_calendar_title,
            job.customerName.ifBlank { stringResource(R.string.jd_customer_fallback) }
        )
        OutlinedButton(
            onClick = {
                IntentHelpers.addToCalendar(
                    context = context,
                    title = calendarTitle,
                    description = job.notes,
                    location = job.address,
                    startMillis = scheduledDate,
                    durationHours = job.estimatedDurationHours
                )
            },
            modifier = Modifier.fillMaxWidth()
        ) {
            Icon(Icons.Filled.CalendarMonth, contentDescription = null)
            Text("  " + stringResource(R.string.jd_add_to_calendar))
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
            value = selected?.name ?: stringResource(R.string.jd_unassigned), onValueChange = {}, readOnly = true,
            label = { Text(stringResource(R.string.jd_assigned_crew)) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor()
        )
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.jd_unassigned)) },
                onClick = { viewModel.update { j -> j.copy(assignedEmployeeId = null) }; expanded = false }
            )
            employees.forEach { e ->
                DropdownMenuItem(
                    text = { Text(e.name.ifBlank { stringResource(R.string.jd_unnamed) } + if (e.role.isNotBlank()) " · ${e.role}" else "") },
                    onClick = { viewModel.update { j -> j.copy(assignedEmployeeId = e.id) }; expanded = false }
                )
            }
            if (employees.isEmpty()) {
                DropdownMenuItem(text = { Text(stringResource(R.string.jd_no_crew_yet)) }, onClick = { expanded = false })
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
            value = selected?.name ?: stringResource(R.string.jd_no_manufacturer), onValueChange = {}, readOnly = true,
            label = { Text(stringResource(R.string.jd_order_from)) },
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
    val seeAttachedEstimate = stringResource(R.string.jd_see_attached_estimate)
    val orderSubject = stringResource(
        R.string.jd_order_subject,
        job.customerName.ifBlank { stringResource(R.string.jd_customer_fallback) },
        job.address
    )
    Button(
        onClick = {
            val to = selected?.email.orEmpty()
            val runSummary = runs.joinToString("\n") {
                val typeName = context.getString(it.fenceType.labelRes())
                "- ${it.label.ifBlank { typeName }}: $typeName"
            }
            val body = TemplateFiller.fillOrderTemplate(
                template = profile.orderEmailTemplate,
                customerName = job.customerName,
                address = job.address,
                lineItems = runSummary,
                total = seeAttachedEstimate,
                businessName = profile.businessName
            )
            IntentHelpers.openEmailDraft(context, to, orderSubject, body)
        },
        enabled = selected != null,
        modifier = Modifier.fillMaxWidth()
    ) {
        Text(if (selected == null) stringResource(R.string.jd_add_manufacturer_first) else stringResource(R.string.jd_email_order_to, selected.name))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HoaFields(job: Job, runs: List<FenceRun>, profile: BusinessProfile, viewModel: JobDetailViewModel) {
    val context = LocalContext.current
    DraftTextField(stableKey = job.id, initialValue = job.hoaName, label = stringResource(R.string.jd_hoa_name), modifier = Modifier.fillMaxWidth()) {
        viewModel.update { j -> j.copy(hoaName = it) }
    }
    DraftTextField(stableKey = job.id, initialValue = job.hoaEmail, label = stringResource(R.string.jd_hoa_email), keyboardType = KeyboardType.Email, modifier = Modifier.fillMaxWidth()) {
        viewModel.update { j -> j.copy(hoaEmail = it) }
    }
    var hoaExpanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = hoaExpanded, onExpandedChange = { hoaExpanded = it }) {
        OutlinedTextField(
            value = job.hoaApprovalStatus.label(), onValueChange = {}, readOnly = true,
            label = { Text(stringResource(R.string.jd_hoa_status)) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = hoaExpanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor()
        )
        DropdownMenu(expanded = hoaExpanded, onDismissRequest = { hoaExpanded = false }) {
            HoaApprovalStatus.values().forEach { status ->
                DropdownMenuItem(
                    text = { Text(status.label()) },
                    onClick = { viewModel.update { j -> j.copy(hoaApprovalStatus = status) }; hoaExpanded = false }
                )
            }
        }
    }
    val hoaSubject = stringResource(R.string.jd_hoa_subject, job.address)
    Button(
        onClick = {
            val firstRun = runs.firstOrNull()
            val body = TemplateFiller.fillHoaTemplate(
                template = profile.hoaEmailTemplate,
                address = job.address,
                fenceType = firstRun?.fenceType?.let { context.getString(it.labelRes()) } ?: "",
                height = firstRun?.panelHeightFt?.toString() ?: "",
                material = firstRun?.colorOrFinish ?: "",
                businessName = profile.businessName,
                phone = profile.phone
            )
            IntentHelpers.openEmailDraft(context, job.hoaEmail, hoaSubject, body)
            viewModel.update { j -> if (j.hoaApprovalStatus == HoaApprovalStatus.NOT_REQUIRED) j.copy(hoaApprovalStatus = HoaApprovalStatus.PENDING) else j }
        },
        enabled = job.hoaEmail.isNotBlank(),
        modifier = Modifier.fillMaxWidth()
    ) {
        Text(stringResource(R.string.jd_send_hoa_request))
    }

    androidx.compose.foundation.layout.Spacer(Modifier.height(4.dp))
    Text(stringResource(R.string.jd_permit), style = MaterialTheme.typography.titleSmall)
    DraftTextField(stableKey = job.id, initialValue = job.permitNumber, label = stringResource(R.string.jd_permit_number), modifier = Modifier.fillMaxWidth()) {
        viewModel.update { j -> j.copy(permitNumber = it) }
    }
    var permitExpanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = permitExpanded, onExpandedChange = { permitExpanded = it }) {
        OutlinedTextField(
            value = job.permitStatus.label(), onValueChange = {}, readOnly = true,
            label = { Text(stringResource(R.string.jd_permit_status)) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = permitExpanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor()
        )
        DropdownMenu(expanded = permitExpanded, onDismissRequest = { permitExpanded = false }) {
            PermitStatus.values().forEach { status ->
                DropdownMenuItem(
                    text = { Text(status.label()) },
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
            value = job.paymentStatus.label(), onValueChange = {}, readOnly = true,
            label = { Text(stringResource(R.string.jd_payment_status)) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor()
        )
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            PaymentStatus.values().forEach { status ->
                DropdownMenuItem(
                    text = { Text(status.label()) },
                    onClick = { viewModel.update { j -> j.copy(paymentStatus = status) }; expanded = false }
                )
            }
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        DraftNumberField(
            stableKey = job.id,
            label = stringResource(R.string.jd_deposit_amount), initialValue = job.depositAmount.toFloat(),
            modifier = Modifier.weight(1f)
        ) { viewModel.update { j -> j.copy(depositAmount = it.toDouble()) } }

        // Once a card has actually been charged, this stops being a field you
        // fill in and becomes a record of what happened. Typing over it would
        // not correct anything -- Stripe would still hold the real figure --
        // it would just create a disagreement that surfaces when the customer
        // queries the bill.
        // netPaid, so this agrees with "Paid so far" further down the same
        // screen. Showing the gross figure here meant a refunded job displayed
        // two different "paid" numbers a few inches apart.
        OutlinedTextField(
            value = "$${"%.2f".format(JobMoney.netPaid(job))}",
            onValueChange = {},
            readOnly = true,
            enabled = false,
            label = { Text(stringResource(R.string.jd_total_paid)) },
            supportingText = {
                Text(
                    stringResource(if (job.paymentsFromProcessor) R.string.jd_paid_auto_updates else R.string.jd_paid_use_record)
                )
            },
            modifier = Modifier.weight(1f)
        )
    }

    if (job.refundedAmount > 0.0) {
        Text(
            stringResource(R.string.jd_refunded_amount, "%.2f".format(job.refundedAmount)) +
                if (job.refundReason.isNotBlank()) " -- ${job.refundReason}" else "",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
            modifier = Modifier.padding(top = 4.dp)
        )
    }

    // A deposit that doesn't cover materials means buying the customer's fence
    // with your own money, so offer the covering figure in one tap.
    val materialCost by viewModel.materialCost.collectAsState()

    // And fill it in automatically the first time there is a figure to use.
    // Waiting for someone to notice the button is how the default becomes
    // "no deposit at all".
    LaunchedEffect(materialCost) { viewModel.autoFillDepositFromMaterials() }
    // suggestedDeposit() is already net of what has been paid, and returns zero
    // once payments cover materials -- so this disappears rather than asking for
    // money that has already changed hands.
    val suggested = viewModel.suggestedDeposit()
    val paidSoFar = JobMoney.netPaid(job)
    if (suggested > 0.0 && job.depositAmount < materialCost) {
        OutlinedButton(
            onClick = { viewModel.applySuggestedDeposit() },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(stringResource(R.string.jd_set_deposit_covers, "%.0f".format(suggested)))
        }
        Text(
            if (paidSoFar > 0.005)
                stringResource(
                    R.string.jd_materials_partly_paid,
                    "%.2f".format(materialCost),
                    "%.2f".format(paidSoFar),
                    "%.2f".format(materialCost - paidSoFar)
                )
            else
                stringResource(R.string.jd_materials_come_to, "%.2f".format(materialCost)),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
    val context = LocalContext.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var creatingLink by remember { mutableStateOf(false) }
    var linkError by remember { mutableStateOf<String?>(null) }
    // Null until a link is made this session: test and live links look identical,
    // and the difference is whether a real card gets charged.
    var liveLink by remember { mutableStateOf<Boolean?>(null) }

    // Everything billable is now derived from the estimate net of refunds, in
    // JobMoney, so the screen, the PDF and the payment link cannot disagree.

    // ---- One contract figure, derived from the estimate ----
    //
    // The deposit used to be a number typed by hand with nothing checking it
    // against the estimate, and the payment link billed that. So the customer
    // could be charged a figure the estimate never said. Everything below hangs
    // off the estimate total instead, and anything that disagrees with it is
    // called out rather than quietly billed.
    val totals by viewModel.contractTotal.collectAsState()
    val contractTotal = totals.grandTotal
    val netPaid = JobMoney.netPaid(job)
    val stillOwed = JobMoney.stillOwed(job, contractTotal)

    // The backend books the money; this decides whether that finishes the job.
    // It has the contract total and the server does not.
    LaunchedEffect(job.amountPaid, job.refundedAmount, contractTotal) {
        viewModel.reconcilePaymentStatus()
    }

    // Pull the moment this screen is looked at.
    //
    // Opening the job and finding a stale figure sent people to Settings to
    // press Sync and then back again -- at which point the app has taught them
    // it cannot be trusted without being nursed. The screen that shows money is
    // the one screen that should never be showing yesterday's answer.
    val paymentApp = currentApp()
    LaunchedEffect(job.id) { paymentApp.autoSync.requestSync() }

    // While a payment link is out and unpaid, check often.
    //
    // The push notification is the fast path, but it only fires if notifications
    // are allowed and Firebase can reach the phone. Someone watching this screen
    // waiting for a customer to pay is the one moment where a fifteen-minute
    // heartbeat is plainly too slow, so poll while they are actually looking --
    // and stop the moment they leave, which is what makes this affordable.
    val awaitingPayment = job.paymentLinkUrl.isNotBlank() && stillOwed > 0.005
    if (awaitingPayment) {
        LaunchedEffect(job.id) {
            while (true) {
                kotlinx.coroutines.delay(20_000)
                paymentApp.autoSync.requestSync()
            }
        }
    }
    val depositOverContract = contractTotal > 0.0 && job.depositAmount > contractTotal + 0.005
    val paidOverContract = JobMoney.overpaid(job, contractTotal)

    if (contractTotal > 0.0) {
        Card(
            Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
        ) {
            Column(Modifier.padding(12.dp)) {
                MoneyLine(stringResource(R.string.jd_contract_total), contractTotal)
                // With a refund in play the lines have to SUM: paid gross,
                // minus refunded, equals kept. The old box put the net figure
                // on the "Paid so far" line and then listed the refund under
                // it anyway -- so reading top to bottom subtracted the refund
                // twice and arrived at a number that matched nothing below.
                if (job.refundedAmount > 0.005) {
                    MoneyLine(stringResource(R.string.jd_paid_in_total), job.amountPaid)
                    MoneyLine(stringResource(R.string.jd_refunded), -job.refundedAmount)
                    MoneyLine(stringResource(R.string.jd_kept_after_refunds), netPaid)
                } else {
                    MoneyLine(stringResource(R.string.jd_paid_so_far), netPaid)
                }
                // Signed, not floored. An overpaid customer used to read as
                // "Still owed $0.00", which hides the fact that money is owed
                // the other way -- and that is a thing to act on before they
                // ask for it.
                val balance = JobMoney.balance(job, contractTotal)
                if (balance < -0.005) {
                    MoneyLine(stringResource(R.string.jd_you_owe_customer), -balance, bold = true)
                } else {
                    MoneyLine(stringResource(R.string.jd_still_owed), balance.coerceAtLeast(0.0), bold = true)
                }
                if (job.amountPaid > 0.0) {
                    Text(
                        when {
                            balance < -0.005 ->
                                stringResource(R.string.jd_overpaid_by, "%.2f".format(-balance))
                            balance <= 0.005 -> stringResource(R.string.jd_paid_in_full)
                            else -> stringResource(R.string.jd_card_payments_auto)
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSecondaryContainer
                    )
                }
                if (totals.changeOrderCost > 0.0) {
                    Text(
                        stringResource(R.string.jd_includes_extra_work, "%.2f".format(totals.changeOrderCost)),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSecondaryContainer
                    )
                }
            }
        }
        if (depositOverContract || paidOverContract) {
            Card(
                Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
            ) {
                Column(Modifier.padding(12.dp)) {
                    Text(
                        if (paidOverContract)
                            stringResource(R.string.jd_paid_over_contract, "%.2f".format(netPaid), "%.2f".format(contractTotal))
                        else
                            stringResource(R.string.jd_deposit_over_contract, "%.2f".format(job.depositAmount), "%.2f".format(contractTotal)),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onErrorContainer
                    )
                    if (paidOverContract) {
                        Text(
                            stringResource(R.string.jd_give_back, "%.2f".format(JobMoney.refundable(job, contractTotal))),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            modifier = Modifier.padding(top = 6.dp)
                        )
                    }
                }
            }
        }

        RecordPaymentControl(job = job, contractTotal = contractTotal, viewModel = viewModel)
        RefundControl(job = job, contractTotal = contractTotal, viewModel = viewModel)
        Spacer(Modifier.height(8.dp))
    }

    // Stripe runs through the backend, so there is no key on this phone to set
    // up and nothing to leak if the phone is lost.
    //
    // What to charge, in the order a job actually goes: the unpaid part of the
    // deposit first, then whatever the estimate says is still owed. Falling
    // back to the deposit alone was how a final payment could be billed at the
    // deposit figure instead of the balance.
    // The old fallback was "the deposit", which is how a fully paid job still
    // offered to charge $5,730 -- the original deposit, for money already
    // collected. There is no case where the right answer is a figure from
    // earlier in the job: it is always what is left.
    // Card payments are sold with the Crew plan. The server refuses the link
    // call for Solo companies, so showing these controls would only ever show
    // an error message. Cash and check recording above is every plan's.
    if (com.fenceestimator.app.ui.components.LocalEntitlements.current.cardPayments) {
    val paymentDescription = stringResource(R.string.jd_payment_description, job.address.ifBlank { job.customerName })
    val requestAmount = JobMoney.nextRequestAmount(job, contractTotal)
    val requestLabel = JobMoney.nextRequestLabel(job, contractTotal)
    Button(
        onClick = {
            scope.launch {
                creatingLink = true
                linkError = null
                val result = PaymentsApi.createPaymentLink(
                    jobSyncId = job.syncId,
                    amountDollars = requestAmount,
                    kind = if (requestLabel == "balance") PaymentsApi.Kind.FINAL
                    else PaymentsApi.Kind.DEPOSIT,
                    description = paymentDescription
                )
                creatingLink = false
                when (result) {
                    is PaymentsApi.Result.Ok -> {
                        liveLink = result.liveMode
                        viewModel.update { j ->
                            j.copy(paymentLinkUrl = result.url, paymentLinkAmount = requestAmount)
                        }
                    }
                    is PaymentsApi.Result.Failed -> linkError = result.reason
                }
            }
        },
        // No payment is asked for before the customer has signed. Money
        // requested against an unsigned estimate is money argued about later.
        enabled = !creatingLink && requestAmount >= 0.50 && job.signedAt != null,
        modifier = Modifier.fillMaxWidth()
    ) {
        Text(
            when {
                creatingLink -> stringResource(R.string.jd_creating_link)
                requestAmount >= 0.50 -> stringResource(R.string.jd_request_by_card, "%.2f".format(requestAmount), requestLabel)
                else -> stringResource(R.string.jd_request_payment_by_card)
            }
        )
    }
    // A grey button with no reason reads as the app being broken.
    if (job.signedAt == null) {
        Text(
            stringResource(R.string.jd_payment_after_signature),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
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
    liveLink?.let { isLive ->
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(
                containerColor = if (isLive) MaterialTheme.colorScheme.errorContainer
                else MaterialTheme.colorScheme.secondaryContainer
            )
        ) {
            Text(
                stringResource(if (isLive) R.string.jd_live_mode else R.string.jd_test_mode),
                modifier = Modifier.padding(12.dp),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                color = if (isLive) MaterialTheme.colorScheme.onErrorContainer
                else MaterialTheme.colorScheme.onSecondaryContainer
            )
        }
        Spacer(Modifier.height(8.dp))
    }
    Text(
        stringResource(R.string.jd_stripe_explain),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
    if (requestAmount < 0.50) {
        Text(
            stringResource(R.string.jd_set_deposit_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }

    DraftTextField(
        stableKey = job.id, initialValue = job.paymentLinkUrl,
        label = stringResource(R.string.jd_payment_link),
        modifier = Modifier.fillMaxWidth()
    ) { viewModel.update { j -> j.copy(paymentLinkUrl = it) } }
    Text(
        stringResource(R.string.jd_payment_link_hint),
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
                    stringResource(R.string.jd_link_stale, "%.2f".format(job.paymentLinkAmount), "%.2f".format(requestAmount)),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onErrorContainer
                )
                Text(
                    stringResource(R.string.jd_link_stale_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onErrorContainer
                )
            }
        }
        Spacer(Modifier.height(8.dp))
    }

    if (job.paymentLinkUrl.isNotBlank()) {
        // Naming the amount in the message means the customer can
        // check it against the estimate before they tap anything.
        val amountText = if (job.paymentLinkAmount > 0.0) " " + stringResource(R.string.jd_for_amount, "%.2f".format(job.paymentLinkAmount)) else ""
        val greetingName = job.customerName.ifBlank { stringResource(R.string.jd_there) }
        val smsBody = stringResource(R.string.jd_payment_sms_body, greetingName, amountText, job.address, job.paymentLinkUrl)
        val emailBody = stringResource(R.string.jd_payment_email_body, greetingName, amountText, job.address, job.paymentLinkUrl)
        val emailSubject = stringResource(R.string.jd_payment_email_subject)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedButton(
                onClick = { IntentHelpers.openSmsDraft(context, job.phone, smsBody) },
                enabled = job.phone.isNotBlank() && !linkIsStale,
                modifier = Modifier.weight(1f)
            ) { Text(stringResource(R.string.jd_text_link)) }
            Button(
                onClick = { IntentHelpers.openEmailDraft(context, job.email, emailSubject, emailBody) },
                enabled = job.email.isNotBlank() && !linkIsStale,
                modifier = Modifier.weight(1f)
            ) { Text(stringResource(R.string.jd_email_link)) }
        }
    }
    }

    androidx.compose.foundation.layout.Spacer(Modifier.height(4.dp))
    DraftNumberField(
        stableKey = job.id, label = stringResource(R.string.jd_tip_label),
        initialValue = job.tipAmount.toFloat(),
        modifier = Modifier.fillMaxWidth()
    ) { viewModel.update { j -> j.copy(tipAmount = it.toDouble()) } }
    if (job.tipAmount > 0.0) {
        Text(
            stringResource(R.string.jd_tip_recorded, "%.2f".format(job.tipAmount)),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }

    if (job.isInvoiced) {
        Text(
            stringResource(R.string.jd_invoice_generated),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    } else {
        Text(
            stringResource(R.string.jd_invoice_hint),
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
            stringResource(R.string.jd_no_expenses),
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
                    Text(expense.description.ifBlank { expense.category.label() }, fontWeight = FontWeight.Medium)
                    Text(
                        expense.category.label(),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Text("$${String.format("%.2f", expense.amount)}")
                if (canDelete) {
                    IconButton(onClick = { viewModel.deleteExpense(expense) }) {
                        Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.jd_remove_expense))
                    }
                }
            }
        }
        Text(stringResource(R.string.jd_total_expenses, String.format("%.2f", total)), fontWeight = FontWeight.Medium)
    }
    OutlinedButton(onClick = { showAdd = true }, modifier = Modifier.fillMaxWidth()) {
        Icon(Icons.Filled.Add, contentDescription = null)
        Text("  " + stringResource(R.string.jd_add_expense))
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
        title = { Text(stringResource(R.string.jd_add_expense)) },
        text = {
            Column {
                ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
                    OutlinedTextField(
                        value = category.label(), onValueChange = {}, readOnly = true,
                        label = { Text(stringResource(R.string.jd_category)) },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
                        modifier = Modifier.fillMaxWidth().menuAnchor()
                    )
                    DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                        ExpenseCategory.values().forEach { c ->
                            DropdownMenuItem(text = { Text(c.label()) }, onClick = { category = c; expanded = false })
                        }
                    }
                }
                androidx.compose.foundation.layout.Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = description, onValueChange = { description = it },
                    label = { Text(stringResource(R.string.est_description)) }, modifier = Modifier.fillMaxWidth()
                )
                androidx.compose.foundation.layout.Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = amountText, onValueChange = { amountText = it },
                    label = { Text(stringResource(R.string.jd_amount)) },
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            Button(onClick = { onConfirm(category, description, amountText.toDoubleOrNull() ?: 0.0) }) { Text(stringResource(R.string.action_add)) }
        },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } }
    )
}

@Composable
/** Button wording for where a step gets finished, or null if it's finished right here. */
private fun stageDestination(action: StageAction): String? = when (action) {
    StageAction.DRAW -> stringResource(R.string.jd_go_to_draw)
    StageAction.ESTIMATE -> stringResource(R.string.jd_go_to_estimate)
    StageAction.CREW_VIEW -> stringResource(R.string.jd_go_to_crew_view)
    StageAction.PAYMENT -> stringResource(R.string.jd_go_to_payment)
    StageAction.HOA -> stringResource(R.string.jd_go_to_hoa)
    StageAction.SCHEDULE -> stringResource(R.string.jd_go_to_scheduling)
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
        stringResource(R.string.jd_steps_done, doneCount, stages.size),
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
                "  " + stringResource(stage.labelRes),
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (stage.current) FontWeight.SemiBold else FontWeight.Normal,
                color = if (stage.done || stage.current) MaterialTheme.colorScheme.onSurface
                    else MaterialTheme.colorScheme.onSurfaceVariant
            )
            if (stage.current) {
                Text(
                    stringResource(R.string.jd_next),
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
            title = { Text(stringResource(stage.labelRes)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        stringResource(if (stage.done) R.string.jd_stage_done else if (stage.current) R.string.jd_stage_next else R.string.jd_stage_not_done),
                        fontWeight = FontWeight.Medium,
                        color = if (stage.done) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.onSurface
                    )
                    Text(stringResource(stage.guidanceRes), style = MaterialTheme.typography.bodyMedium)
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
                    Button(onClick = { openStage = null }) { Text(stringResource(R.string.jd_got_it)) }
                }
            },
            dismissButton = {
                if (stageDestination(stage.action) != null && !stage.done) {
                    OutlinedButton(onClick = { openStage = null }) { Text(stringResource(R.string.jd_close)) }
                }
            }
        )
    }
    Text(
        stringResource(R.string.jd_send_update_hint),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
    val updateSubject = stringResource(R.string.jd_update_subject)
    // The update goes out as plain SMS/email text, so the resources are
    // resolved right here, through the context, at the moment it is built.
    val resolve: (Int, List<Any>) -> String =
        { res, args -> context.getString(res, *args.toTypedArray()) }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlinedButton(
            onClick = {
                IntentHelpers.openSmsDraft(context, job.phone, ProjectStatus.asMessage(job, jobComplete, profile.businessName, resolve))
            },
            enabled = job.phone.isNotBlank(),
            modifier = Modifier.weight(1f)
        ) { Text(stringResource(R.string.jd_text_update)) }
        OutlinedButton(
            onClick = {
                IntentHelpers.openEmailDraft(
                    context, job.email, updateSubject,
                    ProjectStatus.asMessage(job, jobComplete, profile.businessName, resolve)
                )
            },
            enabled = job.email.isNotBlank(),
            modifier = Modifier.weight(1f)
        ) { Text(stringResource(R.string.jd_email_update)) }
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
                    Text(stringResource(R.string.jd_extra_work_approved), color = MaterialTheme.colorScheme.onSecondaryContainer)
                    Text(
                        "+$${"%.2f".format(totals.changeOrderCost)}" +
                            if (totals.changeOrderFeet > 0) "  " + stringResource(R.string.jd_plus_feet_paren, "%.0f".format(totals.changeOrderFeet)) else "",
                        fontWeight = FontWeight.Medium,
                        color = MaterialTheme.colorScheme.onSecondaryContainer
                    )
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(stringResource(R.string.jd_new_contract_total), fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSecondaryContainer)
                    Text(
                        "$${"%.2f".format(totals.grandTotal)}",
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onSecondaryContainer
                    )
                }
                Text(
                    stringResource(R.string.jd_extra_feet_note),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSecondaryContainer
                )
            }
        }
        Spacer(Modifier.height(8.dp))
    }

    if (orders.isEmpty()) {
        Text(
            stringResource(R.string.jd_no_change_orders),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    } else {
        orders.forEach { order ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(order.description.ifBlank { stringResource(R.string.jd_extra_work) }, fontWeight = FontWeight.Medium)
                            val plusFeet = if (order.additionalFeet > 0) stringResource(R.string.jd_plus_feet, "%.0f".format(order.additionalFeet)) + "  ·  " else ""
                            Text(
                                buildString {
                                    append(plusFeet)
                                    append("$${"%.2f".format(order.additionalCost)}")
                                    append("  ·  ${dateFormat.format(Date(order.createdAt))}")
                                },
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        IconButton(onClick = { editingOrder = order }) {
                            Icon(Icons.Filled.Edit, contentDescription = stringResource(R.string.jd_edit_change_order))
                        }
                        if (canDelete) {
                            IconButton(onClick = { viewModel.deleteChangeOrder(order) }) {
                                Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.jd_remove_change_order))
                            }
                        }
                    }
                    if (order.materialCost > 0) {
                        Text(
                            stringResource(R.string.jd_includes_materials, "%.2f".format(order.materialCost)),
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
                                order.signedAt?.let { stringResource(R.string.jd_signed_on, dateFormat.format(Date(it))) }.orEmpty(),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    } else {
                        Button(onClick = { signingOrder = order }, modifier = Modifier.fillMaxWidth()) {
                            Text(stringResource(R.string.jd_get_signature))
                        }
                    }
                }
            }
        }
        val signedTotal = orders.filter { it.isSigned }.sumOf { it.additionalCost }
        Text(stringResource(R.string.jd_approved_extra_work, "%.2f".format(signedTotal)), fontWeight = FontWeight.Medium)
    }

    OutlinedButton(onClick = { showAdd = true }, modifier = Modifier.fillMaxWidth()) {
        Icon(Icons.Filled.Add, contentDescription = null)
        Text("  " + stringResource(R.string.jd_add_change_order))
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
        title = { Text(stringResource(if (existing == null) R.string.jd_additional_work_auth else R.string.jd_edit_change_order_title)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                OutlinedTextField(
                    value = description, onValueChange = { description = it },
                    label = { Text(stringResource(R.string.jd_whats_added)) }, minLines = 2, modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = feetText, onValueChange = { feetText = it },
                    label = { Text(stringResource(R.string.jd_additional_feet)) },
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = costText, onValueChange = { costText = it },
                    label = { Text(stringResource(R.string.jd_total_charged)) },
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = materialText, onValueChange = { materialText = it },
                    label = { Text(stringResource(R.string.jd_of_that_materials)) },
                    isError = materialsTooHigh,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth()
                )
                Text(
                    stringResource(if (materialsTooHigh) R.string.jd_materials_too_high else R.string.jd_materials_note),
                    style = MaterialTheme.typography.bodySmall,
                    color = if (materialsTooHigh) MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.onSurfaceVariant
                )
                if (existing?.signatureImagePath != null) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        stringResource(R.string.jd_signature_clears),
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
            ) { Text(stringResource(if (existing == null) R.string.action_add else R.string.action_save)) }
        },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } }
    )
}

@Composable
private fun PunchListSection(items: List<PunchListItem>, canDelete: Boolean, viewModel: JobDetailViewModel) {
    var newItemText by remember { mutableStateOf("") }

    if (items.isEmpty()) {
        Text(
            stringResource(R.string.jd_no_punch_items),
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
                        Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.jd_remove_item))
                    }
                }
            }
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = newItemText, onValueChange = { newItemText = it },
            label = { Text(stringResource(R.string.jd_new_callback_item)) }, modifier = Modifier.weight(1f)
        )
        Button(onClick = {
            if (newItemText.isNotBlank()) {
                viewModel.addPunchListItem(newItemText)
                newItemText = ""
            }
        }) { Text(stringResource(R.string.action_add)) }
    }
}

@Composable
private fun ReviewRequestFields(job: Job, profile: BusinessProfile, viewModel: JobDetailViewModel) {
    val context = LocalContext.current
    val allJobs by viewModel.allJobs.collectAsState()

    // A customer who has used you before is a different ask, so it is worked
    // out rather than remembered -- matched on name, since the same person
    // booking twice is two job records.
    val isRepeat = remember(allJobs, job.id) {
        allJobs.count {
            it.id != job.id &&
                it.customerName.isNotBlank() &&
                it.customerName.equals(job.customerName, ignoreCase = true)
        } > 0
    }

    var template by remember(job.id) {
        mutableStateOf(com.fenceestimator.app.data.ReviewTemplate.suggestFor(job, isRepeat))
    }
    // Editable before it goes out, because the person sending it knows things
    // the job record never will.
    var body by remember(template, job.id) {
        mutableStateOf(
            TemplateFiller.fillReviewTemplate(
                template = template.body,
                customerName = job.customerName,
                businessName = profile.businessName
            ).replace("{reviewLink}", profile.reviewRequestTemplate.takeIf { it.startsWith("http") } ?: "")
                .trim()
        )
    }

    Text(
        stringResource(R.string.jd_review_send_when),
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )

    Text(stringResource(R.string.jd_which_message), style = MaterialTheme.typography.labelLarge)
    com.fenceestimator.app.data.ReviewTemplate.values().forEach { option ->
        Row(
            Modifier.fillMaxWidth().padding(vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            androidx.compose.material3.RadioButton(
                selected = template == option,
                onClick = { template = option }
            )
            Column(Modifier.padding(start = 4.dp)) {
                Text(option.label(), style = MaterialTheme.typography.bodyMedium)
                Text(
                    option.describes(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }

    OutlinedTextField(
        value = body,
        onValueChange = { body = it },
        label = { Text(stringResource(R.string.jd_message)) },
        modifier = Modifier.fillMaxWidth()
    )

    val thanksSubject = stringResource(R.string.jd_thanks_from, profile.businessName.ifBlank { stringResource(R.string.jd_us) })
    val reviewChooserTitle = stringResource(R.string.jd_send_review_request)
    // The share sheet first, because it is the one that always works. Email and
    // SMS both assume you know how this customer wants to be reached, and half
    // the time the number on file is a landline or they only answer WhatsApp.
    Button(
        onClick = {
            IntentHelpers.shareText(
                context = context,
                subject = thanksSubject,
                body = body,
                chooserTitle = reviewChooserTitle
            )
        },
        modifier = Modifier.fillMaxWidth()
    ) {
        Icon(Icons.Filled.Star, contentDescription = null)
        Text("  " + stringResource(R.string.crew_send_request))
    }

    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlinedButton(
            onClick = { IntentHelpers.openSmsDraft(context, job.phone, body) },
            enabled = job.phone.isNotBlank(),
            modifier = Modifier.weight(1f)
        ) { Text(stringResource(R.string.jd_text)) }
        OutlinedButton(
            onClick = {
                IntentHelpers.openEmailDraft(
                    context,
                    job.email,
                    thanksSubject,
                    body
                )
            },
            enabled = job.email.isNotBlank(),
            modifier = Modifier.weight(1f)
        ) { Text(stringResource(R.string.field_email)) }
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
        Text(kind.label(), style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = {
                pendingKind = kind
                val target = PhotoFiles.newTarget(context, "photos")
                pendingTarget = target
                cameraLauncher.launch(target.uri)
            }) {
                Icon(Icons.Filled.CameraAlt, contentDescription = null)
                Text(" " + stringResource(R.string.jd_camera))
            }
            OutlinedButton(onClick = {
                pendingKind = kind
                galleryLauncher.launch(androidx.activity.result.PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
            }) {
                Icon(Icons.Filled.PhotoLibrary, contentDescription = null)
                Text(" " + stringResource(R.string.jd_gallery))
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
                                Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.jd_remove_photo), tint = MaterialTheme.colorScheme.error)
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
private const val SECTION_LOCATE = "locate"
private const val SECTION_PAYMENT = "payment"

/**
 * Recording money handed back.
 *
 * Deliberately an explicit action rather than letting the paid figure be edited
 * down. Sync keeps the larger payment figure so a race can never erase money,
 * which means "just type a smaller number" cannot work -- and should not: a
 * refund is a thing that happened, with a date and a reason, not a correction
 * to a number. The customer may ask about it a year from now.
 */
@Composable
private fun RefundControl(job: Job, contractTotal: Double, viewModel: JobDetailViewModel) {
    val netPaid = JobMoney.netPaid(job)
    if (netPaid <= 0.005) return

    var showDialog by remember { mutableStateOf(false) }
    val overpaid = JobMoney.refundable(job, contractTotal)

    OutlinedButton(
        onClick = { showDialog = true },
        modifier = Modifier.fillMaxWidth()
    ) { Text(stringResource(R.string.jd_record_refund)) }

    if (showDialog) {
        // Pre-filled with the overpayment when there is one, because that is
        // the figure being given back in the overwhelmingly common case.
        var amountText by remember {
            // Locale.US, because this string is PARSED back by toDoubleOrNull.
            // On a Spanish or French phone the default locale writes "39916,85",
            // the parse fails, and the prefilled refund silently became zero.
            mutableStateOf(if (overpaid > 0.005) "%.2f".format(java.util.Locale.US, overpaid) else "")
        }
        var reason by remember { mutableStateOf("") }
        val amount = amountText.toDoubleOrNull() ?: 0.0
        val tooMuch = amount > netPaid + 0.005

        AlertDialog(
            onDismissRequest = { showDialog = false },
            title = { Text(stringResource(R.string.jd_record_refund)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        stringResource(R.string.jd_collected_so_far, "%.2f".format(netPaid)),
                        style = MaterialTheme.typography.bodyMedium
                    )
                    OutlinedTextField(
                        value = amountText,
                        onValueChange = { amountText = it.replace(',', '.').filter { c -> c.isDigit() || c == '.' } },
                        label = { Text(stringResource(R.string.jd_refund_amount)) },
                        isError = tooMuch,
                        supportingText = if (tooMuch) {
                            { Text(stringResource(R.string.jd_refund_too_much)) }
                        } else null,
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = reason,
                        onValueChange = { reason = it },
                        label = { Text(stringResource(R.string.jd_reason)) },
                        placeholder = { Text(stringResource(R.string.jd_reason_placeholder)) },
                        modifier = Modifier.fillMaxWidth()
                    )
                    // Said plainly, because it is the part people get wrong: the
                    // app records the refund, it does not move the money.
                    Text(
                        stringResource(R.string.jd_refund_note),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            },
            confirmButton = {
                Button(
                    enabled = amount > 0.0 && !tooMuch,
                    onClick = {
                        viewModel.recordRefund(amount, reason.trim())
                        showDialog = false
                    }
                ) { Text(stringResource(R.string.jd_record)) }
            },
            dismissButton = {
                OutlinedButton(onClick = { showDialog = false }) { Text(stringResource(R.string.action_cancel)) }
            }
        )
    }
}

/**
 * Tells you when the customer's signature no longer covers the job.
 *
 * The failure this prevents is quiet and expensive: the layout gets redrawn
 * after the customer signs, and the signature on file stays attached to a price
 * and a length that no longer exist. Nobody notices until the bill is queried,
 * and by then the signed document actively contradicts the invoice.
 */
@Composable
private fun StaleSignatureBanner(
    job: Job,
    contractTotal: Double,
    linearFeet: Float,
    onGetNewSignature: () -> Unit
) {
    if (!JobMoney.signatureIsStale(job, contractTotal, linearFeet)) return

    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                stringResource(R.string.jd_stale_sig_title),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onErrorContainer
            )
            val reason = JobMoney.staleSignatureReasonParts(job, contractTotal, linearFeet)
                .map { (res, args) -> stringResource(res, *args.toTypedArray()) }
                .joinToString(" " + stringResource(R.string.eng2_reason_joiner) + " ")
            Text(
                stringResource(
                    R.string.jd_stale_sig_body,
                    job.customerName.ifBlank { stringResource(R.string.jd_the_customer) },
                    reason
                ),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onErrorContainer
            )
            Button(onClick = onGetNewSignature, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.jd_get_new_signature))
            }
        }
    }
}

/**
 * Logging money taken in person.
 *
 * Deliberately an "add" rather than an editable total. A typed total is a number
 * anyone can overwrite: type 500 on a job that already had a 500 deposit banked
 * and the second replaces the first instead of adding to it, and the job now
 * says the customer owes 500 they have already paid. Card payments post
 * themselves through the change feed, so every route into this figure is an
 * addition and none of them is a keystroke over the top of another.
 */
@Composable
private fun RecordPaymentControl(job: Job, contractTotal: Double, viewModel: JobDetailViewModel) {
    var showDialog by remember { mutableStateOf(false) }
    val owed = JobMoney.stillOwed(job, contractTotal)

    OutlinedButton(onClick = { showDialog = true }, modifier = Modifier.fillMaxWidth()) {
        Text(stringResource(R.string.jd_record_payment_button))
    }

    if (showDialog) {
        // Pre-filled with what is outstanding, since paying off the balance is
        // the common case and retyping a figure the app already knows is how
        // typos get in.
        // Locale.US for the same reason as the refund prefill: it is parsed back.
        var amountText by remember { mutableStateOf(if (owed > 0.005) "%.2f".format(java.util.Locale.US, owed) else "") }
        var method by remember { mutableStateOf(com.fenceestimator.app.data.PaymentMethod.CASH) }
        var reference by remember { mutableStateOf("") }
        val dayFormat = remember { java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US) }
        var dateText by remember { mutableStateOf(dayFormat.format(java.util.Date())) }
        val amount = amountText.toDoubleOrNull() ?: 0.0
        val parsedDate = remember(dateText) {
            runCatching { dayFormat.parse(dateText)?.time }.getOrNull()
        }

        // The same money, twice. A card payment posts itself through the
        // webhook, and the natural next move is to also write it down by hand
        // -- the ledger shows $10,930 arriving twice a minute apart that way.
        // The job then reads as overpaid by exactly one payment, refunds get
        // measured against money that never existed, and the books are wrong
        // in the worst direction. Warned rather than blocked: two genuinely
        // equal payments can happen, but never silently.
        val ledger by viewModel.payments.collectAsState()
        val looksDuplicate = amount > 0.0 && ledger.any { p ->
            p.amount > 0 && kotlin.math.abs(p.amount - amount) < 0.005 &&
                kotlin.math.abs(p.receivedAt - (parsedDate ?: 0L)) < 3L * 24 * 60 * 60 * 1000
        }

        AlertDialog(
            onDismissRequest = { showDialog = false },
            title = { Text(stringResource(R.string.jd_record_payment)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        stringResource(R.string.jd_already_recorded, "%.2f".format(JobMoney.netPaid(job))) +
                            if (owed > 0.005) "\n" + stringResource(R.string.jd_still_owed_amount, "%.2f".format(owed)) else "",
                        style = MaterialTheme.typography.bodyMedium
                    )
                    OutlinedTextField(
                        value = amountText,
                        onValueChange = { amountText = it.replace(',', '.').filter { c -> c.isDigit() || c == '.' } },
                        label = { Text(stringResource(R.string.jd_amount_received)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )

                    // How it arrived, and when. Both go on the ledger row: the
                    // method is what reconciles against a bank statement, and
                    // the date is what decides which month the money counts in.
                    // Defaulting the date to today is right most of the time and
                    // wrong exactly when someone is catching up on paperwork,
                    // which is when it matters.
                    Text(stringResource(R.string.jd_how_arrived), style = MaterialTheme.typography.labelLarge)
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf(
                            com.fenceestimator.app.data.PaymentMethod.CASH,
                            com.fenceestimator.app.data.PaymentMethod.CHECK,
                            com.fenceestimator.app.data.PaymentMethod.BANK_TRANSFER
                        ).forEach { option ->
                            FilterChip(
                                selected = method == option,
                                onClick = { method = option },
                                label = { Text(option.label()) }
                            )
                        }
                    }
                    if (method == com.fenceestimator.app.data.PaymentMethod.CHECK) {
                        OutlinedTextField(
                            value = reference,
                            onValueChange = { reference = it },
                            label = { Text(stringResource(R.string.jd_check_number)) },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                    OutlinedTextField(
                        value = dateText,
                        onValueChange = { dateText = it },
                        label = { Text(stringResource(R.string.jd_date_received)) },
                        isError = parsedDate == null,
                        supportingText = if (parsedDate == null) {
                            { Text(stringResource(R.string.jd_date_format_hint)) }
                        } else null,
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    if (looksDuplicate) {
                        Text(
                            stringResource(R.string.jd_duplicate_payment, "%.2f".format(amount)),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.error
                        )
                    }
                    Text(
                        stringResource(R.string.jd_payment_adds_note),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            },
            confirmButton = {
                Button(
                    enabled = amount > 0.0 && parsedDate != null,
                    onClick = {
                        viewModel.recordPayment(
                            amount = amount,
                            method = method,
                            receivedAt = parsedDate ?: System.currentTimeMillis(),
                            reference = reference.trim(),
                            note = ""
                        )
                        showDialog = false
                    }
                ) { Text(if (looksDuplicate) stringResource(R.string.jd_add_anyway) else stringResource(R.string.jd_add_amount, "%.2f".format(amount))) }
            },
            dismissButton = { OutlinedButton(onClick = { showDialog = false }) { Text(stringResource(R.string.action_cancel)) } }
        )
    }
}


/**
 * The quote link's key, fetched at the moment of sharing rather than synced.
 *
 * The token is a live credential -- whoever holds it can read the quote and
 * approve it. Keeping it out of the phone's database means a lost handset's
 * local data cannot leak every customer's quote link; the phone asks for one
 * token, for one job, when its owner presses Send.
 */
@kotlinx.serialization.Serializable
private data class QuoteTokenRow(
    @kotlinx.serialization.SerialName("quote_token") val quoteToken: String? = null,
)
