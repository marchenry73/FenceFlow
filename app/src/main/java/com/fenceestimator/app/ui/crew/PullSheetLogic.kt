package com.fenceestimator.app.ui.crew

import com.fenceestimator.app.cloud.engineVersionIsNewer
import com.fenceestimator.app.data.IMPORTED_CHECK_FILING
import com.fenceestimator.app.data.MaterialRole

/**
 * What goes on the truck, worked out from the takeoff that is already on the
 * phone. Pure: no Room, no Compose, no clock, no Repository.
 *
 * The owner's words for what this is for: "when picking up materials, I want
 * to have the whole process too for the person picking up. I want them to
 * have a whole page to check if we have everything according to the job."
 *
 * THERE IS NO PRICE IN THIS FILE AND NO FIELD ONE COULD BE PUT IN.
 *
 * That is deliberate, and it is the strongest of the three layers this app
 * already uses to keep money away from a crew phone:
 *
 *  1. The server drops the columns. A phone whose
 *     [com.fenceestimator.app.cloud.MoneyScope] is DENIED pulls line items
 *     from `estimate_line_items_crew`, a view built by selecting every column
 *     of `estimate_line_items` EXCEPT `unit_price` and `supplier_unit_price`
 *     (supabase_crew_money_shield_patch.sql), so the numbers never reach the
 *     handset at all.
 *  2. A crew-facing screen shows no money even when the phone holds it --
 *     [CrewFencePlanScreen]'s run card, "No prices".
 *  3. This model has nowhere to put one. [PullSheetLine] carries a
 *     description, a count, a unit, a role and two HEIGHTS. A later edit
 *     cannot leak a price by forgetting a conditional, because there is no
 *     field to assign it to, and tests/a71-pull-sheet.test.mjs walks the whole
 *     object graph by key name and fails on any key that looks like money.
 *
 * WHY THERE IS NO MoneyScope CHECK ON THE PULL SHEET. One was considered and
 * rejected. A gate turns "this page has no money on it" into "this page has
 * no money on it IF a boolean is the right way round", and
 * [com.fenceestimator.app.cloud.MoneyScope] has three states precisely because
 * the question can fail to be asked -- see memory/empty-answer-reads-as-good-news.md.
 * A page that structurally cannot hold a price needs no gate, and adding one
 * would mean the owner (who has SEE_MONEY and who is usually the person
 * standing at the counter) saw a different page from his crew. One page.
 */

/** Which part of the yard a line is picked from. */
enum class PullSheetSection {
    POSTS,
    PANELS,
    CAPS_AND_TRIM,
    CONCRETE,
    GATE_HARDWARE,
    OTHER,
}

/**
 * Why the person at the counter should ASK rather than guess.
 *
 * Every one of these is about WHICH PRODUCT was identified, never about what
 * it costs. The count on a doubted line is still right -- it came from the
 * engine's takeoff -- and that distinction is the whole message: load the
 * right number of the thing you and the counter agree on.
 *
 * NOT [com.fenceestimator.app.data.isPlaceholderPrice], and the difference
 * matters enough to spell out. That helper is true for four labels, and three
 * of them (`SEEDED`, `PLACEHOLDER`, `IMPORTED_UNVERIFIED`) say the NUMBER is
 * unchecked. On a page with no numbers on it those three are noise, and noise
 * is exactly how a flag that does matter gets ignored. Only the fourth,
 * [IMPORTED_CHECK_FILING], is about the filing -- fence type, category, role
 * and unit guessed from the product's name by the office importer's
 * `impMaterial` -- and a wrong guess there is a wrong product in the truck.
 */
enum class PullSheetDoubt {
    /**
     * The takeoff names a product the catalog no longer has under that role.
     *
     * Fails safe on purpose. A line stores its product as a NAME copied from
     * the catalog row at takeoff time ([com.fenceestimator.app.data.EstimateLineItem]
     * has no link to the row it came from), so renaming the row breaks the
     * match and produces this -- which reads "ask", not "fine". The honest fix
     * is a `materialItemSyncId` column on the line; that needs a Room
     * migration and a sync field, both in files another wave holds today.
     */
    NOT_IN_CATALOG,

    /** The catalog row was imported by the office and its filing never checked. */
    FILING_UNCHECKED,

