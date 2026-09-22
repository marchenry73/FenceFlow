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
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Handyman
import androidx.compose.material.icons.filled.LockOpen
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.ViewKanban
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.R
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.PaymentStatus
import com.fenceestimator.app.data.isWon
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.Money
import com.fenceestimator.app.ui.theme.Space
import com.fenceestimator.app.ui.components.currentApp
import com.fenceestimator.app.ui.components.label
import androidx.lifecycle.viewmodel.compose.viewModel
import java.text.NumberFormat
import java.util.Calendar

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
    onOpenTimeApproval: () -> Unit,
    /**
     * Straight to Account & Team, not via Settings. It is one tap from the
     * sync card, and a signed-out phone should not have to find its way
     * through a menu to the one screen that fixes its problem.
     */
    onOpenAccount: () -> Unit,
    /** "Other jobs -- request access", for a crew member the server shows only their own jobs. */
    onOpenRequestAccess: () -> Unit,
    /** The waiting access requests, for someone who answers them. */
    onOpenAccessRequests: () -> Unit,
    /**
     * A job kept on this phone after its person was taken off it opens on the
     * crew screen, not the office one: that is where a running shift is
     * clocked out, and nothing on it pretends the job can still be edited.
     */
    onOpenCrewJob: (Long) -> Unit
) {
    val app = currentApp()
    val viewModel: JobsViewModel = viewModel(
        factory = GenericViewModelFactory { JobsViewModel(app.repository, app.session) }
    )
    val jobs by viewModel.jobs.collectAsState()
    val heldJobs by viewModel.heldJobs.collectAsState()
    val jobScope by viewModel.jobScope.collectAsState()
    val accessRequestsWaiting by viewModel.accessRequestsWaiting.collectAsState()
    val online by app.connectivity.online.collectAsState()
    val profile by app.settingsStore.profile.collectAsState(initial = com.fenceestimator.app.data.BusinessProfile())
    val session by app.session.state.collectAsState()
    val ent = com.fenceestimator.app.ui.components.LocalEntitlements.current
    val pendingHours by viewModel.pendingHours.collectAsState()
    val allPayments by viewModel.allPayments.collectAsState()
    val jobTotals by viewModel.jobTotals.collectAsState()
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

    // Asked again whenever the app comes back to the front.
    //
    // The check ran once per launch, so the only way to find out about a new
    // version was to close the app completely and open it again -- which
    // nobody does, and which is a strange thing to have to explain to somebody
    // whose fix is sitting on the server. Coming back to the app is enough
    // now. It stays quiet once you have said Later: the dismissal holds, and
    // an update already on offer is not re-fetched.
    val updateLifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current
    androidx.compose.runtime.DisposableEffect(updateLifecycle, updateDismissed) {
        val watcher = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME &&
                !updateDismissed && pendingUpdate == null
            ) {
                app.applicationScope.launch {
                    runCatching { com.fenceestimator.app.cloud.UpdateChecker.check() }
                        .getOrNull()?.let { pendingUpdate = it }
                }
            }
        }
        updateLifecycle.lifecycle.addObserver(watcher)
        onDispose { updateLifecycle.lifecycle.removeObserver(watcher) }
    }
    // Which jobs this person may see, asked again on the way back to the
    // front -- an assignment made while the phone was in a pocket should be
    // reflected when it comes out, not at the next sync pass. One small RPC;
    // offline it keeps the last answer (JobAccess.scope never flickers).
    androidx.compose.runtime.DisposableEffect(updateLifecycle) {
        val watcher = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) viewModel.refreshScope()
        }
        updateLifecycle.lifecycle.addObserver(watcher)
        onDispose { updateLifecycle.lifecycle.removeObserver(watcher) }
    }
    // Only a definite "scoped" answer changes the list; see scopedHome().
    val scoped = scopedHome(jobScope, visibleJobs = jobs.size, keptJobs = heldJobs.size)
    // The crew's own card (see the list item below), read up here so the list
    // can ask whether it has anything to say even when no job is showing: a
    // shift sent back on a job this person has since been taken off is still
    // their pay, and with only kept jobs left the list itself is empty.
    val isCrewRole = session.role == com.fenceestimator.app.cloud.UserRole.CREW
    val crewAttentionViewModel: com.fenceestimator.app.ui.crew.CrewAttentionViewModel? =
        if (isCrewRole) viewModel(
            factory = GenericViewModelFactory {
                com.fenceestimator.app.ui.crew.CrewAttentionViewModel(
                    app.repository, app.session, com.fenceestimator.app.ui.crew.CrewAttentionAckStore(app)
                )
            }
        ) else null
    val crewAttentionItems = crewAttentionViewModel?.items?.collectAsState()?.value.orEmpty()
    val keptJobIds = heldJobs.map { it.id }.toSet()
    pendingUpdate?.takeIf { !updateDismissed }?.let { release ->
        val ctx = androidx.compose.ui.platform.LocalContext.current
        val updateScope = androidx.compose.runtime.rememberCoroutineScope()
        var progress by remember {
            mutableStateOf<com.fenceestimator.app.cloud.ApkUpdater.Progress?>(null)
        }
        // Resolved here, in composable scope, because onOpenInBrowser below
        // is a plain click handler and cannot call stringResource itself.
        val noBrowserMessage = stringResource(R.string.jobpolish_no_browser)

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
                // The dialog only closes once the browser actually opened. A
                // phone with nothing registered for http(s) links used to
                // dismiss anyway, leaving no way back to the download except
                // waiting for the next app-resume check.
                val opened = runCatching {
                    ctx.startActivity(
                        android.content.Intent(
                            android.content.Intent.ACTION_VIEW,
                            android.net.Uri.parse(release.downloadUrl)
                        )
                    )
                }.isSuccess
                if (opened) {
                    updateDismissed = true
                } else {
                    android.widget.Toast.makeText(
                        ctx, noBrowserMessage, android.widget.Toast.LENGTH_LONG
                    ).show()
                }
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
                    // The customer list is nothing but contact details, and its
                    // route refuses anyone without them -- so the icon only
                    // led crew to a wall.
                    if (session.canSeeCustomerContact) {
                        IconButton(onClick = onOpenCustomers) {
                            Icon(Icons.Filled.People, contentDescription = "Customers")
                        }
                    }
                    if (session.canSeeMoney && ent.pipeline) {
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
                    // The menu is for everyone. Crew had no way to reach theme,
                    // language, auto-lock, Help or sign-out; Settings now opens
                    // the screen that fits the person (see Routes.SETTINGS). The
                    // catalog stays with the people who can edit it.
                    var moreOpen by remember { mutableStateOf(false) }
                    IconButton(onClick = { moreOpen = true }) {
                        Icon(Icons.Filled.MoreVert, contentDescription = "More")
                    }
                    DropdownMenu(expanded = moreOpen, onDismissRequest = { moreOpen = false }) {
                        if (session.canEditCatalogAndSettings) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.jobs_materials_catalog)) },
                                leadingIcon = { Icon(Icons.Filled.Handyman, contentDescription = null) },
                                onClick = { moreOpen = false; onOpenCatalog() }
                            )
                        }
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.jobs_settings)) },
                            leadingIcon = { Icon(Icons.Filled.Settings, contentDescription = null) },
                            onClick = { moreOpen = false; onOpenSettings() }
                        )
                    }
                }
            )
        },
        floatingActionButton = {
            // Only for someone who can make a job. A crew phone's new job
            // could never reach the office -- the crew door takes updates to
            // jobs it already has, never a new one -- so the button made work
            // that lived and died on one handset.
            if (session.canEditJobs) {
                FloatingActionButton(
                    onClick = { viewModel.createJob(profile) { id -> onOpenJob(id) } },
                    containerColor = MaterialTheme.colorScheme.secondary,
                    contentColor = MaterialTheme.colorScheme.onSecondary
                ) {
                    Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.jobs_new_job))
                }
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
        // The plain empty state only when the scope has nothing to add. A
        // scoped crew member with no jobs gets the list below instead, which
        // says why in words (not linked, none yet, on the way), keeps the
        // sync card in view so an empty list is never read as a failed sync,
        // and still offers "request access" and anything kept on the phone.
        val nothingToSay = scoped.notice == ScopedNotice.NONE && !scoped.offerRequestAccess && !scoped.showKept
        if (jobs.isEmpty() && nothingToSay) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(stringResource(R.string.jobs_no_jobs), style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        // "Tap +" only where there is a + to tap.
                        stringResource(
                            if (session.canEditJobs) R.string.jobs_tap_to_start else R.string.jobs_empty_office_adds
                        ),
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(Space.screen),
                verticalArrangement = Arrangement.spacedBy(Space.row)
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
                        sync.phase == com.fenceestimator.app.cloud.SyncPhase.SIGNED_OUT ||
                        (sync.phase == com.fenceestimator.app.cloud.SyncPhase.OFFLINE_ONLY &&
                            sync.sessionResolved) ||
                        sync.phase == com.fenceestimator.app.cloud.SyncPhase.FAILED
                    ) {
                        // Tappable exactly when there is something to tap for.
                        val needsSigningIn =
                            sync.phase == com.fenceestimator.app.cloud.SyncPhase.SIGNED_OUT ||
                            sync.phase == com.fenceestimator.app.cloud.SyncPhase.OFFLINE_ONLY
                        Card(
                            Modifier
                                .fillMaxWidth()
                                .then(
                                    if (needsSigningIn) Modifier.clickable { onOpenAccount() }
                                    else Modifier
                                ),
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
                                    // "It uploads on its own" is only true when
                                    // something is actually coming back. Said to
                                    // a phone whose sign-in has expired it is
                                    // simply false, and it is what kept a phone
                                    // sitting quietly for half a day having
                                    // uploaded nothing.
                                    when (sync.phase) {
                                        com.fenceestimator.app.cloud.SyncPhase.OFFLINE_ONLY ->
                                            "This phone is not connected to your company, so these " +
                                                "figures are its own. Open Account & Team and sign in."
                                        com.fenceestimator.app.cloud.SyncPhase.SIGNED_OUT ->
                                            "This will not fix itself. Open Account & Team and sign " +
                                                "in — everything on this phone uploads as soon as you do."
                                        else ->
                                            "Nothing is lost. Keep working — it uploads on its own."
                                    },
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
                if (session.canApproveTime && ent.timeAndCrew && pendingHours.isNotEmpty()) {
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
                // A quote with no business name on it goes out headed
                // "FenceFlow", because that is the PDF's fallback -- so the
                // first thing a new contractor sends a homeowner is branded
                // with the software instead of their own company. Asked for
                // here, where they already are, rather than left to be
                // discovered by a customer.
                if (profile.businessName.isBlank() && session.canEditCatalogAndSettings) {
                    item {
                        Card(
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.tertiaryContainer
                            )
                        ) {
                            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(
                                    stringResource(R.string.jobs_add_business_name),
                                    style = MaterialTheme.typography.titleSmall,
                                    color = MaterialTheme.colorScheme.onTertiaryContainer
                                )
                                Text(
                                    stringResource(R.string.jobs_add_business_name_body),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onTertiaryContainer
                                )
                                Button(onClick = onOpenSettings) {
                                    Text(stringResource(R.string.jobs_add_business_name_action))
                                }
                            }
                        }
                    }
                }

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
                                    stringResource(R.string.jobs_make_prices_yours),
                                    style = MaterialTheme.typography.titleSmall,
                                    color = MaterialTheme.colorScheme.onTertiaryContainer
                                )
                                Text(
                                    stringResource(R.string.jobs_make_prices_yours_body),
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
                // Crew waiting on an answer, for whoever gives one. A banner
                // for the same reason as the hours above: a request sits in a
                // queue nobody opens, and the person who asked is stood in a
                // yard waiting. Zero -- no banner -- on a server without the
                // crew scope, or when the count could not be read.
                if (session.canScheduleAndAssign && accessRequestsWaiting > 0) {
                    item {
                        Card(
                            onClick = onOpenAccessRequests,
                            modifier = Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.tertiaryContainer
                            )
                        ) {
                            Column(Modifier.padding(14.dp)) {
                                Text(
                                    stringResource(R.string.jobs_access_requests_waiting, accessRequestsWaiting),
                                    style = MaterialTheme.typography.titleMedium,
                                    color = MaterialTheme.colorScheme.onTertiaryContainer
                                )
                                Text(
                                    stringResource(R.string.jobs_access_requests_waiting_body),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onTertiaryContainer
                                )
                            }
                        }
                    }
                }
                // Why a scoped crew member's list is short or empty, in words.
                // "Not linked" above all must never look like a sync that
                // failed: it is the office's to fix, and nothing on this phone
                // will change it.
                if (scoped.notice != ScopedNotice.NONE) {
                    item {
                        Card(
                            modifier = Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.secondaryContainer
                            )
                        ) {
                            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(
                                    stringResource(
                                        when (scoped.notice) {
                                            ScopedNotice.NOT_LINKED -> R.string.jobs_scope_not_linked
                                            ScopedNotice.ON_THE_WAY -> R.string.jobs_scope_on_the_way
                                            else -> R.string.jobs_scope_none_assigned
                                        }
                                    ),
                                    style = MaterialTheme.typography.titleSmall,
                                    color = MaterialTheme.colorScheme.onSecondaryContainer
                                )
                                Text(
                                    stringResource(
                                        when (scoped.notice) {
                                            ScopedNotice.NOT_LINKED -> R.string.jobs_scope_not_linked_body
                                            ScopedNotice.ON_THE_WAY -> R.string.jobs_scope_on_the_way_body
                                            else -> R.string.jobs_scope_none_assigned_body
                                        }
                                    ),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSecondaryContainer
                                )
                            }
                        }
                    }
                }
                // Crew's own view of "what is waiting on me" -- see
                // ui/crew/CrewAttention.kt for why this is a closed, separate
                // list rather than a filtered slice of the office dashboard
                // below. Gated on the base CREW role only: a foreman already
                // gets the fuller picture (schedule, approvals, customer
                // contact) below, and this narrower card would only bury the
                // things a foreman is actually meant to see first. Not shown
                // with no jobs and nothing to say: "all clear" under "no jobs
                // assigned to you" says nothing, and under "not linked" says
                // something false. Shown whenever it HAS something, though --
                // a shift sent back on a job this person was taken off is
                // theirs to answer, and it used to be hidden along with the
                // card whenever the list was empty.
                if (isCrewRole && (jobs.isNotEmpty() || crewAttentionItems.isNotEmpty())) {
                    item {
                        val sync by app.autoSync.state.collectAsState()
                        com.fenceestimator.app.ui.crew.CrewAttentionSection(
                            items = crewAttentionItems,
                            online = online,
                            lastSyncedAt = sync.lastSyncedAt,
                            // A kept job opens where a kept job opens (see
                            // onOpenCrewJob), not on the office screen.
                            onOpenJob = { id -> if (id in keptJobIds) onOpenCrewJob(id) else onOpenJob(id) },
                            onDismiss = { key -> crewAttentionViewModel?.dismiss(key) }
                        )
                    }
                }
                if (jobs.isNotEmpty()) item {
                    HomeDashboard(
                        ownerName = profile.ownerName,
                        jobs = jobs,
                        jobTotals = jobTotals,
                        payments = allPayments,
                        // Only someone who can approve hours gets the count at
                        // all. It is every finished shift on the phone -- the
                        // crew member's own the moment they clock out, and every
                        // colleague's -- and it opened a queue that told crew
                        // they could not approve anything.
                        pendingHours = if (session.canApproveTime && ent.timeAndCrew) pendingHours.size else 0,
                        pendingPlanChanges = pendingPlanChanges,
                        outstanding = outstanding,
                        cards = com.fenceestimator.app.data.HomeCard.parse(profile.homeCardsCsv),
                        showMoney = session.canSeeMoney,
                        permissions = session.permissions,
                        isCrew = session.role == com.fenceestimator.app.cloud.UserRole.CREW,
                        workdayHours = (profile.workdayHours - profile.breakHoursPerDay)
                            .coerceAtLeast(1.0),
                        onOpenJob = onOpenJob,
                        onOpenSchedule = onOpenSchedule,
                        // Solo's cards still show the numbers -- they are Solo
                        // features. HomeDashboard reads the plan itself now and
                        // shows a lock instead of quietly swallowing the tap --
                        // a tile that rippled and did nothing used to read as
                        // the app being broken.
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
                if (jobs.isNotEmpty()) item {
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
                    JobRow(
                        customerName = job.customerName.ifBlank { stringResource(R.string.home_untitled_job) },
                        address = job.address,
                        status = job.status,
                        // No price without SEE_MONEY. A crew phone's copy of
                        // the job has had its money scrubbed to defaults, so
                        // this was a made-up figure as well as a forbidden one.
                        trailingText = if (session.canSeeMoney) Money.short(jobTotals[job.id] ?: 0.0) else "",
                        onClick = { onOpenJob(job.id) },
                        showStatusPill = true,
                        action = if (session.canDelete) {
                            {
                                IconButton(onClick = { pendingDelete = job }) {
                                    Icon(
                                        Icons.Filled.Delete,
                                        contentDescription = stringResource(R.string.jobpolish_delete_job),
                                        tint = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                            }
                        } else null
                    )
                }

                // The rest of the company's won work, which this person may
                // ask for. Offered only to a linked, scoped login (the only
                // one the server lets ask), and online only -- the list lives
                // on the server, so offline it says so instead of opening.
                if (scoped.offerRequestAccess) {
                    item {
                        Card(
                            onClick = onOpenRequestAccess,
                            enabled = online,
                            modifier = Modifier.fillMaxWidth().padding(top = 6.dp)
                        ) {
                            Row(
                                Modifier.padding(14.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(12.dp)
                            ) {
                                Icon(Icons.Filled.LockOpen, contentDescription = null)
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        stringResource(R.string.jobs_other_jobs_request),
                                        style = MaterialTheme.typography.titleSmall
                                    )
                                    Text(
                                        stringResource(
                                            if (online) R.string.jobs_other_jobs_request_body
                                            else R.string.access_needs_connection
                                        ),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                                Icon(
                                    Icons.Filled.ChevronRight,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                    }
                }

                // Jobs this phone keeps after its person was taken off them.
                // Hidden from the list, never deleted: a shift may still be
                // running on one, and anything not sent yet waits here until
                // access comes back. They open on the crew screen, where a
                // shift is clocked out.
                if (scoped.showKept) {
                    item {
                        Column(Modifier.padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(
                                stringResource(R.string.jobs_kept_title),
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Bold
                            )
                            Text(
                                stringResource(R.string.jobs_kept_body),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                    items(heldJobs, key = { "kept-${it.id}" }) { job ->
                        JobRow(
                            customerName = job.customerName.ifBlank { stringResource(R.string.home_untitled_job) },
                            address = job.address,
                            status = job.status,
                            trailingText = "",
                            onClick = { onOpenCrewJob(job.id) },
                            // Only the job row itself can say it holds an edit
                            // the office has not got; shifts and photos are
                            // covered by the explanation above.
                            caption = if (com.fenceestimator.app.data.jobHoldsUnpushedEdit(job))
                                stringResource(R.string.jobs_kept_unsent) else null
                        )
                    }
                }
            }
        }
        }
    }

    pendingDelete?.let { job ->
        // Counted fresh each time the dialog opens rather than once at compose
        // time -- a running clock-in is still adding hours while this sits on
        // screen. Null means the count failed and must read as "unknown", not
        // as zero: a wiped-out count reading as "nothing at risk" is exactly
        // the failure this dialog exists to prevent.
        var hoursState by remember(job.id) { mutableStateOf<Double?>(null) }
        var hoursFailed by remember(job.id) { mutableStateOf(false) }
        LaunchedEffect(job.id) {
            val result = viewModel.countRecordedHours(job.id)
            hoursFailed = result == null
            hoursState = result
        }
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text(stringResource(R.string.jobs_delete_title)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        stringResource(
                            R.string.jl_delete_job_body,
                            job.customerName.ifBlank { stringResource(R.string.home_untitled_job) }
                        )
                    )
                    Text(
                        when {
                            hoursFailed -> stringResource(R.string.delc_hours_failed)
                            hoursState == null -> stringResource(R.string.delc_hours_checking)
                            hoursState == 0.0 -> stringResource(R.string.delc_hours_zero)
                            else -> stringResource(
                                R.string.delc_hours_present,
                                stringResource(R.string.delc_hours_value, hoursState!!)
                            )
                        },
                        style = MaterialTheme.typography.bodyMedium
                    )
                }
            },
            confirmButton = {
                // Error-tinted, matching the job's own Delete Job flow: red is
                // reserved for the one button on this screen that cannot be
                // undone, not spent on ordinary confirmations.
                Button(
                    onClick = { viewModel.deleteJob(job); pendingDelete = null },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error,
                        contentColor = MaterialTheme.colorScheme.onError
                    )
                ) { Text(stringResource(R.string.action_delete)) }
            },
            dismissButton = {
                OutlinedButton(onClick = { pendingDelete = null }) { Text(stringResource(R.string.action_cancel)) }
            }
        )
    }
}

/** One wording for a job's status everywhere it is shown; see [JobStatus.label]. */
@Composable
internal fun statusLabel(status: JobStatus): String = status.label()
