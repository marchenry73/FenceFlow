package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.HoaApprovalStatus
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.PaymentStatus
import com.fenceestimator.app.data.PermitStatus
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.estimate.EstimateEngine
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
    // Nullable so "nobody ever set this" is a different value from "this is
    // genuinely zero". The app always sends a real number, so null can only
    // mean no version of the app has ever written the column.
    @SerialName("minimum_job_charge") val minimumJobCharge: Double? = null,
    @SerialName("blocked_reason") val blockedReason: String = "",
    @SerialName("overrun_reason") val overrunReason: String = "",
    @SerialName("grid_extent_ft") val gridExtentFt: Float = 400f,
    /**
     * Where the property is, geocoded once by whichever side (office or
     * phone) opens the satellite tool first. Nullable so "never geocoded" is
     * a different value from a genuine 0,0 -- there is dry land at 0,0.
     */
    @SerialName("site_lat") val siteLat: Double? = null,
    @SerialName("site_lon") val siteLon: Double? = null,
    @SerialName("locate_ticket_no") val locateTicketNo: String = "",
    @SerialName("locate_called_at") val locateCalledAt: String? = null,
    @SerialName("locate_dig_after") val locateDigAfter: String? = null,
    @SerialName("locate_expires_at") val locateExpiresAt: String? = null,
    @SerialName("locate_notes") val locateNotes: String = "",
    @SerialName("customer_must_clear") val customerMustClear: String = "",
    @SerialName("waste_percent") val wastePercent: Double = 0.0,
    @SerialName("teardown_enabled") val teardownEnabled: Boolean = false,
    @SerialName("teardown_flat_fee") val teardownFlatFee: Double = 0.0,
    @SerialName("teardown_rate_per_ft") val teardownRatePerFt: Double = 0.0,
    @SerialName("teardown_feet") val teardownFeet: Double = 0.0,
    @SerialName("deposit_amount") val depositAmount: Double = 0.0,
    @SerialName("amount_paid") val amountPaid: Double = 0.0,
    /**
     * What the customer is actually billed, from the estimating engine.
     *
     * The website used to add up materials and change orders and call that the
     * contract price, which left out labour, markup, tax, gates, teardown and
     * the minimum charge -- so a paid-off job read as massively overpaid. The
     * engine lives in the app, so the app sends its answer rather than having
     * a second one written in SQL to drift away from this one.
     */
    @SerialName("contract_total") val contractTotal: Double? = null,
    /**
     * Who the job is assigned to, by the employee's SYNC id. The website used
     * to write the app's local row id here, which means nothing on any other
     * device -- assignments made on the dashboard never reached a phone.
     */
    @SerialName("assigned_employee_sync_id") val assignedEmployeeSyncId: String? = null,
    @SerialName("preferred_manufacturer_sync_id") val preferredManufacturerSyncId: String? = null,
    // The fields below never travelled at all. Losing them across devices was
    // not cosmetic: gate_rate_per_ft missing is why a gate-only job priced at
    // zero on a second phone, signed_at missing is why the invoice unlocked on
    // one phone and stayed locked on another, and the calibration fields are
    // what the whole drawn takeoff measures by.
    @SerialName("gate_rate_per_ft") val gateRatePerFt: Double? = null,
    @SerialName("trash_haul_fee") val trashHaulFee: Double? = null,
    @SerialName("pricing_tier_name") val pricingTierName: String = "",
    @SerialName("tip_amount") val tipAmount: Double? = null,
    @SerialName("grid_feet_per_square") val gridFeetPerSquare: Float = 0f,
    @SerialName("calibration_pixels_per_foot") val calibrationPixelsPerFoot: Float? = null,
    @SerialName("calibration_known_feet") val calibrationKnownFeet: Float? = null,
    @SerialName("supplier_quote_reference") val supplierQuoteReference: String = "",
    @SerialName("duration_manually_set") val durationManuallySet: Boolean = false,
    @SerialName("payment_link_url") val paymentLinkUrl: String = "",
    @SerialName("payment_link_amount") val paymentLinkAmount: Double = 0.0,
    @SerialName("survey_storage_path") val surveyStoragePath: String? = null,
    @SerialName("signature_storage_path") val signatureStoragePath: String? = null,
    @SerialName("final_sign_off_storage_path") val finalSignOffStoragePath: String? = null,
    @SerialName("signed_at") val signedAt: String? = null,
    @SerialName("quote_approved_at") val quoteApprovedAt: String? = null,
    @SerialName("quote_approved_name") val quoteApprovedName: String = "",
    @SerialName("final_sign_off_at") val finalSignOffAt: String? = null,
    @SerialName("blocked_at") val blockedAt: String? = null,
    @SerialName("customer_notified_at") val customerNotifiedAt: String? = null,
    @SerialName("material_prices_confirmed_at") val materialPricesConfirmedAt: String? = null,
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
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    /** Set when this record was deleted. The row stays so every device learns of it. */
    @SerialName("deleted_at") val deletedAt: String? = null,

    // ---- Office pricing parity (see JobSync's contract_total push block) --
    /** Which template the job's build came from, if the office wizard started it. Provenance only. */
    @SerialName("build_template_sync_id") val buildTemplateSyncId: String? = null,
    /** Which engine wrote [contractTotal] last: '' | 'APP' | 'OFFICE'. */
    @SerialName("priced_by") val pricedBy: String = "",
    @SerialName("priced_at") val pricedAt: String? = null,
    @SerialName("pricing_engine_version") val pricingEngineVersion: String = "",
    /**
     * Set once the office has sent this quote to the customer. From then on
     * the number the customer saw is the number that stands -- the phone
     * only ever records a pricing_drift row if it disagrees, never
     * overwrites. Never sent by the phone: nothing on the phone marks a
     * quote sent, this column only ever arrives FROM the cloud.
     */
    @SerialName("quote_sent_at") val quoteSentAt: String? = null
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

