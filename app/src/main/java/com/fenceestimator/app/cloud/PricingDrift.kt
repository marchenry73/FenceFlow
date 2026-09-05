package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.EstimateLineItem
import com.fenceestimator.app.data.MaterialRole
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * A disagreement between the two pricing engines, written down instead of
 * overwritten. See JobSync's contract_total push block: the phone still
 * wins the row (it is the field truth) once one of these has been filed,
 * except once a quote has been sent, when the office number stands.
 *
 * Insert-only from here -- nothing on the phone ever reads this table back;
 * `pricing_drift_read` restricts it to OWNER/MANAGER on the office side.
 */
@Serializable
data class CloudPricingDrift(
    @SerialName("company_id") val companyId: String,
    @SerialName("job_sync_id") val jobSyncId: String,
    @SerialName("office_total") val officeTotal: Double?,
    @SerialName("phone_total") val phoneTotal: Double?,
    @SerialName("office_engine") val officeEngine: String,
    @SerialName("phone_engine") val phoneEngine: String,
    val detail: JsonObject = buildJsonObject {}
)

/** Files one [CloudPricingDrift] row. Failure is swallowed -- a missed drift note must never block the sync it came from. */
internal suspend fun recordPricingDrift(row: CloudPricingDrift) {
    runCatching { SupabaseModule.client.postgrest.from("pricing_drift").insert(row) }
}

/**
 * A per-role {quantity, unit_price} comparison of what the phone is about to
 * push against what the cloud's own line items already say, for the detail
 * column of a drift row.
 *
 * Best-effort on purpose -- the plan calls for this "if cheap, else {}", and
 * a network fetch that fails (or a job with a role split across lines in a
 * way that doesn't average cleanly) is not worth losing the drift row over.
 * Any problem here falls back to an empty object; the totals and engine
 * versions on the row are already the load-bearing part of the record.
 */
internal suspend fun buildDriftDetail(
    companyId: String,
    jobSyncId: String,
    localItems: List<EstimateLineItem>
): JsonObject = runCatching {
    val cloudItems = SupabaseModule.client.postgrest.from("estimate_line_items")
        .select {
            filter {
                eq("company_id", companyId)
                eq("job_sync_id", jobSyncId)
            }
        }
        .decodeList<CloudLineItem>()

    // Summed by role rather than compared line by line: a run can carry more
    // than one line of the same role (different panel widths), and the two
    // engines only need to agree on the total quantity and the price it
    // worked out to per role, not on how that happened to split into lines.
    fun quantityAndPrice(quantity: Double, priceTimesQuantity: Double): Pair<Double, Double> =
        quantity to if (quantity > 0.0) priceTimesQuantity / quantity else 0.0

    val localByRole = localItems
        .filter { it.role != MaterialRole.NONE }
        .groupBy { it.role.name }
        .mapValues { (_, lines) ->
            quantityAndPrice(lines.sumOf { it.quantity }, lines.sumOf { it.quantity * it.effectiveUnitPrice })
        }
    val cloudByRole = cloudItems
        .filter { it.role != null && it.role != MaterialRole.NONE.name }
        .groupBy { it.role!! }
        .mapValues { (_, lines) ->
            quantityAndPrice(
                lines.sumOf { it.quantity },
                lines.sumOf { it.quantity * (it.supplierUnitPrice ?: it.unitPrice) }
            )
        }

    buildJsonObject {
        (localByRole.keys + cloudByRole.keys).forEach { role ->
            val (phoneQty, phonePrice) = localByRole[role] ?: (0.0 to 0.0)
            val (officeQty, officePrice) = cloudByRole[role] ?: (0.0 to 0.0)
            val differs = kotlin.math.abs(phoneQty - officeQty) > 0.005 || kotlin.math.abs(phonePrice - officePrice) > 0.005
            if (differs) {
                putJsonObject(role) {
                    put("phone_quantity", phoneQty)
                    put("phone_unit_price", phonePrice)
                    put("office_quantity", officeQty)
                    put("office_unit_price", officePrice)
                }
            }
        }
    }
}.getOrElse { buildJsonObject {} }
