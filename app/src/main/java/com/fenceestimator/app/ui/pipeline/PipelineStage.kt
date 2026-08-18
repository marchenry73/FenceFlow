package com.fenceestimator.app.ui.pipeline

import com.fenceestimator.app.data.Job
import com.fenceestimator.app.estimate.JobMoney
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.PaymentStatus

/**
 * Where a job sits in the sales-to-cash pipeline.
 *
 * Derived from data the app already keeps rather than stored as its own
 * field. A separate "stage" column would immediately drift out of step with
 * reality -- someone records a deposit but forgets to move the card, and the
 * board starts lying.
 */
enum class PipelineStage(val label: String) {
    LEAD("New Lead"),
    ESTIMATING("Estimating"),
    QUOTE_SENT("Quote Sent"),
    APPROVED("Approved"),
    DEPOSIT_PAID("Deposit Paid"),
    SCHEDULED("Scheduled"),
    INSTALLED("Installed"),
    COMPLETE("Paid in Full"),
    LOST("Lost");

    companion object {
        fun of(job: Job, hasDrawnWork: Boolean): PipelineStage = when {
            job.status == JobStatus.DECLINED -> LOST
            job.paymentStatus == PaymentStatus.PAID_IN_FULL -> COMPLETE
            job.status == JobStatus.COMPLETED -> INSTALLED
            job.scheduledDate != null && job.status == JobStatus.ACCEPTED -> SCHEDULED
            JobMoney.netPaid(job) > 0.0 || job.paymentStatus == PaymentStatus.DEPOSIT_PAID -> DEPOSIT_PAID
            job.status == JobStatus.ACCEPTED -> APPROVED
            job.status == JobStatus.SENT -> QUOTE_SENT
            hasDrawnWork -> ESTIMATING
            else -> LEAD
        }

        /** Lost sits apart from the flow, so it isn't shown inline by default. */
        val flow: List<PipelineStage> = listOf(
            LEAD, ESTIMATING, QUOTE_SENT, APPROVED, DEPOSIT_PAID, SCHEDULED, INSTALLED, COMPLETE
        )
    }
}
