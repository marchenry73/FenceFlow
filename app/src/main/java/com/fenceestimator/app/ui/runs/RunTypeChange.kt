package com.fenceestimator.app.ui.runs

import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType

/**
 * WHAT KIND OF FENCE EACH SIDE IS, and what changing that answer does to the
 * rest of the row.
 *
 * His words: "after I create the drawing I need a spot to set what kind of
 * fence is on each side, use the default, but I also want to set what type of
 * fence it is on each side." And: "Also for everything that's connected to it
 * for it to work too."
 *
 * The CAPABILITY already existed -- `fence_runs.fence_type` is per run, both
 * pricing engines narrow the catalog by it ([com.fenceestimator.app.estimate
 * .EstimateEngine.buildLineItems], line-items.ts:130), and RunEditScreen has
 * had a dropdown for it all along. What was missing was two things, and this
 * file is the second of them:
 *
 *  1. The picker lived on a different screen from the one he is on when he
 *    finishes drawing. (Fixed by [SideTypesCard], on the drawing screen.)
 *  2. **Nothing reconciled the row with its new type.** The dropdown wrote
 *    `fenceType` and `postSpacingFt` and stopped there, so a 6 ft vinyl side
 *    switched to chain link kept `panelHeightFt = 6` -- which chain link does
 *    not read -- and priced `fabricHeightFt = 4`, the entity default. A 6 ft
 *    fence quoted as 4 ft of fabric, with every screen saying "Chain Link, 6
 *    ft" because they all read `panelHeightFt`.
 *
 * PURE ON PURPOSE -- no Repository, no Context, no clock. Same reason
 * [com.fenceestimator.app.estimate.TakeoffRefresher.pricingSignature] and
 * `SurveyViewModel.checkPositive` are pure: it is where money is decided, so
 * plain node has to be able to check it off device
 * (tests/a81-fence-type-per-side.test.mjs).
 */
object RunTypeChange {

    /**
     * What a NEW side on this job should be, before he touches anything.
     *
     * "Use the default" -- and the default he means is the fence he is already
     * building on this job, not a constant. Today a side started from the
     * drawing screen gets [FenceType.VINYL] because that is
     * `FenceRun`'s entity default and `SurveyViewModel.createBlankRun` never
     * sets the column; the job screen's Add dialog opens on a hardcoded
     * `FenceType.VINYL` too.
     *
     * WHY THE JOB'S OWN SIDES AND NOT A SETTING. Read off the live database
     * on 2 Oct 2026, read-only: 18 sides, 16 vinyl and 2 wood, across 13 jobs
     * -- 12 of one type and exactly one genuinely mixed. A company-level
     * "default fence type" would read VINYL and be right 16 times in 18, but
     * it is a new stored fact (a settings column, a sync field, a screen to
     * set it on) that on his wood job is still wrong for every side of it.
     * The job's own sides cost NO new column -- `fence_type` and `sort_order`
     * are both already there and already sync -- are identical to a company
     * default on side 1 of every job, and are right from side 2 onward on the
     * wood one. On a normal day it is zero taps either way; on the mixed job
     * it saves a tap per extra side.
     *
     * TEARDOWN SIDES ARE IGNORED, and this is the part that is easy to get
     * wrong. A teardown run is the OLD fence coming out
     * ([FenceRun.isTeardown]); its type is what is being REMOVED. Inheriting
     * from it would make the new side of a "pull the wood fence out, put vinyl
     * in" job default to wood -- the one job shape where the old and new types
     * are guaranteed to differ.
     *
     * Last side wins, by [FenceRun.sortOrder] then [FenceRun.id], because
     * sortOrder is what the drawing screen's own picker orders by and a tie
     * there is broken the same way.
     */
    fun defaultTypeFor(siblings: List<FenceRun>): FenceType =
        siblings
            .filterNot { it.isTeardown }
            .maxWithOrNull(compareBy({ it.sortOrder }, { it.id }))
            ?.fenceType
            ?: FenceType.VINYL

    /**
     * Post spacing for a type, lifted verbatim from
     * [FenceRunListViewModel.defaultSpacingFor] rather than restated, so the
     * Add dialog and a type change cannot disagree about what a wood side's
     * spacing is.
     */
    fun spacingFor(type: FenceType, panelWidthFt: Float, fallback: Float): Float =
        FenceRunListViewModel.defaultSpacingFor(type, panelWidthFt, fallback)

    /** Types built from discrete panels: `panelWidthFt` and `panelHeightFt` are their size. */
    val PANEL_TYPES = setOf(FenceType.VINYL, FenceType.ALUMINUM, FenceType.ORNAMENTAL_IRON)

    /** Types built from pickets on rails: `picketWidthIn`, `picketGapIn`, `woodRailCount`. */
    val PICKET_TYPES = setOf(FenceType.WOOD, FenceType.COMPOSITE)

