package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.FieldChange
import com.fenceestimator.app.data.HoaApprovalStatus
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.PaymentStatus
import com.fenceestimator.app.data.PermitStatus
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.estimate.EstimateEngine
import com.fenceestimator.app.estimate.JobMoney
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.query.Columns
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
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
    /**
     * MATERIALS | DIG | SET | BUILD | PUNCH | DONE, or null before production
     * starts. Never sent by the phone -- see the comment on [Job.toCloud]'s
     * omission of this field. `set_production_stage` is the only writer;
     * this class only ever decodes what it or a plain pull already put here.
     */
    @SerialName("production_stage") val productionStage: String? = null,
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
    // Pull-only (docs/REAPPROVAL_RULE.md): the server sets these when a
    // material drawing change withdraws an existing approval. Never sent
    // back up -- see Job.toCloud, which does not include them.
    @SerialName("reapproval_required_at") val reapprovalRequiredAt: String? = null,
    @SerialName("reapproval_reason") val reapprovalReason: String = "",
    @SerialName("reapproval_count") val reapprovalCount: Int = 0,
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
    /**
     * The price the customer accepted (see Job.acceptedTotal). Pull-only, and
     * written server-side by two writers: `stamp_accepted_total` copies
     * signed_contract_total when a drawn signature arrives, and quote-view
     * writes the page total in the same UPDATE as quote_approved_at on an
     * online approval -- the trigger never stamps an approval. Nothing on the
     * phone ever sends it: Job.toCloud leaves it at this null default, which
     * explicitNulls = false drops from the JSON, and it is in MONEY_KEYS for
     * the crew door. Absent from jobs_crew, so it decodes null there and
     * mergeOnto's keepMoney holds the local value.
     */
    @SerialName("accepted_total") val acceptedTotal: Double? = null,
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
    /**
     * Which engine wrote [contractTotal] last: '' | 'APP' | 'OFFICE'.
     *
     * Nullable with a null default, like [pricedAt], and that is load-bearing.
     * These two used to default to "", and SyncJson encodes defaults, so every
     * Job.toCloud() payload carried priced_by = '' and pricing_engine_version
     * = '' -- the comment on toCloud assumed explicitNulls = false dropped
     * them, but that only drops NULL defaults. Through crew_save_job that
     * blanked a real pricing record (job 10b0407f, 2026-09-21: priced_at
     * 19:00, priced_by and engine ''), after which an office price read as
     * "not office-priced" and a phone recompute was free to overwrite it. Null
     * now means "this object says nothing about it", and nothing is sent.
     */
    @SerialName("priced_by") val pricedBy: String? = null,
    @SerialName("priced_at") val pricedAt: String? = null,
    @SerialName("pricing_engine_version") val pricingEngineVersion: String? = null,
    /**
     * Set once the office has sent this quote to the customer. From then on
     * the number the customer saw is the number that stands -- the phone
     * only ever records a pricing_drift row if it disagrees, never
     * overwrites. Never sent by the phone: nothing on the phone marks a
     * quote sent, this column only ever arrives FROM the cloud.
     */
    @SerialName("quote_sent_at") val quoteSentAt: String? = null,
    /**
     * Office-only seed/demo data (e.g. "ZZ TEST" jobs), never meant to reach a
     * phone. The dashboard hides these in its own SQL/JS layer; this is the
     * matching field on the wire so the phone can do the same. Filtered at the
     * single pull choke point in [JobSync.sync] -- never stored locally, never
     * pushed back, and never used to decide a delete (a fixture already synced
     * to a phone before this field existed is removed with
     * [Repository.deleteJobLocallyOnly], the same local-only path GuestWipe
     * uses, so nothing resembling a delete is ever sent to the server for it).
     */
    @SerialName("is_test_fixture") val isTestFixture: Boolean = false
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

    /** The job reached COMPLETED -- the work is done. */
    MARKED_COMPLETE,

    /**
     * The customer accepted the quote (status ACCEPTED).
     *
     * Its own kind because it used to be MARKED_COMPLETE: the check compared
     * against ACCEPTED, so every signed quote announced "Job marked complete
     * -- was finished by the crew" for a fence nobody had started. See
     * [statusChangeKind].
     */
    QUOTE_ACCEPTED,
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

/**
 * What a pulled status change is worth telling somebody, from the status this
 * phone held to the one the cloud now has.
 *
 * ACCEPTED is the customer saying yes to the quote; COMPLETED is the fence
 * being finished. The pull tested ACCEPTED and announced it as completion, so
 * the owner read "was finished by the crew" the moment a quote was signed.
 * Each is now its own kind, announced once, on the way IN: a job already
 * COMPLETED that the cloud still calls ACCEPTED (a phone behind) is not a
 * new acceptance, and a reopened job is an ordinary update.
 */
internal fun statusChangeKind(local: JobStatus, cloudStatus: String): ChangeKind {
    val cloud = runCatching { JobStatus.valueOf(cloudStatus) }.getOrNull() ?: return ChangeKind.UPDATED
    return when {
        cloud == JobStatus.COMPLETED && local != JobStatus.COMPLETED -> ChangeKind.MARKED_COMPLETE
        cloud == JobStatus.ACCEPTED && local != JobStatus.ACCEPTED && local != JobStatus.COMPLETED ->
            ChangeKind.QUOTE_ACCEPTED
        else -> ChangeKind.UPDATED
    }
}

/**
 * Whether a pulled change of [kind] is this phone's to announce, rather than
 * something the server has already pushed to it.
 *
 * UPDATED is ordinary editing. PAYMENT_RECEIVED has its own push from the
 * payment webhooks, naming the amount. QUOTE_ACCEPTED has two --
 * notify-job-change's "Quote accepted / X accepted the quote." (job-push.ts)
 * and quote-view's "Quote approved" -- so announcing it again from the pull
 * that push itself triggers was the second or third notification for one
 * acceptance. A phone with no push token hears neither, and the pull is all
 * it has, so it is told there.
 */
internal fun announcedLocally(kind: ChangeKind, hasPushToken: Boolean): Boolean = when (kind) {
    ChangeKind.UPDATED, ChangeKind.PAYMENT_RECEIVED -> false
    ChangeKind.QUOTE_ACCEPTED -> !hasPushToken
    ChangeKind.NEW_JOB, ChangeKind.ASSIGNED_TO_ME, ChangeKind.MARKED_COMPLETE -> true
}

/**
 * The pulled changes to announce, from one pass's [incoming].
 *
 * One per job per pass: a job in several changes at once is still one thing
 * that happened. And each job's news once per app run -- [announced] is kept
 * by the caller for the life of the process, because several triggers fire
 * together at launch and every pass that pulled the same job announced it
 * again. Keyed by job AND kind: keyed by job alone, a job announced once (its
 * quote accepted, say) could never announce anything again that run, so the
 * crew finishing it that afternoon went unsaid.
 */
internal fun changesToAnnounce(
    incoming: List<IncomingChange>,
    announced: MutableSet<String>,
    hasPushToken: Boolean
): List<IncomingChange> =
    incoming
        .filter { announcedLocally(it.kind, hasPushToken) }
        .distinctBy { it.jobId }
        .filter { announced.add("${it.jobId}:${it.kind.name}") }

data class SyncResult(
    val uploaded: Int,
    val downloaded: Int,
    val incoming: List<IncomingChange> = emptyList(),
    /**
     * Jobs the server refused to take from this phone (a crew door that said
     * no). Not failures -- the work stays here and is retried -- but not
     * nothing either: "everything is backed up" must not be said while any
     * of these exist. See AutoSync's somethingHeldBack.
     */
    val heldBack: Int = 0,
    /**
     * Deletes the server refused for good ("Deleting needs the delete
     * permission") and this pass therefore dropped from the queue, so the pull
     * puts the record back here. Counted once per record per app run, for
     * AutoSync to tell the person; see [JobSync.sync]'s deletion loop.
     */
    val deleteRefused: Int = 0,
    /**
     * Jobs this pass hid because the crew door stopped returning them -- the
     * person was taken off them (see [planJobHolds]). Kept on the phone, not
     * deleted; [com.fenceestimator.app.data.Repository.observeHeldJobs] lists them.
     */
    val accessEnded: Int = 0,
    /** Held jobs that came back this pass: access granted, or put back on the crew. */
    val accessRestored: Int = 0
) {
    val changed: Boolean get() = uploaded > 0 || downloaded > 0
}

/**
 * How a note about crew edits the server will not take is worded, and who it
 * is from. JobSync has no Context, so AutoSync hands in the translated
 * wording; [PLAIN] is the English used where no Context is to hand.
 *
 * @param summary the note's one line, given the changed fields' labels.
 * @param label a field's name as a person reads it, given its column.
 */
