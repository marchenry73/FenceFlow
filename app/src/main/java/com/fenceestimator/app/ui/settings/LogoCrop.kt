package com.fenceestimator.app.ui.settings

/**
 * THE ARITHMETIC OF CROPPING A LOGO, with no Android in it.
 *
 * Separated from the dialog on purpose. What goes wrong in a crop is never the
 * buttons -- it is the rectangle: an off-by-one in the inverse transform puts
 * a sliver of the next pixel row in, a clamp in the wrong order lets the image
 * be dragged off its own frame, and a scale that rounds the wrong way crops
 * one pixel more each time the user nudges it. None of that can be seen in a
 * screenshot and all of it can be tested here, in plain Kotlin, on a JVM.
 *
 * THE MODEL. There is one source of truth and it is [sourceRect]: the
 * rectangle OF THE IMAGE that the frame is showing. The dialog draws exactly
 * that rectangle into the frame, and the crop saves exactly that rectangle.
 * They cannot disagree, because there is only one of them -- the alternative
 * (draw with a transform, then invert the transform to crop) is where the
 * sliver bugs live.
 */
object LogoCrop {

    /** What shape the saved logo is. */
    enum class Shape {
        /** No crop at all: the whole image, whatever shape it is. */
        ORIGINAL,

        /** Three times as wide as it is tall -- what a letterhead usually is. */
        WIDE,

        /** Square, for a badge or a roundel. */
        SQUARE,
    }

    /** The aspect this shape asks for, or null for "whatever the image is". */
    fun aspectOf(shape: Shape): Float? = when (shape) {
        Shape.ORIGINAL -> null
        Shape.WIDE -> 3f
        Shape.SQUARE -> 1f
    }

    /** A rectangle in image pixels. Right and bottom are exclusive. */
    data class Rect(val left: Int, val top: Int, val right: Int, val bottom: Int) {
        val width: Int get() = right - left
        val height: Int get() = bottom - top
    }

    /**
     * The largest rectangle of [aspect] that fits inside [imageWidth] x
     * [imageHeight], centred, before the user has moved anything.
     *
     * Centred rather than top-left because a logo is usually in the middle of
     * whatever it was photographed or exported in, and because a default the
     * user has to correct every time is not a default.
     */
    fun initialRect(imageWidth: Int, imageHeight: Int, aspect: Float?): Rect {
        if (imageWidth <= 0 || imageHeight <= 0) return Rect(0, 0, 0, 0)
        if (aspect == null || aspect <= 0f) return Rect(0, 0, imageWidth, imageHeight)
        val imageAspect = imageWidth.toFloat() / imageHeight.toFloat()
        val w: Int
        val h: Int
        if (imageAspect > aspect) {
            // The image is wider than the shape: full height, narrower width.
            h = imageHeight
            w = (imageHeight * aspect).toInt().coerceAtLeast(1).coerceAtMost(imageWidth)
        } else {
            w = imageWidth
            h = (imageWidth / aspect).toInt().coerceAtLeast(1).coerceAtMost(imageHeight)
        }
        val left = (imageWidth - w) / 2
        val top = (imageHeight - h) / 2
        return Rect(left, top, left + w, top + h)
    }

    /**
     * The same rectangle zoomed by [factor] about its own centre and then moved
     * by [panX] / [panY] IMAGE PIXELS, kept inside the image.
     *
     * The order is the point. Zoom first, then pan, then clamp -- clamping
     * before the pan lets a drag at the edge move the rectangle somewhere the
     * clamp has already approved, which is how a crop ends up with a black
     * strip down one side. Clamping LAST is the only order where the answer is
     * always inside the image.
     *
     * A rectangle that cannot fit (zoomed out past the image) is grown only as
     * far as the image allows and then centred, rather than refused: a user
     * pinching out is asking for "as much as there is".
     */
    fun transform(
        current: Rect,
        imageWidth: Int,
        imageHeight: Int,
        factor: Float,
        panX: Float,
        panY: Float,
        aspect: Float?,
    ): Rect {
        if (imageWidth <= 0 || imageHeight <= 0) return Rect(0, 0, 0, 0)
        if (aspect == null) return Rect(0, 0, imageWidth, imageHeight)

        val safeFactor = if (factor.isFinite() && factor > 0f) factor else 1f
        val centreX = (current.left + current.right) / 2f
        val centreY = (current.top + current.bottom) / 2f

        // DIVIDING by the factor, and that is not a slip.
        //
        // The frame is a fixed box on the screen; this rectangle is the part of
        // the IMAGE shown inside it. A pinch out (factor > 1) means "make the
        // logo bigger in the frame", and the only way to do that with a fixed
        // frame is to show LESS of the image -- a smaller source rectangle.
        // Multiplying would zoom the wrong way, which reads as the control
        // being inverted rather than as a maths error.
        var w = current.width / safeFactor
        // The height follows from the width and the shape, rather than being
        // scaled on its own: scaling both and rounding each would let the two
        // drift apart until the crop was no longer the shape that was asked
        // for.
        var h = w / aspect
        if (h > imageHeight) { h = imageHeight.toFloat(); w = h * aspect }
        if (w > imageWidth) { w = imageWidth.toFloat(); h = w / aspect }
        // A crop smaller than this is not a logo, it is a pixel.
        val minW = minOf(16f, imageWidth.toFloat())
        if (w < minW) { w = minW; h = w / aspect }
        if (h > imageHeight) { h = imageHeight.toFloat(); w = h * aspect }

        var left = centreX - w / 2f + panX
        var top = centreY - h / 2f + panY

        // LAST, always.
        left = left.coerceIn(0f, (imageWidth - w).coerceAtLeast(0f))
        top = top.coerceIn(0f, (imageHeight - h).coerceAtLeast(0f))

        val l = left.toInt()
        val t = top.toInt()
        val r = (l + w.toInt()).coerceAtMost(imageWidth)
        val b = (t + h.toInt()).coerceAtMost(imageHeight)
        return Rect(l, t, r.coerceAtLeast(l + 1), b.coerceAtLeast(t + 1))
    }