    /**
     * The one writer of [FenceRun.fenceType]. Returns the row as it should be
     * once this side is that kind of fence.
     *
     * THREE RULES, and the reasoning for each, because a type change moves
     * money and a rule nobody can defend here becomes a price nobody can
     * explain on site.
     *
     * **1. Post spacing follows the type.** Already what RunEditScreen did.
     * Vinyl, aluminium and ornamental put a post at every panel edge, so
     * spacing IS the panel width; wood and composite are 8 ft, chain link 10,
     * split rail 8.
     *
     * **2. HEIGHT CARRIES ACROSS.** `panelHeightFt` and `fabricHeightFt` are
     * two columns naming ONE physical fact -- how tall the fence is -- and
     * they do not follow each other today. Leaving them alone is the
     * [PANEL_HEIGHT_BLINDNESS] failure in a new place: a 6 ft side switched to
     * chain link prices 4 ft of fabric, and the catalog pick for CHAIN_FABRIC
     * is BY that number (`coversFt` is overloaded as the fabric height), so it
     * genuinely buys the wrong roll. Carried only when the source is a usable
     * measurement, so a zero or a NaN can never be copied ONTO a good value.
     *
     * **3. NOTHING IS CLEARED.** The outgoing type's numbers are left exactly
     * where they are. Two reasons, and they point the same way:
     *
     *  - **Zero is not "unset", it is a wrong price.** `panelWidthFt = 0`
     *    takes the PANEL and LINE_POST lines out of a vinyl quote entirely --
     *    that is the whole reason `RunEditScreen.PositiveNumberField` exists.
     *    Clearing a field to make it "obviously empty" is how an empty spec
     *    starts pricing as nothing instead of reading as nothing.
     *  - **Switching back must not lose what he typed.** He is standing in a
     *    yard deciding between wood and vinyl on one side. A round trip
     *    through the dropdown must not wipe the panel width he set.
     *
     * Stale-but-unread is safe because the engines' `when (run.fenceType)`
     * never reads the other type's fields: a wood side's `panelWidthFt` is
     * never consulted by `picketAndRailEntries`. Where a leftover could
     * actually price something is exactly what [specProblem] names, and the UI
     * says so rather than quietly billing it.
     */
    fun apply(run: FenceRun, newType: FenceType): FenceRun {
        if (run.fenceType == newType) return run
        var next = run.copy(
            fenceType = newType,
            postSpacingFt = spacingFor(newType, run.panelWidthFt, run.postSpacingFt)
        )
        // Height, one fact under two names. Only ever a copy of a usable
        // number, never a copy of a bad one.
        if (newType == FenceType.CHAIN_LINK && isUsable(run.panelHeightFt)) {
            next = next.copy(fabricHeightFt = run.panelHeightFt)
        } else if (run.fenceType == FenceType.CHAIN_LINK && isUsable(run.fabricHeightFt)) {
            next = next.copy(panelHeightFt = run.fabricHeightFt)
        }
        return next
    }

    /** A measurement a fence can actually have: finite and above zero. */
    fun isUsable(v: Float): Boolean = v.isFinite() && v > 0f

    /**
     * The spec number this side needs for its type and does not have, or null
     * if it can be priced honestly.
     *
     * This is the "must read as not set yet, never price as zero" half. The
     * engine's arithmetic on a zero does not throw -- it silently produces a
     * quantity of 0 and the role is simply absent from the estimate, which on
     * screen is indistinguishable from a fence that needs no panels. So the
     * refusal has to be raised HERE, where the field is, and shown next to the
     * side it belongs to.
     *
     * Returns the string resource for the sentence to show. One field, the
     * first that is missing, because a list of four refusals under one row is
     * noise -- he fixes one and the next appears.
     */
    fun specProblem(run: FenceRun): SpecProblem? {
        if (!isUsable(run.postSpacingFt)) return SpecProblem.POST_SPACING
        return when (run.fenceType) {
            in PANEL_TYPES -> when {
                !isUsable(run.panelWidthFt) -> SpecProblem.PANEL_WIDTH
                !isUsable(run.panelHeightFt) -> SpecProblem.PANEL_HEIGHT
                else -> null
            }
            in PICKET_TYPES -> when {
                // The engine coerces the pitch to 0.5 in so it cannot divide
                // by zero, which means a picket width of 0 does NOT crash --
                // it orders 24 pickets a foot. Refused here instead.
                !isUsable(run.picketWidthIn + run.picketGapIn) -> SpecProblem.PICKET_PITCH
                run.woodRailCount <= 0 -> SpecProblem.RAIL_COUNT
                else -> null
            }
            FenceType.CHAIN_LINK -> if (!isUsable(run.fabricHeightFt)) SpecProblem.FABRIC_HEIGHT else null
            FenceType.SPLIT_RAIL -> if (run.splitRailCount <= 0) SpecProblem.RAIL_COUNT else null
            else -> null
        }
    }

    /** Which field is missing. The sentence for each lives in strings_side_types.xml. */
    enum class SpecProblem { POST_SPACING, PANEL_WIDTH, PANEL_HEIGHT, PICKET_PITCH, RAIL_COUNT, FABRIC_HEIGHT }
}
