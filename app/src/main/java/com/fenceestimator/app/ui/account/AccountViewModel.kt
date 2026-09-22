package com.fenceestimator.app.ui.account

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.CloudProfile
import com.fenceestimator.app.cloud.JobSync
import com.fenceestimator.app.cloud.PaymentLedgerSync
import com.fenceestimator.app.cloud.askMoneyScope
import com.fenceestimator.app.cloud.isNotOursToSync
import io.github.jan.supabase.postgrest.postgrest
import com.fenceestimator.app.cloud.SupabaseModule
import com.fenceestimator.app.cloud.UserRole
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.ui.components.UiMessage
import com.fenceestimator.app.ui.components.UiMessageException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

data class AccountUiState(
    val signedInEmail: String? = null,
    val profile: CloudProfile? = null,
    /**
     * A dropped connection while fetching the profile used to look exactly
     * like a successful fetch that came back with no company -- both left
     * [profile] null. That put the "set up your business" form in front of
     * someone who already had one, and they built a second, empty company.
     * This is set only when the fetch itself threw, so needsCompany below
     * cannot fire on a network hiccup.
     */
    val profileFetchFailed: Boolean = false,
    val busy: Boolean = false,
    val message: UiMessage? = null,
    /**
     * A sign-out was refused because work is still waiting to upload, even
     * after the confirm dialog's own "sign out anyway" pass -- e.g. the
     * dialog's local unsynced check was stale, or a deeper server-side
     * rejection (RLS, a policy change) kept the real push from ever landing.
     * The screen watches this to re-show the dialog with what's waiting
     * rather than leaving the refusal in a Snackbar that scrolls away.
     */
    val signOutBlockedByUnsyncedWork: Boolean = false,
    /**
     * Why the last sign-in or sign-up from the form did not get in, shown
     * under the password box. A snackbar was the only place it went, and it
     * had scrolled away by the time anybody looked up from retyping.
     */
    val signInError: UiMessage? = null,
    /**
     * The server said the email and password do not match. The screen empties
     * the password box (only that one -- the address stays) and puts the
     * cursor in it, then clears this with [AccountViewModel.consumePasswordRejected].
     */
    val passwordRejected: Boolean = false,
    /** The address that last got in on this phone, to start the form with. */
    val lastSignInEmail: String? = null,
    /**
     * A sign-in from the form just got in. The screen takes it from here to the
     * home screen once the app-wide session agrees, unless the account still
     * has a step to finish -- see AccountScreen.
     */
    val justSignedIn: Boolean = false
) {
    /** Not signed in means local-only mode, which keeps full access on your own device. */
    val role: UserRole get() = profile?.userRole ?: UserRole.OWNER
    val isSignedIn: Boolean get() = signedInEmail != null
    /** True only after a fetch that actually succeeded came back with no company. */
    val needsCompany: Boolean get() = isSignedIn && !profileFetchFailed && profile?.companyId == null
}

