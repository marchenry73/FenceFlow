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
    @SerialName("waste_percent") val wastePercent: Double = 0.0,
    @SerialName("teardown_enabled") val teardownEnabled: Boolean = false,
    @SerialName("teardown_flat_fee") val teardownFlatFee: Double = 0.0,
    @SerialName("teardown_rate_per_ft") val teardownRatePerFt: Double = 0.0,
    @SerialName("deposit_amount") val depositAmount: Double = 0.0,
    @SerialName("amount_paid") val amountPaid: Double = 0.0,
    @SerialName("payment_status") val paymentStatus: String = "UNPAID",
    @SerialName("is_invoiced") val isInvoiced: Boolean = false,
    @SerialName("hoa_name") val hoaName: String = "",
    @SerialName("hoa_email") val hoaEmail: String = "",
    @SerialName("hoa_approval_status") val hoaApprovalStatus: String = "NOT_REQUIRED",
    @SerialName("permit_number") val permitNumber: String = "",
    @SerialName("permit_status") val permitStatus: String = "NOT_REQUIRED",
    @SerialName("updated_at") val updatedAt: String? = null
) {
    /** Server timestamps are ISO-8601; fall back to 0 so a bad value never beats real local work. */
    fun updatedAtMillis(): Long =
        updatedAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } ?: 0L
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
 * Conflicts resolve last-edit-wins on the update timestamp. Nothing is ever
 * deleted by sync: a row missing on one side means "not synced yet", never
 * "delete the other copy", so a phone that has been offline can't wipe the
 * team's work when it reconnects.
 */
object JobSync {

    suspend fun sync(repository: Repository, companyId: String): Result<SyncResult> = withContext(Dispatchers.IO) {
        runCatching {
            // Deletions first, always. If a pull ran before them, the rows we
            // just deleted locally would still be in the cloud and would come
            // straight back down.
            repository.pendingDeletions().forEach { deletion ->
                val removed = runCatching {
                    SupabaseModule.client.postgrest.from(deletion.tableName).delete {
                        filter {
                            eq("company_id", companyId)
                            eq("sync_id", deletion.syncId)
                        }
                    }
                }
                // Only clear the tombstone once the cloud actually accepted it,
                // so an offline delete retries instead of being forgotten.
                if (removed.isSuccess) repository.clearPendingDeletion(deletion.syncId)
            }

            val localJobs = repository.getAllJobs()
            val cloudJobs = SupabaseModule.client.postgrest.from("jobs")
                .select { filter { eq("company_id", companyId) } }
                .decodeList<CloudJob>()

            val cloudBySyncId = cloudJobs.associateBy { it.syncId }
            val localBySyncId = localJobs.associateBy { it.syncId }
            var uploaded = 0
            var downloaded = 0

            for (job in localJobs) {
                val cloudJob = cloudBySyncId[job.syncId]
                if (cloudJob == null) {
                    SupabaseModule.client.postgrest.from("jobs").insert(job.toCloud(companyId))
                    repository.updateJobSyncStamp(job.id, System.currentTimeMillis())
                    uploaded++
                } else if (job.updatedAt > cloudJob.updatedAtMillis()) {
                    SupabaseModule.client.postgrest.from("jobs").update(job.toCloud(companyId)) {
                        filter {
                            eq("company_id", companyId)
                            eq("sync_id", job.syncId)
                        }
                    }
                    repository.updateJobSyncStamp(job.id, System.currentTimeMillis())
                    uploaded++
                }
            }

            val incoming = mutableListOf<IncomingChange>()

            for (cloudJob in cloudJobs) {
                val local = localBySyncId[cloudJob.syncId]
                if (local == null) {
                    val newId = repository.createJob(cloudJob.toLocalJob())
                    downloaded++
                    incoming += IncomingChange(newId, cloudJob.customerName, ChangeKind.NEW_JOB)
                } else if (cloudJob.updatedAtMillis() > local.updatedAt) {
                    val wasComplete = local.status == JobStatus.ACCEPTED
                    val nowComplete = cloudJob.status == JobStatus.ACCEPTED.name
                    repository.updateJobFromCloud(cloudJob.toLocalJob().copy(id = local.id))
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
    scheduledDate = scheduledDate?.let { Instant.ofEpochMilli(it).toString() },
    estimatedDurationHours = estimatedDurationHours,
    taxRatePercent = taxRatePercent,
    markupPercent = markupPercent,
    discountPercent = discountPercent,
    laborRatePerFt = laborRatePerFt,
    laborFlatFee = laborFlatFee,
    minimumJobCharge = minimumJobCharge,
    wastePercent = wastePercent,
    teardownEnabled = teardownEnabled,
    teardownFlatFee = teardownFlatFee,
    teardownRatePerFt = teardownRatePerFt,
    depositAmount = depositAmount,
    amountPaid = amountPaid,
    paymentStatus = paymentStatus.name,
    isInvoiced = isInvoiced,
    hoaName = hoaName,
    hoaEmail = hoaEmail,
    hoaApprovalStatus = hoaApprovalStatus.name,
    permitNumber = permitNumber,
    permitStatus = permitStatus.name
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
    scheduledDate = scheduledDate?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() },
    estimatedDurationHours = estimatedDurationHours,
    taxRatePercent = taxRatePercent,
    markupPercent = markupPercent,
    discountPercent = discountPercent,
    laborRatePerFt = laborRatePerFt,
    laborFlatFee = laborFlatFee,
    minimumJobCharge = minimumJobCharge,
    wastePercent = wastePercent,
    teardownEnabled = teardownEnabled,
    teardownFlatFee = teardownFlatFee,
    teardownRatePerFt = teardownRatePerFt,
    depositAmount = depositAmount,
    amountPaid = amountPaid,
    paymentStatus = runCatching { PaymentStatus.valueOf(paymentStatus) }.getOrDefault(PaymentStatus.UNPAID),
    isInvoiced = isInvoiced,
    hoaName = hoaName,
    hoaEmail = hoaEmail,
    hoaApprovalStatus = runCatching { HoaApprovalStatus.valueOf(hoaApprovalStatus) }.getOrDefault(HoaApprovalStatus.NOT_REQUIRED),
    permitNumber = permitNumber,
    permitStatus = runCatching { PermitStatus.valueOf(permitStatus) }.getOrDefault(PermitStatus.NOT_REQUIRED),
    updatedAt = updatedAtMillis()
)
