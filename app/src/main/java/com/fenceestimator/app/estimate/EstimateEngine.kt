package com.fenceestimator.app.estimate

import com.fenceestimator.app.R
import com.fenceestimator.app.data.ChangeOrder
import com.fenceestimator.app.data.EstimateLineItem
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.MaterialItem
import com.fenceestimator.app.data.MaterialRole
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FenceGeometryEngine
import com.fenceestimator.app.geometry.FenceGeometryResult
import com.fenceestimator.app.geometry.GateMarker
import com.fenceestimator.app.geometry.GateMounting
import com.fenceestimator.app.geometry.JoinAdjustment
import com.fenceestimator.app.geometry.JoinableRun
import com.fenceestimator.app.geometry.RunJoinArithmetic
import com.fenceestimator.app.geometry.RunPostAdjustment
import kotlin.math.ceil
import kotlin.math.roundToInt

/** One suggested catalog role + quantity, optionally preferring an item covering a specific width/height. */
data class QtyEntry(
    val role: MaterialRole,
    val quantity: Double,
    val preferCoversFt: Float? = null,
    /**
     * The run of fence this entry has to cover, in feet.
     *
     * Carried because [quantity] has already been rounded up to whole units at
     * one width, and re-deriving feet from it (quantity x width) inherits that
     * rounding -- which buys an extra panel every time the catalog stocks a
     * different width than the run was spec'd for. The true footage does not
     * have that problem.
     */
    val coversLinearFt: Float? = null
)

data class EstimateSuggestions(
    val geometry: FenceGeometryResult,
    val netLinearFeet: Float,
    val entries: List<QtyEntry>,
    /** Plain-English counts, shown to the contractor whether or not the catalog has a matching item. */
    val takeoff: List<TakeoffLine> = emptyList()
)

/**
 * Where a post count came from, in the order the arithmetic happens.
 *
 * Deliberately NOT a field on [TakeoffLine]: that type is part of the
 * pricing contract, mirrored by the TypeScript engine and pinned by 77
 * golden fixtures, and widening it to carry a display concern would mean
 * regenerating all of them to say nothing new about price.
 */
data class PostWorkings(
    val fenceFeet: Float,
    val gateFeet: Float,
    val netFeet: Float,
    val spacingFt: Float,
    val bays: Int,
    /** An open run needs a post to finish on; a closed loop lands back on its first. */
    val openRun: Boolean,
    val gateCount: Int,
    val standardEstimate: Int,
    val linePosts: Int,
    val cornerPosts: Int,
    val endPosts: Int,
    val gatePosts: Int,
    val totalPosts: Int,
    /**
     * Posts this run no longer builds because the owner joined one of its
     * ends to another run's end: two free ends become ONE post in the ground,
     * so the "why does it say thirty-three posts?" sheet has to say so or
     * [standardEstimate] above will not add up to [totalPosts] and the
     * explanation becomes a formula the product does not use.
     *
     * Zero on every run of every job that has no joint, which is every job
     * today. Defaulted so the existing call sites compile unchanged.
     */
    val postsSharedAtJoints: Int = 0,
)

/** One "8 line posts" style readout for the takeoff summary. */
data class TakeoffLine(
    val label: String,
    val quantity: Double,
    val unit: String = "",
    /**
     * Which heading this belongs under.
     *
     * The list used to run as one flat column, so total posts sat several rows
     * away from the line, end and corner posts it is the sum of -- and the
     * person loading the truck had to hold the grouping in their head. Things
     * you count together are now printed together.
     */
    val group: TakeoffGroup = TakeoffGroup.OTHER
)

/** Headings on the takeoff, in the order someone actually works through them. */
enum class TakeoffGroup(val heading: String) {
    SITE("The fence line"),
    POSTS("Posts"),
    PANELS("Panels, rails and pickets"),
    CONCRETE("Concrete"),
    GATES("Gate hardware"),
    OTHER("Everything else")
}

/** Fence types whose gate uses a built gate-frame kit rather than a matching panel. */
private val FRAME_KIT_GATE_TYPES = setOf(FenceType.WOOD, FenceType.CHAIN_LINK, FenceType.SPLIT_RAIL, FenceType.COMPOSITE)

/**
 * Fence types whose gate leaf needs a STIFFENER -- the vertical that stops the
 * leaf racking out of square.
 *
 * VINYL alone, and for a physical reason rather than a seeding accident. A
 * vinyl gate arrives as a hollow extruded leaf, and the part that stiffens it
 * is sized to the post it bolts to: the one in every catalog here is a 5" econo
 * stiffener (an H-frame 5x5x96, both suppliers' own wording -- see
 * SUPPLIER_QUOTES_2026-10-01.md), which fits a 5x5 vinyl post and fits nothing
 * else. Every other type's gate is already rigid when it reaches site:
 *
 *  - CHAIN_LINK is a welded tube frame with fabric stretched in it.
 *  - ALUMINUM and ORNAMENTAL_IRON arrive as a welded factory gate panel.
 *  - WOOD, SPLIT_RAIL and COMPOSITE are built on a GATE_FRAME_KIT
 *    ([FRAME_KIT_GATE_TYPES]) -- the seeded wood one is literally
 *    "Steel-Reinforced", which IS the member that keeps the leaf square.
 *
 * The takeoff asked all seven for one anyway, and six of them had nothing to
 * price it against: the role landed in [BuiltItems.unmatchedRoles] and billed
 * nothing, so no money ever moved. Seeding a stiffener for those six instead
 * would have been the dishonest fix -- a 5x5 vinyl H-frame on a chain-link
 * quote is a part he would order and could not fit.
 *
 * A company that genuinely does stiffen another type's gate adds its own row;
 * teaching the takeoff to ask for it is a decision for the owner, not a silent
 * one, because a row nobody sells cannot be told from a row nobody needs.
 */
private val STIFFENED_GATE_TYPES = setOf(FenceType.VINYL)

/**
 * Fence types whose gate needs a BRACE -- the diagonal that stops the leaf
 * sagging on its hinges.
 *
 * Deliberately a SECOND set with the same single member as
 * [STIFFENED_GATE_TYPES] and not one shared constant: a stiffener and a brace
 * answer different problems (racking against sagging) and the day a type needs
 * one and not the other, one list cannot say so.
 *
 * VINYL, for the same reason: the seeded "Gate Support Brace, 8'" is a vinyl
 * part, not a generic one. It is White, it is 8 ft, and the equivalent on the
 * other supplier's list is a "V-brace white bevelled gate brace 8'" -- a
 * bevelled white extrusion that goes inside a vinyl gate frame. Neither
 * supplier quotes it on anything but vinyl.
 *
 * A WOOD gate does need bracing, and that is exactly why it is not here: its
 * brace is not this product. It comes in the steel-reinforced GATE_FRAME_KIT
 * the takeoff already asks for, so asking for a BRACE as well would bill the
 * same function twice -- and on the starting catalog it would bill it against a
 * white vinyl extrusion. Same for SPLIT_RAIL and COMPOSITE, whose kits carry
 * their own structure, and for CHAIN_LINK, ALUMINUM and ORNAMENTAL_IRON, whose
 * gates arrive welded. (CHAIN_LINK's BRACE_BAND is a terminal-post fitting and
 * an unrelated role; it is seeded and asked for already.)
 *
 * If a company builds wood gates from stock lumber and an anti-sag kit, the
 * honest row for that is its GATE_FRAME_KIT. What NOT to do is invent a price
 * for a wood gate brace: nobody here has quoted one.
 */
private val BRACED_GATE_TYPES = setOf(FenceType.VINYL)

/**
 * Turns a calibrated fence run (drawing + gate placements + type/spec) into
 * suggested material quantities. These are starting numbers meant to be
 * reviewed and adjusted by the contractor before pricing -- not a guarantee
 * of exact takeoff.
 */
object EstimateEngine {

