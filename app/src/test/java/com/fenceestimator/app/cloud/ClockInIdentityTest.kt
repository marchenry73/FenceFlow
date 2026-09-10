package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.Employee
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A shift belongs to whoever is holding the phone, not to whoever the job
 * happens to be assigned to.
 *
 * Before this existed, clockIn() took its identity from the job's own
 * assignedEmployeeId. Clock in on an unassigned job and you got a shift with
 * no employee and a zero rate -- one that looked completely ordinary in every
 * list, because nothing marked it as wrong. Three such shifts reached the
 * live database before anyone noticed.
 */
class ClockInIdentityTest {

    private fun crew(id: Long, name: String, rate: Double, email: String = "", profileId: String = "") =
        Employee(id = id, name = name, hourlyRate = rate, email = email, profileId = profileId)

    private val dave = crew(1, "Dave Mullins", 28.0, email = "dave@example.com", profileId = "uid-dave")
    private val sam = crew(2, "Sam Reyes", 24.0, email = "sam@example.com")
    private val roster = listOf(dave, sam)

    @Test
    fun `the signed-in person's own record wins by profile id`() {
        val result = ClockInIdentity.resolve(
            employees = roster,
            assignedEmployeeId = 2,
            signedInProfileId = "uid-dave",
            signedInEmail = null
        )
        assertEquals(ClockInIdentity.Result.Resolved(1, 28.0), result)
    }

    @Test
    fun `no profile id match falls back to email`() {
        val result = ClockInIdentity.resolve(
            employees = roster,
            assignedEmployeeId = null,
            signedInProfileId = null,
            signedInEmail = "sam@example.com"
        )
        assertEquals(ClockInIdentity.Result.Resolved(2, 24.0), result)
    }

    @Test
    fun `the signed-in person's own record wins over the job's assignment`() {
        // Dave is signed in but the job is assigned to Sam -- an owner or
        // foreman clocking themselves in on someone else's ticket. The shift
        // is still Dave's.
        val result = ClockInIdentity.resolve(
            employees = roster,
            assignedEmployeeId = 2,
            signedInProfileId = "uid-dave",
            signedInEmail = "dave@example.com"
        )
        assertEquals(ClockInIdentity.Result.Resolved(1, 28.0), result)
    }

    @Test
    fun `falls back to the job's assignment when the signed-in person has no record of their own`() {
        // The shared-phone case: an owner with no crew record clocking in
        // whoever is actually assigned to the job.
        val result = ClockInIdentity.resolve(
            employees = roster,
            assignedEmployeeId = 2,
            signedInProfileId = "uid-owner-with-no-crew-record",
            signedInEmail = "owner@example.com"
        )
        assertEquals(ClockInIdentity.Result.Resolved(2, 24.0), result)
    }

    @Test
    fun `nobody assigned and nobody signed in as crew clocks in nobody`() {
        // The exact bug this exists to close: an unassigned job, and a phone
        // signed in as somebody with no employee record. There must be no
        // Resolved result here -- the caller has to refuse and say why,
        // never record a shift with a null employee and a zero rate.
        val result = ClockInIdentity.resolve(
            employees = roster,
            assignedEmployeeId = null,
            signedInProfileId = "uid-owner-with-no-crew-record",
            signedInEmail = "owner@example.com"
        )
        assertEquals(ClockInIdentity.Result.NoIdentity, result)
        assertTrue(result !is ClockInIdentity.Result.Resolved)
    }

    @Test
    fun `signed out with nothing assigned also refuses`() {
        val result = ClockInIdentity.resolve(
            employees = roster,
            assignedEmployeeId = null,
            signedInProfileId = null,
            signedInEmail = null
        )
        assertEquals(ClockInIdentity.Result.NoIdentity, result)
    }

    @Test
    fun `an assignment to someone no longer on the roster does not resolve`() {
        val result = ClockInIdentity.resolve(
            employees = roster,
            assignedEmployeeId = 99,
            signedInProfileId = null,
            signedInEmail = null
        )
        assertEquals(ClockInIdentity.Result.NoIdentity, result)
    }
}
