// a103: THE DOUBLE-TAP MUST TAKE BACK THE POINT IT PUT DOWN.
//
// Taps are applied the moment they land -- waiting out a double-tap timeout
// before drawing anything makes every single point feel broken -- so the FIRST
// tap of a double-tap has already added a point by the time the second arrives.
// The second tap's job is to take that one back off and then ask whether he is
// carrying on or starting a new side.
//
// It decided which point to take back by comparing the last two points for
// EXACT FLOAT EQUALITY:
//
//     val duplicate = last.x == prior.x && last.y == prior.y
//
// But the gesture accepts a second tap anywhere within DOUBLE_TAP_SLOP_PX, and
// snapForDraw can move a point away from where the finger landed. So two taps
// close enough to COUNT as a double-tap, yet not identical to the bit, ended
// the side AND LEFT THE STRAY POINT BEHIND -- a short segment hanging off the
// fence. Reported as: "I need to be able to double click on the grid and it not
// create a line before opening the new slide, it messes up the fence."
//
// That leftover is also how a run ends up with POINTS AND NO LENGTH, which
// until engine 2026.10.12 billed two end posts for a fence that was not there:
// one gate, four posts on the quote. The two reports were one bug.
//
// The fix is to stop guessing. The screen knows exactly which point it put in
// -- it is the value it handed to addDrawPoint, after the snap -- so it passes
// that back and the ViewModel removes THAT one.
//
// Source-level, like a95 and a100: these are a Compose gesture handler and a
// ViewModel that needs a repository and a coroutine scope, so neither can be
// run off-device.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VM = readFileSync(
  join(ROOT, "app/src/main/java/com/fenceestimator/app/ui/survey/SurveyViewModel.kt"), "utf8");
const SCREEN = readFileSync(
  join(ROOT, "app/src/main/java/com/fenceestimator/app/ui/survey/SurveyDrawScreen.kt"), "utf8");

function finishBody() {
  const i = VM.indexOf("fun finishSideByDoubleTap(");
  assert.ok(i > 0, "finishSideByDoubleTap is gone -- renamed?");
  const end = VM.indexOf("\n    }", i);
  assert.ok(end > i, "could not find the end of finishSideByDoubleTap");
  return VM.slice(i, end);
}

test("the guess is gone: no exact-equality duplicate check decides what to remove", () => {
  const body = finishBody();
  assert.ok(!/val duplicate = last\.x == prior\.x && last\.y == prior\.y/.test(body),
    "the old coordinate guess is still deciding which point to take back");
});

test("the ViewModel is TOLD which point the first tap added", () => {
  assert.match(VM, /fun finishSideByDoubleTap\(addedByFirstTap: FencePoint\? = null\)/,
    "the function should accept the point the screen actually added");
  const body = finishBody();
  assert.match(body, /addedByFirstTap/, "and it should use it");
});

test("it removes the LAST point, and only when it is the one it was told about", () => {
  const body = finishBody();
  assert.match(body, /pts\.lastOrNull\(\)/, "it should look at the last point");
  assert.match(body, /last\.x == addedByFirstTap\.x && last\.y == addedByFirstTap\.y/,
    "it should compare against the value passed in, not against a neighbouring point");
  assert.match(body, /pts\.removeAt\(pts\.size - 1\)/);
});

test("nothing is removed when the screen passes nothing", () => {
  // The default is null, so any other caller -- or a future one -- ends the
  // side without silently eating a point it did not put there.
  const body = finishBody();
  assert.match(body, /if \(addedByFirstTap != null\)/,
    "a null must mean 'remove nothing', not 'remove the last one anyway'");
});

test("the screen records the point AFTER the snap has moved it", () => {
  // The snap is exactly what moves a point away from the finger, and that gap
  // is what the old equality check fell into. Recording the pre-snap position
  // would reintroduce the bug in a new place.
  const addAt = SCREEN.indexOf("viewModel.addDrawPoint(snap.point)");
  const recordAt = SCREEN.indexOf("lastAddedPoint = snap.point");
  assert.ok(addAt > 0, "addDrawPoint call not found");
  assert.ok(recordAt > addAt, "the recorded point should be snap.point, taken after the snap");
});

test("the screen hands it over and forgets it in the same breath", () => {
  // Left set, a later unrelated double-tap could remove a point that the first
  // tap of THAT pair did not add.
  const i = SCREEN.indexOf("if (quick && nearLast) {");
  assert.ok(i > 0, "the double-tap branch is gone");
  // Wide enough to contain the whole branch. This was 400 and clipped the call
  // itself at "finishSideByDouble", which fails in a way that looks like the
  // code is wrong rather than the window.
  const branch = SCREEN.slice(i, i + 900);
  assert.match(branch, /val added = lastAddedPoint/);
  assert.match(branch, /lastAddedPoint = null/, "it must be cleared as it is handed over");
  assert.match(branch, /viewModel\.finishSideByDoubleTap\(added\)/);
  const clearAt = branch.indexOf("lastAddedPoint = null");
  const callAt = branch.indexOf("finishSideByDoubleTap(added)");
  assert.ok(clearAt < callAt, "clear it before the call, so an early return cannot leave it set");
});

test("TEETH: restoring the equality guess turns the first three checks red", () => {
  const broken = VM.replace(
    /if \(addedByFirstTap != null\) \{[\s\S]*?\n        \}/,
    `val last = points.last()
        val prior = points[points.size - 2]
        val duplicate = last.x == prior.x && last.y == prior.y`);
  assert.notEqual(broken, VM, "the mutation changed nothing -- anchor is stale");
  assert.ok(/val duplicate = last\.x == prior\.x/.test(broken));
  assert.ok(!/last\.x == addedByFirstTap\.x/.test(broken),
    "the restored version should no longer compare against the passed point");
});