    /**
     * How big the saved image should be, with the long side capped at [maxLongSide].
     *
     * NEVER ENLARGED. A 90-pixel-wide logo blown up to 1024 is a blurry 90-pixel
     * logo in a bigger file -- it costs upload time and storage to make it look
     * worse. Scaling down is the only direction worth taking.
     */
    fun outputSize(width: Int, height: Int, maxLongSide: Int): Pair<Int, Int> {
        if (width <= 0 || height <= 0) return 1 to 1
        val longSide = maxOf(width, height)
        if (longSide <= maxLongSide) return width to height
        val scale = maxLongSide.toFloat() / longSide
        return (width * scale).toInt().coerceAtLeast(1) to
            (height * scale).toInt().coerceAtLeast(1)
    }

    /**
     * The image's size after [quarterTurns] quarter-turns clockwise.
     *
     * An odd number of turns swaps the sides. Said once, here, because getting
     * it wrong gives a crop frame of the right shape over an image of the
     * wrong one, and the result looks like the crop is ignoring the user.
     */
    fun sizeAfterRotation(width: Int, height: Int, quarterTurns: Int): Pair<Int, Int> {
        val turns = ((quarterTurns % 4) + 4) % 4
        return if (turns % 2 == 0) width to height else height to width
    }

    // ---------------------------------------------------- making it look right

    /**
     * Brightness and contrast as one 4x5 colour matrix.
     *
     * A logo is usually an export, and an export is usually fine. The ones
     * that are not are the photographed ones -- a sign, a van door, a printed
     * letterhead -- which come out grey and flat, and no amount of cropping
     * helps them. Two numbers fix almost all of those.
     *
     * @param brightness -1 (black) .. 0 (unchanged) .. 1 (white). Added to
     *   every channel, so it moves the whole image rather than stretching it.
     * @param contrast -1 (flat grey) .. 0 (unchanged) .. 1 (hard). Scales
     *   around the mid grey 128, which is why the translate term carries the
     *   `(1 - scale) * 128` that keeps mid grey where it is; scaling around
     *   zero instead darkens everything as a side effect, which looks like a
     *   broken brightness control.
     *
     * ALPHA IS LEFT ALONE. Row four is the identity, so a transparent logo
     * stays transparent and the knockout below is not quietly undone.
     */
    fun colorMatrix(brightness: Float, contrast: Float): FloatArray {
        val b = brightness.coerceIn(-1f, 1f) * 255f
        val scale = 1f + contrast.coerceIn(-1f, 1f)
        val t = (1f - scale) * 128f + b
        return floatArrayOf(
            scale, 0f, 0f, 0f, t,
            0f, scale, 0f, 0f, t,
            0f, 0f, scale, 0f, t,
            0f, 0f, 0f, 1f, 0f,
        )
    }

    /** The default knockout threshold: how close to white counts as the paper. */
    const val WHITE_THRESHOLD = 236

    /**
     * Whether this pixel is the white background rather than part of the logo.
     *
     * WHY IT IS WORTH HAVING AT ALL. A logo saved as a JPG has no transparency,
     * so it carries its own white rectangle everywhere it goes -- and FenceFlow
     * puts it on the quote page, on the PDF header and at the top of the emails
     * it sends. On anything but a white background that rectangle is a white
     * box with a logo floating in it, which is the single thing that makes a
     * small contractor's quote look homemade.
     *
     * EVERY channel must be above the threshold, not the average. Averaging
     * makes a saturated yellow (255, 255, 0) read as near-white and punches
     * holes in the logo itself.
     *
     * Deliberately NOT a flood fill from the edges. A flood fill is the
     * cleverer answer and it fails on the common case: a logo with white
     * INSIDE it -- a letter counter, a white outline -- keeps its white while
     * the background goes, so half the picture is knocked out and half is not.
     * A threshold treats both the same, which is at least predictable, and the
     * owner can see the result before he saves it.
     */
    fun isBackgroundWhite(r: Int, g: Int, b: Int, threshold: Int = WHITE_THRESHOLD): Boolean =
        r >= threshold && g >= threshold && b >= threshold
}
