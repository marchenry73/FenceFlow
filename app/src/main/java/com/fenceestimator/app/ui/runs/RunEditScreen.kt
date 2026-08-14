package com.fenceestimator.app.ui.runs

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Card
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
import androidx.compose.material3.Switch
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.data.AluminumStyle
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.WoodStyle
import com.fenceestimator.app.ui.components.DraftNumberField
import com.fenceestimator.app.ui.components.DraftTextField
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RunEditScreen(
    runId: Long,
    onBack: () -> Unit,
    onDeleted: () -> Unit,
    onDrawRun: (Long) -> Unit
) {
    val app = currentApp()
    val viewModel: RunEditViewModel = viewModel(
        key = "run_edit_$runId",
        factory = GenericViewModelFactory { RunEditViewModel(app.repository, runId) }
    )
    val run by viewModel.run.collectAsState()
    val currentRun = run ?: return

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(currentRun.label.ifBlank { "Fence Run" }) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") } }
            )
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxWidth().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            item {
                // The natural next step after naming a run is drawing it. Without
                // this you had to back out to the job and find the survey screen,
                // which broke the flow every single time.
                val hasLine = currentRun.pointsEncoded.isNotBlank()
                androidx.compose.material3.Button(
                    onClick = { onDrawRun(currentRun.jobId) },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Icon(Icons.Filled.Edit, contentDescription = null)
                    Text(if (hasLine) "  Edit the Drawing" else "  Next: Draw This Fence")
                }
                if (!hasLine) {
                    Text(
                        "Set the type and spec below first if you need to, then draw the line.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            item {
                SectionCard("Run") {
                    DraftTextField(
                        stableKey = currentRun.id, initialValue = currentRun.label,
                        label = "Label (e.g. \"Back Yard\")", modifier = Modifier.fillMaxWidth()
                    ) { viewModel.update { r -> r.copy(label = it) } }
                    FenceTypeDropdown(currentRun.fenceType) { newType ->
                        viewModel.update { r ->
                            r.copy(
                                fenceType = newType,
                                postSpacingFt = FenceRunListViewModel.defaultSpacingFor(newType, r.panelWidthFt, r.postSpacingFt)
                            )
                        }
                    }
                    DraftTextField(
                        stableKey = currentRun.id, initialValue = currentRun.colorOrFinish,
                        label = "Color / finish (optional, matches catalog price)", modifier = Modifier.fillMaxWidth()
                    ) { viewModel.update { r -> r.copy(colorOrFinish = it) } }
                }
            }
            item {
                when (currentRun.fenceType) {
                    FenceType.VINYL -> SectionCard("Vinyl Spec") { VinylFields(currentRun, viewModel) }
                    FenceType.ALUMINUM -> SectionCard("Aluminum Spec") { AluminumFields(currentRun, viewModel) }
                    FenceType.ORNAMENTAL_IRON -> SectionCard("Ornamental Iron Spec") { VinylFields(currentRun, viewModel) }
                    FenceType.WOOD -> SectionCard("Wood Spec") { WoodFields(currentRun, viewModel) }
                    FenceType.COMPOSITE -> SectionCard("Composite Spec") { WoodFields(currentRun, viewModel) }
                    FenceType.SPLIT_RAIL -> SectionCard("Split-Rail Spec") { SplitRailFields(currentRun, viewModel) }
                    FenceType.CHAIN_LINK -> SectionCard("Chain Link Spec") { ChainLinkFields(currentRun, viewModel) }
                    FenceType.UNIVERSAL -> {}
                }
            }
            item {
                SectionCard("Posts & Concrete") {
                    val locked = currentRun.fenceType == FenceType.VINYL || currentRun.fenceType == FenceType.ALUMINUM || currentRun.fenceType == FenceType.ORNAMENTAL_IRON
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        DraftNumberField(
                            stableKey = currentRun.id,
                            label = "Post spacing (ft)",
                            initialValue = currentRun.postSpacingFt,
                            enabled = !locked,
                            modifier = Modifier.weight(1f)
                        ) { viewModel.update { r -> r.copy(postSpacingFt = it) } }
                        DraftNumberField(
                            stableKey = currentRun.id,
                            label = "Concrete bags/post",
                            initialValue = currentRun.concreteBagsPerPost,
                            modifier = Modifier.weight(1f)
                        ) { viewModel.update { r -> r.copy(concreteBagsPerPost = it) } }
                    }
                    if (locked) {
                        Text(
                            "Post spacing follows panel width automatically for this fence type.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
            item {
                OutlinedButton(onClick = { viewModel.delete(onDeleted) }, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Filled.Delete, contentDescription = null)
                    Text("  Delete This Run")
                }
            }
        }
    }
}

@Composable
private fun SectionCard(title: String, content: @Composable () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FenceTypeDropdown(current: FenceType, onSelect: (FenceType) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = current.name.replace("_", " "), onValueChange = {}, readOnly = true,
            label = { Text("Fence type") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor()
        )
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            FenceType.values().filter { it != FenceType.UNIVERSAL }.forEach { type ->
                DropdownMenuItem(
                    text = { Text(type.name.replace("_", " ")) },
                    onClick = { onSelect(type); expanded = false }
                )
            }
        }
    }
}

