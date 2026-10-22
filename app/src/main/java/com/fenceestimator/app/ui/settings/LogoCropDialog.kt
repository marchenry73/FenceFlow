package com.fenceestimator.app.ui.settings

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

/**
 * Pick the part of a picture that is the logo, and turn it the right way up.
 *
 * WHY THIS EXISTS. The logo a contractor has is a photograph of a van door, a
 * screenshot with white space round it, or a 4000-pixel export from whoever
 * made their signs. Uploading any of those puts the wrong thing on a customer's
 * quote: a sliver of van, a letterhead floating in a margin, or four megabytes
 * for a picture rendered 220 pixels wide.
 *
 * WHAT IT DOES NOT DO. There is no brightness, no contrast, no background
 * removal and no filters. Those are an image editor, and an image editor that
 * is three buttons short of a real one is worse than none -- the honest answer
 * for "I need to change the picture itself" is to change the picture.
 *
 * ALL THE ARITHMETIC IS IN [LogoCrop], with its own tests. What is here is the
 * gesture, the drawing and the encode -- and the drawing and the crop read the
 * SAME rectangle, so what is seen in the frame is what is saved.
 */

/** The picked image, decoded small enough to work with. */
private const val MAX_WORKING_SIDE = 2048

/** The long side of what is actually uploaded. */
private const val MAX_OUTPUT_SIDE = 1024

