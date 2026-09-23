package com.fenceestimator.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The one unshipped migration, 45 -> 46. Version 45 shipped in app 1.519, so
 * [SchemaV45] is frozen and every column this release adds belongs here.
 *
 * Room refuses to open a database whose tables do not match its entities, so a
 * field added to an entity without its statement here is a crash on the first
 * launch after the update, and the phone cannot be downgraded out of it. This
 * holds the statements to the fields without needing a device.
 *
 * It exists because the migration's own comment claimed it did: SchemaV46 was
 * written with "[SchemaV46Test] holds the two to each other" in it while no such
 * file existed, and SchemaV45Test is hardcoded to change_orders so it would
 * never have noticed. A guard named in a comment and absent from the repo is the
 * shape that makes a green suite carry confidence it has not earned.
 */
class SchemaV46Test {

    private val statements = SchemaV46.MIGRATION_45_46_STATEMENTS

    private fun adds(table: String, column: String): Boolean =
        statements.any { Regex("ALTER TABLE `$table` ADD COLUMN `$column`").containsMatchIn(it) }

    private fun fieldsOf(type: Class<*>) = type.declaredFields.map { it.name }.toSet()

    @Test
    fun `every column this release added to an entity is added by the migration`() {
        assertTrue("minimumLaborCharge" in fieldsOf(Job::class.java))
        assertTrue(adds("jobs", "minimumLaborCharge"))
    }

    @Test
    fun `nothing from a shipped migration is repeated here`() {
        // A statement in two lists runs twice on a phone coming from an older
        // version, and ALTER TABLE ... ADD COLUMN on a column that exists is an
        // error that aborts the migration -- which Room turns into a crash loop.
        val shipped = SchemaV44.MIGRATION_43_44_STATEMENTS.toSet() +
            SchemaV45.MIGRATION_44_45_STATEMENTS.toSet()
        assertEquals(emptySet<String>(), statements.toSet().intersect(shipped))
    }

    /**
     * minimumLaborCharge is a non-null Kotlin Double, which Room expects as REAL
     * NOT NULL with a default. Anything else fails Room's schema check on the
     * first launch after the update.
     *
     * The default has to be 0 specifically, and not only because Room says so:
     * 0 is what the pricing engines read as "this company has no labour floor",
     * so a different default here would quietly put a floor under every job on
     * every phone that updates.
     */
    @Test
    fun `the column is added with the type Room expects and a zero default`() {
        val add = statements.first { it.contains("ADD COLUMN `minimumLaborCharge`") }
        assertTrue(add, add.contains("REAL NOT NULL DEFAULT 0"))
        assertFalse(add, add.contains("DEFAULT 200"))
    }

    /**
     * The planted failure, run through the same check the real assertion uses
     * rather than restated over a local list -- the mistake SchemaV45Test made
     * and that this file is not going to repeat.
     */
    @Test
    fun `the check fails when the statement is missing`() {
        val without = statements.filterNot { it.contains("ADD COLUMN `minimumLaborCharge`") }
        assertFalse(
            "a list without the column must fail the same check that passes above",
            without.any { Regex("ALTER TABLE `jobs` ADD COLUMN `minimumLaborCharge`").containsMatchIn(it) }
        )
        assertTrue("...and the real list passes it", adds("jobs", "minimumLaborCharge"))
    }
}
