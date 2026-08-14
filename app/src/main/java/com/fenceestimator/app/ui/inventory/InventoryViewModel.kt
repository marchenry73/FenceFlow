package com.fenceestimator.app.ui.inventory

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.data.InventoryChecklistItem
import com.fenceestimator.app.data.InventoryKind
import com.fenceestimator.app.data.Repository
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class InventoryViewModel(private val repository: Repository, private val jobId: Long) : ViewModel() {
    val items: StateFlow<List<InventoryChecklistItem>> = repository.observeInventory(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    fun ensureToolsSeeded(defaultToolsCsv: String) {
        viewModelScope.launch {
            val current = repository.getInventory(jobId)
            if (current.none { it.kind == InventoryKind.TOOL }) {
                val tools = defaultToolsCsv.split(",").map { it.trim() }.filter { it.isNotBlank() }
                repository.addInventoryItems(
                    tools.mapIndexed { i, name ->
                        InventoryChecklistItem(jobId = jobId, kind = InventoryKind.TOOL, description = name, sortOrder = i)
                    }
                )
            }
        }
    }

    fun syncMaterialsFromEstimate() {
        viewModelScope.launch {
            repository.clearInventoryMaterials(jobId)
            val lineItems = repository.getLineItems(jobId)
            val materials = lineItems.mapIndexed { i, li ->
                val qtyStr = if (li.quantity % 1.0 == 0.0) li.quantity.toInt().toString() else li.quantity.toString()
                InventoryChecklistItem(
                    jobId = jobId, kind = InventoryKind.MATERIAL,
                    description = "$qtyStr ${li.unit} -- ${li.description}", sortOrder = i
                )
            }
            repository.addInventoryItems(materials)
        }
    }

    fun toggle(item: InventoryChecklistItem) {
        viewModelScope.launch { repository.updateInventoryItem(item.copy(checked = !item.checked)) }
    }

    fun addCustom(kind: InventoryKind, description: String) {
        if (description.isBlank()) return
        viewModelScope.launch {
            val nextOrder = (items.value.filter { it.kind == kind }.maxOfOrNull { it.sortOrder } ?: -1) + 1
            repository.addInventoryItem(InventoryChecklistItem(jobId = jobId, kind = kind, description = description, sortOrder = nextOrder))
        }
    }

    fun delete(item: InventoryChecklistItem) {
        viewModelScope.launch { repository.deleteInventoryItem(item) }
    }

    fun attachPhoto(item: InventoryChecklistItem, path: String) {
        viewModelScope.launch { repository.updateInventoryItem(item.copy(photoPath = path)) }
    }
}
