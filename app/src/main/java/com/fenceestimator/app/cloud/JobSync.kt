package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.HoaApprovalStatus
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.PaymentStatus
import com.fenceestimator.app.data.PermitStatus
import com.fenceestimator.app.data.Repository
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant

@Serializable
data class CloudJob(
    @SerialName("sync_id") val syncId: String,
    @SerialName("company_id") val companyId: String,
    @SerialName("customer_name") val customerName: String = "",
    val address: String = "",
    val phone: String = "",
    val email: String = "",
    val notes: String = "",
    val status: String = "DRAFT",
    @SerialName("referral_source") val referralSource: String = "",
    @SerialName("scheduled_date") val scheduledDate: String? = null,
    @SerialName("estimated_duration_hours") val estimatedDurationHours: Double = 4.0,
    @SerialName("tax_rate_percent") val taxRatePercent: Double = 0.0,
    @SerialName("markup_percent") val markupPercent: Double = 0.0,
    @SerialName("discount_percent") val discountPercent: Double = 0.0,
    @SerialName("labor_rate_per_ft") val laborRatePerFt: Double = 0.0,
    @SerialName("labor_flat_fee") val laborFlatFee: Double = 0.0,
    @SerialName("minimum_job_charge") val minimumJobCharge: Double = 0.0,
    @SerialName("blocked_reason") val blockedReason: String = "",
    @SerialName("customer_must_clear") val customerMustClear: String = "",
    @SerialName("waste_percent") val wastePercent: Double = 0.0,
    @SerialName("teardown_enabled") val teardownEnabled: Boolean = false,
    @SerialName("teardown_flat_fee") val teardownFlatFee: Double = 0.0,
    @SerialName("teardown_rate_per_ft") val teardownRatePerFt: Double = 0.0,
    @SerialName("deposit_amount") val depositAmount: Double = 0.0,
    @SerialName("amount_paid") val amountPaid: Double = 0.0,
    @SerialName("refunded_amount") val refundedAmount: Double = 0.0,
    @SerialName("refunded_at") val refundedAt: String? = null,
    @SerialName("refund_reason") val refundReason: String = "",
    @SerialName("payments_from_processor") val paymentsFromProcessor: Boolean = false,
    @SerialName("signed_contract_total") val signedContractTotal: Double = 0.0,
    @SerialName("signed_linear_feet") val signedLinearFeet: Float = 0f,
    @SerialName("payment_status") val paymentStatus: String = "UNPAID",
    @SerialName("is_invoiced") val isInvoiced: Boolean = false,
    @SerialName("hoa_name") val hoaName: String = "",
    @SerialName("hoa_email") val hoaEmail: String = "",
    @SerialName("hoa_approval_status") val hoaApprovalStatus: String = "NOT_REQUIRED",
    @SerialName("permit_number") val permitNumber: String = "",
    @SerialName("permit_status") val permitStatus: String = "NOT_REQUIRED",
    @SerialName("updated_at") val updatedAt: String? = null,
    /** Set when this record was deleted. The row stays so every device learns of it. */
    @SerialName("deleted_at") val deletedAt: String? = null
) {
    /**
     * Falls back to 0 so a genuinely absent value never beats real local work.
     *
     * It must be a real parse, though. This used to be [Instant.parse], which
     * rejects the numeric offset Postgres returns, so every cloud row read as
     * epoch 0 -- older than everything local -- and nothing was ever pulled
     * down. See [CloudTime].
     */
    fun updatedAtMillis(): Long = CloudTime.parseMillis(updatedAt) ?: 0L
}

/** A change that arrived from someone else's phone and is worth telling this user about. */
data class IncomingChange(val jobId: Long, val customerName: String, val kind: ChangeKind)

enum class ChangeKind { NEW_JOB, ASSIGNED_TO_ME, MARKED_COMPLETE, UPDATED }

data class SyncResult(
    val uploaded: Int,
    val downloaded: Int,
    val incoming: List<IncomingChange> = emptyList()
) {
    val changed: Boolean get() = uploaded > 0 || downloaded > 0
}

/**
 * Two-way job sync between local Room and Supabase.
 *
 * Rows are matched on the device-generated [Job.syncId], never on Room's
 * per-phone auto-increment id -- two phones would otherwise both claim id 1
 * and clobber each other.
 *
 * Conflicts resolve last-edit-wins on the update timestamp.
 *
 * A row missing from the cloud still means "not synced yet", never "delete the
 * other copy" -- a phone that has been offline must not wipe the team's work
 * when it reconnects. Deletion is expressed as a tombstone instead: the row
 * stays with deleted_at set, so every device can tell "not uploaded yet" apart
 * from "deleted on purpose". Reading those two as the same thing is what made
 * deleted jobs come back from any device that had not synced.
 */
