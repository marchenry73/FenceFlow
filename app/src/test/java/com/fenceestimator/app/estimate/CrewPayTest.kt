package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.Employee
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.PayType
import com.fenceestimator.app.data.TimeEntry
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FencePoint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What a crew member sees for their own pay has to be true on every path:
 * unapproved hours never become dollars, a rate that was never set never
 * reads as "you earned nothing," and per-foot pay follows the fence that was
 * actually built, not the number a customer was quoted.
 */
class CrewPayTest {

    private val pxPerFoot = 10f

    private fun entry(
        hours: Double,
        hourlyRate: Double = 0.0,
        approved: Boolean = true,
        awaiting: Boolean = false
    ): TimeEntry {
        val started = 0L
        val ended = (hours * 3_600_000.0).toLong()
        return TimeEntry(
            jobId = 1,
            startedAt = started,
            endedAt = ended,
            hourlyRate = hourlyRate,
            approvedAt = if (approved) ended + 1 else null,
            rejectedAt = null
        ).let {
            // isAwaitingApproval requires endedAt set and neither approved nor rejected.
            if (awaiting) it.copy(approvedAt = null) else it
        }
    }

    /** A run with a real drawing: a straight 100-pixel line, i.e. 10 ft at 10 px/ft. */
    private fun drawnRun(): FenceRun = FenceRun(
        jobId = 1,
        pointsEncoded = FenceCodec.encodePoints(listOf(FencePoint(0f, 0f), FencePoint(100f, 0f)))
    )

    /** A run quoted by typing its length, with no drawing at all. */
    private fun manualRun(feet: Float): FenceRun = FenceRun(jobId = 1, manualLinearFeet = feet)

    // --- Unapproved hours never become money ---

    @Test
    fun `unapproved hours contribute nothing to the amount`() {
        val employee = Employee(payType = PayType.HOURLY, hourlyRate = 25.0)
        val entries = listOf(entry(hours = 5.0, hourlyRate = 25.0, awaiting = true))

        val pay = CrewPay.forJob(employee, entries, emptyList(), pxPerFoot)

        assertEquals(0.0, pay.amount, 0.0001)
        assertEquals(5.0, pay.hoursAwaitingApproval, 0.0001)
    }

    @Test
    fun `PLANTED FAILURE -- unapproved hours would show as pay if payableHours were not gated`() {
        // Proves the test above actually exercises the gate: summing raw
        // hours instead of payableHours must fail this assertion.
        val entries = listOf(entry(hours = 5.0, hourlyRate = 25.0, awaiting = true))
        val rawHoursAmount = entries.sumOf { it.hours * it.hourlyRate }
        assertTrue("raw (ungated) hours would have paid out $rawHoursAmount", rawHoursAmount > 0.0)
        // The real Earnings.amount must NOT match that ungated figure.
        val employee = Employee(payType = PayType.HOURLY, hourlyRate = 25.0)
        val pay = CrewPay.forJob(employee, entries, emptyList(), pxPerFoot)
        assertFalse(pay.amount == rawHoursAmount)
    }

    @Test
    fun `approved hours do pay out at the rate stamped on the entry`() {
        val employee = Employee(payType = PayType.HOURLY, hourlyRate = 30.0)
        val entries = listOf(entry(hours = 8.0, hourlyRate = 25.0, approved = true))

        val pay = CrewPay.forJob(employee, entries, emptyList(), pxPerFoot)

        // Uses the rate on the entry (25), not today's employee rate (30) --
        // a raise must not rewrite what a past shift already cost.
        assertEquals(200.0, pay.amount, 0.0001)
        assertFalse(pay.rateIsUnset)
    }

    // --- A zero rate must never read as "you earned nothing" ---

    @Test
    fun `hourly work at an unset rate is flagged, not silently zero`() {
        val employee = Employee(payType = PayType.HOURLY, hourlyRate = 0.0)
        val entries = listOf(entry(hours = 6.0, hourlyRate = 0.0, approved = true))

        val pay = CrewPay.forJob(employee, entries, emptyList(), pxPerFoot)

        assertEquals(0.0, pay.amount, 0.0001)
        assertTrue(pay.rateIsUnset)
    }

    @Test
    fun `no approved work and no rate is not flagged -- there is nothing to be honest about yet`() {
        val employee = Employee(payType = PayType.HOURLY, hourlyRate = 0.0)

        val pay = CrewPay.forJob(employee, emptyList(), emptyList(), pxPerFoot)

        assertFalse(pay.rateIsUnset)
    }

    @Test
    fun `PLANTED FAILURE -- a genuine zero-hours case must not be flagged as unset`() {
        // If rateIsUnset ignored the "was there work" condition, this would
        // wrongly flag an employee who simply hasn't worked yet.
        val employee = Employee(payType = PayType.HOURLY, hourlyRate = 0.0)
        val pay = CrewPay.forJob(employee, emptyList(), emptyList(), pxPerFoot)
        assertTrue("expected rateIsUnset to be false with no work performed", !pay.rateIsUnset)
    }

    @Test
    fun `per-foot work at an unset rate is flagged`() {
        val employee = Employee(payType = PayType.PER_FOOT, perFootRate = 0.0)
        val runs = listOf(drawnRun())

        val pay = CrewPay.forJob(employee, emptyList(), runs, pxPerFoot)

        assertEquals(0.0, pay.amount, 0.0001)
        assertTrue(pay.rateIsUnset)
    }

    // --- Per-foot pay follows footage actually built, not the quote ---

    @Test
    fun `per-foot pay uses the manual length when a run has no drawing`() {
        val employee = Employee(payType = PayType.PER_FOOT, perFootRate = 5.0)
        val runs = listOf(manualRun(feet = 120f))

        val pay = CrewPay.forJob(employee, emptyList(), runs, pxPerFoot)

        assertEquals(120.0, pay.feet, 0.0001)
        assertEquals(600.0, pay.amount, 0.0001)
    }

    @Test
    fun `PLANTED FAILURE -- ignoring manualLinearFeet would pay nothing for an undrawn run`() {
        // Reproduces the pre-fix behaviour directly to prove the fix matters:
        // reading only the drawn points on a manual-length run yields 0 ft.
        val run = manualRun(feet = 120f)
        val pointsOnlyFeet = FenceCodec.decodePoints(run.pointsEncoded).size
        assertEquals(0, pointsOnlyFeet)

        val employee = Employee(payType = PayType.PER_FOOT, perFootRate = 5.0)
        val pay = CrewPay.forJob(employee, emptyList(), listOf(run), pxPerFoot)
        // The real result must NOT be the broken (points-only) answer of $0.
        assertTrue("expected built footage to be paid, not the undrawn-run zero", pay.amount > 0.0)
    }

    @Test
    fun `per-foot pay uses drawn geometry when a real survey exists`() {
        val employee = Employee(payType = PayType.PER_FOOT, perFootRate = 2.0)
        val runs = listOf(drawnRun())

        val pay = CrewPay.forJob(employee, emptyList(), runs, pxPerFoot)

        assertEquals(10.0, pay.feet, 0.01)
        assertEquals(20.0, pay.amount, 0.01)
    }
}