    /**
     * Which arithmetic this engine speaks. The server port carries the same
     * constant, and the committed parity fixtures carry it too: a change to
     * any formula here is a new version, regenerated fixtures, and the port
     * moved in the same commit -- never one side alone.
     *
     * Bumped 2026.09.2 -> 2026.09.3 for the LINE_TO_WALL post-cap fix
     * (computePostCounts' gatePosts, ported to takeoff.ts): the formula
     * moved and this stayed 2026.09.2 on BOTH engines through that whole
     * change, so an old phone and the new office would have priced the
     * identical job differently with nothing to catch it -- see
     * tests/a18-gate-post-cap-parity-fix.test.mjs and
     * tests/a4-engine-parity.test.mjs FINDING 2. jobs.pricing_engine_version
     * (JobSync.kt pushContractTotal / price-job/index.ts) needs no
     * migration for the bump: [JobMoney.anchoredTotal] is checked FIRST
     * and, when a total is anchored (a quote
     * that has been sent or accepted), no recompute happens regardless of
     * engine version, so a signed price never moves under a customer's
     * feet just because this number changed. An un-anchored job priced by
     * this phone under the old version simply re-prices, silently, on its
     * next sync, the same as any other formula fix always has; an
     * un-anchored job the OFFICE priced under the old version is caught by
     * JobSync's own engineVersionIsNewer comparison, which now sees the
     * phone ahead of the stored office version, records the disagreement
     * to pricing_drift (or app_errors if the phone is somehow the one
     * behind), and still refuses to overwrite a total once quote_sent_at is
     * set. Old rows read as stale, not wrong, and stale is exactly what
     * lets that machinery do its job.
     *
     * Bumped 2026.09.3 -> 2026.10.1 (1 Oct 2026) for the total's rounding:
     * [Totals.grandTotal] is now EXACT to the cent instead of rounded up to the
     * next ten ([computeTotals], through [roundToCents]) -- the owner's
     * decision, taken knowing the cost. totals.ts moved with it, and the
     * fixtures regenerate with nearly every grand_total lower by up to $10
     * (and nothing else in any fixture moving).
     * A formula change, so a version change, on both sides at once. Anchored
     * totals are untouched, as above: an accepted price never moves for a new
     * version number.
     *
     * A phone still on 2026.09.3 rounds up to ten until it updates; the
     * version comparison above is what keeps that from overwriting an office
     * price priced under this version.
     *
     * Bumped 2026.10.1 -> 2026.10.2 (1 Oct 2026) for panel height: between PANEL
     * (or GATE_PANEL) rows of one width, the row whose [MaterialItem.heightFt]
     * equals the run's panel height now beats a row that does not ([buildLineItems],
     * and line-items.ts buildLineItems on the server). A formula change, so a
     * version change on BOTH engines, and the 85 fixtures regenerate in the same
     * commit.
     * It moves a quote only where a company has filled a height in: a catalog that
     * declares none is priced exactly as under 2026.10.1. Where it does move one
     * it is the starting catalog's 6 ft ornamental iron, which was priced with the
     * 4 ft high panel (an undercharge of $40 a panel before tax and markup).
     * Anchored totals do not move, as above.
     *
     * Bumped 2026.10.2 -> 2026.10.3 (1 Oct 2026) to extend that same height rule
     * to the POST roles -- LINE_POST, END_POST, CORNER_POST, GATE_POST,
     * BLANK_POST ([buildLineItems], and line-items.ts buildLineItems on the
     * server). A formula change, so a version change on BOTH engines, and the 85
     * fixtures regenerate in the same commit. This one is not a price: a post has
     * no width, so it was chosen by price alone, and on the owner's own catalog a
     * 72 ft run six feet high was quoted "5x5 Utility Post White 6' (Flori, 4ft
     * run)" at $13.18 -- the post the supplier sells for a FOUR foot fence, six
     * feet long, so nothing of it is in the ground. A fence built on it falls
     * over. On a post, [MaterialItem.heightFt] is the FENCE height the post is
     * for, not the post's own length. Additive exactly as 2026.10.2 was: a
     * catalog where no post declares a height prices identically, and it moves a
     * quote only where a height has been filled in. Anchored totals do not move,
     * as above.
     *
     * Bumped 2026.10.3 -> 2026.10.4 (1 Oct 2026) because a gate now asks for a
     * GATE_POST ([gateAreaEntries], and takeoff.ts gateAreaEntries on the
     * server). WALL is BLANK_POST + GATE_POST, LINE is GATE_POST 2,
     * LINE_TO_WALL is GATE_POST 2 + END_POST 1 -- that third post is where the
     * run terminates at the wall, which is a genuine end post. Every COUNT is
     * unchanged: gatePosts, totalPosts, POST_CAP and CONCRETE_BAG all come out
     * exactly as under 2026.10.3, and the takeoff summary lines do not move.
     * What changes is WHICH CATALOG ROW IS BILLED for those posts, so it is a
     * formula change, so a version change on both engines and the 85 fixtures
     * regenerate in the same commit. Before this, nothing in either engine ever
     * asked for GATE_POST: the role existed, the editor offered it, the seed
     * shipped one per fence type, and a gate quietly bought END_POST rows
     * instead. The owner's catalog has ten GATE_POST rows priced by hand that no
     * estimate could reach.
     * This is additive ONLY once the line-item matcher prefers END_POST for a
     * GATE_POST entry with no candidates; without that, a catalog holding no
     * GATE_POST row loses its gate posts from the estimate entirely. That
     * fallback belongs in [buildLineItems] on both sides and MUST land in the
     * same commit as this bump. Anchored totals do not move, as above.
     *
     * Bumped 2026.10.4 -> 2026.10.5 (1 Oct 2026) because a BLANK_POST entry
     * with no BLANK_POST row is now priced off the company's GATE_POST rows --
     * the owner's decision, taken knowing the cost ([PRICING_FALLBACK_ROLE],
     * and PRICING_FALLBACK_ROLE in line-items.ts). BLANK_POST has never existed
     * in any catalog anywhere -- not [SeedData], not supabase_r20's seed, not
     * the office page's starting list, and zero rows across every company
     * (read-only SELECT, 1 Oct 2026) -- while [gateAreaEntries] asks for one on
     * every WALL-mounted gate. So that post has been silently dropped from
     * every wall-gate estimate ever written: the role went into
     * [BuiltItems.unmatchedRoles] and no line appeared.
     *
     * THIS ONE IS NOT ADDITIVE, unlike 2026.10.2 and 2026.10.3, and it is the
     * first bump here that is not. Every wall-gate quote in every company that
     * has a GATE_POST row goes UP by one post plus tax -- on the owner's own
     * catalog $17.72 for a 6 ft white vinyl gate ($16.56 + 7%), before markup;
     * $17.93 at 4 ft ($16.75), and $10.16 wood, $21.14 chain link, $23.54
     * aluminum, $29.96 composite, $34.24 ornamental iron, $14.98 split rail on
     * his rows for those types -- all measured with the real engine rather than
     * multiplied out by hand, which is why three of them sit a cent off the row
     * times 1.07: tax is taken on the whole taxable subtotal and each grand
     * total is rounded to the cent, so the DIFFERENCE of two totals can land
     * either side. Nothing else moves: a quote with no WALL gate
     * is priced identically, and so is one in a catalog with no GATE_POST row
     * (the fallback does NOT chain to END_POST). The 85 fixtures regenerate in
     * the same commit; the wall-gate ones among them move upward by one post
     * and the rest do not move at all.
     *
     * The LINE keeps role BLANK_POST and takes the chosen row's name, so a
     * quote names the gate post it really billed rather than claiming a product
     * he does not stock. [BuiltItems.unmatchedRoles] keeps its meaning --
     * nothing was billed for this role -- so BLANK_POST leaves it where a
     * GATE_POST row carries the line and stays in it where neither row exists.
     * Anchored totals do not move, as above.
     *
     * Bumped 2026.10.6 -> 2026.10.7 (1 Oct 2026) for the gate hardware a fence
     * type actually uses: the takeoff no longer asks for a BRACE or a
     * STIFFENER on a gate that does not take one ([BRACED_GATE_TYPES],
     * [STIFFENED_GATE_TYPES] -- vinyl alone), and the starting catalog's gate
     * HANDLE moves from VINYL to UNIVERSAL so the six other types can reach it
     * (SeedData.universalItems, supabase_r20's list, dashboard.html's
     * CATALOG_SEED -- all three, or two new companies get different catalogs
     * depending which door they came through).
     *
     * NOBODY'S PRICE MOVES who has a catalog today. Those two roles were
     * unmatched on all six non-vinyl types in every catalog in production
     * (read-only SELECT, 1 Oct 2026), so they billed nothing and a takeoff that
     * stops asking subtracts nothing; what goes is the unmatched-role noise. A
     * vinyl gate is priced to the cent as before, including the entry ORDER
     * that line sort order follows. The owner's own company is vinyl with one
     * UNGATED wood run: all eleven of his live jobs reprice BYTE-IDENTICALLY,
     * measured by replaying his own cloud rows through this engine and through
     * a copy of this same tree with only these gate edits undone -- not argued,
     * and not read off the totals alone (the whole output was compared).
     *
     * WHAT DOES MOVE is a NEW company's first non-vinyl gated quote, by the one
     * handle: +$5.00 of material (plus that company's tax and markup) per gate
     * on wood, chain link, aluminum, ornamental iron, split rail and composite.
     * An existing company's catalog is its own and is never rewritten.
     *
     * Bumped 2026.10.7 -> 2026.10.9 (1 Oct 2026) because TWO SIDES THE OWNER
     * HAS JOINED NOW SHARE ONE POST. [RunJoinArithmetic.adjust] is called once
     * over every run of the job and each run's own [RunPostAdjustment] handed
     * to [suggestQuantities], which applies it at the END of
     * [computePostCounts] -- after the counts are finished, never fed into
     * them, because corners and ends are carved out of one fixed estimate and
     * line posts are whatever is left. At a joint where `degree` run ends
     * meet: end posts fall by `degree`, ONE corner (or line) post appears, so
     * the job builds `degree - 1` fewer posts -- and `degree - 1` fewer CAPS
     * (priced off totalPosts) and bags of CONCRETE (priced off totalPosts -
     * gatePosts), and on chain link fewer tension bands, brace bands and rail
     * ends (priced off terminalPosts). Two ends that met become ONE CORNER
     * POST, a different catalog row at a different price, so getting the
     * count right while leaving both as end posts would have been only half
     * of it. The server's copy is joins.ts.
     *
     * A formula change, so a version change on BOTH engines, and the 85
     * fixtures regenerate in the same commit.
     *
     * ADDITIVE TO THE CENT where nothing is joined, which is everywhere
     * today: no run carries a joint id, so [RunJoinArithmetic.adjust] returns
     * [JoinAdjustment.NONE] before it reads any geometry and the default
     * argument below leaves every existing caller pricing exactly as it did.
     * Anchored (signed/sent) totals do not move regardless, as above.
     *
     */
    const val PRICING_ENGINE_VERSION = "2026.10.11"

    /**
     * Money, to the cent: the ONE place a total is rounded.
     *
     * The total is a chain of double multiplications (tax, markup, then
     * discount), so a job worth exactly $2,200 can come out as
     * 2200.0000000000005 -- float dust, not a price, which must never be
     * stored or shown. The old ceil-to-ten used to hide it. Two decimal places
     * because a cent is the smallest thing money has.
     *
     * Math.round(x * 100.0) / 100.0 and nothing cleverer, because it is
     * exactly what totals.ts writes (Math.round(x * 100) / 100): the same
     * IEEE multiply and divide, and both round halves toward +infinity, so the
     * two engines return the same double for the same input. NOT
     * kotlin.math.round, which rounds halves to even and would disagree with
     * the server on a half-cent. A non-finite value passes through untouched:
     * Math.round turns NaN into 0, and a NaN total must stay visibly broken
     * rather than quietly become a $0.00 quote.
     */
    fun roundToCents(value: Double): Double =
        if (value.isFinite()) Math.round(value * 100.0) / 100.0 else value

    private data class PostCounts(
        val linePosts: Int,
        val cornerPosts: Int,
        val endPosts: Int,
        val gatePosts: Int,
        val terminalPosts: Int,
        val totalPosts: Int,
        /** Bays the run divides into at the chosen spacing, before any adjustment. */
        val bays: Int = 0,
        /** Posts the run length alone calls for, once ends and gates are accounted for. */
        val standardEstimate: Int = 0,
        /**
         * Posts this run no longer builds because the owner joined one of its
         * ends to another run's end. Zero unless a [RunPostAdjustment] was
         * applied, so zero on every job with no joint -- which is every job
         * today. Carried only so [explainPosts] can say why [standardEstimate]
         * no longer adds up to [totalPosts]; nothing is priced off it.
         */
        val postsSharedAtJoints: Int = 0
    )

    /**
     * Roles bought by length or by the piece, where an extra cut-and-waste
     * allowance makes sense. Posts, caps, and hardware are deliberately absent:
     * you buy those as whole units off an exact count.
     */
    private val WASTE_ROLES = setOf(
        MaterialRole.PANEL, MaterialRole.WOOD_PICKET, MaterialRole.WOOD_RAIL,
        MaterialRole.CHAIN_FABRIC, MaterialRole.TOP_RAIL, MaterialRole.TENSION_WIRE,
        MaterialRole.PRIVACY_SLAT, MaterialRole.CONCRETE_BAG, MaterialRole.TRIM
    )

    /**
     * @param wastePercent extra allowance applied to cut-and-waste roles only.
     * @param joinAdjustment how THIS run's post counts move because of the
     *   joints the owner has made between its ends and other runs' ends. Null
     *   is "no joint touches this run" and prices exactly as before joints
     *   existed. The caller works it out ONCE over every run of the job
     *   ([joinAdjustments], which calls [RunJoinArithmetic.adjust]) and hands
     *   each run its own [JoinAdjustment.forRun], because the run billed a
     *   shared post is chosen ACROSS runs -- a per-run call would see one
     *   candidate and every member would keep its post.
     */
    fun suggestQuantities(
        run: FenceRun,
        pixelsPerFoot: Float,
        wastePercent: Double = 0.0,
        joinAdjustment: RunPostAdjustment? = null
    ): EstimateSuggestions {
        val gates = FenceCodec.decodeGates(run.gatesEncoded)
        val geometry = resolveGeometry(run, pixelsPerFoot)
        val gateWidthTotal = gates.sumOf { it.widthFt.toDouble() }.toFloat()
        val netFt = (geometry.totalLinearFeet - gateWidthTotal).coerceAtLeast(0f)

        val postCounts = computePostCounts(geometry, gates, run.postSpacingFt, netFt, joinAdjustment)

        val entries = mutableListOf<QtyEntry>()
        when (run.fenceType) {
            FenceType.VINYL, FenceType.ALUMINUM, FenceType.ORNAMENTAL_IRON -> entries += panelBasedEntries(run, netFt, postCounts)
            FenceType.WOOD, FenceType.COMPOSITE -> entries += picketAndRailEntries(run, netFt, postCounts)
            FenceType.CHAIN_LINK -> entries += chainLinkEntries(run, netFt, postCounts)
            FenceType.SPLIT_RAIL -> entries += splitRailEntries(run, netFt, postCounts)
            FenceType.UNIVERSAL -> {}
        }

        // Gate posts are left out here and paid for by the gate itself.
        //
        // They were counted in both places: totalPosts includes the two posts
        // per gate, and the gate area then added its own bags for the same two
        // holes. Every gate on every job carried a double charge for concrete.
        val nonGatePosts = (postCounts.totalPosts - postCounts.gatePosts).coerceAtLeast(0)
        entries += QtyEntry(MaterialRole.CONCRETE_BAG, nonGatePosts * run.concreteBagsPerPost.toDouble())

        // hasFenceLine: is there any fence for a latch post to connect TO? A
        // gate-only run (a standalone gate sale, no line drawn) has none, and
        // its second post is a blank rather than the end of a fence that is not
        // there.
        val hasFenceLine = geometry.totalLinearFeet > 0f
        gates.forEach { gate -> entries += gateEntries(run.fenceType, gate, hasFenceLine) }

        val withWaste = applyWaste(entries, wastePercent)
        val kept = wholeBags(withWaste).filter { it.role !in run.suppressedRoles }

        return EstimateSuggestions(
            geometry = geometry,
            netLinearFeet = netFt,
            entries = kept,
            takeoff = buildTakeoff(geometry, gates.size, postCounts, kept)
        )
    }

