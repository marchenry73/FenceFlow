package com.fenceestimator.app.survey

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The survey photo is SAVED -- kept, not discarded -- and the drawing screen
 * can use it, hide it and fit it without ever writing a scale of its own.
 *
 * "For the survey, I just want it to be saved, and also the option to use it in
 * the picture and for it to be recalibrated in there to fit."
 *
 * Source-read, like GridExtentTest and GuestReadOnlyTest, because the view model
 * and the screen need Android and Compose and cannot be run off a device. What
 * can be run -- the scale rules and the fit arithmetic -- is held to behaviour
 * in [SurveyFitTest]; this file pins that the code which has to CALL those rules
 * does, and that the things it must never do are not there.
 *
 * Every pin has a planted failure beside it: the same check run against a
 * hand-built copy of the old, wrong shape, which must trip it.
 */
class SurveySavedTest {

    private fun source(path: String): String = listOf(
        File("src/main/java/com/fenceestimator/app/$path"),
        File("app/src/main/java/com/fenceestimator/app/$path")
    ).first { it.isFile }.readText()

    /**
     * Code only. These files explain themselves at length -- including by quoting the
     * exact lines they no longer contain -- and a check that reads the explanation as
     * if it were code trips on its own history.
     */
    private fun stripComments(src: String): String =
        src.replace(Regex("""/\*[\s\S]*?\*/"""), "").replace(Regex("""(?m)^\s*//[^\n]*"""), "")

    private val viewModel: String get() = stripComments(source("ui/survey/SurveyViewModel.kt"))
    private val screen: String get() = stripComments(source("ui/survey/SurveyDrawScreen.kt"))

    /** The body of the function whose signature starts with [signature], by brace balance. */
    private fun bodyOf(src: String, signature: String): String {
        val at = src.indexOf(signature)
        assertTrue("could not find $signature -- it was renamed or removed; move this test with it", at >= 0)
        val open = src.indexOf('{', at)
        var depth = 0
        for (i in open until src.length) {
            if (src[i] == '{') depth++
            else if (src[i] == '}') {
                depth--
                if (depth == 0) return src.substring(open, i + 1)
            }
        }
        throw AssertionError("braces never balanced for $signature -- the file may be mid-edit")
    }

    // ---- "Use Grid" keeps the survey ---------------------------------------

    private fun removesTheSurvey(body: String): Boolean =
        Regex("""surveyImagePath\s*=\s*null""").containsMatchIn(body) ||
            Regex("""surveyStoragePath\s*=\s*null""").containsMatchIn(body)

    @Test
    fun `Use Grid never removes the survey from the job`() {
        val body = bodyOf(viewModel, "fun clearSurveyImage() {")
        assertFalse(
            "clearSurveyImage must not write either survey field null. Clearing the local path is " +
                "undone by the next sync (the storage path travels and the photo is downloaded again), and " +
                "clearing the storage path is dropped from the update the phone sends (explicitNulls = false) " +
                "and merged back from the row the server returns. The owner asked for the survey to be SAVED.",
            removesTheSurvey(body)
        )
        assertTrue("the choice is remembered where it can be", body.contains("rememberSurveyShown(false)"))
    }

    @Test
    fun `the survey-removal check has teeth -- planted failure`() {
        val old = """
            fun clearSurveyImage() {
                repository.updateJob(current.copy(surveyImagePath = null, calibrationPixelsPerFoot = null))
            }
        """.trimIndent()
        assertTrue("the old local-only clear must trip the check", removesTheSurvey(old))
        val olderStill = "repository.updateJob(current.copy(surveyStoragePath = null))"
        assertTrue("clearing the travelling path must trip it too", removesTheSurvey(olderStill))
        assertFalse(removesTheSurvey("current.copy(calibrationPixelsPerFoot = seed, calibrationKnownFeet = null)"))
    }

    @Test
    fun `no function in the view model removes the survey from a job`() {
        // Not just clearSurveyImage: nothing here may write either field null. The
        // photo is attached by importImage and detached by nothing.
        assertFalse(
            "a surveyImagePath/surveyStoragePath = null write has appeared in SurveyViewModel",
            removesTheSurvey(viewModel)
        )
    }

    // ---- one survey per job, and a failed copy is not a survey -------------

