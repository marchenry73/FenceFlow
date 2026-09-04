package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.AluminumStyle
import com.fenceestimator.app.data.WoodStyle
import com.fenceestimator.app.data.ChangeOrder
import com.fenceestimator.app.data.Employee
import com.fenceestimator.app.data.EstimateLineItem
import com.fenceestimator.app.data.Expense
import com.fenceestimator.app.data.ExpenseCategory
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.JobStep
import com.fenceestimator.app.data.JobStepKind
import com.fenceestimator.app.data.Manufacturer
import com.fenceestimator.app.data.MaterialCategory
import com.fenceestimator.app.data.MaterialItem
import com.fenceestimator.app.data.MaterialRole
import com.fenceestimator.app.data.PayType
import com.fenceestimator.app.data.PricingTier
import com.fenceestimator.app.data.PunchListItem
import com.fenceestimator.app.data.FieldChange
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.data.SiteMarker
import com.fenceestimator.app.data.SiteMarkerKind
import com.fenceestimator.app.data.TimeEntry
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.time.Instant

/**
 * Excludes rows that were deleted somewhere else.
 *
 * Every pull needs this and none of them had it. Deleting anything other than a
 * job wrote a tombstone to the cloud and removed the local row, DeletionReaper
 * dutifully removed it on the other devices -- and then the very next pull, in
 * the same sync pass, read the tombstoned row back and re-inserted it because
 * it was no longer present locally. Delete, reap, resurrect, on a loop, which
 * is why deleted change orders kept reappearing on opening a job.
 *
 * Not used by the payments ledger, which needs to see tombstones: it works out
 * what to push by comparing against the cloud list, so hiding deleted rows
 * would make it re-upload deleted payments. It filters them in Kotlin instead.
 */
/** At most this many sync requests in flight at once; see the reap and pullAll. */
private val netGate = kotlinx.coroutines.sync.Semaphore(4)

private fun io.github.jan.supabase.postgrest.query.filter.PostgrestFilterBuilder.notDeleted() =
    filter("deleted_at", io.github.jan.supabase.postgrest.query.filter.FilterOperator.IS, "null")

/* ---------------- wire shapes ---------------- */

@Serializable
data class CloudEmployee(
    @SerialName("company_id") val companyId: String,
    @SerialName("sync_id") val syncId: String,
    val name: String = "",
    val role: String = "",
    val phone: String = "",
    val email: String = "",
    val notes: String = "",
    @SerialName("hourly_rate") val hourlyRate: Double = 0.0,
    // Pay arrangement. Without these a crew member paid by the foot arrived
    // elsewhere as hourly, at whatever their hourly field happened to hold.
    @SerialName("pay_type") val payType: String = "HOURLY",
    @SerialName("per_foot_rate") val perFootRate: Double = 0.0,
    // Whether they are still on the crew, and which account is theirs.
    @SerialName("is_active") val isActive: Boolean = true,
    @SerialName("deactivated_at") val deactivatedAt: String? = null,
    @SerialName("profile_id") val profileId: String? = null
)

@Serializable
data class CloudManufacturer(
    @SerialName("company_id") val companyId: String,
    @SerialName("sync_id") val syncId: String,
    val name: String = "",
    val email: String = "",
    val phone: String = "",
    val address: String = "",
    val hours: String = "",
    val notes: String = ""
)

@Serializable
data class CloudFenceRun(
    @SerialName("company_id") val companyId: String,
    @SerialName("sync_id") val syncId: String,
    @SerialName("job_sync_id") val jobSyncId: String,
    val label: String = "",
    @SerialName("fence_type") val fenceType: String = "VINYL",
    @SerialName("color_or_finish") val colorOrFinish: String = "",
    @SerialName("points_encoded") val pointsEncoded: String = "",
    @SerialName("gates_encoded") val gatesEncoded: String = "",
    @SerialName("closed_loop") val closedLoop: Boolean = false,
    @SerialName("is_teardown") val isTeardown: Boolean = false,
    @SerialName("panel_width_ft") val panelWidthFt: Float = 6f,
    @SerialName("panel_height_ft") val panelHeightFt: Float = 6f,
    @SerialName("post_spacing_ft") val postSpacingFt: Float = 6f,
    @SerialName("concrete_bags_per_post") val concreteBagsPerPost: Float = 1f,
    @SerialName("manual_linear_feet") val manualLinearFeet: Float? = null,
    @SerialName("manual_corner_count") val manualCornerCount: Int = 0,
    @SerialName("suppressed_roles") val suppressedRolesCsv: String = "",
    // The run specification. Absent until now, so a run arrived on another
    // phone carrying its outline and the default spec for its fence type --
    // and the two phones then computed different material takeoffs from it.
    @SerialName("sort_order") val sortOrder: Int = 0,
    @SerialName("aluminum_style") val aluminumStyle: String = "RACKABLE",
    @SerialName("wood_style") val woodStyle: String = "PRIVACY",
    @SerialName("wood_rail_count") val woodRailCount: Int = 3,
    @SerialName("picket_width_in") val picketWidthIn: Float = 5.5f,
    @SerialName("picket_gap_in") val picketGapIn: Float = 0f,
    @SerialName("fabric_height_ft") val fabricHeightFt: Float = 4f,
    @SerialName("include_top_rail") val includeTopRail: Boolean = true,
    @SerialName("include_tension_wire") val includeTensionWire: Boolean = false,
    @SerialName("include_barbed_wire_arms") val includeBarbedWireArms: Boolean = false,
    @SerialName("include_privacy_slats") val includePrivacySlats: Boolean = false,
    @SerialName("split_rail_count") val splitRailCount: Int = 2
)

@Serializable
data class CloudLineItem(
    @SerialName("company_id") val companyId: String,
    @SerialName("sync_id") val syncId: String,
    @SerialName("job_sync_id") val jobSyncId: String,
    /**
     * Which fence run this line belongs to. Without it every line item pulled
     * from the cloud landed under "Other Items" as an orphan, sitting alongside
     * the real ones -- which is where the stray items nobody could explain came
     * from.
     */
    @SerialName("fence_run_sync_id") val fenceRunSyncId: String? = null,
    @SerialName("sort_order") val sortOrder: Int = 0,
    val description: String = "",
    val quantity: Double = 0.0,
    val unit: String = "EA",
    @SerialName("unit_price") val unitPrice: Double = 0.0,
    val taxable: Boolean = true,
    val role: String? = null,
    @SerialName("auto_generated") val autoGenerated: Boolean = false,
    /**
     * What the supplier charges, as against what the customer is quoted.
     * Nullable on purpose: null means not quoted separately, which is a
     * different statement from quoted at zero.
     */
    @SerialName("supplier_unit_price") val supplierUnitPrice: Double? = null
)

/**
 * The crew list without the pay. What crew_roster() returns.
 *
 * Mapped onto CloudEmployee so the rest of the sync does not have to care
 * which source it came from -- the pay fields simply stay at their defaults,
 * which is the point.
 */
@Serializable
data class CrewRosterRow(
    val id: String,
    @SerialName("sync_id") val syncId: String,
    val name: String = "",
    val role: String = "",
    @SerialName("is_active") val isActive: Boolean = true,
) {
    fun asEmployee(companyId: String) = CloudEmployee(
        companyId = companyId,
        syncId = syncId,
        name = name,
        role = role,
        isActive = isActive,
    )
}

@Serializable
data class CloudExpense(
    @SerialName("company_id") val companyId: String,
    @SerialName("sync_id") val syncId: String,
    @SerialName("job_sync_id") val jobSyncId: String,
    val category: String = "OTHER",
    val description: String = "",
    val amount: Double = 0.0
)

@Serializable
/** A plan change or note from the field, with the office's answer. */
data class CloudFieldChange(
    @SerialName("company_id") val companyId: String,
    @SerialName("sync_id") val syncId: String,
    @SerialName("job_sync_id") val jobSyncId: String,
    val summary: String = "",
    val detail: String = "",
    @SerialName("changed_by") val changedBy: String = "",
    @SerialName("changed_by_role") val changedByRole: String = "",
    val at: String,
    @SerialName("acknowledged_at") val acknowledgedAt: String? = null,
    @SerialName("is_request") val isRequest: Boolean = false,
    @SerialName("approved_at") val approvedAt: String? = null,
    @SerialName("rejected_at") val rejectedAt: String? = null,
    @SerialName("decided_by") val decidedBy: String = "",
    @SerialName("decision_note") val decisionNote: String = "",
    @SerialName("deleted_at") val deletedAt: String? = null
)

@Serializable
data class CloudPunchItem(
    @SerialName("company_id") val companyId: String,
    @SerialName("sync_id") val syncId: String,
    @SerialName("job_sync_id") val jobSyncId: String,
    val description: String = "",
    val resolved: Boolean = false
)

@Serializable
data class CloudChangeOrder(
    @SerialName("company_id") val companyId: String,
    @SerialName("sync_id") val syncId: String,
    @SerialName("job_sync_id") val jobSyncId: String,
    val description: String = "",
    @SerialName("additional_feet") val additionalFeet: Double = 0.0,
    @SerialName("additional_cost") val additionalCost: Double = 0.0,
    @SerialName("material_cost") val materialCost: Double = 0.0,
    @SerialName("signed_at") val signedAt: String? = null
)

@Serializable
data class CloudJobStep(
    @SerialName("company_id") val companyId: String,
    @SerialName("sync_id") val syncId: String,
    @SerialName("job_sync_id") val jobSyncId: String,
    val kind: String = "INSTALL",
    val description: String = "",
    val checked: Boolean = false,
    @SerialName("verified_with_customer") val verifiedWithCustomer: Boolean = false,
    @SerialName("sort_order") val sortOrder: Int = 0,
    /**
     * When the step was ticked.
     *
     * Without it the two sides carried a bare true/false and nothing could say
     * which was more recent -- so a tick saved on the phone was overwritten by
     * the cloud false on the next pull, and the push after that uploaded the
     * false. The tick could never reach the cloud and always reverted.
     */
    @SerialName("completed_at") val completedAt: String? = null
)

@Serializable
data class CloudSiteMarker(
    @SerialName("company_id") val companyId: String,
    @SerialName("sync_id") val syncId: String,
    @SerialName("job_sync_id") val jobSyncId: String,
    val kind: String = "OBSTACLE",
    val x: Float = 0f,
    val y: Float = 0f,
    val label: String = ""
)

