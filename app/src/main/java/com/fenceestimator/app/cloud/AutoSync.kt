package com.fenceestimator.app.cloud

import com.fenceestimator.app.R
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

    // Remote nudges, kept apart from the ones the person in front of the phone
    // asked for. A tap on Sync should still be instant; somebody else's typing
    // should not be.
    private val remoteTrigger = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
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

        @OptIn(kotlinx.coroutines.FlowPreview::class)
        scope.launch {
            remoteTrigger
                .debounce(REMOTE_QUIET_MS)
                .collect { runSync() }
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

    /** When our own last push finished, so the change feed's echo of it can be ignored. */
    @Volatile private var lastPushCompletedAt = 0L

    /**
     * A sync asked for by the change feed. Our own pushes come straight back
     * down the feed as events; with every synced table on the channel that
     * was a full extra pass after each edit. Events inside a short window
     * after our own push are ours, and are ignored.
     */
    /**
     * Another phone changed something. Come and look -- in a moment, once.
     *
     * Every row change on any of thirteen watched tables used to ask for a
     * sync immediately. So one person working on a crew phone set the owner's
     * phone syncing over and over: thirteen tables, many rows, a request each.
     * The two handsets were wired together far more tightly than anybody
     * wanted, and the owner saw constant churn for work that was not theirs.
     *
     * The information still arrives -- that part is the point of watching at
     * all. It just arrives as one calm sync after the other phone goes quiet,
     * instead of a ripple per row.
     */
    fun requestSyncFromRemote() {
        if (System.currentTimeMillis() - lastPushCompletedAt < REMOTE_ECHO_WINDOW_MS) return
        remoteTrigger.tryEmit(Unit)
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
    /**
     * What went wrong, said to the person holding the phone.
     *
     * Postgres and Ktor both write for developers. Anything not recognised
     * falls back to a sentence that is true of every remaining case: the work
     * is on the phone and it will go up.
     */
    private fun plainWords(error: Throwable): String {
        val text = generateSequence(error) { it.cause }
            .mapNotNull { it.message }
            .joinToString(" ")
            .lowercase()
        // Matched on the ERROR, never on the request.
        //
        // The message from these libraries carries the URL, and every upsert
        // this app sends has on_conflict= in its query string. So a bare
        // "conflict" test matched every failure there is, and a crew member
        // whose sync was refused read "Someone changed the same thing on
        // another phone" -- confidently wrong, about a thing that had not
        // happened. Only phrases that appear in the server's own explanation
        // are tested, and the URL is cut off the front before testing.
        val body = text.substringAfterLast("supabase.co")
        return when {
            looksLikeNoSignal(error) ->
                context.getString(R.string.sync_plain_no_signal)
            "jwt" in body || "not authenticated" in body || "invalid claim" in body ->
                context.getString(R.string.sync_plain_signed_out)
            "duplicate key" in body || "already exists" in body ->
                context.getString(R.string.sync_plain_conflict)
            "timeout" in body || "timed out" in body ->
                context.getString(R.string.sync_plain_slow)
            else -> context.getString(R.string.sync_plain_unknown)
        }
    }

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

        // A company that has been switched off does not keep the cloud half of
        // the product. Sync runs on the application scope, outside the screen
        // that shows the blocked notice, so without this it went right on
        // syncing jobs, payments and photos for a lapsed subscription -- and
        // RLS could not catch that, because RLS only refuses a *suspended*
        // company, not one whose plan simply ran out.
        //
        // Only a definite "no" stops it: a phone that was never told stays
        // working, the same rule the gate screen follows.
        if (ServiceGate.remembered(context)?.allowed == false) {
            _state.value = _state.value.copy(
                phase = SyncPhase.IDLE,
                lastError = context.getString(R.string.sync_account_not_active)
            )
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
                    lastError = context.getString(R.string.vm_waiting_sign_back_in),
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

            // The ledger has just been reconciled both ways and every job's
            // cached total rebuilt from it, so this is the one moment the local
            // figure is authoritative -- including when it went DOWN, which the
            // ordinary job push refuses to send. Without this, deleting a
            // duplicate payment was undone by the next pull, every time.
            runCatching { JobSync.pushLedgerTotals(repository, companyId) }

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
            // A permission refusal is not a failure of the sync.
            //
            // The server refusing a table is it telling this phone that the
            // table is none of its business -- money on a crew handset, for
            // instance. Reporting that as "could not sync" was wrong twice
            // over: it said something was broken when nothing was, and it
            // buried a real failure among noise the person could do nothing
            // about.
            val entityError = listOfNotNull(
                reaped.exceptionOrNull(),
                ledgerResult.exceptionOrNull(),
                pushResult.exceptionOrNull(),
                pullResult.exceptionOrNull(),
            ).firstOrNull { !isNotOursToSync(it) }

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
                    // Never the database's own words.
                    //
                    // A crew member read "Could not sync: new row violates
                    // row-level security policy for table payment_records" on
                    // their phone. That sentence is for whoever wrote the
                    // policy. What the person holding the phone needs to know
                    // is whether their work is safe and whether they must do
                    // something.
                    lastError = plainWords(entityError),
                    hasUnsyncedWork = true
                )
                return@withLock
            }

            lastPushCompletedAt = System.currentTimeMillis()
            _state.value = result.fold(
                onSuccess = { syncResult ->
                    notifyIncoming(syncResult)
                    // Something the server would not take is still something
                    // waiting. pushAll signals that with a negative count.
                    // Saying "everything is backed up" when a table was
                    // refused is how a crew member's plan-change requests
                    // disappeared with nothing on screen to notice.
                    val somethingHeldBack = (pushResult.getOrNull() ?: 0) < 0
                    SyncState(
                        phase = SyncPhase.OK,
                        lastSyncedAt = System.currentTimeMillis(),
                        lastError = null,
                        hasUnsyncedWork = somethingHeldBack
                    )
                },
                onFailure = {
                    _state.value.copy(
                        phase = if (looksLikeNoSignal(it)) SyncPhase.WAITING_FOR_SIGNAL
                        else SyncPhase.FAILED,
                        lastError = it.message ?: context.getString(R.string.sync_failed),
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
                title = context.getString(R.string.ntf_fenceflow_updated),
                body = context.getString(R.string.ntf_jobs_came_in, worthTelling.size),
                channelId = Notifications.CHANNEL_JOBS
            )
            return
        }

        worthTelling.forEach { change ->
            val customer = change.customerName.ifBlank { context.getString(R.string.ntf_a_job) }
            val (title, body) = when (change.kind) {
                ChangeKind.NEW_JOB ->
                    context.getString(R.string.ntf_new_job_title) to
                        context.getString(R.string.ntf_new_job_body, customer)
                ChangeKind.MARKED_COMPLETE ->
                    context.getString(R.string.ntf_job_complete_title) to
                        context.getString(R.string.ntf_job_complete_body, customer)
                ChangeKind.ASSIGNED_TO_ME ->
                    context.getString(R.string.ntf_assigned_title) to
                        context.getString(R.string.ntf_assigned_body, customer)
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
        const val REMOTE_ECHO_WINDOW_MS = 4_000L

        /**
         * How long another phone has to stop working before we go and look.
         *
         * Long enough that a person filling in a job on the other handset
         * produces one sync rather than dozens; short enough that the office
         * still sees field work within half a minute.
         */
        const val REMOTE_QUIET_MS = 20_000L
        const val HEARTBEAT_MS = 15 * 60 * 1000L

        /** While someone is looking at the app, a figure should never be more than a minute old. */
        const val FOREGROUND_HEARTBEAT_MS = 60 * 1000L
        const val NOTIFY_LIMIT = 5
        const val SUMMARY_NOTIFICATION_ID = 9_000
    }
}
