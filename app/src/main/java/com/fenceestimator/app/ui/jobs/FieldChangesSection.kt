package com.fenceestimator.app.ui.jobs

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Button
import com.fenceestimator.app.R
import com.fenceestimator.app.data.FieldChange
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * One thing the crew changed or reported on site -- a single row of
 * [JobChangesSection]'s field-changes half (JobDetailScreen.kt), which is
 * where the section this used to render on its own now lives (F2 on the
 * owner's list: merged with the drawing-changes half into one card).
 *
 * Not a request -- see [PlanRequestCard] for those. This is either a plain
 * report ("the run is now 138 ft") or a request already decided one way or
 * the other; either way there is nothing left to press here, only to read.
 *
 * [someone] and [timeFormat] are hoisted by the caller so every row in the
 * merged list shares one formatter and one fallback name instead of each row
 * rebuilding its own.
 */
@Composable
fun FieldChangeCard(change: FieldChange, someone: String, timeFormat: SimpleDateFormat) {
    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (change.isAcknowledged) MaterialTheme.colorScheme.surface
            else MaterialTheme.colorScheme.secondaryContainer
        )
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(change.summary, fontWeight = FontWeight.Medium)
            if (change.detail.isNotBlank()) {
                Text(change.detail, style = MaterialTheme.typography.bodySmall)
            }
            Text(
                buildString {
                    append(change.changedBy.ifBlank { someone })
                    if (change.changedByRole.isNotBlank()) append(" (${change.changedByRole})")
                    append(" · ${timeFormat.format(Date(change.at))}")
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

/**
 * One crew request, and the two answers to it.
 *
 * A reason is required to turn one down. "Rejected" with no explanation gets
 * the crew asking on the phone anyway, which is the call the request existed to
 * avoid -- and the person who has to explain it is standing in a yard rather
 * than sitting at a desk.
 *
 * Not private any more: [JobChangesSection] in JobDetailScreen.kt calls this
 * directly now that the "waiting on you" block lives in the merged section
 * instead of in a separate FieldChangesSection composable. Nothing about the
 * card itself changed -- same [canApprove] gate (APPROVE_PLAN_CHANGES, the
 * one this repo's field_changes UPDATE policy actually enforces
 * server-side), same self-approval shift rule, same required-reason-to-reject
 * rule.
 */
@Composable
fun PlanRequestCard(request: FieldChange, canApprove: Boolean, viewModel: JobDetailViewModel) {
    // Keyed on the request, or a note typed for one card carried over to the
    // next when the list changed underneath it.
    var note by remember(request.id) { mutableStateOf("") }

    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(request.summary, style = MaterialTheme.typography.titleSmall)
            if (request.detail.isNotBlank()) {
                Text(request.detail, style = MaterialTheme.typography.bodyMedium)
            }
            Text(
                listOfNotNull(
                    request.changedBy.takeIf { it.isNotBlank() },
                    request.changedByRole.takeIf { it.isNotBlank() }
                ).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            // Only somebody with the approval permission gets the buttons.
            // This screen is reachable by anyone who can open the job, and an
            // ungated Approve here let a crew member sign off the very change
            // they had just requested -- the self-approval rule covered shifts
            // and never this. The request stays visible to everyone: what is
            // being asked is not a secret, who may answer it is the rule.
            // The shift rule, one level up: holding the permission still does
            // not let you sign off the change you yourself asked for. The
            // record only carries a name, so the match is by name -- the same
            // fallback the shift check uses when there is no email to go on.
            val isOwnRequest = request.changedBy.isNotBlank() &&
                request.changedBy.trim().equals(viewModel.decidedByName.trim(), ignoreCase = true)
            if (canApprove && !isOwnRequest) {
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = { Text(stringResource(R.string.jsec_fc_answer_label)) },
                    modifier = Modifier.fillMaxWidth()
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = { viewModel.decidePlanChange(request, approved = true, note = note.trim()) },
                        modifier = Modifier.weight(1f)
                    ) { Text(stringResource(R.string.time_approve)) }
                    OutlinedButton(
                        // A reason is required to say no, but not to say yes -- yes
                        // needs no defending, and requiring one just slows the crew.
                        enabled = note.isNotBlank(),
                        onClick = { viewModel.decidePlanChange(request, approved = false, note = note.trim()) },
                        modifier = Modifier.weight(1f)
                    ) { Text(stringResource(R.string.jsec_fc_not_this_time)) }
                }
            } else {
                Text(
                    if (canApprove) stringResource(R.string.jsec_fc_own_request)
                    else stringResource(R.string.jsec_fc_waiting_office),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}
