package com.fenceestimator.app.cloud

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

data class SessionState(
    val signedIn: Boolean = false,
    val email: String? = null,
    val companyId: String? = null,
    /**
     * Signed-out means local-only mode on your own phone, so it gets full
     * access -- the restricted roles only apply to a real company login.
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
    val resolved: Boolean = false
) {
    /**
     * What this person can actually do, role plus their own adjustments.
     *
     * Signed out means working alone on your own phone, so everything is
     * allowed -- the restrictions exist to divide a team, and there is no team.
     */
    val permissions: Set<Permission>
        get() = when {
            // Working alone on your own phone. The restrictions exist to divide
            // a team, and there is no team.
            !signedIn -> Permission.ALL
            // Signed in but we have not read who they are. Nothing, until we do.
            !accessKnown -> emptySet()
            else -> PermissionOverrides.resolve(role, permissionOverrides)
        }

    fun can(permission: Permission): Boolean = permission in permissions

    /** Prices, margins, costs and payment figures. */
    val canSeeMoney: Boolean get() = can(Permission.SEE_MONEY)

    /** Catalog prices, pricing tiers, company settings. */
    val canEditCatalogAndSettings: Boolean get() = can(Permission.EDIT_CATALOG_AND_SETTINGS)

    /** Editing the job itself: customer, spec, scheduling. */
    val canEditJobs: Boolean get() = can(Permission.EDIT_JOBS)

    /** Assigning crew and moving work around the calendar. */
    val canScheduleAndAssign: Boolean get() = can(Permission.SCHEDULE_AND_ASSIGN)

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
     * Supplies this device's push token. Injected rather than imported so the
     * cloud layer stays free of any Firebase dependency -- if Firebase is ever
     * swapped out, nothing here changes.
     */
    var pushTokenProvider: (() -> String?)? = null

    /** Set by the app on startup so signing in can restore company settings. */
    var settingsStore: com.fenceestimator.app.data.SettingsStore? = null

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
            val email = runCatching { SupabaseModule.currentUserEmail() }.getOrNull()
            if (email == null) {
                // Signed out. Forget who this phone belonged to, or the
                // remembered company and role outlive the account that earned
                // them and the next person to sign in here inherits them.
                appContext?.let { ctx -> runCatching { CachedIdentity.clear(ctx) } }
                _state.value = SessionState(resolved = true)
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
                _state.value = SessionState(
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
                _state.value = SessionState(
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
                _state.value = SessionState(
                    signedIn = true, email = email,
                    role = UserRole.CREW,
                    accessKnown = true, resolved = true
                )
            } else if (cached == null) {
                // The read failed and this phone has never known who it is, so
                // there is genuinely nothing to go on. Fail closed and retry.
                _state.value = SessionState(
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
            runCatching {
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
}
