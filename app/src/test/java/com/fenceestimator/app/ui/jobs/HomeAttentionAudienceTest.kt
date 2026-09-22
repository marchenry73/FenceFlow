package com.fenceestimator.app.ui.jobs

import com.fenceestimator.app.cloud.Permission
import com.fenceestimator.app.cloud.PermissionOverrides
import com.fenceestimator.app.cloud.UserRole
import com.fenceestimator.app.cloud.defaultPermissions
import com.fenceestimator.app.data.FieldChange
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Who "Needs attention" talks to (HomeAttention.kt).
 *
 * The owner's words: crew see only role-relevant attentions -- never hours
 * awaiting approval, never money, never office-only items. Every test runs
 * the same deliberately loud phone: one job for every kind of line the card
 * can carry, nine shifts waiting and a plan-change request open. The owner
 * must get all seven kinds from it (the planted failure: without that, an
 * empty crew card could just mean the data was too quiet to say anything).
 */
class HomeAttentionAudienceTest {

    private val now = 1_758_500_000_000L
    private val day = 86_400_000L
    private val workday = 8.0

    private val overrun = Job(
        id = 1, customerName = "Overrun", status = JobStatus.ACCEPTED,
        scheduledDate = now - 10 * day, estimatedDurationHours = 8.0
    )
    private val justApproved = Job(
        id = 2, customerName = "Approved", status = JobStatus.ACCEPTED,
        quoteApprovedAt = now - 3_600_000L
    )
    private val planChange = Job(id = 3, customerName = "Plan change", status = JobStatus.ACCEPTED)
    private val locateLapsed = Job(
        id = 4, customerName = "Locate", status = JobStatus.ACCEPTED,
        locateTicketNo = "A-1", locateExpiresAt = now - day
    )
    private val finishedUnpaid = Job(id = 5, customerName = "Unpaid", status = JobStatus.COMPLETED)
    private val staleDraft = Job(id = 6, customerName = "Draft", status = JobStatus.DRAFT, updatedAt = now - 30 * day)

    private val jobs = listOf(overrun, justApproved, planChange, locateLapsed, finishedUnpaid, staleDraft)
    private val openRequest = FieldChange(jobId = 3, isRequest = true)

    private fun kindsFor(permissions: Set<Permission>, isCrew: Boolean = false, pendingHours: Int = 9) =
        attentionFacts(
            jobs = jobs,
            pendingHours = pendingHours,
            pendingPlanChanges = listOf(openRequest),
            audience = HomeAudience.of(permissions, isCrew),
            workdayHours = workday,
            now = now
        ).map { it.kind }.toSet()

    @Test
    fun `the owner gets every kind from this phone -- planted failure for the quiet-data trap`() {
        assertEquals(AttentionKind.values().toSet(), kindsFor(Permission.ALL))
    }

    @Test
    fun `crew get the expired locate and nothing else`() {
        val crew = kindsFor(UserRole.CREW.defaultPermissions, isCrew = true)
        assertEquals(setOf(AttentionKind.LOCATE_EXPIRED), crew)
    }

    @Test
    fun `crew never get the shifts line, however many are waiting`() {
        val facts = attentionFacts(
            jobs, pendingHours = 9, pendingPlanChanges = emptyList(),
            audience = HomeAudience.of(UserRole.CREW.defaultPermissions, isCrew = true),
            workdayHours = workday, now = now
        )
        assertTrue(facts.none { it.kind == AttentionKind.SHIFTS_TO_APPROVE })
    }

    @Test
    fun `the crew card replaces the office card for the crew role only`() {
        assertFalse(HomeAudience.of(UserRole.CREW.defaultPermissions, isCrew = true).showsAttentionCard)
        assertTrue(HomeAudience.of(UserRole.FOREMAN.defaultPermissions, isCrew = false).showsAttentionCard)
    }

    @Test
    fun `a foreman gets the field and schedule lines, none of the money or selling`() {
        assertEquals(
            setOf(
                AttentionKind.RUNNING_LATE, AttentionKind.SHIFTS_TO_APPROVE,
                AttentionKind.PLAN_CHANGE, AttentionKind.LOCATE_EXPIRED
            ),
            kindsFor(UserRole.FOREMAN.defaultPermissions)
        )
    }

    @Test
    fun `a bookkeeper gets the money and selling lines, none of the approvals or the calendar`() {
        assertEquals(
            setOf(
                AttentionKind.QUOTE_APPROVED, AttentionKind.LOCATE_EXPIRED,
                AttentionKind.FINISHED_UNPAID, AttentionKind.STALE_DRAFT
            ),
            kindsFor(UserRole.ACCOUNTANT.defaultPermissions)
        )
    }

    @Test
    fun `sales without SEE_PAY or approvals still get what they sell`() {
        val sales = kindsFor(UserRole.SALES.defaultPermissions)
        assertTrue(AttentionKind.QUOTE_APPROVED in sales)
        assertTrue(AttentionKind.FINISHED_UNPAID in sales)
        assertFalse(AttentionKind.SHIFTS_TO_APPROVE in sales)
        assertFalse(AttentionKind.PLAN_CHANGE in sales)
    }

    @Test
    fun `a per-person grant moves one line and only that line`() {
        val crewWhoApproves = PermissionOverrides.resolve(UserRole.CREW, "+APPROVE_TIME")
        assertEquals(
            setOf(AttentionKind.LOCATE_EXPIRED, AttentionKind.SHIFTS_TO_APPROVE),
            kindsFor(crewWhoApproves, isCrew = true)
        )
    }

    @Test
    fun `no shifts waiting means no shifts line, even for the owner`() {
        assertFalse(AttentionKind.SHIFTS_TO_APPROVE in kindsFor(Permission.ALL, pendingHours = 0))
    }

    @Test
    fun `nobody signed in with no permissions read yet gets only the safety line`() {
        // SessionState.permissions is empty while a signed-in profile is unread.
        assertEquals(setOf(AttentionKind.LOCATE_EXPIRED), kindsFor(emptySet()))
    }

    @Test
    fun `every kind but the locate belongs to someone -- no line is shown to all by accident`() {
        val nobody = HomeAudience.of(emptySet(), isCrew = false)
        AttentionKind.values().filter { it != AttentionKind.LOCATE_EXPIRED }.forEach {
            assertFalse("$it is shown to someone with no permissions", nobody.sees(it))
        }
    }

    @Test
    fun `the shifts line carries the count and opens the queue, not a job`() {
        val shifts = attentionFacts(
            jobs, pendingHours = 9, pendingPlanChanges = emptyList(),
            audience = HomeAudience.of(Permission.ALL, isCrew = false), workdayHours = workday, now = now
        ).single { it.kind == AttentionKind.SHIFTS_TO_APPROVE }
        assertEquals(9, shifts.count)
        assertEquals(null, shifts.job)
    }
}