    /**
     * The catalog row says which fence height it is for, and it is not this
     * run's height.
     *
     * This is the one that is live on the owner's own data right now: on one
     * job, twenty-two line posts sold for a four foot fence are on two six
     * foot runs, because the lines were generated before the engine learned to
     * choose a post by height ([com.fenceestimator.app.data.MaterialItem.heightFt])
     * and nothing has redrawn the job since. A post two and a half feet short
     * is not a pricing problem.
     */
    WRONG_HEIGHT,
}

/**
 * Whether the arithmetic that wrote this job's takeoff is the arithmetic this
 * app speaks.
 *
 * WHY THIS EXISTS. Every stored takeoff in production is older than the engine
 * (read-only SELECT, 2 Oct 2026: of eleven live jobs, two were never priced,
 * three were priced by 2026.09.1 and six by 2026.10.2 -- and ZERO by the
 * current 2026.10.8). So every one of them predates the panel-height fix
 * (2026.10.2), the post-height fix (2026.10.3), the gate-post fix (2026.10.4),
 * the wall-gate BLANK_POST fix (2026.10.5), the gate-hardware change
 * (2026.10.7) and the shared-post-at-a-joint fix (2026.10.8). On the owner's
 * own job the sheet lists 37 posts where this engine now says 38 -- a missing
 * BLANK_POST -- and names a four foot post for a six foot run. The page cannot
 * see any of that by looking at the lines, because the lines are internally
 * consistent; the only thing that gives it away is `jobs.pricing_engine_version`.
 *
 * WHY IT WARNS ON ANY DIFFERENCE RATHER THAN ON A "MATERIALS-AFFECTING" ONE.
 * The tempting refinement is to stay quiet on a bump that only moved money,
 * since this page has no money on it -- 2026.09.3 -> 2026.10.1 was exactly
 * that, the grand total's rounding and nothing else. There is no honest way to
 * ask that question here:
 *
 *  - Nothing in the schema or in the app records what a bump CHANGED. The
 *    reasons live in prose, in [com.fenceestimator.app.estimate.EstimateEngine]'s
 *    KDoc, which no code can read.
 *  - A hand-maintained "this one moved materials" flag would answer the
 *    question by whichever way somebody remembered to set it, and a flag
 *    nobody set reads as all-clear. That is the empty-answer bug class
 *    (memory/empty-answer-reads-as-good-news.md) with a nicer name.
 *  - Ignoring the patch component and warning only on a larger move is worse
 *    than useless here: the version is a DATE (year.month.patch), so every
 *    materials change this engine has ever made was a patch bump. The
 *    post-height fix -- the one that is live and wrong on his own data -- is
 *    2026.10.2 -> 2026.10.3. A rule that skipped patches would have stayed
 *    silent on precisely the bug this warning is for.
 *  - Recomputing the takeoff here and diffing it is what the whole page
 *    refuses to do: a crew phone's catalog has every price scrubbed, so its
 *    recompute picks different products and would push its own quantities over
 *    the office's on the next sync (see [PullSheetViewModel]).
 *
 * So: any difference warns, and the asymmetry is the argument. A warning that
 * did not need to be there costs a phone call to the office. A silence that
 * should have been a warning costs a wrong truck, a second trip, and a crew
 * standing in a yard. The project's own rule makes this cheap to live with --
 * "a change to any formula here is a new version" -- so the version only moves
 * when the arithmetic moves, and a version that matches really does mean these
 * quantities came out of this engine.
 *
 * It is also not cry-wolf in the sense that matters. It does not fire on every
 * patch release: it fires until somebody re-runs the takeoff, which is exactly
 * the thing being asked for, and then it goes quiet and stays quiet.
 */
enum class PullSheetTakeoffAge {
    /** Measured by the arithmetic this app speaks. Nothing to say. */
    CURRENT,

    /**
     * Nobody recorded which engine measured this job.
     *
     * Not the same as old, and the wording differs: '' is what the column
     * holds on a job the phone has never pushed a total for, so this is "no
     * one has priced this", not "this was priced a while ago".
     */
    UNRECORDED,

    /** Measured by an older engine. The takeoff has to be re-run. */
    TAKEOFF_BEHIND,

    /**
     * Measured by a NEWER engine than this phone has, which means this handset
     * is behind and could not reproduce these lines if it tried. A different
     * instruction -- update the app -- so a different state rather than the
     * same warning with the wrong advice on it.
     */
    APP_BEHIND,
}

