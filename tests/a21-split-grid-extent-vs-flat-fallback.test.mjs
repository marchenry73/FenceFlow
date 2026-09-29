// A21 -- THE SPLIT: the office and the phone measure an uncalibrated GRID
// job's drawing at two different scales, and D1 (unbounded grid sizes) made
// the gap between them much bigger than it used to be.
//
// THE TWO SCALES.
//   - Office pricing (this file's own totals.ts, and the identical
//     EstimateEngine.footageOf on the phone) falls back to a FLAT
//     GRID_PIXELS_PER_FOOT (20) for an uncalibrated grid run, and never reads
//     grid_extent_ft at all -- confirmed below by grepping this directory,
//     and confirmed again live in section 1.
//   - The phone's own drawing screen (DrawingScale.of / SurveyViewModel,
//     Kotlin only -- there is nothing to import here) falls back to THIS
//     JOB'S OWN grid_extent_ft instead: GRID_CANVAS_SIZE / extentFt, 8000 /
//     extentFt. The two fallbacks are the same number only at the 400ft
//     default (8000 / 400 = 20); at any other extent they disagree.
//
// WHY THIS FILE DOES NOT FIX totals.ts. Teaching this engine grid_extent_ft
// (option (a) in the brief this change was written against) would be a real
// formula change -- inlined PRICING_ENGINE_VERSION, a version bump on both
// engines, regenerated fixtures, and a live job whose price already depends
// on the CURRENT flat behaviour (see fixtures/pricing/drawn-uncalibrated.json,
// UncalibratedLabourTest, tests/a11-uncalibrated-labour.test.mjs). This file
// does not touch totals.ts or load.ts. It only proves the gap is real and
// quantifies it, so the actual fix -- SurveyViewModel guaranteeing a grid job
// never sits with calibration_pixels_per_foot null at a non-default
// grid_extent_ft (SurveyViewModel.clearSurveyImage, GridExtentTest.kt in the
// Kotlin module) -- has a number to be closing.
//
// Run: npx tsx tests/a21-split-grid-extent-vs-flat-fallback.test.mjs

