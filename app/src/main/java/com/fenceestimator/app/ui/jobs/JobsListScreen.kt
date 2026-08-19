package com.fenceestimator.app.ui.jobs

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Handyman
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.ViewKanban
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.PaymentStatus
import com.fenceestimator.app.data.isWon
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp
import androidx.lifecycle.viewmodel.compose.viewModel
import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun JobsListScreen(
    onOpenJob: (Long) -> Unit,
    onOpenCatalog: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenCustomers: () -> Unit,
    onOpenSchedule: () -> Unit,
    onOpenReports: () -> Unit,
    onOpenPipeline: () -> Unit,
    onOpenTimeApproval: () -> Unit
) {
    val app = currentApp()
    val viewModel: JobsViewModel = viewModel(factory = GenericViewModelFactory { JobsViewModel(app.repository) })
    val jobs by viewModel.jobs.collectAsState()
    val profile by app.settingsStore.profile.collectAsState(initial = com.fenceestimator.app.data.BusinessProfile())
    val session by app.session.state.collectAsState()
    val pendingHours by viewModel.pendingHours.collectAsState()
    val allPayments by viewModel.allPayments.collectAsState()
    val outstanding by viewModel.outstandingTotal.collectAsState()
    var pendingDelete by remember { mutableStateOf<Job?>(null) }

    // Shown once, on the first open. Covers only the things that are not
    // guessable and cost money when found out late.
    val tourScope = rememberCoroutineScope()

    // Only for somebody who has genuinely never used it.
    //
    // Keying on a flag alone made it reappear on every update: the settings
    // flow emits its defaults before DataStore has loaded, so hasSeenTour reads
    // false for a moment and the tour fires. Requiring an empty job list as
    // well means it cannot show to anybody with work in the app, whatever the
    // flag says -- and "no jobs at all" IS what a new company looks like.
    var showTour by remember(profile.hasSeenTour, jobs.isEmpty()) {
        mutableStateOf(!profile.hasSeenTour && jobs.isEmpty() && profile.updatedAt == 0L)
    }
    // Checked once per launch. Silence when this build is current, or when the
    // check simply could not run -- interrupting somebody mid-job to say the
    // update server was unreachable helps nobody.
    var pendingUpdate by remember {
        mutableStateOf<com.fenceestimator.app.cloud.AppRelease?>(null)
    }
    var updateDismissed by remember { mutableStateOf(false) }
    androidx.compose.runtime.LaunchedEffect(Unit) {
        pendingUpdate = com.fenceestimator.app.cloud.UpdateChecker.checkOnce()
    }
    pendingUpdate?.takeIf { !updateDismissed }?.let { release ->
        val ctx = androidx.compose.ui.platform.LocalContext.current
        com.fenceestimator.app.ui.onboarding.UpdateAvailableDialog(
            release = release,
            onDownload = {
                runCatching {
                    ctx.startActivity(
                        android.content.Intent(
                            android.content.Intent.ACTION_VIEW,
                            android.net.Uri.parse(release.downloadUrl)
                        )
                    )
                }
                updateDismissed = true
            },
            onLater = { updateDismissed = true }
        )
    }

    if (showTour) {
        com.fenceestimator.app.ui.onboarding.FirstRunTour(
            onFinished = {
                showTour = false
                tourScope.launch { app.settingsStore.markTourSeen() }
            }
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        if (profile.businessName.isBlank()) "FenceFlow" else profile.businessName,
                        fontWeight = FontWeight.Bold
                    )
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    titleContentColor = MaterialTheme.colorScheme.onPrimary,
                    actionIconContentColor = MaterialTheme.colorScheme.onPrimary
                ),
                actions = {
                    IconButton(onClick = onOpenSchedule) {
                        Icon(Icons.Filled.CalendarMonth, contentDescription = "Schedule")
                    }
                    IconButton(onClick = onOpenCustomers) {
                        Icon(Icons.Filled.People, contentDescription = "Customers")
                    }
                    if (session.canSeeMoney) {
                        IconButton(onClick = onOpenPipeline) {
                            Icon(Icons.Filled.ViewKanban, contentDescription = "Pipeline")
                        }
                        IconButton(onClick = onOpenReports) {
                            Icon(Icons.Filled.BarChart, contentDescription = "Reports")
                        }
                    }
                    if (session.canEditCatalogAndSettings) {
                        IconButton(onClick = onOpenCatalog) {
                            Icon(Icons.Filled.Handyman, contentDescription = "Materials catalog")
                        }
                        IconButton(onClick = onOpenSettings) {
                            Icon(Icons.Filled.Settings, contentDescription = "Settings")
                        }
                    }
                }
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick = { viewModel.createJob(profile) { id -> onOpenJob(id) } },
                containerColor = MaterialTheme.colorScheme.secondary,
                contentColor = MaterialTheme.colorScheme.onSecondary
            ) {
                Icon(Icons.Filled.Add, contentDescription = "New job")
            }
        }
    ) { padding ->
        // Pull to refresh.
        //
        // The app keeps itself current on its own -- change feed, sync passes,
        // and a re-check whenever it comes to the foreground. This is not the
        // mechanism, it is the reassurance: when a figure looks wrong, people
        // need something to pull, and being able to prove it is current is
        // worth as much as it being current.
        val scope = rememberCoroutineScope()
        var refreshing by remember { mutableStateOf(false) }
        val onRefresh: () -> Unit = {
            refreshing = true
            app.session.refresh()
            app.autoSync.requestSync()
            scope.launch {
                kotlinx.coroutines.delay(900)
                refreshing = false
            }
        }

        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = onRefresh,
            modifier = Modifier.fillMaxSize().padding(padding)
        ) {
        if (jobs.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("No jobs yet", style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(8.dp))
                    Text("Tap + to start a new fence estimate", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                // Only shown when there is something to say. A permanent "all
                // good" badge is wallpaper -- people stop seeing it, and then
                // miss the one time it says something different.
                item {
                    val sync by app.autoSync.state.collectAsState()
                    // OFFLINE_ONLY and FAILED are shown too. They were not, and
                    // that is how a phone sat disconnected from the company for
                    // hours showing stale money with nothing on screen to say
                    // so -- the one state where silence is actively misleading,
                    // because everything looks like it is working.
                    if (sync.hasUnsyncedWork ||
                        sync.phase == com.fenceestimator.app.cloud.SyncPhase.WAITING_FOR_SIGNAL ||
                        (sync.phase == com.fenceestimator.app.cloud.SyncPhase.OFFLINE_ONLY &&
                            sync.sessionResolved) ||
                        sync.phase == com.fenceestimator.app.cloud.SyncPhase.FAILED
                    ) {
                        Card(
                            Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.secondaryContainer
                            )
                        ) {
                            Column(Modifier.padding(12.dp)) {
                                Text(
                                    sync.message,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSecondaryContainer
                                )
                                Text(
                                    if (sync.phase == com.fenceestimator.app.cloud.SyncPhase.OFFLINE_ONLY)
                                        "This phone is not connected to your company, so these " +
                                            "figures are its own. Open Account & Team and sign in."
                                    else
                                        "Nothing is lost. Keep working — it uploads on its own.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSecondaryContainer
                                )
                                sync.lastSyncedAt?.let { at ->
                                    // A figure with no time against it invites
                                    // the assumption that it is current.
                                    Text(
                                        "Last updated " + android.text.format.DateUtils
                                            .getRelativeTimeSpanString(at),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSecondaryContainer
                                    )
                                }
                            }
                        }
                    }
                }
                // A banner rather than a menu entry. Unapproved hours are money
                // standing still -- the crew are not paid and the job cost is
                // understated -- and a buried menu item is how a queue goes
                // unread for a fortnight.
                if (session.canApproveTime && pendingHours.isNotEmpty()) {
                    item {
                        Card(
                            onClick = onOpenTimeApproval,
                            modifier = Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.tertiaryContainer
                            )
                        ) {
                            Column(Modifier.padding(14.dp)) {
                                Text(
                                    "${pendingHours.size} shift(s) waiting on you",
                                    style = MaterialTheme.typography.titleMedium,
                                    color = MaterialTheme.colorScheme.onTertiaryContainer
                                )
                                Text(
                                    "Crew hours don't count towards pay or job cost until approved.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onTertiaryContainer
                                )
                            }
                        }
                    }
                }
                item {
                    DashboardHeader(
                        jobs = jobs,
                        payments = allPayments,
                        pendingHours = pendingHours.size,
                        outstanding = outstanding,
                        cards = com.fenceestimator.app.data.HomeCard.parse(profile.homeCardsCsv),
                        showMoney = session.canSeeMoney,
                        workdayHours = (profile.workdayHours - profile.breakHoursPerDay)
                            .coerceAtLeast(1.0),
                        onOpenSchedule = onOpenSchedule,
                        onOpenPipeline = onOpenPipeline,
                        onOpenReports = onOpenReports,
                        onOpenTimeApproval = onOpenTimeApproval
                    )
                }
                items(jobs, key = { it.id }) { job ->
                    JobCard(
                        job = job,
                        onClick = { onOpenJob(job.id) },
                        onDelete = if (session.canDelete) {
                            { pendingDelete = job }
                        } else null
                    )
                }
            }
        }
        }
    }

    pendingDelete?.let { job ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("Delete this job?") },
            text = {
                Text(
                    "\"${job.customerName.ifBlank { "Untitled job" }}\" and everything on it -- fence runs, " +
                        "estimate, photos, expenses and time entries -- will be deleted. This can't be undone."
                )
            },
            confirmButton = {
                Button(onClick = { viewModel.deleteJob(job); pendingDelete = null }) { Text("Delete") }
            },
            dismissButton = {
                OutlinedButton(onClick = { pendingDelete = null }) { Text("Cancel") }
            }
        )
    }
}

