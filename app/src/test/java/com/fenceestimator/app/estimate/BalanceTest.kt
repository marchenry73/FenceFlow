package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.Job
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Two different questions that used to share one answer.
 *
 * "What do I ask them for" can never be negative -- a payment request for minus
 * four hundred dollars is meaningless. "Where does this job stand" absolutely
 * can be, and flooring it hid the fact that money was owed the other way: an
 * overpaid customer read as "Still owed $0.00", which tells a contractor
 * nothing about the four hundred dollars they are holding.
 */
class BalanceTest {

    private fun job(paid: Double, refunded: Double = 0.0) =
        Job(customerName = "Test", amountPaid = paid, refundedAmount = refunded)

    @Test
    fun `an ordinary part-paid job owes the difference`() {
        assertEquals(600.0, JobMoney.balance(job(paid = 400.0), 1000.0), 0.001)
        assertEquals(600.0, JobMoney.stillOwed(job(paid = 400.0), 1000.0), 0.001)
    }

    @Test
    fun `overpaying goes negative, and that is the point`() {
        assertEquals(-400.0, JobMoney.balance(job(paid = 1400.0), 1000.0), 0.001)
    }

    @Test
    fun `what you ask for is still never negative`() {
        // The whole reason both exist. This one feeds payment requests.
        assertEquals(0.0, JobMoney.stillOwed(job(paid = 1400.0), 1000.0), 0.001)
        assertEquals(0.0, JobMoney.nextRequestAmount(job(paid = 1400.0), 1000.0), 0.001)
    }

    @Test
    fun `paid to the penny is zero, not a rounding artefact`() {
        assertEquals(0.0, JobMoney.balance(job(paid = 1000.0), 1000.0), 0.001)
    }

    @Test
    fun `a refund puts the balance back the other way`() {
        // Paid 1000 on a 1000 job, then refunded 400: they are owed nothing and
        // now owe 400 again.
        assertEquals(400.0, JobMoney.balance(job(paid = 1000.0, refunded = 400.0), 1000.0), 0.001)
    }

    @Test
    fun `refunding an overpayment settles it`() {
        // Overpaid by 400, refunded the 400: square.
        assertEquals(0.0, JobMoney.balance(job(paid = 1400.0, refunded = 400.0), 1000.0), 0.001)
    }

    @Test
    fun `the two agree wherever the balance is not negative`() {
        // stillOwed is balance with a floor, so they must not disagree anywhere
        // above zero -- a screen and a payment request quoting different figures
        // for the same job is the bug this pairing could reintroduce.
        for (paid in listOf(0.0, 1.0, 250.0, 999.99, 1000.0)) {
            val j = job(paid = paid)
            assertEquals(
                "disagreed at paid=$paid",
                JobMoney.stillOwed(j, 1000.0),
                JobMoney.balance(j, 1000.0).coerceAtLeast(0.0),
                0.001
            )
        }
    }
}
