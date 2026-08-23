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

enum class SyncPhase { IDLE, SYNCING, OK, FAILED, OFFLINE_ONLY, WAITING_FOR_SIGNAL }

data class SyncState(
    val phase: SyncPhase = SyncPhase.OFFLINE_ONLY,
    val lastSyncedAt: Long? = null,
    val lastError: String? = null,
    /** True when work is saved on this phone but not yet in the cloud. */
    val hasUnsyncedWork: Boolean = false,
    /** Signed in, but not part of a company -- so there is nowhere to sync to. */
    val signedInWithoutCompany: Boolean = false,
    /** False while the app is still working out who is signed in. */
    val sessionResolved: Boolean = false
) {
    /**
     * What to tell the user. "Saved on this phone" matters more than any
     * technical detail -- the fear when a sync fails is that the work is gone,
     * and it never is.
     */
    val message: String
        get() = when (phase) {
            SyncPhase.SYNCING -> "Syncing..."
            SyncPhase.OK -> "Everything is backed up"
            SyncPhase.WAITING_FOR_SIGNAL ->
                "No signal. Your work is saved on this phone and will upload by itself."
            SyncPhase.FAILED ->
                "Couldn't sync: ${lastError ?: "unknown"}. Your work is safe on this phone."
            // Two very different situations used to share one sentence. Telling
            // somebody who IS signed in to "sign in" reads as the app being
            // broken, and hides the actual step: they have no company yet, so
            // there is nowhere for the work to go.
            SyncPhase.OFFLINE_ONLY ->
                if (signedInWithoutCompany)
                    "Not backing up yet. Create your company or join one with an " +
                        "invite code, and everything saves to the cloud from then on."
                else "Working on this phone only. Sign in to back up."
            SyncPhase.IDLE -> "Ready"
        }
}

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

    /**
     * `replay = 1` on purpose, and it is load-bearing.
     *
     * A "payment received" push starts the process, so [FenceEstimatorApp.onCreate]
     * and the push handler run within milliseconds of each other. The handler
     * calls [requestSync] immediately, but [start]'s collector subscribes from a
     * coroutine that may not have run yet -- and a SharedFlow with no replay
     * discards emissions made while nobody is listening. The trigger vanished,
     * and the payment then waited for the fifteen-minute heartbeat: the user saw
     * the notification say money arrived while the job still read unpaid.
     *
     * With a replay slot the late collector still receives it.
     */
    private val manualTrigger = MutableSharedFlow<Unit>(replay = 1, extraBufferCapacity = 1)
    private val mutex = Mutex()

    /** Uploads signatures, surveys and photos. Set by the app on startup. */
    var fileUploader: JobFileUploader? = null

    /**
     * Whether the app is on screen. Set from the process lifecycle.
     *
     * Only paces the heartbeat. Everything else runs regardless, so a
     * backgrounded phone still receives pushes and change-feed updates.
     */
    @Volatile var inForeground: Boolean = true

    /** A trigger that arrived while a sync was already running, to be honoured after it. */
    private val pendingSync = java.util.concurrent.atomic.AtomicBoolean(false)

    /**
     * The first sync after launch pulls down everything this phone hasn't seen,
     * which on a fresh install is the whole job list. Announcing all of it would
     * bury the user in notifications about work they already know about, so the
     * opening pass stays silent and only genuinely new arrivals after it notify.
     */
    private var hasCompletedFirstSync = false

    /**
     * Jobs this phone has already told the user about.
     *
     * Unbounded on purpose -- it holds longs for one session, and the failure
     * it prevents (the same job announced on every sync pass) is worse than the
     * memory. Cleared with the process, which is also when "new to you" stops
     * meaning anything.
     */
    private val alreadyAnnounced = java.util.Collections.synchronizedSet(mutableSetOf<Long>())

    fun start() {
        if (!SupabaseModule.isConfigured) return

        // Local data changed -> push it up once the dust settles. Any synced
        // table, not just jobs: see Repository.observeAnyChange.
        scope.launch {
            repository.observeAnyChange()
                .debounce(DEBOUNCE_MS)
                .collect { runSync() }
        }

        // Explicit "sync now" taps.
        scope.launch {
            manualTrigger.collect { runSync() }
        }

        // The moment the login token is (re)established, push what waited.
        scope.launch {
            SupabaseModule.sessionStatus.collect { status ->
                if (status is io.github.jan.supabase.auth.status.SessionStatus.Authenticated) requestSync()
            }
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

        // Heartbeat, so another phone's edits land here even when nothing
        // changes locally.
        //
        // Paced by whether anyone is actually looking. Fifteen minutes is fine
        // for a phone in a pocket and far too long for one open on the reports
        // screen -- that is how a device sat showing a stale figure while the
        // cloud held the right one, with nothing on screen admitting it. The
        // change feed normally gets there first; this is the backstop for when
        // the socket is down, which on a phone is often.
        scope.launch {
            while (true) {
                runSync()
                delay(if (inForeground) FOREGROUND_HEARTBEAT_MS else HEARTBEAT_MS)
            }
        }
    }

    fun requestSync() {
        manualTrigger.tryEmit(Unit)
    }

    /**
     * Whether a failure is just "no signal" rather than something wrong.
     *
     * Matched on the exception text because the failure surfaces from several
     * layers -- Ktor, OkHttp, the JDK -- with no common type between them. The
     * cost of guessing wrong is only which message the user reads, and the
     * behaviour is identical either way: keep the work, retry later.
     */
    private fun looksLikeNoSignal(error: Throwable): Boolean {
        val text = generateSequence(error) { it.cause }
            .mapNotNull { "${it::class.simpleName} ${it.message}" }
            .joinToString(" ")
            .lowercase()
        return listOf(
            "unable to resolve host", "failed to connect", "timeout", "timed out",
            "no address associated", "network is unreachable", "unknownhost",
            "connectexception", "sockettimeout", "connect timeout", "software caused connection abort"
        ).any { it in text }
    }

    private suspend fun runSync() {
        val companyId = session.state.value.companyId
        if (companyId == null) {
            _state.value = _state.value.copy(
                phase = SyncPhase.OFFLINE_ONLY,
                signedInWithoutCompany = session.state.value.signedIn,
                // Startup has no company id yet simply because the answer has
                // not arrived. Reporting "not backing up" during that moment
                // put an alarming banner on screen at every launch, saying
                // something that was not true a second later.
                sessionResolved = session.state.value.resolved
            )
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

        // No token, no sync. The session state says who this phone belongs to
        // from memory; the token is what the server checks. Without one the
        // whole pass runs anonymous -- pushes refused, pulls empty -- and the
        // empty pulls are the dangerous half: they make every local row look
        // new. So ask for a fresh token and try again on the next trigger.
        if (!SupabaseModule.hasLiveSession()) {
            SupabaseModule.tryRefreshSession()
            if (!SupabaseModule.hasLiveSession()) {
                _state.value = _state.value.copy(
                    phase = SyncPhase.WAITING_FOR_SIGNAL,
                    lastError = "Waiting to sign back in",
                    hasUnsyncedWork = true
                )
                session.refresh()
                return
            }
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
            // Before the push, always. Reaping after it would upload rows that
            // another device deleted, which is the resurrection this exists to
            // stop.
            // Re-read who this person is and what they are allowed to do, on
            // every pass. The change feed is the fast path, but a websocket on a
            // phone drops constantly -- a tunnel, a dead spot, doze -- and
            // access is the one thing that must not quietly go stale while the
            // socket is down.
            session.refresh()

            val reaped = DeletionReaper.reap(repository, companyId)

            // After jobs, because a payment attaches to its job by syncId and
            // cannot land on a phone that has not pulled the job yet.
            val ledgerResult = PaymentLedgerSync.sync(repository, companyId)

            val pushResult = EntitySync.pushAll(repository, companyId)
            val pullResult = EntitySync.pullAll(repository, companyId)

            // Files last, and never allowed to fail the sync. A signature that
            // hasn't uploaded yet is a retry; a job list that didn't sync is a
            // problem, and conflating the two would hide the one that matters.
            runCatching {
                fileUploader?.let { uploader ->
                    uploader.uploadPending(companyId)
                    uploader.downloadMissing()
                }
            }
            val entityError = reaped.exceptionOrNull()
                ?: ledgerResult.exceptionOrNull()
                ?: pushResult.exceptionOrNull()
                ?: pullResult.exceptionOrNull()

            if (entityError != null) {
                // A network failure is not the same as a real error. The crew
                // being out of signal is normal and self-correcting; saying
                // "sync failed" for it teaches people to ignore the message.
                //
                // Real failures are also worth hearing about at this end. A
                // sync that keeps failing for one company is invisible
                // otherwise -- their work simply stops arriving, and the first
                // anyone knows is a phone call about missing jobs.
                if (!looksLikeNoSignal(entityError)) {
                    CrashReporter.report(context, "sync", entityError)
                }
                _state.value = SyncState(
                    phase = if (looksLikeNoSignal(entityError)) SyncPhase.WAITING_FOR_SIGNAL
                    else SyncPhase.FAILED,
                    lastSyncedAt = _state.value.lastSyncedAt,
                    lastError = entityError.message ?: "Couldn't sync crew and settings",
                    hasUnsyncedWork = true
                )
                return@withLock
            }

            _state.value = result.fold(
                onSuccess = { syncResult ->
                    notifyIncoming(syncResult)
                    SyncState(
                        phase = SyncPhase.OK,
                        lastSyncedAt = System.currentTimeMillis(),
                        lastError = null,
                        hasUnsyncedWork = false
                    )
                },
                onFailure = {
                    _state.value.copy(
                        phase = if (looksLikeNoSignal(it)) SyncPhase.WAITING_FOR_SIGNAL
                        else SyncPhase.FAILED,
                        lastError = it.message ?: "Couldn't reach the cloud",
                        hasUnsyncedWork = true
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
        val worthTelling = result.incoming
            // UPDATED is ordinary editing and PAYMENT_RECEIVED already has its
            // own push from the backend naming the amount -- announcing it
            // again here was the second of two notifications for one event.
            .filter { it.kind != ChangeKind.UPDATED && it.kind != ChangeKind.PAYMENT_RECEIVED }
            // One per job. A job that appears in several changes in the same
            // pass is still one thing that happened.
            .distinctBy { it.jobId }
            // And one per job EVER. Several triggers fire together at launch,
            // and each pass that pulled the same job announced it again -- the
            // notifications arrived back to back and looked like the app was
            // malfunctioning rather than reporting anything.
            .filter { alreadyAnnounced.add(it.jobId) }

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
                // Both are filtered out above; listed rather than folded into an
                // else so that adding a new kind is a compile error here and
                // has to be decided on, instead of silently never notifying.
                ChangeKind.UPDATED, ChangeKind.PAYMENT_RECEIVED -> return@forEach
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
        const val DEBOUNCE_MS = 1_500L
        const val HEARTBEAT_MS = 15 * 60 * 1000L

        /** While someone is looking at the app, a figure should never be more than a minute old. */
        const val FOREGROUND_HEARTBEAT_MS = 60 * 1000L
        const val NOTIFY_LIMIT = 5
        const val SUMMARY_NOTIFICATION_ID = 9_000
    }
}
