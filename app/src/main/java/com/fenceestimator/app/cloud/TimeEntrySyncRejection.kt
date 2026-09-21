package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.Employee
import com.fenceestimator.app.data.TimeEntry
import io.github.jan.supabase.exceptions.RestException

/**
 * Why a shift is being held back from [EntitySync.pushTimeEntries] rather
 * than retried.
 */
enum class TimeEntrySyncBlock {
    /** No employee the cloud can be told about is attached to the shift -- the insert trigger's own rule. */
    NEEDS_WORKER,
    /** The server refused it for some other reason a retry cannot fix. */
    SERVER_REJECTED
}

/**
 * The `employee_sync_id` this shift would be SENT with, or null when there is
 * nothing to send.
 *
 * Null for a shift with no employee, for one whose employee row is gone from
 * this phone (an employeeId pointing at nobody), and for an employee whose
 * own sync id is blank. [needsWorkerAssignment] tests this value and
 * [EntitySync.pushTimeEntries] sends this value, so the two cannot disagree.
 * They did: the hold-back looked at `employeeId == null` alone, and the two
 * shifts refused on every sync for a week each HAD an employeeId -- naming an
 * employee this phone no longer held -- so they sailed past the check and
 * went up as employee_sync_id "" to be refused, every sync, forever.
 */
fun resolveEmployeeSyncId(entry: TimeEntry, employeeSyncById: Map<Long, String>): String? =
    entry.employeeId?.let { employeeSyncById[it] }?.takeIf { it.isNotBlank() }

/**
 * True for a finished shift that would go up with no employee_sync_id -- the
 * one rule the `time_entries` insert trigger enforces, and the one case this
 * app can know about without ever asking the server. Pushing one anyway is a
 * guaranteed, permanent 4xx: the same answer every single sync, forever,
 * until a person picks who worked it.
 *
 * [resolvedEmployeeSyncId] is what [resolveEmployeeSyncId] returned for the
 * shift -- the value that will actually be sent -- not the local employeeId.
 *
 * Only asked of a finished shift -- a running one has no crew assignment
 * requirement yet, and [EntitySync.pushTimeEntries] never sends one anyway.
 */
fun needsWorkerAssignment(entry: TimeEntry, resolvedEmployeeSyncId: String?): Boolean =
    !entry.isRunning && resolvedEmployeeSyncId.isNullOrBlank()

/**
 * Whether a phone that cannot see pay has any business PUSHING this shift.
 *
 * True when the shift's worker is plausibly the signed-in person, which is the
 * client-side reading of the server's own `is_my_shift(employee_sync_id)` --
 * the one thing that makes a `time_entries` row visible, and therefore
 * writable, to somebody without SEE_PAY. A phone in that position holds its
 * colleagues' shifts only because the pull handed them down out of
 * `time_entries_crew`; every write of one is refused 42501 (measured, both
 * push passes, 2026-09-20), so sending them is a guaranteed 403 on a loop.
 *
 * Deliberately a UNION of two tests, not the exact server test alone:
 *
 *  * `profileId == signedInProfileId` IS the server's test, employee row for
 *    employee row, and is the one that should normally answer;
 *  * [OwnWork.isSamePerson] is kept alongside it because a crew record whose
 *    `profile_id` was never filled in would otherwise have its own field work
 *    silently held back on this phone -- a far worse failure than the one
 *    being fixed. The union can only ever send MORE than the server accepts,
 *    never less, so the worst case is exactly today's behaviour for that row.
 *
 * Pure and top level so a test can hold it to that without a sync pass.
 */
fun isOwnShiftToPush(
    entry: TimeEntry,
    employees: List<Employee>,
    signedInProfileId: String?,
    signedInEmail: String?
): Boolean {
    val employeeId = entry.employeeId ?: return false
    val employee = employees.firstOrNull { it.id == employeeId } ?: return false
    val linked = signedInProfileId != null &&
        employee.profileId.isNotBlank() &&
        employee.profileId == signedInProfileId
    return linked || OwnWork.isSamePerson(employee, signedInEmail)
}

