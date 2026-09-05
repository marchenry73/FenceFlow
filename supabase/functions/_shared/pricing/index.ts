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
 * This file mirrors app/src/test/.../parity/PricingAdapters.kt
 * (PricingRunner.price), which is the one place every rule AROUND the engine
 * is written down: which scale the takeoff measures by, which runs get line
 * items, how prices carry over, which existing rows survive a regenerate,
 * and the order the totals sum in. The engine itself is the other files.
 *
 * Nothing here performs I/O. Every stage is a pure function so the Kotlin
 * fixtures can be replayed against it and the first divergent stage named.
 */
import { compareString, f32, sortedWith } from "./f32.ts";
import { trim } from "./kotlin-text.ts";
import { buildLineItems, carryOverPrices } from "./line-items.ts";
import { suggestQuantities } from "./takeoff.ts";
import type { EstimateSuggestions, TakeoffGroup } from "./takeoff.ts";
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
  /** job.calibration_pixels_per_foot ?? 20 (the EstimateViewModel / TakeoffRefresher fallback). Float. */
  pixels_per_foot: number;
  job: JobRow;
  /** fence_runs rows, non-deleted, in sort order. */
  runs: FenceRunRow[];
  /** material_items rows, active and inactive both (the engine filters). */
  catalog: MaterialItemRow[];
  /** The phone narrows on manufacturer ids; a sync id absent from this list resolves to "no manufacturer". */
  manufacturers: ManufacturerRow[];
  change_orders: ChangeOrderRow[];
  /** estimate_line_items rows already on the job: carry-over and survivors. */
  existing_items: LineItemRow[];
}

export interface SegmentOutput {
  from_index: number;
  to_index: number;
  /** Float. */
  length_ft: number;
}

export interface VertexOutput {
  index: number;
  kind: string;
  /** Float. */
  turn_degrees: number;
}

export interface GeometryOutput {
  corner_count: number;
  end_count: number;
  line_vertex_count: number;
  segments: SegmentOutput[];
  vertices: VertexOutput[];
}

export interface PostsOutput {
  line: number;
  corner: number;
  end: number;
  gate: number;
  terminal: number;
  total: number;
}

export interface EntryOutput {
  role: MaterialRole;
  quantity: number;
  prefer_covers_ft: number | null;
  covers_linear_ft: number | null;
}

export interface TakeoffLineOutput {
  label: string;
  quantity: number;
  unit: string;
  group: TakeoffGroup;
}

export interface RunOutput {
  run_sync_id: string;
  is_teardown: boolean;
  gate_count: number;
  /** Float. */
  gross_feet: number;
  /** Float. */
  gate_feet: number;
  /** Float. */
  net_feet: number;
  geometry: GeometryOutput;
  posts: PostsOutput;
  entries: EntryOutput[];
  takeoff: TakeoffLineOutput[];
}

export interface ItemOutput {
  sync_id: string;
  fence_run_sync_id: string;
  sort_order: number;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  supplier_unit_price: number | null;
  taxable: boolean;
  role: MaterialRole;
  auto_generated: boolean;
  /** Always null: EstimateLineItem carries no category. Kept so the column has a home. */
  category: null;
}

export interface RunRole {
  run_sync_id: string;
  role: MaterialRole;
}

export interface RunName {
  run_sync_id: string;
  name: string;
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
  /** Float. */
  billable_linear_feet: number;
}

export interface PricingOutput {
  engine_version: string;
  /** Float. */
  linear_feet: number;
  /** Float. */
  teardown_linear_feet: number;
  /** Float. */
  billable_linear_feet: number;
  /** Every run in runs[] order, teardown runs included. */
  runs: RunOutput[];
  /** The rows the engine would write, for every non-teardown run, in run order, after carry-over. */
  items: ItemOutput[];
  unmatched_roles: RunRole[];
  /** Sync ids of written rows whose catalog price is <= 0 (before carry-over). */
  zero_priced: string[];
  zero_priced_names: RunName[];
  /** Line-item sync ids in the order computeTotals summed them. */
  totals_items: string[];
  totals: TotalsOutput;
}

// ---------------------------------------------------------------------------
// Adapters: cloud rows -> the Kotlin shapes, exactly as PricingRunner builds
// them. Null fallbacks for the nullable money columns are the ones the
// phone's own pull (JobSync / EntitySync) applies to the same rows.
// ---------------------------------------------------------------------------

const num = (x: number | null | undefined, fallback: number): number => (x === null || x === undefined ? fallback : x);
const int = (x: number | null | undefined, fallback: number): number => Math.trunc(num(x, fallback));
const str = (x: string | null | undefined, fallback: string): string => (x === null || x === undefined ? fallback : x);
const bool = (x: boolean | null | undefined, fallback: boolean): boolean => (x === null || x === undefined ? fallback : x);

