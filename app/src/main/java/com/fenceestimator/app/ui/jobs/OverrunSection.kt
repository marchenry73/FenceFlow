package com.fenceestimator.app.ui.jobs

import com.fenceestimator.app.ui.components.DraftTextField
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
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.estimate.JobSchedule
import com.fenceestimator.app.ui.components.IntentHelpers
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * A job that has run past the day it was meant to finish.
 *
 * The moment worth catching, because it is the moment the NEXT customer's date
 * stops being true -- and normally nobody finds that out until a crew fails to
 * turn up somewhere. Two things are needed and neither happens by itself:
 * a record of why it ran over, and the next customer told before they are
 * standing in their yard waiting.
 */
@Composable
fun OverrunSection(
    job: Job,
    allJobs: List<Job>,
    workdayHours: Double,
    viewModel: JobDetailViewModel
) {
    if (!JobSchedule.hasOverrun(job, workdayHours)) return

    val context = androidx.compose.ui.platform.LocalContext.current
    val dayFormat = remember { SimpleDateFormat("EEEE d MMM", Locale.US) }
    val days = JobSchedule.daysOverrun(job, workdayHours)
    val next = JobSchedule.nextAffected(job, allJobs, workdayHours)


    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                "This job is " + (if (days == 1) "a day" else "$days days") + " past its finish date",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onErrorContainer
            )

            // Recorded now, while somebody remembers. A month later in a dispute
            // "it rained" and "the customer never cleared the line" are the
            // difference between eating the cost and charging for it.
            // Saves itself shortly after you stop typing, like every other
            // field in the app. It used to need the button below pressed, and
            // a reason typed on site and then walked away from was simply
            // lost -- which is the reason you most want a month later, when
            // the customer is asking why the job ran late.
            DraftTextField(
                stableKey = job.id,
                initialValue = job.blockedReason,
                label = "Why did it run over?",
                minLines = 2,
                modifier = Modifier.fillMaxWidth()
            ) { text -> viewModel.update { it.copy(blockedReason = text.trim()) } }

            if (next != null) {
                Text(
                    "Next up is " + next.customerName.ifBlank { "your next job" } +
                        (next.scheduledDate?.let { ", booked " + dayFormat.format(Date(it)) } ?: "") +
                        ". They are the one this pushes.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onErrorContainer
                )

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = {
                            // Their phone, not an email. Somebody expecting a
                            // crew tomorrow morning needs to know today, and a
                            // text gets read.
                            IntentHelpers.openSmsDraft(
                                context,
                                next.phone,
                                "Hi " + next.customerName.ifBlank { "there" } + " -- the job before " +
                                    "yours has run over, so we need to move your fence install. " +
                                    "I'll call shortly to agree a new day. Sorry for the change."
                            )
                        },
                        enabled = next.phone.isNotBlank(),
                        modifier = Modifier.weight(1f)
                    ) { Text("Text them") }

                    OutlinedButton(
                        onClick = {
                            // Pushed by however many days this one has run over,
                            // which is the honest first guess -- and it is a
                            // date they can then change rather than a promise.
                            val moved = next.scheduledDate?.let { JobSchedule.addDays(it, days) }
                            viewModel.rescheduleOtherJob(next, moved)
                        },
                        enabled = next.scheduledDate != null,
                        modifier = Modifier.weight(1f)
                    ) { Text("Push $days day" + if (days == 1) "" else "s") }
                }
            }
        }
    }
}
