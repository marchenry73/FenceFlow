package com.fenceestimator.app.survey

import com.fenceestimator.app.cloud.SatelliteMath
import com.fenceestimator.app.ui.survey.MAX_SATELLITE_TILES
import com.fenceestimator.app.ui.survey.SATELLITE_TILE_Z
import com.fenceestimator.app.ui.survey.SurveyViewModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.math.ceil

/**
 * D1's OTHER half: "the grid is unlimited now... but satellite still stops
 * at 400ft." A reviewer suspected the 400ft pin was an internal shortcut,
 * not a limit of the map -- reading SatelliteAnchor (SurveyDrawScreen.kt)
 * proved that right: it hardcoded SurveyViewModel.PIXELS_PER_FOOT_GRID as
 * the scale to draw imagery at, correct only when gridExtentFt happened to
 * equal SurveyViewModel.SATELLITE_CANVAS_EXTENT_FT (400).
 *
 * That hardcoding was not just a missed feature, it was a live bug: nothing
 * on the drawing screen ever disabled the grid-size chips or the +/- zoom
 * buttons while satellite was the active background, so pressing either
 * already rescaled every drawn point (via setGridExtent, to keep real
 * length) while the OLD anchor kept the imagery at the 400ft scale
 * regardless -- the fence stopped lining up with the ground under it, with
 * nothing on screen saying so. SatelliteAnchor now takes the job's own
 * current scale, which fixes that regardless of anything below.
 *
 * What this file actually pins is the SEPARATE, honest question that fix
 * raises: how far can satellite's imagery genuinely follow, once its scale
 * is no longer hardcoded? The z=20 tiles it fetches (SATELLITE_TILE_Z) each
 * cover a fixed amount of real ground -- a fact of the Web Mercator
 * projection and latitude alone (SatelliteMath.feetPerPx), nothing to do
 * with this app's canvas -- so "how far" is exactly how many of those
 * fixed-size tiles fit inside the existing fetch ceiling
 * (MAX_SATELLITE_TILES, already in SurveyDrawScreen.kt for a slow
 * connection, now doing double duty as satellite's real reach). All of this
 * is pure arithmetic (SurveyViewModel.satelliteTilesNeeded/
 * satelliteCanFullyCover/maxSatelliteExtentFt) -- no Compose, no Android, no
 * device needed to check it. What a plain JVM test CANNOT check: whether the
 * on-screen crop past that point (SurveyDrawScreen's visibleSatelliteTiles
 * takes whichever tiles a raster scan reaches first once the budget is hit,
 * not an even sample) actually looks acceptable on a phone. Nobody has
 * looked at that yet, the same caveat GridExtentTest already states for the
 * grid's own rendering.
 */
class SatelliteExtentTest {

    /**
     * Riverview, FL -- the same reference site SatelliteMathTest and
     * website/dashboard.html's own JS test data use, and where this app's
     * real jobs actually are (see CLAUDE.md / the Hillsborough-County-only
     * free imagery tier in supabase/functions/quote-map). The reach numbers
     * below are only meaningful at a real, in-market latitude -- there is no
     * single ft figure that is true everywhere on Earth, which is exactly
     * why this is a function of latitude and not a second hardcoded
     * constant.
     */
    private val lat = 27.78

    /**
     * The same tile-count arithmetic as [SurveyViewModel.satelliteTilesNeeded],
     * worked out independently from [SatelliteMath] directly rather than by
     * calling the function under test -- so a bug in the real function has
     * something outside itself to disagree with.
     */
    private fun expectedTiles(extentFt: Float, siteLat: Double): Int {
        val feetPerTile = 256.0 * SatelliteMath.feetPerPx(siteLat, SATELLITE_TILE_Z)
        val across = ceil(extentFt / feetPerTile).toInt() + 1
        return across * across
    }

    // ---- satelliteTilesNeeded matches hand-worked-out arithmetic ----

    @Test
    fun `tile count matches independently worked out arithmetic across a range of extents`() {
        for (extent in listOf(25f, 100f, 400f, 700f, 800f, 2000f, 10000f)) {
            assertEquals(
                "extent=$extent ft at lat=$lat",
                expectedTiles(extent, lat),
                SurveyViewModel.satelliteTilesNeeded(extent, lat)
            )
        }
    }

    // ---- the untouched default: 400ft must still comfortably fit ----

