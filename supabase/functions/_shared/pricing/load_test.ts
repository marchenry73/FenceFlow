/**
 * Hand-built rows through load.ts's row <-> contract mapping.
 *
 * No test framework, matching smoke.ts and parity.ts: this runs under both
 *   npx -y tsx supabase/functions/_shared/pricing/load_test.ts
 *   deno run -A supabase/functions/_shared/pricing/load_test.ts
 *
 * This is NOT the parity gate -- it never calls priceJob and knows nothing
 * about fence geometry or money. It exists so the boundary the edge function
 * stands on (database rows in, PricingInput out; PricingOutput in, database
 * rows out) can be checked without a database, an HTTP request, or a caller
 * JWT anywhere in the loop.
 */
import process from "node:process";
import {
  buildCommitPlan,
  buildPricingInput,
  buildSampleRun,
  changeOrderRowToInput,
  fenceRunRowToInput,
  isStale,
  jobRowToInput,
  lineItemRowToInput,
  manufacturerRowToInput,
  materialItemRowToInput,
} from "./load.ts";
import type {
  DbBuildTemplateRow,
  DbChangeOrderRow,
  DbFenceRunRow,
  DbJobRow,
  DbLineItemRow,
  DbManufacturerRow,
  DbMaterialItemRow,
} from "./load.ts";
import type { ItemOutput, PricingOutput } from "./index.ts";

let failures = 0;
let checks = 0;

function describe(v: unknown): string {
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
  return JSON.stringify(v) ?? String(v);
}

