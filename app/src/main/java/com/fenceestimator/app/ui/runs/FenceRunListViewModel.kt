package com.fenceestimator.app.ui.runs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.Repository
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class FenceRunListViewModel(private val repository: Repository, private val jobId: Long) : ViewModel() {
    val runs: StateFlow<List<FenceRun>> = repository.observeFenceRuns(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    fun addRun(label: String, fenceType: FenceType, defaults: BusinessProfile, onCreated: (Long) -> Unit) {
        viewModelScope.launch {
            val nextOrder = (runs.value.maxOfOrNull { it.sortOrder } ?: -1) + 1
            val run = FenceRun(
                jobId = jobId,
                label = label,
                fenceType = fenceType,
                sortOrder = nextOrder,
                panelWidthFt = defaults.defaultPanelWidthFt,
                panelHeightFt = defaults.defaultPanelHeightFt,
                postSpacingFt = defaultSpacingFor(fenceType, defaults.defaultPanelWidthFt, defaults.defaultPostSpacingFt),
                concreteBagsPerPost = defaults.defaultConcreteBagsPerPost
            )
            val id = repository.createFenceRun(run)
            onCreated(id)
        }
    }

    fun duplicateRun(run: FenceRun, onCreated: (Long) -> Unit) {
        viewModelScope.launch {
            val nextOrder = (runs.value.maxOfOrNull { it.sortOrder } ?: -1) + 1
            val copy = run.copy(
                id = 0,
                label = if (run.label.isBlank()) "Copy" else "${run.label} (copy)",
                sortOrder = nextOrder,
                pointsEncoded = "",
                gatesEncoded = ""
            )
            val id = repository.createFenceRun(copy)
            onCreated(id)
        }
    }

    fun deleteRun(run: FenceRun) {
        viewModelScope.launch { repository.deleteFenceRun(run) }
    }

    companion object {
        fun defaultSpacingFor(fenceType: FenceType, panelWidthFt: Float, fallback: Float): Float = when (fenceType) {
            FenceType.VINYL, FenceType.ALUMINUM, FenceType.ORNAMENTAL_IRON -> panelWidthFt
            FenceType.WOOD, FenceType.COMPOSITE -> 8f
            FenceType.CHAIN_LINK -> 10f
            FenceType.SPLIT_RAIL -> 8f
            FenceType.UNIVERSAL -> fallback
        }
    }
}
