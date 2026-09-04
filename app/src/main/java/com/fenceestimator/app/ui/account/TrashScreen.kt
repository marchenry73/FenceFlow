package com.fenceestimator.app.ui.account

import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.R
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp
import com.fenceestimator.app.ui.components.resolve
import com.fenceestimator.app.ui.theme.Space

/**
 * Everything that was deleted, and putting it back.
 *
 * Deleting stays deliberately hard -- it is granted to a named person rather
 * than inherited with a job title -- but hard is not the same as irreversible.
 * The thing that actually happens is somebody deletes the wrong job, realises
 * an hour later, and by then every device has removed its copy. This reads
 * straight from the cloud, so it can recover something this phone never had.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrashScreen(onBack: () -> Unit) {
    val app = currentApp()
    val viewModel: TrashViewModel = viewModel(
        factory = GenericViewModelFactory { TrashViewModel(app.session, app.autoSync) }
    )
    val session by app.session.state.collectAsState()
    val items by viewModel.items.collectAsState()
    val busy by viewModel.busy.collectAsState()
    val message by viewModel.message.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(Unit) { viewModel.load() }
    val messageText = message?.resolve()
    LaunchedEffect(message) { messageText?.let { snackbarHostState.showSnackbar(it) } }

    val dayFormat = remember { java.text.SimpleDateFormat("d MMM yyyy, h:mm a", java.util.Locale.US) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.acct_deleted_items)) },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back)) }
                }
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) }
    ) { padding ->
        // Restoring is the counterpart of deleting, so it takes the same
        // permission. Someone who cannot delete has no business undoing
        // somebody else's deletion either.
        if (!session.canDelete) {
            Column(Modifier.fillMaxSize().padding(padding).padding(Space.xl)) {
                Text(
                    stringResource(R.string.acct_trash_only_deleters_restore),
                    style = MaterialTheme.typography.bodyLarge
                )
            }
            return@Scaffold
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(Space.screen),
            verticalArrangement = Arrangement.spacedBy(Space.row)
        ) {
            if (busy) {
                item {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator()
                        Text("  " + stringResource(R.string.acct_loading), style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }

            if (!busy && items.isEmpty()) {
                item {
                    Text(
                        stringResource(R.string.acct_trash_empty),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            items(items, key = { it.table + it.syncId }) { record ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(Space.xs)) {
                        Text(record.label, style = MaterialTheme.typography.titleMedium)
                        Text(
                            stringResource(record.kindLabelRes) +
                                (record.deletedAt?.let { " · " + stringResource(R.string.acct_trash_deleted_on, dayFormat.format(java.util.Date(it))) } ?: "") +
                                (if (record.deletedBy.isNotBlank()) " · " + stringResource(R.string.acct_trash_deleted_by, record.deletedBy) else ""),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Button(
                            onClick = { viewModel.restore(record) },
                            modifier = Modifier.fillMaxWidth()
                        ) { Text(stringResource(R.string.acct_trash_put_it_back)) }
                    }
                }
            }

            if (items.isNotEmpty()) {
                item {
                    Text(
                        stringResource(R.string.acct_trash_restore_everyone),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            item {
                Button(onClick = { viewModel.load() }, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.acct_refresh))
                }
            }
        }
    }
}
