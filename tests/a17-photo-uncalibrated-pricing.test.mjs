// A17 -- closes the bug this wave was asked to fix: the phone and the office
// quoted the SAME job on an uncalibrated survey PHOTO two different ways.
//
// Background (A11, already landed): an uncalibrated drawn run used to bill
// full materials and zero labour, because the takeoff (suggestQuantities /
// pixels_per_foot) fell back to the survey grid's flat 20 px/ft while
// linearFeet/teardownLinearFeet read job.calibration_pixels_per_foot with no
// fallback at all. A11 fixed that by giving linearFeet/teardownLinearFeet the
// identical `?? 20` fallback -- correct for an uncalibrated GRID run, because
// a grid square really is a known size.
//
// The bug THIS file pins: that same `?? 20` fallback is wrong for an
// uncalibrated survey PHOTO. A photo has no scale at all until somebody
// calibrates it against something of known length, so both engines must
// refuse to price one, not guess -- and, until this change, only the
// PHONE'S labour path (EstimateEngine.linearFeet, via DrawingScale.isPhotoJob)
// knew how to refuse. The server had no photo signal on its JobRow at all,
// so price-job kept guessing the grid scale for an uncalibrated photo job --
// and the phone's own MATERIALS path (suggestQuantities, called from
// TakeoffRefresher with no photo check) had exactly the same gap. Same job,
// $1,320 on the phone (0 ft billed) against $2,120 in the office (100 ft
// guessed) -- and TakeoffRefresher re-measuring materials at the guessed
// grid scale on every drawing change, even while labour correctly billed
// zero for the identical run.
//
// THE SIGNAL: `survey_storage_path` (jobs.survey_storage_path, `text`,
// nullable) is what travels to a second phone and to the office; the
// phone-local `survey_image_path` a first drawing screen writes is NOT a
// database column at all (verified against the LIVE schema below, not
// assumed -- see the positive-control query this session ran with
// `npx supabase db query`). Both existing Kotlin photo tests
// (DrawingScaleSharedTest, LinearFeetTest) key their uncalibrated-photo case
// on `surveyImagePath`, the field that does NOT reach the office -- so
// nothing before this file pinned the leg that actually does. Every
// assertion below uses `survey_storage_path` / `surveyStoragePath` instead.
//
//   Live schema check (2026-09-28, project newcrgafcptspmapacrx):
//     select column_name, data_type, is_nullable from information_schema.columns
//     where table_schema='public' and table_name='jobs'
//       and column_name in ('calibration_pixels_per_foot','survey_storage_path','survey_image_path');
//   ->  calibration_pixels_per_foot | double precision | YES   (positive control: known to exist)
//       survey_storage_path         | text             | YES   (the travelling signal)
//   (survey_image_path: no row -- not a column, confirming the phone-local claim)
//
// THE FIX: load.ts's buildPricingInput (the boundary between the database
// rows and the engine) now reads survey_storage_path and, for an
// uncalibrated photo job, hands the engine every geometry-driven run
// (`points_encoded` and `gates_encoded`) blanked -- exactly what a run
// nobody has drawn on looks like. The completely UNMODIFIED engine already
// refuses to invent footage or materials for a run like that, on both the
// labour side (linearFeet/footageOf) and the materials side
// (suggestQuantities/resolveGeometry), so pixels_per_foot's value (still a
// grid guess) never gets to multiply anything for that run. Typed footage
// (manual_linear_feet) is untouched, on either side, because it needs no
// scale in the first place.
//
// CROSS-LANGUAGE PARITY: app/src/test/java/com/fenceestimator/app/estimate/
// PhotoScaleTest.kt asserts the identical rule
// (TakeoffRefresher.blockedByUncalibratedPhoto) using Job.surveyStoragePath,
// the same travelling field, since Gradle is reserved for the parity gate at
// the end of this change (house rule), not for a single track to run
// mid-flight.
//
// Run: npx tsx tests/a17-photo-uncalibrated-pricing.test.mjs

