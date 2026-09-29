// A4 audit -- "the two pricing engines and the tax base"
// (app/src/main/java/com/fenceestimator/app/estimate/EstimateEngine.kt vs
// supabase/functions/_shared/pricing/). Originally a READ-ONLY audit proving
// two real money bugs without fixing them; FINDING 1 below is now FIXED (both
// engines bill labour for an uncalibrated GRID run) and its assertions were
// rewritten to check the corrected numbers instead of the bug. FINDING 2 is
// untouched and still documents an open bug -- this file no longer proves
// only bugs, but it still only asserts what it can show to be true, fixed or
// not.
//
// Both are called here exactly the way price-job/index.ts calls the real
// server engine: priceJob(PricingInput), the same function
// tests/company-golden-path.pricing-runner.mts wraps for the golden-path
// test and the edge function itself imports unmodified. No duplicated
// arithmetic, no mocked engine.
//
// Neither finding is a Kotlin-vs-TypeScript disagreement -- both fixtures
// used here are Kotlin-generated parity fixtures committed at fixtures/
// pricing/, so the two engines always agreed with each other on these exact
// inputs; FINDING 1 was agreeing on a wrong number, FINDING 2 still is. A
// parity gate, by construction, cannot catch that class of bug; only reading
// the formula against what it should compute can. `npx tsx supabase/
// functions/_shared/pricing/parity.ts` is the parity gate itself and is not
// re-verified by this file.
//
// Run: npx tsx tests/a4-engine-parity.test.mjs

import { readFileSync } from "node:fs";
import { priceJob } from "../supabase/functions/_shared/pricing/index.ts";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`); }
};

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/pricing/${name}.json`, import.meta.url), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));

// ===========================================================================
// FINDING 1 (FIXED) -- an uncalibrated drawn run used to bill full materials
// and ZERO labour for the very same footage. Now both bill the same footage.
//
// suggestQuantities() (materials/takeoff) and linearFeet() (labour billing)
// used to read job.calibration_pixels_per_foot two different ways:
//   - the takeoff's scale is input.pixels_per_foot, which price-job's own
//     load.ts sets to `job.calibration_pixels_per_foot ?? 20` (the survey
//     grid's fallback) -- so an uncalibrated run still measures real feet.
//   - linearFeet() (totals.ts / EstimateEngine.kt) read
//     job.calibrationPixelsPerFoot directly, with NO fallback, and a run
//     under a null calibration contributed 0 ft.
// One formula trusted the drawing enough to sell materials off it; the other
// did not trust it enough to bill an hour of labour for installing them.
// linearFeet (both engines, PRICING_ENGINE_VERSION 2026.09.2) now shares the
// same grid fallback the takeoff already used, so an uncalibrated run bills
// the same footage on both halves of the estimate.
//
// This fixture is specifically a GRID run (no survey photo) -- the JobRow
// contract has no field for one at all, so it is the only shape this
// fixture format can express. A grid square is a known size, so guessing 20
// px/ft for it is a fact, not a guess; an uncalibrated run on a survey PHOTO
// is a different, harder case (a photo has no scale until it is calibrated)
// that the phone now refuses rather than guesses
// (EstimateEngine.linearFeet, via DrawingScale.isPhotoJob) but that this
// server engine cannot distinguish from the grid case above -- its input
// carries no survey-photo signal at all. See the comment on footageOf in
// pricing/totals.ts. That gap is real and still open; nothing in this file
// exercises it, because nothing in this contract can represent it.
//
// Not a hypothetical shape -- fixtures/pricing/drawn-uncalibrated.json is a
// real, Kotlin-generated parity fixture. It has NOT been regenerated for this
// fix yet -- that is a later phase of this wave, not done here -- and it
// still carries engine.version "2026.09.1" and a `note` field (sourced from
// ParityCases.kt) describing the pre-fix asymmetry as "reproduced". Running
// this file against the still-old fixture is expected to fail RIGHT NOW: the
// live pricing engine's own version guard (index.ts) throws
// `input engine_version 2026.09.1 != 2026.09.2` before a single assertion
// below even runs, because PRICING_ENGINE_VERSION was bumped to 2026.09.2 as
// part of the fix this file exercises. That is not a bug in this test file --
// the assertions below are the correct, intended behaviour and are simply
// waiting on the fixture regeneration. Do not weaken or delete them to make
// this file pass early; treat red here as expected until
// fixtures/pricing/drawn-uncalibrated.json is regenerated (bumping its
// engine.version to 2026.09.2 and rewriting its `note` to match) in that
// later phase, at which point this file should go green with no further
// changes needed.
// ===========================================================================
console.log("\n1. Uncalibrated GRID run: labour now bills the same footage materials already priced (fixtures/pricing/drawn-uncalibrated.json):");

