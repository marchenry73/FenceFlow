package com.fenceestimator.app.ui.survey

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Undo and Redo stay on screen in full-screen drawing.
 *
 * They sat in one row with the button on to the estimate, and the whole row
 * was wrapped in `if (!fullScreenDrawing)` -- while the comment above the run
 * picker said undo "already floats over the canvas" in either mode. So the
 * mode people turn on to draw was the one mode where a slip could not be
 * taken back without leaving it. Full screen now hides only the estimate
 * button; Undo and Redo keep their place and their round floating shape.
 *
 * Source-read: a Compose screen has no seam this suite can render (see
 * PushChildTableIsolationTest for the same tradeoff).
 */
class FullScreenUndoRedoTest {

    private fun bottomStart(): String {
        val src = listOf(
            File("src/main/java/com/fenceestimator/app/ui/survey/SurveyDrawScreen.kt"),
            File("app/src/main/java/com/fenceestimator/app/ui/survey/SurveyDrawScreen.kt")
        ).first { it.isFile }.readText()
        val start = src.indexOf("// BOTTOM-START:")
        val end = src.indexOf("// BOTTOM-CENTER:", start)
        assertTrue("the bottom-start controls moved -- move this test with them", start >= 0 && end > start)
        return src.substring(start, end)
    }

    @Test
    fun `undo and redo are not hidden by full screen`() {
        val block = bottomStart()
        val undo = block.indexOf("icon = Icons.Filled.Undo")
        val redo = block.indexOf("icon = Icons.Filled.Redo")
        assertTrue("Undo is gone from the bottom-start controls", undo >= 0)
        assertTrue("Redo is gone from the bottom-start controls", redo >= 0)
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
        val block = bottomStart()
        val estimate = block.indexOf("R.string.draw_to_estimate")
        assertTrue(estimate >= 0)
        val guard = block.lastIndexOf("if (!fullScreenDrawing)", estimate)
        assertTrue("the estimate button is no longer hidden in full screen", guard >= 0)
        assertTrue(
            "the full-screen check wraps more than the estimate button",
            guard > block.indexOf("icon = Icons.Filled.Redo")
        )
    }
}