@Serializable
data class CloudMaterialItem(
    @SerialName("company_id") val companyId: String,
    @SerialName("sync_id") val syncId: String,
    val name: String = "",
    val category: String = "MISC",
    val role: String = "NONE",
    @SerialName("fence_type") val fenceType: String = "UNIVERSAL",
    @SerialName("color_or_finish") val colorOrFinish: String = "",
    val unit: String = "EA",
    @SerialName("unit_price") val unitPrice: Double = 0.0,
    val taxable: Boolean = true,
    @SerialName("covers_ft") val coversFt: Float? = null,
    @SerialName("is_active") val isActive: Boolean = true,
    @SerialName("source_doc") val sourceDoc: String = "",
    // Never set on push -- the touch_updated_at trigger owns this column, the
    // same as jobs.updated_at. Only read, on pull, to arbitrate which side of
    // an edit is newer.
    @SerialName("updated_at") val updatedAt: String? = null
) {
    /** See [CloudJob.updatedAtMillis]: falls back to 0 so an absent value never outranks real local work. */
    fun updatedAtMillis(): Long = CloudTime.parseMillis(updatedAt) ?: 0L
}

@Serializable
data class CloudPricingTier(
    @SerialName("company_id") val companyId: String,
    @SerialName("sync_id") val syncId: String,
    val name: String = "",
    @SerialName("labor_rate_per_ft") val laborRatePerFt: Double = 0.0,
    @SerialName("labor_flat_fee") val laborFlatFee: Double = 0.0,
    @SerialName("markup_percent") val markupPercent: Double = 0.0,
    @SerialName("discount_percent") val discountPercent: Double = 0.0,
    @SerialName("sort_order") val sortOrder: Int = 0,
    // Never set on push -- the touch_updated_at trigger owns this column, the
    // same as jobs.updated_at. Only read, on pull, to arbitrate which side of
    // an edit is newer.
    @SerialName("updated_at") val updatedAt: String? = null
) {
    /** See [CloudJob.updatedAtMillis]: falls back to 0 so an absent value never outranks real local work. */
    fun updatedAtMillis(): Long = CloudTime.parseMillis(updatedAt) ?: 0L
}

@Serializable
data class CloudTimeEntry(
    @SerialName("company_id") val companyId: String,
    @SerialName("sync_id") val syncId: String,
    @SerialName("job_sync_id") val jobSyncId: String,
    @SerialName("started_at") val startedAt: String,
    @SerialName("ended_at") val endedAt: String? = null,
    @SerialName("hourly_rate") val hourlyRate: Double = 0.0,
    /**
     * Whose shift. Was never sent, so payroll on the website could not group by
     * person.
     *
     * Not nullable, and that is the whole point. The column is NOT NULL with a
     * default of '', but a default only applies to a column the insert leaves
     * out -- and PostgREST names every column explicitly when it sends a batch,
     * so a row merely MISSING the key arrives as an explicit null and is
     * rejected. One shift with nobody attached therefore took the entire
     * batch down with it, every sync: no shift uploaded, no approval uploaded,
     * and "could not sync" on screen. Empty string is what a shift with no
     * employee has always meant here, so say it rather than omit it.
     */
    @SerialName("employee_sync_id") val employeeSyncId: String = "",
    val notes: String = "",
    /**
     * Approval has to travel with the shift.
     *
     * Without these the cloud row could not carry it, so any device pulling a
     * shift it did not already hold recreated it as pending -- hours that had
     * been signed off came back unapproved, which reads as the approval not
     * having saved. Verified in live data: an approved local shift sat in the
     * cloud with approved_at null.
     */
    @SerialName("approved_at") val approvedAt: String? = null,
    @SerialName("approved_by") val approvedBy: String = "",
    @SerialName("rejected_at") val rejectedAt: String? = null,
    @SerialName("review_note") val reviewNote: String = ""
)

/**
 * Pushes the app's non-job records to the cloud so the office website can see
 * them. This is the piece that was missing -- a crew member added on a phone
 * existed only on that phone, which is exactly why they never showed up on the
 * website.
 *
 * Upserts on (company_id, sync_id), so running it repeatedly is safe and never
 * creates duplicates. Deliberately push-only for now: the phone stays the
 * source of truth for these while the web side is still read-mostly, which
 * avoids a half-built two-way merge quietly overwriting field data.
 */
object EntitySync {

    /**
     * One table failing must not stop the six behind it.
     *
     * These used to run inside a single runCatching, one after another, with
     * employees first. So the moment the server refused a crew phone's
     * employee push -- which it does now, correctly, because pay is office
     * information -- manufacturers, fence runs, time entries, the catalog,
     * pricing tiers and every job child were skipped too. The phone stopped
     * syncing altogether and said "Could not sync: new row violates row-level
     * security policy". A crew member's whole day of field work sat on their
     * handset because of a table they should never have been sending.
     *
     * Each table stands alone now. A refusal is a skip: the server saying this
     * one is not yours, which is not a failure and is not worth telling anyone
     * about. Anything else is collected and reported once, after everything
     * that CAN go up has gone up.
     */
    suspend fun pushAll(repository: Repository, companyId: String): Result<Int> =
        withContext(Dispatchers.IO) {
            var pushed = 0
            var skipped = 0
            var firstRealFailure: Throwable? = null

            suspend fun step(what: String, block: suspend () -> Int) {
                val r = runCatching { block() }
                r.onSuccess { pushed += it }
                r.onFailure { e ->
                    if (isNotOursToSync(e)) {
                        // Skipped, not failed -- but NOT nothing.
                        //
                        // Treating a refusal as a clean success is how a crew
                        // member's plan-change requests vanished while the
                        // phone said "Everything is backed up". Silence about
                        // work that did not go up is worse than the error it
                        // replaced: at least the error made somebody ask.
                        skipped += 1
                        android.util.Log.i("EntitySync", "push $what skipped: not this phone's to send")
                    } else {
                        if (firstRealFailure == null) firstRealFailure = e
                        android.util.Log.w("EntitySync", "push $what failed", e)
                    }
                }
            }

            step("employees")      { pushEmployees(repository, companyId) }
            step("manufacturers")  { pushManufacturers(repository, companyId) }
            step("fence runs")     { pushFenceRuns(repository, companyId) }
            step("time entries")   { pushTimeEntries(repository, companyId) }
            step("catalog")        { pushCatalog(repository, companyId) }
            step("pricing tiers")  { pushPricingTiers(repository, companyId) }
            step("job children")   { pushJobChildren(repository, companyId) }

            // A negative count carries "some of this did not go up" back to the
            // caller without inventing a new return type for one fact. The
            // caller only ever compares it against zero.
            firstRealFailure?.let { Result.failure(it) }
                ?: Result.success(if (skipped > 0) -pushed - 1 else pushed)
        }

    /**
     * Everything that hangs off a job: line items, expenses, punch list,
     * change orders, checklists and site markers.
     *
     * Collected in one pass over the jobs so the whole set is pushed with one
     * request per table, rather than one per job.
     */
    private suspend fun pushJobChildren(repository: Repository, companyId: String): Int {
        val allJobs = repository.getAllJobs()
        if (allJobs.isEmpty()) return 0

        // Don't write this phone's copy of a job whose cloud row is newer.
        //
        // Every job's children -- line items, change orders, expenses -- were
        // pushed unconditionally, so a phone that had been in a pocket for a
        // week wrote its week-old figures over whatever the office had done
        // since. The child rows carry no timestamp of their own to compare, but
        // their JOB does, and a job edited more recently elsewhere means this
        // phone's copy of its children is the stale one. Those get skipped here
        // and arrive on the pull instead.
        //
        // A job this phone edited most recently is still pushed, so ordinary
        // work -- including a week of it done offline -- goes up as before.
        val cloudTouchedAt = runCatching {
            SupabaseModule.client.postgrest.from("jobs")
                // sees-tombstones: this reads WHEN each job last changed, not
                // what it contains. A job deleted elsewhere has a very recent
                // timestamp, and its children are exactly the ones this phone
                // must not push back up -- so hiding the tombstone here would
                // resurrect them through the side door.
                .select { filter { eq("company_id", companyId) } }
                .decodeList<CloudJob>()
                .associate { it.syncId to it.updatedAtMillis() }
        }.getOrDefault(emptyMap())

        val jobs = allJobs.filter { job ->
            val cloudAt = cloudTouchedAt[job.syncId] ?: return@filter true
            cloudAt <= job.updatedAt
        }
        if (jobs.isEmpty()) return 0

        val lineItems = mutableListOf<CloudLineItem>()
        val expenses = mutableListOf<CloudExpense>()
        val punch = mutableListOf<CloudPunchItem>()
        val orders = mutableListOf<CloudChangeOrder>()
        val steps = mutableListOf<CloudJobStep>()
        val markers = mutableListOf<CloudSiteMarker>()
        val changes = mutableListOf<CloudFieldChange>()

        jobs.forEach { job ->
            val js = job.syncId
            val runSyncIdById = repository.getFenceRuns(job.id).associate { it.id to it.syncId }
            repository.getLineItems(job.id).forEach {
                lineItems += CloudLineItem(
                    companyId, it.syncId, js, it.fenceRunId?.let { id -> runSyncIdById[id] },
                    it.sortOrder, it.description, it.quantity,
                    it.unit, it.unitPrice, it.taxable, it.role?.name, it.isAutoGenerated,
                    // The price off the supplier's own quote. It was left off
                    // this list, so the cloud held null forever -- and the pull
                    // then wrote that null back over the figure somebody had
                    // just typed. Prices entered in the office never reached
                    // the crew's phone, and did not survive on the phone that
                    // entered them: one push-then-pull cycle erased them.
                    supplierUnitPrice = it.supplierUnitPrice
                )
            }
            repository.getExpenses(job.id).forEach {
                expenses += CloudExpense(companyId, it.syncId, js, it.category.name, it.description, it.amount)
            }
            repository.getPunchList(job.id).forEach {
                punch += CloudPunchItem(companyId, it.syncId, js, it.description, it.resolved)
            }
            repository.getChangeOrders(job.id).forEach {
                orders += CloudChangeOrder(
                    companyId, it.syncId, js, it.description, it.additionalFeet, it.additionalCost,
                    it.materialCost,
                    it.signedAt?.let { at -> Instant.ofEpochMilli(at).toString() }
                )
            }
            repository.getJobSteps(job.id).forEach {
                steps += CloudJobStep(
                    companyId, it.syncId, js, it.kind.name, it.description,
                    it.checked, it.verifiedWithCustomer, it.sortOrder,
                    it.completedAt?.let { at -> CloudTime.format(at) }
                )
            }
            repository.getSiteMarkers(job.id).forEach {
                markers += CloudSiteMarker(companyId, it.syncId, js, it.kind.name, it.x, it.y, it.label)
            }
            // A crew member's "can we move the gate?" and the office's answer.
            // This table existed in the cloud and on the website and the app
            // never sent it, so a request made on one phone was invisible on
            // every other -- the approval flow only worked on a single device.
            repository.getFieldChanges(job.id).forEach {
                changes += CloudFieldChange(
                    companyId, it.syncId, js, it.summary, it.detail, it.changedBy, it.changedByRole,
                    CloudTime.format(it.at),
                    it.acknowledgedAt?.let { at -> CloudTime.format(at) },
                    it.isRequest,
                    it.approvedAt?.let { at -> CloudTime.format(at) },
                    it.rejectedAt?.let { at -> CloudTime.format(at) },
                    it.decidedBy, it.decisionNote
                )
            }
        }

        var pushed = 0
        pushed += upsert("estimate_line_items", lineItems)
        pushed += upsert("expenses", expenses)
        pushed += upsert("punch_list_items", punch)
        pushed += upsert("change_orders", orders)
        pushed += upsert("job_steps", steps)
        pushed += upsert("site_markers", markers)
        // Insert-only, for two reasons that point the same way.
        //
        // A field change is the crew asking the office a question -- move the
        // gate, the ground is rock, the neighbour objected. The office answers
        // it. A phone re-uploading its stale copy would overwrite that answer,
        // which it should never do.
        //
        // And an ordinary upsert is INSERT ... ON CONFLICT DO UPDATE, so it
        // needs UPDATE permission on the table. field_changes_update is
        // OWNER, MANAGER and FOREMAN only, so a CREW phone was refused -- and
        // because the whole batch goes up in one statement, ONE already-
        // uploaded row took every new request down with it. Proved against
        // production: sending the batch, 1 of 2 requests arrived; sending the
        // new request alone, it arrived.
        //
        // So the crew member taps "can we move the gate?", nothing reaches the
        // office, and it never recovers -- every later request from that phone
        // dies the same way.
        // But insert-only cannot be the whole answer, because ANSWERING a
        // request is an update to a row that already exists -- and
        // ignoreDuplicates makes the server skip exactly that. So the office
        // approved the gate move, the approval never left the phone, and the
        // next pull brought the unanswered copy back down. The request
        // reappeared as still waiting, every single sync, which is precisely
        // what was reported.
        //
        // The two needs are not in conflict once the phone stops guessing:
        // send the real upsert, and drop to insert-only only for a phone the
        // server actually refuses.
        pushed += pushFieldChanges(changes)
        return pushed
    }

