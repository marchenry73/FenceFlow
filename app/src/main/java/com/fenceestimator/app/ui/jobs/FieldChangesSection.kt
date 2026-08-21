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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Button
import com.fenceestimator.app.data.FieldChange
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * What the crew changed on site, for whoever is running the job.
 *
 * The crew are allowed to correct the plan -- they're standing at the fence
 * line and the drawing isn't. But footage drives the estimate, the post count
 * and the material order, so a correction the office never sees is a job that
 * quietly stops matching what the customer agreed to pay. Unacknowledged
 * changes stay red until someone has actually looked at them.
 */
@Composable
fun FieldChangesSection(changes: List<FieldChange>, canApprove: Boolean, viewModel: JobDetailViewModel) {
    val timeFormat = remember { SimpleDateFormat("MMM d, h:mm a", Locale.US) }

    if (changes.isEmpty()) {
        Text(
            "Nothing changed on site yet. If the crew corrects the plan — a longer run, " +
                "a gate moved — it shows up here.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        return
    }

    // Requests come first and stay first. A crew standing at a fence line
    // waiting on an answer is a different thing from a note about work already
    // done, and burying the first among the second is how they end up waiting
    // all afternoon.
    val waiting = changes.filter { it.isAwaitingDecision }
    if (waiting.isNotEmpty()) {
        Card(
            Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer)
        ) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    "The crew are waiting on you",
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onTertiaryContainer
                )
                Text(
                    "They have stopped rather than build it different. Answer and they carry on.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onTertiaryContainer
                )
            }
        }
        waiting.forEach { request -> PlanRequestCard(request, canApprove, viewModel) }
    }

    val unseen = changes.count { !it.isAcknowledged && !it.isAwaitingDecision }
    if (unseen > 0) {
        Card(
            Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
        ) {
            Row(
                Modifier.fillMaxWidth().padding(12.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically
            ) {
                Text(
                    "$unseen change${if (unseen == 1) "" else "s"} you haven't seen",
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onErrorContainer
                )
                OutlinedButton(onClick = { viewModel.acknowledgeFieldChanges() }) {
                    Text("Mark seen")
                }
            }
        }
    }

    changes.filter { !it.isAwaitingDecision }.forEach { change ->
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
                        append(change.changedBy.ifBlank { "Someone" })
                        if (change.changedByRole.isNotBlank()) append(" (${change.changedByRole})")
                        append(" · ${timeFormat.format(Date(change.at))}")
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }

    Text(
        "If the footage moved, re-run Suggest Quantities on the estimate so the material " +
            "order matches what's actually being built.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
}

/**
 * One crew request, and the two answers to it.
 *
 * A reason is required to turn one down. "Rejected" with no explanation gets
 * the crew asking on the phone anyway, which is the call the request existed to
 * avoid -- and the person who has to explain it is standing in a yard rather
 * than sitting at a desk.
 */
@Composable
private fun PlanRequestCard(request: FieldChange, canApprove: Boolean, viewModel: JobDetailViewModel) {
    var note by remember { mutableStateOf("") }

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
            if (canApprove) {
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = { Text("Answer (the crew will see this)") },
                    modifier = Modifier.fillMaxWidth()
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = { viewModel.decidePlanChange(request, approved = true, note = note.trim()) },
                        modifier = Modifier.weight(1f)
                    ) { Text("Approve") }
                    OutlinedButton(
                        // A reason is required to say no, but not to say yes -- yes
                        // needs no defending, and requiring one just slows the crew.
                        enabled = note.isNotBlank(),
                        onClick = { viewModel.decidePlanChange(request, approved = false, note = note.trim()) },
                        modifier = Modifier.weight(1f)
                    ) { Text("Not this time") }
                }
            } else {
                Text(
                    "Waiting on the office to answer.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}
