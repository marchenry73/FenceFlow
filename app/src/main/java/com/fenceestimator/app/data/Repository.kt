package com.fenceestimator.app.data

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.map

class Repository(private val db: AppDatabase) {

    /**
     * Who is deleting things on this device, recorded on the tombstone so the
     * trash can say who to ask about a record before restoring it. Set by the
     * app when the session resolves; blank when working signed-out alone.
     */
    var deletingUser: String = ""

    /** Flushes pending writes to disk so a raw copy of the DB file for backup is complete. */
    suspend fun checkpointForBackup() = db.checkpoint()

    private val jobDao = db.jobDao()
    private val fenceRunDao = db.fenceRunDao()
    private val materialDao = db.materialItemDao()
    private val lineItemDao = db.estimateLineItemDao()
    private val manufacturerDao = db.manufacturerDao()
    private val pricingTierDao = db.pricingTierDao()
    private val jobPhotoDao = db.jobPhotoDao()
    private val inventoryItemDao = db.inventoryItemDao()
    private val employeeDao = db.employeeDao()
    private val expenseDao = db.expenseDao()
    private val punchListDao = db.punchListDao()
    private val jobStepDao = db.jobStepDao()
    private val fieldChangeDao = db.fieldChangeDao()
    private val changeOrderDao = db.changeOrderDao()
    private val siteMarkerDao = db.siteMarkerDao()
    private val timeEntryDao = db.timeEntryDao()
    private val pendingDeletionDao = db.pendingDeletionDao()
    private val syncMaintenanceDao = db.syncMaintenanceDao()
    private val paymentRecordDao = db.paymentRecordDao()

    fun observeJobs(): Flow<List<Job>> = jobDao.observeAll()
    fun observeJob(id: Long): Flow<Job?> = jobDao.observeById(id)
    suspend fun getJob(id: Long): Job? = jobDao.getById(id)
    suspend fun getJobsScheduledBetween(startMillis: Long, endMillis: Long): List<Job> = jobDao.getScheduledBetween(startMillis, endMillis)
    suspend fun getAllJobs(): List<Job> = jobDao.getAll()
    suspend fun createJob(job: Job): Long = jobDao.insert(job)
    suspend fun updateJob(job: Job) = jobDao.update(job.copy(updatedAt = System.currentTimeMillis()))

    /**
     * Writes a job pulled from the cloud WITHOUT touching updatedAt -- the
     * cloud's timestamp has to survive, otherwise every download would look
     * locally-newer on the next pass and ping-pong back up forever.
     */
    suspend fun updateJobFromCloud(job: Job) = jobDao.update(job)

    suspend fun updateJobSyncStamp(jobId: Long, syncedAt: Long) {
        jobDao.getById(jobId)?.let { jobDao.update(it.copy(lastSyncedAt = syncedAt)) }
    }
    /**
     * Deletes locally and records that the cloud copy must go too.
     *
     * Deleting used to be local-only, so the row survived in Supabase and the
     * next sync pulled it straight back as "a job this phone is missing" --
     * which is why deleted jobs kept reappearing.
     */
    suspend fun deleteJob(job: Job) {
        jobDao.delete(job)
        pendingDeletionDao.insert(PendingDeletion(syncId = job.syncId, tableName = "jobs", deletedBy = deletingUser))
    }

    /**
     * Wipes every table on this phone.
     *
     * Used when the phone changes hands between accounts. The cloud copy is
     * untouched, so this removes the local view, not the data -- signing back in
     * downloads it again. Deliberately does NOT write tombstones: this is "these
     * records are not mine to see", not "delete these records".
     */
    suspend fun clearAllLocalData() = db.clearAllTables()

    /** Queues a cloud row for deletion on the next sync. */
    suspend fun queueDeletion(syncId: String, tableName: String) =
        pendingDeletionDao.insert(PendingDeletion(syncId = syncId, tableName = tableName, deletedBy = deletingUser))

