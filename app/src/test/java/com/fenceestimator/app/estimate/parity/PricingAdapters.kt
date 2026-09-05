package com.fenceestimator.app.estimate.parity

import com.fenceestimator.app.data.AluminumStyle
import com.fenceestimator.app.data.ChangeOrder
import com.fenceestimator.app.data.EstimateLineItem
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.MaterialCategory
import com.fenceestimator.app.data.MaterialItem
import com.fenceestimator.app.data.MaterialRole
import com.fenceestimator.app.data.WoodStyle
import com.fenceestimator.app.estimate.EstimateEngine
import com.fenceestimator.app.geometry.FenceCodec

/**
 * PricingInput -> the phone's domain objects -> the engine -> PricingOutput.
 *
 * This is the whole of what the server port has to reproduce, in the order
 * the phone does it. Every rule that is NOT inside EstimateEngine itself is
 * written here in one place with its source named, so the port has one file
 * to mirror rather than four screens' worth of view-model to reverse-engineer:
 *
 *  - which scale the takeoff measures by (EstimateViewModel / TakeoffRefresher);
 *  - which runs get line items at all (TakeoffRefresher: never a teardown run);
 *  - hand-edited and supplier prices carried over by role (TakeoffRefresher);
 *  - which existing rows survive a regenerate (EstimateLineItemDao.replaceGeneratedForRun);
 *  - the order the totals sum in (EstimateLineItemDao: sort_order, then sync_id).
 */
object PricingRunner {

    /**
     * A JSON number that is not exactly a float cannot have come from the
     * phone, and would price differently there. Refuse it rather than round.
     */
    private fun f32(value: Double, field: String): Float {
        val f = value.toFloat()
        require(f.toDouble() == value) { "$field = $value is not representable as a Float (write it after fround)" }
        return f
    }

