package com.fenceestimator.app.ui.jobs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.data.BusinessProfile
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
import com.fenceestimator.app.geometry.DrawingSnapshot
import com.fenceestimator.app.cloud.SupabaseModule
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FieldChange
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class JobDetailViewModel(
    private val repository: Repository,
    private val jobId: Long,
    /**
     * The company's rates, for the computed install hours
     * ([followComputedDuration]). Empty by default, which simply means the
     * hours are never followed -- never guessed from default rates.
     */
    private val profileFlow: Flow<BusinessProfile> = emptyFlow()
) : ViewModel() {
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
     * The figure this job is billed against: the price the customer accepted
     * (plus extra work signed since) once they have, the live estimate until
     * then -- see [JobMoney.billableTotal]. Every "still owed", payment request,
     * deposit check and status decision on this screen goes through it, so
     * none of them can disagree with the quote page or the invoice.
     */
    fun billableTotal(current: Job): Double =
        JobMoney.billableTotal(current, contractTotal.value.grandTotal, changeOrders.value)

    /**
     * What still needs collecting to cover materials, rounded up to the next
     * $10 so it reads like a real figure rather than a calculation -- and never
     * more than is still owed on [billableTotal]. See
     * [JobMoney.suggestedMaterialsDeposit].
     *
     * Net of what the customer has already paid. Without that subtraction,
     * adding materials to a job that was already part paid produced a
     * suggestion to collect the whole new material total again -- so a customer
     * who had handed over $1,000 was asked for the full $2,450 rather than the
     * $1,450 outstanding. Returns zero once payments already cover materials,
     * which is also what stops the suggestion appearing at all.
     *
     * Offered, never applied by itself. The screen used to write this into the
     * deposit on its own the first time the materials figure was non-zero
     * (autoFillDepositFromMaterials): whatever the takeoff showed at that
     * moment -- mid-regenerate, or with lines a sync was about to revert --
     * became the customer's deposit for good, from the raw materials sum with
     * no tax, labour or markup, and tied to no price anyone had agreed.
     * John Beaunissant's deposit moved from $9,910 to $5,730 ten seconds after
     * he signed. There is no company deposit rule to compute one from instead
     * (dashboard: deposit_percent was removed as decoration, pending the
     * owner's decision), so the deposit is whatever a person types or taps.
     */
    fun suggestedDeposit(): Double {
        val current = job.value ?: return 0.0
        return JobMoney.suggestedMaterialsDeposit(current, materialCost.value, billableTotal(current))
    }

    fun applySuggestedDeposit() {
        val amount = suggestedDeposit()
        if (amount <= 0.0) return
        update { it.copy(depositAmount = amount) }
    }

    /**
     * What this phone saw the computed install hours come to when it last
     * looked, for [followComputedDuration]. Held by the ViewModel, so it
     * survives a trip to the drawing screen and back -- which is exactly the
     * change it exists to notice.
     */
    private var durationBaseline: Double? = null

    /**
     * The computed install hours, from this ViewModel's own reads of the job,
     * its runs, its site markers and the company's rates. A cold flow, so each
     * collection starts from what is on disk, and `combine` holds its first
     * value back until all four have loaded -- the screen's own figure starts
     * from empty lists and a default profile, and a baseline taken from that
     * would read the load itself as a change.
     */
    private val computedHours = combine(
        repository.observeJob(jobId),
        repository.observeFenceRuns(jobId),
        repository.observeSiteMarkers(jobId),
        profileFlow
    ) { currentJob, runs, markers, profile ->
        currentJob?.let {
            com.fenceestimator.app.estimate.DurationEstimator.estimate(
                it, runs,
                it.calibrationPixelsPerFoot ?: com.fenceestimator.app.ui.survey.SurveyViewModel.PIXELS_PER_FOOT_GRID,
                durationRatesOf(profile),
                markers
            ).totalHours
        }
    }

    /**
     * Keeps the stored duration in step with the footage while this job is
     * open -- but only for a change that happened while it was, and only on a
     * phone allowed to reschedule. Runs until the calling effect leaves.
     *
     * It used to save the computed hours whenever they differed from the
     * stored ones, the moment the screen opened, on every phone. A computed
     * figure differing from the stored one is not an edit: the office may have
     * typed its own, the rates may differ from phone to phone, the drawing may
     * not have synced yet. On a crew handset that save was a job-row write
     * that pushed the crew's whole copy of the job; job 4598150b went from the
     * office's 4 hours to 93.33 that way. See [durationFollowStep] (the
     * pure rule) for exactly when it writes.
     */
    suspend fun followComputedDuration(mayWrite: Boolean) {
        computedHours.collect { hours ->
            if (hours == null) return@collect
            val current = repository.getJob(jobId) ?: return@collect
            val step = durationFollowStep(
                baseline = durationBaseline,
                computed = hours,
                stored = current.estimatedDurationHours,
                manuallySet = current.durationManuallySet,
                mayWrite = mayWrite
            )
            durationBaseline = step.baseline
            step.write?.let { repository.updateJob(current.copy(estimatedDurationHours = it)) }
        }
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
        // What the job is billed against, not the live estimate: once the
        // customer has accepted a price, a recompute that drifted above it
        // must not hold a job that has been paid in full at "deposit paid".
        val total = billableTotal(current)
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
     * Stores the signature together with what it is a signature FOR, exactly
     * as EstimateViewModel.captureSignature does for the estimate screen's own
     * "sign" button -- this is the job screen's door to the same act, for a
     * re-sign asked for after the original was stale.
     *
     * Goes through repository.recordSignedAcceptance rather than update{}: that
     * repository method wraps the job write AND
     * changeOrderDao.markAllInAcceptedTotal(job.id) in one transaction, and
     * skipping the second half double-bills every change order on the job --
     * grandTotal already counts them whether signed or not, so one still
     * unsigned right now would be added again the day it is signed.
     *
     * acceptedTotal is frozen here too, in the same write: this is the moment
     * the customer agreed to the price, and from here on it is the figure the
     * phone bills against (see JobMoney.anchoredTotal). Only frozen when the
     * agreed total is actually above zero -- a zero here means totals have not
     * loaded yet, and freezing that would anchor the job at $0 instead of
     * leaving the previous acceptedTotal standing. Skipping this reproduces a
     * real regression where a signature covered $9,710 and the quote page kept
     * recomputing to $13,410.
     */
    fun captureSignature(path: String) {
        val current = job.value ?: return
        val agreed = contractTotal.value
        viewModelScope.launch {
            repository.recordSignedAcceptance(
                current.copy(
                    signatureImagePath = path,
                    signedAt = System.currentTimeMillis(),
                    signedContractTotal = agreed.grandTotal,
                    signedLinearFeet = agreed.billableLinearFeet,
                    acceptedTotal = agreed.grandTotal.takeIf { it > 0.005 } ?: current.acceptedTotal
                )
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
     *
     * The UPLOADED copy of that signature goes with it
     * ([ChangeOrder.signatureStoragePath]), and leaving it behind was worse
     * than useless. JobFileUploader only uploads a signature when the order
     * has no storage path yet, so a stale path meant the NEW signature was
     * never uploaded at all -- and then the push sent the OLD image as the
     * proof for the new terms ([changeOrderSignaturePathToSend] asks only
     * whether the order is signed, and after re-signing it is). Every other
     * phone and the office would have downloaded a signature for $1,200 and
     * shown it against $3,400. Cleared here, the uploader takes the new image
     * on the next pass and the push has nothing to send until it does.
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
                    signatureStoragePath = if (termsChanged) null else order.signatureStoragePath,
                    signedAt = if (termsChanged) null else order.signedAt,
                    // Says out loud that this phone cleared it, so the push
                    // sends the clear instead of leaving the field out and the
                    // pull putting the old signature back. Only when there was
                    // one to clear.
                    signatureClearedAt =
                        if (termsChanged && (order.signedAt != null || order.signatureStoragePath != null))
                            System.currentTimeMillis()
                        else order.signatureClearedAt
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

    /**
     * For the delete confirmation, so it can name how many hours are on the
     * job rather than just warning about "clocked hours" in the abstract.
     * Null means the count failed, not that there were zero -- see
     * [Repository.recordedHoursForJob].
     */
    suspend fun countRecordedHours(): Double? = repository.recordedHoursForJob(jobId)

    /**
     * Who to name as the author of a drawing restore, and their role. Set by
     * the screen from the session.
     *
     * Deliberately not [decidedByName], which is who ANSWERS a crew request to
     * change the plan. The two happen to have the same answer today; they are
     * still two questions, and one field serving both is how a later change to
     * either one silently moves the other.
     *
     * Blank is possible and is not a failure: a phone with no company login has
     * one person on it and nobody to report to. On a company login the session
     * carries an email, which is the point -- a footage change appearing in the
     * crew's feed with no author was the gap this fills.
     */
    var restoredByName: String = ""
    var restoredByRole: String = ""

    /**
     * Puts an earlier drawing back onto one of this job's fence runs.
     *
     * An ordinary local edit and deliberately nothing more.
     * [Repository.updateFenceRun] stamps the run's clock to now, exactly as the
     * drawing screen's own edits do, and the push sends a run whose clock is
     * ahead of the cloud's. That push is what fires the server trigger which
     * decides -- on its own, from the geometry and the price -- whether the
     * customer's approval comes back. There is no restore route to call and
     * there must not be one: a direct write to the cloud from here would land
     * the same row without moving this phone's clock, so the next pull would
     * read this phone's copy as the older one and put the changed drawing
     * straight back.
     *
     * THE WITHDRAWAL IS RE-READ FROM THE SERVER FIRST, and nothing is written
     * unless that read arrives and says it is still unsettled. The flag the
     * screen holds came from a read taken when the screen opened. Once the
     * customer has approved again, the job is approved once more -- and this
     * same write then reads as an ordinary edit to an approved job, which takes
     * the approval they just gave AWAY instead of putting anything back. So an
     * unreachable server ends the attempt
     * ([DrawingRestoreOutcome.CANNOT_CHECK]) rather than queueing an edit that
     * would land hours later against a job that had moved on, with nobody
     * watching the screen that would have said so.
     *
     * The run is re-read from disk rather than taken from the list on screen,
     * the same way the drawing screen re-reads a run before editing it. A row
     * a composition has been holding for a minute is not what is in the
     * database, and writing a whole run from a stale copy would take
     * everything edited in between with it.
     *
     * A run that already carries everything the snapshot holds is not written
     * at all. Every write moves the run's clock, and fence runs resolve a
     * conflict by the later clock, so re-saving an unchanged run would make
     * this phone's copy look newer than an office change that has not come
     * down yet -- the same reason the drawing screen refuses an edit that
     * changed nothing.
     *
     * Runs in the ViewModel's own scope, and answers through [onDone], so
     * walking off the job screen mid-write cannot cancel it half done.
     *
     * WHAT IS STILL OPEN, and it is a window rather than a hole. The check is a
     * live read; the write is a local one that reaches the cloud on the next
     * push. So the gap is not "until this phone has signal" -- that case is
     * closed, since no signal means no write at all -- it is the seconds or
     * minutes between the check passing and the push landing. A customer who
     * approves again inside that gap has the approval taken away by this push,
     * with the phone already having said the drawing was put back. Closing it
     * properly means re-checking as part of the push itself, which belongs in the
     * sync layer rather than here, so it is written down instead of pretended
     * away.
     */
    // internal, not public: its snapshot parameter is an internal type that
    // exists only for this screen, and Kotlin refuses a public signature that
    // names a less visible one. Every other internal type in this module is
    // reached the same way. The only caller is the card on the job screen,
    // in this module.
    internal fun restoreRunDrawing(
        /** The quote_reapprovals row this drawing came off, so it can be re-read. */
        withdrawalId: String,
        runSyncId: String,
        snapshot: RunSnapshot,
        /**
         * The day of the change being undone, already formatted by the screen,
         * so the feed entry can name which change was put back without this
         * class having to know how the reader's locale writes a date.
         */
        changedOn: String,
        onDone: (DrawingRestoreOutcome) -> Unit
    ) {
        viewModelScope.launch {
            when (withdrawalStillOpen(withdrawalId)) {
                WithdrawalState.UNREADABLE -> {
                    onDone(DrawingRestoreOutcome.CANNOT_CHECK)
                    return@launch
                }
                WithdrawalState.RESOLVED -> {
                    onDone(DrawingRestoreOutcome.RESOLVED_MEANWHILE)
                    return@launch
                }
                WithdrawalState.OPEN -> Unit
            }
            val run = repository.getFenceRuns(jobId).firstOrNull { it.syncId == runSyncId }
            if (run == null) {
                onDone(DrawingRestoreOutcome.RUN_GONE)
                return@launch
            }
            val restored = snapshot.appliedTo(run)
            if (restored == run) {
                onDone(DrawingRestoreOutcome.ALREADY_THERE)
                return@launch
            }
            repository.updateFenceRun(restored)
            recordRestoreInFeed(run, restored, snapshot, changedOn)
            onDone(DrawingRestoreOutcome.DONE)
        }
    }

    /** What the server says about one withdrawal right now. See [withdrawalStillOpen]. */
    private enum class WithdrawalState { OPEN, RESOLVED, UNREADABLE }

    /**
     * Asks the server whether one withdrawal is still waiting to be settled.
     *
     * The narrowest read that answers the question: the row's own id and its
     * resolved_at, nothing else. prior_contract_total lives on this same table
     * and is deliberately not asked for, so no price can reach a phone through
     * this call any more than through the history read on the job screen.
     *
     * A row that has vanished counts as settled rather than readable. The only
     * things that remove one are the job or the company going, and neither is a
     * state to write a drawing into.
     *
     * The failure is not sent to the crash log: the ordinary cause is no
     * signal, and a log full of that tells nobody anything. The caller says so
     * on screen instead, which is where it is any use.
     */
    private suspend fun withdrawalStillOpen(withdrawalId: String): WithdrawalState {
        if (withdrawalId.isBlank()) return WithdrawalState.UNREADABLE
        // Asked before the request, not after it. supabase-kt sends the anon key
        // when it holds no token, which is a request that succeeds and comes
        // back empty -- and empty here would read as "settled".
        if (!SupabaseModule.hasLiveSession()) return WithdrawalState.UNREADABLE
        return runCatching {
            SupabaseModule.client.postgrest.from("quote_reapprovals")
                .select(
                    io.github.jan.supabase.postgrest.query.Columns.list("id", "resolved_at")
                ) {
                    filter { eq("id", withdrawalId) }
                }
                .decodeList<WithdrawalStateRow>()
                .firstOrNull()
        }.fold(
            onSuccess = { rowNow ->
                when {
                    rowNow == null -> WithdrawalState.RESOLVED
                    rowNow.resolvedAt != null -> WithdrawalState.RESOLVED
                    else -> WithdrawalState.OPEN
                }
            },
            onFailure = { e ->
                // Leaving the screen mid-read cancels this, which is not a
                // failure and must stay a cancellation.
                if (e is kotlinx.coroutines.CancellationException) throw e
                WithdrawalState.UNREADABLE
            }
        )
    }

    /**
     * Puts the restore in the feed the office and the crew already read.
     *
     * Every ordinary drawing edit on the drawing screen -- Undo and Redo
     * included -- records a field change when the footage moves, and that is
     * how a crew already on site find out the fence line is not the one they
     * measured against. A restore moves the same numbers and recorded nothing,
     * so the footage changed underneath them with no author and no entry. This
     * writes the same record, from here, because this is where the change is
     * made.
     *
     * The footage comes from [EstimateEngine.linearFeet] rather than being
     * measured again here, so the figure in the feed is the figure the estimate
     * and the crew's plan already show. The run is measured as though it were
     * being built: linearFeet leaves a teardown run out of the total, which is
     * right for the money and wrong for this sentence, because a crew needs to
     * know the old fence line moved as well. Whether the run is a teardown is
     * said in words instead.
     *
     * A job with no calibration and no typed footage has no scale to measure
     * at, and linearFeet answers nought rather than guessing -- so the figures
     * are left out of the line entirely rather than reporting nought feet on
     * both sides of an arrow.
     *
     * Nothing written here says the approval is back. The server decides that,
     * and it decides after this row exists.
     */
    private suspend fun recordRestoreInFeed(
        before: FenceRun,
        after: FenceRun,
        snapshot: RunSnapshot,
        changedOn: String
    ) {
        val current = job.value ?: repository.getJob(jobId) ?: return
        val label = before.label.ifBlank { "Fence run" }
        val measurable = current.calibrationPixelsPerFoot != null ||
            before.manualLinearFeet != null || after.manualLinearFeet != null
        val movement = if (!measurable) "" else {
            val wasFeet = EstimateEngine.linearFeet(current, listOf(before.copy(isTeardown = false)))
            val nowFeet = EstimateEngine.linearFeet(current, listOf(after.copy(isTeardown = false)))
            ": " + "%.0f".format(wasFeet) + " ft → " + "%.0f".format(nowFeet) + " ft"
        }
        val typedNow = after.manualLinearFeet
        val detail = buildString {
            append("The drawing was put back to the one this run had before the change on ")
            append(changedOn)
            append(". ")
            if (snapshot.typed == null) {
                append(
                    "Only the outline was kept for that change, so any typed footage and " +
                        "the teardown flag are untouched. "
                )
            } else {
                if (before.manualLinearFeet != typedNow) {
                    append(
                        if (typedNow == null)
                            "Typed footage was removed, so the length is measured off the drawing again. "
                        else
                            "Typed footage is back to " + "%.0f".format(typedNow) + " ft. "
                    )
                }
                if (before.isTeardown != after.isTeardown) {
                    append(
                        if (after.isTeardown) "This run counts as the old fence coming out again. "
                        else "This run counts as new fence going in again. "
                    )
                }
            }
            append(
                "Whether the customer's approval comes back is decided in the cloud, " +
                    "on the next sync."
            )
        }
        // A job the sync removed while this screen was open took its runs with
        // it, so the note has nothing to hang off -- and inserting it hits the
        // foreign key and crashes. Skipped instead (see OrphanRows).
        com.fenceestimator.app.cloud.skipIfOrphaned {
            repository.recordFieldChange(
                FieldChange(
                    jobId = jobId,
                    summary = label + ": drawing put back" + movement,
                    detail = detail,
                    changedBy = restoredByName,
                    changedByRole = restoredByRole
                )
            )
        }
    }

    private companion object {
        val EMPTY_TOTALS = EstimateEngine.Totals(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    }
}

/**
 * One withdrawal's settled state, read back at the moment of writing.
 *
 * Two columns and no more. prior_contract_total is on this table too; asking
 * for it would put a price on a phone that may not be allowed one, so this read
 * names exactly what it needs.
 */
@kotlinx.serialization.Serializable
private data class WithdrawalStateRow(
    val id: String = "",
    @kotlinx.serialization.SerialName("resolved_at") val resolvedAt: String? = null,
)

/** What came of [JobDetailViewModel.restoreRunDrawing]. */
enum class DrawingRestoreOutcome {
    /** The run carries the earlier drawing now, and the next sync sends it up. */
    DONE,

    /**
     * That fence run is not on this job any more -- deleted here, or a delete
     * that synced down while the history was on screen. Said out loud, because
     * a button that reports success and changes nothing is worse than no
     * button.
     */
    RUN_GONE,

    /** The run already carried everything that snapshot holds, so nothing was written. */
    ALREADY_THERE,

    /**
     * The customer has already approved this quote again, so this withdrawal is
     * settled. Writing the old drawing now would not bring an approval back --
     * it would withdraw the one they just gave, because an edit to an approved
     * job is what withdraws an approval. Nothing was written.
     */
    RESOLVED_MEANWHILE,

    /**
     * The server could not be asked whether the withdrawal is still open --
     * ordinarily no signal. Nothing was written and nothing was queued: an edit
     * left in the outbox lands whenever the phone next reaches the network,
     * against a job that may have been approved again by then, and with nobody
     * looking at the screen that would have reported it.
     */
    CANNOT_CHECK,
}

/**
 * What a withdrawn approval kept of the run, as something that can be written
 * back.
 *
 * Answered around [DrawingSnapshot] because that type exists for exactly this:
 * it holds the stored strings rather than decoded lists, so what goes back onto
 * the run is byte for byte what came off it. That is the same guarantee Undo
 * and Redo rely on, and it is also what lets the server's fingerprint match the
 * approved takeoff again.
 */
internal data class RunSnapshot(
    val drawing: DrawingSnapshot,
    /**
     * The typed takeoff, or null on a row written before the snapshot carried
     * it.
     *
     * Null means NOT RECORDED, which is not the same as recorded as nothing. A
     * restore from such a row has to leave the run's typed footage, typed
     * corner count and teardown flag exactly as they are, because it has no
     * idea what they were.
     */
    val typed: TypedTakeoff?
) {
    /**
     * The three run columns the fingerprint reads besides the geometry.
     *
     * They are in the snapshot because the fingerprint is taken on them: a
     * change that also touched the typed footage, the typed corner count or the
     * teardown flag left a geometry-only record that could not reproduce it, so
     * the drawing went back, the fingerprint still missed, and the price got
     * blamed for it.
     */
    internal data class TypedTakeoff(
        /**
         * Null means the run had NO typed footage. Not zero feet: the two are
         * different runs, and the app reads a typed figure only when there is
         * one.
         */
        val manualLinearFeet: Float?,
        val manualCornerCount: Int,
        val isTeardown: Boolean
    )

    /** [run] with this snapshot written over it and nothing else touched. */
    fun appliedTo(run: FenceRun): FenceRun {
        val withDrawing = run.copy(
            pointsEncoded = drawing.pointsEncoded,
            gatesEncoded = drawing.gatesEncoded,
            closedLoop = drawing.closedLoop
        )
        val t = typed ?: return withDrawing
        return withDrawing.copy(
            manualLinearFeet = t.manualLinearFeet,
            manualCornerCount = t.manualCornerCount,
            isTeardown = t.isTeardown
        )
    }
}

/**
 * Reads one stored snapshot, or refuses it.
 *
 * The server joins the run's own strings with bars (reapp_run_snapshot) -- the
 * app's encoding, not a second one. It writes SIX fields now: the two encoded
 * strings, the closed-loop flag, the typed footage, the typed corner count and
 * the teardown flag. Rows written before it was widened hold the first THREE
 * and still have to be readable, so both lengths are accepted and nothing else
 * is. Any other shape came from something that is not that function, and
 * guessing which field is which would put a gate list into the point column;
 * refused whole instead, and the screen offers no way back for a row it cannot
 * read.
 *
 * Neither encoded string can contain a bar -- points are coordinate pairs
 * joined by commas, gates likewise -- so splitting on it is exact.
 *
 * The typed footage and the typed corner count are EMPTY when the server's
 * column was null, and empty is not zero. The app's own footage column is
 * nullable and gets the null back, which matters because "no typed footage" and
 * "typed footage of nothing" are different runs. Its corner-count column is
 * not nullable: it is a plain integer whose no-figure-typed value is nought, so
 * an empty corner count can only come back as nought. That is the one field
 * this cannot reproduce exactly, and the corner count is read at all only
 * alongside a typed footage figure, so it cannot turn a run with nothing typed
 * into one with something typed.
 *
 * A three-part row restores the outline and nothing else -- it never recorded
 * the rest. The row on screen says so, rather than implying a fuller restore
 * than happened.
 */
internal fun parseRunSnapshot(raw: String): RunSnapshot? {
    val parts = raw.split("|")
    if (parts.size != 3 && parts.size != 6) return null
    val closed = snapshotFlagOrNull(parts[2]) ?: return null
    val drawing = DrawingSnapshot(
        pointsEncoded = parts[0],
        gatesEncoded = parts[1],
        closedLoop = closed
    )
    if (parts.size == 3) return RunSnapshot(drawing = drawing, typed = null)
    // A field that is present but will not parse is a snapshot this code does
    // not understand. Half of one is worse than none, so the whole row is
    // refused rather than restored with a number guessed for the rest.
    val feet = if (parts[3].isEmpty()) null else (parts[3].toFloatOrNull() ?: return null)
    val corners = if (parts[4].isEmpty()) 0 else (parts[4].toIntOrNull() ?: return null)
    val teardown = snapshotFlagOrNull(parts[5]) ?: return null
    return RunSnapshot(
        drawing = drawing,
        typed = RunSnapshot.TypedTakeoff(
            manualLinearFeet = feet,
            manualCornerCount = corners,
            isTeardown = teardown
        )
    )
}

/** The server writes a snapshot's booleans as 1 or 0; anything else is not its writing. */
private fun snapshotFlagOrNull(raw: String): Boolean? = when (raw) {
    "1" -> true
    "0" -> false
    else -> null
}

/**
 * The company's duration rates, in one place: the job screen's hours estimate
 * and [JobDetailViewModel.followComputedDuration] both read them from here, so
 * the figure shown and the figure saved cannot come from two different
 * mappings.
 */
internal fun durationRatesOf(profile: BusinessProfile) =
    com.fenceestimator.app.estimate.DurationEstimator.Rates(
        feetPerDay = profile.feetPerDay,
        workdayHours = profile.workdayHours,
        breakHoursPerDay = profile.breakHoursPerDay,
        hoursPerGate = profile.hoursPerGate,
        hoursPerTree = profile.hoursPerTree,
        hoursPerObstacle = profile.hoursPerObstacle,
        hoursPerCorner = profile.hoursPerCorner,
        setupHours = profile.setupHours,
        teardownHoursPerFoot = profile.teardownHoursPerFoot
    )

/** One step of [JobDetailViewModel.followComputedDuration], decided by [durationFollowStep]: the baseline to keep, and the hours to save, if any. */
internal data class DurationFollowStep(val baseline: Double, val write: Double?)

/**
 * Whether the computed install hours should be saved over the stored ones.
 *
 * Only when the computed figure has MOVED since this phone first saw it
 * ([baseline]) -- a drawing edited, a run added -- and only on a phone that may
 * reschedule ([mayWrite]), and never over hours somebody typed
 * ([manuallySet]). The first figure seen is only ever recorded: a computed
 * value that differs from the stored one when a job is opened is not anything
 * the person holding the phone did. The old rule saved on that difference
 * alone, on open, on every phone -- a crew handset wrote 93.33 hours over the
 * office's 4 on job 4598150b just by opening it.
 */
internal fun durationFollowStep(
    baseline: Double?,
    computed: Double,
    stored: Double,
    manuallySet: Boolean,
    mayWrite: Boolean
): DurationFollowStep {
    if (baseline == null) return DurationFollowStep(computed, null)
    if (kotlin.math.abs(computed - baseline) <= 0.005) return DurationFollowStep(baseline, null)
    val write = computed.takeIf {
        mayWrite && !manuallySet && it > 0.0 && kotlin.math.abs(it - stored) > 0.005
    }
    return DurationFollowStep(computed, write)
}