    /**
     * Deletes locally and records that the cloud copy must go too.
     *
     * Only jobs and employees used to do this. Everything else deleted locally
     * and left its cloud row alone, so the next pull saw a record this phone
     * was "missing" and put it straight back -- which is why deleted change
     * orders, expenses and punch list items kept returning, and why they
     * multiplied across devices.
     *
     * The tombstone is written first: if the sync runs between the two steps,
     * a delete that is queued but not yet applied locally is harmless, whereas
     * the reverse loses the instruction entirely.
     */
    private suspend fun deleteSynced(syncId: String, tableName: String, deleteLocal: suspend () -> Unit) {
        pendingDeletionDao.insert(PendingDeletion(syncId = syncId, tableName = tableName, deletedBy = deletingUser))
        deleteLocal()
    }

    /**
     * Removes a job because the cloud says it was deleted somewhere else.
     *
     * Deliberately does NOT queue a deletion of its own: the tombstone already
     * exists in the cloud, and queueing another would have this device stamp a
     * row that is already stamped. The cloud copy is what keeps it restorable.
     */
    suspend fun deleteJobLocallyOnly(job: Job) = jobDao.delete(job)

    /**
     * Removes rows another device deleted, without queueing a deletion of our
     * own -- the cloud tombstone already exists and is what keeps them
     * restorable.
     *
     * [table] is interpolated into the statement, which would be an injection
     * risk if it came from anywhere but [SyncTables.ALL]. It does not: those are
     * compile-time constants. The sync ids are bound as parameters.
     */
    suspend fun deleteLocalRowsBySyncId(table: String, syncIds: List<String>): Int {
        if (syncIds.isEmpty()) return 0
        require(table in SyncTables.ALL) { "refusing to delete from an unknown table: $table" }
        var removed = 0
        // Chunked because SQLite caps how many bind variables one statement takes.
        syncIds.chunked(400).forEach { chunk ->
            val placeholders = chunk.joinToString(",") { "?" }
            removed += syncMaintenanceDao.execute(
                androidx.sqlite.db.SimpleSQLiteQuery(
                    "DELETE FROM `$table` WHERE syncId IN ($placeholders)",
                    chunk.toTypedArray()
                )
            )
        }
        return removed
    }

    // ---- Payments ledger ---------------------------------------------------
    //
    // Every figure about money is a sum of these rows. Reports bucket on
    // receivedAt -- when the money actually moved -- so the same period gives
    // the same answer on every device. The previous arrangement attributed a
    // job's whole lifetime payment total to a single job timestamp, and that
    // timestamp was a sync artifact that differed per device.

    fun observePaymentsForJob(jobId: Long): Flow<List<PaymentRecord>> =
        paymentRecordDao.observeForJob(jobId)

    fun observeAllPayments(): Flow<List<PaymentRecord>> = paymentRecordDao.observeAll()

    suspend fun getPaymentsBetween(fromMillis: Long, toMillis: Long): List<PaymentRecord> =
        paymentRecordDao.getBetween(fromMillis, toMillis)

    suspend fun getAllPayments(): List<PaymentRecord> = paymentRecordDao.getAll()

    /** Replaces a ledger row with the cloud's version of it. */
    suspend fun updatePaymentFromCloud(record: PaymentRecord) = paymentRecordDao.insert(record)

    /** Inserts ledger rows pulled from the cloud, ignoring ones already held. */
    suspend fun insertPaymentsFromCloud(records: List<PaymentRecord>) =
        paymentRecordDao.insertAll(records)

    /**
     * Records money moving, and brings the job's cached total in step.
     *
     * The job still carries amountPaid because the payment link, the invoice
     * and the sync merge all read it, and it is what the webhook writes. It is
     * a cache of the ledger rather than a second source of truth: recomputed
     * from the rows every time one is added, so the two cannot drift.
     */
    suspend fun recordPayment(record: PaymentRecord) {
        paymentRecordDao.insert(record.copy(recordedBy = record.recordedBy.ifBlank { deletingUser }))
        syncJobTotalsFromLedger(record.jobId)
    }

    /** Recomputes the job's paid and refunded figures from the ledger. */
    suspend fun syncJobTotalsFromLedger(jobId: Long) {
        val rows = paymentRecordDao.observeForJob(jobId).firstOrNull().orEmpty()
        val paid = rows.filter { !it.isRefund }.sumOf { it.amount }
        val refunded = rows.filter { it.isRefund }.sumOf { -it.amount }
        val job = jobDao.getById(jobId) ?: return
        if (kotlin.math.abs(job.amountPaid - paid) < 0.005 &&
            kotlin.math.abs(job.refundedAmount - refunded) < 0.005
        ) return
        jobDao.update(
            job.copy(
                amountPaid = paid,
                refundedAmount = refunded,
                updatedAt = System.currentTimeMillis()
            )
        )
    }

