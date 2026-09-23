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

    @Test
    fun `every order already on the phone is owed one push`() {
        // Same reasoning as estimate_line_items in SchemaV44: an edit made
        // offline before the update has no other record that it never went up,
        // and without this every existing order would read as already taken by
        // the cloud, so the pull would write the cloud's copy over it.
        assertTrue(statements.contains("UPDATE `change_orders` SET `pendingPush` = 1"))
        // ...and it comes after the column exists.
        val add = statements.indexOfFirst { it.contains("ADD COLUMN `pendingPush`") }
        val mark = statements.indexOf("UPDATE `change_orders` SET `pendingPush` = 1")
        assertTrue(add in 0 until mark)
        // Planted failure: the list without it is caught.
        assertFalse(
            (statements - "UPDATE `change_orders` SET `pendingPush` = 1")
                .contains("UPDATE `change_orders` SET `pendingPush` = 1")
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
