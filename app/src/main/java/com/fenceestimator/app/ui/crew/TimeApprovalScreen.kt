package com.fenceestimator.app.ui.crew

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.R
import com.fenceestimator.app.data.TimeEntry
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.Money
import com.fenceestimator.app.ui.components.currentApp
import com.fenceestimator.app.ui.components.resolve
import com.fenceestimator.app.ui.theme.Space
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Shifts waiting to be signed off.
 *
 * Hours become pay and become job cost, and both are wrong if a clock ran
 * through lunch or somebody forgot to clock out until the next morning. Neither
 * is dishonesty -- it is what happens on a site -- which is exactly why a shift
 * is a claim until someone has looked at it.
 *
 * Correcting the times is offered alongside approving, because "reject" is
 * usually the wrong tool: the crew did work that day, the figure is just wrong.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TimeApprovalScreen(onBack: () -> Unit) {
    val app = currentApp()
    val viewModel: TimeApprovalViewModel = viewModel(
        // With who is signed in, or the own-shift guard has nothing to
        // compare against and fails open.
        factory = GenericViewModelFactory {
            TimeApprovalViewModel(
                app.repository,
                app.session.state.value.email,
                null
            )
        }
    )
    val session by app.session.state.collectAsState()
    val pending by viewModel.pending.collectAsState()
    val employees by viewModel.employees.collectAsState()
    val fixableEmployees by viewModel.fixableEmployees.collectAsState()
    val jobs by viewModel.jobs.collectAsState()

    // Nobody signs off the shift that pays them, whatever their role. A crew
    // lead approves their team; that is what makes them a lead. This is not
    // about trust -- it is what lets the timesheet be shown to an accountant,
    // or to the person being paid, without an argument about who approved it.
    val ownShift: (TimeEntry) -> Boolean = { entry ->
        com.fenceestimator.app.cloud.OwnWork.isOwnShift(
            entry, employees, session.email, null
        )
    }

    var reviewing by remember { mutableStateOf<TimeEntry?>(null) }
    var fixing by remember { mutableStateOf<TimeEntry?>(null) }
    var discarding by remember { mutableStateOf<TimeEntry?>(null) }
    val syncBlocked by viewModel.syncBlocked.collectAsState()
    val disputed by viewModel.disputed.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    val message by viewModel.message.collectAsState()
    val messageText = message?.resolve()
    LaunchedEffect(message) { messageText?.let { snackbarHostState.showSnackbar(it) } }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.time_hours_to_approve)) },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                }
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) }
    ) { padding ->
        if (!session.canApproveTime) {
            Column(Modifier.fillMaxSize().padding(padding).padding(Space.xl)) {
                Text(
                    "You don't have \"Approve crew hours\". Ask an owner if you should.",
                    style = MaterialTheme.typography.bodyLarge
                )
            }
            return@Scaffold
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(Space.screen),
            verticalArrangement = Arrangement.spacedBy(Space.row)
        ) {
            // Shown first -- these are the ones actually going wrong. A shift
            // simply waiting for a signature is normal; one the cloud has
            // permanently refused is not, and burying it below the ordinary
            // queue is how "2 of 7 rows rejected, every sync" went unnoticed
            // for as long as it did.
            if (syncBlocked.isNotEmpty()) {
                item {
                    Text(
                        stringResource(R.string.time_shifts_cannot_upload_note, syncBlocked.size),
                        style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.error
                    )
                }
                items(syncBlocked, key = { "blocked-${it.id}" }) { entry ->
                    SyncBlockedShiftCard(
                        entry = entry,
                        who = employees.firstOrNull { it.id == entry.employeeId }?.name,
                        jobName = jobs.firstOrNull { it.id == entry.jobId }?.customerName.orEmpty(),
                        onFix = { fixing = entry },
                        onDiscard = { discarding = entry }
                    )
                }
            }

            // Hours somebody has objected to, whether or not they were signed
            // off already. Above the ordinary queue because a person is waiting
            // on an answer about their own pay; below the blocked shifts
            // because those are hours that exist nowhere but this handset.
            //
            // Not dismissible, and carrying no decision control. The record has
            // no "settled" flag on purpose (supabase_shift_dispute.sql: a
            // dispute puts a flag and a sentence beside the hours and leaves
            // the office to settle it), so a button here could only pretend to
            // close something. An objection leaves this list when the times it
            // was about are corrected again.
            if (disputed.isNotEmpty()) {
                item {
                    Text(
                        stringResource(R.string.time_disputed_heading, disputed.size),
                        style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.error
                    )
                }
                items(disputed, key = { "disputed-${it.id}" }) { entry ->
                    DisputedShiftCard(
                        entry = entry,
                        who = employees.firstOrNull { it.id == entry.employeeId }?.name,
                        jobName = jobs.firstOrNull { it.id == entry.jobId }?.customerName.orEmpty()
                    )
                }
            }

            if (pending.isEmpty()) {
                item {
                    Text(
                        "Nothing waiting. Hours appear here when the crew clock out.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            } else {
                item {
                    Text(
                        stringResource(R.string.crew_shifts_waiting_note, pending.size),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            items(pending, key = { it.id }) { entry ->
                PendingShiftCard(
                    entry = entry,
                    who = employees.firstOrNull { it.id == entry.employeeId }?.name ?: "Unassigned",
                    jobName = jobs.firstOrNull { it.id == entry.jobId }?.customerName.orEmpty(),
                    isOwn = ownShift(entry),
                    onReview = { reviewing = entry }
                )
            }
        }
    }

    reviewing?.let { entry ->
        ReviewShiftDialog(
            entry = entry,
            onApprove = { start, end, note ->
                viewModel.approve(entry, session.email ?: "Manager", start, end, note)
                reviewing = null
            },
            onReject = { note ->
                viewModel.reject(entry, note)
                reviewing = null
            },
            onDismiss = { reviewing = null }
        )
    }

    fixing?.let { entry ->
        FixShiftDialog(
            // Only people with a sync id: anyone else would be refused again.
            employees = fixableEmployees,
            defaultEmployeeId = viewModel.ownEmployeeId(),
            onConfirm = { employeeId ->
                viewModel.fixAndRetry(entry, employeeId)
                fixing = null
            },
            onDismiss = { fixing = null }
        )
    }

    discarding?.let { entry ->
        AlertDialog(
            onDismissRequest = { discarding = null },
            title = { Text(stringResource(R.string.time_discard_shift_title)) },
            text = {
                Text(
                    stringResource(
                        R.string.time_discard_shift_body,
                        "%.2f".format(entry.hours)
                    )
                )
            },
            confirmButton = {
                Button(onClick = {
                    viewModel.discardBlocked(entry)
                    discarding = null
                }) { Text(stringResource(R.string.time_discard_shift_confirm)) }
            },
            dismissButton = {
                OutlinedButton(onClick = { discarding = null }) {
                    Text(stringResource(R.string.action_cancel))
                }
            }
        )
    }
}

/** One shift the cloud will never accept as it stands. */
@Composable
private fun SyncBlockedShiftCard(
    entry: TimeEntry,
    who: String?,
    jobName: String,
    onFix: () -> Unit,
    onDiscard: () -> Unit
) {
    val dayFormat = remember { SimpleDateFormat("EEE d MMM", Locale.US) }
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
    ) {
        Column(Modifier.padding(Space.card), verticalArrangement = Arrangement.spacedBy(Space.xs)) {
            Text(
                who ?: stringResource(R.string.time_no_worker_set),
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onErrorContainer
            )
            if (jobName.isNotBlank()) {
                Text(jobName, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onErrorContainer)
            }
            Text(dayFormat.format(Date(entry.startedAt)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onErrorContainer)
            Text(
                entry.syncBlockedDetail ?: stringResource(R.string.time_generic_sync_blocked_detail),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onErrorContainer
            )
            Row(horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                Button(onClick = onFix) { Text(stringResource(R.string.time_fix_shift)) }
                OutlinedButton(onClick = onDiscard) { Text(stringResource(R.string.time_discard_shift)) }
            }
        }
    }
}

/**
 * One shift its own crew member says is wrong.
 *
 * NO money figure anywhere on this card, deliberately. A FOREMAN reaches this
 * screen with APPROVE_TIME and without SEE_PAY, and such a phone reads shifts
 * through a view with no hourly_rate column at all -- so anything derived from
 * the rate would render as $0.00 and read as "these hours are worth nothing",
 * which is the opposite of what an objection about pay needs to say. The times
 * and the hours are what is being argued about anyway.
 *
 * Shows what the clock said next to what it was changed to, then the reason
 * given for the change, then the crew member's words. In that order because the
 * objection can only be judged against the change it answers.
 */
@Composable
private fun DisputedShiftCard(
    entry: TimeEntry,
    who: String?,
    jobName: String
) {
    val dayFormat = remember { SimpleDateFormat("EEE d MMM", Locale.US) }
    val timeFormat = remember { SimpleDateFormat("h:mm a", Locale.US) }
    fun at(millis: Long?): String = millis?.let { timeFormat.format(Date(it)) }.orEmpty()

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
    ) {
        Column(Modifier.padding(Space.card), verticalArrangement = Arrangement.spacedBy(Space.xs)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Filled.WarningAmber,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onErrorContainer
                )
                Text(
                    "  " + stringResource(R.string.time_dispute_badge),
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onErrorContainer
                )
            }
            Text(
                who ?: stringResource(R.string.time_no_worker_set),
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onErrorContainer
            )
            if (jobName.isNotBlank()) {
                Text(
                    jobName,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onErrorContainer
                )
            }
            Text(
                dayFormat.format(Date(entry.startedAt)),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onErrorContainer
            )
            // Each original is written by the trigger only for the time that
            // actually moved, so a start that was never touched has none --
            // falling back to the current value keeps the line readable
            // instead of printing a gap.
            if (entry.originalStartedAt != null || entry.originalEndedAt != null) {
                Text(
                    stringResource(
                        R.string.time_dispute_times_changed,
                        at(entry.originalStartedAt ?: entry.startedAt),
                        at(entry.originalEndedAt ?: entry.endedAt),
                        at(entry.startedAt),
                        at(entry.endedAt)
                    ),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onErrorContainer
                )
            }
            if (entry.correctionReason.isNotBlank()) {
                Text(
                    stringResource(R.string.time_dispute_our_reason, entry.correctionReason),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onErrorContainer
                )
            }
            Text(
                stringResource(R.string.time_dispute_their_note, entry.disputeNote),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onErrorContainer
            )
            Text(
                stringResource(
                    if (entry.isApproved) R.string.time_dispute_already_approved
                    else R.string.time_dispute_still_waiting
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onErrorContainer
            )
            Text(
                stringResource(R.string.time_dispute_settle_note),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onErrorContainer
            )
        }
    }
}

/** Picks who worked the shift, defaulting to the signed-in person's own record when linked. */
@Composable
private fun FixShiftDialog(
    employees: List<com.fenceestimator.app.data.Employee>,
    defaultEmployeeId: Long?,
    onConfirm: (Long) -> Unit,
    onDismiss: () -> Unit
) {
    var selected by remember {
        mutableStateOf(defaultEmployeeId ?: employees.firstOrNull()?.id)
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.time_fix_shift_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Space.xs)) {
                Text(stringResource(R.string.time_fix_shift_prompt))
                if (employees.isEmpty()) {
                    Text(stringResource(R.string.time_fix_shift_nobody_available))
                }
                employees.forEach { employee ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { selected = employee.id }
                    ) {
                        androidx.compose.material3.RadioButton(
                            selected = selected == employee.id,
                            onClick = { selected = employee.id }
                        )
                        Text(employee.name)
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { selected?.let(onConfirm) },
                enabled = selected != null
            ) { Text(stringResource(R.string.time_fix_shift_confirm)) }
        },
        dismissButton = {
            OutlinedButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
        }
    )
}

