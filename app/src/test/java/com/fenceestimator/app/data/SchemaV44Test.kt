package com.fenceestimator.app.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The one unshipped migration, 43 -> 44, carries every column this release
 * adds -- there is no second bump. Room refuses to open a database whose
 * tables do not match the entities, so a field added to an entity without
 * its statement here is a crash on the first launch after the update; this
 * holds the statements to the fields without a device.
 */
class SchemaV44Test {

    private val statements = SchemaV44.MIGRATION_43_44_STATEMENTS

    private fun adds(table: String, column: String): Boolean =
        statements.any { Regex("ALTER TABLE `$table` ADD COLUMN `$column`").containsMatchIn(it) }

    private fun fieldsOf(type: Class<*>) = type.declaredFields.map { it.name }.toSet()

    @Test
    fun `every column this release added to an entity is added by the migration`() {
        assertTrue("acceptedTotal" in fieldsOf(Job::class.java))
        assertTrue(adds("jobs", "acceptedTotal"))
        assertTrue("crewBase" in fieldsOf(Job::class.java))
        assertTrue(adds("jobs", "crewBase"))
        assertTrue("accessEndedAt" in fieldsOf(Job::class.java))
        assertTrue(adds("jobs", "accessEndedAt"))
        assertTrue("pendingPush" in fieldsOf(EstimateLineItem::class.java))
        assertTrue(adds("estimate_line_items", "pendingPush"))
        assertTrue("inAcceptedTotal" in fieldsOf(ChangeOrder::class.java))
        assertTrue(adds("change_orders", "inAcceptedTotal"))
        assertTrue(statements.any { it.contains("CREATE TABLE IF NOT EXISTS `pending_resurrections`") })
    }

    @Test
    fun `every line already on the phone is owed one push`() {
        // An edit typed offline before the update has no other record that it
        // never went up. Without this UPDATE every existing line would read as
        // already taken by the cloud, and the pull would write the cloud's
        // older copy over it.
        assertTrue(statements.contains("UPDATE `estimate_line_items` SET `pendingPush` = 1"))
        // ...and it comes after the column exists.
        val add = statements.indexOfFirst { it.contains("ADD COLUMN `pendingPush`") }
        val mark = statements.indexOf("UPDATE `estimate_line_items` SET `pendingPush` = 1")
        assertTrue(add in 0 until mark)
        // Planted failure: the list without it is caught.
        assertFalse((statements - "UPDATE `estimate_line_items` SET `pendingPush` = 1").contains("UPDATE `estimate_line_items` SET `pendingPush` = 1"))
    }

    /**
     * Job.accessEndedAt is a nullable Long, which Room expects as a nullable
     * INTEGER with no default -- anything else fails Room's schema check on
     * the first launch after the update. And nullable, so every job already
     * on a phone starts visible.
     */
    @Test
    fun `accessEndedAt is added as a nullable INTEGER with no default`() {
        val add = statements.single { it.contains("ADD COLUMN `accessEndedAt`") }
        assertTrue(add.endsWith("`accessEndedAt` INTEGER"))
        // Planted failure: a NOT NULL or defaulted column is caught.
        assertFalse("ALTER TABLE `jobs` ADD COLUMN `accessEndedAt` INTEGER NOT NULL DEFAULT 0".endsWith("`accessEndedAt` INTEGER"))
    }

    @Test
    fun `the migration deletes nothing -- planted failure`() {
        assertTrue(statements.none { Regex("\\b(DELETE|DROP)\\b", RegexOption.IGNORE_CASE).containsMatchIn(it) })
        // The check can see one.
        val planted = statements + "DROP TABLE `pending_deletions`"
        assertFalse(planted.none { Regex("\\b(DELETE|DROP)\\b", RegexOption.IGNORE_CASE).containsMatchIn(it) })
    }
}