@Composable
private fun DashboardHeader(
    jobs: List<Job>,
    payments: List<com.fenceestimator.app.data.PaymentRecord>,
    pendingHours: Int,
    outstanding: Double,
    cards: List<com.fenceestimator.app.data.HomeCard>,
    showMoney: Boolean,
    workdayHours: Double,
    onOpenSchedule: () -> Unit,
    onOpenPipeline: () -> Unit,
    onOpenReports: () -> Unit,
    onOpenTimeApproval: () -> Unit
) {
    val currency = remember { NumberFormat.getCurrencyInstance(Locale.US) }

    val monthStart = remember {
        Calendar.getInstance().apply {
            set(Calendar.DAY_OF_MONTH, 1); set(Calendar.HOUR_OF_DAY, 0)
            set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }.timeInMillis
    }

    // Money comes from the ledger, by the date it actually arrived.
    //
    // This screen had the same bug the reports screen did: it attributed a
    // job's whole lifetime amountPaid to a single job timestamp, and for an
    // unscheduled job that timestamp was updatedAt -- a sync artifact. Editing
    // an old job dragged its payments into this month, and two devices
    // disagreed. Same fix, because it is the same mistake.
    val collectedThisMonth = remember(payments, monthStart) {
        payments.filter { it.receivedAt >= monthStart }.sumOf { it.amount }
    }

    fun valueFor(card: com.fenceestimator.app.data.HomeCard): String {
        val now = System.currentTimeMillis()
        val weekEnd = Calendar.getInstance().apply { add(Calendar.DAY_OF_YEAR, 7) }.timeInMillis
        return when (card) {
            com.fenceestimator.app.data.HomeCard.SCHEDULED_THIS_WEEK ->
                jobs.count { it.scheduledDate != null && it.scheduledDate in now..weekEnd }.toString()
            com.fenceestimator.app.data.HomeCard.WON_THIS_MONTH ->
                jobs.count { it.status.isWon && (it.scheduledDate ?: it.createdAt) >= monthStart }.toString()
            com.fenceestimator.app.data.HomeCard.COLLECTED_THIS_MONTH ->
                currency.format(collectedThisMonth)
            com.fenceestimator.app.data.HomeCard.OUTSTANDING -> currency.format(outstanding)
            com.fenceestimator.app.data.HomeCard.UNPAID_JOBS ->
                jobs.count { it.status.isWon && it.paymentStatus != PaymentStatus.PAID_IN_FULL }.toString()
            com.fenceestimator.app.data.HomeCard.HOURS_TO_APPROVE -> pendingHours.toString()
            com.fenceestimator.app.data.HomeCard.DRAFT_ESTIMATES ->
                jobs.count { it.status == JobStatus.DRAFT }.toString()
            com.fenceestimator.app.data.HomeCard.OVERRUNNING ->
                jobs.count {
                    com.fenceestimator.app.estimate.JobSchedule.hasOverrun(it, workdayHours)
                }.toString()
        }
    }

    fun destinationFor(card: com.fenceestimator.app.data.HomeCard): () -> Unit = when (card) {
        com.fenceestimator.app.data.HomeCard.SCHEDULED_THIS_WEEK,
        com.fenceestimator.app.data.HomeCard.OVERRUNNING -> onOpenSchedule
        com.fenceestimator.app.data.HomeCard.COLLECTED_THIS_MONTH,
        com.fenceestimator.app.data.HomeCard.OUTSTANDING -> onOpenReports
        com.fenceestimator.app.data.HomeCard.HOURS_TO_APPROVE -> onOpenTimeApproval
        else -> onOpenPipeline
    }

    // Money cards are dropped rather than blanked for anyone without permission
    // to see money -- an empty card labelled "Collected" still tells them there
    // is money to know about.
    val visible = cards.filter { showMoney || !it.needsMoney }

    visible.chunked(2).forEach { pair ->
        Row(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp)
        ) {
            pair.forEach { card ->
                StatCard(card.label, valueFor(card), Modifier.weight(1f), destinationFor(card))
            }
            if (pair.size == 1) Box(Modifier.weight(1f))
        }
    }
    Spacer(Modifier.height(4.dp))
}


