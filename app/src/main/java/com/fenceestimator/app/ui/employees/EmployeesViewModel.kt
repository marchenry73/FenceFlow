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
