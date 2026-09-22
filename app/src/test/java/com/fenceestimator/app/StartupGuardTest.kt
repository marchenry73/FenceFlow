package com.fenceestimator.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What a launch does when the database will not load (see [StartupGuard]).
 *
 * The case that started it: seven fatal "Unable to create application ...
 * AppDatabase_Impl does not exist" reports from one crew phone on 1.512, a
 * build whose APK holds that class, all after 1.512 had already started
 * cleanly once (a 1.512 sync failure sits before them in the same upload).
 * Each of those starts died before a screen drew. The guard lets the first
 * such launch stay up and say so once, keeps the next ones quiet for a
 * window counted from that first failure -- and must never do the same for a
 * real fault, or for a build that is genuinely broken.
 */
class StartupGuardTest {

    /** Room's own sentence, word for word from the 1.512 report. */
    private fun roomCannotFindImpl() = RuntimeException(
        "Cannot find implementation for com.fenceestimator.app.data.AppDatabase. AppDatabase_Impl does not exist"
    )

    /** How the platform wraps it when Application.onCreate throws. */
    private fun asTheReportShowedIt() = RuntimeException(
        "Unable to create application com.fenceestimator.app.FenceEstimatorApp: " +
            "java.lang.RuntimeException: Cannot find implementation for com.fenceestimator.app.data.AppDatabase. " +
            "AppDatabase_Impl does not exist",
        roomCannotFindImpl()
    )

    private val aMinute = 60_000L

    @Test
    fun `the 1512 report reads as generated code failing to load`() {
        assertTrue(StartupGuard.isMissingGeneratedCode(roomCannotFindImpl()))
        assertTrue(StartupGuard.isMissingGeneratedCode(asTheReportShowedIt()))
    }

    @Test
    fun `a dao or entity class failing the same way counts too`() {
        assertTrue(StartupGuard.isMissingGeneratedCode(ClassNotFoundException("com.fenceestimator.app.data.JobDao_Impl")))
        assertTrue(
            StartupGuard.isMissingGeneratedCode(
                RuntimeException("wrapped", NoClassDefFoundError("com/fenceestimator/app/data/FieldChangeDao_Impl"))
            )
        )
    }

    /**
     * A migration that throws, or a damaged file, is a real fault and must
     * crash and report on the very first launch -- exactly as it always did.
     */
    @Test
    fun `a real database fault is never mistaken for it`() {
        val migration = IllegalStateException(
            "A migration from 43 to 44 was required but not found. Please provide the necessary Migration path"
        )
        val corrupt = RuntimeException("file is not a database (code 26 SQLITE_NOTADB)")
        assertFalse(StartupGuard.isMissingGeneratedCode(migration))
        assertFalse(StartupGuard.isMissingGeneratedCode(corrupt))
        assertEquals(StartupGuard.Verdict.CRASH, StartupGuard.decide(migration, 0, aMinute))
        assertEquals(StartupGuard.Verdict.CRASH, StartupGuard.decide(corrupt, 0, aMinute))
    }

    /** Half of Room's sentence is not the sentence: "does not exist" alone is some other fault. */
    @Test
    fun `only Room's whole sentence counts, not any message that says does not exist`() {
        val other = IllegalArgumentException("column accessEndedAt does not exist")
        assertFalse(StartupGuard.isMissingGeneratedCode(other))
        assertEquals(StartupGuard.Verdict.CRASH, StartupGuard.decide(other, 0, aMinute))
    }

    @Test
    fun `the first failure on a build stays up and reports once`() {
        assertEquals(StartupGuard.Verdict.REPORT_AND_WAIT, StartupGuard.decide(asTheReportShowedIt(), 0, aMinute))
        // Even with no time to go on: one report, never a crash loop.
        assertEquals(StartupGuard.Verdict.REPORT_AND_WAIT, StartupGuard.decide(asTheReportShowedIt(), 0, null))
    }

    @Test
    fun `later failures inside the window stay quiet`() {
        assertEquals(StartupGuard.Verdict.WAIT, StartupGuard.decide(roomCannotFindImpl(), 1, aMinute))
        assertEquals(StartupGuard.Verdict.WAIT, StartupGuard.decide(roomCannotFindImpl(), 6, StartupGuard.SETTLE_MS))
    }