/**
 * Whether the Time screen's Fix picker may offer this person.
 *
 * A shift goes up with its employee's sync id, and the server refuses a blank
 * one outright, so picking someone without one would clear the block, send
 * the same empty value, and land the shift straight back on the list. Every
 * employee this app creates or pulls has a sync id; this is the last line.
 */
fun canBeSentAsWorker(employee: Employee): Boolean = employee.syncId.isNotBlank()

/**
 * Whether a rejection from the server is permanent -- will happen again on
 * the exact same row every time, with nothing about the network or the
 * sign-in changing that -- as opposed to temporary, where the very next
 * attempt might simply work.
 *
 * A 4xx that isn't about who's asking is the server refusing the ROW itself:
 * a trigger, a check constraint, a not-null violation. Retrying changes
 * nothing until the row does.
 *
 * [io.github.jan.supabase.exceptions.UnauthorizedRestException] (401/403) is
 * explicitly NOT permanent here even though it is a 4xx -- it says this
 * phone may not ask right now, not that the row is bad, and the very next
 * sync after a fresh sign-in can carry the same row through clean.
 *
 * A 5xx, a timeout, or no HTTP response at all (offline, DNS, a dropped
 * socket) says nothing about the row -- only that the request never
 * finished -- so those must never be treated as permanent, or one flaky
 * connection would tattoo a perfectly good shift as broken forever.
 *
 * Matched on [RestException.getStatusCode] rather than on the subclass the
 * client happens to throw (`UnauthorizedRestException`, `BadRequestRestException`,
 * ...), so this reads the same real number the server sent regardless of
 * which of those types wraps it. Confirmed against the supabase-kt 3.0.2
 * bytecode on 2026-09-18: `statusCode` is a real field, filled from
 * `response.status.value`, and postgrest-kt builds `BadRequestRestException`
 * for an HTTP 400 only (401 Unauthorized, 404 NotFound, everything else
 * Unknown) -- see TimeEntryPushDecisionTest, which feeds the real type
 * through here.
 */
fun isPermanentRejection(error: Throwable): Boolean {
    val rest = generateSequence(error) { it.cause }
        .filterIsInstance<RestException>()
        .firstOrNull() ?: return false
    val code = rest.statusCode
    if (code == 401 || code == 403) return false
    if (code in 500..599) return false
    return code in 400..499
}

/**
 * The server's own explanation, trimmed for showing to the person holding
 * the phone -- never re-derived or guessed at, so "This shift is not linked
 * to a crew member..." reaches the screen exactly as the trigger wrote it
 * rather than a generic "couldn't sync" that sends someone hunting for an
 * hour. Falls back to the exception's message when the structured field is
 * blank, and to null when there is truly nothing usable.
 */
fun permanentRejectionDetail(error: Throwable): String? {
    val rest = generateSequence(error) { it.cause }
        .filterIsInstance<RestException>()
        .firstOrNull { isPermanentRejection(it) } ?: return null
    val text = rest.error.ifBlank { rest.message.orEmpty() }
    return text.takeUnless { it.isBlank() }
}

/**
 * What [EntitySync.pushTimeEntries] does with one row the server would not
 * take, decided in one pure place so a test can feed it the real exception
 * type and watch the answer.
 */
sealed class RowRejection {
    /**
     * Marked [TimeEntrySyncBlock.SERVER_REJECTED] with [detail] (the server's
     * own sentence) and left out of every later pass. Never counted as a sync
     * failure: a banner that keeps saying FAILED for a row that can never go
     * up teaches people to ignore it, and the Time screen is where this
     * belongs.
     */
    data class Permanent(val detail: String?) : RowRejection()

    /** Counted as a failure, so the sync reports it and the row is tried again next pass. */
    data class Retry(val cause: Throwable) : RowRejection()
}

fun classifyRowRejection(cause: Throwable): RowRejection =
    if (isPermanentRejection(cause)) RowRejection.Permanent(permanentRejectionDetail(cause) ?: cause.message)
    else RowRejection.Retry(cause)
