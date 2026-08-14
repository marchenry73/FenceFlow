package com.fenceestimator.app.ui.components

import com.fenceestimator.app.data.HoaApprovalStatus
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.PaymentStatus
import com.fenceestimator.app.data.isWon
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * One step of the project pipeline, with what to actually do about it.
 * [guidance] is what the user sees when they tap a step they haven't finished.
 */
data class ProjectStage(
    val label: String,
    val done: Boolean,
    val current: Boolean,
    val guidance: String = "",
    val action: StageAction = StageAction.NONE
)

/** Where tapping an unfinished step should take you. */
enum class StageAction { NONE, DRAW, ESTIMATE, PAYMENT, HOA, SCHEDULE, CREW_VIEW }

object ProjectStatus {

    /**
     * The pipeline a customer actually cares about, derived from data the app
     * already tracks -- no separate status field to keep in sync (and get wrong).
     */
    fun stages(job: Job, jobComplete: Boolean): List<ProjectStage> {
        val quoteSent = job.status != JobStatus.DRAFT
        val approved = job.status.isWon || job.signatureImagePath != null
        val depositReceived = job.amountPaid > 0.0 || job.paymentStatus != PaymentStatus.UNPAID
        val hoaDone = job.hoaApprovalStatus == HoaApprovalStatus.NOT_REQUIRED ||
            job.hoaApprovalStatus == HoaApprovalStatus.APPROVED
        val scheduled = job.scheduledDate != null
        val paidInFull = job.paymentStatus == PaymentStatus.PAID_IN_FULL

        // Each step carries the instruction for finishing it, so tapping an
        // unfinished step tells you what to do rather than just that it's undone.
        val flags = listOf(
            Triple("Quote sent", quoteSent, StageAction.ESTIMATE) to
                "Draw the fence, run Suggest Quantities, then Export & Share the PDF estimate.",
            Triple("Quote approved", approved, StageAction.ESTIMATE) to
                "Once the customer agrees, capture their signature on the Estimate screen or set the job status to Accepted.",
            Triple("Deposit received", depositReceived, StageAction.PAYMENT) to
                "Record the deposit under Payment & Invoice, or send them a payment link.",
            Triple("HOA / permit cleared", hoaDone, StageAction.HOA) to
                "Send the HOA approval request and set the status to Approved, or mark it Not Required.",
            Triple("Installation scheduled", scheduled, StageAction.SCHEDULE) to
                "Set the job date under Schedule & Crew, and assign who's running it.",
            Triple("Installation complete", jobComplete, StageAction.CREW_VIEW) to
                "Work through the install checklist in the crew view, then tap Mark Job Complete.",
            Triple("Final payment", paidInFull, StageAction.PAYMENT) to
                "Generate the invoice, then set payment status to Paid in Full once the money lands."
        )

        val firstUnfinished = flags.indexOfFirst { !it.first.second }
        return flags.mapIndexed { index, (triple, guidance) ->
            val (label, done, action) = triple
            ProjectStage(
                label = label,
                done = done,
                current = index == firstUnfinished,
                guidance = guidance,
                action = action
            )
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