    /**
     * Total footage across a job's runs.
     *
     * The one place this is worked out. It used to be copied by hand into the
     * home screen, the job screen and the estimate screen, and three copies of
     * a rule is three chances for the home total to stop matching the job it
     * came from -- the sort of disagreement that reads as the app inventing
     * numbers. Calling this from all of them means they cannot drift apart.
     *
     * A drawn run with a stored calibration measures at it; an uncalibrated
     * drawn run on the GRID (no survey photo) measures at
     * [DrawingScale.PIXELS_PER_FOOT_GRID] -- the same flat scale
     * [suggestQuantities] already measures materials at for it, and the same
     * one the server port's own footageOf (pricing/totals.ts) uses, so a run
     * priced off the drawing bills the same footage on both halves of the
     * estimate AND the same footage the office would compute for it. This
     * used to read the job's calibration directly and treat "none set" as
     * zero feet, which billed full materials and zero labour for the same
     * grid run.
     *
     * An uncalibrated drawn run on a SURVEY PHOTO is different, and is NOT
     * given that same fallback. A grid square is a known size, so 20 px/ft
     * is a fact; a photo has no scale at all until somebody calibrates it
     * against something of known length. Guessing one would price labour off
     * a made-up number -- worse than the zero this billed before, because
     * zero at least reads as "incomplete" rather than as a real quote nobody
     * can trust. [DrawingScale.isPhotoJob] is what tells the two cases apart
     * ([DrawingScale.of] already refuses to answer for exactly this job
     * shape); a photo run with no calibration still contributes nothing,
     * same as every uncalibrated run did before the grid fallback existed.
     *
     * The server (pricing/totals.ts) cannot make this same distinction by
     * reading `job.calibrationPixelsPerFoot` alone: its JobRow / PricingInput
     * contract has no survey-photo field of its own, only
     * `calibration_pixels_per_foot` -- adding one would mean widening a type
     * this file does not own. Instead the boundary that builds the engine's
     * input (`buildPricingInput`, supabase/functions/_shared/pricing/load.ts)
     * reads the column that DOES travel to the office, `survey_storage_path`
     * (verified against the live schema, not assumed -- `survey_image_path`,
     * the phone-local field, is not a column at all), and for an uncalibrated
     * photo run hands the engine that run with no drawing and no gates --
     * exactly what a run that was never drawn looks like. The unmodified
     * engine then refuses it on its own, the same way it already refuses a
     * run with nothing drawn on it. A calibrated photo, and every grid run,
     * reach the engine untouched.
     *
     * Only a run with neither typed footage nor any drawing at all, and an
     * uncalibrated photo run, still contribute nothing.
     */
    // Only fence being BUILT. The old fence's footage is the teardown
    // charge's business, not the labour rate's -- counting it here billed
    // installation labour for a fence that is leaving the property.
    fun linearFeet(job: Job, runs: List<FenceRun>): Float =
        runs.filterNot { it.isTeardown }.sumOf { run -> footageOf(job, run) }.toFloat()

    /**
     * The body [linearFeet] and [teardownLinearFeet] share: typed footage,
     * else the stored calibration, else the grid's flat fallback scale
     * UNLESS this is an uncalibrated survey photo ([DrawingScale.isPhotoJob])
     * -- in which case there is no honest scale to measure by and the run
     * contributes nothing, same as a run with no drawing at all. See
     * [linearFeet] for how the server reaches the identical answer without
     * this function, or this check, existing on that side at all.
     *
     * Deliberately NOT [DrawingScale.of]: that helper also rescales an
     * uncalibrated GRID job to its own extent
     * ([DrawingScale.unitsPerFoot]), which a job whose grid is not the
     * default 400 ft would measure differently here than the flat scale the
     * server still assumes. Only the photo/grid split is this function's to
     * fix; changing the grid case's own scale would be a second, unrelated
     * formula change the server has no way to follow.
     */
    private fun footageOf(job: Job, run: FenceRun): Double {
        val manual = run.manualLinearFeet
        if (manual != null && manual > 0f) return manual.toDouble()
        if (job.calibrationPixelsPerFoot == null && DrawingScale.isPhotoJob(job)) return 0.0
        val pixelsPerFoot = job.calibrationPixelsPerFoot ?: DrawingScale.PIXELS_PER_FOOT_GRID
        return resolveGeometry(run, pixelsPerFoot).totalLinearFeet.toDouble()
    }

    /**
     * Footage either comes from the drawing or is typed in. Typed-in footage
     * wins outright, which is what lets a run be quoted with no drawing and no
     * calibration -- corners are taken from the run's own count instead of being
     * measured off vertices that don't exist.
     */
    private fun resolveGeometry(run: FenceRun, pixelsPerFoot: Float): FenceGeometryResult {
        val manual = run.manualLinearFeet
        if (manual != null && manual > 0f) {
            return FenceGeometryResult(
                totalLinearFeet = manual,
                segments = emptyList(),
                vertices = emptyList(),
                cornerCount = run.manualCornerCount.coerceAtLeast(0),
                // A closed loop has no loose ends; an open run has two.
                endCount = if (run.closedLoop) 0 else 2,
                lineVertexCount = 0
            )
        }
        return FenceGeometryEngine.analyze(FenceCodec.decodePoints(run.pointsEncoded), pixelsPerFoot, run.closedLoop)
    }

    /**
     * Concrete, rounded up to bags you can actually buy.
     *
     * The yard sells a 60lb bag whole. A takeoff asking for 2.5 bags cannot be
     * ordered and cannot be priced honestly -- and it happened on every job
     * with no waste allowance set, because [applyWaste] returns early at 0%
     * and nothing else rounded.
     *
     * Summed BEFORE rounding, deliberately. Rounding each entry on its own
     * turns a 1.2-bag run and a 1.3-bag gate into four bags instead of three,
     * and that error repeats on every gate of every job.
     */
    private fun wholeBags(entries: List<QtyEntry>): List<QtyEntry> {
        val total = entries.filter { it.role == MaterialRole.CONCRETE_BAG }.sumOf { it.quantity }
        if (total <= 0.0) return entries
        return entries.filterNot { it.role == MaterialRole.CONCRETE_BAG } +
            QtyEntry(MaterialRole.CONCRETE_BAG, ceil(total))
    }

    private fun applyWaste(entries: List<QtyEntry>, wastePercent: Double): List<QtyEntry> {
        if (wastePercent <= 0.0) return entries
        val factor = 1.0 + wastePercent / 100.0
        return entries.map { entry ->
            when {
                entry.role !in WASTE_ROLES -> entry
                // Concrete is rounded once, after every entry has been summed
                // -- that is [wholeBags]' whole point. Rounding it here as
                // well rounded it twice, so a 1.2-bag run and a 1.3-bag gate
                // came to four bags instead of three, on every gated job.
                entry.role == MaterialRole.CONCRETE_BAG ->
                    entry.copy(quantity = entry.quantity * factor)
                else -> entry.copy(quantity = ceil(entry.quantity * factor))
            }
        }
    }

    /** The counts a contractor actually reads off before ordering. */
    private fun buildTakeoff(
        geometry: FenceGeometryResult,
        gateCount: Int,
        posts: PostCounts,
        entries: List<QtyEntry>
    ): List<TakeoffLine> {
        fun qty(role: MaterialRole) = entries.filter { it.role == role }.sumOf { it.quantity }
        return listOf(
            TakeoffLine("Fence length", geometry.totalLinearFeet.toDouble(), "ft", TakeoffGroup.SITE),
            TakeoffLine("Gates", gateCount.toDouble(), "", TakeoffGroup.SITE),

            TakeoffLine("Line posts", posts.linePosts.toDouble(), "", TakeoffGroup.POSTS),
            TakeoffLine("Corner posts", posts.cornerPosts.toDouble(), "", TakeoffGroup.POSTS),
            TakeoffLine("End posts", posts.endPosts.toDouble(), "", TakeoffGroup.POSTS),
            TakeoffLine("Gate posts (end posts + stiffener)", posts.gatePosts.toDouble(), "", TakeoffGroup.POSTS),
            TakeoffLine("Blank posts (wall-hung gates)", qty(MaterialRole.BLANK_POST), "", TakeoffGroup.POSTS),
            TakeoffLine("Total posts", posts.totalPosts.toDouble(), "", TakeoffGroup.POSTS),
            TakeoffLine("Post caps", qty(MaterialRole.POST_CAP), "", TakeoffGroup.POSTS),

            TakeoffLine("Panels", qty(MaterialRole.PANEL), "", TakeoffGroup.PANELS),
            TakeoffLine("Pickets", qty(MaterialRole.WOOD_PICKET), "", TakeoffGroup.PANELS),
            TakeoffLine("Rails", qty(MaterialRole.WOOD_RAIL), "", TakeoffGroup.PANELS),
            TakeoffLine("Chain link fabric", qty(MaterialRole.CHAIN_FABRIC), "ft", TakeoffGroup.PANELS),

            TakeoffLine("Concrete", qty(MaterialRole.CONCRETE_BAG), "bags", TakeoffGroup.CONCRETE),

            TakeoffLine("Hinge sets", qty(MaterialRole.HINGE_SET), "", TakeoffGroup.GATES),
            TakeoffLine("Latches", qty(MaterialRole.LATCH), "", TakeoffGroup.GATES),
            TakeoffLine("Gate handles", qty(MaterialRole.HANDLE), "", TakeoffGroup.GATES),
            TakeoffLine("Gate braces", qty(MaterialRole.BRACE), "", TakeoffGroup.GATES),
            TakeoffLine("Econo stiffeners", qty(MaterialRole.STIFFENER), "", TakeoffGroup.GATES),
            TakeoffLine("Hole plugs", qty(MaterialRole.HOLE_PLUG), "", TakeoffGroup.GATES)
        ).filter { it.quantity > 0.0 }
    }

    /**
     * The arithmetic behind the post count, so the screen can answer the
     * question every contractor asks the first time they use this: "why does
     * it say thirty-three posts?"
     *
     * Reads the same [computePostCounts] the takeoff itself is built from
     * rather than restating the rules, because an explanation that can drift
     * from the number it explains is worse than no explanation -- it teaches
     * somebody a formula the product does not actually use.
     */
    fun explainPosts(
        run: FenceRun,
        pixelsPerFoot: Float,
        joinAdjustment: RunPostAdjustment? = null
    ): PostWorkings {
        val gates = FenceCodec.decodeGates(run.gatesEncoded)
        val geometry = resolveGeometry(run, pixelsPerFoot)
        val gateWidthTotal = gates.sumOf { it.widthFt.toDouble() }.toFloat()
        val netFt = (geometry.totalLinearFeet - gateWidthTotal).coerceAtLeast(0f)
        val c = computePostCounts(geometry, gates, run.postSpacingFt, netFt, joinAdjustment)
        return PostWorkings(
            fenceFeet = geometry.totalLinearFeet,
            gateFeet = gateWidthTotal,
            netFeet = netFt,
            spacingFt = run.postSpacingFt,
            bays = c.bays,
            openRun = c.endPosts > 0,
            gateCount = gates.size,
            standardEstimate = c.standardEstimate,
            linePosts = c.linePosts,
            cornerPosts = c.cornerPosts,
            endPosts = c.endPosts,
            gatePosts = c.gatePosts,
            totalPosts = c.totalPosts,
            postsSharedAtJoints = c.postsSharedAtJoints,
        )
    }

    /**
     * The whole job's join arithmetic, worked out ONCE, for the caller to hand
     * each run its own slice of.
     *
     * ONCE and over EVERY run, never a subset: a shared post has to be billed
     * to exactly one run (each run has its own lines, its own catalog choice
     * and its own colour), and which one is decided ACROSS runs -- the taller
     * fence, then the lower sort order, then the lower sync id. Called per run
     * it would see one candidate every time and every member would keep its
     * post, which is the bug this whole change removes.
     *
     * The geometry handed over is the SAME [resolveGeometry] the run's posts
     * are counted from, so typed footage arrives with no vertices and a closed
     * run with no ends -- the two cases [RunJoinArithmetic] refuses to take a
     * post off. Reusing it is what stops this and [computePostCounts]
     * disagreeing about whether a run has ends to give up.
     *
     * A job where no run carries a usable joint id gets
     * [JoinAdjustment.NONE] back before any geometry is read, so every run
     * prices exactly as it does today, to the cent.
     */
    fun joinAdjustments(runs: List<FenceRun>, pixelsPerFoot: Float): JoinAdjustment =
        RunJoinArithmetic.adjust(
            runs.map { run ->
                JoinableRun(
                    id = run.syncId,
                    geometry = resolveGeometry(run, pixelsPerFoot),
                    heightFt = joinHeightOf(run),
                    sortOrder = run.sortOrder,
                    isTeardown = run.isTeardown,
                    startJointId = usableJointId(run.startJoint),
                    endJointId = usableJointId(run.endJoint),
                )
            }
        )

    /**
     * The height that decides which run is billed the shared post: the taller
     * post is the one that has to be built, and a taller post can carry a
     * shorter panel but not the reverse (docs/JOINING_RUNS.md 2.4, Q1).
     *
     * NOT simply [FenceRun.panelHeightFt]: chain link keeps its height in
     * fabricHeightFt and split rail declares none. It is a different question
     * from the one [buildLineItems] asks when it picks a catalog row -- that
     * reads panelHeightFt even on a chain-link run, deliberately, because no
     * chain-link post row declares a height. This one is "which post is taller
     * in the ground".
     *
     * THE SAME RULE IS WRITTEN IN THREE PLACES and must stay identical, or the
     * gesture, the phone's price and the office's price can name three
     * different owners for one post: here, `SurveyViewModel.joinHeightOf`
     * (the attach gesture) and `joinHeightFt` in
     * supabase/functions/_shared/pricing/joins.ts (the office).
     * tests/a61-corner-post-pricing.test.mjs reads all three and fails if any
     * one of them drops a branch.
     */
    private fun joinHeightOf(run: FenceRun): Float = when (run.fenceType) {
        FenceType.CHAIN_LINK -> run.fabricHeightFt
        FenceType.SPLIT_RAIL -> 0f
        else -> run.panelHeightFt
    }

