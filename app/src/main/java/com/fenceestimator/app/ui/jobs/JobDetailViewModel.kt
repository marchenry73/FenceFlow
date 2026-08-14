package com.fenceestimator.app.ui.jobs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.data.ChangeOrder
import com.fenceestimator.app.data.Employee
import com.fenceestimator.app.data.Expense
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobPhoto
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.Manufacturer
import com.fenceestimator.app.data.PhotoKind
import com.fenceestimator.app.data.PricingTier
import com.fenceestimator.app.data.PunchListItem
import com.fenceestimator.app.data.Repository
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class JobDetailViewModel(private val repository: Repository, private val jobId: Long) : ViewModel() {
    val job: StateFlow<Job?> = repository.observeJob(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    val pricingTiers: StateFlow<List<PricingTier>> = repository.observePricingTiers()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val manufacturers: StateFlow<List<Manufacturer>> = repository.observeManufacturers()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val photos: StateFlow<List<JobPhoto>> = repository.observePhotos(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val employees: StateFlow<List<Employee>> = repository.observeEmployees()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val expenses: StateFlow<List<Expense>> = repository.observeExpenses(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val punchList: StateFlow<List<PunchListItem>> = repository.observePunchList(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val changeOrders: StateFlow<List<ChangeOrder>> = repository.observeChangeOrders(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    fun update(transform: (Job) -> Job) {
        val current = job.value ?: return
        viewModelScope.launch { repository.updateJob(transform(current)) }
    }

    fun setStatus(status: JobStatus) = update { it.copy(status = status) }

    fun applyTier(tier: PricingTier) = update {
        it.copy(
            pricingTierName = tier.name,
            laborRatePerFt = tier.laborRatePerFt,
            laborFlatFee = tier.laborFlatFee,
            markupPercent = tier.markupPercent,
            discountPercent = tier.discountPercent
        )
    }

    fun addPhoto(kind: PhotoKind, filePath: String) {
        viewModelScope.launch {
            repository.addPhoto(JobPhoto(jobId = jobId, kind = kind, filePath = filePath))
        }
    }

    fun deletePhoto(photo: JobPhoto) {
        viewModelScope.launch { repository.deletePhoto(photo) }
    }

    fun addExpense(category: com.fenceestimator.app.data.ExpenseCategory, description: String, amount: Double) {
        viewModelScope.launch {
            repository.saveExpense(
                Expense(jobId = jobId, category = category, description = description, amount = amount)
            )
        }
    }

    fun deleteExpense(expense: Expense) {
        viewModelScope.launch { repository.deleteExpense(expense) }
    }

    fun addPunchListItem(description: String) {
        viewModelScope.launch {
            repository.addPunchListItem(PunchListItem(jobId = jobId, description = description))
        }
    }

    fun togglePunchListItem(item: PunchListItem) {
        viewModelScope.launch {
            repository.updatePunchListItem(
                item.copy(
                    resolved = !item.resolved,
                    resolvedAt = if (!item.resolved) System.currentTimeMillis() else null
                )
            )
        }
    }

    fun deletePunchListItem(item: PunchListItem) {
        viewModelScope.launch { repository.deletePunchListItem(item) }
    }

    fun addChangeOrder(description: String, additionalFeet: Double, additionalCost: Double) {
        viewModelScope.launch {
            repository.saveChangeOrder(
                ChangeOrder(
                    jobId = jobId,
                    description = description,
                    additionalFeet = additionalFeet,
                    additionalCost = additionalCost
                )
            )
        }
    }

    fun signChangeOrder(order: ChangeOrder, signaturePath: String) {
        viewModelScope.launch {
            repository.updateChangeOrder(
                order.copy(signatureImagePath = signaturePath, signedAt = System.currentTimeMillis())
            )
        }
    }

    fun deleteChangeOrder(order: ChangeOrder) {
        viewModelScope.launch { repository.deleteChangeOrder(order) }
    }

    fun delete(onDeleted: () -> Unit) {
        val current = job.value ?: return
        viewModelScope.launch {
            repository.deleteJob(current)
            onDeleted()
        }
    }
}
