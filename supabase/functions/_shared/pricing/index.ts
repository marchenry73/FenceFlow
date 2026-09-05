/**
 * The server copy of the phone's pricing engine.
 *
 * `priceJob` takes one PricingInput -- the snake_case rows exactly as
 * CloudJob, CloudFenceRun, CloudMaterialItem and CloudLineItem serialise
 * them (docs/PRICING_CONTRACT.md) -- and returns one PricingOutput. It is
 * used ONLY by the `price-job` edge function and by the fixture replay in
 * parity.ts. The office dashboard never gains a formula: two formulas is how
 * the office and the phone once disagreed about the same job.
 *
 * Nothing here performs I/O. Every stage is a pure function so the Kotlin
 * fixtures can be replayed against it and the first divergent stage named.
 */
import { f32 } from "./f32.ts";
import { trim } from "./kotlin-text.ts";
import { buildLineItems, carryOverPrices } from "./line-items.ts";
import type { BuiltLineItem } from "./line-items.ts";
import { suggestQuantities } from "./takeoff.ts";
import { computeTotals, linearFeet, teardownLinearFeet } from "./totals.ts";
import { ALUMINUM_STYLES, FENCE_TYPES, MATERIAL_ROLES, WOOD_STYLES, enumValueOf } from "./types.ts";
import type { ChangeOrder, EstimateLineItem, FenceRun, Job, MaterialItem, MaterialRole } from "./types.ts";

export {
  buildLineItems, carryOverPrices, computeTotals, linearFeet, suggestQuantities, teardownLinearFeet,
};

/**
 * Bumped, on BOTH engines and in the regenerated fixture manifest, whenever
 * a pricing rule changes. A mismatch between the two engines, or between an
 * engine and the fixtures, is a red parity gate; at runtime it is what lets
 * a phone tell that the office priced a job with newer rules.
 */
export const PRICING_ENGINE_VERSION = "2026.09.1";

// ---------------------------------------------------------------------------
// Contract shapes (docs/PRICING_CONTRACT.md). Column names, never invented.
// ---------------------------------------------------------------------------

export interface JobRow {
  calibration_pixels_per_foot: number | null;
  tax_rate_percent: number;
  markup_percent: number;
  discount_percent: number;
  labor_rate_per_ft: number;
  labor_flat_fee: number;
  minimum_job_charge: number | null;
  waste_percent: number;
  gate_rate_per_ft: number | null;
  trash_haul_fee: number | null;
  teardown_enabled: boolean;
  teardown_flat_fee: number;
  teardown_rate_per_ft: number;
  teardown_feet: number;
  preferred_manufacturer_sync_id: string | null;
}

export interface FenceRunRow {
  sync_id: string;
  label: string;
  fence_type: string;
  color_or_finish: string;
  points_encoded: string;
  gates_encoded: string;
  closed_loop: boolean;
  manual_linear_feet: number | null;
  manual_corner_count: number;
  panel_width_ft: number;
  panel_height_ft: number;
  post_spacing_ft: number;
  concrete_bags_per_post: number;
  aluminum_style: string;
  wood_style: string;
  wood_rail_count: number;
  picket_width_in: number;
  picket_gap_in: number;
  fabric_height_ft: number;
  include_top_rail: boolean;
  include_tension_wire: boolean;
  include_barbed_wire_arms: boolean;
  include_privacy_slats: boolean;
  split_rail_count: number;
  suppressed_roles: string;
  is_teardown: boolean;
  sort_order: number;
}

export interface MaterialItemRow {
  sync_id: string;
  name: string;
  category: string;
  role: string;
  fence_type: string;
  color_or_finish: string;
  unit: string;
  unit_price: number;
  /** Not a Kotlin field; accepted because the contract lists it, never read. */
  supplier_unit_price?: number | null;
  taxable: boolean;
  covers_ft: number | null;
  is_active: boolean;
  manufacturer_sync_id: string | null;
}

export interface ManufacturerRow {
  sync_id: string;
  name: string;
}

export interface ChangeOrderRow {
  sync_id: string;
  additional_feet: number;
  additional_cost: number;
  material_cost: number;
}

export interface LineItemRow {
  sync_id: string;
  fence_run_sync_id: string | null;
  role: string | null;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  supplier_unit_price: number | null;
  taxable: boolean;
  auto_generated: boolean;
  sort_order: number;
}