    @Test
    fun `importImage refuses a second survey and a failed copy`() {
        val body = bodyOf(viewModel, "fun importImage(context: Context, uri: Uri) {")
        assertTrue("the guest refusal comes first", body.trimStart('{', ' ', '\n', '\r').startsWith("if (viewerIsGuestDemo()) return"))
        assertTrue(
            "a job that already has a survey -- on this phone OR in cloud storage -- must refuse the import",
            body.contains("DrawingScale.hasSavedSurvey(")
        )
        assertTrue("and say so", body.contains("ImportRefusal.ALREADY_HAS_SURVEY"))
        assertTrue(
            "a copy that produced no file must not become the job's survey",
            body.contains("outFile.length() > 0L") && body.contains("ImportRefusal.COULD_NOT_READ")
        )
        // The check happens BEFORE the bytes are copied, and again after (a sync can land the
        // cloud's photo while they copy).
        val firstCheck = body.indexOf("DrawingScale.hasSavedSurvey(")
        val copy = body.indexOf("copyTo(")
        val secondCheck = body.indexOf("DrawingScale.hasSavedSurvey(", firstCheck + 1)
        assertTrue(firstCheck in 0 until copy)
        assertTrue("checked again after the copy", secondCheck > copy)
        assertFalse(
            "a photo is attached through surveyImagePath only; the storage path is the uploader's to set",
            Regex("""surveyStoragePath\s*=""").containsMatchIn(body)
        )
    }

    // ---- no grid scale is ever written onto a photo job ---------------------

    @Test
    fun `the grid-scale writers all ask whether this is a photo JOB, not whether the file is on this phone`() {
        listOf(
            "fun ensureGridCalibration() {",
            "fun setGridExtent(extentFt: Float) {",
            "suspend fun ensureSatelliteCalibration(): SatelliteCalibration {",
        ).forEach { signature ->
            val body = bodyOf(viewModel, signature)
            assertTrue(
                "$signature must refuse a photo job by DrawingScale.isPhotoJob -- a job whose photo is in " +
                    "cloud storage but has not downloaded here yet is a photo job, and gets no grid scale",
                body.contains("DrawingScale.isPhotoJob(current)")
            )
            assertFalse(
                "$signature asks only about the local file again -- the second-phone / offline hole",
                body.contains("current.surveyImagePath != null")
            )
        }
    }

    @Test
    fun `the photo-job guard check has teeth -- planted failure`() {
        val old = """
            fun setGridExtent(extentFt: Float) {
                val current = job.value ?: return
                if (current.surveyImagePath != null) return
            }
        """.trimIndent()
        val body = bodyOf(old, "fun setGridExtent(extentFt: Float) {")
        assertTrue("the old local-only guard is present in the planted body", body.contains("current.surveyImagePath != null"))
        assertFalse("and carries no photo-JOB question", body.contains("DrawingScale.isPhotoJob(current)"))
    }

    @Test
    fun `the screen never writes a calibration or touches the repository itself`() {
        // The screen asks the view model, which asks DrawingScale / DrawingFit. A scale written from
        // a composable would be a second place that can disagree with the rules.
        assertFalse(
            "a calibration is being written from SurveyDrawScreen",
            Regex("""calibrationPixelsPerFoot\s*=""").containsMatchIn(screen.replace(Regex("""//[^\n]*"""), ""))
        )
        assertFalse("the screen reaches into the repository", screen.contains("repository."))
    }

    @Test
    fun `recalibrating re-prices the stored materials, for the people who may, like a drawing change does`() {
        val calibrate = bodyOf(viewModel, "fun applyCalibration(p1: FencePoint, p2: FencePoint, knownFeet: Float) {")
        assertTrue("the guest refusal still comes first", calibrate.trimStart('{', ' ', '\n', '\r').startsWith("if (viewerIsGuestDemo()) return"))
        assertTrue(
            "a new scale changes every length on the drawing; the stored materials must follow it",
            calibrate.contains("repriceAfterScaleChange()")
        )
        val reprice = bodyOf(viewModel, "private suspend fun repriceAfterScaleChange() {")
        assertTrue("only a phone that prices, and never the crew's read-only plan", reprice.contains("viewerMayReprice()") && reprice.contains("repriceOnDrawingChange"))
        assertTrue("through the same refresher a drawing change uses", reprice.contains("TakeoffRefresher.refreshRun("))
        assertTrue("and the same failure banner", reprice.contains("_repriceFailed.value = true"))
    }

    // ---- fitting ---------------------------------------------------------------

