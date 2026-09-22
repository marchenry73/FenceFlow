package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.Job

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
 * NOT used by [EstimateEngine.linearFeet] / [EstimateEngine.teardownLinearFeet]
 * yet, deliberately. Those count an uncalibrated drawn run as 0 ft, and the
 * server's price-job reproduces exactly that (supabase/functions/_shared/
 * pricing/totals.ts footageOf, pinned by the drawn-uncalibrated parity fixture
 * and smoke case 3b). Moving the phone alone would make the office and the
 * phone quote the same job two ways, which is the failure the parity gate
 * exists to stop -- the two have to move in one commit.
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
}