object JobSync {

    /**
     * Which side's payment figure to keep.
     *
     * Deliberately not last-edit-wins. A job open on screen is always "newer",
     * so plain last-edit-wins let the phone push a stale copy over a payment
     * the webhook had just recorded, and the money vanished. A cleared payment
     * is a fact; an unsaved edit is not. The larger figure survives.
     *
     * The consequence worth naming: correcting a payment DOWNWARD has to be
     * done deliberately, and the app treats that as a refund rather than an
     * edit. Silently losing money to a sync race is the worse failure.
     */
    fun mergedAmountPaid(localPaid: Double, cloudPaid: Double): Double = maxOf(localPaid, cloudPaid)

    suspend fun sync(repository: Repository, companyId: String): Result<SyncResult> = withContext(Dispatchers.IO) {
        runCatching {
            // Deletions first, always. If a pull ran before them, the rows we
            // just deleted locally would still be in the cloud and would come
            // straight back down.
            repository.pendingDeletions().forEach { deletion ->
                // Stamped, not removed.
                //
                // A hard delete is invisible to every other device: they read
                // "on my phone but not in the cloud" as "not uploaded yet" and
                // upload it again, so the record came straight back and the
                // deleting device pulled it down as brand new. A tombstone
                // makes the deletion itself a thing that syncs, and makes it
                // recoverable from the trash.
                val removed = runCatching {
                    SupabaseModule.client.postgrest.from(deletion.tableName).update(
                        buildJsonObject {
                            put("deleted_at", Instant.now().toString())
                            put("deleted_by", deletion.deletedBy)
                        }
                    ) {
                        filter {
                            eq("company_id", companyId)
                            eq("sync_id", deletion.syncId)
                        }
                    }
                }
                // Only clear the local marker once the cloud actually accepted
                // it, so an offline delete retries instead of being forgotten.
                if (removed.isSuccess) repository.clearPendingDeletion(deletion.syncId)
            }

            val localJobs = repository.getAllJobs()
            val cloudJobs = SupabaseModule.client.postgrest.from("jobs")
                .select { filter { eq("company_id", companyId) } }
                .decodeList<CloudJob>()

            val cloudBySyncId = cloudJobs.associateBy { it.syncId }
            var uploaded = 0
            var downloaded = 0

            for (job in localJobs) {
                val cloudJob = cloudBySyncId[job.syncId]

                // Deleted elsewhere. This is the resurrection the whole
                // tombstone exists to stop: without it this branch fell through
                // to "not in the cloud, so upload it", and a device that had
                // simply not synced yet put back everything another device had
                // deleted. Nothing is pushed for a deleted row -- it is removed
                // here instead, and stays recoverable from the cloud trash.
                if (cloudJob?.deletedAt != null) {
                    repository.deleteJobLocallyOnly(job)
                    downloaded++
                    continue
                }

                if (cloudJob == null) {
                    SupabaseModule.client.postgrest.from("jobs").insert(job.toCloud(companyId))
                    repository.updateJobSyncStamp(job.id, System.currentTimeMillis())
                    uploaded++
                } else if (job.updatedAt > cloudJob.updatedAtMillis()) {
                    // Money that cleared is a fact, not an opinion.
                    //
                    // Last-edit-wins on the whole row meant a job open on screen
                    // was always "newer", so the app pushed its stale copy over
                    // a payment the webhook had just recorded -- and the money
                    // disappeared. Payment fields are never pushed downward:
                    // the higher figure survives whichever side is newer.
                    val payload = job.toCloud(companyId).let { local ->
                        if (cloudJob.amountPaid > local.amountPaid) {
                            local.copy(
                                amountPaid = cloudJob.amountPaid,
                                paymentStatus = cloudJob.paymentStatus
                            )
                        } else local
                    }
                    SupabaseModule.client.postgrest.from("jobs").update(payload) {
                        filter {
                            eq("company_id", companyId)
                            eq("sync_id", job.syncId)
                        }
                    }
                    // Keep the phone in step with what we just agreed the cloud
                    // holds, or the next pass would try to undo it again.
                    if (payload.amountPaid > job.amountPaid) {
                        repository.updateJobFromCloud(
                            job.copy(
                                amountPaid = payload.amountPaid,
                                paymentStatus = runCatching {
                                    PaymentStatus.valueOf(payload.paymentStatus)
                                }.getOrDefault(job.paymentStatus)
                            )
                        )
                    }
                    repository.updateJobSyncStamp(job.id, System.currentTimeMillis())
                    uploaded++
                }
            }

            val incoming = mutableListOf<IncomingChange>()

            // Re-read before pulling. The push loop above writes to these same
            // rows -- it merges cleared payments back down and stamps sync
            // times -- so the snapshot taken at the top is already out of date
            // by the time we get here. Pulling against the stale copy re-applied
            // work that had just been done and could hand back an older row.
            val freshBySyncId = repository.getAllJobs().associateBy { it.syncId }

            for (cloudJob in cloudJobs) {
                val local = freshBySyncId[cloudJob.syncId]

                // Never recreate something that was deleted. This is the other
                // half of the loop: the pull used to treat a tombstoned row as
                // simply "a job this phone is missing".
                if (cloudJob.deletedAt != null) {
                    local?.let { repository.deleteJobLocallyOnly(it); downloaded++ }
                    continue
                }

                if (local == null) {
                    val newId = repository.createJob(cloudJob.toLocalJob())
                    downloaded++
                    incoming += IncomingChange(newId, cloudJob.customerName, ChangeKind.NEW_JOB)
                } else if (cloudJob.amountPaid > local.amountPaid + 0.005) {
                    // A payment cleared while this phone was editing the job.
                    // Take the money and nothing else -- overwriting the whole
                    // row here would throw away whatever they were typing.
                    repository.updateJobFromCloud(
                        local.copy(
                            amountPaid = cloudJob.amountPaid,
                            paymentStatus = runCatching {
                                PaymentStatus.valueOf(cloudJob.paymentStatus)
                            }.getOrDefault(local.paymentStatus)
                        )
                    )
                    downloaded++
                    incoming += IncomingChange(local.id, cloudJob.customerName, ChangeKind.NEW_JOB)
                } else if (cloudJob.updatedAtMillis() > local.updatedAt) {
                    val wasComplete = local.status == JobStatus.ACCEPTED
                    val nowComplete = cloudJob.status == JobStatus.ACCEPTED.name
                    // Merged onto the local row, never substituted for it.
                    //
                    // [CloudJob] carries 33 of the Job's 53 fields. Building a
                    // fresh Job from it and keeping only the id meant the other
                    // twenty silently reverted to their defaults -- the survey
                    // image, the calibration the whole takeoff depends on, the
                    // customer's signature, the payment link. This branch never
                    // ran while cloud timestamps were misparsed as epoch 0, so
                    // the damage was latent rather than absent; fixing the
                    // parsing without fixing this would have armed it.
                    repository.updateJobFromCloud(cloudJob.mergeOnto(local))
                    downloaded++
                    incoming += IncomingChange(
                        jobId = local.id,
                        customerName = cloudJob.customerName,
                        kind = if (!wasComplete && nowComplete) ChangeKind.MARKED_COMPLETE else ChangeKind.UPDATED
                    )
                }
            }

            SyncResult(uploaded, downloaded, incoming)
        }
    }
}

