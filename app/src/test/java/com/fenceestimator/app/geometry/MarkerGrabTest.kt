package com.fenceestimator.app.geometry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A HOUSE IS GRABBABLE BY ITS BODY, NOT ONLY BY ITS CENTRE DOT.
 *
 * The hit test measured to the marker's stored point with a 40 px reach,
 * which was the whole truth while a marker was a dot. Once a house could
 * carry a size and draw as a box, pressing its body grabbed nothing -- and a
 * drag that grabs nothing is discarded in silence, so the house did not move
 * and nothing said why. "The house marker keeps reverting" includes that
 * case, and it is the one that needs no network at all.
 *
 * The controls here matter more than the assertions. A hit test that said
 * "yes" to everything would pass every "can grab" test in this file, so each
 * group is paired with a press that must MISS.
 */
class MarkerGrabTest {

    private val slop = MARKER_GRAB_SLOP_PX

    /** A 30 ft x 50 ft house at 4 canvas px per foot, square to the road. */
    private fun house(
        tapX: Float,
        tapY: Float,
        rotationDeg: Float = 0f,
    ): Float? = markerGrabDistance(
        cx = 500f, cy = 400f,
        halfW = 60f, halfH = 100f,
        rotationDeg = rotationDeg,
        tapX = tapX, tapY = tapY,
        slopPx = slop,
    )

    @Test
    fun `a press in the middle of the house grabs it`() {
        assertNotNull("the centre of the box must be grabbable", house(500f, 400f))
        assertEquals(0f, house(500f, 400f)!!, 0.001f)
    }

    /**
     * THE BUG. 150 px below the centre is well inside a box that reaches 100
     * px down -- and 150 is far outside the 40 px circle the old test used.
     */
    @Test
    fun `a press on the body of the house, far from its centre, grabs it`() {
        assertNotNull("pressing inside the box must grab it", house(500f, 530f))
        assertNotNull(house(550f, 480f))
        assertNotNull("a corner of the box", house(555f, 495f))
    }

    @Test
    fun `a press just outside the edge still grabs it, by the slop`() {
        // 100 px half-height + 40 slop = 140. 135 is in, 145 is out.
        assertNotNull(house(500f, 400f + 135f))
        assertNull(house(500f, 400f + 145f))
    }

    /**
     * A CONTROL. Without this every assertion above would pass against a
     * function that returned a distance for any input whatsoever.
     */
    @Test
    fun `a press nowhere near the house misses`() {
        assertNull("far to the right", house(900f, 400f))
        assertNull("far below", house(500f, 900f))
        assertNull("diagonally away", house(800f, 800f))
    }

    /**
     * A house is almost never square to the road, and the box is drawn
     * rotated. The hit area has to rotate with it or a turned house is
     * grabbable where it is not drawn and not grabbable where it is.
     */
    @Test
    fun `the hit area turns with the box`() {
        // Rotated 90 degrees, the 60x100 half-extents swap: a point 130 px to
        // the RIGHT is now inside (it is along the long axis), while the same
        // 130 px BELOW is outside.
        assertNotNull("along the long axis after a quarter turn", house(500f + 130f, 400f, rotationDeg = 90f))
        assertNull("across the short axis after a quarter turn", house(500f, 400f + 130f, rotationDeg = 90f))

        // CONTROL: unrotated, those two answers are the other way round, so
        // the test above is measuring the rotation and not a constant.
        assertNull(house(500f + 130f, 400f, rotationDeg = 0f))
        assertNotNull(house(500f, 400f + 130f, rotationDeg = 0f))
    }

    @Test
    fun `a half turn grabs the same places as no turn at all`() {
        for ((x, y) in listOf(500f to 530f, 550f to 480f, 500f to 400f, 900f to 400f)) {
            val flat = house(x, y, rotationDeg = 0f)
            val turned = house(x, y, rotationDeg = 180f)
            assertEquals(
                "a half turn changed whether ($x, $y) grabs",
                flat == null, turned == null
            )
        }
    }

    /**
     * A marker with no size must behave EXACTLY as it did before this
     * function existed: a circle of 40 px about its point. Anything wider
     * would start stealing taps from the fence vertices underneath.
     */
    @Test
    fun `a marker with no size is still a 40 pixel circle`() {
        fun dot(tapX: Float, tapY: Float) = markerGrabDistance(
            cx = 100f, cy = 100f, halfW = 0f, halfH = 0f, rotationDeg = 0f,
            tapX = tapX, tapY = tapY, slopPx = slop,
        )
        assertNotNull(dot(100f, 100f))
        assertNotNull("just inside 40", dot(100f + 39f, 100f))
        assertNull("just outside 40", dot(100f + 41f, 100f))
        // Round, not square: 30 px on each axis is 42.4 away and must miss.
        assertNull("the corner of a square would be a hit; a circle is not", dot(130f, 130f))
    }

    /** A half-size of zero on ONE axis is not a box. Treat it as a point. */
    @Test
    fun `a size on only one axis falls back to the point behaviour`() {
        val wideOnly = markerGrabDistance(
            cx = 0f, cy = 0f, halfW = 200f, halfH = 0f, rotationDeg = 0f,
            tapX = 150f, tapY = 0f, slopPx = slop,
        )
        assertNull("200 px of width with no height is not a box to grab", wideOnly)
    }

    /**
     * Two markers over one another resolve to the nearer CENTRE, which is
     * what the old nearest-point test did and what makes a small marker on
     * top of a big one still reachable.
     */
    @Test
    fun `the returned distance orders overlapping markers by their centres`() {
        val big = markerGrabDistance(
            cx = 500f, cy = 400f, halfW = 200f, halfH = 200f, rotationDeg = 0f,
            tapX = 520f, tapY = 400f, slopPx = slop,
        )
        val small = markerGrabDistance(
            cx = 525f, cy = 400f, halfW = 10f, halfH = 10f, rotationDeg = 0f,
            tapX = 520f, tapY = 400f, slopPx = slop,
        )
        assertNotNull(big); assertNotNull(small)
        assertTrue(
            "the marker whose centre is nearer must win: big=$big small=$small",
            small!! < big!!
        )
    }
}
