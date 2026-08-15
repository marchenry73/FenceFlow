package com.fenceestimator.app.ui.jobs

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.ui.components.DraftTextField
import com.fenceestimator.app.ui.components.IntentHelpers
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Why a job didn't get finished, and telling the customer about it.
 *
 * The reasons a crew walks off a fence job are nearly always the customer's to
 * fix -- a locked gate, a dog in the yard, a hedge nobody cleared, an unmarked
 * sprinkler line. Left as a conversation between the foreman and the office it
 * gets forgotten, the customer hears nothing for a week, and by the time it
 * surfaces it is an argument about who delayed whom. Written on the job, with
 * a dated record of when the customer was told, it is just a scheduling note.
 */
@Composable
fun JobBlockedSection(job: Job, profile: BusinessProfile, viewModel: JobDetailViewModel) {
    val context = LocalContext.current
    val dateFormat = remember0()

    DraftTextField(
        stableKey = job.id,
        initialValue = job.blockedReason,
        label = "What stopped the job? (leave blank if nothing did)",
        minLines = 2,
        modifier = Modifier.fillMaxWidth()
    ) { text ->
        viewModel.update { j ->
            j.copy(
                blockedReason = text,
                // Stamp the first time a reason is written, and clear it again
                // if the reason is removed, so the date always means something.
                blockedAt = if (text.isBlank()) null else j.blockedAt ?: System.currentTimeMillis(),
                customerNotifiedAt = if (text.isBlank()) null else j.customerNotifiedAt
            )
        }
    }

    DraftTextField(
        stableKey = job.id,
        initialValue = job.customerMustClear,
        label = "What the customer needs to move or clear",
        minLines = 2,
        modifier = Modifier.fillMaxWidth()
    ) { text -> viewModel.update { j -> j.copy(customerMustClear = text) } }

    Text(
        "We clear leaves and loose debris. Anything needing a tool -- bushes, planters, " +
            "sheds, limbs, old posts -- is the customer's to clear, or it becomes a change order.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )

    if (job.blockedReason.isNotBlank()) {
        val message = blockedMessage(job, profile)

        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(
                containerColor = if (job.customerNotifiedAt == null)
                    MaterialTheme.colorScheme.errorContainer
                else MaterialTheme.colorScheme.secondaryContainer
            )
        ) {
            Column(Modifier.padding(12.dp)) {
                Text(
                    if (job.customerNotifiedAt == null) "Customer has NOT been told yet"
                    else "Customer told ${dateFormat.format(Date(job.customerNotifiedAt))}",
                    fontWeight = FontWeight.Bold,
                    color = if (job.customerNotifiedAt == null)
                        MaterialTheme.colorScheme.onErrorContainer
                    else MaterialTheme.colorScheme.onSecondaryContainer
                )
                job.blockedAt?.let {
                    Text(
                        "Held up since ${dateFormat.format(Date(it))}",
                        style = MaterialTheme.typography.bodySmall,
                        color = if (job.customerNotifiedAt == null)
                            MaterialTheme.colorScheme.onErrorContainer
                        else MaterialTheme.colorScheme.onSecondaryContainer
                    )
                }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
            OutlinedButton(
                onClick = {
                    IntentHelpers.openSmsDraft(context, job.phone, message)
                    viewModel.markCustomerNotified()
                },
                enabled = job.phone.isNotBlank(),
                modifier = Modifier.weight(1f)
            ) { Text("Text Customer") }

            Button(
                onClick = {
                    IntentHelpers.openEmailDraft(
                        context, job.email, "Update on your fence installation", message
                    )
                    viewModel.markCustomerNotified()
                },
                enabled = job.email.isNotBlank(),
                modifier = Modifier.weight(1f)
            ) { Text("Email Customer") }
        }
    }
}

/**
 * Plain, non-accusatory wording. The customer is being asked to do something,
 * so the message says what happened, what they need to do, and that the crew
 * comes back once it's done -- not who is at fault.
 */
private fun blockedMessage(job: Job, profile: BusinessProfile): String = buildString {
    append("Hi ${job.customerName.ifBlank { "there" }},\n\n")
    append("We weren't able to finish the fence at ${job.address.ifBlank { "your property" }} today.\n\n")
    append("What happened: ${job.blockedReason.trim()}\n")
    if (job.customerMustClear.isNotBlank()) {
        append("\nBefore we come back, we need this cleared:\n${job.customerMustClear.trim()}\n")
        append(
            "\nWe take care of leaves and loose debris ourselves. Anything needing tools " +
                "to move -- bushes, planters, sheds, limbs, old posts -- has to be cleared " +
                "by you, or we can quote it as extra work.\n"
        )
    }
    append("\nAs soon as that's sorted, give us a call and we'll get straight back out.\n\n")
    append(profile.businessName.ifBlank { "Thank you" })
    if (profile.phone.isNotBlank()) append("\n${profile.phone}")
}

@Composable
private fun remember0(): SimpleDateFormat =
    androidx.compose.runtime.remember { SimpleDateFormat("MMM d, yyyy", Locale.US) }
