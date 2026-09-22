package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.Job
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which jobs a crew phone hides when the crew door stops returning them, and
 * which come back ([planJobHolds]). The rules that matter, each with the
 * wrong version beside it:
 *  - only a definite "you see only your jobs" hides anything -- an unanswered
 *    question never does;
 *  - a job made here and never sent is not the cloud's to take away;
 *  - an empty door while the server says "you are on jobs" hides nothing
 *    (a suspended company's door answers empty);
 *  - seeing everything, by capability or because the server has no scope
 *    yet, brings every held job back;
 *  - a pass that decides what the last one did plans no write at all, so it
 *    cannot wake another pass through the Room change feed.
 *
 * Deleting is not among the outcomes at all: the plan only ever names jobs to
 * hide or bring back.
 */
class JobHoldPlanTest {

    private val scoped = JobScope.Scoped(linked = true, visible = 2, pendingRequests = 0)

    /** A job this phone pulled from the cloud (stamped, as toLocalJob stamps it). */
    private fun pulled(syncId: String, heldAt: Long? = null) =
        Job(id = syncId.hashCode().toLong(), syncId = syncId, updatedAt = 1_000L, lastSyncedAt = 1_000L, accessEndedAt = heldAt)

    private fun cloud(syncId: String, deleted: Boolean = false) =
        CloudJob(syncId = syncId, companyId = "co", deletedAt = if (deleted) "2026-09-22T10:00:00+00:00" else null)

    private val mine = pulled("mine")
    private val taken = pulled("taken-off")
    private val door = listOf(cloud("mine"), cloud("other-mine"))

    // ---- scoped ----

    @Test
    fun `a job the door stopped returning is hidden, the rest are left`() {
        val plan = planJobHolds(listOf(mine, taken), door, MoneyScope.DENIED, scoped)
        assertEquals(setOf("taken-off"), plan.hide)
        assertTrue(plan.unhide.isEmpty())
        assertFalse(plan.unhideAll)
    }

    @Test
    fun `a held job the door returns again comes back`() {
        val plan = planJobHolds(listOf(pulled("mine", heldAt = 500L)), door, MoneyScope.DENIED, scoped)
        assertEquals(setOf("mine"), plan.unhide)
        assertTrue(plan.hide.isEmpty())
    }

    @Test
    fun `a job made here and never sent stays in the list`() {
        val madeHere = Job(syncId = "made-here", updatedAt = 2_000L, lastSyncedAt = null, crewBase = null)
        assertTrue(planJobHolds(listOf(madeHere), door, MoneyScope.DENIED, scoped).hide.isEmpty())
        // Planted failure: the same job with a crew snapshot -- so it was taken
        // from the cloud once -- is hidden. The stamp/snapshot is what decides.
        assertEquals(
            setOf("made-here"),
            planJobHolds(listOf(madeHere.copy(crewBase = "{}")), door, MoneyScope.DENIED, scoped).hide
        )
    }

    @Test
    fun `an unlinked login is on no job, and has everything hidden`() {
        val unlinked = JobScope.Scoped(linked = false, visible = 0, pendingRequests = 0)
        assertEquals(setOf("mine", "taken-off"), planJobHolds(listOf(mine, taken), emptyList(), MoneyScope.DENIED, unlinked).hide)
    }

    @Test
    fun `an empty door while the server says you are on jobs hides nothing`() {
        // The crew door also answers empty for a suspended company.
        assertTrue(planJobHolds(listOf(mine, taken), emptyList(), MoneyScope.DENIED, scoped).changesNothing)
        // Only tombstones through the door is still "no live job".
        assertTrue(planJobHolds(listOf(mine, taken), listOf(cloud("gone", deleted = true)), MoneyScope.DENIED, scoped).changesNothing)
        // Planted failure: the same empty door with visible = 0 does hide --
        // the guard is the server's own count, not emptiness alone.
        assertFalse(planJobHolds(listOf(mine, taken), emptyList(), MoneyScope.DENIED, scoped.copy(visible = 0)).changesNothing)
    }

    @Test
    fun `a tombstone that still arrives is not hidden -- it takes the delete path`() {
        val plan = planJobHolds(listOf(mine), listOf(cloud("mine", deleted = true), cloud("x")), MoneyScope.DENIED, scoped)
        assertFalse("mine" in plan.hide)
    }

    // ---- not scoped ----

    @Test
    fun `an unanswered question hides nothing and brings nothing back`() {
        val held = listOf(pulled("a", heldAt = 5L), taken)
        assertTrue(planJobHolds(held, door, MoneyScope.DENIED, JobScope.Unknown).changesNothing)
        assertTrue(planJobHolds(held, door, MoneyScope.UNKNOWN, scoped).changesNothing)
    }

    @Test
    fun `seeing everything brings every held job back and hides nothing`() {
        val held = listOf(pulled("a", heldAt = 5L), taken)
        for (plan in listOf(
            planJobHolds(held, door, MoneyScope.DENIED, JobScope.SeesAll),
            planJobHolds(held, door, MoneyScope.DENIED, JobScope.NotDeployed),
            // A phone that may see money reads the real jobs table.
            planJobHolds(held, door, MoneyScope.ALLOWED, scoped)
        )) {
            assertTrue(plan.unhideAll)
            assertTrue(plan.hide.isEmpty())
        }
    }

    // ---- no needless writes ----

    @Test
    fun `a pass that decides what the last one did plans nothing`() {
        // Held already, still absent: nothing to write.
        assertTrue(planJobHolds(listOf(mine, pulled("taken-off", heldAt = 9L)), door, MoneyScope.DENIED, scoped).changesNothing)
        // Seeing everything with nothing held: nothing to write either.
        assertTrue(planJobHolds(listOf(mine, taken), door, MoneyScope.ALLOWED, scoped).changesNothing)
        assertTrue(planJobHolds(listOf(mine, taken), door, MoneyScope.DENIED, JobScope.NotDeployed).changesNothing)
    }

    // ---- the wrong planners, to prove these checks bite ----

    /** "Anything not in the door is gone" -- the naive reading of a scoped pull. */
    private fun naive(local: List<Job>, cloud: List<CloudJob>): JobHoldPlan =
        JobHoldPlan(hide = local.filter { l -> cloud.none { it.syncId == l.syncId } }.mapTo(HashSet()) { it.syncId })

    @Test
    fun `the naive planner would hide a never-sent job and hide everything on an empty door`() {
        val madeHere = Job(syncId = "made-here", lastSyncedAt = null)
        assertTrue("made-here" in naive(listOf(madeHere), door).hide)
        assertEquals(2, naive(listOf(mine, taken), emptyList()).hide.size)
        // ...both of which the real one refuses.
        assertFalse("made-here" in planJobHolds(listOf(madeHere), door, MoneyScope.DENIED, scoped).hide)
        assertTrue(planJobHolds(listOf(mine, taken), emptyList(), MoneyScope.DENIED, scoped).hide.isEmpty())
    }
}
