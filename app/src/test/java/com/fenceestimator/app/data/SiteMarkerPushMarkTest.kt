package com.fenceestimator.app.data

import com.fenceestimator.app.cloud.pullMayWriteMarker
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * SITE MARKERS JOIN THE PUSH MARK THE OTHER TWO CHILD TABLES ALREADY USE.
 *
 * Markers were the one child table pushed WHOLESALE -- every marker of every
 * job, from every device, on every pass -- with NO pull guard of any kind.
 * So the cloud's copy went straight over a position dragged a moment earlier,
 * and two phones re-sent their own copies for ever. That is the loop line
 * items (SchemaV44) and change orders (SchemaV45) were each taken out of.
 *
 * Four things have to hold together or the mark makes things worse rather
 * than better, and each has its own test below:
 *
 *  1. the migration adds the column Room expects, and does not repeat a
 *     statement from a shipped migration;
 *  2. every marker already on a phone is marked ONCE, so a drag made before
 *     the update is not quietly overwritten by the cloud's older copy;
 *  3. the pull refuses to write a marked row;
 *  4. the mark is cleared only where the row still holds what went up.
 */
class SiteMarkerPushMarkTest {

    private val statements = SchemaV52.MIGRATION_51_52_STATEMENTS

    private fun marker(
        syncId: String = "m1",
        x: Float = 10f,
        y: Float = 20f,
        label: String = "House",
        pendingPush: Boolean = false,
        widthFt: Float = 30f,
        heightFt: Float = 50f,
        rotationDeg: Float = 12f,
        kind: SiteMarkerKind = SiteMarkerKind.HOUSE,
    ) = SiteMarker(
        syncId = syncId, jobId = 1L, kind = kind, x = x, y = y, label = label,
        widthFt = widthFt, heightFt = heightFt, rotationDeg = rotationDeg,
        pendingPush = pendingPush,
    )

    // ------------------------------------------------------- 1. the column --

    @Test
    fun `the entity has the field and the migration adds the column`() {
        val fields = SiteMarker::class.java.declaredFields.map { it.name }.toSet()
        assertTrue("SiteMarker.pendingPush is missing", "pendingPush" in fields)
        assertTrue(
            "the migration does not add site_markers.pendingPush",
            statements.any {
                Regex("ALTER TABLE `site_markers` ADD COLUMN `pendingPush`").containsMatchIn(it)
            }
        )
    }

    /**
     * A non-null Kotlin Boolean is INTEGER NOT NULL with a default to Room.
     * Anything else fails Room's schema check on the first launch after the
     * update, and a phone cannot be downgraded out of that.
     */
    @Test
    fun `the column is the type Room expects, defaulted to not-waiting`() {
        val add = statements.first { it.contains("ADD COLUMN `pendingPush`") }
        assertTrue("saw: $add", add.contains("INTEGER NOT NULL DEFAULT 0"))
    }

    /**
     * A statement in two lists runs twice on a phone coming from an older
     * version, and ALTER TABLE ... ADD COLUMN on a column that exists aborts
     * the migration -- which Room turns into a crash loop.
     */
    @Test
    fun `nothing from a shipped migration is repeated here`() {
        val shipped = SchemaV44.MIGRATION_43_44_STATEMENTS.toSet() +
            SchemaV45.MIGRATION_44_45_STATEMENTS.toSet() +
            SchemaV46.MIGRATION_45_46_STATEMENTS.toSet() +
            SchemaV51.MIGRATION_50_51_STATEMENTS.toSet()
        assertEquals(emptySet<String>(), statements.toSet().intersect(shipped))
    }

    // ------------------------------------------------------ 2. the backfill --

