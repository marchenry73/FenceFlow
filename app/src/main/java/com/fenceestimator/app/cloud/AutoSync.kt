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

enum class SyncPhase {
    IDLE, SYNCING, OK, FAILED, OFFLINE_ONLY,
    /** Cannot reach the server. Waiting will fix it. */
    WAITING_FOR_SIGNAL,
    /** The sign-in has expired. Waiting will NOT fix it; only signing in will. */
    SIGNED_OUT,
}

/**
 * Which of the several different "not everything is up there yet" situations a
 * phone is in.
 *
 * All of them used to share one sentence, and that sentence talked about a
 * queue. So a phone that had nothing typed on it -- one that had merely failed
 * to ask the server what its account is allowed to see -- told its owner that
 * work of his was stuck waiting to upload. He read that as the sync being
 * broken on every new phone he signed into, and none of the three conditions
 * actually means that.
 *
 * Splitting them does not soften any of it. Not one of the sentences below says
 * the work is up.
 */
enum class UnsyncedReason {
    /**
     * Job edits made on this phone that the cloud has not taken -- a job the
     * crew door refused, or one being kept on this phone with an edit still on
     * it. The person's own typing, genuinely not up yet.
     */
    JOBS_HELD_BACK,

    /**
     * Rows in the tables other than jobs that this pass could not send. Also
     * the person's own work, and also genuinely not up yet -- said separately
     * because it is not a job, and pointing somebody at their job list for it
     * sends them looking in the wrong place.
     */
    RECORDS_HELD_BACK,

    /**
     * This phone could not get an answer about what the account is allowed to
     * see, so the half of the pass that moves jobs and prices did not run at
     * all -- not because there was nothing to move, but because the app
     * declined to guess. Whether anything of the person's is actually waiting
     * is exactly what this pass could not find out, so the wording must not
     * claim either way. This is the one that must not sound like a queue,
     * because there is no queue answer in it either way.
     */
    ACCESS_NOT_CONFIRMED,

    /**
     * [RECORDS_HELD_BACK] and [ACCESS_NOT_CONFIRMED] at the same time: a
     * table push this pass genuinely refused something, AND the money scope
     * came back unknown, so the jobs half of the same pass never ran at all
     * (see [ACCESS_NOT_CONFIRMED]). Naming only the refusal would let the
     * reader assume jobs were checked and are fine -- exactly the assumption
     * this pass never got to make. Naming only the unanswered scope would go
     * quiet about a real, actionable refusal that has nothing to do with
     * money. Neither sentence alone is honest about a pass where both are
     * true, so this gets its own value rather than folding into either one;
     * the card composes it from the two existing sentences instead of a new
     * one, so nothing here needs its own translation.
     */
    RECORDS_HELD_BACK_AND_ACCESS_NOT_CONFIRMED,
}