    suspend fun pendingDeletions(): List<PendingDeletion> = pendingDeletionDao.getAll()
    suspend fun clearPendingDeletion(syncId: String) = pendingDeletionDao.clear(syncId)


    fun observeFenceRuns(jobId: Long): Flow<List<FenceRun>> = fenceRunDao.observeForJob(jobId)
    suspend fun getFenceRuns(jobId: Long): List<FenceRun> = fenceRunDao.getForJob(jobId)

    /**
     * Everything for every job, grouped by job id.
     *
     * A figure that spans all jobs -- what the whole business is still owed --
     * needs the same three tables for each one. Asking per job is three round
     * trips times the job count, which is what made the home screen slow to
     * settle once a company had real history in it. These are three queries
     * total no matter how many jobs there are.
     */
    suspend fun getAllFenceRunsByJob(): Map<Long, List<FenceRun>> =
        fenceRunDao.getAll().groupBy { it.jobId }
    fun observeFenceRun(id: Long): Flow<FenceRun?> = fenceRunDao.observeById(id)
    suspend fun getFenceRun(id: Long): FenceRun? = fenceRunDao.getById(id)
    suspend fun createFenceRun(run: FenceRun): Long = fenceRunDao.insert(run)
    suspend fun updateFenceRun(run: FenceRun) = fenceRunDao.update(run)
    suspend fun deleteFenceRun(run: FenceRun) = deleteSynced(run.syncId, "fence_runs") { fenceRunDao.delete(run) }

    fun observeCatalog(): Flow<List<MaterialItem>> = materialDao.observeAllActive()
    fun observeFullCatalog(): Flow<List<MaterialItem>> = materialDao.observeAll()
    suspend fun getByRole(role: MaterialRole): List<MaterialItem> = materialDao.getByRole(role)
    suspend fun saveMaterialItem(item: MaterialItem): Long =
        materialDao.insert(item.copy(lastUpdated = System.currentTimeMillis()))
    suspend fun updateMaterialItem(item: MaterialItem) =
        materialDao.update(item.copy(lastUpdated = System.currentTimeMillis()))
    suspend fun deleteMaterialItem(item: MaterialItem) = deleteSynced(item.syncId, "material_items") { materialDao.delete(item) }
    suspend fun addMaterialItems(items: List<MaterialItem>) = materialDao.insertAll(items)

    fun observeLineItems(jobId: Long): Flow<List<EstimateLineItem>> = lineItemDao.observeForJob(jobId)
    suspend fun getLineItems(jobId: Long): List<EstimateLineItem> = lineItemDao.getForJob(jobId)

    /** See [getAllFenceRunsByJob]. */
    suspend fun getAllLineItemsByJob(): Map<Long, List<EstimateLineItem>> =
        lineItemDao.getAll().groupBy { it.jobId }
    /**
     * Swaps this run's takeoff for a freshly generated one.
     *
     * Anything dropped is tombstoned so the cloud copy goes too. Without that,
     * a delete was local-only: the old rows stayed in the cloud, and the very
     * next sync pulled them back down beside the new ones. That is why pressing
     * Suggest Quantities twice still ended up with everything listed twice even
     * after the local duplicate was fixed.
     */
    suspend fun replaceAutoGeneratedLineItemsForRun(runId: Long, items: List<EstimateLineItem>) {
        val goingAway = lineItemDao.getGeneratedForRun(runId).map { it.syncId }.toSet()
        val staying = items.map { it.syncId }.toSet()
        (goingAway - staying).forEach { syncId ->
            pendingDeletionDao.insert(
                PendingDeletion(syncId = syncId, tableName = "estimate_line_items")
            )
        }
        lineItemDao.replaceGeneratedForRun(runId, items)
    }
    /**
     * Removes takeoff lines that lost their fence run, and tombstones them so
     * the cloud copy goes too.
     *
     * Deleting them locally alone did nothing lasting: the cloud rows survived,
     * the next pull saw sync ids it no longer recognised, and inserted them
     * straight back. That is why the stray items kept reappearing -- and why
     * they multiplied, since every device did this independently.
     *
     * Hand-typed extras have role NONE and are never touched.
     */
    suspend fun deleteOrphanedGeneratedLineItems(): Int {
        val orphans = lineItemDao.orphanedGenerated()
        orphans.forEach { item ->
            pendingDeletionDao.insert(
                PendingDeletion(syncId = item.syncId, tableName = "estimate_line_items")
            )
        }
        lineItemDao.deleteOrphanedGenerated()
        return orphans.size
    }

