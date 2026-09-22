package com.fenceestimator.app.notify

import com.fenceestimator.app.cloud.SessionState
import com.fenceestimator.app.cloud.UserRole
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * "Running late: <customer>" is for whoever can move the job. The watcher
 * sent it to every phone on the crew channel -- for every late job the phone
 * held, which before the crew scope was the whole company -- while the home
 * screen had already made the same line office-only (HomeAudience).
 */
class OverrunAlertAudienceTest {

    private fun signedIn(role: UserRole, overrides: String = "") =
        SessionState(signedIn = true, role = role, permissionOverrides = overrides, accessKnown = true, resolved = true)

    @Test
    fun `crew are never told a job is running late`() {
        assertFalse(overrunAlertsFor(signedIn(UserRole.CREW)))
    }

    @Test
    fun `whoever can reschedule or edit the job is -- the positive control`() {
        assertTrue(overrunAlertsFor(signedIn(UserRole.OWNER)))
        assertTrue(overrunAlertsFor(signedIn(UserRole.MANAGER)))
        assertTrue(overrunAlertsFor(signedIn(UserRole.FOREMAN)))
        assertTrue(overrunAlertsFor(signedIn(UserRole.SALES)))
    }

    @Test
    fun `money alone is not the office's scheduling -- the accountant is not told`() {
        assertFalse(overrunAlertsFor(signedIn(UserRole.ACCOUNTANT)))
    }

    @Test
    fun `a capability, not a role name -- overrides move someone either way`() {
        assertTrue(overrunAlertsFor(signedIn(UserRole.CREW, "+EDIT_JOBS")))
        assertTrue(overrunAlertsFor(signedIn(UserRole.CREW, "+SCHEDULE_AND_ASSIGN")))
        assertFalse(overrunAlertsFor(signedIn(UserRole.FOREMAN, "-SCHEDULE_AND_ASSIGN")))
    }

    @Test
    fun `signed in but not read yet is nothing, working alone is everything`() {
        assertFalse(overrunAlertsFor(SessionState(signedIn = true, role = UserRole.OWNER, accessKnown = false, resolved = true)))
        assertTrue(overrunAlertsFor(SessionState(signedIn = false, role = UserRole.CREW, resolved = true)))
    }

    @Test
    fun `the same rule as the home screen's running-late line`() {
        // HomeAudience.sees(RUNNING_LATE) is canScheduleAndAssign || canEditJobs;
        // two rules for one alert is how a phone and its own home screen disagree.
        for (role in UserRole.values()) {
            val s = signedIn(role)
            val home = com.fenceestimator.app.ui.jobs.HomeAudience.of(s.permissions, isCrew = role == UserRole.CREW)
                .sees(com.fenceestimator.app.ui.jobs.AttentionKind.RUNNING_LATE)
            assertEquals("role $role", home, overrunAlertsFor(s))
        }
    }

    @Test
    fun `the watcher asks the rule, waits for a settled session, and reads only visible jobs`() {
        val source = File("src/main/java/com/fenceestimator/app/notify/OverdueWatcher.kt").readText()
        val check = source.substring(source.indexOf("suspend fun checkOnce()"), source.indexOf("private suspend fun settledSession()"))
        assertTrue("checkOnce no longer asks overrunAlertsFor", check.contains("overrunAlertsFor("))
        assertTrue("checkOnce judges an unsettled session", check.contains("settledSession()"))
        assertFalse("checkOnce reads every job, kept ones included", check.contains("getAllJobs()"))
        assertTrue(check.contains("getVisibleJobs()"))
        val weekly = File("src/main/java/com/fenceestimator/app/notify/WeeklySummary.kt").readText()
        assertFalse("the Monday digest counts jobs this person was taken off", weekly.contains("getAllJobs()"))
    }
}