@Composable
private fun PendingShiftCard(
    entry: TimeEntry,
    who: String,
    jobName: String,
    /** The signed-in person's own shift, which they may not sign off. */
    isOwn: Boolean,
    onReview: () -> Unit
) {
    val dayFormat = remember { SimpleDateFormat("EEE d MMM", Locale.US) }
    val timeFormat = remember { SimpleDateFormat("h:mm a", Locale.US) }
    // A shift this long is nearly always a clock left running overnight, and
    // it is the single most expensive mistake to wave through.
    val suspiciouslyLong = entry.hours > LONG_SHIFT_HOURS

    Card(
        // Not tappable when it is your own: the reason is stated below rather
        // than leaving a card that silently does nothing when pressed.
        onClick = { if (!isOwn) onReview() },
        modifier = Modifier.fillMaxWidth(),
        colors = if (suspiciouslyLong || entry.hasOpenDispute) {
            CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
        } else CardDefaults.cardColors()
    ) {
        Column(Modifier.padding(Space.card), verticalArrangement = Arrangement.spacedBy(Space.xs)) {
            Text(who, style = MaterialTheme.typography.titleMedium)
            // A shift can be disputed and still be waiting for sign-off -- the
            // office can correct the hours without approving them in the same
            // breath. Flagged on the card as well as in the dialog so the queue
            // itself says which one to open first.
            if (entry.hasOpenDispute) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        Icons.Filled.WarningAmber,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onErrorContainer
                    )
                    Text(
                        "  " + stringResource(R.string.time_dispute_badge),
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onErrorContainer
                    )
                }
            }
            if (isOwn) {
                Text(
                    "Your own shift. Someone else has to sign this one off.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error
                )
            }
            if (jobName.isNotBlank()) {
                Text(
                    jobName,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Text(
                dayFormat.format(Date(entry.startedAt)) + "  " +
                    timeFormat.format(Date(entry.startedAt)) + " - " +
                    (entry.endedAt?.let { timeFormat.format(Date(it)) } ?: "still running"),
                style = MaterialTheme.typography.bodyMedium
            )
            Text(
                "%.2f hours".format(entry.hours) +
                    if (entry.hourlyRate > 0.0) "  =  " + Money.format(entry.claimedCost) else "",
                style = MaterialTheme.typography.bodyMedium
            )
            if (suspiciouslyLong) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = Space.xs)) {
                    Icon(
                        Icons.Filled.WarningAmber,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onErrorContainer
                    )
                    Text(
                        "  Over ${LONG_SHIFT_HOURS.toInt()} hours -- check the clock wasn't left running.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onErrorContainer
                    )
                }
            }
        }
    }
}

