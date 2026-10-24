package com.fenceestimator.app.geometry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/**
 * THE GRID'S OWN RULES, CHECKED ACROSS MANY SHAPES RATHER THAN A FEW.
 *
 * He asked for the grid to be flawless and named three symptoms: lines landing
 * in the wrong place or jumping, lengths or footage reading wrong, and things
 * vanishing or coming back. The existing geometry tests are green, so whatever
 * is left is where they do not look -- which is the usual place for a bug to
 * live.
 *
 * So these are PROPERTIES, not examples. Each one is a sentence the drawing
 * must satisfy for EVERY shape, checked over a spread of generated runs:
 * open and closed, two corners to twelve, square corners and awkward angles,
 * tiny sides and long ones. A property test finds the shape that breaks the
 * rule; an example test only ever finds what its author already suspected.
 *
 * The generator is deterministic -- a fixed seed, no clock, no randomness the
 * next run cannot reproduce -- so a failure here is a failure anybody can
 * repeat, and the shape that caused it is printed with it.
 */
class GridInvariantsTest {

    private val pxPerFt = 20f

    /** A reproducible pseudo-random source: same sequence every run, for ever. */
    private class Seeded(private var s: Int) {
        fun next(): Float {
            s = s * 1664525 + 1013904223
            return ((s ushr 8) and 0xFFFFFF) / 16777216f
        }
        fun between(lo: Float, hi: Float) = lo + next() * (hi - lo)
        fun int(lo: Int, hi: Int) = lo + (next() * (hi - lo + 1)).toInt().coerceAtMost(hi - lo)
    }

    /** A spread of shapes worth measuring: not all neat, not all awkward. */
    private fun shapes(): List<Triple<String, List<FencePoint>, Boolean>> {
        val out = mutableListOf<Triple<String, List<FencePoint>, Boolean>>()
        out += Triple("straight 100ft", listOf(FencePoint(0f, 0f), FencePoint(2000f, 0f)), false)
        out += Triple("L", listOf(FencePoint(0f, 0f), FencePoint(2000f, 0f), FencePoint(2000f, 1200f)), false)
        out += Triple(
            "square yard",
            listOf(FencePoint(0f, 0f), FencePoint(800f, 0f), FencePoint(800f, 600f), FencePoint(0f, 600f)),
            true
        )
        out += Triple(
            "diagonal",
            listOf(FencePoint(2508.652f, 394.14835f), FencePoint(2190.7705f, 304.57584f)),
            false
        )
        val r = Seeded(20261024)
        repeat(40) { k ->
            val n = r.int(2, 12)
            val pts = (0 until n).map { FencePoint(r.between(-4000f, 4000f), r.between(-4000f, 4000f)) }
            // A closed shape needs at least three corners to be one.
            out += Triple("random#$k n=$n", pts, n >= 3 && k % 2 == 0)
        }
        return out
    }

    private fun sides(points: List<FencePoint>, closed: Boolean): List<Float> =
        (0 until sideCount(points.size, closed)).mapNotNull { sideLengthFeet(points, it, pxPerFt, closed) }

    // -----------------------------------------------------------------------
    // "Lengths or footage read wrong"
    // -----------------------------------------------------------------------

    @Test
    fun `the sides add up to the total the takeoff prices`() {
        // THE ONE THAT WOULD BE MONEY. Every dimension label on the plan is a
        // side length; the estimate prices totalLinearFeet. If those two ever
        // disagree, the drawing shows one number and the customer is charged
        // for another, and nothing on screen says which is right.
        shapes().forEach { (name, pts, closed) ->
            if (pts.size < 2) return@forEach
            val total = FenceGeometryEngine.analyze(pts, pxPerFt, closed).totalLinearFeet
            val sum = sides(pts, closed).sum()
            // Float addition in a different order, so an exact match is not
            // owed -- but a thousandth of a foot across a whole fence is.
            assertEquals("$name: labels sum to $sum, takeoff prices $total", total, sum, 0.001f)
        }
    }

    @Test
    fun `a closed loop measures exactly one more side than the same shape open`() {
        // The closing side is real fence and gets billed. It was once missing
        // from the plan entirely, which is how a yard could be quoted a side
        // short.
        shapes().filter { it.second.size >= 3 }.forEach { (name, pts, _) ->
            val open = FenceGeometryEngine.analyze(pts, pxPerFt, false)
            val closed = FenceGeometryEngine.analyze(pts, pxPerFt, true)
            assertEquals("$name: side count", open.segments.size + 1, closed.segments.size)
            val closing = sideLengthFeet(pts, pts.size - 1, pxPerFt, true)!!
            assertEquals(
                "$name: closing the loop must add exactly the closing side",
                closed.totalLinearFeet, open.totalLinearFeet + closing, 0.001f
            )
        }
    }

