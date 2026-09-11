package com.fenceestimator.app

import kotlinx.coroutines.launch
import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.input.pointer.pointerInput
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.fenceestimator.app.notify.Notifications
import com.fenceestimator.app.ui.lock.IdleTimer
import com.fenceestimator.app.ui.lock.LockScreen
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.ThemeMode
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import androidx.navigation.NavType
import com.fenceestimator.app.ui.account.AccountScreen
import com.fenceestimator.app.ui.catalog.CatalogScreen
import com.fenceestimator.app.ui.components.WithAppLanguage
import com.fenceestimator.app.ui.crew.CrewJobScreen
import com.fenceestimator.app.ui.customers.CustomersScreen
import com.fenceestimator.app.ui.employees.EmployeesScreen
import com.fenceestimator.app.ui.estimate.EstimateScreen
import com.fenceestimator.app.ui.inventory.InventoryScreen
import com.fenceestimator.app.ui.jobs.JobDetailScreen
import com.fenceestimator.app.ui.jobs.JobsListScreen
import com.fenceestimator.app.ui.manufacturers.ManufacturersScreen
import com.fenceestimator.app.ui.nav.Routes
import com.fenceestimator.app.ui.reports.ReportsScreen
import com.fenceestimator.app.ui.runs.RunEditScreen
import com.fenceestimator.app.ui.schedule.ScheduleScreen
import com.fenceestimator.app.ui.settings.SettingsScreen
import com.fenceestimator.app.ui.survey.SurveyDrawScreen
import com.fenceestimator.app.ui.components.devBackendBadge
import com.fenceestimator.app.ui.theme.FenceEstimatorTheme
import com.fenceestimator.app.guest.GuestBanner
import com.fenceestimator.app.guest.GuestSeeder
import com.fenceestimator.app.guest.GuestSession
import com.fenceestimator.app.guest.GuestWipe
import com.fenceestimator.app.guest.WelcomeScreen

