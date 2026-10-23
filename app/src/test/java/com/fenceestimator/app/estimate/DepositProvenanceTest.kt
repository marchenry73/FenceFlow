package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.Job
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WHO SET THE DEPOSIT -- the bit, not the rule.
 *
 * [DepositFollowsPriceTest] beside this file proves the RULE:
 * [JobMoney.depositToStore] moves an automatic deposit, never a typed one, and
 * freezes both once the customer is in it. That rule was right, and shipped,
 * and the owner still reported twice that his deposit did not follow the price.
 *
 * He was right, and the rule was not the problem. "Set deposit" -- the button
 * that fills in the app's OWN suggested figure -- stored depositIsAuto = false,
 * the same value a figure typed by hand gets. So the single action that puts a
 * deposit on a job also marked that deposit as a person's choice, and the
 * rule's first gate then refused to move it ever again. Pressing the button we
 * told him to press is what turned the feature off.
 *
 * So this file is about PROVENANCE: which of the two things a stored deposit
 * is, who is allowed to say so, and what the screen may tell him when the
 * figure is not the one the price suggests. The canary is the exact mistake
 * that shipped, so re-making it goes red here.
 */
class DepositProvenanceTest {

    /** Enough materials and price that the rule has a real answer. */
    private val materials = 4_000.0
    private val billable = 12_000.0

    /** Dearer, for "the price moved" -- a second answer, provably different. */
    private val dearerMaterials = 6_000.0
    private val dearerBillable = 18_000.0

    private fun job(
        deposit: Double = 0.0,
        auto: Boolean = false,
        approvedAt: Long? = null,
        signedAt: Long? = null,
        paid: Double = 0.0,
    ) = Job(
        id = 1,
        customerName = "A",
        depositAmount = deposit,
        depositIsAuto = auto,
        quoteApprovedAt = approvedAt,
        signedAt = signedAt,
        amountPaid = paid,
    )

    private fun suggestion(j: Job, m: Double = materials, b: Double = billable) =
        JobMoney.depositSuggestion(j, m, b).amount

    @Test
    fun `positive control -- both price points really do suggest different figures`() {
        // Without this, "it followed the price" could pass because the two
        // prices suggest the same deposit, and "it did not follow" could pass
        // because neither suggests anything at all.
        val cheap = suggestion(job())
        val dear = suggestion(job(), dearerMaterials, dearerBillable)
        assertTrue("the cheap fixture suggests $cheap", cheap > 100.0)
        assertTrue("the dear fixture suggests $dear", dear > cheap)
    }

    // -----------------------------------------------------------------------
    // THE BUG.
    // -----------------------------------------------------------------------

    /**
     * ACCEPTING THE APP'S FIGURE IS NOT CHOOSING A FIGURE.
     *
     * The correction, expressed where it can be tested: a deposit that came
     * from the suggestion, marked as the app's, follows the next price.
     * `applySuggestedDeposit()` stores exactly this pair now, and stored the
     * other one before.
     */
    @Test
    fun `a deposit set from the suggestion still follows the next price`() {
        val fresh = job()
        val accepted = fresh.copy(depositAmount = suggestion(fresh), depositIsAuto = true)

        val next = JobMoney.depositToStore(accepted, dearerMaterials, dearerBillable)
        assertNotNull(
            "the deposit did not follow the price after being set from the suggestion",
            next
        )
        assertTrue(
            "the deposit did not rise with the price: $next vs ${accepted.depositAmount}",
            next!! > accepted.depositAmount
        )
        assertEquals(suggestion(accepted, dearerMaterials, dearerBillable), next, 0.005)
    }

    /**
     * CANARY for the exact line that shipped. If "Set deposit" ever writes
     * false again, this is the job it writes -- and the rule refuses to move
     * it, which is precisely what he reported. A green canary here would mean
     * this file could not have caught the bug it exists for.
     */
    @Test
    fun `CANARY -- storing the suggestion as a typed figure kills the follow`() {
        val fresh = job()
        val frozen = fresh.copy(depositAmount = suggestion(fresh), depositIsAuto = false)
        assertNull(
            "THE CANARY DID NOT FIRE: a deposit marked as typed was followed anyway",
            JobMoney.depositToStore(frozen, dearerMaterials, dearerBillable)
        )
    }

