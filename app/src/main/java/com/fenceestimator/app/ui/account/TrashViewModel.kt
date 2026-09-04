package com.fenceestimator.app.ui.account

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.AutoSync
import com.fenceestimator.app.cloud.SessionManager
import com.fenceestimator.app.cloud.TrashBin
import com.fenceestimator.app.cloud.TrashedRecord
import com.fenceestimator.app.ui.components.UiMessage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class TrashViewModel(
    private val session: SessionManager,
    private val autoSync: AutoSync
) : ViewModel() {

    private val _items = MutableStateFlow<List<TrashedRecord>>(emptyList())
    val items: StateFlow<List<TrashedRecord>> = _items

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy

    private val _message = MutableStateFlow<UiMessage?>(null)
    val message: StateFlow<UiMessage?> = _message

    fun load() {
        val companyId = session.state.value.companyId ?: run {
            _message.value = UiMessage(R.string.vm_sign_in_deleted_items)
            return
        }
        viewModelScope.launch {
            _busy.value = true
            TrashBin.list(companyId)
                .onSuccess { _items.value = it }
                .onFailure { _message.value = UiMessage(R.string.vm_couldnt_load_deleted, listOf(it.message.orEmpty())) }
            _busy.value = false
        }
    }

    /**
     * Clears the tombstone and lets sync bring it back.
     *
     * Nothing is written locally. The record becomes live in the cloud again and
     * arrives the same way any other record does -- so it lands on every device
     * rather than only this one, and it comes down the path that has already
     * been made to behave correctly.
     */
    // "Purge forever" used to call TrashBin.purge, which the database refuses
    // for every role -- there is no DELETE policy on this table for anyone,
    // owner included. The call returned success and did nothing, so someone
    // who purged an item saw it come right back on the next load with no
    // explanation. Removed rather than fixed: nothing in this app is meant to
    // be destroyed, and Restore already covers the only path anyone needs.
    fun restore(record: TrashedRecord) {
        val companyId = session.state.value.companyId ?: return
        viewModelScope.launch {
            _busy.value = true
            TrashBin.restore(companyId, record)
                .onSuccess {
                    _message.value = UiMessage(R.string.vm_restored_back, listOf(record.label))
                    autoSync.requestSync()
                    load()
                }
                .onFailure { _message.value = UiMessage(R.string.vm_couldnt_restore, listOf(it.message.orEmpty())) }
            _busy.value = false
        }
    }
}
