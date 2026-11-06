package com.fenceestimator.app.ui.components

import com.fenceestimator.app.data.JobPhoto
import com.fenceestimator.app.data.PhotoKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * TAPPING A PHOTO MUST OPEN THAT PHOTO.
 *
 * The thumbnails are grouped Before / After / Jobsite; the viewer walks the
 * whole job in one sequence. So "open the one I tapped" is an index from one
 * ordering into another, and an index into the wrong order opens somebody
 * else's driveway. That is the whole reason this is a pure function with a
 * test rather than an expression inside the composable.
 */
class PhotoViewerOrderTest {

    private fun photo(id: Long, kind: PhotoKind, path: String = "/p/$id.jpg") =
        JobPhoto(id = id, jobId = 1L, filePath = path, kind = kind)

    @Test
    fun `before then after then jobsite, oldest first inside each`() {
        val mixed = listOf(
            photo(5, PhotoKind.JOBSITE),
            photo(3, PhotoKind.AFTER),
            photo(1, PhotoKind.BEFORE),
            photo(4, PhotoKind.AFTER),
            photo(2, PhotoKind.BEFORE)
        )
        assertEquals(listOf(1L, 2L, 3L, 4L, 5L), PhotoViewerOrder.sorted(mixed).map { it.id })
    }

    @Test
    fun `the index is the tapped photo's place in that order`() {
        val mixed = listOf(
            photo(5, PhotoKind.JOBSITE),
            photo(3, PhotoKind.AFTER),
            photo(1, PhotoKind.BEFORE)
        )
        // Third in the list given, FIRST in the viewer's order.
        assertEquals(0, PhotoViewerOrder.indexOf(mixed, photo(1, PhotoKind.BEFORE)))
        assertEquals(1, PhotoViewerOrder.indexOf(mixed, photo(3, PhotoKind.AFTER)))
        assertEquals(2, PhotoViewerOrder.indexOf(mixed, photo(5, PhotoKind.JOBSITE)))
    }

    @Test
    fun `THE BUG THIS PREVENTS - the given order is not the viewer order`() {
        // If indexOf used the position in the incoming list, tapping the first
        // thumbnail of the AFTER strip would open a JOBSITE photo. This asserts
        // the two orderings genuinely differ, so the test above is not passing
        // by coincidence.
        val mixed = listOf(
            photo(5, PhotoKind.JOBSITE),
            photo(3, PhotoKind.AFTER),
            photo(1, PhotoKind.BEFORE)
        )
        val naive = mixed.indexOfFirst { it.id == 1L }
        val real = PhotoViewerOrder.indexOf(mixed, photo(1, PhotoKind.BEFORE))
        assertTrue("the two orderings are the same here, so this proves nothing", naive != real)
    }

    @Test
    fun `a photo that is not in the list opens the first one, never nothing`() {
        // indexOfFirst answers -1, and -1 as a start index is a viewer opened
        // on no photo at all. A photo deleted on another device between the
        // strip rendering and the tap landing is exactly this case.
        val list = listOf(photo(1, PhotoKind.BEFORE), photo(2, PhotoKind.AFTER))
        assertEquals(0, PhotoViewerOrder.indexOf(list, photo(99, PhotoKind.AFTER)))
    }

    @Test
    fun `an empty list has an index of zero rather than minus one`() {
        assertEquals(0, PhotoViewerOrder.indexOf(emptyList(), photo(1, PhotoKind.BEFORE)))
        assertTrue(PhotoViewerOrder.sorted(emptyList()).isEmpty())
    }

    @Test
    fun `photos still on their way keep their place`() {
        // A row arrives before its file, so filePath is blank for a while. The
        // viewer says so for that one photo; it must not be dropped from the
        // sequence, or the count ("3 of 5") would disagree with the strip and
        // a swipe would skip a gap.
        val list = listOf(
            photo(1, PhotoKind.BEFORE, path = ""),
            photo(2, PhotoKind.BEFORE)
        )
        assertEquals(2, PhotoViewerOrder.sorted(list).size)
        assertEquals(listOf(1L, 2L), PhotoViewerOrder.sorted(list).map { it.id })
    }

    @Test
    fun `every kind is placed, so a new one cannot fall out of the sequence`() {
        val one = PhotoKind.entries.map { photo(it.ordinal + 1L, it) }
        assertEquals(PhotoKind.entries.size, PhotoViewerOrder.sorted(one).size)
    }
}
