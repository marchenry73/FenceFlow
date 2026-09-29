// A11 -- fixes the biggest money defect a4-engine-parity.test.mjs found:
// an uncalibrated drawn run billed FULL MATERIALS and ZERO LABOUR for the
// same footage (supabase/functions/_shared/pricing/totals.ts footageOf(),
// app/src/main/java/com/fenceestimator/app/estimate/EstimateEngine.kt
// linearFeet()/teardownLinearFeet()). This file proves the FIX, in both
// languages as far as this sandbox can run them.
//
// Mechanism: suggestQuantities() (materials/takeoff) measures a drawn run at
// input.pixels_per_foot, which price-job's own load.ts sets to
// `job.calibration_pixels_per_foot ?? 20` (the survey grid's fallback) --
// so an uncalibrated run still measures real feet for materials.
// linearFeet()/teardownLinearFeet() used to read job.calibrationPixelsPerFoot
// directly with NO fallback, so the very same run contributed 0 ft to
// labour. The fix makes footageOf() (TS) and linearFeet/teardownLinearFeet
// (Kotlin) apply the identical `?? 20` / `?: DrawingScale.PIXELS_PER_FOOT_GRID`
// fallback that the takeoff already used -- one decision, reused, not
// re-derived.
//
// THIS FILE WAS RED BEFORE THE FIX. Run against the pre-fix totals.ts (the
// version at git HEAD when this file was written), the checks below reported:
//   linear_feet=0  billable_linear_feet=0  labor_cost=0  grand_total=1320
// which matches fixtures/pricing/drawn-uncalibrated.json's own `note` field
// and a4-engine-parity.test.mjs's "BUG" findings exactly. After the fix in
// this same change, they report:
//   linear_feet=100  billable_linear_feet=100  labor_cost=800  grand_total=2120
// (verified by temporarily running this fixture through a copy of index.ts
// with only totals.ts swapped back to its git-HEAD, pre-fix version --
// nothing in the working tree was reverted to get that reading).
//
// CROSS-LANGUAGE PARITY: app/src/test/java/com/fenceestimator/app/estimate/
// UncalibratedLabourTest.kt asserts the identical case and identical
// expected numbers by hand (same fixture input, same arithmetic), because
// this sandbox cannot run Gradle (house rule: gradlew and check-parity.mjs
// are for the parity gate to run once, at the end, not for a track making a
// source change to run for itself). fixtures/pricing/drawn-uncalibrated.json
// is Kotlin-generated and never regenerated from this side (parity.ts's own
// header) -- its `expected` section still pins the PRE-FIX numbers above, so
// it will fail parity.ts until Kotlin re-writes it. That is expected, not a
// new bug: it is exactly the divergence the parity gate exists to catch, and
// this file only ever reads the fixture's `.input`, never its `.expected`.
//
// Run: npx tsx tests/a11-uncalibrated-labour.test.mjs

