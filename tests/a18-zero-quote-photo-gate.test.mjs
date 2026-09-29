// A18 -- item 3 of this wave: "the last phone-office gap" on an uncalibrated
// survey PHOTO job that has a gate.
//
// Background (A17, already landed): an uncalibrated photo has no scale at
// all until somebody calibrates it, so both engines correctly refuse to
// guess one -- the phone via EstimateEngine.linearFeet / footageOf
// (DrawingScale.isPhotoJob), the office by blanking the WHOLE run
// (points_encoded AND gates_encoded) at the load.ts boundary before the
// engine ever sees it (buildPricingInput's neutralizeUnscaledRun).
//
// THE GAP THIS FILE PINS: a gate's width is typed directly in feet and does
// not depend on pixels_per_foot, so it needs no scale at all -- and nothing
// on the PHONE stopped it from being billed anyway. EstimateEngine
// .computeTotals's gateFeet summed every run's gates straight off the
// drawing with no photo check whatsoever, even while linearFeet correctly
// refused the SAME run's fence footage. So the phone billed the gate charge
// (gate feet x gate rate, then marked up) on a job the phone's own fence
// total already read as $0 -- and the gap SCALES with the gate rate: two
// 6 ft gates at $35/ft with 25% markup is $525, not $0.
//
// THE FIX is Kotlin-only (app/src/main/java/com/fenceestimator/app/estimate/
// EstimateEngine.kt's computeTotals), because the office ALREADY handles
// this correctly -- load.ts blanks a photo run's gates along with its
// points before totals.ts's own computeTotals (this file's subject) ever
// runs, so nothing on this side of the contract needed to change. This file
// exists to pin the OFFICE's already-correct reference numbers for exactly
// this shape (survey_storage_path set, no calibration, a gated run), which
// is the target the Kotlin fix has to match -- see the file header of
// app/src/test/java/com/fenceestimator/app/estimate/ZeroPriceGuardTest.kt
// (ITEM 3) for the Kotlin-side pin, hand-derived against these same numbers
// since this sandbox cannot run Gradle.
//
// Run: npx tsx tests/a18-zero-quote-photo-gate.test.mjs

