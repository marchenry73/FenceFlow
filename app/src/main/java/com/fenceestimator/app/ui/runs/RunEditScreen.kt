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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.R
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
                title = { Text(currentRun.label.ifBlank { stringResource(R.string.est2_fence_run_title) }) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back)) } }
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
                    Text("  " + stringResource(if (hasLine) R.string.est2_edit_drawing else R.string.est2_next_draw_fence))
                }
                if (!hasLine) {
                    Text(
                        stringResource(R.string.est2_set_type_first),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            item {
                SectionCard(stringResource(R.string.est2_section_run)) {
                    DraftTextField(
                        stableKey = currentRun.id, initialValue = currentRun.label,
                        label = stringResource(R.string.est2_run_label_hint), modifier = Modifier.fillMaxWidth()
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
                        label = stringResource(R.string.est2_color_finish), modifier = Modifier.fillMaxWidth()
                    ) { viewModel.update { r -> r.copy(colorOrFinish = it) } }
                }
            }
            item {
                when (currentRun.fenceType) {
                    FenceType.VINYL -> SectionCard(stringResource(R.string.est2_spec_vinyl)) { VinylFields(currentRun, viewModel) }
                    FenceType.ALUMINUM -> SectionCard(stringResource(R.string.est2_spec_aluminum)) { AluminumFields(currentRun, viewModel) }
                    FenceType.ORNAMENTAL_IRON -> SectionCard(stringResource(R.string.est2_spec_ornamental_iron)) { VinylFields(currentRun, viewModel) }
                    FenceType.WOOD -> SectionCard(stringResource(R.string.est2_spec_wood)) { WoodFields(currentRun, viewModel) }
                    FenceType.COMPOSITE -> SectionCard(stringResource(R.string.est2_spec_composite)) { WoodFields(currentRun, viewModel) }
                    FenceType.SPLIT_RAIL -> SectionCard(stringResource(R.string.est2_spec_split_rail)) { SplitRailFields(currentRun, viewModel) }
                    FenceType.CHAIN_LINK -> SectionCard(stringResource(R.string.est2_spec_chain_link)) { ChainLinkFields(currentRun, viewModel) }
                    FenceType.UNIVERSAL -> {}
                }
            }
            item {
                SectionCard(stringResource(R.string.est2_section_posts_concrete)) {
                    val locked = currentRun.fenceType == FenceType.VINYL || currentRun.fenceType == FenceType.ALUMINUM || currentRun.fenceType == FenceType.ORNAMENTAL_IRON
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        DraftNumberField(
                            stableKey = currentRun.id,
                            label = stringResource(R.string.est2_post_spacing_ft),
                            initialValue = currentRun.postSpacingFt,
                            enabled = !locked,
                            modifier = Modifier.weight(1f)
                        ) { viewModel.update { r -> r.copy(postSpacingFt = it) } }
                        DraftNumberField(
                            stableKey = currentRun.id,
                            label = stringResource(R.string.est2_concrete_bags_per_post),
                            initialValue = currentRun.concreteBagsPerPost,
                            modifier = Modifier.weight(1f)
                        ) { viewModel.update { r -> r.copy(concreteBagsPerPost = it) } }
                    }
                    if (locked) {
                        Text(
                            stringResource(R.string.est2_post_spacing_follows_panel),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
            item {
                OutlinedButton(onClick = { viewModel.delete(onDeleted) }, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Filled.Delete, contentDescription = null)
                    Text("  " + stringResource(R.string.est2_delete_this_run))
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
            label = { Text(stringResource(R.string.est2_fence_type)) },
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
        DraftNumberField(stableKey = run.id, label = stringResource(R.string.est2_panel_width_ft), initialValue = run.panelWidthFt, modifier = Modifier.weight(1f)) {
            viewModel.update { r -> r.copy(panelWidthFt = it, postSpacingFt = it) }
        }
        DraftNumberField(stableKey = run.id, label = stringResource(R.string.est2_panel_height_ft), initialValue = run.panelHeightFt, modifier = Modifier.weight(1f)) {
            viewModel.update { r -> r.copy(panelHeightFt = it) }
        }
    }
}

@Composable
private fun AluminumFields(run: FenceRun, viewModel: RunEditViewModel) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        DraftNumberField(stableKey = run.id, label = stringResource(R.string.est2_panel_width_ft), initialValue = run.panelWidthFt, modifier = Modifier.weight(1f)) {
            viewModel.update { r -> r.copy(panelWidthFt = it, postSpacingFt = it) }
        }
        DraftNumberField(stableKey = run.id, label = stringResource(R.string.est2_panel_height_ft), initialValue = run.panelHeightFt, modifier = Modifier.weight(1f)) {
            viewModel.update { r -> r.copy(panelHeightFt = it) }
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.est2_rackable), modifier = Modifier.weight(1f))
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
        Text(stringResource(R.string.est2_spaced_picket), modifier = Modifier.weight(1f))
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
        DraftNumberField(stableKey = run.id, label = stringResource(R.string.est2_fence_height_ft), initialValue = run.panelHeightFt, modifier = Modifier.weight(1f)) { newHeight ->
            viewModel.update { r ->
                r.copy(panelHeightFt = newHeight, woodRailCount = if (newHeight > 4f) 3 else 2)
            }
        }
        DraftNumberField(stableKey = run.id, label = stringResource(R.string.est2_rail_count), initialValue = run.woodRailCount.toFloat(), modifier = Modifier.weight(1f)) {
            viewModel.update { r -> r.copy(woodRailCount = it.toInt().coerceAtLeast(1)) }
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        DraftNumberField(stableKey = run.id, label = stringResource(R.string.est2_picket_width_in), initialValue = run.picketWidthIn, modifier = Modifier.weight(1f)) {
            viewModel.update { r -> r.copy(picketWidthIn = it) }
        }
        if (run.woodStyle == WoodStyle.SPACED_PICKET) {
            DraftNumberField(stableKey = run.id, label = stringResource(R.string.est2_picket_gap_in), initialValue = run.picketGapIn, modifier = Modifier.weight(1f)) {
                viewModel.update { r -> r.copy(picketGapIn = it) }
            }
        }
    }
}

@Composable
private fun ChainLinkFields(run: FenceRun, viewModel: RunEditViewModel) {
    DraftNumberField(stableKey = run.id, label = stringResource(R.string.est2_fabric_height_ft), initialValue = run.fabricHeightFt, modifier = Modifier.fillMaxWidth()) {
        viewModel.update { r -> r.copy(fabricHeightFt = it) }
    }
    ToggleRow(stringResource(R.string.est2_include_top_rail), run.includeTopRail) { viewModel.update { r -> r.copy(includeTopRail = it) } }
    ToggleRow(stringResource(R.string.est2_include_tension_wire), run.includeTensionWire) { viewModel.update { r -> r.copy(includeTensionWire = it) } }
    ToggleRow(stringResource(R.string.est2_barbed_wire_arms), run.includeBarbedWireArms) { viewModel.update { r -> r.copy(includeBarbedWireArms = it) } }
    ToggleRow(stringResource(R.string.est2_privacy_slats), run.includePrivacySlats) { viewModel.update { r -> r.copy(includePrivacySlats = it) } }
}

@Composable
private fun SplitRailFields(run: FenceRun, viewModel: RunEditViewModel) {
    DraftNumberField(stableKey = run.id, label = stringResource(R.string.est2_rails_per_section), initialValue = run.splitRailCount.toFloat(), modifier = Modifier.fillMaxWidth()) {
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

