package com.fenceestimator.app.ui.jobs

import androidx.annotation.StringRes
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.AccessRefusal
import com.fenceestimator.app.cloud.AccessRequestStatus
import com.fenceestimator.app.cloud.AssignmentKind
import com.fenceestimator.app.cloud.JobAssignment
import com.fenceestimator.app.cloud.JobScope
import com.fenceestimator.app.cloud.RequestableJob
import com.fenceestimator.app.data.Employee

/*
 * The decisions behind "crew see the jobs they are on, and ask for the rest"
 * on screen (supabase_crew_job_scope.sql, cloud/JobAccess.kt), kept apart
 * from the composables so each can be held to a test without a device. The
 * screens only draw what these decide.
 *
 * Every one of them starts from the same rule: only a definite
 * [JobScope.Scoped] answer changes anything. Unknown (not asked yet, no
 * signal) and NotDeployed (the server has no crew scope) are the job list as
 * it always was -- no notice, no request row -- so a phone on a database the
 * change has not reached cannot tell it exists.
 */

/** What the job list says above the jobs, for someone the server shows only their own. */
internal enum class ScopedNotice {
    /** Nothing to say: not scoped, or there are jobs to show. */
    NONE,

    /**
     * This login has no crew record, so the server rightly shows it nothing.
     * Said in words, never as an empty list: an empty list reads as a sync
     * failure, and only the office can fix this one.
     */
    NOT_LINKED,

    /** Linked, and on no job yet. */
    NONE_ASSIGNED,

    /**
     * The server says they are on jobs this phone does not have yet -- just
     * assigned, or just let in. They arrive with the next sync; saying so
     * stops "no jobs" being read as the assignment not having worked.
     */
    ON_THE_WAY
}

internal data class ScopedHome(
    val notice: ScopedNotice,
    /** Offer "Other jobs -- request access". Only a linked, scoped login can ask. */
    val offerRequestAccess: Boolean,
    /** Show "Kept on this phone": whenever there are held jobs, whatever the scope says now. */
    val showKept: Boolean
)

/**
 * @param visibleJobs jobs in the list (held ones are not in it).
 * @param keptJobs jobs this phone holds after its person was taken off them.
 */
internal fun scopedHome(scope: JobScope, visibleJobs: Int, keptJobs: Int): ScopedHome {
    val kept = keptJobs > 0
    val scoped = scope as? JobScope.Scoped ?: return ScopedHome(ScopedNotice.NONE, false, kept)
    if (!scoped.linked) return ScopedHome(ScopedNotice.NOT_LINKED, false, kept)
    val notice = when {
        visibleJobs > 0 -> ScopedNotice.NONE
        scoped.visible > 0 -> ScopedNotice.ON_THE_WAY
        else -> ScopedNotice.NONE_ASSIGNED
    }
    return ScopedHome(notice, true, kept)
}

/** One row of the request list, as the screen draws it. */
internal data class RequestRow(
    /** The chip beside the job: waiting, or declined. Null: nothing to say. */
    val chip: AccessRequestStatus?,
    /** The office's note on a decline, when it left one. */
    val note: String,
    /** No request is waiting, so "Request access" is offered. */
    val canAsk: Boolean,
    /**
     * The waiting request's id, for Withdraw. Null when it is not known --
     * the requests table could not be read this time -- and then Withdraw is
     * not offered rather than offered and failing.
     */
    val withdrawId: String?
)

/**
 * The latest thing this person asked about [job], as a row.
 *
 * The list's own status is the truth for the chip (it is read in the same
 * query as the job); the full request only supplies the id and the note, and
 * only when it is the same request -- a newer ask racing the two reads must
 * not put an old decline's note beside a fresh "waiting".
 */
internal fun requestRowOf(job: RequestableJob): RequestRow {
    val full = job.myRequest?.takeIf { it.jobSyncId == job.jobSyncId && it.status == job.myRequestStatus }
    return when (job.myRequestStatus) {
        AccessRequestStatus.PENDING -> RequestRow(AccessRequestStatus.PENDING, "", canAsk = false, withdrawId = full?.id)
        AccessRequestStatus.DENIED ->
            RequestRow(AccessRequestStatus.DENIED, full?.decisionNote.orEmpty().trim(), canAsk = true, withdrawId = null)
        // Let in once and since taken off (a job is only listed while they
        // are not on it), withdrawn, or never asked: ask afresh.
        AccessRequestStatus.APPROVED, AccessRequestStatus.WITHDRAWN, null ->
            RequestRow(null, "", canAsk = true, withdrawId = null)
    }
}

