package com.fenceestimator.app.ui.account

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.cloud.CloudProfile
import com.fenceestimator.app.cloud.JobSync
import com.fenceestimator.app.cloud.SupabaseModule
import com.fenceestimator.app.cloud.UserRole
import com.fenceestimator.app.data.Repository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

data class AccountUiState(
    val signedInEmail: String? = null,
    val profile: CloudProfile? = null,
    val busy: Boolean = false,
    val message: String? = null
) {
    /** Not signed in means local-only mode, which keeps full access on your own device. */
    val role: UserRole get() = profile?.userRole ?: UserRole.OWNER
    val isSignedIn: Boolean get() = signedInEmail != null
    val needsCompany: Boolean get() = isSignedIn && profile?.companyId == null
}

class AccountViewModel(private val repository: Repository? = null) : ViewModel() {
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

    fun signIn(email: String, password: String) = run("Signed in") {
        SupabaseModule.signIn(email.trim(), password)
    }

    fun signUp(email: String, password: String) = run("Account created") {
        SupabaseModule.signUp(email.trim(), password)
    }

    fun createCompany(companyName: String, ownerName: String) = run("Business created") {
        SupabaseModule.createCompany(companyName.trim(), ownerName.trim())
    }

    fun joinCompany(companyId: String, memberName: String) = run("Joined business") {
        SupabaseModule.joinCompany(companyId.trim(), memberName.trim())
    }

    fun signOut() = run("Signed out") {
        SupabaseModule.signOut()
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
                    onSuccess = { "Synced: ${it.uploaded} sent up, ${it.downloaded} brought down" },
                    onFailure = { "Sync failed: ${it.message}" }
                )
            )
        }
    }

    fun clearMessage() {
        _state.value = _state.value.copy(message = null)
    }

    private fun run(successMessage: String, block: suspend () -> Unit) {
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
                    onFailure = { it.message ?: "Something went wrong" }
                )
            )
        }
    }
}
