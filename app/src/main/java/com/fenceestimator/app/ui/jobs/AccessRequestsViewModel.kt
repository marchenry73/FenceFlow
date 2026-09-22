package com.fenceestimator.app.ui.jobs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.AccessRefusal
import com.fenceestimator.app.cloud.AccessRequestStatus
import com.fenceestimator.app.cloud.AccessResult
import com.fenceestimator.app.cloud.JobAccess
import com.fenceestimator.app.cloud.JobAccessRequest
import com.fenceestimator.app.cloud.SessionManager
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.ui.components.UiMessage
import kotlinx.coroutines.Job as CoroutineJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** A waiting request with the names this phone can put to it. */
data class PendingAsk(
    val request: JobAccessRequest,
    /** The crew member who asked, from this phone's crew list; null when it has not arrived here. */
    val personName: String?,
    /** The job, when this phone holds it (an office phone holds every job). */
    val job: Job?
)

/**
 * "N crew asked for access": the waiting requests, and answering them
 * (decide_job_access through [JobAccess]). For someone holding
 * SCHEDULE_AND_ASSIGN -- the server refuses anyone else, and never lets a
 * person answer their own. Online only: an answer is a decision the crew
 * member is waiting on, and one queued on a phone in a dead spot is one they
 * never get.
 */
class AccessRequestsViewModel(
    repository: Repository,
    private val session: SessionManager,
    private val online: StateFlow<Boolean>
) : ViewModel() {

    data class State(
        val loading: Boolean = true,
        val requests: List<JobAccessRequest> = emptyList(),
        /** Why the list could not be read the last time, if it could not. */
        val refusal: AccessRefusal? = null,
        /** Requests with an answer in flight, so their buttons wait. */
        val busy: Set<String> = emptySet()
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state

    /** [state]'s requests, named from this phone's own crew list and jobs. */
    val asks: StateFlow<List<PendingAsk>> = combine(
        _state, repository.observeEmployees(), repository.observeJobs(), repository.observeHeldJobs()
    ) { s, employees, jobs, held ->
        val people = employees.associateBy { it.syncId }
        val bySync = (jobs + held).associateBy { it.syncId }
        s.requests.map { r ->
            PendingAsk(r, people[r.employeeSyncId]?.name?.takeIf { it.isNotBlank() }, bySync[r.jobSyncId])
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    private val _message = MutableStateFlow<UiMessage?>(null)
    val message: StateFlow<UiMessage?> = _message
    fun consumeMessage() { _message.value = null }

    private var reading: CoroutineJob? = null

    init {
        viewModelScope.launch {
            online.collect { up -> if (up) load() else _state.update { it.copy(loading = false) } }
        }
        // A new ask arriving on the change feed, or an answer given here.
        viewModelScope.launch { JobAccess.changes.collect { load() } }
    }

    fun load() {
        if (!online.value) {
            _state.update { it.copy(loading = false) }
            return
        }
        val company = session.state.value.companyId
        if (company == null) {
            _state.update { it.copy(loading = false, refusal = AccessRefusal.SIGNED_OUT) }
            return
        }
        reading?.cancel()
        reading = viewModelScope.launch {
            when (val r = JobAccess.readRequests(company, status = AccessRequestStatus.PENDING)) {
                // Oldest first: whoever has waited longest is answered first.
                is AccessResult.Ok -> _state.update {
                    it.copy(loading = false, requests = r.value.sortedBy { q -> q.createdAt ?: 0L }, refusal = null)
                }
                is AccessResult.Refused -> _state.update { it.copy(loading = false, refusal = r.reason) }
            }
        }
    }

    fun decide(requestId: String, approve: Boolean, note: String = "") {
        if (!online.value) {
            _message.value = UiMessage(R.string.access_needs_connection)
            return
        }
        if (requestId in _state.value.busy) return
        _state.update { it.copy(busy = it.busy + requestId) }
        viewModelScope.launch {
            try {
                val result = JobAccess.decideRequest(requestId, approve, note)
                _message.value = UiMessage(decisionOutcome(result, approve))
                // An Ok reloads through JobAccess.changes; a refusal may mean
                // the request or the feature is gone, so look again.
                if (result is AccessResult.Refused) load()
            } finally {
                _state.update { it.copy(busy = it.busy - requestId) }
            }
        }
    }
}

/**
 * What to say after answering a request: said yes, said no, somebody else
 * got there first (decide_job_access answers false for a request no longer
 * waiting), or why not. Shared by the requests screen and the job screen.
 */
internal fun decisionOutcome(result: AccessResult<Boolean>, approve: Boolean): Int = when (result) {
    is AccessResult.Ok -> when {
        !result.value -> R.string.access_already_answered_other
        approve -> R.string.access_approved
        else -> R.string.access_declined
    }
    is AccessResult.Refused -> accessRefusalText(result.reason, AccessAction.ANSWER)
}
