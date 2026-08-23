package com.fenceestimator.app.ui.manufacturers

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Directions
import androidx.compose.material.icons.filled.NearMe
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.R
import com.fenceestimator.app.data.Manufacturer
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.IntentHelpers
import com.fenceestimator.app.ui.components.currentApp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ManufacturersScreen(onBack: () -> Unit) {
    val app = currentApp()
    val context = LocalContext.current
    val viewModel: ManufacturersViewModel = viewModel(factory = GenericViewModelFactory { ManufacturersViewModel(app.repository) })
    val manufacturers by viewModel.manufacturers.collectAsState()
    val session by app.session.state.collectAsState()
    val canDelete = session.canDelete

    var editing by remember { mutableStateOf<Manufacturer?>(null) }
    var showNew by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.mfr_title)) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back)) } }
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { showNew = true }) {
                Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.mfr_add_manufacturer))
            }
        }
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            Button(
                onClick = { IntentHelpers.searchNearby(context, "fence supply store") },
                modifier = Modifier.fillMaxWidth().padding(16.dp, 16.dp, 16.dp, 8.dp)
            ) {
                Icon(Icons.Filled.NearMe, contentDescription = null)
                Text("  " + stringResource(R.string.mfr_find_supply_stores))
            }
            if (manufacturers.isEmpty()) {
                Column(modifier = Modifier.fillMaxSize().padding(24.dp)) {
                    Text(
                        stringResource(R.string.mfr_empty_hint),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    items(manufacturers, key = { it.id }) { m ->
                        Card(onClick = { editing = m }, modifier = Modifier.fillMaxWidth()) {
                            Row(modifier = Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(m.name.ifBlank { stringResource(R.string.mfr_unnamed) }, fontWeight = FontWeight.Medium)
                                    if (m.email.isNotBlank()) Text(m.email, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    if (m.phone.isNotBlank()) Text(m.phone, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    if (m.hours.isNotBlank()) Text(m.hours, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                if (m.address.isNotBlank()) {
                                    IconButton(
                                        onClick = { IntentHelpers.searchNearby(context, m.address) },
                                        modifier = Modifier.size(40.dp)
                                    ) {
                                        Icon(Icons.Filled.Directions, contentDescription = stringResource(R.string.crew_directions), tint = MaterialTheme.colorScheme.primary)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    editing?.let { m ->
        EditManufacturerDialog(
            manufacturer = m,
            onSave = { viewModel.save(it); editing = null },
            onDelete = { viewModel.delete(m); editing = null },
            canDelete = canDelete,
            onDismiss = { editing = null }
        )
    }
    if (showNew) {
        EditManufacturerDialog(
            manufacturer = Manufacturer(),
            onSave = { viewModel.save(it); showNew = false },
            onDelete = { showNew = false },
            canDelete = canDelete,
            onDismiss = { showNew = false }
        )
    }
}

@Composable
private fun EditManufacturerDialog(
    manufacturer: Manufacturer,
    onSave: (Manufacturer) -> Unit,
    onDelete: () -> Unit,
    canDelete: Boolean,
    onDismiss: () -> Unit
) {
    var name by remember { mutableStateOf(manufacturer.name) }
    var email by remember { mutableStateOf(manufacturer.email) }
    var phone by remember { mutableStateOf(manufacturer.phone) }
    var address by remember { mutableStateOf(manufacturer.address) }
    var hours by remember { mutableStateOf(manufacturer.hours) }
    var notes by remember { mutableStateOf(manufacturer.notes) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(if (manufacturer.id == 0L) R.string.mfr_new_manufacturer else R.string.mfr_edit_manufacturer)) },
        text = {
            Column {
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text(stringResource(R.string.mfr_name)) }, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(value = email, onValueChange = { email = it }, label = { Text(stringResource(R.string.mfr_order_email)) }, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(value = phone, onValueChange = { phone = it }, label = { Text(stringResource(R.string.field_phone)) }, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(value = address, onValueChange = { address = it }, label = { Text(stringResource(R.string.mfr_address)) }, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = hours, onValueChange = { hours = it },
                    label = { Text(stringResource(R.string.mfr_hours_hint)) }, modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(value = notes, onValueChange = { notes = it }, label = { Text(stringResource(R.string.field_notes)) }, modifier = Modifier.fillMaxWidth(), minLines = 2)
            }
        },
        confirmButton = {
            Button(onClick = { onSave(manufacturer.copy(name = name, email = email, phone = phone, address = address, hours = hours, notes = notes)) }) {
                Text(stringResource(R.string.action_save))
            }
        },
        dismissButton = {
            Row {
                if (manufacturer.id != 0L && canDelete) {
                    OutlinedButton(onClick = onDelete) { Text(stringResource(R.string.action_delete)) }
                    Spacer(Modifier.width(8.dp))
                }
                OutlinedButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
            }
        }
    )
}
