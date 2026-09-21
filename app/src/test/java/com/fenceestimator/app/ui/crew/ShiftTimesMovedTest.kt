package com.fenceestimator.app.ui.crew

import com.fenceestimator.app.data.TimeEntry
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What counts as a correction, and what is just the dialog's own rounding.
 *
 * The review dialog's Start and End fields are HH:mm. A shift the clock
 * recorded at 06:14:37 comes back out of an untouched field as 06:14:00, so
 * an exact comparison would call every single approval a correction: it would
 * demand a reason for signing off an ordinary day, and file a correction
 * against a foreman who changed nothing. The office's own datetime-local
 * inputs round the same way -- 5 of the 9 live shifts move their seconds on a
 * round trip -- so this is a known shape, not a theory.
 */
class ShiftTimesMovedTest {

    private val hour = 3_600_000L

    /** 2026-09-19 18:00:37 local-ish, deliberately carrying seconds. */
    private val clockIn = 1_758_312_037_000L

    private fun shift(started: Long = clockIn, ended: Long? = clockIn + 14 * hour) =
        TimeEntry(jobId = 1, employeeId = 7L, startedAt = started, endedAt = ended)

    /** What the dialog produces from an untouched field: same minute, seconds zeroed. */
    private fun toTheMinute(millis: Long) = millis - (millis % 60_000L)

    @Test
    fun `an untouched dialog is not a correction`() {
        val entry = shift()
        assertFalse(
            "approving an ordinary day must not be filed as a correction",
            shiftTimesMoved(entry, toTheMinute(entry.startedAt), toTheMinute(entry.endedAt!!))
        )
    }

    @Test
    fun `PLANTED FAILURE -- an exact comparison would call that untouched dialog a correction`() {
        // The bug this function exists to avoid, stated as an assertion: the
        // values really do differ, and only the minute rounding saves them.
        val entry = shift()
        assertTrue(
            "the fixture must actually carry seconds, or the test above proves nothing",
            toTheMinute(entry.startedAt) != entry.startedAt
        )
        assertTrue(toTheMinute(entry.endedAt!!) != entry.endedAt)
    }

    @Test
    fun `a clock left running overnight, corrected to eight hours, is a correction`() {
        val entry = shift()
        val newEnd = toTheMinute(entry.startedAt) + 8 * hour
        assertTrue(shiftTimesMoved(entry, toTheMinute(entry.startedAt), newEnd))
    }

    @Test
    fun `one minute either way still counts`() {
        val entry = shift()
        val start = toTheMinute(entry.startedAt)
        assertTrue(shiftTimesMoved(entry, start + 60_000L, toTheMinute(entry.endedAt!!)))
        assertTrue(shiftTimesMoved(entry, start, toTheMinute(entry.endedAt!!) - 60_000L))
    }

    @Test
    fun `a still-running shift has no finish to correct`() {
        val running = shift(ended = null)
        assertFalse(shiftTimesMoved(running, toTheMinute(running.startedAt), null))
        // Even offered a finish time, a shift with no clock-out is not a
        // correction -- the server refuses one outright for the same reason.
        assertFalse(shiftTimesMoved(running, toTheMinute(running.startedAt), clockIn + 8 * hour))
    }

    @Test
    fun `a null start is a correction, not silently ignored`() {
        // Should never reach here (the dialog disables Approve on an
        // unparseable time), but a null must not read as "unchanged".
        val entry = shift()
        assertTrue(shiftTimesMoved(entry, null, toTheMinute(entry.endedAt!!)))
    }
}
