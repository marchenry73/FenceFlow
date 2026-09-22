package com.fenceestimator.app.ui.crew

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import com.fenceestimator.app.cloud.ClockInIdentity
import com.fenceestimator.app.cloud.JobAccess
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
 * This is the privacy boundary as much as it is a performance one. Until
 * supabase_crew_job_scope.sql is applied, a crew member's Room database holds
 * every job (sync pulls the company's jobs, not a filtered slice), so the
 * boundary has to be drawn here, in what this screen chooses to look at,
 * rather than in what the phone downloaded. Once it is applied the server
 * sends a scoped crew member only the jobs they are on, and every one of
 * those counts as theirs, lead or not -- see [CrewAttention.jobsMineByScope].
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

    /**
     * The lead's jobs, plus -- for a scoped crew member -- every job the
     * server sent them (extra crew, let in). observeJobs() already leaves out
     * jobs kept after their person was taken off them, so those never raise
     * anything here.
     */
    private val myJobs: Flow<List<Job>> = combine(
        repository.observeJobs(), myEmployeeId, JobAccess.scope
    ) { jobs, id, scope ->
        if (id == null) emptyList()
        else {
            val alsoMine = CrewAttention.jobsMineByScope(scope, jobs)
            jobs.filter { it.assignedEmployeeId == id || it.id in alsoMine }
        }
    }

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

    /**
     * This person's own shifts the office sent back or corrected, on ANY job
     * -- one they were moved off as lead, or taken off altogether and which
     * is only kept on the phone now (Job.accessEndedAt). myJobs leaves those
     * jobs out, so their shifts did too, and a correction to what someone is
     * owed went unmentioned because of which job it was worked on. The server
     * still sends a person their own shifts (time_entries_crew), so the rows
     * are here; this is one indexed read, not the whole company's shifts.
     */
    private val myReviewedShifts: Flow<List<TimeEntry>> = myEmployeeId
        .flatMapLatest { id -> if (id == null) flowOf(emptyList()) else repository.observeReviewedShifts(id) }

    private val myShifts: Flow<List<TimeEntry>> = combine(myTimeEntries, myReviewedShifts) { onMyJobs, reviewed ->
        (onMyJobs + reviewed).distinctBy { it.id }
    }

    /**
     * Every job on the phone, kept ones included, for naming an item's job:
     * a shift on a job this person was taken off still says which job it was.
     */
    private val jobsForNames: Flow<Map<Long, Job>> = combine(
        repository.observeJobs(), repository.observeHeldJobs()
    ) { visible, held -> (visible + held).associateBy { it.id } }

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
        myEmployeeId, myJobs, myShifts, myFieldChanges, ackTick
    ) { id, jobs, times, changes, _ ->
        val dismissed = ackStore.dismissedKeys()
        CrewAttention.build(
            myEmployeeId = id,
            myEmail = session.state.value.email.orEmpty(),
            jobs = jobs,
            timeEntries = times,
            fieldChanges = changes,
            // Every job here was already judged to be this person's (myJobs),
            // lead or not; without this build() would narrow it back to the
            // lead's alone.
            alsoMine = jobs.map { it.id }.toSet()
        ).filter { it.key !in dismissed }
    }.combine(jobsForNames) { found, names -> found.map { it to names[it.jobId] } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

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
