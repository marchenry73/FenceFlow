package com.fenceestimator.app.ui.jobs

/**
 * WHY THE JOB DATE WILL NOT MOVE, when it will not move.
 *
 * The owner reported it as a date range: "need to be able to push the job to
 * however far I need it for". It is not a range -- neither date picker has a
 * minDate or a maxDate, and the office sends the date it is given. The button
 * is simply DISABLED, and said nothing about why.
 *
 * It is disabled because SessionManager answers "what may this person do"
 * with an EMPTY SET while they are signed in and their profile has not been
 * read yet:
 *
 *     !signedIn    -> Permission.ALL      // solo owner, no account
 *     !accessKnown -> emptySet()          // signed in, profile unread: nothing
 *     else         -> resolve(role, overrides)
 *
 * That is the right call and the comment there says why -- guessing
 * generously is how a crew phone briefly became an owner. But it means an
 * OWNER sees every schedule control greyed out during the moment before the
 * profile arrives, and for as long as it cannot be fetched at all
 * ([accessUnavailable] is "could not be reached -- temporary, and being
 * retried"). On a bad signal that moment is the whole visit.
 *
 * So the three cases have to be told apart, because they want three different
 * things from the person looking at them:
 *
 *   CHECKING       wait a second, it is about to work
 *   NOT_CONNECTED  it is the signal, not your account; it will come back
 *   NO_PERMISSION  it is your account; ask an owner or foreman
 *
 * Reporting all three as one grey button breaks the rule this project holds
 * everywhere else: every visible control works, says why it doesn't, or is
 * not there. It also sent the owner hunting for a date limit that was never
 * there.
 *
 * Pure, and in its own file, so the decision can be tested without a phone --
 * which is where this project's bugs have consistently NOT been.
 */
enum class ScheduleLockReason {
    /** The profile is on its way. Momentary, and about to resolve itself. */
    CHECKING,

    /** The profile could not be fetched. Nothing to do with this account. */
    NOT_CONNECTED,

    /** Read, and this account genuinely may not schedule. */
    NO_PERMISSION,
}

/**
 * Why the schedule controls are locked, or null when they are not.
 *
 * [canSchedule] is the capability itself (SCHEDULE_AND_ASSIGN). The other
 * three are the session facts that explain a false one.
 *
 * Order matters: "not connected" is checked before "not read", because
 * accessUnavailable is the specific, actionable half of accessKnown being
 * false. Reporting CHECKING to somebody whose phone has no signal would be a
 * spinner that never finishes.
 */
fun scheduleLockReason(
    canSchedule: Boolean,
    signedIn: Boolean,
    accessKnown: Boolean,
    accessUnavailable: Boolean,
): ScheduleLockReason? = when {
    canSchedule -> null
    // Signed out is Permission.ALL, so a signed-out person with no capability
    // should be impossible. If it ever happens, it is a real denial rather
    // than a wait -- there is no profile coming to change the answer.
    !signedIn -> ScheduleLockReason.NO_PERMISSION
    accessUnavailable -> ScheduleLockReason.NOT_CONNECTED
    !accessKnown -> ScheduleLockReason.CHECKING
    else -> ScheduleLockReason.NO_PERMISSION
}