    /**
     * Uploads catalog items, without adding another copy of one already there.
     *
     * Same fault as the pricing tiers and much larger: the seeded catalog is
     * around ninety items, so five installs left 460 rows in the cloud for 92
     * real products. Identity is name, role, fence type and colour -- the same
     * rule the pull uses to decide a downloaded item is one it already holds.
     */
    private suspend fun pushCatalog(repository: Repository, companyId: String): Int {
        val local = repository.getAllMaterialItems()
        if (local.isEmpty()) return 0

        fun identity(name: String, role: String, fenceType: String, colour: String) =
            listOf(name, role, fenceType, colour).joinToString("|") { it.trim().lowercase() }

        val cloudByIdentity = SupabaseModule.client.postgrest.from("material_items")
            // sees-tombstones: as above -- a deleted catalog item keeps its
            // identity reserved so this phone does not push a fresh copy.
            .select { filter { eq("company_id", companyId) } }
            .decodeList<CloudMaterialItem>()
            .associateBy { identity(it.name, it.role, it.fenceType, it.colorOrFinish) }

        val rows = local.filter { item ->
            val claimed = cloudByIdentity[
                identity(item.name, item.role.name, item.fenceType.name, item.colorOrFinish)
            ]
            // No cloud row of this identity yet: push it, same as always. One
            // already up there under this row's own sync id only goes back up
            // when this phone's copy is actually newer -- otherwise a phone
            // that merely pulled the item, and never touched it, re-pushes its
            // now-stale copy on every sync and clobbers a price corrected
            // elsewhere in between.
            claimed == null || (claimed.syncId == item.syncId && item.lastUpdated > claimed.updatedAtMillis())
        }.map {
            CloudMaterialItem(
                companyId, it.syncId, it.name, it.category.name, it.role.name,
                it.fenceType.name, it.colorOrFinish, it.unit, it.unitPrice,
                it.taxable, it.coversFt, it.isActive, it.sourceDoc
            )
        }
        return upsert("material_items", rows)
    }

    /**
     * Uploads pricing tiers, without adding another copy of one that is
     * already up there under a different id.
     *
     * Every install seeds its own copy of the standard tiers with its own
     * random sync ids and pushed all of them. The app hid it, because the pull
     * matches these by name and so each phone still showed one of each -- but
     * the cloud accumulated a full set per install, and the office website,
     * which reads the cloud directly, showed every tier five times over.
     *
     * Matching on name here is the same rule the pull already uses. A tier is
     * the tier called "Residential", not whichever random id the phone that
     * happened to seed it invented.
     */
    private suspend fun pushPricingTiers(repository: Repository, companyId: String): Int {
        val local = repository.getAllPricingTiers()
        if (local.isEmpty()) return 0

        // Tombstoned rows are included deliberately: a name already taken by a
        // deleted row must not be re-created by this phone pushing its own
        // copy, or emptying the trash would never stick.
        val cloudByName = SupabaseModule.client.postgrest.from("pricing_tiers")
            // sees-tombstones: a name held by a deleted row must stay taken, or
            // this phone re-creates it and emptying the trash never sticks.
            .select { filter { eq("company_id", companyId) } }
            .decodeList<CloudPricingTier>()
            .associateBy { it.name.trim().lowercase() }

        val rows = local.filter { tier ->
            val claimed = cloudByName[tier.name.trim().lowercase()]
            // Push it when the cloud has no tier by that name -- a duplicate of
            // somebody else's copy is the only thing excluded here, not
            // staleness. When the cloud row IS this row, though, only push
            // when this phone's copy is actually newer: otherwise a phone that
            // only pulled the tier re-pushes its now-stale copy every sync and
            // clobbers a rate changed in the office in between.
            claimed == null || (claimed.syncId == tier.syncId && tier.updatedAt > claimed.updatedAtMillis())
        }.map {
            CloudPricingTier(
                companyId, it.syncId, it.name, it.laborRatePerFt,
                it.laborFlatFee, it.markupPercent, it.discountPercent, it.sortOrder
            )
        }
        return upsert("pricing_tiers", rows)
    }

    /**
     * Whether this phone has been refused the update half of field_changes.
     *
     * Remembered for the life of the process. A phone without the permission
     * is refused every time, and re-attempting the full upsert on every sync
     * would put a guaranteed failure in the log for ever. A phone that HAS the
     * permission never pays for this at all.
     */
    @Volatile private var fieldChangesInsertOnly = false

    /**
     * Requests go up from any phone; answers go up from the phones allowed to
     * give them.
     */
    private suspend fun pushFieldChanges(changes: List<CloudFieldChange>): Int {
        if (changes.isEmpty()) return 0
        if (!fieldChangesInsertOnly) {
            val full = runCatching { upsert("field_changes", changes) }
            full.getOrNull()?.let { return it }
            val why = full.exceptionOrNull()!!
            // A refusal means this phone may not answer requests, which is
            // fine and expected on a crew handset. Anything else is a real
            // failure and must not be swallowed by the retry.
            if (!isNotOursToSync(why)) throw why
            fieldChangesInsertOnly = true
        }
        return upsert("field_changes", changes, insertOnly = true)
    }

    /**
     * One or more rows a chunk-level upsert still rejected even sent alone.
     *
     * Thrown only after every row that COULD go up already has -- it exists
     * to carry news of the failure back through [pushAll]'s existing
     * reporting rather than to stop anything. Its cause is the real
     * underlying error, so [isNotOursToSync] still walks straight through to
     * it: a row refused for the same reason the whole file already treats as
     * a normal, silent skip is still treated as one.
     */
    private class PartialUpsertFailure(
        table: String,
        failedCount: Int,
        totalCount: Int,
        cause: Throwable
    ) : Exception("push $table: $failedCount of $totalCount rows rejected", cause)

    /**
     * Chunked so a large catalog doesn't become one oversized request -- and,
     * within a chunk, isolated so one bad row doesn't become one oversized
     * failure.
     *
     * A single upsert call used to cover the whole table at once for four of
     * these callers, so one row the server would not accept -- a constraint
     * violation, a value it rejects -- failed the entire request and nothing
     * for that table went up AT ALL, every sync, for every row, until
     * whatever was wrong with the one row got fixed. Chunking already
     * narrowed that from "the table" to "the 200-row batch it happened to
     * fall in"; retrying a failed chunk one row at a time narrows it the rest
     * of the way, to just that row.
     */
    private suspend inline fun <reified T : Any> upsert(
        table: String,
        rows: List<T>,
        // When true the row is inserted if it is new and left alone if it is
        // not, instead of being overwritten.
        insertOnly: Boolean = false,
    ): Int {
        if (rows.isEmpty()) return 0
        var pushed = 0
        var firstRowFailure: Throwable? = null
        var failedCount = 0

        rows.chunked(200).forEach { chunk ->
            val whole = runCatching {
                SupabaseModule.client.postgrest.from(table)
                    .upsert(chunk) {
                        onConflict = "company_id,sync_id"
                        if (insertOnly) ignoreDuplicates = true
                    }
            }
            if (whole.isSuccess) {
                pushed += chunk.size
            } else {
                chunk.forEach { row ->
                    val single = runCatching {
                        SupabaseModule.client.postgrest.from(table)
                            .upsert(listOf(row)) {
                                onConflict = "company_id,sync_id"
                                if (insertOnly) ignoreDuplicates = true
                            }
                    }
                    if (single.isSuccess) {
                        pushed++
                    } else {
                        failedCount++
                        if (firstRowFailure == null) firstRowFailure = single.exceptionOrNull()
                        android.util.Log.w("EntitySync", "push $table: one row rejected and skipped", single.exceptionOrNull())
                    }
                }
            }
        }

        // Everything that could reach the cloud already has, by this point --
        // what's left is making sure the row(s) that could not are not simply
        // forgotten. Silence about a bad row is how it stays broken forever,
        // because nothing is ever prompted to ask about it.
        firstRowFailure?.let { throw PartialUpsertFailure(table, failedCount, rows.size, it) }

        return pushed
    }