    suspend fun saveLineItem(item: EstimateLineItem): Long = lineItemDao.insert(item)
    suspend fun updateLineItem(item: EstimateLineItem) = lineItemDao.update(item)
    suspend fun deleteLineItem(item: EstimateLineItem) = deleteSynced(item.syncId, "estimate_line_items") { lineItemDao.delete(item) }

    fun observeManufacturers(): Flow<List<Manufacturer>> = manufacturerDao.observeAll()
    suspend fun getAllManufacturers(): List<Manufacturer> = manufacturerDao.getAll()
    suspend fun getEmployee(id: Long): Employee? = employeeDao.getById(id)
    suspend fun getManufacturer(id: Long): Manufacturer? = manufacturerDao.getById(id)
    suspend fun saveManufacturer(m: Manufacturer): Long =
        if (m.id == 0L) manufacturerDao.insert(m) else { manufacturerDao.update(m); m.id }
    suspend fun deleteManufacturer(m: Manufacturer) = deleteSynced(m.syncId, "manufacturers") { manufacturerDao.delete(m) }

    fun observePricingTiers(): Flow<List<PricingTier>> = pricingTierDao.observeAll()
    suspend fun savePricingTier(tier: PricingTier): Long =
        if (tier.id == 0L) pricingTierDao.insert(tier) else { pricingTierDao.update(tier); tier.id }
    suspend fun deletePricingTier(tier: PricingTier) = deleteSynced(tier.syncId, "pricing_tiers") { pricingTierDao.delete(tier) }

    fun observePhotos(jobId: Long): Flow<List<JobPhoto>> = jobPhotoDao.observeForJob(jobId)
    suspend fun getPhotos(jobId: Long): List<JobPhoto> = jobPhotoDao.getForJob(jobId)
    suspend fun updatePhoto(photo: JobPhoto) = jobPhotoDao.update(photo)
    suspend fun addPhoto(photo: JobPhoto): Long = jobPhotoDao.insert(photo)
    suspend fun deletePhoto(photo: JobPhoto) = jobPhotoDao.delete(photo)

    fun observeInventory(jobId: Long): Flow<List<InventoryChecklistItem>> = inventoryItemDao.observeForJob(jobId)
    suspend fun getInventory(jobId: Long): List<InventoryChecklistItem> = inventoryItemDao.getForJob(jobId)
    suspend fun addInventoryItems(items: List<InventoryChecklistItem>) = inventoryItemDao.insertAll(items)
    suspend fun addInventoryItem(item: InventoryChecklistItem): Long = inventoryItemDao.insert(item)
    suspend fun updateInventoryItem(item: InventoryChecklistItem) = inventoryItemDao.update(item)
    suspend fun deleteInventoryItem(item: InventoryChecklistItem) = inventoryItemDao.delete(item)
    suspend fun clearInventoryMaterials(jobId: Long) = inventoryItemDao.deleteByKind(jobId, InventoryKind.MATERIAL)

    /**
     * Everyone, including people who have left.
     *
     * Reports and timesheets use this: a former crew member's hours still
     * happened and still cost what they cost, and a report that quietly drops
     * them stops reconciling with the payroll it is meant to explain.
     */
    fun observeEmployees(): Flow<List<Employee>> = employeeDao.observeAll()
    suspend fun getAllEmployees(): List<Employee> = employeeDao.getAll()

    /** Just the people still on the crew, for anywhere you pick somebody. */
    fun observeActiveEmployees(): Flow<List<Employee>> =
        employeeDao.observeAll().map { list -> list.filter { it.isActive } }

    suspend fun getActiveEmployees(): List<Employee> =
        employeeDao.getAll().filter { it.isActive }