    /**
     * A stored joint id as the ENGINE should read it: the id, or blank for
     * "not joined".
     *
     * [FenceRun.startJoint] accepts any text, because fence_runs upserts are
     * batched and one row a constraint refuses fails the whole batch, so no
     * run of that company would sync at all. The readers judge instead, and
     * every one of them has to judge the same way: this is the engine's copy
     * of `SurveyViewModel.jointIdsOf` and of `readJointId` in joins.ts.
     *
     * Length first, because `UUID.fromString` accepts short non-canonical
     * forms ("1-1-1-1-1") and a joint id is only ever one this app generated
     * with `UUID.randomUUID().toString()`. Anything else reads as a free end,
     * which is the HIGHER post count and today's price -- bad data must never
     * make a job cheaper.
     */
    private fun usableJointId(stored: String): String =
        if (stored.length == 36 && runCatching { java.util.UUID.fromString(stored) }.isSuccess) stored else ""

    /**
     * @param joinAdjustment applied LAST, to the finished counts, and only
     *   when the owner has attached this run's end to another run's end. It is
     *   NOT fed into the estimate below: corner and end posts are CARVED OUT
     *   of one fixed pool (`standardPostEstimate`) and line posts are whatever
     *   is left, so lowering the end count before that runs hands the same
     *   number straight back as line posts and the total does not move at all.
     *   See [RunJoinArithmetic] and [RunPostAdjustment].
     */
    private fun computePostCounts(
        geometry: FenceGeometryResult,
        gates: List<GateMarker>,
        postSpacingFt: Float,
        netFt: Float,
        joinAdjustment: RunPostAdjustment? = null
    ): PostCounts {
        val gateCount = gates.size
        // Two end posts per gate, except LINE_TO_WALL, which ends the fence
        // line a SECOND time -- gateAreaEntries adds a third END_POST for
        // that mounting alone (its own two, plus the one where the rest of
        // the run terminates at the wall). This count is what POST_CAP is
        // priced off (totalPosts below), so it has to agree with what
        // gateAreaEntries actually builds, or a LINE_TO_WALL gate stands one
        // more post than it bills a cap for -- which it did, until now. WALL
        // and LINE both still take exactly two.
        // The `n: Int` is load-bearing, not style: a bare `if (..) 3 else 2`
        // leaves sumOf ambiguous between its Int and Long overloads and does
        // not compile.
        // A STANDALONE GATE STANDS ON TWO POSTS, WHATEVER THE MOUNTING SAYS.
        //
        // The comment above is right that this count must agree with what
        // gateAreaEntries builds -- and when the standalone rule landed there
        // (two blank posts for every mounting, 5 Oct 2026) this was left
        // saying 3 for LINE_TO_WALL. The fixture caught it the honest way: a
        // standalone LINE_TO_WALL gate billed THREE post caps while standing
        // on TWO posts.
        //
        // With no fence drawn there is no second place for the line to end,
        // so the third post has nothing to be.
        val hasFenceLine = geometry.totalLinearFeet > 0f
        val gatePosts = gates.sumOf { gate ->
            val n: Int = if (gate.mounting == GateMounting.LINE_TO_WALL && hasFenceLine) 3 else 2
            n
        }
        val cornerPosts = geometry.cornerCount
        val endPosts = geometry.endCount

        // A closed loop needs no closing post -- the last bay lands back on the
        // first one -- so only an open run gets the extra post on the end.
        val bays = if (postSpacingFt > 0f) ceil(netFt / postSpacingFt).roundToInt() else 0
        // Each gate splits the fence, and the two posts either side of the
        // opening ARE posts of that fence line -- they are not extra. Counting
        // the line as unbroken and then adding two posts per gate on top
        // bought one surplus post, one cap and a bag of concrete for every
        // gate on every job, which then rode back to the yard.
        //
        // Take one out of the run-length estimate per gate; gatePosts adds the
        // pair back below.
        val standardPostEstimate =
            if (bays == 0) 0
            else if (endPosts == 0) (bays - gateCount).coerceAtLeast(0)
            else (bays + 1 - gateCount).coerceAtLeast(0)

        // Gate posts are NOT subtracted here: the gate openings were already
        // taken out of netFt, so those posts sit outside this count. Subtracting
        // them was wiping out the line posts on short runs.
        val linePosts = (standardPostEstimate - cornerPosts - endPosts).coerceAtLeast(0)
        val totalPosts = linePosts + cornerPosts + endPosts + gatePosts

        val counts = PostCounts(
            linePosts, cornerPosts, endPosts, gatePosts,
            cornerPosts + endPosts + gatePosts, totalPosts,
            bays = bays, standardEstimate = standardPostEstimate
        )
        // Two sides the owner has JOINED share ONE post, so the second one --
        // and its cap, and its bag of concrete -- come off here, and the two
        // end posts that met become one CORNER post, a different catalog row.
        // Nothing to apply on a job with no joint, which is every job today.
        if (joinAdjustment == null || joinAdjustment.isZero) return counts
        val joinedLine = linePosts + joinAdjustment.linePostsDelta
        val joinedCorner = cornerPosts + joinAdjustment.cornerPostsDelta
        val joinedEnd = endPosts + joinAdjustment.endPostsDelta
        // Deliberately NOT clamped at zero, because joins.ts
        // applyJoinAdjustment is not either and a clamp that fires on one
        // engine and not the other is a price disagreement. It cannot fire:
        // a run only reaches a joint when RunJoinArithmetic.isLive finds
        // geometry.endCount >= 2, endPosts IS that end count, and a run has
        // two ends -- so the most it can give up is the two it has.
        return counts.copy(
            linePosts = joinedLine,
            cornerPosts = joinedCorner,
            endPosts = joinedEnd,
            terminalPosts = joinedCorner + joinedEnd + gatePosts,
            totalPosts = joinedLine + joinedCorner + joinedEnd + gatePosts,
            postsSharedAtJoints = -joinAdjustment.totalPostsDelta
        )
    }

    /** Vinyl, aluminum, ornamental iron: fence built from discrete panels. */
    private fun panelBasedEntries(run: FenceRun, netFt: Float, posts: PostCounts): List<QtyEntry> {
        val panelCount = if (run.panelWidthFt > 0f) ceil(netFt / run.panelWidthFt).roundToInt() else 0
        return listOf(
            QtyEntry(
                MaterialRole.PANEL, panelCount.toDouble(),
                preferCoversFt = run.panelWidthFt, coversLinearFt = netFt
            ),
            QtyEntry(MaterialRole.LINE_POST, posts.linePosts.toDouble()),
            QtyEntry(MaterialRole.CORNER_POST, posts.cornerPosts.toDouble()),
            QtyEntry(MaterialRole.END_POST, posts.endPosts.toDouble()),
            QtyEntry(MaterialRole.POST_CAP, posts.totalPosts.toDouble())
        )
    }

    /** Wood and composite: picket-and-rail construction between posts. */
    private fun picketAndRailEntries(run: FenceRun, netFt: Float, posts: PostCounts): List<QtyEntry> {
        val bays = if (run.postSpacingFt > 0f) ceil(netFt / run.postSpacingFt).roundToInt() else 0
        val railQty = bays * run.woodRailCount
        val picketPitchIn = (run.picketWidthIn + run.picketGapIn).coerceAtLeast(0.5f)
        val picketQty = ceil((netFt * 12f) / picketPitchIn).roundToInt()
        return listOf(
            QtyEntry(MaterialRole.WOOD_PICKET, picketQty.toDouble()),
            QtyEntry(MaterialRole.WOOD_RAIL, railQty.toDouble()),
            QtyEntry(MaterialRole.LINE_POST, posts.linePosts.toDouble()),
            QtyEntry(MaterialRole.CORNER_POST, posts.cornerPosts.toDouble()),
            QtyEntry(MaterialRole.END_POST, posts.endPosts.toDouble()),
            QtyEntry(MaterialRole.POST_CAP, posts.totalPosts.toDouble())
        )
    }

    /** Split-rail: just rails between posts, no pickets or caps. */
    private fun splitRailEntries(run: FenceRun, netFt: Float, posts: PostCounts): List<QtyEntry> {
        val bays = if (run.postSpacingFt > 0f) ceil(netFt / run.postSpacingFt).roundToInt() else 0
        val railQty = bays * run.splitRailCount
        return listOf(
            QtyEntry(MaterialRole.WOOD_RAIL, railQty.toDouble()),
            QtyEntry(MaterialRole.LINE_POST, posts.linePosts.toDouble()),
            QtyEntry(MaterialRole.CORNER_POST, posts.cornerPosts.toDouble()),
            QtyEntry(MaterialRole.END_POST, posts.endPosts.toDouble()),
        )
    }

    private fun chainLinkEntries(run: FenceRun, netFt: Float, posts: PostCounts): List<QtyEntry> {
        val bandsPerTerminalPost = ceil(run.fabricHeightFt).roundToInt().coerceAtLeast(1)
        val entries = mutableListOf(
            QtyEntry(MaterialRole.CHAIN_FABRIC, netFt.toDouble(), preferCoversFt = run.fabricHeightFt),
            QtyEntry(MaterialRole.LINE_POST, posts.linePosts.toDouble()),
            QtyEntry(MaterialRole.CORNER_POST, posts.cornerPosts.toDouble()),
            QtyEntry(MaterialRole.END_POST, posts.endPosts.toDouble()),
            QtyEntry(MaterialRole.POST_CAP, posts.totalPosts.toDouble()),
            QtyEntry(MaterialRole.TENSION_BAND, (posts.terminalPosts * bandsPerTerminalPost).toDouble()),
            QtyEntry(MaterialRole.BRACE_BAND, posts.terminalPosts.toDouble())
        )
        if (run.includeTopRail) {
            entries += QtyEntry(MaterialRole.TOP_RAIL, netFt.toDouble())
            entries += QtyEntry(MaterialRole.RAIL_END, posts.terminalPosts.toDouble())
        }
        if (run.includeTensionWire) entries += QtyEntry(MaterialRole.TENSION_WIRE, netFt.toDouble())
        if (run.includeBarbedWireArms) entries += QtyEntry(MaterialRole.BARBED_WIRE_ARM, posts.terminalPosts.toDouble())
        if (run.includePrivacySlats) entries += QtyEntry(MaterialRole.PRIVACY_SLAT, netFt.toDouble())
        return entries
    }

    /**
     * Every gate gets its hinges, latch and handle whatever the fence is made
     * of -- forgetting one of those is what sends a crew back to the supply
     * house mid-install. Anything the contractor doesn't want is removed on the
     * estimate and stays removed (see FenceRun.suppressedRoles).
     *
     * The BRACE is NOT one of the three. It used to be, for all seven types,
     * and six of them had nothing in any catalog to price it against -- the
     * role was reported unmatched and billed nothing. See [BRACED_GATE_TYPES]
     * for why the honest fix is to stop asking rather than to seed a white
     * vinyl extrusion for a chain-link gate. HINGE_SET, LATCH and HANDLE stay
     * universal because they genuinely are: a hinge, a catch and a pull fit
     * any leaf, and every fence type's starting catalog already prices a hinge
     * set and a latch.
     *
     * Order is load-bearing, not style. A line item's sort order follows the
     * order a role is first seen in these entries, so the branches below are
     * arranged to leave a VINYL gate's sequence byte for byte what it was --
     * panel, hinges, latch, handle, brace, (second brace, second hinge set),
     * trim. Only the non-vinyl types, which never had a brace line to begin
     * with, see anything change.
     */
    private fun gateEntries(fenceType: FenceType, gate: GateMarker, hasFenceLine: Boolean): List<QtyEntry> {
        val panelRole = if (fenceType in FRAME_KIT_GATE_TYPES) MaterialRole.GATE_FRAME_KIT else MaterialRole.GATE_PANEL
        val entries = mutableListOf(QtyEntry(panelRole, 1.0, preferCoversFt = gate.widthFt))
        entries += QtyEntry(MaterialRole.HINGE_SET, 1.0)
        entries += QtyEntry(MaterialRole.LATCH, 1.0)
        entries += QtyEntry(MaterialRole.HANDLE, 1.0)
        val braced = fenceType in BRACED_GATE_TYPES
        if (braced) entries += QtyEntry(MaterialRole.BRACE, 1.0)
        // A wide gate sags without a second brace and a heavier hinge set. The
        // heavier hinge set is wanted whatever the leaf is made of; the second
        // brace only where the first one was asked for at all.
        if (gate.widthFt >= 8f) {
            if (braced) entries += QtyEntry(MaterialRole.BRACE, 1.0)
            entries += QtyEntry(MaterialRole.HINGE_SET, 1.0)
        }
        if (fenceType == FenceType.VINYL) {
            entries += QtyEntry(MaterialRole.TRIM, 4.0)
        }
        entries += gateAreaEntries(fenceType, gate, hasFenceLine)
        return entries
    }

