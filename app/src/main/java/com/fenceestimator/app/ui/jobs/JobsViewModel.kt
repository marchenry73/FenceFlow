package com.fenceestimator.app.ui.jobs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.Repository
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class JobsViewModel(private val repository: Repository) : ViewModel() {

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