class UnsentCrewEditNote(
    val summary: (List<String>) -> String,
    val label: (String) -> String,
    val by: String,
    val role: String
) {
    companion object {
        val PLAIN = UnsentCrewEditNote(
            summary = { labels -> "Changed on a crew phone, not saved: " + labels.joinToString(", ") },
            label = { column -> column.replace('_', ' ') },
            by = "",
            role = "Crew"
        )
    }
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
        companyId: String,
        scope: MoneyScope
    ): Result<Int> = withContext(Dispatchers.IO) {
        runCatching {
            // Nothing here is safe to ask about, let alone send, from a phone
            // that isn't confirmed ALLOWED -- including UNKNOWN, which is
            // "couldn't ask" rather than "no."
            if (scope != MoneyScope.ALLOWED) return@runCatching 0
            val jobs = repository.getAllJobs()
            if (jobs.isEmpty()) return@runCatching 0
            // Paged: another push-side compare, so a job past row one
            // thousand would read as "not found in the cloud" and this
            // correction pass would silently skip reconciling its ledger
            // total.
            val cloudBySyncId = pagedList<CloudJob>("jobs") {
                eq("company_id", companyId)
            }
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
     * Which of [shiftSyncIds] the crew door (time_entries_crew) shows -- that
     * is, which of this phone's finished shifts the cloud already holds. The
     * door is readable by every signed-in member of the company; once the
     * crew scope is live it shows a scoped person their own shifts, on any
     * job, deleted or not, which is exactly what keptJobsToForget needs to
     * know. A shift the door does not show is treated as not sent: the job is
     * kept, never forgotten over a shift that might be somebody's pay.
     */
    private suspend fun crewDoorShiftSyncIds(companyId: String, shiftSyncIds: List<String>): Set<String> {
        val found = HashSet<String>()
        for (chunk in shiftSyncIds.distinct().chunked(100)) {
            // By sync id, a hundred at a time: at most a hundred rows back,
            // said out loud (the range), so it is never mistaken for a
            // whole-table read the 1000-row cap would cut short, and no
            // request line runs long.
            found += SupabaseModule.client.postgrest.from("time_entries_crew")
                .select(Columns.list("sync_id")) {
                    filter {
                        eq("company_id", companyId)
                        isIn("sync_id", chunk)
                    }
                    range(0L, chunk.size.toLong() - 1)
                }
                .decodeList<ShiftSyncIdRow>()
                .map { it.syncId }
        }
        return found
    }

    @Serializable
    private data class ShiftSyncIdRow(@SerialName("sync_id") val syncId: String = "")

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

    /**
     * Takes the row the cloud now holds for [pushed] -- [returned], as the
     * push itself handed it back -- onto this phone, so the rest of this same
     * pass compares like with like.
     *
     * The mechanism this fixes, step by step. A job edit here stamps
     * updatedAt with the device clock (T1). The push writes the row, and the
     * server's touch_updated_at trigger sets updated_at = now() (S), later
     * than T1. The phone used to record only lastSyncedAt, so its updatedAt
     * stayed at T1. Later in the SAME pass EntitySync's collectJobChildRows
     * skips every child of a job whose cloud updated_at is newer than the
     * local one -- S > T1 -- so this job's line items were not pushed, and
     * pullAll then merged the cloud's OLDER quantities over the fresh local
     * ones. Because line-item sync ids are deterministic, even a brand-new
     * Suggest result matched a cloud row and was overwritten: the quantities
     * and the price snapped back a few seconds after the owner pressed
     * Suggest, set the waste, took a signature, or anything else that writes
     * the job row alongside its lines.
     *
     * Why the whole row and not only its clock. The old T1-behind-S gap was
     * also what made the NEXT pass pull the job back down, and that echo was
     * doing real work: the BEFORE triggers on jobs can change what was sent
     * (the money and contract holds put a refused column back,
     * protect_customer_identity puts a crew-typed name back,
     * stamp_accepted_total copies a drawn signature's figure into the
     * accepted price -- an online approval's figure is quote-view's to write,
     * never the trigger's), and pull-only columns
     * (reapproval_*, production_stage, quote_approved_at) may have moved
     * since this pass read the table. Adopting only S would have told the
     * phone "you are in step" while it still held the values the server had
     * just refused, for good. mergeOnto of the returned row is exactly what
     * that echo pull would have written, done now instead of one pass late.
     *
     * [returned] comes from the write itself where it can (the ALLOWED
     * UPDATE/INSERT with return=representation), so an edit made elsewhere a
     * moment later cannot be mistaken for ours. A crew phone's door is an RPC
     * that returns a bare boolean, so there it is read back from jobs_crew
     * straight after; an office edit landing in between is then simply part
     * of the row adopted -- merged in whole, never vouched for without its
     * content, so nothing of it is lost.
     *
     * Compare-and-set against the row as it is now, inside one Room
     * transaction (Repository.updateJobAtomically), because the job can be
     * typed into while the push is in flight: [jobAfterPush] never lets the
     * returned row overwrite that edit, nor marks it synced.
     *
     * Falls back to a stamp when there is nothing to adopt: no row came back
     * (the update matched nothing, or the read-back failed), its clock did not
     * parse, or it came back tombstoned (the next pass removes the job, as it
     * always has). The stamp is the clock of the copy that was SENT, not the
     * time now: stamping "now" marked as synced any edit typed while the
     * request was in flight, so jobHoldsUnpushedEdit read false and the
     * sign-out guard could wipe an edit that never went up.
     *
     * @param finish what to do to a row adopted whole before it is written:
     *   the cloud's employee/manufacturer references mapped to this phone's
     *   ids, and the snapshot the next crew push diffs against (crewBase).
     * @return true when the returned row was adopted whole -- the caller then
     *   keeps the pull further down off this job, because the table snapshot
     *   that pull works from was read before this write and is older than
     *   what the phone now holds.
     */
    private suspend fun adoptPushedRow(
        repository: Repository,
        pushed: Job,
        returned: CloudJob?,
        keepMoney: Boolean,
        finish: (CloudJob, Job) -> Job
    ): Boolean {
        if (returned == null || returned.deletedAt != null || returned.updatedAtMillis() <= 0L) {
            repository.updateJobSyncStamp(pushed.id, pushed.updatedAt)
            return false
        }
        var adoptedWhole = false
        repository.updateJobAtomically(pushed.id) { current ->
            val next = jobAfterPush(pushed, current, returned, keepMoney) ?: return@updateJobAtomically null
            adoptedWhole = current.updatedAt == pushed.updatedAt
            if (adoptedWhole) finish(returned, next) else next
        }
        return adoptedWhole
    }

    /**
     * Records the server refused to delete for good, already counted in a
     * [SyncResult.deleteRefused] this app run -- so the person hears about
     * each one once, not on every pass until they restart the app.
     */
    private val reportedRefusals: MutableSet<String> = java.util.Collections.synchronizedSet(HashSet<String>())

    /**
     * @param jobScope which jobs this person may see ([JobAccess.askJobScope]),
     *   asked once per pass by AutoSync beside [scope]. Null asks here, and
     *   only on a DENIED phone -- an ALLOWED one sees every job whatever the
     *   answer -- so a caller that predates crew scoping still hides and
     *   un-hides correctly.
     */
    suspend fun sync(
        repository: Repository,
        companyId: String,
        scope: MoneyScope,
        unsentNote: UnsentCrewEditNote = UnsentCrewEditNote.PLAIN,
        jobScope: JobScope? = null
    ): Result<SyncResult> = withContext(Dispatchers.IO) {
        // Could not ask, so nothing here is trusted -- not a read, not a
        // write. Collapsing this into DENIED would scrub real prices off a
        // phone that was ALLOWED all along; collapsing it into ALLOWED would
        // push a crew phone's payload straight at a door that just refuses
        // money quietly and does not know it failed.
        if (scope == MoneyScope.UNKNOWN) {
            android.util.Log.i("JobSync", "money scope: UNKNOWN; skipping job sync this pass")
            return@withContext Result.success(SyncResult(0, 0))
        }
        runCatching {
            // Deletions first, always. If a pull ran before them, the rows we
            // just deleted locally would still be in the cloud and would come
            // straight back down.
            //
            // Skipped entirely on a DENIED phone: crew have no DELETE_RECORDS
            // by default, and once the base tables are gated, an UPDATE this
            // phone is not allowed to make matches zero rows, comes back a
            // quiet 200, and `removed.isSuccess` would clear the local marker
            // as though the delete had actually reached the cloud.
            var deleteRefused = 0
            if (scope == MoneyScope.ALLOWED) {
                // Through pendingDeletionsForSync: a queued line-item delete
                // whose line is alive here again is cancelled first, never
                // sent (see PendingDeletionDao.clearStaleLineItemDeletes --
                // landing one takes the live line off every device).
                repository.pendingDeletionsForSync().forEach { deletion ->
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
                    //
                    // Or once the server has said no for good. A delete this
                    // account may not make ("Deleting needs the delete
                    // permission", enforce_delete_permission) used to stay
                    // queued and be retried for ever, while the pull honoured
                    // it (lineItemsToApply) -- so the record stayed hidden on
                    // this phone alone and was live everywhere else. For a
                    // line item that meant this phone priced the job without
                    // it and every other phone with it, and each pushed its
                    // own contract_total over the other's through the
                    // realtime feed: a price that flipped between two figures
                    // every few seconds, on the number the quote page and the
                    // payment links read. Dropped from the queue, the pull
                    // puts the record back here too, and the person is told
                    // once. Anything else (no signal, a timeout) still retries.
                    when {
                        removed.isSuccess -> repository.clearPendingDeletion(deletion.syncId)
                        isDeletePermissionRefusal(removed.exceptionOrNull()) -> {
                            repository.clearPendingDeletion(deletion.syncId)
                            if (reportedRefusals.add(deletion.syncId)) deleteRefused++
                        }
                    }
                }
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

            // ALLOWED reads the real table; anything else reads the door
            // without money on it -- same filter, same shape, absent keys
            // decoding to CloudJob's own defaults.
            // Paged: this is the jobs table itself, which the arithmetic on
            // this bug names directly -- at 1:1 rows per job it truncates at
            // exactly 1000 jobs for a company, and it is both a push-side
            // compare (below) and the read that decides what gets pulled.
            val cloudJobsRaw = if (scope == MoneyScope.ALLOWED)
                pagedList<CloudJob>("jobs") {
                    eq("company_id", companyId)
                }
            else
                pagedList<CloudJob>("jobs_crew") {
                    eq("company_id", companyId)
                }

            // Office-only seed/demo rows never reach a phone. Filtered here,
            // at the single pull choke point, rather than in every downstream
            // screen/query -- see the doc comment on CloudJob.isTestFixture.
            val fixtureSyncIds = cloudJobsRaw.filter { it.isTestFixture }.mapTo(HashSet()) { it.syncId }
            val cloudJobs = if (fixtureSyncIds.isEmpty()) cloudJobsRaw
                else cloudJobsRaw.filterNot { it.isTestFixture }

            val cloudBySyncId = cloudJobs.associateBy { it.syncId }
            var uploaded = 0
            var downloaded = 0
            var heldBack = 0

            // Jobs whose row this pass has just written. cloudJobs was read
            // BEFORE those writes, so for these the snapshot is older than the
            // cloud -- the pull below must not take a quiet column from it
            // (see the accepted_total branch) and undo what was just sent.
            val pushedThisPass = HashSet<String>()
            // The subset whose returned row was adopted whole (adoptPushedRow):
            // the phone already holds the cloud's current copy of these, newer
            // than anything in the snapshot, so the pull skips them entirely --
            // its production_stage and payment branches compare against that
            // older snapshot and would otherwise roll the adopted values back.
            val adoptedThisPass = HashSet<String>()

            /**
             * The cloud's employee and manufacturer references, turned into
             * this phone's row ids where this phone knows them. mergeOnto
             * cannot do it (the ids are per-phone), so every path that takes a
             * cloud row -- the pull and the post-push adoption -- goes through
             * this one mapping. An id this phone has not pulled yet leaves the
             * local reference as it was.
             */
            fun withCloudRefs(cloud: CloudJob, job: Job): Job {
                val withEmployee = cloud.assignedEmployeeSyncId
                    ?.let { es -> employeeIdBySync[es] }
                    ?.let { job.copy(assignedEmployeeId = it) } ?: job
                return cloud.preferredManufacturerSyncId
                    ?.let { ms -> manufacturerIdBySync[ms] }
                    ?.let { withEmployee.copy(preferredManufacturerId = it) } ?: withEmployee
            }

            /**
             * What [job] serializes to as a push would send it, money keys
             * and identity left out -- with this pass's own id mappings, so a
             * snapshot taken now and one taken at the next push compare like
             * with like (see jobSyncSnapshot).
             */
            fun snapshotOf(job: Job): JsonObject = jobSyncSnapshot(
                job, companyId,
                job.assignedEmployeeId?.let { employeeSyncById[it] },
                job.preferredManufacturerId?.let { manufacturerSyncById[it] }
            )

            /**
             * A row this phone has just taken from the cloud, as it will be
             * written: references mapped (withCloudRefs), and the snapshot
             * the next crew push diffs against recorded (Job.crewBase). Every
             * path that writes a whole cloud row goes through here -- the
             * first pull, the newer-in-the-cloud merge, and the adoption of a
             * pushed row.
             */
            fun taken(cloud: CloudJob, job: Job): Job =
                withCloudRefs(cloud, job).let { it.copy(crewBase = encodeSnapshot(snapshotOf(it))) }

            // Whether a crew/foreman caller may send a duration
            // (CREW_SCHEDULER_JOB_KEYS). Asked at most once a pass, and only
            // if a crew push actually happens. The same has_permission the
            // server's crew_save_job consults, so the two cannot disagree. A
            // failed question reads as "no": the duration is then simply not
            // sent this pass and stays on the phone, still newer, for the next.
            var crewMayRescheduleAnswer: Boolean? = null
            suspend fun crewMayReschedule(): Boolean = crewMayRescheduleAnswer ?: runCatching {
                SupabaseModule.client.postgrest.rpc(
                    "has_permission",
                    buildJsonObject { put("perm", "SCHEDULE_AND_ASSIGN") }
                ).decodeAs<Boolean>()
            }.getOrDefault(false).also { crewMayRescheduleAnswer = it }

            // A fixture already synced to this phone before it knew the flag
            // existed. Removed locally only -- never pushed, never tombstoned,
            // the exact path GuestWipe already relies on for the same reason.
            if (fixtureSyncIds.isNotEmpty()) {
                localJobs.filter { it.syncId in fixtureSyncIds }
                    .forEach { repository.deleteJobLocallyOnly(it) }
            }

            // Jobs this person is no longer on stop arriving through the crew
            // door (supabase_crew_job_scope.sql). They are HIDDEN here, never
            // deleted: a delete would cascade their shifts away and take any
            // tick or marker the cloud has not got, and nothing says which of
            // those the cloud has. A job that arrives again comes back. Before
            // anything is pushed, so the push loop and the child pushes after
            // it see this pass's answer -- a held job's rows are not sent at a
            // door that refuses them row by row (EntitySync.mayPushJobChildren).
            // Nothing is ever pushed or tombstoned for a held job.
            val access = jobScope ?: if (scope == MoneyScope.DENIED) JobAccess.askJobScope() else JobScope.Unknown
            val holds = planJobHolds(localJobs.filter { it.syncId !in fixtureSyncIds }, cloudJobs, scope, access)
            val regained = ArrayList<IncomingChange>()
            var restored = 0
            if (!holds.changesNothing) {
                repository.applyJobHolds(holds.hide, holds.unhide, holds.unhideAll, System.currentTimeMillis())
                val back = localJobs.filter { it.accessEndedAt != null && (holds.unhideAll || it.syncId in holds.unhide) }
                restored = back.size
                // "Assigned to you" only while this person is still scoped --
                // an approval, or being put back on the crew. Everything held
                // coming back at once is a promotion (or a database without
                // the scope), and none of those jobs was assigned to anyone.
                if (!holds.unhideAll) {
                    back.forEach { regained += IncomingChange(it.id, it.customerName, ChangeKind.ASSIGNED_TO_ME) }
                }
                android.util.Log.i(
                    "JobSync",
                    "crew scope: ${holds.hide.size} job(s) kept on this phone, $restored back"
                )
            }

            // Kept after this pass: held before and not back, or hidden just now.
            val keptNow = localJobs.filter { it.syncId !in fixtureSyncIds && holds.keepsHeld(it) }

            // A kept job the office has since deleted. The crew door sends a
            // tombstone only for a job this person can still see, so such a
            // job never reached the delete path below: it sat under "Kept on
            // this phone" for good, and an unsent edit on it blocked an
            // ordinary sign-out for ever. The server is asked about the kept
            // ones by id (deleted_job_sync_ids) and a deleted one takes the
            // ordinary local delete -- a deleted job's work is moot, as it is
            // for any tombstone -- but not while it still holds a shift the
            // cloud may not have (keptJobsToForget). Pay outranks tidiness:
            // that job is asked about again next pass, after this pass's
            // shift push has run.
            val forgotten = HashSet<String>()
            if (keptNow.isNotEmpty() && access is JobScope.Scoped) {
                val deletedInCloud = JobAccess.deletedAmong(keptNow.map { it.syncId }).orEmpty()
                    .mapTo(HashSet()) { it.lowercase() }
                val candidates = keptNow.filter { it.syncId.lowercase() in deletedInCloud }
                if (candidates.isNotEmpty()) {
                    val shiftsByJob = candidates.associate { it.id to repository.getTimeEntries(it.id) }
                    val finished = shiftsByJob.values.flatten().filter { !it.isRunning }.map { it.syncId }
                    val shiftsInCloud = if (finished.isEmpty()) emptySet()
                        else runCatching { crewDoorShiftSyncIds(companyId, finished) }.getOrNull()
                    for (job in keptJobsToForget(candidates, deletedInCloud, shiftsByJob, shiftsInCloud)) {
                        repository.deleteJobLocallyOnly(job)
                        forgotten += job.syncId
                        downloaded++
                    }
                    android.util.Log.i(
                        "JobSync",
                        "crew scope: ${candidates.size} kept job(s) deleted by the office, ${forgotten.size} forgotten here"
                    )
                }
            }

            // A kept job holding an edit the cloud has not got is work
            // waiting, whatever the reason it cannot go up yet -- so the sync
            // card must not say "everything is backed up" over it (AutoSync's
            // somethingHeldBack). It said exactly that: the push below leaves
            // a kept job alone, and "left alone" counted as nothing. Only the
            // job row can say so precisely (jobHoldsUnpushedEdit); its
            // children carry no mark of their own, and guessing from them
            // would call every kept job unsent for ever.
            heldBack += keptNow.count {
                it.syncId !in forgotten && com.fenceestimator.app.data.jobHoldsUnpushedEdit(it)
            }

            for (job in localJobs) {
                if (job.syncId in fixtureSyncIds) continue
                // Nothing is pushed for a kept job (see keptNow): it waits on
                // this phone until the door returns it. Most passes it would
                // never get past "left alone" below anyway, but a pass whose
                // money question failed (UNKNOWN) takes the insert branch for
                // a job missing from the door -- it tried to INSERT every kept
                // job into the real table, which a crew login is refused, and
                // that one refusal failed the whole pass. Forgotten ones
                // (above) are gone from the phone already.
                if (holds.keepsHeld(job)) continue
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
                // What the block below decided contract_total should be, if it
                // decided anything. The ordinary row push further down must
                // carry exactly this -- or, when the block chose not to push,
                // the cloud's current figure -- never its own fresh recompute.
                // It used to send totalFor(job) regardless, so an unrelated
                // edit (a phone number, opening satellite mode) quietly put the
                // phone's number over an office price the customer had already
                // been sent. The block was the only authority on paper.
                //
                // Runs only when ALLOWED. contract_total is itself one of
                // MONEY_KEYS, and cloudJob's copy of it is real only when this
                // pull came from the actual "jobs" table -- from jobs_crew it
                // is always CloudJob's bare default, which would otherwise
                // read as "nobody has priced this" on every single pass.
                var decidedTotal: Double? = null
                // Accepted, with an accepted figure on record: the price the
                // customer agreed to (plus extra work they have signed since)
                // is the only total this phone may assert. The branches below
                // used to run regardless of acceptance -- only an OFFICE price
                // with quote_sent_at stopped them -- so the phone's fresh
                // recompute went up as contract_total after every regenerate,
                // catalog change or reverted quantity, and the quote page, the
                // payment link and the deposit cap all moved with it (Woody:
                // signed $3,620, contract_total $200; job 4598: signed $9,710,
                // contract_total $13,410). A recompute that disagrees now
                // changes nothing: the job screen shows both figures, and a
                // real change goes through a change order or re-approval
                // (anchoredTotal is null while reapproval_required_at is set,
                // so the new figure is free to reach the quote page then).
                val anchored = if (scope == MoneyScope.ALLOWED)
                    JobMoney.anchoredTotal(job, ordersByJob[job.id].orEmpty()) else null
                if (anchored != null) {
                    if (cloudJob != null && cloudJob.deletedAt == null &&
                        (cloudJob.contractTotal == null || kotlin.math.abs(cloudJob.contractTotal - anchored) > 0.005)
                    ) {
                        pushContractTotal(companyId, job.syncId, anchored)
                        decidedTotal = anchored
                    }
                } else if (scope == MoneyScope.ALLOWED) {
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
                        val officeEngine = cloudJob.pricingEngineVersion.orEmpty()
                        val officeEngineIsNewer = officePriced &&
                            officeEngine.isNotBlank() &&
                            engineVersionIsNewer(officeEngine, EstimateEngine.PRICING_ENGINE_VERSION)
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
                                            "(engine $officeEngine) vs phone total $freshTotal " +
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
                                        officeEngine = officeEngine,
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
                                    decidedTotal = freshTotal
                                }
                            }
                            // (c) Nobody has priced this from the office, or the
                            // last price on it was the phone's own -- unchanged
                            // from before this feature existed.
                            else -> {
                                pushContractTotal(companyId, job.syncId, freshTotal)
                                decidedTotal = freshTotal
                            }
                        }
                    }
                }

                if (cloudJob == null) {
                    // DENIED never inserts. There is no crew insert path on
                    // the server either (crew_save_job is UPDATE-only) -- a
                    // job this phone has never seen from the cloud is either
                    // one this phone created (and it will appear once ALLOWED
                    // pushes it, or once the office adds it) or one this
                    // account is not supposed to see at all. Either way,
                    // guessing by inserting a duplicate is worse than waiting.
                    // A job this person was taken off lands here too, and has
                    // just been hidden above (planJobHolds) -- kept, with its
                    // unsent work, until the door returns it again.
                    if (scope == MoneyScope.DENIED) {
                        android.util.Log.i(
                            "JobSync",
                            "job ${job.syncId} unknown to the cloud on a crew phone; left alone"
                        )
                    } else {
                        // A job signed on this phone before it ever reached the
                        // cloud goes up at the price that was signed, not at a
                        // recompute from the moment the signal came back.
                        val insertTotal = JobMoney.anchoredTotal(job, ordersByJob[job.id].orEmpty()) ?: totalFor(job)
                        val written = SupabaseModule.client.postgrest.from("jobs").insert(job.toCloud(companyId, insertTotal, job.assignedEmployeeId?.let { employeeSyncById[it] }, job.preferredManufacturerId?.let { manufacturerSyncById[it] })) {
                            // The row as the insert left it, triggers and
                            // all, from the same statement -- see adoptPushedRow.
                            select(Columns.ALL)
                        }.let { result -> runCatching { result.decodeList<CloudJob>().firstOrNull() }.getOrNull() }
                        if (adoptPushedRow(repository, job, written, keepMoney = false, ::taken)) {
                            adoptedThisPass += job.syncId
                        }
                        pushedThisPass += job.syncId
                        uploaded++
                    }
                } else if (job.updatedAt > cloudJob.updatedAtMillis()) {
                    if (scope == MoneyScope.DENIED) {
                        // The base table refuses this phone's write outright
                        // once the policy flips, so it never lands there at
                        // all -- crew_save_job is the only door, it is
                        // UPDATE-only, and it drops every MONEY_KEYS key on
                        // the server regardless of what is sent. The filter
                        // here is belt-and-suspenders: this phone's own JSON
                        // should never assert a price in the first place.
                        val payload = job.toCloud(
                            companyId, null,
                            job.assignedEmployeeId?.let { employeeSyncById[it] },
                            job.preferredManufacturerId?.let { manufacturerSyncById[it] }
                        )
                        // Only what this phone changed since it last took the
                        // cloud's copy (Job.crewBase). Sending every
                        // allowlisted column put a stale crew copy back over
                        // the office's newer calibration, grid size, teardown
                        // feet and locate ticket -- this push runs before the
                        // pull -- and the first three move the footage
                        // price-job bills. A job with no snapshot yet (pulled
                        // before this build) sends what it always sent, so the
                        // first push after the upgrade loses nothing.
                        val current = snapshotOf(job)
                        val base = decodeSnapshot(job.crewBase)
                        val mayReschedule = crewMayReschedule()
                        // The pen raises 42501 when this account may not
                        // write jobs at all (not signed in, company
                        // suspended, RECORD_FIELD_WORK gone). Left uncaught
                        // that one refusal threw out of the loop, so every
                        // job after it was skipped and the pull never ran --
                        // and the raw policy text reached the screen, which
                        // is exactly the sentence isNotOursToSync exists to
                        // keep off it. A refusal is this job held back for
                        // retry; anything else is still a real failure.
                        // Only the crew-writable columns (CREW_WRITABLE_JOB_KEYS),
                        // never this phone's whole copy of the row -- see
                        // buildCrewSaveJobPayload for what that used to erase.
                        val rowIn = buildCrewSaveJobPayload(
                            payload, mayReschedule = mayReschedule, onlyKeys = crewChangedKeys(current, base)
                        )
                        val accepted = runCatching {
                            SupabaseModule.client.postgrest.rpc(
                                "crew_save_job",
                                buildJsonObject { put("row_in", rowIn) }
                            ).decodeAs<Boolean>()
                        }.getOrElse { e ->
                            if (!isNotOursToSync(e)) throw e
                            android.util.Log.i(
                                "JobSync",
                                "job ${job.syncId} refused by crew_save_job; kept on this phone for retry"
                            )
                            heldBack++
                            false
                        }
                        // false means the row didn't match (deleted, wrong
                        // company, or this account lost RECORD_FIELD_WORK) --
                        // leave the local sync stamp untouched so this job is
                        // retried rather than silently marked "sent."
                        if (accepted) {
                            // The door answers a bare boolean, so the row is
                            // read back through the crew's own view and
                            // adopted (adoptPushedRow). Three things this
                            // settles that a stamp alone left wrong: this
                            // job's punch list, steps and markers were held
                            // back for the rest of the pass by the same
                            // clock gate as the office's line items; a local
                            // edit to a column the server does not take from
                            // crew (anything off CREW_WRITABLE_JOB_KEYS)
                            // stayed on this phone looking saved; and because
                            // the server moved nothing, updated_at stayed put
                            // and the phone pushed the same job on every
                            // pass, never pulling the office's next change
                            // until it happened to be newer. A failed read is
                            // the old behaviour, nothing worse.
                            val readBack = runCatching {
                                SupabaseModule.client.postgrest.from("jobs_crew").select {
                                    filter {
                                        eq("company_id", companyId)
                                        eq("sync_id", job.syncId)
                                    }
                                    // One job by its sync id: one row, said
                                    // out loud, so it is never mistaken for
                                    // a whole-table read the 1000-row cap
                                    // could truncate (sync-unpaged-reads).
                                    range(0L, 0L)
                                }.decodeList<CloudJob>().firstOrNull()
                            }.getOrNull()
                            if (adoptPushedRow(repository, job, readBack, keepMoney = true, ::taken)) {
                                adoptedThisPass += job.syncId
                                // What this phone changed that the server does
                                // not take from crew -- typically a note or an
                                // HOA or permit field typed into the old,
                                // editable Customer card before this build.
                                // crew_save_job drops it and says yes, and the
                                // adoption just put the server's value over
                                // it: offline work gone without a trace. It
                                // goes to the office as a request instead,
                                // once -- the adoption moved crewBase on, so
                                // the next push no longer sees it as changed.
                                repository.getJob(job.id)?.let { now ->
                                    val unsent = unsentCrewEdits(current, base, decodeSnapshot(now.crewBase) ?: current, rowIn.keys)
                                    if (unsent.isNotEmpty()) {
                                        // The job was read a moment ago; if it
                                        // went since, so does the note (see
                                        // OrphanRows) -- never the whole pass.
                                        skipIfOrphaned { repository.recordFieldChange(
                                            FieldChange(
                                                jobId = job.id,
                                                summary = unsentNote.summary(unsent.keys.map(unsentNote.label)),
                                                detail = unsent.entries.joinToString(separator = "\n") { (k, v) -> unsentNote.label(k) + ": " + v },
                                                changedBy = unsentNote.by,
                                                changedByRole = unsentNote.role,
                                                isRequest = true
                                            )
                                        ) }
                                    }
                                }
                            }
                            pushedThisPass += job.syncId
                            uploaded++
                        }
                    } else {
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
                            // And the total itself: whatever the block above
                            // pushed, else whatever the cloud already holds.
                            // The office's number, once sent, survives an
                            // edit to the notes.
                            contractTotal = decidedTotal ?: cloudJob.contractTotal,
                            pricedBy = cloudJob.pricedBy,
                            pricedAt = cloudJob.pricedAt,
                            pricingEngineVersion = cloudJob.pricingEngineVersion,
                            quoteSentAt = cloudJob.quoteSentAt,
                            // An update never moves when the job was created.
                            // Pulls used to stamp createdAt with the moment of
                            // the pull (toLocalJob did not map it), and the
                            // next ordinary edit sent that back: 4598150b went
                            // from 2026-08-18 to 09-18, c1491dd4 from 08-27 to
                            // 09-11. toLocalJob maps it now; this also stops a
                            // phone already holding a drifted copy from
                            // re-asserting it over a repaired cloud value.
                            createdAt = cloudJob.createdAt ?: withPayment.createdAt
                        )
                    }
                    val written = SupabaseModule.client.postgrest.from("jobs").update(payload) {
                        // The row as the update left it, triggers and all,
                        // from the same statement -- see adoptPushedRow.
                        select(Columns.ALL)
                        filter {
                            eq("company_id", companyId)
                            eq("sync_id", job.syncId)
                        }
                    }.let { result -> runCatching { result.decodeList<CloudJob>().firstOrNull() }.getOrNull() }
                    val adopted = adoptPushedRow(repository, job, written, keepMoney = false, ::taken)
                    if (adopted) adoptedThisPass += job.syncId
                    // Keep the phone in step with what we just agreed the cloud
                    // holds, or the next pass would try to undo it again. An
                    // adopted row already carries the payment; this is for the
                    // fallbacks. Written onto the row as it is NOW, not onto
                    // `job` -- the copy this push was built from -- which put
                    // the pushed copy back over anything typed while the
                    // request was in flight.
                    if (!adopted && payload.amountPaid > job.amountPaid) {
                        repository.getJob(job.id)?.let { now ->
                            if (payload.amountPaid > now.amountPaid) {
                                repository.updateJobFromCloud(
                                    now.copy(
                                        amountPaid = payload.amountPaid,
                                        paymentStatus = runCatching {
                                            PaymentStatus.valueOf(payload.paymentStatus)
                                        }.getOrDefault(now.paymentStatus)
                                    )
                                )
                            }
                        }
                    }
                    pushedThisPass += job.syncId
                    uploaded++
                    }
                }
            }

            // A job coming back is news worth a notification -- usually it is
            // an access request the office just approved. First in the list,
            // so it is what notifyIncoming announces for that job rather than
            // the ordinary "updated" the pull below may add for it.
            val incoming = mutableListOf<IncomingChange>()
            incoming += regained

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

                // Already holding the row the push handed back, which is newer
                // than this snapshot -- see adoptedThisPass.
                if (cloudJob.syncId in adoptedThisPass) continue

                if (local == null) {
                    val newId = repository.createJob(taken(cloudJob, cloudJob.toLocalJob()))
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
                } else if (cloudJob.productionStage != local.productionStage) {
                    // set_production_stage is a quiet clock, the same shape as
                    // the payment ledger above: a crew phone moving a job to
                    // DIG must not have to wait for some unrelated field edit
                    // to bump updated_at before every OTHER phone (and the
                    // office) finds out where the job actually is.
                    repository.updateJobFromCloud(local.copy(productionStage = cloudJob.productionStage))
                    downloaded++
                    incoming += IncomingChange(local.id, cloudJob.customerName, ChangeKind.UPDATED)
                } else if (cloudJob.updatedAtMillis() > local.updatedAt) {
                    // Read before the merge below moves local.status on.
                    val statusKind = statusChangeKind(local.status, cloudJob.status)
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
                        taken(cloudJob, cloudJob.mergeOnto(local, keepMoney = scope != MoneyScope.ALLOWED))
                    )
                    downloaded++
                    incoming += IncomingChange(
                        jobId = local.id,
                        customerName = cloudJob.customerName,
                        kind = statusKind
                    )
                } else if (scope == MoneyScope.ALLOWED && cloudJob.syncId !in pushedThisPass &&
                    acceptedTotalToAdopt(local.acceptedTotal, cloudJob.acceptedTotal) != null
                ) {
                    // accepted_total is on touch_updated_at's quiet list -- it
                    // is server bookkeeping, and stamping it must never look
                    // like an edit that beats a phone's offline work -- so a
                    // stamp or an owner-approved backfill that moves nothing
                    // else never trips the branch above. Taken on its own,
                    // like production_stage, and without touching updatedAt.
                    // Skipped for a job pushed this pass: cloudJobs is the
                    // snapshot from BEFORE that push, and a re-signature just
                    // sent would otherwise be rolled back to the old figure.
                    repository.updateJobFromCloud(
                        local.copy(acceptedTotal = acceptedTotalToAdopt(local.acceptedTotal, cloudJob.acceptedTotal))
                    )
                    downloaded++
                }

                // A job pulled by an older build carries no sync stamp, because
                // only a push used to write one -- so every job the office made
                // counted as unsynced work on this phone for ever. The pull
                // stamps it now (toLocalJob, mergeOnto); this repairs the ones
                // already here, but only when the row is provably the cloud's
                // own copy, untouched since. After the branches above, so their
                // writes are not undone -- updateJobSyncStamp re-reads the row.
                if (local != null) {
                    pulledCopySyncStamp(local, cloudJob.updatedAtMillis())?.let { stamp ->
                        repository.updateJobSyncStamp(local.id, stamp)
                    }
                }
            }

            SyncResult(
                uploaded, downloaded, incoming, heldBack, deleteRefused,
                accessEnded = holds.hide.size, accessRestored = restored
            )
        }
    }
}

