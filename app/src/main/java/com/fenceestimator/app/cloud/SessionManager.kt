package com.fenceestimator.app.cloud

import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.auth.status.SessionStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

data class SessionState(
    val signedIn: Boolean = false,
    val email: String? = null,
    val companyId: String? = null,
    /**
     * Signed-out means local-only mode on your own phone, so it gets full
     * access -- the restricted roles only apply to a real company login.
     *
     * Except in the guest demo, which is also signed out and is not this
     * person's phone in any meaningful sense. See [permissions].
     */
    val role: UserRole = UserRole.OWNER,
    /**
     * This person's adjustments to their role, as stored on their profile.
     * Blank means "whatever the role says", which is the case for most people.
     */
    val permissionOverrides: String = "",
    /**
     * True once this person's profile has actually been read.
     *
     * Signed in but unread means we do not know who they are yet, and the only
     * safe answer to "what may they do" is nothing. Guessing generously here is
     * how a crew phone briefly became an owner.
     */
    val accessKnown: Boolean = false,
    /** The profile could not be reached -- temporary, and being retried. */
    val accessUnavailable: Boolean = false,
    /**
     * True once we have actually established who is signed in, if anyone.
     *
     * Before this, the state is only the defaults -- signed out, no company --
     * which is indistinguishable from genuinely being signed out. Screens that
     * warn about not being connected must wait for this, or they announce it
     * every single launch during the moment before the answer arrives.
     */
    val resolved: Boolean = false,
    /**
     * True while the guest demo is running: the sample company somebody is
     * looking around in before they have an account.
     *
     * Kept separate from [signedIn] because signed-out covers two completely
     * different people who used to share one flag. One is a solo owner working
     * on their own phone before ever making an account -- their jobs are real,
     * and taking write access away from them would break the app for the only
     * person it belongs to. The other is a visitor in a sample company that
     * gets deleted when the timer runs out. Telling them apart is what makes
     * "read only" mean anything.
     *
     * Read from the one place that already decides whether a demo is running,
     * the guest start time in SettingsStore, rather than from a second flag
     * that could disagree with the countdown on screen.
     */
    val guestDemo: Boolean = false,
    /**
     * True once the guest flag above has actually been read off disk.
     *
     * The read is a DataStore round trip, so for the first moments of a launch
     * the honest answer to "is this a demo" is "not yet known". [permissions]
     * treats that moment as read-only rather than as full access: being wrong
     * toward read-only shows a write button a fraction of a second late, and
     * being wrong the other way is a writable demo, which is the bug this
     * whole field exists to close.
     */
    val guestKnown: Boolean = false
) {
    /**
     * What this person can actually do, role plus their own adjustments.
     *
     * Three different signed-out situations, which used to be one:
     *
     *  - The guest demo gets [GUEST_READ_ONLY]. The owner asked for a demo
     *    where a visitor can see everything and change nothing, and signed-out
     *    holding every permission is why that was not true: a visitor could
     *    create, edit, delete and re-price jobs and rewrite the catalog and
     *    company settings. Worse, the demo's sample rows are marked as demo
     *    rows by two pieces of free text, one of them a customer name -- so a
     *    visitor with edit access could rub out the very mark the end-of-demo
     *    cleanup recognises them by.
     *  - Signed out with the demo flag not yet read is read-only too, for the
     *    reason on [guestKnown].
     *  - Signed out for real is still everything. That is a solo owner working
     *    alone on their own phone before making an account; the restrictions
     *    exist to divide a team and there is no team.
     */
    val permissions: Set<Permission>
        get() = when {
            // The demo. Look at everything, change nothing.
            !signedIn && guestDemo -> GUEST_READ_ONLY
            // Signed out, and whether this is a demo has not been read yet.
            !signedIn && !guestKnown -> GUEST_READ_ONLY
            // Working alone on your own phone, before any account exists. The
            // restrictions exist to divide a team, and there is no team.
            !signedIn -> Permission.ALL
            // Signed in but we have not read who they are. Nothing, until we do.
            !accessKnown -> emptySet()
            else -> PermissionOverrides.resolve(role, permissionOverrides)
        }

    /**
     * True for the read-only demo specifically, for the few screens that write
     * without ever asking about a permission and so cannot be stopped by
     * [permissions] alone.
     *
     * A screen reaching for this is a screen that should be asking about a
     * named capability instead. It exists because the fence drawing is
     * deliberately open to everyone -- crew draw on it -- so there is no
     * permission to refuse it with.
     */
    val isGuestDemo: Boolean get() = guestDemo && !signedIn

    fun can(permission: Permission): Boolean = permission in permissions

    /** Prices, margins, costs and payment figures. */
    val canSeeMoney: Boolean get() = can(Permission.SEE_MONEY)

    /**
     * A colleague's pay: hourly rate, pay type, per-foot rate.
     *
     * Kept apart from [canSeeMoney] -- a salesperson sees job prices and
     * margins to do their job, not what the crew earns. The server enforces
     * this via can_see_pay(); this mirror only keeps the app from offering a
     * screen the server would hand back empty.
     */
    val canSeePay: Boolean get() = can(Permission.SEE_PAY)

    /** Catalog prices, pricing tiers, company settings. */
    val canEditCatalogAndSettings: Boolean get() = can(Permission.EDIT_CATALOG_AND_SETTINGS)

    /** Editing the job itself: customer, spec, scheduling. */
    val canEditJobs: Boolean get() = can(Permission.EDIT_JOBS)

    /** Assigning crew and moving work around the calendar. */
    val canScheduleAndAssign: Boolean get() = can(Permission.SCHEDULE_AND_ASSIGN)

    /**
     * Sees every job rather than only the ones they are on: the same
     * capability test as the server's sees_all_jobs() (SEE_MONEY, EDIT_JOBS
     * or SCHEDULE_AND_ASSIGN), never a role name, so a per-person override
     * moves someone either way -- a foreman with -SCHEDULE_AND_ASSIGN is
     * scoped, a crew member with +EDIT_JOBS sees everything.
     *
     * A hint for what to offer, not the boundary: the server decides what
     * arrives, and [JobAccess.scope] carries its actual answer -- including
     * that a database without the crew scope shows everyone everything.
     * Signed out it is true (working alone sees everything, and so does the
     * read-only demo, which keeps SEE_MONEY); signed in but unread
     * ([accessKnown] false) it is false, like every other capability.
     */
    val seesAllJobs: Boolean get() = canSeeMoney || canEditJobs || canScheduleAndAssign

    /** Asking a customer for money. */
    val canRequestPayment: Boolean get() = can(Permission.REQUEST_PAYMENT)

    /** Marking progress, ticking checklists, adding photos on site. */
    val canRecordFieldWork: Boolean get() = can(Permission.RECORD_FIELD_WORK)

    /** Customer phone numbers, emails and addresses beyond the job site. */
    val canSeeCustomerContact: Boolean get() = can(Permission.SEE_CUSTOMER_CONTACT)

    /**
     * Deleting stays hard. It is absent from every role's defaults including
     * manager, so it only ever applies to someone it was deliberately granted
     * to -- a mistaken delete on a signed change order or a paid invoice
     * destroys the record you would need in a dispute, and there is no undo.
     */
    val canDelete: Boolean get() = can(Permission.DELETE_RECORDS)

    val canApproveTime: Boolean get() = can(Permission.APPROVE_TIME)
    val canApprovePlanChanges: Boolean get() = can(Permission.APPROVE_PLAN_CHANGES)
    val canRecordRefunds: Boolean get() = can(Permission.RECORD_REFUNDS)
    val canSeeReports: Boolean get() = can(Permission.SEE_REPORTS)
    val canManageAccess: Boolean get() = can(Permission.MANAGE_ACCESS)
    val canShareInviteCode: Boolean get() = can(Permission.SHARE_INVITE_CODE)

    companion object {
        /**
         * Everything a guest in the read-only demo may do: look.
         *
         * Written as the list of things granted rather than as everything minus
         * the writes, so a capability added to [Permission] later is refused to
         * the demo until somebody decides it belongs here. The other spelling
         * would hand every future permission to a visitor by default, which is
         * how the demo came to hold all of them in the first place.
         *
         * Money is in, deliberately. The demo exists to show a contractor what
         * the app does, and an estimating app with the prices hidden shows
         * nothing; the figures a visitor sees are the seeded sample company's,
         * not anybody's real books.
         *
         * Pay is deliberately OUT, although a demo has no real crew to expose.
         * It is the only key to the crew roster, that screen's add and save
         * buttons call straight through to the database without asking about a
         * capability anywhere in the file, and the demo seeds no crew -- so
         * granting it offered a visitor an empty list they could type into, and
         * refusing it costs the demo nothing at all.
         *
         * Everything that changes, moves, approves, charges, deletes or invites
         * is out: EDIT_JOBS, EDIT_CATALOG_AND_SETTINGS, SCHEDULE_AND_ASSIGN,
         * REQUEST_PAYMENT, RECORD_REFUNDS, RECORD_FIELD_WORK, APPROVE_TIME,
         * APPROVE_PLAN_CHANGES, DELETE_RECORDS, SHARE_INVITE_CODE and
         * MANAGE_ACCESS.
         */
        val GUEST_READ_ONLY: Set<Permission> = setOf(
            Permission.SEE_MONEY,
            Permission.SEE_CUSTOMER_CONTACT,
            Permission.SEE_REPORTS
        )
    }
}

