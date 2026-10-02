package com.fenceestimator.app.ui.runs

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.fenceestimator.app.R
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.ui.components.label

/**
 * THE fence-type picker. One of them.
 *
 * It was private to RunEditScreen; the drawing screen now needs the same
 * control, and this project already paid for the alternative -- the company
 * name lives in `companies.*` AND in the settings blob, and nothing reads both
 * (docs: "FenceFlow two company stores"). Two pickers for one fact is the same
 * mistake with a shorter fuse: the day one of them stops applying
 * [RunTypeChange.apply] is the day a side's height silently stops following
 * its type on one screen and not the other.
 *
 * UNIVERSAL is filtered out, as it always has been. It is a CATALOG value --
 * "this post fits any fence" -- not a fence somebody builds, and a run set to
 * it prices nothing at all (`suggestQuantities`' `FenceType.UNIVERSAL -> {}`).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FenceTypeDropdown(
    current: FenceType,
    editable: Boolean,
    modifier: Modifier = Modifier.fillMaxWidth(),
    label: String? = null,
    onSelect: (FenceType) -> Unit
) {
    var expanded by remember { mutableStateOf(false) }
    val fieldLabel = label ?: stringResource(R.string.est2_fence_type)
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { if (editable) expanded = it }) {
        OutlinedTextField(
            value = current.label(), onValueChange = {}, readOnly = true,
            enabled = editable,
            label = { Text(fieldLabel) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = modifier.menuAnchor()
        )
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            FenceType.values().filter { it != FenceType.UNIVERSAL }.forEach { type ->
                DropdownMenuItem(
                    text = { Text(type.label()) },
                    onClick = { onSelect(type); expanded = false }
                )
            }
        }
    }
}
