package com.fenceestimator.app.cloud

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which pulled changes a phone announces itself (see [changesToAnnounce]).
 *
 * An accepted quote is already pushed by the server twice over --
 * notify-job-change's "Quote accepted / X accepted the quote." and
 * quote-view's "Quote approved" -- and that push triggers the very pull that
 * would announce it a third time. And the once-per-run memory was keyed by
 * job alone, so a job announced once could announce nothing else that run.
 */
class IncomingAnnouncementTest {

    private fun change(job: Long, kind: ChangeKind) = IncomingChange(job, "Pat Lee", kind)

    @Test
    fun `an accepted quote is left to the server's push on a phone that gets pushes`() {
        assertFalse(announcedLocally(ChangeKind.QUOTE_ACCEPTED, hasPushToken = true))
        val seen = mutableSetOf<String>()
        assertEquals(emptyList<IncomingChange>(), changesToAnnounce(listOf(change(7, ChangeKind.QUOTE_ACCEPTED)), seen, hasPushToken = true))
    }

    /** No push token, no push: the pull is all such a phone hears. */
    @Test
    fun `a phone with no push token is still told the quote was accepted`() {
        assertTrue(announcedLocally(ChangeKind.QUOTE_ACCEPTED, hasPushToken = false))
        val seen = mutableSetOf<String>()
        assertEquals(
            listOf(change(7, ChangeKind.QUOTE_ACCEPTED)),
            changesToAnnounce(listOf(change(7, ChangeKind.QUOTE_ACCEPTED)), seen, hasPushToken = false)
        )
    }

    @Test
    fun `ordinary edits and payments are never announced from the pull`() {
        listOf(true, false).forEach { token ->
            assertFalse(announcedLocally(ChangeKind.UPDATED, token))
            assertFalse(announcedLocally(ChangeKind.PAYMENT_RECEIVED, token))
        }
    }

    /** The server sends nothing when a job is finished; the pull is the only word of it. */
    @Test
    fun `a finished job, a new job and an assignment are announced`() {
        listOf(true, false).forEach { token ->
            assertTrue(announcedLocally(ChangeKind.MARKED_COMPLETE, token))
            assertTrue(announcedLocally(ChangeKind.NEW_JOB, token))
            assertTrue(announcedLocally(ChangeKind.ASSIGNED_TO_ME, token))
        }
    }

    /**
     * Keyed by job alone, the job whose quote was accepted in the morning
     * could not be announced finished in the afternoon: it was already in
     * the set, and the crew's "done" went unsaid.
     */
    @Test
    fun `a job announced once can still announce something else later that run`() {
        val seen = mutableSetOf<String>()
        assertEquals(1, changesToAnnounce(listOf(change(7, ChangeKind.NEW_JOB)), seen, hasPushToken = true).size)
        assertEquals(
            listOf(change(7, ChangeKind.MARKED_COMPLETE)),
            changesToAnnounce(listOf(change(7, ChangeKind.MARKED_COMPLETE)), seen, hasPushToken = true)
        )
    }

    /** Several passes fire together at launch; each pulling the same job must not announce it again. */
    @Test
    fun `the same news about the same job is announced once per run, and once per pass`() {
        val seen = mutableSetOf<String>()
        val pass = listOf(
            change(7, ChangeKind.MARKED_COMPLETE), change(7, ChangeKind.MARKED_COMPLETE),
            // Two things about one job in one pass are still one notification.
            change(8, ChangeKind.NEW_JOB), change(8, ChangeKind.ASSIGNED_TO_ME)
        )
        assertEquals(
            listOf(change(7, ChangeKind.MARKED_COMPLETE), change(8, ChangeKind.NEW_JOB)),
            changesToAnnounce(pass, seen, hasPushToken = true)
        )
        assertEquals(emptyList<IncomingChange>(), changesToAnnounce(pass.take(3), seen, hasPushToken = true))
    }

    /** AutoSync.notifyIncoming needs a Context, so what it hands the rule is read from its source. */
    @Test
    fun `AutoSync announces through this rule, with this phone's push token`() {
        val src = listOf(
            java.io.File("src/main/java/com/fenceestimator/app/cloud/AutoSync.kt"),
            java.io.File("app/src/main/java/com/fenceestimator/app/cloud/AutoSync.kt")
        ).first { it.isFile }.readText()
        val notify = src.substringAfter("private fun notifyIncoming(result: SyncResult) {").substringBefore("if (worthTelling.isEmpty()) return")
        assertTrue(notify, notify.contains("changesToAnnounce(result.incoming, alreadyAnnounced, hasPushToken)"))
        assertTrue(notify, notify.contains("PushTokenStore.cached(context)"))
        assertTrue("the memory holds job and kind, not a bare job id",
            src.contains("private val alreadyAnnounced = java.util.Collections.synchronizedSet(mutableSetOf<String>())"))
    }
}
