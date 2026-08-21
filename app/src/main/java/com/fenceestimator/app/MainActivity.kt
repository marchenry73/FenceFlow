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
import com.fenceestimator.app.ui.theme.FenceEstimatorTheme

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
                    Surface(modifier = Modifier.fillMaxSize()) {
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
                                        com.fenceestimator.app.cloud.ServiceGate.refresh(ctx)
                                            ?.let { service = it }
                                    }
                                    checkedService = true
                                }

                                val blocked = service?.allowed == false
                                if (checkedService && blocked) {
                                    com.fenceestimator.app.ui.onboarding.ServiceBlockedScreen(
                                        status = service!!,
                                        onRetry = { recheck++ },
                                        onSignOut = {
                                            app.applicationScope.launch {
                                                runCatching {
                                                    com.fenceestimator.app.cloud.ServiceGate
                                                        .clear(applicationContext)
                                                    com.fenceestimator.app.cloud.SupabaseModule.signOut()
                                                }
                                                app.session.refresh()
                                            }
                                        }
                                    )
                                } else {
                                    androidx.compose.foundation.layout.Column {
                                        // The trial says it is ending instead of just
                                        // ending. Day 14 used to be a lock with no
                                        // warning -- the first sign was being unable to
                                        // open the app in front of a customer. Three
                                        // days is enough to decide like a customer
                                        // rather than react like a lockout.
                                        val daysLeft = service?.trialDaysLeft
                                        if (service?.subscriptionStatus == "trialing" &&
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
                                        FenceEstimatorNavHost()
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
fun FenceEstimatorNavHost() {
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

    NavHost(navController = navController, startDestination = Routes.JOBS) {
        composable(Routes.JOBS) {
            JobsListScreen(
                onOpenJob = { id -> navController.navigate(Routes.jobDetail(id)) },
                onOpenCatalog = { navController.navigate(Routes.CATALOG) },
                onOpenSettings = { navController.navigate(Routes.SETTINGS) },
                onOpenCustomers = { navController.navigate(Routes.CUSTOMERS) },
                onOpenSchedule = { navController.navigate(Routes.SCHEDULE) },
                onOpenReports = { navController.navigate(Routes.REPORTS) },
                onOpenPipeline = { navController.navigate(Routes.PIPELINE) },
                onOpenTimeApproval = { navController.navigate(Routes.TIME_APPROVAL) }
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
        composable(
            Routes.ESTIMATE,
            arguments = listOf(navArgument("jobId") { type = NavType.LongType })
        ) { backStackEntry ->
            val jobId = backStackEntry.arguments?.getLong("jobId") ?: 0L
            EstimateScreen(
                jobId = jobId,
                onBack = { navController.popBackStack() },
                onOpenSupplierPrices = { id -> navController.navigate(Routes.supplierPrices(id)) }
            )
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
            com.fenceestimator.app.ui.estimate.SupplierPricesScreen(
                jobId = entry.arguments?.getLong("jobId") ?: 0L,
                onBack = { navController.popBackStack() }
            )
        }
        composable(Routes.TRASH) {
            com.fenceestimator.app.ui.account.TrashScreen(onBack = { navController.popBackStack() })
        }
        composable(Routes.ACCESS) {
            com.fenceestimator.app.ui.account.AccessScreen(onBack = { navController.popBackStack() })
        }
        composable(Routes.MANUFACTURERS) {
            ManufacturersScreen(onBack = { navController.popBackStack() })
        }
        composable(Routes.EMPLOYEES) {
            EmployeesScreen(onBack = { navController.popBackStack() })
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
