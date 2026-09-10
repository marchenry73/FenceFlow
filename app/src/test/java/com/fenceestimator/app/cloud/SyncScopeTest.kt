package com.fenceestimator.app.cloud

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * MONEY_KEYS is copied by hand from `job_money_columns()` in
 * supabase_crew_money_shield_patch.sql -- the one list the SQL views, the
 * crew RPCs, the hold trigger and this app all have to agree on. These
 * tests are the drift guard mustNotDo asks for: "any new money column on
 * jobs must be added to job_money_columns() and MONEY_KEYS in the same
 * commit."
 *
 * The comparison is against [CloudJob]'s real serial names, read off its
 * `kotlinx.serialization` descriptor rather than hand-copied again --
 * hand-copying the same list twice is exactly how the two would drift apart
 * silently.
 */
class SyncScopeTest {

    private fun cloudJobSerialNames(): Set<String> {
        val descriptor = CloudJob.serializer().descriptor
        return (0 until descriptor.elementsCount).map { descriptor.getElementName(it) }.toSet()
    }

    @Test
    fun `every MONEY_KEYS entry is a real CloudJob field, except the two documented exceptions`() {
        val onCloudJob = cloudJobSerialNames()
        val missing = MONEY_KEYS - onCloudJob
        assertEquals(
            "job_money_columns() carries a key with no CloudJob field and no entry in " +
                "MONEY_KEYS_NOT_ON_CLOUD_JOB. Either CloudJob is missing a field, or the gap " +
                "needs documenting there the way quote_token/quote_viewed_at already are.",
            MONEY_KEYS_NOT_ON_CLOUD_JOB,
            missing
        )
    }

    @Test
    fun `the two keys with no CloudJob field are exactly the quote-token path's own columns`() {
        // quote_token and quote_viewed_at are fetched by
        // JobDetailScreen.fetchQuoteToken through its own single-column
        // select, not through CloudJob at all -- see MONEY_KEYS' doc comment.
        assertEquals(setOf("quote_token", "quote_viewed_at"), MONEY_KEYS_NOT_ON_CLOUD_JOB)
    }

    @Test
    fun `MONEY_KEYS is not accidentally empty or truncated`() {
        // A regex or a bad merge that silently emptied this set would make
        // every other test in this file pass for the wrong reason -- nothing
        // to compare against is not the same as agreeing.
        assertTrue(MONEY_KEYS.size >= 28)
    }

    @Test
    fun `every CloudJob field MONEY_KEYS actually does cover round-trips through the descriptor`() {
        // Sanity check on the test itself: if getElementName ever stopped
        // matching real @SerialName values, every assertion above would
        // pass by finding nothing to disagree with.
        val onCloudJob = cloudJobSerialNames()
        assertTrue("sync_id" in onCloudJob)
        assertTrue("company_id" in onCloudJob)
        assertTrue("tax_rate_percent" in onCloudJob)
    }

    // ---- foldPayAnswer: the shared three-state fold behind askMoneyScope
    // and askEmployeePayScope ----
    //
    // Both askMoneyScope() (can_see_pay) and askEmployeePayScope()
    // (can_see_employee_pay) turn their RPC's Result<Boolean> into a
    // MoneyScope through this one function. The rule that must hold for
    // either RPC: a true answer is ALLOWED, a false answer is DENIED, and a
    // THROWN error -- not a false -- is UNKNOWN. Collapsing a thrown error
    // into DENIED is exactly the bug documented on MoneyScope and on
    // memory/empty-answer-reads-as-good-news.md: a dead spot reading as "not
    // allowed" scrubbed real cached rates to zero and pushed the zeros back
    // up.

    @Test
    fun `a true answer is ALLOWED`() {
        assertEquals(MoneyScope.ALLOWED, foldPayAnswer(Result.success(true)))
    }

    @Test
    fun `a false answer is DENIED, not UNKNOWN`() {
        assertEquals(MoneyScope.DENIED, foldPayAnswer(Result.success(false)))
    }

    @Test
    fun `a thrown error is UNKNOWN, never DENIED`() {
        // This is the one that matters: a network failure, a missing RPC on
        // an old database, or a dropped session must never be read as "the
        // server said no."
        assertEquals(
            MoneyScope.UNKNOWN,
            foldPayAnswer(Result.failure(RuntimeException("no signal")))
        )
    }
}
