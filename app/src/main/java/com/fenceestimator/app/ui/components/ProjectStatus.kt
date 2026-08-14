package com.fenceestimator.app.ui.components

import com.fenceestimator.app.data.HoaApprovalStatus
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.PaymentStatus
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** One step of the customer-visible project pipeline. */
data class ProjectStage(val label: String, val done: Boolean, val current: Boolean)

object ProjectStatus {

    /**
     * The pipeline a customer actually cares about, derived from data the app
     * already tracks -- no separate status field to keep in sync (and get wrong).
     */
    fun stages(job: Job, jobComplete: Boolean): List<ProjectStage> {
        val quoteSent = job.status != JobStatus.DRAFT
        val approved = job.status == JobStatus.ACCEPTED || job.signatureImagePath != null
        val depositReceived = job.amountPaid > 0.0 || job.paymentStatus != PaymentStatus.UNPAID
        val hoaDone = job.hoaApprovalStatus == HoaApprovalStatus.NOT_REQUIRED ||
            job.hoaApprovalStatus == HoaApprovalStatus.APPROVED
        val scheduled = job.scheduledDate != null
        val paidInFull = job.paymentStatus == PaymentStatus.PAID_IN_FULL

        val flags = listOf(
            "Quote sent" to quoteSent,
            "Quote approved" to approved,
            "Deposit received" to depositReceived,
            "HOA / permit cleared" to hoaDone,
            "Installation scheduled" to scheduled,
            "Installation complete" to jobComplete,
            "Final payment" to paidInFull
        )

        val firstUnfinished = flags.indexOfFirst { !it.second }
        return flags.mapIndexed { index, (label, done) ->
            ProjectStage(label = label, done = done, current = index == firstUnfinished)
        }
    }

    /** Plain-text version for texting or emailing the customer an update. */
    fun asMessage(job: Job, jobComplete: Boolean, businessName: String): String {
        val dateFormat = SimpleDateFormat("EEEE, MMMM d", Locale.US)
        val lines = stages(job, jobComplete).joinToString("\n") { stage ->
            val mark = when {
                stage.done -> "[x]"
                stage.current -> "[ ] <-- we are here"
                else -> "[ ]"
            }
            "$mark ${stage.label}"
        }
        val scheduleNote = job.scheduledDate?.let {
            "\n\nInstallation is scheduled for ${dateFormat.format(Date(it))}."
        }.orEmpty()
        val balance = (job.amountPaid).let { paid ->
            if (paid > 0.0) "\n\nReceived so far: $${"%.2f".format(paid)}." else ""
        }

        return "Hi ${job.customerName.ifBlank { "there" }}, here's where your fence project stands:\n\n" +
            "$lines$scheduleNote$balance\n\n" +
            "Any questions, just reply to this message.\n\n" +
            businessName.ifBlank { "Your fence crew" }
    }
}