    /**
     * What the gate area itself is built from, which depends on where the gate
     * hangs rather than on the fence type.
     *
     * A VINYL gate takes one econo stiffener, and only a vinyl one does --
     * [STIFFENED_GATE_TYPES] has the reason, which is that the part is sized to
     * a 5x5 vinyl post and every other type's gate reaches site already rigid.
     * This asked for one on all seven types; the other six had nothing to price
     * it against, so the role was reported unmatched and billed nothing. The
     * posts, plugs and concrete below are unchanged and still depend only on
     * where the gate hangs.
     *
     * After that the three cases are genuinely different builds, and treating
     * them alike is a truck going back to the yard:
     *
     *  - **On the wall**: the hinge side bolts through a blank post. Four 5/8"
     *    holes are drilled through the leaf (through the stiffener, where there
     *    is one) into that post, so it needs plugs to close them -- which is
     *    why the plugs do NOT follow the stiffener out on a non-vinyl wall gate:
     *    the holes are in the post either way. Whether a 5/8" plug is the right
     *    part for a steel or timber post is a separate question nobody has put
     *    to him; HOLE_PLUG is seeded UNIVERSAL and has always billed on every
     *    type. Nothing is set in the ground, so **no concrete** --
     *    this is the case the old code got most wrong, since it charged concrete
     *    for every gate regardless. Takes a blank post plus the latch post.
     *  - **In the line**: two posts at the opening, set in concrete -- two bags.
     *  - **In the line with the fence carrying on to a wall**: the run
     *    terminates twice, so the gate's own two posts plus an end post, still
     *    in concrete.
     *
     * WHICH ROLE EACH OF THOSE POSTS IS, which decides which catalog row gets
     * billed. Counted the same either way -- [computePostCounts]' gatePosts is
     * untouched by this -- but a post standing at a gate opening is a GATE_POST
     * and is not the post where a fence line terminates:
     *
     *  - The two posts a gate hangs between (hinge side and latch side) are
     *    GATE_POST. Both stand at the opening; neither is an end of the fence.
     *    On a WALL gate only the latch side is one of these, because the hinge
     *    side is the BLANK_POST bolted to the wall.
     *  - The THIRD post on a LINE_TO_WALL is an END_POST, and genuinely so: it
     *    is where the rest of the run terminates against the wall, nowhere near
     *    the gate leaf. [GateMounting.LINE_TO_WALL]'s own wording is "the run
     *    terminates twice and needs a second end post". So LINE_TO_WALL is
     *    GATE_POST 2 + END_POST 1, not GATE_POST 3.
     *
     * This used to ask for END_POST for all of them, which meant nothing could
     * ever reach a GATE_POST row: the enum has the role, the catalog editor
     * offers it, the seed ships one per fence type, and the takeoff never asked.
     * The owner's own catalog has ten GATE_POST rows with prices typed into them
     * -- including both suppliers' blank posts, which are separate SKUs from
     * their end posts -- and no estimate could reach any of them. His gate post
     * and end post happen to cost the same today, so no money moved; the next
     * supplier to price them apart would have made every gated estimate wrong
     * with nothing on screen looking wrong.
     *
     * A catalog with no GATE_POST row must still get its gate posts. That
     * fallback is NOT here -- the takeoff cannot see the catalog (no catalog
     * argument, by design) and emitting both roles would bill four posts for a
     * two-post gate. It is a role preference in the line-item matcher, which
     * picks END_POST candidates when a GATE_POST entry has none. See the report:
     * that matcher is [buildLineItems] / line-items.ts buildLineItems and this
     * change MUST NOT ship before it.
     *
     * Gate posts are counted separately by [computePostCounts]; these are the
     * posts the gate area needs on top of that.
     */
    private fun gateAreaEntries(fenceType: FenceType, gate: GateMarker, hasFenceLine: Boolean): List<QtyEntry> {
        // The post opposite the hinge. His rule in full: an END POST where the
        // fence connects to it, a BLANK where nothing does. The first half was
        // implemented and the second half was not, so a standalone gate billed
        // the end of a fence that does not exist.
        val latchPost = if (hasFenceLine) MaterialRole.END_POST else MaterialRole.BLANK_POST
        val entries = mutableListOf<QtyEntry>()
        if (fenceType in STIFFENED_GATE_TYPES) entries += QtyEntry(MaterialRole.STIFFENER, 1.0)

        // A GATE STANDING ON ITS OWN: two blank posts, both in the ground.
        //
        // The owner's rule, 5 Oct 2026, asked in these words: "if a gate is a
        // stand alone and nothing else, it should be 2 blank post and the gate,
        // and the hardwares."
        //
        // "AND NOTHING ELSE" IS LOAD-BEARING, and this is the second attempt at
        // it. The first applied the rule to every mounting whenever no fence was
        // drawn, which broke the one case that was already right. A gate marked
        // WALL is bolted to a wall -- that IS something else. It keeps its own
        // branch below, where the hinge side is a blank post bolted through the
        // stiffener (hence HOLE_PLUG) and set in nothing (hence latch concrete
        // only, per the GateMounting.WALL doc). Treating it as standalone billed
        // a second bag of concrete for a post that is not in the ground and
        // dropped the four plugs that actually hold the gate up -- an overcharge
        // AND a missing part, which is the opposite of the bug being fixed.
        // ConcreteBagsTest caught it; the fixtures did not, because no fixture
        // covered a wall gate with no fence.
        //
        // With WALL excluded, the rule is about a gate attached to nothing: LINE
        // and LINE_TO_WALL both describe how a gate meets a FENCE, and with no
        // fence drawn there is nothing for either to describe. No post can be
        // the END of a line that is not there and neither carries one, so both
        // are simply posts in the ground with a gate between them -- and both
        // take their bag, which is why the concrete is the hinge+latch pair.
        //
        // Before this, LINE billed GATE + BLANK and LINE_TO_WALL billed
        // GATE + END + END -- three posts for a gate that stands on two.
        // The money barely moves on LINE, which was already two posts both
        // priced off the GATE_POST row (BLANK_POST has no catalog row anywhere
        // and falls back to it). LINE_TO_WALL stops billing a post, a cap and a
        // bag for something that does not exist.
        if (!hasFenceLine && gate.mounting != GateMounting.WALL) {
            entries += QtyEntry(MaterialRole.BLANK_POST, 2.0)
            entries += QtyEntry(MaterialRole.CONCRETE_BAG, GATE_HINGE_BAGS + GATE_LATCH_BAGS)
            return entries
        }

        when (gate.mounting) {
            GateMounting.WALL -> {
                entries += QtyEntry(MaterialRole.BLANK_POST, 1.0)
                // The latch side is an END POST, and the owner said so plainly on
                // 1 Oct 2026: "if it's against the wall, it's a blank post, and then
                // an end post for the fence line that the gate latches to."
                //
                // This read GATE_POST for a few hours earlier that day, on the
                // reasoning that a post at an opening is not the end of a fence. That
                // reasoning is wrong HERE and right for LINE below, and the difference
                // is what the fence does on the far side. On a WALL gate the hinge side
                // is the wall, so the fence line runs up to the latch post and STOPS:
                // that post IS the end of the line. On a LINE gate the fence carries on
                // past both posts, so neither is an end.
                //
                // END_POST only while a fence line EXISTS to end. `latchPost`
                // is END_POST when it does and BLANK_POST when it does not,
                // which is the owner's own wording applied to the wall case:
                // "an end post if it is connected to the fence, or a blank if
                // disconnected." So a wall gate with no fence drawn bills a
                // blank post on the hinge side and a blank on the latch side --
                // the two blank posts he asked for on 5 Oct 2026 -- while
                // keeping the plugs it is bolted up with and the single bag for
                // the one post that is actually in the ground. This was a
                // hardcoded END_POST, so a wall gate with no fence billed the
                // end of a line that was not there.
                entries += QtyEntry(latchPost, 1.0)
                entries += QtyEntry(MaterialRole.HOLE_PLUG, WALL_MOUNT_HOLES)
                // The hinge side is bolted to the wall and set in nothing. The
                // latch side is still a post in a hole and still takes its bag.
                entries += QtyEntry(MaterialRole.CONCRETE_BAG, GATE_LATCH_BAGS)
            }
            GateMounting.LINE -> {
                // THE GATE HANGS FROM ONE POST, NOT TWO.
                //
                // His rule, said twice and confirmed on 4 Oct 2026: the gate
                // and its econo stiffener belong to ONE post -- the hinge side,
                // which carries the whole weight. What the OTHER post is
                // depends on what the fence does there: an end post where the
                // fence connects to it, a blank where nothing does.
                //
                // This read GATE_POST 2, on the reasoning that both posts stand
                // at the opening so neither is the end of anything. That is a
                // fair description of the geometry and the wrong description of
                // what he buys: a gate post and an end post are different
                // catalog rows at different prices, so billing two of one kind
                // bills the wrong row once per gate on every job.
                //
                // The COUNT does not change -- two posts still go in the ground
                // -- so computePostCounts' gatePosts, POST_CAP and the concrete
                // are all untouched. Only the row each post is billed from.
                entries += QtyEntry(MaterialRole.GATE_POST, 1.0)
                entries += QtyEntry(latchPost, 1.0)
                entries += QtyEntry(MaterialRole.CONCRETE_BAG, GATE_HINGE_BAGS + GATE_LATCH_BAGS)
            }
            GateMounting.LINE_TO_WALL -> {
                // The gate's hinge post and its latch post, plus the one where
                // the rest of the run terminates at the wall. Three posts, as
                // before -- computePostCounts' gatePosts counts all three, so
                // POST_CAP still matches what stands in the ground -- but the
                // latch side is now an END_POST for the same reason it is on a
                // LINE gate: the fence connects to it.
                entries += QtyEntry(MaterialRole.GATE_POST, 1.0)
                entries += QtyEntry(MaterialRole.END_POST, 2.0)
                entries += QtyEntry(
                    MaterialRole.CONCRETE_BAG,
                    GATE_HINGE_BAGS + GATE_LATCH_BAGS + GATE_LATCH_BAGS
                )
            }
        }
        return entries
    }

    /** Holes drilled through the stiffener into the blank post, each needing a plug. */
    private const val WALL_MOUNT_HOLES = 4.0

    /**
     * Concrete for the two posts a gate hangs between.
     *
     * Only the hinge post carries the gate's weight and its swing, so only
     * that one is dug deep and wide enough to want the extra half bag. The
     * latch side is holding a catch, not a gate, and takes an ordinary post's
     * bag whether it stands in the fence line or on its own.
     *
     * This was a flat two bags for each, which quietly over-ordered half a bag
     * on every gate. The total is rounded up to whole bags by [wholeBags].
     */
    private const val GATE_HINGE_BAGS = 1.5
    private const val GATE_LATCH_BAGS = 1.0

    /**
     * Builds priced, editable line items from suggested quantities and the
     * current material catalog, scoped to the run's fence type. Prefers the
     * run's chosen color/finish and the job's preferred manufacturer when
     * more than one catalog item matches a role; falls back gracefully when
     * a role has no matching catalog item at all.
     */
    /**
     * A stable uuid for one run's line of a given material role.
     *
     * nameUUIDFromBytes is a content hash, so the same run and role always
     * produce the same uuid on every device and every regenerate -- which is
     * what makes the cloud upsert replace the row rather than add another.
     */
    private fun deterministicSyncId(runSyncId: String, role: String): String =
        java.util.UUID.nameUUIDFromBytes("fenceflow-line:$runSyncId:$role".toByteArray()).toString()

