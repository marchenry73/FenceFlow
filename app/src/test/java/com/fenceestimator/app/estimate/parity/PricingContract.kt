package com.fenceestimator.app.estimate.parity

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The shapes in docs/PRICING_CONTRACT.md, as Kotlin.
 *
 * Field names are the Supabase column names, spelled out with @SerialName so
 * the JSON on disk is the JSON the edge function speaks -- the same file is
 * read by the TypeScript parity test, so a name that exists on one side only
 * is a bug on both.
 *
 * Every value the phone holds as a Float is declared Double here and written
 * after the Float->Double widening, which is exact: the JSON number then
 * round-trips through Math.fround on the other side to the identical float.
 * Reading goes the other way (Double -> Float) and refuses a value that was
 * not already a float, so a fixture authored by hand cannot smuggle in a
 * number the phone could never have held.
 */
@OptIn(ExperimentalSerializationApi::class)
internal val ParityJson = Json {
    prettyPrint = true
    prettyPrintIndent = "  "
    encodeDefaults = true
    explicitNulls = true
    // A key the contract does not know is a contract change that was not
    // written down. Fail loudly rather than skip it.
    ignoreUnknownKeys = false
}

/* ---------------- PricingInput ---------------- */

@Serializable
data class PricingInput(
    @SerialName("engine_version") val engineVersion: String,
    /** job.calibration_pixels_per_foot, or the phone's grid fallback (20) when null. */
    @SerialName("pixels_per_foot") val pixelsPerFoot: Double,
    val job: PricingJob,
    val runs: List<PricingRun>,
    val catalog: List<PricingCatalogItem>,
    val manufacturers: List<PricingManufacturer>,
    @SerialName("change_orders") val changeOrders: List<PricingChangeOrder>,
    @SerialName("existing_items") val existingItems: List<PricingExistingItem>
)

@Serializable
data class PricingJob(
    @SerialName("calibration_pixels_per_foot") val calibrationPixelsPerFoot: Double?,
    @SerialName("tax_rate_percent") val taxRatePercent: Double,
    @SerialName("markup_percent") val markupPercent: Double,
    @SerialName("discount_percent") val discountPercent: Double,
    @SerialName("labor_rate_per_ft") val laborRatePerFt: Double,
    @SerialName("labor_flat_fee") val laborFlatFee: Double,
    @SerialName("minimum_job_charge") val minimumJobCharge: Double,
    @SerialName("waste_percent") val wastePercent: Double,
    @SerialName("gate_rate_per_ft") val gateRatePerFt: Double,
    @SerialName("trash_haul_fee") val trashHaulFee: Double,
    @SerialName("teardown_enabled") val teardownEnabled: Boolean,
    @SerialName("teardown_flat_fee") val teardownFlatFee: Double,
    @SerialName("teardown_rate_per_ft") val teardownRatePerFt: Double,
    @SerialName("teardown_feet") val teardownFeet: Double,
    @SerialName("preferred_manufacturer_sync_id") val preferredManufacturerSyncId: String?
)

