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
import com.fenceestimator.app.estimate.EstimateEngine
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FenceGeometryEngine
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class JobDetailViewModel(private val repository: Repository, private val jobId: Long) : ViewModel() {
    val job: StateFlow<Job?> = repository.observeJob(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    val pricingTiers: StateFlow<List<PricingTier>> = repository.observePricingTiers()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    /**
     * Everything you have to buy before this job can be finished: the estimate's
     * materials plus the materials on any approved change order. A deposit below
     * this means fronting the customer's material out of pocket, so the deposit
     * suggestion uses it as a floor.
     */
    val materialCost: StateFlow<Double> = combine(
        repository.observeLineItems(jobId),
        repository.observeChangeOrders(jobId)
    ) { items, orders ->
        items.sumOf { it.quantity * it.unitPrice } + orders.sumOf { it.materialCost }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0.0)

    /**
     * The live contract total, so approving extra work visibly moves the money
     * on the same screen where the change order was entered. Adding one and
     * seeing nothing change reads as a failure even when it saved fine.
     */
    val contractTotal: StateFlow<EstimateEngine.Totals> = combine(
        repository.observeJob(jobId),
        repository.observeLineItems(jobId),
        repository.observeFenceRuns(jobId),
        repository.observeChangeOrders(jobId)
    ) { currentJob, items, runs, orders ->
        if (currentJob == null) EMPTY_TOTALS
        else {
            val feet = runs.sumOf { run ->
                val manual = run.manualLinearFeet
                if (manual != null && manual > 0f) manual.toDouble()
                else currentJob.calibrationPixelsPerFoot?.let { pxPerFt ->
                    FenceGeometryEngine.analyze(
                        FenceCodec.decodePoints(run.pointsEncoded), pxPerFt, run.closedLoop
                    ).totalLinearFeet.toDouble()
                } ?: 0.0
            }.toFloat()
            EstimateEngine.computeTotals(currentJob, items, feet, orders, runs)
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), EMPTY_TOTALS)

    /** Rounds a deposit up to the next $10 so it reads like a real figure, not a calculation. */
    fun suggestedDeposit(): Double {
        val cost = materialCost.value
        if (cost <= 0.0) return 0.0
        return kotlin.math.ceil(cost / 10.0) * 10.0
    }

    fun applySuggestedDeposit() {
        val amount = suggestedDeposit()
        if (amount <= 0.0) return
        update { it.copy(depositAmount = amount) }
    }

    /**
     * Sets the deposit to cover materials as soon as the takeoff produces a
     * figure, unless someone has already set one themselves.
     *
     * Fronting the customer's material out of your own pocket is the default
     * failure here, and it happens by omission -- nobody decides to do it, they
     * just never set a deposit. Only fills a blank; never overwrites a number
     * you chose, and never moves once payment has started.
     */
    fun autoFillDepositFromMaterials() {
        val current = job.value ?: return
        if (current.depositAmount > 0.0) return
        if (current.amountPaid > 0.0) return
        val amount = suggestedDeposit()
        if (amount <= 0.0) return
        update { it.copy(depositAmount = amount) }
    }

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

    val timeEntries: StateFlow<List<com.fenceestimator.app.data.TimeEntry>> =
        repository.observeTimeEntries(jobId)
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

    fun addChangeOrder(
        description: String,
        additionalFeet: Double,
        additionalCost: Double,
        materialCost: Double = 0.0
    ) {
        viewModelScope.launch {
            repository.saveChangeOrder(
                ChangeOrder(
                    jobId = jobId,
                    description = description,
                    additionalFeet = additionalFeet,
                    additionalCost = additionalCost,
                    materialCost = materialCost
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

    val siteMarkers: StateFlow<List<com.fenceestimator.app.data.SiteMarker>> =
        repository.observeSiteMarkers(jobId)
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val fieldChanges: StateFlow<List<com.fenceestimator.app.data.FieldChange>> =
        repository.observeFieldChanges(jobId)
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    fun acknowledgeFieldChanges() {
        viewModelScope.launch { repository.acknowledgeFieldChanges(jobId) }
    }

    /** Stamps that the customer has actually been told why the job is held up. */
    fun markCustomerNotified() {
        update { it.copy(customerNotifiedAt = System.currentTimeMillis()) }
    }

    fun deleteChangeOrder(order: ChangeOrder) {
        viewModelScope.launch { repository.deleteChangeOrder(order) }
    }

    /**
     * Editing keeps the signature only when nothing about the money or the
     * scope moved. A customer signed for what it said at the time; letting an
     * edited amount keep the old signature would make that record worthless.
     */
    fun updateChangeOrder(
        order: ChangeOrder,
        description: String,
        additionalFeet: Double,
        additionalCost: Double,
        materialCost: Double
    ) {
        val termsChanged = additionalCost != order.additionalCost ||
            additionalFeet != order.additionalFeet ||
            materialCost != order.materialCost
        viewModelScope.launch {
            repository.saveChangeOrder(
                order.copy(
                    description = description,
                    additionalFeet = additionalFeet,
                    additionalCost = additionalCost,
                    materialCost = materialCost,
                    signatureImagePath = if (termsChanged) null else order.signatureImagePath,
                    signedAt = if (termsChanged) null else order.signedAt
                )
            )
        }
    }

    fun delete(onDeleted: () -> Unit) {
        val current = job.value ?: return
        viewModelScope.launch {
            repository.deleteJob(current)
            onDeleted()
        }
    }

    private companion object {
        val EMPTY_TOTALS = EstimateEngine.Totals(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    }
}
