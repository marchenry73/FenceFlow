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
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

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