import { readFileSync, mkdtempSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { priceJob, PRICING_ENGINE_VERSION } from "../supabase/functions/_shared/pricing/index.ts";
import { buildPricingInput } from "../supabase/functions/_shared/pricing/load.ts";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`); }
};

const clone = (x) => JSON.parse(JSON.stringify(x));

const catalog = [
  { sync_id: "11111111-0000-4000-8000-000000000001", name: "6x6 Vinyl Panel White", category: "PANEL", role: "PANEL",
    fence_type: "VINYL", color_or_finish: "White", unit: "ea", unit_price: 120, supplier_unit_price: null,
    taxable: true, covers_ft: 6, is_active: true, manufacturer_sync_id: null },
];

const baseJob = {
  sync_id: "job-1", updated_at: "2026-09-29T00:00:00Z",
  calibration_pixels_per_foot: null,
  tax_rate_percent: 0.0, markup_percent: 25.0, discount_percent: 0.0,
  labor_rate_per_ft: 0.0, labor_flat_fee: 0.0,
  minimum_job_charge: 0.0, minimum_labor_charge: 0.0, waste_percent: 0.0,
  gate_rate_per_ft: 35.0, trash_haul_fee: 0.0,
  teardown_enabled: false, teardown_flat_fee: 0.0, teardown_rate_per_ft: 0.0, teardown_feet: 0.0,
  preferred_manufacturer_sync_id: null,
  survey_storage_path: null,
};

// A run with NOTHING drawn on the fence line at all -- just two 6 ft gates.
// A gate's own hinges/panel are priced by role, not by gateFeet, so this
// isolates gateFeet/gate_charge (the field the bug and the fix are both
// about) from every other total on the job.
const twoGatesNoFence = {
  sync_id: "00000006-0000-4000-8000-000000000001", label: "gates only", fence_type: "VINYL",
  color_or_finish: "White", points_encoded: "", gates_encoded: "0.0:0.0:6.0:LINE:IN,500.0:0.0:6.0:LINE:IN",
  closed_loop: false,
  manual_linear_feet: null, manual_corner_count: 0,
  panel_width_ft: 6.0, panel_height_ft: 6.0, post_spacing_ft: 6.0, concrete_bags_per_post: 1.0,
  aluminum_style: "RACKABLE", wood_style: "PRIVACY", wood_rail_count: 3,
  picket_width_in: 5.5, picket_gap_in: 0.0, fabric_height_ft: 4.0,
  include_top_rail: true, include_tension_wire: false, include_barbed_wire_arms: false,
  include_privacy_slats: false, split_rail_count: 2, suppressed_roles: "",
  is_teardown: false, sort_order: 0,
};

function priceIt(job, runs) {
  const input = buildPricingInput({
    job, runs, catalog, manufacturers: [], changeOrders: [], existingItems: [],
    engineVersion: PRICING_ENGINE_VERSION,
  });
  return { input, output: priceJob(input) };
}

// ===========================================================================
// 1. An uncalibrated PHOTO job with two 6 ft gates and no fence line drawn:
//    the office already bills NOTHING for the gates -- gate_feet and
//    gate_charge both zero, same as the (already-fixed, A17) fence footage.
// ===========================================================================
console.log("\n1. Uncalibrated PHOTO job, two 6 ft gates, no fence drawn -- office already bills $0:");
{
  const job = { ...baseJob, survey_storage_path: "co-1/job-1/survey.jpg" };
  const { input, output } = priceIt(job, [twoGatesNoFence]);

  ok("buildPricingInput blanks this run's gates too, not just its (empty) points",
    input.runs[0].gates_encoded === "", `gates_encoded=${JSON.stringify(input.runs[0].gates_encoded)}`);
  ok("OFFICE REFERENCE: gate_feet is 0, not 12", output.totals.gate_feet === 0, `gate_feet=${output.totals.gate_feet}`);
  ok("OFFICE REFERENCE: gate_charge is $0, not $420", output.totals.gate_charge === 0, `gate_charge=${output.totals.gate_charge}`);
  ok("OFFICE REFERENCE: grand_total is $0 -- this is the target the Kotlin fix (EstimateEngine.computeTotals) must match",
    output.totals.grand_total === 0, `grand_total=${output.totals.grand_total}`);
}

// ===========================================================================
// 2. POSITIVE CONTROL -- the exact dollar figure the wave brief names: two
//    6 ft gates at $35/ft with 25% markup is $525 once calibrated. Proves
//    section 1's $0 is the guard engaging, not a coincidence of the rate,
//    the codec, or an empty catalog -- the identical shape, calibrated,
//    bills real money at the precise figure this bug report used.
// ===========================================================================
console.log("\n2. POSITIVE CONTROL -- the identical job, calibrated, bills the wave brief's own $525:");
{
  const job = { ...baseJob, survey_storage_path: "co-1/job-1/survey.jpg", calibration_pixels_per_foot: 20.0 };
  const { input, output } = priceIt(job, [twoGatesNoFence]);

  ok("calibrated: the run's gates are NOT blanked", input.runs[0].gates_encoded === twoGatesNoFence.gates_encoded);
  ok("bills the real 12 ft of gate opening", output.totals.gate_feet === 12, `gate_feet=${output.totals.gate_feet}`);
  ok("gate_charge: 12 ft x $35/ft = $420", output.totals.gate_charge === 420, `gate_charge=${output.totals.gate_charge}`);
  // $420 marked up 25% is $525 -- the wave brief's own figure -- before
  // computeTotals' own "always up to the next $10" rounding (unrelated to
  // this fix) takes it the rest of the way to $530.
  ok("premarkup + markup is exactly $525, the wave brief's own figure",
    output.totals.pre_markup_total === 420 && output.totals.markup_amount === 105,
    `pre_markup_total=${output.totals.pre_markup_total} markup_amount=${output.totals.markup_amount}`);
  ok("grand_total: $525 rounded up to the next $10 is $530",
    output.totals.grand_total === 530, `grand_total=${output.totals.grand_total}`);
}

// ===========================================================================
// 3. CANARY -- an uncalibrated GRID job (no survey_storage_path) still bills
//    its gates in full: this refusal is specific to an unmeasurable PHOTO,
//    not to "no calibration" in general. A grid square is a known size, so
//    a gate on it is exactly as measurable as it always was.
// ===========================================================================
console.log("\n3. CANARY: uncalibrated GRID job (no photo) is unaffected, still bills the gates:");
{
  const job = { ...baseJob, survey_storage_path: null };
  const { input, output } = priceIt(job, [twoGatesNoFence]);

  ok("a grid job's gates are NOT blanked", input.runs[0].gates_encoded === twoGatesNoFence.gates_encoded);
  ok("still bills 12 ft / $420 / $530, exactly as the calibrated case above",
    output.totals.gate_feet === 12 && output.totals.gate_charge === 420 && output.totals.grand_total === 530);
}

// ===========================================================================
// 4. Prove teeth -- revert load.ts's gate-blanking half of neutralizeUnscaledRun
//    (keep the points blanked, stop blanking gates) in a scratch copy, and
//    confirm section 1 goes RED under it: this is exactly the bug the phone
//    carried before this wave's fix, reproduced deliberately to prove this
//    file would have caught it. Nothing in the working tree is touched.
// ===========================================================================
console.log("\n4. Prove teeth -- un-blank only the gates in a scratch copy, confirm it reproduces the bug:");
{
  const scratchRoot = mkdtempSync(join(tmpdir(), "a18-photo-gate-scratch-"));
  const realPricingDir = fileURLToPath(new URL("../supabase/functions/_shared/pricing/", import.meta.url));
  const scratchPricingDir = join(scratchRoot, "pricing");
  cpSync(realPricingDir, scratchPricingDir, { recursive: true });

  const loadPath = join(scratchPricingDir, "load.ts");
  const loadSrc = readFileSync(loadPath, "utf8");
  const needle = 'return { ...row, points_encoded: "", gates_encoded: "" };';
  ok("found the exact line to weaken (if this fails, the scratch check below is not exercising the guard)",
    loadSrc.includes(needle));
  const weakened = loadSrc.replace(needle, 'return { ...row, points_encoded: "" }; // WEAKENED for this test only -- gates left live');
  writeFileSync(loadPath, weakened);

  const scratchLoad = await import(pathToFileURL(join(scratchPricingDir, "load.ts")).href);
  const scratchIndex = await import(pathToFileURL(join(scratchPricingDir, "index.ts")).href);

  const job = { ...baseJob, survey_storage_path: "co-1/job-1/survey.jpg" };
  const weakenedInput = scratchLoad.buildPricingInput({
    job, runs: [twoGatesNoFence], catalog, manufacturers: [], changeOrders: [], existingItems: [],
    engineVersion: scratchIndex.PRICING_ENGINE_VERSION,
  });
  const weakenedOutput = scratchIndex.priceJob(weakenedInput);

  ok("RED under the weakened rule: gates are NOT blanked even though points still are",
    weakenedInput.runs[0].points_encoded === "" && weakenedInput.runs[0].gates_encoded === twoGatesNoFence.gates_encoded);
  ok("RED under the weakened rule: this reproduces exactly the bug report's shape -- " +
     "gate_charge billed ($420, marked up and rounded to $530) while the fence line bills $0",
    weakenedOutput.totals.gate_charge === 420 && weakenedOutput.totals.grand_total === 530,
    `gate_charge=${weakenedOutput.totals.gate_charge} grand_total=${weakenedOutput.totals.grand_total}`);

  rmSync(scratchRoot, { recursive: true, force: true });
}

console.log(`\n${pass} of ${pass + fail} checks passed`);
if (fail) process.exit(1);
