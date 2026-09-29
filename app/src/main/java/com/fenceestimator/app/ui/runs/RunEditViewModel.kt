package com.fenceestimator.app.ui.runs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.cloud.SessionManager
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.Repository
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class RunEditViewModel(
    private val repository: Repository,
    private val runId: Long,
    /**
     * Who is holding the phone, so [update] can refuse a guest in the
     * read-only demo -- the same reference JobDetailViewModel takes and for
     * the same reason: read live rather than as a boolean fixed at
     * construction, so a demo that starts or ends while this screen is
     * already open is still caught.
     *
     * Every field on this screen is disabled today by RunEditScreen's own
     * `editable` (see the comment there), which is what has kept this table
     * safe so far -- but that was equally true of the twelve controls closed
     * elsewhere in this wave, right up until one of them was not. This is the
     * second line of defence, not the only one.
     */
    private val session: SessionManager
) : ViewModel() {
    val run: StateFlow<FenceRun?> = repository.observeFenceRun(runId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    fun update(transform: (FenceRun) -> FenceRun) {
        if (session.state.value.isGuestDemo) return
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
