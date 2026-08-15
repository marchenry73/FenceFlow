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
fun FieldChangesSection(changes: List<FieldChange>, viewModel: JobDetailViewModel) {
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

    val unseen = changes.count { !it.isAcknowledged }
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

    changes.forEach { change ->
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
