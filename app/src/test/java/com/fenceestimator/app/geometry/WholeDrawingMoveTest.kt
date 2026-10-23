package com.fenceestimator.app.geometry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * MOVING THE WHOLE DRAWING MUST MOVE NO MONEY.
 *
 * "I need to be able to move the entire fence and everything connected to
 * wherever I want on the drawing."
 *
 * A tool that slides the whole fence across the yard is only safe if it is
 * provably rigid. The reasoning is one line -- every length is a DIFFERENCE of
 * coordinates, and a constant added to both ends of a difference cancels --
 * but the thing that would break it is not the arithmetic, it is a later edit
 * that moves the points and forgets the gates, or rounds one and not the
 * other. So these do not check the reasoning; they measure the drawing with
 * the SAME engine the takeoff uses, before and after, and demand the same
 * numbers out.
 */
class WholeDrawingMoveTest {

    private val pxPerFt = 12f

    /** An L with a gate on its first wall, which is the ordinary case. */
    private fun ell() = listOf(
        FencePoint(100f, 100f), FencePoint(340f, 100f), FencePoint(340f, 280f)
    )

    private fun gateOnFirstWall() = GateMarker(x = 220f, y = 100f, widthFt = 4f)

    private fun shift(dx: Float, dy: Float, points: List<FencePoint>, gates: List<GateMarker>) =
        WholeDrawingMove.plan(
            runs = listOf(WholeDrawingMove.RunShift(points, gates)),
            markers = emptyList(),
            dx = dx, dy = dy
        )

    @Test
    fun totalFootageIsIdenticalAfterAMove() {
        val before = FenceGeometryEngine.analyze(ell(), pxPerFt).totalLinearFeet
        val plan = shift(-713.5f, 2048.25f, ell(), emptyList())
        assertNotNull(plan)
        val after = FenceGeometryEngine.analyze(plan!!.runs[0].points, pxPerFt).totalLinearFeet
        // Exactly, not nearly: a foot of drift on every move is a different
        // price every time the fence is nudged.
        assertEquals(before, after, 0.0f)
    }

    @Test
    fun everySideKeepsItsOwnLengthNotJustTheTotal() {
        // A total that survives while two sides swap length would price the
        // same footage out of two different catalogs.
        val plan = shift(37f, -91f, ell(), emptyList())!!
        val before = FenceGeometryEngine.analyze(ell(), pxPerFt).segments.map { it.lengthFt }
        val after = FenceGeometryEngine.analyze(plan.runs[0].points, pxPerFt).segments.map { it.lengthFt }
        assertEquals(before, after)
    }

    @Test
    fun thePostCountAndWhatEachPostIsAreIdentical() {
        // Corner posts cost more than line posts, so a corner that reads as a
        // line post after a move is money.
        val before = FenceGeometryEngine.analyze(ell(), pxPerFt, closedLoop = true)
        val plan = shift(900f, 900f, ell(), emptyList())!!
        val after = FenceGeometryEngine.analyze(plan.runs[0].points, pxPerFt, closedLoop = true)
        assertEquals(before.cornerCount, after.cornerCount)
        assertEquals(before.endCount, after.endCount)
        assertEquals(before.lineVertexCount, after.lineVertexCount)
        assertEquals(before.vertices.map { it.kind }, after.vertices.map { it.kind })
    }

    @Test
    fun aGateTravelsWithTheWallItSitsOn() {
        // THE FAILURE THIS CATCHES: points moved, gates left behind. The gate
        // is then no longer on any side, so it is laid out as a standalone
        // span -- a different opening, cutting no fence, on a wall that is
        // still billed its full length.
        val dx = 150f
        val dy = -75f
        val plan = shift(dx, dy, ell(), listOf(gateOnFirstWall()))!!
        val movedGate = plan.runs[0].gates.single()
        assertEquals(gateOnFirstWall().x + dx, movedGate.x, 0.0f)
        assertEquals(gateOnFirstWall().y + dy, movedGate.y, 0.0f)

        val before = GateGeometry.spansFor(listOf(gateOnFirstWall()), ell(), false, pxPerFt).single()
        val after = GateGeometry.spansFor(plan.runs[0].gates, plan.runs[0].points, false, pxPerFt).single()
        // The opening is the same size and on the same side; only where it is
        // on the page has changed.
        assertEquals(before.second.segmentIndex, after.second.segmentIndex)
        assertEquals(spanLength(before.second), spanLength(after.second), 0.0f)
    }

    private fun spanLength(span: GateSpan): Float = kotlin.math.hypot(
        (span.end.x - span.start.x).toDouble(), (span.end.y - span.start.y).toDouble()
    ).toFloat()