/**
 * What one pass decided about jobs this person may no longer see: which to
 * hide ([hide]), which held ones to bring back ([unhide]), or to bring every
 * held one back ([unhideAll]). Sync ids. See [planJobHolds].
 */
internal data class JobHoldPlan(
    val hide: Set<String> = emptySet(),
    val unhide: Set<String> = emptySet(),
    val unhideAll: Boolean = false
) {
    val changesNothing: Boolean get() = hide.isEmpty() && unhide.isEmpty() && !unhideAll

    /**
     * Whether [job], as read at the top of the pass, is kept (hidden) once
     * this plan is applied: held already and not brought back, or hidden by
     * this plan. A plan that changes nothing -- an unanswered question --
     * keeps what was held held.
     */
    fun keepsHeld(job: com.fenceestimator.app.data.Job): Boolean =
        if (job.accessEndedAt != null) !(unhideAll || job.syncId in unhide)
        else job.syncId in hide
}

/**
 * Which kept jobs the office deleted ([deletedInCloud], from
 * deleted_job_sync_ids) this phone may now forget, the way it forgets any
 * tombstoned job.
 *
 * Not one that still holds a shift the cloud may not have: a shift still
 * running (someone is on the clock on it), or a finished one the crew door
 * does not show ([shiftsInCloud], the sync ids of this phone's finished
 * shifts that time_entries_crew returned; null when that read failed, which
 * keeps every job with a shift). Forgetting a job takes its shifts with it
 * (TimeEntry cascades on the job), and a shift is somebody's pay. It is kept
 * and asked about again next pass, by which time the shift push -- which
 * never leaves a kept job's shifts out -- has sent it.
 *
 * A job with no shift on this phone at all is forgotten on the server's word.
 * Pure, so JobHoldPlanTest holds it to that.
 */
