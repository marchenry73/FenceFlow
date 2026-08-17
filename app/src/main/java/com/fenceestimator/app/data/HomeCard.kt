package com.fenceestimator.app.data

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
 */
enum class HomeCard(val label: String, val explains: String, val needsMoney: Boolean = false) {
    SCHEDULED_THIS_WEEK("Booked this week", "Jobs with a date in the next seven days"),
    WON_THIS_MONTH("Won this month", "Jobs the customer accepted"),
    COLLECTED_THIS_MONTH("Collected this month", "Money actually received", needsMoney = true),
    OUTSTANDING("Still owed", "Across every unpaid job", needsMoney = true),
    UNPAID_JOBS("Unpaid jobs", "Finished or accepted, not settled", needsMoney = true),
    HOURS_TO_APPROVE("Hours to approve", "Crew shifts waiting on you"),
    DRAFT_ESTIMATES("Drafts", "Started but never sent"),
    OVERRUNNING("Running late", "Past the day they were meant to finish");

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
