package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.Employee
import com.fenceestimator.app.data.TimeEntry
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Nobody signs off the shift that pays them.
 *
 * A crew lead approves their team -- that is what makes them a lead. The rule
 * they cannot escape is approving their own hours, whatever their role, because
 * that is what lets a timesheet be shown to an accountant, or to the person
 * being paid, without an argument about who approved it.
 */
class OwnWorkTest {

    private fun crew(id: Long, name: String, email: String = "") =
        Employee(id = id, name = name, email = email)

    private fun shift(employeeId: Long?) =
        TimeEntry(jobId = 1, employeeId = employeeId, startedAt = 0L, endedAt = 3_600_000L)

    private val dave = crew(1, "Dave Mullins", "dave@example.com")
    private val sam = crew(2, "Sam Reyes", "sam@example.com")
    private val crewList = listOf(dave, sam)

    @Test
    fun `your own shift is recognised by email`() {
        assertTrue(OwnWork.isOwnShift(shift(1), crewList, "dave@example.com"))
    }

    @Test
    fun `somebody else's shift is not yours`() {
        assertFalse(OwnWork.isOwnShift(shift(2), crewList, "dave@example.com"))
    }

    @Test
    fun `email matching ignores case and spacing`() {
        // People type their address inconsistently, and a lead who could approve
        // their own shift because of a capital letter is not a control.
        assertTrue(OwnWork.isOwnShift(shift(1), crewList, "  DAVE@Example.com "))
    }

    @Test
    fun `a crew record with no email falls back to the name`() {
        val noEmail = listOf(crew(3, "Pat Doyle"))
        assertTrue(
            OwnWork.isOwnShift(shift(3), noEmail, signedInEmail = null, signedInName = "Pat Doyle")
        )
    }

    @Test
    fun `a shift with nobody attached belongs to nobody`() {
        assertFalse(OwnWork.isOwnShift(shift(null), crewList, "dave@example.com"))
    }

    @Test
    fun `a shift for someone no longer on the crew list is not yours`() {
        assertFalse(OwnWork.isOwnShift(shift(99), crewList, "dave@example.com"))
    }

    @Test
    fun `signed out means the rule does not apply`() {
        // One person working alone on their own phone. There is nobody else to
        // approve anything, so blocking them would just break the app.
        assertFalse(OwnWork.isOwnShift(shift(1), crewList, signedInEmail = null))
    }

    @Test
    fun `an unidentifiable person is not blocked`() {
        // Deliberate, and the known limit of matching this way. A crew record
        // with no email and a name that does not match cannot be recognised.
        // Failing the other way would stop anyone approving anything the moment
        // one crew record was missing an address -- see the note in OwnWork.
        val stranger = listOf(crew(4, "Unknown Person"))
        assertFalse(
            OwnWork.isOwnShift(shift(4), stranger, "dave@example.com", "Dave Mullins")
        )
    }

    @Test
    fun `email wins over name when both are present`() {
        // Two people can share a name; an address is the stronger signal, so a
        // name collision must not make somebody else's shift look like yours.
        val namesake = listOf(crew(5, "Dave Mullins", "other.dave@example.com"))
        assertFalse(
            OwnWork.isOwnShift(shift(5), namesake, "dave@example.com", "Dave Mullins")
        )
    }
}
