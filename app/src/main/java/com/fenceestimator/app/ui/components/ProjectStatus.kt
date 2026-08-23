package com.fenceestimator.app.ui.components

import androidx.annotation.StringRes
import com.fenceestimator.app.R
import com.fenceestimator.app.data.HoaApprovalStatus
import com.fenceestimator.app.estimate.JobMoney
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.PaymentStatus
import com.fenceestimator.app.data.isWon
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * One step of the project pipeline, with what to actually do about it.
 * [guidanceRes] is what the user sees when they tap a step they haven't
 * finished. Both are string resources so the screen renders them in the
 * device language.
 */
data class ProjectStage(
    @StringRes val labelRes: Int,
    val done: Boolean,
    val current: Boolean,
    @StringRes val guidanceRes: Int,
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
        // netPaid, not amountPaid: a job paid and then fully refunded has not
        // had its deposit received, however much passed through it.
        val depositReceived = JobMoney.netPaid(job) > 0.0 || job.paymentStatus != PaymentStatus.UNPAID
        val hoaDone = job.hoaApprovalStatus == HoaApprovalStatus.NOT_REQUIRED ||
            job.hoaApprovalStatus == HoaApprovalStatus.APPROVED
        val scheduled = job.scheduledDate != null
        val paidInFull = job.paymentStatus == PaymentStatus.PAID_IN_FULL

        // Each step carries the instruction for finishing it, so tapping an
        // unfinished step tells you what to do rather than just that it's undone.
        val flags = listOf(
            Triple(R.string.eng2_stage_quote_sent, quoteSent, StageAction.ESTIMATE) to
                R.string.eng2_guide_quote_sent,
            Triple(R.string.eng2_stage_quote_approved, approved, StageAction.ESTIMATE) to
                R.string.eng2_guide_quote_approved,
            Triple(R.string.eng2_stage_deposit_received, depositReceived, StageAction.PAYMENT) to
                R.string.eng2_guide_deposit,
            Triple(R.string.eng2_stage_hoa_cleared, hoaDone, StageAction.HOA) to
                R.string.eng2_guide_hoa,
            Triple(R.string.eng2_stage_scheduled, scheduled, StageAction.SCHEDULE) to
                R.string.eng2_guide_schedule,
            Triple(R.string.eng2_stage_complete, jobComplete, StageAction.CREW_VIEW) to
                R.string.eng2_guide_complete,
            Triple(R.string.eng2_stage_final_payment, paidInFull, StageAction.PAYMENT) to
                R.string.eng2_guide_final_payment
        )

        val firstUnfinished = flags.indexOfFirst { !it.first.second }
        return flags.mapIndexed { index, (triple, guidanceRes) ->
            val (labelRes, done, action) = triple
            ProjectStage(
                labelRes = labelRes,
                done = done,
                current = index == firstUnfinished,
                guidanceRes = guidanceRes,
                action = action
            )
        }
    }

    /**
     * Plain-text version for texting or emailing the customer an update.
     *
     * The text goes straight into an SMS or email draft, so it has to be a
     * finished string here -- the caller passes [resolve] (in the app,
     * `context.getString`) and the message comes out in the app language.
     */
    fun asMessage(
        job: Job,
        jobComplete: Boolean,
        businessName: String,
        resolve: (Int, List<Any>) -> String
    ): String {
        val dateFormat = SimpleDateFormat("EEEE, MMMM d", Locale.US)
        val lines = stages(job, jobComplete).joinToString("\n") { stage ->
            val mark = when {
                stage.done -> "[x]"
                stage.current -> "[ ] " + resolve(R.string.eng2_update_we_are_here, emptyList())
                else -> "[ ]"
            }
            "$mark ${resolve(stage.labelRes, emptyList())}"
        }
        val scheduleNote = job.scheduledDate?.let {
            "\n\n" + resolve(R.string.eng2_update_scheduled_for, listOf(dateFormat.format(Date(it))))
        }.orEmpty()
        // Net of refunds. This line goes to the customer, so telling them we
        // received more than we kept is the one version of this figure that
        // could start an argument.
        val balance = JobMoney.netPaid(job).let { paid ->
            if (paid > 0.0) {
                "\n\n" + resolve(R.string.eng2_update_received_so_far, listOf("%.2f".format(paid)))
            } else ""
        }

        val name = job.customerName.ifBlank { resolve(R.string.jd_there, emptyList()) }
        val signoff = businessName.ifBlank { resolve(R.string.eng2_update_your_fence_crew, emptyList()) }
        return resolve(R.string.eng2_update_greeting, listOf(name)) + "\n\n" +
            "$lines$scheduleNote$balance\n\n" +
            resolve(R.string.eng2_update_any_questions, emptyList()) + "\n\n" +
            signoff
    }
}
