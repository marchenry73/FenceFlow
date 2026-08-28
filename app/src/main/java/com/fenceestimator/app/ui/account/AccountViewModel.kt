package com.fenceestimator.app.ui.account

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.CloudProfile
import com.fenceestimator.app.cloud.JobSync
import com.fenceestimator.app.cloud.PaymentLedgerSync
import io.github.jan.supabase.postgrest.postgrest
import com.fenceestimator.app.cloud.SupabaseModule
import com.fenceestimator.app.cloud.UserRole
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.ui.components.UiMessage
import com.fenceestimator.app.ui.components.UiMessageException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

data class AccountUiState(
    val signedInEmail: String? = null,
    val profile: CloudProfile? = null,
    val busy: Boolean = false,
    val message: UiMessage? = null
) {
    /** Not signed in means local-only mode, which keeps full access on your own device. */
    val role: UserRole get() = profile?.userRole ?: UserRole.OWNER
    val isSignedIn: Boolean get() = signedInEmail != null
    val needsCompany: Boolean get() = isSignedIn && profile?.companyId == null
}

class AccountViewModel(
    private val repository: Repository? = null,
    private val dataOwnership: com.fenceestimator.app.cloud.DataOwnership? = null
) : ViewModel() {
    private val _state = MutableStateFlow(AccountUiState())
    val state: StateFlow<AccountUiState> = _state

    init {
        refresh()
    }

    fun refresh() {
        if (!SupabaseModule.isConfigured) return
        viewModelScope.launch {
            val email = SupabaseModule.currentUserEmail()
            val profile = if (email != null) runCatching { SupabaseModule.fetchProfile() }.getOrNull() else null
            _state.value = _state.value.copy(signedInEmail = email, profile = profile)
        }
    }

    fun signIn(email: String, password: String) = run(UiMessage(R.string.vm_signed_in)) {
        try {
            SupabaseModule.signIn(email.trim(), password)
        } catch (e: Exception) {
            // The raw failure is written for whoever built the auth server.
            // The person at the door needs to know which of three different
            // problems they have, because each has a different fix.
            val text = "${e::class.simpleName} ${e.message}".lowercase()
            throw when {
                "invalid login credentials" in text || "invalid_grant" in text ||
                "invalid_credentials" in text ->
                    UiMessageException(UiMessage(R.string.vm_wrong_email_or_password))
                "email not confirmed" in text || "email_not_confirmed" in text ->
                    UiMessageException(UiMessage(R.string.vm_confirm_email_first))
                com.fenceestimator.app.cloud.looksLikeNoNetwork(e) ->
                    UiMessageException(UiMessage(R.string.vm_no_signal_try_again))
                else -> e
            }
        }
    }

    fun signUp(email: String, password: String) = run(UiMessage(R.string.vm_account_created)) {
        SupabaseModule.signUp(email.trim(), password)
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
            throw UiMessageException(UiMessage(R.string.vm_sign_out_unsynced))
        }
        SupabaseModule.signOut()
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
        JobSync.sync(repo, companyId).getOrThrow()
        PaymentLedgerSync.sync(repo, companyId).getOrThrow()
        Unit
    }

    fun syncJobs() {
        val repo = repository ?: return
        val companyId = _state.value.profile?.companyId ?: return
        viewModelScope.launch {
            _state.value = _state.value.copy(busy = true, message = null)
            val result = JobSync.sync(repo, companyId)
            _state.value = _state.value.copy(
                busy = false,
                message = result.fold(
                    onSuccess = { UiMessage(R.string.vm_synced_up_down, listOf(it.uploaded, it.downloaded)) },
                    onFailure = { UiMessage(R.string.vm_sync_failed_with, listOf(it.message.orEmpty())) }
                )
            )
        }
    }

    fun clearMessage() {
        _state.value = _state.value.copy(message = null)
    }

    private fun run(successMessage: UiMessage, block: suspend () -> Unit) {
        viewModelScope.launch {
            _state.value = _state.value.copy(busy = true, message = null)
            val result = runCatching { block() }
            val email = runCatching { SupabaseModule.currentUserEmail() }.getOrNull()
            val profile = if (email != null) runCatching { SupabaseModule.fetchProfile() }.getOrNull() else null
            _state.value = _state.value.copy(
                busy = false,
                signedInEmail = email,
                profile = profile,
                message = result.fold(
                    onSuccess = { successMessage },
                    onFailure = { error ->
                        val text = error.message
                        when {
                            error is UiMessageException -> error.ui
                            text != null -> UiMessage(R.string.vm_failed_with, listOf(text))
                            else -> UiMessage(R.string.vm_something_went_wrong)
                        }
                    }
                )
            )
        }
    }
}
