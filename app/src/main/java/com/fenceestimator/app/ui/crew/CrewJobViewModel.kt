package com.fenceestimator.app.ui.crew

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobPhoto
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.JobStep
import com.fenceestimator.app.data.PhotoKind
import com.fenceestimator.app.data.Repository
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class CrewJobViewModel(private val repository: Repository, private val jobId: Long) : ViewModel() {
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

    val employees: StateFlow<List<com.fenceestimator.app.data.Employee>> = repository.observeEmployees()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    init {
        viewModelScope.launch { repository.ensureJobStepsSeeded(jobId) }
    }

    /** Clocks in against the job's assigned crew member, at whatever their rate is today. */
    fun clockIn() {
        viewModelScope.launch {
            val employeeId = job.value?.assignedEmployeeId
            val rate = employees.value.firstOrNull { it.id == employeeId }?.hourlyRate ?: 0.0
            repository.clockIn(jobId, employeeId, rate)
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
