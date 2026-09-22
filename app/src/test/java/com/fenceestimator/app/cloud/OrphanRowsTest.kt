package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.FieldChange
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * A pulled row whose job left this phone while the pass was running (see
 * OrphanRows.kt).
 *
 * One crew phone on 1.512 hit SQLite's FOREIGN KEY constraint (787) at
 * FieldChangeDao.insert during a sync: the job list the pull checks against
 * was read at the top of the pass, and the job went before the insert. The
 * throw ended the whole child pull -- change orders, shifts, steps and
 * markers after it never arrived. This runs the real merge
 * ([mergeFieldChanges]) against a table that enforces the foreign key the
 * way Room's does, with the job removed mid-pass.
 */
class OrphanRowsTest {

    /** What SQLite says, word for word from the report. */
    private fun foreignKeyFailure() =
        RuntimeException("FOREIGN KEY constraint failed (code 787 SQLITE_CONSTRAINT_FOREIGNKEY)")

    /** field_changes with its Room foreign key to jobs(id), and nothing else. */
    private class FieldChangeTable(val jobs: MutableSet<Long>) {
        val rows = mutableMapOf<String, FieldChange>()
        var writes = 0
        fun insert(c: FieldChange) {
            writes++
            if (c.jobId !in jobs) throw RuntimeException("FOREIGN KEY constraint failed (code 787 SQLITE_CONSTRAINT_FOREIGNKEY)")
            rows[c.syncId] = c
        }
        fun update(c: FieldChange) {
            writes++
            if (c.jobId !in jobs) throw RuntimeException("FOREIGN KEY constraint failed (code 787 SQLITE_CONSTRAINT_FOREIGNKEY)")
            rows[c.syncId] = c
        }
    }

    private fun cloud(syncId: String, job: String, summary: String = "Move gate 2 ft", approvedAt: String? = null) =
        CloudFieldChange(
            companyId = "co", syncId = syncId, jobSyncId = job, summary = summary,
            at = "2026-09-21T20:19:19Z", isRequest = true, approvedAt = approvedAt
        )

    @Test
    fun `a job gone mid-pass skips its row and every other row still lands`() = runBlocking {
        // Both jobs were on the phone when the pull read its job list...
        val jobIdBySyncId = mapOf("job-kept" to 1L, "job-gone" to 2L)
        // ...and job 2 was deleted (a sign-out's wipe, the Account screen's own
        // JobSync pass) before the inserts ran.
        val table = FieldChangeTable(jobs = mutableSetOf(1L))
        val pulled = listOf(
            cloud("a", "job-kept"),
            cloud("b", "job-gone"),
            cloud("c", "job-kept", summary = "Add a walk gate"),
        )

        val added = mergeFieldChanges(pulled, jobIdBySyncId, emptyMap(), table::insert, table::update, now = 0L)

        assertEquals(2, added)
        assertEquals(setOf("a", "c"), table.rows.keys)
        assertEquals("the orphan was attempted, then skipped", 3, table.writes)
    }

    @Test
    fun `a row whose job never reached this phone is not even attempted`() = runBlocking {
        val table = FieldChangeTable(jobs = mutableSetOf(1L))
        val added = mergeFieldChanges(
            listOf(cloud("x", "job-held-elsewhere"), cloud("a", "job-kept")),
            mapOf("job-kept" to 1L), emptyMap(), table::insert, table::update, now = 0L
        )
        assertEquals(1, added)
        assertEquals(1, table.writes)
    }

    @Test
    fun `an update to a row whose job went mid-pass is skipped the same way`() = runBlocking {
        val existing = FieldChange(id = 7, syncId = "b", jobId = 2L, summary = "old", isRequest = true)
        val table = FieldChangeTable(jobs = mutableSetOf(1L))
        val added = mergeFieldChanges(
            listOf(cloud("b", "job-gone", summary = "new"), cloud("a", "job-kept")),
            mapOf("job-kept" to 1L, "job-gone" to 2L), mapOf("b" to existing),
            table::insert, table::update, now = 0L
        )
        assertEquals(1, added)
        assertEquals(setOf("a"), table.rows.keys)
    }