    @Test
    fun aGateKeepsItsWidthMountingAndSwing() {
        // A move that rebuilt the gate instead of copying it would quietly
        // reset the three fields that decide what gets bought.
        val gate = GateMarker(
            x = 220f, y = 100f, widthFt = 12f,
            mounting = GateMounting.WALL, swing = GateSwing.BOTH
        )
        val moved = shift(10f, 10f, ell(), listOf(gate))!!.runs[0].gates.single()
        assertEquals(gate.widthFt, moved.widthFt, 0.0f)
        assertEquals(gate.mounting, moved.mounting)
        assertEquals(gate.swing, moved.swing)
    }

    @Test
    fun markersMoveByTheSameOffsetAsTheFence() {
        // The house is the thing he lines the fence up against, so a fence
        // that moves and a house that does not is the move being useless.
        val plan = WholeDrawingMove.plan(
            runs = listOf(WholeDrawingMove.RunShift(ell(), listOf(gateOnFirstWall()))),
            markers = listOf(FencePoint(500f, 500f), FencePoint(-20f, 640f)),
            dx = 12.5f, dy = -4.25f
        )!!
        assertEquals(FencePoint(512.5f, 495.75f), plan.markers[0])
        assertEquals(FencePoint(-7.5f, 635.75f), plan.markers[1])
        // And by the SAME offset the points took: the relative position of
        // house to fence is the whole reason the drawing is worth anything.
        val dxPoint = plan.runs[0].points[0].x - ell()[0].x
        assertEquals(dxPoint, plan.markers[0].x - 500f, 0.0f)
    }

    @Test
    fun severalRunsAllMoveTogether() {
        val other = listOf(FencePoint(0f, 0f), FencePoint(60f, 0f))
        val plan = WholeDrawingMove.plan(
            runs = listOf(
                WholeDrawingMove.RunShift(ell(), emptyList()),
                WholeDrawingMove.RunShift(other, emptyList())
            ),
            markers = emptyList(), dx = 5f, dy = 7f
        )!!
        assertEquals(FencePoint(105f, 107f), plan.runs[0].points[0])
        assertEquals(FencePoint(5f, 7f), plan.runs[1].points[0])
        // Two runs that touched still touch -- which is what a joint between
        // them is billed on.
        val gapBefore = ell()[0].x - other[1].x
        val gapAfter = plan.runs[0].points[0].x - plan.runs[1].points[1].x
        assertEquals(gapBefore, gapAfter, 0.0f)
    }

    @Test
    fun aMoveThatGoesNowhereIsRefused() {
        assertNull(shift(0f, 0f, ell(), emptyList()))
        assertTrue(WholeDrawingMove.isUsableOffset(0f, 0.5f))
        assertTrue(WholeDrawingMove.isUsableOffset(-0.5f, 0f))
    }

    @Test
    fun aNonFiniteOffsetIsRefused() {
        assertNull(shift(Float.NaN, 10f, ell(), emptyList()))
        assertNull(shift(10f, Float.POSITIVE_INFINITY, ell(), emptyList()))
        assertNull(shift(Float.NEGATIVE_INFINITY, Float.NaN, ell(), emptyList()))
    }

    @Test
    fun allOrNothingOneUnholdableCoordinateRefusesTheWholeMove() {
        // The case: a drawing already out at the edge of what a Float holds.
        // Adding to it gives Infinity, and an Infinity coordinate measures the
        // whole fence at nothing. A plan that moved the other runs and skipped
        // this one would leave the drawing in two places at once.
        val faraway = listOf(FencePoint(Float.MAX_VALUE, 0f), FencePoint(10f, 10f))
        assertNull(
            WholeDrawingMove.plan(
                runs = listOf(
                    WholeDrawingMove.RunShift(ell(), emptyList()),
                    WholeDrawingMove.RunShift(faraway, emptyList())
                ),
                markers = emptyList(), dx = Float.MAX_VALUE, dy = 0f
            )
        )
    }

    @Test
    fun aMarkerAloneCanRefuseTheMove() {
        // The same all-or-nothing rule, reached through the markers rather
        // than the runs -- the arm that is easy to leave out of the check.
        assertNull(
            WholeDrawingMove.plan(
                runs = listOf(WholeDrawingMove.RunShift(ell(), emptyList())),
                markers = listOf(FencePoint(Float.MAX_VALUE, 0f)),
                dx = Float.MAX_VALUE, dy = 0f
            )
        )
    }

    @Test
    fun aGateAloneCanRefuseTheMove() {
        assertNull(
            WholeDrawingMove.plan(
                runs = listOf(
                    WholeDrawingMove.RunShift(
                        listOf(FencePoint(1f, 1f), FencePoint(2f, 2f)),
                        listOf(GateMarker(x = Float.MAX_VALUE, y = 0f, widthFt = 4f))
                    )
                ),
                markers = emptyList(), dx = Float.MAX_VALUE, dy = 0f
            )
        )
    }

