package com.fenceestimator.app.ui.survey

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Undo and Redo stay on screen in full-screen drawing, and stay out of every
 * band another overlay can occupy.
 *
 * They sat in one row with the button on to the estimate, and the whole row
 * was wrapped in `if (!fullScreenDrawing)` -- so the mode people turn on to
 * draw was the one mode where a slip could not be taken back without leaving
 * it. Then they moved to the right edge, where seven stacked buttons ran into
 * NudgePad and off the bottom of a landscape canvas. They now live in the
 * TOP-CENTER group, under the mode switcher: the one band PropertyInfoPanel
 * (bottom, opaque, up to 360dp wide and tall when expanded), the view-control
 * column (right) and NudgePad (bottom-right) all stay out of.
 *
 * This test does NOT pin them to a corner -- that is what made its first
 * version fail the moment they were moved for a good reason. It pins the two
 * things that must hold wherever they are: they are not behind a full-screen
 * check, and they are not in a band something else draws over.
 *
 * Source-read: a Compose screen has no seam this suite can render (see
 * PushChildTableIsolationTest for the same tradeoff).
 */
class FullScreenUndoRedoTest {

    private val src: String = listOf(
        File("src/main/java/com/fenceestimator/app/ui/survey/SurveyDrawScreen.kt"),
        File("app/src/main/java/com/fenceestimator/app/ui/survey/SurveyDrawScreen.kt")
    ).first { it.isFile }.readText()

    /** The source between two of the overlay's band comments. */
    private fun band(from: String, to: String): String {
        val start = src.indexOf(from)
        val end = src.indexOf(to, start + 1)
        assertTrue(
            "the overlay bands were renamed (" + from + " .. " + to + ") -- move this test with them",
            start >= 0 && end > start
        )
        return src.substring(start, end)
    }

    private fun undoBand(): String {
        // Wherever the pair lives, it is the band that holds Undo.
        val bands = listOf(
            "// TOP-CENTER:" to "// TOP-END:",
            "// TOP-END:" to "// BOTTOM-START:",
            "// BOTTOM-START:" to "// BOTTOM-CENTER:"
        )
        val found = bands.map { band(it.first, it.second) }
            .filter { it.contains("icon = Icons.Filled.Undo") }
        assertTrue("Undo is not in any of the overlay's bands any more", found.size == 1)
        return found.single()
    }

    @Test
    fun `undo and redo are not hidden by full screen`() {
        val block = undoBand()
        val undo = block.indexOf("icon = Icons.Filled.Undo")
        val redo = block.indexOf("icon = Icons.Filled.Redo")
        assertTrue("Redo is not beside Undo any more", redo >= 0)
        val guard = Regex("""if\s*\(\s*!\s*fullScreenDrawing\s*\)""")
        assertFalse(
            "Undo or Redo sits behind a full-screen check again",
            guard.containsMatchIn(block.substring(0, maxOf(undo, redo)))
        )
        // Still the undo and redo they were.
        assertTrue(block.contains("viewModel.undoLast()"))
        assertTrue(block.contains("viewModel.redo()"))
    }

    @Test
    fun `only the estimate button leaves in full screen`() {
        val block = band("// BOTTOM-START:", "// BOTTOM-CENTER:")
        val estimate = block.indexOf("R.string.draw_to_estimate")
        assertTrue("the estimate button left the bottom-start band", estimate >= 0)
        val guard = block.lastIndexOf("if (!fullScreenDrawing)", estimate)
        assertTrue("the estimate button is no longer hidden in full screen", guard >= 0)
        // Nothing else is inside that check -- the band holds the button alone.
        assertFalse(
            "the full-screen check wraps more than the estimate button",
            block.contains("icon = Icons.Filled.Undo") || block.contains("icon = Icons.Filled.Redo")
        )
    }

    /**
     * The right-edge column is what Undo/Redo were taken OUT of. Five 48dp
     * buttons is 272dp; seven was 392dp, which NudgePad met on a normal phone
     * and which did not fit a landscape canvas at all. A sixth control added
     * here later should fail this and be thought about, not discovered on a
     * phone.
     */
    @Test
    fun `the right-edge column stays short enough to fit`() {
        val block = band("// TOP-END:", "// BOTTOM-START:")
        val buttons = Regex("""(ToolIconButton|ZoomButton)\s*\(""").findAll(block).count()
        assertTrue(
            "the right-edge column is up to $buttons controls; over five it runs into NudgePad",
            buttons in 1..5
        )
    }
}