    /** The merge itself is unchanged: a decision made here is not un-made by a cloud row without one. */
    @Test
    fun `a decision already made here survives a cloud row that has not heard of it`() = runBlocking {
        val decided = FieldChange(
            id = 7, syncId = "a", jobId = 1L, summary = "Move gate 2 ft", isRequest = true,
            approvedAt = 1_000L, decidedBy = "owner@example.com"
        )
        val table = FieldChangeTable(jobs = mutableSetOf(1L))
        mergeFieldChanges(
            listOf(cloud("a", "job-kept", summary = "Move gate 3 ft")),
            mapOf("job-kept" to 1L), mapOf("a" to decided), table::insert, table::update, now = 0L
        )
        val merged = table.rows.getValue("a")
        assertEquals("Move gate 3 ft", merged.summary)
        assertEquals(1_000L, merged.approvedAt)
        assertEquals("owner@example.com", merged.decidedBy)
    }

    /** Only the foreign key is forgiven. Anything else is still a failure of the pull. */
    @Test
    fun `any other failure still ends the pull`() = runBlocking {
        val broken: suspend (FieldChange) -> Unit = { throw IllegalStateException("disk I/O error (code 10 SQLITE_IOERR)") }
        try {
            mergeFieldChanges(listOf(cloud("a", "job-kept")), mapOf("job-kept" to 1L), emptyMap(), broken, broken, now = 0L)
            fail("a disk error was swallowed as an orphan")
        } catch (e: IllegalStateException) {
            assertTrue(e.message!!.contains("SQLITE_IOERR"))
        }
    }

    @Test
    fun `the foreign key is recognised through a wrapper, and nothing else is`() {
        assertTrue(isOrphanedWrite(foreignKeyFailure()))
        assertTrue(isOrphanedWrite(RuntimeException("insert failed", foreignKeyFailure())))
        assertFalse(isOrphanedWrite(RuntimeException("UNIQUE constraint failed: field_changes.syncId (code 2067)")))
        assertFalse(isOrphanedWrite(IllegalStateException("NOT NULL constraint failed: field_changes.jobId")))
    }

    /**
     * The crew's plan-change request goes through the same guard, and the
     * card said "Change requested ... the office has it" whatever the guard
     * did -- `sent = true` ran beside the launch, not after the save. A
     * request thrown away because its job had left the phone must say so.
     * Compose needs a device, so the order is read from the source.
     */
    @Test
    fun `a plan-change request reads as sent only once it is saved`() {
        val src = listOf(
            java.io.File("src/main/java/com/fenceestimator/app/ui/crew/CrewFencePlanScreen.kt"),
            java.io.File("app/src/main/java/com/fenceestimator/app/ui/crew/CrewFencePlanScreen.kt")
        ).first { it.isFile }.readText()
        val save = src.indexOf("val saved = com.fenceestimator.app.cloud.skipIfOrphaned {")
        assertTrue("the request is saved through the orphan guard", save >= 0)
        val sentAt = Regex("""\bsent = true\b""").findAll(src).map { it.range.first }.toList()
        assertEquals("one place says sent", 1, sentAt.size)
        val refused = src.indexOf("if (saved == null) {", save)
        assertTrue("a skipped save is looked at", refused > save)
        assertTrue("and says the job is gone", src.substring(refused, sentAt.single()).contains("jobGone = true"))
        assertTrue("sent is set only after that", sentAt.single() > refused)
        // The words, in every language the app ships.
        val res = listOf(java.io.File("src/main/res"), java.io.File("app/src/main/res")).first { it.isDirectory }
        listOf("values", "values-es", "values-fr").forEach { dir ->
            val xml = java.io.File(res, "$dir/strings.xml").readText()
            listOf("crew_plan_not_sent", "crew_plan_job_gone").forEach { key ->
                assertTrue("$dir has $key", xml.contains("<string name=\"$key\">"))
            }
        }
    }

    @Test
    fun `skipIfOrphaned answers null for an orphan and passes everything else through`() {
        assertNull(skipIfOrphaned<Unit> { throw foreignKeyFailure() })
        assertEquals(5, skipIfOrphaned { 5 })
        try {
            skipIfOrphaned<Unit> { throw kotlinx.coroutines.CancellationException("left the screen") }
            fail("a cancellation was swallowed")
        } catch (_: kotlinx.coroutines.CancellationException) {
        }
    }
}
