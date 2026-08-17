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
import com.fenceestimator.app.data.PaymentStatus
import com.fenceestimator.app.data.PricingTier
import com.fenceestimator.app.data.PunchListItem
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.estimate.EstimateEngine
import com.fenceestimator.app.estimate.JobMoney
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
        items.sumOf { it.lineTotal } + orders.sumOf { it.materialCost }
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

    /**
     * Moves a job to Paid in Full once the money actually covers the contract.
     *
     * The backend records that a payment arrived but deliberately does not
     * decide this: the contract total is computed here from line items, change
     * orders and gate charges, and the server has none of that. So the server
     * says "money came in" and this says "that's all of it".
     *
     * Never downgrades. Someone who marked a job paid by hand -- cash, a check,
     * a bank transfer -- had a reason, and having the app quietly undo it would
     * make the status untrustworthy.
     */
    fun reconcilePaymentStatus() {
        val current = job.value ?: return
        val total = contractTotal.value.grandTotal
        if (total <= 0.0) return
        // Net of refunds. Giving money back has to be able to move a job out of
        // "paid in full", or a refunded job reads as settled forever.
        val net = JobMoney.netPaid(current)
        val settled = net + 0.005 >= total
        val target = when {
            settled -> PaymentStatus.PAID_IN_FULL
            net > 0.005 -> PaymentStatus.DEPOSIT_PAID
            else -> PaymentStatus.UNPAID
        }
        if (current.paymentStatus == target) return
        // Only a refund may walk the status backwards. Otherwise this never
        // downgrades: someone who marked a job paid by hand -- cash, a check, a
        // bank transfer -- had a reason, and quietly undoing it would make the
        // status untrustworthy.
        val goingBackwards = target.ordinal < current.paymentStatus.ordinal
        if (goingBackwards && current.refundedAmount <= 0.005) return
        update { it.copy(paymentStatus = target) }
    }

    /**
     * Records money taken in person -- cash, a check, a bank transfer.
     *
     * Adds to the total rather than setting it, which is the whole reason the
     * figure stopped being a text box. A typed total is a number someone can
     * overwrite: tap in 500 on a job that already had a 500 deposit banked and
     * the second 500 silently replaces the first instead of adding to it. Card
     * payments post themselves, so every route into this figure is now an
     * addition and none of them is a keystroke over the top of another.
     */
    fun recordPayment(
        amount: Double,
        method: com.fenceestimator.app.data.PaymentMethod,
        receivedAt: Long,
        reference: String,
        note: String
    ) {
        if (amount <= 0.0) return
        viewModelScope.launch {
            // Written to the ledger, which then recomputes the job's total.
            // Adding straight to amountPaid would leave a figure with no row
            // behind it -- and "collected this month" is a sum of rows, so the
            // payment would be invisible to every report.
            repository.recordPayment(
                com.fenceestimator.app.data.PaymentRecord(
                    jobId = jobId,
                    amount = amount,
                    method = method,
                    receivedAt = receivedAt,
                    reference = reference,
                    note = note
                )
            )
            reconcilePaymentStatus()
        }
    }

    /**
     * Records money handed back to the customer.
     *
     * Added to a refund total rather than subtracted from what they paid. Sync
     * keeps the larger of each figure so a race can never erase money, which
     * means a payment cannot be edited downward -- so a refund is recorded as
     * its own fact and the two are netted when the balance is shown.
     *
     * The amount is capped at what has actually been collected: refunding more
     * than was ever taken is always a typo, and it would leave the job showing
     * the customer as owed money that never existed.
     */
    fun recordRefund(amount: Double, reason: String) {
        val current = job.value ?: return
        if (amount <= 0.0) return
        val capped = minOf(amount, JobMoney.netPaid(current))
        if (capped <= 0.0) return
        viewModelScope.launch {
            // A negative ledger row, so the statement reads in one place and a
            // refund lands in the month it was actually given back rather than
            // being netted invisibly off an older payment.
            repository.recordPayment(
                com.fenceestimator.app.data.PaymentRecord(
                    jobId = jobId,
                    amount = -capped,
                    method = com.fenceestimator.app.data.PaymentMethod.OTHER,
                    note = reason
                )
            )
            update {
                it.copy(
                    refundedAt = System.currentTimeMillis(),
                    refundReason = listOf(it.refundReason, reason)
                        .filter { line -> line.isNotBlank() }
                        .joinToString("; ")
                )
            }
            // The status has to follow the money straight away, or the job sits
            // at "paid in full" while the customer is holding a refund.
            reconcilePaymentStatus()
        }
    }

    /**
     * Stamps what the customer actually agreed to, at the moment they agree.
     *
     * Without this a signature is just "someone signed something": redraw the
     * layout afterwards and the old signature silently stands as agreement to a
     * job that no longer exists.
     */
    fun recordSignedTerms() {
        val totals = contractTotal.value
        update {
            it.copy(
                signedContractTotal = totals.grandTotal,
                signedLinearFeet = totals.billableLinearFeet
            )
        }
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
