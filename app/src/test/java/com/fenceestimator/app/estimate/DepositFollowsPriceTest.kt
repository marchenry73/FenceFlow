package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.Job
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE DEPOSIT FOLLOWS THE PRICE -- while it is still the app's own figure.
 *
 * He asked twice: "the deposit asked is not automatically updating, I want
 * this to work even when the price changes." It did not, because the only
 * thing that wrote it gave up the moment a deposit existed:
 *
 *     if (job.depositAmount > 0.005) return null
 *
 * That line was standing in for something real. An older auto-fill overwrote a
 * deposit a PERSON had typed -- $9,910 became $5,730 ten seconds after the
 * signature -- and a database trigger rescaled stored deposits on every
 * re-price behind his back. Both are still things that must not happen.
 *
 * So the rule is not "always follow" and not "never move". It is: follow while
 * the figure is the app's own, stop the moment a person chooses one, and stop
 * for good once the customer is in it. [JobMoney.depositToStore] is that rule
 * and this file is the proof, planted failures included -- a test that has
 * never been seen to fail has only been run.
 */
class DepositFollowsPriceTest {

    /** Materials to buy on the job; the deposit rule is driven by this. */
    private val materials = 1_230.0

    /** The whole job price, comfortably above any deposit asked here. */
    private val billable = 9_000.0

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

    /** What the rule says to ask for, given these materials. */
    private val ruleFigure = JobMoney.ruleDeposit(materials)

    @Test
    fun `the rule is round up to the next hundred, then a hundred more`() {
        // Stated here so the figures below are readable, and so a change to
        // the rule fails in one obvious place instead of eight obscure ones.
        assertEquals(1_400.0, JobMoney.ruleDeposit(1_230.0), 0.001)
        assertEquals(1_200.0, JobMoney.ruleDeposit(1_100.0), 0.001)
    }

    @Test
    fun `an automatic deposit moves to the new figure when the price changes`() {
        // The job was priced when the materials came to less; the deposit on
        // it is the app's old answer.
        val before = job(deposit = 900.0, auto = true)
        assertEquals(ruleFigure, JobMoney.depositToStore(before, materials, billable)!!, 0.001)
    }

    @Test
    fun `a deposit somebody typed is never moved`() {
        val typed = job(deposit = 900.0, auto = false)
        assertNull(
            "a figure a person chose was overwritten -- this is the $9,910 to $5,730 case",
            JobMoney.depositToStore(typed, materials, billable)
        )
    }

    @Test
    fun `PLANTED FAILURE the two cases really do differ`() {
        // Without this, "typed is not moved" would pass just as well if
        // depositToStore returned null for everything.
        assertTrue(
            "automatic and typed now behave the same, so the check above proves nothing",
            JobMoney.depositToStore(job(deposit = 900.0, auto = true), materials, billable) != null
        )
    }

    @Test
    fun `nothing moves once the customer has approved, signed or paid`() {
        for ((what, j) in listOf(
            "approved" to job(deposit = 900.0, auto = true, approvedAt = 1_700_000_000_000L),
            "signed" to job(deposit = 900.0, auto = true, signedAt = 1_700_000_000_000L),
            "paid" to job(deposit = 900.0, auto = true, paid = 50.0),
        )) {
            assertNull(
                "an automatic deposit moved after the customer $what -- that is a different deal from the one they agreed to",
                JobMoney.depositToStore(j, materials, billable)
            )
        }
    }

    @Test
    fun `PLANTED FAILURE the freeze is doing the work, not the flag`() {
        // Same job, same flag, customer NOT in it: it must move. Otherwise the
        // three assertions above would pass on a job that could never move
        // anyway.
        assertTrue(JobMoney.depositToStore(job(deposit = 900.0, auto = true), materials, billable) != null)
    }

    @Test
    fun `an unchanged figure is not rewritten`() {
        // Called on every price change, which means on every recomposition
        // where the total moved. Returning the same number would be a write
        // each time, and a write bumps updated_at -- which is how an offline
        // edit on another phone gets thrown away.
        val settled = job(deposit = ruleFigure, auto = true)
        assertNull(JobMoney.depositToStore(settled, materials, billable))
    }

    @Test
    fun `a job with no price at all gets nothing`() {
        assertNull(JobMoney.depositToStore(job(deposit = 500.0, auto = true), 0.0, 0.0))
        assertNull(JobMoney.depositToStore(job(deposit = 500.0, auto = true), Double.NaN, billable))
    }

    @Test
    fun `the deposit never exceeds the job price`() {
        // The cap is depositSuggestion's, and it has to survive the new path:
        // asking for $1,400 on a $600 job is the bug that made a $3,963
        // deposit read on a $3,620 job.
        val small = 600.0
        val asked = JobMoney.depositToStore(job(deposit = 100.0, auto = true), materials, small)!!
        assertTrue("the deposit asked ($asked) is more than the whole job ($small)", asked <= small + 0.005)
    }

    @Test
    fun `seeding a job that has none still works, and is the app's figure`() {
        // depositToSeed is unchanged; the caller is what marks it automatic.
        assertEquals(ruleFigure, JobMoney.depositToSeed(job(), materials, billable)!!, 0.001)
        assertNull(
            "seeding wrote over a deposit that already existed",
            JobMoney.depositToSeed(job(deposit = 900.0), materials, billable)
        )
    }

    @Test
    fun `CANARY a default job is not automatic`() {
        // The field defaults false on purpose: a row from an older build, or
        // from any code that does not know about it, must read as somebody's
        // own figure rather than as free to overwrite.
        assertEquals(false, Job(id = 1, customerName = "A").depositIsAuto)
    }
}
