package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.ChangeOrder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A change order goes up only when this phone changed it, and a signature the
 * terms voided actually comes off the server.
 *
 * Both used to be broken in the same way and neither could be seen: change
 * orders held 0 rows in production and audit_log held 0 change-order edits on
 * 2026-09-22, so nothing exercised any of it. On line items -- the same table
 * shape, actually used -- the audit log holds 198 quantity flip-flops, which is
 * what "every row goes up on every pass and the pull applies whatever the cloud
 * holds" looks like once two phones are typing.
 */
class ChangeOrderPushQueueTest {

    private val company = "11111111-1111-1111-1111-111111111111"
    private val job = "22222222-2222-2222-2222-222222222222"

    private fun order(
        syncId: String = "33333333-3333-3333-3333-333333333333",
        pendingPush: Boolean = false,
        signedAt: Long? = null,
        storagePath: String? = null,
        clearedAt: Long? = null
    ) = ChangeOrder(
        syncId = syncId, jobId = 1L, description = "extra 40 ft", additionalFeet = 40.0,
        additionalCost = 900.0, materialCost = 300.0,
        signatureStoragePath = storagePath, signedAt = signedAt,
        pendingPush = pendingPush, signatureClearedAt = clearedAt
    )

    // ---- the queue ----

    @Test
    fun `the pull may not write an order this phone has waiting to go up`() {
        assertTrue("an order the cloud has taken", pullMayWriteOrder(order(pendingPush = false)))
        assertTrue("an order this phone does not hold at all", pullMayWriteOrder(null))
        assertFalse("an order changed here", pullMayWriteOrder(order(pendingPush = true)))
    }

    /**
     * The whole point of the mark, stated as the case that used to fail: the
     * terms were edited here, which clears the signature, and the pull runs
     * straight after the push. Without the mark the cloud's copy -- still
     * signed, because a null is left out of the body -- landed on the edited
     * terms the same second.
     */
    @Test
    fun `an order whose signature was just voided is not overwritten by the cloud`() {
        val edited = order(pendingPush = true, signedAt = null, storagePath = null, clearedAt = 1790000000000)
        assertFalse(pullMayWriteOrder(edited))
    }

    // ---- saying NULL out loud ----

    /**
     * Why the clear cannot be an ordinary row: the shared Json drops a null
     * property, so a serialized order can ask the server to KEEP a signature or
     * to SET one, never to remove it. This is the premise the hand-built rows
     * exist for -- if it ever stops being true, this test says so.
     */
    @Test
    fun `a serialized order cannot ask the server to remove a signature`() {
        val row = CloudChangeOrder(
            companyId = company, syncId = "x", jobSyncId = job,
            description = "extra 40 ft", additionalFeet = 40.0, additionalCost = 900.0,
            materialCost = 300.0, signedAt = null, signatureStoragePath = null
        )
        val json = SyncJson.encodeToJsonElement(CloudChangeOrder.serializer(), row).jsonObject
        assertFalse("signed_at" in json.keys)
        assertFalse("signature_storage_path" in json.keys)
    }

    @Test
    fun `the clear rows name both signature columns as explicit nulls`() {
        val cleared = order(pendingPush = true, clearedAt = 1790000000000)
        val rows = changeOrderSignatureClearRows(listOf(cleared), company) { job }
        assertEquals(1, rows.size)
        val row = rows.single()
        assertEquals(JsonNull, row["signed_at"])
        assertEquals(JsonNull, row["signature_storage_path"])
        // The keys that find the row, and nothing else: the terms go up in the
        // ordinary batches, and in_accepted_total latches server-side so a null
        // there would read as "not marked".
        assertEquals(
            setOf("company_id", "sync_id", "job_sync_id", "signed_at", "signature_storage_path"),
            row.keys
        )
        assertEquals(JsonPrimitive(company), row["company_id"])
        assertEquals(JsonPrimitive(cleared.syncId), row["sync_id"])
        assertEquals(JsonPrimitive(job), row["job_sync_id"])
        assertFalse("in_accepted_total" in row.keys)
        assertFalse("additional_cost" in row.keys)
    }

