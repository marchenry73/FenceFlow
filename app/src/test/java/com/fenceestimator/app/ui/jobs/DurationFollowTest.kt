package com.fenceestimator.app.ui.jobs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * When the job screen may save the computed install hours over the stored
 * ones ([durationFollowStep]).
 *
 * The old rule saved whenever the computed figure differed from the stored
 * one, the moment the screen opened, on every phone. On a crew handset that
 * write went up with the crew's whole copy of the job: 4598150b went from the
 * office's 4 hours to 93.33 with nobody touching anything.
 */
class DurationFollowTest {

    /** The rule this replaces, restated so each test can show it would have fired. */
    private fun oldRuleWrites(computed: Double, stored: Double, manuallySet: Boolean) =
        !manuallySet && computed > 0.0 && kotlin.math.abs(computed - stored) > 0.005

    @Test
    fun `opening a job never saves a computed figure`() {
        val step = durationFollowStep(baseline = null, computed = 93.33, stored = 4.0, manuallySet = false, mayWrite = true)
        assertNull(step.write)
        assertEquals(93.33, step.baseline, 0.001)
        // Planted: the old rule saved exactly this on open.
        assertTrue(oldRuleWrites(93.33, 4.0, manuallySet = false))
    }

    @Test
    fun `a crew phone never saves one, even after the drawing changes`() {
        val step = durationFollowStep(baseline = 8.0, computed = 12.0, stored = 8.0, manuallySet = false, mayWrite = false)
        assertNull(step.write)
        assertEquals(12.0, step.baseline, 0.001)
        assertTrue(oldRuleWrites(12.0, 8.0, manuallySet = false))
    }

    @Test
    fun `a change made while the job is open follows the footage on a phone that may reschedule`() {
        // What the auto-follow exists for: lengthen the fence, the hours follow.
        val step = durationFollowStep(baseline = 8.0, computed = 12.0, stored = 8.0, manuallySet = false, mayWrite = true)
        assertEquals(12.0, step.write!!, 0.001)
        assertEquals(12.0, step.baseline, 0.001)
    }

    @Test
    fun `hours somebody typed are never overwritten`() {
        val step = durationFollowStep(baseline = 8.0, computed = 12.0, stored = 6.0, manuallySet = true, mayWrite = true)
        assertNull(step.write)
    }

    @Test
    fun `an unchanged figure writes nothing, even if the stored one differs`() {
        // The office typed 4 on the dashboard; this phone computes 93.33 and
        // has done since it opened the job. Nothing here changed.
        val step = durationFollowStep(baseline = 93.33, computed = 93.33, stored = 4.0, manuallySet = false, mayWrite = true)
        assertNull(step.write)
    }

    @Test
    fun `a change that lands on the stored figure writes nothing`() {
        val step = durationFollowStep(baseline = 8.0, computed = 12.0, stored = 12.0, manuallySet = false, mayWrite = true)
        assertNull(step.write)
        assertEquals(12.0, step.baseline, 0.001)
    }

    @Test
    fun `a drawing emptied to nothing does not save zero hours`() {
        val step = durationFollowStep(baseline = 8.0, computed = 0.0, stored = 8.0, manuallySet = false, mayWrite = true)
        assertNull(step.write)
    }
}

/**
 * The one case where opening a job DOES save a computed figure: a job whose
 * estimate has never been set at all.
 *
 * Nobody chose zero. There is no office figure to protect, no disagreement to
 * resolve, and until something else happened to change in the same session the
 * screen simply showed no estimated time. Everything else about the rule is
 * unchanged, and the test above -- the 4-hour job that became 93.33 -- still
 * holds, which is what the planted failures here prove.
 */
class DurationFirstEmissionTest {

    @Test
    fun `a job with no estimate at all gets one on open`() {
        val step = durationFollowStep(baseline = null, computed = 12.5, stored = 0.0, manuallySet = false, mayWrite = true)
        assertEquals(12.5, step.write)
        assertEquals(12.5, step.baseline, 0.001)
    }

    @Test
    fun `PLANTED FAILURE the incident case still writes nothing on open`() {
        // 4598150b: the office said 4 hours, this phone worked out 93.33.
        val step = durationFollowStep(baseline = null, computed = 93.33, stored = 4.0, manuallySet = false, mayWrite = true)
        assertNull("opening a job overwrote a figure somebody else put there", step.write)
    }

    @Test
    fun `a crew phone still writes nothing, even to an empty estimate`() {
        val step = durationFollowStep(baseline = null, computed = 12.5, stored = 0.0, manuallySet = false, mayWrite = false)
        assertNull(step.write)
    }

    @Test
    fun `a figure somebody typed is not replaced, even when the stored one is zero`() {
        val step = durationFollowStep(baseline = null, computed = 12.5, stored = 0.0, manuallySet = true, mayWrite = true)
        assertNull(step.write)
    }

    @Test
    fun `nothing is written when there is nothing to write`() {
        assertNull(durationFollowStep(baseline = null, computed = 0.0, stored = 0.0, manuallySet = false, mayWrite = true).write)
    }
}