    /**
     * Brings down anything this device doesn't have yet -- the path that makes
     * "new phone, sign in, everything's there" actually work.
     *
     * Matched on syncId, so a record already present is left alone rather than
     * duplicated. Existing local rows are not overwritten: the phone that has
     * been working offline keeps its own version until a proper two-way merge
     * exists for these tables.
     */
    suspend fun pullAll(repository: Repository, companyId: String): Result<Int> =
        withContext(Dispatchers.IO) {
            // In flight together rather than one after another. Each pull
            // reads its own cloud table and writes its own local one, so
            // nothing here orders them -- but they used to run in a row,
            // and a sync's cost is round-trips, not rows: forty-odd calls
            // in single file is most of why pressing Sync felt like the
            // app had hung.
            //
            // And each one now survives its neighbours. awaitAll() cancels the
            // whole scope the moment any single pull throws, so one refused
            // table threw away five perfectly good ones -- the same fault the
            // push side had, arriving from the other direction.
            val results = kotlinx.coroutines.coroutineScope {
                listOf(
                    async { runCatching { netGate.withPermit { pullEmployees(repository, companyId) } } },
                    async { runCatching { netGate.withPermit { pullManufacturers(repository, companyId) } } },
                    async { runCatching { netGate.withPermit { pullPricingTiers(repository, companyId) } } },
                    async { runCatching { netGate.withPermit { pullCatalog(repository, companyId) } } },
                    async { runCatching { netGate.withPermit { pullFenceRuns(repository, companyId) } } },
                    async { runCatching { netGate.withPermit { pullJobChildren(repository, companyId) } } }
                ).awaitAll()
            }
            val realFailure = results.mapNotNull { it.exceptionOrNull() }
                .firstOrNull { !isNotOursToSync(it) }
            realFailure?.let { Result.failure<Int>(it) }
                ?: Result.success(results.sumOf { it.getOrDefault(0) })
        }

    private suspend fun pullPricingTiers(repository: Repository, companyId: String): Int {
        val cloud = SupabaseModule.client.postgrest.from("pricing_tiers")
            .select { filter { eq("company_id", companyId); notDeleted() } }
            .decodeList<CloudPricingTier>()
        // Match on NAME as well as sync id.
        //
        // Every install seeds its own copy of the standard tiers, each with its
        // own random sync id. Two phones therefore push six rows for the same
        // three tiers, then each pulls the other's three back -- so the list
        // doubles, and a third device triples it. That is the "everything shows
        // three times" bug. A tier is identified by its name, not by whichever
        // random id the phone that happened to create it invented.
        val existing = repository.getAllPricingTiers()
        val knownIds = existing.map { it.syncId }.toSet()
        val knownNames = existing.map { it.name.trim().lowercase() }.toSet()
        val localBySyncId = existing.associateBy { it.syncId }
        val localByName = existing.associateBy { it.name.trim().lowercase() }
        val adoptedNames = mutableSetOf<String>()
        var added = 0
        cloud.forEach { row ->
            val held = localBySyncId[row.syncId]
            if (held != null) {
                // Rates are what every estimate is priced from, so a change made
                // in the office has to reach the phone quoting in the driveway.
                //
                // Gated last-edit-wins: a rate typed on this phone and not yet
                // pushed must survive a pull landing in between, or the figure
                // the crew is about to quote from reverts under them. Applying
                // stamps this phone's clock to the cloud's, not to "now" --
                // otherwise the very next push would see its own just-pulled
                // copy as newer and send it straight back up.
                if (row.updatedAtMillis() > held.updatedAt) {
                    repository.savePricingTierFromCloud(
                        held.copy(
                            name = row.name,
                            laborRatePerFt = row.laborRatePerFt,
                            laborFlatFee = row.laborFlatFee,
                            markupPercent = row.markupPercent,
                            discountPercent = row.discountPercent,
                            sortOrder = row.sortOrder,
                            updatedAt = row.updatedAtMillis()
                        )
                    )
                    added++
                }
                return@forEach
            }
            // Unknown id, but the name-matching above still applies: a tier
            // seeded separately on each phone is one tier, not two.
            //
            // Not skipped, though -- adopted. Skipping stopped the list
            // tripling but left this phone's copy permanently detached, so a
            // labour rate raised in the office never reached the phone that
            // had seeded its own Residential tier. Every estimate it wrote
            // afterwards was priced from last season's rate.
            //
            // Unconditional, same as before this clock existed: there is no
            // prior pull of THIS cloud row to have a stale local clock about,
            // so there is nothing to gate against.
            val tierName = row.name.trim().lowercase()
            val sameTier = if (tierName in adoptedNames) null else localByName[tierName]
            if (sameTier != null) {
                adoptedNames += tierName
                repository.savePricingTierFromCloud(
                    sameTier.copy(
                        syncId = row.syncId,
                        laborRatePerFt = row.laborRatePerFt,
                        laborFlatFee = row.laborFlatFee,
                        markupPercent = row.markupPercent,
                        discountPercent = row.discountPercent,
                        sortOrder = row.sortOrder,
                        updatedAt = row.updatedAtMillis()
                    )
                )
                added++
                return@forEach
            }
            if (tierName in knownNames) return@forEach
            repository.savePricingTierFromCloud(
                PricingTier(
                    syncId = row.syncId, name = row.name,
                    laborRatePerFt = row.laborRatePerFt, laborFlatFee = row.laborFlatFee,
                    markupPercent = row.markupPercent, discountPercent = row.discountPercent,
                    sortOrder = row.sortOrder,
                    updatedAt = row.updatedAtMillis()
                )
            )
            added++
        }
        return added
    }

    private suspend fun pullCatalog(repository: Repository, companyId: String): Int {
        val cloud = SupabaseModule.client.postgrest.from("material_items")
            .select { filter { eq("company_id", companyId); notDeleted() } }
            .decodeList<CloudMaterialItem>()
        // Same seeded-identity problem as pricing tiers: a catalog item is the
        // same item if its name, role, fence type and colour match, whatever
        // sync id the phone that seeded it happened to generate.
        val existingItems = repository.getAllMaterialItems()
        val knownIds = existingItems.map { it.syncId }.toSet()
        fun identity(name: String, role: String, fenceType: String, colour: String) =
            listOf(name, role, fenceType, colour).joinToString("|") { it.trim().lowercase() }
        val knownIdentities = existingItems
            .map { identity(it.name, it.role.name, it.fenceType.name, it.colorOrFinish) }
            .toSet()
        val localBySyncId = existingItems.associateBy { it.syncId }
        val localByIdentity = existingItems
            .associateBy { identity(it.name, it.role.name, it.fenceType.name, it.colorOrFinish) }
        // A local copy may only be re-keyed once, however many cloud rows
        // happen to share its identity.
        val adoptedIdentities = mutableSetOf<String>()
        var added = 0
        cloud.forEach { row ->
            val category = runCatching { MaterialCategory.valueOf(row.category) }
                .getOrDefault(MaterialCategory.MISC)
            val role = runCatching { MaterialRole.valueOf(row.role) }
                .getOrDefault(MaterialRole.NONE)
            val fenceType = runCatching { FenceType.valueOf(row.fenceType) }
                .getOrDefault(FenceType.UNIVERSAL)
            val existing = localBySyncId[row.syncId]
            if (existing != null) {
                // A price corrected after a supplier invoice has to reach every
                // phone, or two people quote the same fence at two prices.
                //
                // Gated last-edit-wins: a price typed on this phone and not yet
                // pushed must survive a pull landing in between, or it reverts
                // under whoever is mid-edit. Applying stamps this phone's clock
                // to the cloud's, not to "now" -- otherwise the very next push
                // would see its own just-pulled copy as newer and send it
                // straight back up.
                //
                // copy() keeps manufacturerId, which the cloud shape does not
                // carry. Losing it would detach the item from its supplier.
                if (row.updatedAtMillis() > existing.lastUpdated) {
                    repository.updateMaterialItemFromCloud(
                        existing.copy(
                            name = row.name,
                            category = category,
                            role = role,
                            fenceType = fenceType,
                            colorOrFinish = row.colorOrFinish,
                            unit = row.unit,
                            unitPrice = row.unitPrice,
                            taxable = row.taxable,
                            coversFt = row.coversFt,
                            isActive = row.isActive,
                            sourceDoc = row.sourceDoc,
                            lastUpdated = row.updatedAtMillis()
                        )
                    )
                    added++
                }
                return@forEach
            }
            // New to this phone by sync id -- but every phone seeds the same
            // starter catalog locally, generating its own ids, so "6ft Vinyl
            // Panel" exists here already under a different one.
            //
            // Skipping it was safe but left the two copies divorced forever:
            // the owner corrects a price after a supplier invoice, it reaches
            // the phones that pulled the item by id, and the phone that had
            // seeded its own copy quietly keeps quoting the old figure. Two
            // people then price the same fence differently, which is the exact
            // thing this sync exists to prevent.
            //
            // So the local copy adopts the company's id and values. Line items
            // reference the catalog by role and carry their own price snapshot,
            // so nothing is orphaned by the re-key -- and the cloud row is the
            // company's copy, which is the one that should win.
            // Unconditional, same as before this clock existed: there is no
            // prior pull of THIS cloud row to have a stale local clock about,
            // so there is nothing to gate against.
            val ident = identity(row.name, row.role, row.fenceType, row.colorOrFinish)
            val sameThing = if (ident in adoptedIdentities) null else localByIdentity[ident]
            if (sameThing != null) {
                adoptedIdentities += ident
                repository.updateMaterialItemFromCloud(
                    sameThing.copy(
                        syncId = row.syncId,
                        category = category,
                        unit = row.unit,
                        unitPrice = row.unitPrice,
                        taxable = row.taxable,
                        coversFt = row.coversFt,
                        isActive = row.isActive,
                        sourceDoc = row.sourceDoc,
                        lastUpdated = row.updatedAtMillis()
                    )
                )
                added++
                return@forEach
            }
            if (ident in knownIdentities) return@forEach
            repository.saveMaterialItemFromCloud(
                MaterialItem(
                    syncId = row.syncId,
                    name = row.name,
                    category = category,
                    role = role,
                    fenceType = fenceType,
                    colorOrFinish = row.colorOrFinish,
                    unit = row.unit,
                    unitPrice = row.unitPrice,
                    taxable = row.taxable,
                    coversFt = row.coversFt,
                    isActive = row.isActive,
                    sourceDoc = row.sourceDoc,
                    lastUpdated = row.updatedAtMillis()
                )
            )
            added++
        }
        return added
    }