@Composable
fun LogoCropDialog(
    source: Bitmap,
    onCancel: () -> Unit,
    onUse: (bytes: ByteArray, mimeType: String) -> Unit,
) {
    var shape by remember { mutableStateOf(LogoCrop.Shape.ORIGINAL) }
    var quarterTurns by remember { mutableStateOf(0) }
    // Off, 0 and 0: a logo that was already fine must come out of this dialog
    // byte-for-byte what it would have been before any of this existed.
    var knockOutWhite by remember { mutableStateOf(false) }
    var brightness by remember { mutableStateOf(0f) }
    var contrast by remember { mutableStateOf(0f) }
    // The bitmap as it is being LOOKED AT -- rotated, if they turned it.
    // Rotating the pixels once and cropping the result is one transform to get
    // right; rotating the crop rectangle instead is two, and the second one is
    // where a 90-degree mirror hides.
    val turned = remember(source, quarterTurns) { rotated(source, quarterTurns) }
    // The bitmap as it is being LOOKED AT. The knockout is a per-pixel pass,
    // so it is done once when the switch moves rather than per frame, and the
    // preview and the encoder both read THIS -- one bitmap, so what is in the
    // frame is what is saved.
    var shown by remember(turned) { mutableStateOf(turned) }
    LaunchedEffect(turned, knockOutWhite) {
        shown = if (!knockOutWhite) turned
        else withContext(Dispatchers.Default) { whiteKnockedOut(turned) }
    }
    var rect by remember(shown, shape) {
        mutableStateOf(LogoCrop.initialRect(shown.width, shown.height, LogoCrop.aspectOf(shape)))
    }
    // Re-seeded whenever the shape changes, so switching Wide -> Square starts
    // from a sensible square rather than from whatever the wide crop was.
    LaunchedEffect(shown, shape) {
        rect = LogoCrop.initialRect(shown.width, shown.height, LogoCrop.aspectOf(shape))
    }
    var frame by remember { mutableStateOf(IntSize.Zero) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    AlertDialog(
        onDismissRequest = { if (!busy) onCancel() },
        title = { Text(stringResource(R.string.set_logo_crop_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    stringResource(R.string.set_logo_crop_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                // White behind it, always: a logo drawn for paper is dark on
                // nothing, and on a dark theme it would be invisible here
                // while printing perfectly.
                Canvas(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(180.dp)
                        .background(Color.White)
                        .pointerInput(shown, shape) {
                            detectTransformGestures { _, pan, zoom, _ ->
                                val f = frame
                                if (f.width <= 0 || f.height <= 0) return@detectTransformGestures
                                // A drag of N screen pixels moves the image
                                // under the frame, so the rectangle moves the
                                // OTHER way -- and by however many image pixels
                                // one screen pixel is currently worth.
                                val perPixel = rect.width.toFloat() / f.width.toFloat()
                                rect = LogoCrop.transform(
                                    current = rect,
                                    imageWidth = shown.width,
                                    imageHeight = shown.height,
                                    factor = zoom,
                                    panX = -pan.x * perPixel,
                                    panY = -pan.y * perPixel,
                                    aspect = LogoCrop.aspectOf(shape),
                                )
                            }
                        }
                ) {
                    frame = IntSize(size.width.toInt(), size.height.toInt())
                    // ONE rectangle: this is drawn, and this is saved.
                    drawImage(
                        image = shown.asImageBitmap(),
                        srcOffset = IntOffset(rect.left, rect.top),
                        srcSize = IntSize(rect.width.coerceAtLeast(1), rect.height.coerceAtLeast(1)),
                        dstOffset = IntOffset.Zero,
                        dstSize = IntSize(size.width.toInt(), size.height.toInt()),
                        // The SAME numbers the encoder uses, so the picture in
                        // the frame is the picture that gets saved.
                        colorFilter = if (brightness == 0f && contrast == 0f) null
                        else ColorFilter.colorMatrix(
                            ColorMatrix(LogoCrop.colorMatrix(brightness, contrast))
                        ),
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (s in LogoCrop.Shape.values()) {
                        FilterChip(
                            selected = shape == s,
                            onClick = { if (!busy) shape = s },
                            label = {
                                Text(
                                    stringResource(
                                        when (s) {
                                            LogoCrop.Shape.ORIGINAL -> R.string.set_logo_shape_original
                                            LogoCrop.Shape.WIDE -> R.string.set_logo_shape_wide
                                            LogoCrop.Shape.SQUARE -> R.string.set_logo_shape_square
                                        }
                                    )
                                )
                            },
                        )
                    }
                }
                TextButton(onClick = { if (!busy) quarterTurns += 1 }) {
                    Text(stringResource(R.string.set_logo_rotate))
                }

                // The white behind a JPG logo, taken out. A switch rather than
                // a slider: there is one sensible threshold and a number to
                // tune would be one more thing to get wrong on a phone in a
                // van. He can see the result before he saves it.
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Switch(checked = knockOutWhite, enabled = !busy, onCheckedChange = { knockOutWhite = it })
                    Spacer(Modifier.width(10.dp))
                    Column {
                        Text(
                            stringResource(R.string.set_logo_remove_white),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text(
                            stringResource(R.string.set_logo_remove_white_hint),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }

                Text(
                    stringResource(R.string.set_logo_brightness),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Slider(
                    value = brightness,
                    onValueChange = { if (!busy) brightness = it },
                    valueRange = -0.5f..0.5f,
                )
                Text(
                    stringResource(R.string.set_logo_contrast),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Slider(
                    value = contrast,
                    onValueChange = { if (!busy) contrast = it },
                    valueRange = -0.5f..0.5f,
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy,
                onClick = {
                    busy = true
                    // Encoding a 1024-pixel PNG is not frame work. The scope is
                    // the composition's, so a dialog dismissed mid-encode takes
                    // the encode with it rather than calling back into a screen
                    // that has gone.
                    val r = rect
                    val bmp = shown
                    val br = brightness
                    val co = contrast
                    scope.launch {
                        val bytes = withContext(Dispatchers.Default) { encodePng(bmp, r, br, co) }
                        busy = false
                        if (bytes != null) onUse(bytes, "image/png") else onCancel()
                    }
                }
            ) { Text(stringResource(R.string.set_logo_use)) }
        },
        dismissButton = {
            TextButton(enabled = !busy, onClick = onCancel) {
                Text(stringResource(R.string.action_cancel))
            }
        },
    )
}

/**
 * The picked file, decoded at a size worth working with.
 *
 * A phone camera photo is twelve megapixels; decoded whole it is 48 MB of
 * bitmap, which is how an image picker becomes an out-of-memory crash on the
 * cheapest phone on the crew. inSampleSize halves it until it fits, which is
 * free -- the decoder never allocates the full size at all.
 *
 * Returns null rather than throwing: a file that will not decode is answered
 * with a sentence, not a stack trace.
 */
suspend fun decodeForLogo(context: Context, uri: Uri): Bitmap? = withContext(Dispatchers.IO) {
    runCatching {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > MAX_WORKING_SIDE) sample *= 2
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) }
    }.getOrNull()
}

/** [source] turned [quarterTurns] quarter-turns clockwise. Zero turns is free. */
private fun rotated(source: Bitmap, quarterTurns: Int): Bitmap {
    val turns = ((quarterTurns % 4) + 4) % 4
    if (turns == 0) return source
    val m = Matrix().apply { postRotate(90f * turns) }
    return runCatching {
        Bitmap.createBitmap(source, 0, 0, source.width, source.height, m, true)
    }.getOrDefault(source)
}

/**
 * The chosen rectangle, scaled down if it is big, as PNG bytes.
 *
 * PNG, not JPEG: a logo is flat colour and hard edges, which is exactly what
 * JPEG is worst at -- and a logo with transparency would be given a black
 * background by JPEG, which is how a white wordmark ends up unreadable on a
 * quote. The size cost is paid once, by one file per company.
 */
/**
 * Every white-enough pixel turned transparent.
 *
 * One pass, on a bitmap already capped at MAX_WORKING_SIDE, off the main
 * thread. ARGB_8888 because the source may be an opaque JPG with no alpha
 * channel at all -- writing transparency into a bitmap that cannot hold it is
 * a no-op that looks like the switch did nothing.
 */
private fun whiteKnockedOut(source: Bitmap): Bitmap = runCatching {
    val w = source.width
    val h = source.height
    val pixels = IntArray(w * h)
    source.getPixels(pixels, 0, w, 0, 0, w, h)
    for (i in pixels.indices) {
        val p = pixels[i]
        val r = (p shr 16) and 0xFF
        val g = (p shr 8) and 0xFF
        val b = p and 0xFF
        if (LogoCrop.isBackgroundWhite(r, g, b)) pixels[i] = 0
    }
    Bitmap.createBitmap(pixels, w, h, Bitmap.Config.ARGB_8888)
}.getOrDefault(source)

private fun encodePng(
    source: Bitmap,
    rect: LogoCrop.Rect,
    brightness: Float = 0f,
    contrast: Float = 0f,
): ByteArray? = runCatching {
    val left = rect.left.coerceIn(0, source.width - 1)
    val top = rect.top.coerceIn(0, source.height - 1)
    val width = rect.width.coerceIn(1, source.width - left)
    val height = rect.height.coerceIn(1, source.height - top)
    val cropped = Bitmap.createBitmap(source, left, top, width, height)
    val (outW, outH) = LogoCrop.outputSize(cropped.width, cropped.height, MAX_OUTPUT_SIDE)
    val scaled =
        if (outW == cropped.width && outH == cropped.height) cropped
        else Bitmap.createScaledBitmap(cropped, outW, outH, true)
    // Brightness and contrast go on LAST, after the scale, through the same
    // matrix the preview drew with. Nothing happens at all when both are zero,
    // so a logo nobody adjusted comes out exactly as it did before any of this
    // existed.
    val finished =
        if (brightness == 0f && contrast == 0f) scaled
        else runCatching {
            val out = Bitmap.createBitmap(scaled.width, scaled.height, Bitmap.Config.ARGB_8888)
            android.graphics.Canvas(out).drawBitmap(
                scaled, 0f, 0f,
                android.graphics.Paint().apply {
                    isAntiAlias = true
                    colorFilter = android.graphics.ColorMatrixColorFilter(
                        android.graphics.ColorMatrix(LogoCrop.colorMatrix(brightness, contrast))
                    )
                }
            )
            out
        }.getOrDefault(scaled)
    ByteArrayOutputStream().use { out ->
        finished.compress(Bitmap.CompressFormat.PNG, 100, out)
        out.toByteArray()
    }
}.getOrNull()
