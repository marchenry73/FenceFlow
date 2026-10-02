package com.fenceestimator.app.estimate

import com.fenceestimator.app.R
import com.fenceestimator.app.data.Job
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class JobMoneyTest {

    private fun job(
        deposit: Double = 0.0,
        paid: Double = 0.0,
        refunded: Double = 0.0,
        signedAt: Long? = null,
        signedTotal: Double = 0.0,
        signedFeet: Float = 0f
    ) = Job(
        customerName = "Test",
        depositAmount = deposit,
        amountPaid = paid,
        refundedAmount = refunded,
        signedAt = signedAt,
        signedContractTotal = signedTotal,
        signedLinearFeet = signedFeet
    )

    // ---- what is still owed ----

    @Test
    fun `owing is the contract minus what was actually kept`() {
        assertEquals(600.0, JobMoney.stillOwed(job(paid = 400.0), 1000.0), 0.001)
    }

    @Test
    fun `a refund puts the money back on the customer's tab`() {
        // Paid 1000, refunded 400: they have really paid 600, so 400 is owed.
        assertEquals(400.0, JobMoney.stillOwed(job(paid = 1000.0, refunded = 400.0), 1000.0), 0.001)
    }

    @Test
    fun `owing never goes negative`() {
        assertEquals(0.0, JobMoney.stillOwed(job(paid = 5000.0), 1000.0), 0.001)
    }

    // ---- the bug from the screenshot ----

    @Test
    fun `a paid job never asks for the deposit again`() {
        // $5,730 deposit on a $10,595 job, fully paid. The button used to fall
        // back to the deposit and offer to bill it a second time.
        val j = job(deposit = 5730.0, paid = 10595.38)
        assertEquals(0.0, JobMoney.nextRequestAmount(j, 10595.38), 0.001)
    }

    @Test
    fun `a part-paid job asks for what is left, not the deposit`() {
        // The deposit here is paid IN FULL ($5,730 asked, $5,730 in), so the
        // next thing to ask for is the balance -- which is what this has
        // always asserted and still does. Since 2 Oct 2026 the rule is "the
        // rest of the deposit first, then the balance"
        // (JobMoney.nextRequestAmount), so a job part way through its DEPOSIT
        // asks for the rest of the deposit instead; that case is pinned in
        // AcceptedPriceTest and in tests/a66-deposit-one-meaning.test.mjs.
        val j = job(deposit = 5730.0, paid = 5730.0)
        assertEquals(4865.38, JobMoney.nextRequestAmount(j, 10595.38), 0.001)
        assertEquals("balance", JobMoney.nextRequestLabel(j, 10595.38))
    }

    @Test
    fun `a job part way through its deposit asks for the rest of the deposit`() {
        val j = job(deposit = 5730.0, paid = 1000.0)
        assertEquals(4730.0, JobMoney.nextRequestAmount(j, 10595.38), 0.001)
        assertEquals("deposit", JobMoney.nextRequestLabel(j, 10595.38))
        // Planted: the old rule asked for the whole remaining balance, which
        // bills the labour on a fence that has not been built.
        assertEquals(9595.38, JobMoney.stillOwed(j, 10595.38), 0.001)
    }

    @Test
    fun `the deposit asked for is never more than the price, and the cap is one decision`() {
        // The $3,963-on-a-$3,620 shape. The PDF and the estimate card used to
        // print the raw figure while the quote page, the email, the pay link
        // and the office all capped it.
        val over = job(deposit = 3963.0)
        assertEquals(3620.0, JobMoney.depositAsked(over, 3620.0), 0.001)
        assertEquals(3620.0, JobMoney.depositStillDue(over, 3620.0), 0.001)
        // A job with no price has not been priced, so there is nothing to cap
        // against and the typed figure stands.
        assertEquals(3963.0, JobMoney.depositAsked(over, 0.0), 0.001)
        // Cents, not float dust: 2,119.99 less 500.01.
        val part = job(deposit = 2119.99, paid = 500.01)
        assertEquals(1619.98, JobMoney.depositStillDue(part, 2119.99), 0.0)
    }

    @Test
    fun `deposit received means the whole deposit, or none asked for`() {
        assertTrue(JobMoney.depositSettled(job(), 4654.47))
        assertFalse(JobMoney.depositSettled(job(deposit = 3000.0, paid = 500.0), 4654.47))
        assertFalse(JobMoney.depositSettled(job(deposit = 3000.0, paid = 2999.99), 4654.47))
        assertTrue(JobMoney.depositSettled(job(deposit = 3000.0, paid = 3000.0), 4654.47))
        // A deposit stored above the price cannot hold a fully paid job back.
        assertTrue(JobMoney.depositSettled(job(deposit = 3963.0, paid = 3620.0), 3620.0))
        // Money that went back out is not money received.
        assertFalse(JobMoney.depositSettled(job(deposit = 1000.0, paid = 1000.0, refunded = 1000.0), 5000.0))
    }

    @Test
    fun `an untouched job asks for the deposit`() {
        val j = job(deposit = 5730.0)
        assertEquals(5730.0, JobMoney.nextRequestAmount(j, 10595.38), 0.001)
        assertEquals("deposit", JobMoney.nextRequestLabel(j, 10595.38))
    }

    @Test
    fun `a deposit larger than the job bills only the job`() {
        val j = job(deposit = 9000.0)
        assertEquals(1000.0, JobMoney.nextRequestAmount(j, 1000.0), 0.001)
    }

    @Test
    fun `after a refund the job can be billed again`() {
        val j = job(deposit = 500.0, paid = 1000.0, refunded = 1000.0)
        assertEquals(1000.0, JobMoney.stillOwed(j, 1000.0), 0.001)
    }

    // ---- refunds ----

    @Test
    fun `only the overpayment is offered back`() {
        assertEquals(500.0, JobMoney.refundable(job(paid = 1500.0), 1000.0), 0.001)
        assertEquals(0.0, JobMoney.refundable(job(paid = 800.0), 1000.0), 0.001)
    }

    @Test
    fun `overpayment is called out`() {
        assertTrue(JobMoney.overpaid(job(paid = 1500.0), 1000.0))
        assertFalse(JobMoney.overpaid(job(paid = 1000.0), 1000.0))
        assertFalse(JobMoney.overpaid(job(paid = 1500.0, refunded = 500.0), 1000.0))
    }

    // ---- signature staleness ----

    @Test
    fun `redrawing the fence invalidates the signature`() {
        val j = job(signedAt = 1L, signedTotal = 10000.0, signedFeet = 200f)
        assertTrue(JobMoney.signatureIsStale(j, contractTotal = 14000.0, linearFeet = 200f))
        assertTrue(JobMoney.signatureIsStale(j, contractTotal = 10000.0, linearFeet = 300f))
    }

    @Test
    fun `an unchanged job keeps its signature`() {
        val j = job(signedAt = 1L, signedTotal = 10000.0, signedFeet = 200f)
        assertFalse(JobMoney.signatureIsStale(j, contractTotal = 10000.0, linearFeet = 200f))
    }

    @Test
    fun `rounding is not a renegotiation`() {
        val j = job(signedAt = 1L, signedTotal = 10000.0, signedFeet = 200f)
        assertFalse(JobMoney.signatureIsStale(j, contractTotal = 10000.60, linearFeet = 201f))
    }

    @Test
    fun `an unsigned job is never nagged`() {
        assertFalse(JobMoney.signatureIsStale(job(), 10000.0, 200f))
    }

    @Test
    fun `jobs signed before we tracked terms are left alone`() {
        // signedAt set but no recorded terms: flagging these would fire on every
        // historical job at once and teach people to ignore the warning.
        val legacy = job(signedAt = 1L)
        assertFalse(JobMoney.signatureIsStale(legacy, 10000.0, 200f))
    }

    @Test
    fun `the reason names what actually moved`() {
        val j = job(signedAt = 1L, signedTotal = 10000.0, signedFeet = 200f)
        val parts = JobMoney.staleSignatureReasonParts(j, 14000.0, 200f)
        assertEquals(1, parts.size)
        assertEquals(R.string.eng2_reason_price_moved, parts[0].first)
        assertEquals(listOf("10000.00", "14000.00"), parts[0].second)
        assertFalse(
            "footage did not move, so it should not be mentioned",
            parts.any { it.first == R.string.eng2_reason_fence_moved }
        )
    }

    @Test
    fun `a redrawn fence is named in the reason`() {
        val j = job(signedAt = 1L, signedTotal = 10000.0, signedFeet = 200f)
        val parts = JobMoney.staleSignatureReasonParts(j, 10000.0, 300f)
        assertEquals(1, parts.size)
        assertEquals(R.string.eng2_reason_fence_moved, parts[0].first)
        assertEquals(listOf("200", "300"), parts[0].second)
    }

    // ---- processor lock ----

    @Test
    fun `a hand-typed figure stays editable`() {
        assertFalse(JobMoney.paidFigureIsReadOnly(job(paid = 500.0)))
    }

    @Test
    fun `a processor figure is locked`() {
        val j = job(paid = 500.0).copy(paymentsFromProcessor = true)
        assertTrue(JobMoney.paidFigureIsReadOnly(j))
    }

    // ---- one acceptance, checked everywhere the same way ----
    //
    // A customer can agree to a quote by drawing a signature in the app OR by
    // typing their name on the emailed/texted quote page. Those write to two
    // different columns (signedAt vs quoteApprovedAt) for the SAME agreement.
    // Every screen that gates on "has this been accepted" must go through
    // isAccepted() so signing online counts -- the bug this guards against is
    // the app asking someone to sign twice for the same document because one
    // screen only checked signedAt.

    @Test
    fun `an in-app drawn signature counts as accepted`() {
        val j = job(signedAt = 1L)
        assertTrue(JobMoney.isAccepted(j))
    }

    @Test
    fun `an online quote-page approval counts as accepted, with no drawn signature at all`() {
        val j = job().copy(quoteApprovedAt = 2L, quoteApprovedName = "Pat Customer")
        assertTrue(
            "approving on the website is a real acceptance, not a lesser one -- " +
                "the app must not demand a second signature for the same agreement",
            JobMoney.isAccepted(j)
        )
    }

    @Test
    fun `neither signature nor online approval is not accepted`() {
        // Planted-failure case: if isAccepted ever degrades to "always true"
        // or ignores both fields, this is the case that must go red.
        val j = job()
        assertFalse(JobMoney.isAccepted(j))
    }
}
