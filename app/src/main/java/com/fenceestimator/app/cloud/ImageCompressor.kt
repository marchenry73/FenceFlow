package com.fenceestimator.app.cloud

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import androidx.exifinterface.media.ExifInterface
import java.io.File

/**
 * Shrinks a job photo to something worth storing.
 *
 * A photo off a modern phone is four to eight megabytes. A crew takes a dozen
 * on a job. Uploading them untouched fills cloud storage quickly, and worse,
 * spends the crew's mobile data in a yard where the signal is already poor --
 * which is the moment the upload matters least and costs most.
 *
 * [MAX_EDGE] is the deliberate trade: sharp enough to show a customer real
 * damage, a finished line, or which post is leaning, and to zoom in a little
 * while doing it. Roughly 300-500KB per photo.
 *
 * ## What must NOT come through here, and why
 *
 * **Survey images.** The fence line drawn on a survey is stored in that
 * bitmap's own pixel coordinates, and the drawing's scale --
 * `calibrationPixelsPerFoot` -- is in the same space. Resize the image and
 * every point on it moves and every measurement taken from it is wrong by the
 * scale factor. A survey shrunk from 4000px to 1600px would silently reprice
 * every job drawn on it. Rescaling the points too is possible; doing it to
 * drawings that already exist is not worth the risk for a few megabytes.
 *
 * **Signatures.** Line art on white, and evidence that somebody agreed to
 * something. JPEG smears exactly the thin dark strokes that make a signature
 * recognisable, and they are small to begin with -- there is nothing to gain
 * and something real to lose.
 */
object ImageCompressor {

    /** Long edge, in pixels, after shrinking. */
    const val MAX_EDGE = 1600

    /** JPEG quality. High enough that compression is not visible at arm's length. */
    const val QUALITY = 82

    /**
     * Returns a compressed copy, or the original path when compressing would
     * not help or did not work.
     *
     * Never throws and never returns nothing: a photo that cannot be shrunk is
     * still a photo worth keeping, so the caller uploads the original rather
     * than dropping it.
     *
     * @param cacheDir where the temporary compressed copy goes. The caller
     *   deletes it once uploaded; it is a copy, never the user's own file.
     */
    fun compressForUpload(localPath: String, cacheDir: File): String {
        val source = File(localPath)
        if (!source.exists() || source.length() == 0L) return localPath

        return runCatching {
            // Measure first, so a large photo is decoded straight into a small
            // bitmap rather than being loaded whole and then shrunk. Loading a
            // 50-megapixel photo at full size to make a thumbnail of it is how
            // this runs out of memory on a cheap phone.
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(localPath, bounds)
            val longest = maxOf(bounds.outWidth, bounds.outHeight)
            if (longest <= 0) return localPath

            // Already small enough, and already a JPEG: re-encoding would only
            // lose quality for nothing.
            if (longest <= MAX_EDGE && source.length() < 600_000) return localPath

            var sample = 1
            while (longest / (sample * 2) >= MAX_EDGE) sample *= 2

            val decoded = BitmapFactory.decodeFile(
                localPath,
                BitmapFactory.Options().apply { inSampleSize = sample }
            ) ?: return localPath

            val scaled = scaleToMaxEdge(decoded)
            // A photo taken in portrait carries its rotation in EXIF rather
            // than in the pixels. Re-encoding drops EXIF, so without this the
            // photo arrives on the other phone lying on its side.
            val upright = applyExifRotation(scaled, localPath)

            val out = File(cacheDir, "upload_" + source.nameWithoutExtension + ".jpg")
            out.outputStream().use { stream ->
                upright.compress(Bitmap.CompressFormat.JPEG, QUALITY, stream)
            }

            if (upright !== decoded) decoded.recycle()
            if (upright !== scaled) scaled.recycle()
            upright.recycle()

            // Only worth it if it actually got smaller.
            if (out.length() in 1 until source.length()) out.absolutePath else localPath
        }.getOrDefault(localPath)
    }

    private fun scaleToMaxEdge(bitmap: Bitmap): Bitmap {
        val longest = maxOf(bitmap.width, bitmap.height)
        if (longest <= MAX_EDGE) return bitmap
        val ratio = MAX_EDGE.toFloat() / longest
        return Bitmap.createScaledBitmap(
            bitmap,
            (bitmap.width * ratio).toInt().coerceAtLeast(1),
            (bitmap.height * ratio).toInt().coerceAtLeast(1),
            true
        )
    }

    private fun applyExifRotation(bitmap: Bitmap, originalPath: String): Bitmap {
        val degrees = runCatching {
            when (
                ExifInterface(originalPath)
                    .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            ) {
                ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                else -> 0f
            }
        }.getOrDefault(0f)

        if (degrees == 0f) return bitmap
        val matrix = Matrix().apply { postRotate(degrees) }
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    }
}
