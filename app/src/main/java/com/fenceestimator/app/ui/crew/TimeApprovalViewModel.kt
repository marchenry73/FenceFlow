package com.fenceestimator.app.ui.crew

import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.TimeCorrection
import com.fenceestimator.app.cloud.canBeSentAsWorker
import com.fenceestimator.app.data.Employee
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.data.TimeEntry
import com.fenceestimator.app.ui.components.UiMessage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * Whether the review dialog's times differ from what the clock recorded.
 *
 * Compared to the MINUTE, because that is the precision the dialog offers. A
 * shift that started at 06:14:37 comes back from an untouched HH:mm field as
 * 06:14:00, and treating those 37 seconds as a correction would demand a
 * reason for every single approval and file a correction against a foreman
 * who changed nothing. The same rounding bites the office's own
 * datetime-local inputs -- 5 of the 9 live shifts move their seconds on a
 * round trip -- so this is the existing shape of the problem, not a new one.
 *
 * A shift with no finish yet cannot be corrected at all (the server refuses
 * it too: there is no clock-out to move), so it reports false.
 *
 * Top-level and pure so a test can hold it to that, without a ViewModel.
 */
fun shiftTimesMoved(entry: TimeEntry, newStartedAt: Long?, newEndedAt: Long?): Boolean {
    if (entry.endedAt == null || newEndedAt == null) return false
    fun minute(value: Long?): Long? = value?.floorDiv(60_000L)
    return minute(newStartedAt) != minute(entry.startedAt) ||
        minute(newEndedAt) != minute(entry.endedAt)
}

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
        // The dialog only offers [fixableEmployees], but a control that is
        // merely filtered is not a control: a worker the cloud cannot be told
        // about would clear the block, go up as employee_sync_id "" and land
        // the shift straight back on this list.
        val worker = employees.value.firstOrNull { it.id == employeeId }
        if (worker == null || !canBeSentAsWorker(worker)) {
            _message.value = UiMessage(R.string.vm_time_fix_worker_unsyncable)
            return
        }
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

    /**
     * Who the Fix dialog may offer: only people the cloud can be told about.
     * A shift goes up with its employee's sync id and the server refuses a
     * blank one outright -- see [canBeSentAsWorker]. Declared after
     * [employees], which it is built from.
     */
    val fixableEmployees: StateFlow<List<Employee>> = employees
        .map { list -> list.filter(::canBeSentAsWorker) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val jobs: StateFlow<List<Job>> = repository.observeJobs()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    /**
     * Sign off a shift, optionally correcting what the clock recorded.
     *
     * The correction does NOT ride the ordinary sync. It cannot:
     * [com.fenceestimator.app.cloud.EntitySync.pushTimeEntries] sends each
     * finished shift twice, and the only pass that carries started_at/ended_at
     * is insert-only -- a no-op for a row the cloud already holds. That split
     * is deliberate (it stops a phone re-asserting its original times over an
     * office correction) and it meant a correction typed here was applied to
     * Room, shown as "Approved", and then quietly reverted by the next pull.
     * Payroll paid the uncorrected hours.
     *
     * So a correction goes through [com.fenceestimator.app.cloud.TimeCorrection]
     * -- the `correct_time_entry` RPC, which needs APPROVE_TIME, keeps the
     * original alongside and records who changed it and why -- and the screen
     * is told what the SERVER stored, not what was typed. If the correction
     * cannot be sent, the shift is NOT approved and the message says so; the
     * one thing this must never do is show "Approved" over hours nobody has.
     */
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

        val newStart = correctedStart ?: entry.startedAt
        val newEnd = correctedEnd ?: entry.endedAt
        val timesChanged = shiftTimesMoved(entry, newStart, newEnd)

        viewModelScope.launch {
            if (!timesChanged) {
                // Nothing to correct -- the ordinary sign-off, unchanged. This
                // is payroll: a dialog that just closes leaves nobody able to
                // tell a saved approval from one the database silently dropped.
                runCatching { repository.approveTimeEntry(entry, approvedBy, null, null, note) }
                    .onSuccess { _message.value = UiMessage(R.string.vm_time_approved) }
                    .onFailure { _message.value = UiMessage(R.string.vm_couldnt_approve_time, listOf(it.message.orEmpty())) }
                return@launch
            }

            // Asked for here so the refusal is a sentence on the screen rather
            // than a round trip: the server refuses a wordless correction, and
            // the reason is what the crew member reads when their hours change.
            if (note.isBlank()) {
                _message.value = UiMessage(R.string.vm_time_correction_needs_reason)
                return@launch
            }

            // timesChanged is what guarantees this; a boolean the compiler
            // cannot follow back to the null check, so it is stated once here
            // rather than !! at four call sites.
            val correctedEndAt = newEnd ?: return@launch

            when (val sent = TimeCorrection.correct(entry.syncId, newStart, correctedEndAt, note)) {
                is TimeCorrection.Outcome.Saved ->
                    // The server's own values, not the typed ones.
                    finishApproval(
                        entry.copy(
                            originalStartedAt = sent.originalStartedAt ?: entry.originalStartedAt,
                            originalEndedAt = sent.originalEndedAt ?: entry.originalEndedAt,
                            correctedAt = sent.correctedAt ?: entry.correctedAt,
                            correctionReason = sent.correctionReason.ifBlank { entry.correctionReason }
                        ),
                        approvedBy, sent.startedAt, sent.endedAt, note,
                        R.string.vm_time_corrected_and_approved
                    )

                // The cloud has never seen this shift, so there is nothing
                // there to correct -- and the insert-only pass, the one that
                // DOES carry the clock, will send the corrected times as the
                // shift's first and only version. Stamped locally the way
                // preserve_original_shift would have, so the phone still shows
                // what the clock said next to what it was changed to.
                TimeCorrection.Outcome.NotInCloudYet ->
                    finishApproval(
                        stampedLocally(entry, newStart, correctedEndAt, note),
                        approvedBy, newStart, correctedEndAt, note,
                        R.string.vm_time_corrected_will_sync
                    )

                // One person working alone on their own phone: no cloud to
                // send anything to, and nothing to be wrong about.
                TimeCorrection.Outcome.NotSignedIn ->
                    finishApproval(
                        stampedLocally(entry, newStart, correctedEndAt, note),
                        approvedBy, newStart, correctedEndAt, note,
                        R.string.vm_time_corrected_on_this_phone
                    )

                // Both of these leave the shift in the queue, unapproved and
                // uncorrected, which is the honest state.
                is TimeCorrection.Outcome.Refused ->
                    _message.value = UiMessage(R.string.vm_time_correction_refused, listOf(sent.detail))

                TimeCorrection.Outcome.Unreachable ->
                    _message.value = UiMessage(R.string.vm_time_correction_unreachable)
            }
        }
    }

    /**
     * What `preserve_original_shift()` does, done here for a shift the cloud
     * has never held -- per field, so a start that never moved keeps no
     * "original" it never had.
     */
    private fun stampedLocally(entry: TimeEntry, newStart: Long, newEnd: Long, note: String): TimeEntry =
        entry.copy(
            originalStartedAt =
                if (newStart != entry.startedAt) entry.originalStartedAt ?: entry.startedAt
                else entry.originalStartedAt,
            originalEndedAt =
                if (newEnd != entry.endedAt) entry.originalEndedAt ?: entry.endedAt
                else entry.originalEndedAt,
            correctedAt = System.currentTimeMillis(),
            correctionReason = note
        )

    private suspend fun finishApproval(
        entry: TimeEntry,
        approvedBy: String,
        startedAt: Long,
        endedAt: Long,
        note: String,
        @StringRes successMessage: Int
    ) {
        runCatching { repository.approveTimeEntry(entry, approvedBy, startedAt, endedAt, note) }
            .onSuccess { _message.value = UiMessage(successMessage) }
            .onFailure { _message.value = UiMessage(R.string.vm_couldnt_approve_time, listOf(it.message.orEmpty())) }
    }

    fun reject(entry: TimeEntry, note: String) {
        viewModelScope.launch {
            runCatching { repository.rejectTimeEntry(entry, note) }
                .onSuccess { _message.value = UiMessage(R.string.vm_time_rejected) }
                .onFailure { _message.value = UiMessage(R.string.vm_couldnt_reject_time, listOf(it.message.orEmpty())) }
        }
    }
}
