package com.fenceestimator.app.ui.jobs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.cloud.AccessRefusal
import com.fenceestimator.app.cloud.AccessRequestStatus
import com.fenceestimator.app.cloud.AccessResult
import com.fenceestimator.app.cloud.JobAccess
import com.fenceestimator.app.cloud.JobScope
import com.fenceestimator.app.cloud.SessionManager
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.data.isWon
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class JobsViewModel(
    private val repository: Repository,
    /**
     * Who is signed in, for the "crew asked for access" count. Optional so a
     * screen that only wants the lists (the pipeline) need not pass it;
     * without it the count simply stays at zero.
     */
    private val session: SessionManager? = null
) : ViewModel() {

    /**
     * What every won job still owes, added up.
     *
     * Computed from the line items rather than guessed from the job row,
     * because the job row has no contract total on it -- and a home screen
     * figure that is approximately right about money is worse than no figure,
     * since nobody knows which way it is wrong.
     */
    val outstandingTotal: StateFlow<Double> = kotlinx.coroutines.flow.combine(
        repository.observeJobs(),
        repository.observeAllPayments()
    ) { allJobs, _ -> allJobs }
        .map { allJobs ->
            val won = allJobs.filter { it.status.isWon }
            if (won.isEmpty()) return@map 0.0
            // Three queries for the whole business, not three per job. Fetching
            // per job meant the home screen fired 3xN round trips every time any
            // payment landed, which is what made it slow to settle once a company
            // had real history behind it.
            val itemsByJob = repository.getAllLineItemsByJob()
            val runsByJob = repository.getAllFenceRunsByJob()
            val ordersByJob = repository.getAllChangeOrdersByJob()
            won.sumOf { job ->
                val runs = runsByJob[job.id].orEmpty()
                val totals = com.fenceestimator.app.estimate.EstimateEngine.computeTotals(
                    job,
                    itemsByJob[job.id].orEmpty(),
                    com.fenceestimator.app.estimate.EstimateEngine.linearFeet(job, runs),
                    ordersByJob[job.id].orEmpty(),
                    runs
                )
                // Against the price the customer accepted (plus extra work
                // signed since), as the job screen, the quote page and the
                // payment link all bill -- not the live recompute, which moves
                // after acceptance. Woody (accepted $3,620, recomputing to
                // $200) read here as owing nothing while its own screen said
                // $3,620 less payments.
                com.fenceestimator.app.estimate.JobMoney.stillOwed(
                    job,
                    com.fenceestimator.app.estimate.JobMoney.billableTotal(
                        job, totals.grandTotal, ordersByJob[job.id].orEmpty()
                    )
                )
            }
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0.0)

    /**
     * Every job's contract total, keyed by id, for the row that shows one
     * figure per job in a list.
     *
     * The same batch [outstandingTotal] already uses -- three queries for the
     * whole business, computed once when the job list changes, rather than a
     * job's totals being recomputed every time its row scrolls past. A job
     * with no runs or line items yet prices to zero rather than being left
     * out of the map, so a fresh draft's row shows "$0" instead of nothing.
     */
    val jobTotals: StateFlow<Map<Long, Double>> = repository.observeJobs()
        .map { allJobs ->
            if (allJobs.isEmpty()) return@map emptyMap()
            val itemsByJob = repository.getAllLineItemsByJob()
            val runsByJob = repository.getAllFenceRunsByJob()
            val ordersByJob = repository.getAllChangeOrdersByJob()
            allJobs.associate { job ->
                val runs = runsByJob[job.id].orEmpty()
                val totals = com.fenceestimator.app.estimate.EstimateEngine.computeTotals(
                    job,
                    itemsByJob[job.id].orEmpty(),
                    com.fenceestimator.app.estimate.EstimateEngine.linearFeet(job, runs),
                    ordersByJob[job.id].orEmpty(),
                    runs
                )
                // The billable figure, for the same reason as outstandingTotal:
                // a won job's row shows the price it was won at.
                job.id to com.fenceestimator.app.estimate.JobMoney.billableTotal(
                    job, totals.grandTotal, ordersByJob[job.id].orEmpty()
                )
            }
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyMap())

    /** Plan-change requests nobody has answered, so the home screen can say so. */
    val pendingPlanChanges: StateFlow<List<com.fenceestimator.app.data.FieldChange>> =
        repository.observeUnacknowledgedFieldChanges()
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val allPayments: StateFlow<List<com.fenceestimator.app.data.PaymentRecord>> =
        repository.observeAllPayments()
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    /** Finished shifts nobody has signed off, so the queue is visible without hunting for it. */
    val pendingHours: StateFlow<List<com.fenceestimator.app.data.TimeEntry>> =
        repository.observeTimeAwaitingApproval()
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val jobs: StateFlow<List<Job>> = repository.observeJobs()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    /**
     * Jobs this phone keeps after its person was taken off them, for the
     * "Kept on this phone" section. Never deleted (see
     * Repository.observeHeldJobs): a shift running on one must still be
     * clockable out, and anything not sent yet goes up once access is back.
     */
    val heldJobs: StateFlow<List<Job>> = repository.observeHeldJobs()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    /**
     * The server's answer to "which jobs may this person see", as the last
     * sync pass (or [refreshScope]) heard it. Only [JobScope.Scoped] changes
     * anything on screen; Unknown and NotDeployed are today's list, unchanged.
     */
    val jobScope: StateFlow<JobScope> = JobAccess.scope

    private val _accessRequestsWaiting = MutableStateFlow(0)

    /**
     * Access requests nobody has answered, for someone who answers them
     * (SCHEDULE_AND_ASSIGN). Zero -- no banner -- for everyone else, on a
     * server without the crew scope, and when the list could not be read:
     * a count that could not be checked is not shown as current.
     */
    val accessRequestsWaiting: StateFlow<Int> = _accessRequestsWaiting

    private var requestsRead: kotlinx.coroutines.Job? = null

    init {
        // Re-read when the answer could have moved: the scope settling after
        // the first sync, a change on job_access_requests (the change feed,
        // or an answer given on this phone), and a different person or
        // permission set.
        if (session != null) {
            viewModelScope.launch {
                kotlinx.coroutines.flow.merge(
                    JobAccess.scope.map { },
                    JobAccess.changes,
                    session.state.map { it.companyId to it.canScheduleAndAssign }
                        .distinctUntilChanged().map { }
                ).collect { refreshAccessRequests() }
            }
        }
    }

    /**
     * Asks the server again who may see what -- the screen coming back into
     * view -- and re-reads the waiting requests with the answer. A failed ask
     * keeps the last answer (JobAccess.scope never flickers to Unknown).
     */
    fun refreshScope() {
        // Working alone on this phone there is nobody to scope, and nothing
        // to ask a server about.
        if (session?.state?.value?.signedIn != true) return
        viewModelScope.launch {
            runCatching { JobAccess.refreshScope() }
            refreshAccessRequests()
        }
    }

    private fun refreshAccessRequests() {
        val s = session?.state?.value ?: return
        val company = s.companyId
        requestsRead?.cancel()
        if (!s.canScheduleAndAssign || company == null || !JobAccess.scope.value.isDeployed) {
            _accessRequestsWaiting.value = 0
            return
        }
        requestsRead = viewModelScope.launch {
            when (val r = JobAccess.readRequests(company, status = AccessRequestStatus.PENDING)) {
                is AccessResult.Ok -> _accessRequestsWaiting.value = r.value.size
                is AccessResult.Refused ->
                    // No signal keeps what was last read; anything else -- the
                    // table missing, a refusal -- is nothing to announce.
                    if (r.reason != AccessRefusal.NO_CONNECTION) _accessRequestsWaiting.value = 0
            }
        }
    }

    fun createJob(defaults: BusinessProfile, onCreated: (Long) -> Unit) {
        viewModelScope.launch {
            // Carry every pricing default across, not just a few -- a new job
            // that quietly starts at 0% markup and no minimum charge is how you
            // send a quote with no profit in it.
            val job = Job(
                taxRatePercent = defaults.defaultTaxRatePercent,
                markupPercent = defaults.defaultMarkupPercent,
                laborRatePerFt = defaults.defaultLaborRatePerFt,
                minimumJobCharge = defaults.defaultMinimumJobCharge,
                preferredManufacturerId = defaults.preferredManufacturerId.takeIf { it != 0L }
            )
            // Start on the standard residential tier rather than "Custom" -- that's
            // the vast majority of work, and an unset tier means an unpriced job.
            val tiers = repository.observePricingTiers().first()
            val residential = tiers.firstOrNull { it.name.equals("Residential", ignoreCase = true) }
                ?: tiers.firstOrNull()

            val withTier = residential?.let {
                job.copy(
                    pricingTierName = it.name,
                    laborRatePerFt = it.laborRatePerFt,
                    laborFlatFee = it.laborFlatFee,
                    markupPercent = it.markupPercent,
                    discountPercent = it.discountPercent
                )
            } ?: job

            val id = repository.createJob(withTier)
            onCreated(id)
        }
    }

    fun deleteJob(job: Job) {
        viewModelScope.launch { repository.deleteJob(job) }
    }

    /**
     * For the delete confirmation, so it can name how many hours are on the
     * job rather than just warning about "time entries" in the abstract. Null
     * means the count failed, not that there were zero -- see
     * [Repository.recordedHoursForJob].
     */
    suspend fun countRecordedHours(jobId: Long): Double? = repository.recordedHoursForJob(jobId)
}
