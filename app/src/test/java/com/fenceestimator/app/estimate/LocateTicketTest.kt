package com.fenceestimator.app.estimate

import com.fenceestimator.app.R
import com.fenceestimator.app.data.Job
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The dates that decide whether digging is legal.
 *
 * Getting this wrong in either direction is bad, but not equally: saying
 * "clear to dig" when a ticket has expired is how somebody hits a gas line, so
 * every uncertain case has to resolve away from clear.
 */
class LocateTicketTest {

    private val now = 1_700_000_000_000L
    private val day = 86_400_000L

    private fun job(
        ticket: String = "",
        digAfter: Long? = null,
        expires: Long? = null
    ) = Job(
        customerName = "Test",
        locateTicketNo = ticket,
        locateDigAfter = digAfter,
        locateExpiresAt = expires
    )

    @Test
    fun `no ticket is not the same as a clear one`() {
        assertEquals(LocateTicket.State.NONE, LocateTicket.stateOf(job(), now))
    }

    @Test
    fun `inside the window is clear`() {
        val j = job("A1234", digAfter = now - day, expires = now + 10 * day)
        assertEquals(LocateTicket.State.CLEAR, LocateTicket.stateOf(j, now))
    }

    @Test
    fun `before the wait is up, nobody digs`() {
        val j = job("A1234", digAfter = now + 2 * day, expires = now + 12 * day)
        assertEquals(LocateTicket.State.WAITING, LocateTicket.stateOf(j, now))
    }

    @Test
    fun `past the expiry is expired, not clear`() {
        val j = job("A1234", digAfter = now - 20 * day, expires = now - day)
        assertEquals(LocateTicket.State.EXPIRED, LocateTicket.stateOf(j, now))
    }

    @Test
    fun `expiry beats the wait when a ticket is both`() {
        // A nonsense ticket -- expired AND not yet diggable. Expired is the
        // answer that keeps somebody out of the ground.
        val j = job("A1234", digAfter = now + day, expires = now - day)
        assertEquals(LocateTicket.State.EXPIRED, LocateTicket.stateOf(j, now))
    }

    @Test
    fun `expiring today still counts as clear, and says so`() {
        val j = job("A1234", digAfter = now - 5 * day, expires = now + 1000L)
        assertEquals(LocateTicket.State.CLEAR, LocateTicket.stateOf(j, now))
        assertEquals(R.string.eng2_locate_msg_expires_today, LocateTicket.messageRes(j, now).textRes)
    }

    @Test
    fun `a ticket close to expiry warns before somebody is on site`() {
        val j = job("A1234", digAfter = now - 5 * day, expires = now + 2 * day)
        assertTrue(LocateTicket.expiringSoon(j, now))
        val message = LocateTicket.messageRes(j, now)
        assertEquals(R.string.eng2_locate_msg_expires_in_many, message.textRes)
        assertEquals(listOf<Any>(2), message.args)
    }

    @Test
    fun `a ticket with plenty of time does not nag`() {
        val j = job("A1234", digAfter = now - day, expires = now + 20 * day)
        assertFalse(LocateTicket.expiringSoon(j, now))
        assertEquals(R.string.eng2_locate_msg_clear, LocateTicket.messageRes(j, now).textRes)
    }

    @Test
    fun `an expired ticket is never reported as expiring soon`() {
        // Only a valid ticket can be close to expiry. An expired one is a
        // different, louder problem.
        val j = job("A1234", expires = now - day)
        assertFalse(LocateTicket.expiringSoon(j, now))
    }

    @Test
    fun `everything except clear warns before digging`() {
        assertTrue(LocateTicket.shouldWarnBeforeDigging(job(), now))
        assertTrue(LocateTicket.shouldWarnBeforeDigging(job("A1", digAfter = now + day), now))
        assertTrue(LocateTicket.shouldWarnBeforeDigging(job("A1", expires = now - day), now))
        assertFalse(
            LocateTicket.shouldWarnBeforeDigging(
                job("A1", digAfter = now - day, expires = now + 9 * day), now
            )
        )
    }

    @Test
    fun `a ticket with no dates recorded is treated as clear`() {
        // Somebody noted the number and nothing else. Not ideal, but it is a
        // deliberate act, and refusing to believe it would train people to skip
        // recording it at all.
        assertEquals(LocateTicket.State.CLEAR, LocateTicket.stateOf(job("A1234"), now))
    }
}