internal fun keptJobsToForget(
    kept: List<com.fenceestimator.app.data.Job>,
    deletedInCloud: Set<String>,
    shiftsByJob: Map<Long, List<com.fenceestimator.app.data.TimeEntry>>,
    shiftsInCloud: Set<String>?
): List<com.fenceestimator.app.data.Job> {
    // Ids compared as uuids are: whatever case either side happens to carry.
    val deleted = deletedInCloud.mapTo(HashSet()) { it.lowercase() }
    val sent = shiftsInCloud?.mapTo(HashSet()) { it.lowercase() }
    return kept.filter { job ->
        job.syncId.lowercase() in deleted && shiftsByJob[job.id].orEmpty().all { shift ->
            !shift.isRunning && sent != null && shift.syncId.lowercase() in sent
        }
    }
}

/**
 * Which local jobs to hide and which to bring back, given what the crew door
 * returned this pass ([cloud], test fixtures already taken out) and the two
 * scope answers.
 *
 * Hides only on a definite "you see only your jobs": money DENIED (the phone
 * read jobs_crew) AND [JobScope.Scoped]. Everything else either changes
 * nothing -- an unanswered question ([MoneyScope.UNKNOWN],
 * [JobScope.Unknown]) is never a reason to hide a crew member's work -- or
 * brings every held job back: a phone that may see money reads the real jobs
 * table and sees them all, and so does anyone [JobScope.seesEverything]
 * (a foreman, a +EDIT_JOBS crew member, or a database the crew scope has not
 * reached, where every job is visible exactly as before).
 *
 * When scoped:
 *  - hide a job the door did not return, but only one this phone provably
 *    had from the cloud (a sync stamp, or a crew snapshot). A job made here
 *    and never sent was never the cloud's to take away; it stays in the list.
 *  - bring back a held job the door returns again.
 *  - change nothing when the server says this person is on jobs
 *    ([JobScope.Scoped.visible] > 0) and the door returned no live job at
 *    all. That door also answers empty for a suspended company; hiding every
 *    job over an empty answer is the empty-answer-reads-as-good-news bug in
 *    its most expensive form. An unlinked login ([JobScope.Scoped.linked]
 *    false) is on no job, and correctly has everything hidden.
 *
 * Never plans a write it does not need: [JobHoldPlan.unhideAll] only when a
 * job is actually held, and each set only rows that would change -- a pass
 * that decides what the last one decided writes nothing, so the Room change
 * feed (Repository.observeAnyChange) does not wake another pass.
 *
 * Pure on purpose, so JobHoldPlanTest holds it to all of that.
 */
