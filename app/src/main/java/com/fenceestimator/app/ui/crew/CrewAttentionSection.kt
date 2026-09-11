package com.fenceestimator.app.ui.crew

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.PriorityHigh
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Event
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.R
import com.fenceestimator.app.data.Job
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The crew half of notifications: what is waiting on THIS person, and
 * nothing else.
 *
 * Deliberately not a copy of [com.fenceestimator.app.ui.jobs.HomeDashboard]'s
 * "Needs attention" card. That card reads the whole company's jobs and shows
 * office-shaped facts (money, stale drafts, quotes). This one is scoped to a
 * single person by [items] already having been filtered to their own
 * assignment before it got here (see [CrewAttentionViewModel]) -- there is no
 * "show everything, then hide some of it" step, because that step is exactly
 * how an office alert leaks into a phone that has no business seeing it.
 *
 * @param items each alert paired with the job it is about, or null if that
 *   job is no longer on the phone (deleted, or synced away) -- shown with a
 *   generic name rather than dropped, since the alert itself is still real.
 * @param online whether the phone currently has a usable connection. Used
 *   only to caveat freshness, never to hide or invent an item -- an item
 *   already on the phone is real whether or not the phone can currently
 *   reach the server.
 * @param lastSyncedAt when this phone last completed a sync, or null if it
 *   never has. Shown while offline so "nothing waiting on you" cannot be
 *   mistaken for a live answer when it might just be an old one.
 */
@Composable
fun CrewAttentionSection(
    items: List<Pair<CrewAttentionItem, Job?>>,
    online: Boolean,
    lastSyncedAt: Long?,
    onOpenJob: (Long) -> Unit,
    onDismiss: (String) -> Unit
) {
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 1.dp,
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.padding(vertical = 10.dp)) {
            Text(
                stringResource(R.string.crew_attn_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)
            )

            // Freshness is stated, never implied by an empty list. A phone
            // with no signal for two days and nothing shown here looks
            // identical to a phone with no signal for two minutes -- this is
            // the line that tells them apart, per the offline rule this
            // screen exists under: no stale count is ever shown as current.
            if (!online) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    Icon(
                        Icons.Filled.CloudOff,
                        contentDescription = null,
                        modifier = Modifier.padding(end = 2.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(
                        lastSyncedAt?.let {
                            stringResource(R.string.crew_attn_offline_since, formatWhen(it))
                        } ?: stringResource(R.string.crew_attn_offline_never_synced),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            if (items.isEmpty()) {
                Text(
                    stringResource(R.string.home_all_clear),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
                )
            } else {
                items.forEach { (item, job) ->
                    CrewAttentionRow(item, job, onOpenJob, onDismiss)
                }
            }
        }
    }
}

@Composable
private fun CrewAttentionRow(
    item: CrewAttentionItem,
    job: Job?,
    onOpenJob: (Long) -> Unit,
    onDismiss: (String) -> Unit
) {
    val untitled = stringResource(R.string.home_untitled_job)
    val jobName = if (job == null) {
        untitled
    } else {
        job.customerName.ifBlank { job.address }.ifBlank { untitled }
    }

    val (icon, message) = when (item.kind) {
        CrewAttentionItem.Kind.JOB_TODAY ->
            Icons.Filled.Event to stringResource(R.string.crew_attn_job_today, jobName)
        CrewAttentionItem.Kind.LOCATE_EXPIRED ->
            Icons.Filled.PriorityHigh to stringResource(R.string.crew_attn_locate_expired, jobName)
        CrewAttentionItem.Kind.SHIFT_SENT_BACK ->
            Icons.Filled.CalendarMonth to stringResource(R.string.crew_attn_shift_sent_back, jobName)
        CrewAttentionItem.Kind.PLAN_CHANGE_ANSWERED ->
            (if (item.approved == true) Icons.Filled.Check else Icons.Filled.Close) to
                stringResource(
                    if (item.approved == true) R.string.crew_attn_plan_change_approved
                    else R.string.crew_attn_plan_change_rejected,
                    jobName
                )
    }

    Row(
        Modifier
            .fillMaxWidth()
            .clickable { item.jobId?.let(onOpenJob) }
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.padding(end = 12.dp)
        )
        Column(Modifier.weight(1f)) {
            Text(message, style = MaterialTheme.typography.bodyMedium)
            if (item.detail.isNotBlank()) {
                Text(
                    item.detail,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
        // "Got it" rather than a swipe: a shift sent back or a locate that
        // expired is exactly the kind of thing that must not disappear from
        // a stray thumb brushing the list on a moving phone.
        TextButton(onClick = { onDismiss(item.key) }) {
            Text(stringResource(R.string.crew_attn_dismiss))
        }
    }
}

private fun formatWhen(millis: Long): String =
    SimpleDateFormat("EEE h:mm a", Locale.getDefault()).format(Date(millis))