import { readFileSync, readdirSync } from "node:fs";
import { priceJob, PRICING_ENGINE_VERSION } from "../supabase/functions/_shared/pricing/index.ts";
import { buildPricingInput } from "../supabase/functions/_shared/pricing/load.ts";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`); }
};

// Mirrors SurveyViewModel.GRID_CANVAS_SIZE / DrawingScale.unitsPerFoot
// exactly -- there is no TypeScript module to import this from, because
// nothing on the server side needs it (that IS the bug being documented).
const GRID_CANVAS_SIZE = 8000;
const drawingPxPerFoot = (extentFt) => GRID_CANVAS_SIZE / extentFt;
const OFFICE_FLAT_PX_PER_FOOT = 20.0;

// Same audit fixture rates/catalog A11/A17 use: vinyl, $8/ft labour, 7% tax.
const auditFixture = JSON.parse(
  readFileSync(new URL("../fixtures/pricing/drawn-uncalibrated.json", import.meta.url), "utf8"),
);
const catalog = auditFixture.input.catalog;

const baseJob = {
  sync_id: "job-1", updated_at: "2026-09-28T00:00:00Z",
  calibration_pixels_per_foot: null,
  tax_rate_percent: 7.0, markup_percent: 0.0, discount_percent: 0.0,
  labor_rate_per_ft: 8.0, labor_flat_fee: 0.0,
  minimum_job_charge: 0.0, minimum_labor_charge: 0.0, waste_percent: 0.0,
  gate_rate_per_ft: 20.0, trash_haul_fee: 0.0,
  teardown_enabled: false, teardown_flat_fee: 0.0, teardown_rate_per_ft: 0.0, teardown_feet: 0.0,
  preferred_manufacturer_sync_id: null,
  survey_storage_path: null,
  // Not a real JobRow column as far as this engine is concerned (section 0
  // proves that) -- included on some of the jobs below anyway, to prove its
  // PRESENCE changes nothing, not just its absence.
  grid_extent_ft: 400,
};

// The same 2000px straight line A11/A17 use: 100 ft at the grid's 20 px/ft.
const drawnRun = {
  sync_id: "00000005-0000-4000-8000-000000000001", label: "vinyl", fence_type: "VINYL",
  color_or_finish: "", points_encoded: "0.0:0.0,2000.0:0.0",
  gates_encoded: "", closed_loop: false,
  manual_linear_feet: null, manual_corner_count: 0,
  panel_width_ft: 6.0, panel_height_ft: 6.0, post_spacing_ft: 6.0, concrete_bags_per_post: 1.0,
  aluminum_style: "RACKABLE", wood_style: "PRIVACY", wood_rail_count: 3,
  picket_width_in: 5.5, picket_gap_in: 0.0, fabric_height_ft: 4.0,
  include_top_rail: true, include_tension_wire: false, include_barbed_wire_arms: false,
  include_privacy_slats: false, split_rail_count: 2, suppressed_roles: "",
  is_teardown: false, sort_order: 0,
};

function priceAt(gridExtentFt) {
  const job = { ...baseJob, grid_extent_ft: gridExtentFt };
  const input = buildPricingInput({
    job, runs: [drawnRun], catalog, manufacturers: [], changeOrders: [], existingItems: [],
    engineVersion: PRICING_ENGINE_VERSION,
  });
  return { input, output: priceJob(input) };
}

// ===========================================================================
// 0. POSITIVE CONTROL -- grid_extent_ft is not read by this engine at all.
//    Grepped, not assumed: if a later change teaches load.ts or totals.ts
//    about grid_extent_ft, this goes red immediately and names the file.
// ===========================================================================
console.log("\n0. positive control -- grid_extent_ft is not referenced anywhere in the pricing engine:");
{
  const pricingDir = new URL("../supabase/functions/_shared/pricing/", import.meta.url);
  const files = readdirSync(pricingDir).filter((f) => f.endsWith(".ts"));
  ok("the pricing directory actually has files to check (a broken glob would false-pass everything below)",
    files.length > 5, `files=${files.length}`);
  const offenders = files.filter((f) =>
    readFileSync(new URL(f, pricingDir), "utf8").includes("grid_extent_ft") ||
    readFileSync(new URL(f, pricingDir), "utf8").includes("gridExtentFt"));
  ok("no file in supabase/functions/_shared/pricing reads grid_extent_ft / gridExtentFt",
    offenders.length === 0, `offenders=${JSON.stringify(offenders)}`);
}

// ===========================================================================
// 1. THE SPLIT, proven live: an uncalibrated GRID job prices IDENTICALLY at
//    grid_extent_ft 25, 400 and 10000 -- the office genuinely cannot tell
//    these three jobs apart, even though a real drawing on each of them
//    would be measured at 320, 20 and 0.8 px/ft respectively on the phone.
// ===========================================================================
console.log("\n1. an uncalibrated GRID job prices the same regardless of grid_extent_ft:");
{
  const at25 = priceAt(25);
  const at400 = priceAt(400);
  const at10000 = priceAt(10000);

  ok("25ft and 400ft bill identical linear_feet", at25.output.linear_feet === at400.output.linear_feet,
    `25ft=${at25.output.linear_feet} 400ft=${at400.output.linear_feet}`);
  ok("10000ft and 400ft bill identical linear_feet", at10000.output.linear_feet === at400.output.linear_feet,
    `10000ft=${at10000.output.linear_feet} 400ft=${at400.output.linear_feet}`);
  ok("all three bill the audit fixture's known $800 labour",
    at25.output.totals.labor_cost === 800 && at400.output.totals.labor_cost === 800 &&
      at10000.output.totals.labor_cost === 800,
    `25ft=${at25.output.totals.labor_cost} 400ft=${at400.output.totals.labor_cost} 10000ft=${at10000.output.totals.labor_cost}`);
  ok("all three bill identical materials too", at25.output.totals.materials_subtotal === at400.output.totals.materials_subtotal &&
    at10000.output.totals.materials_subtotal === at400.output.totals.materials_subtotal);
}

// ===========================================================================
// 2. THE GAP, quantified: what the phone's OWN drawing scale would be at
//    those same three extents, against the office's fixed 20 px/ft --
//    turning "fivefold to twenty-fivefold and beyond" into checked numbers.
//    Nothing here calls into any engine; this is the arithmetic
//    SurveyViewModel.unitsPerFoot / DrawingScale.unitsPerFoot does, repeated
//    independently so a change to GRID_CANVAS_SIZE on either side would have
//    to break BOTH this file and GridExtentTest.kt to go unnoticed.
// ===========================================================================
console.log("\n2. the gap between the office's flat fallback and the phone's own drawing scale:");
{
  const ratioAt = (extentFt) => OFFICE_FLAT_PX_PER_FOOT / drawingPxPerFoot(extentFt);

  ok("at the 400ft default the two fallbacks AGREE exactly (ratio 1) -- this is why no live job has shown the bug yet",
    Math.abs(ratioAt(400) - 1) < 1e-9, `ratio=${ratioAt(400)}`);
  ok("at 25ft (the floor, unchanged by D1) the gap is sixteenfold",
    Math.abs(1 / ratioAt(25) - 16) < 1e-9, `1/ratio=${1 / ratioAt(25)}`);
  ok("at 2000ft (the old ceiling, pre-D1) the gap was fivefold",
    Math.abs(ratioAt(2000) - 5) < 1e-9, `ratio=${ratioAt(2000)}`);
  ok("at 10000ft (D1's new ceiling) the gap is twenty-fivefold",
    Math.abs(ratioAt(10000) - 25) < 1e-9, `ratio=${ratioAt(10000)}`);
  ok("'and beyond': D1's zoom control has no ceiling past 10000ft, so 20000ft already exceeds twenty-fivefold",
    ratioAt(20000) > 25, `ratio=${ratioAt(20000)}`);
}

// ===========================================================================
// 3. Prove teeth: this file's section 1 assertions WOULD go red if the
//    office ever guessed the drawing's real scale instead of the flat one --
//    i.e. if the split were "fixed" the dangerous way (option (a)), without
//    a version bump, right here. Computed by hand, not by patching real
//    source: proves section 1 is actually sensitive to grid_extent_ft, not
//    vacuously passing because the two jobs happen to bill the same thing
//    for an unrelated reason.
// ===========================================================================
console.log("\n3. prove teeth -- what section 1 would look like if the office read grid_extent_ft:");
{
  const at25 = priceAt(25);
  // What footageOf/linearFeet WOULD compute at 25ft if it used the phone's
  // grid-aware scale instead of the flat one: the same 2000px line measured
  // at 320 px/ft is 6.25 ft, not 100.
  const hypotheticalGridAwareFeet = 2000 / drawingPxPerFoot(25);
  ok("the hypothetical grid-aware answer is NOT what the real engine returns today -- " +
    "proving section 1 would have caught option (a) landing here unversioned",
    hypotheticalGridAwareFeet !== at25.output.linear_feet,
    `hypothetical=${hypotheticalGridAwareFeet} actual=${at25.output.linear_feet}`);
  ok("and it is not some coincidental near-miss either", Math.abs(hypotheticalGridAwareFeet - at25.output.linear_feet) > 50);
}

console.log(`\n${pass} of ${pass + fail} checks passed`);
if (fail) process.exit(1);