enum class ChangeKind {
    NEW_JOB,
    ASSIGNED_TO_ME,
    MARKED_COMPLETE,
    UPDATED,

    /**
     * Money landed on a job this phone already had.
     *
     * Its own kind because it was being reported as NEW_JOB, so every payment
     * that synced announced "New job on your list" -- for a job that was
     * already there, and alongside the webhook push that had just correctly
     * said a payment arrived. Two notifications, one of them wrong.
     */
    PAYMENT_RECEIVED
}

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

    /**
     * Which payment figure to keep now that a ledger exists.
     *
     * The cloud value wins outright. [mergedAmountPaid] kept the larger of the
     * two, which protected a cleared payment from being erased by a race -- but
     * it also meant a figure could never come DOWN. A device holding a stale
     * $10,000 against a cloud that said $4,938.93 kept the $10,000 forever, and
     * pushed it, so two phones stayed apart with no way to converge.
     *
     * That guard is no longer what protects the money. Payments are ledger rows
     * now, the ledger is append-only and synced, and the job total is recomputed
     * from those rows -- so a payment cannot be lost by taking the cloud value,
     * because the row it came from is still there. Keeping the maximum would
     * only preserve a figure with no rows behind it.
     */
    fun ledgerBackedAmountPaid(cloudPaid: Double): Double = cloudPaid

    /**
     * Sends the ledger's answer for what a job has been paid, downward included.
     *
     * amountPaid is a cache of the payment rows, and [PaymentLedgerSync] has
     * just reconciled those rows in both directions and rebuilt every job's
     * total from them -- so at this moment the local figure is the truth.
     *
     * The ordinary job push deliberately refuses to lower amount_paid, because
     * a job sitting open on screen must never overwrite a payment the webhook
     * has just recorded. But that also meant a duplicate payment corrected on
     * this phone was restored from the cloud on the very next pull, and the two
     * sides then disagreed for ever: the figure could climb but never come back
     * down, however wrong it was. This is the one place allowed to send it down,
     * and only immediately after the ledger has been reconciled.
     *
     * Nothing is lost if a payment lands in the gap: it writes a payment row
     * too, which the next ledger pass pulls, and the total rises again.
     */
    suspend fun pushLedgerTotals(
        repository: Repository,
        companyId: String
    ): Result<Int> = withContext(Dispatchers.IO) {
        runCatching {
            val jobs = repository.getAllJobs()
            if (jobs.isEmpty()) return@runCatching 0
            val cloudBySyncId = SupabaseModule.client.postgrest.from("jobs")
                .select { filter { eq("company_id", companyId) } }
                .decodeList<CloudJob>()
                .associateBy { it.syncId }

            var corrected = 0
            jobs.forEach { job ->
                val row = cloudBySyncId[job.syncId] ?: return@forEach
                if (row.deletedAt != null) return@forEach
                val paidDiffers = kotlin.math.abs(row.amountPaid - job.amountPaid) > 0.005
                val refundDiffers = kotlin.math.abs(row.refundedAmount - job.refundedAmount) > 0.005
                if (!paidDiffers && !refundDiffers) return@forEach

                SupabaseModule.client.postgrest.from("jobs").update(
                    buildJsonObject {
                        put("amount_paid", job.amountPaid)
                        put("refunded_amount", job.refundedAmount)
                    }
                ) {
                    filter {
                        eq("company_id", companyId)
                        eq("sync_id", job.syncId)
                    }
                }
                corrected++
            }
            corrected
        }
    }

    /**
     * The only place allowed to write priced_by, priced_at and
     * pricing_engine_version -- see the long comment on [Job.toCloud] for
     * why an ordinary row push must never touch them. A small targeted
     * patch, the same shape as [pushLedgerTotals]'s amount_paid/
     * refunded_amount write above, rather than the whole [CloudJob] object:
     * nothing else on the row is at risk from a stale local copy this way.
     * Never bumps updated_at -- all four columns it writes are on the
     * server's quiet list.
     */
    private suspend fun pushContractTotal(companyId: String, jobSyncId: String, total: Double) {
        runCatching {
            SupabaseModule.client.postgrest.from("jobs").update(
                buildJsonObject {
                    put("contract_total", total)
                    put("priced_by", "APP")
                    put("priced_at", Instant.now().toString())
                    put("pricing_engine_version", EstimateEngine.PRICING_ENGINE_VERSION)
                }
            ) {
                filter {
                    eq("company_id", companyId)
                    eq("sync_id", jobSyncId)
                }
            }
        }
    }

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

            // Three reads for the whole sync rather than three per job. The
            // same shape JobsViewModel uses for the home screen, and for the
            // same reason: per-job fetches turn one sync into 3xN round trips.
            val employeeSyncById = repository.getAllEmployees().associateBy({ it.id }, { it.syncId })
            val employeeIdBySync = repository.getAllEmployees().associateBy({ it.syncId }, { it.id })
            val manufacturerSyncById = repository.getAllManufacturers().associateBy({ it.id }, { it.syncId })
            val manufacturerIdBySync = repository.getAllManufacturers().associateBy({ it.syncId }, { it.id })
            val itemsByJob = repository.getAllLineItemsByJob()
            val runsByJob = repository.getAllFenceRunsByJob()
            val ordersByJob = repository.getAllChangeOrdersByJob()

            /** The engine's answer for one job, computed fresh at push time. */
            fun totalFor(job: com.fenceestimator.app.data.Job): Double {
                val runs = runsByJob[job.id].orEmpty()
                return com.fenceestimator.app.estimate.EstimateEngine.computeTotals(
                    job,
                    itemsByJob[job.id].orEmpty(),
                    com.fenceestimator.app.estimate.EstimateEngine.linearFeet(job, runs),
                    ordersByJob[job.id].orEmpty(),
                    runs
                ).grandTotal
            }

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

                // A job nobody has touched still needs its total sent once.
                //
                // The push below only fires when this phone's copy is newer,
                // so contract_total would fill in for new and edited jobs and
                // stay blank on every existing one -- leaving the website
                // wrong on exactly the old jobs with money outstanding.
                //
                // Only the one column is written. Pushing the whole row to
                // backfill a single field would send this phone's untouched
                // copy over a cloud row that may be newer, and quietly undo an
                // edit made somewhere else.
                // Sent whenever it differs, not only when missing: change orders,
                // line-item and run edits and dashboard price edits all move the
                // price without touching the job row, and the website showed the
                // old figure until something else happened to save the job.
                // ...but only for a job this phone can actually price.
                //
                // A job with nothing on it to work from -- no line items, no
                // runs, no change orders -- computes to the bare minimum job
                // charge, which is not a price anybody quoted. An imported job
                // is exactly that shape: it carries a total from the old
                // system and none of the working behind it. Without this guard
                // a $12,400 imported job became $200 on the next background
                // sync, with nobody touching anything, and the office, the
                // ageing report and the homeowner's quote page all agreed on
                // the wrong number.
                val hasWorking = itemsByJob[job.id].orEmpty().isNotEmpty() ||
                    runsByJob[job.id].orEmpty().isNotEmpty() ||
                    ordersByJob[job.id].orEmpty().isNotEmpty()
                val freshTotal = totalFor(job)
                if (hasWorking && cloudJob != null && cloudJob.deletedAt == null &&
                    (cloudJob.contractTotal == null || kotlin.math.abs(cloudJob.contractTotal - freshTotal) > 0.005)
                ) {
                    // The office can price a job now too (price-job, the New
                    // Client wizard), so a phone recompute that disagrees
                    // with an OFFICE price is no longer automatically this
                    // phone's to win outright. See docs/OFFICE_SETUP_PLAN.md,
                    // open question 1, and the JobSync rules section.
                    val officePriced = cloudJob.pricedBy == "OFFICE"
                    val officeEngineIsNewer = officePriced &&
                        cloudJob.pricingEngineVersion.isNotBlank() &&
                        cloudJob.pricingEngineVersion > EstimateEngine.PRICING_ENGINE_VERSION
                    when {
                        // (a) The office priced this job on engine logic
                        // newer than the one this build carries. Overwriting
                        // would replace a price computed by rules this phone
                        // has not caught up to with one from rules that are
                        // already behind -- so the phone backs off and files
                        // a report instead of quietly winning an argument it
                        // cannot actually win. app_errors is its own table,
                        // so this never touches the job row at all.
                        officeEngineIsNewer -> runCatching {
                            SupabaseModule.client.postgrest.from("app_errors").insert(
                                CloudError(
                                    companyId = companyId,
                                    fatal = false,
                                    whereAt = "pricing_parity",
                                    message = "job ${job.syncId}: office total ${cloudJob.contractTotal} " +
                                        "(engine ${cloudJob.pricingEngineVersion}) vs phone total $freshTotal " +
                                        "(engine ${EstimateEngine.PRICING_ENGINE_VERSION})"
                                )
                            )
                        }
                        // (b) The office priced this job, on an engine this
                        // phone is caught up to or ahead of, and the two
                        // totals disagree. That disagreement is worth a
                        // permanent record even when the phone goes on to
                        // win it.
                        officePriced -> {
                            // recordPricingDrift already swallows its own
                            // failure -- a missed drift note must never
                            // block the rest of this sync.
                            recordPricingDrift(
                                CloudPricingDrift(
                                    companyId = companyId,
                                    jobSyncId = job.syncId,
                                    officeTotal = cloudJob.contractTotal,
                                    phoneTotal = freshTotal,
                                    officeEngine = cloudJob.pricingEngineVersion,
                                    phoneEngine = EstimateEngine.PRICING_ENGINE_VERSION,
                                    detail = buildDriftDetail(companyId, job.syncId, itemsByJob[job.id].orEmpty())
                                )
                            )
                            // Once a quote has been sent, the number the
                            // customer saw and agreed to is the number that
                            // stands -- the phone only ever records the
                            // disagreement from here on. Before that, the
                            // phone's fresher figure still wins, same as
                            // always.
                            if (cloudJob.quoteSentAt == null) {
                                pushContractTotal(companyId, job.syncId, freshTotal)
                            }
                        }
                        // (c) Nobody has priced this from the office, or the
                        // last price on it was the phone's own -- unchanged
                        // from before this feature existed.
                        else -> pushContractTotal(companyId, job.syncId, freshTotal)
                    }
                }

                if (cloudJob == null) {
                    SupabaseModule.client.postgrest.from("jobs").insert(job.toCloud(companyId, totalFor(job), job.assignedEmployeeId?.let { employeeSyncById[it] }, job.preferredManufacturerId?.let { manufacturerSyncById[it] }))
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
                    val payload = job.toCloud(companyId, totalFor(job), job.assignedEmployeeId?.let { employeeSyncById[it] }, job.preferredManufacturerId?.let { manufacturerSyncById[it] }).let { local ->
                        val withPayment = if (cloudJob.amountPaid > local.amountPaid) {
                            local.copy(
                                amountPaid = cloudJob.amountPaid,
                                paymentStatus = cloudJob.paymentStatus
                            )
                        } else local
                        // Pricing-parity bookkeeping belongs to the
                        // contract_total push block above and nowhere else.
                        // job.toCloud() leaves these four at CloudJob's bare
                        // defaults on purpose (see the comment there), so an
                        // ordinary edit here -- a phone number, a note --
                        // must have them filled back in with whatever the
                        // cloud currently holds, or this update would stamp
                        // blank pricing metadata straight over a real office
                        // price the moment it serializes the whole row.
                        withPayment.copy(
                            pricedBy = cloudJob.pricedBy,
                            pricedAt = cloudJob.pricedAt,
                            pricingEngineVersion = cloudJob.pricingEngineVersion,
                            quoteSentAt = cloudJob.quoteSentAt
                        )
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
                    val newId = repository.createJob(
                        cloudJob.toLocalJob().let { fresh ->
                            val withEmployee = cloudJob.assignedEmployeeSyncId
                                ?.let { es -> employeeIdBySync[es] }
                                ?.let { fresh.copy(assignedEmployeeId = it) } ?: fresh
                            cloudJob.preferredManufacturerSyncId
                                ?.let { ms -> manufacturerIdBySync[ms] }
                                ?.let { withEmployee.copy(preferredManufacturerId = it) } ?: withEmployee
                        }
                    )
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
                    incoming += IncomingChange(local.id, cloudJob.customerName, ChangeKind.PAYMENT_RECEIVED)
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
                    repository.updateJobFromCloud(
                        cloudJob.mergeOnto(local).let { merged ->
                            val withEmployee = cloudJob.assignedEmployeeSyncId
                                ?.let { es -> employeeIdBySync[es] }
                                ?.let { merged.copy(assignedEmployeeId = it) } ?: merged
                            cloudJob.preferredManufacturerSyncId
                                ?.let { ms -> manufacturerIdBySync[ms] }
                                ?.let { withEmployee.copy(preferredManufacturerId = it) } ?: withEmployee
                        }
                    )
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

private fun Job.toCloud(
    companyId: String,
    contractTotal: Double? = null,
    assignedEmployeeSyncId: String? = null,
    preferredManufacturerSyncId: String? = null
) = CloudJob(
    syncId = syncId,
    companyId = companyId,
    customerName = customerName,
    address = address,
    phone = phone,
    email = email,
    notes = notes,
    status = status.name,
    referralSource = referralSource,
    createdAt = CloudTime.format(createdAt),
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
    overrunReason = overrunReason,
    gridExtentFt = gridExtentFt,
    siteLat = siteLat,
    siteLon = siteLon,
    locateTicketNo = locateTicketNo,
    locateNotes = locateNotes,
    customerMustClear = customerMustClear,
    teardownEnabled = teardownEnabled,
    teardownFlatFee = teardownFlatFee,
    teardownRatePerFt = teardownRatePerFt,
    teardownFeet = teardownFeet,
    gateRatePerFt = gateRatePerFt,
    trashHaulFee = trashHaulFee,
    pricingTierName = pricingTierName,
    tipAmount = tipAmount,
    gridFeetPerSquare = gridFeetPerSquare,
    calibrationPixelsPerFoot = calibrationPixelsPerFoot,
    calibrationKnownFeet = calibrationKnownFeet,
    supplierQuoteReference = supplierQuoteReference,
    durationManuallySet = durationManuallySet,
    paymentLinkUrl = paymentLinkUrl,
    paymentLinkAmount = paymentLinkAmount,
    surveyStoragePath = surveyStoragePath,
    signatureStoragePath = signatureStoragePath,
    finalSignOffStoragePath = finalSignOffStoragePath,
    depositAmount = depositAmount,
    amountPaid = amountPaid,
    contractTotal = contractTotal,
    assignedEmployeeSyncId = assignedEmployeeSyncId,
    preferredManufacturerSyncId = preferredManufacturerSyncId,
    refundedAmount = refundedAmount,
    refundedAt = refundedAt?.let { CloudTime.format(it) },
    signedAt = signedAt?.let { CloudTime.format(it) },
    finalSignOffAt = finalSignOffAt?.let { CloudTime.format(it) },
    blockedAt = blockedAt?.let { CloudTime.format(it) },
    customerNotifiedAt = customerNotifiedAt?.let { CloudTime.format(it) },
    materialPricesConfirmedAt = materialPricesConfirmedAt?.let { CloudTime.format(it) },
    locateCalledAt = locateCalledAt?.let { CloudTime.format(it) },
    locateDigAfter = locateDigAfter?.let { CloudTime.format(it) },
    locateExpiresAt = locateExpiresAt?.let { CloudTime.format(it) },
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
    permitStatus = permitStatus.name,
    // buildTemplateSyncId is a real edit (LOUD server-side), so it travels
    // like every other field above: whichever side is newer wins.
    //
    // priced_by / priced_at / pricing_engine_version / quote_sent_at are
    // deliberately NOT wired in here -- they stay at CloudJob's defaults on
    // this object. Those four are quiet-clock bookkeeping the OFFICE writes;
    // this function backs every ordinary row push (a phone number, a note,
    // a new job), and if it sent this phone's cached copy of them, an
    // unrelated edit would stamp blank/APP-shaped values over a real office
    // price the moment `encodeDefaults = true` serialized this whole object.
    // The one place allowed to touch them is the contract_total push block
    // in JobSync.sync(), which either omits them (a brand new job, correctly
    // blank) or explicitly carries the cloud's own current values forward on
    // an ordinary update (see the `payload` build there).
    buildTemplateSyncId = buildTemplateSyncId
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
    createdAt = CloudTime.parseMillis(createdAt) ?: System.currentTimeMillis(),
    scheduledDate = CloudTime.parseMillis(scheduledDate),
    estimatedDurationHours = estimatedDurationHours,
    taxRatePercent = taxRatePercent,
    markupPercent = markupPercent,
    discountPercent = discountPercent,
    laborRatePerFt = laborRatePerFt,
    laborFlatFee = laborFlatFee,
    minimumJobCharge = minimumJobCharge ?: local.minimumJobCharge,
    wastePercent = wastePercent,
    blockedReason = blockedReason,
    overrunReason = overrunReason,
    gridExtentFt = gridExtentFt,
    // Whichever side geocoded it first wins the field, same as any other
    // shared column -- but never erase a known location with a null one,
    // since "not yet geocoded on that device" must not un-place a job that
    // has already been placed.
    siteLat = siteLat ?: local.siteLat,
    siteLon = siteLon ?: local.siteLon,
    locateTicketNo = locateTicketNo,
    locateNotes = locateNotes,
    customerMustClear = customerMustClear,
    teardownEnabled = teardownEnabled,
    teardownFlatFee = teardownFlatFee,
    teardownRatePerFt = teardownRatePerFt,
    teardownFeet = teardownFeet,
    gateRatePerFt = gateRatePerFt ?: local.gateRatePerFt,
    trashHaulFee = trashHaulFee ?: local.trashHaulFee,
    pricingTierName = pricingTierName.ifBlank { local.pricingTierName },
    tipAmount = tipAmount ?: local.tipAmount,
    gridFeetPerSquare = if (gridFeetPerSquare > 0f) gridFeetPerSquare else local.gridFeetPerSquare,
    calibrationPixelsPerFoot = calibrationPixelsPerFoot ?: local.calibrationPixelsPerFoot,
    calibrationKnownFeet = calibrationKnownFeet ?: local.calibrationKnownFeet,
    supplierQuoteReference = supplierQuoteReference.ifBlank { local.supplierQuoteReference },
    durationManuallySet = durationManuallySet,
    paymentLinkUrl = paymentLinkUrl.ifBlank { local.paymentLinkUrl },
    paymentLinkAmount = if (paymentLinkAmount > 0.0) paymentLinkAmount else local.paymentLinkAmount,
    surveyStoragePath = surveyStoragePath ?: local.surveyStoragePath,
    signatureStoragePath = signatureStoragePath ?: local.signatureStoragePath,
    finalSignOffStoragePath = finalSignOffStoragePath ?: local.finalSignOffStoragePath,
    depositAmount = depositAmount,
    // Money that cleared is still never allowed to go backwards, even on a
    // branch where the cloud row is unambiguously newer.
    // Both are caches of the ledger, so the cloud value is taken as-is and
    // then recomputed from the rows after the ledger syncs. Keeping the larger
    // of the two is what pinned a stale figure permanently high.
    amountPaid = JobSync.ledgerBackedAmountPaid(amountPaid),
    refundedAmount = JobSync.ledgerBackedAmountPaid(refundedAmount),
    refundedAt = CloudTime.parseMillis(refundedAt) ?: local.refundedAt,
    signedAt = CloudTime.parseMillis(signedAt) ?: local.signedAt,
    quoteApprovedAt = CloudTime.parseMillis(quoteApprovedAt) ?: local.quoteApprovedAt,
    quoteApprovedName = quoteApprovedName.ifBlank { local.quoteApprovedName },
    finalSignOffAt = CloudTime.parseMillis(finalSignOffAt) ?: local.finalSignOffAt,
    blockedAt = CloudTime.parseMillis(blockedAt) ?: local.blockedAt,
    customerNotifiedAt = CloudTime.parseMillis(customerNotifiedAt) ?: local.customerNotifiedAt,
    materialPricesConfirmedAt = CloudTime.parseMillis(materialPricesConfirmedAt) ?: local.materialPricesConfirmedAt,
    locateCalledAt = CloudTime.parseMillis(locateCalledAt) ?: local.locateCalledAt,
    locateDigAfter = CloudTime.parseMillis(locateDigAfter) ?: local.locateDigAfter,
    locateExpiresAt = CloudTime.parseMillis(locateExpiresAt) ?: local.locateExpiresAt,
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
    // buildTemplateSyncId is LOUD, so it takes the cloud's value outright,
    // the same as every other field in this merge -- this branch only runs
    // when the cloud row is already established as newer.
    buildTemplateSyncId = buildTemplateSyncId ?: local.buildTemplateSyncId,
    // These four are quiet-clock bookkeeping (see the comment on Job.toCloud
    // for why they are never pushed from here). On the way DOWN there is no
    // such danger -- the cloud is the only writer of a real value, so taking
    // it is always at least as correct as whatever this phone is holding.
    // Not dropped, so a job pulled fresh after the office prices it actually
    // shows that on this phone instead of resetting to blank forever.
    pricedBy = pricedBy.ifBlank { local.pricedBy },
    pricedAt = CloudTime.parseMillis(pricedAt) ?: local.pricedAt,
    pricingEngineVersion = pricingEngineVersion.ifBlank { local.pricingEngineVersion },
    quoteSentAt = CloudTime.parseMillis(quoteSentAt) ?: local.quoteSentAt,
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
    minimumJobCharge = minimumJobCharge ?: 0.0,
    wastePercent = wastePercent,
    blockedReason = blockedReason,
    overrunReason = overrunReason,
    gridExtentFt = gridExtentFt,
    siteLat = siteLat,
    siteLon = siteLon,
    locateTicketNo = locateTicketNo,
    locateNotes = locateNotes,
    customerMustClear = customerMustClear,
    teardownEnabled = teardownEnabled,
    teardownFlatFee = teardownFlatFee,
    teardownRatePerFt = teardownRatePerFt,
    teardownFeet = teardownFeet,
    gateRatePerFt = gateRatePerFt ?: 20.0,
    trashHaulFee = trashHaulFee ?: 0.0,
    pricingTierName = pricingTierName,
    tipAmount = tipAmount ?: 0.0,
    gridFeetPerSquare = gridFeetPerSquare,
    calibrationPixelsPerFoot = calibrationPixelsPerFoot,
    calibrationKnownFeet = calibrationKnownFeet,
    supplierQuoteReference = supplierQuoteReference,
    durationManuallySet = durationManuallySet,
    paymentLinkUrl = paymentLinkUrl,
    paymentLinkAmount = paymentLinkAmount,
    surveyStoragePath = surveyStoragePath,
    signatureStoragePath = signatureStoragePath,
    finalSignOffStoragePath = finalSignOffStoragePath,
    depositAmount = depositAmount,
    amountPaid = amountPaid,
    refundedAmount = refundedAmount,
    refundedAt = CloudTime.parseMillis(refundedAt),
    signedAt = CloudTime.parseMillis(signedAt),
    quoteApprovedAt = CloudTime.parseMillis(quoteApprovedAt),
    quoteApprovedName = quoteApprovedName,
    finalSignOffAt = CloudTime.parseMillis(finalSignOffAt),
    blockedAt = CloudTime.parseMillis(blockedAt),
    customerNotifiedAt = CloudTime.parseMillis(customerNotifiedAt),
    materialPricesConfirmedAt = CloudTime.parseMillis(materialPricesConfirmedAt),
    locateCalledAt = CloudTime.parseMillis(locateCalledAt),
    locateDigAfter = CloudTime.parseMillis(locateDigAfter),
    locateExpiresAt = CloudTime.parseMillis(locateExpiresAt),
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
    buildTemplateSyncId = buildTemplateSyncId,
    pricedBy = pricedBy,
    pricedAt = CloudTime.parseMillis(pricedAt),
    pricingEngineVersion = pricingEngineVersion,
    quoteSentAt = CloudTime.parseMillis(quoteSentAt),
    updatedAt = updatedAtMillis()
)
