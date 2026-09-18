package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.TimeEntry
import io.github.jan.supabase.exceptions.RestException

/**
 * Why a shift is being held back from [EntitySync.pushTimeEntries] rather
 * than retried.
 */
enum class TimeEntrySyncBlock {
    /** No employee is attached to the shift -- the insert trigger's own rule. */
    NEEDS_WORKER,
    /** The server refused it for some other reason a retry cannot fix. */
    SERVER_REJECTED
}

/**
 * True for a finished shift with nobody attached -- the one rule the
 * `time_entries` insert trigger enforces, and the one case this app can
 * know about without ever asking the server. Pushing one anyway is a
 * guaranteed, permanent 4xx: the same answer every single sync, forever,
 * until a person picks who worked it.
 *
 * Only asked of a finished shift -- a running one has no crew assignment
 * requirement yet, and [EntitySync.pushTimeEntries] never sends one anyway.
 */
fun needsWorkerAssignment(entry: TimeEntry): Boolean =
    !entry.isRunning && entry.employeeId == null

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
 * which of those types wraps it.
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
