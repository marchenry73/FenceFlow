package com.fenceestimator.app.ui.jobs

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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
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
import androidx.compose.material3.Surface
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.AccessRefusal
import com.fenceestimator.app.cloud.AccessRequestStatus
import com.fenceestimator.app.cloud.JobAccess
import com.fenceestimator.app.cloud.RequestableJob
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp
import com.fenceestimator.app.ui.components.resolve
import com.fenceestimator.app.ui.theme.Space
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Won jobs this crew member is not on, and asking for one.
 *
 * Reached from the job list's "Other jobs -- request access" row, which only
 * a linked, scoped login is shown (see [scopedHome]). Names and places only:
 * the server's list carries no money, no phone and no email, and neither
 * does this screen. An answer arrives by itself -- a yes puts the job on the
 * phone at the next sync, which the change feed starts within seconds.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RequestAccessScreen(onBack: () -> Unit) {
    val app = currentApp()
    val viewModel: RequestAccessViewModel = viewModel(
        factory = GenericViewModelFactory { RequestAccessViewModel(app.session, app.connectivity.online) }
    )
    val state by viewModel.state.collectAsState()
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

    var query by remember { mutableStateOf("") }
    var asking by remember { mutableStateOf<RequestableJob?>(null) }
    val dateFormat = remember { SimpleDateFormat("EEE, MMM d", Locale.getDefault()) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.access_request_title)) },
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
                    stringResource(R.string.access_request_intro),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            if (!online) {
                item { NeedsConnectionCard(stringResource(R.string.access_request_offline)) }
            }
            val refusal = state.refusal
            when {
                state.loading -> item {
                    Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                }
                // Nothing to list, and a reason why: said once, in words. A
                // list that was read before and failed to refresh is kept
                // instead (below) -- still the right list to ask from.
                refusal != null && state.rows.isEmpty() && online -> item {
                    Card(
                        Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
                    ) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(
                                stringResource(accessRefusalText(refusal, AccessAction.ASK)),
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
                state.rows.isEmpty() && online -> item {
                    Text(
                        stringResource(R.string.access_request_none),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 8.dp)
                    )
                }
            }

            if (state.rows.isNotEmpty()) {
                item {
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        singleLine = true,
                        placeholder = { Text(stringResource(R.string.home_search_jobs)) },
                        leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                        trailingIcon = {
                            if (query.isNotBlank()) {
                                IconButton(onClick = { query = "" }) {
                                    Icon(Icons.Filled.Close, contentDescription = null)
                                }
                            }
                        },
                        shape = RoundedCornerShape(16.dp),
                        modifier = Modifier.fillMaxWidth()
                    )
                }
                val shown = filterRequestable(state.rows, query)
                if (shown.isEmpty()) {
                    item {
                        Text(
                            stringResource(R.string.home_no_matches),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(vertical = 8.dp)
                        )
                    }
                }
                items(shown, key = { it.jobSyncId }) { job ->
                    RequestableJobCard(
                        job = job,
                        row = requestRowOf(job),
                        dateText = job.scheduledDate?.let { dateFormat.format(Date(it)) },
                        enabled = online && job.jobSyncId !in state.busy,
                        onAsk = { asking = job },
                        onWithdraw = { id -> viewModel.withdraw(job.jobSyncId, id) }
                    )
                }
            }
        }
    }

    asking?.let { job ->
        AskDialog(
            jobName = job.customerName.ifBlank { job.address.ifBlank { stringResource(R.string.home_untitled_job) } },
            onSend = { reason ->
                viewModel.request(job.jobSyncId, reason)
                asking = null
            },
            onDismiss = { asking = null }
        )
    }
}

@Composable
private fun RequestableJobCard(
    job: RequestableJob,
    row: RequestRow,
    dateText: String?,
    enabled: Boolean,
    onAsk: () -> Unit,
    onWithdraw: (String) -> Unit
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    job.customerName.ifBlank { stringResource(R.string.home_untitled_job) },
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                when (row.chip) {
                    AccessRequestStatus.PENDING -> RequestChip(
                        stringResource(R.string.access_chip_waiting),
                        MaterialTheme.colorScheme.tertiaryContainer,
                        MaterialTheme.colorScheme.onTertiaryContainer
                    )
                    AccessRequestStatus.DENIED -> RequestChip(
                        stringResource(R.string.access_chip_declined),
                        MaterialTheme.colorScheme.errorContainer,
                        MaterialTheme.colorScheme.onErrorContainer
                    )
                    else -> Unit
                }
            }
            if (job.address.isNotBlank()) {
                Text(
                    job.address,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
            Text(
                dateText?.let { stringResource(R.string.access_scheduled_on, it) }
                    ?: stringResource(R.string.access_no_date),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            if (row.note.isNotBlank()) {
                Text(
                    stringResource(R.string.access_office_note, row.note),
                    style = MaterialTheme.typography.bodySmall
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (row.canAsk) {
                    Button(onClick = onAsk, enabled = enabled) {
                        Text(
                            stringResource(
                                if (row.chip == AccessRequestStatus.DENIED) R.string.access_ask_again
                                else R.string.access_request_button
                            )
                        )
                    }
                }
                row.withdrawId?.let { id ->
                    OutlinedButton(onClick = { onWithdraw(id) }, enabled = enabled) {
                        Text(stringResource(R.string.access_withdraw))
                    }
                }
            }
        }
    }
}

@Composable
internal fun RequestChip(text: String, container: Color, content: Color) {
    Surface(shape = RoundedCornerShape(50), color = container) {
        Text(
            text,
            color = content,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp)
        )
    }
}

/** The optional reason, capped where the server caps it. */
@Composable
private fun AskDialog(jobName: String, onSend: (String) -> Unit, onDismiss: () -> Unit) {
    var reason by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.access_ask_title, jobName)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.access_ask_body), style = MaterialTheme.typography.bodyMedium)
                OutlinedTextField(
                    value = reason,
                    onValueChange = { reason = it.take(JobAccess.MAX_REASON_LENGTH) },
                    label = { Text(stringResource(R.string.access_reason_label)) },
                    supportingText = {
                        Text(stringResource(R.string.access_reason_count, reason.length, JobAccess.MAX_REASON_LENGTH))
                    },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            Button(onClick = { onSend(reason) }) { Text(stringResource(R.string.access_send_request)) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
        }
    )
}

/** "Needs a connection", with the reason this screen in particular needs one. */
@Composable
internal fun NeedsConnectionCard(detail: String) {
    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
    ) {
        Row(
            Modifier.padding(14.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(Icons.Filled.CloudOff, contentDescription = null, tint = MaterialTheme.colorScheme.onSecondaryContainer)
            Column {
                Text(
                    stringResource(R.string.access_needs_connection),
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onSecondaryContainer
                )
                Text(
                    detail,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSecondaryContainer
                )
            }
        }
    }
}
