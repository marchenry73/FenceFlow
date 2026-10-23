package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.MaterialRole
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A THOUSANDTH OF A FOOT MUST NOT BUY A BAY.
 *
 * He asked for this in three words -- "Do the 0.001 fix" -- after I showed him
 * what I had found trying to ship the whole-drawing move.
 *
 * THE BUG IT CLOSES. Every count of bays, panels and pickets is
 * `ceil(span / size)`. A side whose length is an EXACT multiple of the size is
 * exactly N: 96 ft at 8 ft spacing is 12 bays. It reads 13 the moment the
 * length comes back a hair over -- and that buys a post, a panel, a cap and a
 * bag of concrete that are not there.
 *
 * A hair over is what float32 arithmetic produces. Measured over 200,000
 * grid-like drawings in docs/measurements/fuzz_move_rigidity.mjs: a
 * translation adds the same offset to every coordinate, which cancels in
 * arithmetic but not in floats, and one drawing in eight came out up to
 * 0.0004 ft different. Aimed at a bay boundary that flipped 4.5% of counts.
 *
 * WHY THESE TESTS AND NOT THE PARITY FIXTURES. The fixtures are recorded FROM
 * this engine and replayed by the server, so they prove the two agree -- they
 * cannot prove either is right, because a fixture written after a mistake pins
 * the mistake. These assert the intended behaviour directly, in the three
 * cases that matter and in the one that must NOT change.
 *
 * The office engine's copy of these cases is
 * supabase/functions/_shared/pricing/tolerance_test.ts, the same four
 * arithmetic claims against the same numbers.
 */
class CountToleranceTest {

    /** Vinyl: panels and posts both come off the same footage. */
    private fun run(feet: Float, spacing: Float = 8f, panel: Float = 8f) = FenceRun(
        jobId = 1,
        fenceType = FenceType.VINYL,
        manualLinearFeet = feet,
        panelWidthFt = panel,
        postSpacingFt = spacing,
    )

    private fun qty(r: FenceRun, role: MaterialRole): Double =
        EstimateEngine.suggestQuantities(r, pixelsPerFoot = 0f)
            .entries.filter { it.role == role }.sumOf { it.quantity }

    private fun panels(feet: Float) = qty(run(feet), MaterialRole.PANEL)

    @Test
    fun `an exact multiple is exactly that many panels -- unchanged`() {
        // THE CASE THAT MUST NOT MOVE. 96 ft at 8 ft panels was 12 before this
        // change and must be 12 after it: the tolerance is subtracted from the
        // span, so 95.999 / 8 still ceils to 12. If this ever reads 11 the
        // slack is being taken off a figure that did not need it, and every
        // exact job in the database just got a panel cheaper.
        assertEquals(12.0, panels(96f), 0.0)
        assertEquals(1.0, panels(8f), 0.0)
        assertEquals(50.0, panels(400f), 0.0)
    }

    @Test
    fun `a hair over an exact multiple is still that many panels`() {
        // THE BUG. 96.000008 ft is 96 ft that went through a few float
        // operations. Before the fix this bought a thirteenth panel.
        assertEquals(12.0, panels(96.000008f), 0.0)
        // The worst drift measured was 0.0004 ft. Twice that, still absorbed.
        assertEquals(12.0, panels(96.0008f), 0.0)
        // Right up to the tolerance.
        assertEquals(12.0, panels(96.001f), 0.0)
    }

    @Test
    fun `an overhang a tape could read still buys the next panel`() {
        // THE THING THE TOLERANCE MUST NOT SWALLOW. A hundredth of a foot is
        // an eighth of an inch; a tenth of a foot is over an inch. Both are
        // real fence and both need the next panel.
        assertEquals(13.0, panels(96.01f), 0.0)
        assertEquals(13.0, panels(96.1f), 0.0)
        assertEquals(13.0, panels(97f), 0.0)
        // And a genuine fraction well inside a bay is untouched.
        assertEquals(13.0, panels(100f), 0.0)
    }

    @Test
    fun `a span smaller than the tolerance keeps its old answer`() {
        // Subtracting the slack from a span under a thousandth of a foot would
        // turn it negative and buy ZERO panels where this bought one. That is
        // a second behaviour change nobody asked for, so the slack is only
        // taken off a span bigger than it.
        assertEquals(1.0, panels(0.0005f), 0.0)
        assertEquals(1.0, panels(0.001f), 0.0)
        // Nothing drawn is still nothing bought.
        assertEquals(0.0, panels(0f), 0.0)
    }

    @Test
    fun `the same rule holds for posts, not just panels`() {
        // Bays decide line posts, caps and concrete. A boundary side that
        // gained a bay gained all of them.
        val exact = run(96f, spacing = 8f, panel = 8f)
        val hairOver = run(96.000008f, spacing = 8f, panel = 8f)
        for (role in listOf(
            MaterialRole.LINE_POST, MaterialRole.CORNER_POST,
            MaterialRole.END_POST, MaterialRole.POST_CAP,
        )) {
            assertEquals(
                "$role moved on a span a hair over an exact multiple",
                qty(exact, role), qty(hairOver, role), 0.0,
            )
        }
    }

    @Test
    fun `the same rule holds for pickets, whose pitch is in inches`() {
        // The picket count divides INCHES by an inch pitch, so it takes the
        // slack in inches. Getting that wrong would leave pickets as the one
        // count still able to gain on a hair -- 0.001 ft of slack applied to a
        // figure in inches is twelve times too small to absorb anything.
        //
        // 96 ft is 1152 in; at a 6 in pitch that is exactly 192 pickets.
        val wood = { feet: Float ->
            FenceRun(
                jobId = 1,
                fenceType = FenceType.WOOD,
                manualLinearFeet = feet,
                postSpacingFt = 8f,
                picketWidthIn = 5.5f,
                picketGapIn = 0.5f,
                woodRailCount = 2,
            )
        }
        assertEquals(192.0, qty(wood(96f), MaterialRole.WOOD_PICKET), 0.0)
        assertEquals(192.0, qty(wood(96.000008f), MaterialRole.WOOD_PICKET), 0.0)
        // And a real overhang still buys the next picket.
        assertEquals(193.0, qty(wood(96.05f), MaterialRole.WOOD_PICKET), 0.0)
    }

    @Test
    fun `CANARY -- the old behaviour is detectable`() {
        // If this suite could not tell the fixed engine from the broken one,
        // the assertions above are decoration. ceil without the slack is the
        // shape that shipped until today.
        val brokenBays = kotlin.math.ceil(96.000008f / 8f).toInt()
        assertEquals(
            "THE CANARY DID NOT FIRE: ceil with no slack no longer gains a bay, " +
                "so these tests are no longer testing anything",
            13, brokenBays,
        )
        // And the fixed engine disagrees with it, which is the whole point.
        assertEquals(12.0, panels(96.000008f), 0.0)
    }

    @Test
    fun `the tolerance is a thousandth of a foot, and the inch one follows from it`() {
        // Pinned so the two cannot drift apart, and so a later edit that
        // "rounds" either of them has to come through here.
        assertEquals(0.001f, EstimateEngine.COUNT_TOLERANCE_FT, 0.0f)
        assertEquals(
            EstimateEngine.COUNT_TOLERANCE_FT * 12f,
            EstimateEngine.COUNT_TOLERANCE_IN,
            0.0f,
        )
    }
}