/**
 * A JSON number that is not exactly a float cannot have come from the
 * phone, and would price differently there. Refuse it rather than round --
 * PricingRunner.f32 does the same, so a value one engine rejects the other
 * rejects too. (NaN fails the equality, as it does on the JVM.)
 */
export function floatExact(value: number, field: string): number {
  const f = f32(value);
  if (f !== value) throw new Error(`${field} = ${value} is not representable as a Float (write it after fround)`);
  return f;
}

const flt = (x: number | null | undefined, fallback: number, field: string): number => floatExact(num(x, fallback), field);

/**
 * The phone narrows on manufacturer ids it has, and JobSync resolves a sync
 * id it has never seen to null. Here the ids ARE the sync ids, so "never
 * seen" is "not in manufacturers[]".
 */
function resolveManufacturer(syncId: string | null | undefined, known: ReadonlySet<string>): string | null {
  if (syncId === null || syncId === undefined) return null;
  return known.has(syncId) ? syncId : null;
}

export function jobFromRow(row: JobRow, manufacturerSyncIds: ReadonlySet<string>): Job {
  return {
    calibrationPixelsPerFoot: row.calibration_pixels_per_foot === null || row.calibration_pixels_per_foot === undefined
      ? null
      : floatExact(row.calibration_pixels_per_foot, "job.calibration_pixels_per_foot"),
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
    preferredManufacturerSyncId: resolveManufacturer(row.preferred_manufacturer_sync_id, manufacturerSyncIds),
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

export function runFromRow(row: FenceRunRow, index: number): FenceRun {
  const at = `runs[${index}]`;
  // Strict on purpose: a run row with a fence type the phone does not know
  // is not something either engine should price (FenceType.valueOf throws).
  const fenceType = enumValueOf(FENCE_TYPES, str(row.fence_type, ""));
  if (fenceType === null) throw new Error(`${at}.fence_type ${JSON.stringify(row.fence_type)} is not a FenceType`);
  return {
    syncId: row.sync_id,
    label: str(row.label, ""),
    fenceType,
    sortOrder: int(row.sort_order, 0),
    pointsEncoded: str(row.points_encoded, ""),
    gatesEncoded: str(row.gates_encoded, ""),
    closedLoop: bool(row.closed_loop, false),
    isTeardown: bool(row.is_teardown, false),
    colorOrFinish: str(row.color_or_finish, ""),
    panelWidthFt: flt(row.panel_width_ft, 6, `${at}.panel_width_ft`),
    panelHeightFt: flt(row.panel_height_ft, 6, `${at}.panel_height_ft`),
    // Not read by the engine; mapped the way the pull does (EntitySync) for completeness.
    aluminumStyle: enumValueOf(ALUMINUM_STYLES, str(row.aluminum_style, "RACKABLE")) ?? "RACKABLE",
    woodStyle: enumValueOf(WOOD_STYLES, str(row.wood_style, "PRIVACY")) ?? "PRIVACY",
    woodRailCount: int(row.wood_rail_count, 3),
    picketWidthIn: flt(row.picket_width_in, 5.5, `${at}.picket_width_in`),
    picketGapIn: flt(row.picket_gap_in, 0, `${at}.picket_gap_in`),
    fabricHeightFt: flt(row.fabric_height_ft, 4, `${at}.fabric_height_ft`),
    includeTopRail: bool(row.include_top_rail, true),
    includeTensionWire: bool(row.include_tension_wire, false),
    includeBarbedWireArms: bool(row.include_barbed_wire_arms, false),
    includePrivacySlats: bool(row.include_privacy_slats, false),
    splitRailCount: int(row.split_rail_count, 2),
    postSpacingFt: flt(row.post_spacing_ft, 6, `${at}.post_spacing_ft`),
    concreteBagsPerPost: flt(row.concrete_bags_per_post, 1, `${at}.concrete_bags_per_post`),
    manualLinearFeet: row.manual_linear_feet === null || row.manual_linear_feet === undefined
      ? null
      : floatExact(row.manual_linear_feet, `${at}.manual_linear_feet`),
    manualCornerCount: int(row.manual_corner_count, 0),
    suppressedRoles: parseSuppressedRoles(str(row.suppressed_roles, "")),
  };
}

/**
 * Catalog enums fall back exactly as the phone's pull does (EntitySync
 * material_items): an unknown role is NONE, category MISC, fence type
 * UNIVERSAL.
 */
export function materialItemFromRow(row: MaterialItemRow, index: number, manufacturerSyncIds: ReadonlySet<string>): MaterialItem {
  return {
    syncId: row.sync_id,
    category: str(row.category, "MISC"),
    role: enumValueOf(MATERIAL_ROLES, str(row.role, "NONE")) ?? "NONE",
    fenceType: enumValueOf(FENCE_TYPES, str(row.fence_type, "UNIVERSAL")) ?? "UNIVERSAL",
    name: str(row.name, ""),
    unit: str(row.unit, "EA"),
    unitPrice: num(row.unit_price, 0.0),
    taxable: bool(row.taxable, true),
    coversFt: row.covers_ft === null || row.covers_ft === undefined
      ? null
      : floatExact(row.covers_ft, `catalog[${index}].covers_ft`),
    colorOrFinish: str(row.color_or_finish, ""),
    manufacturerSyncId: resolveManufacturer(row.manufacturer_sync_id, manufacturerSyncIds),
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

/**
 * A row on a run this input does not carry is job-level as far as pricing
 * goes: nothing regenerates it and nothing removes it. So the run reference
 * survives only when it names one of runs[].
 */
export function lineItemFromRow(row: LineItemRow, runSyncIds: ReadonlySet<string>): EstimateLineItem {
  const runSyncId = row.fence_run_sync_id;
  return {
    syncId: row.sync_id,
    fenceRunSyncId: runSyncId !== null && runSyncId !== undefined && runSyncIds.has(runSyncId) ? runSyncId : null,
    sortOrder: int(row.sort_order, 0),
    description: str(row.description, ""),
    quantity: num(row.quantity, 0.0),
    unit: str(row.unit, "EA"),
    unitPrice: num(row.unit_price, 0.0),
    taxable: bool(row.taxable, true),
    // Same fallback as the pull: an unknown or missing role is NONE.
    role: (row.role === null || row.role === undefined ? null : enumValueOf(MATERIAL_ROLES, row.role)) ?? "NONE",
    isAutoGenerated: bool(row.auto_generated, false),
    supplierUnitPrice: row.supplier_unit_price === null || row.supplier_unit_price === undefined ? null : row.supplier_unit_price,
  };
}

/** `compareBy { it.sortOrder }` on an Int. */
function compareInt(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// The job, priced the way the phone prices it: every run's takeoff, the
// lines for the runs that get any, then the totals over what is left on the
// job afterwards.
// ---------------------------------------------------------------------------

export function priceJob(input: PricingInput): PricingOutput {
  if (input.engine_version !== PRICING_ENGINE_VERSION) {
    throw new Error(`input engine_version ${input.engine_version} != ${PRICING_ENGINE_VERSION}`);
  }

  const manufacturerSyncIds: ReadonlySet<string> = new Set(input.manufacturers.map((m) => m.sync_id));
  const job = jobFromRow(input.job, manufacturerSyncIds);
  const runs = input.runs.map(runFromRow);
  const catalog = input.catalog.map((row, i) => materialItemFromRow(row, i, manufacturerSyncIds));
  const changeOrders = input.change_orders.map(changeOrderFromRow);
  const runSyncIds: ReadonlySet<string> = new Set(runs.map((r) => r.syncId));
  const existing = input.existing_items.map((row) => lineItemFromRow(row, runSyncIds));

  // The scale the takeoff measures by. Typed footage ignores it; a drawn run
  // uses the job's calibration, or the grid's 20 px/ft when there is none
  // (EstimateViewModel.regenerateInternal, TakeoffRefresher). linearFeet()
  // below does NOT share this fallback -- an uncalibrated drawn run bills
  // zero labour feet while still getting materials -- and that asymmetry is
  // the phone's, so it is reproduced, not repaired.
  const pixelsPerFoot = floatExact(input.pixels_per_foot, "pixels_per_foot");

  const runOutputs: RunOutput[] = [];
  const writtenItems: EstimateLineItem[] = [];
  const unmatched: RunRole[] = [];
  const zeroPricedIds: string[] = [];
  const zeroPricedNames: RunName[] = [];

  for (const run of runs) {
    const suggestions = suggestQuantities(run, pixelsPerFoot, job.wastePercent);
    runOutputs.push(runOutput(run, suggestions));

    // A teardown run is the old fence: no bill of materials, and any it had
    // accumulated is cleared (TakeoffRefresher.refreshRun).
    if (run.isTeardown) continue;

    const built = buildLineItems(run, suggestions, catalog, job.preferredManufacturerSyncId);
    for (const role of built.unmatchedRoles) unmatched.push({ run_sync_id: run.syncId, role });
    for (const name of built.zeroPricedNames) zeroPricedNames.push({ run_sync_id: run.syncId, name });
    for (const item of built.items) if (item.unitPrice <= 0.0) zeroPricedIds.push(item.syncId);

    // Carry-over, exactly as TakeoffRefresher.refreshRun does it, matched on
    // the role of the rows THIS RUN already has.
    const existingForRun = existing.filter((e) => e.fenceRunSyncId === run.syncId);
    for (const item of carryOverPrices(built.items, existingForRun)) writtenItems.push(item);
  }

  // What is left on the job after the regenerate, and therefore what the
  // totals see. replaceGeneratedForRun deletes every roled row of the run --
  // edited ones included, since editing clears the auto flag -- and
  // hand-typed extras (role NONE) are left alone. Rows with no run are never
  // touched.
  const survivors = existing.filter((e) => e.role === "NONE" || e.fenceRunSyncId === null);

  // The phone sums whatever observeLineItems hands it, and that is
  // ORDER BY sortOrder ASC, syncId ASC. Floating-point sums depend on order,
  // so the office has to add the same rows in the same order.
  const itemsForTotals = sortedWith(
    writtenItems.concat(survivors),
    (a, b) => compareInt(a.sortOrder, b.sortOrder) || compareString(a.syncId, b.syncId),
  );

  const totalFeet = linearFeet(job, runs);
  const totals = computeTotals(job, itemsForTotals, totalFeet, changeOrders, runs);

  return {
    engine_version: PRICING_ENGINE_VERSION,
    linear_feet: totalFeet,
    teardown_linear_feet: teardownLinearFeet(job, runs),
    billable_linear_feet: totals.billableLinearFeet,
    runs: runOutputs,
    items: writtenItems.map((item) => ({
      sync_id: item.syncId,
      fence_run_sync_id: item.fenceRunSyncId as string,
      sort_order: item.sortOrder,
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unitPrice,
      supplier_unit_price: item.supplierUnitPrice,
      taxable: item.taxable,
      role: item.role,
      auto_generated: item.isAutoGenerated,
      category: null,
    })),
    unmatched_roles: unmatched,
    zero_priced: zeroPricedIds,
    zero_priced_names: zeroPricedNames,
    totals_items: itemsForTotals.map((i) => i.syncId),
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
      // Not on Totals; rebuilt from the six components it IS built from, in
      // the engine's own order (computeTotals, preMarkup).
      pre_markup_total: totals.materialsSubtotal + totals.tax + totals.laborCost +
        totals.teardownCost + totals.changeOrderCost + totals.gateCharge,
      grand_total: totals.grandTotal,
      billable_linear_feet: totals.billableLinearFeet,
    },
  };
}

function runOutput(run: FenceRun, s: EstimateSuggestions): RunOutput {
  // PostCounts is private to the engine on the phone; PricingRunner reads
  // every one of its figures back off the takeoff lines (zero lines are
  // dropped there, hence the 0), and so does this, so that a renamed label
  // fails the posts stage on both sides rather than one.
  const takeoffInt = (label: string): number => {
    const line = s.takeoff.find((t) => t.label === label);
    return line === undefined ? 0 : Math.trunc(line.quantity);
  };
  const line = takeoffInt("Line posts");
  const corner = takeoffInt("Corner posts");
  const end = takeoffInt("End posts");
  const gate = takeoffInt("Gate posts (end posts + stiffener)");

  return {
    run_sync_id: run.syncId,
    is_teardown: run.isTeardown,
    gate_count: s.gates.length,
    gross_feet: s.geometry.totalLinearFeet,
    gate_feet: s.gateWidthTotal,
    net_feet: s.netLinearFeet,
    geometry: {
      corner_count: s.geometry.cornerCount,
      end_count: s.geometry.endCount,
      line_vertex_count: s.geometry.lineVertexCount,
      segments: s.geometry.segments.map((seg) => ({ from_index: seg.fromIndex, to_index: seg.toIndex, length_ft: seg.lengthFt })),
      vertices: s.geometry.vertices.map((v) => ({ index: v.index, kind: v.kind, turn_degrees: v.turnDegrees })),
    },
    posts: {
      line,
      corner,
      end,
      gate,
      terminal: corner + end + gate,
      total: takeoffInt("Total posts"),
    },
    entries: s.entries.map((e) => ({
      role: e.role,
      quantity: e.quantity,
      prefer_covers_ft: e.preferCoversFt,
      covers_linear_ft: e.coversLinearFt,
    })),
    takeoff: s.takeoff.map((t) => ({ label: t.label, quantity: t.quantity, unit: t.unit, group: t.group })),
  };
}
