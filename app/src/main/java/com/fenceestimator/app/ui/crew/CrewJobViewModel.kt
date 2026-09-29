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
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Whether [error] is set_production_stage refusing a job this person is no
 * longer on: crew_job_guard's "This job is not assigned to you."
 * (supabase_crew_job_scope.sql, 42501). postgrest-kt keeps the sentence and
 * drops the SQLSTATE, so the sentence is what is matched, through the cause
 * chain.
 */
internal fun isNotYourJobRefusal(error: Throwable): Boolean =
    generateSequence(error) { it.cause }
        .any { it.message?.contains("not assigned to you", ignoreCase = true) == true }

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

    /**
     * What ensureJobStepsSeeded would have written for this job, computed
     * once and never persisted. init (below) skips the real seed for a guest
     * entirely, so [steps] stays empty for the whole demo -- this is what the
     * walkthrough, install and final-walkthrough sections read instead, the
     * same fix the Materials screen's tool checklist needed.
     */
    val guestStepPreview: List<JobStep> =
        com.fenceestimator.app.data.DefaultJobSteps.WALKTHROUGH.mapIndexed { index, step ->
            JobStep(jobId = jobId, kind = com.fenceestimator.app.data.JobStepKind.WALKTHROUGH, description = step.text, sortOrder = index, stepKey = step.key)
        } +
        com.fenceestimator.app.data.DefaultJobSteps.INSTALL.mapIndexed { index, step ->
            JobStep(jobId = jobId, kind = com.fenceestimator.app.data.JobStepKind.INSTALL, description = step.text, sortOrder = index, stepKey = step.key)
        } +
        com.fenceestimator.app.data.DefaultJobSteps.FINAL.mapIndexed { index, step ->
            JobStep(jobId = jobId, kind = com.fenceestimator.app.data.JobStepKind.FINAL_WALKTHROUGH, description = step.text, sortOrder = index, stepKey = step.key)
        }

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

    /**
     * How many PER_FOOT workers split this job's footage -- the last answer
     * the server gave, cached so the split survives a dead spot. Null when it
     * has never been answered; CrewPay then counts only the person asking.
     */
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    val perFootCrewCount: StateFlow<Int?> = job
        .flatMapLatest { j ->
            if (j == null) kotlinx.coroutines.flow.flowOf(null)
            else repository.observePerFootCrewCount(j.syncId)
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    init {
        // Both of these write with no button pressed, the same shape as the
        // Materials screen's start-up seed this session found and fixed --
        // opening this screen was enough. Repository now throws
        // (GuestWriteGuard) rather than seeding for a guest, and an
        // uncaught throw inside a bare viewModelScope.launch here would
        // crash the screen the instant a guest opened it, so both are opted
        // out up front instead of relying on that throw.
        if (!session.state.value.isGuestDemo) {
            viewModelScope.launch { repository.ensureJobStepsSeeded(jobId) }
            viewModelScope.launch { refreshPerFootCrewCount() }
        }
    }

    /**
     * Asks per_foot_crew_count(). Offline, or a NULL answer (not this
     * person's job to ask about), leaves the cache alone rather than writing
     * a guess over it.
     */
    private suspend fun refreshPerFootCrewCount() {
        val syncId = job.filterNotNull().first().syncId
        val count = runCatching {
            SupabaseModule.client.postgrest.rpc(
                "per_foot_crew_count",
                buildJsonObject { put("p_job_sync_id", syncId) }
            ).decodeAs<kotlinx.serialization.json.JsonElement>()
        }.getOrNull()
            ?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content?.toIntOrNull() }
            ?: return
        repository.savePerFootCrewCount(syncId, count)
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
        // The guest demo reaches this screen with no gate on the route or the
        // button today -- refused here regardless of what the UI shows, the
        // same guest-demo predicate every other screen's write funnel uses.
        // Never a permission: a real, signed-in crew member is never
        // guestDemo, so nothing here narrows what crew can already do.
        if (session.state.value.isGuestDemo) return
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
        if (session.state.value.isGuestDemo) return
        viewModelScope.launch { repository.clockOut(jobId) }
    }

    /** Starts the unpaid break on the shift currently running for this job. */
    fun startBreak() {
        if (session.state.value.isGuestDemo) return
        viewModelScope.launch { repository.startBreak(jobId) }
    }

    /**
     * Ends the break. A refusal is spoken rather than silently dropped --
     * these are local writes, so there is no network failure to report, but
     * a break the database would reject anyway must not read as saved.
     */
    fun endBreak() {
        if (session.state.value.isGuestDemo) return
        viewModelScope.launch {
            when (repository.endBreak(jobId)) {
                is com.fenceestimator.app.data.BreakResult.TooLong ->
                    _message.tryEmit(UiMessage(R.string.crew_break_too_long))
                else -> Unit
            }
        }
    }

    fun toggleStep(step: JobStep) {
        if (session.state.value.isGuestDemo) return
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
        if (session.state.value.isGuestDemo) return
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
        if (session.state.value.isGuestDemo) return
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
        if (session.state.value.isGuestDemo) return
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
                // One refusal is said in the phone's own words rather than the
                // server's English: the job is no longer this person's (the
                // crew scope's guard). The screen hides the stage buttons on a
                // job kept after its person was taken off it, but the office
                // can take someone off between two syncs.
                _message.tryEmit(
                    if (isNotYourJobRefusal(e)) UiMessage(R.string.crew_stage_not_yours)
                    else UiMessage(R.string.crew_stage_move_failed, listOf(e.message.orEmpty()))
                )
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
        if (session.state.value.isGuestDemo) return
        viewModelScope.launch {
            repository.clockOut(jobId)
            val current = job.value ?: return@launch
            repository.updateJob(current.copy(status = JobStatus.COMPLETED))
        }
    }
}
