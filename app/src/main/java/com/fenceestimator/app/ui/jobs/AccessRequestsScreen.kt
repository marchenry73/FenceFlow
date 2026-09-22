package com.fenceestimator.app.ui.jobs

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.AccessRefusal
import com.fenceestimator.app.cloud.JobAccess
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp
import com.fenceestimator.app.ui.components.resolve
import com.fenceestimator.app.ui.theme.Space

/**
 * The crew's waiting access requests, for the people who answer them.
 *
 * Opened from the job list's "Access requests waiting" banner; the office
 * dashboard answers the same requests (website/dashboard.html). A yes lets
 * the person see that one job (a job_assignments row of kind ACCESS, ended
 * from the job's own screen when it is no longer needed); a no can carry a
 * note, which they see beside "Declined".
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AccessRequestsScreen(onBack: () -> Unit, onOpenJob: (Long) -> Unit) {
    val app = currentApp()
    val viewModel: AccessRequestsViewModel = viewModel(
        factory = GenericViewModelFactory {
            AccessRequestsViewModel(app.repository, app.session, app.connectivity.online)
        }
    )
    val state by viewModel.state.collectAsState()
    val asks by viewModel.asks.collectAsState()
    val online by app.connectivity.online.collectAsState()
    val message by viewModel.message.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    val messageText = message?.resolve()
    LaunchedEffect(message) {
        messageText?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.consumeMessage()
        }
    }
    var declining by remember { mutableStateOf<PendingAsk?>(null) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.access_answer_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back))
                    }
                },
                actions = {
                    IconButton(onClick = { viewModel.load() }, enabled = online) {
                        Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.access_refresh))
                    }
                }
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) }
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(Space.screen),
            verticalArrangement = Arrangement.spacedBy(Space.row)
        ) {
            item {
                Text(
                    stringResource(R.string.access_answer_intro),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            if (!online) {
                item { NeedsConnectionCard(stringResource(R.string.access_answer_offline)) }
            }
            val refusal = state.refusal
            when {
                state.loading -> item {
                    Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                }
                refusal != null && asks.isEmpty() && online -> item {
                    Card(
                        Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
                    ) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(
                                stringResource(accessRefusalText(refusal, AccessAction.ANSWER)),
                                color = MaterialTheme.colorScheme.onSecondaryContainer
                            )
                            if (refusal == AccessRefusal.FAILED || refusal == AccessRefusal.NO_CONNECTION) {
                                OutlinedButton(onClick = { viewModel.load() }) {
                                    Text(stringResource(R.string.access_try_again))
                                }
                            }
                        }
                    }
                }
                asks.isEmpty() && online -> item {
                    Text(
                        stringResource(R.string.access_answer_none),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 8.dp)
                    )
                }
            }
            items(asks, key = { it.request.id }) { ask ->
                AccessAskCard(
                    ask = ask,
                    showJob = true,
                    enabled = online && ask.request.id !in state.busy,
                    onApprove = { viewModel.decide(ask.request.id, approve = true) },
                    onDecline = { declining = ask },
                    onOpenJob = ask.job?.let { j -> { onOpenJob(j.id) } }
                )
            }
        }
    }

    declining?.let { ask ->
        DeclineDialog(
            personName = ask.personName ?: stringResource(R.string.access_someone),
            onDecline = { note ->
                viewModel.decide(ask.request.id, approve = false, note = note)
                declining = null
            },
            onDismiss = { declining = null }
        )
    }
}

/**
 * One waiting request: who, which job, why, and the two answers. Shared by
 * [AccessRequestsScreen] and the job screen's crew section, which leaves the
 * job out ([showJob] false) because it is the job on screen.
 */
@Composable
internal fun AccessAskCard(
    ask: PendingAsk,
    showJob: Boolean,
    enabled: Boolean,
    onApprove: () -> Unit,
    onDecline: () -> Unit,
    onOpenJob: (() -> Unit)?
) {
    val askedWhen = ask.request.createdAt?.let {
        android.text.format.DateUtils.getRelativeTimeSpanString(it).toString()
    }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                stringResource(R.string.access_asked_by, ask.personName ?: stringResource(R.string.access_someone)),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold
            )
            if (showJob) {
                val jobLine = ask.job?.let { j -> j.customerName.ifBlank { j.address } }
                    ?.ifBlank { null }
                    ?: stringResource(R.string.access_job_not_here)
                Text(
                    jobLine,
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (onOpenJob != null) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = if (onOpenJob != null) Modifier.clickable { onOpenJob() } else Modifier
                )
            }
            if (ask.request.reason.isNotBlank()) {
                Text(
                    stringResource(R.string.access_their_reason, ask.request.reason),
                    style = MaterialTheme.typography.bodyMedium
                )
            }
            if (askedWhen != null) {
                Text(
                    askedWhen,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onApprove, enabled = enabled) { Text(stringResource(R.string.access_approve)) }
                OutlinedButton(onClick = onDecline, enabled = enabled) { Text(stringResource(R.string.access_decline)) }
            }
        }
    }
}

/** Declining, with an optional note the crew member sees beside "Declined". */
@Composable
internal fun DeclineDialog(personName: String, onDecline: (String) -> Unit, onDismiss: () -> Unit) {
    var note by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.access_decline_title, personName)) },
        text = {
            OutlinedTextField(
                value = note,
                onValueChange = { note = it.take(JobAccess.MAX_NOTE_LENGTH) },
                label = { Text(stringResource(R.string.access_decline_note_label)) },
                supportingText = {
                    Text(stringResource(R.string.access_reason_count, note.length, JobAccess.MAX_NOTE_LENGTH))
                },
                minLines = 2,
                modifier = Modifier.fillMaxWidth()
            )
        },
        confirmButton = {
            Button(onClick = { onDecline(note) }) { Text(stringResource(R.string.access_decline)) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
        }
    )
}
