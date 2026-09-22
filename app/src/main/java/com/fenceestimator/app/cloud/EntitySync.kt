package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.AluminumStyle
import com.fenceestimator.app.data.WoodStyle
import com.fenceestimator.app.data.BuildTemplate
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
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
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

/**
 * Reads a whole table a page at a time.
 *
 * PostgREST answers at most 1000 rows and reports the total as unknown
 * (the Content-Range header ends in a star, not a count), so a caller that asks once and counts what came
 * back cannot tell a complete answer from a truncated one. Measured against
 * this project: a view of 3000 rows returned exactly 1000 to a plain request.
 *
 * Every read here asked once. A company with more than a thousand estimate
 * lines -- roughly forty jobs -- would have had the phone pull the first
 * thousand and then reconcile against them as if that were everything. On a
 * sync, "the cloud does not have this row" is not a harmless gap: it decides
 * what gets pushed, and in places what gets tombstoned.
 *
 * Ordered by sync_id so the pages cannot overlap or skip. A short page ends
 * the loop; a full one means ask again. The cap is a runaway stop rather than
 * a limit: fifty pages is fifty thousand rows, and a company there needs a
 * delta sync, not a longer loop.
 */
internal suspend inline fun <reified T : Any> pagedList(
    table: String,
    crossinline filters: io.github.jan.supabase.postgrest.query.filter.PostgrestFilterBuilder.() -> Unit,
): List<T> {
    val page = 1000
    val all = ArrayList<T>()
    var from = 0L
    while (true) {
        val batch = SupabaseModule.client.postgrest.from(table)
            .select {
                filter { filters() }
                order("sync_id", io.github.jan.supabase.postgrest.query.Order.ASCENDING)
                range(from, from + page - 1)
            }
            .decodeList<T>()
        all += batch
        if (batch.size < page) break
        from += page
        if (all.size >= page * 50) break
    }
    return all
}

private fun io.github.jan.supabase.postgrest.query.filter.PostgrestFilterBuilder.notDeleted() =
    filter("deleted_at", io.github.jan.supabase.postgrest.query.filter.FilterOperator.IS, "null")

/* ---------------- wire shapes ---------------- */

@Serializable
data class CloudEmployee(
    @SerialName("company_id") val companyId: String,
    /**
     * Defaulted because employees.sync_id is NULLABLE on the server (uuid,
     * default gen_random_uuid()) -- checked live 2026-09-18. A row that ever
     * carried a null would otherwise kill the whole employees pull, the way
     * correction_reason killed time_entries; see cloudJson. The pull skips a
     * blank one rather than saving an employee with no identity.
     */
    @SerialName("sync_id") val syncId: String = "",
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
    @SerialName("split_rail_count") val splitRailCount: Int = 2,
    // Never set on push -- the touch_updated_at trigger owns this column, the
    // same as pricing_tiers.updated_at. Only read, on pull, to arbitrate which
    // side of an edit is newer.
    @SerialName("updated_at") val updatedAt: String? = null
) {
    /** See [CloudJob.updatedAtMillis]: falls back to 0 so an absent value never outranks real local work. */
    fun updatedAtMillis(): Long = CloudTime.parseMillis(updatedAt) ?: 0L
}

/**
 * The fence a company usually builds, as data. Pull-only -- see
 * [EntitySync.pullBuildTemplates] -- so this shape is only ever decoded,
 * never encoded, and needs no upsert helper of its own.
 *
 * [companyId] is nullable and deliberately never filtered on when pulling:
 * RLS already restricts a select on build_templates to "company_id is null
 * (shipped) or company_id = my company", so asking for everything this
 * session can see already IS "shipped ∪ own" with no extra filter needed.
 */
@Serializable
data class CloudBuildTemplate(
    @SerialName("sync_id") val syncId: String,
    @SerialName("company_id") val companyId: String? = null,
    val name: String = "",
    val description: String = "",
    @SerialName("is_default") val isDefault: Boolean = false,
    @SerialName("derived_from_sync_id") val derivedFromSyncId: String? = null,
    @SerialName("sort_order") val sortOrder: Int = 0,
    @SerialName("fence_type") val fenceType: String = "VINYL",
    @SerialName("color_or_finish") val colorOrFinish: String = "",
    @SerialName("panel_width_ft") val panelWidthFt: Float = 6f,
    @SerialName("panel_height_ft") val panelHeightFt: Float = 6f,
    @SerialName("post_spacing_ft") val postSpacingFt: Float = 6f,
    @SerialName("concrete_bags_per_post") val concreteBagsPerPost: Float = 1f,
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
    @SerialName("split_rail_count") val splitRailCount: Int = 2,
    @SerialName("gate_width_ft") val gateWidthFt: Float = 4f,
    @SerialName("gate_mounting") val gateMounting: String = "LINE",
    @SerialName("updated_at") val updatedAt: String? = null
) {
    /** See [CloudJob.updatedAtMillis]: falls back to 0 so an absent value never outranks real local work. */
    fun updatedAtMillis(): Long = CloudTime.parseMillis(updatedAt) ?: 0L

    fun toLocal(): BuildTemplate = BuildTemplate(
        syncId = syncId,
        companyId = companyId,
        name = name,
        description = description,
        isDefault = isDefault,
        derivedFromSyncId = derivedFromSyncId,
        sortOrder = sortOrder,
        fenceType = runCatching { FenceType.valueOf(fenceType) }.getOrDefault(FenceType.VINYL),
        colorOrFinish = colorOrFinish,
        panelWidthFt = panelWidthFt,
        panelHeightFt = panelHeightFt,
        postSpacingFt = postSpacingFt,
        concreteBagsPerPost = concreteBagsPerPost,
        aluminumStyle = runCatching { AluminumStyle.valueOf(aluminumStyle) }.getOrDefault(AluminumStyle.RACKABLE),
        woodStyle = runCatching { WoodStyle.valueOf(woodStyle) }.getOrDefault(WoodStyle.PRIVACY),
        woodRailCount = woodRailCount,
        picketWidthIn = picketWidthIn,
        picketGapIn = picketGapIn,
        fabricHeightFt = fabricHeightFt,
        includeTopRail = includeTopRail,
        includeTensionWire = includeTensionWire,
        includeBarbedWireArms = includeBarbedWireArms,
        includePrivacySlats = includePrivacySlats,
        splitRailCount = splitRailCount,
        gateWidthFt = gateWidthFt,
        gateMounting = gateMounting,
        updatedAt = updatedAtMillis()
    )
}

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
    @SerialName("supplier_unit_price") val supplierUnitPrice: Double? = null,
    /**
     * Sent ONLY to bring a tombstoned row back to life, and then as an
     * explicit JSON null -- see [reviveLineItems].
     *
     * Typed as a JsonElement on purpose. Both Json configurations here have
     * explicitNulls = false, which leaves a Kotlin null out of the body
     * altogether, and an upsert that leaves deleted_at out leaves the cloud's
     * deleted_at exactly as it was: the phone rewrote a tombstoned line's
     * quantity and price while the row stayed deleted (Woody's LINE_POST and
     * PANEL, $3,963.44 hidden in the cloud). [JsonNull] is a value, not a
     * Kotlin null, so it is written as `"deleted_at": null`. Left at the
     * Kotlin null default for every ordinary row, which is what keeps an
     * ordinary push from undoing a delete made on another device.
     */
    @SerialName("deleted_at") val deletedAt: JsonElement? = null,
    /** Cleared with [deletedAt] on a revival, as price-job's commit does; absent otherwise. */
    @SerialName("deleted_by") val deletedBy: String? = null
)

/**
 * The rows of one line-item push, split by whether they revive a tombstone.
 *
 * The two halves go up as separate upserts and must never share a batch:
 * PostgREST names every column any row in a batch carries, so a row missing
 * a key there is written with an explicit null (see CloudTimeEntry's
 * employeeSyncId). One reviving row in a batch would clear deleted_at on
 * every other row in it -- a delete made on another phone undone by this
 * phone pushing its ordinary lines.
 *
 * @param revive sync ids this phone regenerated and has not yet revived
 *   (Repository.lineItemResurrections).
 * @return ordinary rows unchanged, and reviving rows with `deleted_at: null`
 *   and `deleted_by: ""` set.
 */
internal fun reviveLineItems(
    rows: List<CloudLineItem>,
    revive: Set<String>
): Pair<List<CloudLineItem>, List<CloudLineItem>> {
    val (reviving, plain) = rows.partition { it.syncId in revive }
    return plain to reviving.map { it.copy(deletedAt = JsonNull, deletedBy = "") }
}

/**
 * The cloud line items the pull may write onto this phone: every one except
 * those this phone has queued a delete for and not yet landed.
 *
 * The pull used to insert any cloud row it did not hold locally. A delete on
 * this phone removes the row at once and queues the tombstone; until the
 * tombstone lands -- next pass, or never, on a MANAGER phone the server
 * refuses ("Deleting needs the delete permission") -- the cloud row is still
 * live, and the pull put it straight back beside the new lines, counting
 * twice in the price. The phone honours its own delete until the cloud
 * agrees; the queue entry stays, so it keeps being retried.
 */
internal fun lineItemsToApply(rows: List<CloudLineItem>, queuedDeletes: Set<String>): List<CloudLineItem> =
    rows.filterNot { it.syncId in queuedDeletes }

/**
 * Whether the pull may write [cloud]'s copy of a line over [local] (null:
 * this phone does not hold it). Not over a line changed here and not yet
 * taken by the cloud ([EstimateLineItem.pendingPush]): the pull runs straight
 * after the push, and a push that failed or was held back would otherwise
 * have its change overwritten by the cloud's older copy the same second --
 * and with line items carrying no clock, that is how a typed quantity or a
 * fresh Suggest snapped back.
 */
internal fun pullMayWriteLine(local: EstimateLineItem?): Boolean = local?.pendingPush != true

/**
 * Whether this pass may push [job]'s punch list, change orders, expenses,
 * steps, markers and field changes.
 *
 * Not for a job this person is no longer on ([com.fenceestimator.app.data.Job.accessEndedAt]).
 * The crew-scope policies refuse those rows one by one, so every pass cost a
 * request per stale row and still sent nothing -- and nothing is lost by
 * waiting: the rows stay on the phone and go up the pass the job comes back.
 *
 * Otherwise by the job clock, as before: not when the cloud's copy of the job
 * is newer (this phone's children are then the stale ones, and the pull
 * brings the fresh ones).
 *
 * @param cloudTouchedAt each job's cloud updated_at and whether it is
 *   tombstoned, as read from the door this phone reads. Null when that read
 *   failed: then only the held check applies, and the rest go up as they
 *   always did -- a failed read is not "the cloud has none of these".
 *
 * A job missing from a read that worked is a job the cloud does not have for
 * this phone. From the real table (ALLOWED) that means not uploaded yet, and
 * its children go up behind it. From the crew door (anything else) it means
 * this person may not see it -- not assigned, or created here and never sent,
 * since a crew phone inserts no jobs -- and the server would refuse every row.
 */
internal fun mayPushJobChildren(
    job: com.fenceestimator.app.data.Job,
    cloudTouchedAt: Map<String, Pair<Long, Boolean>>?,
    scope: MoneyScope
): Boolean {
    if (job.accessEndedAt != null) return false
    if (cloudTouchedAt == null) return true
    val cloudAt = cloudTouchedAt[job.syncId]?.first ?: return scope == MoneyScope.ALLOWED
    return cloudAt <= job.updatedAt
}

/**
 * Whether this pass may push [job]'s fence runs: the "whose job is it" half
 * of [mayPushJobChildren] and not its clock half.
 *
 * Never a job this person is no longer on, and never -- from anything but the
 * real table -- a job the crew door did not return ([cloudTouchedAt], the
 * same read collectJobChildRows makes): not assigned, or made here and never
 * sent, and the crew-scope policy on fence_runs refuses every one of its runs
 * row by row. Leaving only held jobs out still sent those, on every pass,
 * whenever the scope question had not been answered or the job had never
 * reached the cloud. A failed read (null) is not "the cloud has none of
 * these": the runs go up as they always did.
 *
 * Not the job clock: a run carries its own (pushFenceRuns compares each
 * run's updatedAt with its cloud copy), and holding a redrawn run back
 * because the office touched the job row since would let the pull put the
 * cloud's older run over the new drawing.
 */
internal fun mayPushJobRuns(
    job: com.fenceestimator.app.data.Job,
    cloudTouchedAt: Map<String, Pair<Long, Boolean>>?,
    scope: MoneyScope
): Boolean {
    if (job.accessEndedAt != null) return false
    if (cloudTouchedAt == null) return true
    return job.syncId in cloudTouchedAt || scope == MoneyScope.ALLOWED
}

/** One local line as the cloud stores it. */
internal fun EstimateLineItem.toCloud(companyId: String, jobSyncId: String, runSyncIdById: Map<Long, String>) =
    CloudLineItem(
        companyId, syncId, jobSyncId, fenceRunId?.let { id -> runSyncIdById[id] },
        sortOrder, description, quantity,
        unit, unitPrice, taxable, role.name, isAutoGenerated,
        // The price off the supplier's own quote. It was left off this list,
        // so the cloud held null forever -- and the pull then wrote that null
        // back over the figure somebody had just typed. Prices entered in the
        // office never reached the crew's phone, and did not survive on the
        // phone that entered them: one push-then-pull cycle erased them.
        supplierUnitPrice = supplierUnitPrice
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
    // Both defaulted: the roster is read off employees, whose sync_id is
    // nullable on the server. See CloudEmployee.syncId; blank rows are skipped.
    val id: String = "",
    @SerialName("sync_id") val syncId: String = "",
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
    // expenses.sync_id and job_sync_id are both nullable on the server
    // (checked live 2026-09-18): defaulted so a null cannot kill the pull,
    // and a blank is skipped there. See CloudEmployee.syncId.
    @SerialName("sync_id") val syncId: String = "",
    @SerialName("job_sync_id") val jobSyncId: String = "",
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
    // punch_list_items.sync_id and job_sync_id are both nullable on the
    // server (checked live 2026-09-18): defaulted so a null cannot kill the
    // pull, and a blank is skipped there. See CloudEmployee.syncId.
    @SerialName("sync_id") val syncId: String = "",
    @SerialName("job_sync_id") val jobSyncId: String = "",
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
    @SerialName("signed_at") val signedAt: String? = null,
    /**
     * The order is inside a price the customer accepted (ChangeOrder.inAcceptedTotal).
     * Sent only as `true`, by an order this phone marked at a signature, and
     * in a batch of its own ([splitChangeOrdersByAcceptance]) -- so an
     * ordinary push never mentions the column at all, and a database the
     * column has not reached yet refuses only those rows. The server latches
     * it (it can never go back to false), and a null here on the way down --
     * change_orders_crew does not carry it -- reads as "not marked".
     */
    @SerialName("in_accepted_total") val inAcceptedTotal: Boolean? = null,
    /**
     * The customer's signature image in cloud storage --
     * `<company>/<job>/change-order/<file>`, the path FileSync.upload returns
     * and JobFileUploader stores on the order (ChangeOrder.signatureStoragePath).
     * Never ChangeOrder.signatureImagePath, the file on this phone, which means
     * nothing anywhere else. Sent only for an order signed here and uploaded
     * ([changeOrderSignaturePathToSend]); null stays out of the body
     * (explicitNulls = false). The image went up and the path never did, so
     * every other device and the office saw a signed order with no signature.
     */
    @SerialName("signature_storage_path") val signatureStoragePath: String? = null
)

