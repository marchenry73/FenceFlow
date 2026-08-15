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

    val overdueWatcher: com.fenceestimator.app.notify.OverdueWatcher by lazy {
        com.fenceestimator.app.notify.OverdueWatcher(applicationScope, repository, this)
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

        session.refresh()
        // Self-heals installs whose catalog never got seeded -- without a catalog,
        // Suggest Quantities silently returns nothing.
        applicationScope.launch(Dispatchers.IO) {
            runCatching { repository.ensureSeedDataPresent() }
        }
        autoSync.start()
        // Checks hourly, and once now, so a job that ran long yesterday is
        // flagged on opening the app rather than an hour later.
        overdueWatcher.start()
    }
}
