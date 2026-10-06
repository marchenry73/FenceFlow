// a105: THE NUMBERS FOLLOW WITHOUT BEING ASKED TWICE.
//
// Two reports, one complaint: "I want the suggest quantities to already be
// calculating as I'm drawing, and when I'm done, it can be ready" and "When I
// click waste allowances, it should auto update without having to click
// suggest quantities again."
//
// They had different causes.
//
// (1) DRAWING. SurveyViewModel.watchDrawingForRepricing already re-prices every
//     run whose pricing signature changed, 700 ms after he stops moving. But
//     TakeoffRefresher.refreshRun bailed on `if (takeoffLines.isEmpty())` --
//     "never invent an estimate for a run nobody has priced yet" -- so a side
//     he had JUST DRAWN had no lines, fell out there, and was never priced
//     until he pressed Suggest Quantities once by hand. After that one press it
//     tracked the drawing fine, which is why it looked like it half worked.
//
//     The guard is right everywhere else, so it is opt-in: only the drawing
//     watcher passes priceUnpriced. Drawing a side is choosing to price it.
//
// (2) WASTE. setWastePercent stored the number and stopped. The only automatic
//     re-pricing watches FENCE RUNS, and waste lives on the JOB, so nothing
//     ever saw it.
//
//     The trap in fixing it: regenerateInternal reads `job.value`, a StateFlow
//     fed by observeJob, which has NOT caught up when updateJob() returns. A
//     naive save-then-reprice prices against the OLD percentage, so the chips
//     lag one press behind -- press 10%, see the 5% answer. That version looks
//     like it works, which is how it would have shipped.
//
// Source-level: a ViewModel needing a repository and a coroutine scope, and a
// refresher that needs a database.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const REFRESHER = read("app/src/main/java/com/fenceestimator/app/estimate/TakeoffRefresher.kt");
const SURVEY = read("app/src/main/java/com/fenceestimator/app/ui/survey/SurveyViewModel.kt");
const ESTIMATE = read("app/src/main/java/com/fenceestimator/app/ui/estimate/EstimateViewModel.kt");

// ----------------------------------------------------------- drawing ------

test("a side with no lines yet can be priced, but only on request", () => {
  assert.match(REFRESHER, /priceUnpriced: Boolean = false/,
    "the opt-in should default to false, so every existing caller is unchanged");
  assert.match(REFRESHER, /if \(takeoffLines\.isEmpty\(\) && !priceUnpriced\) return false/,
    "the never-invent guard must still stand for callers that do not ask");
});

test("the drawing watcher is the one that asks", () => {
  const i = SURVEY.indexOf("private fun watchDrawingForRepricing()");
  assert.ok(i > 0, "the watcher is gone");
  const body = SURVEY.slice(i, i + 2600);
  assert.match(body, /priceUnpriced = true/,
    "the drawing watcher should price a side he has just drawn");
});

test("nothing else asks for it", () => {
  // A shared predicate quietly changing meaning for every caller is a mistake
  // this project has made before. Every other call site must be untouched.
  // CALL sites only. Matching `refreshRun(...)` loosely also catches the
  // declaration, which of course names the parameter -- so the test would fail
  // against correct code and look like the opt-in had leaked.
  const RUN_EDIT = read("app/src/main/java/com/fenceestimator/app/ui/runs/RunEditViewModel.kt");
  // `repository` NOT followed by a colon: the declaration reads
  // `repository: Repository`, a call reads `repository,` or `repository)`.
  const callsIn = (src) =>
    [...src.matchAll(/refreshRun\(\s*repository(?!\s*:)[^)]*\)/g)].map((m) => m[0]);
  const calls = callsIn(REFRESHER).concat(callsIn(RUN_EDIT));
  assert.ok(calls.length >= 3, `expected to find the other call sites, found ${calls.length}`);
  const asking = calls.filter((c) => /priceUnpriced/.test(c));
  assert.deepEqual(asking, [],
    `only the drawing watcher may opt in; these also do: ${asking}`);
});

