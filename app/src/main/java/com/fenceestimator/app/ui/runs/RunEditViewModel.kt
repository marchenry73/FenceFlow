package com.fenceestimator.app.ui.runs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.cloud.SessionManager
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.estimate.TakeoffRefresher
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

    /**
     * Changing WHAT KIND OF FENCE this side is, which is not an ordinary field
     * edit and must not go through [update].
     *
     * Vinyl, wood and chain link pick different catalog rows, different posts
     * and different hardware, so the type IS the price. [update] writes the row
     * and stops; the only re-pricing watcher in the app is on the drawing
     * screen (`SurveyViewModel.watchDrawingForRepricing`), so a side switched
     * here kept the previous type's panels, posts and caps priced on it until
     * somebody pressed Suggest Quantities on the estimate -- with every surface
     * in the app already reading the new type off the row.
     *
     * Delegated to [SideTypesViewModel]'s two steps rather than restated:
     * [RunTypeChange.apply] for the spacing follow and the height carry, then
     * [TakeoffRefresher.refreshAfterTypeChange]. Both pickers, one set of
     * rules.
     */
    fun setFenceType(newType: com.fenceestimator.app.data.FenceType) {
        if (session.state.value.isGuestDemo) return
        val current = run.value ?: return
        if (current.fenceType == newType) return
        viewModelScope.launch {
            // Re-read rather than trusting the screen's copy: another phone's
            // sync or the drawing screen can have moved this row since it was
            // collected, and a type change written over a stale row undoes
            // whatever else moved on it.
            val fresh = repository.getFenceRun(runId) ?: return@launch
            val updated = RunTypeChange.apply(fresh, newType)
            repository.updateFenceRun(updated)
            TakeoffRefresher.refreshAfterTypeChange(
                repository = repository,
                run = updated,
                mayReprice = TakeoffRefresher.mayReprice(session.state.value)
            )
        }
    }

    fun delete(onDeleted: () -> Unit) {
        val current = run.value ?: return
        viewModelScope.launch {
            repository.deleteFenceRun(current)
            onDeleted()
        }
    }
}
