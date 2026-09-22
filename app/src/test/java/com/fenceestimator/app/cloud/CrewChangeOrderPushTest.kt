package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.ChangeOrder
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * A crew phone's change orders reach the server.
 *
 * They never had: the phone pushed them with an upsert, an upsert is INSERT
 * ... ON CONFLICT, and ON CONFLICT runs the table's SELECT policies over the
 * row -- where the restrictive change_orders_money_hidden_from_crew refuses
 * anyone without SEE_MONEY (42501, new order or old). change_orders held 0
 * rows in production on 2026-09-22. crew_push_change_orders
 * (supabase_r6_crew_change_orders.sql) is the crew's door now; this holds the
 * app to using it the way it was built to be used:
 *
 *  - the door is decided by the money scope, and only a crew phone takes it;
 *  - the crew sends only what the crew may write -- no cost, no acceptance;
 *  - what the server skips is held back, never read as backed up, and a
 *    refusal of the whole call is held back rather than thrown at the screen;
 *  - the signature's STORAGE path travels, never the phone's own file path,
 *    and an unsigned copy never goes up beside a signed one in one batch
 *    (postgrest-kt writes NULL into a column a row leaves out).
 */
class CrewChangeOrderPushTest {

    private val errors = RealRestErrors()

    @After
    fun tearDown() = errors.close()

    private val company = "11111111-1111-1111-1111-111111111111"
    private val job = "22222222-2222-2222-2222-222222222222"
    private val ownFolder = "$company/$job/change-order/signature_1790000000000_abc.png"

    private fun order(
        syncId: String = "33333333-3333-3333-3333-333333333333",
        signedAt: String? = null,
        path: String? = null,
        marked: Boolean? = null
    ) = CloudChangeOrder(
        companyId = company, syncId = syncId, jobSyncId = job,
        description = "Extra 40 ft along the back", additionalFeet = 40.0,
        additionalCost = 900.0, materialCost = 350.0,
        signedAt = signedAt, inAcceptedTotal = marked, signatureStoragePath = path
    )

    // ---- which door ----

    @Test
    fun `only a crew phone goes through the crew door`() {
        assertEquals(ChangeOrderDoor.CREW_RPC, changeOrderDoor(MoneyScope.DENIED))
        assertEquals(ChangeOrderDoor.TABLE, changeOrderDoor(MoneyScope.ALLOWED))
        assertEquals(ChangeOrderDoor.NONE, changeOrderDoor(MoneyScope.UNKNOWN))
    }

    private fun pushAllStep(): String {
        val source = File("src/main/java/com/fenceestimator/app/cloud/EntitySync.kt").readText()
        val start = source.indexOf("step(\"change orders\") {")
        assertTrue("the change orders step is gone from pushAll", start >= 0)
        val end = source.indexOf("step(\"job steps\")", start)
        assertTrue(end > start)
        return source.substring(start, end)
    }

    @Test
    fun `the step asks changeOrderDoor and the crew branch never upserts the table`() {
        val step = pushAllStep()
        assertTrue("the step no longer decides by changeOrderDoor(scope)", step.contains("when (changeOrderDoor(scope))"))
        val crew = step.substringAfter("ChangeOrderDoor.CREW_RPC ->").substringBefore("ChangeOrderDoor.NONE ->")
        assertTrue("the crew branch does not use the crew door", crew.contains("pushChangeOrdersThroughCrewDoor(rows.orders)"))
        assertFalse("the crew branch upserts change_orders -- refused 42501 for every crew login", crew.contains("upsert(\"change_orders\""))
        assertTrue("orders the server did not take are not counted as held back", Regex("""if \(tally\.heldBack > 0\) \{\s*skipped \+= 1""").containsMatchIn(crew))
        assertTrue("a server without the function fails the sync instead of holding back", crew.contains("isNotDeployedYet(e)"))
        assertTrue(Regex("""ChangeOrderDoor\.NONE\s*->\s*0\b""").containsMatchIn(step))
    }

    @Test
    fun `the crew door calls the live function with rows_in`() {
        val source = File("src/main/java/com/fenceestimator/app/cloud/EntitySync.kt").readText()
        val body = source.substringAfter("private suspend fun pushChangeOrdersThroughCrewDoor(")
            .substringBefore("Uploads catalog items")
        assertTrue(body.contains("\"crew_push_change_orders\""))
        assertTrue(body.contains("put(\"rows_in\", crewChangeOrderRows(chunk))"))
        // An answer nobody can read is held back, not taken.
        assertTrue(body.contains("heldBack += chunk.size"))
    }

    // ---- what the crew sends ----