test("what it does NOT change: scale, catalog and teardown still block pricing", () => {
  // This decides WHEN pricing starts, never what the price is.
  assert.match(REFRESHER, /blockedByUncalibratedPhoto\(job, run\)/,
    "an uncalibrated photo must still block it");
  assert.match(REFRESHER, /if \(catalog\.isEmpty\(\)\) return false/,
    "an empty catalog must still block it");
  assert.match(REFRESHER, /if \(run\.isTeardown\)/,
    "a teardown run must still get no materials");
  // And the uncalibrated check must come AFTER the opt-in, or opting in would
  // walk straight past it and invent numbers with no honest scale.
  const optIn = REFRESHER.indexOf("if (takeoffLines.isEmpty() && !priceUnpriced)");
  const uncal = REFRESHER.indexOf("blockedByUncalibratedPhoto(job, run)");
  assert.ok(optIn > 0 && uncal > optIn,
    "the uncalibrated-photo block must still be reached when priceUnpriced is set");
});

// ------------------------------------------------------------- waste ------

test("changing the waste allowance re-prices", () => {
  const i = ESTIMATE.indexOf("fun setWastePercent(");
  assert.ok(i > 0, "setWastePercent is gone");
  const body = ESTIMATE.slice(i, i + 1400);
  assert.match(body, /regenerateAll\(\)/,
    "storing the number without re-pricing is the bug being fixed");
});

test("it waits for the write to come back before re-pricing", () => {
  // regenerateInternal reads job.value. Re-pricing before observeJob has
  // emitted prices against the OLD percentage, so the chips lag one press
  // behind. That looks like it works, which is worse than not working.
  const i = ESTIMATE.indexOf("fun setWastePercent(");
  const body = ESTIMATE.slice(i, i + 1400);
  assert.match(body, /job\.first \{ it\?\.wastePercent == percent \}/,
    "it must wait for the new percentage to come back through the flow");
  const waitAt = body.indexOf("job.first {");
  const repriceAt = body.indexOf("regenerateAll()");
  assert.ok(waitAt > 0 && waitAt < repriceAt,
    "the wait must come BEFORE the re-price, or it prices against the old value");
});

test("if the write never lands, nothing is re-priced rather than something wrong", () => {
  const i = ESTIMATE.indexOf("fun setWastePercent(");
  const body = ESTIMATE.slice(i, i + 1400);
  assert.match(body, /withTimeoutOrNull\(WASTE_SETTLE_MS\)/, "the wait must be bounded");
  assert.match(body, /if \(landed\) regenerateAll\(\)/,
    "a timed-out wait must skip the re-price, not fall through to it");
  assert.match(ESTIMATE, /const val WASTE_SETTLE_MS/);
});

test("pressing the chip that is already on does nothing", () => {
  const i = ESTIMATE.indexOf("fun setWastePercent(");
  const body = ESTIMATE.slice(i, i + 1400);
  assert.match(body, /if \(current\.wastePercent == percent\) return/,
    "re-pricing every run for an answer that cannot have changed is wasted work");
});

test("TEETH: removing either half turns its own checks red", () => {
  const noOptIn = REFRESHER.replace(
    "if (takeoffLines.isEmpty() && !priceUnpriced) return false",
    "if (takeoffLines.isEmpty()) return false");
  assert.notEqual(noOptIn, REFRESHER, "mutation 1 changed nothing");
  assert.ok(!/takeoffLines\.isEmpty\(\) && !priceUnpriced/.test(noOptIn));

  const noWait = ESTIMATE.replace(/val landed = withTimeoutOrNull[\s\S]*?!= null\n/, "val landed = true\n");
  assert.notEqual(noWait, ESTIMATE, "mutation 2 changed nothing");
  assert.ok(!/job\.first \{ it\?\.wastePercent == percent \}/.test(noWait),
    "removing the wait should leave no wait to find");
});