/**
 * Review one shift.
 *
 * Times are editable here on purpose. Rejecting a shift the crew genuinely
 * worked, because the finish time is half an hour out, is how a crew learns the
 * clock is not worth using.
 */
@Composable
private fun ReviewShiftDialog(
    entry: TimeEntry,
    onApprove: (Long?, Long?, String) -> Unit,
    onReject: (String) -> Unit,
    onDismiss: () -> Unit
) {
    val timeFormat = remember { SimpleDateFormat("HH:mm", Locale.US) }
    var startText by remember { mutableStateOf(timeFormat.format(Date(entry.startedAt))) }
    var endText by remember {
        mutableStateOf(entry.endedAt?.let { timeFormat.format(Date(it)) }.orEmpty())
    }
    var note by remember { mutableStateOf("") }

    fun parsed(text: String, sameDayAs: Long): Long? {
        val parts = text.split(":")
        if (parts.size != 2) return null
        val hour = parts[0].trim().toIntOrNull() ?: return null
        val minute = parts[1].trim().toIntOrNull() ?: return null
        if (hour !in 0..23 || minute !in 0..59) return null
        val cal = java.util.Calendar.getInstance().apply {
            timeInMillis = sameDayAs
            set(java.util.Calendar.HOUR_OF_DAY, hour)
            set(java.util.Calendar.MINUTE, minute)
            set(java.util.Calendar.SECOND, 0)
            set(java.util.Calendar.MILLISECOND, 0)
        }
        return cal.timeInMillis
    }

    val newStart = parsed(startText, entry.startedAt)
    val newEnd = entry.endedAt?.let { parsed(endText, it) }
    val timesValid = newStart != null && newEnd != null && newEnd > newStart
    val correctedHours = if (timesValid) (newEnd!! - newStart!!) / 3_600_000.0 else entry.hours
    // A correction is a different act from an approval: it goes to the server
    // through correct_time_entry, it is recorded against the person who made
    // it, and the crew member reads the reason. So the note stops being
    // optional the moment either time actually moves -- judged by the same
    // function the ViewModel uses to decide whether to send a correction at
    // all, or the screen would ask for a reason the sync never uses (or
    // worse, not ask for one it does).
    val timesChanged = timesValid && shiftTimesMoved(entry, newStart, newEnd)
    val reasonMissing = timesChanged && note.isBlank()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.time_review_shift)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Space.row)) {
                // First thing in the dialog, above the times and well above
                // the Approve button. Approving anyway is legitimate -- the
                // office may be right and the crew member wrong -- so this
                // does not block anything; what it makes impossible is signing
                // the hours off without having been shown what the person
                // being paid said was wrong with them.
                if (entry.hasOpenDispute) {
                    Column(verticalArrangement = Arrangement.spacedBy(Space.xs)) {
                        Text(
                            stringResource(R.string.time_dispute_badge),
                            style = MaterialTheme.typography.titleSmall,
                            color = MaterialTheme.colorScheme.error
                        )
                        Text(
                            stringResource(R.string.time_dispute_their_note, entry.disputeNote),
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.error
                        )
                    }
                }
                Text(
                    "Correct the times if the clock ran through a break or was left " +
                        "running, then approve. Approving is what makes these hours count.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Row(horizontalArrangement = Arrangement.spacedBy(Space.row)) {
                    OutlinedTextField(
                        value = startText,
                        onValueChange = { startText = it },
                        label = { Text(stringResource(R.string.time_start_hhmm)) },
                        isError = newStart == null,
                        singleLine = true,
                        modifier = Modifier.weight(1f)
                    )
                    OutlinedTextField(
                        value = endText,
                        onValueChange = { endText = it },
                        label = { Text(stringResource(R.string.time_end_hhmm)) },
                        isError = newEnd == null,
                        singleLine = true,
                        modifier = Modifier.weight(1f)
                    )
                }
                Text(
                    "%.2f hours".format(correctedHours) +
                        if (entry.hourlyRate > 0.0) "  =  " + Money.format(correctedHours * entry.hourlyRate) else "",
                    style = MaterialTheme.typography.titleMedium
                )
                if (!timesValid) {
                    Text(
                        "Enter both times as HH:mm, with the end after the start.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error
                    )
                }
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = {
                        Text(
                            stringResource(
                                if (timesChanged) R.string.time_correction_reason
                                else R.string.time_note_crew_sees
                            )
                        )
                    },
                    isError = reasonMissing,
                    modifier = Modifier.fillMaxWidth()
                )
                if (timesChanged) {
                    Text(
                        stringResource(R.string.time_correction_reason_why),
                        style = MaterialTheme.typography.bodySmall,
                        color = if (reasonMissing) MaterialTheme.colorScheme.error
                                else MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        },
        confirmButton = {
            Button(
                // A correction with no reason is refused by the server anyway;
                // refusing it here costs a round trip less and says why.
                enabled = timesValid && !reasonMissing,
                onClick = { onApprove(newStart, newEnd, note.trim()) }
            ) { Text(stringResource(R.string.time_approve)) }
        },
        dismissButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                OutlinedButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
                OutlinedButton(
                    // A reason is required. "Rejected" with no explanation is
                    // how a crew member finds out at payday and nobody can say
                    // why.
                    enabled = note.isNotBlank(),
                    onClick = { onReject(note.trim()) }
                ) { Text(stringResource(R.string.time_send_back)) }
            }
        }
    )
}

/** Longer than a legitimate day on a fence line; almost always a clock left running. */
private const val LONG_SHIFT_HOURS = 14.0