    /**
     * Takes somebody off the crew without taking their history with them.
     *
     * They disappear from crew lists and assignment pickers and can no longer
     * sign in, while every hour they worked and every job they costed stays
     * exactly where it was. Deleting them would destroy the payroll record,
     * which is the one thing you cannot afford to lose about a former employee
     * -- it is what answers a wage dispute or a tax question a year later.
     *
     * @param reassignTo who picks up their unfinished jobs. Finished jobs keep
     *   their name, because they did that work and the record should say so.
     *   Unfinished ones need a live person against them or they quietly become
     *   nobody's responsibility, which is how a job gets missed.
     */
    suspend fun deactivateEmployee(employee: Employee, reassignTo: Long?) {
        val openJobs = jobDao.getAll().filter {
            it.assignedEmployeeId == employee.id && it.status != JobStatus.COMPLETED
        }
        openJobs.forEach { job ->
            jobDao.update(
                job.copy(assignedEmployeeId = reassignTo, updatedAt = System.currentTimeMillis())
            )
        }
        employeeDao.update(
            employee.copy(isActive = false, deactivatedAt = System.currentTimeMillis())
        )
    }

    /** Puts somebody back on the crew. */
    suspend fun reactivateEmployee(employee: Employee) =
        employeeDao.update(employee.copy(isActive = true, deactivatedAt = null))

    /** Their unfinished jobs, so you can be told what is about to move. */
    suspend fun openJobsFor(employeeId: Long): List<Job> =
        jobDao.getAll().filter {
            it.assignedEmployeeId == employeeId && it.status != JobStatus.COMPLETED
        }
    suspend fun saveEmployee(e: Employee): Long =
        if (e.id == 0L) employeeDao.insert(e) else { employeeDao.update(e); e.id }
    /**
     * Removes a crew member everywhere, not just here.
     *
     * There used to be two of these: this one, which the screen called and which
     * deleted only the local row, and a "Synced" variant that wrote the
     * tombstone and which nothing called. So a crew member deleted on one phone
     * stayed on every other phone, and came back here on the next sync.
     */
    suspend fun deleteEmployee(e: Employee) =
        deleteSynced(e.syncId, "employees") { employeeDao.delete(e) }

    fun observeExpenses(jobId: Long): Flow<List<Expense>> = expenseDao.observeForJob(jobId)
    suspend fun getExpenses(jobId: Long): List<Expense> = expenseDao.getForJob(jobId)
    suspend fun getAllExpenses(): List<Expense> = expenseDao.getAll()
    suspend fun saveExpense(expense: Expense): Long = expenseDao.insert(expense)
    suspend fun updateExpense(expense: Expense) = expenseDao.update(expense)
    suspend fun deleteExpense(expense: Expense) = deleteSynced(expense.syncId, "expenses") { expenseDao.delete(expense) }

    /**
     * Seeds the starter catalog and pricing tiers if they're missing.
     *
     * This runs on every app start instead of only in the database's onCreate
     * callback. That callback referenced the singleton while it was still being
     * assigned, so a null-safe call could silently skip seeding entirely -- and
     * an empty catalog makes Suggest Quantities produce nothing with no error,
     * which is exactly how it looked "broken". Checking on each start also
     * repairs installs that were left with an empty catalog by that bug.
     */
    suspend fun ensureSeedDataPresent() {
        // Clean up first: an earlier build seeded from two places at once and
        // left a second copy of every catalog item and pricing tier.
        materialDao.deleteDuplicates()
        pricingTierDao.deleteDuplicates()

        if (materialDao.count() == 0) materialDao.insertAll(SeedData.materialItems())
        if (pricingTierDao.count() == 0) pricingTierDao.insertAll(SeedData.pricingTiers())
    }

    suspend fun catalogCount(): Int = materialDao.count()

    // Suspend readers used by cloud sync, which needs a one-shot snapshot
    // rather than a Flow it would have to collect and cancel.
    suspend fun getAllMaterialItems(): List<MaterialItem> = materialDao.getAll()
    suspend fun getAllPricingTiers(): List<PricingTier> = pricingTierDao.getAll()
    suspend fun getPunchList(jobId: Long): List<PunchListItem> = punchListDao.getForJob(jobId)
    suspend fun getChangeOrders(jobId: Long): List<ChangeOrder> = changeOrderDao.getForJob(jobId)