    // -----------------------------------------------------------------------
    // "Lines land in the wrong place or jump"
    // -----------------------------------------------------------------------

    @Test
    fun `a typed length lands exactly, on every shape`() {
        // setSideLength promises the corner lands where the takeoff measures
        // the typed number -- "not a rounding error above it, which the takeoff
        // would round up into an extra bay". That promise is the whole reason
        // to type a length, so it is checked on every side of every shape
        // rather than on one.
        shapes().forEach { (name, pts, closed) ->
            val n = sideCount(pts.size, closed)
            (0 until n).forEach { i ->
                listOf(10f, 47.5f, 96f, 250f).forEach { feet ->
                    val edit = setSideLength(pts, emptyList(), i, feet, pxPerFt, closed) ?: return@forEach
                    val got = sideLengthFeet(edit.points, i, pxPerFt, closed) ?: return@forEach
                    assertTrue(
                        "$name side $i typed $feet ft, measures $got",
                        abs(got - feet) <= 0.0005f
                    )
                }
            }
        }
    }

    @Test
    fun `typing one side of an OPEN run leaves every other side alone`() {
        // "correcting the first leg of an L does not silently change the
        // second leg the user never touched". A side that moves on its own is
        // exactly "lines jump", and it changes the price of a side nobody
        // edited.
        shapes().filter { !it.third && it.second.size >= 3 }.forEach { (name, pts, _) ->
            val before = sides(pts, false)
            (0 until sideCount(pts.size, false)).forEach { i ->
                val edit = setSideLength(pts, emptyList(), i, 80f, pxPerFt, false) ?: return@forEach
                val after = sides(edit.points, false)
                assertEquals("$name: side count changed", before.size, after.size)
                after.indices.filter { it != i }.forEach { j ->
                    assertEquals(
                        "$name: typing side $i moved side $j (${before[j]} -> ${after[j]})",
                        before[j], after[j], 0.002f
                    )
                }
            }
        }
    }

    @Test
    fun `typing a side never moves the corner the run starts from`() {
        // Everything on the plan was measured from the first corner. If it
        // drifts, every side is still the right length and the whole fence has
        // moved -- which looks exactly like "lines jump".
        shapes().forEach { (name, pts, closed) ->
            (0 until sideCount(pts.size, closed)).forEach { i ->
                val edit = setSideLength(pts, emptyList(), i, 60f, pxPerFt, closed) ?: return@forEach
                assertEquals("$name: typing side $i moved the first corner", pts[0], edit.points[0])
            }
        }
    }

    @Test
    fun `a side set to the length it already has changes nothing at all`() {
        // The quietest way to corrupt a drawing: open the dialog, press OK
        // without changing the number, and have the shape shift underneath.
        shapes().forEach { (name, pts, closed) ->
            (0 until sideCount(pts.size, closed)).forEach { i ->
                val now = sideLengthFeet(pts, i, pxPerFt, closed) ?: return@forEach
                if (now < 0.5f) return@forEach
                val edit = setSideLength(pts, emptyList(), i, now, pxPerFt, closed) ?: return@forEach
                edit.points.indices.forEach { k ->
                    assertTrue(
                        "$name: re-typing side $i its own length ($now) moved corner $k " +
                            "from ${pts[k]} to ${edit.points[k]}",
                        abs(edit.points[k].x - pts[k].x) <= 0.05f &&
                            abs(edit.points[k].y - pts[k].y) <= 0.05f
                    )
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Snapping: the other half of "lines land in the wrong place"
    // -----------------------------------------------------------------------

    @Test
    fun `a vertex snap lands exactly on the corner it snapped to`() {
        // Two ends that LOOK joined but are a thousandth of a foot apart are
        // billed two end posts instead of one shared. The snap must return the
        // existing corner, not a copy near it.
        val other = listOf(FencePoint(1000f, 1000f), FencePoint(1600f, 1000f))
        val r = Seeded(99)
        repeat(60) {
            val near = FencePoint(1000f + r.between(-20f, 20f), 1000f + r.between(-20f, 20f))
            val snap = snapDrawPoint(
                candidate = near,
                previous = null,
                beforePrevious = null,
                otherVertices = other,
                pxPerFt = pxPerFt,
            )
            if (snap.kind == SnapKind.VERTEX) {
                assertEquals("a vertex snap must land ON the corner", other[0], snap.point)
            }
        }
    }
}