    @Test
    fun puttingAMoveBackIsNotBitExactButIsExactEnoughToBeInvisible() {
        // THIS TEST CAUGHT A FALSE CLAIM OF MINE. It first asserted bit
        // equality, on the reasoning that a translation is undone by its own
        // negation. In floating point it is not: `(x + d) - d` rounds the sum
        // to the nearest representable float, and subtracting d back cannot
        // always recover what the rounding threw away. A corner at 100.0
        // moved by 123.456 and put back lands on 99.99999.
        //
        // So the claim is corrected rather than the code: the put-back is
        // right to within one rounding step of a float, which on this drawing
        // is about a ten-thousandth of an inch. What has to be true is that
        // nothing anybody sees or is billed can tell the difference, and that
        // is what is asserted here.
        val dx = 123.456f
        val dy = -78.9f
        val there = shift(dx, dy, ell(), listOf(gateOnFirstWall()))!!
        val (bx, by) = WholeDrawingMove.putBack(dx, dy)
        val back = WholeDrawingMove.plan(
            runs = listOf(WholeDrawingMove.RunShift(there.runs[0].points, there.runs[0].gates)),
            markers = emptyList(), dx = bx, dy = by
        )!!

        // A thousandth of a drawing pixel. At the grid's 20 px/ft that is a
        // twenty-thousandth of a foot -- four orders of magnitude below the
        // nearest thing the app rounds to.
        val slop = 0.001f
        ell().forEachIndexed { i, want ->
            assertEquals(want.x, back.runs[0].points[i].x, slop)
            assertEquals(want.y, back.runs[0].points[i].y, slop)
        }
        assertEquals(gateOnFirstWall().x, back.runs[0].gates.single().x, slop)
        assertEquals(gateOnFirstWall().y, back.runs[0].gates.single().y, slop)

        // THE CLAIM THAT MATTERS: the takeoff cannot tell the round trip
        // happened. Measured with the engine the quote is built from.
        assertEquals(
            FenceGeometryEngine.analyze(ell(), pxPerFt).totalLinearFeet,
            FenceGeometryEngine.analyze(back.runs[0].points, pxPerFt).totalLinearFeet,
            0.001f
        )
    }

    @Test
    fun theRoundTripErrorDoesNotGrowWithRepeatedMoves() {
        // If each move-and-put-back added its error to the last, enough of
        // them would walk the fence off the page. It cannot: each round trip
        // adds at most another rounding step, so twenty of them stay inside
        // the same slop one of them does.
        var points = ell()
        repeat(20) {
            val dx = 137.913f
            val dy = -64.277f
            val there = WholeDrawingMove.plan(
                runs = listOf(WholeDrawingMove.RunShift(points, emptyList())),
                markers = emptyList(), dx = dx, dy = dy
            )!!
            val (bx, by) = WholeDrawingMove.putBack(dx, dy)
            points = WholeDrawingMove.plan(
                runs = listOf(WholeDrawingMove.RunShift(there.runs[0].points, emptyList())),
                markers = emptyList(), dx = bx, dy = by
            )!!.runs[0].points
        }
        ell().forEachIndexed { i, want ->
            assertEquals(want.x, points[i].x, 0.01f)
            assertEquals(want.y, points[i].y, 0.01f)
        }
        assertEquals(
            FenceGeometryEngine.analyze(ell(), pxPerFt).totalLinearFeet,
            FenceGeometryEngine.analyze(points, pxPerFt).totalLinearFeet,
            0.001f
        )
    }

    @Test
    fun canaryAMoveThatForgotTheGatesIsCaught() {
        // If this cannot be spotted, the gate checks above are decoration.
        val lazyPlan = WholeDrawingMove.Plan(
            runs = listOf(
                WholeDrawingMove.RunShift(
                    points = ell().map { FencePoint(it.x + 150f, it.y) },
                    gates = listOf(gateOnFirstWall())   // <- left behind
                )
            ),
            markers = emptyList()
        )
        val spans = GateGeometry.spansFor(
            lazyPlan.runs[0].gates, lazyPlan.runs[0].points, false, pxPerFt
        )
        // The honest answer, from a move that carried the gate along.
        val honest = shift(150f, 0f, ell(), listOf(gateOnFirstWall()))!!
        val wanted = GateGeometry.spansFor(
            honest.runs[0].gates, honest.runs[0].points, false, pxPerFt
        ).single().second
        // The left-behind gate's opening is NOT where the carried one's is.
        val got = spans.singleOrNull()?.second
        assertTrue(
            "THE CANARY DID NOT FIRE: a gate left behind landed where a carried one would",
            got == null || got.start != wanted.start || got.end != wanted.end
        )
    }
}