export interface PricingInput {
  engine_version: string;
  /** job.calibration_pixels_per_foot ?? 20 (the EstimateViewModel fallback). Float. */
  pixels_per_foot: number;
  job: JobRow;
  /** fence_runs rows, non-deleted, in sort order. */
  runs: FenceRunRow[];
  /** material_items rows, active and inactive both (the engine filters). */
  catalog: MaterialItemRow[];
  /** Accepted for the contract's sake; the engine matches manufacturers by sync id and never needs the name. */
  manufacturers: ManufacturerRow[];
  change_orders: ChangeOrderRow[];
  /** estimate_line_items rows already on the job, for hand-edited price carry-over. */
  existing_items: LineItemRow[];
}

export interface RunOutput {
  run_sync_id: string;
  gross_feet: number;
  gate_feet: number;
  net_feet: number;
  geometry: { corner_count: number; end_count: number; line_vertex_count: number };
  posts: { line: number; corner: number; end: number; gate: number; terminal: number; total: number };
  entries: Array<{ role: MaterialRole; quantity: number; prefer_covers_ft: number | null; covers_linear_ft: number | null }>;
}

export interface ItemOutput {
  sync_id: string;
  fence_run_sync_id: string | null;
  sort_order: number;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  supplier_unit_price: number | null;
  taxable: boolean;
  role: MaterialRole;
  auto_generated: boolean;
  category: string;
}

export interface TotalsOutput {
  materials_subtotal: number;
  taxable_subtotal: number;
  tax: number;
  labor_cost: number;
  teardown_cost: number;
  trash_haul_fee: number;
  gate_feet: number;
  gate_charge: number;
  change_order_cost: number;
  change_order_feet: number;
  markup_amount: number;
  discount_amount: number;
  pre_markup_total: number;
  grand_total: number;
}

export interface PricingOutput {
  engine_version: string;
  linear_feet: number;
  teardown_linear_feet: number;
  billable_linear_feet: number;
  runs: RunOutput[];
  items: ItemOutput[];
  unmatched_roles: Array<{ run_sync_id: string; role: MaterialRole }>;
  zero_priced: string[];
  totals: TotalsOutput;
}

// ---------------------------------------------------------------------------
// Adapters: cloud rows -> the Kotlin shapes. Fallbacks are the ones the
// phone's own pull (EntitySync / JobSync) applies to the same rows, so a
// row the phone would read one way is read the same way here.
// ---------------------------------------------------------------------------

const num = (x: number | null | undefined, fallback: number): number => (x === null || x === undefined ? fallback : x);
const int = (x: number | null | undefined, fallback: number): number => Math.trunc(num(x, fallback));
const flt = (x: number | null | undefined, fallback: number): number => f32(num(x, fallback));
const str = (x: string | null | undefined, fallback: string): string => (x === null || x === undefined ? fallback : x);
const bool = (x: boolean | null | undefined, fallback: boolean): boolean => (x === null || x === undefined ? fallback : x);

export function jobFromRow(row: JobRow): Job {
  return {
    calibrationPixelsPerFoot: row.calibration_pixels_per_foot === null || row.calibration_pixels_per_foot === undefined
      ? null
      : f32(row.calibration_pixels_per_foot),
    taxRatePercent: num(row.tax_rate_percent, 0.0),
    markupPercent: num(row.markup_percent, 0.0),
    laborRatePerFt: num(row.labor_rate_per_ft, 0.0),
    laborFlatFee: num(row.labor_flat_fee, 0.0),
    discountPercent: num(row.discount_percent, 0.0),
    // JobSync's fresh-pull defaults for the three nullable money columns.
    minimumJobCharge: num(row.minimum_job_charge, 0.0),
    wastePercent: num(row.waste_percent, 0.0),
    gateRatePerFt: num(row.gate_rate_per_ft, 20.0),
    trashHaulFee: num(row.trash_haul_fee, 0.0),
    teardownEnabled: bool(row.teardown_enabled, false),
    teardownFlatFee: num(row.teardown_flat_fee, 0.0),
    teardownRatePerFt: num(row.teardown_rate_per_ft, 0.0),
    teardownFeet: num(row.teardown_feet, 0.0),
    preferredManufacturerSyncId: str(row.preferred_manufacturer_sync_id, "") || null,
  };
}

