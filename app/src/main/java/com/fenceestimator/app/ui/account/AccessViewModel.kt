package com.fenceestimator.app.ui.account

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.CloudProfile
import com.fenceestimator.app.cloud.Permission
import com.fenceestimator.app.cloud.PermissionOverrides
import com.fenceestimator.app.cloud.SessionManager
import com.fenceestimator.app.cloud.SupabaseModule
import com.fenceestimator.app.cloud.UserRole
import com.fenceestimator.app.ui.components.UiMessage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class AccessViewModel(private val session: SessionManager) : ViewModel() {

    private val _team = MutableStateFlow<List<CloudProfile>>(emptyList())
    val team: StateFlow<List<CloudProfile>> = _team

    private val _message = MutableStateFlow<UiMessage?>(null)
    val message: StateFlow<UiMessage?> = _message

    fun load() {
        val companyId = session.state.value.companyId ?: return
        viewModelScope.launch {
            runCatching { SupabaseModule.fetchTeam(companyId) }
                .onSuccess { members ->
                    // Owners first, then by name -- the list is read to find one
                    // person, and alphabetical-by-role is how you find them.
                    _team.value = members.sortedWith(
                        compareBy({ it.userRole.ordinal }, { it.fullName.lowercase() })
                    )
                }
                .onFailure { _message.value = UiMessage(R.string.vm_couldnt_load_team, listOf(it.message.orEmpty())) }
        }
    }

    /**
     * Saves one person's access.
     *
     * Stored as differences from the role rather than the resolved set, so that
     * if what a role means changes later, everyone who was never specifically
     * adjusted moves with it.
     *
     * The database is the actual gate: the update is rejected outright unless
     * the caller holds MANAGE_ACCESS, and never applies to their own row. This
     * reports the rejection rather than swallowing it, because a permission
     * that silently failed to save is worse than one that visibly did not.
     */
    fun save(member: CloudProfile, role: UserRole, permissions: Set<Permission>) {
        viewModelScope.launch {
            val overrides = PermissionOverrides.encode(role, permissions)
            runCatching { SupabaseModule.updateMemberAccess(member.id, role, overrides) }
                .onSuccess {
                    _message.value = if (member.fullName.isBlank()) UiMessage(R.string.vm_saved_their_access)
                        else UiMessage(R.string.vm_saved_access_of, listOf(member.fullName))
                    load()
                    // If we just changed our own company's rules, re-read our
                    // own session so the app reflects them without a restart.
                    session.refresh()
                }
                .onFailure { error ->
                    val reason = error.message
                    _message.value = if (reason != null) UiMessage(R.string.vm_couldnt_save_with, listOf(reason))
                        else UiMessage(R.string.vm_couldnt_save_refused)
                }
        }
    }
}
