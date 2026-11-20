package com.fenceestimator.app.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * THE TRIAL EXTENSION MUST SAY WHAT IT WILL ACTUALLY DO.
 *
 * The dialog used to promise "counted from today". The live server rule, read
 * from pg_get_functiondef on 19 Nov 2026, is:
 *
 *     trial_ends_at = greatest(coalesce(trial_ends_at, now()), now())
 *                     + make_interval(days => days)
 *
 * which is "from today" ONLY when the trial has already ended. The case that
 * was being described wrongly -- a trial still running -- is the first test
 * here, with the owner's own company's real date.
 *
 * This file is a mirror of a server rule and will go stale silently if that
 * rule changes. That is the point of pinning both branches by name.
 */
class TrialExtensionTest {

    private val now: Instant = Instant.parse("2026-11-19T18:00:00Z")

    @Test
    fun `a trial still running has the days ADDED to its end date, not to today`() {
        // Legacy Solutions, really: running to 2 December when this was written.
        // 14 more days is the 16th, not the 3rd -- which is what the old
        // "counted from today" wording promised and the server never did.
        val end = Instant.parse("2026-12-02T04:59:59Z")
        val out = TrialExtension.outcome(currentEnd = end, days = 14, now = now)

        assertEquals(Instant.parse("2026-12-16T04:59:59Z"), out.newEnd)
        assertTrue("this is the case the old wording described wrongly", out.addedToRunningTrial)

        val fromToday = now.plus(14, ChronoUnit.DAYS)
        assertTrue(
            "if these ever match, the server rule changed to 'from today' and this file is stale",
            out.newEnd != fromToday
        )
    }

    @Test
    fun `a trial that has already ended restarts from today`() {
        // The branch the old comment was right about, kept so the fix does not
        // quietly break the case that already worked.
        val ended = Instant.parse("2026-10-27T00:00:00Z")
        val out = TrialExtension.outcome(currentEnd = ended, days = 30, now = now)

        assertEquals(now.plus(30, ChronoUnit.DAYS), out.newEnd)
        assertFalse("nothing was added to a date in the past", out.addedToRunningTrial)
    }

    @Test
    fun `a company with no trial date at all starts from today`() {
        // Summit Landscapes' shape: signed up, never given a date, locked out.
        val out = TrialExtension.outcome(currentEnd = null, days = 30, now = now)
        assertEquals(now.plus(30, ChronoUnit.DAYS), out.newEnd)
        assertFalse(out.addedToRunningTrial)
    }

    @Test
    fun `a trial ending this very second counts as ended`() {
        // greatest() takes now() when they are equal, so the boundary belongs
        // with "restart from today". Pinned because an off-by-one here is a
        // day of somebody's access.
        val out = TrialExtension.outcome(currentEnd = now, days = 1, now = now)
        assertEquals(now.plus(1, ChronoUnit.DAYS), out.newEnd)
        assertFalse(out.addedToRunningTrial)
    }

    @Test
    fun `one day and a long grant both land where the rule says`() {
        val end = Instant.parse("2026-12-02T04:59:59Z")
        assertEquals(
            Instant.parse("2026-12-03T04:59:59Z"),
            TrialExtension.outcome(end, 1, now).newEnd
        )
        assertEquals(
            Instant.parse("2027-03-02T04:59:59Z"),
            TrialExtension.outcome(end, 90, now).newEnd
        )
    }

    @Test
    fun `the quoted server rule still matches the arithmetic this file does`() {
        // Not a string check for its own sake: the quote is what a reader
        // compares against the database, so it has to name both halves of the
        // rule this class implements -- the greatest() and the coalesce().
        val rule = TrialExtension.SERVER_RULE
        assertTrue("the quoted rule no longer mentions greatest()", rule.contains("greatest("))
        assertTrue("the quoted rule no longer mentions coalesce()", rule.contains("coalesce(trial_ends_at"))
        assertTrue("the quoted rule no longer adds an interval of days", rule.contains("make_interval(days => days)"))
    }

    @Test
    fun `postgres timestamps parse, in both the shapes it renders`() {
        assertEquals(
            Instant.parse("2026-12-02T04:59:59Z"),
            TrialExtension.parse("2026-12-02T04:59:59Z")
        )
        assertEquals(
            "a space instead of the T, and an offset with no colon",
            Instant.parse("2026-12-02T04:59:59Z"),
            TrialExtension.parse("2026-12-02 04:59:59+00")
        )
    }

    @Test
    fun `an unreadable date answers null rather than taking the screen down`() {
        // This feeds the one screen that can let a locked-out company back in.
        assertNull(TrialExtension.parse(null))
        assertNull(TrialExtension.parse(""))
        assertNull(TrialExtension.parse("whenever"))
    }
}