    /**
     * Restores the records that hang off a job. A child whose job isn't on this
     * device yet is skipped rather than orphaned -- the next pass picks it up
     * once the job itself has come down.
     */
    private suspend fun pullJobChildren(repository: Repository, companyId: String): Int {
        val jobIdBySyncId = repository.getAllJobs().associateBy({ it.syncId }, { it.id })
        if (jobIdBySyncId.isEmpty()) return 0
        var added = 0

        // Clears out orphans left by the old pull, which dropped every line item
        // into "Other Items" because it discarded the run. Only auto-generated,
        // role-bearing lines are removed -- anything typed by hand has no role
        // and is left exactly where it is.
        repository.deleteOrphanedGeneratedLineItems()

        val lineItems = SupabaseModule.client.postgrest.from("estimate_line_items")
            .select { filter { eq("company_id", companyId); notDeleted() } }
            .decodeList<CloudLineItem>()
        val runIdBySyncId = jobIdBySyncId.values
            .flatMap { repository.getFenceRuns(it) }.associate { it.syncId to it.id }
        val localItemsBySyncId = jobIdBySyncId.values
            .flatMap { repository.getLineItems(it) }.associateBy { it.syncId }

        // Refuse legacy orphans outright rather than pulling them and cleaning
        // up afterwards. A row with a real material role but no run was pushed
        // before line items carried their run; re-inserting it just recreates
        // the stray item, and the cleanup and the pull chase each other forever.
        // Hand-typed extras have role NONE or none at all, and still come down.
        val (legacyOrphans, usable) = lineItems.partition { row ->
            row.fenceRunSyncId == null && row.role != null && row.role != "NONE"
        }
        legacyOrphans.forEach { row ->
            repository.queueDeletion(row.syncId, "estimate_line_items")
        }

        usable.forEach { row ->
            val jobId = jobIdBySyncId[row.jobSyncId] ?: return@forEach
            val role = row.role?.let { r -> runCatching { MaterialRole.valueOf(r) }.getOrNull() }
                ?: MaterialRole.NONE
            val existing = localItemsBySyncId[row.syncId]
            if (existing == null) {
                repository.saveLineItem(
                    EstimateLineItem(
                        syncId = row.syncId, jobId = jobId,
                        fenceRunId = row.fenceRunSyncId?.let { runIdBySyncId[it] },
                        sortOrder = row.sortOrder, description = row.description,
                        quantity = row.quantity, unit = row.unit, unitPrice = row.unitPrice,
                        taxable = row.taxable,
                        role = role,
                        isAutoGenerated = row.autoGenerated,
                        supplierUnitPrice = row.supplierUnitPrice
                    )
                )
                added++
            } else {
                // Quantities and prices are the estimate. Not applying a change
                // meant one phone quoting a job at a price the other phone had
                // already corrected.
                //
                // supplierUnitPrice is carried now, so a supplier quote entered
                // on one phone reaches the other. It stays nullable: null means
                // not quoted separately, which is not the same as quoted at zero.
                //
                // fenceRunId is only overwritten when the cloud names a run this
                // device can resolve. Otherwise the local grouping stands, since
                // clearing it would drop the line into "Other Items".
                val merged = existing.copy(
                    fenceRunId = row.fenceRunSyncId?.let { runIdBySyncId[it] } ?: existing.fenceRunId,
                    sortOrder = row.sortOrder,
                    description = row.description,
                    quantity = row.quantity,
                    unit = row.unit,
                    unitPrice = row.unitPrice,
                    taxable = row.taxable,
                    role = role,
                    isAutoGenerated = row.autoGenerated,
                    supplierUnitPrice = row.supplierUnitPrice
                )
                if (merged != existing) {
                    repository.updateLineItem(merged)
                    added++
                }
            }
        }

        val expenses = SupabaseModule.client.postgrest.from("expenses")
            .select { filter { eq("company_id", companyId); notDeleted() } }
            .decodeList<CloudExpense>()
        val localExpensesBySyncId = jobIdBySyncId.values
            .flatMap { repository.getExpenses(it) }.associateBy { it.syncId }
        expenses.forEach { row ->
            val jobId = jobIdBySyncId[row.jobSyncId] ?: return@forEach
            val category = runCatching { ExpenseCategory.valueOf(row.category) }
                .getOrDefault(ExpenseCategory.OTHER)
            val existing = localExpensesBySyncId[row.syncId]
            if (existing == null) {
                repository.saveExpense(
                    Expense(
                        syncId = row.syncId, jobId = jobId,
                        category = category,
                        description = row.description, amount = row.amount
                    )
                )
                added++
            } else {
                // copy() keeps date, which the cloud shape does not carry.
                // Overwriting wholesale would move every expense to today and
                // quietly rewrite which tax year it falls in.
                val merged = existing.copy(
                    category = category,
                    description = row.description,
                    amount = row.amount
                )
                if (merged != existing) { repository.updateExpense(merged); added++ }
            }
        }

        val punch = SupabaseModule.client.postgrest.from("punch_list_items")
            .select { filter { eq("company_id", companyId); notDeleted() } }
            .decodeList<CloudPunchItem>()
        val localPunchBySyncId = jobIdBySyncId.values
            .flatMap { repository.getPunchList(it) }.associateBy { it.syncId }
        punch.forEach { row ->
            val jobId = jobIdBySyncId[row.jobSyncId] ?: return@forEach
            val existing = localPunchBySyncId[row.syncId]
            if (existing == null) {
                repository.addPunchListItem(
                    PunchListItem(
                        syncId = row.syncId, jobId = jobId,
                        description = row.description, resolved = row.resolved
                    )
                )
                added++
            } else {
                // Ticking a callback off on site has to reach the office.
                // copy() keeps createdAt, resolvedAt and the local photo path.
                val merged = existing.copy(
                    description = row.description,
                    resolved = row.resolved
                )
                if (merged != existing) { repository.updatePunchListItem(merged); added++ }
            }
        }

        val cloudChanges = SupabaseModule.client.postgrest.from("field_changes")
            .select { filter { eq("company_id", companyId); notDeleted() } }
            .decodeList<CloudFieldChange>()
        val localChangesBySyncId = jobIdBySyncId.values
            .flatMap { repository.getFieldChanges(it) }.associateBy { it.syncId }
        cloudChanges.forEach { row ->
            val jobId = jobIdBySyncId[row.jobSyncId] ?: return@forEach
            val existing = localChangesBySyncId[row.syncId]
            val at = CloudTime.parseMillis(row.at) ?: System.currentTimeMillis()
            if (existing == null) {
                repository.recordFieldChange(
                    FieldChange(
                        syncId = row.syncId, jobId = jobId, summary = row.summary, detail = row.detail,
                        changedBy = row.changedBy, changedByRole = row.changedByRole, at = at,
                        acknowledgedAt = CloudTime.parseMillis(row.acknowledgedAt),
                        isRequest = row.isRequest,
                        approvedAt = CloudTime.parseMillis(row.approvedAt),
                        rejectedAt = CloudTime.parseMillis(row.rejectedAt),
                        decidedBy = row.decidedBy, decisionNote = row.decisionNote
                    )
                )
                added++
            } else {
                // A decision already made here is never un-made by a cloud row
                // that has not heard about it yet; the cloud wins when it
                // actually carries one. Same ratchet as shift approvals.
                val cloudApproved = CloudTime.parseMillis(row.approvedAt)
                val cloudRejected = CloudTime.parseMillis(row.rejectedAt)
                val cloudDecided = cloudApproved != null || cloudRejected != null
                val merged = existing.copy(
                    summary = row.summary, detail = row.detail,
                    acknowledgedAt = existing.acknowledgedAt ?: CloudTime.parseMillis(row.acknowledgedAt),
                    approvedAt = if (cloudDecided) cloudApproved else existing.approvedAt,
                    rejectedAt = if (cloudDecided) cloudRejected else existing.rejectedAt,
                    decidedBy = if (cloudDecided) row.decidedBy else existing.decidedBy,
                    decisionNote = if (cloudDecided) row.decisionNote else existing.decisionNote
                )
                if (merged != existing) { repository.updateFieldChangeFromCloud(merged); added++ }
            }
        }

        // These four were pushed but never pulled back, so switching phones lost
        // signed change orders and clocked hours -- money and payroll records --
        // along with job checklists and site markers.

        val orders = SupabaseModule.client.postgrest.from("change_orders")
            .select { filter { eq("company_id", companyId); notDeleted() } }
            .decodeList<CloudChangeOrder>()
        val localOrdersBySyncId = jobIdBySyncId.values
            .flatMap { repository.getChangeOrders(it) }.associateBy { it.syncId }
        orders.forEach { row ->
            val jobId = jobIdBySyncId[row.jobSyncId] ?: return@forEach
            // The signature image itself is a local file that isn't synced yet,
            // so only the fact and date of signing survive.
            val signedAt = row.signedAt?.let { at -> CloudTime.parseMillis(at) }
            val existing = localOrdersBySyncId[row.syncId]
            if (existing == null) {
                repository.saveChangeOrder(
                    ChangeOrder(
                        syncId = row.syncId, jobId = jobId,
                        description = row.description,
                        additionalFeet = row.additionalFeet,
                        additionalCost = row.additionalCost,
                        materialCost = row.materialCost,
                        signedAt = signedAt
                    )
                )
                added++
            } else {
                // Amounts change when extra work is repriced, and that has to
                // reach the other phone or two people quote the same job
                // differently. copy() keeps createdAt and the local signature
                // file path, which the cloud does not carry.
                val merged = existing.copy(
                    description = row.description,
                    additionalFeet = row.additionalFeet,
                    additionalCost = row.additionalCost,
                    materialCost = row.materialCost,
                    signedAt = signedAt
                )
                if (merged != existing) {
                    repository.updateChangeOrder(merged)
                    added++
                }
            }
        }

        val times = SupabaseModule.client.postgrest.from("time_entries")
            .select { filter { eq("company_id", companyId); notDeleted() } }
            .decodeList<CloudTimeEntry>()
        // Keyed by sync id, not a set of ids, because rows that already exist
        // have to be updated rather than skipped. Skipping them is what made an
        // approved shift show as still pending on the crew's phone forever: the
        // owner approved it, the approval reached the cloud, and every device
        // that already held the row ignored it on the way back down.
        val localTimesBySyncId = jobIdBySyncId.values
            .flatMap { repository.getTimeEntries(it) }.associateBy { it.syncId }
        val employeeIdBySyncId = repository.getAllEmployees().associateBy({ it.syncId }, { it.id })
        times.forEach { row ->
            val jobId = jobIdBySyncId[row.jobSyncId] ?: return@forEach
            val startedAt = CloudTime.parseMillis(row.startedAt)
                ?: return@forEach
            val existing = localTimesBySyncId[row.syncId]
            if (existing == null) {
                repository.insertTimeEntry(
                    TimeEntry(
                        syncId = row.syncId, jobId = jobId,
                        // "" matches no employee, which is exactly right for a
                        // shift nobody is attached to.
                        employeeId = employeeIdBySyncId[row.employeeSyncId],
                        startedAt = startedAt,
                        endedAt = row.endedAt?.let { at ->
                            CloudTime.parseMillis(at)
                        },
                        hourlyRate = row.hourlyRate, notes = row.notes,
                        approvedAt = CloudTime.parseMillis(row.approvedAt),
                        approvedBy = row.approvedBy,
                        rejectedAt = CloudTime.parseMillis(row.rejectedAt),
                        reviewNote = row.reviewNote
                    )
                )
                added++
            } else {
                // copy() from the local row, naming only the fields the cloud
                // actually carries. employeeId is NOT one of them -- overwriting
                // wholesale would erase which crew member the shift belongs to,
                // which is payroll.
                // Signing off is a one-way ratchet: a decision already made
                // here is never un-made by a cloud row that has not heard about
                // it yet.
                //
                // Without this, approving a shift while a sync was already in
                // flight lost the approval -- the push had gone before the tap,
                // so the pull moments later brought back the un-approved copy
                // and wrote it over the top. The shift reappeared in the queue
                // and it looked like the approval had never saved. Which is
                // exactly what was reported, twice.
                //
                // Cloud still wins when it actually carries a decision, so a
                // sign-off or rejection made on another phone lands normally.
                val cloudApprovedAt = CloudTime.parseMillis(row.approvedAt)
                val cloudRejectedAt = CloudTime.parseMillis(row.rejectedAt)
                val cloudHasDecision = cloudApprovedAt != null || cloudRejectedAt != null
                val localHasDecision = existing.approvedAt != null || existing.rejectedAt != null

                val merged = existing.copy(
                    startedAt = startedAt,
                    endedAt = row.endedAt?.let { at -> CloudTime.parseMillis(at) },
                    hourlyRate = row.hourlyRate,
                    notes = row.notes,
                    approvedAt = if (cloudHasDecision) cloudApprovedAt else existing.approvedAt,
                    approvedBy = if (cloudHasDecision) row.approvedBy else existing.approvedBy,
                    rejectedAt = if (cloudHasDecision) cloudRejectedAt else existing.rejectedAt,
                    reviewNote = if (cloudHasDecision || !localHasDecision) row.reviewNote
                                 else existing.reviewNote
                )
                if (merged != existing) {
                    repository.updateTimeEntry(merged)
                    added++
                }
            }
        }

        val steps = SupabaseModule.client.postgrest.from("job_steps")
            .select { filter { eq("company_id", companyId); notDeleted() } }
            .decodeList<CloudJobStep>()
        val localStepsBySyncId = jobIdBySyncId.values
            .flatMap { repository.getJobSteps(it) }.associateBy { it.syncId }
        steps.forEach { row ->
            val jobId = jobIdBySyncId[row.jobSyncId] ?: return@forEach
            val kind = runCatching { JobStepKind.valueOf(row.kind) }
                .getOrDefault(JobStepKind.INSTALL)
            val existing = localStepsBySyncId[row.syncId]
            if (existing == null) {
                repository.insertJobStep(
                    JobStep(
                        syncId = row.syncId, jobId = jobId,
                        kind = kind,
                        description = row.description, checked = row.checked,
                        verifiedWithCustomer = row.verifiedWithCustomer,
                        sortOrder = row.sortOrder,
                        completedAt = CloudTime.parseMillis(row.completedAt)
                    )
                )
                added++
            } else {
                // The install checklist is what the crew works from, so a step
                // ticked on one phone has to read as ticked on the other --
                // and a tick made here must not be undone by a cloud row that
                // predates it.
                //
                // Whichever side ticked more recently wins. A local tick with
                // no cloud tick is newer by definition: it has not been pushed
                // yet, which is the whole reason the cloud does not know. That
                // exact case is what made the walkthrough impossible to save --
                // the pull cleared the tick, then the next push uploaded the
                // cleared value, so it could never take.
                val cloudCompleted = CloudTime.parseMillis(row.completedAt)
                val localCompleted = existing.completedAt
                val takeCloudTick = when {
                    cloudCompleted == null && localCompleted == null -> true
                    localCompleted == null -> true
                    cloudCompleted == null -> false
                    else -> cloudCompleted >= localCompleted
                }
                val merged = existing.copy(
                    kind = kind,
                    description = row.description,
                    checked = if (takeCloudTick) row.checked else existing.checked,
                    completedAt = if (takeCloudTick) cloudCompleted else localCompleted,
                    verifiedWithCustomer =
                        if (takeCloudTick) row.verifiedWithCustomer
                        else existing.verifiedWithCustomer,
                    sortOrder = row.sortOrder
                )
                if (merged != existing) { repository.updateJobStep(merged); added++ }
            }
        }

        val markers = SupabaseModule.client.postgrest.from("site_markers")
            .select { filter { eq("company_id", companyId); notDeleted() } }
            .decodeList<CloudSiteMarker>()
        val localMarkersBySyncId = jobIdBySyncId.values
            .flatMap { repository.getSiteMarkers(it) }.associateBy { it.syncId }
        markers.forEach { row ->
            val jobId = jobIdBySyncId[row.jobSyncId] ?: return@forEach
            val kind = runCatching { SiteMarkerKind.valueOf(row.kind) }
                .getOrDefault(SiteMarkerKind.OBSTACLE)
            val existing = localMarkersBySyncId[row.syncId]
            if (existing == null) {
                repository.addSiteMarker(
                    SiteMarker(
                        syncId = row.syncId, jobId = jobId,
                        kind = kind, x = row.x, y = row.y, label = row.label
                    )
                )
                added++
            } else {
                // A marked obstacle that moved has to reach whoever is digging.
                val merged = existing.copy(
                    kind = kind, x = row.x, y = row.y, label = row.label
                )
                if (merged != existing) { repository.updateSiteMarker(merged); added++ }
            }
        }

        return added
    }