    fun price(input: PricingInput): PricingOutput {
        require(input.engineVersion == EstimateEngine.PRICING_ENGINE_VERSION) {
            "input engine_version ${input.engineVersion} != ${EstimateEngine.PRICING_ENGINE_VERSION}"
        }

        // Manufacturers only exist to the engine as the phone's Long ids. The
        // phone resolves a sync id it has never seen to null (JobSync), which
        // means "no preference" -- an unknown preferred manufacturer narrows
        // nothing.
        val manufacturerIdBySync: Map<String, Long> =
            input.manufacturers.mapIndexed { i, m -> m.syncId to (i + 1L) }.toMap()

        val job = Job(
            id = 1,
            calibrationPixelsPerFoot = input.job.calibrationPixelsPerFoot?.let { f32(it, "job.calibration_pixels_per_foot") },
            taxRatePercent = input.job.taxRatePercent,
            markupPercent = input.job.markupPercent,
            discountPercent = input.job.discountPercent,
            laborRatePerFt = input.job.laborRatePerFt,
            laborFlatFee = input.job.laborFlatFee,
            minimumJobCharge = input.job.minimumJobCharge,
            wastePercent = input.job.wastePercent,
            gateRatePerFt = input.job.gateRatePerFt,
            trashHaulFee = input.job.trashHaulFee,
            teardownEnabled = input.job.teardownEnabled,
            teardownFlatFee = input.job.teardownFlatFee,
            teardownRatePerFt = input.job.teardownRatePerFt,
            teardownFeet = input.job.teardownFeet,
            preferredManufacturerId = input.job.preferredManufacturerSyncId?.let { manufacturerIdBySync[it] }
        )

        val runs: List<FenceRun> = input.runs.mapIndexed { i, r ->
            FenceRun(
                id = i + 1L,
                syncId = r.syncId,
                jobId = 1,
                label = r.label,
                // Strict on purpose: a run row with a fence type the phone does
                // not know is not something either engine should price.
                fenceType = FenceType.valueOf(r.fenceType),
                sortOrder = r.sortOrder,
                pointsEncoded = r.pointsEncoded,
                gatesEncoded = r.gatesEncoded,
                closedLoop = r.closedLoop,
                isTeardown = r.isTeardown,
                colorOrFinish = r.colorOrFinish,
                panelWidthFt = f32(r.panelWidthFt, "runs[$i].panel_width_ft"),
                panelHeightFt = f32(r.panelHeightFt, "runs[$i].panel_height_ft"),
                // Not read by the engine; mapped the way the pull does (EntitySync) for completeness.
                aluminumStyle = runCatching { AluminumStyle.valueOf(r.aluminumStyle) }.getOrDefault(AluminumStyle.RACKABLE),
                woodStyle = runCatching { WoodStyle.valueOf(r.woodStyle) }.getOrDefault(WoodStyle.PRIVACY),
                woodRailCount = r.woodRailCount,
                picketWidthIn = f32(r.picketWidthIn, "runs[$i].picket_width_in"),
                picketGapIn = f32(r.picketGapIn, "runs[$i].picket_gap_in"),
                fabricHeightFt = f32(r.fabricHeightFt, "runs[$i].fabric_height_ft"),
                includeTopRail = r.includeTopRail,
                includeTensionWire = r.includeTensionWire,
                includeBarbedWireArms = r.includeBarbedWireArms,
                includePrivacySlats = r.includePrivacySlats,
                splitRailCount = r.splitRailCount,
                postSpacingFt = f32(r.postSpacingFt, "runs[$i].post_spacing_ft"),
                concreteBagsPerPost = f32(r.concreteBagsPerPost, "runs[$i].concrete_bags_per_post"),
                manualLinearFeet = r.manualLinearFeet?.let { f32(it, "runs[$i].manual_linear_feet") },
                manualCornerCount = r.manualCornerCount,
                suppressedRolesCsv = r.suppressedRoles
            )
        }

        // Catalog enums fall back exactly as the phone's pull does (EntitySync
        // material_items): an unknown role is NONE, category MISC, fence type
        // UNIVERSAL. The Room id is whatever the phone minted; since the
        // tie-break is on sync id it no longer matters, and 1..n is as good as any.
        val catalog: List<MaterialItem> = input.catalog.mapIndexed { i, c ->
            MaterialItem(
                id = i + 1L,
                syncId = c.syncId,
                category = runCatching { MaterialCategory.valueOf(c.category) }.getOrDefault(MaterialCategory.MISC),
                role = runCatching { MaterialRole.valueOf(c.role) }.getOrDefault(MaterialRole.NONE),
                fenceType = runCatching { FenceType.valueOf(c.fenceType) }.getOrDefault(FenceType.UNIVERSAL),
                name = c.name,
                unit = c.unit,
                unitPrice = c.unitPrice,
                taxable = c.taxable,
                coversFt = c.coversFt?.let { f32(it, "catalog[$i].covers_ft") },
                colorOrFinish = c.colorOrFinish,
                manufacturerId = c.manufacturerSyncId?.let { manufacturerIdBySync[it] },
                isActive = c.isActive
            )
        }

        val changeOrders: List<ChangeOrder> = input.changeOrders.map { co ->
            ChangeOrder(
                jobId = 1, syncId = co.syncId,
                additionalFeet = co.additionalFeet, additionalCost = co.additionalCost, materialCost = co.materialCost
            )
        }

        val runIdBySync: Map<String, Long> = runs.associate { it.syncId to it.id }
        val existing: List<EstimateLineItem> = input.existingItems.map { e ->
            EstimateLineItem(
                syncId = e.syncId,
                jobId = 1,
                // A row on a run this input does not carry is job-level as far
                // as pricing goes: nothing regenerates it and nothing removes it.
                fenceRunId = e.fenceRunSyncId?.let { runIdBySync[it] },
                sortOrder = e.sortOrder,
                description = e.description,
                quantity = e.quantity,
                unit = e.unit,
                unitPrice = e.unitPrice,
                taxable = e.taxable,
                // Same fallback as the pull: an unknown or missing role is NONE.
                role = e.role?.let { r -> runCatching { MaterialRole.valueOf(r) }.getOrNull() } ?: MaterialRole.NONE,
                isAutoGenerated = e.autoGenerated,
                supplierUnitPrice = e.supplierUnitPrice
            )
        }

        // The scale the takeoff measures by. Typed footage ignores it; a drawn
        // run uses the job's calibration, or the grid's 20 px/ft when there is
        // none (EstimateViewModel.regenerateInternal, TakeoffRefresher).
        // linearFeet() below does NOT share this fallback -- an uncalibrated
        // drawn run bills zero labour feet while still getting materials --
        // and that asymmetry is the phone's, so it is reproduced, not repaired.
        val pixelsPerFoot = f32(input.pixelsPerFoot, "pixels_per_foot")

        val runOutputs = mutableListOf<RunOutput>()
        val writtenItems = mutableListOf<EstimateLineItem>()
        val unmatched = mutableListOf<RunRole>()
        val zeroPricedIds = mutableListOf<String>()
        val zeroPricedNames = mutableListOf<RunName>()

        runs.forEach { run ->
            val suggestions = EstimateEngine.suggestQuantities(run, pixelsPerFoot, job.wastePercent)
            runOutputs += runOutput(run, suggestions)

            // A teardown run is the old fence: no bill of materials, and any
            // it had accumulated is cleared (TakeoffRefresher.refreshRun).
            if (run.isTeardown) return@forEach

            val built = EstimateEngine.buildLineItems(
                jobId = job.id, fenceRunId = run.id, run = run,
                suggestions = suggestions, catalog = catalog,
                preferredManufacturerId = job.preferredManufacturerId
            )
            built.unmatchedRoles.forEach { unmatched += RunRole(run.syncId, it.name) }
            built.zeroPricedNames.forEach { zeroPricedNames += RunName(run.syncId, it) }
            built.items.filter { it.unitPrice <= 0.0 }.forEach { zeroPricedIds += it.syncId }

            // Carry-over, exactly as TakeoffRefresher.refreshRun does it: a
            // price somebody typed is a decision, a supplier's quote is the
            // most authoritative number on the job, and both are matched on
            // the role of the rows THIS RUN already has. `associate` keeps the
            // last row per role, as it does there.
            val existingForRun = existing.filter { it.fenceRunId == run.id }
            val editedPrices = existingForRun
                .filter { !it.isAutoGenerated && it.role != MaterialRole.NONE }
                .associate { it.role to it.unitPrice }
            val quotedPrices = existingForRun
                .filter { it.supplierUnitPrice != null && it.role != MaterialRole.NONE }
                .associate { it.role to it.supplierUnitPrice }
            writtenItems += built.items.map { item ->
                val quoted = quotedPrices[item.role]
                val withQuote = if (quoted != null) item.copy(supplierUnitPrice = quoted) else item
                val kept = editedPrices[item.role]
                if (kept != null && kept != withQuote.unitPrice) {
                    withQuote.copy(unitPrice = kept, isAutoGenerated = false)
                } else {
                    withQuote
                }
            }
        }

        // What is left on the job after the regenerate, and therefore what the
        // totals see. replaceGeneratedForRun deletes every roled row of the
        // run -- edited ones included, since editing clears the auto flag --
        // and hand-typed extras (role NONE) are left alone. Rows with no run
        // are never touched.
        val survivors = existing.filter { it.role == MaterialRole.NONE || it.fenceRunId == null }

        // The phone sums whatever observeLineItems hands it, and that is
        // ORDER BY sortOrder ASC, syncId ASC. Floating-point sums depend on
        // order, so the office has to add the same rows in the same order.
        val itemsForTotals = (writtenItems + survivors)
            .sortedWith(compareBy({ it.sortOrder }, { it.syncId }))

        val linearFeet = EstimateEngine.linearFeet(job, runs)
        val totals = EstimateEngine.computeTotals(job, itemsForTotals, linearFeet, changeOrders, runs)

        val runSyncById = runs.associate { it.id to it.syncId }
        return PricingOutput(
            engineVersion = EstimateEngine.PRICING_ENGINE_VERSION,
            linearFeet = linearFeet.toDouble(),
            teardownLinearFeet = EstimateEngine.teardownLinearFeet(job, runs).toDouble(),
            billableLinearFeet = totals.billableLinearFeet.toDouble(),
            runs = runOutputs,
            items = writtenItems.map { item ->
                ItemOutput(
                    syncId = item.syncId,
                    fenceRunSyncId = runSyncById.getValue(item.fenceRunId!!),
                    sortOrder = item.sortOrder,
                    description = item.description,
                    quantity = item.quantity,
                    unit = item.unit,
                    unitPrice = item.unitPrice,
                    supplierUnitPrice = item.supplierUnitPrice,
                    taxable = item.taxable,
                    role = item.role.name,
                    autoGenerated = item.isAutoGenerated,
                    category = null
                )
            },
            unmatchedRoles = unmatched,
            zeroPriced = zeroPricedIds,
            zeroPricedNames = zeroPricedNames,
            totalsItems = itemsForTotals.map { it.syncId },
            totals = TotalsOutput(
                materialsSubtotal = totals.materialsSubtotal,
                taxableSubtotal = totals.taxableSubtotal,
                tax = totals.tax,
                laborCost = totals.laborCost,
                teardownCost = totals.teardownCost,
                trashHaulFee = totals.trashHaulFee,
                gateFeet = totals.gateFeet,
                gateCharge = totals.gateCharge,
                changeOrderCost = totals.changeOrderCost,
                changeOrderFeet = totals.changeOrderFeet,
                markupAmount = totals.markupAmount,
                discountAmount = totals.discountAmount,
                // Not on Totals; rebuilt from the six components it IS built
                // from, in the engine's own order (computeTotals, preMarkup).
                preMarkupTotal = totals.materialsSubtotal + totals.tax + totals.laborCost +
                    totals.teardownCost + totals.changeOrderCost + totals.gateCharge,
                grandTotal = totals.grandTotal,
                billableLinearFeet = totals.billableLinearFeet.toDouble()
            )
        )
    }

