package com.fenceestimator.app.estimate

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
import kotlin.math.ceil
import kotlin.math.roundToInt

/** One suggested catalog role + quantity, optionally preferring an item covering a specific width/height. */
data class QtyEntry(val role: MaterialRole, val quantity: Double, val preferCoversFt: Float? = null)

data class EstimateSuggestions(
    val geometry: FenceGeometryResult,
    val netLinearFeet: Float,
    val entries: List<QtyEntry>
)

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

    fun suggestQuantities(run: FenceRun, pixelsPerFoot: Float): EstimateSuggestions {
        val points = FenceCodec.decodePoints(run.pointsEncoded)
        val gates = FenceCodec.decodeGates(run.gatesEncoded)
        val geometry = FenceGeometryEngine.analyze(points, pixelsPerFoot, run.closedLoop)
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

        return EstimateSuggestions(geometry, netFt, entries)
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

        val standardPostEstimate = if (postSpacingFt > 0f) ceil(netFt / postSpacingFt).roundToInt() + 1 else 0
        val linePosts = (standardPostEstimate - cornerPosts - endPosts - gatePosts).coerceAtLeast(0)
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

    private fun gateEntries(fenceType: FenceType, gate: GateMarker): List<QtyEntry> {
        val panelRole = if (fenceType in FRAME_KIT_GATE_TYPES) MaterialRole.GATE_FRAME_KIT else MaterialRole.GATE_PANEL
        val entries = mutableListOf(QtyEntry(panelRole, 1.0, preferCoversFt = gate.widthFt))
        entries += QtyEntry(MaterialRole.HINGE_SET, 1.0)
        entries += QtyEntry(MaterialRole.LATCH, 1.0)
        if (fenceType == FenceType.VINYL) {
            entries += QtyEntry(MaterialRole.HANDLE, 1.0)
            entries += QtyEntry(MaterialRole.BRACE, 1.0)
            entries += QtyEntry(MaterialRole.STIFFENER, 1.0)
            entries += QtyEntry(MaterialRole.TRIM, 4.0)
        }
        return entries
    }

    /**
     * Builds priced, editable line items from suggested quantities and the
     * current material catalog, scoped to the run's fence type. Prefers the
     * run's chosen color/finish and the job's preferred manufacturer when
     * more than one catalog item matches a role; falls back gracefully when
     * a role has no matching catalog item at all.
     */
    fun buildLineItems(
        jobId: Long,
        fenceRunId: Long,
        run: FenceRun,
        suggestions: EstimateSuggestions,
        catalog: List<MaterialItem>,
        preferredManufacturerId: Long?
    ): List<EstimateLineItem> {
        val candidatesByRole = catalog
            .filter { it.isActive && (it.fenceType == run.fenceType || it.fenceType == FenceType.UNIVERSAL) }
            .groupBy { it.role }

        val items = mutableListOf<EstimateLineItem>()
        var order = 0

        suggestions.entries.forEach { entry ->
            if (entry.quantity <= 0.0) return@forEach
            var candidates = candidatesByRole[entry.role].orEmpty()
            if (candidates.isEmpty()) return@forEach

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
                candidates.firstOrNull()
            } ?: return@forEach

            items.add(
                EstimateLineItem(
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

        return items
    }

    data class Totals(
        val materialsSubtotal: Double,
        val taxableSubtotal: Double,
        val tax: Double,
        val laborCost: Double,
        val teardownCost: Double,
        val markupAmount: Double,
        val discountAmount: Double,
        val grandTotal: Double
    )

    fun computeTotals(job: Job, lineItems: List<EstimateLineItem>, totalLinearFeet: Float): Totals {
        val materialsSubtotal = lineItems.sumOf { it.quantity * it.unitPrice }
        val taxableSubtotal = lineItems.filter { it.taxable }.sumOf { it.quantity * it.unitPrice }
        val tax = taxableSubtotal * (job.taxRatePercent / 100.0)
        val laborCost = job.laborFlatFee + (job.laborRatePerFt * totalLinearFeet)
        val teardownCost = if (job.teardownEnabled) job.teardownFlatFee + job.teardownRatePerFt * totalLinearFeet else 0.0

        val preMarkup = materialsSubtotal + tax + laborCost + teardownCost
        val markupAmount = preMarkup * (job.markupPercent / 100.0)
        val afterMarkup = preMarkup + markupAmount

        val discountAmount = afterMarkup * (job.discountPercent / 100.0)
        val afterDiscount = afterMarkup - discountAmount

        val grandTotal = maxOf(afterDiscount, job.minimumJobCharge)

        return Totals(materialsSubtotal, taxableSubtotal, tax, laborCost, teardownCost, markupAmount, discountAmount, grandTotal)
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

        if (totals.grandTotal > 0.0) {
            val cost = totals.materialsSubtotal + totals.tax + totals.laborCost + totals.teardownCost
            val marginPercent = (totals.grandTotal - cost) / totals.grandTotal * 100.0
            if (marginPercent < LOW_MARGIN_THRESHOLD_PERCENT) {
                warnings += "This project only has an estimated ${marginPercent.roundToInt()}% profit margin."
            }
        }

        if (totals.materialsSubtotal > 0.0 && job.depositAmount < totals.materialsSubtotal) {
            warnings += "Deposit (\$${"%.2f".format(job.depositAmount)}) doesn't cover the estimated material cost (\$${"%.2f".format(totals.materialsSubtotal)})."
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
