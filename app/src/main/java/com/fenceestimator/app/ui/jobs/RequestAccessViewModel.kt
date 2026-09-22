package com.fenceestimator.app.ui.jobs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.AccessRefusal
import com.fenceestimator.app.cloud.AccessResult
import com.fenceestimator.app.cloud.JobAccess
import com.fenceestimator.app.cloud.RequestableJob
import com.fenceestimator.app.cloud.SessionManager
import com.fenceestimator.app.ui.components.UiMessage
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * "Other jobs -- request access": won work a scoped crew member is not on,
 * and asking for it (list_requestable_jobs, request_job_access,
 * withdraw_job_access_request through [JobAccess]).
 *
 * Online only, and says so. The list lives on the server -- the phone does
 * not hold jobs it is not on any more -- so there is nothing to show from
 * memory, and an ask made offline would have to be queued and replayed long
 * after the person stopped waiting for it.
 */
class RequestAccessViewModel(
    private val session: SessionManager,
    private val online: StateFlow<Boolean>
) : ViewModel() {

    data class State(
        val loading: Boolean = true,
        val rows: List<RequestableJob> = emptyList(),
        /** Why the list could not be read the last time, if it could not. */
        val refusal: AccessRefusal? = null,
        /** Jobs with an ask or a withdrawal in flight, so their buttons wait. */
        val busy: Set<String> = emptySet()
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state

    private val _message = MutableStateFlow<UiMessage?>(null)
    val message: StateFlow<UiMessage?> = _message
    fun consumeMessage() { _message.value = null }

    private var reading: Job? = null

    init {
        // Read on open and again whenever the signal comes back; offline just
        // stops the spinner, and the screen says it needs a connection.
        viewModelScope.launch {
            online.collect { up -> if (up) load() else _state.update { it.copy(loading = false) } }
        }
        // An answer from the office (the change feed) or an ask made here.
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
            _state.update { it.copy(loading = it.rows.isEmpty()) }
            when (val r = JobAccess.listRequestableJobs(company)) {
                is AccessResult.Ok -> _state.update { it.copy(loading = false, rows = r.value, refusal = null) }
                // A failed read keeps whatever was already on screen: a list
                // from a minute ago is still the right list to ask from.
                is AccessResult.Refused -> _state.update { it.copy(loading = false, refusal = r.reason) }
            }
        }
    }

    fun request(jobSyncId: String, reason: String) {
        if (!online.value) {
            _message.value = UiMessage(R.string.access_needs_connection)
            return
        }
        if (jobSyncId in _state.value.busy) return
        _state.update { it.copy(busy = it.busy + jobSyncId) }
        viewModelScope.launch {
            try {
                when (val r = JobAccess.requestAccess(jobSyncId, reason)) {
                    // JobAccess announces the write on `changes`, which reloads.
                    is AccessResult.Ok -> _message.value = UiMessage(R.string.access_request_sent)
                    is AccessResult.Refused -> {
                        _message.value = UiMessage(accessRefusalText(r.reason, AccessAction.ASK))
                        // The list itself is what changed: the job was taken
                        // on, stopped being won work, or the feature went.
                        if (r.reason in RELOAD_AFTER) load()
                    }
                }
            } finally {
                _state.update { it.copy(busy = it.busy - jobSyncId) }
            }
        }
    }

    fun withdraw(jobSyncId: String, requestId: String) {
        if (!online.value) {
            _message.value = UiMessage(R.string.access_needs_connection)
            return
        }
        if (jobSyncId in _state.value.busy) return
        _state.update { it.copy(busy = it.busy + jobSyncId) }
        viewModelScope.launch {
            try {
                when (val r = JobAccess.withdrawRequest(requestId)) {
                    is AccessResult.Ok -> _message.value = UiMessage(
                        if (r.value) R.string.access_request_withdrawn else R.string.access_request_already_answered
                    )
                    is AccessResult.Refused -> {
                        _message.value = UiMessage(accessRefusalText(r.reason, AccessAction.ASK))
                        if (r.reason in RELOAD_AFTER) load()
                    }
                }
            } finally {
                _state.update { it.copy(busy = it.busy - jobSyncId) }
            }
        }
    }

    private companion object {
        val RELOAD_AFTER = setOf(
            AccessRefusal.NOTHING_TO_ASK, AccessRefusal.NOT_FOUND,
            AccessRefusal.NOT_LINKED, AccessRefusal.NOT_AVAILABLE
        )
    }
}