/**
 * Compares the engine that wrote the takeoff against the engine in this build.
 *
 * Numeric, through [engineVersionIsNewer] -- the app's ONE version comparator,
 * reused rather than re-written, so "newer" cannot come to mean two things
 * (memory/shared-helper-meaning-drift.md). Numeric and not a string compare
 * for one reason worth having: "2026.10.08" and "2026.10.8" are the same
 * arithmetic, and a sheet that cried stale over a leading zero is a sheet that
 * gets ignored. Anything unparseable reads as behind, because a version this
 * code cannot understand is not a version it can vouch for.
 */
fun takeoffAge(storedEngineVersion: String, appEngineVersion: String): PullSheetTakeoffAge {
    val stored = storedEngineVersion.trim()
    if (stored.isEmpty()) return PullSheetTakeoffAge.UNRECORDED
    val app = appEngineVersion.trim()
    val storedIsNewer = engineVersionIsNewer(stored, app)
    val appIsNewer = engineVersionIsNewer(app, stored)
    return when {
        storedIsNewer -> PullSheetTakeoffAge.APP_BEHIND
        appIsNewer -> PullSheetTakeoffAge.TAKEOFF_BEHIND
        else -> PullSheetTakeoffAge.CURRENT
    }
}

/** A run reduced to what a pull sheet needs to know about it. */
data class PullSheetRun(
    val id: Long,
    val label: String,
    val isTeardown: Boolean,
    /** The height the run is built to, which is what a post has to suit. */
    val fenceHeightFt: Float,
    /** Drawn on, or typed footage. A run with neither is not work yet. */
    val hasWork: Boolean,
    /**
     * False when this run cannot be honestly measured right now -- an
     * uncalibrated survey photo, [com.fenceestimator.app.estimate.TakeoffRefresher.blockedByUncalibratedPhoto].
     * Its materials are not wrong, they do not exist.
     */
    val measurable: Boolean,
)

/** One stored takeoff line, with the price fields deliberately not carried over. */
data class PullSheetSourceLine(
    val runId: Long?,
    val role: MaterialRole,
    val product: String,
    val quantity: Double,
    val unit: String,
    val isAutoGenerated: Boolean,
)

/** One catalog row, reduced to what decides whether the PRODUCT is right. */
data class PullSheetCatalogRow(
    val name: String,
    val role: MaterialRole,
    val heightFt: Float?,
    val sourceDoc: String,
)

/**
 * One line on the sheet: a thing, how many, and what to ask about it.
 *
 * Merged ACROSS runs when the product and the fence height agree, because a
 * supply counter is worked a product at a time. Two six foot runs needing
 * twelve and ten of the same post is one request for twenty-two, with both run
 * names beside it so it can still be traced back to the drawing.
 *
 * NOT merged across heights, ever. Collapsing a four foot run's posts into a
 * six foot run's would hide the single distinction this page exists to make.
 */
data class PullSheetLine(
    /**
     * Stable identity for the tick, and it includes [quantity] on purpose: if
     * the takeoff changes the count, the tick drops and the line has to be
     * checked off again. At a counter, inheriting a tick for a different
     * number is worse than losing a tick.
     */
    val key: String,
    val section: PullSheetSection,
    val role: MaterialRole,
    val product: String,
    val quantity: Double,
    val unit: String,
    val runLabels: List<String>,
    /** The fence height this line is for; null on a job-level line. */
    val fenceHeightFt: Float?,
    /** What the catalog says the product is for, when it says anything. */
    val catalogHeightFt: Float?,
    val doubts: List<PullSheetDoubt>,
    /**
     * The catalog row exists and declares no height. Information, not a doubt:
     * a 4x4x8 pressure-treated post legitimately declares none and serves both
     * heights, and flagging it would put a warning on every wood job forever.
     */
    val heightNotDeclared: Boolean,
    /**
     * Somebody typed this line rather than the engine generating it. Carried
     * so the page can say so and so it is never doubted: a doubt means the
     * engine picked a product and may have picked wrong, and there is nothing
     * for the engine to have got wrong here.
     */
    val handAdded: Boolean,
)

/** A heading and its lines, in the order a counter is worked through. */
data class PullSheetGroup(val section: PullSheetSection, val lines: List<PullSheetLine>)

/**
 * What the screen is to show. A RESULT, never a bare list.
 *
 * An empty pull sheet that looks complete is the worst thing this page could
 * do: somebody drives to the yard, loads nothing, and finds out on site. So
 * "there is nothing to show" and "there is nothing to buy" are different
 * answers with different wording, and neither is an empty list.
 *
 * It is also the common case rather than an edge: of nineteen live jobs on
 * 2 Oct 2026, six carry any takeoff line at all.
 */
