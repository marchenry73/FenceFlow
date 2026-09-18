package com.fenceestimator.app.ui.crew

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.R
import com.fenceestimator.app.data.Employee
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.data.TimeEntry
import com.fenceestimator.app.ui.components.UiMessage
import kotlinx.coroutines.flow.MutableStateFlow
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
     * Shifts the cloud has permanently refused -- see [TimeEntry.isSyncBlocked].
     * Never retried by [com.fenceestimator.app.cloud.EntitySync.pushTimeEntries]
     * on its own; the only way one leaves this list is [fixAndRetry] or the
     * shift being discarded.
     */
    val syncBlocked: StateFlow<List<TimeEntry>> = repository.observeSyncBlockedTimeEntries()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    private val _message = MutableStateFlow<UiMessage?>(null)
    val message: StateFlow<UiMessage?> = _message

    /**
     * The Fix action: attach an employee and clear the block so the next
     * sync actually retries it. Defaults to the signed-in person's own
     * employee record when one is linked, per the task's requirement, but the
     * caller always passes the id the person actually picked in the dialog.
     */
    fun fixAndRetry(entry: TimeEntry, employeeId: Long) {
        viewModelScope.launch {
            runCatching { repository.assignEmployeeAndRetry(entry, employeeId) }
                .onSuccess { _message.value = UiMessage(R.string.vm_time_fixed_will_retry) }
                .onFailure { _message.value = UiMessage(R.string.vm_couldnt_fix_time, listOf(it.message.orEmpty())) }
        }
    }

    /**
     * Discarding a blocked shift for good. The caller (the confirmation
     * dialog) is what asks "are you sure" and says what is lost -- this just
     * carries out the choice once made.
     */
    fun discardBlocked(entry: TimeEntry) {
        viewModelScope.launch {
            runCatching { repository.deleteTimeEntry(entry) }
                .onSuccess { _message.value = UiMessage(R.string.vm_time_discarded) }
                .onFailure { _message.value = UiMessage(R.string.vm_couldnt_discard_time, listOf(it.message.orEmpty())) }
        }
    }

    /**
     * The signed-in person's own employee row, if their account is linked to
     * one -- the default choice [fixAndRetry]'s dialog should preselect.
     */
    fun ownEmployeeId(): Long? = employees.value.firstOrNull {
        com.fenceestimator.app.cloud.OwnWork.isSamePerson(it, signedInEmail, signedInName)
    }?.id

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
            // This is payroll: a dialog that just closes leaves nobody able to
            // tell a saved approval from one the database silently dropped.
            runCatching { repository.approveTimeEntry(entry, approvedBy, correctedStart, correctedEnd, note) }
                .onSuccess { _message.value = UiMessage(R.string.vm_time_approved) }
                .onFailure { _message.value = UiMessage(R.string.vm_couldnt_approve_time, listOf(it.message.orEmpty())) }
        }
    }

    fun reject(entry: TimeEntry, note: String) {
        viewModelScope.launch {
            runCatching { repository.rejectTimeEntry(entry, note) }
                .onSuccess { _message.value = UiMessage(R.string.vm_time_rejected) }
                .onFailure { _message.value = UiMessage(R.string.vm_couldnt_reject_time, listOf(it.message.orEmpty())) }
        }
    }
}