    /** See [getAllFenceRunsByJob]. */
    suspend fun getAllChangeOrdersByJob(): Map<Long, List<ChangeOrder>> =
        changeOrderDao.getAll().groupBy { it.jobId }
    suspend fun getJobSteps(jobId: Long): List<JobStep> = jobStepDao.getForJob(jobId)
    suspend fun getSiteMarkers(jobId: Long): List<SiteMarker> = siteMarkerDao.getForJob(jobId)

    fun observeTimeEntries(jobId: Long): Flow<List<TimeEntry>> = timeEntryDao.observeForJob(jobId)
    fun observeRunningTimers(): Flow<List<TimeEntry>> = timeEntryDao.observeRunning()
    suspend fun getTimeEntries(jobId: Long): List<TimeEntry> = timeEntryDao.getForJob(jobId)
    suspend fun getAllTimeEntries(): List<TimeEntry> = timeEntryDao.getAll()
    suspend fun deleteTimeEntry(entry: TimeEntry) = deleteSynced(entry.syncId, "time_entries") { timeEntryDao.delete(entry) }
    suspend fun updateTimeEntry(entry: TimeEntry) = timeEntryDao.update(entry)

    /**
     * Starts the clock for [employeeId] on this job. Returns the existing entry
     * untouched if a shift is already running -- double-tapping Clock In must
     * never create two overlapping spans and double-bill the labor.
     */
    suspend fun clockIn(jobId: Long, employeeId: Long?, hourlyRate: Double): TimeEntry {
        timeEntryDao.runningForJob(jobId)?.let { return it }
        val entry = TimeEntry(jobId = jobId, employeeId = employeeId, hourlyRate = hourlyRate)
        val id = timeEntryDao.insert(entry)
        return entry.copy(id = id)
    }

    /**
     * Ends the shift and puts it in the queue rather than straight onto the
     * books. Clocking out is a claim about hours worked; approving it is what
     * turns that into pay and into job cost.
     */
    suspend fun clockOut(jobId: Long) {
        val running = timeEntryDao.runningForJob(jobId) ?: return
        timeEntryDao.update(running.copy(endedAt = System.currentTimeMillis()))
    }

    /** Shifts waiting on a manager or the owner. */
    fun observeTimeAwaitingApproval(): Flow<List<TimeEntry>> = timeEntryDao.observeAwaitingApproval()

    /**
     * Signs off a shift so its hours count.
     *
     * Optionally with corrected times: the two things that actually go wrong
     * are a clock left running overnight and a lunch nobody clocked out for,
     * and both need the figure adjusted rather than the shift thrown away.
     */
    suspend fun approveTimeEntry(
        entry: TimeEntry,
        approvedBy: String,
        correctedStart: Long? = null,
        correctedEnd: Long? = null,
        note: String = ""
    ) {
        timeEntryDao.update(
            entry.copy(
                startedAt = correctedStart ?: entry.startedAt,
                endedAt = correctedEnd ?: entry.endedAt,
                approvedAt = System.currentTimeMillis(),
                approvedBy = approvedBy,
                rejectedAt = null,
                reviewNote = note
            )
        )
    }

    /**
     * Sends a shift back with a reason.
     *
     * Kept rather than deleted. The crew member needs to see why, and a
     * disputed shift that has been quietly removed is exactly the record you
     * want when someone says they were not paid for a day they worked.
     */
    suspend fun rejectTimeEntry(entry: TimeEntry, note: String) {
        timeEntryDao.update(
            entry.copy(rejectedAt = System.currentTimeMillis(), approvedAt = null, reviewNote = note)
        )
    }

    fun observeSiteMarkers(jobId: Long): Flow<List<SiteMarker>> = siteMarkerDao.observeForJob(jobId)
    suspend fun addSiteMarker(marker: SiteMarker): Long = siteMarkerDao.insert(marker)
    suspend fun updateSiteMarker(marker: SiteMarker) = siteMarkerDao.update(marker)
    suspend fun deleteSiteMarker(marker: SiteMarker) = deleteSynced(marker.syncId, "site_markers") { siteMarkerDao.delete(marker) }

    fun observeChangeOrders(jobId: Long): Flow<List<ChangeOrder>> = changeOrderDao.observeForJob(jobId)
    suspend fun saveChangeOrder(order: ChangeOrder): Long = changeOrderDao.insert(order)
    suspend fun updateChangeOrder(order: ChangeOrder) = changeOrderDao.update(order)
    suspend fun deleteChangeOrder(order: ChangeOrder) = deleteSynced(order.syncId, "change_orders") { changeOrderDao.delete(order) }

