package com.fenceestimator.app.ui.inventory

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.SessionManager
import com.fenceestimator.app.data.InventoryChecklistItem
import com.fenceestimator.app.data.InventoryKind
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.ui.components.UiMessage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class InventoryViewModel(
    private val repository: Repository,
    private val jobId: Long,
    /**
     * Who is holding the phone, so every write funnel below can refuse a
     * guest in the read-only demo. Read live, the way every other view model
     * in this app reaches the session, rather than a boolean frozen at
     * construction.
     */
    private val session: SessionManager
) : ViewModel() {
    val items: StateFlow<List<InventoryChecklistItem>> = repository.observeInventory(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    /**
     * What ensureToolsSeeded would have inserted, computed fresh and never
     * written. The guest demo still needs a sensible Tools list to look at --
     * the fix for the start-up write is not to leave the screen blank, it is
     * to stop persisting what it shows.
     */
    private val guestToolPreviewCsv = MutableStateFlow("")
    val guestToolPreview: StateFlow<List<InventoryChecklistItem>> = guestToolPreviewCsv.map { csv ->
        csv.split(",").map { it.trim() }.filter { it.isNotBlank() }
            .mapIndexed { i, name -> InventoryChecklistItem(jobId = jobId, kind = InventoryKind.TOOL, description = name, sortOrder = i) }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    /**
     * What syncMaterialsFromEstimate would have written, computed live off
     * the real line items instead of a stored copy -- so the guest's
     * Materials section always matches the estimate without ever being
     * persisted or needing the Sync button.
     */
    val guestMaterialPreview: StateFlow<List<InventoryChecklistItem>> = repository.observeLineItems(jobId).map { lineItems ->
        lineItems.mapIndexed { i, li ->
            val qtyStr = if (li.quantity % 1.0 == 0.0) li.quantity.toInt().toString() else li.quantity.toString()
            InventoryChecklistItem(
                jobId = jobId, kind = InventoryKind.MATERIAL,
                description = "$qtyStr ${li.unit} -- ${li.description}", sortOrder = i
            )
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    // toggle/attachPhoto/delete used to fire and forget -- a checked box or a
    // deleted row would look identical whether the local write actually
    // landed or Room threw. This app is offline-first, so being offline is
    // never the cause of a failure here; only a genuine local-write error is.
    private val _message = MutableStateFlow<UiMessage?>(null)
    val message: StateFlow<UiMessage?> = _message

    fun ensureToolsSeeded(defaultToolsCsv: String) {
        // The worst of the writes this screen made: nobody pressed anything,
        // opening the screen was enough. A guest gets the same list shown
        // (guestToolPreview, above) with nothing persisted behind it.
        if (session.state.value.isGuestDemo) {
            guestToolPreviewCsv.value = defaultToolsCsv
            return
        }
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
        if (session.state.value.isGuestDemo) return
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
        if (session.state.value.isGuestDemo) return
        viewModelScope.launch {
            runCatching { repository.updateInventoryItem(item.copy(checked = !item.checked)) }
                .onFailure { _message.value = UiMessage(R.string.vm_couldnt_update_item, listOf(it.message.orEmpty())) }
        }
    }

    fun addCustom(kind: InventoryKind, description: String) {
        if (session.state.value.isGuestDemo) return
        if (description.isBlank()) return
        viewModelScope.launch {
            val nextOrder = (items.value.filter { it.kind == kind }.maxOfOrNull { it.sortOrder } ?: -1) + 1
            repository.addInventoryItem(InventoryChecklistItem(jobId = jobId, kind = kind, description = description, sortOrder = nextOrder))
        }
    }

    fun delete(item: InventoryChecklistItem) {
        if (session.state.value.isGuestDemo) return
        viewModelScope.launch {
            runCatching { repository.deleteInventoryItem(item) }
                .onFailure { _message.value = UiMessage(R.string.vm_couldnt_delete_item, listOf(it.message.orEmpty())) }
        }
    }

    fun attachPhoto(item: InventoryChecklistItem, path: String) {
        if (session.state.value.isGuestDemo) return
        viewModelScope.launch {
            runCatching { repository.updateInventoryItem(item.copy(photoPath = path)) }
                .onFailure { _message.value = UiMessage(R.string.vm_couldnt_attach_photo, listOf(it.message.orEmpty())) }
        }
    }
}