private fun Job.toCloud(companyId: String) = CloudJob(
    syncId = syncId,
    companyId = companyId,
    customerName = customerName,
    address = address,
    phone = phone,
    email = email,
    notes = notes,
    status = status.name,
    referralSource = referralSource,
    scheduledDate = scheduledDate?.let { CloudTime.format(it) },
    estimatedDurationHours = estimatedDurationHours,
    taxRatePercent = taxRatePercent,
    markupPercent = markupPercent,
    discountPercent = discountPercent,
    laborRatePerFt = laborRatePerFt,
    laborFlatFee = laborFlatFee,
    minimumJobCharge = minimumJobCharge,
    wastePercent = wastePercent,
    blockedReason = blockedReason,
    customerMustClear = customerMustClear,
    teardownEnabled = teardownEnabled,
    teardownFlatFee = teardownFlatFee,
    teardownRatePerFt = teardownRatePerFt,
    depositAmount = depositAmount,
    amountPaid = amountPaid,
    refundedAmount = refundedAmount,
    refundedAt = refundedAt?.let { CloudTime.format(it) },
    refundReason = refundReason,
    paymentsFromProcessor = paymentsFromProcessor,
    signedContractTotal = signedContractTotal,
    signedLinearFeet = signedLinearFeet,
    paymentStatus = paymentStatus.name,
    isInvoiced = isInvoiced,
    hoaName = hoaName,
    hoaEmail = hoaEmail,
    hoaApprovalStatus = hoaApprovalStatus.name,
    permitNumber = permitNumber,
    permitStatus = permitStatus.name
)

/**
 * Applies the cloud's copy of the shared fields onto the row this phone already
 * has, leaving everything the cloud does not carry exactly as it was.
 *
 * The distinction that matters: a field absent from [CloudJob] is not "empty in
 * the cloud", it is "not synced at all". Treating the two the same is how a
 * pull erases a signature or a calibration that was never in danger.
 *
 * Written as an explicit field list rather than `toLocalJob().copy(...)` so
 * that adding a column to [CloudJob] without adding it here is a compile error
 * in the mapper below, not a silent reset here.
 */