{
  const input = fixture("drawn-uncalibrated").input;
  ok("fixture precondition: the job really is uncalibrated",
    input.job.calibration_pixels_per_foot === null,
    `calibration_pixels_per_foot=${input.job.calibration_pixels_per_foot}`);
  ok("fixture precondition: the run is drawn (not typed footage), 2000px straight line",
    input.runs[0].manual_linear_feet === null && input.runs[0].points_encoded === "0.0:0.0,2000.0:0.0",
    `manual_linear_feet=${input.runs[0].manual_linear_feet} points_encoded=${input.runs[0].points_encoded}`);
  ok("fixture precondition: labour is priced at $8/ft on this job",
    input.job.labor_rate_per_ft === 8, `labor_rate_per_ft=${input.job.labor_rate_per_ft}`);

  const out = priceJob(input);

  // The takeoff measured a real 100 ft run (2000px at the grid's 20px/ft
  // fallback) and priced real materials against it.
  ok("materials ARE computed for the drawn run: net_feet=100, real dollars charged",
    out.runs[0].net_feet === 100 && out.totals.materials_subtotal === 1286.85,
    `net_feet=${out.runs[0].net_feet} materials_subtotal=${out.totals.materials_subtotal}`);

  // FIXED: the labour base for the exact same run now reads the same 100 ft
  // the takeoff already measured, instead of zero.
  ok("FIXED: linear_feet / billable_linear_feet now read 100 for the SAME drawn run " +
     "that priced $1,286.85 of materials off it, not 0",
    out.linear_feet === 100 && out.totals.billable_linear_feet === 100,
    `linear_feet=${out.linear_feet} billable_linear_feet=${out.totals.billable_linear_feet}`);

  // Arithmetic: 100 ft @ $8/ft owes $800.00 of labour. It now bills exactly that.
  ok("FIXED: labor_cost is $800.00 on a 100 ft run at $8/ft, not $0.00",
    out.totals.labor_cost === 800,
    `labor_cost=${out.totals.labor_cost}, should be 100 * 8 = 800`);

  // What gets billed now vs. before: materials + tax + the once-missing $800
  // labour, then the same $10-ceiling rounding computeTotals always applies
  // (teardown/change-order/gate charge are all 0 on this fixture).
  const correctPreMarkup = out.totals.materials_subtotal + out.totals.tax + 800
    + out.totals.teardown_cost + out.totals.change_order_cost + out.totals.gate_charge;
  const correctGrandTotal = Math.ceil(correctPreMarkup / 10) * 10;
  ok(`FIXED, in dollars actually billed: grand_total is $${out.totals.grand_total.toFixed(2)}, ` +
     `matching the $${correctGrandTotal.toFixed(2)} labour should have always included -- ` +
     `the $${(correctGrandTotal - 1320).toFixed(2)} undercharge this fixture used to carry is gone`,
    out.totals.grand_total === 2120 && correctGrandTotal === 2120,
    `actual grand_total=${out.totals.grand_total} correct=${correctGrandTotal}`);
}

// CANARY: the ONLY thing that changes below is job.calibration_pixels_per_foot,
// set to 20 -- the EXACT fallback value the takeoff (materials) already used,
// and the exact value the uncalibrated case above now measures itself at.
// price-job's own input.pixels_per_foot (what the takeoff reads) is untouched
// by this change, so if materials moved too, something other than
// linearFeet()'s grid fallback would be responsible. They do not move:
// net_feet and materials_subtotal come back bit-for-bit identical whether the
// calibration is explicit or left null, and the labour side now agrees too --
// $800 either way. That is the positive control: it proves the fixed $800
// above comes from the SAME grid scale explicit calibration would give, not
// from a coincidence of a zero labour rate or a run the engine skipped, and
// it guards against the fix ever drifting back to two different answers for
// "null" and "the value null falls back to".
{
  const uncalibratedInput = fixture("drawn-uncalibrated").input;
  const calibratedInput = clone(uncalibratedInput);
  calibratedInput.job.calibration_pixels_per_foot = 20;

  const uncalibrated = priceJob(uncalibratedInput);
  const calibrated = priceJob(calibratedInput);

  ok("CANARY: materials are UNCHANGED whether calibration is explicit or left null " +
     "(identical net_feet, identical materials_subtotal) -- calibration only ever " +
     "touched the labour side of this run",
    calibrated.runs[0].net_feet === uncalibrated.runs[0].net_feet &&
    calibrated.totals.materials_subtotal === uncalibrated.totals.materials_subtotal,
    `net_feet ${uncalibrated.runs[0].net_feet}->${calibrated.runs[0].net_feet}, ` +
    `materials ${uncalibrated.totals.materials_subtotal}->${calibrated.totals.materials_subtotal}`);

  ok("CANARY: null calibration and calibration explicitly set to the grid's own 20 px/ft " +
     "bill the identical $800.00 labour and $2,120.00 grand total -- the fix did not just " +
     "move the bug, it made the two paths agree",
    uncalibrated.totals.labor_cost === calibrated.totals.labor_cost &&
    uncalibrated.totals.grand_total === calibrated.totals.grand_total &&
    calibrated.totals.labor_cost === 800 && calibrated.totals.grand_total === 2120,
    `uncalibrated labor_cost=${uncalibrated.totals.labor_cost} grand_total=${uncalibrated.totals.grand_total}, ` +
    `calibrated labor_cost=${calibrated.totals.labor_cost} grand_total=${calibrated.totals.grand_total}`);
}