sealed interface PullSheetState {
    /** Nothing drawn and nothing typed. There is no job here yet. */
    data object NoRuns : PullSheetState

    /** Every run is a removal. You do not buy material for a fence you are taking out. */
    data object OnlyTeardown : PullSheetState

    /** Fence to build, and nobody has run the takeoff for any of it. */
    data class NoTakeoff(val runLabels: List<String>) : PullSheetState

    /** Fence to build, and it cannot be measured until somebody calibrates the photo. */
    data class NotMeasurable(val runLabels: List<String>) : PullSheetState

    data class Ready(
        val groups: List<PullSheetGroup>,
        /**
         * Runs that are fence to build and have no takeoff, while other runs
         * do. The dangerous case the whole sheet turns on: three runs, one
         * priced, and a page that looks finished. Named here so the screen
         * must say it out loud.
         */
        val runsWithoutTakeoff: List<String>,
        /** Runs left off because they cannot be measured, while others could. */
        val runsNotMeasurable: List<String>,
        /**
         * The runs whose own takeoff lines are on this sheet, by id.
         *
         * Ids rather than labels because this is not for reading -- it is what
         * the drawing's side lengths are gated on
         * ([com.fenceestimator.app.ui.components.FencePlanCanvas]'s
         * `labelLengthsForRunIds`). A run that is drawn but contributed no line
         * is not in here, so its sides are drawn and not dimensioned: there are
         * no posts counted for that length, and a figure in feet beside a shape
         * is a figure somebody can buy panels against.
         */
        val runIdsOnSheet: Set<Long>,
        /** Every post on the sheet, so the count can be read against the truck. */
        val totalPosts: Double,
        /** True when the job also has a teardown, so the page can say why it is absent. */
        val hadTeardownRuns: Boolean,
    ) : PullSheetState
}

/**
 * Where each role is picked from.
 *
 * Close to [com.fenceestimator.app.estimate.TakeoffGroup] but not the same, and
 * the two differences are both about a yard rather than a quote. TakeoffGroup
 * files POST_CAP under Posts, because that is where it is explained; a counter
 * keeps caps and trim in a different aisle from eight-foot posts, so they are
 * their own section. HOLE_PLUG sits with gate hardware for the same reason --
 * it is a small bagged fitting, picked with the hinges.
 *
 * Anything not listed falls to [PullSheetSection.OTHER] rather than being
 * dropped. A role this map has not heard of is still something on the truck,
 * and silently losing it is exactly the failure this page exists to prevent.
 */
internal val SECTION_OF_ROLE: Map<MaterialRole, PullSheetSection> = mapOf(
    MaterialRole.LINE_POST to PullSheetSection.POSTS,
    MaterialRole.END_POST to PullSheetSection.POSTS,
    MaterialRole.CORNER_POST to PullSheetSection.POSTS,
    MaterialRole.GATE_POST to PullSheetSection.POSTS,
    MaterialRole.BLANK_POST to PullSheetSection.POSTS,

    MaterialRole.PANEL to PullSheetSection.PANELS,
    MaterialRole.GATE_PANEL to PullSheetSection.PANELS,
    MaterialRole.WOOD_PICKET to PullSheetSection.PANELS,
    MaterialRole.WOOD_RAIL to PullSheetSection.PANELS,
    MaterialRole.CHAIN_FABRIC to PullSheetSection.PANELS,
    MaterialRole.TOP_RAIL to PullSheetSection.PANELS,
    MaterialRole.PRIVACY_SLAT to PullSheetSection.PANELS,
    MaterialRole.GATE_FRAME_KIT to PullSheetSection.PANELS,

    MaterialRole.POST_CAP to PullSheetSection.CAPS_AND_TRIM,
    MaterialRole.TRIM to PullSheetSection.CAPS_AND_TRIM,

    MaterialRole.CONCRETE_BAG to PullSheetSection.CONCRETE,

    MaterialRole.HINGE_SET to PullSheetSection.GATE_HARDWARE,
    MaterialRole.LATCH to PullSheetSection.GATE_HARDWARE,
    MaterialRole.HANDLE to PullSheetSection.GATE_HARDWARE,
    MaterialRole.BRACE to PullSheetSection.GATE_HARDWARE,
    MaterialRole.STIFFENER to PullSheetSection.GATE_HARDWARE,
    MaterialRole.HOLE_PLUG to PullSheetSection.GATE_HARDWARE,

    MaterialRole.TENSION_WIRE to PullSheetSection.OTHER,
    MaterialRole.TENSION_BAND to PullSheetSection.OTHER,
    MaterialRole.BRACE_BAND to PullSheetSection.OTHER,
    MaterialRole.RAIL_END to PullSheetSection.OTHER,
    MaterialRole.BARBED_WIRE_ARM to PullSheetSection.OTHER,
    MaterialRole.NONE to PullSheetSection.OTHER,
)

