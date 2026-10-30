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

    // ---- r57: "no locate needed" is something somebody SAID --------------
    //
    // NONE used to mean two things at once -- nobody has called 811 yet, and
    // this job needs no digging -- so neither could be chased, and the
    // office's locate alert could never be satisfied for the second kind. It
    // fired every day such a job sat on the schedule, which is how a safety
    // alert gets muted for every job at once.

    @Test
    fun `a job with nothing said is still NONE, not not-required`() {
        assertEquals(LocateTicket.State.NONE, LocateTicket.stateOf(job(), now))
    }

    @Test
    fun `saying the job needs no locate is its own state`() {
        assertEquals(
            LocateTicket.State.NOT_REQUIRED,
            LocateTicket.stateOf(job(notRequired = true), now)
        )
    }

    @Test
    fun `a ticket always wins over the no-locate box`() {
        // Somebody ringing 811 anyway is not a reason to stop reading the
        // expiry. Every one of these has the box ticked.
        assertEquals(
            LocateTicket.State.CLEAR,
            LocateTicket.stateOf(job(ticket = "A1", notRequired = true), now)
        )
        assertEquals(
            LocateTicket.State.EXPIRED,
            LocateTicket.stateOf(job(ticket = "A1", expires = now - day, notRequired = true), now)
        )
        assertEquals(
            LocateTicket.State.WAITING,
            LocateTicket.stateOf(job(ticket = "A1", digAfter = now + day, notRequired = true), now)
        )
    }

    @Test
    fun `a job that needs no digging does not warn before digging`() {
        // The whole point of the box. A warning that stays on after somebody
        // has answered it is one they learn to ignore -- and this is the
        // warning that matters most when it is real.
        assertFalse(LocateTicket.shouldWarnBeforeDigging(job(notRequired = true), now))
        // CONTROL: the states that SHOULD warn still do, or the line above
        // proves only that nothing warns any more.
        assertTrue(LocateTicket.shouldWarnBeforeDigging(job(), now))
        assertTrue(LocateTicket.shouldWarnBeforeDigging(job(ticket = "A1", expires = now - day), now))
    }

    @Test
    fun `the no-locate message is its own, not the clear-to-dig fallback`() {
        // message() ends in `else -> "Clear to dig."`, so a new state added
        // without a branch would have told the crew a no-digging job was
        // clear to dig.
        assertEquals(
            R.string.eng2_locate_msg_not_required,
            LocateTicket.messageRes(job(notRequired = true), now).textRes
        )
        val text = LocateTicket.message(job(notRequired = true), now)
        assertTrue("got: $text", text.contains("no digging"))
        assertFalse("got: $text", text == "Clear to dig.")
    }

    private val now = 1_700_000_000_000L
    private val day = 86_400_000L

    private fun job(
        ticket: String = "",
        digAfter: Long? = null,
        expires: Long? = null,
        notRequired: Boolean = false
    ) = Job(
        customerName = "Test",
        locateTicketNo = ticket,
        locateNotRequired = notRequired,
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