    @Test
    fun `fitSurvey carries the drawing and its scale together, and writes the scale last`() {
        val body = bodyOf(viewModel, "fun fitSurvey(fit: PhotoFit) {")
        assertTrue("the guest refusal comes first", body.trimStart('{', ' ', '\n', '\r').startsWith("if (viewerIsGuestDemo()) return"))
        assertTrue("the arithmetic and the footage check live in DrawingFit.plan", body.contains("DrawingFit.plan("))
        assertTrue("the job's scale is carried by DrawingFit.jobAfter, not a number written here", body.contains("DrawingFit.jobAfter("))
        assertTrue("a fit is refused, nothing written, when there is no plan", body.contains("_fitRefused.tryEmit(Unit)"))
        assertTrue("only a photo job is fitted -- the grid is resized with setGridExtent", body.contains("DrawingScale.isPhotoJob("))
        assertTrue("it runs to the end even if the screen closes", body.contains("NonCancellable"))
        assertTrue("one drawing change at a time", body.contains("drawingWrites.withLock"))
        // Order: runs, then markers, then the job -- the scale goes last.
        val runs = body.indexOf("repository.updateFenceRun(")
        val markers = body.indexOf("repository.updateSiteMarker(")
        val job = body.indexOf("repository.updateJob(")
        assertTrue("runs are written", runs > 0)
        assertTrue("markers are written after the runs", markers > runs)
        assertTrue("the scale is written LAST, after every run and marker", job > markers)
        assertFalse(
            "fitSurvey must not clear or seed a scale itself -- only DrawingFit.jobAfter writes one",
            Regex("""\.copy\([^)]*calibration""").containsMatchIn(body) || body.contains("unitsPerFoot(")
        )
    }

    @Test
    fun `fitting is offered only over a photo that has a scale to carry`() {
        // Not a floating control (the right-edge column is capped at five -- see
        // FullScreenUndoRedoTest); it lives in Layers, and only while a photo is showing.
        assertTrue(
            "fitAvailable must require a photo on screen and a scale that exists",
            Regex("""fitAvailable\s*=\s*!usingGrid\s*&&\s*\(\s*dialogBasis == ScaleBasis\.MEASURED \|\| dialogBasis == ScaleBasis\.UNMEASURED\s*\)""")
                .containsMatchIn(screen)
        )
        assertTrue(
            "a photo with no scale is told to calibrate first, not offered a fit that cannot carry one",
            screen.contains("fitNeedsScale = !usingGrid && dialogBasis == ScaleBasis.NONE")
        )
    }

    @Test
    fun `a fit is a draft until Apply, and leaving drops it`() {
        assertTrue("Back drops the draft", screen.contains("BackHandler(enabled = fitActive) { fitDraft = null }"))
        assertTrue("picking another tool drops the draft", screen.contains("LaunchedEffect(mode) { fitDraft = null }"))
        assertTrue("Apply is off until the photo has moved", screen.contains("applyEnabled = !draft.isIdentity"))
        // The only writer of a fit is the one call under Apply.
        assertEquals(1, Regex("""viewModel\.fitSurvey\(""").findAll(screen).count())
    }

    @Test
    fun `while a fit is being lined up the drawing layer ignores touches`() {
        val layer = screen.substringAfter(".pointerInput(mode, committedPoints, bmp, activeRun.id, usingGrid, gates, siteMarkers, fitActive) {")
        val firstStatement = layer.trimStart().substringBefore("when (mode)")
        assertTrue(
            "a tap must not drop a corner while the photo is being lined up",
            firstStatement.contains("if (fitActive) {") && firstStatement.contains("return@pointerInput")
        )
    }

    // ---- no string the build cannot find ---------------------------------------

    @Test
    fun `every string resource these two files name exists in all three locales`() {
        // A reference to a resource that is missing from any locale fails the WHOLE build. The survey
        // controls' own wording is looked up by name with an English fallback (fitText), so it cannot
        // do that -- but nothing else in these files may reference a resource that is not there.
        val res = listOf(File("src/main/res"), File("app/src/main/res")).first { it.isDirectory }
        val locales = listOf("values", "values-es", "values-fr").map { dir ->
            File(res, dir).listFiles { f -> f.name.startsWith("strings") && f.name.endsWith(".xml") }!!
                .flatMap { f -> Regex("""<string\s+name="([^"]+)"""").findAll(f.readText()).map { it.groupValues[1] }.toList() }
                .toSet()
        }
        val named = (Regex("""R\.string\.([A-Za-z0-9_]+)""").findAll(screen).map { it.groupValues[1] } +
            Regex("""R\.string\.([A-Za-z0-9_]+)""").findAll(viewModel).map { it.groupValues[1] }).toSet()
        assertTrue("expected the screen to name string resources", named.size > 20)
        val missing = named.filter { n -> locales.any { n !in it } }
        assertTrue("string resources named but missing from a locale: $missing", missing.isEmpty())
    }
}