    /**
     * The same, for a role that legitimately appears more than once on a run.
     *
     * Entries are merged by role AND width, so a run with a 4 ft gate and a 6 ft
     * gate keeps two GATE_PANEL lines -- and both were being handed the same
     * id, because the id was built from the role alone. Two rows with one
     * primary key do not survive an upsert: the estimate push for that job
     * failed as a batch, so NONE of its line items reached the cloud.
     *
     * Only used when a role really does repeat, so every run that was already
     * syncing keeps the ids it has.
     */
    private fun deterministicSyncId(runSyncId: String, role: String, coversFt: Float?): String =
        java.util.UUID.nameUUIDFromBytes(
            "fenceflow-line:$runSyncId:$role:${coversFt ?: 0f}".toByteArray()
        ).toString()

    data class BuiltItems(
        val items: List<EstimateLineItem>,
        /** Roles the takeoff called for that the catalog has nothing priced for. */
        val unmatchedRoles: List<MaterialRole>,
        /** Matched items whose catalog price is still zero, so the estimate would read $0. */
        val zeroPricedNames: List<String>
    )

    /**
     * The role whose catalog rows a line may be priced off when the catalog
     * holds NOTHING for the role the takeoff asked for.
     *
     * A fallback belongs HERE and not in the takeoff. The takeoff says what the
     * build needs; this is where a need is turned into a row somebody sells.
     * Moving it into the takeoff would change what is ASKED for, and on a wall
     * gate that loses the one distinction that matters -- the hinge side is an
     * undrilled post bolted through the wall, the latch side is a post set in
     * concrete. The counts, the concrete and the hole plugs all follow from
     * keeping them apart.
     *
     * BLANK_POST -> GATE_POST, the owner's decision of 1 Oct 2026. BLANK_POST
     * has never existed in ANY catalog: not in [SeedData], not in
     * supabase_r20's seed, not in the office page's starting list, and not in a
     * single company's rows (read-only SELECT across every company, 1 Oct 2026:
     * zero). [gateAreaEntries] asks for one on every WALL-mounted gate, so that
     * post has been dropped from every wall-gate estimate ever written -- the
     * role landed in [BuiltItems.unmatchedRoles] and no line appeared. His
     * GATE_POST rows are the right rows to bill it against: two of his four
     * vinyl ones are literally named "Blank Post" ("5x5 Co-Ex Utility Post
     * White 8.5' - Blank" at $16.56, "5x5x102 HFS Blank Post White 6' Privacy"
     * at $19.00), and he has a GATE_POST row for all seven fence types.
     *
     * THIS RAISES PRICES, and that is the point: a wall gate now bills a post
     * it used to omit. On his catalog a 6 ft white vinyl wall gate goes up
     * $17.72 ($16.56 plus 7% tax, before markup).
     *
     * PREFERENCE, NOT REPLACEMENT. A company that DOES price a BLANK_POST row
     * gets its own row; this is consulted only when the real role matches
     * nothing.
     *
     * IT DOES NOT CHAIN, and nothing here pretends otherwise: a catalog with no
     * BLANK_POST row AND no GATE_POST row still reports BLANK_POST unmatched
     * and bills nothing for it. The matching gap on the other side -- a
     * GATE_POST entry on a catalog with no GATE_POST row, which loses its gate
     * posts outright since 2026.10.4 -- is NOT wired here. The entry would be
     * `MaterialRole.GATE_POST to MaterialRole.END_POST`; it is the owner's
     * call, not a silent one, and tests/a53-gate-post-role.test.mjs block 5
     * pins today's broken state so it cannot be forgotten.
     *
     * WHAT THE QUOTE SAYS. The line keeps `role = BLANK_POST` and takes its
     * description from the row actually chosen, so a quote never claims to have
     * billed a product he does not stock -- it names the gate post it really
     * billed. [BuiltItems.unmatchedRoles] keeps its exact meaning, "nothing was
     * billed for this role", so BLANK_POST drops out of it once a GATE_POST row
     * carries the line. The gap that remains genuine -- neither row exists -- is
     * still reported, under BLANK_POST's own name. What is NOT reported anywhere
     * is that a substitution happened at all; saying so would need a new field
     * on the pricing contract, which is a wider change than this one.
     *
     * The server port is `PRICING_FALLBACK_ROLE` in line-items.ts, same role,
     * same single entry, consulted at the same point.
     */
    private val PRICING_FALLBACK_ROLE: Map<MaterialRole, MaterialRole> = mapOf(
        MaterialRole.BLANK_POST to MaterialRole.GATE_POST
    )

    fun buildLineItems(
        jobId: Long,
        fenceRunId: Long,
        run: FenceRun,
        suggestions: EstimateSuggestions,
        catalog: List<MaterialItem>,
        preferredManufacturerId: Long?
    ): BuiltItems {
        val candidatesByRole = catalog
            .filter { it.isActive && (it.fenceType == run.fenceType || it.fenceType == FenceType.UNIVERSAL) }
            .groupBy { it.role }

        val items = mutableListOf<EstimateLineItem>()
        val unmatched = mutableListOf<MaterialRole>()
        val zeroPriced = mutableListOf<String>()
        var order = 0

        // The same role can be suggested more than once (two braces on a wide
        // gate, hinges for each of several gates). Merge before pricing so the
        // estimate shows one line with the full count instead of duplicates.
        val mergedEntries = suggestions.entries
            .filter { it.quantity > 0.0 }
            .groupBy { it.role to it.preferCoversFt }
            .map { (key, group) ->
                QtyEntry(
                    key.first,
                    group.sumOf { it.quantity },
                    key.second,
                    group.mapNotNull { it.coversLinearFt }.takeIf { it.isNotEmpty() }?.sum()
                )
            }

        // How many lines each role ends up with, so the id only needs
        // qualifying where it would otherwise collide.
        val entriesPerRole = mergedEntries.groupingBy { it.role }.eachCount()

        mergedEntries.forEach { entry ->
            var candidates = candidatesByRole[entry.role].orEmpty()
            // Nothing priced for the role itself: price it off the fallback
            // role's rows if there is one ([PRICING_FALLBACK_ROLE]). Here,
            // BEFORE the colour, manufacturer and height filters, so a borrowed
            // row is then chosen by exactly the rules the real role's rows would
            // have been chosen by -- the height filter below reads entry.role,
            // which is unchanged, and BLANK_POST and GATE_POST are both in its
            // list, so a borrowed gate post is still held to the run's height.
            if (candidates.isEmpty()) {
                val fallbackRole = PRICING_FALLBACK_ROLE[entry.role]
                if (fallbackRole != null) candidates = candidatesByRole[fallbackRole].orEmpty()
            }
            if (candidates.isEmpty()) {
                unmatched += entry.role
                return@forEach
            }

            if (run.colorOrFinish.isNotBlank()) {
                val colorMatches = candidates.filter { it.colorOrFinish.equals(run.colorOrFinish, ignoreCase = true) }
                if (colorMatches.isNotEmpty()) candidates = colorMatches
            }

            if (preferredManufacturerId != null) {
                val manufacturerMatches = candidates.filter { it.manufacturerId == preferredManufacturerId }
                if (manufacturerMatches.isNotEmpty()) candidates = manufacturerMatches
            }

            // Height, for the roles whose row has to physically suit a fence this tall:
            // the two panel roles, and the POSTS. Width alone cannot tell a 4 ft high
            // panel from a 6 ft high one when both are 6 ft wide, and the cheaper one
            // then won every quote of the dearer height -- the starting catalog's
            // ornamental iron, short by $40 a panel.
            //
            // POSTS are here because the same choice on a post is not a price, it is a
            // fence that falls over. A post has no width, so it was picked by price
            // alone, and on a 72 ft run six feet high the cheapest LINE_POST in the
            // owner's catalog was "5x5 Utility Post White 6' (Flori, 4ft run)" at
            // $13.18 -- the post the supplier quotes for a FOUR foot fence, six feet
            // long, so nothing of it is in the ground. The right row is the 8.5 ft
            // Co-Ex at $16.56. It only became reachable the day both suppliers' posts
            // were loaded: before that there was one post per role and nothing to
            // choose wrongly between.
            //
            // On a POST, heightFt is THE FENCE HEIGHT THE POST IS FOR, not the post's
            // own length. That is the one reading that lets a single comparison serve
            // panels and posts alike -- the run says "I am 6 ft" and every row that
            // says 6 is a candidate -- and the post's physical length stays in its
            // name, where no engine reads it. See MaterialItem.heightFt.
            //
            // A row says how tall it is in heightFt, a column of its own; the NAME is
            // never read for it. The same "narrow only if something matches" shape as
            // colour and manufacturer, with one difference that matters: it narrows
            // WITHIN a width. Height is what separates rows that tie on width; it must
            // not change which widths are in the running. Dropping every row that does
            // not declare the run's height hid the other widths of a role -- a 4 ft and a
            // 6 ft gate beside a 5 ft one that declared its height -- and moved 3 of the
            // 85 recorded quotes that have nothing to do with height, one of them down.
            // So a row is set aside only when another row of ITS OWN width declares the
            // run's height and it does not. When no row declares the run's height -- which
            // is every catalog that declares no height at all -- nothing is set aside and
            // the choice below is exactly what it always was, and a row that does declare
            // it never sets itself aside, so the list cannot be emptied.
            //
            // WHY PER-WIDTH IS STILL RIGHT FOR POSTS, which have no width at all:
            // coversFt is null on every post row, and `==` on two null `Float?` is true
            // here (it compiles to Intrinsics.areEqual, which answers true for null
            // against null) exactly as `null === null` is true in line-items.ts. So
            // every post of a role falls into ONE width group and the rule narrows the
            // whole list -- which is what posts want, since there are no other widths of
            // a post to hide. Had null not equalled null the rule would have silently
            // done nothing for posts, and the phone and the office would still have
            // bought different posts. The two sides agree on this case; where they do
            // NOT agree is a heightFt or coversFt of NaN or -0.0, which this compares
            // with Float.equals (NaN equals itself, -0.0 differs from 0.0) and
            // line-items.ts compares with IEEE `===` (the reverse on both). No catalog
            // can reach that -- a fence is not NaN feet tall -- and null, the only value
            // that matters here, behaves identically.
            //
            // Not for any other role. CHAIN_FABRIC keeps its height in coversFt, so it
            // is already chosen by it; POST_CAP, rails, bands, concrete and gate hardware
            // are still chosen by price alone, and no row of those roles declares a height
            // in the starting catalog or in the owner's (checked 1 Oct 2026) -- see
            // tests/a51-post-height-choice.test.mjs, which pins that list. A run's height here is
            // always panelHeightFt, including on a chain-link run, whose real height is
            // fabricHeightFt -- no chain-link post declares a height today, so the rule
            // is inert there, and teaching it that second column is a decision for the
            // owner, not a silent one.
            if (
                entry.role == MaterialRole.PANEL || entry.role == MaterialRole.GATE_PANEL ||
                entry.role == MaterialRole.LINE_POST || entry.role == MaterialRole.END_POST ||
                entry.role == MaterialRole.CORNER_POST || entry.role == MaterialRole.GATE_POST ||
                entry.role == MaterialRole.BLANK_POST
            ) {
                val current = candidates
                candidates = current.filter { c ->
                    c.heightFt == run.panelHeightFt ||
                        current.none { d -> d.coversFt == c.coversFt && d.heightFt == run.panelHeightFt }
                }
            }

            val chosen = if (entry.preferCoversFt != null) {
                // Nearest width, but among items that have a price if any do.
                // The other branch has always preferred a priced item; this one
                // did not, so a $0.00 placeholder that happened to be the
                // closest width could carry an entire panel line and quietly
                // zero out the biggest number on the estimate.
                val priced = candidates.filter { it.unitPrice > 0.0 }
                val pool = priced.ifEmpty { candidates }
                // Two items at the same distance must resolve the same way
                // every single time -- minByOrNull alone keeps whichever came
                // first in an unordered list, which is a coin toss dressed as
                // a choice. Distance, then price, then sync id: total order.
                // The sync id, not the Room id -- the Room id is minted per
                // phone, so two phones (and the server) would break the same
                // tie two ways.
                pool.minWithOrNull(
                    compareBy(
                        { kotlin.math.abs((it.coversFt ?: entry.preferCoversFt) - entry.preferCoversFt) },
                        { it.unitPrice },
                        { it.syncId }
                    )
                )
            } else {
                // Prefer something actually priced. Picking the first match blind
                // is how a $0.00 placeholder ended up representing a whole role
                // and quietly zeroed out the materials total.
                // Same rule: never let list position decide. Priced beats
                // unpriced, then cheapest, then lowest sync id (see above).
                candidates.sortedWith(
                    compareBy({ it.unitPrice <= 0.0 }, { it.unitPrice }, { it.syncId })
                ).firstOrNull()
            } ?: run {
                unmatched += entry.role
                return@forEach
            }
            if (chosen.unitPrice <= 0.0) zeroPriced += chosen.name

            // How many, against what the chosen item actually covers.
            //
            // The count came from the width the RUN is spec'd for, and the item
            // was then picked separately as the nearest available width -- with
            // nothing reconciling the two. Spec a 100 ft run at 8 ft panels
            // when the catalog only stocks that colour at 6 ft, and the takeoff
            // ordered thirteen panels covering 78 ft: 22 ft of fence with
            // nothing to put in it, found on the day. It goes the other way
            // too -- a 4 ft spec against a 6 ft item ordered fifty percent more
            // panel than the run needs.
            //
            // Only for PANEL, which is bought by the foot of fence. A gate is
            // not: a 5 ft opening takes one 4 ft-ish gate, never two.
            var quantity = entry.quantity
            val preferred = entry.preferCoversFt
            val feetToCover = entry.coversLinearFt
            if (entry.role == MaterialRole.PANEL && preferred != null && feetToCover != null) {
                val actualCoverage = chosen.coversFt ?: preferred
                if (actualCoverage > 0f && kotlin.math.abs(actualCoverage - preferred) > 0.01f) {
                    quantity = ceil(feetToCover.toDouble() / actualCoverage.toDouble())
                }
            }

            items.add(
                EstimateLineItem(
                    // Same run + same role always lands on the same sync id, so
                    // regenerating overwrites the cloud row instead of adding a
                    // second one next to it. Roles are unique per run after the
                    // merge above, so this can't collide.
                    //
                    // It has to BE a uuid, not merely be unique: the cloud column
                    // is typed uuid, and "<uuid>:PANEL" was rejected outright --
                    // which broke syncing estimates entirely. Hashing the same
                    // two inputs into a uuid keeps the determinism and the type.
                    //
                    // Roles are NOT always unique per run, whatever the old note
                    // here claimed: the merge above groups by role and width, so
                    // two gates of different widths keep two GATE_PANEL lines.
                    // Those get the width folded in as well.
                    syncId = if ((entriesPerRole[entry.role] ?: 1) > 1) {
                        deterministicSyncId(run.syncId, entry.role.name, entry.preferCoversFt)
                    } else {
                        deterministicSyncId(run.syncId, entry.role.name)
                    },
                    jobId = jobId,
                    fenceRunId = fenceRunId,
                    sortOrder = order++,
                    description = chosen.name,
                    quantity = quantity,
                    unit = chosen.unit,
                    unitPrice = chosen.unitPrice,
                    taxable = chosen.taxable,
                    role = entry.role,
                    isAutoGenerated = true
                )
            )
        }

        return BuiltItems(items, unmatched.distinct(), zeroPriced.distinct())
    }

