package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.notify.Notifications
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

enum class SyncPhase { IDLE, SYNCING, OK, FAILED, OFFLINE_ONLY }

data class SyncState(
    val phase: SyncPhase = SyncPhase.OFFLINE_ONLY,
    val lastSyncedAt: Long? = null,
    val lastError: String? = null
)

/**
 * Keeps the cloud copy up to date without anyone pressing a button.
 *
 * Three triggers, all funnelled through one mutex so two passes can never
 * interleave and double-write:
 *  - app start
 *  - shortly after local data stops changing (debounced, so a burst of
 *    keystrokes is one sync rather than fifty)
 *  - a slow heartbeat, to pick up teammates' edits made on other phones
 *
 * Failure is deliberately quiet and non-destructive: if the network is down
 * the local database is still the source of truth and the next trigger
 * retries. Nothing waits on the cloud to save.
 */
@OptIn(FlowPreview::class)
class AutoSync(
    private val scope: CoroutineScope,
    private val repository: Repository,
    private val session: SessionManager,
    private val context: android.content.Context
) {
    private val _state = MutableStateFlow(SyncState())
    val state: StateFlow<SyncState> = _state

    private val manualTrigger = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    private val mutex = Mutex()

    /**
     * The first sync after launch pulls down everything this phone hasn't seen,
     * which on a fresh install is the whole job list. Announcing all of it would
     * bury the user in notifications about work they already know about, so the
     * opening pass stays silent and only genuinely new arrivals after it notify.
     */
    private var hasCompletedFirstSync = false

    fun start() {
        if (!SupabaseModule.isConfigured) return

        // Local data changed -> push it up once the dust settles.
        scope.launch {
            repository.observeJobs()
                .drop(1) // the first emission is just the initial load, not a change
                .debounce(DEBOUNCE_MS)
                .collect { runSync() }
        }

        // Explicit "sync now" taps.
        scope.launch {
            manualTrigger.collect { runSync() }
        }

        // Heartbeat, so another phone's edits eventually land here even if
        // nothing changes locally.
        scope.launch {
            while (true) {
                runSync()
                delay(HEARTBEAT_MS)
            }
        }
    }

    fun requestSync() {
        manualTrigger.tryEmit(Unit)
    }

    private suspend fun runSync() {
        val companyId = session.state.value.companyId
        if (companyId == null) {
            _state.value = _state.value.copy(phase = SyncPhase.OFFLINE_ONLY)
            return
        }
        // A second trigger while one is already running is dropped rather than
        // queued -- it would only repeat work that is already in flight.
        if (mutex.isLocked) return

        mutex.withLock {
            _state.value = _state.value.copy(phase = SyncPhase.SYNCING, lastError = null)
            val result = JobSync.sync(repository, companyId)
            _state.value = result.fold(
                onSuccess = { syncResult ->
                    notifyIncoming(syncResult)
                    SyncState(
                        phase = SyncPhase.OK,
                        lastSyncedAt = System.currentTimeMillis(),
                        lastError = null
                    )
                },
                onFailure = {
                    _state.value.copy(
                        phase = SyncPhase.FAILED,
                        lastError = it.message ?: "Couldn't reach the cloud"
                    )
                }
            )
        }
    }

    /**
     * Tells the user about work that arrived from someone else's phone.
     *
     * Only changes that came DOWN are announced -- notifying someone about an
     * edit they just made themselves would be pure noise. Capped so a first
     * sync pulling fifty jobs doesn't bury the notification shade.
     */
    private fun notifyIncoming(result: SyncResult) {
        if (!hasCompletedFirstSync) {
            hasCompletedFirstSync = true
            return
        }
        val worthTelling = result.incoming.filter { it.kind != ChangeKind.UPDATED }
        if (worthTelling.isEmpty()) return

        if (worthTelling.size > NOTIFY_LIMIT) {
            Notifications.show(
                context = context,
                id = SUMMARY_NOTIFICATION_ID,
                title = "FenceFlow updated",
                body = "${worthTelling.size} jobs came in from your team.",
                channelId = Notifications.CHANNEL_JOBS
            )
            return
        }

        worthTelling.forEach { change ->
            val customer = change.customerName.ifBlank { "a job" }
            val (title, body) = when (change.kind) {
                ChangeKind.NEW_JOB -> "New job on your list" to "$customer was added by your team."
                ChangeKind.MARKED_COMPLETE -> "Job marked complete" to "$customer was finished by the crew."
                ChangeKind.ASSIGNED_TO_ME -> "You've been assigned a job" to "You're on $customer."
                ChangeKind.UPDATED -> return@forEach
            }
            Notifications.show(
                context = context,
                id = change.jobId.toInt(),
                title = title,
                body = body,
                channelId = Notifications.CHANNEL_CREW
            )
        }
    }

    private companion object {
        const val DEBOUNCE_MS = 4_000L
        const val HEARTBEAT_MS = 15 * 60 * 1000L
        const val NOTIFY_LIMIT = 5
        const val SUMMARY_NOTIFICATION_ID = 9_000
    }
}