/**
 * FenceRun.suppressedRoles: the CSV split on commas, each name trimmed and
 * looked up; anything that is not a role is dropped, as runCatching drops it.
 */
export function parseSuppressedRoles(csv: string): Set<MaterialRole> {
  const roles = new Set<MaterialRole>();
  for (const name of csv.split(",")) {
    const role = enumValueOf(MATERIAL_ROLES, trim(name));
    if (role !== null) roles.add(role);
  }
  return roles;
}

export function runFromRow(row: FenceRunRow): FenceRun {
  return {
    syncId: row.sync_id,
    label: str(row.label, ""),
    fenceType: enumValueOf(FENCE_TYPES, str(row.fence_type, "VINYL")) ?? "VINYL",
    sortOrder: int(row.sort_order, 0),
    pointsEncoded: str(row.points_encoded, ""),
    gatesEncoded: str(row.gates_encoded, ""),
    closedLoop: bool(row.closed_loop, false),
    isTeardown: bool(row.is_teardown, false),
    colorOrFinish: str(row.color_or_finish, ""),
    panelWidthFt: flt(row.panel_width_ft, 6),
    panelHeightFt: flt(row.panel_height_ft, 6),
    aluminumStyle: enumValueOf(ALUMINUM_STYLES, str(row.aluminum_style, "RACKABLE")) ?? "RACKABLE",
    woodStyle: enumValueOf(WOOD_STYLES, str(row.wood_style, "PRIVACY")) ?? "PRIVACY",
    woodRailCount: int(row.wood_rail_count, 3),
    picketWidthIn: flt(row.picket_width_in, 5.5),
    picketGapIn: flt(row.picket_gap_in, 0),
    fabricHeightFt: flt(row.fabric_height_ft, 4),
    includeTopRail: bool(row.include_top_rail, true),
    includeTensionWire: bool(row.include_tension_wire, false),
    includeBarbedWireArms: bool(row.include_barbed_wire_arms, false),
    includePrivacySlats: bool(row.include_privacy_slats, false),
    splitRailCount: int(row.split_rail_count, 2),
    postSpacingFt: flt(row.post_spacing_ft, 6),
    concreteBagsPerPost: flt(row.concrete_bags_per_post, 1),
    manualLinearFeet: row.manual_linear_feet === null || row.manual_linear_feet === undefined ? null : f32(row.manual_linear_feet),
    manualCornerCount: int(row.manual_corner_count, 0),
    suppressedRoles: parseSuppressedRoles(str(row.suppressed_roles, "")),
  };
}

export function materialItemFromRow(row: MaterialItemRow): MaterialItem {
  return {
    syncId: row.sync_id,
    category: str(row.category, "MISC"),
    role: enumValueOf(MATERIAL_ROLES, str(row.role, "NONE")) ?? "NONE",
    fenceType: enumValueOf(FENCE_TYPES, str(row.fence_type, "UNIVERSAL")) ?? "UNIVERSAL",
    name: str(row.name, ""),
    unit: str(row.unit, "EA"),
    unitPrice: num(row.unit_price, 0.0),
    taxable: bool(row.taxable, true),
    coversFt: row.covers_ft === null || row.covers_ft === undefined ? null : f32(row.covers_ft),
    colorOrFinish: str(row.color_or_finish, ""),
    manufacturerSyncId: str(row.manufacturer_sync_id, "") || null,
    isActive: bool(row.is_active, true),
  };
}

export function changeOrderFromRow(row: ChangeOrderRow): ChangeOrder {
  return {
    syncId: row.sync_id,
    additionalFeet: num(row.additional_feet, 0.0),
    additionalCost: num(row.additional_cost, 0.0),
    materialCost: num(row.material_cost, 0.0),
  };
}

export function lineItemFromRow(row: LineItemRow): EstimateLineItem {
  return {
    syncId: row.sync_id,
    fenceRunSyncId: str(row.fence_run_sync_id, "") || null,
    sortOrder: int(row.sort_order, 0),
    description: str(row.description, ""),
    quantity: num(row.quantity, 0.0),
    unit: str(row.unit, "EA"),
    unitPrice: num(row.unit_price, 0.0),
    taxable: bool(row.taxable, true),
    role: (row.role === null || row.role === undefined ? null : enumValueOf(MATERIAL_ROLES, row.role)) ?? "NONE",
    isAutoGenerated: bool(row.auto_generated, false),
    supplierUnitPrice: row.supplier_unit_price === null || row.supplier_unit_price === undefined ? null : row.supplier_unit_price,
  };
}

