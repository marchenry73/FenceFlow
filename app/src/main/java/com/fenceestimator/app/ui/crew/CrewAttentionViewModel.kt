package com.fenceestimator.app.ui.crew

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import com.fenceestimator.app.cloud.ClockInIdentity
import com.fenceestimator.app.cloud.SessionManager
import com.fenceestimator.app.cloud.SupabaseModule
import com.fenceestimator.app.data.Employee
import com.fenceestimator.app.data.FieldChange
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.data.TimeEntry
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn

/**
 * Resolves "which jobs are mine" once, then reads only those jobs' shifts and
 * plan changes -- never the whole company's.
 *
 * This is the privacy boundary as much as it is a performance one: a crew
 * member's Room database already holds every job (sync pulls the company's
 * jobs, not a filtered slice -- there is no server-side view keyed to "my
 * jobs only"), so the boundary has to be drawn here, in what this screen
 * chooses to look at, rather than in what the phone downloaded.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CrewAttentionViewModel(
    private val repository: Repository,
    private val session: SessionManager,
    private val ackStore: CrewAttentionAckStore
) : ViewModel() {

    private val myEmployeeId: Flow<Long?> = combine(
        repository.observeEmployees(),
        session.state
    ) { employees, state -> employees to state }
        .map { (employees, state) ->
            resolveMyEmployeeId(employees, state.email)
        }
        .distinctUntilChanged()

    private val myJobs: Flow<List<Job>> = combine(
        repository.observeJobs(), myEmployeeId
    ) { jobs, id -> if (id == null) emptyList() else jobs.filter { it.assignedEmployeeId == id } }

    /**
     * Per-job shifts and plan changes, refetched whenever the set of jobs
     * assigned to this person changes -- not the whole company's tables. A
     * crew member is on a handful of jobs at once; this stays a handful of
     * small queries rather than one that scans everything and filters after.
     */
    private val myTimeEntries: Flow<List<TimeEntry>> = myJobs
        .map { jobs -> jobs.map { it.id } }
        .distinctUntilChanged()
        .flatMapLatest { ids ->
            if (ids.isEmpty()) flowOf(emptyList())
            else combine(ids.map { repository.observeTimeEntries(it) }) { arrays -> arrays.flatMap { it } }
        }

    private val myFieldChanges: Flow<List<FieldChange>> = myJobs
        .map { jobs -> jobs.map { it.id } }
        .distinctUntilChanged()
        .flatMapLatest { ids ->
            if (ids.isEmpty()) flowOf(emptyList())
            else combine(ids.map { repository.observeFieldChanges(it) }) { arrays -> arrays.flatMap { it } }
        }

    /**
     * [ackStore] is a plain SharedPreferences read, not a Flow -- so it will
     * not by itself notice a dismissal and redraw. [dismiss] bumps this so
     * the combine below re-reads it once, right after a dismissal is written.
     */
    private val ackTick = MutableStateFlow(0)

    val items = combine(
        myEmployeeId, myJobs, myTimeEntries, myFieldChanges, ackTick
    ) { id, jobs, times, changes, _ ->
        val dismissed = ackStore.dismissedKeys()
        val jobsById = jobs.associateBy { it.id }
        CrewAttention.build(
            myEmployeeId = id,
            myEmail = session.state.value.email.orEmpty(),
            jobs = jobs,
            timeEntries = times,
            fieldChanges = changes
        ).filter { it.key !in dismissed }
            .map { it to jobsById[it.jobId] }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    fun dismiss(key: String) {
        ackStore.dismiss(key)
        ackTick.value += 1
    }

    private fun resolveMyEmployeeId(employees: List<Employee>, email: String?): Long? {
        return when (
            val result = ClockInIdentity.resolve(
                employees = employees,
                assignedEmployeeId = null,
                signedInProfileId = SupabaseModule.currentUserId(),
                signedInEmail = email
            )
        ) {
            is ClockInIdentity.Result.Resolved -> result.employeeId
            ClockInIdentity.Result.NoIdentity -> null
        }
    }
}
