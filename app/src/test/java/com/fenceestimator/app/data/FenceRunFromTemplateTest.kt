package com.fenceestimator.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `FenceRun.fromTemplate()` copies `BuildTemplate`'s spec columns onto a new
 * run by name. The two column sets have to stay in lockstep with each other
 * and with supabase_build_templates_patch.sql, which defines them a third
 * time -- a spec column added to only one of the three means either every
 * run started from a template silently ignores it, or a template can never
 * actually set it.
 *
 * Plain Java reflection rather than a hand-maintained list of names on both
 * sides: the whole point of this test is to fail the moment somebody adds a
 * column and forgets the other half, and a second hand-written list is
 * exactly the kind of thing that goes stale the same way the code it is
 * meant to catch does.
 */
class FenceRunFromTemplateTest {

    /**
     * Columns on [BuildTemplate] that are bookkeeping or wizard-only, not
     * part of a run's fence spec -- so they have no [FenceRun] column of the
     * same name and are not expected to be copied by [FenceRun.fromTemplate].
     * gateWidthFt/gateMounting are real columns, but they seed the wizard's
     * gate step; a run's actual gates live in gatesEncoded once drawn or typed.
     */
    private val nonSpecFields = setOf(
        "syncId", "companyId", "name", "description", "isDefault",
        "derivedFromSyncId", "sortOrder", "gateWidthFt", "gateMounting",
        "updatedAt", "deletedAt"
    )

    private fun declaredFieldNames(clazz: Class<*>): Set<String> =
        clazz.declaredFields.map { it.name }.toSet()

    private fun specFieldsOnTemplate(): Set<String> =
        declaredFieldNames(BuildTemplate::class.java) - nonSpecFields

    private fun sampleTemplate() = BuildTemplate(
        syncId = "tmpl-1",
        companyId = "co-1",
        name = "Test template",
        description = "for the test",
        isDefault = true,
        derivedFromSyncId = "tmpl-0",
        sortOrder = 5,
        fenceType = FenceType.CHAIN_LINK,
        colorOrFinish = "Black",
        panelWidthFt = 11f,
        panelHeightFt = 7f,
        postSpacingFt = 13f,
        concreteBagsPerPost = 2f,
        aluminumStyle = AluminumStyle.FLAT_TOP,
        woodStyle = WoodStyle.SPACED_PICKET,
        woodRailCount = 4,
        picketWidthIn = 6.5f,
        picketGapIn = 3f,
        fabricHeightFt = 9f,
        includeTopRail = false,
        includeTensionWire = true,
        includeBarbedWireArms = true,
        includePrivacySlats = true,
        splitRailCount = 5,
        gateWidthFt = 8f,
        gateMounting = "WALL"
    )

    @Test
    fun `every spec column on BuildTemplate is one fromTemplate actually copies`() {
        val template = sampleTemplate()
        val run = FenceRun.fromTemplate(template, jobId = 1L, label = "Back Yard", sortOrder = 0)

        val templateClass = BuildTemplate::class.java
        val runClass = FenceRun::class.java
        val specFields = specFieldsOnTemplate()
        // Guards the guard: if this comes up empty, nonSpecFields has almost
        // certainly swallowed a real column by accident and every check below
        // would pass by doing nothing.
        assertTrue("expected at least one spec column on BuildTemplate", specFields.isNotEmpty())

        specFields.forEach { name ->
            val templateField = templateClass.getDeclaredField(name).apply { isAccessible = true }
            val runField = try {
                runClass.getDeclaredField(name).apply { isAccessible = true }
            } catch (e: NoSuchFieldException) {
                throw AssertionError(
                    "BuildTemplate.$name has no matching FenceRun column -- add it to " +
                        "fence_runs and FenceRun.fromTemplate, or to nonSpecFields above " +
                        "if it genuinely isn't part of the fence spec",
                    e
                )
            }
            assertEquals(
                "FenceRun.fromTemplate did not copy $name from the template",
                templateField.get(template),
                runField.get(run)
            )
        }
    }

    @Test
    fun `the run remembers which template it came from, and takes its own identity from the caller`() {
        val template = sampleTemplate()
        val run = FenceRun.fromTemplate(template, jobId = 42L, label = "Back Yard", sortOrder = 3)

        assertEquals(template.syncId, run.buildTemplateSyncId)
        assertEquals(42L, run.jobId)
        assertEquals("Back Yard", run.label)
        assertEquals(3, run.sortOrder)
        // A template is a spec, not a drawing -- fromTemplate must never
        // invent geometry or gates the run didn't actually have.
        assertEquals("", run.pointsEncoded)
        assertEquals("", run.gatesEncoded)
    }
}