internal fun planJobHolds(
    local: List<com.fenceestimator.app.data.Job>,
    cloud: List<CloudJob>,
    moneyScope: MoneyScope,
    jobScope: JobScope
): JobHoldPlan {
    val anyHeld = local.any { it.accessEndedAt != null }
    val everything = if (anyHeld) JobHoldPlan(unhideAll = true) else JobHoldPlan()
    if (moneyScope == MoneyScope.UNKNOWN) return JobHoldPlan()
    if (moneyScope == MoneyScope.ALLOWED) return everything
    return when (jobScope) {
        JobScope.Unknown -> JobHoldPlan()
        JobScope.NotDeployed, JobScope.SeesAll -> everything
        is JobScope.Scoped -> {
            if (jobScope.visible > 0 && cloud.none { it.deletedAt == null }) return JobHoldPlan()
            val arriving = cloud.mapTo(HashSet()) { it.syncId }
            JobHoldPlan(
                hide = local.filter {
                    it.accessEndedAt == null && it.syncId !in arriving &&
                        (it.lastSyncedAt != null || it.crewBase != null)
                }.mapTo(HashSet()) { it.syncId },
                unhide = local.filter { it.accessEndedAt != null && it.syncId in arriving }
                    .mapTo(HashSet()) { it.syncId }
            )
        }
    }
}

