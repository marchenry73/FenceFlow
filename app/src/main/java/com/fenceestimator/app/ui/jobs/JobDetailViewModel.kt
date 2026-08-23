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
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class JobDetailViewModel(private val repository: Repository, private val jobId: Long) : ViewModel() {
    val job: StateFlow<Job?> = repository.observeJob(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    /** Every job, so an overrun can work out whose date it pushes. */
    val allJobs: StateFlow<List<Job>> = repository.observeJobs()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

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
            EstimateEngine.computeTotals(
                currentJob, items, EstimateEngine.linearFeet(currentJob, runs), orders, runs
            )
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), EMPTY_TOTALS)

    /**
     * What still needs collecting to cover materials, rounded up to the next
     * $10 so it reads like a real figure rather than a calculation.
     *
     * Net of what the customer has already paid. Without that subtraction,
     * adding materials to a job that was already part paid produced a
     * suggestion to collect the whole new material total again -- so a customer
     * who had handed over $1,000 was asked for the full $2,450 rather than the
     * $1,450 outstanding. Returns zero once payments already cover materials,
     * which is also what stops the suggestion appearing at all.
     */
    fun suggestedDeposit(): Double {
        val cost = materialCost.value
        if (cost <= 0.0) return 0.0
        val current = job.value
        val alreadyPaid = current?.let { com.fenceestimator.app.estimate.JobMoney.netPaid(it) } ?: 0.0
        val outstanding = cost - alreadyPaid
        if (outstanding <= 0.0) return 0.0
        return kotlin.math.ceil(outstanding / 10.0) * 10.0
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

    /**
     * Only people still on the crew: this list is for choosing who does the
     * work, and somebody who has left cannot. Their name stays on the jobs they
     * already did.
     */
    val employees: StateFlow<List<Employee>> = repository.observeActiveEmployees()
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
    /**
     * @param known the job as it is right now, when the caller has just
     *   changed it. job.value is a Flow and lags a write made moments earlier
     *   in the same coroutine, so a caller that has just moved money must pass
     *   what it read back rather than let this read a stale copy.
     */
    fun reconcilePaymentStatus(known: Job? = null) {
        val current = known ?: job.value ?: return
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
        // Written through the job we were handed (the freshly re-read one),
        // not through update(), which copies job.value -- the Flow this file
        // documents as lagging inside the same coroutine. Going through it put
        // the pre-refund totals straight back over the refund just recorded.
        viewModelScope.launch { repository.updateJob(current.copy(paymentStatus = target)) }
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
    /** The job's ledger, for the duplicate warning in the payment dialog. */
    val payments: StateFlow<List<com.fenceestimator.app.data.PaymentRecord>> =
        repository.observePaymentsForJob(jobId)
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    /** Serialises refunds so two quick presses cannot both pass the cap. */
    private val refundLock = kotlinx.coroutines.sync.Mutex()

    fun recordRefund(amount: Double, reason: String) {
        if (amount <= 0.0) return
        viewModelScope.launch {
            // One refund at a time, and capped against the job as it is on
            // disk right now.
            //
            // Both halves matter. The cap used to be worked out from
            // job.value, a Flow that has not caught up while a refund is still
            // being written -- so a second press moments later measured itself
            // against the balance from BEFORE the first one and recorded the
            // whole amount again. A real ledger shows this happening four
            // times in ninety seconds for the same $39,916.85, because nothing
            // on screen moved and the obvious response is to press it again.
            refundLock.withLock {
                val current = repository.getJob(jobId) ?: return@withLock
                val capped = minOf(amount, JobMoney.netPaid(current))
                if (capped <= 0.0) return@withLock

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
                // Re-read rather than using job.value.
                //
                // recordPayment has just rewritten amountPaid and refundedAmount
                // from the ledger, but job.value is a Flow and has not caught up in
                // this same coroutine. Copying from it here wrote the PRE-refund
                // totals straight back over the top, so the ledger row survived and
                // the figures on screen did not move -- the refund only appeared
                // later, when a sync recomputed the totals again. Which is exactly
                // "recording a refund is not working immediately".
                val fresh = repository.getJob(jobId) ?: return@withLock
                repository.updateJob(
                    fresh.copy(
                        refundedAt = System.currentTimeMillis(),
                        refundReason = listOf(fresh.refundReason, reason)
                            .filter { line -> line.isNotBlank() }
                            .joinToString("; ")
                    )
                )
                // The status has to follow the money straight away, or the job sits
                // at "paid in full" while the customer is holding a refund. Given
                // the freshly read job for the same reason as above.
                reconcilePaymentStatus(repository.getJob(jobId))
            }
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

    /** Answers a crew request to change the plan. */
    fun decidePlanChange(change: com.fenceestimator.app.data.FieldChange, approved: Boolean, note: String) {
        viewModelScope.launch {
            repository.decidePlanChange(change, approved, decidedByName, note)
        }
    }

    /**
     * Moves another job on the calendar -- the one this overrun pushed.
     *
     * Done from here rather than making somebody open that job, find the date
     * field and work out the new day. The whole point is that it happens at the
     * moment the problem is noticed, because the alternative is remembering to
     * do it later and the customer finding out when nobody turns up.
     */
    fun rescheduleOtherJob(other: com.fenceestimator.app.data.Job, newDate: Long?) {
        if (newDate == null) return
        viewModelScope.launch {
            repository.updateJob(other.copy(scheduledDate = newDate))
        }
    }

    /** Who is answering, set by the screen from the session. */
    var decidedByName: String = ""

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
