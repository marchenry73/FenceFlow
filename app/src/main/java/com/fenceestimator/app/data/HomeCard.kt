package com.fenceestimator.app.data

import com.fenceestimator.app.cloud.Permission

/**
 * The figures that can sit on the home screen.
 *
 * Which ones matter is genuinely different per business -- somebody chasing
 * cash watches what is owed, somebody with a full book watches the week ahead,
 * and a dashboard showing all of them shows none of them. So the set is chosen
 * rather than fixed, and the default is the four that suit most people starting
 * out.
 *
 * @param needsMoney true when the figure is money, so it can be hidden from
 *   anyone without permission to see it rather than left for a screen to
 *   remember.
 * @param needsAnyOf who the figure is for: shown to someone holding any one
 *   of these, and to everyone when empty. Declared here, once, for the same
 *   reason as [needsMoney]. The company picks the cards and every phone in it
 *   shows them, so a crew phone used to get "Hours to approve" (a queue it
 *   cannot open) and "Drafts" (office work) because the owner chose them for
 *   the owner. Money cards always include SEE_MONEY, whatever else is listed.
 */
enum class HomeCard(
    val label: String,
    val explains: String,
    val needsMoney: Boolean = false,
    val needsAnyOf: Set<Permission> = if (needsMoney) setOf(Permission.SEE_MONEY) else emptySet()
) {
    SCHEDULED_THIS_WEEK("Booked this week", "Jobs with a date in the next seven days"),
    // Selling is the office's side of the job; a salesperson has EDIT_JOBS
    // without money, a bookkeeper money without EDIT_JOBS, and both follow it.
    WON_THIS_MONTH("Won this month", "Jobs the customer accepted",
        needsAnyOf = setOf(Permission.EDIT_JOBS, Permission.SEE_MONEY)),
    COLLECTED_THIS_MONTH("Collected this month", "Money actually received", needsMoney = true),
    OUTSTANDING("Still owed", "Across every unpaid job", needsMoney = true),
    UNPAID_JOBS("Unpaid jobs", "Finished or accepted, not settled", needsMoney = true),
    // The tile opens the approvals queue; without APPROVE_TIME that screen
    // only says you cannot, and the count was every colleague's shift.
    HOURS_TO_APPROVE("Hours to approve", "Crew shifts waiting on you",
        needsAnyOf = setOf(Permission.APPROVE_TIME)),
    DRAFT_ESTIMATES("Drafts", "Started but never sent",
        needsAnyOf = setOf(Permission.EDIT_JOBS, Permission.SEE_MONEY)),
    // Whose day slips is for the people who move the calendar. The same line
    // as the "running late" attention item (HomeAudience.sees).
    OVERRUNNING("Running late", "Past the day they were meant to finish",
        needsAnyOf = setOf(Permission.SCHEDULE_AND_ASSIGN, Permission.EDIT_JOBS));

    /**
     * Whether someone holding [granted] gets this card. Signed out, a phone
     * holds every permission (working alone), so it gets every card it chose.
     */
    fun shownTo(granted: Set<Permission>): Boolean =
        (!needsMoney || Permission.SEE_MONEY in granted) &&
            (needsAnyOf.isEmpty() || needsAnyOf.any { it in granted })

    companion object {
        /** Sensible for somebody who has just installed it and set nothing up. */
        val DEFAULT_CSV: String = listOf(
            SCHEDULED_THIS_WEEK, WON_THIS_MONTH, COLLECTED_THIS_MONTH, OUTSTANDING
        ).joinToString(",") { it.name }

        fun parse(csv: String): List<HomeCard> = csv.split(",")
            .mapNotNull { name -> runCatching { valueOf(name.trim()) }.getOrNull() }
            .ifEmpty { parse(DEFAULT_CSV) }
    }
}
