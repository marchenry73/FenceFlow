package com.fenceestimator.app.ui.runs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.SessionManager
import com.fenceestimator.app.data.BuildTemplate
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.ui.components.UiMessage
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
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
    /**
     * Told to the screen once, not stored -- a Snackbar, not a field that
     * lingers, the same shape CrewJobViewModel's own `message` uses.
     *
     * [addRun] and [duplicateRun] used to refuse a guest by returning with
     * their `onCreated` callback never invoked at all: no error, no
     * navigation, no explanation for whatever was waiting on it. That is the
     * silent-swallow shape this app's guest-demo waves keep banning
     * elsewhere -- and `onCreated` could not honestly be called instead,
     * because it exists to hand back the id of a run that now exists; a
     * fabricated id would navigate the caller to an editor for a run that
     * was never created, which is worse than saying nothing (a fake
     * feature, not a fix). Emitting here is the honest middle: the refusal
     * still refuses, but it no longer disappears without a trace.
     *
     * Nothing on JobDetailScreen collects this today -- the two buttons
     * that reach these functions are already hidden there for a guest
     * (`ui/jobs/JobDetailScreen.kt`'s own `!session.isGuestDemo` gates), so
     * this refusal is a defence-in-depth path, not the one a real guest
     * would ever hit. That is exactly why the fix stops here rather than
     * also wiring a Snackbar into a screen this file does not own: closing
     * the silent-callback contract at this layer is the honest, minimal
     * step: the screen can start collecting this whenever it is next
     * touched.
     *
     * Checked again this wave, deliberately: a whole-tree search turns up
     * exactly one place either function is called from (JobDetailScreen's
     * own construction of this view model, and its own two call sites),
     * and both of JobDetailScreen's controls -- the duplicate icon
     * (`showDuplicate = !session.isGuestDemo`) and the button that opens
     * `AddRunDialog` -- render nothing at all for a guest, not merely a
     * disabled control. So this stays exactly what it says above: a path a
     * real guest cannot reach today. It is also, right now, the ONLY
     * observable trace this refusal leaves. Repository.guardWrite's own
     * GuestWriteGuard check on [Repository.isGuestSession] is not a second
     * backstop for this write in practice: that field is never assigned
     * true anywhere in this app (by design -- see its own doc), so it
     * reads false for every write, guest or not, and refuses nothing.
     * [SessionManager]'s live `isGuestDemo`, read fresh in [addRun] and
     * [duplicateRun] below, is the only guard actually doing anything here
     * beside JobDetailScreen's own invisible controls. Since nothing
     * collects [message] either, this refusal was otherwise silent to
     * everyone including a developer running a debug build who trips it
     * by some path this trace missed -- which is the one gap worth
     * closing without inventing screen plumbing for a control nobody can
     * press: both guards below also log, so the refusal is at least loud
     * in logcat.
     */
    private val _message = MutableSharedFlow<UiMessage>(extraBufferCapacity = 1)
    val message: SharedFlow<UiMessage> = _message

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
        if (session.state.value.isGuestDemo) {
            // No screen collects `message` (see its own doc above), so this
            // is the only place this refusal is actually observable right
            // now -- loud for whoever is at a debug build's logcat, not for
            // the guest, who cannot reach this line through JobDetailScreen.
            android.util.Log.w("FenceRunListViewModel", "guest demo refused write: addRun")
            _message.tryEmit(UiMessage(R.string.onb_access_changed_guest_body))
            return
        }
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
        if (session.state.value.isGuestDemo) {
            // See addRun's identical guard above for why this logs.
            android.util.Log.w("FenceRunListViewModel", "guest demo refused write: duplicateRun")
            _message.tryEmit(UiMessage(R.string.onb_access_changed_guest_body))
            return
        }
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
