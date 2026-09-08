package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FencePoint
import com.fenceestimator.app.geometry.GateMarker
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The answer to "why does it say thirty-three posts?".
 *
 * The one thing that must never be true of an explanation is that it
 * disagrees with the number it explains. A contractor who is told the
 * arithmetic and then counts a different total on the takeoff has been
 * taught a formula the product does not use, which is worse than being told
 * nothing. Every case here checks the explanation against the takeoff the
 * order is actually built from.
 */
class PostWorkingsTest {

    private val pxPerFt = 20f

    /** A straight run of [feet], drawn left to right at 20px per foot. */
    private fun straightRun(
        feet: Float,
        spacing: Float = 6f,
        closed: Boolean = false,
        gates: List<GateMarker> = emptyList(),
    ): FenceRun {
        val pts = listOf(FencePoint(0f, 0f), FencePoint(feet * pxPerFt, 0f))
        return FenceRun(
            jobId = 1L,
            fenceType = FenceType.VINYL,
            postSpacingFt = spacing,
            closedLoop = closed,
            pointsEncoded = FenceCodec.encodePoints(pts),
            gatesEncoded = FenceCodec.encodeGates(gates),
        )
    }

    /** A rectangle, which gives four corners and no ends. */
    private fun rectangleRun(w: Float, h: Float, spacing: Float = 6f): FenceRun {
        val pts = listOf(
            FencePoint(0f, 0f),
            FencePoint(w * pxPerFt, 0f),
            FencePoint(w * pxPerFt, h * pxPerFt),
            FencePoint(0f, h * pxPerFt),
        )
        return FenceRun(
            jobId = 1L,
            fenceType = FenceType.VINYL,
            postSpacingFt = spacing,
            closedLoop = true,
            pointsEncoded = FenceCodec.encodePoints(pts),
            gatesEncoded = "",
        )
    }

    private fun takeoffTotalPosts(run: FenceRun): Int {
        val line = EstimateEngine.suggestQuantities(run, pxPerFt).takeoff
            .firstOrNull { it.label == "Total posts" }
        return line?.quantity?.toInt() ?: 0
    }

    private fun assertAgrees(run: FenceRun, what: String) {
        val w = EstimateEngine.explainPosts(run, pxPerFt)
        assertEquals(
            "the explanation and the takeoff disagree for $what",
            takeoffTotalPosts(run), w.totalPosts
        )
        // And the explanation has to add up on its own terms.
        assertEquals(
            "the parts do not sum to the total for $what",
            w.totalPosts, w.linePosts + w.cornerPosts + w.endPosts + w.gatePosts
        )
    }

    @Test
    fun `a plain straight run`() = assertAgrees(straightRun(120f), "a 120 ft straight run")

    @Test
    fun `a short run`() = assertAgrees(straightRun(12f), "a 12 ft run")

    @Test
    fun `a run that is not a whole number of bays`() =
        assertAgrees(straightRun(47.5f), "47.5 ft at 6 ft spacing")

    @Test
    fun `a closed rectangle`() = assertAgrees(rectangleRun(40f, 25f), "a 40x25 rectangle")

    @Test
    fun `a run with one gate`() =
        assertAgrees(straightRun(120f, gates = listOf(gate(60f, 4f))), "120 ft with one gate")

    @Test
    fun `a run with several gates`() = assertAgrees(
        straightRun(200f, gates = listOf(gate(40f, 4f), gate(90f, 10f), gate(150f, 4f))),
        "200 ft with three gates"
    )

    @Test
    fun `tighter spacing needs more posts`() {
        val wide = EstimateEngine.explainPosts(straightRun(120f, spacing = 8f), pxPerFt)
        val tight = EstimateEngine.explainPosts(straightRun(120f, spacing = 4f), pxPerFt)
        assertTrue(
            "halving the spacing should not reduce the post count",
            tight.totalPosts > wide.totalPosts
        )
        assertAgrees(straightRun(120f, spacing = 8f), "8 ft spacing")
        assertAgrees(straightRun(120f, spacing = 4f), "4 ft spacing")
    }

    @Test
    fun `the workings report the numbers a person would check`() {
        val run = straightRun(120f, gates = listOf(gate(60f, 4f)))
        val w = EstimateEngine.explainPosts(run, pxPerFt)
        assertEquals("fence length", 120f, w.fenceFeet, 0.5f)
        assertEquals("gate opening", 4f, w.gateFeet, 0.01f)
        assertEquals("net fence", 116f, w.netFeet, 0.5f)
        assertEquals("spacing", 6f, w.spacingFt, 0.01f)
        assertEquals("gates", 1, w.gateCount)
        assertEquals("two posts per gate", 2, w.gatePosts)
        assertTrue("an open run has ends", w.openRun)
        assertTrue("bays should reflect the net length", w.bays >= 19)
    }

    @Test
    fun `a closed loop is reported as closed and has no end posts`() {
        val w = EstimateEngine.explainPosts(rectangleRun(40f, 25f), pxPerFt)
        assertTrue("a rectangle is a closed run", !w.openRun)
        assertEquals(0, w.endPosts)
        assertEquals("four corners", 4, w.cornerPosts)
    }

    @Test
    fun `a run with no drawing at all does not throw`() {
        val empty = FenceRun(jobId = 1L, fenceType = FenceType.VINYL, postSpacingFt = 6f)
        val w = EstimateEngine.explainPosts(empty, pxPerFt)
        assertEquals(0, w.totalPosts)
    }

    private fun gate(atFt: Float, widthFt: Float) =
        GateMarker(x = atFt * pxPerFt, y = 0f, widthFt = widthFt)
}
