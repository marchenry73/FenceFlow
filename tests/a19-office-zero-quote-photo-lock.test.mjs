// A19 (office) -- the phone refuses to send a contract or an invoice for a
// job that totals $0 because it is drawn on a survey photo nobody has
// calibrated (EstimateEngine.hasUnmeasurablePhotoWork,
// EstimateScreen.kt's zeroQuoteBlocked, both in
// app/src/main/java/com/fenceestimator/app/estimate/ /ui/estimate/): "there
// is no reading of a $0 fence contract that is ever the right document to
// send" is a hard lock there, not a warning. The office had NO equivalent
// lock on either of its own two doors to the same customer quote link:
//
//   - the job view's Copy link / Preview (renderQuoteBlock) was gated only
//     on unverifiedPricesOn (unconfirmed catalog prices) -- a DIFFERENT
//     refusal, for a different reason, that says nothing about a $0 total;
//   - the quote wizard's own Copy link / Preview (wizStepSendHtml /
//     wizWireSend) was gated on NOTHING at all.
//
// That is the same shape of bug unverifiedPricesOn's own comment already
// names: "a gate on one door only". This wave closes BOTH doors with ONE
// shared pair of functions (jobHasUnmeasurablePhotoWork / zeroQuoteBlockedOn
// in website/dashboard.html), so there is exactly one definition of
// "unmeasurable" for the office to drift from, not two.
//
// WHETHER THE OFFICE CAN ACTUALLY TELL: it can, but only after this wave,
// and only just. The condition needs THREE facts about a job plus its runs:
//   1. job.calibration_pixels_per_foot -- already in JOB_COLUMNS.
//   2. job.survey_storage_path -- the ONE column that says this job is
//      drawn over a photo at all (DrawingScale.isPhotoJob on the phone).
//      This was NOT in JOB_COLUMNS before this wave. Without it, every job
//      object on this page reads survey_storage_path as undefined, so
//      isPhotoJob would always be false and the lock would silently never
//      fire on a real device -- a hole with no visible failure, worse than
//      no lock at all because it would look shipped. Confirmed missing by
//      reading JOB_COLUMNS in website/dashboard.html directly before this
//      fix; confirmed real and distinct from the phone-local
//      survey_image_path by supabase/functions/_shared/pricing/load.ts's own
//      comment on the same column. Fixed by adding it to JOB_COLUMNS --
//      tests/job-columns.test.mjs (run separately, unowned by this file)
//      passes against that addition, proving nothing else on the page reads
//      a job column this list does not carry.
//   3. fence_runs.points_encoded / gates_encoded / manual_linear_feet --
//      already loaded in full (`runs`, selected with no column list, i.e.
//      '*'), decoded with the SAME decodeRunPoints (website/js/lib/pay.mjs)
//      and decodeRunGates (website/dashboard.html) the Fence Run viewer
//      panel already uses -- not a second decoder that could read the same
//      bytes differently.
//
// Run: node --test tests/a19-office-zero-quote-photo-lock.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeRunPoints } from "../website/js/lib/pay.mjs";
import { OLD_renderQuoteBlock, OLD_wizStepSendHtml, OLD_wizWireSend } from "./a19-office-old-snippets.mjs";

const src = readFileSync(new URL("../website/dashboard.html", import.meta.url), "utf8");

// Same grab()/new Function() idiom as tests/a7-dashboard-money-regressions.
// test.mjs, tests/a12-dash-zero-row-writes.test.mjs and
// tests/a15-dash-discarded-rpc-answers.test.mjs -- runs the REAL functions
// lifted out of dashboard.html, not a reimplementation that could drift.
function grabFrom(source, name) {
  let start = source.indexOf("function " + name + "(");
  if (start < 0) throw new Error("not found: " + name);
  if (source.slice(start - 6, start) === "async ") start -= 6;
  let i = source.indexOf("{", source.indexOf(")", start)), depth = 0;
  for (let j = i; j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") { depth--; if (!depth) return source.slice(start, j + 1); }
  }
  throw new Error("unbalanced: " + name);
}
const grab = (name) => grabFrom(src, name);

// jobHasUnmeasurablePhotoWork and zeroQuoteBlockedOn are pure (no DOM, no
// Supabase) -- same reason TakeoffRefresher.blockedByUncalibratedPhoto is
// pure on the phone -- so they run standalone with just decodeRunPoints
// (the real pay.mjs export) and decodeRunGates (the real one grabbed
// alongside them, since both helpers call it).
const { jobHasUnmeasurablePhotoWork, zeroQuoteBlockedOn } = new Function(
  "decodeRunPoints",
  grab("decodeRunGates") + "\n" +
    grab("jobHasUnmeasurablePhotoWork") + "\n" +
    grab("zeroQuoteBlockedOn") +
    "\nreturn { jobHasUnmeasurablePhotoWork, zeroQuoteBlockedOn };"
)(decodeRunPoints);

