package com.fenceestimator.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The one unshipped migration, 44 -> 45. Version 44 shipped in app 1.514, so
 * [SchemaV44] is frozen and every column this release adds belongs here.
 *
 * Room refuses to open a database whose tables do not match its entities, so a
 * field added to an entity without its statement here is a crash on the first
 * launch after the update -- and the phone cannot be downgraded out of it. This
 * holds the statements to the fields without a device.
 */
class SchemaV45Test {

    private val statements = SchemaV45.MIGRATION_44_45_STATEMENTS

    private fun adds(table: String, column: String): Boolean =
        statements.any { Regex("ALTER TABLE `$table` ADD COLUMN `$column`").containsMatchIn(it) }

    private fun fieldsOf(type: Class<*>) = type.declaredFields.map { it.name }.toSet()

    @Test
    fun `every column this release added to an entity is added by the migration`() {
        assertTrue("pendingPush" in fieldsOf(ChangeOrder::class.java))
        assertTrue(adds("change_orders", "pendingPush"))
        assertTrue("signatureClearedAt" in fieldsOf(ChangeOrder::class.java))
        assertTrue(adds("change_orders", "signatureClearedAt"))
    }

    @Test
    fun `nothing from the shipped migration is repeated here`() {
        // A statement in both lists runs twice on a phone coming from 43, and
        // `ALTER TABLE ... ADD COLUMN` on a column that exists is an error that
        // aborts the migration -- which Room turns into a crash loop.
        val shipped = SchemaV44.MIGRATION_43_44_STATEMENTS.toSet()
        assertEquals(emptySet<String>(), statements.toSet().intersect(shipped))
    }

    private val mark = "UPDATE `change_orders` SET `pendingPush` = 1"

    /**
     * The check itself, as a function, so a planted failure can run THE SAME
     * check over a broken list.
     *
     * What was here before asserted that a list with an item removed no longer
     * contains it -- which tests kotlin's List.minus and nothing about the
     * migration. It could only ever pass, whatever SchemaV45 said, and a canary
     * that cannot fail is worse than none: the report then carries confidence it
     * has not earned.
     */
    private fun everyOrderIsOwedAPush(list: List<String>): Boolean {
        val at = list.indexOf(mark)
        val add = list.indexOfFirst { it.contains("ADD COLUMN `pendingPush`") }
        return at >= 0 && add in 0 until at
    }

    @Test
    fun `every order already on the phone is owed one push`() {
        // Same reasoning as estimate_line_items in SchemaV44: an edit made
        // offline before the update has no other record that it never went up,
        // and without this every existing order would read as already taken by
        // the cloud, so the pull would write the cloud's copy over it.
        assertTrue(everyOrderIsOwedAPush(statements))

        // Planted failures, each run through the same check: the mark missing,
        // and the mark placed before the column it writes to exists -- which
        // SQLite refuses at migration time, on the user's phone, once.
        assertFalse(
            "a list with no mark must fail the check",
            everyOrderIsOwedAPush(statements.filterNot { it == mark })
        )
        assertFalse(
            "a mark before its column must fail the check",
            everyOrderIsOwedAPush(listOf(mark) + statements.filterNot { it == mark })
        )
    }

    /**
     * pendingPush is a non-null Boolean, which Room expects as INTEGER NOT NULL
     * with a default; signatureClearedAt is a nullable Long, which Room expects
     * as a nullable INTEGER with no default. Anything else fails Room's schema
     * check on the first launch after the update.
     */
    @Test
    fun `the two columns are added with the types Room expects`() {
        val push = statements.first { it.contains("ADD COLUMN `pendingPush`") }
        assertTrue(push, push.contains("INTEGER NOT NULL DEFAULT 0"))

        val cleared = statements.first { it.contains("ADD COLUMN `signatureClearedAt`") }
        assertTrue(cleared, cleared.trimEnd().endsWith("INTEGER"))
        assertFalse(cleared, cleared.contains("NOT NULL"))
        assertFalse(cleared, cleared.contains("DEFAULT"))
    }
}