@Serializable
data class PricingRun(
    @SerialName("sync_id") val syncId: String,
    val label: String,
    @SerialName("fence_type") val fenceType: String,
    @SerialName("color_or_finish") val colorOrFinish: String,
    @SerialName("points_encoded") val pointsEncoded: String,
    @SerialName("gates_encoded") val gatesEncoded: String,
    @SerialName("closed_loop") val closedLoop: Boolean,
    @SerialName("manual_linear_feet") val manualLinearFeet: Double?,
    @SerialName("manual_corner_count") val manualCornerCount: Int,
    @SerialName("panel_width_ft") val panelWidthFt: Double,
    @SerialName("panel_height_ft") val panelHeightFt: Double,
    @SerialName("post_spacing_ft") val postSpacingFt: Double,
    @SerialName("concrete_bags_per_post") val concreteBagsPerPost: Double,
    @SerialName("aluminum_style") val aluminumStyle: String,
    @SerialName("wood_style") val woodStyle: String,
    @SerialName("wood_rail_count") val woodRailCount: Int,
    @SerialName("picket_width_in") val picketWidthIn: Double,
    @SerialName("picket_gap_in") val picketGapIn: Double,
    @SerialName("fabric_height_ft") val fabricHeightFt: Double,
    @SerialName("include_top_rail") val includeTopRail: Boolean,
    @SerialName("include_tension_wire") val includeTensionWire: Boolean,
    @SerialName("include_barbed_wire_arms") val includeBarbedWireArms: Boolean,
    @SerialName("include_privacy_slats") val includePrivacySlats: Boolean,
    @SerialName("split_rail_count") val splitRailCount: Int,
    @SerialName("suppressed_roles") val suppressedRoles: String,
    @SerialName("is_teardown") val isTeardown: Boolean,
    @SerialName("sort_order") val sortOrder: Int
)

@Serializable
data class PricingCatalogItem(
    @SerialName("sync_id") val syncId: String,
    val name: String,
    val category: String,
    val role: String,
    @SerialName("fence_type") val fenceType: String,
    @SerialName("color_or_finish") val colorOrFinish: String,
    val unit: String,
    @SerialName("unit_price") val unitPrice: Double,
    /** Accepted for the column's sake; MaterialItem has no such field, so neither engine reads it. */
    @SerialName("supplier_unit_price") val supplierUnitPrice: Double?,
    val taxable: Boolean,
    @SerialName("covers_ft") val coversFt: Double?,
    @SerialName("is_active") val isActive: Boolean,
    @SerialName("manufacturer_sync_id") val manufacturerSyncId: String?
)

@Serializable
data class PricingManufacturer(
    @SerialName("sync_id") val syncId: String,
    val name: String
)

@Serializable
data class PricingChangeOrder(
    @SerialName("sync_id") val syncId: String,
    @SerialName("additional_feet") val additionalFeet: Double,
    @SerialName("additional_cost") val additionalCost: Double,
    @SerialName("material_cost") val materialCost: Double
)

@Serializable
data class PricingExistingItem(
    @SerialName("sync_id") val syncId: String,
    @SerialName("fence_run_sync_id") val fenceRunSyncId: String?,
    val role: String?,
    val description: String,
    val quantity: Double,
    val unit: String,
    @SerialName("unit_price") val unitPrice: Double,
    @SerialName("supplier_unit_price") val supplierUnitPrice: Double?,
    val taxable: Boolean,
    @SerialName("auto_generated") val autoGenerated: Boolean,
    @SerialName("sort_order") val sortOrder: Int
)

/* ---------------- PricingOutput ---------------- */

@Serializable
data class PricingOutput(
    @SerialName("engine_version") val engineVersion: String,
    @SerialName("linear_feet") val linearFeet: Double,
    @SerialName("teardown_linear_feet") val teardownLinearFeet: Double,
    @SerialName("billable_linear_feet") val billableLinearFeet: Double,
    val runs: List<RunOutput>,
    val items: List<ItemOutput>,
    @SerialName("unmatched_roles") val unmatchedRoles: List<RunRole>,
    @SerialName("zero_priced") val zeroPriced: List<String>,
    @SerialName("zero_priced_names") val zeroPricedNames: List<RunName>,
    /** Line-item sync ids in the order computeTotals summed them. */
    @SerialName("totals_items") val totalsItems: List<String>,
    val totals: TotalsOutput
)

@Serializable
data class RunOutput(
    @SerialName("run_sync_id") val runSyncId: String,
    @SerialName("is_teardown") val isTeardown: Boolean,
    @SerialName("gate_count") val gateCount: Int,
    @SerialName("gross_feet") val grossFeet: Double,
    @SerialName("gate_feet") val gateFeet: Double,
    @SerialName("net_feet") val netFeet: Double,
    val geometry: GeometryOutput,
    val posts: PostsOutput,
    val entries: List<EntryOutput>,
    val takeoff: List<TakeoffLineOutput>
)