    private fun runOutput(run: FenceRun, s: com.fenceestimator.app.estimate.EstimateSuggestions): RunOutput {
        // The engine's first two lines (suggestQuantities), repeated so the
        // gate footage it subtracted is visible as its own stage.
        val gates = FenceCodec.decodeGates(run.gatesEncoded)
        val gateFeet = gates.sumOf { it.widthFt.toDouble() }.toFloat()

        // PostCounts is private to the engine; the takeoff prints every one
        // of its figures (zero lines are dropped there, hence the default).
        fun takeoff(label: String): Int =
            s.takeoff.firstOrNull { it.label == label }?.quantity?.toInt() ?: 0
        val line = takeoff("Line posts")
        val corner = takeoff("Corner posts")
        val end = takeoff("End posts")
        val gate = takeoff("Gate posts (end posts + stiffener)")

        return RunOutput(
            runSyncId = run.syncId,
            isTeardown = run.isTeardown,
            gateCount = gates.size,
            grossFeet = s.geometry.totalLinearFeet.toDouble(),
            gateFeet = gateFeet.toDouble(),
            netFeet = s.netLinearFeet.toDouble(),
            geometry = GeometryOutput(
                cornerCount = s.geometry.cornerCount,
                endCount = s.geometry.endCount,
                lineVertexCount = s.geometry.lineVertexCount,
                segments = s.geometry.segments.map { SegmentOutput(it.fromIndex, it.toIndex, it.lengthFt.toDouble()) },
                vertices = s.geometry.vertices.map { VertexOutput(it.index, it.kind.name, it.turnDegrees.toDouble()) }
            ),
            posts = PostsOutput(
                line = line, corner = corner, end = end, gate = gate,
                terminal = corner + end + gate,
                total = takeoff("Total posts")
            ),
            entries = s.entries.map {
                EntryOutput(it.role.name, it.quantity, it.preferCoversFt?.toDouble(), it.coversLinearFt?.toDouble())
            },
            takeoff = s.takeoff.map { TakeoffLineOutput(it.label, it.quantity, it.unit, it.group.name) }
        )
    }
}
