package com.fenceestimator.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil.compose.AsyncImage
import com.fenceestimator.app.R
import com.fenceestimator.app.data.JobPhoto

/**
 * A JOB'S PHOTOS, FULL SCREEN, ONE AT A TIME.
 *
 * MARCH, 6 Nov 2026: "For the pictures also, I want to be able to open the
 * pictures so I can see the before and after pictures and any other pictures,
 * I want to be ablet to open them."
 *
 * Until this, a photo was a 90dp thumbnail in a row and nothing else -- which
 * is no use at all for the thing photos are for here: standing with a customer
 * and showing them the before against the after.
 *
 * ACROSS EVERY KIND, NOT WITHIN ONE. The thumbnails are grouped Before /
 * After / Jobsite, but the comparison the owner described crosses those
 * groups, so the viewer walks the whole job in one sequence and names the kind
 * of each as it goes. Grouping the swipe by kind would mean backing out of one
 * strip and into another to do the one thing he asked for.
 *
 * NO HorizontalPager. This project has never used one; it lives in
 * androidx.compose.foundation.pager behind an experimental opt-in, and
 * introducing it for this would put a compiler flag between the owner and his
 * photos. A horizontal drag gesture and two arrows do the same job with APIs
 * already in use here.
 *
 * A ROW CAN ARRIVE BEFORE ITS FILE -- the row comes down with the job and
 * JobFileUploader.downloadMissing() fetches the picture on a later pass -- so a
 * blank path is said out loud, exactly as the thumbnail strip does it. Drawing
 * AsyncImage("") would give a black screen that reads as a broken photo rather
 * than one still on its way.
 */
@Composable
fun PhotoViewer(
    photos: List<JobPhoto>,
    startAt: Int,
    onClose: () -> Unit
) {
    if (photos.isEmpty()) return

    // Clamped, not trusted. A photo deleted while the viewer is open, or an
    // index taken from a list that has since been filtered, would otherwise be
    // an out-of-bounds read on the first frame.
    var index by remember { mutableIntStateOf(startAt.coerceIn(0, photos.lastIndex)) }
    val at = index.coerceIn(0, photos.lastIndex)
    val photo = photos[at]

    Dialog(
        onDismissRequest = onClose,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black)
        ) {
            Box(
                Modifier
                    .fillMaxSize()
                    // The drag is consumed per gesture, with a threshold, so a
                    // shaky thumb on a work glove does not count as a swipe and
                    // a single drag cannot skip several photos.
                    // KEYED ON `at` AS WELL AS THE COUNT. Without `at` the
                    // gesture lambda keeps the index it captured when it was
                    // first set up, so the FIRST swipe works and every one
                    // after it re-sets the same photo -- found on the owner's
                    // phone: 2 of 4, swipe, 3 of 4, swipe, still 3 of 4. The
                    // arrows were fine throughout because they recompose,
                    // which is what made it easy to miss.
                    .pointerInput(photos.size, at) {
                        var travelled = 0f
                        detectHorizontalDragGestures(
                            onDragStart = { travelled = 0f },
                            onDragEnd = {
                                if (travelled <= -60f && at < photos.lastIndex) index = at + 1
                                else if (travelled >= 60f && at > 0) index = at - 1
                            }
                        ) { _, delta -> travelled += delta }
                    },
                contentAlignment = Alignment.Center
            ) {
                if (photo.filePath.isBlank()) {
                    Text(
                        androidx.compose.ui.res.stringResource(R.string.jd_photo_on_its_way),
                        color = Color.White,
                        style = MaterialTheme.typography.bodyMedium
                    )
                } else {
                    AsyncImage(
                        model = photo.filePath,
                        contentDescription = photo.kind.label(),
                        // FIT, never Crop: a cropped photo at full screen hides
                        // the edges of the fence, which is the part being shown.
                        contentScale = ContentScale.Fit,
                        modifier = Modifier.fillMaxSize()
                    )
                }
            }

            // Which photo this is, and of how many. Without the count there is
            // no way to tell a one-photo job from a swipe that is not working.
            Column(Modifier.align(Alignment.TopStart).padding(16.dp)) {
                Text(
                    photo.kind.label(),
                    color = Color.White,
                    style = MaterialTheme.typography.titleMedium
                )
                Text(
                    androidx.compose.ui.res.stringResource(
                        R.string.photo_viewer_position, at + 1, photos.size
                    ),
                    color = Color.White.copy(alpha = 0.75f),
                    style = MaterialTheme.typography.bodySmall
                )
            }

            Box(
                Modifier
                    .align(Alignment.TopEnd)
                    .padding(8.dp)
                    .size(48.dp)
                    .clickable(onClick = onClose),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    Icons.Filled.Close,
                    contentDescription = androidx.compose.ui.res.stringResource(R.string.photo_viewer_close),
                    tint = Color.White
                )
            }

            // Arrows as well as the swipe: a swipe is undiscoverable, and these
            // are the only way through the set with one hand full of fence.
            // Each is hidden at its end of the set rather than disabled, so
            // there is no control that looks pressable and does nothing.
            Row(
                Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .padding(24.dp),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Box(Modifier.size(56.dp), contentAlignment = Alignment.Center) {
                    if (at > 0) {
                        Icon(
                            Icons.Filled.ChevronLeft,
                            contentDescription = androidx.compose.ui.res.stringResource(R.string.photo_viewer_previous),
                            tint = Color.White,
                            modifier = Modifier.size(48.dp).clickable { index = at - 1 }
                        )
                    }
                }
                Box(Modifier.size(56.dp), contentAlignment = Alignment.Center) {
                    if (at < photos.lastIndex) {
                        Icon(
                            Icons.Filled.ChevronRight,
                            contentDescription = androidx.compose.ui.res.stringResource(R.string.photo_viewer_next),
                            tint = Color.White,
                            modifier = Modifier.size(48.dp).clickable { index = at + 1 }
                        )
                    }
                }
            }
        }
    }
}

/**
 * The order the viewer walks: Before, then After, then Jobsite, and oldest
 * first inside each.
 *
 * Pure, so it can be tested without Compose -- and it is the part worth
 * testing, because "open the one I tapped" is an INDEX into this list and an
 * index into the wrong order opens the wrong photo. [PhotoViewerOrder.indexOf]
 * is what the thumbnail strip hands to [PhotoViewer].
 */
object PhotoViewerOrder {

    private val KIND_ORDER = listOf(
        com.fenceestimator.app.data.PhotoKind.BEFORE,
        com.fenceestimator.app.data.PhotoKind.AFTER,
        com.fenceestimator.app.data.PhotoKind.JOBSITE
    )

    fun sorted(photos: List<JobPhoto>): List<JobPhoto> =
        photos.sortedWith(
            compareBy(
                { KIND_ORDER.indexOf(it.kind).let { i -> if (i < 0) KIND_ORDER.size else i } },
                { it.id }
            )
        )

    /**
     * Where [photo] sits in [sorted], or 0 if it is not there at all -- never
     * -1, which as a start index would mean the viewer opened on nothing.
     */
    fun indexOf(photos: List<JobPhoto>, photo: JobPhoto): Int =
        sorted(photos).indexOfFirst { it.id == photo.id }.coerceAtLeast(0)
}