/** The search box: a name or a street, ignoring case and the spaces around it. */
internal fun filterRequestable(rows: List<RequestableJob>, query: String): List<RequestableJob> {
    val q = query.trim()
    if (q.isEmpty()) return rows
    return rows.filter { it.customerName.contains(q, ignoreCase = true) || it.address.contains(q, ignoreCase = true) }
}

/**
 * The people on a job besides its lead, as "Also on this job" lists them:
 * open rows only, one per person, the lead left out (they are on the lead
 * picker above), oldest first.
 */
internal fun extraCrewOf(assignments: List<JobAssignment>, leadSyncId: String?): List<JobAssignment> =
    assignments
        .filter { it.endedAt == null && it.employeeSyncId != leadSyncId }
        .sortedBy { it.assignedAt ?: Long.MAX_VALUE }
        .distinctBy { it.employeeSyncId }

/**
 * What to send set_job_crew to add [employeeSyncId]. It REPLACES the job's
 * whole extra-crew list -- everyone of kind CREW left off is ended -- so this
 * is every open CREW row plus the new person, never the new person alone.
 * Access grants (kind ACCESS) are not the list's to carry: set_job_crew
 * never ends them, and listing them would only try to add them twice.
 */
internal fun crewAfterAdding(assignments: List<JobAssignment>, employeeSyncId: String): List<String> =
    (assignments.filter { it.endedAt == null && it.kind == AssignmentKind.CREW }.map { it.employeeSyncId } +
        employeeSyncId).distinct()

/**
 * Who can be added: active crew with a cloud identity, not the lead and not
 * already on the job, by name. An inactive record sees nothing on the server
 * (my_employee_sync_ids ignores it), so offering one would add a person the
 * job can never reach.
 */
internal fun addableCrew(employees: List<Employee>, leadEmployeeId: Long?, assignments: List<JobAssignment>): List<Employee> {
    val onIt = assignments.filter { it.endedAt == null }.map { it.employeeSyncId }.toSet()
    return employees
        .filter { it.isActive && it.syncId.isNotBlank() && it.id != leadEmployeeId && it.syncId !in onIt }
        .sortedBy { it.name.lowercase() }
}

/** What an access refusal was about, where the wording differs. */
internal enum class AccessAction { ASK, ANSWER, CREW }

/**
 * The sentence for a refusal, in the app's words and the phone's language --
 * the server's own English (AccessResult.Refused.serverMessage) is for the
 * log. [AccessRefusal.NOT_AVAILABLE] has a sentence too, for a screen that is
 * already open when it turns out the server has no crew scope; every entry
 * point hides itself before that can happen.
 */
@StringRes
internal fun accessRefusalText(reason: AccessRefusal, action: AccessAction): Int = when (reason) {
    AccessRefusal.NOT_ALLOWED -> when (action) {
        AccessAction.ASK -> R.string.access_refused_ask_not_allowed
        AccessAction.ANSWER -> R.string.access_refused_answer_not_allowed
        AccessAction.CREW -> R.string.access_refused_crew_not_allowed
    }
    AccessRefusal.NOT_FOUND -> when (action) {
        AccessAction.ASK -> R.string.access_refused_ask_not_found
        AccessAction.ANSWER -> R.string.access_refused_answer_not_found
        AccessAction.CREW -> R.string.access_refused_crew_not_found
    }
    AccessRefusal.NOT_LINKED -> R.string.jobs_scope_not_linked
    AccessRefusal.NOTHING_TO_ASK -> R.string.access_refused_nothing_to_ask
    AccessRefusal.LIMIT_REACHED -> R.string.access_refused_limit
    AccessRefusal.SIGNED_OUT -> R.string.access_refused_signed_out
    AccessRefusal.NOT_AVAILABLE -> R.string.access_refused_not_available
    AccessRefusal.NO_CONNECTION -> R.string.access_needs_connection
    AccessRefusal.FAILED -> R.string.access_refused_failed
}