    @Test
    fun `every clear row names the same columns, so they are one batch`() {
        val rows = changeOrderSignatureClearRows(
            listOf(
                order(syncId = "a", pendingPush = true, clearedAt = 1L),
                order(syncId = "b", pendingPush = true, clearedAt = 2L)
            ),
            company
        ) { job }
        assertEquals(2, rows.size)
        assertEquals(1, rows.map { it.keys }.distinct().size)
    }

    @Test
    fun `an order with no job to belong to is left out rather than sent half-addressed`() {
        val rows = changeOrderSignatureClearRows(listOf(order(pendingPush = true, clearedAt = 1L)), company) { null }
        assertTrue(rows.isEmpty())
    }

    // ---- job steps: the same batch-NULL trap, on the table that still had it ----

    /**
     * A batch upsert names every column any of its rows carries and writes NULL
     * into it for a row that does not have it. `step_key` says WHICH shipped
     * step this is, and a keyless row means "nothing to say" -- so one keyless
     * step in a batch blanked the key of every keyed step beside it, and those
     * steps then read in their seeded language on every phone for good.
     */
    @Test
    fun `a keyless job step never shares a batch with one that has a key`() {
        val keyed = step(syncId = "a", stepKey = "install.set_posts")
        val keyless = step(syncId = "b", stepKey = null)
        val batches = jobStepsInSameColumnBatches(listOf(keyed, keyless))
        assertEquals(2, batches.size)
        batches.forEach { batch ->
            assertEquals("a batch mixes keyed and keyless rows", 1, batch.map { it.stepKey != null }.distinct().size)
        }
        // Planted failure: unbatched, these two went up together -- which is
        // exactly what the push did before.
        assertEquals(2, listOf(keyed, keyless).size)
        assertEquals(1, listOf(listOf(keyed, keyless)).size)
    }

    /**
     * And the tick. Whether a push mentioned completed_at depended on whether
     * some OTHER step in the batch happened to be ticked, which is not a rule.
     * Grouped, an all-unticked batch never names the column, so a phone cannot
     * clear a tick it has simply not pulled yet -- which is what the merge on
     * the way down already says should happen.
     */
    @Test
    fun `a ticked step never shares a batch with an unticked one`() {
        val ticked = step(syncId = "a", completedAt = "2026-09-22T15:00:00Z", stepKey = "k")
        val unticked = step(syncId = "b", completedAt = null, stepKey = "k")
        val batches = jobStepsInSameColumnBatches(listOf(ticked, unticked))
        assertEquals(2, batches.size)
    }

    @Test
    fun `steps that say the same things stay in one batch`() {
        val a = step(syncId = "a", completedAt = "2026-09-22T15:00:00Z", stepKey = "k1")
        val b = step(syncId = "b", completedAt = "2026-09-22T16:00:00Z", stepKey = "k2")
        assertEquals(1, jobStepsInSameColumnBatches(listOf(a, b)).size)
        assertNotNull(jobStepsInSameColumnBatches(listOf(a, b)).single().find { it.syncId == "b" })
    }

    @Test
    fun `no rows is no batches, so the push sends nothing`() {
        assertTrue(jobStepsInSameColumnBatches(emptyList()).isEmpty())
        assertTrue(changeOrderSignatureClearRows(emptyList(), company) { job }.isEmpty())
    }

    private fun step(
        syncId: String,
        completedAt: String? = null,
        stepKey: String? = null
    ) = CloudJobStep(
        companyId = company, syncId = syncId, jobSyncId = job, kind = "INSTALL",
        description = "set the posts", checked = completedAt != null,
        verifiedWithCustomer = false, sortOrder = 0,
        completedAt = completedAt, stepKey = stepKey
    )
}
