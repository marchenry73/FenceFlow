package com.fenceestimator.app.ui.jobs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.AccessRefusal
import com.fenceestimator.app.cloud.AccessRequestStatus
import com.fenceestimator.app.cloud.AccessResult
import com.fenceestimator.app.cloud.JobAccess
import com.fenceestimator.app.cloud.JobAccessRequest
import com.fenceestimator.app.cloud.JobAssignment
import com.fenceestimator.app.cloud.JobScope
import com.fenceestimator.app.cloud.SessionManager
import com.fenceestimator.app.ui.components.UiMessage
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * "Also on this job" on the job screen: the extra crew and the people let in
 * (job_assignments), this job's waiting requests, and changing them
 * (set_job_crew, end_job_assignment, decide_job_access through [JobAccess]).
 *
 * The lead is not here. It stays the job's own assignee, picked on the job
 * screen and saved with the job the way it always was; the server only adds
 * this list beside it.
 *
 * Read for someone who assigns work (SCHEDULE_AND_ASSIGN) and, read-only, for
 * anyone else the server shows every job. A scoped crew member's phone can
 * read only its own rows, which would make "also on this job" a list of one,
 * so it is not asked at all. Nothing is shown on a server without the crew
 * scope: [State.available] stays false until a read has actually worked.
 */
class JobCrewViewModel(
    private val session: SessionManager,
    private val online: StateFlow<Boolean>,
    private val jobSyncId: String
) : ViewModel() {

    data class State(
        /** The server has job_assignments and this person may read it; false hides the section. */
        val available: Boolean = false,
        /** Open rows on this job, lead included if the office also listed them. */
        val assignments: List<JobAssignment> = emptyList(),
        /** This job's waiting requests -- read only for someone who answers them. */
        val requests: List<JobAccessRequest> = emptyList(),
        /** A change is in flight: the controls wait for it. */
        val busy: Boolean = false
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state

    private val _message = MutableStateFlow<UiMessage?>(null)
    val message: StateFlow<UiMessage?> = _message
    fun consumeMessage() { _message.value = null }

    private var reading: Job? = null

    init {
        viewModelScope.launch { online.collect { up -> if (up) load() } }
        // The scope settling after the first sync decides whether there is
        // anything to read at all.
        viewModelScope.launch { JobAccess.scope.collect { load() } }
        viewModelScope.launch { JobAccess.changes.collect { load() } }
    }

    fun load() {
        val s = session.state.value
        val company = s.companyId
        val scope = JobAccess.scope.value
        val mayRead = s.canScheduleAndAssign || scope is JobScope.SeesAll
        if (company == null || !scope.isDeployed || !mayRead) {
            reading?.cancel()
            _state.value = State()
            return
        }
        // Offline keeps whatever was last read; the section says it needs a
        // connection to change anything.
        if (!online.value) return
        reading?.cancel()
        reading = viewModelScope.launch {
            when (val a = JobAccess.readAssignments(company, jobSyncId)) {
                is AccessResult.Ok -> _state.update { it.copy(available = true, assignments = a.value) }
                is AccessResult.Refused -> {
                    // The table missing (or no longer readable) hides the
                    // section; a dropped signal keeps what is on screen.
                    if (a.reason == AccessRefusal.NOT_AVAILABLE || a.reason == AccessRefusal.NOT_ALLOWED) {
                        _state.value = State()
                        return@launch
                    }
                }
            }
            if (s.canScheduleAndAssign) {
                JobAccess.readRequests(company, jobSyncId = jobSyncId, status = AccessRequestStatus.PENDING)
                    .getOrNull()
                    ?.let { asks -> _state.update { it.copy(requests = asks.sortedBy { q -> q.createdAt ?: 0L }) } }
            }
        }
    }

    /**
     * Puts [employeeSyncId] on the job as extra crew. set_job_crew replaces
     * the whole list, so the list is read again first -- never trusted from
     * the screen, which may be minutes old and would end whoever the office
     * added since -- and sent back whole with the new person on it
     * ([crewAfterAdding]).
     */
    fun add(employeeSyncId: String) = change {
        val company = session.state.value.companyId ?: return@change UiMessage(R.string.access_refused_signed_out)
        when (val fresh = JobAccess.readAssignments(company, jobSyncId)) {
            is AccessResult.Refused -> UiMessage(accessRefusalText(fresh.reason, AccessAction.CREW))
            is AccessResult.Ok -> when (val r = JobAccess.setJobCrew(jobSyncId, crewAfterAdding(fresh.value, employeeSyncId))) {
                is AccessResult.Ok -> UiMessage(R.string.job_crew_added)
                is AccessResult.Refused -> UiMessage(accessRefusalText(r.reason, AccessAction.CREW))
            }
        }
    }

    /** Takes someone off the job -- extra crew or let in. Their row is kept, ended. */
    fun remove(assignment: JobAssignment) = change {
        when (val r = JobAccess.endAssignment(assignment.id)) {
            is AccessResult.Ok -> UiMessage(if (r.value) R.string.job_crew_removed else R.string.job_crew_already_off)
            is AccessResult.Refused -> UiMessage(accessRefusalText(r.reason, AccessAction.CREW))
        }
    }

    fun decide(requestId: String, approve: Boolean, note: String = "") = change {
        UiMessage(decisionOutcome(JobAccess.decideRequest(requestId, approve, note), approve))
    }

    /** One change at a time, online only; every outcome is said, and the list read again. */
    private fun change(block: suspend () -> UiMessage) {
        if (!online.value) {
            _message.value = UiMessage(R.string.job_crew_offline)
            return
        }
        if (_state.value.busy) return
        _state.update { it.copy(busy = true) }
        viewModelScope.launch {
            try {
                _message.value = block()
            } finally {
                _state.update { it.copy(busy = false) }
                load()
            }
        }
    }
}