/** Reading order on the page: heavy and bulky first, fittings last. */
internal val SECTION_ORDER: List<PullSheetSection> = listOf(
    PullSheetSection.POSTS,
    PullSheetSection.PANELS,
    PullSheetSection.CAPS_AND_TRIM,
    PullSheetSection.CONCRETE,
    PullSheetSection.GATE_HARDWARE,
    PullSheetSection.OTHER,
)

internal val POST_ROLES: Set<MaterialRole> = setOf(
    MaterialRole.LINE_POST, MaterialRole.END_POST, MaterialRole.CORNER_POST,
    MaterialRole.GATE_POST, MaterialRole.BLANK_POST,
)

/**
 * Builds the sheet.
 *
 * THE POST COUNTS ARE NOT RECOMPUTED HERE, and that is the point of taking
 * [lines] as an argument at all. They are read from the takeoff the engine
 * already wrote ([com.fenceestimator.app.estimate.EstimateEngine.buildLineItems],
 * run after [com.fenceestimator.app.estimate.EstimateEngine.joinAdjustments]),
 * so a corner post SHARED between two joined runs has already been subtracted
 * from one of them and billed to the other. A per-run sum of ends and corners
 * computed here would hand back the older, dearer answer and disagree with
 * every other number on the job.
 *
 * TEARDOWN RUNS ARE DROPPED TWICE. [com.fenceestimator.app.estimate.TakeoffRefresher.refreshRun]
 * already clears a teardown run's generated lines, and the live database agrees
 * (2 Oct 2026: one teardown run, zero teardown runs carrying a line item). This
 * filters them again anyway, so a line left behind on a run marked teardown
 * AFTER its takeoff was built still cannot reach the truck.
 */
fun buildPullSheet(
    runs: List<PullSheetRun>,
    lines: List<PullSheetSourceLine>,
    catalog: List<PullSheetCatalogRow>,
): PullSheetState {
    val real = runs.filter { it.hasWork }
    if (real.isEmpty()) return PullSheetState.NoRuns

    val toBuild = real.filterNot { it.isTeardown }
    if (toBuild.isEmpty()) return PullSheetState.OnlyTeardown

    val buildableIds = toBuild.filter { it.measurable }.map { it.id }.toSet()
    val runById = toBuild.associateBy { it.id }

    // A line belongs on the sheet when it belongs to a run we are building and
    // can measure, or when it is job-level (runId null -- a hand-typed extra).
    val usable = lines.filter { line ->
        line.quantity > 0.0 && (line.runId == null || line.runId in buildableIds)
    }

    val runsWithTakeoff = usable.mapNotNull { it.runId }.toSet()
    val missing = toBuild.filter { it.measurable && it.id !in runsWithTakeoff }.map { it.label }
    val unmeasurable = toBuild.filterNot { it.measurable }.map { it.label }

    if (usable.isEmpty()) {
        // Nothing at all. Which of the two reasons it is decides the wording,
        // and "cannot be measured" wins when it explains every run -- telling
        // someone to run the takeoff on a job that has no scale to measure at
        // sends them round a loop that cannot close.
        return if (unmeasurable.isNotEmpty() && missing.isEmpty()) {
            PullSheetState.NotMeasurable(unmeasurable)
        } else {
            PullSheetState.NoTakeoff(toBuild.map { it.label })
        }
    }

    val lineKeyed = usable.groupBy { line ->
        val run = line.runId?.let { runById[it] }
        MergeKey(
            section = SECTION_OF_ROLE[line.role] ?: PullSheetSection.OTHER,
            role = line.role,
            product = line.product,
            unit = line.unit,
            fenceHeightFt = run?.fenceHeightFt,
            handAdded = !line.isAutoGenerated,
        )
    }

    val built = lineKeyed.map { (key, group) ->
        val quantity = group.sumOf { it.quantity }
        val runLabels = group.mapNotNull { it.runId?.let { id -> runById[id]?.label } }
            .distinct()
            .sorted()
        val row = matchCatalog(catalog, key.product, key.role)
        PullSheetLine(
            key = tickKey(key, quantity),
            section = key.section,
            role = key.role,
            product = key.product,
            quantity = quantity,
            unit = key.unit,
            runLabels = runLabels,
            fenceHeightFt = key.fenceHeightFt,
            catalogHeightFt = row?.heightFt,
            doubts = doubtsFor(key, row),
            heightNotDeclared = row != null && row.heightFt == null,
            handAdded = key.handAdded,
        )
    }

    val groups = SECTION_ORDER.mapNotNull { section ->
        val inSection = built.filter { it.section == section }
            // Doubted lines first inside a section: the thing to ask about is
            // the thing you want to see before the counter starts picking.
            .sortedWith(
                compareByDescending<PullSheetLine> { it.doubts.isNotEmpty() }
                    .thenBy { it.role.name }
                    .thenBy { it.fenceHeightFt ?: Float.MAX_VALUE }
                    .thenBy { it.product }
            )
        if (inSection.isEmpty()) null else PullSheetGroup(section, inSection)
    }

    return PullSheetState.Ready(
        groups = groups,
        runsWithoutTakeoff = missing,
        runsNotMeasurable = unmeasurable,
        runIdsOnSheet = runsWithTakeoff,
        totalPosts = built.filter { it.role in POST_ROLES }.sumOf { it.quantity },
        hadTeardownRuns = real.any { it.isTeardown },
    )
}

