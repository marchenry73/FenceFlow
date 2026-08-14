package com.fenceestimator.app.ui.runs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.Repository
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class RunEditViewModel(private val repository: Repository, private val runId: Long) : ViewModel() {
    val run: StateFlow<FenceRun?> = repository.observeFenceRun(runId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    fun update(transform: (FenceRun) -> FenceRun) {
        val current = run.value ?: return
        viewModelScope.launch { repository.updateFenceRun(transform(current)) }
    }

    fun delete(onDeleted: () -> Unit) {
        val current = run.value ?: return
        viewModelScope.launch {
            repository.deleteFenceRun(current)
            onDeleted()
        }
    }
}
