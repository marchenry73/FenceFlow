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
    val permissionOverrides: String = ""
) {
    /**
     * What this person can actually do, role plus their own adjustments.
     *
     * Signed out means working alone on your own phone, so everything is
     * allowed -- the restrictions exist to divide a team, and there is no team.
     */
    val permissions: Set<Permission>
        get() = if (!signedIn) Permission.ALL
        else PermissionOverrides.resolve(role, permissionOverrides)

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
}

/** App-wide view of who is signed in and what they're allowed to see. */
class SessionManager(private val scope: CoroutineScope) {
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

    fun refresh() {
        if (!SupabaseModule.isConfigured) return
        scope.launch {
            val email = runCatching { SupabaseModule.currentUserEmail() }.getOrNull()
            if (email == null) {
                _state.value = SessionState()
                return@launch
            }
            val profile = runCatching { SupabaseModule.fetchProfile() }.getOrNull()
            _state.value = SessionState(
                signedIn = true,
                email = email,
                companyId = profile?.companyId,
                role = profile?.userRole ?: UserRole.OWNER,
                permissionOverrides = profile?.permissionOverrides.orEmpty()
            )

            // Before anything else: if this phone is holding a DIFFERENT
            // company's data, clear it. Otherwise signing in on a shared crew
            // phone shows the previous company's jobs, customers and revenue.
            profile?.companyId?.let { company ->
                runCatching {
                    if (dataOwnership?.onSignedIn(company) == true) {
                        _wipedForNewAccount.value = true
                    }
                }
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