@Composable
private fun VinylFields(run: FenceRun, viewModel: RunEditViewModel) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        DraftNumberField(stableKey = run.id, label = "Panel width (ft)", initialValue = run.panelWidthFt, modifier = Modifier.weight(1f)) {
            viewModel.update { r -> r.copy(panelWidthFt = it, postSpacingFt = it) }
        }
        DraftNumberField(stableKey = run.id, label = "Panel height (ft)", initialValue = run.panelHeightFt, modifier = Modifier.weight(1f)) {
            viewModel.update { r -> r.copy(panelHeightFt = it) }
        }
    }
}

@Composable
private fun AluminumFields(run: FenceRun, viewModel: RunEditViewModel) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        DraftNumberField(stableKey = run.id, label = "Panel width (ft)", initialValue = run.panelWidthFt, modifier = Modifier.weight(1f)) {
            viewModel.update { r -> r.copy(panelWidthFt = it, postSpacingFt = it) }
        }
        DraftNumberField(stableKey = run.id, label = "Panel height (ft)", initialValue = run.panelHeightFt, modifier = Modifier.weight(1f)) {
            viewModel.update { r -> r.copy(panelHeightFt = it) }
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Rackable (follows slope)", modifier = Modifier.weight(1f))
        Switch(
            checked = run.aluminumStyle == AluminumStyle.RACKABLE,
            onCheckedChange = { checked ->
                viewModel.update { r -> r.copy(aluminumStyle = if (checked) AluminumStyle.RACKABLE else AluminumStyle.FLAT_TOP) }
            }
        )
    }
}

@Composable
private fun WoodFields(run: FenceRun, viewModel: RunEditViewModel) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Spaced picket (vs. privacy)", modifier = Modifier.weight(1f))
        Switch(
            checked = run.woodStyle == WoodStyle.SPACED_PICKET,
            onCheckedChange = { checked ->
                viewModel.update { r ->
                    r.copy(
                        woodStyle = if (checked) WoodStyle.SPACED_PICKET else WoodStyle.PRIVACY,
                        picketGapIn = if (checked) r.picketGapIn.takeIf { it > 0f } ?: 2f else 0f
                    )
                }
            }
        )
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        DraftNumberField(stableKey = run.id, label = "Fence height (ft)", initialValue = run.panelHeightFt, modifier = Modifier.weight(1f)) { newHeight ->
            viewModel.update { r ->
                r.copy(panelHeightFt = newHeight, woodRailCount = if (newHeight > 4f) 3 else 2)
            }
        }
        DraftNumberField(stableKey = run.id, label = "Rail count", initialValue = run.woodRailCount.toFloat(), modifier = Modifier.weight(1f)) {
            viewModel.update { r -> r.copy(woodRailCount = it.toInt().coerceAtLeast(1)) }
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        DraftNumberField(stableKey = run.id, label = "Picket width (in)", initialValue = run.picketWidthIn, modifier = Modifier.weight(1f)) {
            viewModel.update { r -> r.copy(picketWidthIn = it) }
        }
        if (run.woodStyle == WoodStyle.SPACED_PICKET) {
            DraftNumberField(stableKey = run.id, label = "Gap between pickets (in)", initialValue = run.picketGapIn, modifier = Modifier.weight(1f)) {
                viewModel.update { r -> r.copy(picketGapIn = it) }
            }
        }
    }
}

@Composable
private fun ChainLinkFields(run: FenceRun, viewModel: RunEditViewModel) {
    DraftNumberField(stableKey = run.id, label = "Fabric height (ft)", initialValue = run.fabricHeightFt, modifier = Modifier.fillMaxWidth()) {
        viewModel.update { r -> r.copy(fabricHeightFt = it) }
    }
    ToggleRow("Include top rail", run.includeTopRail) { viewModel.update { r -> r.copy(includeTopRail = it) } }
    ToggleRow("Include bottom tension wire", run.includeTensionWire) { viewModel.update { r -> r.copy(includeTensionWire = it) } }
    ToggleRow("Barbed wire arms (commercial)", run.includeBarbedWireArms) { viewModel.update { r -> r.copy(includeBarbedWireArms = it) } }
    ToggleRow("Privacy slats", run.includePrivacySlats) { viewModel.update { r -> r.copy(includePrivacySlats = it) } }
}

@Composable
private fun SplitRailFields(run: FenceRun, viewModel: RunEditViewModel) {
    DraftNumberField(stableKey = run.id, label = "Rails per section (2 or 3)", initialValue = run.splitRailCount.toFloat(), modifier = Modifier.fillMaxWidth()) {
        viewModel.update { r -> r.copy(splitRailCount = it.toInt().coerceAtLeast(1)) }
    }
}

@Composable
private fun ToggleRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

