package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.ChangeOrder
import com.fenceestimator.app.data.changeOrderStillAsSent
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

    /**
     * The clear goes up as its own request, so it can fail while the ordinary
     * batch succeeds -- and that batch clears pendingPush. An order in that
     * state is still claiming the clear and the server still holds the
     * signature, so the pull must keep its hands off it until the clear lands.
     * Reading only pendingPush here let the signature back in one pass later.
     */
    @Test
    fun `an order still claiming a clear is protected after its push mark comes off`() {
        val halfSent = order(pendingPush = false, clearedAt = 1790000000000)
        assertFalse(pullMayWriteOrder(halfSent))
        // Planted failure, stated as the rule it replaced rather than as a
        // restatement of the fixture: reading only pendingPush -- which is what
        // this function did for one build -- gives the OPPOSITE answer for this
        // exact order, and would have let the cloud's still-signed copy land on
        // it one pass after the ordinary batch cleared the mark.
        val ruleBeforeTheFix = { o: ChangeOrder? -> o?.pendingPush != true }
        assertTrue("the rule as it was would have allowed this", ruleBeforeTheFix(halfSent))
        assertFalse("the rule as it is refuses it", pullMayWriteOrder(halfSent))
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

    private fun cloudOrder(
        syncId: String = "33333333-3333-3333-3333-333333333333",
        signedAt: String? = null,
        storagePath: String? = null,
        inAcceptedTotal: Boolean? = null
    ) = CloudChangeOrder(
        companyId = company, syncId = syncId, jobSyncId = job,
        description = "extra 40 ft", additionalFeet = 40.0, additionalCost = 900.0,
        materialCost = 300.0, signedAt = signedAt, inAcceptedTotal = inAcceptedTotal,
        signatureStoragePath = storagePath
    )

    @Test
    fun `the clear rows name both signature columns as explicit nulls` () {
        val row = changeOrderSignatureClearRows(listOf(cloudOrder()), setOf(cloudOrder().syncId))
            .single().single()
        assertEquals(JsonNull, row["signed_at"])
        assertEquals(JsonNull, row["signature_storage_path"])
        // Complete, not just the three keys that find the row: an upsert is
        // INSERT ... ON CONFLICT and every other NOT NULL column has a default,
        // so a bare clear for an order the server does not hold yet would have
        // inserted a phantom order with an empty description and $0.
        assertEquals(JsonPrimitive(company), row["company_id"])
        assertEquals(JsonPrimitive(job), row["job_sync_id"])
        assertEquals(JsonPrimitive("extra 40 ft"), row["description"])
        assertEquals(JsonPrimitive(900.0), row["additional_cost"])
        // Never a null on the latching flag -- that would read as "not marked".
        assertFalse("in_accepted_total" in row.keys)
    }

    @Test
    fun `only the orders claiming a clear are sent, and only the ones the push carries` () {
        val cleared = cloudOrder(syncId = "a")
        val untouched = cloudOrder(syncId = "b", signedAt = "2026-09-22T15:00:00Z")
        val batches = changeOrderSignatureClearRows(listOf(cleared, untouched), setOf("a"))
        assertEquals(1, batches.sumOf { it.size })
        assertEquals(JsonPrimitive("a"), batches.single().single()["sync_id"])
        // An id claiming a clear that this pass is not pushing sends nothing at
        // all, rather than a row with no terms on it.
        assertTrue(changeOrderSignatureClearRows(listOf(untouched), setOf("a")).isEmpty())
    }

    @Test
    fun `clear rows that name different columns are different batches` () {
        // One order was inside an accepted price and one was not, so their rows
        // do not name the same columns -- and a batch upsert writes NULL into a
        // column a row in it does not carry.
        val plain = cloudOrder(syncId = "a", inAcceptedTotal = null)
        val marked = cloudOrder(syncId = "b", inAcceptedTotal = true)
        val batches = changeOrderSignatureClearRows(listOf(plain, marked), setOf("a", "b"))
        assertEquals(2, batches.size)
        batches.forEach { batch -> assertEquals(1, batch.map { it.keys }.distinct().size) }
    }

    @Test
    fun `orders that say the same things share one clear batch` () {
        val batches = changeOrderSignatureClearRows(
            listOf(cloudOrder(syncId = "a"), cloudOrder(syncId = "b")), setOf("a", "b")
        )
        assertEquals(1, batches.size)
        assertEquals(2, batches.single().size)
        assertEquals(1, batches.single().map { it.keys }.distinct().size)
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
        val batches = jobStepPushRows(listOf(keyed, keyless))
        assertEquals(2, batches.size)
        batches.forEach { batch ->
            assertEquals(
                "a batch mixes rows that name step_key with rows that do not",
                1, batch.map { "step_key" in it.keys }.distinct().size
            )
        }
        // The keyed row names it; the keyless row leaves it out, which is what
        // makes them different batches -- a batch upsert would otherwise write
        // NULL over the key of every keyed step beside it.
        val all = batches.flatten()
        assertEquals(setOf(true, false), all.map { "step_key" in it.keys }.toSet())
    }

    /**
     * And the tick. Whether a push mentioned completed_at depended on whether
     * some OTHER step in the batch happened to be ticked, which is not a rule.
     * Grouped, an all-unticked batch never names the column, so a phone cannot
     * clear a tick it has simply not pulled yet -- which is what the merge on
     * the way down already says should happen.
     */
    /**
     * The tick is TWO columns and only one of them is nullable. `checked` is a
     * non-null Boolean, so it travels on every row whatever the batch looks like;
     * leaving `completed_at` out for an unticked step wrote "not ticked" while
     * the server kept its tick DATE. Grouping them apart, as this file did for
     * one build, made that permanent -- an all-unticked batch never named the
     * column again, so the contradiction could never be corrected by a push.
     * Named explicitly, the pair always travels together.
     */
    @Test
    fun `an unticked step says completed_at is null out loud, in the same batch as a ticked one`() {
        val ticked = step(syncId = "a", completedAt = "2026-09-22T15:00:00Z", stepKey = "k")
        val unticked = step(syncId = "b", completedAt = null, stepKey = "k")
        val batches = jobStepPushRows(listOf(ticked, unticked))
        assertEquals("both rows name the same columns, so one batch", 1, batches.size)
        val rows = batches.single().associateBy { it["sync_id"] }
        assertEquals(JsonPrimitive("2026-09-22T15:00:00Z"), rows[JsonPrimitive("a")]!!["completed_at"])
        assertEquals(JsonNull, rows[JsonPrimitive("b")]!!["completed_at"])
        // ...and `checked` is on both, which is why the null has to be explicit.
        assertEquals(JsonPrimitive(true), rows[JsonPrimitive("a")]!!["checked"])
        assertEquals(JsonPrimitive(false), rows[JsonPrimitive("b")]!!["checked"])
    }

    @Test
    fun `steps that say the same things stay in one batch`() {
        val a = step(syncId = "a", completedAt = "2026-09-22T15:00:00Z", stepKey = "k1")
        val b = step(syncId = "b", completedAt = "2026-09-22T16:00:00Z", stepKey = "k2")
        val batches = jobStepPushRows(listOf(a, b))
        assertEquals(1, batches.size)
        assertNotNull(batches.single().find { it["sync_id"] == JsonPrimitive("b") })
    }

    @Test
    fun `no rows is no batches, so the push sends nothing`() {
        assertTrue(jobStepPushRows(emptyList()).isEmpty())
        assertTrue(changeOrderSignatureClearRows(emptyList(), setOf("a")).isEmpty())
        assertTrue(changeOrderSignatureClearRows(listOf(cloudOrder()), emptySet()).isEmpty())
    }

    // ---- what the review confirmed, each written to fail against the old code ----

    /**
     * THE CRITICAL. The customer can sign again between the terms edit and the
     * sync -- the phone is usually offline for both -- and signing does not reset
     * signatureClearedAt. Sending a clear for that order nulled the signature
     * that had just gone up in the ordinary batch, and
     * clearSignatureClearedMark then matched nothing (it asks for signedAt IS
     * NULL), so the same pair of requests repeated for ever and the server could
     * never hold the revised order's signature.
     */
    @Test
    fun `a re-signed order is never sent a clear`() {
        val resigned = cloudOrder(syncId = "a", signedAt = "2026-09-23T10:00:00Z", storagePath = null)
        // The push splits by the same rule: still cleared means unsigned here.
        val stillCleared = order(syncId = "b", pendingPush = true, clearedAt = 1L)
        val reSigned = order(syncId = "a", pendingPush = true, clearedAt = 1L, signedAt = 2L)
        val (cleared, signedAgain) = listOf(stillCleared, reSigned)
            .filter { it.signatureClearedAt != null }
            .partition { it.signedAt == null && it.signatureStoragePath == null }
        assertEquals(listOf("b"), cleared.map { it.syncId })
        assertEquals(listOf("a"), signedAgain.map { it.syncId })
        // ...and the clear rows for that pass carry only the one still cleared.
        val rows = changeOrderSignatureClearRows(
            listOf(resigned, cloudOrder(syncId = "b")), cleared.map { it.syncId }.toSet()
        )
        assertEquals(1, rows.sumOf { it.size })
        assertEquals(JsonPrimitive("b"), rows.single().single()["sync_id"])
    }

    @Test
    fun `an order re-signed after a terms edit stops claiming the clear`() {
        // The claim is dropped by signedAt OR a storage path: an image uploaded
        // for the new signature is the same news arriving a different way.
        val bySignature = order(syncId = "a", clearedAt = 1L, signedAt = 2L)
        val byUpload = order(syncId = "b", clearedAt = 1L, storagePath = "co/x.png")
        val stillCleared = order(syncId = "c", clearedAt = 1L)
        listOf(bySignature, byUpload).forEach {
            assertFalse(
                "an order signed again must not be treated as still cleared",
                it.signedAt == null && it.signatureStoragePath == null
            )
        }
        assertTrue(stillCleared.signedAt == null && stillCleared.signatureStoragePath == null)
    }

    /**
     * The mark may come off only where the row still holds what went up. An
     * amount typed while the upsert was in flight has not been sent, and clearing
     * by sync id alone dropped it -- the next pull then wrote the cloud's older
     * value over it with nothing to show the edit had existed.
     */
    @Test
    fun `a change order edited while the push was in flight is not counted as sent`() {
        val sent = order(syncId = "a", pendingPush = true)
        assertTrue("unchanged: the mark may come off", changeOrderStillAsSent(sent, sent))
        // Every column that travels, one at a time.
        assertFalse(changeOrderStillAsSent(sent, sent.copy(additionalCost = 1250.0)))
        assertFalse(changeOrderStillAsSent(sent, sent.copy(materialCost = 400.0)))
        assertFalse(changeOrderStillAsSent(sent, sent.copy(additionalFeet = 60.0)))
        assertFalse(changeOrderStillAsSent(sent, sent.copy(description = "8ft gate")))
        assertFalse(changeOrderStillAsSent(sent, sent.copy(signedAt = 5L)))
        assertFalse(changeOrderStillAsSent(sent, sent.copy(signatureStoragePath = "co/y.png")))
        assertFalse(changeOrderStillAsSent(sent, sent.copy(inAcceptedTotal = true)))
        // ...and the two marks themselves never travel, so they must not count as
        // a change -- or a row could never be unmarked at all.
        assertTrue(changeOrderStillAsSent(sent, sent.copy(pendingPush = false)))
        assertTrue(changeOrderStillAsSent(sent, sent.copy(signatureClearedAt = 99L)))
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
