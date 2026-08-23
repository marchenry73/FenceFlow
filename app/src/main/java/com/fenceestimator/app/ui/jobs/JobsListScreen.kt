package com.fenceestimator.app.ui.jobs

import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.sp
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.DropdownMenu
import androidx.compose.material.icons.filled.MoreVert
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
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Close
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
import kotlinx.coroutines.flow.first
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
import com.fenceestimator.app.R
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
    val pendingPlanChanges by viewModel.pendingPlanChanges.collectAsState()
    // Search and status filter for the job list below the dashboard.
    var query by remember { mutableStateOf("") }
    var statusFilter by remember { mutableStateOf<JobStatus?>(null) }
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
    // Keyed on being signed in, not on Unit. Reading the release list needs a
    // session, and this screen composes before Supabase has restored one -- so
    // keying on Unit asked exactly once, too early, and got an empty answer
    // that looked identical to being up to date.
    androidx.compose.runtime.LaunchedEffect(session.signedIn, session.resolved) {
        if (session.signedIn) {
            pendingUpdate = com.fenceestimator.app.cloud.UpdateChecker.checkOnce()
        }
    }
    pendingUpdate?.takeIf { !updateDismissed }?.let { release ->
        val ctx = androidx.compose.ui.platform.LocalContext.current
        val updateScope = androidx.compose.runtime.rememberCoroutineScope()
        var progress by remember {
            mutableStateOf<com.fenceestimator.app.cloud.ApkUpdater.Progress?>(null)
        }

        com.fenceestimator.app.ui.onboarding.UpdateAvailableDialog(
            release = release,
            progress = progress,
            onDownload = {
                // Downloaded here and handed to Android, rather than opening a
                // browser and leaving somebody to find the file, download it,
                // find it again and open it. Four steps, each of which people
                // give up at -- which matters most for the update that fixes
                // something about their money.
                updateScope.launch {
                    progress = com.fenceestimator.app.cloud.ApkUpdater.Progress.Downloading(0)
                    val apk = com.fenceestimator.app.cloud.ApkUpdater.download(
                        ctx, release.downloadUrl
                    ) { p -> progress = p }
                    if (apk != null) {
                        progress = com.fenceestimator.app.cloud.ApkUpdater.Progress.Installing
                        com.fenceestimator.app.cloud.ApkUpdater.install(ctx, apk)
                        // Left open on purpose. Android shows its own install
                        // prompt on top, and closing this underneath it would
                        // leave nothing to return to if they decline.
                    }
                }
            },
            onOpenInBrowser = {
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
                    // A trading name is often longer than one word, and six
                    // action icons left almost no room for it. Two of those
                    // moved into the overflow menu below; the rest of the fix
                    // is letting a long name step down in size rather than
                    // being cut off mid-word.
                    val shownName =
                        if (profile.businessName.isBlank()) "FenceFlow" else profile.businessName
                    Text(
                        shownName,
                        fontWeight = FontWeight.Bold,
                        maxLines = 1,
                        overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                        fontSize = when {
                            shownName.length <= 16 -> 22.sp
                            shownName.length <= 24 -> 19.sp
                            shownName.length <= 32 -> 17.sp
                            else -> 15.sp
                        }
                    )
                },
                // Quiet on purpose: the dashboard's hero card is the one block
                // of colour on this screen, and a coloured bar above it made
                // two competing slabs. The name stays bold; the colour moved.
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                    titleContentColor = MaterialTheme.colorScheme.onBackground,
                    actionIconContentColor = MaterialTheme.colorScheme.onBackground
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
                    // Catalog and settings live in the overflow rather than on
                    // the bar: they are opened occasionally, and each icon on
                    // the bar is width taken from the business name.
                    if (session.canEditCatalogAndSettings) {
                        var moreOpen by remember { mutableStateOf(false) }
                        IconButton(onClick = { moreOpen = true }) {
                            Icon(Icons.Filled.MoreVert, contentDescription = "More")
                        }
                        DropdownMenu(expanded = moreOpen, onDismissRequest = { moreOpen = false }) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.jobs_materials_catalog)) },
                                leadingIcon = { Icon(Icons.Filled.Handyman, contentDescription = null) },
                                onClick = { moreOpen = false; onOpenCatalog() }
                            )
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.jobs_settings)) },
                                leadingIcon = { Icon(Icons.Filled.Settings, contentDescription = null) },
                                onClick = { moreOpen = false; onOpenSettings() }
                            )
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
                    Text(stringResource(R.string.jobs_no_jobs), style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(8.dp))
                    Text(stringResource(R.string.jobs_tap_to_start), color = MaterialTheme.colorScheme.onSurfaceVariant)
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
                // The review-your-prices moment. The catalog and labor rates
                // arrive seeded so day one works, but seeded numbers are the
                // founding company's numbers -- and the one warning used to be
                // the last line of a skippable tour dialog. This sits where
                // the eye lands every morning and does not leave until someone
                // with the catalog permission answers it.
                if (!profile.pricesReviewed && session.canEditCatalogAndSettings) {
                    item {
                        Card(
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.tertiaryContainer
                            )
                        ) {
                            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(
                                    "Make these prices yours",
                                    style = MaterialTheme.typography.titleSmall,
                                    color = MaterialTheme.colorScheme.onTertiaryContainer
                                )
                                Text(
                                    "The catalog and labor rates came pre-filled so you can " +
                                        "estimate from day one -- but they are starting numbers, " +
                                        "not your numbers. Check them before your first real quote.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onTertiaryContainer
                                )
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Button(
                                        onClick = {
                                            tourScope.launch {
                                                app.settingsStore.markPricesReviewed()
                                                // Pushed now rather than at the next settings save,
                                                // or every other phone keeps asking a question the
                                                // company already answered.
                                                runCatching {
                                                    com.fenceestimator.app.cloud.SettingsSync.push(
                                                        app.settingsStore.profile.first()
                                                    )
                                                }
                                            }
                                            onOpenCatalog()
                                        },
                                        modifier = Modifier.weight(1f)
                                    ) { Text(stringResource(R.string.jobs_review_catalog)) }
                                    OutlinedButton(
                                        onClick = { tourScope.launch {
                                                app.settingsStore.markPricesReviewed()
                                                // Pushed now rather than at the next settings save,
                                                // or every other phone keeps asking a question the
                                                // company already answered.
                                                runCatching {
                                                    com.fenceestimator.app.cloud.SettingsSync.push(
                                                        app.settingsStore.profile.first()
                                                    )
                                                }
                                            } },
                                        modifier = Modifier.weight(1f)
                                    ) { Text(stringResource(R.string.jobs_prices_right)) }
                                }
                            }
                        }
                    }
                }
                item {
                    HomeDashboard(
                        ownerName = profile.ownerName,
                        jobs = jobs,
                        payments = allPayments,
                        pendingHours = pendingHours.size,
                        pendingPlanChanges = pendingPlanChanges,
                        outstanding = outstanding,
                        cards = com.fenceestimator.app.data.HomeCard.parse(profile.homeCardsCsv),
                        showMoney = session.canSeeMoney,
                        workdayHours = (profile.workdayHours - profile.breakHoursPerDay)
                            .coerceAtLeast(1.0),
                        onOpenJob = onOpenJob,
                        onOpenSchedule = onOpenSchedule,
                        onOpenPipeline = onOpenPipeline,
                        onOpenReports = onOpenReports,
                        onOpenTimeApproval = onOpenTimeApproval
                    )
                }

                // The job list, searchable. A contractor with forty jobs was
                // scrolling for the one they wanted; a name, a street or a
                // status narrows it in a keystroke.
                val filteredJobs = jobs.filter { j ->
                    (statusFilter == null || j.status == statusFilter) &&
                        (query.isBlank() ||
                            j.customerName.contains(query, ignoreCase = true) ||
                            j.address.contains(query, ignoreCase = true))
                }
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 6.dp)) {
                        Text(
                            stringResource(R.string.home_jobs),
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold
                        )
                        androidx.compose.material3.OutlinedTextField(
                            value = query,
                            onValueChange = { query = it },
                            singleLine = true,
                            placeholder = { Text(stringResource(R.string.home_search_jobs)) },
                            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                            trailingIcon = {
                                if (query.isNotBlank()) {
                                    IconButton(onClick = { query = "" }) {
                                        Icon(Icons.Filled.Close, contentDescription = null)
                                    }
                                }
                            },
                            shape = RoundedCornerShape(16.dp),
                            modifier = Modifier.fillMaxWidth()
                        )
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())
                        ) {
                            androidx.compose.material3.FilterChip(
                                selected = statusFilter == null,
                                onClick = { statusFilter = null },
                                label = { Text(stringResource(R.string.home_filter_all)) }
                            )
                            JobStatus.values().forEach { st ->
                                androidx.compose.material3.FilterChip(
                                    selected = statusFilter == st,
                                    onClick = { statusFilter = if (statusFilter == st) null else st },
                                    label = { Text(statusLabel(st)) }
                                )
                            }
                        }
                        if (filteredJobs.isEmpty()) {
                            Text(
                                stringResource(R.string.home_no_matches),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(vertical = 8.dp)
                            )
                        }
                    }
                }
                items(filteredJobs, key = { it.id }) { job ->
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
            title = { Text(stringResource(R.string.jobs_delete_title)) },
            text = {
                Text(
                    "\"${job.customerName.ifBlank { "Untitled job" }}\" and everything on it -- fence runs, " +
                        "estimate, photos, expenses and time entries -- will be deleted. This can't be undone."
                )
            },
            confirmButton = {
                Button(onClick = { viewModel.deleteJob(job); pendingDelete = null }) { Text(stringResource(R.string.action_delete)) }
            },
            dismissButton = {
                OutlinedButton(onClick = { pendingDelete = null }) { Text(stringResource(R.string.action_cancel)) }
            }
        )
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
                        text = job.customerName.ifBlank { stringResource(R.string.home_untitled_job) },
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold
                    )
                    if (job.address.isNotBlank()) {
                        Text(job.address, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Spacer(Modifier.height(4.dp))
                    val scheduled = job.scheduledDate
                    val dayFmt = remember { SimpleDateFormat("MMM d, yyyy", Locale.getDefault()) }
                    Text(
                        if (scheduled != null)
                            stringResource(R.string.home_scheduled_on, dayFmt.format(Date(scheduled)))
                        else
                            stringResource(R.string.home_updated_on, dayFmt.format(Date(job.updatedAt))),
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
internal fun statusLabel(status: JobStatus): String = stringResource(
    when (status) {
        JobStatus.DRAFT -> R.string.home_status_draft
        JobStatus.SENT -> R.string.home_status_sent
        JobStatus.ACCEPTED -> R.string.home_status_accepted
        JobStatus.COMPLETED -> R.string.home_status_completed
        JobStatus.DECLINED -> R.string.home_status_declined
    }
)

@Composable
private fun StatusPill(status: JobStatus) {
    val label = statusLabel(status)
    val (bg, fg) = when (status) {
        JobStatus.DRAFT -> Pair(Color(0xFFE3E7ED), Color(0xFF3A4048))
        JobStatus.SENT -> Pair(Color(0xFFFFC49A), Color(0xFFB23800))
        JobStatus.ACCEPTED -> Pair(Color(0xFFA9EEE1), Color(0xFF07473D))
        JobStatus.COMPLETED -> Pair(Color(0xFFD7DEE8), Color(0xFF1E2A3D))
        JobStatus.DECLINED -> Pair(Color(0xFFFBD3D4), Color(0xFF8C1114))
    }
    Box(
        modifier = Modifier
            .background(bg, RoundedCornerShape(50))
            .padding(horizontal = 10.dp, vertical = 5.dp)
    ) {
        Text(label, color = fg, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
    }
}