    fun observeJobSteps(jobId: Long): Flow<List<JobStep>> = jobStepDao.observeForJob(jobId)
    suspend fun updateJobStep(step: JobStep) = jobStepDao.update(step)

    /** Used by cloud pull to restore records made on another phone. */
    suspend fun insertJobStep(step: JobStep): Long = jobStepDao.insert(step)
    suspend fun insertTimeEntry(entry: TimeEntry): Long = timeEntryDao.insert(entry)

    // ---- Changes the crew made on site ----
    fun observeFieldChanges(jobId: Long): Flow<List<FieldChange>> = fieldChangeDao.observeForJob(jobId)
    fun observeUnacknowledgedChanges(): Flow<List<FieldChange>> = fieldChangeDao.observeUnacknowledged()
    suspend fun getFieldChanges(jobId: Long): List<FieldChange> = fieldChangeDao.getForJob(jobId)
    suspend fun recordFieldChange(change: FieldChange): Long = fieldChangeDao.insert(change)
    /**
     * Records the crew asking for a change rather than making one.
     *
     * Kept apart from a report of work already done. A report says the line
     * moved and the office needs to know; a request says the crew think it
     * should move and are standing there waiting. Filing the second as the
     * first means nobody realises a decision is owed and the crew wait all
     * afternoon.
     */
    suspend fun requestPlanChange(jobId: Long, summary: String, detail: String, by: String, role: String) {
        fieldChangeDao.insert(
            FieldChange(
                jobId = jobId,
                summary = summary,
                detail = detail,
                changedBy = by,
                changedByRole = role,
                isRequest = true
            )
        )
    }

    suspend fun decidePlanChange(change: FieldChange, approved: Boolean, by: String, note: String) {
        fieldChangeDao.update(
            change.copy(
                approvedAt = if (approved) System.currentTimeMillis() else null,
                rejectedAt = if (approved) null else System.currentTimeMillis(),
                decidedBy = by,
                decisionNote = note,
                acknowledgedAt = System.currentTimeMillis()
            )
        )
    }

    suspend fun acknowledgeFieldChanges(jobId: Long) =
        fieldChangeDao.acknowledgeAllForJob(jobId, System.currentTimeMillis())

    /**
     * Seeds the three checklists the first time a job's crew view is opened.
     *
     * Checked per kind rather than "has any steps at all", so a job seeded
     * before the closing walkthrough existed gains it on next open instead of
     * being stuck without one forever.
     */
    suspend fun ensureJobStepsSeeded(jobId: Long) {
        val existing = jobStepDao.getForJob(jobId)
        val present = existing.map { it.kind }.toSet()
        val toAdd = mutableListOf<JobStep>()

        if (JobStepKind.WALKTHROUGH !in present) {
            toAdd += DefaultJobSteps.WALKTHROUGH.mapIndexed { index, text ->
                JobStep(jobId = jobId, kind = JobStepKind.WALKTHROUGH, description = text, sortOrder = index)
            }
        }
        if (JobStepKind.INSTALL !in present) {
            toAdd += DefaultJobSteps.INSTALL.mapIndexed { index, text ->
                JobStep(jobId = jobId, kind = JobStepKind.INSTALL, description = text, sortOrder = index)
            }
        }
        if (JobStepKind.FINAL_WALKTHROUGH !in present) {
            toAdd += DefaultJobSteps.FINAL.mapIndexed { index, text ->
                JobStep(jobId = jobId, kind = JobStepKind.FINAL_WALKTHROUGH, description = text, sortOrder = index)
            }
        }
        if (toAdd.isNotEmpty()) jobStepDao.insertAll(toAdd)
    }

    fun observePunchList(jobId: Long): Flow<List<PunchListItem>> = punchListDao.observeForJob(jobId)
    suspend fun addPunchListItem(item: PunchListItem): Long = punchListDao.insert(item)
    suspend fun updatePunchListItem(item: PunchListItem) = punchListDao.update(item)
    suspend fun deletePunchListItem(item: PunchListItem) = deleteSynced(item.syncId, "punch_list_items") { punchListDao.delete(item) }
}

