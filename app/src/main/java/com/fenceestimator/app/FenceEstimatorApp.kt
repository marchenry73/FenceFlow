package com.fenceestimator.app

import android.app.Application
import com.fenceestimator.app.data.AppDatabase
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.cloud.AutoSync
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

    lateinit var repository: Repository
        private set

    lateinit var settingsStore: SettingsStore
        private set

    val session: SessionManager by lazy { SessionManager(applicationScope) }

    val autoSync: AutoSync by lazy { AutoSync(applicationScope, repository, session, this) }

    /** Live row changes, so money lands without anyone pressing anything. */
    val realtimeWatcher: com.fenceestimator.app.cloud.RealtimeWatcher by lazy {
        com.fenceestimator.app.cloud.RealtimeWatcher(applicationScope, session, autoSync)
    }

    val overdueWatcher: com.fenceestimator.app.notify.OverdueWatcher by lazy {
        com.fenceestimator.app.notify.OverdueWatcher(applicationScope, repository, this)
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
        PDFBoxResourceLoader.init(applicationContext)
        val db = AppDatabase.getInstance(this, applicationScope)
        repository = Repository(db)
        settingsStore = SettingsStore(this)

        Notifications.ensureChannels(this)
        // Fetch the push token early so it's cached and ready by the time the
        // session knows which company this user belongs to.
        PushTokenStore.refresh(this)
        session.pushTokenProvider = { PushTokenStore.cached(this) }
        session.settingsStore = settingsStore
        session.dataOwnership = dataOwnership

        // Tombstones record who deleted the record, so the trash can say who to
        // ask before restoring it.
        applicationScope.launch {
            session.state.collect { repository.deletingUser = it.email.orEmpty() }
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
    }
}