    @Test
    fun `satellite's own 400ft default comfortably fits inside the fetch budget`() {
        val tiles = SurveyViewModel.satelliteTilesNeeded(SurveyViewModel.SATELLITE_CANVAS_EXTENT_FT, lat)
        assertTrue("400ft must fit today exactly as it always has, or every existing satellite job is already broken", tiles <= MAX_SATELLITE_TILES)
        assertTrue(SurveyViewModel.satelliteCanFullyCover(SurveyViewModel.SATELLITE_CANVAS_EXTENT_FT, lat))
    }

    // ---- positive control: satelliteCanFullyCover really can say no ----

    @Test
    fun `a paddock-sized 2000ft grid genuinely cannot be covered -- the positive control`() {
        // If this ever reads true, satelliteCanFullyCover cannot be trusted for
        // anything -- a predicate that never fails is the exact audit-blind-spot
        // shape (see MEMORY's "positive control in every probe").
        assertFalse(SurveyViewModel.satelliteCanFullyCover(2000f, lat))
        assertTrue(SurveyViewModel.satelliteTilesNeeded(2000f, lat) > MAX_SATELLITE_TILES)
    }

    // ---- maxSatelliteExtentFt lands where the closed-form math says ----

    @Test
    fun `satelliteCanFullyCover flips from true to false within one tile-width of the closed-form boundary`() {
        // floor(sqrt(MAX_SATELLITE_TILES)) == 8 tiles per axis is the most
        // satelliteTilesNeeded's "+1 tile" formula can fit in budget, so the
        // exact boundary is 7 * feetPerTile (see maxSatelliteExtentFt's own
        // doc for the algebra). Tested half a tile either side rather than
        // at the razor's edge, since maxSatelliteExtentFt itself round-trips
        // through a Float and a value sitting exactly on a ceil() boundary
        // can land on either side of it depending on which way that rounds --
        // this checks the FORMULA, not a specific bit pattern.
        val feetPerTile = 256.0 * SatelliteMath.feetPerPx(lat, SATELLITE_TILE_Z)
        val exactBoundary = 7.0 * feetPerTile
        val margin = feetPerTile / 2.0
        assertTrue(SurveyViewModel.satelliteCanFullyCover((exactBoundary - margin).toFloat(), lat))
        assertFalse(SurveyViewModel.satelliteCanFullyCover((exactBoundary + margin).toFloat(), lat))
    }

    @Test
    fun `maxSatelliteExtentFt is within one tile-width of the closed-form boundary`() {
        val feetPerTile = 256.0 * SatelliteMath.feetPerPx(lat, SATELLITE_TILE_Z)
        val exactBoundary = 7.0 * feetPerTile
        val maxFt = SurveyViewModel.maxSatelliteExtentFt(lat)
        assertEquals(exactBoundary, maxFt.toDouble(), feetPerTile)
    }

    @Test
    fun `at this app's real latitude, satellite's honest reach sits between its 400ft default and the smallest paddock pick`() {
        // The literal reading of "zoom out and keep finding grid" would have
        // satellite reach GRID_SIZES_FT's 1000/2000/5000/10000ft paddock and
        // acreage sizes too. This is the honest answer for why it does not:
        // at Tampa's latitude, satellite's own fetch budget (MAX_SATELLITE_TILES)
        // runs out well before even the smallest of those, so the grid-size
        // chips above 400ft are always reached through the SAME control, but
        // satellite genuinely cannot follow all the way to them.
        val maxFt = SurveyViewModel.maxSatelliteExtentFt(lat)
        assertTrue("must be able to grow past the 400ft default at all", maxFt > SurveyViewModel.SATELLITE_CANVAS_EXTENT_FT)
        assertTrue("but not anywhere near the smallest paddock pick", maxFt < 1000f)
    }

    // ---- the physical direction of the relationship: further from the
    // equator, less ground per tile, so satellite's reach only shrinks ----

    @Test
    fun `imagery reach shrinks moving away from the equator, in the direction Web Mercator actually distorts`() {
        val equator = SurveyViewModel.maxSatelliteExtentFt(0.0)
        val tampa = SurveyViewModel.maxSatelliteExtentFt(lat)
        val midLatitude = SurveyViewModel.maxSatelliteExtentFt(45.0)
        assertTrue("cos(0) > cos(lat) for any lat in (0, 90), so the equator must see furthest", equator > tampa)
        assertTrue("and further still than a mid-latitude site", tampa > midLatitude)
    }