internal fun CloudJob.mergeOnto(local: Job): Job = local.copy(
    customerName = customerName,
    address = address,
    phone = phone,
    email = email,
    notes = notes,
    status = runCatching { JobStatus.valueOf(status) }.getOrDefault(local.status),
    referralSource = referralSource,
    scheduledDate = CloudTime.parseMillis(scheduledDate),
    estimatedDurationHours = estimatedDurationHours,
    taxRatePercent = taxRatePercent,
    markupPercent = markupPercent,
    discountPercent = discountPercent,
    laborRatePerFt = laborRatePerFt,
    laborFlatFee = laborFlatFee,
    minimumJobCharge = minimumJobCharge,
    wastePercent = wastePercent,
    blockedReason = blockedReason,
    customerMustClear = customerMustClear,
    teardownEnabled = teardownEnabled,
    teardownFlatFee = teardownFlatFee,
    teardownRatePerFt = teardownRatePerFt,
    depositAmount = depositAmount,
    // Money that cleared is still never allowed to go backwards, even on a
    // branch where the cloud row is unambiguously newer.
    amountPaid = JobSync.mergedAmountPaid(local.amountPaid, amountPaid),
    // A refund is a total that only grows, for the same reason a payment is:
    // whichever side saw it first, it is a fact and must not be undone.
    refundedAmount = JobSync.mergedAmountPaid(local.refundedAmount, refundedAmount),
    refundedAt = CloudTime.parseMillis(refundedAt) ?: local.refundedAt,
    refundReason = refundReason.ifBlank { local.refundReason },
    // Latches on. Once a processor has reported money, hand-editing the figure
    // stays shut off even if an older row says otherwise.
    paymentsFromProcessor = paymentsFromProcessor || local.paymentsFromProcessor,
    signedContractTotal = signedContractTotal,
    signedLinearFeet = signedLinearFeet,
    paymentStatus = runCatching { PaymentStatus.valueOf(paymentStatus) }.getOrDefault(local.paymentStatus),
    isInvoiced = isInvoiced,
    hoaName = hoaName,
    hoaEmail = hoaEmail,
    hoaApprovalStatus = runCatching { HoaApprovalStatus.valueOf(hoaApprovalStatus) }
        .getOrDefault(local.hoaApprovalStatus),
    permitNumber = permitNumber,
    permitStatus = runCatching { PermitStatus.valueOf(permitStatus) }.getOrDefault(local.permitStatus),
    updatedAt = updatedAtMillis()
)

private fun CloudJob.toLocalJob() = Job(
    syncId = syncId,
    customerName = customerName,
    address = address,
    phone = phone,
    email = email,
    notes = notes,
    status = runCatching { JobStatus.valueOf(status) }.getOrDefault(JobStatus.DRAFT),
    referralSource = referralSource,
    scheduledDate = CloudTime.parseMillis(scheduledDate),
    estimatedDurationHours = estimatedDurationHours,
    taxRatePercent = taxRatePercent,
    markupPercent = markupPercent,
    discountPercent = discountPercent,
    laborRatePerFt = laborRatePerFt,
    laborFlatFee = laborFlatFee,
    minimumJobCharge = minimumJobCharge,
    wastePercent = wastePercent,
    blockedReason = blockedReason,
    customerMustClear = customerMustClear,
    teardownEnabled = teardownEnabled,
    teardownFlatFee = teardownFlatFee,
    teardownRatePerFt = teardownRatePerFt,
    depositAmount = depositAmount,
    amountPaid = amountPaid,
    refundedAmount = refundedAmount,
    refundedAt = CloudTime.parseMillis(refundedAt),
    refundReason = refundReason,
    paymentsFromProcessor = paymentsFromProcessor,
    signedContractTotal = signedContractTotal,
    signedLinearFeet = signedLinearFeet,
    paymentStatus = runCatching { PaymentStatus.valueOf(paymentStatus) }.getOrDefault(PaymentStatus.UNPAID),
    isInvoiced = isInvoiced,
    hoaName = hoaName,
    hoaEmail = hoaEmail,
    hoaApprovalStatus = runCatching { HoaApprovalStatus.valueOf(hoaApprovalStatus) }.getOrDefault(HoaApprovalStatus.NOT_REQUIRED),
    permitNumber = permitNumber,
    permitStatus = runCatching { PermitStatus.valueOf(permitStatus) }.getOrDefault(PermitStatus.NOT_REQUIRED),
    updatedAt = updatedAtMillis()
)