/** App-wide view of who is signed in and what they're allowed to see. */
class SessionManager(private val scope: CoroutineScope) {

    /**
     * Set by the app on startup so identity can be remembered between launches.
     *
     * Without it the app asked the server who it was at every start and could
     * not work until the answer came back -- which offline it never did. See
     * [CachedIdentity] for why remembering a role is not the hole it sounds
     * like, and why shortening its life would not close anything.
     */
    var appContext: android.content.Context? = null
    private val _state = MutableStateFlow(SessionState())
    val state: StateFlow<SessionState> = _state

    /**
     * The one way this class replaces the session, so that whoever is signed in
     * can never overwrite what is known about the guest demo.
     *
     * Every branch of [refresh] builds a fresh [SessionState] from scratch --
     * signing out builds an empty one -- and a fresh one carries the demo flag
     * as false. A refresh landing mid-demo would therefore have re-granted
     * every permission for as long as it took the flag watch to notice, which
     * is precisely the window a visitor is tapping through. Stamping here means
     * there is no such window.
     */
    private var current: SessionState
        get() = _state.value
        set(value) {
            _state.value = value.copy(guestDemo = guestDemoActive, guestKnown = guestDemoRead)
        }

    /**
     * Supplies this device's push token. Injected rather than imported so the
     * cloud layer stays free of any Firebase dependency -- if Firebase is ever
     * swapped out, nothing here changes.
     */
    var pushTokenProvider: (() -> String?)? = null