/**
 * Whether [error] is the server refusing a delete this account may not make
 * (enforce_delete_permission's "Deleting needs the delete permission") --
 * final, unlike no signal or a timeout. Matched on the text through the
 * cause chain, the way isNotOursToSync is: the refusal arrives through
 * several layers with no common type.
 */
internal fun isDeletePermissionRefusal(error: Throwable?): Boolean =
    error != null && generateSequence(error) { it.cause }
        .any { it.message?.contains("Deleting needs the delete permission", ignoreCase = true) == true }

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
    // priced_by / priced_at / pricing_engine_version / quote_sent_at /
    // production_stage / accepted_total are deliberately NOT wired in here --
    // they stay at CloudJob's defaults on this object, and every one of those
    // defaults is null. `explicitNulls = false` (SyncJson) drops a field left
    // at a NULL default from the payload entirely rather than sending an
    // explicit null -- but it does nothing for a non-null default: priced_by
    // and pricing_engine_version defaulted to "" until 2026-09-21 and so WERE
    // sent, as blanks, on every push (see CloudJob.pricedBy). Leaving
    // production_stage off here is what keeps crew_save_job's dynamic UPDATE
    // from touching that column at all. Those are quiet-clock bookkeeping the
    // OFFICE (or, for production_stage, the set_production_stage RPC) writes;
    // this function backs every ordinary row push (a phone number, a note,
    // a new job), and if it sent this phone's cached copy of them, an
    // unrelated edit would stamp blank/APP-shaped values over a real office
    // price the moment `encodeDefaults = true` serialized this whole object.
    // The one place allowed to touch them is the contract_total push block
    // in JobSync.sync(), which either omits them (a brand new job, correctly
    // blank) or explicitly carries the cloud's own current values forward on
    // an ordinary update (see the `payload` build there). accepted_total has
    // no writer on the phone at all: the server stamps it at acceptance.
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
 *
 * @param keepMoney True when [cloudJob][this] arrived through the money-free
 *   door (`jobs_crew`): every [MONEY_KEYS] field decoded onto it is that
 *   view's absent-column default, not a real answer, and taking it here would
 *   be the exact 25-to-0 shape of loss this whole feature exists to stop.
 *   [local]'s own value is kept instead for every one of them; everything
 *   else in the row still comes down as usual.
 */