// ===========================================================================
// FINDING 2 -- a LINE_TO_WALL gate bills one fewer post cap than the number
// of posts the SAME takeoff puts in the ground for that job.
//
// computePostCounts() always assumes exactly 2 "gate posts" per gate
// (gatePosts = gateCount * 2, unconditional on mounting, identical in both
// engines) and POST_CAP is priced off that count (posts.totalPosts, used by
// panelBasedEntries/picketAndRailEntries/chainLinkEntries). But
// gateAreaEntries() for GateMounting.LINE_TO_WALL adds THREE END_POST
// entries -- the gate's own hinge and latch posts, plus the post where the
// rest of the fence terminates at the wall, because that mounting ends the
// run twice. The post-cap count never learns about that third post; the
// concrete count does (gateAreaEntries adds its bags explicitly per
// mounting), so only POST_CAP falls short.
//
// Not a hypothetical shape -- fixtures/pricing/gate-line-to-wall-mount.json
// is a real, currently-passing, Kotlin-generated parity fixture whose own
// `note` field names this exact shortfall and says it is "reproduced", not
// fixed.
// ===========================================================================
console.log("\n2. LINE_TO_WALL gate: one post stands with no cap billed for it (fixtures/pricing/gate-line-to-wall-mount.json):");

{
  const input = fixture("gate-line-to-wall-mount").input;
  const out = priceJob(input);
  const run = out.runs[0];

  // Actual physical posts the takeoff itself decided to build: line + corner
  // posts, plus every END_POST entry the engine emitted for this run (the
  // fence's own two ends, and whatever the gate area added) -- read straight
  // off entries, not re-derived, so this counts what the engine actually did.
  const endPostQty = run.entries.filter((e) => e.role === "END_POST").reduce((s, e) => s + e.quantity, 0);
  const physicalPosts = run.posts.line + run.posts.corner + endPostQty;
  const capEntry = run.entries.find((e) => e.role === "POST_CAP");

  ok("fixture precondition: this really is the LINE_TO_WALL path (3 END_POST added by the gate area, not 2)",
    endPostQty === 5, `END_POST entries sum to ${endPostQty} (expected 2 fence-end + 3 gate-end)`);

  ok(`BUG: ${physicalPosts} physical posts stand on this job (${run.posts.line} line + ` +
     `${run.posts.corner} corner + ${endPostQty} end) but only ${capEntry.quantity} post caps are billed`,
    physicalPosts === 19 && capEntry.quantity === 18,
    `physicalPosts=${physicalPosts} capQty=${capEntry.quantity}`);

  const capCatalogRow = input.catalog.find((c) => c.role === "POST_CAP");
  const capLineItem = out.items.find((i) => i.role === "POST_CAP");
  ok(`BUG, in dollars: materials_subtotal/taxable_subtotal/tax are each short by exactly one ` +
     `cap ($${capCatalogRow.unit_price.toFixed(2)}, taxable=${capLineItem.taxable}) on every LINE_TO_WALL gate ` +
     `-- $${capCatalogRow.unit_price.toFixed(2)} undercharged materials, ` +
     `$${(capCatalogRow.unit_price * input.job.tax_rate_percent / 100).toFixed(4)} undercharged tax`,
    capLineItem.quantity === 18 && capLineItem.taxable === true && capCatalogRow.unit_price === 0.74,
    `capLineItem.quantity=${capLineItem.quantity} taxable=${capLineItem.taxable} unit_price=${capCatalogRow.unit_price}`);
}

// CANARY: change ONLY the gate's mounting from LINE_TO_WALL to LINE (same
// run, same gate width, same everything else) and the shortfall disappears:
// the gate area then adds exactly 2 END_POST entries, matching the flat
// "2 gate posts" the cap count assumes, so physical posts and billed caps
// come back equal. Proves the defect above is specific to LINE_TO_WALL, not
// a general off-by-one every gate carries.
{
  const input = clone(fixture("gate-line-to-wall-mount").input);
  input.runs[0].gates_encoded = input.runs[0].gates_encoded.replace("LINE_TO_WALL", "LINE");
  ok("mutation actually changed the mounting and nothing else",
    input.runs[0].gates_encoded === "500.0:0.0:4.0:LINE:IN",
    `gates_encoded=${input.runs[0].gates_encoded}`);

  const out = priceJob(input);
  const run = out.runs[0];
  const endPostQty = run.entries.filter((e) => e.role === "END_POST").reduce((s, e) => s + e.quantity, 0);
  const physicalPosts = run.posts.line + run.posts.corner + endPostQty;
  const capEntry = run.entries.find((e) => e.role === "POST_CAP");

  ok("CANARY: the same gate mounted LINE instead needs only 2 end posts, and the billed " +
     "cap count matches the physical post count exactly -- no shortfall",
    endPostQty === 4 && physicalPosts === 18 && physicalPosts === capEntry.quantity,
    `endPostQty=${endPostQty} physicalPosts=${physicalPosts} capQty=${capEntry.quantity}`);
}

console.log(`\n${pass} of ${pass + fail} checks passed`);
if (fail) process.exit(1);
