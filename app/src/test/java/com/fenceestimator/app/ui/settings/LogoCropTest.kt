package com.fenceestimator.app.ui.settings

import com.fenceestimator.app.ui.settings.LogoCrop.Shape
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The crop rectangle, on a JVM, with no Android and no screen.
 *
 * Every one of these is a bug that cannot be seen in a screenshot: a rectangle
 * one pixel outside the image, a drag at the edge that escapes its clamp, a
 * shape that drifts because both sides were scaled and rounded separately, an
 * image enlarged to a cap it was never near. They are the whole reason the
 * arithmetic is not inside the dialog.
 */
class LogoCropTest {

    // ---------------------------------------------------------------- shapes

    @Test
    fun `original is the whole image, whatever shape it is`() {
        for ((w, h) in listOf(100 to 100, 1000 to 40, 40 to 1000, 1 to 1)) {
            val r = LogoCrop.initialRect(w, h, LogoCrop.aspectOf(Shape.ORIGINAL))
            assertEquals(LogoCrop.Rect(0, 0, w, h), r)
        }
    }

    @Test
    fun `a wide crop of a square image takes the full width and is centred`() {
        val r = LogoCrop.initialRect(300, 300, LogoCrop.aspectOf(Shape.WIDE))
        assertEquals(300, r.width)
        assertEquals(100, r.height)
        // Centred: the same amount is left above and below.
        assertEquals(r.top, 300 - r.bottom)
    }

    @Test
    fun `a square crop of a wide image takes the full height and is centred`() {
        val r = LogoCrop.initialRect(1200, 300, LogoCrop.aspectOf(Shape.SQUARE))
        assertEquals(300, r.width)
        assertEquals(300, r.height)
        assertEquals(r.left, 1200 - r.right)
    }

    @Test
    fun `an initial rect is always inside the image`() {
        for (shape in Shape.values()) {
            for ((w, h) in listOf(1 to 1, 7 to 3, 4000 to 17, 17 to 4000, 640 to 480)) {
                val r = LogoCrop.initialRect(w, h, LogoCrop.aspectOf(shape))
                assertTrue("$shape ${w}x$h left", r.left >= 0)
                assertTrue("$shape ${w}x$h top", r.top >= 0)
                assertTrue("$shape ${w}x$h right", r.right <= w)
                assertTrue("$shape ${w}x$h bottom", r.bottom <= h)
                assertTrue("$shape ${w}x$h not empty", r.width >= 1 && r.height >= 1)
            }
        }
    }

    // ------------------------------------------------------------- zoom sense

    @Test
    fun `pinching out shows less of the image, not more`() {
        // The frame is fixed. Making the logo bigger in it means taking a
        // SMALLER piece of the image. Getting this backwards reads as the
        // control being inverted, so it is pinned.
        val start = LogoCrop.initialRect(900, 300, 3f)
        val zoomedIn = LogoCrop.transform(start, 900, 300, factor = 2f, panX = 0f, panY = 0f, aspect = 3f)
        assertTrue("pinch out took a bigger piece", zoomedIn.width < start.width)

        val zoomedOut = LogoCrop.transform(zoomedIn, 900, 300, factor = 0.5f, panX = 0f, panY = 0f, aspect = 3f)
        assertTrue("pinch in took a smaller piece", zoomedOut.width > zoomedIn.width)
    }

    @Test
    fun `zooming out stops at the image rather than running past it`() {
        val start = LogoCrop.initialRect(900, 300, 3f)
        var r = start
        repeat(10) { r = LogoCrop.transform(r, 900, 300, 0.25f, 0f, 0f, 3f) }
        assertTrue(r.width <= 900)
        assertTrue(r.height <= 300)
        assertTrue(r.left >= 0 && r.top >= 0)
    }

    @Test
    fun `zooming in stops before the crop becomes a pixel`() {
        var r = LogoCrop.initialRect(900, 300, 3f)
        repeat(20) { r = LogoCrop.transform(r, 900, 300, 4f, 0f, 0f, 3f) }
        assertTrue("crop collapsed to ${r.width}x${r.height}", r.width >= 16)
        assertTrue(r.height >= 1)
    }

    // ------------------------------------------------------------------ clamp

    @Test
    fun `no drag, however far, can move the crop outside the image`() {
        val image = 800 to 600
        var r = LogoCrop.initialRect(image.first, image.second, 1f)
        // Zoom in so there is room to move, then shove it in every direction
        // by more than the image is wide.
        r = LogoCrop.transform(r, image.first, image.second, 3f, 0f, 0f, 1f)
        for ((dx, dy) in listOf(
            9999f to 0f, -9999f to 0f, 0f to 9999f, 0f to -9999f,
            9999f to 9999f, -9999f to -9999f,
        )) {
            val moved = LogoCrop.transform(r, image.first, image.second, 1f, dx, dy, 1f)
            assertTrue("left $dx,$dy", moved.left >= 0)
            assertTrue("top $dx,$dy", moved.top >= 0)
            assertTrue("right $dx,$dy -> ${moved.right}", moved.right <= image.first)
            assertTrue("bottom $dx,$dy -> ${moved.bottom}", moved.bottom <= image.second)
        }
    }

