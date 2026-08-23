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
    /**
     * Deletes for good. The one action in the app with no way back, which is
     * why it is confirmed separately rather than sitting next to Restore as an
     * equal-looking button.
     */
    fun purge(record: TrashedRecord) {
        val companyId = session.state.value.companyId ?: return
        viewModelScope.launch {
            _busy.value = true
            TrashBin.purge(companyId, record)
                .onSuccess {
                    _message.value = UiMessage(R.string.vm_permanently_deleted)
                    load()
                }
                .onFailure { _message.value = UiMessage(R.string.vm_couldnt_delete, listOf(it.message.orEmpty())) }
            _busy.value = false
        }
    }

    /**
     * Deletes several for good in one go. Each row is its own request -- a
     * failure on one must not stop the rest -- and the list reloads once at
     * the end rather than flickering per item.
     */
    fun purgeMany(records: List<TrashedRecord>) {
        val companyId = session.state.value.companyId ?: return
        viewModelScope.launch {
            _busy.value = true
            var ok = 0
            var failed = 0
            records.forEach { record ->
                TrashBin.purge(companyId, record)
                    .onSuccess { ok++ }
                    .onFailure { failed++ }
            }
            _message.value = if (failed == 0) UiMessage(R.string.vm_deleted_count, listOf(ok))
                else UiMessage(R.string.vm_deleted_some_failed, listOf(ok, failed))
            load()
            _busy.value = false
        }
    }

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
