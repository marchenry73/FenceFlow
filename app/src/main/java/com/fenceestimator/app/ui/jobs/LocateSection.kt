package com.fenceestimator.app.ui.jobs

import android.app.DatePickerDialog
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Event
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.R
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.estimate.LocateTicket
import com.fenceestimator.app.ui.components.DraftTextField
import com.fenceestimator.app.ui.components.IntentHelpers
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * The utility locate, and whether anyone may dig yet.
 *
 * Coloured by state rather than left as a row of dates, because the question
 * somebody has on site is not "what are the dates" but "can I put a hole in
 * the ground". A screen that makes them work that out from three timestamps
 * is a screen they stop reading.
 *
 * It never blocks anything. Some jobs need no digging at all -- a gate rehung
 * on existing posts, a panel replaced -- and an app that refuses to let a
 * contractor work is one they stop using.
 */
@Composable
fun LocateSection(job: Job, viewModel: JobDetailViewModel) {
    val context = LocalContext.current
    val dateFormat = remember { SimpleDateFormat("EEE, MMM d", Locale.US) }
    val state = LocateTicket.stateOf(job)

    // Only the states that need attention are coloured. Making "clear" green
    // as well would mean every job on the list is shouting something, and then
    // none of them are.
    val container = when (state) {
        LocateTicket.State.EXPIRED -> MaterialTheme.colorScheme.errorContainer
        LocateTicket.State.WAITING -> MaterialTheme.colorScheme.tertiaryContainer
        LocateTicket.State.NONE -> MaterialTheme.colorScheme.surfaceVariant
        LocateTicket.State.CLEAR ->
            if (LocateTicket.expiringSoon(job)) MaterialTheme.colorScheme.tertiaryContainer
            else MaterialTheme.colorScheme.surfaceVariant
    }

    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = container)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                stringResource(
                    when (state) {
                        LocateTicket.State.NONE -> R.string.jsec_locate_none
                        LocateTicket.State.WAITING -> R.string.jsec_locate_waiting
                        LocateTicket.State.EXPIRED -> R.string.jsec_locate_expired
                        LocateTicket.State.CLEAR -> R.string.jsec_locate_clear
                    }
                ),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold
            )
            Text(
                LocateTicket.message(job),
                style = MaterialTheme.typography.bodyMedium
            )

            // Ringing 811 is the action, so it is a button rather than a phone
            // number somebody has to copy out.
            if (state == LocateTicket.State.NONE || state == LocateTicket.State.EXPIRED) {
                OutlinedButton(
                    onClick = { IntentHelpers.dial(context, "811") },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    androidx.compose.material3.Icon(Icons.Filled.Call, contentDescription = null)
                    Text("  " + stringResource(R.string.jsec_locate_call_811))
                }
            }

            DraftTextField(
                stableKey = job.id,
                initialValue = job.locateTicketNo,
                label = stringResource(R.string.jsec_locate_ticket_number),
                modifier = Modifier.fillMaxWidth()
            ) { text -> viewModel.update { it.copy(locateTicketNo = text.trim()) } }

            // Both dates come from what the locate service actually said. The
            // wait and the validity period differ by state and by utility, so
            // a date this app worked out for itself would be a confident guess
            // about something with legal weight.
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                DateButton(
                    label = stringResource(R.string.jsec_locate_dig_after),
                    value = job.locateDigAfter,
                    dateFormat = dateFormat,
                    modifier = Modifier.weight(1f)
                ) { chosen -> viewModel.update { it.copy(locateDigAfter = chosen) } }

                DateButton(
                    label = stringResource(R.string.jsec_locate_expires),
                    value = job.locateExpiresAt,
                    dateFormat = dateFormat,
                    modifier = Modifier.weight(1f)
                ) { chosen -> viewModel.update { it.copy(locateExpiresAt = chosen) } }
            }

            DraftTextField(
                stableKey = job.id,
                initialValue = job.locateNotes,
                label = stringResource(R.string.jsec_locate_marked_label),
                minLines = 2,
                modifier = Modifier.fillMaxWidth()
            ) { text -> viewModel.update { it.copy(locateNotes = text) } }

            Text(
                stringResource(R.string.jsec_locate_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun DateButton(
    label: String,
    value: Long?,
    dateFormat: SimpleDateFormat,
    modifier: Modifier = Modifier,
    onPick: (Long) -> Unit
) {
    val context = LocalContext.current
    OutlinedButton(
        onClick = {
            val cal = Calendar.getInstance()
            value?.let { cal.timeInMillis = it }
            DatePickerDialog(
                context,
                { _, year, month, day ->
                    val chosen = Calendar.getInstance()
                    // Start of day: a locate is valid for a date, not a moment,
                    // and an expiry stamped at the time somebody happened to
                    // tap would cut a day short.
                    chosen.set(year, month, day, 0, 0, 0)
                    chosen.set(Calendar.MILLISECOND, 0)
                    onPick(chosen.timeInMillis)
                },
                cal.get(Calendar.YEAR), cal.get(Calendar.MONTH), cal.get(Calendar.DAY_OF_MONTH)
            ).show()
        },
        modifier = modifier
    ) {
        androidx.compose.material3.Icon(Icons.Filled.Event, contentDescription = null)
        Text("  " + (value?.let { dateFormat.format(Date(it)) } ?: label))
    }
}
