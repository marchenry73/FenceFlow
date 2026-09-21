package com.fenceestimator.app.ui.crew

import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.TimeApproval
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
     * Shifts the cloud has refused -- see [TimeEntry.isSyncBlocked]. A
     * SERVER_REJECTED one is tried once more by
     * [com.fenceestimator.app.cloud.EntitySync.pushTimeEntries] when its mark
     * expires ([com.fenceestimator.app.cloud.isDueForPush]) and leaves this
     * list by itself if it goes up; otherwise it leaves by [fixAndRetry] or by
     * being discarded. A NEEDS_WORKER one leaves when its worker resolves.
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
     * NEITHER half of this rides the ordinary sync any more, and both for the
     * same reason: [com.fenceestimator.app.cloud.EntitySync.pushTimeEntries]
     * cannot carry them.
     *
     * The correction could not, because the only push pass that carries
     * started_at/ended_at is insert-only -- a no-op for a row the cloud
     * already holds. That split is deliberate (it stops a phone re-asserting
     * its original times over an office correction) and it meant a correction
     * typed here was applied to Room, shown as "Approved", and then quietly
     * reverted by the next pull. Payroll paid the uncorrected hours. Fixed by
     * [com.fenceestimator.app.cloud.TimeCorrection].
     *
     * The DECISION could not either, and that was worse, because it failed for
     * the very person this screen exists for. A FOREMAN has APPROVE_TIME and
     * not SEE_PAY, and `time_entries_pay_needs_see_pay` hides a colleague's
     * whole row from anyone without SEE_PAY -- so the update the push sends
     * matched 0 rows on a plain UPDATE and was refused 42501 on the real
     * upsert shape, which PostgREST returns as a 403 and the sync retries for
     * ever. Measured live; see
     * [com.fenceestimator.app.cloud.TimeApproval] and
     * `supabase_p3_approve_time_entry.sql`.
     *
     * So both go through their own SECURITY DEFINER door, and the screen is
     * told what the SERVER stored rather than what was typed. If either cannot
     * be sent, the shift is NOT approved and the message says so; the one
     * thing this must never do is show "Approved" over a decision the office
     * will never see.
     */
    fun approve(
        entry: TimeEntry,
        approvedBy: String,
        correctedStart: Long?,
        correctedEnd: Long?,
        note: String
    ) {
        // Checked here as well as in the UI, because a control that is merely
        // hidden is not a control -- and because the server now refuses it
        // outright, so a silent return would leave somebody tapping a dead
        // button. This says the same sentence the database would.
        if (isOwnShift(entry)) {
            _message.value = UiMessage(R.string.vm_time_cannot_decide_own)
            return
        }

        val newStart = correctedStart ?: entry.startedAt
        val newEnd = correctedEnd ?: entry.endedAt
        val timesChanged = shiftTimesMoved(entry, newStart, newEnd)

        viewModelScope.launch {
            if (!timesChanged) {
                // Nothing to correct -- the ordinary sign-off. This is payroll:
                // a dialog that just closes leaves nobody able to tell a saved
                // approval from one the database silently dropped.
                sendDecision(entry, approve = true, note = note,
                    startedAt = entry.startedAt, endedAt = entry.endedAt,
                    approvedBy = approvedBy, corrected = false)
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
                    sendDecision(
                        entry.copy(
                            originalStartedAt = sent.originalStartedAt ?: entry.originalStartedAt,
                            originalEndedAt = sent.originalEndedAt ?: entry.originalEndedAt,
                            correctedAt = sent.correctedAt ?: entry.correctedAt,
                            correctionReason = sent.correctionReason.ifBlank { entry.correctionReason }
                        ),
                        approve = true, note = note,
                        startedAt = sent.startedAt, endedAt = sent.endedAt,
                        approvedBy = approvedBy, corrected = true
                    )

                // The cloud has never seen this shift, so there is nothing
                // there to correct -- and the insert-only pass, the one that
                // DOES carry the clock and the decision, will send the
                // corrected times as the shift's first and only version.
                // Stamped locally the way preserve_original_shift would have,
                // so the phone still shows what the clock said next to what it
                // was changed to.
                TimeCorrection.Outcome.NotInCloudYet ->
                    sendDecision(
                        stampedLocally(entry, newStart, correctedEndAt, note),
                        approve = true, note = note,
                        startedAt = newStart, endedAt = correctedEndAt,
                        approvedBy = approvedBy, corrected = true
                    )

                // One person working alone on their own phone: no cloud to
                // send anything to, and nothing to be wrong about.
                TimeCorrection.Outcome.NotSignedIn ->
                    sendDecision(
                        stampedLocally(entry, newStart, correctedEndAt, note),
                        approve = true, note = note,
                        startedAt = newStart, endedAt = correctedEndAt,
                        approvedBy = approvedBy, corrected = true
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

    /**
     * The one place a sign-off or a rejection is sent and then written down.
     *
     * The order matters and is the whole point: the SERVER decides first, and
     * Room is only written when the server has actually stored the decision or
     * when there is provably no server to store it in
     * ([com.fenceestimator.app.cloud.TimeApproval.Outcome.NotInCloudYet],
     * where the insert pass will carry it, and
     * [com.fenceestimator.app.cloud.TimeApproval.Outcome.NotSignedIn], where
     * this phone is the only record there is). A refusal or a dead connection
     * writes NOTHING and leaves the shift in the queue, because the update
     * push no longer carries approved_at/rejected_at at all -- so a decision
     * written locally and refused by the server would sit on the handset for
     * ever, shown as settled, while the office still saw it pending. That is
     * the shape of the bug this whole change exists to close, and it would be
     * a new instance of it.
     *
     * @param corrected true when the clock was changed in the same action, so
     *   the confirmation says so.
     */
    private suspend fun sendDecision(
        entry: TimeEntry,
        approve: Boolean,
        note: String,
        startedAt: Long,
        endedAt: Long?,
        approvedBy: String,
        corrected: Boolean
    ) {
        // One row of message ids per outcome, picked up front so the branches
        // below read as what happened rather than as string bookkeeping.
        @StringRes val savedMessage: Int = when {
            !approve -> R.string.vm_time_rejected
            corrected -> R.string.vm_time_corrected_and_approved
            else -> R.string.vm_time_approved
        }
        @StringRes val willSyncMessage: Int = when {
            !approve -> R.string.vm_time_rejected_will_sync
            corrected -> R.string.vm_time_corrected_will_sync
            else -> R.string.vm_time_approved_will_sync
        }
        @StringRes val thisPhoneMessage: Int = when {
            !approve -> R.string.vm_time_rejected_on_this_phone
            corrected -> R.string.vm_time_corrected_on_this_phone
            else -> R.string.vm_time_approved_on_this_phone
        }
        @StringRes val failureMessage: Int =
            if (approve) R.string.vm_couldnt_approve_time else R.string.vm_couldnt_reject_time

        // Written down only after the answer comes back, and always from what
        // the answer carried rather than from what was typed.
        suspend fun store(row: TimeEntry, success: Int) {
            runCatching { repository.updateTimeEntry(row) }
                .onSuccess { _message.value = UiMessage(success) }
                .onFailure { _message.value = UiMessage(failureMessage, listOf(it.message.orEmpty())) }
        }

        when (val sent = TimeApproval.decide(entry.syncId, approve, note)) {
            is TimeApproval.Outcome.Saved -> store(
                entry.copy(
                    startedAt = startedAt,
                    endedAt = endedAt ?: entry.endedAt,
                    // approvedBy is the server's, derived from the signed-in
                    // person's profile -- not the string this screen guessed
                    // at from an email address.
                    approvedAt = sent.approvedAt,
                    approvedBy = sent.approvedBy,
                    rejectedAt = sent.rejectedAt,
                    reviewNote = sent.reviewNote
                ),
                savedMessage
            )

            // No row in the cloud to decide about yet. The insert-only pass is
            // the one pass that still carries approved_at/rejected_at, and it
            // is the pass a brand new shift goes up on, so stamping it here is
            // what makes the decision travel with it.
            TimeApproval.Outcome.NotInCloudYet -> store(
                localDecision(entry, approve, approvedBy, note, startedAt, endedAt), willSyncMessage
            )

            // One person working alone on their own phone: no cloud, nothing
            // to be wrong about.
            TimeApproval.Outcome.NotSignedIn -> store(
                localDecision(entry, approve, approvedBy, note, startedAt, endedAt), thisPhoneMessage
            )

            // The server answered no. Its own sentence, verbatim -- it names
            // the actual rule ("needs APPROVE_TIME", "cannot be signed off by
            // the person being paid for it") and sending someone hunting for
            // an hour instead is the thing to avoid.
            is TimeApproval.Outcome.Refused ->
                _message.value = UiMessage(
                    if (approve) R.string.vm_time_approval_refused
                    else R.string.vm_time_rejection_refused,
                    listOf(sent.detail)
                )

            // Nothing was saved anywhere. Said plainly, because the shift is
            // still in the queue and the person needs to know to come back to
            // it rather than assume it went through.
            TimeApproval.Outcome.Unreachable ->
                _message.value = UiMessage(
                    if (approve) R.string.vm_time_approval_unreachable
                    else R.string.vm_time_rejection_unreachable
                )
        }
    }

    /**
     * The decision written with this phone's own clock, for the two cases
     * where there is genuinely nothing on the server to read it back from.
     *
     * Mirrors what `approve_time_entry` writes, column for column, so a shift
     * decided offline and one decided against the cloud end up in the same
     * shape: a decision is an approval OR a rejection, never both.
     */
    private fun localDecision(
        entry: TimeEntry,
        approve: Boolean,
        approvedBy: String,
        note: String,
        startedAt: Long,
        endedAt: Long?
    ): TimeEntry = entry.copy(
        startedAt = startedAt,
        endedAt = endedAt ?: entry.endedAt,
        approvedAt = if (approve) System.currentTimeMillis() else null,
        approvedBy = if (approve) approvedBy else "",
        rejectedAt = if (approve) null else System.currentTimeMillis(),
        reviewNote = note
    )

    fun reject(entry: TimeEntry, note: String) {
        // The same rule as [approve], and the server applies it to a rejection
        // too: the own-shift test in approve_time_entry runs before it looks at
        // which way the decision goes. Sending your own hours back with a note
        // is still deciding your own hours.
        if (isOwnShift(entry)) {
            _message.value = UiMessage(R.string.vm_time_cannot_decide_own)
            return
        }
        viewModelScope.launch {
            sendDecision(
                entry, approve = false, note = note,
                startedAt = entry.startedAt, endedAt = entry.endedAt,
                approvedBy = "", corrected = false
            )
        }
    }
}