/**
 * The storage path a push should carry for [order]'s signature, or null to
 * send none.
 *
 * Only for an order that is signed ([ChangeOrder.signedAt]): editing the terms
 * clears the signature on this phone but not the path of the image already
 * uploaded, and that old image must not go up as the signature for the new
 * terms. And only a path inside this order's own folder
 * (`<company>/<job>/change-order/`), which is also the only shape
 * crew_push_change_orders accepts -- so a local file path, or one that
 * belongs to another job, can never be sent as the proof.
 */
internal fun changeOrderSignaturePathToSend(order: ChangeOrder, companyId: String, jobSyncId: String): String? =
    order.signatureStoragePath
        ?.takeIf { order.signedAt != null }
        ?.takeIf { it.startsWith("$companyId/$jobSyncId/change-order/") && !it.contains("..") }

/**
 * The storage path this phone's copy of a pulled change order should hold
 * ([local] null: the pull is inserting it).
 *
 * The cloud's, when it is signed there and this phone holds no signature of
 * its own -- a crew phone took it, and without the path the office phone
 * (and a new phone) had the date but never the image
 * (JobFileUploader.downloadMissing fetches it from here). A signature this
 * phone captured -- its file, or a path it uploaded -- is never replaced by
 * another device's.
 */
internal fun pulledSignatureStoragePath(local: ChangeOrder?, cloud: CloudChangeOrder): String? {
    val theirs = cloud.signatureStoragePath?.takeIf { it.isNotBlank() && cloud.signedAt != null }
    if (local == null) return theirs
    if (local.signatureImagePath != null || local.signatureStoragePath != null) return local.signatureStoragePath
    return theirs
}

/**
 * [rows] in batches whose rows all name the same columns.
 *
 * A batch upsert names every column any of its rows carries, and postgrest-kt
 * writes NULL into that column for a row that does not have it (it sends
 * `columns=` for the union and no `missing=default`; read from the 3.0.2
 * bytecode). signed_at and signature_storage_path are left out of a row that
 * has none (explicitNulls = false), so ONE signed order in a batch wrote NULL
 * over the signing date and image path of every other order in it -- a
 * signature taken on a crew phone, which this phone had not pulled yet,
 * erased by this phone's next push. Grouped, a row only ever goes up beside
 * rows that say the same things about it.
 */
internal fun changeOrdersInSameColumnBatches(rows: List<CloudChangeOrder>): List<List<CloudChangeOrder>> =
    rows.groupBy { Triple(it.signedAt != null, it.signatureStoragePath != null, it.inAcceptedTotal != null) }
        .values.toList()

/** Which door a phone's change orders go up through. See [changeOrderDoor]. */
internal enum class ChangeOrderDoor {
    /** The table itself, by upsert: a phone that may see money. */
    TABLE,
    /** crew_push_change_orders: a phone that may not ([crewChangeOrderRows]). */
    CREW_RPC,
    /** Nothing this pass: the money question has no answer yet. */
    NONE
}

/**
 * The door [scope] sends change orders through.
 *
 * A crew phone (DENIED) cannot use the table: an upsert is INSERT ... ON
 * CONFLICT, which needs the SELECT policies to pass on the row, and the
 * restrictive change_orders_money_hidden_from_crew refuses any caller without
 * SEE_MONEY -- 42501 for a new order and an existing one alike, so not one
 * crew change order had ever reached the server (0 rows in production,
 * 2026-09-22). crew_push_change_orders is its door
 * (supabase_r6_crew_change_orders.sql). UNKNOWN sends nothing: which door is
 * open is exactly what it does not know.
 */
internal fun changeOrderDoor(scope: MoneyScope): ChangeOrderDoor = when (scope) {
    MoneyScope.ALLOWED -> ChangeOrderDoor.TABLE
    MoneyScope.DENIED -> ChangeOrderDoor.CREW_RPC
    MoneyScope.UNKNOWN -> ChangeOrderDoor.NONE
}

/** The columns a crew phone sends crew_push_change_orders: the ones it may write, and the keys that find the row. */
internal val CREW_CHANGE_ORDER_KEYS = setOf(
    "company_id", "sync_id", "job_sync_id",
    "description", "additional_feet",
    "signed_at", "signature_storage_path"
)

/**
 * `rows_in` for crew_push_change_orders: each order with only
 * [CREW_CHANGE_ORDER_KEYS]. The server ignores costs, in_accepted_total and
 * deleted_* anyway -- and writes neither money nor a delete from this door --
 * but a crew phone's payload should not assert a cost it cannot see, nor mark
 * an order as inside a price, which is a statement about money too. A null
 * signing date or path stays out (explicitNulls = false), which the server
 * reads as "nothing to say", never as "clear it".
 */
internal fun crewChangeOrderRows(rows: List<CloudChangeOrder>): JsonArray = JsonArray(
    rows.map { row ->
        JsonObject(
            SyncJson.encodeToJsonElement(CloudChangeOrder.serializer(), row).jsonObject
                .filterKeys { it in CREW_CHANGE_ORDER_KEYS }
        )
    }
)

/**
 * What crew_push_change_orders answers for one batch. Every field defaults to
 * 0 so an answer missing one still decodes -- and then counts as not taken
 * ([heldBack]), never as taken.
 */
@Serializable
internal data class CrewChangeOrderPushResult(
    val inserted: Int = 0,
    val updated: Int = 0,
    val unchanged: Int = 0,
    val skipped: Int = 0
) {
    /** Orders the server wrote this call. */
    val written: Int get() = inserted + updated

    /**
     * Of [sent] orders, how many the server did not take: the ones it
     * skipped -- a job it will not show this person, an order tombstoned or
     * on another job, feet that are not a real number, a signature arriving
     * with terms the office has since changed -- and any it did not account
     * for at all. "unchanged" is taken: the server already holds that order
     * as this phone does, or holds terms that are the office's now.
     */
    fun heldBack(sent: Int): Int = maxOf(skipped, sent - (inserted + updated + unchanged), 0)
}

/**
 * A change-order push as two batches: orders to mark as inside an accepted
 * price, and every other order, which says nothing about it. A batch names
 * every column any of its rows carries, so mixing them would write an
 * explicit null onto every unmarked row -- harmless once the server's latch
 * is in (it keeps what it had), but a refusal of the whole batch on a
 * database the column has not reached yet.
 */
internal fun splitChangeOrdersByAcceptance(rows: List<CloudChangeOrder>): Pair<List<CloudChangeOrder>, List<CloudChangeOrder>> {
    val (marked, plain) = rows.partition { it.inAcceptedTotal == true }
    return plain.map { it.copy(inAcceptedTotal = null) } to marked
}

/** Whether [error], or anything that caused it, names [text] -- a column a database does not have yet, say. */
internal fun failureMentions(error: Throwable, text: String): Boolean =
    generateSequence(error) { it.cause }.any { it.message?.contains(text) == true }

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
    @SerialName("completed_at") val completedAt: String? = null,
    /**
     * Which shipped step this is, so a fresh install shows it translated
     * instead of stuck in whichever language it happened to be seeded in.
     *
     * Null here is not "clear the cloud's key" -- it is "this row has nothing
     * to say about the key." `explicitNulls = false` on the shared Json (see
     * [SupabaseModule]) drops a null field from the request body entirely, so
     * a keyless local row (hand-typed by a crew member, or seeded before this
     * column existed) leaves whatever key the server already holds alone on
     * push instead of blanking it. Only ever read on pull for the reverse
     * case: a keyless cloud row must not blank a key this phone already has.
     */
    @SerialName("step_key") val stepKey: String? = null
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
    @SerialName("review_note") val reviewNote: String = "",
    /**
     * Read only, and that is load-bearing.
     *
     * These are written by the office and by a database trigger, never by a
     * phone. They are on THIS class, which the pull decodes, and deliberately
     * NOT on [CloudTimeEntryPush], which the upsert sends -- because
     * PostgREST names every column explicitly, so a push carrying them would
     * send nulls and erase the correction the office had just made. An
     * explicit null beats a column default, which is the trap this codebase
     * has hit before.
     */
    @SerialName("original_started_at") val originalStartedAt: String? = null,
    @SerialName("original_ended_at") val originalEndedAt: String? = null,
    @SerialName("corrected_at") val correctedAt: String? = null,
    /**
     * Non-null with a default, on purpose, although the column is nullable
     * and null on most rows (7 of 9 live on 2026-09-18). Room's own
     * TimeEntry.correctionReason is `String = ""` and the pull merges with
     * `row.correctionReason.ifBlank { existing.correctionReason }`, so null
     * and "" already mean the same thing here: no reason recorded. The
     * shared Json has coerceInputValues = true (see cloudJson), which turns
     * the server's null into this default at the decoder instead of throwing
     * "Expected string literal but 'null' literal was found" and taking the
     * whole time_entries pull down with it -- on every sync, from 1.445 to
     * 1.501. Making it `String?` would only push a `?: ""` into two call
     * sites for the same result.
     */
    @SerialName("correction_reason") val correctionReason: String = "",
    /**
     * The unpaid break, in the same shape [CloudTimeEntryPush] sends it in --
     * see that class for why these three travel together with started_at/
     * ended_at rather than on every push. Null here means exactly what it
     * means in Room: nobody has recorded a break, never a break of zero.
     */
    @SerialName("break_minutes") val breakMinutes: Int? = null,
    @SerialName("break_started_at") val breakStartedAt: String? = null,
    @SerialName("break_ended_at") val breakEndedAt: String? = null
)

/**
 * What a phone sends for a shift the first time -- the insert-only pass of
 * [EntitySync.pushTimeEntries], built by [toInsertRow] and by nothing else.
 *
 * Every field the phone legitimately owns at the moment it records a shift,
 * and none of the ones the office owns. Splitting the shapes is the only way
 * to add a pull-only field safely: one class for both directions means every
 * push asserts a value for every column, including the ones it knows nothing
 * about.
 *
 * Only ever sent insert-only (`ignoreDuplicates`), so none of it can land on
 * a row the cloud already holds. That is what keeps an office correction of
 * the clock, the break or the decision standing: this class is how a shift is
 * BORN in the cloud, never how it is changed. The one later change a phone
 * may make goes as [CloudTimeEntryWorkerPatch].
 */
@Serializable
data class CloudTimeEntryPush(
    @SerialName("company_id") val companyId: String,
    @SerialName("sync_id") val syncId: String,
    @SerialName("job_sync_id") val jobSyncId: String,
    /**
     * Non-null, and that is the point.
     *
     * This used to be `String? = null` so an "update pass" could drop the key
     * and leave an office correction alone. But that pass was an upsert, and
     * Postgres checks NOT NULL on the proposed row before ON CONFLICT is
     * consulted -- so a row without started_at was refused 23502 on every
     * shift, on every sync, from 1.470 (proved 2026-09-21; see
     * [EntitySync.pushTimeEntries]). A shift row without its clock can no
     * longer be built at all.
     */
    @SerialName("started_at") val startedAt: String,
    @SerialName("ended_at") val endedAt: String? = null,
    /**
     * Sent, and then decided by the server: `stamp_time_entry_rate` replaces it
     * with the employee record's rate whenever there is one. Only ever sent on
     * the insert -- a later write of it could only re-assert a stale figure.
     */
    @SerialName("hourly_rate") val hourlyRate: Double = 0.0,
    @SerialName("employee_sync_id") val employeeSyncId: String = "",
    val notes: String = "",
    /**
     * The sign-off decision, for a shift the cloud has never held -- decided
     * offline or before its first upload ([TimeApproval.Outcome.NotInCloudYet]).
     *
     * On a row the cloud already holds, `approve_time_entry`
     * (supabase_p3_approve_time_entry.sql) owns the decision, and this pass
     * cannot reach that row anyway. A FOREMAN has APPROVE_TIME and not
     * SEE_PAY, and `time_entries_pay_needs_see_pay` hides a colleague's whole
     * row from anyone without SEE_PAY -- so the old upsert asserting
     * approved_at on a colleague's stored row was refused 42501. Measured live
     * on 2026-09-20; see [TimeApproval].
     */
    @SerialName("approved_at") val approvedAt: String? = null,
    @SerialName("approved_by") val approvedBy: String = "",
    @SerialName("rejected_at") val rejectedAt: String? = null,
    @SerialName("review_note") val reviewNote: String = "",
    /**
     * Set once, by the phone that recorded the break, exactly like started_at
     * and ended_at. `explicitNulls = false` drops a null from the body, so a
     * shift with no break recorded lands with the column null ("nobody
     * recorded one"), never 0 -- see [SupabaseModule].
     */
    @SerialName("break_minutes") val breakMinutes: Int? = null,
    @SerialName("break_started_at") val breakStartedAt: String? = null,
    @SerialName("break_ended_at") val breakEndedAt: String? = null
)

/**
 * The only thing a phone ever writes to a shift the cloud already holds: who
 * worked it, after a person picked again on the Time screen (the Fix action,
 * [TimeEntry.workerChangedAt]).
 *
 * Sent as a PATCH -- an UPDATE filtered by company_id and sync_id -- never as
 * an upsert, so it needs no started_at, and it names exactly one column, so
 * it cannot move the clock, the break, the notes or the decision the office
 * may have corrected. Built only by [workerChangeToSend].
 *
 * Refused server-side when it should be: moving a shift onto somebody who is
 * not on the company (`time_entry_needs_a_person`, 23514), or by an account
 * without SCHEDULE_AND_ASSIGN / APPROVE_TIME (`guard_time_entry_write_permission`,
 * 42501). Both proved in the same rolled-back probe.
 */