    data class Totals(
        val materialsSubtotal: Double,
        val taxableSubtotal: Double,
        val tax: Double,
        val laborCost: Double,
        val teardownCost: Double,
        val markupAmount: Double,
        val discountAmount: Double,
        val grandTotal: Double,
        /** Approved extra work, already included in [grandTotal]. */
        val changeOrderCost: Double = 0.0,
        val changeOrderFeet: Double = 0.0,
        /** Gate openings charged by the foot, already included in [grandTotal]. */
        val gateCharge: Double = 0.0,
        val gateFeet: Double = 0.0,
        /** Hauling the old fence away, already included in [grandTotal]. */
        val trashHaulFee: Double = 0.0,
        /**
         * Fence billed, including change-order feet. Carried on the totals so
         * that "what the customer signed for" can be recorded as one thing --
         * a price and a length -- rather than re-derived from the geometry
         * somewhere else and drifting from what the estimate actually said.
         */
        val billableLinearFeet: Float = 0f,
        /**
         * The base the markup is taken on: materials + tax + labour + teardown +
         * change orders + gates. Carried here so a screen can SHOW a subtotal
         * instead of adding the parts up again -- the estimate screen did that
         * once and left tax out, so 20% markup read as 21.4% of the subtotal
         * beside it and looked like a bug in the markup.
         *
         * The server engine has carried this all along (totals.ts preMarkup);
         * Kotlin simply never exposed it, which is why check-parity.mjs could
         * not have caught the difference.
         *
         * LAST in the parameter list on purpose: every positional Totals(...)
         * call in the app and the tests passes grandTotal eighth, and they are
         * all Double, so a field inserted ahead of it would be accepted
         * silently by any call that happened to pass enough arguments.
         */
        val preMarkup: Double = 0.0
    ) {
        /**
         * Whether a tax rate is actually set on this job.
         *
         * Asked so a screen can tell "no tax here" from "tax on the wrong
         * base". At a rate of zero the taxable subtotal is meaningless and a
         * note about it would be noise; at any other rate the base is worth
         * showing when it is not all the materials.
         */
        fun taxRateIsSet(job: Job?): Boolean = (job?.taxRatePercent ?: 0.0) > 0.0
    }

    /**
     * @param changeOrders extra work agreed after the original quote. Their feet
     *   are billed at the same labor rate as the rest of the job, and their cost
     *   is added on top -- a change order that doesn't move the total is just a
     *   note, and the whole point of one is that the customer owes more.
     */
    /**
     * @param runs used to price gate openings. A gate is charged by the foot of
     *   opening, not at the fence rate -- hanging and squaring one is the
     *   slowest work on the job per foot, and pricing it like fence line loses
     *   money on every gate.
     */
    /** The old fence's own footage, for the teardown charge. Same fallback -- and same photo refusal -- as [linearFeet]. */
    fun teardownLinearFeet(job: Job, runs: List<FenceRun>): Float =
        runs.filter { it.isTeardown }.sumOf { run -> footageOf(job, run) }.toFloat()

    fun computeTotals(
        job: Job,
        lineItems: List<EstimateLineItem>,
        totalLinearFeet: Float,
        changeOrders: List<ChangeOrder> = emptyList(),
        runs: List<FenceRun> = emptyList()
    ): Totals {
        val materialsSubtotal = lineItems.sumOf { it.lineTotal }
        val taxableSubtotal = lineItems.filter { it.taxable }.sumOf { it.lineTotal }
        val tax = taxableSubtotal * (job.taxRatePercent / 100.0)

        val changeOrderCost = changeOrders.sumOf { it.additionalCost }
        val changeOrderFeet = changeOrders.sumOf { it.additionalFeet }
        val billableFeet = totalLinearFeet + changeOrderFeet

        // Gate openings, charged by the foot of opening. The gate width was
        // already removed from the fence footage by the takeoff, so this adds
        // rather than double-charges.
        //
        // A run this job cannot honestly measure -- an uncalibrated survey
        // photo, the same test [TakeoffRefresher.blockedByUncalibratedPhoto]
        // already applies to that run's fence footage above (via
        // [linearFeet]/[footageOf]) -- contributes no gate feet either. A
        // gate's width is typed directly in feet and needs no scale, so
        // nothing here stopped it from being billed even while the fence
        // line it opens onto correctly billed zero: two 6 ft gates at
        // $35/ft with 25% markup billed $525 the office (which blanks a run
        // it cannot measure entirely -- gates included, see load.ts's
        // neutralizeUnscaledRun) had already zeroed out, and the gap SCALES
        // with the gate rate rather than staying a rounding error. Refusing
        // the run's gates along with its fence line is the one answer that
        // cannot read as a second, quieter version of the zero-quote bug
        // this same uncalibrated-photo case exists to fix.
        val gateFeet = runs.sumOf { run ->
            if (TakeoffRefresher.blockedByUncalibratedPhoto(job, run)) 0.0
            else FenceCodec.decodeGates(run.gatesEncoded).sumOf { it.widthFt.toDouble() }
        }
        val gateCharge = gateFeet * job.gateRatePerFt

        // Labour is charged on the fence that is built. The gate openings are
        // charged by the gate rate below, so they come out of the labour
        // footage here -- otherwise a 4 ft gate was billed twice: once as
        // fence labour, once as a gate.
        val laborFeet = (billableFeet - gateFeet).coerceAtLeast(0.0)
        // Floor on labour alone, applied before markup/tax/discount like the
        // whole-job floor below -- so markup earns on the floored labour exactly
        // as it would on real labour. 0 is off.
        //
        // Guarded on > 0 rather than relying on maxOf(x, 0.0) being a no-op,
        // because it is not one: laborFeet is clamped at zero but laborFlatFee
        // is NOT, and a negative flat fee is how an estimator knocks money off a
        // quote. maxOf(-150.0, 0.0) is 0.0, so an untouched company's credit
        // would silently vanish and its quote would go UP by the size of it.
        // totals.ts is guarded the same way; a difference of a cent between the
        // two is a phone and a server quoting one job twice.
        val rawLabor = job.laborFlatFee + (job.laborRatePerFt * laborFeet)
        val laborCost =
            if (job.minimumLaborCharge > 0.0) maxOf(rawLabor, job.minimumLaborCharge) else rawLabor
        val trashHaul = if (job.teardownEnabled) job.trashHaulFee else 0.0
        // The typed teardown length when there is one, because the old fence
        // does not always match the new one. Zero means what every job meant
        // before the field existed: priced along the new fence.
        // Typed footage first; then the drawn old fence itself, which is the
        // whole point of drawing it; the new fence's footage only as the last
        // guess when nothing better exists.
        val drawnTeardownFt = teardownLinearFeet(job, runs).toDouble()
        val teardownFt = when {
            job.teardownFeet > 0.0 -> job.teardownFeet
            drawnTeardownFt > 0.0 -> drawnTeardownFt
            else -> billableFeet.toDouble()
        }
        val teardownCost =
            if (job.teardownEnabled) job.teardownFlatFee + job.teardownRatePerFt * teardownFt + trashHaul
            else 0.0

        val preMarkup = materialsSubtotal + tax + laborCost + teardownCost + changeOrderCost + gateCharge
        val markupAmount = preMarkup * (job.markupPercent / 100.0)
        val afterMarkup = preMarkup + markupAmount

        val discountAmount = afterMarkup * (job.discountPercent / 100.0)
        val afterDiscount = afterMarkup - discountAmount

        // EXACT, to the cent -- not rounded up. This was ceil(.. / 10) * 10 until
        // PRICING_ENGINE_VERSION 2026.10.1 (the owner's decision, 1 Oct 2026,
        // taken knowing the cost: a quote of $15,991.06 kept coming in "less
        // than needed" once material prices moved a cent, and rounding up was
        // the cushion for it).
        //
        // The ONE place a total is rounded, and to two places, not zero: the
        // sum above is a chain of double multiplications, so a job that is
        // exactly $2,200 can arrive as 2200.0000000000005, and without the
        // cents rounding that dust would be stored, signed, billed and shown.
        // Only the final figure is rounded -- tax, markup and the other parts
        // stay unrounded, so the sum is not rounded twice.
        //
        // The minimum job charge is applied BEFORE the rounding, as it always
        // was, so a job that falls to the minimum reads exactly the minimum:
        // maxOf picks the charge itself and rounding a number already on cents
        // leaves it alone. totals.ts does the same (roundToCents).
        val grandTotal = roundToCents(maxOf(afterDiscount, job.minimumJobCharge))

        return Totals(
            materialsSubtotal, taxableSubtotal, tax, laborCost, teardownCost,
            markupAmount, discountAmount, grandTotal, changeOrderCost, changeOrderFeet,
            gateCharge, gateFeet, trashHaul, billableFeet.toFloat(), preMarkup
        )
    }

    private val POST_ROLES = setOf(MaterialRole.LINE_POST, MaterialRole.CORNER_POST, MaterialRole.END_POST, MaterialRole.GATE_POST)
    private val GATE_HARDWARE_ROLES = setOf(MaterialRole.HINGE_SET, MaterialRole.LATCH, MaterialRole.GATE_PANEL, MaterialRole.GATE_FRAME_KIT)
    private const val LOW_KEPT_THRESHOLD_PERCENT = 35.0

    /**
     * Whether this job's price reads as zero (or near it) for a reason a
     * contractor cannot see anywhere on the screen: real work is drawn --
     * a fence line, or a gate -- on a survey PHOTO nobody has calibrated, so
     * [linearFeet] and [computeTotals]'s own gate feet (both applying
     * [TakeoffRefresher.blockedByUncalibratedPhoto]) correctly refuse to
     * guess its length rather than price off a made-up scale.
     * That refusal is the right arithmetic -- guessing would be worse, a
     * real-looking number nobody can trust -- but nothing before this said
     * WHY the total reads zero, and there was no guard anywhere stopping
     * that zero from being sent to a customer as if it were a real quote.
     *
     * Deliberately false for a run that is blocked for the identical reason
     * but has nothing drawn on it at all: a brand-new job on an uploaded
     * photo, not yet calibrated and not yet drawn, is not a mistake to warn
     * about -- it is every job's very first moment, and nagging it is
     * exactly the kind of warning that teaches people to stop reading
     * warnings. What tells the two apart is content, not calibration state:
     * at least one point placed on the drawing, or at least one gate.
     *
     * A run with typed footage ([FenceRun.usesManualFeet]) is never blocked
     * in the first place -- it needs no scale -- so it never reaches this
     * check at all.
     */
    fun hasUnmeasurablePhotoWork(job: Job, runs: List<FenceRun>): Boolean =
        runs.any { run ->
            TakeoffRefresher.blockedByUncalibratedPhoto(job, run) && runHasDrawnWork(run)
        }