    @Test
    fun `the crew sends what it may write and nothing about money`() {
        val rows = crewChangeOrderRows(listOf(order(signedAt = "2026-09-22T15:00:00Z", path = ownFolder, marked = true)))
        val sent = rows.single().jsonObject
        assertEquals(CREW_CHANGE_ORDER_KEYS, sent.keys)
        assertEquals(JsonPrimitive(ownFolder), sent["signature_storage_path"])
        assertEquals(JsonPrimitive(40.0), sent["additional_feet"])
        listOf("additional_cost", "material_cost", "in_accepted_total", "deleted_at", "deleted_by").forEach {
            assertFalse("$it sent from a crew phone", it in sent)
        }
        // Planted failure: the order as-is -- the shape the table upsert sent,
        // and the one the server would accept and ignore -- asserts a cost the
        // crew cannot see, and marks the order as inside an accepted price.
        val asIs = SyncJson.encodeToJsonElement(CloudChangeOrder.serializer(), order(marked = true)).jsonObject
        assertTrue("additional_cost" in asIs && "material_cost" in asIs && "in_accepted_total" in asIs)
    }

    @Test
    fun `an unsigned order says nothing about a signature`() {
        val sent = crewChangeOrderRows(listOf(order())).single().jsonObject
        assertFalse("a null date must stay out -- the server reads a key as something to say", "signed_at" in sent)
        assertFalse("signature_storage_path" in sent)
        assertEquals(setOf("company_id", "sync_id", "job_sync_id", "description", "additional_feet"), sent.keys)
    }

    // ---- what the server answered ----

    @Test
    fun `skipped orders are held back and unchanged ones are taken`() {
        val answer = SyncJson.decodeFromString(
            CrewChangeOrderPushResult.serializer(),
            """{"inserted": 2, "updated": 1, "unchanged": 3, "skipped": 1}"""
        )
        assertEquals(3, answer.written)
        assertEquals(1, answer.heldBack(sent = 7))
        // A re-sent copy the server already holds is the usual answer, and it
        // is not work waiting.
        assertEquals(0, CrewChangeOrderPushResult(unchanged = 5).heldBack(sent = 5))
        // Planted failure: reading only "was anything written" would call
        // that same all-unchanged answer a miss on every pass.
        assertEquals(0, CrewChangeOrderPushResult(unchanged = 5).written)
    }

    @Test
    fun `an answer that accounts for nothing is not good news`() {
        val empty = SyncJson.decodeFromString(CrewChangeOrderPushResult.serializer(), "{}")
        assertEquals(4, empty.heldBack(sent = 4))
        // Counts that fall short of what was sent: the rest were not taken.
        assertEquals(2, CrewChangeOrderPushResult(inserted = 1, unchanged = 1).heldBack(sent = 4))
        // Planted failure: trusting "skipped" alone reads both as all taken.
        assertEquals(0, empty.skipped)
    }

    @Test
    fun `a refusal of the whole call is held back, not a crash`() {
        // What crew_push_change_orders raises for the caller as a whole
        // (42501 -> HTTP 403 for a signed-in caller), as postgrest-kt throws it.
        listOf("Not signed in", "Company suspended", "Not allowed to write change orders").forEach { said ->
            val refusal = errors.of(403, said, rpc = "crew_push_change_orders")
            assertTrue(said, isNotOursToSync(refusal))
            assertFalse(said, isNotDeployedYet(refusal))
        }
        // A server this function has not reached: held back too, not reported.
        val missing = errors.of(
            404, "Could not find the function public.crew_push_change_orders(rows_in) in the schema cache",
            rpc = "crew_push_change_orders"
        )
        assertTrue(isNotDeployedYet(missing))
        // Planted failure: a real fault is neither, and must still be reported.
        val broken = errors.of(500, "canceling statement due to statement timeout", rpc = "crew_push_change_orders")
        assertFalse(isNotOursToSync(broken))
        assertFalse(isNotDeployedYet(broken))
    }

    // ---- the signature's storage path ----

    private fun local(signedAt: Long? = null, image: String? = null, path: String? = null) = ChangeOrder(
        jobId = 7, description = "Extra 40 ft", additionalFeet = 40.0,
        signedAt = signedAt, signatureImagePath = image, signatureStoragePath = path
    )

