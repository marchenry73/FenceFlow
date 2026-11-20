package com.fenceestimator.app.ui.admin

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * What giving a company N more days actually does to its trial end date.
 *
 * ------------------------------------------------------------------
 * WHY THIS EXISTS: THE DIALOG WAS TELLING HIM SOMETHING UNTRUE
 * ------------------------------------------------------------------
 * The confirmation read "counted from today", and the comment beside it
 * explained that the server "restarts from NOW rather than adding to a date in
 * the past". READ OFF THE LIVE FUNCTION, 19 Nov 2026:
 *
 *     trial_ends_at = greatest(coalesce(trial_ends_at, now()), now())
 *                     + make_interval(days => days)
 *
 * So the explanation is right only for a trial that has ALREADY ENDED. For one
 * still running it ADDS to the existing end date. Legacy Solutions runs to
 * 2 December; "Give 14 days" makes it 16 December, while the dialog promised a
 * date around the 3rd. That is a wrong statement about money-adjacent access,
 * made at the moment of pressing the button.
 *
 * Better wording would still be a sentence somebody has to reason from. The
 * dialog now shows THE RESULTING DATE, computed here by the server's own rule,
 * so there is nothing left to misread.
 *
 * THIS IS A MIRROR OF A SERVER RULE, which is the dangerous kind of code: it
 * can drift silently. It is kept honest three ways -- the rule is in one small
 * pure function instead of inside a Composable, [SERVER_RULE] quotes the SQL
 * it mirrors so a reader can compare them without leaving the file, and
 * TrialExtensionTest pins both branches with the live function's own wording
 * in its failure messages. If the server rule ever changes, the test is where
 * it should bite first.
 */
object TrialExtension {

    /**
     * The live SQL this mirrors, quoted so the two can be compared in one
     * place. Read from pg_get_functiondef on the production database.
     */
    const val SERVER_RULE: String =
        "trial_ends_at = greatest(coalesce(trial_ends_at, now()), now()) + make_interval(days => days)"

    /** What the extension will do, in the terms the dialog needs to say it. */
    data class Outcome(
        /** The new end instant, by the server's rule. */
        val newEnd: Instant,
        /**
         * True when the days are added to a trial still running, so the new
         * date is NOT "today plus days". This is the case the old wording got
         * wrong, and the only one where the distinction is visible.
         */
        val addedToRunningTrial: Boolean
    )

    /**
     * Apply the server's rule.
     *
     * [currentEnd] is the company's trial_ends_at, or null when it has none.
     * [now] is passed in rather than read, so the test is not a race and the
     * dialog and the confirmation cannot disagree by a tick.
     */
    fun outcome(currentEnd: Instant?, days: Int, now: Instant): Outcome {
        // greatest(coalesce(trial_ends_at, now()), now())
        val base = if (currentEnd != null && currentEnd.isAfter(now)) currentEnd else now
        // make_interval(days => N) on a timestamptz adds CALENDAR days in the
        // database's timezone, which is not the same instant as N x 86400
        // seconds when a daylight-saving change falls in between. CHECKED
        // against production, 19 Nov 2026: the database runs in UTC ("show
        // timezone" -> UTC), where a calendar day is exactly 86400 seconds, and
        // the two agreed to the second on all four cases tried -- including one
        // deliberately spanning the US spring change. If that database timezone
        // is ever moved off UTC, this line and the server part company by an
        // hour, which can move the DATE this dialog shows across midnight.
        return Outcome(
            newEnd = base.plusSeconds(days.toLong() * 86_400L),
            addedToRunningTrial = base != now
        )
    }

    /** The resulting date, as the phone's locale writes a date. */
    fun formatDate(instant: Instant, zone: ZoneId = ZoneId.systemDefault()): String =
        DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)
            .withLocale(Locale.getDefault())
            .withZone(zone)
            .format(instant)

    /**
     * Parse what the admin list carries, which is whatever Postgres rendered.
     *
     * Answers null rather than throwing on anything unexpected: this feeds a
     * confirmation dialog, and a crash there would take away the one screen
     * that can let a locked-out company back in.
     */
    fun parse(iso: String?): Instant? {
        if (iso.isNullOrBlank()) return null
        return runCatching { Instant.parse(iso) }
            .recoverCatching {
                // Postgres often renders "2026-12-02 04:59:59.123+00" -- a space
                // instead of the T, and an offset without a colon.
                val t = iso.trim().replace(' ', 'T')
                Instant.parse(if (t.endsWith("Z")) t else t.replace(Regex("([+-]\\d{2})$"), "$1:00"))
            }
            .getOrNull()
    }
}