function check(name: string, actual: unknown, expected: unknown): void {
  checks++;
  const same = typeof actual === "number" && typeof expected === "number"
    ? Object.is(actual, expected)
    : JSON.stringify(actual) === JSON.stringify(expected);
  if (!same) {
    failures++;
    console.log(`FAIL ${name}\n     expected ${describe(expected)}\n     actual   ${describe(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures: minimal rows, exactly the columns price-job selects.
// ---------------------------------------------------------------------------

function jobRow(overrides: Partial<DbJobRow> = {}): DbJobRow {
  return {
    sync_id: "job-1",
    updated_at: "2026-09-04T12:00:00Z",
    calibration_pixels_per_foot: null,
    tax_rate_percent: 7,
    markup_percent: 0,
    discount_percent: 0,
    labor_rate_per_ft: 8,
    labor_flat_fee: 0,
    minimum_job_charge: 200,
    waste_percent: 0,
    gate_rate_per_ft: 20,
    trash_haul_fee: 0,
    teardown_enabled: false,
    teardown_flat_fee: 0,
    teardown_rate_per_ft: 0,
    teardown_feet: 0,
    preferred_manufacturer_sync_id: null,
    ...overrides,
  };
}

function runRow(sync_id: string, overrides: Partial<DbFenceRunRow> = {}): DbFenceRunRow {
  return {
    sync_id,
    label: "Back",
    fence_type: "VINYL",
    color_or_finish: "White",
    points_encoded: "",
    gates_encoded: "",
    closed_loop: false,
    manual_linear_feet: 100,
    manual_corner_count: 0,
    panel_width_ft: 6,
    panel_height_ft: 6,
    post_spacing_ft: 6,
    concrete_bags_per_post: 1,
    aluminum_style: "RACKABLE",
    wood_style: "PRIVACY",
    wood_rail_count: 3,
    picket_width_in: 5.5,
    picket_gap_in: 0,
    fabric_height_ft: 4,
    include_top_rail: true,
    include_tension_wire: false,
    include_barbed_wire_arms: false,
    include_privacy_slats: false,
    split_rail_count: 2,
    suppressed_roles: "",
    is_teardown: false,
    sort_order: 0,
    ...overrides,
  };
}

function catalogRow(sync_id: string, overrides: Partial<DbMaterialItemRow> = {}): DbMaterialItemRow {
  return {
    sync_id, name: sync_id, category: "MISC", role: "PANEL", fence_type: "VINYL",
    color_or_finish: "White", unit: "EA", unit_price: 52.35, taxable: true,
    covers_ft: 6, manufacturer_sync_id: null, is_active: true,
    ...overrides,
  };
}

function lineItemRow(sync_id: string, overrides: Partial<DbLineItemRow> = {}): DbLineItemRow {
  return {
    sync_id, fence_run_sync_id: "run-1", role: "PANEL", description: "Panel",
    quantity: 10, unit: "EA", unit_price: 52.35, supplier_unit_price: null,
    taxable: true, auto_generated: true, sort_order: 0,
    ...overrides,
  };
}

function templateRow(overrides: Partial<DbBuildTemplateRow> = {}): DbBuildTemplateRow {
  return {
    sync_id: "00000000-0000-4000-8000-000000000001",
    name: "Vinyl privacy 6 ft",
    fence_type: "VINYL",
    color_or_finish: "White",
    panel_width_ft: 6, panel_height_ft: 6, post_spacing_ft: 6, concrete_bags_per_post: 1,
    aluminum_style: "RACKABLE", wood_style: "PRIVACY", wood_rail_count: 3,
    picket_width_in: 5.5, picket_gap_in: 0, fabric_height_ft: 4,
    include_top_rail: true, include_tension_wire: false, include_barbed_wire_arms: false,
    include_privacy_slats: false, split_rail_count: 2,
    ...overrides,
  };
}

function itemOutput(overrides: Partial<ItemOutput> = {}): ItemOutput {
  return {
    sync_id: "item-1", fence_run_sync_id: "run-1", sort_order: 0, description: "Panel",
    quantity: 10, unit: "EA", unit_price: 52.35, supplier_unit_price: null,
    taxable: true, role: "PANEL", auto_generated: true, category: null,
    ...overrides,
  };
}

function totals(overrides: Partial<PricingOutput["totals"]> = {}): PricingOutput["totals"] {
  return {
    materials_subtotal: 0, taxable_subtotal: 0, tax: 0, labor_cost: 0, teardown_cost: 0,
    trash_haul_fee: 0, gate_feet: 0, gate_charge: 0, change_order_cost: 0, change_order_feet: 0,
    markup_amount: 0, discount_amount: 0, pre_markup_total: 0, grand_total: 0, billable_linear_feet: 0,
    ...overrides,
  };
}

function output(items: ItemOutput[], overrides: Partial<PricingOutput> = {}): PricingOutput {
  return {
    engine_version: "2026.09.1", linear_feet: 100, teardown_linear_feet: 0, billable_linear_feet: 100,
    runs: [], items, unmatched_roles: [], zero_priced: [], zero_priced_names: [],
    totals_items: items.map((i) => i.sync_id), totals: totals(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// jobRowToInput
// ---------------------------------------------------------------------------

check("jobRowToInput: null calibration passes through as null, not omitted",
  "calibration_pixels_per_foot" in jobRowToInput(jobRow()), true);
check("jobRowToInput: null calibration value", jobRowToInput(jobRow()).calibration_pixels_per_foot, null);
check("jobRowToInput: calibration fround'd", jobRowToInput(jobRow({ calibration_pixels_per_foot: 19.1 })).calibration_pixels_per_foot, Math.fround(19.1));
check("jobRowToInput: nullable money stays null, not defaulted here",
  jobRowToInput(jobRow({ minimum_job_charge: null, gate_rate_per_ft: null, trash_haul_fee: null })),
  { ...jobRowToInput(jobRow()), minimum_job_charge: null, gate_rate_per_ft: null, trash_haul_fee: null });
check("jobRowToInput: preferred manufacturer null default", jobRowToInput(jobRow()).preferred_manufacturer_sync_id, null);
check("jobRowToInput: preferred manufacturer passthrough", jobRowToInput(jobRow({ preferred_manufacturer_sync_id: "mfr-1" })).preferred_manufacturer_sync_id, "mfr-1");

// ---------------------------------------------------------------------------
// fenceRunRowToInput
// ---------------------------------------------------------------------------

{
  const mapped = fenceRunRowToInput(runRow("run-1", { panel_width_ft: 6.1, post_spacing_ft: 6.1 }));
  check("fenceRunRowToInput: Float fields fround'd", [mapped.panel_width_ft, mapped.post_spacing_ft], [Math.fround(6.1), Math.fround(6.1)]);
  check("fenceRunRowToInput: sync id and label passthrough", [mapped.sync_id, mapped.label], ["run-1", "Back"]);
}
check("fenceRunRowToInput: manual_linear_feet null stays null", fenceRunRowToInput(runRow("r", { manual_linear_feet: null })).manual_linear_feet, null);
check("fenceRunRowToInput: manual_linear_feet fround'd when set", fenceRunRowToInput(runRow("r", { manual_linear_feet: 143.55 })).manual_linear_feet, Math.fround(143.55));

// ---------------------------------------------------------------------------
// materialItemRowToInput / manufacturerRowToInput / changeOrderRowToInput / lineItemRowToInput
// ---------------------------------------------------------------------------

check("materialItemRowToInput: covers_ft fround'd", materialItemRowToInput(catalogRow("c", { covers_ft: 6.1 })).covers_ft, Math.fround(6.1));
check("materialItemRowToInput: covers_ft null stays null", materialItemRowToInput(catalogRow("c", { covers_ft: null })).covers_ft, null);
check("materialItemRowToInput: manufacturer null default", materialItemRowToInput(catalogRow("c")).manufacturer_sync_id, null);

const mfr: DbManufacturerRow = { sync_id: "m-1", name: "Acme" };
check("manufacturerRowToInput: passthrough", manufacturerRowToInput(mfr), { sync_id: "m-1", name: "Acme" });

const co: DbChangeOrderRow = { sync_id: "co-1", additional_feet: 10, additional_cost: 500, material_cost: 100 };
check("changeOrderRowToInput: passthrough (Double, no fround)", changeOrderRowToInput(co), co);

check("lineItemRowToInput: passthrough shape", lineItemRowToInput(lineItemRow("li-1")), lineItemRow("li-1"));

// ---------------------------------------------------------------------------
// buildPricingInput
// ---------------------------------------------------------------------------

{
  const input = buildPricingInput({
    job: jobRow(),
    runs: [runRow("run-1"), runRow("run-2", { sort_order: 1 })],
    catalog: [catalogRow("c-1")],
    manufacturers: [mfr],
    changeOrders: [co],
    existingItems: [lineItemRow("li-1")],
    engineVersion: "2026.09.1",
  });
  check("buildPricingInput: engine_version carried", input.engine_version, "2026.09.1");
  check("buildPricingInput: pixels_per_foot falls back to 20 when uncalibrated", input.pixels_per_foot, 20);
  check("buildPricingInput: run order preserved", input.runs.map((r) => r.sync_id), ["run-1", "run-2"]);
  check("buildPricingInput: catalog/manufacturers/change_orders/existing_items all carried",
    [input.catalog.length, input.manufacturers.length, input.change_orders.length, input.existing_items.length],
    [1, 1, 1, 1]);
}
{
  const input = buildPricingInput({
    job: jobRow({ calibration_pixels_per_foot: 24.4 }),
    runs: [], catalog: [], manufacturers: [], changeOrders: [], existingItems: [],
    engineVersion: "2026.09.1",
  });
  check("buildPricingInput: pixels_per_foot uses the job's own calibration, fround'd", input.pixels_per_foot, Math.fround(24.4));
}

// ---------------------------------------------------------------------------
// buildSampleRun
// ---------------------------------------------------------------------------

{
  const run = buildSampleRun(templateRow(), 150.5, "sample-run-1");
  check("buildSampleRun: sync id is the one handed in", run.sync_id, "sample-run-1");
  check("buildSampleRun: typed footage fround'd", run.manual_linear_feet, Math.fround(150.5));
  check("buildSampleRun: open run, no gates, no drawing", [run.closed_loop, run.gates_encoded, run.points_encoded], [false, "", ""]);
  check("buildSampleRun: no corners assumed for typed footage", run.manual_corner_count, 0);
  check("buildSampleRun: spec copied from the template", [run.fence_type, run.panel_width_ft, run.wood_style], ["VINYL", 6, "PRIVACY"]);
  check("buildSampleRun: label is the template's name", run.label, "Vinyl privacy 6 ft");
  check("buildSampleRun: nothing suppressed, not a teardown", [run.suppressed_roles, run.is_teardown], ["", false]);
}
{
  const run = buildSampleRun(templateRow({ panel_width_ft: 8.1, fence_type: "WOOD" }), 10, "s2");
  check("buildSampleRun: Float spec fields fround'd too", run.panel_width_ft, Math.fround(8.1));
}

// ---------------------------------------------------------------------------
// isStale
// ---------------------------------------------------------------------------

check("isStale: no expected_updated_at never blocks", isStale("2026-09-04T12:00:00Z", undefined), false);
check("isStale: null never blocks", isStale("2026-09-04T12:00:00Z", null), false);
check("isStale: empty string never blocks", isStale("2026-09-04T12:00:00Z", ""), false);
check("isStale: identical strings match", isStale("2026-09-04T12:00:00Z", "2026-09-04T12:00:00Z"), false);
check("isStale: same instant, different text, is not stale", isStale("2026-09-04T12:00:00Z", "2026-09-04T12:00:00.000+00:00"), false);
check("isStale: a genuinely different time is stale", isStale("2026-09-04T12:00:00Z", "2026-09-04T11:59:59Z"), true);
check("isStale: an unparsable expected value cannot be proven fresh", isStale("2026-09-04T12:00:00Z", "not a date"), true);
check("isStale: an unparsable actual value cannot be proven fresh either", isStale("not a date", "2026-09-04T12:00:00Z"), true);

// ---------------------------------------------------------------------------
// buildCommitPlan
// ---------------------------------------------------------------------------

{
  // A run that used to have a PANEL and a hand-typed extra (role NONE), plus
  // a job-level line with no run at all. The regenerate keeps the same PANEL
  // sync id (carried over), drops a CONCRETE_BAG that no longer matches
  // anything, and must never touch the NONE row or the job-level row.
  const existing: DbLineItemRow[] = [
    lineItemRow("panel-1", { fence_run_sync_id: "run-1", role: "PANEL" }),
    lineItemRow("bag-1", { fence_run_sync_id: "run-1", role: "CONCRETE_BAG" }),
    lineItemRow("extra-1", { fence_run_sync_id: "run-1", role: "NONE", auto_generated: false }),
    lineItemRow("joblevel-1", { fence_run_sync_id: null, role: "PANEL" }),
    lineItemRow("otherrun-1", { fence_run_sync_id: "run-2", role: "PANEL" }),
  ];
  const plan = buildCommitPlan({
    output: output([itemOutput({ sync_id: "panel-1", fence_run_sync_id: "run-1" })]),
    companyId: "company-1",
    jobSyncId: "job-1",
    pricedRunSyncIds: ["run-1"],
    existingItems: existing,
    nowIso: "2026-09-05T00:00:00Z",
  });
  check("buildCommitPlan: tombstones the dropped role, nothing else", plan.tombstoneSyncIds, ["bag-1"]);
  check("buildCommitPlan: upserts exactly the output rows", plan.upsertItems.map((i) => i.sync_id), ["panel-1"]);
  check("buildCommitPlan: upserted row carries company/job ids and resets the tombstone", plan.upsertItems[0], {
    company_id: "company-1", sync_id: "panel-1", job_sync_id: "job-1", fence_run_sync_id: "run-1",
    sort_order: 0, description: "Panel", quantity: 10, unit: "EA", unit_price: 52.35,
    supplier_unit_price: null, taxable: true, role: "PANEL", auto_generated: true,
    deleted_at: null, deleted_by: "",
  });
  check("buildCommitPlan: job patch", plan.jobPatch, {
    contract_total: 0, priced_by: "OFFICE", priced_at: "2026-09-05T00:00:00Z", pricing_engine_version: "2026.09.1",
  });
}
{
  // A teardown run: it never produces items, so every roled row of it
  // tombstones -- TakeoffRefresher's "marking a run teardown clears its
  // materials", reproduced without any special case in buildCommitPlan.
  const existing: DbLineItemRow[] = [
    lineItemRow("old-panel-1", { fence_run_sync_id: "teardown-1", role: "PANEL" }),
  ];
  const plan = buildCommitPlan({
    output: output([]), companyId: "co", jobSyncId: "job-1",
    pricedRunSyncIds: ["teardown-1"], existingItems: existing, nowIso: "now",
  });
  check("buildCommitPlan: teardown run's materials all tombstone", plan.tombstoneSyncIds, ["old-panel-1"]);
}
{
  // An existing row naming a run this call did NOT price is left alone --
  // should never happen in practice (dry_run/commit always price every
  // non-deleted run) but the function's own rule must still hold.
  const existing: DbLineItemRow[] = [
    lineItemRow("stale-run-row", { fence_run_sync_id: "run-not-priced", role: "PANEL" }),
  ];
  const plan = buildCommitPlan({
    output: output([]), companyId: "co", jobSyncId: "job-1",
    pricedRunSyncIds: ["run-1"], existingItems: existing, nowIso: "now",
  });
  check("buildCommitPlan: a row on an unpriced run is never tombstoned", plan.tombstoneSyncIds, []);
}
{
  // A legacy/unrecognised role string must fall back to NONE exactly as the
  // engine's own lineItemFromRow does, or this function would tombstone a
  // row the engine's survivor check would have kept.
  const existing: DbLineItemRow[] = [
    lineItemRow("legacy-1", { fence_run_sync_id: "run-1", role: "SOME_ROLE_NEITHER_ENGINE_KNOWS" }),
  ];
  const plan = buildCommitPlan({
    output: output([]), companyId: "co", jobSyncId: "job-1",
    pricedRunSyncIds: ["run-1"], existingItems: existing, nowIso: "now",
  });
  check("buildCommitPlan: an unrecognised role reads as NONE and survives", plan.tombstoneSyncIds, []);
}
{
  const existing: DbLineItemRow[] = [
    lineItemRow("null-role-1", { fence_run_sync_id: "run-1", role: null }),
  ];
  const plan = buildCommitPlan({
    output: output([]), companyId: "co", jobSyncId: "job-1",
    pricedRunSyncIds: ["run-1"], existingItems: existing, nowIso: "now",
  });
  check("buildCommitPlan: a null role reads as NONE and survives", plan.tombstoneSyncIds, []);
}

console.log(`load: ${checks - failures} of ${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
