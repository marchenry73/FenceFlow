package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.Job
import com.fenceestimator.app.geometry.FenceGeometryEngine
import com.fenceestimator.app.geometry.FencePoint
import com.fenceestimator.app.geometry.GateMarker
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.pow

/**
 * The scale a job's drawing is measured at, worked out in ONE place.
 *
 * This lived in SurveyViewModel's companion, where the drawing screen used it
 * and nothing else could without reaching into a view model. So the estimate
 * side kept its own idea of the scale: EstimateViewModel's Suggest wrote a
 * flat 20 units per foot onto any grid job that had no calibration, whatever
 * size the grid was. On the default 400 ft grid that is the same number; on a
 * 100 ft grid (80 units per foot) it told the drawing it was a quarter of the
 * scale it was drawn at, so pressing Suggest made every side read four times
 * its length on the plan and in the takeoff that followed.
 *
 * Pure -- no Android, no database -- so the rule is held to a test
 * (DrawingScaleSharedTest) and every caller reads the same answer.
 *
 * [isPhotoJob] IS used by [EstimateEngine.linearFeet] and
 * [EstimateEngine.teardownLinearFeet] (both go through the shared private
 * `footageOf`, which calls it once): an uncalibrated GRID run bills its flat
 * [PIXELS_PER_FOOT_GRID] footage (a grid square is a known size), while an
 * uncalibrated PHOTO run bills nothing rather than a guessed scale. This
 * used to be one undifferentiated 0 ft for every uncalibrated run, grid or
 * photo, which is what let a grid run bill full materials
 * (suggestQuantities, measured at the same grid fallback) and zero labour
 * for the identical footage. [TakeoffRefresher.blockedByUncalibratedPhoto]
 * applies the identical photo check before materials are (re)generated, and
 * the server closes the same gap at the boundary (see load.ts
 * buildPricingInput) rather than in this file, which nothing on the server
 * imports.
 */
object DrawingScale {

    /**
     * Units per foot on the no-photo grid, for a job that has not chosen a
     * size. Kept as the old fixed value so existing drawings measure exactly
     * what they always did.
     */
    const val PIXELS_PER_FOOT_GRID = 20f

    /** Virtual canvas size (width == height) used when there's no survey photo -- 400ft x 400ft of drawable area. */
    const val GRID_CANVAS_SIZE = 8000

    /** Units per foot for a grid covering [extentFt] across. */
    fun unitsPerFoot(extentFt: Float): Float =
        if (extentFt <= 0f) PIXELS_PER_FOOT_GRID
        else GRID_CANVAS_SIZE / extentFt

    /**
     * The scale a drawing is measured at, in canvas units per foot, or null
     * when it genuinely has none yet.
     *
     * A stored calibration always wins. Without one, a grid drawing (no
     * survey photo) still has a scale: the grid's own, [unitsPerFoot] of its
     * extent -- the value SurveyViewModel.ensureGridCalibration would have
     * seeded and the one setGridExtent rescales from. Only a photo nobody has
     * calibrated has no answer: the app cannot know how big the picture is,
     * and the screen asks for a calibration instead.
     *
     * A stored value that is not a positive number is treated as absent;
     * measuring by it would make every length zero or infinite.
     */
    fun of(calibrationPixelsPerFoot: Float?, surveyImagePath: String?, gridExtentFt: Float): Float? =
        calibrationPixelsPerFoot?.takeIf { it > 0f && it.isFinite() }
            ?: if (surveyImagePath == null) unitsPerFoot(gridExtentFt) else null

    /**
     * [of] for [job]. A job is a photo job when it has a survey photo on this
     * phone OR in cloud storage ([Job.surveyStoragePath]) -- see
     * [isPhotoJob] for why the second half matters.
     */
    fun of(job: Job): Float? = of(job.calibrationPixelsPerFoot, photoMarker(job), job.gridExtentFt)

    /**
     * Whether [job] is drawn over a survey photo rather than on the grid.
     *
     * [Job.surveyImagePath] alone only ever exists on the phone that took the
     * photo, or one that has downloaded it -- and the download runs at the end
     * of a sync pass, and not at all offline. On a second phone whose copy had
     * not arrived yet, a photo job read as a grid job: Suggest stored the
     * grid's scale as its calibration and pushed it, and every device and
     * price-job then measured the photo at that made-up scale instead of
     * asking for a real calibration. The storage path travels with the job,
     * so it says "photo" everywhere as soon as the job does.
     */
    fun isPhotoJob(job: Job): Boolean = job.surveyImagePath != null || job.surveyStoragePath != null