internal fun CloudJob.mergeOnto(local: Job, keepMoney: Boolean = false): Job = local.copy(
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
    taxRatePercent = if (keepMoney) local.taxRatePercent else taxRatePercent,
    markupPercent = if (keepMoney) local.markupPercent else markupPercent,
    discountPercent = if (keepMoney) local.discountPercent else discountPercent,
    laborRatePerFt = if (keepMoney) local.laborRatePerFt else laborRatePerFt,
    laborFlatFee = if (keepMoney) local.laborFlatFee else laborFlatFee,
    minimumJobCharge = if (keepMoney) local.minimumJobCharge else (minimumJobCharge ?: local.minimumJobCharge),
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
    teardownFlatFee = if (keepMoney) local.teardownFlatFee else teardownFlatFee,
    teardownRatePerFt = if (keepMoney) local.teardownRatePerFt else teardownRatePerFt,
    teardownFeet = teardownFeet,
    gateRatePerFt = if (keepMoney) local.gateRatePerFt else (gateRatePerFt ?: local.gateRatePerFt),
    trashHaulFee = if (keepMoney) local.trashHaulFee else (trashHaulFee ?: local.trashHaulFee),
    pricingTierName = if (keepMoney) local.pricingTierName else pricingTierName.ifBlank { local.pricingTierName },
    tipAmount = if (keepMoney) local.tipAmount else (tipAmount ?: local.tipAmount),
    gridFeetPerSquare = if (gridFeetPerSquare > 0f) gridFeetPerSquare else local.gridFeetPerSquare,
    calibrationPixelsPerFoot = calibrationPixelsPerFoot ?: local.calibrationPixelsPerFoot,
    calibrationKnownFeet = calibrationKnownFeet ?: local.calibrationKnownFeet,
    supplierQuoteReference = if (keepMoney) local.supplierQuoteReference else supplierQuoteReference.ifBlank { local.supplierQuoteReference },
    durationManuallySet = durationManuallySet,
    paymentLinkUrl = if (keepMoney) local.paymentLinkUrl else paymentLinkUrl.ifBlank { local.paymentLinkUrl },
    paymentLinkAmount = if (keepMoney) local.paymentLinkAmount else (if (paymentLinkAmount > 0.0) paymentLinkAmount else local.paymentLinkAmount),
    surveyStoragePath = surveyStoragePath ?: local.surveyStoragePath,
    signatureStoragePath = signatureStoragePath ?: local.signatureStoragePath,
    finalSignOffStoragePath = finalSignOffStoragePath ?: local.finalSignOffStoragePath,
    depositAmount = if (keepMoney) local.depositAmount else depositAmount,
    // Money that cleared is still never allowed to go backwards, even on a
    // branch where the cloud row is unambiguously newer.
    // Both are caches of the ledger, so the cloud value is taken as-is and
    // then recomputed from the rows after the ledger syncs. Keeping the larger
    // of the two is what pinned a stale figure permanently high.
    //
    // Through the money-free door these two decode to CloudJob's bare zero,
    // which is not "the ledger says zero" -- it is "this door carries no
    // ledger figure at all" -- so keepMoney holds the phone's own cache
    // instead of letting a real paid amount read as refunded to nothing.
    amountPaid = if (keepMoney) local.amountPaid else JobSync.ledgerBackedAmountPaid(amountPaid),
    refundedAmount = if (keepMoney) local.refundedAmount else JobSync.ledgerBackedAmountPaid(refundedAmount),
    refundedAt = if (keepMoney) local.refundedAt else (CloudTime.parseMillis(refundedAt) ?: local.refundedAt),
    signedAt = CloudTime.parseMillis(signedAt) ?: local.signedAt,
    quoteApprovedAt = CloudTime.parseMillis(quoteApprovedAt) ?: local.quoteApprovedAt,
    quoteApprovedName = quoteApprovedName.ifBlank { local.quoteApprovedName },
    reapprovalRequiredAt = CloudTime.parseMillis(reapprovalRequiredAt),
    reapprovalReason = reapprovalReason,
    reapprovalCount = reapprovalCount,
    finalSignOffAt = CloudTime.parseMillis(finalSignOffAt) ?: local.finalSignOffAt,
    blockedAt = CloudTime.parseMillis(blockedAt) ?: local.blockedAt,
    customerNotifiedAt = CloudTime.parseMillis(customerNotifiedAt) ?: local.customerNotifiedAt,
    materialPricesConfirmedAt = CloudTime.parseMillis(materialPricesConfirmedAt) ?: local.materialPricesConfirmedAt,
    locateCalledAt = CloudTime.parseMillis(locateCalledAt) ?: local.locateCalledAt,
    locateDigAfter = CloudTime.parseMillis(locateDigAfter) ?: local.locateDigAfter,
    locateExpiresAt = CloudTime.parseMillis(locateExpiresAt) ?: local.locateExpiresAt,
    refundReason = if (keepMoney) local.refundReason else refundReason.ifBlank { local.refundReason },
    // Latches on. Once a processor has reported money, hand-editing the figure
    // stays shut off even if an older row says otherwise. keepMoney holds the
    // local value too -- the door carrying no answer must not silently
    // unlatch something a real payment already locked.
    paymentsFromProcessor = if (keepMoney) local.paymentsFromProcessor else (paymentsFromProcessor || local.paymentsFromProcessor),
    signedContractTotal = if (keepMoney) local.signedContractTotal else signedContractTotal,
    signedLinearFeet = signedLinearFeet,
    // The server is its only writer, so a real figure is taken as-is; a null
    // is "not stamped yet" (see acceptedTotalToAdopt), never a reason to drop
    // a figure a drawn signature froze here before its push landed. Through
    // the money-free door it is always null, so keepMoney holds it too.
    acceptedTotal = if (keepMoney) local.acceptedTotal else (acceptedTotal ?: local.acceptedTotal),
    paymentStatus = if (keepMoney) local.paymentStatus else runCatching { PaymentStatus.valueOf(paymentStatus) }.getOrDefault(local.paymentStatus),
    isInvoiced = if (keepMoney) local.isInvoiced else isInvoiced,
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
    pricedBy = pricedBy?.ifBlank { null } ?: local.pricedBy,
    pricedAt = CloudTime.parseMillis(pricedAt) ?: local.pricedAt,
    pricingEngineVersion = pricingEngineVersion?.ifBlank { null } ?: local.pricingEngineVersion,
    quoteSentAt = CloudTime.parseMillis(quoteSentAt) ?: local.quoteSentAt,
    // The server is the only writer of a real value here, so take it as-is --
    // same as the amountPaid bypass branch in JobSync.sync(), this is a quiet
    // clock the RPC can move without bumping updated_at, so a merge that only
    // ran because some OTHER field changed must still carry the current
    // stage down rather than leaving the phone on whatever it had cached.
    productionStage = productionStage,
    updatedAt = updatedAtMillis(),
    // The row now IS the cloud's copy as of that clock, so this phone and the
    // cloud agree on it -- see [jobHoldsUnpushedEdit]. Only reached when the
    // cloud row is newer than the local one, i.e. when any local edit has just
    // lost to it anyway, so this never vouches for an edit still owed.
    lastSyncedAt = updatedAtMillis()
)

/**
 * The lastSyncedAt a job already on this phone should now carry, when its row
 * is provably the cloud's own copy, untouched since it was pulled -- or null
 * when there is nothing to repair or nothing can be vouched for.
 *
 * "Provably": [local]'s updatedAt equals the cloud's updated_at to the
 * millisecond. A pull writes exactly that value (toLocalJob, mergeOnto), and
 * every local edit replaces it with the device clock at the moment of the edit
 * (Repository.updateJob), so a job anyone has touched here fails the test --
 * and stays counted as unsynced, which is the point of the count.
 *
 * Exists for the jobs pulled before the pull stamped anything, which carry no
 * stamp at all and so counted as unsynced work on every phone for ever.
 */
internal fun pulledCopySyncStamp(local: Job, cloudUpdatedAt: Long): Long? {
    // 0 is updatedAtMillis()'s "could not read the cloud's clock" -- never a
    // basis for saying two copies agree.
    if (cloudUpdatedAt <= 0L) return null
    if (local.updatedAt != cloudUpdatedAt) return null
    val stamped = local.lastSyncedAt
    return if (stamped == null || stamped < local.updatedAt) local.updatedAt else null
}

/**
 * A job the cloud has and this phone does not, as this phone will hold it.
 *
 * Stamped as in step with the cloud ([Job.lastSyncedAt] = the cloud's
 * updated_at, which is also its updatedAt), because it is: nothing on this
 * phone has touched it yet. Without the stamp a job the office created counted
 * as unsynced work here for ever -- see [jobHoldsUnpushedEdit].
 *
 * Internal, not private, so a test can hold the stamp to that.
 */
internal fun CloudJob.toLocalJob(): Job = Job(
    syncId = syncId,
    customerName = customerName,
    address = address,
    phone = phone,
    email = email,
    notes = notes,
    status = runCatching { JobStatus.valueOf(status) }.getOrDefault(JobStatus.DRAFT),
    // Missing from this list, a freshly pulled job took Job's default -- the
    // moment of the pull -- and the phone's next ordinary edit sent that back
    // as created_at, so creation dates drifted forward to whenever a phone
    // first saw the job (4598150b: 2026-08-18 became 09-18). mergeOnto always
    // mapped it; only the first-pull path did not.
    createdAt = CloudTime.parseMillis(createdAt) ?: System.currentTimeMillis(),
    productionStage = productionStage,
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
    reapprovalRequiredAt = CloudTime.parseMillis(reapprovalRequiredAt),
    reapprovalReason = reapprovalReason,
    reapprovalCount = reapprovalCount,
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
    acceptedTotal = acceptedTotal,
    paymentStatus = runCatching { PaymentStatus.valueOf(paymentStatus) }.getOrDefault(PaymentStatus.UNPAID),
    isInvoiced = isInvoiced,
    hoaName = hoaName,
    hoaEmail = hoaEmail,
    hoaApprovalStatus = runCatching { HoaApprovalStatus.valueOf(hoaApprovalStatus) }.getOrDefault(HoaApprovalStatus.NOT_REQUIRED),
    permitNumber = permitNumber,
    permitStatus = runCatching { PermitStatus.valueOf(permitStatus) }.getOrDefault(PermitStatus.NOT_REQUIRED),
    buildTemplateSyncId = buildTemplateSyncId,
    pricedBy = pricedBy.orEmpty(),
    pricedAt = CloudTime.parseMillis(pricedAt),
    pricingEngineVersion = pricingEngineVersion.orEmpty(),
    quoteSentAt = CloudTime.parseMillis(quoteSentAt),
    updatedAt = updatedAtMillis(),
    lastSyncedAt = updatedAtMillis()
)

