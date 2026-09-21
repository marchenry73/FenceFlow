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
    /**
     * The server refused it for what looked like a reason about the row
     * itself. Held back, and tried once more when the mark expires -- see
     * [isDueForPush] for why a mark can no longer be permanent.
     */
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
 * Whether a rejection from the server is (probably) about the ROW -- will
 * happen again on the exact same row, with nothing about the network, the
 * sign-in or the server's own state changing that -- as opposed to
 * temporary, where the very next attempt might simply work.
 *
 * "Probably", and that word is the reason [isDueForPush] exists. The honest
 * test would be the SQLSTATE: 23514 (a check or a trigger's refusal), 23502
 * (not-null), 23503 (foreign key) are about the row; PGRST204 ("column not in
 * the schema cache", a 400 in the middle of a migration) is not. PostgREST
 * sends that code in the body -- and postgrest-kt 3.0.2 parses it and throws
 * it away (PostgrestImpl.parseErrorResponse builds the exception from
 * message, response and details-or-hint only; read from the bytecode on
 * 2026-09-21). The phone therefore has only the HTTP status, and one status
 * can mean either. So the statuses that are NEVER about the row are retried
 * outright here, and everything left that merely usually is -- 400, 409, 413,
 * 422 -- is permanent with an expiry, so a wrong guess costs a few hours and
 * one request rather than a good shift stuck until a person notices.
 *
 * Never about the row, and therefore retries:
 *  - 401 and 403: this phone may not ask right now (a fresh sign-in, a
 *    permission restored), not that the row is bad.
 *  - 404: PostgREST's "no such table or function" -- PGRST205 while the schema
 *    cache catches up with a migration, 42P01, 42883. A write to a table this
 *    app ships against can only 404 while the server is mid-change.
 *  - 408, 425, 429: timed out, too early, rate-limited. The gateway's words,
 *    about load, never about content. A 429 used to mark every row of a
 *    throttled batch as rejected -- with a Discard button beside each one.
 *  - 5xx, a timeout, or no HTTP response at all (offline, DNS, a dropped
 *    socket): the request never finished.
 *
 * Matched on [RestException.getStatusCode] rather than on the subclass the
 * client happens to throw (`UnauthorizedRestException`, `BadRequestRestException`,
 * ...), so this reads the same real number the server sent regardless of
 * which of those types wraps it. Confirmed against the supabase-kt 3.0.2
 * bytecode on 2026-09-18: `statusCode` is a real field, filled from
 * `response.status.value`, and postgrest-kt builds `BadRequestRestException`
 * for an HTTP 400 only (401 Unauthorized, 404 NotFound, everything else
 * Unknown) -- see TimeEntryPushDecisionTest, which feeds the real types
 * through here.
 */
fun isPermanentRejection(error: Throwable): Boolean {
    val rest = generateSequence(error) { it.cause }
        .filterIsInstance<RestException>()
        .firstOrNull() ?: return false
    val code = rest.statusCode
    if (code in NEVER_ABOUT_THE_ROW) return false
    if (code in 500..599) return false
    return code in 400..499
}

/** See [isPermanentRejection] for each one. */
private val NEVER_ABOUT_THE_ROW = setOf(401, 403, 404, 408, 425, 429)

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
     * own sentence) and left out of later passes until [isDueForPush] says
     * the mark has expired. Never counted as a sync failure: a banner that
     * keeps saying FAILED for a row that will not go up teaches people to
     * ignore it, and the Time screen is where this belongs.
     */
    data class Permanent(val detail: String?) : RowRejection()

    /** Counted as a failure, so the sync reports it and the row is tried again next pass. */
    data class Retry(val cause: Throwable) : RowRejection()
}

fun classifyRowRejection(cause: Throwable): RowRejection =
    if (isPermanentRejection(cause)) RowRejection.Permanent(permanentRejectionDetail(cause) ?: cause.message)
    else RowRejection.Retry(cause)

/**
 * How long a SERVER_REJECTED mark holds before the shift is tried once more.
 *
 * Six hours: long enough that a row the server genuinely refuses costs four
 * requests a day rather than one per sync, short enough that a shift wrongly
 * marked -- a migration window, a throttle, the update-pass bug below -- is
 * back in the queue the same working day, before payroll, and before anyone
 * has been left staring at a Discard button beside good hours.
 */