    /**
     * EVERY EXISTING MARKER IS MARKED ONCE.
     *
     * Without this, a marker dragged before the update has no record anywhere
     * that it never reached the cloud -- and the first pull after the update
     * would write the cloud's older position over it. That is the loss being
     * fixed, made permanent by the fix. Re-pushing a marker the cloud already
     * has costs nothing: it is exactly what every pass did until now.
     */
    @Test
    fun `every marker already on the phone is marked once`() {
        assertTrue(
            "the migration must backfill pendingPush = 1, as SchemaV44 and V45 do",
            statements.any {
                Regex("UPDATE `site_markers` SET `pendingPush` = 1").containsMatchIn(it)
            }
        )
        // ...and in that order. A backfill before the column exists is an error.
        val addAt = statements.indexOfFirst { it.contains("ADD COLUMN `pendingPush`") }
        val setAt = statements.indexOfFirst { it.contains("SET `pendingPush` = 1") }
        assertTrue("the backfill must come after the ALTER (add=$addAt set=$setAt)", addAt < setAt)
    }

    // ------------------------------------------------------ 3. the pull guard --

    @Test
    fun `the pull refuses to write a marker this phone changed`() {
        assertFalse("a marked marker must be left alone", pullMayWriteMarker(marker(pendingPush = true)))
        assertTrue("an unmarked marker takes the cloud's copy", pullMayWriteMarker(marker(pendingPush = false)))
    }

    /**
     * A marker the phone has never seen is not "changed here", so the pull
     * must create it. Null reading as "refuse" would mean a marker placed on
     * one phone never arrived on another.
     */
    @Test
    fun `a marker the phone does not have yet is written`() {
        assertTrue(pullMayWriteMarker(null))
    }

    // ------------------------------------------- 4. clearing the mark safely --

    @Test
    fun `the mark clears when the row still holds what went up`() {
        val sent = marker(pendingPush = true)
        // The row as it is after the upsert: identical content, mark still set.
        assertTrue(siteMarkerStillAsSent(sent, sent.copy()))
    }

    /**
     * THE TRAP THIS EXISTS FOR. A drag that happened while the upsert was in
     * flight has NOT gone up. Clearing its mark would drop it from the next
     * pass and let the pull put the cloud's older position over it -- the
     * original bug, re-entered through the fix.
     */
    @Test
    fun `a drag during the upsert keeps its mark`() {
        val sent = marker(x = 10f, y = 20f, pendingPush = true)
        val draggedSince = sent.copy(x = 400f, y = 250f)
        assertFalse(
            "a marker moved while the request was in flight must stay marked",
            siteMarkerStillAsSent(sent, draggedSince)
        )
    }

    /**
     * Every field the push carries is part of that comparison, not just x and
     * y. A label or a size changed in flight has not gone up either.
     *
     * This is written as a loop over every change so that a field ADDED to the
     * push later and forgotten here fails rather than passing quietly.
     */
    @Test
    fun `every pushed field counts, not only the position`() {
        val sent = marker(pendingPush = true)
        val changes = mapOf(
            "x" to sent.copy(x = 11f),
            "y" to sent.copy(y = 21f),
            "label" to sent.copy(label = "Pool"),
            "widthFt" to sent.copy(widthFt = 31f),
            "heightFt" to sent.copy(heightFt = 51f),
            "rotationDeg" to sent.copy(rotationDeg = 13f),
            "kind" to sent.copy(kind = SiteMarkerKind.POOL),
            "syncId" to sent.copy(syncId = "m2"),
        )
        for ((field, now) in changes) {
            assertFalse("$field changed in flight and the mark would have been cleared",
                siteMarkerStillAsSent(sent, now))
        }
        // CONTROL: the comparison is not simply false for everything. The mark
        // itself is not content, and neither is the Room id, so neither of
        // these counts as "changed since it was sent".
        assertTrue("the mark is not content", siteMarkerStillAsSent(sent, sent.copy(pendingPush = false)))
        assertTrue("the Room id is not content", siteMarkerStillAsSent(sent, sent.copy(id = 99L)))
    }

    /**
     * A CONTROL on the field list itself. siteMarkerPushContent must cover
     * every field CloudSiteMarker carries; if somebody adds a column to the
     * marker push and not to this list, a change to it would clear the mark
     * for something that never went up.
     */
    @Test
    fun `the push content names as many fields as the push sends`() {
        // syncId, kind, x, y, label, widthFt, heightFt, rotationDeg -- eight.
        // companyId and the job's sync id are addressing, not content.
        assertEquals(8, siteMarkerPushContent(marker()).size)
    }
}
