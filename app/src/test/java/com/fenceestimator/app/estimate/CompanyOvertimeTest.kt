package com.fenceestimator.app.estimate

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE COMPANY'S OWN OVERTIME RULE, now that the phone reads it.
 *
 * The office has let a company set ot_after_hours / ot_multiplier since the
 * payroll panel was built; the phone hardcoded the federal 40 and 1.5. No
 * company had set an override, so nothing disagreed -- it would have the first
 * time one did, with the office's estimated pay and the crew member's own pay
 * card showing different money for the same week and neither able to say why.
 *
 * What is pinned here is the reading of the setting, not the week-bucketing
 * (SatelliteExtentTest's neighbour CrewPayTest already owns that): that a real
 * override is obeyed, that a nonsense one is not, and that absence means the
 * federal rule rather than zero.
 */
class CompanyOvertimeTest {

    @Test
    fun `no override means the federal rule, exactly as before`() {
        assertEquals(40.0, CrewOvertime.afterHoursOf(null), 0.0)
        assertEquals(1.5, CrewOvertime.multiplierOf(null), 0.0)
        assertEquals(CrewOvertime.AFTER_HOURS, CrewOvertime.afterHoursOf(null), 0.0)
        assertEquals(CrewOvertime.MULTIPLIER, CrewOvertime.multiplierOf(null), 0.0)
    }

    @Test
    fun `a real override is obeyed`() {
        assertEquals(35.0, CrewOvertime.afterHoursOf(35.0), 0.0)
        assertEquals(44.0, CrewOvertime.afterHoursOf(44.0), 0.0)
        assertEquals(2.0, CrewOvertime.multiplierOf(2.0), 0.0)
        assertEquals(1.25, CrewOvertime.multiplierOf(1.25), 0.0)
        // A multiplier of exactly 1 is a company that pays no premium. That is
        // a decision, not a mistake, and it must travel.
        assertEquals(1.0, CrewOvertime.multiplierOf(1.0), 0.0)
    }

    @Test
    fun `a figure that is not a rule is refused, not obeyed`() {
        // Zero hours would make EVERY hour overtime; a negative multiplier
        // would pay a premium backwards. Both are "nobody set this", not
        // instructions.
        for (bad in listOf(0.0, -1.0, Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY)) {
            assertEquals("afterHours accepted $bad", 40.0, CrewOvertime.afterHoursOf(bad), 0.0)
            assertEquals("multiplier accepted $bad", 1.5, CrewOvertime.multiplierOf(bad), 0.0)
        }
    }

    @Test
    fun `the split follows the company's threshold`() {
        // 45 hours at the federal rule is 40 + 5.
        val (regFederal, otFederal) = CrewOvertime.split(45.0, CrewOvertime.afterHoursOf(null))
        assertEquals(40.0, regFederal, 0.0)
        assertEquals(5.0, otFederal, 0.0)

        // The same 45 hours at a company that starts overtime at 35.
        val (reg35, ot35) = CrewOvertime.split(45.0, CrewOvertime.afterHoursOf(35.0))
        assertEquals(35.0, reg35, 0.0)
        assertEquals(10.0, ot35, 0.0)

        // POSITIVE CONTROL: the two answers are genuinely different, so the
        // threshold above is load-bearing rather than being ignored.
        assertNotEquals(otFederal, ot35, 0.0001)
    }

    @Test
    fun `the money moves by the amount the override says it should`() {
        // 45 hours at $20. Federal: 40 straight + 5 at 1.5x = 800 + 150 = 950.
        // At 35/2.0:        35 straight + 10 at 2.0x = 700 + 400 = 1100.
        val rate = 20.0
        fun weekPay(hours: Double, after: Double?, mult: Double?): Double {
            val (reg, ot) = CrewOvertime.split(hours, CrewOvertime.afterHoursOf(after))
            return reg * rate + ot * rate * CrewOvertime.multiplierOf(mult)
        }
        assertEquals(950.0, weekPay(45.0, null, null), 0.0001)
        assertEquals(1100.0, weekPay(45.0, 35.0, 2.0), 0.0001)
        // And a week under any threshold is straight time either way.
        assertEquals(600.0, weekPay(30.0, null, null), 0.0001)
        assertEquals(600.0, weekPay(30.0, 35.0, 2.0), 0.0001)
    }

    @Test
    fun `CANARY -- ignoring the override would be caught by the figures above`() {
        // If afterHoursOf and multiplierOf simply returned the constants, the
        // 1100 case would come back as 950. Said out loud so the assertion is
        // known to discriminate rather than to agree by coincidence.
        val rate = 20.0
        val (reg, ot) = CrewOvertime.split(45.0, CrewOvertime.AFTER_HOURS)
        val ignoringTheOverride = reg * rate + ot * rate * CrewOvertime.MULTIPLIER
        assertEquals(950.0, ignoringTheOverride, 0.0001)
        assertTrue(
            "the override and the default produce the same money, so the test above proves nothing",
            kotlin.math.abs(ignoringTheOverride - 1100.0) > 1.0
        )
    }
}
