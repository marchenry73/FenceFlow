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
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Event
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.SupabaseModule
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.ui.components.UiMessage
import com.fenceestimator.app.ui.components.currentApp
import com.fenceestimator.app.ui.components.resolve
import io.github.jan.supabase.postgrest.postgrest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

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
                    CrewAttentionRow(item, job, online, onOpenJob, onDismiss)
                }
            }
        }
    }
}

@Composable
private fun CrewAttentionRow(
    item: CrewAttentionItem,
    job: Job?,
    online: Boolean,
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
        CrewAttentionItem.Kind.HOURS_CORRECTED ->
            Icons.Filled.Schedule to stringResource(R.string.crew_attn_hours_corrected, jobName)
        CrewAttentionItem.Kind.PLAN_CHANGE_ANSWERED ->
            (if (item.approved == true) Icons.Filled.Check else Icons.Filled.Close) to
                stringResource(
                    if (item.approved == true) R.string.crew_attn_plan_change_approved
                    else R.string.crew_attn_plan_change_rejected,
                    jobName
                )
    }

    // HOURS_CORRECTED is the one kind where "Got it" is not the only way off
    // this list -- see ShiftReplyControls. What this phone has already sent
    // back (if anything) is read once per composition and only ever moves
    // from null to an answer, never back, matching how CrewShiftReplyStore
    // itself works (an answer is never un-sent).
    val app = currentApp()
    val replyStore = remember { CrewShiftReplyStore(app) }
    var reply by remember(item.key) {
        mutableStateOf(
            if (item.kind == CrewAttentionItem.Kind.HOURS_CORRECTED) replyStore.answerFor(item.key) else null
        )
    }
    // Every other kind keeps its unconditional dismiss button. HOURS_CORRECTED
    // only gets one once it has an answer -- before that, Accept/Dispute are
    // the only way to clear it, so a tap can never skip past answering.
    val showDismiss = item.kind != CrewAttentionItem.Kind.HOURS_CORRECTED || reply != null

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
            if (item.kind == CrewAttentionItem.Kind.HOURS_CORRECTED) {
                ShiftReplyControls(
                    item = item,
                    online = online,
                    reply = reply,
                    replyStore = replyStore,
                    onReplied = { reply = it }
                )
            }
        }
        // "Got it" rather than a swipe: a shift sent back or a locate that
        // expired is exactly the kind of thing that must not disappear from
        // a stray thumb brushing the list on a moving phone.
        if (showDismiss) {
            TextButton(onClick = { onDismiss(item.key) }) {
                Text(stringResource(R.string.crew_attn_dismiss))
            }
        }
    }
}

/**
 * Accept or dispute one hours correction -- the crew's half of a gap that sat
 * open for months: `acknowledge_my_shift` and `dispute_my_shift` (see
 * supabase_shift_dispute.sql) existed and were reachable, and nothing on the
 * phone or the website ever called either one. A manager could already
 * correct a shift and the crew could already see the reason ([item.detail]
 * above); this is the part that lets the person actually being paid answer
 * back instead of just reading it.
 *
 * Direct RPC, not a queued local write -- same shape as
 * [CrewJobViewModel.moveStage], for the same reason: there is no local column
 * this could stage the answer into (see [CrewShiftReplyStore]), so "saved"
 * can only ever mean the server actually has it. A queued guess would be a
 * lie the moment the phone got signal back and the sync found out otherwise.
 */
