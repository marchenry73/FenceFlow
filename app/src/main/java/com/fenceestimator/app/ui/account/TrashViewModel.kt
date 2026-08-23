package com.fenceestimator.app.ui.account

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.cloud.AutoSync
import com.fenceestimator.app.cloud.SessionManager
import com.fenceestimator.app.cloud.TrashBin
import com.fenceestimator.app.cloud.TrashedRecord
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

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message

    fun load() {
        val companyId = session.state.value.companyId ?: run {
            _message.value = "Sign in to your company to see deleted items."
            return
        }
        viewModelScope.launch {
            _busy.value = true
            TrashBin.list(companyId)
                .onSuccess { _items.value = it }
                .onFailure { _message.value = "Couldn't load deleted items: ${it.message}" }
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
                    _message.value = "Permanently deleted."
                    load()
                }
                .onFailure { _message.value = "Couldn't delete it: ${it.message}" }
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
            _message.value = if (failed == 0) "Permanently deleted $ok item(s)."
                else "Deleted $ok; $failed couldn't be deleted."
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
                    _message.value = "\"${record.label}\" is back."
                    autoSync.requestSync()
                    load()
                }
                .onFailure { _message.value = "Couldn't restore it: ${it.message}" }
            _busy.value = false
        }
    }
}