    /**
     * Whether [job] has a survey SAVED somewhere: in cloud storage, or as a file
     * that is actually on this phone ([fileExists] answers that, so this stays
     * pure and a test can say which files exist).
     *
     * Not the same question as [isPhotoJob], which is about SCALE and treats any
     * photo reference as a photo -- a local path to a file that has gone, with
     * nothing in storage, is still a photo job for pricing, but it is not a saved
     * survey, and refusing a new photo for it would leave the job with no way to
     * ever have one again.
     */
    fun hasSavedSurvey(job: Job, fileExists: (String) -> Boolean): Boolean =
        job.surveyStoragePath != null || (job.surveyImagePath?.let(fileExists) ?: false)

    /** A non-null stand-in for "there is a photo" that [of]'s path argument reads. */
    private fun photoMarker(job: Job): String? = job.surveyImagePath ?: job.surveyStoragePath

    /**
     * The calibration Suggest should store on [job] before measuring a drawn
     * run, or null when it should store nothing.
     *
     * Null when the job already has a usable scale (nothing to seed) and when
     * it is a photo nobody has calibrated (there is nothing honest to seed --
     * the caller asks for a calibration instead). Otherwise the grid's own
     * scale, the same one the drawing screen is already showing, so seeding
     * it moves no line on the plan.
     */
    fun calibrationToSeed(job: Job): Float? {
        val stored = job.calibrationPixelsPerFoot?.takeIf { it > 0f && it.isFinite() }
        if (stored != null) return null
        if (isPhotoJob(job)) return null
        return unitsPerFoot(job.gridExtentFt)
    }

    /**
     * What stands behind [job]'s scale -- the difference between a scale that
     * was MEASURED and one that was only carried or fitted by eye.
     *
     * The app holds a photo's scale as one number ([Job.calibrationPixelsPerFoot])
     * and the length it was measured against ([Job.calibrationKnownFeet]) is
     * written ONLY by a real calibration (two taps on something of known
     * length). Every other way a photo job comes to have a scale -- the grid's
     * own number seeded onto it, or [DrawingFit] carrying the drawing's scale
     * across a fit -- leaves that length null, so null here is the honest
     * "nobody measured this against the photo".
     *
     * Reading it as a DISPLAY fact does not change what anything is priced
     * at. Both engines price a photo job off the calibration alone, exactly as
     * before; this only lets the screen say which kind of number it is
     * pricing from, so a fit by eye is never presented as a measurement.
     */
    fun basisOf(job: Job): ScaleBasis {
        if (!isPhotoJob(job)) return ScaleBasis.GRID
        if (of(job) == null) return ScaleBasis.NONE
        val known = job.calibrationKnownFeet
        return if (known != null && known > 0f && known.isFinite()) ScaleBasis.MEASURED else ScaleBasis.UNMEASURED
    }

    /**
     * What choosing the grid as the background does to a job that has a survey
     * photo -- decided here, in one pure place, because it is the one choice
     * that could otherwise invent a scale.
     *
     * The survey photo itself is never touched: it stays saved with the job,
     * on this phone and in the cloud, and choosing the grid only hides it. So
     * the only question is whether the job is left able to measure what gets
     * drawn on the grid.
     *
     * - A job that already has a usable scale keeps it, whatever its basis.
     *   Nothing is written.
     * - A job with NO scale and nothing drawn yet gets the grid's own scale
     *   for its own extent, the same number every grid job starts with. That
     *   is not a guess about the photo: nothing has been traced on the photo
     *   to be misread, and the grid square is a known size. This is the case
     *   that used to leave a job quoting zero.
     * - A job with NO scale and lines already drawn on the photo is refused
     *   ([GridBackdropPlan.NeedsScale]). Those lines are in the photo's own
     *   pixels; giving them the grid's scale would price a made-up length,
     *   which is the one thing an uncalibrated photo must never do. The way
     *   forward is to calibrate the photo first.
     */
    fun gridBackdropPlan(job: Job, anythingDrawn: Boolean): GridBackdropPlan {
        if (of(job) != null) return GridBackdropPlan.Allowed(seed = null)
        if (anythingDrawn) return GridBackdropPlan.NeedsScale
        return GridBackdropPlan.Allowed(seed = unitsPerFoot(job.gridExtentFt))
    }
}

/** See [DrawingScale.basisOf]. */
enum class ScaleBasis {
    /** No survey photo: the grid is the scale, and a grid square is a known size. */
    GRID,

