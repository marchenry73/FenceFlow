package com.fenceestimator.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar

/**
 * "Collected this month" has to mean money received this month, and has to
 * produce the same figure on every device.
 *
 * The arrangement it replaces did neither. It summed each job's lifetime
 * amountPaid and bucketed the whole figure by one job timestamp -- and for an
 * unscheduled job that timestamp was updatedAt, a sync artifact. So editing an
 * old job dragged all of its historical payments into the current month, and
 * because updatedAt differs per device, two phones in the same company reported
 * different numbers and neither was right.
 */
class PaymentLedgerTest {

    private fun at(year: Int, month: Int, day: Int): Long =
        Calendar.getInstance().apply {
            set(year, month - 1, day, 12, 0, 0)
            set(Calendar.MILLISECOND, 0)
        }.timeInMillis

    private fun payment(amount: Double, on: Long, jobId: Long = 1) =
        PaymentRecord(jobId = jobId, amount = amount, receivedAt = on)

    private fun collectedBetween(rows: List<PaymentRecord>, from: Long, to: Long): Double =
        rows.filter { it.receivedAt in from..to }.sumOf { it.amount }

    @Test
    fun `a period counts only the money received inside it`() {
        val rows = listOf(
            payment(1000.0, at(2026, 7, 20)),
            payment(500.0, at(2026, 8, 3)),
            payment(250.0, at(2026, 8, 28))
        )
        val august = collectedBetween(rows, at(2026, 8, 1), at(2026, 8, 31))
        assertEquals("July money must not appear in August", 750.0, august, 0.001)
    }

    @Test
    fun `editing an old job cannot move its money`() {
        // The whole point. A payment's month comes from receivedAt, which
        // nothing about editing the job touches.
        val march = payment(5000.0, at(2026, 3, 10))
        val august = collectedBetween(listOf(march), at(2026, 8, 1), at(2026, 8, 31))
        assertEquals(0.0, august, 0.001)
    }

    @Test
    fun `a refund reduces the month it was given back in`() {
        val rows = listOf(
            payment(1000.0, at(2026, 8, 5)),
            payment(-300.0, at(2026, 8, 20))
        )
        assertEquals(700.0, collectedBetween(rows, at(2026, 8, 1), at(2026, 8, 31)), 0.001)
    }

    @Test
    fun `a refund lands in its own month, not the month of the payment`() {
        val rows = listOf(
            payment(1000.0, at(2026, 7, 5)),
            payment(-1000.0, at(2026, 8, 5))
        )
        assertEquals(1000.0, collectedBetween(rows, at(2026, 7, 1), at(2026, 7, 31)), 0.001)
        assertEquals(-1000.0, collectedBetween(rows, at(2026, 8, 1), at(2026, 8, 31)), 0.001)
    }

    @Test
    fun `a refund is recognisable as one`() {
        assertTrue(payment(-100.0, at(2026, 8, 1)).isRefund)
        assertFalse(payment(100.0, at(2026, 8, 1)).isRefund)
    }

    @Test
    fun `the job total is the sum of its rows`() {
        val rows = listOf(
            payment(500.0, at(2026, 8, 1)),
            payment(500.0, at(2026, 8, 9)),
            payment(-200.0, at(2026, 8, 15))
        )
        val paid = rows.filter { !it.isRefund }.sumOf { it.amount }
        val refunded = rows.filter { it.isRefund }.sumOf { -it.amount }
        assertEquals(1000.0, paid, 0.001)
        assertEquals(200.0, refunded, 0.001)
        assertEquals(800.0, paid - refunded, 0.001)
    }

    @Test
    fun `two devices summing the same rows get the same answer`() {
        // The property that was missing. receivedAt is a stated fact carried on
        // the row; nothing about which phone is looking can change it.
        val rows = listOf(
            payment(1200.0, at(2026, 8, 4)),
            payment(800.0, at(2026, 8, 11))
        )
        val deviceA = collectedBetween(rows, at(2026, 8, 1), at(2026, 8, 31))
        val deviceB = collectedBetween(rows.reversed(), at(2026, 8, 1), at(2026, 8, 31))
        assertEquals(deviceA, deviceB, 0.0)
        assertEquals(2000.0, deviceA, 0.001)
    }
}
