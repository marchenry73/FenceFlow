package com.fenceestimator.app.estimate

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
        val j = job(deposit = 5730.0, paid = 5730.0)
        assertEquals(4865.38, JobMoney.nextRequestAmount(j, 10595.38), 0.001)
        assertEquals("balance", JobMoney.nextRequestLabel(j, 10595.38))
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
        val reason = JobMoney.staleSignatureReason(j, 14000.0, 200f)
        assertTrue(reason.contains("10000.00"))
        assertTrue(reason.contains("14000.00"))
        assertFalse("footage did not move, so it should not be mentioned", reason.contains("ft"))
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
}
