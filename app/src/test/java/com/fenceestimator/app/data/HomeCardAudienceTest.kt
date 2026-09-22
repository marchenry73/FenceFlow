package com.fenceestimator.app.data

import com.fenceestimator.app.cloud.Permission
import com.fenceestimator.app.cloud.UserRole
import com.fenceestimator.app.cloud.defaultPermissions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which home-screen tiles each person gets (HomeCard.shownTo).
 *
 * The company chooses the tiles and every phone in it shows them, so the
 * owner's "Hours to approve" and "Drafts" used to sit on a crew phone -- a
 * count of every colleague's shift, and a queue it could not open.
 */
class HomeCardAudienceTest {

    private val every = HomeCard.values().toList()

    private fun tilesFor(granted: Set<Permission>) = every.filter { it.shownTo(granted) }.toSet()

    @Test
    fun `crew get only the week ahead`() {
        assertEquals(setOf(HomeCard.SCHEDULED_THIS_WEEK), tilesFor(UserRole.CREW.defaultPermissions))
    }

    @Test
    fun `the owner and a signed-out phone get every tile they chose -- planted failure for an empty rule`() {
        // A rule that hid everything would pass the crew test above.
        assertEquals(every.toSet(), tilesFor(Permission.ALL))
    }

    @Test
    fun `a foreman gets the queue they answer and the calendar they run, no money`() {
        assertEquals(
            setOf(HomeCard.SCHEDULED_THIS_WEEK, HomeCard.HOURS_TO_APPROVE, HomeCard.OVERRUNNING),
            tilesFor(UserRole.FOREMAN.defaultPermissions)
        )
    }

    @Test
    fun `every money tile needs SEE_MONEY, whatever else it lists`() {
        val allButMoney = Permission.ALL - Permission.SEE_MONEY
        every.filter { it.needsMoney }.forEach { card ->
            assertTrue("$card must list SEE_MONEY", Permission.SEE_MONEY in card.needsAnyOf)
            assertFalse("$card shown without SEE_MONEY", card.shownTo(allButMoney))
        }
    }

    @Test
    fun `no tile but the week ahead is shown to someone with no permissions`() {
        // A signed-in profile not read yet holds nothing (SessionState.permissions).
        assertEquals(setOf(HomeCard.SCHEDULED_THIS_WEEK), tilesFor(emptySet()))
    }

    @Test
    fun `hours to approve follows APPROVE_TIME alone`() {
        assertTrue(HomeCard.HOURS_TO_APPROVE.shownTo(setOf(Permission.APPROVE_TIME)))
        assertFalse(HomeCard.HOURS_TO_APPROVE.shownTo(Permission.ALL - Permission.APPROVE_TIME))
    }

    @Test
    fun `selling tiles follow either EDIT_JOBS or SEE_MONEY`() {
        listOf(HomeCard.WON_THIS_MONTH, HomeCard.DRAFT_ESTIMATES).forEach { card ->
            assertTrue(card.shownTo(setOf(Permission.EDIT_JOBS)))
            assertTrue(card.shownTo(setOf(Permission.SEE_MONEY)))
            assertFalse(card.shownTo(setOf(Permission.RECORD_FIELD_WORK, Permission.APPROVE_TIME)))
        }
    }
}