@Serializable
data class CloudTimeEntryWorkerPatch(
    @SerialName("employee_sync_id") val employeeSyncId: String
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
/**
 * The conflict rule, per table -- written down because launch audit #37 found
 * nobody could state it, and a rule nobody can state is a rule nobody can
 * defend. This is the actual behaviour of the code below and in [JobSync], not
 * an aspiration; keep it in sync with whichever function it describes.
 *
 * **jobs** (see [JobSync]) -- last-edit-wins on the whole row, gated by
 * `job.updatedAt > cloudJob.updatedAtMillis()`, with two carve-outs that are
 * never subject to the gate: `amount_paid`/`payment_status` only ever move up
 * (the higher figure survives regardless of which side is "newer"), and
 * `contract_total`/`priced_by`/`priced_at`/`pricing_engine_version`/
 * `quote_sent_at` are written only by the dedicated contract-total block, on
 * its own compare against the current cloud figure.
 *
 * **fence_runs** -- last-edit-wins on the whole row, gated by
 * `run.updatedAt > cloudRun.updatedAtMillis()` ([pushFenceRuns]).
 *
 * **pricing_tiers**, **material_items** (catalog) -- last-edit-wins gated the
 * same way ([pushPricingTiers], [pushCatalog]), but ONLY once a cloud row has
 * been claimed by this row's own sync id. A tier or catalog item with no
 * matching identity (name, or name+role+fenceType+colour) is pushed
 * unconditionally, because a starter row seeded independently on every phone
 * has no prior cloud copy to have gone stale against.
 *
 * **build_templates** -- pull-only gate, same clock, formal rather than load-
 * bearing: this phone never edits a template, so the compare mostly guards
 * against two pulls racing each other.
 *
 * **time_entries** -- NOT last-edit-wins, and split by column owner instead.
 * [pushTimeEntries] compares nothing against the cloud row. It sends each
 * completed shift once as an insert-only row carrying everything the phone
 * recorded (clock, break, notes, rate, worker, and a decision made before the
 * first upload), which cannot touch a row the cloud already holds; and after
 * that it writes a stored shift only to send a worker change a person made on
 * this phone ([TimeEntry.workerChangedAt]), as a PATCH naming
 * employee_sync_id alone. So the clock is written exactly once, by the phone
 * that recorded it, and nothing later from a phone re-asserts it -- or the
 * notes, the rate, or a worker the office has since moved. Corrections go
 * through `correct_time_entry` and decisions through `approve_time_entry`,
 * never through this push. (Until 2026-09-21 there was an "update pass" that
 * re-sent notes, rate, worker and decision for every shift on every sync; it
 * was an upsert without started_at and Postgres refused it 23502 every time
 * from 1.470 on -- see [pushTimeEntries].) What protects an approval or rejection from being
 * clobbered lives entirely on the pull side ([pullJobChildren]'s time-entries
 * block): a decision already recorded locally is a one-way ratchet that a
 * cloud row without a decision cannot undo, and a decision the cloud DOES
 * carry always wins outright, regardless of either side's clock. The four
 * correction columns are read-only on the pull and never blanked by a cloud
 * row that lacks them.
 *
 * **estimate_line_items** -- a per-row mark, not a clock
 * ([EstimateLineItem.pendingPush]): a line goes up only when this phone
 * changed it and the cloud has not taken the change yet, and the pull writes
 * the cloud's copy over every line that is not so marked ([pullMayWriteLine]).
 * Two phones therefore resolve last-writer-wins on real edits only, instead
 * of each re-sending its whole copy on every pass. Line items go up only
 * from a phone confirmed ALLOWED -- never a crew phone, whose money-scrubbed
 * catalog builds a different takeoff (see [pushAll]) -- and the pull never
 * writes back a line this phone has a delete queued for ([lineItemsToApply]).
 *
 * **change_orders** -- last-edit-wins is not expressed as a push-side gate
 * beyond the job clock; the push sends the current local row, and the
 * merge-on-pull applies whatever the cloud holds. A phone that may see money
 * upserts the table; a crew phone goes through crew_push_change_orders
 * ([changeOrderDoor]), which freezes the terms once the office has priced
 * them, a customer has accepted them or signed them, and takes a signature
 * once -- so a crew phone's stale copy cannot undo the office's edit.
 *
 * **employees**, **manufacturers** -- unconditional upsert on every push
 * ([pushEmployees], [pushManufacturers]); the phone is the source of truth and
 * there is no merge to arbitrate.
 *
 * **field_changes** -- append-only requests plus (for the phones allowed to
 * answer them) an update of the answer half; not a last-edit-wins table at all.
 *
 * The clock used everywhere above that says "gated" is `updated_at`/
 * `lastUpdated`/`updatedAt` -- always the device's own clock on the local side
 * ([Repository]'s save/update functions stamp it with
 * `System.currentTimeMillis()` at edit time) compared against the server's own
 * clock on the cloud side (`updated_at` is written by the `touch_updated_at`
 * trigger in Postgres, never sent by the phone). A phone with a wrong clock
 * therefore wins or loses every one of these comparisons regardless of which
 * edit is actually newer -- confirmed still true as of this audit pass. Fixing
 * it means changing how [Repository] stamps a local edit, which is outside
 * this file; see the launch-audit report for the details.
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
    suspend fun pushAll(
        repository: Repository,
        companyId: String,
        scope: MoneyScope,
        // Employee pay -- has_permission('SEE_PAY') -- which is a different
        // door from [scope]'s job money and is what decides whether this phone
        // can write a colleague's shift at all. Asked once per pass in
        // AutoSync, beside [scope], and handed down here rather than re-asked,
        // for the same reason [scope] is: one transient failure must not read
        // as "not allowed" for one table and as the real answer for another.
        // No default value on purpose -- a default is how a caller that was
        // never updated keeps the old behaviour silently.
        employeePayScope: MoneyScope,
        // True on the one pass right after a DENIED->ALLOWED promotion: pull
        // has to restore real prices and rates before push runs at all, or
        // this phone's zero-priced local copies -- cached from the money-free
        // door -- go straight through the now-open owner door ahead of the
        // pull that would have fixed them. See AutoSync.runSync.
        skipMoneySensitivePushes: Boolean = false
    ): Result<Int> =
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
                        // A real fault outranks a dead spot that failed first,
                        // so the one worth reporting is the one kept (see
                        // SyncFailure.toReport, which AutoSync asks next).
                        val kept = firstRealFailure
                        if (kept == null || (SyncFailure.isTransientNetwork(kept) && !SyncFailure.isTransientNetwork(e))) {
                            firstRealFailure = e
                        }
                        android.util.Log.w("EntitySync", "push $what failed", e)
                    }
                }
            }

            // The job children are gathered FIRST, before this pass pushes
            // anything. collectJobChildRows holds back a job's children when
            // the cloud's job clock is newer than this phone's, and it used to
            // read that clock after the fence runs had gone up. On an approved
            // job the first drawing change's run push fires the server's
            // reapproval_on_drawing_change, which withdraws the approval on
            // the job row (quote_approved_at, reapproval_required_at,
            // reapproval_count -- none of them quiet), so updated_at moved
            // under this very pass: the gate then held back that job's punch
            // list, steps, markers and field changes, and the pull put the
            // cloud's older copies over them. Read now, the clocks are the
            // ones JobSync has just reconciled, not ones this pass moved.
            // (Line items no longer pass through that gate at all -- they go
            // up by their own pendingPush mark -- but the rest still do.)
            val rows: JobChildRows? = if (skipMoneySensitivePushes) null else
                runCatching { collectJobChildRows(repository, companyId, scope) }
                    .onFailure { e ->
                        firstRealFailure = e
                        android.util.Log.w("EntitySync", "collect job children failed", e)
                    }
                    .getOrNull()

            step("employees")      { pushEmployees(repository, companyId, scope) }
            step("manufacturers")  { pushManufacturers(repository, companyId) }
            // The crew-door read collectJobChildRows made (null when it failed,
            // or was skipped on the promotion pass, which is ALLOWED anyway).
            step("fence runs")     { pushFenceRuns(repository, companyId, scope, rows?.cloudTouchedAt) }
            step("time entries")   { pushTimeEntries(repository, companyId, employeePayScope) }

            // A DENIED phone holds zero prices for everything in the catalog
            // and every tier; pushing them would be refused at best (1 + up
            // to 200 requests per table for nothing) and would assert a false
            // zero at worst. Skipped outright rather than attempted and
            // swallowed, so this is not counted against the phone at all.
            if (scope == MoneyScope.ALLOWED && !skipMoneySensitivePushes) {
                step("catalog")        { pushCatalog(repository, companyId) }
                step("pricing tiers")  { pushPricingTiers(repository, companyId) }
            }

            // Each child table is its OWN step, deliberately -- see
            // [collectJobChildRows]'s doc for the bug this fixes: the six
            // upserts used to run inside one function and one throw from the
            // first (say, a DENIED phone's line items) meant punch list,
            // steps, markers and plan-change requests never went up either,
            // on every build old enough to still hit that door. Splitting
            // them holds for every scope, not only the money-gated one.
            if (rows != null) {
                step("line items") {
                    when (scope) {
                        MoneyScope.ALLOWED -> pushLineItems(repository, rows.lineItems, rows.lineItemSources)
                        // Nothing, from a crew phone. It used to go through
                        // crew_push_line_items, which drops prices but WRITES
                        // quantity and description -- and a crew phone's
                        // takeoff is not the office's: its catalog has every
                        // price scrubbed to zero, so the product pick breaks
                        // ties by sync id and lands on other posts and panels,
                        // and its copy of the drawing can be stale. The owner's
                        // phone and a crew phone overwrote each other's
                        // quantities on every sync (161 flips, 2026-09-17..21:
                        // Woody's concrete 3 and 85, John Beaunissant's panels
                        // 402 and 177, back and forth). No crew screen edits a
                        // line item, so nothing a crew member did is lost by
                        // not sending them; the estimate is priced by people
                        // who can see prices.
                        MoneyScope.DENIED -> 0
                        MoneyScope.UNKNOWN -> 0
                    }
                }
                step("expenses") {
                    // Deliberately app-level, not a server refusal: the
                    // expenses READ policy is unchanged by this feature (the
                    // 26-Aug decision), but an amount is still money, and a
                    // DENIED or unresolved phone does not push one.
                    if (scope == MoneyScope.ALLOWED) upsert("expenses", rows.expenses) else 0
                }
                step("punch list") { upsert("punch_list_items", rows.punch) }
                step("change orders") {
                    when (changeOrderDoor(scope)) {
                        ChangeOrderDoor.TABLE -> {
                            // Two batches -- see splitChangeOrdersByAcceptance --
                            // each sent in batches whose rows name the same
                            // columns (changeOrdersInSameColumnBatches), so an
                            // unsigned copy never writes NULL over a signature.
                            // Both halves are attempted whatever the other did;
                            // the first failure is what the step reports.
                            val (plain, marked) = splitChangeOrdersByAcceptance(rows.orders)
                            val plainResult = runCatching {
                                changeOrdersInSameColumnBatches(plain).sumOf { upsert("change_orders", it) }
                            }
                            // A database the column has not reached yet
                            // refuses the marked batch outright; those orders
                            // still go up, unmarked, rather than failing the
                            // sync on every pass until the migration lands.
                            // The phone keeps its mark and sends it again.
                            val markedResult = runCatching {
                                changeOrdersInSameColumnBatches(marked).sumOf { upsert("change_orders", it) }
                            }.recoverCatching { e ->
                                if (!failureMentions(e, "in_accepted_total")) throw e
                                changeOrdersInSameColumnBatches(marked.map { it.copy(inAcceptedTotal = null) })
                                    .sumOf { upsert("change_orders", it) }
                            }
                            plainResult.exceptionOrNull()?.let { throw it }
                            markedResult.exceptionOrNull()?.let { throw it }
                            plainResult.getOrDefault(0) + markedResult.getOrDefault(0)
                        }
                        // The crew's own door, as crew_save_job is for jobs.
                        // An order the server skipped stays on this phone and
                        // goes again next pass (every pass sends every order
                        // on a job it may push), and is counted as held back
                        // so the phone never says everything is backed up
                        // over it. A refusal of the whole call (42501: signed
                        // out, suspended, no field-work permission) throws on
                        // to step(), which counts it the same way; so does a
                        // server this function has not reached yet.
                        ChangeOrderDoor.CREW_RPC -> {
                            val tally = runCatching { pushChangeOrdersThroughCrewDoor(rows.orders) }
                                .getOrElse { e ->
                                    if (!isNotDeployedYet(e)) throw e
                                    android.util.Log.i("EntitySync", "crew_push_change_orders is not on this server yet; change orders kept on this phone")
                                    CrewChangeOrderTally(written = 0, heldBack = rows.orders.size)
                                }
                            if (tally.heldBack > 0) {
                                skipped += 1
                                android.util.Log.i(
                                    "EntitySync",
                                    "push change orders: ${tally.heldBack} of ${rows.orders.size} not taken by crew_push_change_orders; kept on this phone for retry"
                                )
                            }
                            tally.written
                        }
                        ChangeOrderDoor.NONE -> 0
                    }
                }
                step("job steps")     { upsert("job_steps", rows.steps) }
                step("site markers")  { upsert("site_markers", rows.markers) }
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
                step("field changes") { pushFieldChanges(rows.changes) }
            }

            // A negative count carries "some of this did not go up" back to the
            // caller without inventing a new return type for one fact. The
            // caller only ever compares it against zero.
            firstRealFailure?.let { Result.failure(it) }
                ?: Result.success(if (skipped > 0) -pushed - 1 else pushed)
        }

    /** Everything [collectJobChildRows] gathers for the jobs eligible to push this pass. */
    private data class JobChildRows(
        val lineItems: List<CloudLineItem> = emptyList(),
        /** The local rows [lineItems] were built from, as read, for Repository.markLineItemsPushed. */
        val lineItemSources: List<EstimateLineItem> = emptyList(),
        val expenses: List<CloudExpense> = emptyList(),
        val punch: List<CloudPunchItem> = emptyList(),
        val orders: List<CloudChangeOrder> = emptyList(),
        val steps: List<CloudJobStep> = emptyList(),
        val markers: List<CloudSiteMarker> = emptyList(),
        val changes: List<CloudFieldChange> = emptyList(),
        /**
         * Each job's cloud clock and tombstone as read this pass, from the door
         * this phone reads -- null when that read failed. Handed on to
         * pushFenceRuns (mayPushJobRuns), so the runs are judged against the
         * same answer as every other child.
         */
        val cloudTouchedAt: Map<String, Pair<Long, Boolean>>? = null
    )

    /**
     * Everything that hangs off a job: line items, expenses, punch list,
     * change orders, checklists, site markers and field changes.
     *
     * Collected in one pass over the jobs so the whole set costs one request
     * per table rather than one per job. Building the rows is kept separate
     * from pushing them (see [pushAll]) -- these used to be six upserts plus
     * the field_changes push run back to back inside one function, all under
     * one try: the first refusal (a DENIED phone's line items, once the
     * policy flips) threw before punch list, steps, markers or plan-change
     * requests ever got a turn, and a crew member's whole day of field work
     * sat on their handset over a table they were never sending in the first
     * place.
     */
    private suspend fun collectJobChildRows(
        repository: Repository,
        companyId: String,
        scope: MoneyScope
    ): JobChildRows {
        val allJobs = repository.getAllJobs()
        if (allJobs.isEmpty()) return JobChildRows()

        // Line items by their own mark, not by the job clock below: every
        // line changed here and not yet taken by the cloud
        // (EstimateLineItem.pendingPush), plus any still waiting to be revived.
        // Read first, before the cloud call, so a line changed while that call
        // is in flight is simply sent next pass.
        val waitingRevival = repository.lineItemResurrections.pending()
        val lineSources = repository.getAllLineItemsByJob().values.flatten()
            .filter { it.pendingPush || it.syncId in waitingRevival }

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
        //
        // ALLOWED reads "jobs"; anything else reads "jobs_crew" -- readable by
        // any signed-in company member regardless of SEE_MONEY, so this stays
        // accurate rather than silently empty even under UNKNOWN.
        // Null when the read failed -- which is not the same as "the cloud has
        // none of these" (see mayPushJobChildren).
        val cloudTouchedAt: Map<String, Pair<Long, Boolean>>? = runCatching {
            // Paged: this is the push-side "what does the cloud already have"
            // read, so a truncation here is worse than on a pull -- it decides
            // which jobs' children get held back, and a job past the first
            // thousand would silently read as "cloud has nothing newer" and
            // let this phone push stale children over it.
            val rows = if (scope == MoneyScope.ALLOWED)
                pagedList<CloudJob>("jobs") {
                    // sees-tombstones: this reads WHEN each job last changed, not
                    // what it contains. A job deleted elsewhere has a very recent
                    // timestamp, and its children are exactly the ones this phone
                    // must not push back up -- so hiding the tombstone here would
                    // resurrect them through the side door.
                    eq("company_id", companyId)
                }
            else
                pagedList<CloudJob>("jobs_crew") {
                    // sees-tombstones: same reasoning as the "jobs" branch --
                    // a job tombstoned elsewhere still has to stop this phone
                    // pushing its children back up, and the view carries
                    // deleted_at same as the base table.
                    eq("company_id", companyId)
                }
            rows.associate { it.syncId to (it.updatedAtMillis() to (it.deletedAt != null)) }
        }.getOrNull()

        // A line changed here still never goes up for a job deleted
        // elsewhere: its children are exactly what must not come back. Nor
        // for a job this person is no longer on (Job.accessEndedAt): the line
        // stays marked, and goes up if access comes back.
        val jobById = allJobs.associateBy { it.id }
        val runSyncIdById = repository.getAllFenceRunsByJob().values.flatten().associate { it.id to it.syncId }
        val sentLines = lineSources.filter { line ->
            val job = jobById[line.jobId] ?: return@filter false
            job.accessEndedAt == null && cloudTouchedAt?.get(job.syncId)?.second != true
        }
        val lineItems = sentLines.map { it.toCloud(companyId, jobById.getValue(it.jobId).syncId, runSyncIdById) }

        val jobs = allJobs.filter { job -> mayPushJobChildren(job, cloudTouchedAt, scope) }
        if (jobs.isEmpty()) {
            return JobChildRows(lineItems = lineItems, lineItemSources = sentLines, cloudTouchedAt = cloudTouchedAt)
        }

        val expenses = mutableListOf<CloudExpense>()
        val punch = mutableListOf<CloudPunchItem>()
        val orders = mutableListOf<CloudChangeOrder>()
        val steps = mutableListOf<CloudJobStep>()
        val markers = mutableListOf<CloudSiteMarker>()
        val changes = mutableListOf<CloudFieldChange>()

        jobs.forEach { job ->
            val js = job.syncId
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
                    it.signedAt?.let { at -> Instant.ofEpochMilli(at).toString() },
                    // Only ever sent as true (see splitChangeOrdersByAcceptance).
                    inAcceptedTotal = if (it.inAcceptedTotal) true else null,
                    // The uploaded image's storage path, never the file on
                    // this phone -- see changeOrderSignaturePathToSend.
                    signatureStoragePath = changeOrderSignaturePathToSend(it, companyId, js)
                )
            }
            repository.getJobSteps(job.id).forEach {
                steps += CloudJobStep(
                    companyId, it.syncId, js, it.kind.name, it.description,
                    it.checked, it.verifiedWithCustomer, it.sortOrder,
                    it.completedAt?.let { at -> CloudTime.format(at) },
                    // Null when this phone has no key for the step; the class
                    // KDoc on stepKey explains why that never blanks a key the
                    // server already holds.
                    stepKey = it.stepKey
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

        return JobChildRows(
            lineItems = lineItems, lineItemSources = sentLines, expenses = expenses, punch = punch,
            orders = orders, steps = steps, markers = markers, changes = changes,
            cloudTouchedAt = cloudTouchedAt
        )
    }

    /**
     * Line items from a phone that prices, in two upserts: the ordinary rows,
     * and the rows that revive a tombstone ([reviveLineItems] for why they
     * can never share one).
     *
     * A reviving row is one a regenerate on this phone just wrote under a
     * sync id the cloud may hold deleted (Repository.lineItemResurrections).
     * It is sent with `deleted_at: null` -- the same resurrection price-job's
     * commit does -- and forgotten once the cloud has taken it. If that
     * upsert fails, the ids stay waiting: the reaper keeps sparing them and
     * the next pass tries again, since sending a revival twice changes
     * nothing. Both halves are attempted whatever the other did, and the
     * first failure is what the step reports.
     *
     * Sent a chunk at a time, and each chunk the cloud took has its lines'
     * pendingPush cleared -- where the row still holds what went up
     * (Repository.markLineItemsPushed). A chunk that failed stays marked and
     * goes again next pass; the pull leaves marked lines alone meanwhile.
     */
    private suspend fun pushLineItems(
        repository: Repository,
        lineItems: List<CloudLineItem>,
        sources: List<EstimateLineItem>
    ): Int {
        val (plain, reviving) = reviveLineItems(lineItems, repository.lineItemResurrections.pending())
        val sourceBySyncId = sources.associateBy { it.syncId }
        var sent = 0
        var firstFailure: Throwable? = null

        plain.chunked(200).forEach { chunk ->
            runCatching { upsert("estimate_line_items", chunk) }
                .onSuccess { n ->
                    sent += n
                    repository.markLineItemsPushed(chunk.mapNotNull { sourceBySyncId[it.syncId] })
                }
                .onFailure { if (firstFailure == null) firstFailure = it }
        }
        reviving.chunked(200).forEach { chunk ->
            runCatching { upsert("estimate_line_items", chunk) }
                .onSuccess { n ->
                    sent += n
                    repository.lineItemResurrections.confirmPushed(chunk.map { it.syncId })
                    repository.markLineItemsPushed(chunk.mapNotNull { sourceBySyncId[it.syncId] })
                }
                .onFailure { if (firstFailure == null) firstFailure = it }
        }
        firstFailure?.let { throw it }
        return sent
    }

    /** What one crew change-order push came to: orders written, and orders the server did not take. */
    internal data class CrewChangeOrderTally(val written: Int, val heldBack: Int)

    /**
     * A crew phone's change orders, through crew_push_change_orders
     * (supabase_r6_crew_change_orders.sql) a batch at a time.
     *
     * The server writes only what the crew may: a new order, and the terms
     * (description, extra feet) of one nobody has priced, accepted or signed
     * yet; the signing date and image path once each, never over another. It
     * never writes money and never deletes. Row by row it SKIPS what it will
     * not take -- counted, not raised, so one stale order cannot sink the
     * batch -- and those are held back here ([CrewChangeOrderPushResult.heldBack]).
     * Nothing on this phone is marked as sent either way: change orders carry
     * no such mark, and every pass sends every order on the jobs it may push.
     *
     * An answer that will not decode is treated as nothing taken: an answer
     * nobody can read is not news that the orders arrived.
     *
     * A refusal of the whole call (42501) is thrown, not counted, so the
     * caller's step() files it the way it files every refusal: held back, not
     * a crash, and not the database's words on screen. It is a verdict on the
     * caller, so the batches after it are not tried.
     */
    private suspend fun pushChangeOrdersThroughCrewDoor(orders: List<CloudChangeOrder>): CrewChangeOrderTally {
        if (orders.isEmpty()) return CrewChangeOrderTally(written = 0, heldBack = 0)
        var written = 0
        var heldBack = 0
        orders.chunked(200).forEach { chunk ->
            val answer = SupabaseModule.client.postgrest.rpc(
                "crew_push_change_orders",
                buildJsonObject { put("rows_in", crewChangeOrderRows(chunk)) }
            )
            val result = runCatching { answer.decodeAs<CrewChangeOrderPushResult>() }.getOrNull()
            if (result == null) {
                heldBack += chunk.size
            } else {
                written += result.written
                heldBack += result.heldBack(chunk.size)
            }
        }
        return CrewChangeOrderTally(written = written, heldBack = heldBack)
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

        // Paged: another push-side compare, so a truncation here means items
        // past row one thousand look unclaimed and get duplicated upward.
        val cloudByIdentity = pagedList<CloudMaterialItem>("material_items") {
            // sees-tombstones: as above -- a deleted catalog item keeps its
            // identity reserved so this phone does not push a fresh copy.
            eq("company_id", companyId)
        }
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
        // Paged: same push-side-compare risk as the catalog above -- a tier
        // name past the first thousand rows would read as unclaimed and get
        // re-created under a fresh id every sync.
        val cloudByName = pagedList<CloudPricingTier>("pricing_tiers") {
            // sees-tombstones: a name held by a deleted row must stay taken, or
            // this phone re-creates it and emptying the trash never sticks.
            eq("company_id", companyId)
        }
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
                // No connection for the batch is no connection for each row
                // in it. Retrying them one by one while offline sent 125
                // doomed requests and reported "125 of 125 rows rejected"
                // (job_steps, 1.509) -- no row was rejected; none arrived.
                // The next pass sends the lot.
                //
                // Only when the request never left the phone, though. A chunk
                // that timed out or lost its connection half way still falls
                // back to single rows: on a slow upload link 200 rows can
                // outlast the client's ten-second timeout every pass while
                // each row alone gets through, and stopping there left the
                // table never syncing with nothing reported.
                whole.exceptionOrNull()?.let { if (SyncFailure.neverReachedServer(it)) throw it }
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
    suspend fun pullAll(
        repository: Repository,
        companyId: String,
        scope: MoneyScope,
        employeePayScope: MoneyScope
    ): Result<Int> =
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
                    async { runCatching { netGate.withPermit { pullEmployees(repository, companyId, employeePayScope) } } },
                    async { runCatching { netGate.withPermit { pullManufacturers(repository, companyId) } } },
                    // Tiers are SEE_MONEY-gated at the base table; asking
                    // while not confirmed ALLOWED would read an empty answer
                    // as "the office cleared every tier," which is exactly
                    // the class of bug this whole feature exists to close.
                    async { runCatching { netGate.withPermit {
                        if (scope == MoneyScope.ALLOWED) pullPricingTiers(repository, companyId) else 0
                    } } },
                    // UNKNOWN skips the catalog outright -- unlike job
                    // children below, there is no non-money remainder of
                    // pullCatalog worth preserving; unitPrice is most of what
                    // it carries.
                    async { runCatching { netGate.withPermit {
                        if (scope == MoneyScope.UNKNOWN) 0 else pullCatalog(repository, companyId, scope)
                    } } },
                    async { runCatching { netGate.withPermit { pullFenceRuns(repository, companyId) } } },
                    // Called for every scope, UNKNOWN included: punch list,
                    // job steps, site markers and field changes carry no
                    // money and must keep arriving even when the door itself
                    // could not be asked about. Only its internal line-item,
                    // expense and change-order blocks gate on scope.
                    async { runCatching { netGate.withPermit { pullJobChildren(repository, companyId, scope, employeePayScope) } } },
                    async { runCatching { netGate.withPermit { pullBuildTemplates(repository, companyId) } } }
                ).awaitAll()
            }
            val failures = results.mapNotNull { it.exceptionOrNull() }
            // A real fault first, a dead spot only if that is all there was.
            val realFailure = SyncFailure.toReport(failures) ?: failures.firstOrNull { !isNotOursToSync(it) }
            realFailure?.let { Result.failure<Int>(it) }
                ?: Result.success(results.sumOf { it.getOrDefault(0) })
        }

    private suspend fun pullPricingTiers(repository: Repository, companyId: String): Int {
        // Paged, same reason as every other pull below: an unpaged read
        // truncates at 1000 with no error, and a tier past that line would
        // read as "the office deleted it."
        val cloud = pagedList<CloudPricingTier>("pricing_tiers") {
            eq("company_id", companyId); notDeleted()
        }
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

    /**
     * Shipped templates plus this company's own -- the first piece of the
     * office setting a client up without a phone reaching the phone at all.
     *
     * Matched on syncId only, unlike [pullPricingTiers]/[pullCatalog]: those
     * exist because every phone used to seed its own copy of the same
     * starter data with a random id apiece, so two phones' "Residential"
     * tiers had to be reconciled by name. Templates are never seeded on the
     * phone -- they only ever arrive from here, with the sync id the office
     * or the shipped-row migration already gave them -- so there is no
     * local-only copy under a different id to adopt.
     *
     * Gated last-edit-wins on `updated_at`, the same clock pricing tiers use:
     * a template this phone has not seen changes only when the cloud's copy
     * is actually newer. In practice this phone never edits a template, so
     * the gate is mostly a formality against two pulls racing -- but it is
     * the same rule every other pull-and-compare table uses, and there is no
     * reason to invent a second one here.
     */
    private suspend fun pullBuildTemplates(repository: Repository, companyId: String): Int {
        // Paged, same trap as the rest of this pass.
        val cloud = pagedList<CloudBuildTemplate>("build_templates") {
            // No company_id filter: RLS on build_templates already restricts
            // a select to "company_id is null (shipped) or mine", which is
            // exactly shipped union own -- asking for everything visible IS
            // asking for that set, with nothing extra to intersect here.
            notDeleted()
        }
        val localBySyncId = repository.getAllBuildTemplates().associateBy { it.syncId }

        val toUpsert = cloud.mapNotNull { row ->
            val existing = localBySyncId[row.syncId]
            if (existing != null && row.updatedAtMillis() <= existing.updatedAt) null else row.toLocal()
        }
        if (toUpsert.isEmpty()) return 0
        repository.saveBuildTemplatesFromCloud(toUpsert)
        return toUpsert.size
    }

    private suspend fun pullCatalog(repository: Repository, companyId: String, scope: MoneyScope): Int {
        // Paged, same trap as the rest of this pass.
        val cloud = if (scope == MoneyScope.DENIED)
            pagedList<CloudMaterialItem>("material_items_crew") {
                eq("company_id", companyId); notDeleted()
            }
        else
            pagedList<CloudMaterialItem>("material_items") {
                eq("company_id", companyId); notDeleted()
            }
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
                            // material_items_crew carries no unit_price column
                            // at all, so a DENIED pull would otherwise decode
                            // CloudMaterialItem's bare 0.0 and wipe the real
                            // price this phone already has cached.
                            unitPrice = if (scope == MoneyScope.ALLOWED) row.unitPrice else existing.unitPrice,
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
                        unitPrice = if (scope == MoneyScope.ALLOWED) row.unitPrice else sameThing.unitPrice,
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
                    unitPrice = if (scope == MoneyScope.ALLOWED) row.unitPrice else 0.0,
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
    private suspend fun pullJobChildren(
        repository: Repository,
        companyId: String,
        scope: MoneyScope,
        // Shift pay is gated on SEE_PAY, not SEE_MONEY: a salesperson holds
        // SEE_MONEY and no SEE_PAY, and time_entries now hides the whole row
        // from anyone without SEE_PAY (supabase_sec_time_entries_pay.sql), the
        // same shape employees already had. Reading the base table on
        // SEE_MONEY would come back empty and read as "no shifts".
        payScope: MoneyScope
    ): Int {
        val jobIdBySyncId = repository.getAllJobs().associateBy({ it.syncId }, { it.id })
        if (jobIdBySyncId.isEmpty()) return 0
        var added = 0

        // Line items, gated on scope: UNKNOWN cannot tell which table is safe
        // to trust and skips both the read and the merge entirely. DENIED
        // reads the money-free view and the merge below never lets a price
        // move.
        if (scope != MoneyScope.UNKNOWN) {
            // Clears out orphans left by the old pull, which dropped every line item
            // into "Other Items" because it discarded the run. Only auto-generated,
            // role-bearing lines are removed -- anything typed by hand has no role
            // and is left exactly where it is.
            repository.deleteOrphanedGeneratedLineItems()

            // Paged. This is the table that reaches a thousand first: about
            // twenty-five lines a job, so roughly forty jobs in.
            val lineItems = pagedList<CloudLineItem>(
                if (scope == MoneyScope.DENIED) "estimate_line_items_crew" else "estimate_line_items"
            ) { eq("company_id", companyId); notDeleted() }
            val runIdBySyncId = jobIdBySyncId.values
                .flatMap { repository.getFenceRuns(it) }.associate { it.syncId to it.id }
            val localItemsBySyncId = jobIdBySyncId.values
                .flatMap { repository.getLineItems(it) }.associateBy { it.syncId }
            // Deletes this phone made and the cloud has not taken yet. See
            // [lineItemsToApply]: their cloud rows are still live, and must
            // not be written back here while the delete waits. Through
            // pendingDeletionsForSync, so a stale entry for a line that is
            // alive again (an old build's) no longer stops this phone taking
            // the office's changes to it.
            val queuedDeletes = repository.pendingDeletionsForSync()
                .filter { it.tableName == "estimate_line_items" }
                .map { it.syncId }
                .toSet()

            // Refuse legacy orphans outright rather than pulling them and cleaning
            // up afterwards. A row with a real material role but no run was pushed
            // before line items carried their run; re-inserting it just recreates
            // the stray item, and the cleanup and the pull chase each other forever.
            // Hand-typed extras have role NONE or none at all, and still come down.
            val (legacyOrphans, usable) = lineItems.partition { row ->
                row.fenceRunSyncId == null && row.role != null && row.role != "NONE"
            }
            legacyOrphans.forEach { row ->
                // Not when this phone holds a live line under that id: a
                // queued delete for a live line is exactly what
                // pendingDeletionsForSync cancels as stale, and the two would
                // chase each other on every pass. (None exist in production
                // today; the rule is what keeps "a live line never has a
                // queued delete" true.)
                if (localItemsBySyncId[row.syncId] == null) {
                    repository.queueDeletion(row.syncId, "estimate_line_items")
                }
            }

            lineItemsToApply(usable, queuedDeletes).forEach { row ->
                val jobId = jobIdBySyncId[row.jobSyncId] ?: return@forEach
                val role = row.role?.let { r -> runCatching { MaterialRole.valueOf(r) }.getOrNull() }
                    ?: MaterialRole.NONE
                val existing = localItemsBySyncId[row.syncId]
                // A line changed here and not yet up stays as it is; it goes
                // up next pass (see pullMayWriteLine).
                if (!pullMayWriteLine(existing)) return@forEach
                if (existing == null) {
                    // A job (or run) gone mid-pass skips the row: see OrphanRows.
                    skipIfOrphaned { repository.saveLineItemFromCloud(
                        EstimateLineItem(
                            syncId = row.syncId, jobId = jobId,
                            fenceRunId = row.fenceRunSyncId?.let { runIdBySyncId[it] },
                            sortOrder = row.sortOrder, description = row.description,
                            quantity = row.quantity, unit = row.unit,
                            unitPrice = if (scope == MoneyScope.ALLOWED) row.unitPrice else 0.0,
                            taxable = row.taxable,
                            role = role,
                            isAutoGenerated = row.autoGenerated,
                            supplierUnitPrice = if (scope == MoneyScope.ALLOWED) row.supplierUnitPrice else 0.0
                        )
                    ) } ?: return@forEach
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
                    //
                    // unitPrice/supplierUnitPrice never move under DENIED: the
                    // crew view carries neither column, so row.unitPrice here
                    // is CloudLineItem's bare 0.0/null, not a real answer.
                    val merged = existing.copy(
                        fenceRunId = row.fenceRunSyncId?.let { runIdBySyncId[it] } ?: existing.fenceRunId,
                        sortOrder = row.sortOrder,
                        description = row.description,
                        quantity = row.quantity,
                        unit = row.unit,
                        unitPrice = if (scope == MoneyScope.ALLOWED) row.unitPrice else existing.unitPrice,
                        taxable = row.taxable,
                        role = role,
                        isAutoGenerated = row.autoGenerated,
                        supplierUnitPrice = if (scope == MoneyScope.ALLOWED) row.supplierUnitPrice else existing.supplierUnitPrice
                    )
                    if (merged != existing) {
                        skipIfOrphaned { repository.saveLineItemFromCloud(merged) } ?: return@forEach
                        added++
                    }
                }
            }
        }

        // Deliberately app-level, same as the push side: the expenses READ
        // policy is unchanged by this feature, but an amount is still money,
        // and only a confirmed ALLOWED phone pulls it down.
        if (scope == MoneyScope.ALLOWED) {
        // Paged, same trap as the rest of this pass.
        val expenses = pagedList<CloudExpense>("expenses") {
            eq("company_id", companyId); notDeleted()
        }
        val localExpensesBySyncId = jobIdBySyncId.values
            .flatMap { repository.getExpenses(it) }.associateBy { it.syncId }
        expenses.forEach { row ->
            // See CloudExpense.syncId: a null decodes as "" rather than
            // killing the pull, and a row with no identity is skipped.
            if (row.syncId.isBlank()) return@forEach
            val jobId = jobIdBySyncId[row.jobSyncId] ?: return@forEach
            val category = runCatching { ExpenseCategory.valueOf(row.category) }
                .getOrDefault(ExpenseCategory.OTHER)
            val existing = localExpensesBySyncId[row.syncId]
            if (existing == null) {
                skipIfOrphaned { repository.saveExpense(
                    Expense(
                        syncId = row.syncId, jobId = jobId,
                        category = category,
                        description = row.description, amount = row.amount
                    )
                ) } ?: return@forEach
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
                if (merged != existing) { skipIfOrphaned { repository.updateExpense(merged) } ?: return@forEach; added++ }
            }
        }
        }

        // Paged, same trap as the rest of this pass.
        val punch = pagedList<CloudPunchItem>("punch_list_items") {
            eq("company_id", companyId); notDeleted()
        }
        val localPunchBySyncId = jobIdBySyncId.values
            .flatMap { repository.getPunchList(it) }.associateBy { it.syncId }
        punch.forEach { row ->
            // See CloudPunchItem.syncId: same rule as expenses above.
            if (row.syncId.isBlank()) return@forEach
            val jobId = jobIdBySyncId[row.jobSyncId] ?: return@forEach
            val existing = localPunchBySyncId[row.syncId]
            if (existing == null) {
                skipIfOrphaned { repository.addPunchListItem(
                    PunchListItem(
                        syncId = row.syncId, jobId = jobId,
                        description = row.description, resolved = row.resolved
                    )
                ) } ?: return@forEach
                added++
            } else {
                // Ticking a callback off on site has to reach the office.
                // copy() keeps createdAt, resolvedAt and the local photo path.
                val merged = existing.copy(
                    description = row.description,
                    resolved = row.resolved
                )
                if (merged != existing) { skipIfOrphaned { repository.updatePunchListItem(merged) } ?: return@forEach; added++ }
            }
        }

        // Paged, same trap as the rest of this pass.
        val cloudChanges = pagedList<CloudFieldChange>("field_changes") {
            eq("company_id", companyId); notDeleted()
        }
        val localChangesBySyncId = jobIdBySyncId.values
            .flatMap { repository.getFieldChanges(it) }.associateBy { it.syncId }
        // The table that hit the foreign key on 2026-09-21 -- see OrphanRows.
        added += mergeFieldChanges(
            cloudChanges, jobIdBySyncId, localChangesBySyncId,
            insert = { repository.recordFieldChange(it) },
            update = { repository.updateFieldChangeFromCloud(it) }
        )

        // These four were pushed but never pulled back, so switching phones lost
        // signed change orders and clocked hours -- money and payroll records --
        // along with job checklists and site markers.

        // Change orders, gated the same way as line items above: UNKNOWN
        // skips outright, DENIED reads the money-free view and never moves a
        // cost.
        if (scope != MoneyScope.UNKNOWN) {
        // Paged, same trap as the rest of this pass.
        val orders = if (scope == MoneyScope.DENIED)
            pagedList<CloudChangeOrder>("change_orders_crew") {
                eq("company_id", companyId); notDeleted()
            }
        else
            pagedList<CloudChangeOrder>("change_orders") {
                eq("company_id", companyId); notDeleted()
            }
        val localOrdersBySyncId = jobIdBySyncId.values
            .flatMap { repository.getChangeOrders(it) }.associateBy { it.syncId }
        orders.forEach { row ->
            val jobId = jobIdBySyncId[row.jobSyncId] ?: return@forEach
            // The fact and date of signing, and where the image is in cloud
            // storage (pulledSignatureStoragePath) -- JobFileUploader's
            // downloadMissing fetches the image itself from there after the
            // pull. The file path on the phone that signed never travels.
            val signedAt = row.signedAt?.let { at -> CloudTime.parseMillis(at) }
            val existing = localOrdersBySyncId[row.syncId]
            if (existing == null) {
                skipIfOrphaned { repository.saveChangeOrder(
                    ChangeOrder(
                        syncId = row.syncId, jobId = jobId,
                        description = row.description,
                        additionalFeet = row.additionalFeet,
                        additionalCost = if (scope == MoneyScope.ALLOWED) row.additionalCost else 0.0,
                        materialCost = if (scope == MoneyScope.ALLOWED) row.materialCost else 0.0,
                        signatureStoragePath = pulledSignatureStoragePath(null, row),
                        signedAt = signedAt,
                        inAcceptedTotal = row.inAcceptedTotal == true
                    )
                ) } ?: return@forEach
                added++
            } else {
                // Amounts change when extra work is repriced, and that has to
                // reach the other phone or two people quote the same job
                // differently. copy() keeps createdAt and the local signature
                // file path, which the cloud does not carry; the storage path
                // is taken from the cloud only when this phone has no
                // signature of its own (pulledSignatureStoragePath).
                //
                // Costs are left alone under DENIED: change_orders_crew
                // carries neither column, so row.additionalCost/materialCost
                // here are CloudChangeOrder's bare 0.0, not a real answer.
                val merged = existing.copy(
                    description = row.description,
                    additionalFeet = row.additionalFeet,
                    additionalCost = if (scope == MoneyScope.ALLOWED) row.additionalCost else existing.additionalCost,
                    materialCost = if (scope == MoneyScope.ALLOWED) row.materialCost else existing.materialCost,
                    signatureStoragePath = pulledSignatureStoragePath(existing, row),
                    signedAt = signedAt,
                    // Latches, as it does server-side: a null from the crew
                    // view, or a phone's copy from before the mark, never
                    // unmarks an order that was inside an accepted price.
                    inAcceptedTotal = existing.inAcceptedTotal || row.inAcceptedTotal == true
                )
                if (merged != existing) {
                    skipIfOrphaned { repository.updateChangeOrder(merged) } ?: return@forEach
                    added++
                }
            }
        }
        }

        // Time entries, gated like line items and change orders above. This
        // was the one job child still read from the base table on every
        // scope -- and time_entries_read is "same company", so a crew phone
        // pulled every colleague's shift with its hourly rate attached, and
        // the rate landed in Room. UNKNOWN skips the read outright (the
        // employees pull has the same rule and the same reason); DENIED reads
        // time_entries_crew, which has no hourly_rate column at all, and the
        // merge below never lets a rate move unless this phone is ALLOWED.
        if (scope != MoneyScope.UNKNOWN) {
        // Paged. Two shifts a day for two crew is a thousand rows inside a
        // year, and this one never stops growing.
        val times = pagedList<CloudTimeEntry>(
            if (payScope == MoneyScope.ALLOWED) "time_entries" else "time_entries_crew"
        ) { eq("company_id", companyId); notDeleted() }
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
                skipIfOrphaned { repository.insertTimeEntry(
                    TimeEntry(
                        syncId = row.syncId, jobId = jobId,
                        // "" matches no employee, which is exactly right for a
                        // shift nobody is attached to.
                        employeeId = employeeIdBySyncId[row.employeeSyncId],
                        startedAt = startedAt,
                        endedAt = row.endedAt?.let { at ->
                            CloudTime.parseMillis(at)
                        },
                        hourlyRate = if (payScope == MoneyScope.ALLOWED) row.hourlyRate else 0.0,
                        notes = row.notes,
                        approvedAt = CloudTime.parseMillis(row.approvedAt),
                        approvedBy = row.approvedBy,
                        rejectedAt = CloudTime.parseMillis(row.rejectedAt),
                        reviewNote = row.reviewNote,
                        originalStartedAt = CloudTime.parseMillis(row.originalStartedAt),
                        originalEndedAt = CloudTime.parseMillis(row.originalEndedAt),
                        correctedAt = CloudTime.parseMillis(row.correctedAt),
                        correctionReason = row.correctionReason,
                        breakMinutes = row.breakMinutes,
                        breakStartedAt = CloudTime.parseMillis(row.breakStartedAt),
                        breakEndedAt = CloudTime.parseMillis(row.breakEndedAt)
                    )
                ) } ?: return@forEach
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

                // A correction has to look like one on every phone, not only on
                // the phone that happened to be missing the shift.
                //
                // The insert branch above already carries these four; this one
                // did not, so a device that ALREADY held the shift -- which is
                // every device the crew member actually uses -- took the
                // corrected start time and showed it bare. The hours changed
                // and nothing on screen said so, no original to compare
                // against and no reason, which is the state dispute_my_shift
                // assumes cannot happen.
                //
                // Kept, not blanked, when the cloud has nothing to say: the
                // columns are absent from an old cloud row and from any row
                // nobody has corrected, and "the cloud does not carry it" is
                // not "the office cleared it". Blanking on a null would erase
                // the correction notice on the very next pull after it
                // arrived. The office is the only writer, so there is no
                // ratchet to argue with here -- whatever it holds wins, and
                // absence loses.
                val merged = existing.copy(
                    startedAt = startedAt,
                    endedAt = row.endedAt?.let { at -> CloudTime.parseMillis(at) },
                    hourlyRate = if (payScope == MoneyScope.ALLOWED) row.hourlyRate else existing.hourlyRate,
                    notes = row.notes,
                    approvedAt = if (cloudHasDecision) cloudApprovedAt else existing.approvedAt,
                    approvedBy = if (cloudHasDecision) row.approvedBy else existing.approvedBy,
                    rejectedAt = if (cloudHasDecision) cloudRejectedAt else existing.rejectedAt,
                    reviewNote = if (cloudHasDecision || !localHasDecision) row.reviewNote
                                 else existing.reviewNote,
                    originalStartedAt = CloudTime.parseMillis(row.originalStartedAt)
                        ?: existing.originalStartedAt,
                    originalEndedAt = CloudTime.parseMillis(row.originalEndedAt)
                        ?: existing.originalEndedAt,
                    correctedAt = CloudTime.parseMillis(row.correctedAt)
                        ?: existing.correctedAt,
                    correctionReason = row.correctionReason.ifBlank { existing.correctionReason },
                    // Same "kept, not blanked" rule as the correction columns
                    // just above, and for a related reason: only the insert-only
                    // pass of pushTimeEntries ever carries the break (see
                    // CloudTimeEntryPush.breakMinutes), so a pull that lands
                    // before this device's own insert-only push has reached
                    // the cloud would otherwise see a bare cloud row and wipe
                    // out a break this same phone just recorded. Falling back
                    // to the existing local value when the cloud has nothing
                    // to say means the only way a break actually clears here
                    // is the cloud genuinely carrying one.
                    breakMinutes = row.breakMinutes ?: existing.breakMinutes,
                    breakStartedAt = CloudTime.parseMillis(row.breakStartedAt)
                        ?: existing.breakStartedAt,
                    breakEndedAt = CloudTime.parseMillis(row.breakEndedAt)
                        ?: existing.breakEndedAt
                )
                if (merged != existing) {
                    skipIfOrphaned { repository.updateTimeEntry(merged) } ?: return@forEach
                    added++
                }
            }
        }
        }

        // Paged, same trap as the rest of this pass.
        val steps = pagedList<CloudJobStep>("job_steps") {
            eq("company_id", companyId); notDeleted()
        }
        val localStepsBySyncId = jobIdBySyncId.values
            .flatMap { repository.getJobSteps(it) }.associateBy { it.syncId }
        steps.forEach { row ->
            val jobId = jobIdBySyncId[row.jobSyncId] ?: return@forEach
            val kind = runCatching { JobStepKind.valueOf(row.kind) }
                .getOrDefault(JobStepKind.INSTALL)
            val existing = localStepsBySyncId[row.syncId]
            if (existing == null) {
                skipIfOrphaned { repository.insertJobStep(
                    JobStep(
                        syncId = row.syncId, jobId = jobId,
                        kind = kind,
                        description = row.description, checked = row.checked,
                        verifiedWithCustomer = row.verifiedWithCustomer,
                        sortOrder = row.sortOrder,
                        completedAt = CloudTime.parseMillis(row.completedAt),
                        stepKey = row.stepKey
                    )
                ) } ?: return@forEach
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
                    sortOrder = row.sortOrder,
                    // A keyless cloud row (an older phone that pulled before
                    // this column existed, then pushed) must not blank a key
                    // this phone already resolved -- same rule as the push
                    // side, just in the other direction. Take the cloud key
                    // only when it actually has one.
                    stepKey = row.stepKey ?: existing.stepKey
                )
                if (merged != existing) { skipIfOrphaned { repository.updateJobStep(merged) } ?: return@forEach; added++ }
            }
        }

        // Paged, same trap as the rest of this pass.
        val markers = pagedList<CloudSiteMarker>("site_markers") {
            eq("company_id", companyId); notDeleted()
        }
        val localMarkersBySyncId = jobIdBySyncId.values
            .flatMap { repository.getSiteMarkers(it) }.associateBy { it.syncId }
        markers.forEach { row ->
            val jobId = jobIdBySyncId[row.jobSyncId] ?: return@forEach
            val kind = runCatching { SiteMarkerKind.valueOf(row.kind) }
                .getOrDefault(SiteMarkerKind.OBSTACLE)
            val existing = localMarkersBySyncId[row.syncId]
            if (existing == null) {
                skipIfOrphaned { repository.addSiteMarker(
                    SiteMarker(
                        syncId = row.syncId, jobId = jobId,
                        kind = kind, x = row.x, y = row.y, label = row.label
                    )
                ) } ?: return@forEach
                added++
            } else {
                // A marked obstacle that moved has to reach whoever is digging.
                val merged = existing.copy(
                    kind = kind, x = row.x, y = row.y, label = row.label
                )
                if (merged != existing) { skipIfOrphaned { repository.updateSiteMarker(merged) } ?: return@forEach; added++ }
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
    private suspend fun pullEmployees(repository: Repository, companyId: String, employeePayScope: MoneyScope): Int {
        // employeePayScope answers can_see_employee_pay(), NOT can_see_pay() --
        // a different door than the rest of this pass. A salesperson can be
        // ALLOWED to see job money and still DENIED here, and used to take the
        // direct `employees` read anyway because this function reused the job
        // MoneyScope: the read came back with zero rows (the server, not this
        // code, was doing the actual gating), so nothing was added and nothing
        // was scrubbed, and whatever rates that phone cached before the server
        // side was locked down just sat in Room forever.
        //
        // This is asked once, up in AutoSync beside the job MoneyScope, rather
        // than a second, separate can_see_employee_pay() call here. It used to
        // ask can_see_pay() again on its own (wrong RPC, but the same instinct)
        // and fold ANY failure into "not allowed" -- so a dead spot on an
        // owner's phone read as "not allowed to see pay," replaced every
        // cached rate with the roster's zeros, and the very next push sent
        // those zeros back up. A real hourly rate on this database went from
        // 25 to 0 that way. UNKNOWN here still skips the pull entirely:
        // neither the real rows nor the roster's zeros are safe to apply when
        // the door itself could not be asked about.
        if (employeePayScope == MoneyScope.UNKNOWN) return 0
        val maySeePay = employeePayScope == MoneyScope.ALLOWED

        val fromRoster = !maySeePay
        // Paged, same trap as the rest of this pass.
        val roster = if (maySeePay)
            pagedList<CloudEmployee>("employees") {
                eq("company_id", companyId); notDeleted()
            }
        else
            SupabaseModule.client.postgrest
                .rpc("crew_roster")
                .decodeList<CrewRosterRow>()
                // See CrewRosterRow: a null sync_id decodes as "" now.
                .filter { it.syncId.isNotBlank() }
                .map { it.asEmployee(companyId) }
        // A crew member's OWN row, pay included. employees_read already lets
        // anyone read the row linked to their own login (profile_id =
        // auth.uid()), and nobody else's -- so this widens nothing. Without it
        // a crew phone only ever had the roster's zeros for itself and its
        // pay card could only say "rate not set", including for per-foot pay.
        // Rows returned here are real rows, not roster rows: their contact
        // fields and profile link are taken as-is below.
        val ownRows: List<CloudEmployee> = if (fromRoster) {
            val uid = SupabaseModule.currentUserId()
            if (uid.isNullOrBlank()) emptyList()
            else runCatching {
                pagedList<CloudEmployee>("employees") {
                    eq("company_id", companyId); eq("profile_id", uid); notDeleted()
                }
            }.getOrDefault(emptyList())
        } else emptyList()
        val ownSyncIds = ownRows.map { it.syncId }.toSet()
        val cloud = roster.filter { it.syncId !in ownSyncIds } + ownRows
        val localBySyncId = repository.getAllEmployees().associateBy { it.syncId }
        var added = 0
        cloud.forEach { row ->
            // A null sync_id decodes as "" now rather than killing the pull;
            // a row with no identity cannot be matched or saved, only skipped.
            if (row.syncId.isBlank()) return@forEach
            val rosterRow = fromRoster && row.syncId !in ownSyncIds
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
                    phone = if (rosterRow) existing.phone else row.phone,
                    email = if (rosterRow) existing.email else row.email,
                    notes = if (rosterRow) existing.notes else row.notes,
                    hourlyRate = row.hourlyRate,
                    payType = runCatching { PayType.valueOf(row.payType) }
                        .getOrDefault(existing.payType),
                    perFootRate = row.perFootRate,
                    // Someone let go on one phone has to be let go on all of
                    // them, and promptly -- that is half the point of the
                    // feature.
                    isActive = row.isActive,
                    deactivatedAt = CloudTime.parseMillis(row.deactivatedAt),
                    profileId = if (rosterRow) existing.profileId else row.profileId.orEmpty()
                )
                if (merged != existing) { repository.saveEmployee(merged); added++ }
            }
        }
        return added
    }

    private suspend fun pullManufacturers(repository: Repository, companyId: String): Int {
        // Paged, same trap as the rest of this pass.
        val cloud = pagedList<CloudManufacturer>("manufacturers") {
            eq("company_id", companyId); notDeleted()
        }
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
        // Paged: three or four runs a job puts this past a thousand at a few
        // hundred jobs, and a missing run is a fence nobody builds.
        val cloud = pagedList<CloudFenceRun>("fence_runs") {
            eq("company_id", companyId); notDeleted()
        }

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
                // A job gone mid-pass skips the run: see OrphanRows.
                skipIfOrphaned { repository.createFenceRunFromCloud(
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
                        splitRailCount = row.splitRailCount,
                        updatedAt = row.updatedAtMillis()
                    )
                ) } ?: return@forEach
                added++
            } else if (row.updatedAtMillis() > existing.updatedAt) {
                // Redrawing a fence line, or correcting its footage, has to
                // reach the crew -- otherwise they build to an older drawing
                // than the one the customer was quoted from.
                //
                // Gated last-edit-wins: a run redrawn on this phone and not
                // yet pushed must survive a pull landing in between, or the
                // scope the crew is about to build from reverts under them.
                //
                // copy() names only what the cloud carries, which is now the
                // whole specification. It used to carry the outline and nothing
                // else, so a run arrived elsewhere with the default spec for its
                // fence type and the two phones computed different takeoffs.
                //
                // jobId is still not named: the run stays attached to the job
                // this device resolved it to. updatedAt is stamped to the
                // cloud's own clock, not to now -- otherwise the very next
                // push would see its own just-pulled copy as newer and send
                // it straight back up.
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
                    splitRailCount = row.splitRailCount,
                    updatedAt = row.updatedAtMillis()
                )
                if (merged != existing) { skipIfOrphaned { repository.updateFenceRunFromCloud(merged) } ?: return@forEach; added++ }
            }
        }
        return added
    }

    private suspend fun pushEmployees(repository: Repository, companyId: String, scope: MoneyScope): Int {
        // A phone that isn't confirmed ALLOWED must not send employee rows at
        // all -- UNKNOWN included. Its local copy may have come from the
        // roster, which carries no rates, so pushing it writes zeros over the
        // office's figures; the one call this used to make on its own folded
        // any failure into "not allowed to push," which is the right answer
        // for THIS direction but is no longer asked twice now that the pass
        // already has scope in hand.
        if (scope != MoneyScope.ALLOWED) return 0

        val rows = repository.getAllEmployees().map { it.toCloud(companyId) }
        return upsert("employees", rows)
    }

    private suspend fun pushManufacturers(repository: Repository, companyId: String): Int {
        val rows = repository.getAllManufacturers().map { it.toCloud(companyId) }
        return upsert("manufacturers", rows)
    }

    private suspend fun pushFenceRuns(
        repository: Repository,
        companyId: String,
        scope: MoneyScope,
        cloudTouchedAt: Map<String, Pair<Long, Boolean>>?
    ): Int {
        // Not the runs of a job this person is no longer on (Job.accessEndedAt),
        // nor -- on a phone reading the crew door -- of a job that door did
        // not return (mayPushJobRuns): the fence_runs read below cannot see
        // them either, so every one read as "no cloud copy" and went up on
        // every pass to be refused row by row. They stay here, and go up if
        // the job comes back.
        val jobs = repository.getAllJobs().filter { mayPushJobRuns(it, cloudTouchedAt, scope) }
        val local = jobs.flatMap { job ->
            repository.getFenceRuns(job.id).map { it to job.syncId }
        }
        if (local.isEmpty()) return 0

        // Points, post spacing and panel height drive the takeoff and the
        // price, so whichever phone happened to sync last must not be able to
        // silently overwrite a run just redrawn on another. Only push when
        // this phone's copy is actually newer than the cloud's; a phone that
        // only pulled the run re-pushes its now-stale copy every sync
        // otherwise and clobbers an edit made elsewhere in between.
        // Paged: push-side compare again, so a run past row one thousand
        // would read as "no cloud copy" and get pushed as if brand new.
        val cloudBySyncId = pagedList<CloudFenceRun>("fence_runs") {
            // sees-tombstones: a run this phone deleted must still compare
            // against the cloud's last known clock for it, or a tombstoned
            // row looks like "no cloud copy" and a stale local push
            // resurrects it.
            eq("company_id", companyId)
        }
            .associateBy { it.syncId }

        val rows = local.filter { (run, _) ->
            val claimed = cloudBySyncId[run.syncId]
            claimed == null || run.updatedAt > claimed.updatedAtMillis()
        }.map { (run, jobSyncId) -> run.toCloud(companyId, jobSyncId) }
        return upsert("fence_runs", rows)
    }

    /**
     * Sends each finished shift up once, whole, as an insert that cannot touch
     * a stored row -- and afterwards writes a stored shift again only when this
     * phone holds a change the cloud does not have.
     *
     * Every office time correction was once undone by the next sync from the
     * phone that recorded the shift: this pushed started_at and ended_at
     * unconditionally on every pass, so a manager fixing an 8:47 clock-in to
     * 8:30 held until the handset next spoke and then reverted. started_at is
     * what pay is calculated from. The fix (568e76c, 1.470) split the push in
     * two -- an insert-only pass carrying the clock, and an "update pass"
     * carrying everything but the clock -- and the second half never worked.
     *
     * It was an UPSERT without started_at. Postgres builds the proposed row
     * and checks NOT NULL on it BEFORE it consults ON CONFLICT, so INSERT ...
     * ON CONFLICT DO UPDATE with no started_at is refused 23502 "null value in
     * column started_at" whether or not the row exists. Proved in a rolled-back
     * transaction on 2026-09-21, in PostgREST's own statement shape, as a
     * MANAGER and as a CREW member on their own shift: refused both ways; the
     * same statement WITH started_at landed -- and put the phone's original
     * clock back over the office correction, which is exactly why "just send
     * the times" is not the fix. So from 1.470 every shift's update failed on
     * every sync (hidden in app_errors behind the insert pass's own "2 of 7
     * rows rejected", which is thrown first), and from 1.502, where a 400
     * became a permanent mark, every shift the phone had already uploaded was
     * tattooed SERVER_REJECTED by its own update. [isDueForPush] clears those.
     *
     * What is sent now:
     *
     *  1. every finished shift, whole, `insertOnly` -- unchanged. PostgREST
     *     resolves a conflict by ignoring the row, so a shift the cloud has
     *     never seen lands complete (clock, break, decision), and a shift it
     *     already holds is untouchable by this pass. That is a property of
     *     the request, not a conclusion drawn from a read.
     *  2. for a shift whose worker a person changed on this phone
     *     ([TimeEntry.workerChangedAt]) and only for that shift: a PATCH --
     *     UPDATE, filtered by company_id and sync_id, naming employee_sync_id
     *     and nothing else ([workerChangeToSend]). An UPDATE needs no
     *     started_at, and one that does not name the clock cannot move it, so
     *     an office correction stands.
     *
     * Why not PATCH every shift with the old update pass's columns? Three
     * reasons, each measured or read, not guessed:
     *  - it was a write per shift per sync. A PATCH cannot be batched with
     *    different values per row, so a manager's phone holding the company's
     *    two thousand shifts would send two thousand requests a minute in the
     *    foreground.
     *  - `stamp_time_entry_rate` runs on EVERY update and re-stamps the row's
     *    hourly_rate from the employee's CURRENT rate (probe case 5: a shift
     *    worked at 17 became 30 after the raise, on a same-value PATCH). Every
     *    sync rewriting every shift would rewrite every past shift's pay rate.
     *  - the office's correction sheet can move a shift to a different worker.
     *    A phone re-asserting its own copy of employee_sync_id (and notes) on
     *    every pass would undo that, the same way it once undid times.
     * And nothing else in that pass was the phone's to send: no screen edits
     * a stored shift's notes, rate or job after clock-out; the pull takes the
     * cloud's notes and rate every pass; the decision goes through
     * `approve_time_entry` and a clock correction through `correct_time_entry`.
     *
     * The one thing that WOULD be lost is a clock-out for a shift the cloud
     * already held while it was still running, because pass 1 would decline
     * to touch it and pass 2 does not carry ended_at. No such shift can exist:
     * this is the only code in the app that writes time_entries rows, it
     * filters running shifts out, so a row only ever reaches the cloud
     * finished. The office page only ever UPDATEs the table -- it has no
     * insert path -- and no Edge Function touches it. Re-check those three
     * before adding an insert anywhere else.
     */
    private suspend fun pushTimeEntries(
        repository: Repository,
        companyId: String,
        // Whether this phone may see what a PERSON is paid -- can_see_employee_pay(),
        // i.e. has_permission('SEE_PAY'). The same answer pullJobChildren uses to
        // choose between time_entries and time_entries_crew, asked once per pass
        // up in AutoSync and handed down rather than re-asked here.
        payScope: MoneyScope
    ): Int {
        val jobsBySyncId = repository.getAllJobs().associateBy({ it.id }, { it.syncId })
        val allEmployees = repository.getAllEmployees()
        val employeeSyncById = allEmployees.associateBy({ it.id }, { it.syncId })
        // Only completed shifts: a running timer has no end yet and would land
        // in the cloud looking like a zero-length entry.
        val everyFinished = repository.getAllTimeEntries()
            .filter { !it.isRunning }
            .mapNotNull { entry ->
                jobsBySyncId[entry.jobId]?.let { jobSyncId -> entry to jobSyncId }
            }

        // A phone without SEE_PAY cannot write a COLLEAGUE'S shift at all, and
        // this is not about which columns it sends. Measured live on
        // 2026-09-20 in a rolled-back transaction, as a FOREMAN (APPROVE_TIME,
        // no SEE_PAY), against a colleague's row the cloud already held:
        //
        //   upsert carrying the approval ....... 42501 time_entries_pay_needs_see_pay
        //   upsert carrying NO approval cols ... 42501, the same policy
        //   the insert-only pass (DO NOTHING) .. 42501, the same policy
        //   a MANAGER doing the first of those . 1 row (the positive control)
        //
        // because `time_entries_pay_needs_see_pay` is a RESTRICTIVE SELECT
        // policy, and Postgres applies SELECT policies to the row an UPDATE
        // reads and to the conflicting row an INSERT ... ON CONFLICT touches.
        // 42501 arrives as HTTP 403; [isPermanentRejection] treats 403 as
        // retryable on purpose (it usually means "sign in again"), so every
        // one of these rows was re-sent on every sync, for ever, and reported
        // as a sync failure every time.
        //
        // Such a phone holds those rows only because the PULL gave them to it,
        // out of time_entries_crew -- they are somebody else's work, read-only
        // by construction, and it has nothing to say about them. So they are
        // not sent. Not marked either: a "cannot upload" banner for a row this
        // phone never authored would be noise on the one screen that has to
        // stay believable. UNKNOWN is treated as DENIED here rather than as
        // ALLOWED -- "could not ask" must never buy write access, and own
        // shifts (the phone's actual field work) still go up either way, so
        // nothing of this phone's own is held back by being careful.
        val mineOnly = payScope != MoneyScope.ALLOWED
        val finished = if (!mineOnly) everyFinished else {
            val uid = SupabaseModule.currentUserId()
            val email = SupabaseModule.currentUserEmail()
            val kept = everyFinished.filter { (entry, _) ->
                isOwnShiftToPush(entry, allEmployees, uid, email)
            }
            if (kept.size < everyFinished.size) {
                android.util.Log.i(
                    "EntitySync",
                    "push time_entries: ${everyFinished.size - kept.size} colleague shifts " +
                        "left alone -- this phone has no SEE_PAY, so the server refuses every " +
                        "write of them and they are the office's copy, not ours"
                )
            }
            kept
        }
        if (finished.isEmpty()) return 0

        // Rows the insert trigger will refuse every single time, known
        // without ever asking -- see [needsWorkerAssignment]. Sending these
        // anyway is not a retry, it is the same permanent 4xx on a loop:
        // "push time_entries: N of M rows rejected" on every sync, forever,
        // for a row no retry can ever fix. Held back and marked instead, so
        // the Time screen can ask a person to pick who worked it.
        //
        // Tested on what will actually be SENT, not on employeeId alone. The
        // two shifts refused on every sync for a week each HAD an employeeId;
        // it named an employee this phone no longer holds, so it resolved to
        // no sync id, went up as employee_sync_id "" and was refused -- while
        // an employeeId == null check waved it straight past. The same
        // resolution feeds toCloud in pushTimeEntryRows, so the check and
        // the send cannot disagree again.
        val (blockedLocally, shifts) = finished.partition { (entry, _) ->
            needsWorkerAssignment(entry, resolveEmployeeSyncId(entry, employeeSyncById))
        }
        for ((entry, _) in blockedLocally) {
            if (entry.syncBlockedReason != TimeEntrySyncBlock.NEEDS_WORKER.name) {
                repository.updateTimeEntry(
                    entry.copy(
                        syncBlockedReason = TimeEntrySyncBlock.NEEDS_WORKER.name,
                        syncBlockedAt = entry.syncBlockedAt ?: System.currentTimeMillis(),
                        syncBlockedDetail = NEEDS_WORKER_DETAIL
                    )
                )
            }
        }
        // The other direction: a shift held back as NEEDS_WORKER whose
        // employee resolves now (re-added, or re-linked by a pull) goes back
        // in the queue. The Fix action clears its own mark; nothing else did.
        val sendable = shifts.map { (entry, jobSyncId) ->
            if (entry.syncBlockedReason != TimeEntrySyncBlock.NEEDS_WORKER.name) {
                entry to jobSyncId
            } else {
                val cleared = entry.copy(syncBlockedReason = null, syncBlockedAt = null, syncBlockedDetail = null)
                repository.updateTimeEntry(cleared)
                cleared to jobSyncId
            }
        }
        if (sendable.isEmpty()) return 0

        // One clock for the whole pass, so the two passes agree on which
        // marks have expired.
        val now = System.currentTimeMillis()

        // Sync ids the insert pass marks SERVER_REJECTED, so the worker pass
        // behind it does not send them a second time. `sendable` was read
        // before either pass ran, so its copies still say "not blocked" after
        // the mark has been written to Room -- the worker pass has to be
        // told, not left to re-read.
        val rejectedThisPass = HashSet<String>()

        // Caught rather than thrown, so one row the server will not accept
        // cannot also block the worker changes behind it -- and reported ahead
        // of anything the worker pass raises, because "could not insert this
        // shift" is the cause and anything the PATCH says about the same row
        // would only be its symptom.
        val firstSight = runCatching {
            pushTimeEntryRows(repository, companyId, sendable, employeeSyncById, rejectedThisPass, now)
        }
        val workerChanges = runCatching {
            pushWorkerChanges(repository, companyId, sendable, employeeSyncById, rejectedThisPass, now)
        }
        firstSight.exceptionOrNull()?.let { throw it }
        workerChanges.exceptionOrNull()?.let { throw it }
        // The insert pass covers every shift that was due, so its count is the
        // number of shifts synced. A worker change is one of those same
        // shifts; adding it would count it twice.
        return firstSight.getOrThrow()
    }

    /** The trigger's own wording, kept in one place for [needsWorkerAssignment]'s local marker. */
    private const val NEEDS_WORKER_DETAIL =
        "This shift is not linked to a crew member. Assign the job to somebody, " +
            "or pick who is working, and clock in again."

    /**
     * Pass 1 of [pushTimeEntries]: every due shift, whole, insert-only.
     *
     * Like [upsert], chunked with a per-row fallback -- but for time entries
     * specifically, because a row the fallback still can't place needs more
     * than a count: it needs to be told apart from every other row so
     * [TimeEntrySyncBlock] can be recorded against the RIGHT shift rather
     * than the whole batch.
     *
     * The request is the same one it always was -- `ignoreDuplicates`, the
     * clock, the break and the decision all carried. There is deliberately no
     * flag for any other shape any more: the upsert-without-started_at that
     * this used to be asked for on its second call is the 23502 that failed
     * every shift from 1.470, and a shape that cannot be requested cannot come
     * back.
     *
     * Which rows: [isDueForPush] -- unmarked, or marked SERVER_REJECTED long
     * enough ago to try once more. An expired mark goes up on its own, never
     * inside a chunk: a row the server still refuses would fail its whole
     * chunk and send up to two hundred good shifts one at a time behind it,
     * every six hours.
     */
    private suspend fun pushTimeEntryRows(
        repository: Repository,
        companyId: String,
        shifts: List<Pair<TimeEntry, String>>,
        employeeSyncById: Map<Long, String>,
        // Sync ids this pass marks SERVER_REJECTED, for the worker pass behind
        // it. Added to, never cleared.
        rejectedThisPass: MutableSet<String>,
        now: Long
    ): Int {
        val due = shifts.filter { (entry, _) -> isDueForPush(entry, now) }
        if (due.isEmpty()) return 0
        val (retrying, fresh) = due.partition { (entry, _) -> entry.isSyncBlocked }

        var pushed = 0
        var firstRowFailure: Throwable? = null
        var failedCount = 0

        // One row, on its own, with its outcome written against that shift.
        suspend fun sendOne(entry: TimeEntry, row: CloudTimeEntryPush) {
            val single = runCatching {
                SupabaseModule.client.postgrest.from("time_entries")
                    .upsert(listOf(row)) {
                        onConflict = "company_id,sync_id"
                        ignoreDuplicates = true
                    }
            }
            if (single.isSuccess) {
                pushed++
                // A row that goes through clean after previously being marked
                // (its employee got fixed, or the mark was a wrong guess that
                // has now expired) is no longer blocked -- clear it rather than
                // leaving a stale reason on a shift that just synced fine.
                if (entry.isSyncBlocked) {
                    runCatching { repository.clearTimeEntrySyncBlock(entry.id) }
                }
                return
            }
            val cause = single.exceptionOrNull()!!
            android.util.Log.w("EntitySync", "push time_entries: one row rejected and skipped", cause)
            // One decision, made in one pure place -- see [classifyRowRejection],
            // and TimeEntryPushDecisionTest, which feeds it the real exceptions.
            when (val decision = classifyRowRejection(cause)) {
                is RowRejection.Permanent -> {
                    // Marked and held back until the mark expires -- not
                    // counted as a failure here either, for the same reason
                    // isNotOursToSync's refusals aren't: a sync that keeps
                    // reporting FAILED for a row that will not go up teaches
                    // people to ignore the banner. The Time screen is where
                    // this belongs. Stamped NOW, every time: the stamp is the
                    // retry clock (see [TimeEntry.syncBlockedAt]).
                    rejectedThisPass += entry.syncId
                    runCatching {
                        repository.markTimeEntrySyncBlocked(
                            entry.id, TimeEntrySyncBlock.SERVER_REJECTED.name,
                            System.currentTimeMillis(), decision.detail
                        )
                    }
                }
                is RowRejection.Retry -> {
                    failedCount++
                    if (firstRowFailure == null) firstRowFailure = decision.cause
                }
            }
        }

        fun rowFor(entry: TimeEntry, jobSyncId: String) =
            // The very value the hold-back in pushTimeEntries tested.
            entry.toInsertRow(companyId, jobSyncId, resolveEmployeeSyncId(entry, employeeSyncById))

        fresh.map { (entry, jobSyncId) -> entry to rowFor(entry, jobSyncId) }
            .chunked(200)
            .forEach { chunk ->
                val whole = runCatching {
                    SupabaseModule.client.postgrest.from("time_entries")
                        .upsert(chunk.map { it.second }) {
                            onConflict = "company_id,sync_id"
                            ignoreDuplicates = true
                        }
                }
                if (whole.isSuccess) {
                    pushed += chunk.size
                } else {
                    // Offline: see upsert. Every row would fail the same way --
                    // but only when the request never left the phone; a
                    // timeout still goes row by row.
                    whole.exceptionOrNull()?.let { if (SyncFailure.neverReachedServer(it)) throw it }
                    chunk.forEach { (entry, row) -> sendOne(entry, row) }
                }
            }
        retrying.forEach { (entry, jobSyncId) -> sendOne(entry, rowFor(entry, jobSyncId)) }

        firstRowFailure?.let { throw PartialUpsertFailure("time_entries", failedCount, due.size, it) }
        return pushed
    }

    /**
     * Pass 2 of [pushTimeEntries]: the worker changes this phone owes the
     * cloud, one PATCH each, and nothing else.
     *
     * Counted by what came back, not by the absence of an error. A PostgREST
     * PATCH that matches no row answers 200 with nothing in it (probe case
     * 3b), so `select("sync_id")` asks for the rows it actually changed. None
     * means the cloud does not hold this shift yet -- pass 1 either refused it
     * (then it is in [rejectedThisPass] and never reaches here) or could not
     * reach the server -- so the stamp stays and the next pass tries again.
     * One means the cloud holds the change: the stamp is cleared, unless a
     * newer Fix replaced it while this was in flight
     * ([Repository.confirmWorkerChangeSynced]).
     */
    private suspend fun pushWorkerChanges(
        repository: Repository,
        companyId: String,
        shifts: List<Pair<TimeEntry, String>>,
        employeeSyncById: Map<Long, String>,
        rejectedThisPass: Set<String>,
        now: Long
    ): Int {
        val owed = shifts.mapNotNull { (entry, _) ->
            if (entry.syncId in rejectedThisPass || !isDueForPush(entry, now)) return@mapNotNull null
            workerChangeToSend(entry, resolveEmployeeSyncId(entry, employeeSyncById))?.let { entry to it }
        }
        if (owed.isEmpty()) return 0

        var confirmed = 0
        var firstFailure: Throwable? = null
        var failedCount = 0

        for ((entry, patch) in owed) {
            val result = runCatching {
                SupabaseModule.client.postgrest.from("time_entries").update(patch) {
                    select(io.github.jan.supabase.postgrest.query.Columns.list("sync_id"))
                    filter {
                        eq("company_id", companyId)
                        eq("sync_id", entry.syncId)
                    }
                }.decodeList<SyncIdOnly>()
            }
            if (result.isSuccess) {
                if (result.getOrThrow().isNotEmpty()) {
                    runCatching { repository.confirmWorkerChangeSynced(entry) }
                    confirmed++
                } else {
                    android.util.Log.i(
                        "EntitySync",
                        "push time_entries: worker change for ${entry.syncId} matched no cloud row yet; kept for the next pass"
                    )
                }
                continue
            }
            val cause = result.exceptionOrNull()!!
            android.util.Log.w("EntitySync", "push time_entries: worker change refused", cause)
            when (val decision = classifyWorkerChangeRejection(cause)) {
                // The stamp is kept: the change is still owed, and goes up
                // again when the mark expires (or when somebody picks again,
                // which clears the mark and re-stamps).
                is RowRejection.Permanent -> runCatching {
                    repository.markTimeEntrySyncBlocked(
                        entry.id, TimeEntrySyncBlock.SERVER_REJECTED.name,
                        System.currentTimeMillis(), decision.detail
                    )
                }
                is RowRejection.Retry -> {
                    failedCount++
                    if (firstFailure == null) firstFailure = decision.cause
                }
            }
        }

        firstFailure?.let { throw PartialUpsertFailure("time_entries worker changes", failedCount, owed.size, it) }
        return confirmed
    }
}

