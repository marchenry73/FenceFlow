package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.Job
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pre-send checks have to know what has already been collected.
 *
 * They did not. The deposit check compared the deposit against materials and
 * nothing else, so it went on saying the deposit would not cover materials long
 * after the customer had paid -- sometimes after they had paid in full. A
 * warning that is wrong on a job you have already been paid for is worse than
 * no warning at all: it teaches people to scroll past the whole section,
 * including the times it is right.
 */
class EstimateWarningsTest {

    private fun totals(materials: Double, grand: Double) = EstimateEngine.Totals(
        materialsSubtotal = materials,
        taxableSubtotal = materials,
        tax = 0.0,
        laborCost = 0.0,
        teardownCost = 0.0,
        markupAmount = 0.0,
        discountAmount = 0.0,
        grandTotal = grand
    )

    private fun warnings(job: Job, materials: Double, grand: Double): List<String> =
        EstimateEngine.estimateWarnings(job, emptyList(), emptyList(), totals(materials, grand))

    @Test
    fun `an unpaid job with a thin deposit is flagged`() {
        val job = Job(customerName = "Test", depositAmount = 100.0)
        val found = warnings(job, materials = 1000.0, grand = 2000.0)
        assertTrue(
            "an unpaid job that would front the customer's material must say so",
            found.any { it.contains("material", ignoreCase = true) }
        )
    }

    @Test
    fun `a job paid in full is not told the deposit is short`() {
        // The bug, exactly.
        val job = Job(customerName = "Test", depositAmount = 100.0, amountPaid = 2000.0)
        val found = warnings(job, materials = 1000.0, grand = 2000.0)
        assertFalse(
            "a job that is paid in full must not warn about covering materials",
            found.any { it.contains("doesn't cover", ignoreCase = true) }
        )
        assertFalse(found.any { it.contains("fronting", ignoreCase = true) })
    }

    @Test
    fun `a part-paid job is told what is actually being fronted`() {
        val job = Job(customerName = "Test", depositAmount = 100.0, amountPaid = 400.0)
        val found = warnings(job, materials = 1000.0, grand = 2000.0)
        // Not "your deposit is short" -- the deposit stopped being the relevant
        // figure the moment money arrived. What matters is the gap.
        assertTrue(found.any { it.contains("600", ignoreCase = true) })
    }

    @Test
    fun `a part-paid job is told what is left to collect`() {
        val job = Job(customerName = "Test", amountPaid = 1500.0)
        val found = warnings(job, materials = 500.0, grand = 2000.0)
        assertTrue(found.any { it.contains("Still to collect", ignoreCase = true) })
        assertTrue(found.any { it.contains("500") })
    }

    @Test
    fun `a refund puts the job back to needing money`() {
        val job = Job(customerName = "Test", amountPaid = 2000.0, refundedAmount = 2000.0)
        val found = warnings(job, materials = 1000.0, grand = 2000.0)
        assertTrue(
            "money given back is money not collected",
            found.any { it.contains("doesn't cover", ignoreCase = true) }
        )
    }

    @Test
    fun `provisional pricing is called out`() {
        val job = Job(customerName = "Test", amountPaid = 5000.0)
        val found = warnings(job, materials = 1000.0, grand = 2000.0)
        assertTrue(found.any { it.contains("catalog", ignoreCase = true) })
    }

    @Test
    fun `confirmed pricing is not called out`() {
        val job = Job(
            customerName = "Test",
            amountPaid = 5000.0,
            materialPricesConfirmedAt = 1L
        )
        val found = warnings(job, materials = 1000.0, grand = 2000.0)
        assertFalse(found.any { it.contains("catalog", ignoreCase = true) })
    }

    @Test
    fun `a stale signature is the loudest thing on the list`() {
        val job = Job(
            customerName = "Test",
            amountPaid = 2000.0,
            materialPricesConfirmedAt = 1L,
            signedAt = 1L,
            signedContractTotal = 1000.0,
            signedLinearFeet = 100f
        )
        val found = warnings(job, materials = 500.0, grand = 2000.0)
        assertTrue(found.any { it.contains("signed", ignoreCase = true) })
    }
}
