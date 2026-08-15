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
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.map
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

    /** A trigger that arrived while a sync was already running, to be honoured after it. */
    private val pendingSync = java.util.concurrent.atomic.AtomicBoolean(false)

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

        // The moment this phone learns which company it belongs to, pull.
        //
        // Signing in used to fire a sync straight away, while the profile fetch
        // that supplies the company id was still in flight -- so the sync saw a
        // null company, returned immediately, and nothing arrived until the
        // heartbeat fifteen minutes later. Someone signing in on a second phone
        // saw an empty app and reasonably concluded nothing had been saved.
        //
        // Reacting to the id arriving, rather than firing at the moment we ask
        // for it, removes the race instead of narrowing it.
        scope.launch {
            session.state
                .map { it.companyId }
                .distinctUntilChanged()
                .filterNotNull()
                .collect { runSync() }
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
        // A trigger arriving mid-sync is remembered, not thrown away. It used to
        // be dropped on the grounds that the running pass was already doing the
        // work -- but that pass may have started before the change that
        // triggered this one, and at launch several triggers fire at once. The
        // dropped one then waited fifteen minutes for the heartbeat.
        if (mutex.isLocked) {
            pendingSync.set(true)
            return
        }

        mutex.withLock {
            _state.value = _state.value.copy(phase = SyncPhase.SYNCING, lastError = null)

            // Jobs first: fence runs and time entries reference their job by
            // syncId, so pulling children before their parent would orphan them.
            val result = JobSync.sync(repository, companyId)

            // Everything else. Failures here are swallowed on purpose -- a
            // problem syncing the crew list should not report the whole sync as
            // failed when the jobs went through fine.
            // Failures here used to be swallowed entirely, which is exactly how
            // "some things save and some don't" stays invisible. Report them.
            val pushResult = EntitySync.pushAll(repository, companyId)
            val pullResult = EntitySync.pullAll(repository, companyId)
            val entityError = pushResult.exceptionOrNull() ?: pullResult.exceptionOrNull()

            if (entityError != null) {
                _state.value = SyncState(
                    phase = SyncPhase.FAILED,
                    lastSyncedAt = _state.value.lastSyncedAt,
                    lastError = entityError.message ?: "Couldn't sync crew and settings"
                )
                return@withLock
            }

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

        // Honour anything that was triggered while we held the lock. Cleared
        // before re-running, so a burst of triggers costs one extra pass and
        // cannot loop.
        if (pendingSync.getAndSet(false)) runSync()
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
