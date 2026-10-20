package com.fenceestimator.app.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * THE ADMIN CONSOLE CONTROLS EVERY COMPANY ON FENCEFLOW, SO THIS GATE IS
 * TESTED THE WAY A LOCK IS TESTED: from the outside, trying to get in.
 *
 * The cases that matter are the ones where a wrong answer LEAKS: a crew phone
 * or an ordinary owner learning that a platform console exists at all. Those
 * must come back HIDDEN for every combination of the other facts, which is
 * why the first test sweeps all of them rather than picking two.
 */
class AdminGateTest {

    /** Every state a session can be in, so the sweeps below are exhaustive. */
    private val aalValues = listOf(null, "aal1", "aal2", "unexpected")

    @Test
    fun `a non-admin never sees the console, whatever the session has done`() {
        for (signed in listOf(true, false)) {
            for (cur in aalValues) {
                for (next in aalValues) {
                    assertEquals(
                        "signedIn=$signed aal=$cur next=$next",
                        AdminEntry.HIDDEN,
                        adminEntryFor(signed, isPlatformAdmin = false, aalCurrent = cur, aalNext = next)
                    )
                }
            }
        }
    }

    @Test
    fun `signed out never sees the console, even for an admin account`() {
        for (cur in aalValues) {
            for (next in aalValues) {
                assertEquals(
                    "aal=$cur next=$next",
                    AdminEntry.HIDDEN,
                    adminEntryFor(signedIn = false, isPlatformAdmin = true, aalCurrent = cur, aalNext = next)
                )
            }
        }
    }

    @Test
    fun `an admin who has done the second factor gets in`() {
        assertEquals(
            AdminEntry.OPEN,
            adminEntryFor(signedIn = true, isPlatformAdmin = true, aalCurrent = "aal2", aalNext = "aal2")
        )
    }

    /**
     * THE ORDINARY CASE: signed in with a password this morning, now wants the
     * console. A factor exists (next = aal2), so ask for the code.
     */
    @Test
    fun `an admin on a password-only session is asked for the code`() {
        assertEquals(
            AdminEntry.NEEDS_CODE,
            adminEntryFor(signedIn = true, isPlatformAdmin = true, aalCurrent = "aal1", aalNext = "aal2")
        )
    }

    /**
     * No factor to step up to. The server would refuse every admin call, so
     * saying "enter your code" would be a prompt with no right answer.
     */
    @Test
    fun `an admin with no authenticator is told to enrol, not asked for a code`() {
        assertEquals(
            AdminEntry.NEEDS_ENROLMENT,
            adminEntryFor(signedIn = true, isPlatformAdmin = true, aalCurrent = "aal1", aalNext = "aal1")
        )
    }

    /**
     * The read has not come back. He IS an admin, and admins are required to
     * hold a factor, so asking for the code is the better of the two wrong
     * answers: it costs a cancelled prompt, where "enrol an authenticator"
     * sends him to set up something he already has.
     */
    @Test
    fun `an unread assurance level asks for the code rather than claiming none exists`() {
        assertEquals(
            AdminEntry.NEEDS_CODE,
            adminEntryFor(signedIn = true, isPlatformAdmin = true, aalCurrent = null, aalNext = null)
        )
        assertNotEquals(
            AdminEntry.NEEDS_ENROLMENT,
            adminEntryFor(signedIn = true, isPlatformAdmin = true, aalCurrent = null, aalNext = null)
        )
    }

    /**
     * aal2 is the only thing that opens it. A value Supabase has never sent
     * must not be read as "good enough".
     */
    @Test
    fun `only aal2 opens the console`() {
        for (cur in listOf("aal1", "unexpected", "AAL2", "")) {
            assertNotEquals(
                "aalCurrent=$cur must not open the console",
                AdminEntry.OPEN,
                adminEntryFor(signedIn = true, isPlatformAdmin = true, aalCurrent = cur, aalNext = "aal2")
            )
        }
    }

    /**
     * Every combination resolves to exactly one answer, and all four are
     * reachable. A function that only ever returned HIDDEN would pass three
     * tests above; this one says it does not.
     */
    @Test
    fun `all four answers are reachable and nothing is left undecided`() {
        val seen = mutableSetOf<AdminEntry>()
        for (signed in listOf(true, false))
            for (admin in listOf(true, false))
                for (cur in aalValues)
                    for (next in aalValues)
                        seen += adminEntryFor(signed, admin, cur, next)

        assertEquals(
            "every answer should be reachable",
            setOf(AdminEntry.HIDDEN, AdminEntry.OPEN, AdminEntry.NEEDS_CODE, AdminEntry.NEEDS_ENROLMENT),
            seen
        )
    }
}