@Composable
private fun ShiftReplyControls(
    item: CrewAttentionItem,
    online: Boolean,
    reply: CrewShiftReplyStore.Reply?,
    replyStore: CrewShiftReplyStore,
    onReplied: (CrewShiftReplyStore.Reply) -> Unit
) {
    val syncId = item.shiftSyncId
    val scope = rememberCoroutineScope()
    var pending by remember(item.key) { mutableStateOf(false) }
    var errorMessage by remember(item.key) { mutableStateOf<UiMessage?>(null) }
    var showDisputeDialog by remember(item.key) { mutableStateOf(false) }

    when (reply) {
        is CrewShiftReplyStore.Reply.Accepted -> {
            Text(
                stringResource(R.string.crew_attn_hours_accepted_note),
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(top = 4.dp)
            )
            return
        }
        is CrewShiftReplyStore.Reply.Disputed -> {
            Text(
                stringResource(R.string.crew_attn_hours_disputed_note, reply.note),
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(top = 4.dp)
            )
            return
        }
        null -> Unit
    }

    // Defensive only -- CrewAttention.build always sets shiftSyncId for this
    // kind, from the same TimeEntry.syncId the RPCs match on. If it is ever
    // missing there is nothing honest to call, so this says so instead of a
    // button that would silently do nothing.
    if (syncId.isNullOrBlank()) {
        Text(
            stringResource(R.string.crew_attn_reply_unavailable),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
            modifier = Modifier.padding(top = 4.dp)
        )
        return
    }

    fun accept() {
        if (pending) return
        if (!online) {
            errorMessage = UiMessage(R.string.crew_attn_reply_needs_signal)
            return
        }
        pending = true
        errorMessage = null
        scope.launch {
            val outcome = runCatching {
                SupabaseModule.client.postgrest.rpc(
                    "acknowledge_my_shift",
                    buildJsonObject { put("shift_sync_id", syncId) }
                ).decodeAs<Boolean>()
            }
            pending = false
            outcome.onSuccess { touched ->
                if (touched) {
                    replyStore.recordAccepted(item.key)
                    onReplied(CrewShiftReplyStore.Reply.Accepted)
                } else {
                    errorMessage = UiMessage(R.string.crew_attn_reply_not_recorded)
                }
            }.onFailure { e ->
                errorMessage = UiMessage(R.string.crew_attn_reply_failed, listOf(e.message.orEmpty()))
            }
        }
    }

    fun dispute(note: String) {
        if (pending) return
        if (!online) {
            errorMessage = UiMessage(R.string.crew_attn_reply_needs_signal)
            return
        }
        pending = true
        errorMessage = null
        scope.launch {
            val outcome = runCatching {
                SupabaseModule.client.postgrest.rpc(
                    "dispute_my_shift",
                    buildJsonObject {
                        put("shift_sync_id", syncId)
                        put("note", note)
                    }
                ).decodeAs<Boolean>()
            }
            pending = false
            outcome.onSuccess { touched ->
                if (touched) {
                    replyStore.recordDisputed(item.key, note)
                    onReplied(CrewShiftReplyStore.Reply.Disputed(note))
                    showDisputeDialog = false
                } else {
                    errorMessage = UiMessage(R.string.crew_attn_reply_not_recorded)
                    // Dialog stays open -- a failure here must leave the
                    // shift answerable, not close on a guess that it worked.
                }
            }.onFailure { e ->
                errorMessage = UiMessage(R.string.crew_attn_reply_failed, listOf(e.message.orEmpty()))
                // Same as above: stays open on a thrown exception too.
            }
        }
    }

    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.padding(top = 6.dp)
    ) {
        Button(enabled = !pending, onClick = ::accept) {
            Text(stringResource(R.string.crew_attn_hours_accept))
        }
        OutlinedButton(
            enabled = !pending,
            onClick = { errorMessage = null; showDisputeDialog = true }
        ) {
            Text(stringResource(R.string.crew_attn_hours_dispute))
        }
    }
    errorMessage?.let {
        Text(
            it.resolve(),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
            modifier = Modifier.padding(top = 4.dp)
        )
    }

    if (showDisputeDialog) {
        DisputeShiftDialog(
            pending = pending,
            errorMessage = errorMessage,
            onDismissRequest = { if (!pending) showDisputeDialog = false },
            onSubmit = ::dispute
        )
    }
}

/**
 * The written reason `dispute_my_shift` requires. The server already refuses
 * an empty note (SQLSTATE 23514, "Say what was wrong with the hours") -- the
 * Send button being disabled on a blank field is this screen not making
 * someone find that out from a failure it could have caught first.
 */
@Composable
private fun DisputeShiftDialog(
    pending: Boolean,
    errorMessage: UiMessage?,
    onDismissRequest: () -> Unit,
    onSubmit: (String) -> Unit
) {
    var note by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismissRequest,
        title = { Text(stringResource(R.string.crew_attn_dispute_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    stringResource(R.string.crew_attn_dispute_explain),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = { Text(stringResource(R.string.crew_attn_dispute_label)) },
                    placeholder = { Text(stringResource(R.string.crew_attn_dispute_placeholder)) },
                    enabled = !pending,
                    modifier = Modifier.fillMaxWidth()
                )
                errorMessage?.let {
                    Text(
                        it.resolve(),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error
                    )
                }
            }
        },
        confirmButton = {
            Button(
                enabled = note.isNotBlank() && !pending,
                onClick = { onSubmit(note.trim()) }
            ) { Text(stringResource(R.string.crew_attn_dispute_submit)) }
        },
        dismissButton = {
            OutlinedButton(enabled = !pending, onClick = onDismissRequest) {
                Text(stringResource(R.string.action_cancel))
            }
        }
    )
}

private fun formatWhen(millis: Long): String =
    SimpleDateFormat("EEE h:mm a", Locale.getDefault()).format(Date(millis))
