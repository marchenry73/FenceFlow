package com.fenceestimator.app.cloud

import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.filter.FilterOperator
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Something that was deleted and can be put back. */
data class TrashedRecord(
    val table: String,
    val syncId: String,
    /** What it was, in the words the person who deleted it would recognise. */
    val label: String,
    val kindLabel: String,
    val deletedAt: Long?,
    val deletedBy: String
)

/**
 * What has been deleted, and putting it back.
 *
 * Only possible because deletion became a tombstone rather than a removal --
 * the row is still there with a date on it. Before that there was nothing to
 * restore from, which is also why a mistaken delete used to be final.
 *
 * Read straight from the cloud rather than from this phone. The whole point is
 * to recover something this device may never have had: the delete may have
 * happened on somebody else's phone, and by the time anyone realises it was a
 * mistake, every device has already removed its local copy.
 */
object TrashBin {

    /**
     * The tables worth showing, with the column that names the record.
     *
     * Not every synced table is here. A deleted job step or site marker is
     * noise in a recovery list -- what people actually come looking for is a
     * job, a change order, an expense or a person.
     */
    private val RECOVERABLE = listOf(
        TrashTable("jobs", "customer_name", "Job"),
        TrashTable("change_orders", "description", "Change order"),
        TrashTable("expenses", "description", "Expense"),
        TrashTable("employees", "name", "Crew member"),
        TrashTable("material_items", "name", "Catalog item"),
        TrashTable("fence_runs", "label", "Fence run"),
        TrashTable("punch_list_items", "description", "Punch list item")
    )

    private data class TrashTable(val table: String, val labelColumn: String, val kind: String)

    suspend fun list(companyId: String): Result<List<TrashedRecord>> =
        withContext(Dispatchers.IO) {
            runCatching {
                RECOVERABLE.flatMap { spec ->
                    // Failing on one table must not empty the whole list -- a
                    // recovery screen that shows nothing because one query broke
                    // is indistinguishable from having nothing to recover.
                    runCatching {
                        SupabaseModule.client.postgrest.from(spec.table)
                            .select(
                                Columns.list("sync_id", spec.labelColumn, "deleted_at", "deleted_by")
                            ) {
                                filter {
                                    eq("company_id", companyId)
                                    filterNot("deleted_at", FilterOperator.IS, "null")
                                }
                            }
                            .decodeList<JsonObject>()
                            .map { row ->
                                TrashedRecord(
                                    table = spec.table,
                                    syncId = row.text("sync_id"),
                                    label = row.text(spec.labelColumn).ifBlank { "(unnamed)" },
                                    kindLabel = spec.kind,
                                    deletedAt = CloudTime.parseMillis(row.text("deleted_at")),
                                    deletedBy = row.text("deleted_by")
                                )
                            }
                    }.getOrDefault(emptyList())
                }.sortedByDescending { it.deletedAt ?: 0L }
            }
        }

    /**
     * Puts a record back by clearing its tombstone.
     *
     * Nothing is written locally here. The row becomes live in the cloud again
     * and the next sync brings it down the same way any other record arrives --
     * which means it lands on every device, not just this one, and it lands
     * through the path that has already been made to behave correctly.
     */
    suspend fun restore(companyId: String, record: TrashedRecord): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                SupabaseModule.client.postgrest.from(record.table).update(
                    buildJsonObject {
                        put("deleted_at", null as String?)
                        put("deleted_by", "")
                    }
                ) {
                    filter {
                        eq("company_id", companyId)
                        eq("sync_id", record.syncId)
                    }
                }
                Unit
            }
        }

    private fun JsonObject.text(key: String): String =
        (this[key] as? JsonPrimitive)?.contentOrNull().orEmpty()

    private fun JsonPrimitive.contentOrNull(): String? = if (isString || content != "null") content else null
}
