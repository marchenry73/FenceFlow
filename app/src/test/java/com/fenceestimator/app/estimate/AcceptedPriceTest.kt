package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.ChangeOrder
import com.fenceestimator.app.data.Job
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The price the customer accepted, and everything that bills against it
 * ([JobMoney.anchoredTotal], [JobMoney.billableTotal], [JobMoney.documentTotal],
 * [JobMoney.suggestedMaterialsDeposit]).
 *
 * The bug: after acceptance the phone kept billing -- and pushing as
 * contract_total -- its LIVE recompute, which moved whenever a catalog price
 * changed, a takeoff was regenerated or a sync reverted a quantity. Job 4598
 * was signed at $9,710 and asked against $13,410; Woody was signed at $3,620
 * and showed $200. Each test below that proves the fix also computes what the
 * live figure would have produced and asserts the two differ.
 */
class AcceptedPriceTest {

    private val signedAtMillis = 1_758_000_000_000L

    private fun signedJob(
        accepted: Double? = 9710.0,
        deposit: Double = 0.0,
        paid: Double = 0.0,
        reapproval: Long? = null
    ) = Job(
        id = 4598,
        customerName = "Test",
        signedAt = signedAtMillis,
        signedContractTotal = 9710.0,
        acceptedTotal = accepted,
        depositAmount = deposit,
        amountPaid = paid,
        reapprovalRequiredAt = reapproval
    )

    private fun order(cost: Double, signedAt: Long?) =
        ChangeOrder(jobId = 4598, additionalCost = cost, signedAt = signedAt, signatureImagePath = signedAt?.let { "/sig.png" })

    private val liveRecompute = 13410.0

    // ---- what stands once the customer has accepted ----

    @Test
    fun `an accepted job bills the accepted price, not the moving estimate`() {
        val j = signedJob()
        assertEquals(9710.0, JobMoney.billableTotal(j, liveRecompute, emptyList()), 0.001)
        // Planted: the old callers passed the live figure straight through.
        assertNotEquals(liveRecompute, JobMoney.billableTotal(j, liveRecompute, emptyList()), 0.001)
    }

    @Test
    fun `the next payment request follows the accepted price`() {
        val j = signedJob(paid = 2000.0)
        val billable = JobMoney.billableTotal(j, liveRecompute, emptyList())
        assertEquals(7710.0, JobMoney.nextRequestAmount(j, billable), 0.001)
        // Planted: against the live recompute it asked for $3,700 more than agreed.
        assertEquals(11410.0, JobMoney.nextRequestAmount(j, liveRecompute), 0.001)
    }

    @Test
    fun `extra work signed after acceptance is added on top`() {
        val later = order(cost = 900.0, signedAt = signedAtMillis + 86_400_000L)
        assertEquals(10610.0, JobMoney.billableTotal(signedJob(), liveRecompute, listOf(later)), 0.001)
    }

    @Test
    fun `extra work already inside the accepted figure is not billed twice`() {
        // Signed before (or at) acceptance: the engine counted it in the
        // grand total the customer accepted.
        val earlier = order(cost = 900.0, signedAt = signedAtMillis - 86_400_000L)
        assertEquals(9710.0, JobMoney.billableTotal(signedJob(), liveRecompute, listOf(earlier)), 0.001)
    }

    @Test
    fun `an order unsigned at acceptance and signed later is not billed twice`() {
        // Added while the quote was out and left unsigned; the engine counted
        // it into the $9,710 the customer signed (grandTotal counts every
        // order), and the signature marked it (inAcceptedTotal). Signed the
        // next day, it is still inside that figure.
        val next = signedAtMillis + 86_400_000L
        val covered = order(cost = 900.0, signedAt = next).copy(inAcceptedTotal = true)
        assertEquals(9710.0, JobMoney.billableTotal(signedJob(), liveRecompute, listOf(covered)), 0.001)
        assertEquals(0.0, JobMoney.extraWorkSinceAcceptance(signedJob(), listOf(covered)), 0.001)
        // Planted: judged on the signature's time alone -- the rule before the
        // flag -- the same order is billed on top of a figure that holds it.
        val judgedByTimeOnly = covered.copy(inAcceptedTotal = false)
        assertEquals(10610.0, JobMoney.billableTotal(signedJob(), liveRecompute, listOf(judgedByTimeOnly)), 0.001)
    }

    @Test
    fun `what the estimate says is still owed follows the accepted price`() {
        // The "still to collect" line on the Estimate screen (estimateWarnings)
        // used the live grand total, so it disagreed with the job screen, the
        // quote page and the payment link on every accepted job whose
        // estimate had moved.
        val j = signedJob(paid = 2000.0)
        val totals = EstimateEngine.Totals(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, liveRecompute)
        val stillToCollect = EstimateEngine.estimateWarnings(j, emptyList(), emptyList(), totals, emptyList())
            .single { it.textRes == com.fenceestimator.app.R.string.warn_still_to_collect }
        assertEquals(listOf("7710.00", "9710.00"), stillToCollect.args)
        // Planted: without the change orders -- the old call -- an unanchored
        // job reads the live figure, which for an anchored one would have been
        // $11,410 still to collect.
        val live = EstimateEngine.estimateWarnings(j.copy(acceptedTotal = null), emptyList(), emptyList(), totals)
            .single { it.textRes == com.fenceestimator.app.R.string.warn_still_to_collect }
        assertEquals(listOf("11410.00", "13410.00"), live.args)
    }

