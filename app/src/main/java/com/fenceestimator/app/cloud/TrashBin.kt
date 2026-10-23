package com.fenceestimator.app.cloud

import androidx.annotation.StringRes
import com.fenceestimator.app.R
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.Order
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
    /** English fallback for code with no Context; screens use [kindLabelRes]. */
    val kindLabel: String,
    @StringRes val kindLabelRes: Int,
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
        TrashTable("jobs", "customer_name", "Job", R.string.vm_kind_job),
        TrashTable("change_orders", "description", "Change order", R.string.vm_kind_change_order),
        TrashTable("expenses", "description", "Expense", R.string.vm_kind_expense),
        TrashTable("employees", "name", "Crew member", R.string.vm_kind_crew_member),
        TrashTable("material_items", "name", "Catalog item", R.string.vm_kind_catalog_item),
        TrashTable("fence_runs", "label", "Fence run", R.string.vm_kind_fence_run),
        TrashTable("punch_list_items", "description", "Punch list item", R.string.vm_kind_punch_item)
    )

    private data class TrashTable(
        val table: String,
        val labelColumn: String,
        val kind: String,
        @StringRes val kindRes: Int
    )

    suspend fun list(companyId: String): Result<List<TrashedRecord>> =
        withContext(Dispatchers.IO) {
            runCatching {
                RECOVERABLE.flatMap { spec ->
                    // Failing on one table must not empty the whole list -- a
                    // recovery screen that shows nothing because one query broke
                    // is indistinguishable from having nothing to recover.
                    runCatching {
                        // Paged, like every other read in the sync layer.
                        //
                        // This one asked once and took what came back, and the
                        // API caps a response at a thousand rows without saying
                        // so. On a company that had deleted more than that, the
                        // recovery screen would quietly stop listing the oldest
                        // items -- and a thing you cannot see in Deleted Items
                        // is indistinguishable from a thing that is gone.
                        //
                        // It was invisible to the guard that exists to catch
                        // exactly this, because that guard only recognised one
                        // of the two shapes a read is written in here. Widening
                        // the guard is what surfaced it.
                        buildList {
                            var from = 0L
                            val page = 1000L
                            while (true) {
                                val batch = SupabaseModule.client.postgrest.from(spec.table)
                                    .select(
                                        Columns.list("sync_id", spec.labelColumn, "deleted_at", "deleted_by")
                                    ) {
                                        filter {
                                            eq("company_id", companyId)
                                            filterNot("deleted_at", FilterOperator.IS, "null")
                                        }
                                        order("sync_id", Order.ASCENDING)
                                        range(from, from + page - 1)
                                    }
                                    .decodeList<JsonObject>()
                                addAll(batch)
                                if (batch.size < page) break
                                from += page
                                // The same backstop the other paged reads carry,
                                // so a server answering oddly cannot spin here.
                                if (size >= page * 50) break
                            }
                        }
                            .map { row ->
                                TrashedRecord(
                                    table = spec.table,
                                    syncId = row.text("sync_id"),
                                    label = row.text(spec.labelColumn).ifBlank { "(unnamed)" },
                                    kindLabel = spec.kind,
                                    kindLabelRes = spec.kindRes,
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
    /**
     * Tables whose rows hang off a job, keyed by the column naming their job.
     *
     * Restoring a job has to bring these back with it. Deleting a job removes
     * its children locally by cascade but only tombstones the job itself, so a
     * restored job arrived alone and its fence runs did not follow until the
     * next sync pass. A job with no fence runs has no linear feet, and with no
     * linear feet there is no labour charge -- so the job came back looking
     * like it was only worth its materials. It corrected itself a minute later,
     * which is arguably worse: the wrong figure is the one somebody reads.
     */
    private val JOB_CHILDREN = listOf(
        "fence_runs", "estimate_line_items", "change_orders",
        "job_steps", "site_markers", "expenses", "punch_list_items", "time_entries"
    )

    suspend fun restore(companyId: String, record: TrashedRecord): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val clear = buildJsonObject {
                    put("deleted_at", null as String?)
                    put("deleted_by", "")
                }

                SupabaseModule.client.postgrest.from(record.table).update(clear) {
                    filter {
                        eq("company_id", companyId)
                        eq("sync_id", record.syncId)
                    }
                }

                // Bring the job's children back in the same breath. Most will
                // carry no tombstone at all -- clearing one that is already
                // clear costs a round trip and changes nothing, which is a fair
                // price for the job returning whole.
                if (record.table == "jobs") {
                    // Only tombstones written with the job's own deletion or
                    // later. Clearing every child tombstone resurrected things
                    // deliberately deleted weeks earlier -- restore a job and a
                    // line item you removed on purpose was quietly back on the
                    // estimate, at its old price. The minute of slack covers
                    // the delete cascade writing its stamps a moment apart.
                    val cutoff = record.deletedAt?.minus(60_000L)
                    JOB_CHILDREN.forEach { child ->
                        runCatching {
                            SupabaseModule.client.postgrest.from(child).update(clear) {
                                filter {
                                    eq("company_id", companyId)
                                    eq("job_sync_id", record.syncId)
                                    if (cutoff != null) {
                                        gte("deleted_at", CloudTime.format(cutoff))
                                    }
                                }
                            }
                        }
                    }
                }
                Unit
            }
        }

    /**
     * Destroys a deleted JOB for good, unless money is recorded against it.
     *
     * AN RPC, NOT A DELETE, and that is the whole reason this works. The
     * previous version of this function issued a plain DELETE, which the
     * database refuses for every role -- there is no DELETE policy on these
     * tables for anybody, owner included. It returned success and destroyed
     * nothing, so whoever pressed the button watched the item come back on the
     * next load. public.purge_job (supabase_r33_purge_job_never_money.sql) is
     * SECURITY DEFINER, which is the only way past that, and it carries the
     * rules in the one place both phones and the office read:
     *
     *   - the caller must hold DELETE_RECORDS;
     *   - the job must already be in the bin, so purge is the second step of a
     *     decision somebody already made, never a shortcut past the first;
     *   - a job with ANY payment recorded against it is refused, in either
     *     ledger, including rows already soft-deleted. "Permanent delete, but
     *     never money."
     *
     * It also discovers the twenty-two tables carrying a job_sync_id at run
     * time rather than from a list in here, so a table added next year is
     * cleaned up by the same call instead of leaving orphans behind.
     *
     * THE SERVER'S SENTENCE IS THE ANSWER. A refusal arrives as the message
     * raised by purge_job -- "That job has 2 payment record(s) against it.
     * Money is never destroyed" -- and callers show it as it is. Replacing it
     * with wording of our own is how 42 deliberate server messages were once
     * all turned into one wrong sentence about the account.
     */
    suspend fun purgeJob(jobSyncId: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                SupabaseModule.client.postgrest.rpc(
                    "purge_job",
                    buildJsonObject { put("p_job_sync_id", jobSyncId) }
                )
                Unit
            }
        }

    private fun JsonObject.text(key: String): String =
        (this[key] as? JsonPrimitive)?.contentOrNull().orEmpty()

    private fun JsonPrimitive.contentOrNull(): String? = if (isString || content != "null") content else null
}