internal data class MergeKey(
    val section: PullSheetSection,
    val role: MaterialRole,
    val product: String,
    val unit: String,
    val fenceHeightFt: Float?,
    val handAdded: Boolean,
)

/**
 * The catalog row a line's product came from, matched by NAME because that is
 * the only link a stored line has to it -- [com.fenceestimator.app.data.EstimateLineItem.description]
 * is a verbatim copy of the chosen row's `name` and nothing else connects them.
 *
 * Role-exact. A row of another role with the same name is a different product
 * for this purpose; matching across roles would let a post be checked against
 * a cap.
 */
internal fun matchCatalog(
    catalog: List<PullSheetCatalogRow>,
    product: String,
    role: MaterialRole,
): PullSheetCatalogRow? = catalog.firstOrNull { it.name == product && it.role == role }

internal fun doubtsFor(key: MergeKey, row: PullSheetCatalogRow?): List<PullSheetDoubt> {
    // A line somebody typed is never doubted: a doubt says the engine chose a
    // product and may have chosen wrong, and no engine chose this one.
    if (key.handAdded) return emptyList()
    if (row == null) return listOf(PullSheetDoubt.NOT_IN_CATALOG)
    val out = mutableListOf<PullSheetDoubt>()
    if (row.sourceDoc.startsWith(IMPORTED_CHECK_FILING)) out += PullSheetDoubt.FILING_UNCHECKED
    val catalogHeight = row.heightFt
    val runHeight = key.fenceHeightFt
    if (catalogHeight != null && runHeight != null && catalogHeight != runHeight) {
        out += PullSheetDoubt.WRONG_HEIGHT
    }
    return out
}

/**
 * The tick's identity. Quantity is in it deliberately -- see [PullSheetLine.key].
 *
 * Both numbers go through a FIXED two-decimal, Locale.ROOT format rather than
 * `toString()`. Two reasons, and the second is the one that bites: a bare
 * toString writes 6f as "6.0" and 6.0 as "6.0" but 22.0 as "22.0" while the
 * JavaScript mirror in tests/a71-pull-sheet.test.mjs writes "22" -- the two
 * would be transcriptions of each other that disagree, so the test could not
 * hold the real rule; and on a French or Spanish phone a locale-sensitive
 * format writes "6,00", so every tick made in one language would be invisible
 * after the phone's language was changed.
 */
internal fun tickKey(key: MergeKey, quantity: Double): String = listOf(
    key.section.name,
    key.role.name,
    key.product,
    key.unit,
    heightToken(key.fenceHeightFt),
    if (key.handAdded) "hand" else "auto",
    quantityToken(quantity),
).joinToString("|")

internal fun heightToken(height: Float?): String =
    if (height == null) "-" else String.format(java.util.Locale.ROOT, "%.2f", height)

internal fun quantityToken(quantity: Double): String =
    String.format(java.util.Locale.ROOT, "%.2f", quantity)
