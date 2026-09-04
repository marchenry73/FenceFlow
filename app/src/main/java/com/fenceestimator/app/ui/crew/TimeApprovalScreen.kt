package com.fenceestimator.app.ui.crew

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
    val snackbarHostState = remember { SnackbarHostState() }

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
                        "${pending.size} shift(s) waiting. Hours don't count towards pay " +
                            "or job cost until they're approved.",
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
        colors = if (suspiciouslyLong) {
            CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
        } else CardDefaults.cardColors()
    ) {
        Column(Modifier.padding(Space.card), verticalArrangement = Arrangement.spacedBy(Space.xs)) {
            Text(who, style = MaterialTheme.typography.titleMedium)
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

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.time_review_shift)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Space.row)) {
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
                    label = { Text(stringResource(R.string.time_note_crew_sees)) },
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            Button(
                enabled = timesValid,
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