    /**
     * Everyone gets the crew list. Only the office gets what they are paid.
     *
     * The employees table carries hourly_rate, pay_type and per_foot_rate, and
     * the server no longer hands those rows to anyone without SEE_MONEY. A
     * crew phone asking for them now gets nothing back, which would empty the
     * local crew list and take the names off every job assignment.
     *
     * crew_roster() returns the same people with no pay attached, so the names
     * still arrive. The rate is not missed: the server stamps it onto a shift
     * when the phone clocks in, rather than believing whatever the phone sent.
     */
    private suspend fun pullEmployees(repository: Repository, companyId: String): Int {
        // Asks the server rather than the session.
        //
        // Whether this phone may see pay is the server's decision, and it
        // already makes it: the employees table hands back nothing at all to
        // anyone without SEE_MONEY. So an empty answer here means "not
        // allowed", and the roster -- the same people with no pay attached --
        // is what this phone should use. An office phone gets the full rows on
        // the first call and never reaches the second.
        //
        // Reading it this way rather than from the local session keeps the two
        // in step: if the rule changes server-side the phone follows, with no
        // release needed.
        // ASKED, not inferred.
        //
        // This decided with withPay.isEmpty() -- treating no rows as "not
        // allowed to see pay". Empty also means the request came back with
        // nothing for any other reason, and when that happened the phone
        // replaced its local rates with the roster's zeros and pushed them
        // back over the real ones. A real hourly rate on this database went
        // from 25 to 0 that way, and payroll would have been silently wrong.
        //
        // A failure to ask leaves it false, which costs a crew phone nothing
        // -- it uses the roster it was going to use anyway -- and costs an
        // office phone one stale sync rather than its pay data.
        val maySeePay = runCatching {
            SupabaseModule.client.postgrest.rpc("can_see_pay").decodeAs<Boolean>()
        }.getOrDefault(false)

        val fromRoster = !maySeePay
        val cloud = if (maySeePay)
            SupabaseModule.client.postgrest.from("employees")
                .select { filter { eq("company_id", companyId); notDeleted() } }
                .decodeList<CloudEmployee>()
        else
            SupabaseModule.client.postgrest
                .rpc("crew_roster")
                .decodeList<CrewRosterRow>()
                .map { it.asEmployee(companyId) }
        val localBySyncId = repository.getAllEmployees().associateBy { it.syncId }
        var added = 0
        cloud.forEach { row ->
            val existing = localBySyncId[row.syncId]
            if (existing == null) {
                repository.saveEmployee(
                    Employee(
                        syncId = row.syncId, name = row.name, role = row.role,
                        phone = row.phone, email = row.email, notes = row.notes,
                        hourlyRate = row.hourlyRate,
                        payType = runCatching { PayType.valueOf(row.payType) }
                            .getOrDefault(PayType.HOURLY),
                        perFootRate = row.perFootRate,
                        isActive = row.isActive,
                        deactivatedAt = CloudTime.parseMillis(row.deactivatedAt),
                        profileId = row.profileId.orEmpty()
                    )
                )
                added++
            } else {
                // A pay rate corrected in the office has to reach the phone that
                // costs the job -- including the pay arrangement itself, which
                // the cloud shape now carries.
                // The roster knows who somebody is, not how to reach them.
                //
                // It returns name, role and whether they are still on the crew,
                // and nothing else -- so taking its blanks for phone, email and
                // notes would quietly erase colleagues' contact details from
                // every crew phone. Those are kept.
                //
                // The pay fields are the opposite case: the roster's zeroes are
                // exactly what should land, because that scrubs whatever rate
                // this phone cached back when the table was readable. Without
                // it, hiding pay server-side would leave yesterday's figures
                // sitting in Room for ever.
                val merged = existing.copy(
                    name = row.name, role = row.role,
                    phone = if (fromRoster) existing.phone else row.phone,
                    email = if (fromRoster) existing.email else row.email,
                    notes = if (fromRoster) existing.notes else row.notes,
                    hourlyRate = row.hourlyRate,
                    payType = runCatching { PayType.valueOf(row.payType) }
                        .getOrDefault(existing.payType),
                    perFootRate = row.perFootRate,
                    // Someone let go on one phone has to be let go on all of
                    // them, and promptly -- that is half the point of the
                    // feature.
                    isActive = row.isActive,
                    deactivatedAt = CloudTime.parseMillis(row.deactivatedAt),
                    profileId = if (fromRoster) existing.profileId else row.profileId.orEmpty()
                )
                if (merged != existing) { repository.saveEmployee(merged); added++ }
            }
        }
        return added
    }