    @Test
    fun `a drag at the edge does not escape by being clamped before it is applied`() {
        // The bug this pins: clamp-then-pan approves a position and then moves
        // away from it. Pushing hard left must leave the crop AT the left edge,
        // not past it and not bounced back to the middle.
        val start = LogoCrop.transform(
            LogoCrop.initialRect(1000, 400, 1f), 1000, 400, 2f, 0f, 0f, 1f
        )
        val pushed = LogoCrop.transform(start, 1000, 400, 1f, -5000f, 0f, 1f)
        assertEquals(0, pushed.left)
        val pushedRight = LogoCrop.transform(start, 1000, 400, 1f, 5000f, 0f, 1f)
        assertEquals(1000, pushedRight.right)
    }

    @Test
    fun `nudging repeatedly does not shrink the crop a pixel at a time`() {
        // Rounding in the wrong place makes every no-op nudge eat a pixel, so
        // a user who adjusts carefully ends up with a smaller crop than one
        // who does not.
        var r = LogoCrop.transform(LogoCrop.initialRect(1200, 400, 3f), 1200, 400, 1.5f, 0f, 0f, 3f)
        val widthAfterZoom = r.width
        repeat(40) { r = LogoCrop.transform(r, 1200, 400, 1f, 1f, 0f, 3f) }
        assertEquals("the crop shrank while being nudged", widthAfterZoom, r.width)
    }

    @Test
    fun `the shape is kept through zooming and dragging`() {
        var r = LogoCrop.initialRect(1600, 900, 3f)
        repeat(6) { i ->
            r = LogoCrop.transform(r, 1600, 900, if (i % 2 == 0) 1.3f else 0.9f, 7f, -5f, 3f)
            val aspect = r.width.toFloat() / r.height.toFloat()
            // One pixel of rounding either way on a crop of this size.
            assertTrue("aspect drifted to $aspect (${r.width}x${r.height})",
                kotlin.math.abs(aspect - 3f) < 0.06f)
        }
    }

    @Test
    fun `ORIGINAL ignores every gesture, because there is nothing to crop`() {
        val whole = LogoCrop.Rect(0, 0, 500, 200)
        val after = LogoCrop.transform(whole, 500, 200, 3f, 100f, 100f, null)
        assertEquals(whole, after)
    }

    // ----------------------------------------------------------- output size

    @Test
    fun `a small logo is never enlarged`() {
        assertEquals(90 to 30, LogoCrop.outputSize(90, 30, 1024))
        assertEquals(1024 to 300, LogoCrop.outputSize(1024, 300, 1024))
    }

    @Test
    fun `a big logo is scaled down by its long side, keeping its shape`() {
        val (w, h) = LogoCrop.outputSize(4000, 1000, 1024)
        assertEquals(1024, w)
        assertEquals(256, h)
        val (tw, th) = LogoCrop.outputSize(1000, 4000, 1024)
        assertEquals(1024, th)
        assertEquals(256, tw)
    }

    @Test
    fun `output size never returns zero`() {
        for ((w, h) in listOf(1 to 10000, 10000 to 1, 0 to 0, -5 to 10)) {
            val (ow, oh) = LogoCrop.outputSize(w, h, 1024)
            assertTrue("$w x $h -> $ow x $oh", ow >= 1 && oh >= 1)
        }
    }

    // -------------------------------------------------------------- rotation

    @Test
    fun `an odd number of quarter turns swaps the sides`() {
        assertEquals(400 to 300, LogoCrop.sizeAfterRotation(300, 400, 1))
        assertEquals(300 to 400, LogoCrop.sizeAfterRotation(300, 400, 2))
        assertEquals(400 to 300, LogoCrop.sizeAfterRotation(300, 400, 3))
        assertEquals(300 to 400, LogoCrop.sizeAfterRotation(300, 400, 4))
    }

    @Test
    fun `rotation handles negative and large turn counts the same way`() {
        assertEquals(LogoCrop.sizeAfterRotation(300, 400, 1), LogoCrop.sizeAfterRotation(300, 400, -3))
        assertEquals(LogoCrop.sizeAfterRotation(300, 400, 1), LogoCrop.sizeAfterRotation(300, 400, 9))
        assertEquals(LogoCrop.sizeAfterRotation(300, 400, 0), LogoCrop.sizeAfterRotation(300, 400, -4))
    }
}