const job = (overrides = {}) => ({
  sync_id: "job-1",
  survey_storage_path: "co-1/job-1/survey/scan.jpg",
  calibration_pixels_per_foot: null,
  contract_total: 0,
  ...overrides,
});
const run = (overrides = {}) => ({
  job_sync_id: "job-1",
  deleted_at: null,
  manual_linear_feet: null,
  points_encoded: "",
  gates_encoded: "",
  ...overrides,
});
const TWO_POINTS = "0:0,100:0";
const ONE_GATE = "0:0:6:LINE:IN";

// =============================================================================
// jobHasUnmeasurablePhotoWork / zeroQuoteBlockedOn -- the shared condition
// =============================================================================

test("an uncalibrated PHOTO job with two points drawn and a $0 total is locked", () => {
  const j = job({ contract_total: 0 });
  const r = run({ points_encoded: TWO_POINTS });
  assert.equal(jobHasUnmeasurablePhotoWork(j, [r]), true);
  assert.equal(zeroQuoteBlockedOn(j, [r]), true);
});

test("the same job with a gate instead of a fence line is locked the same way", () => {
  const j = job({ contract_total: 0 });
  const r = run({ gates_encoded: ONE_GATE });
  assert.equal(zeroQuoteBlockedOn(j, [r]), true);
});

test("a brand-new job on an uncalibrated photo with NOTHING drawn yet is NOT locked or nagged", () => {
  const j = job({ contract_total: 0 });
  const r = run(); // no points, no gates -- every job's very first moment
  assert.equal(jobHasUnmeasurablePhotoWork(j, [r]), false);
  assert.equal(zeroQuoteBlockedOn(j, [r]), false);
});

test("content drawn but the job is NOT priced at $0 -- not locked (the two halves are independent)", () => {
  const j = job({ contract_total: 530 });
  const r = run({ points_encoded: TWO_POINTS });
  // Genuinely unmeasurable either way -- proves the $0 check and the
  // content check are separate conditions, exactly as EstimateScreen's
  // zeroQuoteBlocked ANDs two independent things rather than one.
  assert.equal(jobHasUnmeasurablePhotoWork(j, [r]), true);
  assert.equal(zeroQuoteBlockedOn(j, [r]), false);
});

test("a job never priced at all (contract_total null) with unmeasurable content IS locked -- null reads as $0, not as a pass", () => {
  const j = job({ contract_total: null });
  const r = run({ points_encoded: TWO_POINTS });
  assert.equal(zeroQuoteBlockedOn(j, [r]), true);
});

test("a CALIBRATED photo job is not locked -- it has a real scale, not a guess", () => {
  const j = job({ calibration_pixels_per_foot: 20, contract_total: 0 });
  const r = run({ points_encoded: TWO_POINTS });
  assert.equal(zeroQuoteBlockedOn(j, [r]), false);
});

test("CANARY: an uncalibrated GRID job (no survey photo at all) is unaffected, even at $0 with content drawn", () => {
  // DrawingScale.of() falls back to the grid's own known scale for a
  // non-photo job -- an uncalibrated GRID run is priced off a fact, not a
  // guess, so this lock must never touch it. Mirrors a18-zero-quote-photo-
  // gate.test.mjs's own canary #3 on the office pricing side.
  const j = job({ survey_storage_path: null, calibration_pixels_per_foot: null, contract_total: 0 });
  const r = run({ points_encoded: TWO_POINTS });
  assert.equal(jobHasUnmeasurablePhotoWork(j, [r]), false);
  assert.equal(zeroQuoteBlockedOn(j, [r]), false);
});

test("a run with typed footage (manual_linear_feet) never needs a scale and is never counted", () => {
  const j = job({ contract_total: 0 });
  const r = run({ manual_linear_feet: 120, points_encoded: TWO_POINTS, gates_encoded: ONE_GATE });
  assert.equal(jobHasUnmeasurablePhotoWork(j, [r]), false);
});

test("a soft-deleted run is not counted", () => {
  const j = job({ contract_total: 0 });
  const r = run({ points_encoded: TWO_POINTS, deleted_at: "2026-01-01T00:00:00Z" });
  assert.equal(jobHasUnmeasurablePhotoWork(j, [r]), false);
});

test("a run belonging to a different job is not counted", () => {
  const j = job({ contract_total: 0 });
  const r = run({ job_sync_id: "some-other-job", points_encoded: TWO_POINTS });
  assert.equal(jobHasUnmeasurablePhotoWork(j, [r]), false);
});

test("a job with only one point drawn (not yet a line) is not unmeasurable content, same threshold as the phone's decodePoints.size >= 2", () => {
  const j = job({ contract_total: 0 });
  const r = run({ points_encoded: "0:0" }); // one point only
  assert.equal(jobHasUnmeasurablePhotoWork(j, [r]), false);
});

test("PARITY QUIRK, matched deliberately: a stored calibration of exactly 0 reads as \"calibrated\" here too, same as the phone's strict == null check", () => {
  const j = job({ calibration_pixels_per_foot: 0, contract_total: 0 });
  const r = run({ points_encoded: TWO_POINTS });
  assert.equal(zeroQuoteBlockedOn(j, [r]), false);
});