    private suspend fun pullManufacturers(repository: Repository, companyId: String): Int {
        val cloud = SupabaseModule.client.postgrest.from("manufacturers")
            .select { filter { eq("company_id", companyId); notDeleted() } }
            .decodeList<CloudManufacturer>()
        val localBySyncId = repository.getAllManufacturers().associateBy { it.syncId }
        var added = 0
        cloud.forEach { row ->
            val existing = localBySyncId[row.syncId]
            if (existing == null) {
                repository.saveManufacturer(
                    Manufacturer(
                        syncId = row.syncId, name = row.name, email = row.email,
                        phone = row.phone, address = row.address, hours = row.hours, notes = row.notes
                    )
                )
                added++
            } else {
                // A supplier changing their number is the whole point of holding it.
                val merged = existing.copy(
                    name = row.name, email = row.email,
                    phone = row.phone, address = row.address, hours = row.hours, notes = row.notes
                )
                if (merged != existing) { repository.saveManufacturer(merged); added++ }
            }
        }
        return added
    }

    private suspend fun pullFenceRuns(repository: Repository, companyId: String): Int {
        val cloud = SupabaseModule.client.postgrest.from("fence_runs")
            .select { filter { eq("company_id", companyId); notDeleted() } }
            .decodeList<CloudFenceRun>()

        // Runs belong to a job, so a run whose job hasn't synced down yet is
        // skipped rather than orphaned; the next pass picks it up.
        val jobIdBySyncId = repository.getAllJobs().associateBy({ it.syncId }, { it.id })
        val localBySyncId = jobIdBySyncId.values
            .flatMap { repository.getFenceRuns(it) }.associateBy { it.syncId }

        var added = 0
        cloud.forEach { row ->
            val localJobId = jobIdBySyncId[row.jobSyncId] ?: return@forEach
            val fenceType = runCatching { FenceType.valueOf(row.fenceType) }
                .getOrDefault(FenceType.VINYL)
            val existing = localBySyncId[row.syncId]
            if (existing == null) {
                repository.createFenceRun(
                    FenceRun(
                        syncId = row.syncId,
                        jobId = localJobId,
                        label = row.label,
                        fenceType = fenceType,
                        colorOrFinish = row.colorOrFinish,
                        pointsEncoded = row.pointsEncoded,
                        gatesEncoded = row.gatesEncoded,
                        closedLoop = row.closedLoop,
                        isTeardown = row.isTeardown,
                        panelWidthFt = row.panelWidthFt,
                        panelHeightFt = row.panelHeightFt,
                        postSpacingFt = row.postSpacingFt,
                        concreteBagsPerPost = row.concreteBagsPerPost,
                        manualLinearFeet = row.manualLinearFeet,
                        manualCornerCount = row.manualCornerCount,
                        suppressedRolesCsv = row.suppressedRolesCsv,
                        sortOrder = row.sortOrder,
                        aluminumStyle = runCatching { AluminumStyle.valueOf(row.aluminumStyle) }
                            .getOrDefault(AluminumStyle.RACKABLE),
                        woodStyle = runCatching { WoodStyle.valueOf(row.woodStyle) }
                            .getOrDefault(WoodStyle.PRIVACY),
                        woodRailCount = row.woodRailCount,
                        picketWidthIn = row.picketWidthIn,
                        picketGapIn = row.picketGapIn,
                        fabricHeightFt = row.fabricHeightFt,
                        includeTopRail = row.includeTopRail,
                        includeTensionWire = row.includeTensionWire,
                        includeBarbedWireArms = row.includeBarbedWireArms,
                        includePrivacySlats = row.includePrivacySlats,
                        splitRailCount = row.splitRailCount
                    )
                )
                added++
            } else {
                // Redrawing a fence line, or correcting its footage, has to
                // reach the crew -- otherwise they build to an older drawing
                // than the one the customer was quoted from.
                //
                // copy() names only what the cloud carries, which is now the
                // whole specification. It used to carry the outline and nothing
                // else, so a run arrived elsewhere with the default spec for its
                // fence type and the two phones computed different takeoffs.
                //
                // jobId is still not named: the run stays attached to the job
                // this device resolved it to.
                val merged = existing.copy(
                    label = row.label,
                    fenceType = fenceType,
                    colorOrFinish = row.colorOrFinish,
                    pointsEncoded = row.pointsEncoded,
                    gatesEncoded = row.gatesEncoded,
                    closedLoop = row.closedLoop,
                    panelWidthFt = row.panelWidthFt,
                    panelHeightFt = row.panelHeightFt,
                    postSpacingFt = row.postSpacingFt,
                    concreteBagsPerPost = row.concreteBagsPerPost,
                    manualLinearFeet = row.manualLinearFeet,
                    manualCornerCount = row.manualCornerCount,
                    suppressedRolesCsv = row.suppressedRolesCsv,
                    sortOrder = row.sortOrder,
                    aluminumStyle = runCatching { AluminumStyle.valueOf(row.aluminumStyle) }
                        .getOrDefault(AluminumStyle.RACKABLE),
                    woodStyle = runCatching { WoodStyle.valueOf(row.woodStyle) }
                        .getOrDefault(WoodStyle.PRIVACY),
                    woodRailCount = row.woodRailCount,
                    picketWidthIn = row.picketWidthIn,
                    picketGapIn = row.picketGapIn,
                    fabricHeightFt = row.fabricHeightFt,
                    includeTopRail = row.includeTopRail,
                    includeTensionWire = row.includeTensionWire,
                    includeBarbedWireArms = row.includeBarbedWireArms,
                    includePrivacySlats = row.includePrivacySlats,
                    splitRailCount = row.splitRailCount
                )
                if (merged != existing) { repository.updateFenceRun(merged); added++ }
            }
        }
        return added
    }

    private suspend fun pushEmployees(repository: Repository, companyId: String): Int {
        // A phone that cannot see pay must not send employee rows at all.
        //
        // Its local copy came from the roster, which carries no rates, so
        // pushing it writes zeros over the office's figures. RLS already
        // refuses this for crew, but the owner's phone is allowed -- and the
        // owner's phone is exactly the one that did the damage when the
        // fallback misfired. Two independent things now have to fail before
        // pay can be overwritten.
        val maySeePay = runCatching {
            SupabaseModule.client.postgrest.rpc("can_see_pay").decodeAs<Boolean>()
        }.getOrDefault(false)
        if (!maySeePay) return 0

        val rows = repository.getAllEmployees().map { it.toCloud(companyId) }
        return upsert("employees", rows)
    }

    private suspend fun pushManufacturers(repository: Repository, companyId: String): Int {
        val rows = repository.getAllManufacturers().map { it.toCloud(companyId) }
        return upsert("manufacturers", rows)
    }

    private suspend fun pushFenceRuns(repository: Repository, companyId: String): Int {
        val jobs = repository.getAllJobs()
        val rows = jobs.flatMap { job ->
            repository.getFenceRuns(job.id).map { it.toCloud(companyId, job.syncId) }
        }
        return upsert("fence_runs", rows)
    }

    private suspend fun pushTimeEntries(repository: Repository, companyId: String): Int {
        val jobsBySyncId = repository.getAllJobs().associateBy({ it.id }, { it.syncId })
        val employeeSyncById = repository.getAllEmployees().associateBy({ it.id }, { it.syncId })
        // Only completed shifts: a running timer has no end yet and would land
        // in the cloud looking like a zero-length entry.
        val rows = repository.getAllTimeEntries()
            .filter { !it.isRunning }
            .mapNotNull { entry ->
                jobsBySyncId[entry.jobId]?.let { entry.toCloud(companyId, it, entry.employeeId?.let { e -> employeeSyncById[e] }) }
            }
        return upsert("time_entries", rows)
    }
}

/* ---------------- mapping ---------------- */

private fun Employee.toCloud(companyId: String) = CloudEmployee(
    companyId = companyId, syncId = syncId, name = name, role = role,
    phone = phone, email = email, notes = notes, hourlyRate = hourlyRate,
    payType = payType.name, perFootRate = perFootRate,
    isActive = isActive,
    deactivatedAt = deactivatedAt?.let { CloudTime.format(it) },
    profileId = profileId.takeIf { it.isNotBlank() }
)

private fun Manufacturer.toCloud(companyId: String) = CloudManufacturer(
    companyId = companyId, syncId = syncId, name = name, email = email,
    phone = phone, address = address, hours = hours, notes = notes
)

private fun FenceRun.toCloud(companyId: String, jobSyncId: String) = CloudFenceRun(
    companyId = companyId, syncId = syncId, jobSyncId = jobSyncId,
    label = label, fenceType = fenceType.name, colorOrFinish = colorOrFinish,
    pointsEncoded = pointsEncoded, gatesEncoded = gatesEncoded, closedLoop = closedLoop,
    isTeardown = isTeardown,
    panelWidthFt = panelWidthFt, panelHeightFt = panelHeightFt,
    postSpacingFt = postSpacingFt, concreteBagsPerPost = concreteBagsPerPost,
    manualLinearFeet = manualLinearFeet, manualCornerCount = manualCornerCount,
    suppressedRolesCsv = suppressedRolesCsv,
    sortOrder = sortOrder,
    aluminumStyle = aluminumStyle.name, woodStyle = woodStyle.name,
    woodRailCount = woodRailCount,
    picketWidthIn = picketWidthIn, picketGapIn = picketGapIn,
    fabricHeightFt = fabricHeightFt,
    includeTopRail = includeTopRail, includeTensionWire = includeTensionWire,
    includeBarbedWireArms = includeBarbedWireArms,
    includePrivacySlats = includePrivacySlats,
    splitRailCount = splitRailCount
)

