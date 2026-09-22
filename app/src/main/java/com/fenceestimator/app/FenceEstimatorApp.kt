package com.fenceestimator.app

import android.app.Application
import com.fenceestimator.app.data.AppDatabase
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.cloud.AutoSync
import com.fenceestimator.app.cloud.CrashReporter
import com.fenceestimator.app.cloud.SessionManager
import com.fenceestimator.app.data.SettingsStore
import com.fenceestimator.app.notify.Notifications
import com.fenceestimator.app.notify.PushTokenStore
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class FenceEstimatorApp : Application() {
    val applicationScope = CoroutineScope(SupervisorJob())

    /**
     * Set once the database has loaded ([startIfPossible]). Nothing may read
     * it before [started] is true: a process started while the app was being
     * updated can come up without it (see [StartupGuard]), and every screen
     * sits behind MainActivity's check.
     */
    lateinit var repository: Repository
        private set

    /**
     * True once the database loaded and everything that runs on it -- sync,
     * the change feed, the watchers -- has been started. False in a process
     * that came up in the middle of an update; a push arriving then may show
     * its notification but must not reach for the database.
     */
    @Volatile var started: Boolean = false
        private set

    /** A class-loading failure already counted for this process -- see [startIfPossible]. */
    @Volatile private var settlingThisProcess: Boolean = false

    lateinit var settingsStore: SettingsStore
        private set

    val session: SessionManager by lazy { SessionManager(applicationScope) }

    val autoSync: AutoSync by lazy { AutoSync(applicationScope, repository, session, this) }

    /** Live row changes, so money lands without anyone pressing anything. */
    val realtimeWatcher: com.fenceestimator.app.cloud.RealtimeWatcher by lazy {
        com.fenceestimator.app.cloud.RealtimeWatcher(applicationScope, session, autoSync)
    }

    /** Monday morning: last week in a line, this week in another. */
    val weeklySummary: com.fenceestimator.app.notify.WeeklySummary by lazy {
        com.fenceestimator.app.notify.WeeklySummary(applicationScope, repository, session, this)
    }

    val overdueWatcher: com.fenceestimator.app.notify.OverdueWatcher by lazy {
        com.fenceestimator.app.notify.OverdueWatcher(applicationScope, repository, session, this)
    }

    /** Ties the data on this phone to an account, not to the phone. */
    val dataOwnership: com.fenceestimator.app.cloud.DataOwnership by lazy {
        com.fenceestimator.app.cloud.DataOwnership(this, repository, settingsStore)
    }

    /** Syncs the second signal returns, rather than waiting out the heartbeat. */
    val connectivity: com.fenceestimator.app.cloud.ConnectivityWatcher by lazy {
        com.fenceestimator.app.cloud.ConnectivityWatcher(this) { autoSync.requestSync() }
    }

    override fun onCreate() {
        super.onCreate()
        // First line in the process, deliberately. Anything set up above
        // this point would crash unreported, and startup is where the
        // nastiest crashes live -- a bad migration takes the app down before
        // a single screen draws.
        CrashReporter.install(this)
        settingsStore = SettingsStore(this)
        // Before the database, so a push that starts the process mid-update
        // can still show its notification.
        Notifications.ensureChannels(this)
        startIfPossible()
    }

    /**
     * Loads the database and starts everything that runs on it. Idempotent;
     * true once started.
     *
     * Called from [onCreate], and again by MainActivity when onCreate could
     * not (a retry costs nothing, and a class loader that only blinked gets
     * a second chance). Room used to be built unguarded right here in
     * onCreate, so a process whose class loader could not see the database
     * classes -- started by a push, the widget, or a tap on the icon -- died
     * before a screen drew, as many times as it was started: seven fatal
     * reports from one crew phone on 1.512, after that build had already run
     * cleanly once. What happens instead is [StartupGuard]'s call.
     */
    fun startIfPossible(): Boolean {
        if (started) return true
        synchronized(this) {
            if (started) return true
            val loaded = try {
                // Repository too: its constructor asks the database for every
                // dao, and each dao is generated code that loads the same way.
                Repository(AppDatabase.getInstance(this, applicationScope))
            } catch (e: Throwable) {
                // A retry in a process whose failure was already counted and
                // reported: the same failure again says nothing new.
                if (settlingThisProcess && StartupGuard.isMissingGeneratedCode(e)) return false
                val prefs = getSharedPreferences(STARTUP_PREFS, MODE_PRIVATE)
                val remembered = if (!prefs.contains(KEY_FAILURES)) null else StartupGuard.Tally(
                    build = prefs.getInt(KEY_FAILED_BUILD, -1),
                    failures = prefs.getInt(KEY_FAILURES, 0),
                    firstFailureAt = prefs.getLong(KEY_FIRST_FAILURE_AT, 0L)
                )
                // The window runs from this build's first failure, not from
                // the install: the 1.512 burst came after a clean start, and
                // nothing that rewrites compiled code moves the install time.
                val outcome = StartupGuard.onFailure(e, remembered, BuildConfig.VERSION_CODE, System.currentTimeMillis())
                val verdict = outcome.verdict
                if (verdict == StartupGuard.Verdict.CRASH) throw e
                settlingThisProcess = true
                // commit, not apply: this process may be about to be killed.
                prefs.edit()
                    .putInt(KEY_FAILED_BUILD, outcome.tally.build)
                    .putInt(KEY_FAILURES, outcome.tally.failures)
                    .putLong(KEY_FIRST_FAILURE_AT, outcome.tally.firstFailureAt)
                    .commit()
                if (verdict == StartupGuard.Verdict.REPORT_AND_WAIT) {
                    // Install age for the report only: it decides nothing.
                    val sinceInstall = runCatching {
                        System.currentTimeMillis() - packageManager.getPackageInfo(packageName, 0).lastUpdateTime
                    }.getOrNull()
                    CrashReporter.report(
                        this, "startup", StartupGuard.UpdateInProgress(loadFailureDetail(e, sinceInstall))
                    )
                }
                return false
            }
            // Loaded: whatever was counted against this build is over. commit,
            // not apply: a tally left behind by a process killed before the
            // write landed would time the NEXT streak from this one's first
            // failure, and crash it at once. Only ever after a failure, so rare.
            getSharedPreferences(STARTUP_PREFS, MODE_PRIVATE).let { prefs ->
                if (prefs.contains(KEY_FAILURES)) prefs.edit().clear().commit()
            }
            repository = loaded
            startServices()
            started = true
            return true
        }
    }

    /**
     * What the class loader itself says about the database class, which Room
     * throws away -- asked again here without initialising anything, so the
     * one report this writes carries the real reason (a path, a missing
     * dependency) instead of Room's "does not exist" a second time.
     */
    private fun loadFailureDetail(original: Throwable, sinceInstallMs: Long?): Throwable {
        val probe = runCatching {
            Class.forName(DATABASE_IMPL, false, AppDatabase::class.java.classLoader)
        }.exceptionOrNull()
        val installed = sinceInstallMs?.let { "${it / 1000}s" } ?: "unknown"
        val codePath = runCatching { applicationInfo.sourceDir }.getOrNull() ?: "unknown"
        val detail = "Installed or updated $installed before this launch; code path $codePath; " +
            (if (probe == null) "a second lookup of $DATABASE_IMPL succeeded" else "a second lookup failed too")
        return RuntimeException(detail, probe ?: original).also { if (probe != null) it.addSuppressed(original) }
    }

    /** Everything that needs the database, started once it has loaded. */
    private fun startServices() {
        PDFBoxResourceLoader.init(applicationContext)
        // Fetch the push token early so it's cached and ready by the time the
        // session knows which company this user belongs to.
        PushTokenStore.refresh(this)
        session.pushTokenProvider = { PushTokenStore.cached(this) }
        session.settingsStore = settingsStore
        session.dataOwnership = dataOwnership
        // So the app knows who it belongs to before it can reach the network.
        session.appContext = applicationContext

        // Tombstones record who deleted the record, so the trash can say who to
        // ask before restoring it.
        applicationScope.launch {
            session.state.collect {
                repository.deletingUser = it.email.orEmpty()
                // So a crash report names the account that was signed in when
                // it happened, not whoever is signed in when it uploads.
                CrashReporter.currentEmail = it.email.orEmpty()
                CrashReporter.currentCompanyId = it.companyId.orEmpty()
            }
        }
        // Anything saved by a previous crash goes up as soon as there is an
        // identity to attach it to, so a report says which company hit it.
        applicationScope.launch {
            session.state.collect { st ->
                if (st.signedIn && st.companyId != null) {
                    CrashReporter.uploadPending(
                        applicationScope, this@FenceEstimatorApp, st.companyId, st.email
                    )
                }
            }
        }
        session.refresh()
        // Self-heals installs whose catalog never got seeded -- without a catalog,
        // Suggest Quantities silently returns nothing.
        applicationScope.launch(Dispatchers.IO) {
            runCatching { repository.ensureSeedDataPresent() }
        }
        autoSync.fileUploader = com.fenceestimator.app.cloud.JobFileUploader(
            applicationScope, repository, this
        )
        autoSync.start()
        realtimeWatcher.start()

        // Coming back to the app re-checks everything.
        //
        // Someone reads the screen the second they open it, so that is exactly
        // when the numbers and the access level must already be right. The
        // change feed usually got there first, but a phone that was asleep or
        // out of signal has no socket to be told over.
        androidx.lifecycle.ProcessLifecycleOwner.get().lifecycle.addObserver(
            androidx.lifecycle.LifecycleEventObserver { _, event ->
                when (event) {
                    androidx.lifecycle.Lifecycle.Event.ON_START -> {
                        autoSync.inForeground = true
                        session.refresh()
                        autoSync.requestSync()
                    }
                    androidx.lifecycle.Lifecycle.Event.ON_STOP -> {
                        autoSync.inForeground = false
                    }
                    else -> Unit
                }
            }
        )
        connectivity.start()
        // Checks hourly, and once now, so a job that ran long yesterday is
        // flagged on opening the app rather than an hour later.
        overdueWatcher.start()
        weeklySummary.start()
    }

    private companion object {
        /** SharedPreferences, not DataStore: read and written on the one path that must not need anything. */
        const val STARTUP_PREFS = "startup_guard"
        const val KEY_FAILED_BUILD = "failed_build"
        const val KEY_FAILURES = "failures"
        const val KEY_FIRST_FAILURE_AT = "first_failure_at"
        const val DATABASE_IMPL = "com.fenceestimator.app.data.AppDatabase_Impl"
    }
}