/**
 * What `crew_save_job`'s `row_in` should carry: `sync_id` plus the
 * [CREW_WRITABLE_JOB_KEYS] present on [cloudJob] -- and the
 * [CREW_SCHEDULER_JOB_KEYS] too when [mayReschedule] -- and nothing else.
 *
 * It used to be "every field minus [MONEY_KEYS]", which sent this phone's
 * whole copy of the row. crew_save_job wrote every key it was given, so a
 * crew phone blanked the office's notes, HOA and permit details with its older
 * copy, and stamped priced_by = '' over a real pricing record; and a customer
 * name typed into the crew phone's (then editable) Customer card went up too,
 * was quietly put back by protect_customer_identity, but still moved
 * updated_at -- so the next pull wrote the server's blank name over the phone
 * while the job was open. The server now applies the same allowlist
 * (crew_writable_job_columns()); this keeps the phone from asserting anything
 * the server would drop, which is also what keeps an unsent field from ever
 * being mistaken for a change.
 *
 * `status` travels only as COMPLETED, the one move crew may make: a stale
 * local DRAFT or ACCEPTED must never roll a job back, and the server drops
 * any other value anyway.
 *
 * @param onlyKeys the columns this phone changed since it last took the
 *   cloud's copy ([crewChangedKeys]); only those travel. Null when there is
 *   no snapshot to tell from (a job pulled before snapshots existed), and
 *   then every allowlisted column goes, as it did before. A changed column
 *   whose value is now null is sent as an explicit null -- SyncJson drops a
 *   Kotlin null, so clearing a locate date or a blocked time never reached
 *   the office otherwise.
 *
 * Pure on purpose, so JobSyncCrewDoorTest can hold it to all of that without
 * a Supabase client or a coroutine in sight.
 */
internal fun buildCrewSaveJobPayload(
    cloudJob: CloudJob,
    mayReschedule: Boolean = false,
    onlyKeys: Set<String>? = null
): JsonObject {
    val full = SyncJson.encodeToJsonElement(CloudJob.serializer(), cloudJob).jsonObject
    val writable = if (mayReschedule) CREW_WRITABLE_JOB_KEYS + CREW_SCHEDULER_JOB_KEYS else CREW_WRITABLE_JOB_KEYS
    val sent = full.filter { (key, value) ->
        when {
            key == "sync_id" -> true
            key !in writable || key in MONEY_KEYS -> false
            onlyKeys != null && key !in onlyKeys -> false
            key == "status" -> (value as? JsonPrimitive)?.content == JobStatus.COMPLETED.name
            else -> true
        }
    }
    val cleared = onlyKeys.orEmpty()
        .filter { it in writable && it !in MONEY_KEYS && it != "status" && it !in full }
        .associateWith { JsonNull }
    return JsonObject(sent + cleared)
}

/**
 * Keys a job snapshot never carries: identity and the server's own clocks,
 * which say nothing about what anybody edited.
 */
private val SNAPSHOT_SKIPPED_KEYS = setOf("sync_id", "company_id", "created_at", "updated_at", "deleted_at")

/**
 * What [job] serializes to as a push would send it -- [Job.toCloud] through
 * SyncJson -- with the money keys and [SNAPSHOT_SKIPPED_KEYS] left out.
 *
 * Built from the phone's own row, never from the cloud's JSON, so a snapshot
 * recorded when the cloud's copy was taken (Job.crewBase) and one taken at the
 * next push differ only where this phone changed something: timestamps come
 * out formatted the same way both times, and a field the merge keeps from the
 * local row (a location, a calibration) is the same value on both sides.
 */
internal fun jobSyncSnapshot(
    job: Job,
    companyId: String,
    assignedEmployeeSyncId: String?,
    preferredManufacturerSyncId: String?
): JsonObject {
    val full = SyncJson.encodeToJsonElement(
        CloudJob.serializer(),
        job.toCloud(companyId, null, assignedEmployeeSyncId, preferredManufacturerSyncId)
    ).jsonObject
    return JsonObject(full.filterKeys { it !in MONEY_KEYS && it !in SNAPSHOT_SKIPPED_KEYS })
}

internal fun encodeSnapshot(snapshot: JsonObject): String = SyncJson.encodeToString(JsonObject.serializer(), snapshot)

/** Null for no snapshot, or one that does not parse -- both mean "cannot tell what changed". */
internal fun decodeSnapshot(stored: String?): JsonObject? =
    stored?.let { runCatching { SyncJson.parseToJsonElement(it).jsonObject }.getOrNull() }

/**
 * The columns [current] differs from [base] in -- what this phone changed
 * since it last took the cloud's copy. A column present on one side only
 * (a value cleared to null, or set from null) counts. Null when there is no
 * [base] to compare with.
 */
internal fun crewChangedKeys(current: JsonObject, base: JsonObject?): Set<String>? =
    base?.let { b -> (current.keys + b.keys).filterTo(HashSet<String>()) { current[it] != b[it] } }

/**
 * What a crew phone changed on a job without an earlier snapshot to compare
 * with -- a job pulled before this build -- is judged on these alone: the
 * text fields the old, editable Customer card and HOA and permit section let
 * crew type into, which crew_save_job now drops. Anything else a phone that
 * old changed went up with the allowlist.
 */
internal val CREW_UPGRADE_TEXT_KEYS: Set<String> = setOf(
    "customer_name", "address", "phone", "email", "notes", "referral_source",
    "hoa_name", "hoa_email", "hoa_approval_status", "permit_number", "permit_status"
)

/**
 * The edits a crew push could not carry, as column to the value this phone
 * had, for a note to the office ([FieldChange], isRequest).
 *
 * @param current this phone's row as pushed ([jobSyncSnapshot]).
 * @param base the snapshot it was diffed against, or null (see [CREW_UPGRADE_TEXT_KEYS]).
 * @param returned the row as the server holds it now, as adopted.
 * @param sent the keys crew_save_job was given.
 * @return only columns the server does not already hold at this phone's
 *   value -- the office typing the same thing is not news -- in column order.
 */
internal fun unsentCrewEdits(
    current: JsonObject,
    base: JsonObject?,
    returned: JsonObject,
    sent: Set<String>
): Map<String, String> {
    val candidates = if (base != null) crewChangedKeys(current, base).orEmpty() else CREW_UPGRADE_TEXT_KEYS
    return candidates
        .filter { it !in sent && it !in SNAPSHOT_SKIPPED_KEYS && current[it] != returned[it] }
        .sorted()
        .associateWith { key -> displayValue(current[key]) }
}

/** A JSON value as a person reads it: the text of a string, a dash for nothing at all. */
private fun displayValue(value: JsonElement?): String = when (value) {
    null, JsonNull -> "—"
    is JsonPrimitive -> value.content.ifBlank { "—" }
    else -> value.toString()
}

/**
 * What the job row on this phone should become once [pushed] has been written
 * to the cloud and the cloud has handed back [returned] -- or null when the
 * returned row carries no readable clock and nothing can be vouched for.
 *
 * @param pushed the copy that was serialized and sent.
 * @param current the row as it is now, re-read inside the same transaction.
 *
 * Nothing edited since the push was built ([current]'s updatedAt still equals
 * [pushed]'s): the returned row is merged on, exactly as a pull would merge it
 * (mergeOnto), so both clocks take the server's updated_at and every value a
 * trigger changed comes down with it. That is what lets collectJobChildRows see
 * "not newer in the cloud" and push this job's line items in the same pass,
 * instead of pulling older ones over them. See JobSync.adoptPushedRow.
 *
 * Edited while the push was in flight: that edit has not been sent, so it must
 * neither be overwritten nor vouched for. Nothing from [returned] is taken;
 * lastSyncedAt records only what was actually pushed (jobHoldsUnpushedEdit
 * stays true), and updatedAt is kept strictly newer than the server's clock,
 * so the next pass pushes the edit rather than pulling the cloud's copy over
 * it -- a device clock running behind the server would otherwise let the pull
 * win.
 *
 * Pure, so the rule is held to a test without Room or a network.
 */
internal fun jobAfterPush(pushed: Job, current: Job, returned: CloudJob, keepMoney: Boolean): Job? {
    val serverClock = returned.updatedAtMillis()
    if (serverClock <= 0L) return null
    return if (current.updatedAt == pushed.updatedAt) {
        returned.mergeOnto(current, keepMoney)
    } else {
        current.copy(
            updatedAt = maxOf(current.updatedAt, serverClock + 1),
            lastSyncedAt = pushed.updatedAt
        )
    }
}

/**
 * The accepted_total the pull should write onto the phone, or null to leave
 * it alone. Only a real figure from the cloud that differs from the phone's:
 * a null there means "not stamped" (or a database without the column yet),
 * never "the customer un-accepted", and must not erase a figure a drawn
 * signature froze on this phone before its push has landed.
 */
internal fun acceptedTotalToAdopt(local: Double?, cloud: Double?): Double? {
    if (cloud == null) return null
    if (local != null && kotlin.math.abs(local - cloud) <= 0.005) return null
    return cloud
}

/**
 * "2026.09.10" is newer than "2026.09.9", which a string comparison denies
 * the moment a patch number reaches two digits. Compared component by
 * component as integers; a missing component counts as zero, and anything
 * that is not a number sorts as zero rather than throwing on a phone.
 */
internal fun engineVersionIsNewer(candidate: String, baseline: String): Boolean {
    val a = candidate.trim().split('.').map { it.toIntOrNull() ?: 0 }
    val b = baseline.trim().split('.').map { it.toIntOrNull() ?: 0 }
    for (i in 0 until maxOf(a.size, b.size)) {
        val x = a.getOrElse(i) { 0 }
        val y = b.getOrElse(i) { 0 }
        if (x != y) return x > y
    }
    return false
}