private fun TimeEntry.toCloud(companyId: String, jobSyncId: String, employeeSyncId: String? = null) = CloudTimeEntry(
    companyId = companyId, syncId = syncId, jobSyncId = jobSyncId,
    employeeSyncId = employeeSyncId ?: "",
    startedAt = Instant.ofEpochMilli(startedAt).toString(),
    endedAt = endedAt?.let { Instant.ofEpochMilli(it).toString() },
    hourlyRate = hourlyRate, notes = notes,
    approvedAt = approvedAt?.let { CloudTime.format(it) },
    approvedBy = approvedBy,
    rejectedAt = rejectedAt?.let { CloudTime.format(it) },
    reviewNote = reviewNote
)

/**
 * Removes local rows that another device deleted.
 *
 * The other half of the tombstone fix. [JobSync] handles jobs; every other
 * synced table went through a blanket upsert, which meant a device that still
 * held a local copy of a deleted line item or change order pushed it straight
 * back up. For money-bearing tables that is not just clutter -- resurrected
 * line items and change orders inflate the job total, which is why two devices
 * showed different figures for the same job.
 *
 * Runs before the push, so nothing deleted elsewhere is uploaded again on the
 * same pass.
 */
object DeletionReaper {

    @kotlinx.serialization.Serializable
    private data class TombstonedRow(@kotlinx.serialization.SerialName("sync_id") val syncId: String)

    suspend fun reap(repository: com.fenceestimator.app.data.Repository, companyId: String): Result<Int> =
        runCatching {
            // All thirteen sweeps at once; each touches only its own table.
            kotlinx.coroutines.coroutineScope {
            com.fenceestimator.app.data.SyncTables.ALL.map { table -> async { netGate.withPermit {
                val deletedIds = SupabaseModule.client.postgrest.from(table)
                    .select(io.github.jan.supabase.postgrest.query.Columns.list("sync_id")) {
                        filter {
                            eq("company_id", companyId)
                            // "not null" rather than a date window: a device that
                            // has been off for a month must still learn about
                            // everything deleted while it was away.
                            filterNot("deleted_at", io.github.jan.supabase.postgrest.query.filter.FilterOperator.IS, "null")
                        }
                    }
                    .decodeList<TombstonedRow>()
                    .map { it.syncId }

                if (deletedIds.isNotEmpty()) {
                    repository.deleteLocalRowsBySyncId(table, deletedIds)
                } else 0
            } } }.awaitAll().sum()
            }
        }
}

@kotlinx.serialization.Serializable
data class CloudPaymentRecord(
    @kotlinx.serialization.SerialName("sync_id") val syncId: String,
    @kotlinx.serialization.SerialName("company_id") val companyId: String,
    @kotlinx.serialization.SerialName("job_sync_id") val jobSyncId: String,
    val amount: Double = 0.0,
    val method: String = "OTHER",
    @kotlinx.serialization.SerialName("received_at") val receivedAt: String? = null,
    val reference: String = "",
    val note: String = "",
    @kotlinx.serialization.SerialName("recorded_by") val recordedBy: String = "",
    @kotlinx.serialization.SerialName("deleted_at") val deletedAt: String? = null
)

/**
 * Two-way sync for the payments ledger.
 *
 * Kept apart from the generic entity sync because payments are matched to their
 * job by the job's syncId rather than a local row id -- the same job has a
 * different local id on every phone, so anything else would attach payments to
 * the wrong job or drop them.
 *
 * Rows are never updated once written. A payment is a record of something that
 * happened; correcting one is a second row, not an edit to the first.
 */
/**
 * Whether the server refused this because it is not ours to touch.
 *
 * A permission refusal is not a failure. It is the server telling a phone that
 * this table is none of its business -- which is exactly what should happen on
 * a crew handset now that money is office-only. Treating it as an error meant
 * a crew phone reported "Could not sync: new row violates row-level security
 * policy for table payment_records" for ever, and kept retrying the same
 * forbidden write on every pass.
 *
 * Matched on the text because the refusal arrives through several layers with
 * no common type -- the same reason looksLikeNoSignal is written this way.
 */
internal fun isNotOursToSync(error: Throwable): Boolean {
    val text = generateSequence(error) { it.cause }
        .mapNotNull { "${it::class.simpleName} ${it.message}" }
        .joinToString(" ")
        .lowercase()
    return listOf(
        "row-level security",
        "row level security",
        "42501",
        "permission denied",
        "insufficient_privilege",
    ).any { it in text }
}

object PaymentLedgerSync {

    suspend fun sync(
        repository: com.fenceestimator.app.data.Repository,
        companyId: String
    ): Result<Int> = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
        runCatching {
            val jobs = repository.getAllJobs()
            val jobIdBySyncId = jobs.associate { it.syncId to it.id }
            val jobSyncIdById = jobs.associate { it.id to it.syncId }

            val local = repository.getAllPayments()
            val localBySyncId = local.associateBy { it.syncId }

            val cloud = SupabaseModule.client.postgrest.from("payment_records")
                .select { filter { eq("company_id", companyId) } }
                .decodeList<CloudPaymentRecord>()
            val cloudBySyncId = cloud.associateBy { it.syncId }

            var moved = 0

            // Up: anything this phone has that the cloud does not.
            val toPush = local.filter { it.syncId !in cloudBySyncId }
                .mapNotNull { row ->
                    val jobSyncId = jobSyncIdById[row.jobId] ?: return@mapNotNull null
                    CloudPaymentRecord(
                        syncId = row.syncId,
                        companyId = companyId,
                        jobSyncId = jobSyncId,
                        amount = row.amount,
                        method = row.method.name,
                        receivedAt = CloudTime.format(row.receivedAt),
                        reference = row.reference,
                        note = row.note,
                        recordedBy = row.recordedBy
                    )
                }
            if (toPush.isNotEmpty()) {
                // A crew phone holds payment rows it cached back when the
                // table was readable by everyone. It is not allowed to send
                // them now, and it should not keep trying: the office already
                // has them, and this phone has no business with them at all.
                val pushed = runCatching {
                    toPush.chunked(200).forEach { chunk ->
                        SupabaseModule.client.postgrest.from("payment_records")
                            .upsert(chunk) { onConflict = "company_id,sync_id" }
                    }
                }
                if (pushed.isFailure) {
                    val why = pushed.exceptionOrNull()!!
                    if (!isNotOursToSync(why)) throw why
                    // Not ours. Nothing further to do here on this device --
                    // and nothing is lost, because these rows are the office's
                    // copy of money that already cleared.
                    return@runCatching 0
                }
                moved += toPush.size
            }

            // Rows this phone already has, but the cloud disagrees about.
            //
            // The cloud wins. The opening balance row is backfilled from each
            // device's own cached total, which is exactly the figure that had
            // drifted -- so two devices generate the same row id carrying
            // different amounts. Ignoring the conflict left them permanently
            // apart; taking the server value gives both a single answer to
            // converge on.
            val corrections = cloud.filter { row ->
                row.deletedAt == null && localBySyncId[row.syncId]?.let { existing ->
                    kotlin.math.abs(existing.amount - row.amount) > 0.005 ||
                        existing.receivedAt != (CloudTime.parseMillis(row.receivedAt) ?: existing.receivedAt)
                } == true
            }
            corrections.forEach { row ->
                val existing = localBySyncId[row.syncId] ?: return@forEach
                repository.updatePaymentFromCloud(
                    existing.copy(
                        amount = row.amount,
                        receivedAt = CloudTime.parseMillis(row.receivedAt) ?: existing.receivedAt,
                        note = row.note,
                        reference = row.reference
                    )
                )
                moved++
            }

            // A payment deleted on another phone comes off this one too. The
            // pull below skips tombstones for rows it does not have, but that
            // never removed a row this phone already held -- so a deleted
            // payment lived on locally and the two phones showed different
            // money forever. Totals are rebuilt inside, since they cache these
            // rows.
            val deletedElsewhere = cloud
                .filter { it.deletedAt != null }
                .mapNotNull { row -> localBySyncId[row.syncId] }
            if (deletedElsewhere.isNotEmpty()) {
                repository.removePaymentsTombstonedInCloud(deletedElsewhere)
                moved += deletedElsewhere.size
            }

            // Down: anything the cloud has that this phone does not, skipping
            // tombstoned rows and any whose job has not arrived yet -- those
            // come down on a later pass once the job exists.
            val toPull = cloud.filter { it.deletedAt == null && it.syncId !in localBySyncId }
            val landed = toPull.mapNotNull { row ->
                val jobId = jobIdBySyncId[row.jobSyncId] ?: return@mapNotNull null
                com.fenceestimator.app.data.PaymentRecord(
                    syncId = row.syncId,
                    jobId = jobId,
                    amount = row.amount,
                    method = runCatching {
                        com.fenceestimator.app.data.PaymentMethod.valueOf(row.method)
                    }.getOrDefault(com.fenceestimator.app.data.PaymentMethod.OTHER),
                    receivedAt = CloudTime.parseMillis(row.receivedAt) ?: System.currentTimeMillis(),
                    reference = row.reference,
                    note = row.note,
                    recordedBy = row.recordedBy
                )
            }
            if (landed.isNotEmpty()) {
                repository.insertPaymentsFromCloud(landed)
                moved += landed.size
                // Job totals are a cache of these rows, so they are rebuilt for
                // every job that just gained one. Otherwise the ledger and the
                // job would disagree until something else touched the job.
                landed.map { it.jobId }.distinct().forEach { repository.syncJobTotalsFromLedger(it) }
            }

            // Rebuild every job's cached total from its rows. The cache is what
            // screens and the payment link read, and it is the thing that had
            // drifted between devices -- so it is recomputed from the ledger on
            // every pass rather than trusted to have stayed right.
            (corrections.mapNotNull { jobIdBySyncId[it.jobSyncId] } +
                landed.map { it.jobId } +
                jobs.map { it.id })
                .distinct()
                .forEach { repository.syncJobTotalsFromLedger(it) }

            moved
        }
    }
}
