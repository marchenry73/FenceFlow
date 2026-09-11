package com.fenceestimator.app.ui.crew

import com.fenceestimator.app.data.FieldChange
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.TimeEntry
import com.fenceestimator.app.estimate.LocateTicket
import java.util.Calendar

/**
 * One thing waiting on a specific crew member, with nothing else attached.
 *
 * This is deliberately a closed list, not an open one. The office has
 * fourteen exception detectors (see ALERT_DEFS in website/dashboard.html) and
 * none of them belong here -- they answer "what needs the OFFICE", and a
 * fence in a yard has no dispute to open, no invoice to chase, no margin to
 * review. [kind] is the whole vocabulary a crew member's phone is allowed to
 * raise. Adding a fifth case here means deciding it belongs, not just piping
 * a new office alert through.
 */
data class CrewAttentionItem(
    /**
     * Stable per occurrence, including the timestamp that would change if the
     * underlying fact changes (a new decision, a new rejection). Used both as
     * a Compose list key and as the fingerprint a person's "got it" dismissal
     * is stored against -- the same key+fingerprint shape the office dashboard
     * uses for its own alert de-duplication, so a changed fact always reopens
     * the alert instead of a dismissal silently outliving the thing it was
     * about.
     */
    val key: String,
    val jobId: Long?,
    val kind: Kind,
    /**
     * The one piece of free text a person needs to act, when there is one:
     * the office's reason a shift was sent back, or its note on a plan-change
     * decision. Blank for [Kind.JOB_TODAY] and [Kind.LOCATE_EXPIRED], which
     * carry no such note anywhere in the data.
     */
    val detail: String = "",
    /**
     * Only meaningful for [Kind.PLAN_CHANGE_ANSWERED]: true if the office said
     * yes, false if no. Null for every other kind.
     */
    val approved: Boolean? = null
) {
    enum class Kind {
        /** A job assigned to this person is on today's schedule. */
        JOB_TODAY,

        /** An 811 locate has expired on a job this person is assigned to. */
        LOCATE_EXPIRED,

        /** A shift of theirs was sent back by the office, with a reason. */
        SHIFT_SENT_BACK,

        /** A plan-change request they sent has been answered. */
        PLAN_CHANGE_ANSWERED
    }
}

/**
 * Builds the crew half of notifications: the subset of what the office can
 * see that one specific person in a yard can actually act on.
 *
 * A pure function on purpose. It takes exactly the rows already on the
 * phone -- nothing here reaches for the network -- so it can be unit tested
 * without a device and so the caller can decide, separately, whether the data
 * behind it is fresh enough to trust (see [com.fenceestimator.app.ui.crew.CrewAttentionViewModel]
 * for the online/offline framing that answer needs).
 *
 * @param myEmployeeId this person's own crew record, or null if the signed-in
 *   account does not resolve to one (see [com.fenceestimator.app.cloud.ClockInIdentity]).
 *   Null means nothing here can be attributed to anyone, so an empty list is
 *   returned rather than guessed at.
 * @param myEmail matched against [FieldChange.changedBy], which is how a
 *   plan-change request records who asked -- see Repository.requestPlanChange.
 * @param jobs every job on the phone. Filtered down to this person's own
 *   assignment before anything else runs.
 * @param timeEntries every shift on the phone for jobs this person is
 *   assigned to. A shift on a job this person has since been moved off of is
 *   out of scope -- the same boundary [jobs] draws.
 * @param fieldChanges every plan change on the phone for jobs this person is
 *   assigned to.
 * @param now injected so a test can pick a fixed "today" instead of the
 *   moment it happens to run.
 */
object CrewAttention {

    fun build(
        myEmployeeId: Long?,
        myEmail: String,
        jobs: List<Job>,
        timeEntries: List<TimeEntry>,
        fieldChanges: List<FieldChange>,
        now: Long = System.currentTimeMillis()
    ): List<CrewAttentionItem> {
        if (myEmployeeId == null) return emptyList()

        val myJobs = jobs.filter { it.assignedEmployeeId == myEmployeeId }
        val myJobIds = myJobs.map { it.id }.toSet()
        val active = myJobs.filter { it.status != JobStatus.COMPLETED && it.status != JobStatus.DECLINED }

        val items = mutableListOf<CrewAttentionItem>()

        // Safety first: a lapsed locate is the one item here that is not just
        // inconvenient if missed. See LocateTicket -- the same check the job
        // detail screen uses, so this can never disagree with it about what
        // "expired" means.
        active.filter { LocateTicket.stateOf(it, now) == LocateTicket.State.EXPIRED }
            .forEach { j ->
                items += CrewAttentionItem(
                    key = "locate_expired:${j.id}:${j.locateExpiresAt}",
                    jobId = j.id,
                    kind = CrewAttentionItem.Kind.LOCATE_EXPIRED
                )
            }

        // A shift sent back is the office saying something about THIS
        // person's hours is wrong and needs their side of it, not a
        // read-only fact -- so it is next after the safety item.
        timeEntries.filter { it.employeeId == myEmployeeId && it.isRejected && it.jobId in myJobIds }
            .forEach { t ->
                items += CrewAttentionItem(
                    key = "shift_sent_back:${t.syncId}:${t.rejectedAt}",
                    jobId = t.jobId,
                    kind = CrewAttentionItem.Kind.SHIFT_SENT_BACK,
                    detail = t.reviewNote
                )
            }

        // A request they made has an answer waiting. changedBy is an email,
        // the same identifier Repository.requestPlanChange stamped it with --
        // there is no employee id on a FieldChange, so this is the only link
        // back to "theirs" that exists.
        val myEmailLower = myEmail.trim().lowercase()
        if (myEmailLower.isNotBlank()) {
            fieldChanges.filter {
                it.isRequest && it.jobId in myJobIds &&
                    it.changedBy.trim().lowercase() == myEmailLower &&
                    (it.approvedAt != null || it.rejectedAt != null)
            }.forEach { c ->
                items += CrewAttentionItem(
                    key = "plan_change_answered:${c.syncId}:${c.approvedAt ?: c.rejectedAt}",
                    jobId = c.jobId,
                    kind = CrewAttentionItem.Kind.PLAN_CHANGE_ANSWERED,
                    detail = c.decisionNote,
                    approved = c.approvedAt != null
                )
            }
        }

        // Today's assignment last: it is the plan for the day, not something
        // that went wrong. Shown so opening the app answers "where am I
        // going" without a scroll through the full job list.
        active.filter { j -> j.scheduledDate?.let { isToday(it, now) } == true }
            .forEach { j ->
                items += CrewAttentionItem(
                    key = "job_today:${j.id}:${j.scheduledDate}",
                    jobId = j.id,
                    kind = CrewAttentionItem.Kind.JOB_TODAY
                )
            }

        return items
    }

    private fun isToday(millis: Long, now: Long): Boolean {
        val a = Calendar.getInstance().apply { timeInMillis = millis }
        val b = Calendar.getInstance().apply { timeInMillis = now }
        return a.get(Calendar.YEAR) == b.get(Calendar.YEAR) &&
            a.get(Calendar.DAY_OF_YEAR) == b.get(Calendar.DAY_OF_YEAR)
    }
}