class AccountViewModel(
    private val repository: Repository? = null,
    private val dataOwnership: com.fenceestimator.app.cloud.DataOwnership? = null,
    private val settingsStore: com.fenceestimator.app.data.SettingsStore? = null
) : ViewModel() {
    private val _state = MutableStateFlow(AccountUiState())
    val state: StateFlow<AccountUiState> = _state

    init {
        refresh()
        settingsStore?.let { store ->
            viewModelScope.launch {
                val remembered = runCatching { store.lastSignInEmail.first() }.getOrNull()
                if (!remembered.isNullOrBlank()) {
                    _state.value = _state.value.copy(lastSignInEmail = remembered)
                }
            }
        }
    }

    fun refresh() {
        if (!SupabaseModule.isConfigured) return
        viewModelScope.launch {
            val email = SupabaseModule.currentUserEmail()
            if (email == null) {
                _state.value = _state.value.copy(signedInEmail = null, profile = null, profileFetchFailed = false)
                return@launch
            }
            // Distinguish "the fetch threw" from "the fetch succeeded and there
            // really is no company" -- collapsing them into one null used to
            // show the setup form to someone whose signal just dropped.
            val result = runCatching { SupabaseModule.fetchProfile() }
            _state.value = _state.value.copy(
                signedInEmail = email,
                profile = result.getOrNull(),
                profileFetchFailed = result.isFailure
            )
        }
    }

    fun signIn(email: String, password: String) = run(UiMessage(R.string.vm_signed_in), fromSignInForm = true) {
        try {
            SupabaseModule.signIn(email.trim(), password)
        } catch (e: Exception) {
            // The raw failure is written for whoever built the auth server.
            // The person at the door needs to know which of three different
            // problems they have, because each has a different fix.
            val text = "${e::class.simpleName} ${e.message}".lowercase()
            throw when {
                "invalid login credentials" in text || "invalid_grant" in text ||
                "invalid_credentials" in text -> {
                    // Only this one empties the password. No signal or an
                    // unconfirmed email says nothing about what was typed,
                    // and making somebody retype a correct password because
                    // their truck is in a dead spot helps nobody.
                    _state.value = _state.value.copy(passwordRejected = true)
                    UiMessageException(UiMessage(R.string.vm_wrong_email_or_password))
                }
                "email not confirmed" in text || "email_not_confirmed" in text ->
                    UiMessageException(UiMessage(R.string.vm_confirm_email_first))
                com.fenceestimator.app.cloud.looksLikeNoNetwork(e) ->
                    UiMessageException(UiMessage(R.string.vm_no_signal_try_again))
                else -> e
            }
        }
    }

    fun signUp(email: String, password: String) = run(UiMessage(R.string.vm_account_created), fromSignInForm = true) {
        SupabaseModule.signUp(email.trim(), password)
    }

    /** Typing again means the last failure has been read. */
    fun clearSignInError() {
        if (_state.value.signInError != null) _state.value = _state.value.copy(signInError = null)
    }

    /** Clears the flag once the screen has emptied the password box. */
    fun consumePasswordRejected() {
        _state.value = _state.value.copy(passwordRejected = false)
    }

    /** Clears the flag once the screen has acted on a fresh sign-in. */
    fun consumeJustSignedIn() {
        _state.value = _state.value.copy(justSignedIn = false)
    }

    fun createCompany(companyName: String, ownerName: String) = run(UiMessage(R.string.vm_business_created)) {
        SupabaseModule.createCompany(companyName.trim(), ownerName.trim())
    }

    /** Attaches this account to a company FenceFlow set up in advance. */
    fun claimCompanySetup(setupCode: String, ownerName: String) = run(UiMessage(R.string.vm_you_are_set_up)) {
        SupabaseModule.claimCompanySetup(setupCode, ownerName)
    }

    fun joinCompany(
        companyId: String,
        memberName: String,
        requestedRole: com.fenceestimator.app.cloud.UserRole?
    ) = run(UiMessage(R.string.vm_joined_business)) {
        SupabaseModule.joinCompany(companyId.trim(), memberName.trim(), requestedRole)
    }

    /**
     * Signs out and clears this phone.
     *
     * Leaving the data behind meant the next person to open the app -- or sign
     * in with a different account -- saw the previous company's jobs, customers
     * and revenue. On a shared crew phone that is one company's books shown to
     * another.
     *
     * Blocked while anything is still waiting to upload, so signing out can
     * never be what destroys a day's work recorded somewhere with no signal.
     * @param force skips that guard once the user has been told and chosen to.
     */
    fun signOut(force: Boolean = false) = run(UiMessage(R.string.vm_signed_out)) {
        val ownership = dataOwnership
        if (ownership != null && !ownership.onSignedOut(force)) {
            // Logged here too (not just inside DataOwnership) so a report of
            // "sign out did nothing" can be told apart from a network error
            // during SupabaseModule.signOut() below.
            android.util.Log.w("AccountViewModel", "signOut(force=$force) refused: unsynced work")
            _state.value = _state.value.copy(signOutBlockedByUnsyncedWork = true)
            throw UiMessageException(UiMessage(R.string.vm_sign_out_unsynced))
        }
        _state.value = _state.value.copy(signOutBlockedByUnsyncedWork = false)
        SupabaseModule.signOut()
    }

    /** Clears the re-show flag once the dialog it re-opened has been handled. */
    fun consumeSignOutBlocked() {
        _state.value = _state.value.copy(signOutBlockedByUnsyncedWork = false)
    }

    /**
     * Rebuilds every job's cached money figures from the payment ledger, on
     * the server, then pulls the corrected rows down. The server keeps these
     * in step by itself now; this button exists so that if a number ever looks
     * wrong again, the fix is in the user's hands instead of a support call.
     */
    fun recalculateTotals() = run(UiMessage(R.string.vm_totals_recalculated)) {
        SupabaseModule.client.postgrest.rpc("recalculate_my_job_totals")
        val repo = repository ?: throw UiMessageException(UiMessage(R.string.vm_something_went_wrong))
        val companyId = _state.value.profile?.companyId
            ?: throw UiMessageException(UiMessage(R.string.vm_something_went_wrong))
        // recalculate_my_job_totals already no-ops for a non-SEE_MONEY caller
        // server-side; asked here too so JobSync/PaymentLedgerSync route the
        // same way a manual tap on this button as the background sync does.
        val scope = askMoneyScope()
        JobSync.sync(repo, companyId, scope).getOrThrow()
        PaymentLedgerSync.sync(repo, companyId, scope).getOrThrow()
        Unit
    }

    fun syncJobs() {
        val repo = repository ?: return
        val companyId = _state.value.profile?.companyId ?: return
        viewModelScope.launch {
            _state.value = _state.value.copy(busy = true, message = null)
            val result = JobSync.sync(repo, companyId, askMoneyScope())
            _state.value = _state.value.copy(
                busy = false,
                message = result.fold(
                    onSuccess = { UiMessage(R.string.vm_synced_up_down, listOf(it.uploaded, it.downloaded)) },
                    onFailure = {
                        // A policy refusal is written for whoever wrote the
                        // policy, not for the person holding the phone.
                        if (isNotOursToSync(it)) UiMessage(R.string.sync_plain_unknown, emptyList())
                        else UiMessage(R.string.vm_sync_failed_with, listOf(it.message.orEmpty()))
                    }
                )
            )
        }
    }

    fun clearMessage() {
        _state.value = _state.value.copy(message = null)
    }

    /**
     * @param fromSignInForm the sign-in / sign-up form: a failure is shown under
     *   its password box instead of in a snackbar, and a success records the
     *   address for next time and raises [AccountUiState.justSignedIn].
     */
    private fun run(successMessage: UiMessage, fromSignInForm: Boolean = false, block: suspend () -> Unit) {
        viewModelScope.launch {
            _state.value = _state.value.copy(
                busy = true,
                message = null,
                signInError = if (fromSignInForm) null else _state.value.signInError
            )
            val result = runCatching { block() }
            val email = runCatching { SupabaseModule.currentUserEmail() }.getOrNull()
            val profileResult = if (email != null) runCatching { SupabaseModule.fetchProfile() } else null
            val failure = result.exceptionOrNull()?.let { error ->
                val text = error.message
                when {
                    error is UiMessageException -> error.ui
                    text != null -> UiMessage(R.string.vm_failed_with, listOf(text))
                    else -> UiMessage(R.string.vm_something_went_wrong)
                }
            }
            // Set only when the form has just got somebody in.
            val signedInHere = email?.takeIf { fromSignInForm && failure == null }
            if (signedInHere != null) {
                // The address the server actually signed in, not the one as
                // typed -- and never the password, which has no key to go in.
                settingsStore?.let { store -> runCatching { store.saveLastSignInEmail(signedInHere) } }
            }
            _state.value = _state.value.copy(
                busy = false,
                signedInEmail = email,
                profile = profileResult?.getOrNull(),
                profileFetchFailed = profileResult?.isFailure ?: false,
                message = when {
                    failure == null -> successMessage
                    fromSignInForm -> null
                    else -> failure
                },
                signInError = if (fromSignInForm) failure else _state.value.signInError,
                // Kept in step here too, so signing out later from this same
                // screen starts the form with the address that just worked.
                lastSignInEmail = signedInHere ?: _state.value.lastSignInEmail,
                justSignedIn = _state.value.justSignedIn || signedInHere != null
            )
        }
    }
}