// ---------------------------------------------------------------------------
// The job, priced the way the phone prices it: every run's takeoff and
// lines, then the totals over the lines that were just built.
// ---------------------------------------------------------------------------

export function priceJob(input: PricingInput): PricingOutput {
  const job = jobFromRow(input.job);
  const runs = input.runs.map(runFromRow);
  const catalog = input.catalog.map(materialItemFromRow);
  const changeOrders = input.change_orders.map(changeOrderFromRow);
  const existing = input.existing_items.map(lineItemFromRow);
  const pixelsPerFoot = f32(input.pixels_per_foot);

  const runOutputs: RunOutput[] = [];
  const items: BuiltLineItem[] = [];
  const unmatched: Array<{ run_sync_id: string; role: MaterialRole }> = [];
  const zeroPriced: string[] = [];

  for (const run of runs) {
    // A teardown run is the OLD fence. Nobody is buying panels for it --
    // its cost is the teardown charge, not a bill of materials
    // (TakeoffRefresher clears its auto lines rather than building any).
    if (run.isTeardown) continue;

    const suggestions = suggestQuantities(run, pixelsPerFoot, job.wastePercent);
    const built = buildLineItems(run, suggestions, catalog, job.preferredManufacturerSyncId);
    const finalItems = carryOverPrices(built.items, existing.filter((e) => e.fenceRunSyncId === run.syncId));

    runOutputs.push({
      run_sync_id: run.syncId,
      gross_feet: suggestions.geometry.totalLinearFeet,
      gate_feet: suggestions.gateWidthTotal,
      net_feet: suggestions.netLinearFeet,
      geometry: {
        corner_count: suggestions.geometry.cornerCount,
        end_count: suggestions.geometry.endCount,
        line_vertex_count: suggestions.geometry.lineVertexCount,
      },
      posts: {
        line: suggestions.postCounts.linePosts,
        corner: suggestions.postCounts.cornerPosts,
        end: suggestions.postCounts.endPosts,
        gate: suggestions.postCounts.gatePosts,
        terminal: suggestions.postCounts.terminalPosts,
        total: suggestions.postCounts.totalPosts,
      },
      entries: suggestions.entries.map((e) => ({
        role: e.role,
        quantity: e.quantity,
        prefer_covers_ft: e.preferCoversFt,
        covers_linear_ft: e.coversLinearFt,
      })),
    });
    for (const item of finalItems) items.push(item);
    for (const role of built.unmatchedRoles) unmatched.push({ run_sync_id: run.syncId, role });
    for (const id of built.zeroPricedSyncIds) zeroPriced.push(id);
  }

  const totalFeet = linearFeet(job, runs);
  const totals = computeTotals(job, items, totalFeet, changeOrders, runs);

  return {
    engine_version: PRICING_ENGINE_VERSION,
    linear_feet: totalFeet,
    teardown_linear_feet: teardownLinearFeet(job, runs),
    billable_linear_feet: totals.billableLinearFeet,
    runs: runOutputs,
    items: items.map((item) => ({
      sync_id: item.syncId,
      fence_run_sync_id: item.fenceRunSyncId,
      sort_order: item.sortOrder,
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unitPrice,
      supplier_unit_price: item.supplierUnitPrice,
      taxable: item.taxable,
      role: item.role,
      auto_generated: item.isAutoGenerated,
      category: item.category,
    })),
    unmatched_roles: unmatched,
    zero_priced: zeroPriced,
    totals: {
      materials_subtotal: totals.materialsSubtotal,
      taxable_subtotal: totals.taxableSubtotal,
      tax: totals.tax,
      labor_cost: totals.laborCost,
      teardown_cost: totals.teardownCost,
      trash_haul_fee: totals.trashHaulFee,
      gate_feet: totals.gateFeet,
      gate_charge: totals.gateCharge,
      change_order_cost: totals.changeOrderCost,
      change_order_feet: totals.changeOrderFeet,
      markup_amount: totals.markupAmount,
      discount_amount: totals.discountAmount,
      pre_markup_total: totals.preMarkup,
      grand_total: totals.grandTotal,
    },
  };
}