    /**
     * Whether a run has something on it to price: at least two points placed
     * on the drawing, or at least one gate.
     *
     * The ONE definition of "something is drawn", shared by
     * [hasUnmeasurablePhotoWork] and [hasFenceWithNoMaterials]. It is the test
     * that tells a job with real work on it from a job that is simply new, and
     * two copies of it would eventually disagree about which is which -- one
     * warning would then nag the empty job the other correctly leaves alone.
     *
     * Typed footage is not part of it, because typed footage is not drawn.
     * [hasUnmeasurablePhotoWork] has no use for it (a run with a typed length
     * is never blocked for want of a scale), and [hasFenceWithNoMaterials],
     * which does, adds it on its own.
     */
    private fun runHasDrawnWork(run: FenceRun): Boolean =
        FenceCodec.decodePoints(run.pointsEncoded).size >= 2 ||
            FenceCodec.decodeGates(run.gatesEncoded).isNotEmpty()

    /**
     * Whether this job is a fence to build with nothing priced for materials:
     * the total is labour (plus any gate, teardown and change-order charges)
     * and no posts, panels or concrete, and it reads like a finished quote.
     *
     * Every other materials check on the estimate is switched off by
     * materials being zero -- [estimateWarnings] only says the prices are
     * provisional, the deposit is short of the materials, or the margin is
     * thin when there ARE materials, and a job that keeps 100% of its price
     * after "materials" never trips the margin test. So a job with no
     * materials at all was the one job on which the estimate screen said
     * nothing whatever, and it is the commonest state of a company that has
     * not built a catalog: at the phone's default rates 100 ft of vinyl quotes
     * $800 where the same job priced from the starting list is $2,120,
     * confidently, and once the customer accepts, the figure they accepted is
     * what they owe ([JobMoney.anchoredTotal]).
     *
     * A run counts when it is fence to BUILD -- not the old fence being taken
     * out ([FenceRun.isTeardown], which legitimately needs no materials) --
     * and can be measured, i.e. it is not [TakeoffRefresher.blockedByUncalibratedPhoto]
     * (that job's zero is explained by [hasUnmeasurablePhotoWork], and "copy
     * the starting list" would be the wrong advice for it). Of those, it
     * counts if it has typed footage or something drawn ([runHasDrawnWork],
     * the same test the photo warning uses), so a brand-new job with nothing
     * on it is left alone.
     *
     * Materials are read from [totals], the same figure the rest of
     * [estimateWarnings] reads, so a hand-entered lump-sum line counts as
     * materials and silences this.
     *
     * It locks nothing by itself. [estimateWarnings] shows it as a warning.
     * Whether the send buttons should also refuse is the screen's call, the way
     * its zeroQuoteBlocked already refuses a $0 quote from
     * [hasUnmeasurablePhotoWork].
     */
    fun hasFenceWithNoMaterials(job: Job, runs: List<FenceRun>, totals: Totals): Boolean =
        totals.materialsSubtotal <= 0.005 &&
            runs.any { run ->
                !run.isTeardown &&
                    !TakeoffRefresher.blockedByUncalibratedPhoto(job, run) &&
                    (run.usesManualFeet || runHasDrawnWork(run))
            }

    /**
     * Rule-based sanity checks over the current estimate -- no AI needed,
     * just flags the mistakes that are easy to miss when quoting fast.
     *
     * Returns structured warnings (a string resource plus its positional
     * arguments) so the screen can render them in the device language; money
     * is pre-formatted here so the figures read exactly as they always did.
     *
     * @param changeOrders the job's change orders, so what is still owed is
     *   measured against the price the customer accepted plus extra work
     *   signed since ([JobMoney.billableTotal]) -- the figure the job screen,
     *   the quote page and the payment link bill -- rather than the live
     *   recompute, which moves after acceptance.
     */
    fun estimateWarnings(
        job: Job,
        runs: List<FenceRun>,
        lineItems: List<EstimateLineItem>,
        totals: Totals,
        changeOrders: List<ChangeOrder> = emptyList()
    ): List<EstimateWarning> {
        val warnings = mutableListOf<EstimateWarning>()
        fun money(x: Double): String = "%.2f".format(java.util.Locale.US, x)

        // A zero total that is really "nothing measurable" rather than
        // "nothing drawn" ([hasUnmeasurablePhotoWork]). Checked first and
        // against the raw total, not a share or a rate, because every other
        // warning below is about a number on a real quote reading wrong --
        // this one is about a quote that is not real yet at all. Reuses the
        // Survey screen's own scale prompt rather than a near-duplicate:
        // the fix is the same tap on the same screen either way.
        if (totals.grandTotal <= 0.005 && hasUnmeasurablePhotoWork(job, runs)) {
            warnings += EstimateWarning(R.string.survey_not_calibrated)
        }

        // A fence to build with no materials priced at all
        // ([hasFenceWithNoMaterials]). Second, beside the other "this is not
        // a real quote yet" warning, and for the same reason: every check
        // further down is about a number reading wrong, and this is the case
        // where those checks have all gone quiet BECAUSE the number is zero.
        // The total is not zero -- labour still prices -- which is what makes
        // it dangerous: it looks like a cheap job rather than a broken one.
        if (hasFenceWithNoMaterials(job, runs, totals)) {
            warnings += EstimateWarning(R.string.warn_no_materials)
        }

        // What stays with the business after materials, as a share of the
        // price (tax excluded on both sides -- it is a passthrough).
        //
        // The old version counted the LABOR and TEARDOWN charges as costs, so
        // "what's left" was literally the markup and nothing else: a job at
        // 1% markup read "Only 2% profit margin" forever, adding teardown
        // raised price and "cost" by the same figure so the number never
        // moved, and the labor charge looked like money out the door. But
        // labor and teardown are the contractor's own charges -- crew wages
        // come out of them, and so does the profit. The honest estimate-time
        // figure is how much of the price is not spent on materials.
        val priceExTax = totals.grandTotal - totals.tax
        if (priceExTax > 0.0) {
            val kept = priceExTax - totals.materialsSubtotal
            val keptPercent = kept / priceExTax * 100.0
            if (keptPercent < LOW_KEPT_THRESHOLD_PERCENT) {
                warnings += EstimateWarning(
                    R.string.warn_low_kept,
                    listOf(keptPercent.roundToInt().toString(), "%.0f".format(java.util.Locale.US, kept))
                )
            }
        }

        // An old fence drawn but not charged for.
        //
        // isTeardown on a run only takes that footage OUT of the new fence
        // (linearFeet excludes it) and feeds teardownLinearFeet. What turns the
        // charge on is Job.teardownEnabled, and that switch lives on the job
        // screen -- so a teardown drawn carefully on the survey screen bills
        // exactly nothing, and every figure on the estimate looks ordinary.
        // Removing a fence is a day of work, so this is the difference between
        // a quote and a quote that loses money.
        //
        // Said here, not only beside the switch, because the estimate is where
        // the price is judged and sent. The job screen carries the same warning
        // next to the switch that fixes it.
        if (!job.teardownEnabled && runs.any { it.isTeardown }) {
            warnings += EstimateWarning(R.string.warn_teardown_drawn_not_billed, emptyList())
        }

        // "Will I have enough in hand to buy the materials?"
        //
        // Money already collected counts. The check used to compare the deposit
        // against materials and nothing else, so it went on warning that the
        // deposit would not cover materials long after the customer had paid --
        // sometimes after they had paid in full. A warning that is wrong on a
        // job you have already been paid for is worse than no warning: it
        // teaches people to scroll past this whole section, including the times
        // it is right.
        //
        // Fixing that moved the CONDITION onto money collected and left the
        // MESSAGE printing the deposit, which is a different number, so the
        // sentence stopped being arithmetic. A $3,000 deposit against $2,828.48
        // of materials read "Deposit ($3,000.00) doesn't cover the estimated
        // material cost ($2,828.48)" -- nonsense on its face, because nothing
        // had been collected yet and 0.00 was what the condition had tested.
        // The owner spotted it from the two figures alone.
        //
        // So there is ONE figure now, [inHand], and both the test and the
        // message use it -- not two numbers that have to be kept in step by
        // hand. What it is depends on whether any money has moved:
        //
        //  - NOTHING COLLECTED: the answer turns on the deposit being asked
        //    for, because that is the only money due before the materials are
        //    bought. This is the case the warning was written for and the one
        //    a fresh job sits in -- a deposit of $0 against real materials
        //    still warns.
        //  - PART PAID, whatever the deposit says: the answer turns on what has
        //    actually arrived. Once a payment has landed the app stops asking
        //    for the deposit at all and asks for the whole remaining balance
        //    ([JobMoney.nextRequestAmount]), so the stored deposit is no longer
        //    a figure anybody is going to collect -- it is an intention, not
        //    cash. $500 in hand against $2,828.48 of materials is $2,328.48 out
        //    of his own pocket today, whatever the deposit column says, and
        //    that is what warn_fronting_material reports.
        //  - COVERED: no warning. Either branch going quiet means the money for
        //    the materials is accounted for.
        val collected = JobMoney.netPaid(job)
        val billable = JobMoney.billableTotal(job, totals.grandTotal, changeOrders)
        val owed = JobMoney.stillOwed(job, billable)

        val anyMoneyIn = collected > 0.005
        // Floored: a nonsense negative stored deposit must not print as one.
        val inHand = if (anyMoneyIn) collected else job.depositAmount.coerceAtLeast(0.0)
        if (totals.materialsSubtotal > 0.0 && inHand < totals.materialsSubtotal - 0.005) {
            val shortfall = totals.materialsSubtotal - inHand
            warnings += if (anyMoneyIn) {
                EstimateWarning(
                    R.string.warn_fronting_material,
                    listOf(money(inHand), money(totals.materialsSubtotal), money(shortfall))
                )
            } else {
                EstimateWarning(
                    R.string.warn_deposit_short,
                    listOf(money(inHand), money(totals.materialsSubtotal))
                )
            }
        }

        // Said as a fact rather than a warning, because it is what someone most
        // often opens this screen to find out.
        if (collected > 0.005 && owed > 0.005) {
            warnings += EstimateWarning(
                R.string.warn_still_to_collect,
                listOf(money(owed), money(billable))
            )
        }

        // The price is still a guess until the supplier comes back.
        if (job.materialPricesConfirmedAt == null && totals.materialsSubtotal > 0.0) {
            warnings += EstimateWarning(R.string.warn_provisional_pricing)
        }

        // A signature that no longer covers the job is not a small problem.
        if (JobMoney.signatureIsStale(job, totals.grandTotal, totals.billableLinearFeet)) {
            // The reason travels as resource parts, not a pre-built English
            // sentence, so the renderer can join it in the reader's language.
            warnings += EstimateWarning(
                R.string.warn_changed_after_signed,
                emptyList(),
                reasonParts = JobMoney.staleSignatureReasonParts(job, totals.grandTotal, totals.billableLinearFeet)
            )
        }

        val hasPosts = lineItems.any { it.role in POST_ROLES && it.quantity > 0.0 }
        val hasConcrete = lineItems.any { it.role == MaterialRole.CONCRETE_BAG && it.quantity > 0.0 }
        if (hasPosts && !hasConcrete) {
            warnings += EstimateWarning(R.string.warn_posts_no_concrete)
        }

        val anyGates = runs.any { FenceCodec.decodeGates(it.gatesEncoded).isNotEmpty() }
        val hasGateHardware = lineItems.any { it.role in GATE_HARDWARE_ROLES && it.quantity > 0.0 }
        if (anyGates && !hasGateHardware) {
            warnings += EstimateWarning(R.string.warn_gate_no_hardware)
        }

        return warnings
    }
}

/**
 * One pre-send warning: a string resource and the positional arguments it
 * takes (money already formatted as text). Rendered by the screen with
 * `stringResource(textRes, *args.toTypedArray())`.
 */
data class EstimateWarning(
    val textRes: Int,
    val args: List<Any> = emptyList(),
    /** When set, resolved per-part and joined in the reader's language, then formatted into textRes. */
    val reasonParts: List<Pair<Int, List<Any>>>? = null
)