    /**
     * A genuinely broken build (1.499 was one) must still be loud: once the
     * window after its first failure has passed, a failure crashes and
     * reports as fatal.
     */
    @Test
    fun `a failure that outlives the window crashes as it always did`() {
        assertEquals(
            StartupGuard.Verdict.CRASH,
            StartupGuard.decide(roomCannotFindImpl(), 1, StartupGuard.SETTLE_MS + 1)
        )
        // An unknown first-failure time never counts as settling...
        assertEquals(StartupGuard.Verdict.CRASH, StartupGuard.decide(roomCannotFindImpl(), 1, null))
        // ...and neither does one in the future (the clock was moved back).
        assertEquals(StartupGuard.Verdict.CRASH, StartupGuard.decide(roomCannotFindImpl(), 1, -aMinute))
    }

    // --- the tally between launches (what FenceEstimatorApp stores) ---------

    private val build = 512
    /**
     * A stand-in for when the first failure happened on that phone. The real
     * time is not known (reports did not carry one yet) -- only that it came
     * after 1.512's release at 18:43 and after a clean 1.512 start, and
     * before the upload at 19:32.
     */
    private val firstFailure = java.time.Instant.parse("2026-09-21T19:05:00Z").toEpochMilli()

    /**
     * The 1.512 burst came after a clean start on that build, so it may have
     * begun any time after the install. A window counted from the install
     * (the guard's first version) had already closed by then, and every
     * launch after the first would have crashed as fatal exactly as before.
     * Counted from the first failure, the burst is quiet; and the time of that
     * first failure is carried forward, never restarted, so it still ends.
     */
    @Test
    fun `the window runs from the build's first failure and is not restarted by later ones`() {
        val e = roomCannotFindImpl()
        val first = StartupGuard.onFailure(e, remembered = null, build = build, now = firstFailure)
        assertEquals(StartupGuard.Verdict.REPORT_AND_WAIT, first.verdict)
        assertEquals(StartupGuard.Tally(build, 1, firstFailure), first.tally)

        // Six more launches over the next nine minutes: all quiet, all timed
        // against 19:05.
        var tally = first.tally
        for (minute in listOf(1, 2, 3, 5, 7, 9)) {
            val next = StartupGuard.onFailure(e, tally, build, firstFailure + minute * aMinute)
            assertEquals("minute $minute", StartupGuard.Verdict.WAIT, next.verdict)
            assertEquals("minute $minute keeps the first failure's time", firstFailure, next.tally.firstFailureAt)
            tally = next.tally
        }
        assertEquals(7, tally.failures)

        // Past the window it is a broken build, and loud -- even though the
        // last failure was only two minutes ago.
        val late = StartupGuard.onFailure(e, tally, build, firstFailure + StartupGuard.SETTLE_MS + 2 * aMinute)
        assertEquals(StartupGuard.Verdict.CRASH, late.verdict)
    }

    /** Another build's trouble is not this one's: a new build starts again at zero. */
    @Test
    fun `a tally left by another build starts again`() {
        val old = StartupGuard.Tally(build = 509, failures = 3, firstFailureAt = firstFailure - 60 * aMinute)
        val outcome = StartupGuard.onFailure(roomCannotFindImpl(), old, build, firstFailure)
        assertEquals(StartupGuard.Verdict.REPORT_AND_WAIT, outcome.verdict)
        assertEquals(StartupGuard.Tally(build, 1, firstFailure), outcome.tally)
    }

    /** No tally can make a real fault quiet. */
    @Test
    fun `a real fault crashes whatever the tally says`() {
        val migration = IllegalStateException("A migration from 43 to 44 was required but not found.")
        val tally = StartupGuard.Tally(build, 1, firstFailure)
        assertEquals(StartupGuard.Verdict.CRASH, StartupGuard.onFailure(migration, tally, build, firstFailure + aMinute).verdict)
        assertEquals(StartupGuard.Verdict.CRASH, StartupGuard.onFailure(migration, null, build, firstFailure).verdict)
    }

    /** Every phone's report lands in one group on the admin page; the detail rides in the cause. */
    @Test
    fun `the report has one fixed message and keeps what the loader said`() {
        val a = RuntimeException("Installed or updated 12s before this launch; a second lookup failed too")
        val b = RuntimeException("Installed or updated 400s before this launch; a second lookup succeeded")
        val first = StartupGuard.UpdateInProgress(a)
        val second = StartupGuard.UpdateInProgress(b)
        assertEquals(first.message, second.message)
        assertTrue(first.message.orEmpty().startsWith("Update in progress"))
        assertSame(a, first.cause)
    }
}
