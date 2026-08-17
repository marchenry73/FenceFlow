package com.fenceestimator.app.estimate

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
import kotlin.math.ceil
import kotlin.math.roundToInt

/** One suggested catalog role + quantity, optionally preferring an item covering a specific width/height. */
data class QtyEntry(val role: MaterialRole, val quantity: Double, val preferCoversFt: Float? = null)

data class EstimateSuggestions(
    val geometry: FenceGeometryResult,
    val netLinearFeet: Float,
    val entries: List<QtyEntry>,
    /** Plain-English counts, shown to the contractor whether or not the catalog has a matching item. */
    val takeoff: List<TakeoffLine> = emptyList()
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
 * Turns a calibrated fence run (drawing + gate placements + type/spec) into
 * suggested material quantities. These are starting numbers meant to be
 * reviewed and adjusted by the contractor before pricing -- not a guarantee
 * of exact takeoff.
 */
object EstimateEngine {

    private data class PostCounts(
        val linePosts: Int,
        val cornerPosts: Int,
        val endPosts: Int,
        val gatePosts: Int,
        val terminalPosts: Int,
        val totalPosts: Int
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
     */
    fun suggestQuantities(run: FenceRun, pixelsPerFoot: Float, wastePercent: Double = 0.0): EstimateSuggestions {
        val gates = FenceCodec.decodeGates(run.gatesEncoded)
        val geometry = resolveGeometry(run, pixelsPerFoot)
        val gateWidthTotal = gates.sumOf { it.widthFt.toDouble() }.toFloat()
        val netFt = (geometry.totalLinearFeet - gateWidthTotal).coerceAtLeast(0f)

        val postCounts = computePostCounts(geometry, gates, run.postSpacingFt, netFt)

        val entries = mutableListOf<QtyEntry>()
        when (run.fenceType) {
            FenceType.VINYL, FenceType.ALUMINUM, FenceType.ORNAMENTAL_IRON -> entries += panelBasedEntries(run, netFt, postCounts)
            FenceType.WOOD, FenceType.COMPOSITE -> entries += picketAndRailEntries(run, netFt, postCounts)
            FenceType.CHAIN_LINK -> entries += chainLinkEntries(run, netFt, postCounts)
            FenceType.SPLIT_RAIL -> entries += splitRailEntries(run, netFt, postCounts)
            FenceType.UNIVERSAL -> {}
        }

        entries += QtyEntry(MaterialRole.CONCRETE_BAG, postCounts.totalPosts * run.concreteBagsPerPost.toDouble())

        gates.forEach { gate -> entries += gateEntries(run.fenceType, gate) }

        val withWaste = applyWaste(entries, wastePercent)
        val kept = withWaste.filter { it.role !in run.suppressedRoles }

        return EstimateSuggestions(
            geometry = geometry,
            netLinearFeet = netFt,
            entries = kept,
            takeoff = buildTakeoff(geometry, gates.size, postCounts, kept)
        )
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

    private fun applyWaste(entries: List<QtyEntry>, wastePercent: Double): List<QtyEntry> {
        if (wastePercent <= 0.0) return entries
        val factor = 1.0 + wastePercent / 100.0
        return entries.map { entry ->
            if (entry.role in WASTE_ROLES) entry.copy(quantity = ceil(entry.quantity * factor)) else entry
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
            TakeoffLine("Gate posts", posts.gatePosts.toDouble(), "", TakeoffGroup.POSTS),
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

    private fun computePostCounts(
        geometry: FenceGeometryResult,
        gates: List<GateMarker>,
        postSpacingFt: Float,
        netFt: Float
    ): PostCounts {
        val gateCount = gates.size
        val gatePosts = gateCount * 2
        val cornerPosts = geometry.cornerCount
        val endPosts = geometry.endCount

        // A closed loop needs no closing post -- the last bay lands back on the
        // first one -- so only an open run gets the extra post on the end.
        val bays = if (postSpacingFt > 0f) ceil(netFt / postSpacingFt).roundToInt() else 0
        val standardPostEstimate = if (bays == 0) 0 else if (endPosts == 0) bays else bays + 1

        // Gate posts are NOT subtracted here: the gate openings were already
        // taken out of netFt, so those posts sit outside this count. Subtracting
        // them was wiping out the line posts on short runs.
        val linePosts = (standardPostEstimate - cornerPosts - endPosts).coerceAtLeast(0)
        val totalPosts = linePosts + cornerPosts + endPosts + gatePosts

        return PostCounts(linePosts, cornerPosts, endPosts, gatePosts, cornerPosts + endPosts + gatePosts, totalPosts)
    }

    /** Vinyl, aluminum, ornamental iron: fence built from discrete panels. */
    private fun panelBasedEntries(run: FenceRun, netFt: Float, posts: PostCounts): List<QtyEntry> {
        val panelCount = if (run.panelWidthFt > 0f) ceil(netFt / run.panelWidthFt).roundToInt() else 0
        return listOf(
            QtyEntry(MaterialRole.PANEL, panelCount.toDouble(), preferCoversFt = run.panelWidthFt),
            QtyEntry(MaterialRole.LINE_POST, posts.linePosts.toDouble()),
            QtyEntry(MaterialRole.CORNER_POST, posts.cornerPosts.toDouble()),
            QtyEntry(MaterialRole.END_POST, posts.endPosts.toDouble()),
            QtyEntry(MaterialRole.GATE_POST, posts.gatePosts.toDouble()),
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
            QtyEntry(MaterialRole.GATE_POST, posts.gatePosts.toDouble()),
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
            QtyEntry(MaterialRole.GATE_POST, posts.gatePosts.toDouble())
        )
    }

    private fun chainLinkEntries(run: FenceRun, netFt: Float, posts: PostCounts): List<QtyEntry> {
        val bandsPerTerminalPost = ceil(run.fabricHeightFt).roundToInt().coerceAtLeast(1)
        val entries = mutableListOf(
            QtyEntry(MaterialRole.CHAIN_FABRIC, netFt.toDouble(), preferCoversFt = run.fabricHeightFt),
            QtyEntry(MaterialRole.LINE_POST, posts.linePosts.toDouble()),
            QtyEntry(MaterialRole.CORNER_POST, posts.cornerPosts.toDouble()),
            QtyEntry(MaterialRole.END_POST, posts.endPosts.toDouble()),
            QtyEntry(MaterialRole.GATE_POST, posts.gatePosts.toDouble()),
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
     * Every gate gets its hinges, latch, handle, and brace regardless of fence
     * type -- forgetting one of those is what sends a crew back to the supply
     * house mid-install. Anything the contractor doesn't want is removed on the
     * estimate and stays removed (see FenceRun.suppressedRoles).
     */
    private fun gateEntries(fenceType: FenceType, gate: GateMarker): List<QtyEntry> {
        val panelRole = if (fenceType in FRAME_KIT_GATE_TYPES) MaterialRole.GATE_FRAME_KIT else MaterialRole.GATE_PANEL
        val entries = mutableListOf(QtyEntry(panelRole, 1.0, preferCoversFt = gate.widthFt))
        entries += QtyEntry(MaterialRole.HINGE_SET, 1.0)
        entries += QtyEntry(MaterialRole.LATCH, 1.0)
        entries += QtyEntry(MaterialRole.HANDLE, 1.0)
        entries += QtyEntry(MaterialRole.BRACE, 1.0)
        // A wide gate sags without a second brace and a heavier hinge set.
        if (gate.widthFt >= 8f) {
            entries += QtyEntry(MaterialRole.BRACE, 1.0)
            entries += QtyEntry(MaterialRole.HINGE_SET, 1.0)
        }
        if (fenceType == FenceType.VINYL) {
            entries += QtyEntry(MaterialRole.TRIM, 4.0)
        }
        entries += gateAreaEntries(gate)
        return entries
    }

    /**
     * What the gate area itself is built from, which depends on where the gate
     * hangs rather than on the fence type.
     *
     * Every gate takes one econo stiffener. After that the three cases are
     * genuinely different builds, and treating them alike is a truck going back
     * to the yard:
     *
     *  - **On the wall**: the hinge side bolts through a blank post. Four 5/8"
     *    holes are drilled through the stiffener into that post, so it needs
     *    plugs to close them. Nothing is set in the ground, so **no concrete** --
     *    this is the case the old code got most wrong, since it charged concrete
     *    for every gate regardless. Takes a blank post plus an end post.
     *  - **In the line**: an end post, set in concrete -- two bags.
     *  - **In the line with the fence carrying on to a wall**: the run
     *    terminates twice, so two end posts, still in concrete.
     *
     * Gate posts are counted separately by [computePostCounts]; these are the
     * posts the gate area needs on top of that.
     */
    private fun gateAreaEntries(gate: GateMarker): List<QtyEntry> {
        val entries = mutableListOf(QtyEntry(MaterialRole.STIFFENER, 1.0))
        when (gate.mounting) {
            GateMounting.WALL -> {
                entries += QtyEntry(MaterialRole.BLANK_POST, 1.0)
                entries += QtyEntry(MaterialRole.END_POST, 1.0)
                entries += QtyEntry(MaterialRole.HOLE_PLUG, WALL_MOUNT_HOLES)
                // Deliberately no concrete: a wall-hung gate is bolted, not set.
            }
            GateMounting.LINE -> {
                entries += QtyEntry(MaterialRole.END_POST, 1.0)
                entries += QtyEntry(MaterialRole.CONCRETE_BAG, GATE_CONCRETE_BAGS)
            }
            GateMounting.LINE_TO_WALL -> {
                entries += QtyEntry(MaterialRole.END_POST, 2.0)
                entries += QtyEntry(MaterialRole.CONCRETE_BAG, GATE_CONCRETE_BAGS)
            }
        }
        return entries
    }

    /** Holes drilled through the stiffener into the blank post, each needing a plug. */
    private const val WALL_MOUNT_HOLES = 4.0

    /** Concrete for a gate post set in the ground. */
    private const val GATE_CONCRETE_BAGS = 2.0

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

    data class BuiltItems(
        val items: List<EstimateLineItem>,
        /** Roles the takeoff called for that the catalog has nothing priced for. */
        val unmatchedRoles: List<MaterialRole>,
        /** Matched items whose catalog price is still zero, so the estimate would read $0. */
        val zeroPricedNames: List<String>
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
            .map { (key, group) -> QtyEntry(key.first, group.sumOf { it.quantity }, key.second) }

        mergedEntries.forEach { entry ->
            var candidates = candidatesByRole[entry.role].orEmpty()
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

            val chosen = if (entry.preferCoversFt != null) {
                candidates.minByOrNull { kotlin.math.abs((it.coversFt ?: entry.preferCoversFt) - entry.preferCoversFt) }
            } else {
                // Prefer something actually priced. Picking the first match blind
                // is how a $0.00 placeholder ended up representing a whole role
                // and quietly zeroed out the materials total.
                candidates.firstOrNull { it.unitPrice > 0.0 } ?: candidates.firstOrNull()
            } ?: run {
                unmatched += entry.role
                return@forEach
            }
            if (chosen.unitPrice <= 0.0) zeroPriced += chosen.name

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
                    syncId = deterministicSyncId(run.syncId, entry.role.name),
                    jobId = jobId,
                    fenceRunId = fenceRunId,
                    sortOrder = order++,
                    description = chosen.name,
                    quantity = entry.quantity,
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
        val billableLinearFeet: Float = 0f
    )

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
        val gateFeet = runs.sumOf { run ->
            FenceCodec.decodeGates(run.gatesEncoded).sumOf { it.widthFt.toDouble() }
        }
        val gateCharge = gateFeet * job.gateRatePerFt

        val laborCost = job.laborFlatFee + (job.laborRatePerFt * billableFeet)
        val trashHaul = if (job.teardownEnabled) job.trashHaulFee else 0.0
        val teardownCost =
            if (job.teardownEnabled) job.teardownFlatFee + job.teardownRatePerFt * billableFeet + trashHaul
            else 0.0

        val preMarkup = materialsSubtotal + tax + laborCost + teardownCost + changeOrderCost + gateCharge
        val markupAmount = preMarkup * (job.markupPercent / 100.0)
        val afterMarkup = preMarkup + markupAmount

        val discountAmount = afterMarkup * (job.discountPercent / 100.0)
        val afterDiscount = afterMarkup - discountAmount

        val grandTotal = maxOf(afterDiscount, job.minimumJobCharge)

        return Totals(
            materialsSubtotal, taxableSubtotal, tax, laborCost, teardownCost,
            markupAmount, discountAmount, grandTotal, changeOrderCost, changeOrderFeet,
            gateCharge, gateFeet, trashHaul, billableFeet.toFloat()
        )
    }

    private val POST_ROLES = setOf(MaterialRole.LINE_POST, MaterialRole.CORNER_POST, MaterialRole.END_POST, MaterialRole.GATE_POST)
    private val GATE_HARDWARE_ROLES = setOf(MaterialRole.HINGE_SET, MaterialRole.LATCH, MaterialRole.GATE_PANEL, MaterialRole.GATE_FRAME_KIT)
    private const val LOW_MARGIN_THRESHOLD_PERCENT = 20.0

    /**
     * Rule-based sanity checks over the current estimate -- no AI needed,
     * just flags the mistakes that are easy to miss when quoting fast.
     */
    fun estimateWarnings(job: Job, runs: List<FenceRun>, lineItems: List<EstimateLineItem>, totals: Totals): List<String> {
        val warnings = mutableListOf<String>()

        // Only worth saying when a markup was actually set. With markup at 0 the
        // margin is 0 by definition, so warning about it fires on every single
        // job and becomes noise -- and then the one job that really is
        // underpriced reads the same as all the others.
        if (totals.grandTotal > 0.0 && job.markupPercent > 0.0) {
            val cost = totals.materialsSubtotal + totals.tax + totals.laborCost + totals.teardownCost
            val marginPercent = (totals.grandTotal - cost) / totals.grandTotal * 100.0
            if (marginPercent < LOW_MARGIN_THRESHOLD_PERCENT) {
                warnings += "Only ${marginPercent.roundToInt()}% profit margin -- that's what's left " +
                    "after materials, labor and teardown, as a share of the price."
            }
        }

        // Money already collected counts.
        //
        // This used to compare the deposit against materials and nothing else,
        // so it went on warning that the deposit would not cover materials long
        // after the customer had paid -- sometimes after they had paid in full.
        // A warning that is wrong on a job you have already been paid for is
        // worse than no warning: it teaches people to scroll past this whole
        // section, including the times it is right.
        val collected = JobMoney.netPaid(job)
        val owed = JobMoney.stillOwed(job, totals.grandTotal)

        if (totals.materialsSubtotal > 0.0 && collected < totals.materialsSubtotal) {
            val shortfall = totals.materialsSubtotal - collected
            warnings += if (collected > 0.005) {
                "You have collected \$${"%.2f".format(collected)} but the materials cost " +
                    "\$${"%.2f".format(totals.materialsSubtotal)} -- you are fronting " +
                    "\$${"%.2f".format(shortfall)} of the customer's material."
            } else {
                "Deposit (\$${"%.2f".format(job.depositAmount)}) doesn't cover the estimated " +
                    "material cost (\$${"%.2f".format(totals.materialsSubtotal)}). You would be " +
                    "buying their fence with your own money."
            }
        }

        // Said as a fact rather than a warning, because it is what someone most
        // often opens this screen to find out.
        if (collected > 0.005 && owed > 0.005) {
            warnings += "Still to collect: \$${"%.2f".format(owed)} of " +
                "\$${"%.2f".format(totals.grandTotal)}."
        }

        // The price is still a guess until the supplier comes back.
        if (job.materialPricesConfirmedAt == null && totals.materialsSubtotal > 0.0) {
            warnings += "Materials are priced from your catalog, not a supplier quote. " +
                "The total can still move."
        }

        // A signature that no longer covers the job is not a small problem.
        if (JobMoney.signatureIsStale(job, totals.grandTotal, totals.billableLinearFeet)) {
            warnings += "This changed after it was signed -- " +
                JobMoney.staleSignatureReason(job, totals.grandTotal, totals.billableLinearFeet) +
                ". Get a new signature before sending anything."
        }

        val hasPosts = lineItems.any { it.role in POST_ROLES && it.quantity > 0.0 }
        val hasConcrete = lineItems.any { it.role == MaterialRole.CONCRETE_BAG && it.quantity > 0.0 }
        if (hasPosts && !hasConcrete) {
            warnings += "Posts are on the estimate but concrete hasn't been added."
        }

        val anyGates = runs.any { FenceCodec.decodeGates(it.gatesEncoded).isNotEmpty() }
        val hasGateHardware = lineItems.any { it.role in GATE_HARDWARE_ROLES && it.quantity > 0.0 }
        if (anyGates && !hasGateHardware) {
            warnings += "A gate is drawn but gate hardware (hinges, latch) hasn't been added yet."
        }

        return warnings
    }
}