    /**
     * And the way back exists, with the same protection on it. `followPriceAgain`
     * writes this pair after checking [JobMoney.customerIsInIt] -- so the thing
     * that makes it safe is testable here even though the write is not.
     */
    @Test
    fun `handing a typed deposit back to the price makes it follow again`() {
        val typed = job(deposit = 1_000.0, auto = false)
        assertNull("a typed deposit moved on its own", JobMoney.depositToStore(typed, materials, billable))

        val rearmed = typed.copy(depositAmount = suggestion(typed), depositIsAuto = true)
        assertNotNull(
            "a deposit handed back to the price still did not follow",
            JobMoney.depositToStore(rearmed, dearerMaterials, dearerBillable)
        )
    }

    @Test
    fun `and it cannot be handed back once the customer is in it`() {
        // followPriceAgain refuses these outright; depositToStore would refuse
        // them too, which is the belt as well as the braces.
        for (j in listOf(
            job(deposit = 1_000.0, auto = false, signedAt = 1_760_000_000_000L),
            job(deposit = 1_000.0, auto = false, approvedAt = 1_760_000_000_000L),
            job(deposit = 1_000.0, auto = false, paid = 500.0),
        )) {
            assertTrue("customerIsInIt said no for a job that is agreed", JobMoney.customerIsInIt(j))
            val rearmed = j.copy(depositIsAuto = true)
            assertNull(
                "an agreed deposit moved after being marked automatic",
                JobMoney.depositToStore(rearmed, dearerMaterials, dearerBillable)
            )
        }
    }

    // -----------------------------------------------------------------------
    // What the estimate is allowed to SAY about it.
    //
    // A deposit frozen on purpose and a deposit that was not following looked
    // identical on that screen, which is the reading that got reported.
    // -----------------------------------------------------------------------

    @Test
    fun `depositFollow names the gate that is actually holding`() {
        assertEquals(
            JobMoney.DepositFollow.FOLLOWING,
            JobMoney.depositFollow(job(deposit = 1_000.0, auto = true), materials, billable).first
        )
        assertEquals(
            JobMoney.DepositFollow.TYPED_BY_HAND,
            JobMoney.depositFollow(job(deposit = 1_000.0, auto = false), materials, billable).first
        )
        // AGREED BEATS TYPED. On a signed job it does not matter who chose the
        // figure, and the screen must not offer to put that one back on
        // automatic -- changing it is changing the deal.
        assertEquals(
            JobMoney.DepositFollow.CUSTOMER_AGREED,
            JobMoney.depositFollow(
                job(deposit = 1_000.0, auto = false, signedAt = 1_760_000_000_000L),
                materials, billable
            ).first
        )
        assertEquals(
            JobMoney.DepositFollow.CUSTOMER_AGREED,
            JobMoney.depositFollow(
                job(deposit = 1_000.0, auto = true, paid = 500.0),
                materials, billable
            ).first
        )
        // Nothing priced yet: no figure to name, so the screen says nothing.
        assertEquals(
            JobMoney.DepositFollow.NOTHING_TO_SUGGEST,
            JobMoney.depositFollow(job(), 0.0, 0.0).first
        )
    }

    @Test
    fun `depositFollow hands back the suggested figure, not the stored one`() {
        val j = job(deposit = 1_000.0, auto = false)
        val (state, want) = JobMoney.depositFollow(j, materials, billable)
        assertEquals(JobMoney.DepositFollow.TYPED_BY_HAND, state)
        assertEquals(suggestion(j), want, 0.005)
        assertTrue(
            "the suggestion equals the stored figure, so the sentence would say nothing",
            kotlin.math.abs(want - j.depositAmount) > 0.005
        )
    }

    /**
     * THE REFUSAL THE SEED'S RETRY KEY WAS ADDED FOR -- "a brand new job
     * deposit is 0 until the price changes".
     *
     * With no materials there is no suggestion, so nothing is stored. That is
     * correct, and it is also the pass the estimate screen used to give up on
     * for good: it asked once, keyed on the job's total, and the total does not
     * change again just because the line items finally arrived. The key now
     * includes the materials figure, so this refusal is retried rather than
     * final.
     */
    @Test
    fun `no materials yet stores nothing, rather than a zero`() {
        assertEquals(
            JobMoney.DepositFollow.NOTHING_TO_SUGGEST,
            JobMoney.depositFollow(job(), 0.0, billable).first
        )
        assertNull(JobMoney.depositToSeed(job(), 0.0, billable))
        assertNull(JobMoney.depositToStore(job(deposit = 500.0, auto = true), 0.0, billable))
        // CONTROL: the same job WITH materials is seeded, so the three nulls
        // above are about the materials and not about the fixture.
        assertNotNull(JobMoney.depositToSeed(job(), materials, billable))
    }
}
