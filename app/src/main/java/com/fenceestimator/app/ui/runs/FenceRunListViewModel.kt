package com.fenceestimator.app.ui.runs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.cloud.SessionManager
import com.fenceestimator.app.data.BuildTemplate
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.Repository
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class FenceRunListViewModel(
    private val repository: Repository,
    private val jobId: Long,
    /**
     * Who is holding the phone, so [addRun] and [duplicateRun] have their own
     * refusal for a guest in the read-only demo -- the same reference
     * RunEditViewModel, JobDetailViewModel, CrewJobViewModel and SurveyViewModel
     * already take, and for the same reason: read live rather than fixed at
     * construction, so a demo that starts or ends while this screen is
     * already open is still caught.
     *
     * Until now this view model was the one gap: JobDetailScreen's own
     * `if (!session.isGuestDemo)` around the two buttons that call
     * [addRun] and [duplicateRun] was the only thing standing between a guest
     * and a write, with nothing behind it -- the shape of the last three
     * regressions in this app's guest demo. This is the second line of
     * defence, not the only one.
     */
    private val session: SessionManager
) : ViewModel() {
    val runs: StateFlow<List<FenceRun>> = repository.observeFenceRuns(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    /** Shipped ∪ this company's own, for the Add Fence Run template picker. */
    val templates: StateFlow<List<BuildTemplate>> = repository.observeBuildTemplates()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    /**
     * Starts a new run, either from a chosen [template] (its spec is copied
     * on by [FenceRun.fromTemplate], including the fence type it carries) or
     * from [defaultSpacingFor]'s hardcoded numbers when no template was
     * offered or chosen -- the fallback this app has always had.
     */
    fun addRun(
        label: String,
        fenceType: FenceType,
        defaults: BusinessProfile,
        template: BuildTemplate? = null,
        isTeardown: Boolean = false,
        onCreated: (Long) -> Unit
    ) {
        if (session.state.value.isGuestDemo) return
        viewModelScope.launch {
            val nextOrder = (runs.value.maxOfOrNull { it.sortOrder } ?: -1) + 1
            // Applied on both branches on purpose. A run started from a build
            // template still has to be markable as the old fence coming out --
            // patching only the plain constructor below meant a teardown run
            // built from a template silently lost the flag and was billed as
            // new fence to build.
            val run = if (template != null) {
                FenceRun.fromTemplate(template, jobId = jobId, label = label, sortOrder = nextOrder)
                    .copy(isTeardown = isTeardown)
            } else {
                FenceRun(
                    jobId = jobId,
                    label = label,
                    fenceType = fenceType,
                    sortOrder = nextOrder,
                    isTeardown = isTeardown,
                    panelWidthFt = defaults.defaultPanelWidthFt,
                    panelHeightFt = defaults.defaultPanelHeightFt,
                    postSpacingFt = defaultSpacingFor(fenceType, defaults.defaultPanelWidthFt, defaults.defaultPostSpacingFt),
                    concreteBagsPerPost = defaults.defaultConcreteBagsPerPost
                )
            }
            val id = repository.createFenceRun(run)
            onCreated(id)
        }
    }

    fun duplicateRun(run: FenceRun, onCreated: (Long) -> Unit) {
        if (session.state.value.isGuestDemo) return
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