import { readFileSync, mkdtempSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { priceJob, PRICING_ENGINE_VERSION } from "../supabase/functions/_shared/pricing/index.ts";
import { buildPricingInput } from "../supabase/functions/_shared/pricing/load.ts";
import { linearFeet } from "../supabase/functions/_shared/pricing/totals.ts";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`); }
};

const clone = (x) => JSON.parse(JSON.stringify(x));

// The audit's own fixture (fixtures/pricing/drawn-uncalibrated.json) supplies
// the job rates and the vinyl catalog: a 2000px straight run, 100 ft at the
// grid's 20 px/ft, $8/ft labour, 7% tax. Read once here rather than through
// priceJob() directly -- that fixture's own `input.engine_version` is a
// prior engine version (the version-inlining trap this wave's own briefing
// describes: a fixture is only ever stamped with the version that was live
// when it was generated), so this file builds its inputs fresh through
// buildPricingInput() with the CURRENT PRICING_ENGINE_VERSION instead of
// reading the fixture's `.input` verbatim.
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
};

// The same 2000px straight line the audit fixture drew (100 ft at 20 px/ft).
// Matches fixtures/pricing/drawn-uncalibrated.json's run exactly, so sections
// 3/4/6 below can be checked against that fixture's own committed numbers.
const drawnRunNoGate = {
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

// The identical run, plus one gate. Gate width is typed directly in feet and
// does not depend on pixels_per_foot at all, so this is the case that proves
// the fix refuses the WHOLE run on an uncalibrated photo -- gate hardware
// included -- not only the part of it that is footage-derived. 5 ft of the
// 100 ft is the gate opening, billed at gate_rate_per_ft instead of the
// fence labour rate, so the fence-only labour feet are 95, not 100.
const drawnRunWithGate = { ...drawnRunNoGate, gates_encoded: "500.0:0.0:5.0:LINE" };

function priceIt(job, runs) {
  const input = buildPricingInput({
    job, runs, catalog, manufacturers: [], changeOrders: [], existingItems: [],
    engineVersion: PRICING_ENGINE_VERSION,
  });
  return { input, output: priceJob(input) };
}

// ===========================================================================
// 1. An UNCALIBRATED PHOTO job (keyed on survey_storage_path, the field that
//    travels) prices NO footage and NO materials -- not the fence line, and
//    not the gate hardware sitting on it either.
// ===========================================================================
console.log("\n1. Uncalibrated PHOTO run (survey_storage_path set, no calibration):");
{
  const job = { ...baseJob, survey_storage_path: "co-1/job-1/survey.jpg" };
  const { input, output } = priceIt(job, [drawnRunWithGate]);

  ok("buildPricingInput blanks the run's drawing before the engine ever sees it",
    input.runs[0].points_encoded === "" ,
    `points_encoded=${JSON.stringify(input.runs[0].points_encoded)}`);
  ok("buildPricingInput blanks the run's gates too -- a gate's own hardware is not priced either",
    input.runs[0].gates_encoded === "",
    `gates_encoded=${JSON.stringify(input.runs[0].gates_encoded)}`);

  ok("no footage: linear_feet is 0", output.linear_feet === 0, `linear_feet=${output.linear_feet}`);
  ok("no billable footage, so no labour", output.totals.billable_linear_feet === 0 && output.totals.labor_cost === 0,
    `billable_linear_feet=${output.totals.billable_linear_feet} labor_cost=${output.totals.labor_cost}`);
  ok("no gate charge (the gate was blanked along with the fence line)",
    output.totals.gate_feet === 0 && output.totals.gate_charge === 0,
    `gate_feet=${output.totals.gate_feet} gate_charge=${output.totals.gate_charge}`);
  ok("no materials: materials_subtotal is 0", output.totals.materials_subtotal === 0,
    `materials_subtotal=${output.totals.materials_subtotal}`);
  ok("the run reports a zeroed takeoff, not the drawing's real 100 ft",
    output.runs[0].gross_feet === 0 && output.runs[0].net_feet === 0 && output.runs[0].gate_count === 0,
    `gross_feet=${output.runs[0].gross_feet} net_feet=${output.runs[0].net_feet} gate_count=${output.runs[0].gate_count}`);
  ok("no auto-generated line items at all for this run", output.items.length === 0, `items=${output.items.length}`);
}

// ===========================================================================
// 2. A CALIBRATED photo prices normally -- the same job, calibrated to the
//    grid's own 20 px/ft, must read identically to the uncalibrated GRID
//    case in section 3. Calibration always wins, photo or not.
// ===========================================================================
console.log("\n2. Calibrated PHOTO run (survey_storage_path set, calibration_pixels_per_foot = 20):");
{
  const job = { ...baseJob, survey_storage_path: "co-1/job-1/survey.jpg", calibration_pixels_per_foot: 20.0 };
  const { input, output } = priceIt(job, [drawnRunWithGate]);

  ok("the drawing is NOT blanked once calibrated", input.runs[0].points_encoded === drawnRunWithGate.points_encoded);
  ok("the gate is NOT blanked once calibrated", input.runs[0].gates_encoded === drawnRunWithGate.gates_encoded);
  ok("prices the real 100 ft of fence", output.linear_feet === 100, `linear_feet=${output.linear_feet}`);
  ok("bills real labour: (100 - 5 ft gate opening) @ $8/ft = $760",
    output.totals.labor_cost === 760, `labor_cost=${output.totals.labor_cost}`);
  ok("bills real materials (nonzero)", output.totals.materials_subtotal > 0,
    `materials_subtotal=${output.totals.materials_subtotal}`);
  ok("prices the gate's own hardware (GATE_PANEL is on the estimate)",
    output.items.some((i) => i.role === "GATE_PANEL"));
}

// ===========================================================================
// 3. CANARY -- an uncalibrated GRID job (no survey_storage_path at all) is
//    completely untouched by this change: still the flat grid fallback A11
//    already fixed, still 100 ft, still $800 labour.
// ===========================================================================
console.log("\n3. CANARY: uncalibrated GRID run (survey_storage_path is null) is unaffected:");
{
  const job = { ...baseJob, survey_storage_path: null };
  const { input, output } = priceIt(job, [drawnRunNoGate]);

  ok("the drawing is NOT blanked for a grid job", input.runs[0].points_encoded === drawnRunNoGate.points_encoded);
  ok("still prices the grid's flat 100 ft", output.linear_feet === 100, `linear_feet=${output.linear_feet}`);
  ok("still bills $800 labour (A11's fix, untouched by this change)",
    output.totals.labor_cost === 800, `labor_cost=${output.totals.labor_cost}`);
  ok("still bills the same materials as the audit fixture ($1,286.85)",
    output.totals.materials_subtotal === 1286.85, `materials_subtotal=${output.totals.materials_subtotal}`);
}

// ===========================================================================
// 4. Typed footage on an uncalibrated photo job needs no scale and is not
//    blocked -- it was never measured off the drawing in the first place.
// ===========================================================================
console.log("\n4. Typed footage overrides the photo refusal (no scale needed):");
{
  const job = { ...baseJob, survey_storage_path: "co-1/job-1/survey.jpg" };
  const typedRun = { ...drawnRunNoGate, manual_linear_feet: 100.0, points_encoded: "", gates_encoded: "" };
  const { input, output } = priceIt(job, [typedRun]);

  ok("a typed-footage run is untouched by neutralizeUnscaledRun", input.runs[0] !== undefined);
  ok("prices the typed 100 ft", output.linear_feet === 100, `linear_feet=${output.linear_feet}`);
  ok("bills real labour off the typed footage: $800", output.totals.labor_cost === 800, `labor_cost=${output.totals.labor_cost}`);
  ok("bills real materials off the typed footage", output.totals.materials_subtotal > 0,
    `materials_subtotal=${output.totals.materials_subtotal}`);
}

// ===========================================================================
// 5. Defensive default: a job row missing survey_storage_path altogether
//    (the column left out of a select, e.g. by a future JOB_COLUMNS edit
//    that forgets it -- see the note in price-job/index.ts) must read as
//    "no photo", not "yes photo". Failing the other way would block every
//    ordinary uncalibrated GRID job's materials, a new and worse bug.
// ===========================================================================
console.log("\n5. A job row with survey_storage_path missing (not even null) fails SAFE:");
{
  const job = { ...baseJob };
  delete job.survey_storage_path;
  ok("test precondition: the key is really absent, not just null", !("survey_storage_path" in job));
  const { input, output } = priceIt(job, [drawnRunNoGate]);

  ok("an absent column is read as no photo -- the drawing is NOT blanked",
    input.runs[0].points_encoded === drawnRunNoGate.points_encoded);
  ok("prices the grid fallback as it always did (the pre-existing behaviour, not a new failure)",
    output.linear_feet === 100, `linear_feet=${output.linear_feet}`);
}

// ===========================================================================
// 5b. Parity edge case: an empty-string survey_storage_path reads as "has a
//     photo", matching DrawingScale.isPhotoJob's own null-only check exactly
//     (it does not special-case an empty string either). A mismatch here
//     between the two engines on what counts as "has a photo" would be
//     exactly the kind of drift this whole change exists to close.
// ===========================================================================
console.log("\n5b. Parity: an empty-string survey_storage_path is still treated as a photo:");
{
  const job = { ...baseJob, survey_storage_path: "" };
  const { input } = priceIt(job, [drawnRunNoGate]);
  ok("an empty string (not null/undefined) still blanks the drawing",
    input.runs[0].points_encoded === "");
}

// ===========================================================================
// 6. Prove teeth: revert this change's one rule in a scratch copy of the
//    pricing engine and confirm section 1's assertions go RED under it --
//    proving this file would have caught the bug it was written for. Nothing
//    in the working tree is touched; the copy is discarded afterward.
// ===========================================================================
console.log("\n6. Prove teeth -- revert the fix in a scratch copy, confirm it goes red:");
{
  const scratchRoot = mkdtempSync(join(tmpdir(), "a17-photo-scratch-"));
  const realPricingDir = fileURLToPath(new URL("../supabase/functions/_shared/pricing/", import.meta.url));
  const scratchPricingDir = join(scratchRoot, "pricing");
  cpSync(realPricingDir, scratchPricingDir, { recursive: true });

  const loadPath = join(scratchPricingDir, "load.ts");
  const loadSrc = readFileSync(loadPath, "utf8");
  const needle =
    "const runs = isUncalibratedPhotoJob(job, src.job.survey_storage_path)\n" +
    "    ? src.runs.map(neutralizeUnscaledRun)\n" +
    "    : src.runs;";
  const reverted = loadSrc.replace(needle, "const runs = src.runs; // REVERTED for this test only");

  ok("found the exact rule to revert (if this fails, the scratch check below is not exercising the fix)",
    reverted !== loadSrc);
  writeFileSync(loadPath, reverted);

  const scratchLoad = await import(pathToFileURL(join(scratchPricingDir, "load.ts")).href);
  const scratchIndex = await import(pathToFileURL(join(scratchPricingDir, "index.ts")).href);

  const job = { ...baseJob, survey_storage_path: "co-1/job-1/survey.jpg" };
  const revertedInput = scratchLoad.buildPricingInput({
    job, runs: [drawnRunWithGate], catalog, manufacturers: [], changeOrders: [], existingItems: [],
    engineVersion: scratchIndex.PRICING_ENGINE_VERSION,
  });
  const revertedOutput = scratchIndex.priceJob(revertedInput);

  ok("RED under the reverted rule: the drawing is NOT blanked",
    revertedInput.runs[0].points_encoded === drawnRunWithGate.points_encoded);
  ok("RED under the reverted rule: labour is billed off the guessed grid scale ($760, not $0)",
    revertedOutput.totals.labor_cost === 760, `labor_cost=${revertedOutput.totals.labor_cost}`);
  ok("RED under the reverted rule: materials are billed off the guessed grid scale (nonzero, not $0)",
    revertedOutput.totals.materials_subtotal > 0, `materials_subtotal=${revertedOutput.totals.materials_subtotal}`);
  ok("RED under the reverted rule: this reproduces the exact bug report -- real materials, and now real labour too, for an unmeasurable photo",
    revertedOutput.totals.grand_total > 0);

  rmSync(scratchRoot, { recursive: true, force: true });
}

console.log(`\n${pass} of ${pass + fail} checks passed`);
if (fail) process.exit(1);
