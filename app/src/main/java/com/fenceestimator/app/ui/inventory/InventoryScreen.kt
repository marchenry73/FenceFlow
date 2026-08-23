package com.fenceestimator.app.ui.inventory

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import kotlinx.coroutines.flow.first
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage
import com.fenceestimator.app.R
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.InventoryChecklistItem
import com.fenceestimator.app.data.InventoryKind
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.PhotoFiles
import com.fenceestimator.app.ui.components.currentApp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InventoryScreen(jobId: Long, onBack: () -> Unit) {
    val app = currentApp()
    val viewModel: InventoryViewModel = viewModel(
        key = "inventory_$jobId",
        factory = GenericViewModelFactory { InventoryViewModel(app.repository, jobId) }
    )
    val items by viewModel.items.collectAsState()
    val profile by app.settingsStore.profile.collectAsState(initial = BusinessProfile())
    var addDialogKind by remember { mutableStateOf<InventoryKind?>(null) }

    LaunchedEffect(jobId) {
        // The collected profile starts as a placeholder holding the built-in
        // tools; seeding from it raced DataStore and stamped the defaults on
        // every checklist. first() waits for the stored profile.
        viewModel.ensureToolsSeeded(app.settingsStore.profile.first().defaultToolsListCsv)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.inv_title)) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back)) } }
            )
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxWidth().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            item {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.inv_materials), style = MaterialTheme.typography.titleMedium)
                    OutlinedButton(onClick = { viewModel.syncMaterialsFromEstimate() }) {
                        Icon(Icons.Filled.Refresh, contentDescription = null)
                        Text(" " + stringResource(R.string.inv_sync_from_estimate))
                    }
                }
            }
            val materials = items.filter { it.kind == InventoryKind.MATERIAL }
            if (materials.isEmpty()) {
                item {
                    Text(
                        stringResource(R.string.misc_inventory_no_materials),
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            materials.forEach { checkItem -> item { ChecklistRow(checkItem, viewModel) } }
            item {
                OutlinedButton(onClick = { addDialogKind = InventoryKind.MATERIAL }, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.inv_add_material))
                }
            }

            item { Text(stringResource(R.string.inv_tools), style = MaterialTheme.typography.titleMedium) }
            val tools = items.filter { it.kind == InventoryKind.TOOL }
            tools.forEach { checkItem -> item { ChecklistRow(checkItem, viewModel) } }
            item {
                OutlinedButton(onClick = { addDialogKind = InventoryKind.TOOL }, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.inv_add_tool))
                }
            }
        }
    }

    addDialogKind?.let { kind ->
        AddItemDialog(
            kind = kind,
            onConfirm = { viewModel.addCustom(kind, it); addDialogKind = null },
            onDismiss = { addDialogKind = null }
        )
    }
}

@Composable
private fun ChecklistRow(item: InventoryChecklistItem, viewModel: InventoryViewModel) {
    val context = LocalContext.current
    var pendingPath by remember { mutableStateOf<String?>(null) }
    val cameraLauncher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { success ->
        val path = pendingPath
        if (success && path != null) viewModel.attachPhoto(item, path)
        pendingPath = null
    }

    Card(modifier = Modifier.fillMaxWidth()) {
        Row(modifier = Modifier.fillMaxWidth().padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = item.checked, onCheckedChange = { viewModel.toggle(item) })
            Text(
                item.description,
                modifier = Modifier.weight(1f),
                style = if (item.checked) MaterialTheme.typography.bodyLarge.copy(textDecoration = TextDecoration.LineThrough) else MaterialTheme.typography.bodyLarge,
                color = if (item.checked) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface
            )
            if (item.photoPath != null) {
                AsyncImage(
                    model = item.photoPath, contentDescription = null, contentScale = ContentScale.Crop,
                    modifier = Modifier.size(36.dp).clip(RoundedCornerShape(6.dp))
                )
            }
            IconButton(onClick = {
                val target = PhotoFiles.newTarget(context, "inventory")
                pendingPath = target.absolutePath
                cameraLauncher.launch(target.uri)
            }) { Icon(Icons.Filled.CameraAlt, contentDescription = stringResource(R.string.misc_inventory_verify_with_photo)) }
            IconButton(onClick = { viewModel.delete(item) }) {
                Icon(Icons.Filled.Delete, contentDescription = stringResource(R.string.draw_remove), tint = MaterialTheme.colorScheme.error)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AddItemDialog(kind: InventoryKind, onConfirm: (String) -> Unit, onDismiss: () -> Unit) {
    var text by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(if (kind == InventoryKind.TOOL) R.string.misc_inventory_add_tool_title else R.string.misc_inventory_add_material_title)) },
        text = { OutlinedTextField(value = text, onValueChange = { text = it }, label = { Text(stringResource(R.string.inv_description)) }) },
        confirmButton = { Button(onClick = { onConfirm(text) }) { Text(stringResource(R.string.action_add)) } },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } }
    )
}
