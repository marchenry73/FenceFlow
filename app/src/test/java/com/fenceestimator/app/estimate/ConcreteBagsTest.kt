package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.MaterialRole
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.GateMarker
import com.fenceestimator.app.geometry.GateMounting
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Concrete is bought in whole bags, so the takeoff has to ask for whole bags.
 *
 * Getting this wrong is quiet and expensive: half a bag over on every gate of
 * every job is money spent for years before anyone notices.
 */
class ConcreteBagsTest {

    private fun run(
        feet: Float?,
        gates: List<GateMarker> = emptyList(),
        bagsPerPost: Float = 1f
    ) = FenceRun(
        jobId = 1,
        fenceType = FenceType.VINYL,
        manualLinearFeet = feet,
        gatesEncoded = FenceCodec.encodeGates(gates),
        panelWidthFt = 6f,
        postSpacingFt = 6f,
        concreteBagsPerPost = bagsPerPost
    )

    private fun bags(r: FenceRun): Double =
        EstimateEngine.suggestQuantities(r, pixelsPerFoot = 0f)
            .entries.filter { it.role == MaterialRole.CONCRETE_BAG }
            .sumOf { it.quantity }

    @Test
    fun `a gate asks for the hinge post's bag and a half plus the latch post's bag`() {
        // No fence, so the only concrete is the gate's: 1.5 + 1.0 = 2.5 -> 3.
        val only = run(feet = 0f, gates = listOf(GateMarker(0f, 0f, 5f, GateMounting.LINE)))
        assertEquals(3.0, bags(only), 0.001)
    }

    /** Hinge side bolts to the wall; the latch side is still a post in a hole. */
    @Test
    fun `a wall-hung gate pays for its latch post only`() {
        val wall = run(feet = 0f, gates = listOf(GateMarker(0f, 0f, 5f, GateMounting.WALL)))
        assertEquals(1.0, bags(wall), 0.001)
    }

    /**
     * The double charge this change removes: the two gate posts were counted
     * once by the post tally and again by the gate area, on every gate.
     */
    @Test
    fun `gate posts are not charged concrete twice`() {
        val plain = run(feet = 12f, bagsPerPost = 1f)
        val gated = run(feet = 12f, gates = listOf(GateMarker(0f, 0f, 4f, GateMounting.LINE)), bagsPerPost = 1f)
        val added = bags(gated) - bags(plain)
        assertTrue(
            "a gate added $added bags; its two posts should cost about 2.5, not double",
            added <= 3.0
        )
    }

    /** The bug this whole change exists for: you cannot buy half a bag. */
    @Test
    fun `the total is always a whole number of bags`() {
        listOf(0.5f, 1f, 1.5f, 2f).forEach { perPost ->
            listOf(0f, 20f, 47f, 100f, 133f).forEach { feet ->
                val q = bags(run(feet = feet, bagsPerPost = perPost))
                assertEquals(
                    "fractional bags for $feet ft at $perPost per post",
                    q, Math.ceil(q), 0.0001
                )
            }
        }
    }

    @Test
    fun `a half-bag-per-post run still rounds up rather than down`() {
        // 20 ft at 6 ft spacing -> 4 bays -> 5 posts. 5 x 0.5 = 2.5 -> 3.
        assertEquals(3.0, bags(run(feet = 20f, bagsPerPost = 0.5f)), 0.001)
    }

    /**
     * Rounding the run and the gate separately would order four bags where
     * three do the job -- the error repeats on every gate of every job.
     */
    @Test
    fun `fence concrete and gate concrete are added up before rounding`() {
        val withGate = run(
            feet = 12f,
            gates = listOf(GateMarker(0f, 0f, 4f, GateMounting.LINE)),
            bagsPerPost = 0.5f
        )
        val q = bags(withGate)
        assertEquals("should be whole", q, Math.ceil(q), 0.0001)
        // Rounding the two parts separately would order a bag more than this.
        assertTrue("rounded per-entry instead of on the total: $q", q <= 4.0)
    }
}
