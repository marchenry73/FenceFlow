package com.fenceestimator.app.ui.crew

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.ClockInIdentity
import com.fenceestimator.app.cloud.SessionManager
import com.fenceestimator.app.cloud.SupabaseModule
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobPhoto
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.JobStep
import com.fenceestimator.app.data.PhotoKind
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.ui.components.UiMessage
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class CrewJobViewModel(
    private val repository: Repository,
    private val jobId: Long,
    private val session: SessionManager
) : ViewModel() {

    /** Told to the screen once, not stored -- a Snackbar, not a field that lingers. */
    private val _message = MutableSharedFlow<UiMessage>(extraBufferCapacity = 1)
    val message: SharedFlow<UiMessage> = _message
    val job: StateFlow<Job?> = repository.observeJob(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    val runs: StateFlow<List<FenceRun>> = repository.observeFenceRuns(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val steps: StateFlow<List<JobStep>> = repository.observeJobSteps(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val photos: StateFlow<List<JobPhoto>> = repository.observePhotos(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val timeEntries: StateFlow<List<com.fenceestimator.app.data.TimeEntry>> =
        repository.observeTimeEntries(jobId)
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    // Everyone, including people who have left: this list resolves the name on
    // a job as well as offering a choice, and a finished job should not start
    // reading "Unassigned" because somebody moved on.
    val employees: StateFlow<List<com.fenceestimator.app.data.Employee>> = repository.observeEmployees()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    init {
        viewModelScope.launch { repository.ensureJobStepsSeeded(jobId) }
    }

    /**
     * Clocks in the SIGNED-IN PERSON, not the job's assignment.
     *
     * Taking identity from the job's assignedEmployeeId used to let anyone
     * clock in on an unassigned job and produce a shift with no employee and
     * a zero rate -- indistinguishable from a normal entry in every list.
     * [ClockInIdentity] resolves the signed-in account to its own employee
     * record first, falling back to the job's assignment only when the
     * signed-in person has no crew record of their own (the shared-phone /
     * owner-clocking-in-for-the-crew case). When neither resolves, this must
     * NOT clock in -- the server now rejects a blank employee with a
     * SQLSTATE 23514 trigger anyway, but the point is for the person to find
     * out on the spot, in the field, not from a failed sync days later.
     *
     * The rate sent here is only a local placeholder: the server stamps the
     * real rate over whatever the phone sends, so this never becomes
     * authoritative pay.
     */
    fun clockIn() {
        viewModelScope.launch {
            val result = ClockInIdentity.resolve(
                employees = employees.value,
                assignedEmployeeId = job.value?.assignedEmployeeId,
                signedInProfileId = SupabaseModule.currentUserId(),
                signedInEmail = session.state.value.email
            )
            when (result) {
                is ClockInIdentity.Result.Resolved ->
                    repository.clockIn(jobId, result.employeeId, result.hourlyRate)
                ClockInIdentity.Result.NoIdentity ->
                    _message.tryEmit(UiMessage(R.string.crew_clock_in_no_identity))
            }
        }
    }

    fun clockOut() {
        viewModelScope.launch { repository.clockOut(jobId) }
    }

    fun deleteTimeEntry(entry: com.fenceestimator.app.data.TimeEntry) {
        viewModelScope.launch { repository.deleteTimeEntry(entry) }
    }

    fun toggleStep(step: JobStep) {
        viewModelScope.launch {
            repository.updateJobStep(
                step.copy(
                    checked = !step.checked,
                    completedAt = if (!step.checked) System.currentTimeMillis() else null
                )
            )
        }
    }

    /**
     * The customer signing that the finished work is right.
     *
     * Kept apart from the acceptance signature: one says "I agree to this
     * price", this one says "this was built properly". When a gate is said to
     * have never latched, this is the record that answers it.
     */
    fun captureFinalSignOff(path: String) {
        viewModelScope.launch {
            val current = job.value ?: return@launch
            repository.updateJob(
                current.copy(
                    finalSignOffImagePath = path,
                    finalSignOffAt = System.currentTimeMillis()
                )
            )
        }
    }

    fun addPhoto(kind: PhotoKind, filePath: String) {
        viewModelScope.launch {
            repository.addPhoto(JobPhoto(jobId = jobId, kind = kind, filePath = filePath))
        }
    }

    /**
     * Moves the job to [nextStage] through `set_production_stage` -- the
     * only door onto `jobs.production_stage`. Nothing here ever writes that
     * column directly; this either mirrors back exactly what the server just
     * confirmed, or leaves the phone alone.
     *
     * Requires a live connection, checked by the caller with
     * [com.fenceestimator.app.cloud.ConnectivityWatcher] the same way
     * [com.fenceestimator.app.ui.employees.EmployeesViewModel.addCrewMember]
     * checks it -- this is an RPC, not a queued local write. A phone with no
     * signal that "saved" this locally and showed the new stage right away
     * would be a screen claiming DIG while the server, and every other
     * phone, still say MATERIALS: exactly the failure this app spent today
     * removing. Saying plainly that it needs signal is honest; a queued
     * guess is not.
     *
     * `false` back from the RPC is not a failure -- the job was already on
     * [nextStage] -- so this quietly agrees with the server instead of
     * raising a Snackbar over nothing. A real refusal (job not approved yet,
     * an unknown stage name, an account that may not move jobs) comes back
     * as a raised message written for a person, so it is shown as-is rather
     * than translated into something vaguer.
     */
    fun moveStage(nextStage: String, online: Boolean) {
        viewModelScope.launch {
            if (!online) {
                _message.tryEmit(UiMessage(R.string.crew_stage_needs_signal))
                return@launch
            }
            val current = job.value ?: return@launch
            runCatching {
                SupabaseModule.client.postgrest.rpc(
                    "set_production_stage",
                    buildJsonObject {
                        put("job_sid", current.syncId)
                        put("next_stage", nextStage)
                    }
                )
            }.onSuccess {
                // Both true (moved) and false (already there) mean the server
                // now agrees the job is on nextStage -- confirmed, not
                // guessed, so mirroring it locally without touching updatedAt
                // is the same quiet-clock write JobSync's pull uses for this
                // same column.
                repository.updateJobFromCloud(current.copy(productionStage = nextStage))
            }.onFailure { e ->
                _message.tryEmit(UiMessage(R.string.crew_stage_move_failed, listOf(e.message.orEmpty())))
            }
        }
    }

    /** Crew marking the job finished is what tells the office it's ready for final billing. */
    /**
     * Marks the fence built. Also closes any running time entry -- crews forget
     * to clock out, and a shift left open would silently inflate the job's
     * labor cost forever.
     */
    fun markJobComplete() {
        viewModelScope.launch {
            repository.clockOut(jobId)
            val current = job.value ?: return@launch
            repository.updateJob(current.copy(status = JobStatus.COMPLETED))
        }
    }
}