    @Test
    fun `an unsigned change order does not move the price until it is signed`() {
        val unsigned = order(cost = 900.0, signedAt = null)
        assertEquals(0.0, JobMoney.extraWorkSinceAcceptance(signedJob(), listOf(unsigned)), 0.001)
        assertEquals(9710.0, JobMoney.billableTotal(signedJob(), liveRecompute, listOf(unsigned)), 0.001)
    }

    @Test
    fun `a later online approval is the acceptance extra work is counted from`() {
        // Re-approved after a drawing change: the server re-stamps the
        // accepted price then, so only work signed after THAT is extra.
        val approvedLater = signedJob().copy(quoteApprovedAt = signedAtMillis + 10 * 86_400_000L)
        val between = order(cost = 900.0, signedAt = signedAtMillis + 86_400_000L)
        assertEquals(0.0, JobMoney.extraWorkSinceAcceptance(approvedLater, listOf(between)), 0.001)
    }

    // ---- when nothing anchors the price ----

    @Test
    fun `not accepted yet, the live estimate stands`() {
        val quote = Job(customerName = "Test", acceptedTotal = null)
        assertNull(JobMoney.anchoredTotal(quote, emptyList()))
        assertEquals(liveRecompute, JobMoney.billableTotal(quote, liveRecompute, emptyList()), 0.001)
    }

    @Test
    fun `accepted before the column existed, nothing changes`() {
        // No backfill: rewriting a customer-facing figure is the owner's call.
        assertNull(JobMoney.anchoredTotal(signedJob(accepted = null), emptyList()))
        assertNull(JobMoney.anchoredTotal(signedJob(accepted = 0.0), emptyList()))
    }

    @Test
    fun `a withdrawn approval frees the price to be approved again`() {
        // reapproval_required_at set: the new figure has to reach the quote page.
        val withdrawn = signedJob(reapproval = signedAtMillis + 5_000)
        assertNull(JobMoney.anchoredTotal(withdrawn, emptyList()))
        assertEquals(liveRecompute, JobMoney.billableTotal(withdrawn, liveRecompute, emptyList()), 0.001)
    }

    // ---- the PDF, whose callers may not pass change orders yet ----

    @Test
    fun `a document with no change orders on the job prints the accepted price`() {
        assertEquals(9710.0, JobMoney.documentTotal(signedJob(), liveRecompute, 0.0, null), 0.001)
    }

    @Test
    fun `a document handed the change orders matches the job screen exactly`() {
        val later = order(cost = 900.0, signedAt = signedAtMillis + 86_400_000L)
        assertEquals(
            JobMoney.billableTotal(signedJob(), liveRecompute, listOf(later)),
            JobMoney.documentTotal(signedJob(), liveRecompute, 900.0, listOf(later)),
            0.001
        )
    }

    @Test
    fun `without the list and with change orders on the job, the live figure is kept rather than a guess`() {
        // Guessing "no extra work" would under-bill work signed since.
        assertEquals(liveRecompute, JobMoney.documentTotal(signedJob(), liveRecompute, 900.0, null), 0.001)
    }

    // ---- the deposit suggestion ----

    @Test
    fun `the materials suggestion never asks for more than is owed on the agreed price`() {
        // Woody: $3,620 accepted, $3,963 of lines hiding in the materials.
        val woody = signedJob(accepted = 3620.0)
        val billable = JobMoney.billableTotal(woody, 200.0, emptyList())
        assertEquals(3620.0, JobMoney.suggestedMaterialsDeposit(woody, 3963.44, billable), 0.001)
        // Planted: the old suggestion was the raw materials, rounded up.
        assertEquals(3970.0, kotlin.math.ceil(3963.44 / 10.0) * 10.0, 0.001)
    }

    @Test
    fun `the materials suggestion is net of money already in and rounded up`() {
        val part = signedJob(paid = 1000.0)
        assertEquals(1450.0, JobMoney.suggestedMaterialsDeposit(part, 2449.10, 9710.0), 0.001)
    }

    @Test
    fun `nothing is suggested once payments cover the materials`() {
        assertEquals(0.0, JobMoney.suggestedMaterialsDeposit(signedJob(paid = 3000.0), 2450.0, 9710.0), 0.001)
        assertEquals(0.0, JobMoney.suggestedMaterialsDeposit(signedJob(), 0.0, 9710.0), 0.001)
    }
}