    /**
     * Set by the app on startup so signing in can restore company settings.
     *
     * It is also how this class learns whether a guest demo is running, which
     * is why assigning it starts a watch: the demo flag lives in the settings
     * store, and the permission answer below is wrong until it has been read.
     * Injected rather than read directly so nothing here has to know where the
     * app keeps its settings.
     */
    var settingsStore: com.fenceestimator.app.data.SettingsStore?
        get() = settingsStoreField
        set(value) {
            settingsStoreField = value
            if (value != null) watchGuestFlag(value)
        }
    private var settingsStoreField: com.fenceestimator.app.data.SettingsStore? = null

    /** Whether a guest demo is running, and whether that has been read yet. */
    private var guestDemoActive = false
    private var guestDemoRead = false
    private var guestWatchStarted = false

    /**
     * Follows the guest demo flag for the life of the process.
     *
     * A flow rather than a one-off read because the flag changes underneath
     * this class twice in a session -- once when somebody starts the demo, once
     * when it is cleared -- and a permission answer that was read at startup
     * would still say "full access" to a visitor who tapped Try it afterwards.
     *
     * The guest package's own "is a demo running" test is called here rather
     * than copied, so the countdown on screen and the permissions behind it can
     * never disagree about whether a demo is running.
     */
    private fun watchGuestFlag(store: com.fenceestimator.app.data.SettingsStore) {
        if (guestWatchStarted) return
        guestWatchStarted = true
        scope.launch {
            store.profile.collect { profile ->
                val active = com.fenceestimator.app.guest.GuestSession.isActive(profile)
                if (guestDemoRead && guestDemoActive == active) return@collect
                guestDemoActive = active
                guestDemoRead = true
                _state.update { it.copy(guestDemo = active, guestKnown = true) }
            }
        }
    }

