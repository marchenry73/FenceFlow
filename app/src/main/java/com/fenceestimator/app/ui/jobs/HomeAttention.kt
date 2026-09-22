package com.fenceestimator.app.ui.jobs

import com.fenceestimator.app.cloud.Permission
import com.fenceestimator.app.data.FieldChange
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.PaymentStatus
import com.fenceestimator.app.estimate.JobSchedule
import com.fenceestimator.app.estimate.LocateTicket

/**
 * Who the home screen is talking to, as far as "Needs attention" cares.
 *
 * The card was built for the owner and shown to everyone. A crew phone read
 * "9 shifts waiting for approval" -- every colleague's shift and its own --
 * and tapping it opened a queue that said they could not approve anything.
 * It also read "plan change waiting", "quote approved" and "stale draft",
 * none of which a person in a yard can act on. Each line now belongs to the
 * permission that can act on it, a capability test and never a role name, so
 * a per-person override moves someone either way.
 *
 * Kept free of Compose and Android so the rule can be held to a test without
 * a device -- HomeDashboard only words and draws what this decides.
 */
internal data class HomeAudience(
    val showMoney: Boolean,
    val canApproveTime: Boolean,
    val canApprovePlanChanges: Boolean,
    val canEditJobs: Boolean,
    val canScheduleAndAssign: Boolean,
    /**
     * The base CREW role, the same test JobsListScreen uses to show the
     * crew's own card (CrewAttentionSection). That card already carries
     * everything a crew member acts on, locate included, so the office card
     * under it would only repeat it.
     */
    val isCrew: Boolean
) {
    /** Whether a line of [kind] is this person's business. */
    fun sees(kind: AttentionKind): Boolean = when (kind) {
        AttentionKind.RUNNING_LATE -> canScheduleAndAssign || canEditJobs
        AttentionKind.QUOTE_APPROVED, AttentionKind.STALE_DRAFT -> canEditJobs || showMoney
        AttentionKind.SHIFTS_TO_APPROVE -> canApproveTime
        AttentionKind.PLAN_CHANGE -> canApprovePlanChanges
        // Safety, not office work: whoever is going to dig needs to know.
        AttentionKind.LOCATE_EXPIRED -> true
        AttentionKind.FINISHED_UNPAID -> showMoney
    }

    /** False for crew: see [isCrew]. */
    val showsAttentionCard: Boolean get() = !isCrew

    companion object {
        fun of(permissions: Set<Permission>, isCrew: Boolean): HomeAudience = HomeAudience(
            showMoney = Permission.SEE_MONEY in permissions,
            canApproveTime = Permission.APPROVE_TIME in permissions,
            canApprovePlanChanges = Permission.APPROVE_PLAN_CHANGES in permissions,
            canEditJobs = Permission.EDIT_JOBS in permissions,
            canScheduleAndAssign = Permission.SCHEDULE_AND_ASSIGN in permissions,
            isCrew = isCrew
        )
    }
}

/** The kinds of line "Needs attention" can carry, in the order it lists them. */
internal enum class AttentionKind {
    RUNNING_LATE, QUOTE_APPROVED, SHIFTS_TO_APPROVE, PLAN_CHANGE, LOCATE_EXPIRED, FINISHED_UNPAID, STALE_DRAFT
}

/**
 * One line: what kind, and the job it opens -- null for the approvals queue,
 * whose [count] is the number of shifts.
 */
internal data class AttentionFact(val kind: AttentionKind, val job: Job? = null, val count: Int = 0)

/**
 * Everything that is waiting on this person, in the order it costs money.
 *
 * Built from the lists the screen already holds; no extra queries. A kind
 * [audience] does not see is never built at all, rather than built and
 * dropped, so no future line can be added to the card without first being
 * given an owner in [HomeAudience.sees].
 *
 * @param pendingHours finished shifts nobody has signed off. The caller also
 *   zeroes it without APPROVE_TIME (or the plan's time feature), so the count
 *   is never even held for someone who cannot act on it.
 * @param now injected so a test can fix "today".
 */
internal fun attentionFacts(
    jobs: List<Job>,
    pendingHours: Int,
    pendingPlanChanges: List<FieldChange>,
    audience: HomeAudience,
    workdayHours: Double,
    now: Long = System.currentTimeMillis()
): List<AttentionFact> {
    val out = mutableListOf<AttentionFact>()
    val byId = jobs.associateBy { it.id }

    if (audience.sees(AttentionKind.RUNNING_LATE)) {
        jobs.filter { JobSchedule.hasOverrun(it, workdayHours, now) }.forEach {
            out += AttentionFact(AttentionKind.RUNNING_LATE, it)
        }
    }
    // The best news the screen can carry. Recent approvals lead for two days,
    // then step aside -- an approval from last month is history, not news.
    if (audience.sees(AttentionKind.QUOTE_APPROVED)) {
        val twoDays = now - 2L * 86_400_000
        jobs.filter { (it.quoteApprovedAt ?: 0) > twoDays }.forEach {
            out += AttentionFact(AttentionKind.QUOTE_APPROVED, it)
        }
    }
    if (audience.sees(AttentionKind.SHIFTS_TO_APPROVE) && pendingHours > 0) {
        out += AttentionFact(AttentionKind.SHIFTS_TO_APPROVE, null, pendingHours)
    }
    if (audience.sees(AttentionKind.PLAN_CHANGE)) {
        pendingPlanChanges
            .filter { it.isRequest && it.approvedAt == null && it.rejectedAt == null }
            .mapNotNull { byId[it.jobId] }.distinctBy { it.id }.forEach {
                out += AttentionFact(AttentionKind.PLAN_CHANGE, it)
            }
    }
    if (audience.sees(AttentionKind.LOCATE_EXPIRED)) {
        jobs.filter { LocateTicket.stateOf(it, now) == LocateTicket.State.EXPIRED }.forEach {
            out += AttentionFact(AttentionKind.LOCATE_EXPIRED, it)
        }
    }
    if (audience.sees(AttentionKind.FINISHED_UNPAID)) {
        jobs.filter { it.status == JobStatus.COMPLETED && it.paymentStatus != PaymentStatus.PAID_IN_FULL }.forEach {
            out += AttentionFact(AttentionKind.FINISHED_UNPAID, it)
        }
    }
    if (audience.sees(AttentionKind.STALE_DRAFT)) {
        val weekAgo = now - 7L * 24 * 60 * 60 * 1000
        jobs.filter { it.status == JobStatus.DRAFT && it.updatedAt < weekAgo }.forEach {
            out += AttentionFact(AttentionKind.STALE_DRAFT, it)
        }
    }
    return out
}
