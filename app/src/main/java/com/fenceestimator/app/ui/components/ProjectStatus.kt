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
    fun stages(job: Job, jobComplete: Boolean, billableTotal: Double = 0.0): List<ProjectStage> {
        val quoteSent = job.status != JobStatus.DRAFT
        val approved = job.status.isWon || job.signatureImagePath != null
        // THE WHOLE DEPOSIT, not any money at all (2 Oct 2026).
        //
        // This step read "netPaid > 0 || paymentStatus != UNPAID" -- any money
        // in -- while the office's readiness checklist read the same step as
        // "the whole deposit is collected". So $500 of a $3,000 deposit ticked
        // "Deposit received" on the phone and read "Asked $3,000.00, collected
        // $500.00" in the office, on one job on one afternoon, and he reads
        // them side by side. The office meaning survives, because this step is
        // what decides whether the materials can be bought and the job put on
        // the schedule, and half a deposit does not buy materials. It is now
        // called "Deposit collected in full" so the other reading cannot be
        // taken from it, and the payment-status value that any payment sets
        // reads "Part paid" rather than "Deposit paid".
        //
        // JobMoney.depositSettled is the same arithmetic as the office's
        // jobReadiness(): nothing asked for, or everything asked for is in.
        // netPaid, not amountPaid: a job paid and then fully refunded has not
        // had its deposit received, however much passed through it.
        //
        // [billableTotal] only caps the deposit at the price (JobMoney's own
        // guard leaves it uncapped at zero), so a caller that has not got the
        // estimate to hand still gets the right answer on every job whose
        // deposit is at or below its price -- which is every live job today.
        val depositReceived = JobMoney.depositSettled(job, billableTotal)
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
        // Before [resolve], because [resolve] is passed as a trailing lambda
        // at every call site and Kotlin binds a trailing lambda to the LAST
        // parameter.
        billableTotal: Double = 0.0,
        resolve: (Int, List<Any>) -> String
    ): String {
        val dateFormat = SimpleDateFormat("EEEE, MMMM d", Locale.US)
        val lines = stages(job, jobComplete, billableTotal).joinToString("\n") { stage ->
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