const val SERVER_REJECTED_RETRY_AFTER_MS: Long = 6L * 60 * 60 * 1000

/**
 * Whether [EntitySync.pushTimeEntries] should send this shift on the pass
 * running at [now].
 *
 * An unmarked shift, always. A SERVER_REJECTED one once its mark is
 * [SERVER_REJECTED_RETRY_AFTER_MS] old -- and immediately when the mark
 * carries no time or a time AHEAD of [now] (the phone's clock was moved
 * back), because a mark that cannot be aged must not become a mark that never
 * ages. If the retry is refused again the push re-stamps the mark, so it is
 * one retry per window, not one per sync.
 *
 * NEEDS_WORKER never, here: it is known without asking the server and is
 * cleared by its own rule the moment the shift's worker resolves.
 *
 * Why this exists at all: [isPermanentRejection] has to guess from an HTTP
 * status (see there), and until 2026-09-21 a wrong guess was for ever. Every
 * shift a 1.502-1.508 phone had already uploaded was marked SERVER_REJECTED
 * by the update pass's own 23502 -- "null value in column started_at" -- and
 * nothing but a person could clear it. This clears those on the first sync of
 * a fixed build, since every one of them is older than the window.
 */
fun isDueForPush(entry: TimeEntry, now: Long): Boolean {
    val reason = entry.syncBlockedReason ?: return true
    if (reason == TimeEntrySyncBlock.NEEDS_WORKER.name) return false
    val markedAt = entry.syncBlockedAt ?: return true
    val age = now - markedAt
    return age < 0 || age >= SERVER_REJECTED_RETRY_AFTER_MS
}

/**
 * The one change a phone may send about a shift the cloud already holds:
 * who worked it, after the Time screen's Fix -- or null when there is nothing
 * to send.
 *
 * Nothing else about a stored shift is the phone's to re-assert. The clock
 * and the break are written once, by the insert-only pass, and corrected
 * only by the office or `correct_time_entry`; the decision belongs to
 * `approve_time_entry`; the rate is the server's (`stamp_time_entry_rate`
 * overwrites whatever a phone sends); and no screen edits the notes or moves
 * a shift between jobs after clock-out. The update pass used to send all of
 * those for every shift on every sync, as an upsert that could never work --
 * see [EntitySync.pushTimeEntries].
 *
 * [resolvedEmployeeSyncId] is what [resolveEmployeeSyncId] returned -- the
 * value that will actually be sent. A blank one is never sent: the server
 * refuses clearing a shift's worker, and such a shift is held back as
 * NEEDS_WORKER before it gets here anyway.
 */
fun workerChangeToSend(entry: TimeEntry, resolvedEmployeeSyncId: String?): CloudTimeEntryWorkerPatch? {
    if (entry.workerChangedAt == null) return null
    val worker = resolvedEmployeeSyncId?.takeIf { it.isNotBlank() } ?: return null
    return CloudTimeEntryWorkerPatch(employeeSyncId = worker)
}

/**
 * [classifyRowRejection], for the worker-change PATCH -- with one difference.
 *
 * A 403 there is `guard_time_entry_write_permission` saying this person may
 * not change who worked a shift (it needs SCHEDULE_AND_ASSIGN or
 * APPROVE_TIME). That is an answer about this change by this account, not
 * "sign in again" (an expired session is a 401), and treating it as a retry
 * would send the same refused PATCH on every sync, for ever, with nothing on
 * screen. So it is marked like any other refusal, with the server's own
 * sentence, and ages out on the same clock. 401 stays a retry.
 */
fun classifyWorkerChangeRejection(cause: Throwable): RowRejection {
    val rest = generateSequence(cause) { it.cause }
        .filterIsInstance<RestException>()
        .firstOrNull()
    if (rest != null && rest.statusCode == 403) {
        val sentence = rest.error.ifBlank { rest.message.orEmpty() }
        return RowRejection.Permanent(sentence.takeUnless { it.isBlank() } ?: cause.message)
    }
    return classifyRowRejection(cause)
}
