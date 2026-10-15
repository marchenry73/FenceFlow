package com.fenceestimator.app.ui.jobs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * THE OWNER COULD NOT MOVE A JOB'S DATE AND NOTHING SAID WHY.
 *
 * He reported it as a range -- "push the job however far I need" -- and there
 * is no range: neither picker sets minDate or maxDate. The button was
 * disabled, because a signed-in phone whose profile has not been read yet is
 * given NO permissions at all, deliberately. The bug was that all three
 * reasons for a disabled button looked identical.
 *
 * The case that matters most is NOT_CONNECTED winning over CHECKING: those
 * are the two that both come from accessKnown being false, and telling
 * somebody on a dead signal to "wait a moment" is a spinner that never ends.
 */
class ScheduleLockTest {

    @Test
    fun `with the permission there is no lock at all`() {
        assertNull(scheduleLockReason(canSchedule = true, signedIn = true, accessKnown = true, accessUnavailable = false))
        // ...and the session facts cannot conjure a lock out of a real capability.
        assertNull(scheduleLockReason(canSchedule = true, signedIn = true, accessKnown = false, accessUnavailable = true))
    }

    @Test
    fun `signed in and the profile has not arrived yet reads as CHECKING`() {
        assertEquals(
            ScheduleLockReason.CHECKING,
            scheduleLockReason(canSchedule = false, signedIn = true, accessKnown = false, accessUnavailable = false)
        )
    }

    /**
     * THE ONE THAT MATTERS. accessUnavailable is the specific half of
     * accessKnown being false: the profile could not be fetched, and is being
     * retried. Reporting CHECKING here would be a wait that never resolves,
     * and would send him looking at the job rather than at his signal.
     */
    @Test
    fun `cannot reach the profile beats still waiting for it`() {
        assertEquals(
            ScheduleLockReason.NOT_CONNECTED,
            scheduleLockReason(canSchedule = false, signedIn = true, accessKnown = false, accessUnavailable = true)
        )
        // CONTROL: the only thing changed between this and the test above is
        // accessUnavailable, and the answer moved. So the flag is load-bearing
        // rather than the two cases agreeing by coincidence.
        assertNotEquals(
            scheduleLockReason(canSchedule = false, signedIn = true, accessKnown = false, accessUnavailable = true),
            scheduleLockReason(canSchedule = false, signedIn = true, accessKnown = false, accessUnavailable = false)
        )
    }

    @Test
    fun `profile read and the account genuinely may not schedule`() {
        assertEquals(
            ScheduleLockReason.NO_PERMISSION,
            scheduleLockReason(canSchedule = false, signedIn = true, accessKnown = true, accessUnavailable = false)
        )
    }

    /**
     * Signed out is Permission.ALL, so a signed-out person without the
     * capability should not exist. If it ever does it is a denial, not a
     * wait: there is no profile coming that would change the answer, and a
     * spinner would hang for ever.
     */
    @Test
    fun `signed out and somehow refused is a denial, never a wait`() {
        for (known in listOf(true, false)) for (unavailable in listOf(true, false)) {
            assertEquals(
                "signedIn=false accessKnown=$known accessUnavailable=$unavailable",
                ScheduleLockReason.NO_PERMISSION,
                scheduleLockReason(canSchedule = false, signedIn = false, accessKnown = known, accessUnavailable = unavailable)
            )
        }
    }

    /**
     * Every combination resolves to exactly one answer, and the three locked
     * reasons are all actually reachable. A function that only ever returned
     * NO_PERMISSION would pass several tests above; this one says it does not.
     */
    @Test
    fun `all three reasons are reachable and nothing is left undecided`() {
        val seen = mutableSetOf<ScheduleLockReason?>()
        for (can in listOf(true, false))
            for (signed in listOf(true, false))
                for (known in listOf(true, false))
                    for (unavailable in listOf(true, false))
                        seen += scheduleLockReason(can, signed, known, unavailable)

        assertEquals(
            "every reason plus 'not locked' should be reachable",
            setOf(null, ScheduleLockReason.CHECKING, ScheduleLockReason.NOT_CONNECTED, ScheduleLockReason.NO_PERMISSION),
            seen
        )
    }
}
