package com.fenceestimator.app.ui.customers

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.Repository
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class CustomerSummary(
    val name: String,
    val phone: String,
    val email: String,
    val mostRecentAddress: String,
    val jobCount: Int,
    val mostRecentJobId: Long
)

class CustomersViewModel(private val repository: Repository) : ViewModel() {
    val customers: StateFlow<List<CustomerSummary>> = repository.observeJobs()
        .map { jobs ->
            jobs
                .filter { it.customerName.isNotBlank() }
                .groupBy { it.customerName.trim().lowercase() to it.phone.trim() }
                .map { (_, jobsForCustomer) ->
                    val mostRecent = jobsForCustomer.maxByOrNull { it.updatedAt }!!
                    CustomerSummary(
                        name = mostRecent.customerName,
                        phone = mostRecent.phone,
                        email = mostRecent.email,
                        mostRecentAddress = mostRecent.address,
                        jobCount = jobsForCustomer.size,
                        mostRecentJobId = mostRecent.id
                    )
                }
                .sortedBy { it.name.lowercase() }
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    fun createJobForCustomer(customer: CustomerSummary, onCreated: (Long) -> Unit) {
        viewModelScope.launch {
            val id = repository.createJob(
                Job(customerName = customer.name, phone = customer.phone, email = customer.email)
            )
            onCreated(id)
        }
    }
}
