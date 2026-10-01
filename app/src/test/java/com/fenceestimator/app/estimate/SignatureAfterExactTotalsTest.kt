package com.fenceestimator.app.estimate

import com.fenceestimator.app.R
import com.fenceestimator.app.data.Job
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The day totals went exact (engine 2026.10.1) must not be the day every signed
 * job was told its signature was stale.
 *
 * [JobMoney.signatureIsStale] compares the LIVE total with the figure the
 * customer signed, with a one-dollar tolerance. While every total was rounded
 * up to the next ten that tolerance never decided anything: both sides sat on
 * the ten-dollar grid, so they were equal or at least $10 apart. With exact
 * totals a job signed at $3,620 whose estimate is unchanged recomputes to
 * $3,614.50, which is $5.50 away -- and on a signed job that is a hard block:
 * the estimate screen refuses to send the estimate or the invoice until the
 * customer signs again.
 *
 * [JobMoney.priceMovedSinceSigning] compares a signed figure that is on the
 * ten-dollar grid the way the engine that produced it would have. These tests
 * pin both halves: the false alarm is gone, and every change the old engine
 * would have caught is still caught.
 */
class SignatureAfterExactTotalsTest {

    private fun signed(total: Double, feet: Float = 100f) = Job(
        customerName = "Test",
        signedAt = 1_000L,
        signedContractTotal = total,
        signedLinearFeet = feet,
    )

    private fun stale(job: Job, live: Double, feet: Float = 100f) = JobMoney.signatureIsStale(job, live, feet)

    @Test
    fun `a job signed at a ten-dollar figure is not stale when nothing changed and the live total is now exact`() {
        val legacy = signed(3620.0)
        // The job did not change: 3614.50 is what the exact engine says, and
        // the old engine rounded it up to the 3620 that was signed.
        assertFalse(stale(legacy, 3614.50))
        assertFalse(stale(legacy, 3620.0))
        assertFalse(stale(legacy, 3619.40))
        assertFalse(stale(legacy, 3610.01))
        // PLANTED: the plain one-dollar comparison, which is what this replaces,
        // calls every one of those a changed price.
        assertTrue(kotlin.math.abs(3614.50 - 3620.0) > 1.0)
        assertTrue(kotlin.math.abs(3610.01 - 3620.0) > 1.0)
    }

    @Test
    fun `everything the old engine would have caught is still caught`() {
        val legacy = signed(3620.0)
        // Up past the dollar of tolerance: the old engine rounded 3621.50 to 3630.
        // (A cent or two over is inside that dollar, as it always was.)
        assertFalse(stale(legacy, 3620.01))
        assertTrue(stale(legacy, 3621.50))
        assertTrue(stale(legacy, 3625.0))
        // Down by a whole step: the old engine rounded 3610.00 to 3610.
        assertTrue(stale(legacy, 3610.0))
        assertTrue(stale(legacy, 3600.0))
        assertTrue(stale(legacy, 4200.0))
    }

    @Test
    fun `a signature taken at an exact figure is compared exactly`() {
        val exact = signed(3614.50)
        assertFalse(stale(exact, 3614.50))
        // Within the dollar of tolerance, as it always was.
        assertFalse(stale(exact, 3615.20))
        assertFalse(stale(exact, 3613.60))
        // A real change.
        assertTrue(stale(exact, 3609.0))
        assertTrue(stale(exact, 3620.0))
        assertTrue(stale(exact, 3650.0))
    }

    @Test
    fun `the fence moving still makes a signature stale whatever the price does`() {
        val legacy = signed(3620.0, feet = 100f)
        assertTrue(stale(legacy, 3614.50, feet = 108f))
        assertFalse(stale(legacy, 3614.50, feet = 101f))
    }

    @Test
    fun `an unsigned job, and one signed before terms were tracked, are never stale`() {
        assertFalse(JobMoney.signatureIsStale(Job(customerName = "Test"), 5000.0, 100f))
        assertFalse(
            JobMoney.signatureIsStale(
                Job(customerName = "Test", signedAt = 1L, signedContractTotal = 0.0, signedLinearFeet = 0f),
                5000.0, 100f
            )
        )
    }

    @Test
    fun `the reason parts agree with the check, so a banner is never shown for a price it cannot explain`() {
        val legacy = signed(3620.0)
        // Not stale: no reason to give.
        assertTrue(JobMoney.staleSignatureReasonParts(legacy, 3614.50, 100f).isEmpty())
        // Stale on price: the price clause, carrying both figures.
        val parts = JobMoney.staleSignatureReasonParts(legacy, 3600.0, 100f)
        assertEquals(1, parts.size)
        assertEquals(R.string.eng2_reason_price_moved, parts[0].first)
        assertEquals(listOf("3620.00", "3600.00"), parts[0].second)
        // Stale on both.
        assertEquals(2, JobMoney.staleSignatureReasonParts(legacy, 3600.0, 120f).size)
    }

    @Test
    fun `priceMovedSinceSigning on its own`() {
        assertFalse(JobMoney.priceMovedSinceSigning(3620.0, 3614.50))
        assertTrue(JobMoney.priceMovedSinceSigning(3620.0, 3621.50))
        assertFalse(JobMoney.priceMovedSinceSigning(3614.50, 3614.50))
        assertTrue(JobMoney.priceMovedSinceSigning(3614.50, 3609.0))
        // Zero or negative is not on the grid: nothing to be equivalent to.
        assertTrue(JobMoney.priceMovedSinceSigning(0.0, 100.0))
    }
}