    @Test
    fun `the storage path goes up, never the file on the phone`() {
        val signed = local(signedAt = 1790000000000, image = "/data/user/0/com.fenceestimator.app/files/signatures/signature_1.png", path = ownFolder)
        assertEquals(ownFolder, changeOrderSignaturePathToSend(signed, company, job))
        // Not uploaded yet: nothing to send -- and never the local file instead.
        assertNull(changeOrderSignaturePathToSend(signed.copy(signatureStoragePath = null), company, job))
        assertNull(changeOrderSignaturePathToSend(signed.copy(signatureStoragePath = signed.signatureImagePath), company, job))
        // Another job's folder, or a path that climbs out of this one.
        assertNull(changeOrderSignaturePathToSend(signed, company, "44444444-4444-4444-4444-444444444444"))
        assertNull(changeOrderSignaturePathToSend(signed.copy(signatureStoragePath = "$company/$job/change-order/../signature/x.png"), company, job))
    }

    @Test
    fun `a signature voided by an edit does not send its old image`() {
        // JobDetailViewModel.updateChangeOrder clears the image and the date
        // when the terms move, and leaves the uploaded path behind.
        val voided = local(signedAt = null, image = null, path = ownFolder)
        assertNull(changeOrderSignaturePathToSend(voided, company, job))
        // Planted failure: the path alone would send the old signature for the new terms.
        assertNotEquals(null, voided.signatureStoragePath)
    }

    @Test
    fun `a pulled signature brings its path to a phone that has none`() {
        val signedThere = order(signedAt = "2026-09-22T15:00:00Z", path = ownFolder)
        assertEquals("a new phone gets the image's path", ownFolder, pulledSignatureStoragePath(null, signedThere))
        assertEquals("the office phone gets the crew's signature", ownFolder, pulledSignatureStoragePath(local(), signedThere))
        // This phone's own signature is never replaced by another device's.
        val mine = "$company/$job/change-order/signature_mine.png"
        assertEquals(mine, pulledSignatureStoragePath(local(signedAt = 1L, image = "/x.png", path = mine), signedThere))
        assertNull("its own file, not uploaded yet, is kept", pulledSignatureStoragePath(local(signedAt = 1L, image = "/x.png"), signedThere))
        // An unsigned cloud copy carries no signature to adopt.
        assertNull(pulledSignatureStoragePath(null, order(path = ownFolder)))
    }

    // ---- the office's upsert ----

    @Test
    fun `an unsigned copy never shares a batch with a signed one`() {
        val rows = listOf(
            order(syncId = "a", signedAt = "2026-09-22T15:00:00Z", path = ownFolder),
            order(syncId = "b"),
            order(syncId = "c", signedAt = "2026-09-22T16:00:00Z"),
            order(syncId = "d")
        )
        val batches = changeOrdersInSameColumnBatches(rows)
        assertEquals(rows.map { it.syncId }.toSet(), batches.flatten().map { it.syncId }.toSet())
        assertEquals(rows.size, batches.flatten().size)
        batches.forEach { batch ->
            val wire = cloudJson.encodeToJsonElement(ListSerializer(CloudChangeOrder.serializer()), batch) as JsonArray
            assertEquals("a batch names columns some of its rows do not carry", 1, wire.map { it.jsonObject.keys }.toSet().size)
        }
        val unsigned = batches.single { batch -> batch.any { it.syncId == "b" } }
        assertEquals(listOf("b", "d"), unsigned.map { it.syncId })
        // Planted failure: one batch -- postgrest-kt sends columns= for the
        // union, and "b" and "d" would have NULL written over signed_at and
        // signature_storage_path on the server.
        val mixed = cloudJson.encodeToJsonElement(ListSerializer(CloudChangeOrder.serializer()), rows) as JsonArray
        assertNotEquals(1, mixed.map { it.jsonObject.keys }.toSet().size)
    }

    // ---- deleted elsewhere ----

    @Test
    fun `a crew phone learns of deleted change orders through the crew view`() {
        assertEquals("change_orders_crew", DeletionReaper.reapSource("change_orders", MoneyScope.DENIED))
        assertEquals("change_orders", DeletionReaper.reapSource("change_orders", MoneyScope.ALLOWED))
        // The rules the reap already had, unchanged.
        assertEquals("estimate_line_items_crew", DeletionReaper.reapSource("estimate_line_items", MoneyScope.DENIED))
        assertNull(DeletionReaper.reapSource("estimate_line_items", MoneyScope.UNKNOWN))
        assertNull(DeletionReaper.reapSource("pricing_tiers", MoneyScope.DENIED))
        assertNull(DeletionReaper.reapSource("pricing_tiers", MoneyScope.UNKNOWN))
        assertEquals("pricing_tiers", DeletionReaper.reapSource("pricing_tiers", MoneyScope.ALLOWED))
        assertEquals("job_steps", DeletionReaper.reapSource("job_steps", MoneyScope.DENIED))
    }
}
