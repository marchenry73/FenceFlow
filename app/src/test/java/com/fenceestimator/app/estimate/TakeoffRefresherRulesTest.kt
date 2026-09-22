package com.fenceestimator.app.estimate

import com.fenceestimator.app.cloud.SessionState
import com.fenceestimator.app.cloud.UserRole
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FencePoint
import com.fenceestimator.app.geometry.GateMarker
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.Modifier

/**
 * When the drawing screen may re-price a run, and what counts as the drawing
 * having moved.
 *
 * Two bugs. A crew phone re-priced from its money-scrubbed catalog and its
 * own copy of the drawing, and it and the owner's phone overwrote each
 * other's quantities on every sync (161 flips, 2026-09-17..21). And the
 * signature that decided "the drawing moved" included the run's sync clock,
 * so a pull writing the cloud's updated_at back onto a run re-priced it --
 * over quantities the owner was typing on the Estimate screen above.
 */
class TakeoffRefresherRulesTest {

    private fun signedIn(role: UserRole, overrides: String = "") =
        SessionState(signedIn = true, role = role, permissionOverrides = overrides, accessKnown = true, resolved = true)

    @Test
    fun `only someone who sees prices and edits jobs re-prices`() {
        assertTrue(TakeoffRefresher.mayReprice(signedIn(UserRole.OWNER)))
        assertTrue(TakeoffRefresher.mayReprice(signedIn(UserRole.MANAGER)))
        assertTrue(TakeoffRefresher.mayReprice(signedIn(UserRole.SALES)))

        assertFalse("crew", TakeoffRefresher.mayReprice(signedIn(UserRole.CREW)))
        assertFalse("foreman", TakeoffRefresher.mayReprice(signedIn(UserRole.FOREMAN)))
        assertFalse("accountant: sees money, may not change jobs", TakeoffRefresher.mayReprice(signedIn(UserRole.ACCOUNTANT)))
        // Money alone is not enough: the estimate is part of the job.
        assertFalse(TakeoffRefresher.mayReprice(signedIn(UserRole.CREW, "+SEE_MONEY")))
        assertTrue(TakeoffRefresher.mayReprice(signedIn(UserRole.CREW, "+SEE_MONEY,+EDIT_JOBS")))
    }

    @Test
    fun `a profile not read yet may not re-price, a phone used alone may`() {
        assertFalse(TakeoffRefresher.mayReprice(SessionState(signedIn = true, role = UserRole.OWNER, accessKnown = false)))
        assertTrue(TakeoffRefresher.mayReprice(SessionState(signedIn = false)))
    }

    // Planted failure: the watcher used to start from SurveyViewModel's init
    // with no question asked, which is a yes for everybody -- crew included.
    @Test
    fun `the old unconditional watcher said yes to crew`() {
        val oldAnswer: (SessionState) -> Boolean = { true }
        val crew = signedIn(UserRole.CREW)
        assertNotEquals(oldAnswer(crew), TakeoffRefresher.mayReprice(crew))
    }

    private val base = FenceRun(
        id = 3, syncId = "run-sync", jobId = 9, label = "Back", fenceType = FenceType.VINYL, sortOrder = 2,
        pointsEncoded = FenceCodec.encodePoints(listOf(FencePoint(0f, 0f), FencePoint(2000f, 0f))),
        gatesEncoded = FenceCodec.encodeGates(listOf(GateMarker(1000f, 0f, 4f))),
        updatedAt = 1_000L
    )

    @Test
    fun `a sync echo is not a drawing change`() {
        // What pullFenceRuns writes onto a run this phone just pushed: the
        // same drawing, the server's clock.
        val echo = base.copy(updatedAt = 1_758_480_000_000L)
        assertEquals(TakeoffRefresher.pricingSignature(base), TakeoffRefresher.pricingSignature(echo))

        // Planted failure: the old signature kept updatedAt, so the echo
        // looked like an edit and re-priced the run.
        fun oldSignature(r: FenceRun) = r.copy(label = "", sortOrder = 0).toString()
        assertNotEquals(oldSignature(base), oldSignature(echo))
    }

    @Test
    fun `real drawing changes still re-price`() {
        val moved = base.copy(pointsEncoded = FenceCodec.encodePoints(listOf(FencePoint(0f, 0f), FencePoint(2400f, 0f))))
        val gateGone = base.copy(gatesEncoded = "")
        val closed = base.copy(closedLoop = true)
        listOf(moved, gateGone, closed).forEach {
            assertNotEquals(TakeoffRefresher.pricingSignature(base), TakeoffRefresher.pricingSignature(it))
        }
    }

    /**
     * Every FenceRun column, classified. A column added later fails the first
     * assertion until somebody decides which side it is on -- listing it as
     * priced by default would re-price on every sync if it is bookkeeping,
     * and leaving it out would let the takeoff ignore a spec change.
     */
    private val notPriced = setOf("id", "syncId", "jobId", "label", "sortOrder", "buildTemplateSyncId", "updatedAt")
    private val priced = setOf(
        "fenceType", "pointsEncoded", "gatesEncoded", "closedLoop", "isTeardown", "colorOrFinish",
        "panelWidthFt", "panelHeightFt", "aluminumStyle", "woodStyle", "woodRailCount", "picketWidthIn",
        "picketGapIn", "fabricHeightFt", "includeTopRail", "includeTensionWire", "includeBarbedWireArms",
        "includePrivacySlats", "splitRailCount", "postSpacingFt", "concreteBagsPerPost", "manualLinearFeet",
        "manualCornerCount", "suppressedRolesCsv"
    )

    private fun columns() = FenceRun::class.java.declaredFields
        .filter { !Modifier.isStatic(it.modifiers) && !it.isSynthetic }

    /** [base] with one column changed, by reflection, so no column can be skipped. */
    private fun withChanged(name: String): FenceRun {
        val field = FenceRun::class.java.getDeclaredField(name).apply { isAccessible = true }
        val copy = base.copy()
        val current = field.get(copy)
        val changed: Any = when {
            field.type == String::class.java -> ((current as String?) ?: "") + "x"
            field.type == Float::class.javaPrimitiveType -> (current as Float) + 1.5f
            field.type == Float::class.javaObjectType -> ((current as Float?) ?: 0f) + 12.5f
            field.type == Int::class.javaPrimitiveType -> (current as Int) + 1
            field.type == Long::class.javaPrimitiveType -> (current as Long) + 1L
            field.type == Boolean::class.javaPrimitiveType -> !(current as Boolean)
            field.type.isEnum -> field.type.enumConstants.first { it != current }
            else -> throw AssertionError("FenceRun.$name has a type this test cannot vary: ${field.type}")
        }
        field.set(copy, changed)
        return copy
    }

    @Test
    fun `every column is either priced or deliberately not`() {
        assertEquals(notPriced + priced, columns().map { it.name }.toSet())

        val sig = TakeoffRefresher.pricingSignature(base)
        priced.forEach { name ->
            assertNotEquals("$name changes the takeoff", sig, TakeoffRefresher.pricingSignature(withChanged(name)))
        }
        notPriced.forEach { name ->
            assertEquals("$name must not re-price", sig, TakeoffRefresher.pricingSignature(withChanged(name)))
        }
    }
}
