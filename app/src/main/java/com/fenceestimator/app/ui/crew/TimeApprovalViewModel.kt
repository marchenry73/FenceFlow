package com.fenceestimator.app.ui.crew

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.data.Employee
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.data.TimeEntry
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class TimeApprovalViewModel(
    private val repository: Repository,
    /**
     * Who is signed in, so their own shifts can be held back from them.
     *
     * Nullable because a signed-out phone is one person working alone, where
     * there is nobody else to approve anything and the rule has no meaning.
     */
    private val signedInEmail: String? = null,
    private val signedInName: String? = null
) : ViewModel() {

    val pending: StateFlow<List<TimeEntry>> = repository.observeTimeAwaitingApproval()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    /**
     * Whether this shift is the signed-in person's own.
     *
     * A crew lead approves their team's hours; nobody approves the shift that
     * pays them, whatever their role. Not about trust -- it is what lets the
     * timesheet be shown to an accountant, or to the person being paid, without
     * an argument about who signed it off.
     */
    fun isOwnShift(entry: TimeEntry): Boolean =
        com.fenceestimator.app.cloud.OwnWork.isOwnShift(
            entry, employees.value, signedInEmail, signedInName
        )

    val employees: StateFlow<List<Employee>> = repository.observeEmployees()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val jobs: StateFlow<List<Job>> = repository.observeJobs()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    fun approve(
        entry: TimeEntry,
        approvedBy: String,
        correctedStart: Long?,
        correctedEnd: Long?,
        note: String
    ) {
        // Checked here as well as in the UI, because a control that is merely
        // hidden is not a control.
        if (isOwnShift(entry)) return
        viewModelScope.launch {
            repository.approveTimeEntry(entry, approvedBy, correctedStart, correctedEnd, note)
        }
    }

    fun reject(entry: TimeEntry, note: String) {
        viewModelScope.launch { repository.rejectTimeEntry(entry, note) }
    }
}