    // ---- guards: no crash, no silently-wrong answer on bad input ----

    @Test
    fun `a non-positive or non-finite extent is treated as needing no tiles, not a crash`() {
        for (bad in listOf(0f, -50f, Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY)) {
            assertEquals(0, SurveyViewModel.satelliteTilesNeeded(bad, lat))
        }
    }

    @Test
    fun `an unrealistic latitude approaching the pole reports MAX_VALUE, not a silently overflowed small number`() {
        // The planted failure this guards against: squaring an overflowed
        // tile-per-axis count wraps a 32-bit Int back to something small (even
        // negative), which would read as "fits" when the honest answer is
        // nowhere close. No real FenceFlow job is ever this far from the
        // equator, but a function with no caller-checked precondition should
        // not turn an extreme input into a falsely reassuring answer.
        val nearPole = 89.999999
        assertEquals(Int.MAX_VALUE, SurveyViewModel.satelliteTilesNeeded(400f, nearPole))
        assertFalse(SurveyViewModel.satelliteCanFullyCover(400f, nearPole))
    }

    @Test
    fun `the fetch budget this file reasons about is still 64 and still a plain public constant`() {
        // Not a magic number re-typed here: MAX_SATELLITE_TILES is imported
        // straight from SurveyDrawScreen.kt (see the import above), so if that
        // ceiling ever changes, this file's own expectedTiles() helper and
        // every satelliteCanFullyCover assertion above move with it rather
        // than quietly comparing against a stale copy.
        assertEquals(64, MAX_SATELLITE_TILES)
    }

    // ---- the actual fix, read from source -- SurveyDrawScreen.kt is a
    // Compose file with no way to execute it off a device, same limitation
    // GridExtentTest already documents for drawGrid. This is a durable,
    // specific guard against the exact bug reappearing unnoticed, not proof
    // the file compiles or that the result looks right on a phone. ----

    private fun surveyDrawScreenSource(): String =
        listOf(
            File("src/main/java/com/fenceestimator/app/ui/survey/SurveyDrawScreen.kt"),
            File("app/src/main/java/com/fenceestimator/app/ui/survey/SurveyDrawScreen.kt")
        ).first { it.isFile }.readText()

    @Test
    fun `SatelliteAnchor takes this job's own scale instead of a hardcoded flat one -- the exact D1 fix`() {
        val src = surveyDrawScreenSource()
        assertTrue(
            "SatelliteAnchor's constructor must accept the job's own current scale",
            src.contains("private class SatelliteAnchor(lat: Double, lon: Double, unitsPerFoot: Float)")
        )
        assertTrue(
            "its world-to-survey-pixel scale must be built from that parameter",
            src.contains("SatelliteMath.feetPerPx(lat, SATELLITE_TILE_Z) * unitsPerFoot")
        )
        assertFalse(
            "the planted failure this guards against -- the old hardcoded flat scale that silently " +
                "mis-registered imagery the moment gridExtentFt moved away from 400 while satellite stayed on",
            src.contains("SatelliteMath.feetPerPx(lat, SATELLITE_TILE_Z) * SurveyViewModel.PIXELS_PER_FOOT_GRID")
        )
    }

    @Test
    fun `the anchor is rebuilt whenever this job's own scale changes, not only when its coordinates do`() {
        val src = surveyDrawScreenSource()
        assertTrue(
            "remember(...) must key on the job's current px/ft (gridPxPerFt) so zooming the grid while " +
                "satellite is on actually re-anchors the imagery instead of leaving it at the old scale",
            src.contains("remember(job2.siteLat, job2.siteLon, gridPxPerFt)")
        )
        assertTrue(
            "and must actually pass it to the constructor",
            src.contains("SatelliteAnchor(lat, lon, gridPxPerFt)")
        )
    }

    @Test
    fun `MAX_SATELLITE_TILES and SATELLITE_TILE_Z are public, not private, so this file can share them`() {
        val src = surveyDrawScreenSource()
        assertTrue(src.contains("const val SATELLITE_TILE_Z = 20"))
        assertTrue(src.contains("const val MAX_SATELLITE_TILES = 64"))
        assertFalse(
            "if either goes back to private, satelliteTilesNeeded silently falls back to a " +
                "hand-duplicated copy that can drift from what SurveyDrawScreen actually fetches against",
            src.contains("private const val SATELLITE_TILE_Z") || src.contains("private const val MAX_SATELLITE_TILES")
        )
    }
}
