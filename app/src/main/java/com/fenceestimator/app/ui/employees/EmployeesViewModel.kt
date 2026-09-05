package com.fenceestimator.app.ui.employees

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.data.Employee
import com.fenceestimator.app.data.Repository
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class EmployeesViewModel(private val repository: Repository) : ViewModel() {
    val employees: StateFlow<List<Employee>> = repository.observeEmployees()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    fun save(employee: Employee) {
        viewModelScope.launch { repository.saveEmployee(employee) }
    }

    /**
     * Saves a brand-new crew member and, if they were given an email address
     * and the phone is online, asks invite-crew to email them straight away
     * -- "crew added from the phone should get the invite email", the same
     * as adding someone from the office dashboard already does.
     *
     * Deliberately only for a NEW employee (never called from the edit
     * dialog on an existing one): re-running this every time somebody edits
     * a phone number or hourly rate would re-send the invitation on every
     * save, which is spam, not a feature.
     *
     * @param online whether the phone currently has a usable connection
     *   ([com.fenceestimator.app.cloud.ConnectivityWatcher]) -- checked by
     *   the caller so this class doesn't need an Android Context to ask
     *   itself.
     * @param onOutcome null when no invite was attempted at all (no email
     *   given, or offline); otherwise what invite-crew said.
     */
    fun addCrewMember(employee: Employee, online: Boolean, onOutcome: (InviteCrewApi.Result?) -> Unit) {
        viewModelScope.launch {
            repository.saveEmployee(employee)
            val email = employee.email.trim()
            if (email.isNotBlank() && online) {
                onOutcome(InviteCrewApi.invite(employee.name.trim(), email, employee.role.trim()))
            } else {
                onOutcome(null)
            }
        }
    }

    fun delete(employee: Employee) {
        viewModelScope.launch { repository.deleteEmployee(employee) }
    }

    /** Their unfinished jobs, so the screen can say what is about to move. */
    suspend fun openJobsFor(employee: Employee) = repository.openJobsFor(employee.id)

    /**
     * Takes somebody off the crew, keeping everything they did.
     *
     * @param reassignTo who picks up their unfinished jobs. Finished ones keep
     *   their name -- they did that work and the record should say so.
     */
    fun deactivate(employee: Employee, reassignTo: Long?) {
        viewModelScope.launch { repository.deactivateEmployee(employee, reassignTo) }
    }

    fun reactivate(employee: Employee) {
        viewModelScope.launch { repository.reactivateEmployee(employee) }
    }
}
