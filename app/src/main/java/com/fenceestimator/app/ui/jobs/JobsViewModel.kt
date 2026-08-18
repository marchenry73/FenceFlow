package com.fenceestimator.app.ui.jobs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.data.isWon
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class JobsViewModel(private val repository: Repository) : ViewModel() {

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
                com.fenceestimator.app.estimate.JobMoney.stillOwed(job, totals.grandTotal)
            }
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0.0)

    val allPayments: StateFlow<List<com.fenceestimator.app.data.PaymentRecord>> =
        repository.observeAllPayments()
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    /** Finished shifts nobody has signed off, so the queue is visible without hunting for it. */
    val pendingHours: StateFlow<List<com.fenceestimator.app.data.TimeEntry>> =
        repository.observeTimeAwaitingApproval()
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val jobs: StateFlow<List<Job>> = repository.observeJobs()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

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
}
