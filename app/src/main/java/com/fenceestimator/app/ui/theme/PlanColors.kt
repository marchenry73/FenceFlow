package com.fenceestimator.app.ui.theme

import androidx.compose.ui.graphics.Color
import com.fenceestimator.app.data.SiteMarkerKind

/**
 * The one palette a fence plan is drawn in, wherever it is drawn.
 *
 * The survey screen (where the office draws the job) and the crew's read-only
 * copy of that same plan used to each pick their own colours for the fence
 * line, the gate and every site marker -- close enough that neither looked
 * wrong on its own, different enough that a crew comparing their phone to
 * what the office drew had no way to tell whether a colour meant something or
 * was just an accident of two screens built at different times. One object,
 * read by both, so the same plan looks like the same plan.
 *
 * Reuses a [Color.kt] constant wherever the shade already matches one
 * exactly; everything else is named once, here, instead of being retyped as
 * a bare hex literal on each screen.
 */
object PlanColors {
    /** The fence as it will stand when the job is built. */
    val fenceLine: Color = SteelTeal40

    /** Grey shared with the EXISTING_FENCE marker below -- fence that is
     *  already there, not fence going in, so it reads differently from
     *  [fenceLine] at a glance. */
    private val ExistingFenceGrey = Color(0xFF8A93A3)

    /**
     * The old fence coming out, for a run marked
     * [com.fenceestimator.app.data.FenceRun.isTeardown]. Distinct from
     * [fenceLine] so a crew reading the plan can tell "pull this out" from
     * "build this" at a glance instead of finding out on site.
     */
    val teardownLine: Color = ExistingFenceGrey

    /** A gate opening, on the line or standing on its own. */
    val gate: Color = SafetyOrange20

    /** The no-photo grid's ordinary lines. */
    val grid: Color = Color(0xFFDCE3EC)

    /** Every fifth grid line, drawn heavier so the eye has something to count by. */
    val gridMajor: Color = Graphite80

    // One colour per marker kind. Only two happen to land exactly on an
    // existing theme constant (HOUSE, OBSTACLE); the rest are named once here
    // rather than each screen inventing its own set.
    private val PoolBlue = Color(0xFF0EA5E9)
    private val DrivewayGrey = Color(0xFF6B7280)
    private val EasementMagenta = Color(0xFFD946EF)
    private val UtilityRed = Color(0xFFEF4444)
    private val TreeGreen = Color(0xFF16A34A)
    private val SlopeAmber = Color(0xFFF59E0B)

    /** The colour a [SiteMarkerKind] is drawn in, identical on every screen that draws it. */
    fun marker(kind: SiteMarkerKind): Color = when (kind) {
        SiteMarkerKind.EXISTING_FENCE -> ExistingFenceGrey
        SiteMarkerKind.HOUSE -> Graphite40
        SiteMarkerKind.POOL -> PoolBlue
        SiteMarkerKind.DRIVEWAY -> DrivewayGrey
        SiteMarkerKind.EASEMENT -> EasementMagenta
        SiteMarkerKind.UTILITY -> UtilityRed
        SiteMarkerKind.TREE -> TreeGreen
        SiteMarkerKind.SLOPE -> SlopeAmber
        SiteMarkerKind.OBSTACLE -> SafetyOrange20
    }
}
