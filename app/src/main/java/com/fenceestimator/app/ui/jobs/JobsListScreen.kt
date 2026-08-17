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
    var pendingDelete by remember { mutableStateOf<Job?>(null) }

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
                    if (sync.hasUnsyncedWork ||
                        sync.phase == com.fenceestimator.app.cloud.SyncPhase.WAITING_FOR_SIGNAL
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
                                    "Nothing is lost. Keep working — it uploads on its own.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSecondaryContainer
                                )
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
                        showMoney = session.canSeeMoney,
                        onOpenSchedule = onOpenSchedule,
                        onOpenPipeline = onOpenPipeline,
                        onOpenReports = onOpenReports
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
    showMoney: Boolean,
    onOpenSchedule: () -> Unit,
    onOpenPipeline: () -> Unit,
    onOpenReports: () -> Unit
) {
    val currency = remember { NumberFormat.getCurrencyInstance(Locale.US) }
    val stats = remember(jobs) {
        val now = Calendar.getInstance()
        val weekEnd = (now.clone() as Calendar).apply { add(Calendar.DAY_OF_YEAR, 7) }.timeInMillis
        val monthStart = (now.clone() as Calendar).apply {
            set(Calendar.DAY_OF_MONTH, 1); set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }.timeInMillis

        val scheduledThisWeek = jobs.count { it.scheduledDate != null && it.scheduledDate in now.timeInMillis..weekEnd }
        val monthReference = { j: Job -> j.scheduledDate ?: j.updatedAt }
        val wonThisMonth = jobs.count { it.status.isWon && monthReference(it) >= monthStart }
        val collectedThisMonth = jobs.filter { monthReference(it) >= monthStart }.sumOf { it.amountPaid }
        val unpaidJobs = jobs.count { it.status.isWon && it.paymentStatus != PaymentStatus.PAID_IN_FULL }

        DashboardStats(scheduledThisWeek, wonThisMonth, collectedThisMonth, unpaidJobs)
    }

    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
        StatCard("This Week", stats.scheduledThisWeek.toString(), Modifier.weight(1f), onOpenSchedule)
        StatCard("Won This Month", stats.wonThisMonth.toString(), Modifier.weight(1f), onOpenPipeline)
    }
    if (showMoney) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth().padding(top = 10.dp)) {
            StatCard("Collected This Month", currency.format(stats.collectedThisMonth), Modifier.weight(1f), onOpenReports)
            StatCard("Unpaid Jobs", stats.unpaidJobs.toString(), Modifier.weight(1f), onOpenPipeline)
        }
    }
    Spacer(Modifier.height(4.dp))
}

private data class DashboardStats(val scheduledThisWeek: Int, val wonThisMonth: Int, val collectedThisMonth: Double, val unpaidJobs: Int)

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
