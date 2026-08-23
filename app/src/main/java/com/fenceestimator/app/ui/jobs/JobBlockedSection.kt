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
import android.content.Context
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.R
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
        label = stringResource(R.string.jsec_blocked_reason_label),
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
        label = stringResource(R.string.jsec_blocked_must_clear_label),
        minLines = 2,
        modifier = Modifier.fillMaxWidth()
    ) { text -> viewModel.update { j -> j.copy(customerMustClear = text) } }

    Text(
        stringResource(R.string.jsec_blocked_debris_hint),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )

    if (job.blockedReason.isNotBlank()) {
        val message = blockedMessage(context, job, profile)
        val emailSubject = stringResource(R.string.jsec_blocked_email_subject)

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
                    if (job.customerNotifiedAt == null) stringResource(R.string.jsec_blocked_not_told)
                    else stringResource(R.string.jsec_blocked_told_on, dateFormat.format(Date(job.customerNotifiedAt))),
                    fontWeight = FontWeight.Bold,
                    color = if (job.customerNotifiedAt == null)
                        MaterialTheme.colorScheme.onErrorContainer
                    else MaterialTheme.colorScheme.onSecondaryContainer
                )
                job.blockedAt?.let {
                    Text(
                        stringResource(R.string.jsec_blocked_held_since, dateFormat.format(Date(it))),
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
            ) { Text(stringResource(R.string.jsec_blocked_text_customer)) }

            Button(
                onClick = {
                    IntentHelpers.openEmailDraft(
                        context, job.email, emailSubject, message
                    )
                    viewModel.markCustomerNotified()
                },
                enabled = job.email.isNotBlank(),
                modifier = Modifier.weight(1f)
            ) { Text(stringResource(R.string.jsec_blocked_email_customer)) }
        }
    }
}

/**
 * Plain, non-accusatory wording. The customer is being asked to do something,
 * so the message says what happened, what they need to do, and that the crew
 * comes back once it's done -- not who is at fault.
 */
private fun blockedMessage(context: Context, job: Job, profile: BusinessProfile): String = buildString {
    append(context.getString(R.string.jsec_blocked_msg_hi, job.customerName.ifBlank { context.getString(R.string.jsec_greeting_there) }))
    append("\n\n")
    append(context.getString(R.string.jsec_blocked_msg_unable, job.address.ifBlank { context.getString(R.string.jsec_blocked_msg_your_property) }))
    append("\n\n")
    append(context.getString(R.string.jsec_blocked_msg_what_happened, job.blockedReason.trim()))
    append("\n")
    if (job.customerMustClear.isNotBlank()) {
        append("\n")
        append(context.getString(R.string.jsec_blocked_msg_need_cleared))
        append("\n${job.customerMustClear.trim()}\n")
        append("\n")
        append(context.getString(R.string.jsec_blocked_msg_debris))
        append("\n")
    }
    append("\n")
    append(context.getString(R.string.jsec_blocked_msg_call_us))
    append("\n\n")
    append(profile.businessName.ifBlank { context.getString(R.string.jsec_blocked_msg_thank_you) })
    if (profile.phone.isNotBlank()) append("\n${profile.phone}")
}

@Composable
private fun remember0(): SimpleDateFormat =
    androidx.compose.runtime.remember { SimpleDateFormat("MMM d, yyyy", Locale.US) }