import { readFileSync } from "node:fs";
import { priceJob } from "../supabase/functions/_shared/pricing/index.ts";
import { linearFeet, teardownLinearFeet, computeTotals } from "../supabase/functions/_shared/pricing/totals.ts";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`); }
};

const clone = (x) => JSON.parse(JSON.stringify(x));

// ===========================================================================
// 1. The exact audit case, end to end through priceJob(): a vinyl run drawn
//    as a 2000px straight line (100 ft at the grid's 20 px/ft) on a job with
//    NO calibration and $8/ft labour.
// ===========================================================================
console.log("\n1. priceJob() on fixtures/pricing/drawn-uncalibrated.json (the audit's own case):");
{
  const fixture = JSON.parse(readFileSync(
    new URL("../fixtures/pricing/drawn-uncalibrated.json", import.meta.url), "utf8"));
  const input = fixture.input;

  ok("fixture precondition: job really is uncalibrated",
    input.job.calibration_pixels_per_foot === null);
  ok("fixture precondition: run is drawn (no typed footage), 2000px straight line",
    input.runs[0].manual_linear_feet === null && input.runs[0].points_encoded === "0.0:0.0,2000.0:0.0");
  ok("fixture precondition: labour is $8/ft",
    input.job.labor_rate_per_ft === 8);

  const out = priceJob(input);

  ok("materials measured at 100 ft (unchanged by this fix)",
    out.runs[0].net_feet === 100 && out.totals.materials_subtotal === 1286.85,
    `net_feet=${out.runs[0].net_feet} materials_subtotal=${out.totals.materials_subtotal}`);

  // THE FIX: labour now measures the SAME 100 ft the materials did, instead
  // of reading the job's raw (null) calibration and getting nothing.
  ok("FIXED: linear_feet / billable_linear_feet are 100, the same 100 ft materials priced off",
    out.linear_feet === 100 && out.totals.billable_linear_feet === 100,
    `linear_feet=${out.linear_feet} billable_linear_feet=${out.totals.billable_linear_feet}`);

  ok("FIXED: labor_cost is $800.00 (100 ft @ $8/ft), not $0.00",
    out.totals.labor_cost === 800, `labor_cost=${out.totals.labor_cost}`);

  ok("FIXED: grand_total is $2,120 (materials $1,286.85 + tax $27.78 + labour $800, rounded up to the next $10)",
    out.totals.grand_total === 2120, `grand_total=${out.totals.grand_total}`);
}

// ===========================================================================
// 2. CANARY -- one shared scale. Setting job.calibration_pixels_per_foot to
//    20 explicitly (the exact value the grid fallback now supplies) must
//    produce a BIT-IDENTICAL output to leaving it null. If the fallback
//    constant in totals.ts ever drifted from the takeoff's own 20 px/ft,
//    this is what would catch it -- not just "labour is nonzero", but
//    "labour and materials agree to the last cent, on either path".
// ===========================================================================
console.log("\n2. CANARY: uncalibrated (fallback) and explicitly-calibrated-to-20 must match exactly:");
{
  const fixture = JSON.parse(readFileSync(
    new URL("../fixtures/pricing/drawn-uncalibrated.json", import.meta.url), "utf8"));
  const uncalibrated = fixture.input;
  const calibrated = clone(uncalibrated);
  calibrated.job.calibration_pixels_per_foot = 20;

  const outA = priceJob(uncalibrated);
  const outB = priceJob(calibrated);

  ok("CANARY: whole output is identical whether calibration is null (grid fallback) or explicitly 20",
    JSON.stringify(outA) === JSON.stringify(outB));
}

// ===========================================================================
// 3. teardownLinearFeet() gets the same fix -- no golden fixture covers an
//    uncalibrated TEARDOWN run, so this is built by hand rather than read
//    from fixtures/. Same 2000px line, marked is_teardown instead.
// ===========================================================================
console.log("\n3. Uncalibrated TEARDOWN run (hand-built, no golden fixture covers this):");
{
  const fixture = JSON.parse(readFileSync(
    new URL("../fixtures/pricing/drawn-uncalibrated.json", import.meta.url), "utf8"));
  const input = clone(fixture.input);
  input.job.teardown_enabled = true;
  input.job.teardown_rate_per_ft = 3;
  input.runs[0].is_teardown = true;

  const out = priceJob(input);

  ok("FIXED: teardown_linear_feet reads 100 ft off the drawing, not 0",
    out.teardown_linear_feet === 100, `teardown_linear_feet=${out.teardown_linear_feet}`);
  ok("FIXED: teardown_cost is $300.00 (100 ft @ $3/ft), not $0.00",
    out.totals.teardown_cost === 300, `teardown_cost=${out.totals.teardown_cost}`);
  // A teardown run contributes NOTHING to the new-fence labour footage --
  // that would double-bill the same drawing as both labour and teardown.
  ok("a teardown run still contributes 0 to linear_feet / labour (it is the OLD fence, not being built)",
    out.linear_feet === 0 && out.totals.labor_cost === 0,
    `linear_feet=${out.linear_feet} labor_cost=${out.totals.labor_cost}`);
}

// ===========================================================================
// 4. Unit-level: linearFeet()/teardownLinearFeet() directly, bypassing
//    priceJob() and its row-shape plumbing entirely, on the camelCase Job /
//    FenceRun the functions actually take. Pins the fix at the function
//    that owns it, independent of everything built on top of it.
// ===========================================================================
console.log("\n4. Unit-level: totals.ts linearFeet()/teardownLinearFeet() directly:");
{
  const job = {
    calibrationPixelsPerFoot: null,
    taxRatePercent: 7, markupPercent: 0, laborRatePerFt: 8, laborFlatFee: 0,
    discountPercent: 0, minimumJobCharge: 0, minimumLaborCharge: 0, wastePercent: 0,
    gateRatePerFt: 0, trashHaulFee: 0, teardownEnabled: false, teardownFlatFee: 0,
    teardownRatePerFt: 0, teardownFeet: 0, preferredManufacturerSyncId: null,
  };
  const baseRun = {
    syncId: "run-1", label: "", fenceType: "VINYL", sortOrder: 0,
    pointsEncoded: "0:0,2000:0", gatesEncoded: "", closedLoop: false, isTeardown: false,
    colorOrFinish: "", panelWidthFt: 6, panelHeightFt: 6, aluminumStyle: "RACKABLE",
    woodStyle: "PRIVACY", woodRailCount: 3, picketWidthIn: 5.5, picketGapIn: 0,
    fabricHeightFt: 4, includeTopRail: true, includeTensionWire: false,
    includeBarbedWireArms: false, includePrivacySlats: false, splitRailCount: 2,
    postSpacingFt: 6, concreteBagsPerPost: 1, manualLinearFeet: null, manualCornerCount: 0,
    suppressedRoles: new Set(),
  };

  ok("linearFeet(): uncalibrated 2000px run measures 100 ft (was 0 before the fix)",
    linearFeet(job, [baseRun]) === 100, `got ${linearFeet(job, [baseRun])}`);

  const teardownRun = { ...baseRun, isTeardown: true };
  ok("teardownLinearFeet(): same fix applies to the teardown sum",
    teardownLinearFeet(job, [teardownRun]) === 100, `got ${teardownLinearFeet(job, [teardownRun])}`);

  // A run with genuinely nothing -- no typed footage, no points at all --
  // still contributes nothing. The fix only removes the fallback's
  // ABSENCE; it does not invent length that was never drawn.
  const emptyRun = { ...baseRun, pointsEncoded: "" };
  ok("a run with no drawing and no typed footage still measures 0 ft (nothing to guess at)",
    linearFeet(job, [emptyRun]) === 0, `got ${linearFeet(job, [emptyRun])}`);

  // computeTotals() itself is unchanged by this fix (it already took
  // totalLinearFeet as a parameter) -- confirm it simply bills whatever
  // linearFeet() now correctly hands it.
  const feet = linearFeet(job, [baseRun]);
  const totals = computeTotals(job, [], feet, [], [baseRun]);
  ok("computeTotals() bills the corrected footage: 100 ft @ $8/ft = $800 labour",
    totals.laborCost === 800, `laborCost=${totals.laborCost}`);
}

console.log(`\n${pass} of ${pass + fail} checks passed`);
if (fail) process.exit(1);