/** What a PATCH with `select("sync_id")` answers with: the rows it changed, by identity. */
@Serializable
private data class SyncIdOnly(@SerialName("sync_id") val syncId: String = "")

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

/**
 * The whole shift, as the insert-only pass sends it -- the ONLY shape a
 * TimeEntry is ever pushed in as a row.
 *
 * It used to take includeTimes/includeDecision flags so a second call could
 * leave the clock and the decision out for an "update pass". That pass was an
 * upsert, and an upsert without started_at is refused 23502 on every row (see
 * [EntitySync.pushTimeEntries]), so the flags are gone: [CloudTimeEntryPush.startedAt]
 * is non-null, and a row without the clock cannot be built. A change to a
 * shift the cloud already holds goes up as [workerChangeToSend]'s PATCH.
 *
 * Internal, not private, so a test can serialize it through [cloudJson] and
 * hold it to that.
 */
internal fun TimeEntry.toInsertRow(
    companyId: String,
    jobSyncId: String,
    employeeSyncId: String? = null
): CloudTimeEntryPush = CloudTimeEntryPush(
    companyId = companyId, syncId = syncId, jobSyncId = jobSyncId,
    employeeSyncId = employeeSyncId ?: "",
    startedAt = Instant.ofEpochMilli(startedAt).toString(),
    endedAt = endedAt?.let { Instant.ofEpochMilli(it).toString() },
    hourlyRate = hourlyRate, notes = notes,
    // The decision travels only here, on the shift's first and only insert:
    // on a row the cloud already holds it belongs to `approve_time_entry`,
    // which is the only door a phone without SEE_PAY can get through.
    approvedAt = approvedAt?.let { CloudTime.format(it) },
    approvedBy = approvedBy,
    rejectedAt = rejectedAt?.let { CloudTime.format(it) },
    reviewNote = reviewNote,
    // Recorded once, before the shift is ever pushed (a phone cannot edit it
    // after clocking out -- see Repository.clockOut). Null stays out of the
    // body (explicitNulls = false): "no break recorded", never a break of 0.
    breakMinutes = breakMinutes,
    breakStartedAt = breakStartedAt?.let { Instant.ofEpochMilli(it).toString() },
    breakEndedAt = breakEndedAt?.let { Instant.ofEpochMilli(it).toString() }
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
    // Defaulted for the tables whose sync_id is nullable (employees, expenses,
    // punch_list_items); a tombstone with no identity names nothing to remove.
    private data class TombstonedRow(@kotlinx.serialization.SerialName("sync_id") val syncId: String = "")

    suspend fun reap(repository: com.fenceestimator.app.data.Repository, companyId: String, scope: MoneyScope): Result<Int> =
        runCatching {
            // All thirteen sweeps at once, ordinarily; each touches only its
            // own table. Two of them are conditional on scope:
            // pricing_tiers' base read is SEE_MONEY-gated, so asking while
            // not confirmed ALLOWED would read an empty answer as "the office
            // cleared every tier" -- exactly the class of bug this feature
            // exists to close -- and is skipped instead. estimate_line_items
            // is gated the same way once the policy flips: DENIED reads the
            // money-free view for the same tombstoned sync ids, and UNKNOWN
            // cannot tell which door is open, so it asks neither. DENIED
            // reads change_orders' tombstones through its view too. All of
            // it is reapSource.
            kotlinx.coroutines.coroutineScope {
            com.fenceestimator.app.data.SyncTables.ALL.mapNotNull { table ->
                val source = reapSource(table, scope) ?: return@mapNotNull null
                async { netGate.withPermit {
                val tombstoned = tombstonedSyncIds(source, companyId)
                when {
                    tombstoned.isEmpty() -> 0
                    // Except a takeoff line this phone has just written again
                    // under the same (deterministic) sync id and not yet
                    // revived: deleting it here took a line that had come
                    // back, about a second and a half after Suggest Quantities
                    // put it there, and the price dropped with it. The push
                    // that follows sends it back with deleted_at cleared
                    // (EntitySync.pushLineItems). reapLineItems reads the
                    // waiting ids and deletes in one transaction, so a
                    // regenerate can never slip its line in between the two.
                    table == "estimate_line_items" -> repository.reapLineItems(tombstoned)
                    // The local table name, always -- Room has no "_crew" table.
                    else -> repository.deleteLocalRowsBySyncId(table, tombstoned)
                }
            } } }.awaitAll().sum()
            }
        }

    /**
     * Where [reap] asks for [table]'s tombstones under [scope], or null to not
     * ask at all.
     *
     * The rules the reap has always had -- pricing_tiers only when ALLOWED,
     * estimate_line_items never when UNKNOWN and through its crew view when
     * DENIED -- and change_orders through change_orders_crew when DENIED. The
     * base table hides every row from a crew login (the restrictive
     * change_orders_money_hidden_from_crew SELECT policy), which reads as no
     * tombstones rather than an error: an order the office deleted stayed on
     * the crew phone for good, and now that its orders reach the server
     * (crew_push_change_orders), it would be sent every pass, skipped every
     * pass, and hold the phone at "not backed up" for ever. The view carries
     * sync_id and deleted_at and no money.
     */
    internal fun reapSource(table: String, scope: MoneyScope): String? = when {
        table == "pricing_tiers" && scope != MoneyScope.ALLOWED -> null
        table == "estimate_line_items" && scope == MoneyScope.UNKNOWN -> null
        table == "estimate_line_items" && scope == MoneyScope.DENIED -> "estimate_line_items_crew"
        table == "change_orders" && scope == MoneyScope.DENIED -> "change_orders_crew"
        else -> table
    }

    /**
     * Every tombstoned sync id in one table, a page at a time.
     *
     * This read asked once, and PostgREST answers at most a thousand rows
     * without saying it has stopped short -- the same cap [pagedList] exists
     * for, and the same silence. A company past a thousand deletions in a
     * table got the first thousand ids and no hint of the rest, so every
     * tombstone after that was simply never applied: the local row survived
     * the reap, the push that runs straight afterwards sent it back up, and
     * a deleted line item or change order reappeared on every device and back
     * into the job total. Growing, permanently, because tombstones are never
     * cleaned up ("not null" rather than a date window, below).
     *
     * Not routed through [pagedList] for one reason: [pagedList] selects every
     * column, and this sweep runs over time_entries and material_items among
     * others. Widening the select to reach a sync id would pull hourly_rate
     * and unit_price down onto a crew phone, which is exactly what the _crew
     * views exist to prevent. So the loop is repeated here with the narrow
     * column list kept.
     *
     * Ordered by sync_id, so pages cannot overlap or skip. A short page ends
     * it; a full one means ask again. The fifty-page stop is a runaway guard,
     * not a limit.
     */
    private suspend fun tombstonedSyncIds(source: String, companyId: String): List<String> {
        val page = 1000
        val all = ArrayList<String>()
        var from = 0L
        while (true) {
            val batch = SupabaseModule.client.postgrest.from(source)
                .select(io.github.jan.supabase.postgrest.query.Columns.list("sync_id")) {
                    filter {
                        eq("company_id", companyId)
                        // "not null" rather than a date window: a device that
                        // has been off for a month must still learn about
                        // everything deleted while it was away.
                        filterNot("deleted_at", io.github.jan.supabase.postgrest.query.filter.FilterOperator.IS, "null")
                    }
                    order("sync_id", io.github.jan.supabase.postgrest.query.Order.ASCENDING)
                    range(from, from + page - 1)
                }
                .decodeList<TombstonedRow>()
            all += batch.map { it.syncId }.filter { it.isNotBlank() }
            if (batch.size < page) break
            from += page
            if (all.size >= page * 50) break
        }
        return all
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
    // By status first. PostgREST answers SQLSTATE 42501 with HTTP 403 for a
    // signed-in caller, and postgrest-kt 3.0.2 keeps that status but drops the
    // code from the message -- so a refusal raised with its own sentence
    // ("This job is not assigned to you.", crew_job_guard; "Not allowed to
    // write jobs", crew_save_job) carried none of the words below, and a crew
    // phone taken off a job between reading it and pushing it failed the
    // whole pass instead of holding that one job back.
    if (generateSequence(error) { it.cause }
            .any { (it as? io.github.jan.supabase.exceptions.RestException)?.statusCode == 403 }
    ) return true
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
        companyId: String,
        scope: MoneyScope
    ): Result<Int> = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
        runCatching {
            // payment_records is already gated to SEE_MONEY; asking while not
            // confirmed ALLOWED (UNKNOWN included) would read an empty answer
            // as "every payment was deleted" and start reconciling this
            // phone's ledger against nothing. Before any read, not just the
            // payment_records one.
            if (scope != MoneyScope.ALLOWED) return@runCatching 0
            val jobs = repository.getAllJobs()
            val jobIdBySyncId = jobs.associate { it.syncId to it.id }
            val jobSyncIdById = jobs.associate { it.id to it.syncId }

            val local = repository.getAllPayments()
            val localBySyncId = local.associateBy { it.syncId }

            // Paged. Measured against real data: payment_records runs at
            // 1.125 rows per job, so this truncates around 889 jobs for one
            // company -- before the jobs table itself would. This is the
            // push-side compare, so a truncated read here does not just show
            // a wrong number: it decides which payments look unclaimed and
            // get pushed up a second time.
            val cloud = pagedList<CloudPaymentRecord>("payment_records") {
                eq("company_id", companyId)
            }
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
                // One statement for the lot, and INSERT OR IGNORE does not
                // ignore a foreign key: a job that left mid-pass failed every
                // payment in the batch (see OrphanRows). The batch rolls back
                // whole, so on that failure each row goes in alone and only
                // the orphan is skipped.
                val inserted = if (skipIfOrphaned { repository.insertPaymentsFromCloud(landed) } != null) landed
                    else landed.filter { row -> skipIfOrphaned { repository.insertPaymentsFromCloud(listOf(row)) } != null }
                moved += inserted.size
                // Job totals are a cache of these rows, so they are rebuilt for
                // every job that just gained one. Otherwise the ledger and the
                // job would disagree until something else touched the job.
                inserted.map { it.jobId }.distinct().forEach { repository.syncJobTotalsFromLedger(it) }
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