// FragmentActivity rather than ComponentActivity: BiometricPrompt requires a
// FragmentActivity to host its dialog. FragmentActivity is itself a
// ComponentActivity, so Compose and the result APIs are unaffected.
class MainActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        Notifications.ensureChannels(this)
        setContent {
            // Android 13+ won't post anything without this, and silently drops
            // notifications rather than telling you -- so ask once on launch.
            val notificationPermission = rememberLauncherForActivityResult(
                ActivityResultContracts.RequestPermission()
            ) { }
            LaunchedEffect(Unit) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                    !Notifications.hasPermission(this@MainActivity)
                ) {
                    notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
            }
            val app = LocalContext.current.applicationContext as FenceEstimatorApp
            val profile by app.settingsStore.profile.collectAsState(initial = BusinessProfile())
            val appSession by app.session.state.collectAsState()
            val darkTheme = when (profile.themeMode) {
                ThemeMode.LIGHT -> false
                ThemeMode.DARK -> true
                ThemeMode.SYSTEM -> isSystemInDarkTheme()
            }
            WithAppLanguage(profile.language) {
                FenceEstimatorTheme(darkTheme = darkTheme) {
                    Surface(modifier = Modifier.fillMaxSize().devBackendBadge()) {
                        // Whether a guest session is currently running, straight
                        // off the one persisted flag -- see GuestSession/GuestWipe.
                        val guestActive = com.fenceestimator.app.guest.GuestSession.isActive(profile)
                        // Null until Room has answered once. Treated as "not
                        // empty" below on purpose: judging "no real data" off a
                        // list that hasn't loaded yet would flash the welcome
                        // screen at a contractor with months of jobs, for the
                        // one frame before the query returns.
                        val jobs by app.repository.observeJobs().collectAsState(initial = null)
                        // Set the instant a choice is made on the welcome screen,
                        // so the screen doesn't hang around for the frames it
                        // takes guestActive (a DataStore-backed flow) to catch up.
                        var welcomeDismissedThisLaunch by remember { mutableStateOf(false) }
                        var seedingGuest by remember { mutableStateOf(false) }
                        var postWelcomeStartRoute by remember { mutableStateOf(Routes.JOBS) }
                        // Recomposes the countdown text once a second. profile
                        // (a DataStore flow) only changes when the flag itself is
                        // written, which is once at the start and once at the end
                        // -- nothing between those two moments would otherwise
                        // ever redraw the clock.
                        var guestNowTick by remember { mutableStateOf(System.currentTimeMillis()) }

                        // Cleans up a guest session left behind by a killed
                        // process -- the countdown may have run out while
                        // nothing was around to act on it. GuestWipe re-checks
                        // every guard itself; this call is a no-op whenever the
                        // five minutes are not actually up.
                        LaunchedEffect(Unit) {
                            GuestWipe.wipeIfDue(app.repository, app.settingsStore, app.session)
                        }

                        // The visible countdown, ticking once a second for as
                        // long as a guest session is running. Keys on
                        // guestActive rather than a fixed duration so
                        // backgrounding and reopening the app resumes the same
                        // loop against the same persisted start time instead of
                        // starting a fresh timer.
                        LaunchedEffect(guestActive) {
                            while (guestActive) {
                                guestNowTick = System.currentTimeMillis()
                                if (GuestWipe.wipeIfDue(app.repository, app.settingsStore, app.session)) {
                                    welcomeDismissedThisLaunch = false
                                    break
                                }
                                kotlinx.coroutines.delay(1000)
                            }
                        }

                        // Signing in for real while a guest session happens to
                        // still be running (reachable from Settings > Account
                        // inside the guest app itself) ends the countdown's
                        // bookkeeping immediately. This clears only the flag,
                        // never a row -- GuestWipe already refuses to delete
                        // anything the moment somebody is signed in, so any
                        // demo jobs already seeded are simply left in place,
                        // still carrying their "Guest Demo" marker, for that
                        // now-real account to see and remove itself. See the
                        // handoff report for why this is judged safer than
                        // trying to guess which rows to discard on their behalf.
                        LaunchedEffect(appSession.signedIn, guestActive) {
                            if (appSession.signedIn && guestActive) {
                                app.settingsStore.endGuestSession()
                            }
                        }

                        // Shown only when ALL of: nobody is signed in, no guest
                        // session is running, and this phone looks like it has
                        // never held real work -- the same "no work here yet"
                        // test JobsListScreen already trusts to decide whether
                        // to show the first-run tour (hasSeenTour false AND
                        // updatedAt == 0L, meaning settings were never even
                        // saved once), with jobs.isEmpty() added on top. A
                        // contractor who deleted every job but has otherwise
                        // touched the app even once will not see this again.
                        val showWelcome = !appSession.signedIn && !guestActive &&
                            !welcomeDismissedThisLaunch && jobs != null && jobs!!.isEmpty() &&
                            !profile.hasSeenTour && profile.updatedAt == 0L

                        if (showWelcome) {
                            WelcomeScreen(
                                seeding = seedingGuest,
                                onSignIn = {
                                    postWelcomeStartRoute = Routes.ACCOUNT
                                    welcomeDismissedThisLaunch = true
                                },
                                onTryGuest = {
                                    seedingGuest = true
                                    app.applicationScope.launch {
                                        runCatching { GuestSeeder.seed(app.repository) }
                                        app.settingsStore.startGuestSession(System.currentTimeMillis())
                                        postWelcomeStartRoute = Routes.JOBS
                                        welcomeDismissedThisLaunch = true
                                        seedingGuest = false
                                    }
                                }
                            )
                        } else {
                        var locked by remember { mutableStateOf(false) }

                        // Re-check on every return to the foreground; that's when a
                        // phone left on a truck seat would have gone idle.
                        val lifecycleOwner = LocalLifecycleOwner.current
                        DisposableEffect(lifecycleOwner, profile.autoLockMinutes) {
                            val observer = LifecycleEventObserver { _, event ->
                                when (event) {
                                    Lifecycle.Event.ON_RESUME ->
                                        if (IdleTimer.isExpired(profile.autoLockMinutes)) locked = true
                                    Lifecycle.Event.ON_PAUSE -> IdleTimer.touch()
                                    else -> {}
                                }
                            }
                            lifecycleOwner.lifecycle.addObserver(observer)
                            onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
                        }

                        if (locked) {
                            LockScreen(
                                useBiometric = profile.biometricUnlockEnabled,
                                onUnlocked = { locked = false }
                            )
                        } else {
                            // Any touch anywhere counts as activity, so the timer
                            // only fires on genuine inactivity.
                            Box(
                                Modifier.fillMaxSize().pointerInput(Unit) {
                                    awaitPointerEventScope {
                                        while (true) {
                                            awaitPointerEvent()
                                            IdleTimer.touch()
                                        }
                                    }
                                }
                            ) {
                                // Whether this company is entitled to be here.
                                //
                                // The database has judged this from the start and
                                // nothing ever asked, so access control existed on
                                // paper only. It closes ONLY on a definite answer:
                                // never being able to ask keeps the app working,
                                // because a crew locked out in a dead zone is a
                                // real cost to a paying customer, and RLS refuses
                                // a suspended company's data server-side anyway.
                                var service by remember {
                                    mutableStateOf<com.fenceestimator.app.cloud.ServiceStatus?>(null)
                                }
                                var checkedService by remember { mutableStateOf(false) }
                                var recheck by remember { mutableStateOf(0) }
                                // Whether the last attempt actually reached the
                                // server. A button that reports nothing is
                                // indistinguishable from a button that is broken.
                                var checkingService by remember { mutableStateOf(false) }
                                var couldNotCheck by remember { mutableStateOf(false) }
                                var signingOut by remember { mutableStateOf(false) }
                                // Work the phone is holding because a wipe was
                                // refused; see HeldWorkScreen for the two ways
                                // out. Checked before the service gate because
                                // a removed crew member is usually blocked too,
                                // and the block screen's answer -- sign out --
                                // is the wrong one while this is set.
                                val heldWork by app.dataOwnership.heldWork.collectAsState()

                                // Re-asked whenever the app comes back to the
                                // foreground, not only when somebody signs in.
                                // Checking once at sign-in meant an app already
                                // open never learned it had been switched off --
                                // which is what was seen when suspending a
                                // company changed nothing on a running phone.
                                DisposableEffect(lifecycleOwner) {
                                    val watcher = LifecycleEventObserver { _, event ->
                                        if (event == Lifecycle.Event.ON_RESUME) recheck++
                                    }
                                    lifecycleOwner.lifecycle.addObserver(watcher)
                                    onDispose { lifecycleOwner.lifecycle.removeObserver(watcher) }
                                }

                                LaunchedEffect(appSession.signedIn, recheck) {
                                    val ctx = applicationContext
                                    // The remembered answer first, so a phone
                                    // already told 'blocked' stays blocked without
                                    // waiting for the network.
                                    service = com.fenceestimator.app.cloud.ServiceGate.remembered(ctx)
                                    if (appSession.signedIn) {
                                        checkingService = true
                                        val fresh = com.fenceestimator.app.cloud.ServiceGate
                                            .refreshWhenPossible(ctx)
                                        checkingService = false
                                        couldNotCheck = fresh == null
                                        fresh?.let { service = it }

                                        // One login, one phone at a time.
                                        //
                                        // A shared login walks straight past
                                        // the seat limit: a Crew plan buys six
                                        // logins, and six shared two ways is
                                        // twelve people paying for six. The
                                        // newest sign-in wins, so losing a
                                        // handset is survivable -- sign in on
                                        // the new one and the old one lets go.
                                        //
                                        // Only ever acted on when the server
                                        // says so definitely. Offline leaves it
                                        // alone: nobody gets thrown out of the
                                        // app on a guess in a dead spot.
                                        if (fresh != null) {
                                            val holds = com.fenceestimator.app.cloud.ServiceGate
                                                .holdsLogin(ctx)
                                            if (!holds) {
                                                service = fresh.copy(
                                                    allowed = false,
                                                    reason = getString(R.string.svc_signed_in_elsewhere)
                                                )
                                            }
                                        }
                                        // After the gate, because by then the
                                        // token is known to be live.
                                        runCatching {
                                            com.fenceestimator.app.cloud.SupabaseModule
                                                .recordAppVersion()
                                        }
                                    }
                                    checkedService = true
                                }

                                val blocked = service?.allowed == false
                                if (heldWork != null) {
                                    com.fenceestimator.app.ui.onboarding.HeldWorkScreen(
                                        held = heldWork!!,
                                        signingOut = signingOut,
                                        onSignOutKeeping = {
                                            signingOut = true
                                            app.applicationScope.launch {
                                                // Not through DataOwnership.onSignedOut:
                                                // that is the wipe this screen exists
                                                // to refuse. The session ends, the
                                                // data and its owner stamp stay.
                                                runCatching {
                                                    app.dataOwnership.releaseHold()
                                                    com.fenceestimator.app.cloud.ServiceGate
                                                        .clear(applicationContext)
                                                    com.fenceestimator.app.cloud.SupabaseModule.signOut()
                                                }
                                                com.fenceestimator.app.cloud.SupabaseModule
                                                    .justSignedOut = true
                                                app.session.refresh()
                                                signingOut = false
                                            }
                                        },
                                        onDiscard = {
                                            app.applicationScope.launch {
                                                runCatching { app.dataOwnership.discardHeldWork() }
                                                // Resolving again runs the ownership
                                                // hooks with a clean phone, which
                                                // adopts whatever is signed in.
                                                app.session.refresh()
                                            }
                                        }
                                    )
                                } else if (checkedService && blocked) {
                                    com.fenceestimator.app.ui.onboarding.ServiceBlockedScreen(
                                        status = service!!,
                                        checking = checkingService,
                                        couldNotCheck = couldNotCheck,
                                        signingOut = signingOut,
                                        onRetry = { recheck++ },
                                        onSignOut = {
                                            signingOut = true
                                            app.applicationScope.launch {
                                                runCatching {
                                                    // This phone has been evicted -- another
                                                    // handset took the login. The ordinary
                                                    // sign-out wipes the phone through
                                                    // DataOwnership; this path called signOut()
                                                    // directly and left the company's books on
                                                    // a device that may be exactly the one that
                                                    // was lost or taken. Forced -- but only
                                                    // after the screen has shown what unsynced
                                                    // work the phone holds and taken a second
                                                    // tap to confirm losing it. The gate blocks
                                                    // syncing from here, so waiting for signal
                                                    // can never get that work up; saying so and
                                                    // asking is the most the app can do.
                                                    runCatching { app.dataOwnership.onSignedOut(force = true) }
                                                    com.fenceestimator.app.cloud.ServiceGate
                                                        .clear(applicationContext)
                                                    com.fenceestimator.app.cloud.SupabaseModule.signOut()
                                                }
                                                // Remembered so the sign-in screen
                                                // can confirm what just happened,
                                                // rather than simply appearing.
                                                com.fenceestimator.app.cloud.SupabaseModule
                                                    .justSignedOut = true
                                                app.session.refresh()
                                                signingOut = false
                                            }
                                        }
                                    )
                                } else {
                                    androidx.compose.foundation.layout.Column {
                                        // Always on, never dismissible, for as long as
                                        // the session runs -- the owner asked for the
                                        // countdown to be visible and honest, not a
                                        // one-time toast someone could miss.
                                        if (guestActive) {
                                            GuestBanner(
                                                remainingMs = GuestSession.remainingMs(profile, guestNowTick)
                                            )
                                        }
                                        // The trial says it is ending instead of just
                                        // ending. Day 14 used to be a lock with no
                                        // warning -- the first sign was being unable to
                                        // open the app in front of a customer. Three
                                        // days is enough to decide like a customer
                                        // rather than react like a lockout.
                                        // Copied to a local val: `service` is a
                                        // delegated (collectAsState) property, so
                                        // the compiler can't smart-cast through
                                        // `service?.x` checks below to a plain
                                        // `service.plan` read afterwards.
                                        val svc = service
                                        val daysLeft = svc?.trialDaysLeft
                                        if (svc?.subscribed == true && daysLeft != null && daysLeft in 0..7) {
                                            // Somebody who has already picked a plan
                                            // during their trial is not deciding
                                            // anything any more -- a card is on file
                                            // and will be charged on the day their
                                            // trial ends. "Your trial ends in N days"
                                            // reads as a threat to someone who has
                                            // already committed; what they actually
                                            // want to know is when they start being
                                            // charged, so that is what this says
                                            // instead, and it is not styled as a
                                            // warning because nothing here needs
                                            // deciding.
                                            // Mirrors showServiceBanner() in website/dashboard.html
                                            // word for word, including the one detail easy to
                                            // miss: "today" is charged TODAY, not "then" -- the
                                            // card is charged the moment the trial ends, and on
                                            // day zero that moment is today, not some later "then".
                                            val plan = svc.plan.trim()
                                                .let { if (it.isBlank()) "Your" else it.lowercase().replaceFirstChar { c -> c.uppercase() } }
                                            val bannerText = when {
                                                daysLeft <= 0 -> "Your $plan plan starts today — your card is charged today."
                                                daysLeft == 1 -> "Your $plan plan starts tomorrow — your card is charged then."
                                                else -> "Your $plan plan starts in $daysLeft days — your card is charged then."
                                            }
                                            androidx.compose.material3.Surface(
                                                color = MaterialTheme.colorScheme.secondaryContainer,
                                                modifier = Modifier.fillMaxWidth()
                                            ) {
                                                Text(
                                                    bannerText,
                                                    style = MaterialTheme.typography.bodyMedium,
                                                    color = MaterialTheme.colorScheme.onSecondaryContainer,
                                                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
                                                )
                                            }
                                        } else if (svc?.subscriptionStatus == "trialing" &&
                                            daysLeft != null && daysLeft <= 3
                                        ) {
                                            androidx.compose.material3.Surface(
                                                color = MaterialTheme.colorScheme.errorContainer,
                                                modifier = Modifier.fillMaxWidth()
                                            ) {
                                                Text(
                                                    if (daysLeft <= 1) "Your trial ends today. Get in touch to keep your data flowing."
                                                    else "Your trial ends in $daysLeft days.",
                                                    style = MaterialTheme.typography.bodyMedium,
                                                    color = MaterialTheme.colorScheme.onErrorContainer,
                                                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
                                                )
                                            }
                                        }
                                        androidx.compose.runtime.CompositionLocalProvider(
                                            com.fenceestimator.app.ui.components.LocalEntitlements provides
                                                com.fenceestimator.app.cloud.Entitlements.of(
                                                    service?.plan.orEmpty()
                                                )
                                        ) {
                                            FenceEstimatorNavHost(startDestination = postWelcomeStartRoute)
                                        }
                                    }
                                }
                            }
                        }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun FenceEstimatorNavHost(startDestination: String = Routes.JOBS) {
    val navController: NavHostController = rememberNavController()

    // Watched for the whole graph, so a screen closes the moment the person
    // loses the right to be on it rather than when they next navigate. Access
    // used to be checked only on the way in, which meant taking somebody's
    // access away did not take away what they were already looking at.
    val session by com.fenceestimator.app.ui.components.currentApp()
        .session.state.collectAsState()

    // Notes which screen is open so a crash report names it. This is the
    // route pattern ("job/{jobId}"), never the filled-in route, so no job or
    // customer id rides along into an error record.
    val backStack by navController.currentBackStackEntryAsState()
    androidx.compose.runtime.LaunchedEffect(backStack) {
        com.fenceestimator.app.cloud.CrashReporter.currentScreen =
            backStack?.destination?.route.orEmpty()
    }

    NavHost(navController = navController, startDestination = startDestination) {
        composable(Routes.JOBS) {
            JobsListScreen(
                onOpenJob = { id -> navController.navigate(Routes.jobDetail(id)) },
                onOpenCatalog = { navController.navigate(Routes.CATALOG) },
                onOpenSettings = { navController.navigate(Routes.SETTINGS) },
                onOpenCustomers = { navController.navigate(Routes.CUSTOMERS) },
                onOpenSchedule = { navController.navigate(Routes.SCHEDULE) },
                onOpenReports = { navController.navigate(Routes.REPORTS) },
                onOpenPipeline = { navController.navigate(Routes.PIPELINE) },
                onOpenTimeApproval = { navController.navigate(Routes.TIME_APPROVAL) },
                onOpenAccount = { navController.navigate(Routes.ACCOUNT) }
            )
        }
        composable(Routes.REPORTS) {
            com.fenceestimator.app.ui.components.AccessGuard(
                allowed = session.canSeeMoney,
                permissionName = "See money",
                onLeave = { navController.popBackStack() }
            ) {
                ReportsScreen(onBack = { navController.popBackStack() })
            }
        }
        composable(Routes.PIPELINE) {
          com.fenceestimator.app.ui.components.AccessGuard(
              allowed = session.canSeeMoney,
              permissionName = "See money",
              onLeave = { navController.popBackStack() }
          ) {
            com.fenceestimator.app.ui.pipeline.PipelineScreen(
                onOpenJob = { id -> navController.navigate(Routes.jobDetail(id)) },
                onBack = { navController.popBackStack() }
            )
          }
        }
        composable(Routes.HELP) {
            com.fenceestimator.app.ui.help.HelpScreen(onBack = { navController.popBackStack() })
        }
        composable(Routes.FEEDBACK) {
            com.fenceestimator.app.ui.feedback.FeedbackScreen(onBack = { navController.popBackStack() })
        }
        composable(
            Routes.JOB_DETAIL,
            arguments = listOf(navArgument("jobId") { type = NavType.LongType })
        ) { backStackEntry ->
            val jobId = backStackEntry.arguments?.getLong("jobId") ?: 0L
            JobDetailScreen(
                jobId = jobId,
                onBack = { navController.popBackStack() },
                onOpenSurvey = { id -> navController.navigate(Routes.survey(id)) },
                onOpenEstimate = { id -> navController.navigate(Routes.estimate(id)) },
                onOpenRun = { runId -> navController.navigate(Routes.runEdit(runId)) },
                onOpenInventory = { id -> navController.navigate(Routes.inventory(id)) },
                onOpenCrewView = { id -> navController.navigate(Routes.crewJob(id)) },
                onDeleted = { navController.popBackStack(Routes.JOBS, inclusive = false) }
            )
        }
        composable(
            Routes.CREW_JOB,
            arguments = listOf(navArgument("jobId") { type = NavType.LongType })
        ) { backStackEntry ->
            val jobId = backStackEntry.arguments?.getLong("jobId") ?: 0L
            CrewJobScreen(
                jobId = jobId,
                onBack = { navController.popBackStack() },
                // Crew get the read-only plan. The editable drawing is what the
                // estimate, post count and material order were built from, so a
                // stray tap on it costs real money.
                onOpenSurvey = { id -> navController.navigate(Routes.crewPlan(id)) }
            )
        }
        composable(
            Routes.CREW_PLAN,
            arguments = listOf(navArgument("jobId") { type = NavType.LongType })
        ) { backStackEntry ->
            val jobId = backStackEntry.arguments?.getLong("jobId") ?: 0L
            com.fenceestimator.app.ui.crew.CrewFencePlanScreen(
                jobId = jobId,
                onBack = { navController.popBackStack() }
            )
        }
        composable(
            Routes.RUN_EDIT,
            arguments = listOf(navArgument("runId") { type = NavType.LongType })
        ) { backStackEntry ->
            val runId = backStackEntry.arguments?.getLong("runId") ?: 0L
            RunEditScreen(
                runId = runId,
                onBack = { navController.popBackStack() },
                onDeleted = { navController.popBackStack() },
                onDrawRun = { jobId -> navController.navigate(Routes.survey(jobId)) }
            )
        }
        composable(
            Routes.SURVEY,
            arguments = listOf(navArgument("jobId") { type = NavType.LongType })
        ) { backStackEntry ->
            val jobId = backStackEntry.arguments?.getLong("jobId") ?: 0L
            SurveyDrawScreen(
                jobId = jobId,
                onBack = { navController.popBackStack() },
                onGoToEstimate = { id -> navController.navigate(Routes.estimate(id)) }
            )
        }
        // Guarded: the survey is for everyone (crew draw), but its "To
        // Estimate" button led straight into the full pricing screen, which
        // nothing checked. Same for supplier prices.
        composable(
            Routes.ESTIMATE,
            arguments = listOf(navArgument("jobId") { type = NavType.LongType })
        ) { backStackEntry ->
            val jobId = backStackEntry.arguments?.getLong("jobId") ?: 0L
            com.fenceestimator.app.ui.components.AccessGuard(
                allowed = session.canSeeMoney,
                permissionName = "See money",
                onLeave = { navController.popBackStack() }
            ) {
                EstimateScreen(
                    jobId = jobId,
                    onBack = { navController.popBackStack() },
                    onOpenSupplierPrices = { id -> navController.navigate(Routes.supplierPrices(id)) }
                )
            }
        }
        composable(
            Routes.INVENTORY,
            arguments = listOf(navArgument("jobId") { type = NavType.LongType })
        ) { backStackEntry ->
            val jobId = backStackEntry.arguments?.getLong("jobId") ?: 0L
            InventoryScreen(jobId = jobId, onBack = { navController.popBackStack() })
        }
        composable(Routes.CATALOG) {
            com.fenceestimator.app.ui.components.AccessGuard(
                allowed = session.canEditCatalogAndSettings,
                permissionName = "Edit catalog and settings",
                onLeave = { navController.popBackStack() }
            ) {
                CatalogScreen(onBack = { navController.popBackStack() })
            }
        }
        composable(Routes.SETTINGS) {
          com.fenceestimator.app.ui.components.AccessGuard(
              allowed = session.canEditCatalogAndSettings,
              permissionName = "Edit catalog and settings",
              onLeave = { navController.popBackStack() }
          ) {
            SettingsScreen(
                onBack = { navController.popBackStack() },
                onOpenManufacturers = { navController.navigate(Routes.MANUFACTURERS) },
                onOpenEmployees = { navController.navigate(Routes.EMPLOYEES) },
                onOpenAccount = { navController.navigate(Routes.ACCOUNT) },
                onOpenHelp = { navController.navigate(Routes.HELP) },
                onOpenFeedback = { navController.navigate(Routes.FEEDBACK) }
            )
          }
        }
        composable(Routes.ACCOUNT) {
            AccountScreen(
                onBack = { navController.popBackStack() },
                onOpenAccess = { navController.navigate(Routes.ACCESS) },
                onOpenTrash = { navController.navigate(Routes.TRASH) }
            )
        }
        composable(Routes.TIME_APPROVAL) {
            com.fenceestimator.app.ui.crew.TimeApprovalScreen(onBack = { navController.popBackStack() })
        }
        composable(
            Routes.SUPPLIER_PRICES,
            arguments = listOf(navArgument("jobId") { type = NavType.LongType })
        ) { entry ->
            com.fenceestimator.app.ui.components.AccessGuard(
                allowed = session.canSeeMoney,
                permissionName = "See money",
                onLeave = { navController.popBackStack() }
            ) {
                com.fenceestimator.app.ui.estimate.SupplierPricesScreen(
                    jobId = entry.arguments?.getLong("jobId") ?: 0L,
                    onBack = { navController.popBackStack() }
                )
            }
        }
        composable(Routes.TRASH) {
            com.fenceestimator.app.ui.components.AccessGuard(
                allowed = session.canManageAccess,
                permissionName = androidx.compose.ui.res.stringResource(R.string.access_manage_access_permission_name),
                onLeave = { navController.popBackStack() }
            ) {
                com.fenceestimator.app.ui.account.TrashScreen(onBack = { navController.popBackStack() })
            }
        }
        composable(Routes.ACCESS) {
            com.fenceestimator.app.ui.account.AccessScreen(onBack = { navController.popBackStack() })
        }
        composable(Routes.MANUFACTURERS) {
            ManufacturersScreen(onBack = { navController.popBackStack() })
        }
        composable(Routes.EMPLOYEES) {
            // The whole screen is pay: hourly rate, pay type, per-foot rate.
            // It was the last list with no guard on it -- Customers next door
            // had one, this did not -- so a crew account could open it and
            // read what every colleague earns. Gated on SEE_PAY specifically,
            // not SEE_MONEY: a salesperson has SEE_MONEY to work a job's price
            // but must not see what a colleague is paid. The database now
            // refuses to hand these rows to anyone without SEE_PAY via
            // can_see_pay(), and this stops the screen being reachable in the
            // first place rather than showing an empty list with no explanation.
            com.fenceestimator.app.ui.components.AccessGuard(
                allowed = session.canSeePay,
                permissionName = "See what people are paid",
                onLeave = { navController.popBackStack() }
            ) {
                EmployeesScreen(onBack = { navController.popBackStack() })
            }
        }
        composable(Routes.CUSTOMERS) {
            // The whole screen is customer contact -- names, addresses,
            // phones. It was the one list with no guard on it, so a crew
            // account could read every customer the business has while the
            // permission built for exactly this sat unused.
            com.fenceestimator.app.ui.components.AccessGuard(
                allowed = session.canSeeCustomerContact,
                permissionName = "See customer contact",
                onLeave = { navController.popBackStack() }
            ) {
                CustomersScreen(
                    onOpenJob = { id -> navController.navigate(Routes.jobDetail(id)) },
                    onBack = { navController.popBackStack() }
                )
            }
        }
        composable(Routes.SCHEDULE) {
            ScheduleScreen(
                onOpenJob = { id -> navController.navigate(Routes.jobDetail(id)) },
                onBack = { navController.popBackStack() }
            )
        }
    }
}