    /** A survey photo with no scale at all. Prices nothing, by design. */
    NONE,

    /** A survey photo with a scale nobody measured against it -- carried from the drawing, or fitted by eye. */
    UNMEASURED,

    /** A survey photo calibrated against a known length. */
    MEASURED
}

/** See [DrawingScale.gridBackdropPlan]. */
sealed interface GridBackdropPlan {
    /** Switch to the grid. [seed], when not null, is the one calibration to write with the switch. */
    data class Allowed(val seed: Float?) : GridBackdropPlan

    /** Refused: the photo has drawing on it and no scale, so the grid cannot measure it. */
    data object NeedsScale : GridBackdropPlan
}

/**
 * Where the survey photo sits against the drawing while it is being FITTED:
 * photo pixel `q` is shown at drawing position `scale * q + (dx, dy)`.
 *
 * A draft only. Nothing is stored in this shape -- applying it rewrites the
 * drawing (see [DrawingFit.plan]) so the photo goes back to sitting at its own
 * origin, which is why no new column on the job is needed.
 */
data class PhotoFit(val scale: Float = 1f, val dx: Float = 0f, val dy: Float = 0f) {

    /** True when applying would change nothing -- the Apply button stays off. */
    val isIdentity: Boolean
        get() = abs(scale - 1f) < 1e-4f && abs(dx) < 0.5f && abs(dy) < 0.5f

    /** Slides the photo by [ddx], [ddy] drawing units. */
    fun movedBy(ddx: Float, ddy: Float): PhotoFit = copy(dx = dx + ddx, dy = dy + ddy)

    /**
     * Zooms the photo by [factor] with the drawing position ([cx], [cy])
     * staying exactly where it is on screen -- the spot under the fingers.
     */
    fun zoomedAbout(factor: Float, cx: Float, cy: Float): PhotoFit {
        if (!factor.isFinite() || factor <= 0f) return this
        return PhotoFit(scale * factor, cx + (dx - cx) * factor, cy + (dy - cy) * factor)
    }

    companion object {
        val IDENTITY = PhotoFit()
    }
}

/**
 * Fitting a survey photo to the drawing, and what it may and may not change.
 *
 * THE RULE, stated once: a fit never changes a single measured foot. It moves
 * the drawing and its scale TOGETHER. Every point, gate and site marker is
 * carried by the same transform, and the job's calibration is divided by the
 * same scale factor, so every length -- footage, gate widths, post counts,
 * corners -- comes out identical before and after. Only a real calibration
 * (two taps on a known length) may change what the drawing measures, because
 * only that is a measurement.
 *
 * Why the drawing moves rather than the photo: the drawing's points live in
 * the photo's own pixel space, and the job stores no placement for the photo.
 * Putting the photo back at its own origin and carrying the drawing instead is
 * the same picture without a new column (and so without a migration or a
 * server change), and it leaves the photo file byte for byte as it was.
 *
 * What a fit does NOT do is invent a scale. A photo with no scale has none
 * after a fit; [plan] refuses it, and [jobAfter] leaves it alone. Nothing here
 * can turn an uncalibrated photo into a priced one.
 *
 * Pure -- no Android, no database -- so every claim above is held to a test.
 */
object DrawingFit {

    /** Zoom limits for a fit. Wide enough for any real mismatch, narrow enough that a stray pinch cannot send the drawing to infinity. */
    const val MIN_SCALE = 0.1f
    const val MAX_SCALE = 10f

    /** Tolerance on the footage check in [plan]: the larger of this and one part in 100000 of the total. */
    private const val FOOTAGE_TOLERANCE_FT = 0.01f

    /** One run's drawing, as the fit sees it. */
    data class RunDrawing(
        val id: Long,
        val points: List<FencePoint>,
        val gates: List<GateMarker>,
        val closedLoop: Boolean
    )

    /** One site marker's position. */
    data class MarkerAt(val id: Long, val x: Float, val y: Float)

    /** The whole result of a fit, ready to be written. */
    data class FitPlan(
        val runs: List<RunDrawing>,
        val markers: List<MarkerAt>,
        /** The job's new calibration, in drawing units per foot. */
        val calibrationPixelsPerFoot: Float,
        val feetBefore: Float,
        val feetAfter: Float
    )