// =============================================================================
// JOB_COLUMNS carries the one field this whole check depends on
// =============================================================================

test("JOB_COLUMNS selects survey_storage_path -- without it every job reads it as undefined and this lock never fires", () => {
  const m = src.match(/const JOB_COLUMNS = \[([\s\S]*?)\]\.join/);
  assert.ok(m, "JOB_COLUMNS not found");
  assert.match(m[1], /'survey_storage_path'/);
});

// =============================================================================
// Both doors call the ONE shared definition -- not a second one that could
// drift from it, and not a door left uncalled.
// =============================================================================

test("there is exactly one definition each of jobHasUnmeasurablePhotoWork and zeroQuoteBlockedOn in the page", () => {
  assert.equal((src.match(/function jobHasUnmeasurablePhotoWork\(/g) || []).length, 1);
  assert.equal((src.match(/function zeroQuoteBlockedOn\(/g) || []).length, 1);
});

test("DOOR 1 -- the job view's renderQuoteBlock calls zeroQuoteBlockedOn and disables q_copy/q_open on it", () => {
  const fn = grab("renderQuoteBlock");
  assert.match(fn, /const zeroQuote = zeroQuoteBlockedOn\(j, runs\)/);
  assert.match(fn, /const blocked = zeroQuote \|\| unchecked\.length > 0/);
  assert.match(fn, /b\.disabled = blocked/);
  // The zero-quote message takes the slot when both reasons are true at
  // once, same priority order the phone's own EstimateScreen uses.
  assert.match(fn, /if \(zeroQuote\) \{\s*\n\s*\$\('q_block'\)\.textContent = tr\('qBlockZero'\)/);
});

test("DOOR 2 -- the quote wizard's wizStepSendHtml calls zeroQuoteBlockedOn and disables wz_q_copy/wz_q_open on it", () => {
  const fn = grab("wizStepSendHtml");
  assert.match(fn, /const zeroQuote = zeroQuoteBlockedOn\(j, runs\)/);
  assert.ok(fn.includes('id="wz_q_copy" type="button" ${zeroQuote?\'disabled\':\'\'}'),
    "wz_q_copy must be disabled when zeroQuote is true");
  assert.ok(fn.includes('id="wz_q_open" type="button" ${zeroQuote?\'disabled\':\'\'}'),
    "wz_q_open must be disabled when zeroQuote is true");
});

test("both doors read the message from the SAME translation key, not two different messages for one rule", () => {
  const doorJob = grab("renderQuoteBlock");
  const doorWiz = grab("wizStepSendHtml");
  assert.match(doorJob, /tr\('qBlockZero'\)/);
  assert.match(doorWiz, /tr\('qBlockZero'\)/);
});

test("qBlockZero and qBlockZeroBtnTitle exist in all three languages this page ships (en, es, fr)", () => {
  // One TL object per language, so each key must appear exactly 3 times.
  for (const key of ["qBlockZero", "qBlockZeroBtnTitle"]) {
    const count = (src.match(new RegExp(key + ":'", "g")) || []).length;
    assert.equal(count, 3, `${key} must be defined in exactly 3 language blocks (en/es/fr), found ${count}`);
  }
});

// =============================================================================
// PLANTED FAILURE -- the checks above actually go red against the code that
// shipped before this fix (tests/a19-office-old-snippets.mjs), proving they
// have teeth rather than trivially passing regardless of file content.
// =============================================================================

test("PLANTED FAILURE: the pre-fix renderQuoteBlock had no zero-quote lock at all", () => {
  assert.doesNotMatch(OLD_renderQuoteBlock, /zeroQuoteBlockedOn/);
  // It disabled the buttons on unchecked prices alone -- a real gate, just
  // not this one.
  assert.match(OLD_renderQuoteBlock, /b\.disabled = unchecked\.length > 0/);
});

test("PLANTED FAILURE: the pre-fix quote wizard's Copy link/Preview were gated on NOTHING at all", () => {
  assert.doesNotMatch(OLD_wizStepSendHtml, /disabled/);
  assert.doesNotMatch(OLD_wizStepSendHtml, /zeroQuoteBlockedOn/);
  assert.doesNotMatch(OLD_wizWireSend, /zeroQuoteBlockedOn/);
});

test("PLANTED FAILURE: jobHasUnmeasurablePhotoWork / zeroQuoteBlockedOn did not exist anywhere before this wave", () => {
  assert.equal(/function jobHasUnmeasurablePhotoWork\(/.test(OLD_renderQuoteBlock + OLD_wizStepSendHtml + OLD_wizWireSend), false);
  // grabFrom() on the pre-fix file throws "not found" for both -- confirmed
  // by hand against a scratch copy of the file at HEAD f4ffff9 (the office
  // could not have closed either door before this wave, because the shared
  // function this fix hangs the lock on did not exist).
});

console.log("a19-office-zero-quote-photo-lock: all assertions above use node:test -- run with `node --test` for a pass/fail summary.");
