// a100: THE SECOND SIDE OF A TEARDOWN MUST STILL BE A TEARDOWN.
//
// Double-tapping ends the side being drawn and offers "start a new side".
// startNewSideAfterFinish then called addRun(defaults, isTeardown = false) --
// the flag written out as a constant, whatever he was drawing.
//
// Marking out an OLD fence to pull down is a multi-side job exactly as a new
// fence is: you walk the boundary and double-tap at each corner. So every side
// after the first silently became a NEW FENCE run. It is labelled "Side 2"
// rather than "Old fence 2" (nextQuickRunLabel picks the stem off the same
// flag), and worse, it is PRICED as new fence -- posts, panels, caps and
// concrete for a fence he is removing, not installing. Teardown runs are
// excluded from the new fence's material take-off precisely so that cannot
// happen, and this walked around that exclusion one side at a time.
//
// Source-level, like a95 and a41: startNewSideAfterFinish is a method on a
// ViewModel that needs a repository and a coroutine scope to call, so there is
// no way to run it off-device.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VM = readFileSync(
  join(ROOT, "app/src/main/java/com/fenceestimator/app/ui/survey/SurveyViewModel.kt"), "utf8");

// The method body only. A comment elsewhere that mentions teardown must not be
// able to satisfy any of this.
function startNewSideBody() {
  const i = VM.indexOf("fun startNewSideAfterFinish(");
  assert.ok(i > 0, "startNewSideAfterFinish is gone -- has it been renamed?");
  const end = VM.indexOf("\n    }", i);
  assert.ok(end > i, "could not find the end of startNewSideAfterFinish");
  return VM.slice(i, end);
}

test("it does not hardcode the new side as new fence", () => {
  const body = startNewSideBody();
  assert.ok(!/addRun\([^)]*isTeardown\s*=\s*false/.test(body),
    "startNewSideAfterFinish still passes isTeardown = false outright, so the "
    + "second side of a teardown is priced as new fence");
});

test("it reads the flag off the side he just finished", () => {
  const body = startNewSideBody();
  assert.match(body, /isTeardown/,
    "the new run's teardown flag should come from the finished run");
  assert.match(body, /_sideFinished\.value\?\.runId|finishedId/,
    "it has to identify which run was finished to read its flag");
  assert.match(body, /runs\.value\.firstOrNull/,
    "it should look the finished run up to read its flag");
});

test("it reads the finished run BEFORE clearing the state that names it", () => {
  // Clearing _sideFinished is what loses the answer. Reading after it would
  // always fall back to false -- the original bug wearing a disguise, and one
  // that no amount of reading the diff would catch.
  const body = startNewSideBody();
  const readAt = body.search(/_sideFinished\.value\?\.runId/);
  const clearAt = body.search(/_sideFinished\.value\s*=\s*null/);
  assert.ok(readAt > 0 && clearAt > 0, "expected both a read and a clear");
  assert.ok(readAt < clearAt,
    "the finished run is read AFTER the state is cleared, so the flag is always false");
});

test("a run that is not found falls back to new fence, not to a crash", () => {
  const body = startNewSideBody();
  assert.match(body, /\?:\s*false/,
    "an unknown run should default to new fence rather than throwing");
});

test("the label follows the same flag, so the fix names the side correctly too", () => {
  // nextQuickRunLabel is what makes this visible on screen: get the flag right
  // and the side is called "Old fence 2" rather than "Side 2".
  assert.match(VM, /fun nextQuickRunLabel\(existingLabels: List<String>, isTeardown: Boolean\)/);
  assert.match(VM, /val stem = if \(isTeardown\) "Old fence" else "Side"/);
});

test("TEETH: restoring the hardcoded flag turns the first two checks red", () => {
  const broken = startNewSideBody()
    .replace(/addRun\(defaults, isTeardown = wasTeardown\)/, "addRun(defaults, isTeardown = false)")
    .replace(/val finishedId[\s\S]*?\?: false\n/, "");
  assert.ok(/addRun\([^)]*isTeardown\s*=\s*false/.test(broken),
    "the mutation should put the hardcoded flag back");
  assert.ok(!/_sideFinished\.value\?\.runId/.test(broken),
    "the mutation should remove the lookup, so check two would fail too");
});
