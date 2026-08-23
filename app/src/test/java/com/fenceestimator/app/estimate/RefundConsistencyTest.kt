package com.fenceestimator.app.estimate

import com.fenceestimator.app.R
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.PaymentStatus
import com.fenceestimator.app.data.ReviewTemplate
import com.fenceestimator.app.ui.components.ProjectStatus
import com.fenceestimator.app.ui.pipeline.PipelineStage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A refund has to be visible everywhere at once.
 *
 * The app was refund-blind nearly everywhere: only the job-detail money panel
 * and the PDF subtracted refunds. Reports' "Collected", the pipeline chips, the
 * pipeline stage, and the message sent to the customer all used the gross
 * figure. So a refunded job read as paid on one screen and not on another --
 * and told the customer we had kept money we had given back.
 *
 * These fix the rule in place: anything user-facing that says "paid" means
 * net of refunds.
 */
class RefundConsistencyTest {

    private fun job(paid: Double, refunded: Double, status: JobStatus = JobStatus.ACCEPTED) =
        Job(
            customerName = "Test",
            status = status,
            amountPaid = paid,
            refundedAmount = refunded,
            paymentStatus = PaymentStatus.UNPAID
        )

    @Test
    fun `netPaid subtracts the refund`() {
        assertEquals(600.0, JobMoney.netPaid(job(paid = 1000.0, refunded = 400.0)), 0.001)
    }

    @Test
    fun `a full refund leaves nothing paid`() {
        assertEquals(0.0, JobMoney.netPaid(job(paid = 1000.0, refunded = 1000.0)), 0.001)
    }

    @Test
    fun `refunding more than was paid does not go negative`() {
        // Both fields only ever grow, so a sync race could briefly put refunded
        // ahead of paid. Money owed to the customer is not negative money paid.
        assertEquals(0.0, JobMoney.netPaid(job(paid = 500.0, refunded = 900.0)), 0.001)
    }

    // ---- the places that used to disagree ----

    @Test
    fun `a fully refunded job is not sitting at deposit-paid`() {
        val stage = PipelineStage.of(job(paid = 1000.0, refunded = 1000.0), hasDrawnWork = false)
        assertEquals(PipelineStage.APPROVED, stage)
    }

    @Test
    fun `a partly refunded job still counts as deposit paid`() {
        val stage = PipelineStage.of(job(paid = 1000.0, refunded = 400.0), hasDrawnWork = false)
        assertEquals(PipelineStage.DEPOSIT_PAID, stage)
    }

    @Test
    fun `the deposit step un-ticks when the money goes back`() {
        val stages = ProjectStatus.stages(job(paid = 1000.0, refunded = 1000.0), jobComplete = false)
        val deposit = stages.first { it.labelRes == R.string.eng2_stage_deposit_received }
        assertFalse(deposit.done)
    }

    @Test
    fun `the customer is told what we actually kept`() {
        // A stand-in for context.getString: the res id plus its arguments,
        // which is exactly what carries the money figure into the message.
        val message = ProjectStatus.asMessage(
            job(paid = 1000.0, refunded = 400.0), jobComplete = false, businessName = "Acme"
        ) { res, args -> "$res " + args.joinToString(" ") }
        assertTrue("should quote the net figure", message.contains("600.00"))
        assertFalse("must not quote the gross figure", message.contains("1000.00"))
    }

    @Test
    fun `a refunded job is not pitched as a big job to review`() {
        // 8000 paid, 7000 back: 1000 kept, which is not a big job.
        val suggestion = ReviewTemplate.suggestFor(
            job(paid = 8_000.0, refunded = 7_000.0), isRepeatCustomer = false
        )
        assertEquals(ReviewTemplate.STRAIGHTFORWARD, suggestion)
    }

    @Test
    fun `a genuinely big job still is one`() {
        val suggestion = ReviewTemplate.suggestFor(
            job(paid = 8_000.0, refunded = 0.0), isRepeatCustomer = false
        )
        assertEquals(ReviewTemplate.BIG_JOB, suggestion)
    }
}
