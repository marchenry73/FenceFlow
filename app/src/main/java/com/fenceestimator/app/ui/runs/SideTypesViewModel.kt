package com.fenceestimator.app.ui.runs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.cloud.SessionManager
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.estimate.TakeoffRefresher
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * Setting a side's fence type, and making the price follow.
 *
 * THE ONE ROUTE A TYPE CHANGE TAKES. [RunEditViewModel.setFenceType] delegates
 * to the same two steps for exactly the reason this project keeps relearning:
 * a rule applied at one of two call sites is a rule that holds until somebody
 * uses the other one.
 *
 * Step 1 is pure ([RunTypeChange.apply]) -- the spacing follow and the height
 * carry. Step 2 re-prices ([TakeoffRefresher.refreshAfterTypeChange]), which
 * is the half that did not exist: the only re-pricing watcher in the app is on
 * the drawing screen, so a type set from the run editor left the previous
 * type's panels, posts and caps priced on the side with nothing on any screen
 * disagreeing.
 */
class SideTypesViewModel(
    private val repository: Repository,
    private val jobId: Long,
    /**
     * Read live, not fixed at construction -- the same reason
     * RunEditViewModel, FenceRunListViewModel and SurveyViewModel all take it:
     * a demo or a role change that lands while this card is on screen has to
     * be caught. The drawing screen this card sits on is deliberately open to
     * crew.
     */
    private val session: SessionManager
) : ViewModel() {

    val runs: StateFlow<List<FenceRun>> = repository.observeFenceRuns(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    private val _lastResult = MutableStateFlow<TakeoffRefresher.TypeChangeResult?>(null)

    /**
     * What the last type change did to the money, so the card can say so.
     *
     * Only one of the four outcomes is worth a sentence
     * ([TakeoffRefresher.TypeChangeResult.CLEARED_NOTHING_PRICED]); the others
     * are the price quietly following, which is what he expects and does not
     * need telling. Kept as state rather than a one-shot event because the
     * thing it reports is a condition of the catalog, not a moment -- it is
     * still true when he looks up from the phone.
     */
    val lastResult: StateFlow<TakeoffRefresher.TypeChangeResult?> = _lastResult

    /**
     * Sets one side's fence type and re-prices it.
     *
     * Guest first and before any read, the shape every other write guard in
     * this app uses: refuse before [Repository.updateFenceRun] is ever
     * reached, rather than relying on the card hiding the control.
     *
     * Re-read from the DATABASE rather than taken from [runs]: this is the
     * same hazard `SurveyViewModel.createBlankRun` documents -- the card's
     * copy of a row can be a moment old, and a type change written over a
     * stale row would silently undo whatever else moved on it (a point
     * dragged on the canvas a frame earlier is the realistic case, since this
     * card sits on the drawing screen).
     */
    fun setType(runId: Long, newType: FenceType) {
        if (session.state.value.isGuestDemo) {
            android.util.Log.w("SideTypesViewModel", "guest demo refused write: setType")
            return
        }
        viewModelScope.launch {
            val fresh = repository.getFenceRun(runId)?.takeIf { it.jobId == jobId } ?: return@launch
            if (fresh.fenceType == newType) return@launch
            val updated = RunTypeChange.apply(fresh, newType)
            repository.updateFenceRun(updated)
            _lastResult.value = TakeoffRefresher.refreshAfterTypeChange(
                repository = repository,
                run = updated,
                mayReprice = TakeoffRefresher.mayReprice(session.state.value)
            )
        }
    }
}