@Serializable
data class GeometryOutput(
    @SerialName("corner_count") val cornerCount: Int,
    @SerialName("end_count") val endCount: Int,
    @SerialName("line_vertex_count") val lineVertexCount: Int,
    val segments: List<SegmentOutput>,
    val vertices: List<VertexOutput>
)

@Serializable
data class SegmentOutput(
    @SerialName("from_index") val fromIndex: Int,
    @SerialName("to_index") val toIndex: Int,
    @SerialName("length_ft") val lengthFt: Double
)

@Serializable
data class VertexOutput(
    val index: Int,
    val kind: String,
    @SerialName("turn_degrees") val turnDegrees: Double
)

@Serializable
data class PostsOutput(
    val line: Int,
    val corner: Int,
    val end: Int,
    val gate: Int,
    val terminal: Int,
    val total: Int
)

@Serializable
data class EntryOutput(
    val role: String,
    val quantity: Double,
    @SerialName("prefer_covers_ft") val preferCoversFt: Double?,
    @SerialName("covers_linear_ft") val coversLinearFt: Double?
)

@Serializable
data class TakeoffLineOutput(
    val label: String,
    val quantity: Double,
    val unit: String,
    val group: String
)

@Serializable
data class ItemOutput(
    @SerialName("sync_id") val syncId: String,
    @SerialName("fence_run_sync_id") val fenceRunSyncId: String,
    @SerialName("sort_order") val sortOrder: Int,
    val description: String,
    val quantity: Double,
    val unit: String,
    @SerialName("unit_price") val unitPrice: Double,
    @SerialName("supplier_unit_price") val supplierUnitPrice: Double?,
    val taxable: Boolean,
    val role: String,
    @SerialName("auto_generated") val autoGenerated: Boolean,
    /** Always null: EstimateLineItem carries no category. Kept so the column has a home. */
    val category: String?
)

@Serializable
data class RunRole(
    @SerialName("run_sync_id") val runSyncId: String,
    val role: String
)

@Serializable
data class RunName(
    @SerialName("run_sync_id") val runSyncId: String,
    val name: String
)

@Serializable
data class TotalsOutput(
    @SerialName("materials_subtotal") val materialsSubtotal: Double,
    @SerialName("taxable_subtotal") val taxableSubtotal: Double,
    val tax: Double,
    @SerialName("labor_cost") val laborCost: Double,
    @SerialName("teardown_cost") val teardownCost: Double,
    @SerialName("trash_haul_fee") val trashHaulFee: Double,
    @SerialName("gate_feet") val gateFeet: Double,
    @SerialName("gate_charge") val gateCharge: Double,
    @SerialName("change_order_cost") val changeOrderCost: Double,
    @SerialName("change_order_feet") val changeOrderFeet: Double,
    @SerialName("markup_amount") val markupAmount: Double,
    @SerialName("discount_amount") val discountAmount: Double,
    @SerialName("pre_markup_total") val preMarkupTotal: Double,
    @SerialName("grand_total") val grandTotal: Double,
    @SerialName("billable_linear_feet") val billableLinearFeet: Double
)

/* ---------------- fixture file ---------------- */

@Serializable
data class ParityFixture(
    val schema: Int,
    val engine: FixtureEngine,
    val case: String,
    /** Why the case exists -- what it pins. For whoever debugs a divergence. */
    val note: String,
    val input: PricingInput,
    val expected: PricingOutput
)

@Serializable
data class FixtureEngine(
    val version: String,
    @SerialName("generated_at") val generatedAt: String
)

@Serializable
data class ParityManifest(
    val version: String,
    @SerialName("generated_at") val generatedAt: String,
    @SerialName("case_count") val caseCount: Int
)