@Composable
private fun StatCard(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null
) {
    Card(modifier = if (onClick != null) modifier.clickable(onClick = onClick) else modifier, colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
        Column(Modifier.padding(14.dp)) {
            Text(value, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSecondaryContainer)
            Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSecondaryContainer)
        }
    }
}

@Composable
private fun JobCard(job: Job, onClick: () -> Unit, onDelete: (() -> Unit)? = null) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        shape = RoundedCornerShape(16.dp),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Row(modifier = Modifier.fillMaxWidth()) {
            Box(
                modifier = Modifier
                    .width(5.dp)
                    .fillMaxHeight()
                    .background(statusColor(job.status))
            )
            Row(
                modifier = Modifier.weight(1f).padding(16.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = job.customerName.ifBlank { "Untitled job" },
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold
                    )
                    if (job.address.isNotBlank()) {
                        Text(job.address, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Spacer(Modifier.height(4.dp))
                    val scheduled = job.scheduledDate
                    Text(
                        if (scheduled != null)
                            "Scheduled ${SimpleDateFormat("MMM d, yyyy", Locale.US).format(Date(scheduled))}"
                        else
                            "Updated ${SimpleDateFormat("MMM d, yyyy", Locale.US).format(Date(job.updatedAt))}",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                StatusPill(job.status)
                if (onDelete != null) {
                    IconButton(onClick = onDelete) {
                        Icon(
                            Icons.Filled.Delete,
                            contentDescription = "Delete job",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        }
    }
}

private fun statusColor(status: JobStatus): Color = when (status) {
    JobStatus.DRAFT -> Color(0xFF8A93A3)
    JobStatus.SENT -> Color(0xFFFF5A1F)
    JobStatus.ACCEPTED -> Color(0xFF0E8C7B)
    JobStatus.COMPLETED -> Color(0xFF1E2A3D)
    JobStatus.DECLINED -> Color(0xFFE5484D)
}

@Composable
private fun StatusPill(status: JobStatus) {
    val (bg, fg, label) = when (status) {
        JobStatus.DRAFT -> Triple(Color(0xFFE3E7ED), Color(0xFF3A4048), "Draft")
        JobStatus.SENT -> Triple(Color(0xFFFFC49A), Color(0xFFB23800), "Sent")
        JobStatus.ACCEPTED -> Triple(Color(0xFFA9EEE1), Color(0xFF07473D), "Accepted")
        JobStatus.COMPLETED -> Triple(Color(0xFFD7DEE8), Color(0xFF1E2A3D), "Complete")
        JobStatus.DECLINED -> Triple(Color(0xFFFBD3D4), Color(0xFF8C1114), "Declined")
    }
    Box(
        modifier = Modifier
            .background(bg, RoundedCornerShape(50))
            .padding(horizontal = 10.dp, vertical = 5.dp)
    ) {
        Text(label, color = fg, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
    }
}