data class SyncState(
    val phase: SyncPhase = SyncPhase.OFFLINE_ONLY,
    val lastSyncedAt: Long? = null,
    val lastError: String? = null,
    /** True when work is saved on this phone but not yet in the cloud. */
    val hasUnsyncedWork: Boolean = false,
    /**
     * Why [hasUnsyncedWork] is set, so the sentence can say the true thing
     * rather than the one thing that was true of all of them at once.
     *
     * Null means whoever built this state did not say which, and the wording
     * falls back to the old catch-all -- which is vague but never claims the
     * work is up, so a caller that forgets this cannot turn the card into good
     * news.
     *
     * Read only when [phase] is [SyncPhase.OK] -- by AccountScreen and
     * JobsListScreen, which map it straight to a localized string; see the
     * note on [message] below for why that mapping does not live here.
     * Every other phase reaches the screen through copy() of an earlier
     * state and can therefore be carrying an older pass's answer, which
     * would be a stale reason wearing a current banner -- so no other phase
     * reads this. The only place OK is set builds a whole new state and
     * sets this from that pass.
     */
    val unsyncedReason: UnsyncedReason? = null,
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
            // hasUnsyncedWork can be true even on a clean pass -- a table the
            // server refused, or a money scope this phone could not ask
            // about this time. Saying "everything is backed up" over that is
            // exactly the empty-answer-reads-as-good-news shape of bug this
            // flag exists to prevent noticing.
            //
            // The specific reason is deliberately NOT spelled out here any
            // more. This getter has no Context and cannot resolve a string
            // resource (see the class doc), so a literal English sentence per
            // [unsyncedReason] here is a translation bug waiting to happen --
            // it is exactly how a Spanish or French owner ended up reading
            // English on this card. AccountScreen and JobsListScreen map
            // [unsyncedReason] to a localized string directly instead, so
            // this branch only needs to stay true, not specific: it must
            // never say the work reached the cloud.
            SyncPhase.OK ->
                if (!hasUnsyncedWork) "Everything is backed up"
                else "Some of this phone's work has not reached the cloud yet. It will go up on the next sync."
            SyncPhase.WAITING_FOR_SIGNAL ->
                "No signal. Your work is saved on this phone and will upload by itself."
            // Never "it uploads on its own" here. It does not, and cannot: the
            // token is dead and only signing in makes another one. Saying
            // otherwise is how a phone sat for eleven hours uploading nothing
            // while the banner said everything was in hand.
            SyncPhase.SIGNED_OUT ->
                "Signed out. Your work is safe on this phone, but nothing will " +
                    "upload until you sign in again."
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
     * Whether the pass that has just finished could get an answer about what
     * this account is allowed to see. Set inside the lock, read after it, which
     * is the only place a retry can be started from.
     */
    @Volatile private var couldNotAskMoneyScope = false

    /**
     * How many times in a row a pass has already asked again on its own, kept
     * separately for the two reasons it does so. Each is reset by the first pass
     * that gets past the thing it was waiting on.
     */
    private val tokenRetries = java.util.concurrent.atomic.AtomicInteger(0)
    private val scopeRetries = java.util.concurrent.atomic.AtomicInteger(0)

    /** One waiting retry at a time, across both reasons. */
    private val retryWaiting = java.util.concurrent.atomic.AtomicBoolean(false)

    /**
     * Come back and try this pass again in a few seconds.
     *
     * For the two cases where the pass did not fail and did not succeed either:
     * it asked a question and got no answer, and the next trigger that would
     * have asked again is a minute away with the app on screen and fifteen with
     * it in a pocket. A person who has just signed in on a second phone is
     * looking at the job list during that gap, which is the whole of what
     * "it does not synchronize immediately" describes.
     *
     * Bounded, and it goes quiet rather than getting louder. A company whose
     * database has never had can_see_pay, or a phone parked in a dead spot,
     * would otherwise keep this going for as long as the app is open. After the
     * last attempt the heartbeat is the retry again, exactly as before.
     */
    private fun askAgainShortly(attemptsUsed: java.util.concurrent.atomic.AtomicInteger) {
        if (attemptsUsed.get() >= RETRY_ATTEMPTS) return
        // Several triggers can finish a pass within a second or two of each
        // other -- a sign-in, the company id arriving and the heartbeat all
        // land together at launch -- and without this each of them would start
        // a timer of its own.
        if (!retryWaiting.compareAndSet(false, true)) return
        val attempt = attemptsUsed.incrementAndGet()
        this@AutoSync.scope.launch {
            // Lengthening, because the usual reason a question goes unanswered
            // here is a connection that is still coming up rather than one that
            // is down, and three questions in the same second are three
            // refusals.
            delay(RETRY_DELAY_MS * attempt)
            retryWaiting.set(false)
            runSync()
        }
    }

    /**
     * The first sync after launch pulls down everything this phone hasn't seen,
     * which on a fresh install is the whole job list. Announcing all of it would
     * bury the user in notifications about work they already know about, so the
     * opening pass stays silent and only genuinely new arrivals after it notify.
     */
    private var hasCompletedFirstSync = false

    /**
     * What this phone has already told the user about: job and kind, as
     * "jobId:KIND" (see [changesToAnnounce]).
     *
     * Unbounded on purpose -- it holds short keys for one session, and the
     * failure it prevents (the same job announced on every sync pass) is worse
     * than the memory. Cleared with the process, which is also when "new to
     * you" stops meaning anything.
     */
    private val alreadyAnnounced = java.util.Collections.synchronizedSet(mutableSetOf<String>())

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

        // The moment the sign-in is LOST, not at the next heartbeat. Until this,
        // a phone that lost its sign-in learned it from the next sync pass --
        // up to a minute later with the app open, fifteen in a pocket -- and
        // nothing said so to somebody who was not looking.
        scope.launch {
            session.state
                .map { it.login to lostSignIn(it.login, it.hadAccount, it.guestDemo) }
                .distinctUntilChanged()
                .collect { (health, lost) -> onLoginChanged(health, lost) }
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
    /**
     * A change someone is actively waiting on -- a shift approval, an answer
     * to a field request. These go through the short debounce rather than the
     * remote quiet period: the twenty-second wait exists to keep two phones
     * from ping-ponging over bulk edits, and a decision is not bulk. The crew
     * member is standing there watching the screen to see if their hours went
     * through.
     */
    fun requestUrgentSyncFromRemote() {
        if (System.currentTimeMillis() - lastPushCompletedAt < REMOTE_ECHO_WINDOW_MS) return
        manualTrigger.tryEmit(Unit)
    }

    fun requestSyncFromRemote() {
        if (System.currentTimeMillis() - lastPushCompletedAt < REMOTE_ECHO_WINDOW_MS) return
        remoteTrigger.tryEmit(Unit)
    }

    fun requestSync() {
        manualTrigger.tryEmit(Unit)
    }

    /** True once a "you are signed out" notification is up for the current loss. */
    @Volatile private var signedOutNotified = false

    /**
     * The sign-in was lost, or came back.
     *
     * On a loss: repaint the sync card at once (with no company id a pass
     * returns straight away, so this is cheap), and -- only when the app is not
     * on screen -- put one notification up. On screen, the jobs list already
     * says it and a notification over the top of it would be noise; in a pocket
     * it is the only thing that can reach somebody before they leave. Once per
     * loss, and taken down when the sign-in comes back.
     */
    private suspend fun onLoginChanged(health: LoginHealth, lost: Boolean) {
        if (lost) {
            runSync()
            if (!inForeground && !signedOutNotified) {
                signedOutNotified = true
                Notifications.show(
                    context = context,
                    id = SIGNED_OUT_NOTIFICATION_ID,
                    title = context.getString(R.string.so_ntf_title),
                    body = context.getString(R.string.so_ntf_body),
                    channelId = Notifications.CHANNEL_CREW
                )
            }
            return
        }
        if (health == LoginHealth.WORKING && signedOutNotified) {
            signedOutNotified = false
            runCatching {
                androidx.core.app.NotificationManagerCompat.from(context).cancel(SIGNED_OUT_NOTIFICATION_ID)
            }
        }
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
        // A permanent rejection (see isPermanentRejection) is the server
        // refusing the ROW, not a generic failure -- and its own sentence is
        // exactly what tells the person holding the phone what to fix. An
        // hour was lost diagnosing "Could not reach the cloud" on a phone
        // that was refusing to link two shifts to a crew member; that
        // sentence never reached anyone because this fell through to
        // sync_plain_unknown instead of showing what the server actually
        // said.
        val permanentDetail = permanentRejectionDetail(error)
        return when {
            permanentDetail != null ->
                context.getString(R.string.sync_plain_rejected, permanentDetail)
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

    // One classifier for the whole app (see SyncFailure). This used to be its
    // own phrase list, which had nothing to match in the commonest dead spot
    // of all -- an empty "failed with message: " -- so every pass a crew
    // phone ran with no signal was filed as a crash.
    private fun looksLikeNoSignal(error: Throwable): Boolean = SyncFailure.isTransientNetwork(error)

    private suspend fun runSync() {
        val companyId = session.state.value.companyId
        if (companyId == null) {
            val s = session.state.value
            // A phone that HAD an account and no longer holds a sign-in is not
            // "working on this phone only", which is what a phone that never
            // had one is. Losing the sign-in clears the company id, so the pass
            // that noticed it said SIGNED_OUT, and the very next pass came here
            // and replaced it with the quiet local-only wording within a minute
            // -- the one state that must not fade. SessionManager says which of
            // the two this is (see lostSignIn).
            val lost = lostSignIn(s.login, s.hadAccount, s.guestDemo)
            _state.value = _state.value.copy(
                phase = if (lost) SyncPhase.SIGNED_OUT else SyncPhase.OFFLINE_ONLY,
                lastError = if (lost) context.getString(R.string.vm_signed_out_sign_in_again)
                            else _state.value.lastError,
                signedInWithoutCompany = s.signedIn,
                // Startup has no company id yet simply because the answer has
                // not arrived. Reporting "not backing up" during that moment
                // put an alarming banner on screen at every launch, saying
                // something that was not true a second later.
                sessionResolved = s.resolved
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

        // Nor does a phone another handset has taken the login from. The
        // signed-in-elsewhere screen became a UI state of its own (it had
        // been disguised as allowed = false, which this check caught), so a
        // phone showing "Signed in on another phone" went on pushing in the
        // background -- a stale handset, possibly on a build a year old,
        // writing over the phone that holds the login now. ServiceGate
        // persists the answer (stillMine), and reclaim ("Use this phone")
        // clears it, so sync picks up again the moment the login comes back.
        if (ServiceGate.wasDisplaced(context)) {
            _state.value = _state.value.copy(
                phase = SyncPhase.IDLE,
                lastError = context.getString(R.string.svc_elsewhere_body)
            )
            return
        }

        // No token, no sync. The session state says who this phone belongs to
        // from memory; the token is what the server checks. Without one the
        // whole pass runs anonymous -- pushes refused, pulls empty -- and the
        // empty pulls are the dangerous half: they make every local row look
        // new. So ask for a fresh token and try again on the next trigger.
        if (!SupabaseModule.hasLiveSession()) {
            val outcome = SupabaseModule.tryRefreshSession()
            if (!SupabaseModule.hasLiveSession()) {
                // Two different situations that used to share one banner. A dead
                // spot clears itself; an expired sign-in never does, and the
                // person has to be told which one they are looking at.
                // The plugin's own status wins over the outcome. tryRefreshSession
                // files every refresh failure that was not the network under
                // SIGNED_OUT, including the auth SERVER answering 5xx -- and "sign
                // in again, this will not fix itself" is false for an outage, which
                // does. The plugin keeps that session and retries it by itself.
                val signedOut = outcome == SupabaseModule.RefreshOutcome.SIGNED_OUT &&
                    currentAuthStatusKind() != AuthStatusKind.REFRESH_SERVER_ERROR
                _state.value = _state.value.copy(
                    phase = if (signedOut) SyncPhase.SIGNED_OUT else SyncPhase.WAITING_FOR_SIGNAL,
                    lastError = context.getString(
                        if (signedOut) R.string.vm_signed_out_sign_in_again
                        else R.string.vm_waiting_sign_back_in
                    ),
                    hasUnsyncedWork = true
                )
                session.refresh()
                // "Not yet knowable" is not "no". RefreshOutcome.UNKNOWN means
                // the stored session is still loading, or the last ask was
                // inside the cooldown -- the window where this phone knows who
                // it belongs to but does not hold a token yet. Reading the
                // cloud in that window is the dangerous case the comment above
                // describes: an unauthenticated read comes back as an empty
                // list rather than an error, so the pass would report a result
                // it never really got. Waiting and asking again is the whole
                // fix; nothing here reads anything until there is a token.
                //
                // Deliberately not for NO_NETWORK. A dead spot is honestly
                // reported by the banner this branch has just set, and it
                // already has two retries that suit it better -- the
                // connectivity watcher when signal returns, and the heartbeat.
                if (outcome == SupabaseModule.RefreshOutcome.UNKNOWN) {
                    askAgainShortly(tokenRetries)
                }
                return
            }
        }
        // Past the token guard, so whatever was being waited on has arrived.
        tokenRetries.set(0)

        mutex.withLock {
            _state.value = _state.value.copy(phase = SyncPhase.SYNCING, lastError = null)

            // Asked once, first, inside the lock -- every step below is
            // handed this same answer rather than asking can_see_pay() again
            // on its own, which is what let one table's transient failure
            // read as "not allowed" while another read the real rows in the
            // same pass.
            val scope = askMoneyScope()
            // Remembered for after the lock, which is where a retry can start.
            //
            // An unanswered question here is not a small thing. The job sync
            // does no job work at all on a pass whose money scope is unknown --
            // it returns before its first read -- and the catalog and the line
            // items are skipped with it. So the pass that cannot ask is the
            // pass that moves no jobs, while still reporting itself as having
            // run. The commonest moment to be unable to ask is the first sync
            // after signing in on a new phone: exactly when somebody is looking
            // at an empty job list, deciding whether this app works.
            couldNotAskMoneyScope = scope == MoneyScope.UNKNOWN
            // Employee pay is a separate door from job money -- a salesperson
            // can be ALLOWED here and DENIED there. Asked once, here, beside
            // the money scope, and handed down to pullAll rather than asked
            // again inside pullEmployees: the same reasoning as the comment
            // above, for the employees table instead of the jobs one.
            val employeePayScope = askEmployeePayScope()
            // Which jobs this person may see (supabase_crew_job_scope.sql),
            // asked once here for the same reason and handed to JobSync,
            // which hides the jobs a crew member was taken off and brings
            // back the ones they were let into. Also refreshes
            // JobAccess.scope, which the job list reads for "your login is
            // not linked" and the request screens. A database without the
            // change answers NotDeployed and everything behaves as before; a
            // failed question answers Unknown and nothing is hidden or shown
            // on it.
            val jobScope = JobAccess.askJobScope()
            val uid = SupabaseModule.currentUserId()
            val lastScope = uid?.let { id -> runCatching { MoneyScopeMemory.last(context, id) }.getOrNull() }

            // A promotion -- DENIED last time, ALLOWED now -- has to pull the
            // real prices and rates down before anything pushes, or this
            // phone's zero-priced local copies (cached from the money-free
            // door) go straight through the now-open owner door ahead of the
            // pull that would have restored them. keepMoney protects the job
            // row itself; this protects everything hanging off it.
            val promoted = lastScope == MoneyScope.DENIED && scope == MoneyScope.ALLOWED

            // A demotion, or the first DENIED answer this account has ever
            // had on this device (a fresh install, or one handed to somebody
            // new), scrubs local money before anything else runs. Once
            // recorded below, a DENIED phone that stays DENIED never scrubs
            // again on its own -- see MoneyScopeMemory.
            if (scope == MoneyScope.DENIED && lastScope != MoneyScope.DENIED) {
                runCatching { repository.forgetMoney(uid) }
            }
            if (uid != null) runCatching { MoneyScopeMemory.remember(context, uid, scope) }

            // A phone that may not push line items owes the cloud none of
            // them: its copies came through the money-free door, priced at
            // zero. Unmarked on every such pass, and before the pull on the
            // pass that promotes it -- the pull never writes over a line still
            // marked to go up, so a marked zero-priced copy would survive the
            // promotion and be pushed over the office's prices on the pass
            // after. The upgrade that added the mark set it on every line,
            // crew phones included (SchemaV44).
            if (scope == MoneyScope.DENIED || promoted) {
                runCatching { repository.clearLineItemPushFlags() }
            }

            // Change orders, on the promotion pass ONLY -- not on every DENIED
            // pass, because a crew phone's orders are real work and do go up,
            // through crew_push_change_orders.
            //
            // What a crew phone holds is money-scrubbed: change_orders_crew
            // carries neither cost column, so every order it pulled reads $0.
            // Still marked at the moment the owner door opens, those zeros
            // would go through it and write $0 over the office's prices --
            // the same trap as line items, on the table that decides what a
            // customer is billed for extra work. Unmarked here, the pull that
            // follows restores the real figures first.
            //
            // The cost: an order created on THIS phone that the crew door never
            // took (offline, or refused because the office already holds a newer
            // copy) loses its place in the queue. It is still on the phone, and
            // the next edit to it queues it again -- where pushing $0 over a
            // signed price is silent and unrecoverable.
            if (promoted) {
                runCatching { repository.clearAllChangeOrderPendingPush() }
            }

            // Jobs first: fence runs and time entries reference their job by
            // syncId, so pulling children before their parent would orphan them.
            val sessionNow = session.state.value
            val result = JobSync.sync(
                repository, companyId, scope,
                // Worded in the phone's language: a crew edit the server will
                // not take becomes a request to the office (see
                // JobSync.unsentCrewEdits), and the office reads it as written.
                unsentNote = UnsentCrewEditNote(
                    summary = { labels -> context.getString(R.string.sync_crew_unsent_summary, labels.joinToString(", ")) },
                    label = { column -> crewColumnLabel(column) },
                    by = sessionNow.email ?: "",
                    role = sessionNow.role.label
                ),
                // A promotion needs nothing extra here: an ALLOWED phone
                // reads the real jobs table and JobSync brings every held job
                // back on that answer alone (planJobHolds).
                jobScope = jobScope
            )

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

            val reaped = DeletionReaper.reap(repository, companyId, scope)

            // After jobs, because a payment attaches to its job by syncId and
            // cannot land on a phone that has not pulled the job yet.
            val ledgerResult = PaymentLedgerSync.sync(repository, companyId, scope)

            // The ledger has just been reconciled both ways and every job's
            // cached total rebuilt from it, so this is the one moment the local
            // figure is authoritative -- including when it went DOWN, which the
            // ordinary job push refuses to send. Without this, deleting a
            // duplicate payment was undone by the next pull, every time.
            //
            // Skipped outright on the promotion pass -- see pushAll below.
            if (!promoted) {
                runCatching { JobSync.pushLedgerTotals(repository, companyId, scope) }
            }

            // Pull before push, and the money-sensitive pushes skipped
            // outright, ONLY on the one pass where the door just opened. Every
            // other pass keeps today's push-then-pull order.
            val pushResult: Result<Int>
            val pullResult: Result<Int>
            if (promoted) {
                pullResult = EntitySync.pullAll(repository, companyId, scope, employeePayScope)
                pushResult = EntitySync.pushAll(
                    repository, companyId, scope, employeePayScope, skipMoneySensitivePushes = true
                )
            } else {
                pushResult = EntitySync.pushAll(repository, companyId, scope, employeePayScope)
                pullResult = EntitySync.pullAll(repository, companyId, scope, employeePayScope)
            }

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
            val failures = listOfNotNull(
                reaped.exceptionOrNull(),
                ledgerResult.exceptionOrNull(),
                pushResult.exceptionOrNull(),
                pullResult.exceptionOrNull(),
            )
            // A real fault wins over a dead spot even when the dead spot failed
            // first; either beats nothing. See SyncFailure.toReport.
            val realError = SyncFailure.toReport(failures)
            val entityError = realError ?: failures.firstOrNull { !isNotOursToSync(it) }

            // The token was there when this pass began (the guard above). Was it
            // still there when the pass ended? A sign-in can be dropped part-way
            // through a long pass, and every read after that goes out anonymous
            // and comes back as an empty list rather than an error -- which the
            // rest of this pass would then report as a clean sync, or as a few
            // rows the server declined. Neither is true, so say what happened
            // instead, and let the next pass start from a fresh answer.
            if (!SupabaseModule.hasLiveSession()) {
                val gone = judgeLogin(currentAuthStatusKind(), false, ProfileRead.NOT_ASKED) ==
                    LoginHealth.SIGNED_OUT
                _state.value = _state.value.copy(
                    phase = if (gone) SyncPhase.SIGNED_OUT else SyncPhase.WAITING_FOR_SIGNAL,
                    lastError = context.getString(
                        if (gone) R.string.vm_signed_out_sign_in_again
                        else R.string.vm_waiting_sign_back_in
                    ),
                    hasUnsyncedWork = true
                )
                session.refresh()
                return@withLock
            }

            if (entityError != null) {
                // A network failure is not the same as a real error. The crew
                // being out of signal is normal and self-correcting; saying
                // "sync failed" for it teaches people to ignore the message.
                //
                // Real failures are also worth hearing about at this end. A
                // sync that keeps failing for one company is invisible
                // otherwise -- their work simply stops arriving, and the first
                // anyone knows is a phone call about missing jobs. A lost
                // connection is never one of them: nothing is written for it
                // at all, not even once a pass, because the banner below
                // already says "no signal" and the admin page filled up with
                // nothing else (2026-09-21).
                if (realError != null) {
                    CrashReporter.report(context, "sync", realError)
                }
                _state.value = SyncState(
                    phase = if (realError == null) SyncPhase.WAITING_FOR_SIGNAL
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
                    notifyDeleteRefused(syncResult)
                    // Something the server would not take is still something
                    // waiting. pushAll signals that with a negative count.
                    // Saying "everything is backed up" when a table was
                    // refused is how a crew member's plan-change requests
                    // disappeared with nothing on screen to notice.
                    //
                    // UNKNOWN counts too, even when every step above reports
                    // a clean zero: "couldn't ask" is never "nothing to
                    // report," and this is the one place that distinction
                    // reaches the person holding the phone.
                    val somethingHeldBack = (pushResult.getOrNull() ?: 0) < 0 ||
                        syncResult.heldBack > 0 ||
                        scope == MoneyScope.UNKNOWN
                    // One card holds one sentence, so when more than one of the
                    // three is true the person's own work is named first: that
                    // is the only one of them that can cost him anything. The
                    // unanswered question comes last for the same reason -- it
                    // is the app's own bookkeeping, not his work.
                    //
                    // Ordered on the conditions themselves rather than on an
                    // assumption that two of them cannot happen together, so
                    // this stays correct if the sync's own rules about that
                    // ever change.
                    //
                    // syncResult.heldBack is checked first and alone, never
                    // paired with the scope check below it, because it cannot
                    // be spuriously true: JobSync.sync returns before its
                    // first read whenever scope is UNKNOWN (see its own
                    // guard), so heldBack is always 0 on a pass this pushed
                    // no jobs. A held-back job is real work, every time it is
                    // reported.
                    //
                    // The push-refusal check is NOT the same guarantee, and
                    // that is the bug this ordering used to have: pushAll
                    // covers every table but jobs, none of them gated on the
                    // money scope, so a table can be refused on the exact
                    // same pass that the scope comes back UNKNOWN. Testing
                    // "pushResult < 0" before "scope == UNKNOWN" picked
                    // RECORDS_HELD_BACK on that pass and said nothing about
                    // jobs never having been asked about at all -- read as
                    // reassurance about the one thing that was never checked.
                    // Testing the pair first, ahead of the plain refusal
                    // check, says both true things instead of guessing which
                    // one to hide.
                    val reason = when {
                        !somethingHeldBack -> null
                        syncResult.heldBack > 0 -> UnsyncedReason.JOBS_HELD_BACK
                        (pushResult.getOrNull() ?: 0) < 0 && scope == MoneyScope.UNKNOWN ->
                            UnsyncedReason.RECORDS_HELD_BACK_AND_ACCESS_NOT_CONFIRMED
                        (pushResult.getOrNull() ?: 0) < 0 -> UnsyncedReason.RECORDS_HELD_BACK
                        // Only the unanswered money scope is left: the
                        // conditions above are exactly what somethingHeldBack
                        // is built from.
                        else -> UnsyncedReason.ACCESS_NOT_CONFIRMED
                    }
                    SyncState(
                        phase = SyncPhase.OK,
                        lastSyncedAt = System.currentTimeMillis(),
                        lastError = null,
                        hasUnsyncedWork = somethingHeldBack,
                        unsyncedReason = reason
                    )
                },
                onFailure = {
                    _state.value.copy(
                        phase = if (looksLikeNoSignal(it)) SyncPhase.WAITING_FOR_SIGNAL
                        else SyncPhase.FAILED,
                        // Same rule as entityError above: never the
                        // database's own words. This branch showed them raw.
                        lastError = plainWords(it),
                        hasUnsyncedWork = true
                    )
                }
            )
        }

        // Honour anything that was triggered while we held the lock. Cleared
        // before re-running, so a burst of triggers costs one extra pass and
        // cannot loop.
        if (pendingSync.getAndSet(false)) {
            runSync()
            return
        }

        // A pass that could not ask what this account may see is a pass that
        // moved no jobs, so ask again soon rather than leave somebody looking at
        // a list with work missing from it and a card that does not explain why.
        if (couldNotAskMoneyScope) askAgainShortly(scopeRetries) else scopeRetries.set(0)
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
        // Not what the server already pushed (a payment, an accepted quote),
        // one per job per pass, and each job's news once per run -- see
        // changesToAnnounce. The push token is the test for "the server's
        // push reaches this phone": without one, the pull is all it hears.
        val hasPushToken = runCatching {
            !com.fenceestimator.app.notify.PushTokenStore.cached(context).isNullOrBlank()
        }.getOrDefault(false)
        val worthTelling = changesToAnnounce(result.incoming, alreadyAnnounced, hasPushToken)

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
                // Never the completion sentence: an accepted quote is a fence
                // nobody has built yet (see statusChangeKind).
                ChangeKind.QUOTE_ACCEPTED ->
                    context.getString(R.string.ntf_quote_accepted_title) to
                        context.getString(R.string.ntf_quote_accepted_body, customer)
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

    /**
     * Tells the person that something they deleted was put back, because the
     * server will not let this account delete it (JobSync drops such a delete
     * from the queue instead of retrying it for ever -- see its deletion
     * loop). Once per record per app run; one notification however many.
     */
    private fun notifyDeleteRefused(result: SyncResult) {
        if (result.deleteRefused <= 0) return
        Notifications.show(
            context = context,
            id = DELETE_REFUSED_NOTIFICATION_ID,
            title = context.getString(R.string.sync_delete_refused_title),
            body = context.getString(R.string.sync_delete_refused_body),
            channelId = Notifications.CHANNEL_JOBS
        )
    }

    /**
     * A job column as the office reads it, for a note about a crew edit the
     * server would not take. The labels the job screen already shows, so the
     * note names a field the way the screen does.
     */
    private fun crewColumnLabel(column: String): String = when (column) {
        "customer_name" -> context.getString(R.string.field_customer_name)
        "address" -> context.getString(R.string.field_address)
        "phone" -> context.getString(R.string.field_phone)
        "email" -> context.getString(R.string.field_email)
        "notes" -> context.getString(R.string.field_notes)
        "referral_source" -> context.getString(R.string.field_referral)
        "hoa_name" -> context.getString(R.string.jd_hoa_name)
        "hoa_email" -> context.getString(R.string.jd_hoa_email)
        "hoa_approval_status" -> context.getString(R.string.jd_hoa_status)
        "permit_number" -> context.getString(R.string.jd_permit_number)
        "permit_status" -> context.getString(R.string.jd_permit_status)
        else -> column.replace('_', ' ')
    }

    private companion object {
        const val DELETE_REFUSED_NOTIFICATION_ID = 9_001
        const val SIGNED_OUT_NOTIFICATION_ID = 9_002
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
        /**
         * How many times a pass may ask again on its own before leaving it to
         * the heartbeat, and how long the first wait is -- each attempt waits a
         * multiple of it, so three attempts span roughly twenty seconds. Short
         * enough to beat the foreground heartbeat, which is the gap somebody
         * signing in on a second phone is staring at.
         */
        const val RETRY_ATTEMPTS = 3
        const val RETRY_DELAY_MS = 4_000L
        const val NOTIFY_LIMIT = 5
        const val SUMMARY_NOTIFICATION_ID = 9_000
    }
}