    /** Set by the app on startup so signing in can clear another company's data. */
    var dataOwnership: DataOwnership? = null

    /** Raised when this phone's data was wiped because a different account signed in. */
    private val _wipedForNewAccount = MutableStateFlow(false)
    val wipedForNewAccount: StateFlow<Boolean> = _wipedForNewAccount

    fun acknowledgeWipe() { _wipedForNewAccount.value = false }

    /** Set while a retry is pending, so a burst of failures queues one retry, not many. */
    private var accessRetryQueued = false

    /**
     * Re-reads access shortly after a failed attempt, backing off.
     *
     * Without this, one dropped request leaves someone locked out of their own
     * work until they restart the app -- which, given the read fails closed, is
     * the difference between a brief hiccup and a crew standing at a fence line
     * unable to open the job.
     */
    private fun scheduleAccessRetry() {
        if (accessRetryQueued) return
        accessRetryQueued = true
        scope.launch {
            var wait = 2_000L
            repeat(5) {
                kotlinx.coroutines.delay(wait)
                if (_state.value.accessKnown || !_state.value.signedIn) return@launch
                refresh()
                wait = (wait * 2).coerceAtMost(30_000L)
            }
        }.invokeOnCompletion { accessRetryQueued = false }
    }

    fun refresh() {
        if (!SupabaseModule.isConfigured) return
        scope.launch {
            // Wait for the auth plugin to finish loading from storage before
            // judging anything.
            //
            // currentUserEmail() answers null while it is still Initializing,
            // which is indistinguishable from being signed out -- and the
            // signed-out branch below CLEARS the cached identity. So a launch
            // that raced storage threw away this phone's memory of its own
            // company and showed "Working on this phone only. Sign in to back
            // up." to somebody who was signed in the whole time. Reported
            // immediately after logging in, which is exactly when the race is
            // easiest to lose.
            val settled = runCatching {
                withTimeoutOrNull(SESSION_SETTLE_MS) {
                    SupabaseModule.client.auth.sessionStatus
                        .first { it !is SessionStatus.Initializing }
                }
            }.getOrNull()
            if (settled == null) {
                // Still loading, or the wait itself failed. Say nothing: leave
                // whatever is on screen and let the next refresh decide. An
                // unanswered question must not be recorded as a "no".
                return@launch
            }

            val email = runCatching { SupabaseModule.currentUserEmail() }.getOrNull()
            if (email == null) {
                // Signed out. Forget who this phone belonged to, or the
                // remembered company and role outlive the account that earned
                // them and the next person to sign in here inherits them.
                appContext?.let { ctx -> runCatching { CachedIdentity.clear(ctx) } }
                // ...and which jobs it was allowed to see, for the same reason.
                JobAccess.forget()
                current = SessionState(resolved = true)
                return@launch
            }
            // Fail closed, never open.
            //
            // This used to read `profile?.userRole ?: UserRole.OWNER` with the
            // fetch wrapped in runCatching{}.getOrNull(), so ANY failure to read
            // the profile -- a dead spot, a slow response, an RLS denial --
            // silently promoted whoever was holding the phone to owner. That is
            // an access control that grants everything precisely when it cannot
            // verify anything, and it is why access levels appeared not to work
            // on a second device.
            //
            // A failed read and a genuinely absent profile are told apart
            // deliberately: the first is temporary and retries, the second is a
            // real person who has not joined a company yet. Neither gets
            // permissions, but only one of them is a problem.
            // Load what this phone already knows FIRST, and publish it, so the
            // app is usable from the moment it opens rather than after a round
            // trip. Offline that round trip never completes, which is what left
            // a crew staring at a blank screen in a yard with no signal.
            val cached = appContext?.let { ctx ->
                runCatching { CachedIdentity.load(ctx, email) }.getOrNull()
            }
            if (cached != null) {
                current = SessionState(
                    signedIn = true,
                    email = email,
                    companyId = cached.companyId,
                    role = cached.role,
                    permissionOverrides = cached.permissionOverrides,
                    // Known, but from memory rather than from the server. The
                    // refresh below corrects it within seconds of any signal.
                    accessKnown = true,
                    accessUnavailable = false,
                    resolved = true
                )
            }

            val fetched = runCatching { SupabaseModule.fetchProfile() }
            val profile = fetched.getOrNull()

            if (fetched.isSuccess && profile?.companyId != null) {
                // Only a real answer is written down. A failed fetch must leave
                // the previous one alone -- recording "no company" because the
                // network dropped is exactly how the app used to forget itself.
                appContext?.let { ctx ->
                    runCatching {
                        CachedIdentity.save(
                            ctx, email, profile.companyId!!,
                            profile.userRole, profile.permissionOverrides
                        )
                    }
                }
                current = SessionState(
                    signedIn = true,
                    email = email,
                    companyId = profile.companyId,
                    role = profile.userRole,
                    permissionOverrides = profile.permissionOverrides,
                    accessKnown = true,
                    accessUnavailable = false,
                    resolved = true
                )
            } else if (fetched.isSuccess && profile == null) {
                // A real answer, and the answer is that this account belongs to
                // no company. Distinct from a failed read: nothing to remember,
                // and anything remembered before is now wrong.
                appContext?.let { ctx -> runCatching { CachedIdentity.clear(ctx) } }
                current = SessionState(
                    signedIn = true, email = email,
                    role = UserRole.CREW,
                    accessKnown = true, resolved = true
                )
            } else if (cached == null) {
                // The read failed and this phone has never known who it is, so
                // there is genuinely nothing to go on. Fail closed and retry.
                current = SessionState(
                    signedIn = true, email = email,
                    role = UserRole.CREW,
                    accessKnown = false, accessUnavailable = true,
                    resolved = true
                )
            }
            // The remaining case -- read failed but a cache exists -- keeps the
            // cached state already published above, and retries below.

            // Keep trying. Somebody stuck with no access because their phone
            // dipped out of signal for a second must not have to restart the
            // app to get their work back.
            if (fetched.isFailure) scheduleAccessRetry()

            // Before anything else: if this phone is holding a DIFFERENT
            // company's data, clear it. Otherwise signing in on a shared crew
            // phone shows the previous company's jobs, customers and revenue.
            //
            // The no-company case is handled too, and used not to be. Signing
            // in with an account that has not joined a company left companyId
            // null, so this check was skipped entirely and the previous
            // account's data stayed on screen -- while the app simultaneously
            // reported "working on this phone only". Somebody who has not
            // joined a company is not entitled to any company's books.
            // Only on a real answer. A failed read leaves profile null, and
            // treating that as "this account has no company" wiped the phone
            // on an offline launch -- the one moment the local copy is all
            // there is.
            if (fetched.isSuccess) runCatching {
                val wiped = if (profile?.companyId != null) {
                    dataOwnership?.onSignedIn(profile.companyId!!)
                } else {
                    dataOwnership?.onSignedInWithoutCompany()
                }
                if (wiped == true) _wipedForNewAccount.value = true
            }

            // Bring down the company's saved settings so a reinstall or a new
            // crew phone starts with the right pricing and templates rather than
            // the built-in defaults.
            profile?.companyId?.let { company ->
                settingsStore?.let { store ->
                    runCatching { SettingsSync.pull(store, company) }
                }
            }

            // Register this phone for push once we know which company it belongs to.
            // Failure here must never block sign-in -- notifications are a bonus,
            // not a prerequisite for using the app.
            if (profile?.companyId != null) {
                pushTokenProvider?.invoke()?.let { token ->
                    runCatching { SupabaseModule.registerDeviceToken(token) }
                }
            }
        }
    }
    private companion object {
        /** How long to let the auth plugin load from storage before deciding. */
        const val SESSION_SETTLE_MS = 5_000L
    }
}