    /** [fit] clamped into the allowed zoom range; a non-finite fit becomes the identity. */
    fun clamp(fit: PhotoFit): PhotoFit {
        if (!fit.scale.isFinite() || !fit.dx.isFinite() || !fit.dy.isFinite()) return PhotoFit.IDENTITY
        return fit.copy(scale = fit.scale.coerceIn(MIN_SCALE, MAX_SCALE))
    }

    /** Whether [fit] is something [plan] will carry out. */
    fun isApplicable(fit: PhotoFit): Boolean =
        fit.scale.isFinite() && fit.scale in MIN_SCALE..MAX_SCALE && fit.dx.isFinite() && fit.dy.isFinite()

    /**
     * Where a drawing position lands once the photo is back at its own origin.
     *
     * Worked in double and rounded to a float once, at the end: subtracting and
     * dividing in float rounds twice per coordinate, and the footage the takeoff
     * and the re-approval fingerprint read (to 0.1 ft) is a sum of many of them.
     */
    fun pointAfter(x: Float, y: Float, fit: PhotoFit): FencePoint =
        FencePoint(
            ((x.toDouble() - fit.dx) / fit.scale).toFloat(),
            ((y.toDouble() - fit.dy) / fit.scale).toFloat()
        )

    /** [calibration] after [fit]: the same real length, now spanning [fit]'s scale as many (or few) drawing units. Null stays null. */
    fun calibrationAfter(calibration: Float?, fit: PhotoFit): Float? {
        val usable = calibration?.takeIf { it > 0f && it.isFinite() } ?: return null
        return (usable.toDouble() / fit.scale).toFloat()
    }

    /**
     * [job] after [fit]: its calibration carried across, and the known length
     * cleared, because the scale was carried rather than measured against this
     * photo. A job with no usable scale comes back unchanged -- a fit never
     * writes a scale where there was none.
     */
    fun jobAfter(job: Job, fit: PhotoFit): Job {
        val after = calibrationAfter(job.calibrationPixelsPerFoot, fit) ?: return job
        return job.copy(calibrationPixelsPerFoot = after, calibrationKnownFeet = null)
    }

    /**
     * Carries a whole drawing across [fit], or returns null when it must not.
     *
     * Null when the fit is not applicable, when there is no usable scale to
     * carry, or when the result would measure a different footage than the
     * input -- a belt-and-braces check against the pure rule above, run on the
     * same engine the takeoff uses, so a bug here refuses to write rather than
     * quietly repricing the job.
     */
    fun plan(
        runs: List<RunDrawing>,
        markers: List<MarkerAt>,
        calibrationPixelsPerFoot: Float?,
        fit: PhotoFit
    ): FitPlan? {
        if (!isApplicable(fit)) return null
        val before = calibrationPixelsPerFoot?.takeIf { it > 0f && it.isFinite() } ?: return null
        val after = calibrationAfter(before, fit) ?: return null
        if (!after.isFinite() || after <= 0f) return null

        val movedRuns = runs.map { run ->
            run.copy(
                points = run.points.map { pointAfter(it.x, it.y, fit) },
                gates = run.gates.map { g ->
                    val p = pointAfter(g.x, g.y, fit)
                    g.copy(x = p.x, y = p.y)
                }
            )
        }
        val movedMarkers = markers.map { m ->
            val p = pointAfter(m.x, m.y, fit)
            m.copy(x = p.x, y = p.y)
        }

        val feetBefore = FenceGeometryEngine.totalLinearFeetAcrossRuns(runs.map { it.points to it.closedLoop }, before)
        val feetAfter = FenceGeometryEngine.totalLinearFeetAcrossRuns(movedRuns.map { it.points to it.closedLoop }, after)
        val tolerance = maxOf(FOOTAGE_TOLERANCE_FT, feetBefore * 1e-5f)
        if (!feetAfter.isFinite() || abs(feetAfter - feetBefore) > tolerance) return null

        return FitPlan(movedRuns, movedMarkers, after, feetBefore, feetAfter)
    }

    /**
     * A round number of feet for the reference grid shown while fitting: the
     * smallest of 1, 2, 5, 10, 20, 50, 100 ... that is at least [minFt], so
     * a square never gets too small on screen to read against the photo.
     */
    fun niceGridStepFt(minFt: Float): Float {
        if (!minFt.isFinite() || minFt <= 1f) return 1f
        val magnitude = 10.0.pow(floor(log10(minFt.toDouble())))
        for (m in doubleArrayOf(1.0, 2.0, 5.0, 10.0)) {
            val step = m * magnitude
            if (step >= minFt) return step.toFloat()
        }
        return (10.0 * magnitude).toFloat()
    }
}
