package com.fenceestimator.app.cloud

import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import java.io.File
import org.junit.Test

/**
 * Every pull must exclude tombstoned rows.
 *
 * This reads the source rather than running the sync, because the failure it
 * guards against is not a logic error -- it is somebody adding a new table's
 * pull and not knowing the filter was required. That is exactly what happened:
 * twelve pulls were written without it, so deleting anything other than a job
 * wrote a tombstone, DeletionReaper removed the row on every device, and the
 * pull in the same sync pass read the tombstoned row back and re-inserted it.
 * Delete, reap, resurrect, forever. Deleted change orders kept reappearing when
 * you opened a job, and no unit test would have caught it, because each piece
 * worked correctly on its own.
 *
 * A test over the source catches the omission the moment it is written.
 */
class PullFiltersDeletedTest {

    /**
     * Reads the sync source. The working directory for unit tests is the module
     * root, so this is relative to `app/`.
     */
    private fun syncSource(): String {
        val file = File("src/main/java/com/fenceestimator/app/cloud/EntitySync.kt")
        assertTrue(
            "Could not find EntitySync.kt at ${file.absolutePath} -- if it moved, " +
                "move this test with it rather than deleting it.",
            file.exists()
        )
        return file.readText()
    }

    /**
     * The one exception, and why.
     *
     * The payments ledger works out what to upload by comparing local rows
     * against the full cloud list. Hide the tombstoned rows from it and a
     * payment deleted on one phone looks missing from the cloud, so the other
     * phone re-uploads it -- money coming back from the dead. It filters
     * tombstones in Kotlin instead, after using the full list to decide what to
     * push.
     */
    private val allowedWithoutFilter = setOf("payment_records")

    /**
     * The marker a read carries when it genuinely needs to see tombstones.
     *
     * Some reads are not pulls at all. The push-side dedupe for pricing tiers
     * and catalog items compares what this phone holds against everything in
     * the cloud INCLUDING deleted rows -- because a name freed by a deletion
     * must stay taken, or the next push re-creates the row and emptying the
     * trash never sticks.
     *
     * Marked at the call site with a reason rather than listed here by table,
     * because those same two tables also have real pulls that do need the
     * filter. An allowlist by name would have switched off the check for both.
     */
    private val deliberateMarker = "sees-tombstones:"

    @Test
    fun `every pull excludes deleted rows`() {
        val source = syncSource()

        // Matches: from("table") ... .select { ... } ... .decodeList
        // Captures any comment lines between from(...) and .select, so a read
        // marked as deliberately seeing tombstones can be told apart from one
        // that simply forgot the filter.
        val pull = Regex(
            """from\("([a-z_]+)"\)\s*\n([\s\S]{0,300}?)\.select\s*\{([\s\S]{0,300}?)\}\s*\n?\s*\.decodeList"""
        )

        val offenders = pull.findAll(source).mapNotNull { match ->
            val table = match.groupValues[1]
            val preamble = match.groupValues[2]
            val selectBody = match.groupValues[3]
            when {
                table in allowedWithoutFilter -> null
                preamble.contains(deliberateMarker) -> null
                selectBody.contains("notDeleted()") -> null
                selectBody.contains("deleted_at") -> null
                else -> table
            }
        }.toList()

        if (offenders.isNotEmpty()) {
            fail(
                "These pulls would resurrect deleted rows: ${offenders.joinToString(", ")}.\n" +
                    "Add notDeleted() inside the select filter, next to the company_id check."
            )
        }
    }

    @Test
    fun `the test can actually see the pulls it is checking`() {
        // Without this, a regex that silently matches nothing would make the
        // test above pass forever while checking absolutely nothing.
        val source = syncSource()
        val pullCount = Regex(
            """from\("([a-z_]+)"\)\s*\n\s*\.select\s*\{([\s\S]{0,300}?)\}\s*\n?\s*\.decodeList"""
        ).findAll(source).count()

        assertTrue(
            "Expected to find the sync pulls, found $pullCount. The regex has probably " +
                "stopped matching the code, which would make this suite pass while testing nothing.",
            pullCount >= 12
        )
    }

    /**
     * The second half of the same fault.
     *
     * Filtering tombstones stops deleted rows coming back. It does nothing for
     * the other half: every pull only INSERTED rows the device did not have and
     * never UPDATED ones it did, so an edit made on one phone never reached
     * another. An approved shift stayed pending on the crew's phone forever,
     * because their phone already held the row and skipped it.
     *
     * `filter { it.syncId !in known... }` is the shape that does that. Its
     * absence is what this asserts. The fixed pulls key local rows by sync id
     * with associateBy and branch on whether one already exists.
     */
    @Test
    fun `no pull silently skips rows the device already has`() {
        val source = syncSource()

        val insertOnly = Regex("""filter\s*\{\s*it\.syncId\s*!in\s*known""")
            .findAll(source).count()

        assertTrue(
            "Found $insertOnly pull(s) that skip rows already held locally. That means an " +
                "edit made on one device never reaches another. Key the local rows by sync id " +
                "with associateBy and update the existing row instead, naming only the fields " +
                "the cloud shape carries so local-only ones survive.",
            insertOnly == 0
        )
    }

    @Test
    fun `the helper that does the excluding still exists`() {
        val source = syncSource()
        assertTrue(
            "notDeleted() is gone; the pulls above are relying on it.",
            source.contains("fun ") && source.contains("notDeleted()")
        )
        // "is null", not a date window: a phone that has been off for a month
        // still has to learn about everything deleted while it was away.
        assertTrue(
            "notDeleted() should filter on deleted_at being null.",
            source.contains("\"deleted_at\"") && source.contains("FilterOperator.IS")
        )
    }
}
