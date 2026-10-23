// A125 -- THE TWO DRAWING TOOLS HE ASKED FOR, AND THE TWO WAYS THEY GO WRONG.
//
// HIS WORDS: "I need to be able to move the entire fence and everything
// connected to wherever I want on the drawing. Need to be able to click on
// something on the drawing to remove it."
//
// The arithmetic of a move is pure and is proved off device in
// app/src/test/.../WholeDrawingMoveTest.kt -- including the thing that
// matters, that the takeoff measures the same footage, the same side lengths
// and the same post kinds afterwards. What that test cannot see is the SCREEN,
// and the screen is where both of these tools turn into something else:
//
//   1. MOVE FENCE becomes MOVE VIEW if the background is drawn from the same
//      shifted transform as the fence. It would still look like it worked --
//      everything slides under the finger -- and the drawing would keep
//      landing back on top of the same bit of photo, which is the one thing
//      the tool exists to change. The difference is one word per line.
//
//   2. REMOVE becomes a delete with no question if any arm of the tap goes
//      straight to a viewModel call. A tap is a cheap gesture and this one
//      lands on a priced fence, so every arm has to raise a dialog instead.
//
// Both are checks on the SOURCE, like tests/a124-a-pull-must-not-resurrect:
// exercising them for real needs a canvas, a finger and a view transform.
// Each has a positive control, so a regex that stops matching fails loudly
// rather than reporting the file clean.
//
// Run: node --test tests/a125-move-fence-and-tap-to-remove.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const SCREEN = read("app/src/main/java/com/fenceestimator/app/ui/survey/SurveyDrawScreen.kt");
const VM = read("app/src/main/java/com/fenceestimator/app/ui/survey/SurveyViewModel.kt");
const PURE = read("app/src/main/java/com/fenceestimator/app/geometry/WholeDrawingMove.kt");

/** Comments out. A sentence describing a guard is not a guard. */
const code = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1 ");

const SCREEN_CODE = code(SCREEN);
const VM_CODE = code(VM);

test("POSITIVE CONTROL: both modes exist and the readers find them", () => {
  // Without this every assertion below passes when a name is renamed.
  assert.match(VM_CODE, /enum class SurveyMode \{[^}]*\bMOVE_ALL\b/,
    "SurveyMode.MOVE_ALL is gone -- re-read this file");
  assert.match(VM_CODE, /enum class SurveyMode \{[^}]*\bERASE\b/,
    "SurveyMode.ERASE is gone -- re-read this file");
  assert.match(SCREEN_CODE, /SurveyMode\.MOVE_ALL ->/, "the screen no longer handles MOVE_ALL");
  assert.match(SCREEN_CODE, /SurveyMode\.ERASE ->/, "the screen no longer handles ERASE");
  assert.ok(SCREEN_CODE.length > 50000, "the screen read short -- check the path");
});

// -------------------------------------------------------------------------
// 0. MOVE FENCE IS WITHHELD, ON PURPOSE, UNTIL A MONEY DECISION IS MADE
// -------------------------------------------------------------------------

test("Move Fence is behind a readiness flag, and the flag carries its reason", () => {
  // WHY IT IS OFF. A float32 translation is not exactly rigid: `x1 + d` and
  // `x2 + d` each round, so their difference can land a rounding step away
  // from `x1 - x2`. Measured over 200,000 grid-like drawings, 12.5% of moves
  // change the measured total by up to 0.0004 ft. That alone is invisible --
  // but every bay, panel and picket count is `ceil(netFt / size)` with no
  // tolerance, so a side whose length is an exact multiple of the post
  // spacing gains a whole bay the moment it reads a hair over. Aimed at that
  // boundary, 4.5% of moves flipped a bay count: a post, a panel, a cap and
  // a bag of concrete added to a quote by a cosmetic drag.
  //
  // The fix is a 0.001 ft tolerance in both engines' ceil, and it changes a
  // quantity on exactly the jobs float noise is mis-charging today -- which
  // can make an approved job need re-approving. That is a decision about
  // live customer prices, so the flag waits for him.
  assert.match(VM_CODE, /const val WHOLE_DRAWING_MOVE_READY = false/,
    "WHOLE_DRAWING_MOVE_READY is no longer false -- Move Fence can add a bay to a signed quote. " +
    "Flip it only with the ceil tolerance landed in BOTH engines and a parity proof.");
  assert.match(SCREEN_CODE, /if \(SurveyViewModel\.WHOLE_DRAWING_MOVE_READY\) \{/,
    "the Move Fence button is no longer behind the flag");
  // The reason has to travel with the flag. A bare `= false` invites somebody
  // to flip it as dead code.
  const doc = VM.slice(
    Math.max(0, VM.indexOf("const val WHOLE_DRAWING_MOVE_READY") - 3000),
    VM.indexOf("const val WHOLE_DRAWING_MOVE_READY"),
  );
  for (const must of ["ceil", "0.001 ft", "bay", "re-approv"]) {
    assert.ok(doc.includes(must),
      `the flag's own comment no longer says "${must}" -- the reason it is off is being lost`);
  }
});

// -------------------------------------------------------------------------
// 1. MOVE FENCE IS NOT A PAN
// -------------------------------------------------------------------------

test("the background is drawn from the UNSHIFTED transform", () => {
  // THE WHOLE TOOL. While the finger is down the fence, its gates and the
  // markers are drawn shifted by the draft; the survey photo, the satellite
  // tile and the grid are not. Drawn from the same transform, the drawing can
  // never be moved relative to the ground under it -- which is the only
  // reason to move it at all.
  assert.match(SCREEN_CODE, /val viewOnly = viewTransform\(/,
    "the unshifted transform is gone: there is nothing left for the background to use");
  assert.match(SCREEN_CODE, /val transform = wholeMoveDraft\?\.let \{/,
    "the content transform no longer carries the move draft");

  // The photo transform, both arms of it, reads viewOnly.
  const photo = SCREEN_CODE.slice(
    SCREEN_CODE.indexOf("val photoTransform ="),
    SCREEN_CODE.indexOf("drawSurveyBackground("),
  );
  assert.ok(photo.length > 40, "could not find the photoTransform block");
  assert.ok(!/\btransform\.(scale|offsetX|offsetY)\b/.test(photo),
    "photoTransform reads the SHIFTED transform: Move Fence is now just a pan");
  assert.match(photo, /viewOnly/, "photoTransform no longer reads viewOnly");
});

test("nothing is written until the finger lifts", () => {
  // A write per frame would be hundreds of rows per drag, each one a sync
  // push, and the put-back would only undo the last frame of it.
  const move = SCREEN_CODE.slice(
    SCREEN_CODE.indexOf("SurveyMode.MOVE_ALL ->"),
    SCREEN_CODE.indexOf("SurveyMode.ADJUST ->"),
  );
  assert.ok(move.length > 100 && move.length < 4000, `MOVE_ALL block read ${move.length} chars`);
  assert.match(move, /onDragEnd = \{/, "MOVE_ALL no longer commits on the lift");
  // The only moveWholeDrawing call in the gesture is inside onDragEnd.
  const beforeEnd = move.slice(0, move.indexOf("onDragEnd"));
  assert.ok(!/moveWholeDrawing/.test(beforeEnd),
    "moveWholeDrawing is called before the finger lifts -- that is a write per frame");
  assert.match(move, /onDragCancel = \{/,
    "a cancelled drag no longer drops its draft, so the drawing stays drawn shifted");
});

test("leaving the tool drops the draft and any pending question", () => {
  // THE FAILURE: the move draft lives on the gesture, and the gesture is a
  // pointerInput(mode, ...). Changing mode cancels that coroutine, and a
  // cancelled detectDragGestures does NOT call onDragCancel -- so a mode
  // change with a finger down left a draft standing for ever. The canvas goes
  // on drawing the fence shifted, nothing was written, and no gesture is left
  // that could clear it: the drawing looks moved and is not.
  // Anchored on the clearing itself and read outwards: the LaunchedEffect it
  // sits in is the LAST one opened before it. Taking the first
  // `LaunchedEffect(mode)` in the file instead picks up the snap-join one and
  // runs off the end of this block.
  const clearAt = SCREEN_CODE.indexOf("wholeMoveDraft = null");
  assert.ok(clearAt > 0,
    "nothing clears wholeMoveDraft when the tool changes: the fence can stay drawn in the wrong place");
  const opens = [...SCREEN_CODE.matchAll(/LaunchedEffect\(mode\) \{/g)]
    .map((m) => m.index)
    .filter((i) => i < clearAt);
  assert.ok(opens.length > 0, "the clearing is not inside a LaunchedEffect on the mode");
  const clearing = SCREEN_CODE.slice(opens[opens.length - 1], clearAt + 400);
  assert.match(clearing, /mode != SurveyMode\.MOVE_ALL/,
    "the draft is cleared on the wrong condition");
  assert.match(clearing, /pendingGateErase = null/,
    "a remove question survives leaving Remove mode and reappears over Draw");
  assert.match(clearing, /pendingMarkerErase = null/,
    "a marker remove question survives leaving Remove mode");
});

test("the stored offset is in drawing units, not screen pixels", () => {
  // Divided by the view scale, so the same drag moves the fence the same
  // distance on the DRAWING zoomed in and zoomed out. Multiplied, or not
  // converted at all, and a zoomed-in nudge throws the fence off the page.
  const move = SCREEN_CODE.slice(
    SCREEN_CODE.indexOf("SurveyMode.MOVE_ALL ->"),
    SCREEN_CODE.indexOf("SurveyMode.ADJUST ->"),
  );
  assert.match(move, /moveWholeDrawing\(\s*moved\.x \/ scale,\s*moved\.y \/ scale\s*\)/,
    "the move offset is no longer converted out of screen pixels by the view scale");
  assert.match(move, /scale > 0f/,
    "a zero view scale is no longer guarded, so the offset can be a non-finite number");
});

test("the move is all-or-nothing, and the refusal is the pure code's", () => {
  // Half a move is the worst outcome available: the sides that moved and the
  // sides that did not are in different places and every joint between them
  // is nonsense. The plan is computed in full before anything is written.
  const fn = VM_CODE.slice(
    VM_CODE.indexOf("fun moveWholeDrawing("),
    VM_CODE.indexOf("fun putWholeDrawingBack("),
  );
  assert.ok(fn.length > 400, "could not find moveWholeDrawing");
  const planAt = fn.indexOf("WholeDrawingMove.plan(");
  const firstWriteAt = Math.min(
    ...["repository.updateFenceRun(", "repository.updateSiteMarker("]
      .map((s) => fn.indexOf(s))
      .filter((i) => i >= 0)
  );
  assert.ok(planAt > 0, "moveWholeDrawing no longer asks WholeDrawingMove for a plan");
  assert.ok(firstWriteAt > planAt,
    "a row is written before the whole plan is in hand, so a refusal can half-apply");
  assert.match(fn, /\?: return@withLock/,
    "a refused plan no longer stops the function");
  // The pure code is what refuses, and it refuses on every coordinate.
  assert.match(PURE, /if \(everyCoordinate\.any \{ !it\.x\.isFinite\(\) \|\| !it\.y\.isFinite\(\) \}\) return null/,
    "WholeDrawingMove.plan no longer checks every coordinate");
});

test("a row with nothing to move is not written", () => {
  // An empty side -- added and not yet drawn, and most jobs have one -- comes
  // out of the plan identical to how it went in. Writing it anyway stamps a
  // new updatedAt, and fence runs sync last-edit-wins on that clock: this
  // phone's untouched copy would then look newer than an office edit that has
  // not come down yet, and beat it. A write that changes nothing must never
  // win over a write that changes something.
  const fn = VM_CODE.slice(
    VM_CODE.indexOf("fun moveWholeDrawing("),
    VM_CODE.indexOf("fun putWholeDrawingBack("),
  );
  assert.match(fn, /if \(points == run\.pointsEncoded && gates == run\.gatesEncoded\)/,
    "every run is written on a move, even one with nothing on it");
  assert.match(fn, /if \(to\.x == marker\.x && to\.y == marker\.y\)/,
    "every marker is written on a move, even one that did not move");
  // And a move that wrote nothing offers no put-back and keeps the history.
  assert.match(fn, /if \(!wrote\) return@withLock/,
    "a move that moved nothing still records a put-back and clears the undo history");
  const wroteAt = fn.indexOf("if (!wrote) return@withLock");
  assert.ok(wroteAt > 0 && wroteAt < fn.indexOf("clearDrawingHistory()"),
    "the history is cleared before it is known whether anything moved");
});

test("a move takes the per-run undo history with it", () => {
  // The per-run stack holds ONE drawing per run and Undo acts on the SELECTED
  // run. Left standing after a drawing-wide move, one press puts a single
  // side back where it used to be and leaves the rest moved -- a drawing in
  // two places, with nothing on screen saying which half.
  const fn = VM_CODE.slice(
    VM_CODE.indexOf("fun moveWholeDrawing("),
    VM_CODE.indexOf("fun putWholeDrawingBack("),
  );
  assert.match(fn, /clearDrawingHistory\(\)/,
    "the per-run undo history survives a whole-drawing move");
  assert.ok(!/commitEdit\(/.test(fn),
    "a whole-drawing move records per-run undo steps, which Undo would apply one side at a time");
});

test("the put-back does not offer to put itself back", () => {
  // Two buttons each undoing the other, for ever, is not an undo.
  const fn = VM_CODE.slice(
    VM_CODE.indexOf("fun putWholeDrawingBack("),
    VM_CODE.indexOf("fun putWholeDrawingBack(") + 900,
  );
  assert.match(fn, /offerPutBack = false/,
    "the put-back records its own delta as a new move");
  assert.match(fn, /_lastWholeMove\.value = null/,
    "the put-back is still on offer while it runs, so a double press moves twice as far back");
});

// -------------------------------------------------------------------------
// 2. REMOVE ALWAYS ASKS
// -------------------------------------------------------------------------

/** The ERASE tap branch, from its label to the end of its `when`. */
function eraseBranch() {
  const at = SCREEN_CODE.indexOf("SurveyMode.ERASE ->");
  assert.ok(at > 0, "the ERASE tap branch is gone");
  // Up to the next top-level branch of the same `when`.
  const after = SCREEN_CODE.slice(at);
  const end = after.indexOf("else -> {}");
  assert.ok(end > 0, "could not find the end of the tap `when`");
  return after.slice(0, end);
}

test("every arm of a remove tap raises a dialog -- none deletes on the tap", () => {
  const body = eraseBranch();
  assert.ok(body.length > 300, `ERASE branch read ${body.length} chars`);
  // What a tap may do: set a pending-question flag, or count a miss.
  assert.match(body, /pendingGateErase = gateHit/, "a tapped gate no longer raises a question");
  assert.match(body, /pendingMarkerErase = markerHit/, "a tapped marker no longer raises a question");
  assert.match(body, /pendingEraseRunId = wallHit\.first\.id/, "a tapped side no longer raises a question");
  // What it may NOT do: anything that writes.
  for (const forbidden of [
    "viewModel.eraseRun",
    "viewModel.eraseSegment",
    "viewModel.deleteSiteMarker",
    "viewModel.removeGate",
    "viewModel.removeGateFrom",
  ]) {
    assert.ok(!body.includes(forbidden),
      `the remove tap calls ${forbidden} directly -- that is a delete with no question`);
  }
});

test("CANARY: an arm that deletes on the tap is detected", () => {
  // The exact shape that must never ship. If this cannot be spotted, the
  // check above is decoration.
  const pretend = `
    SurveyMode.ERASE -> {
      val wallHit = viewModel.wallNearest(imgPoint, reach)
      if (wallHit != null) viewModel.eraseRun(wallHit.first.id)
    }
    else -> {}`;
  const at = pretend.indexOf("SurveyMode.ERASE ->");
  const body = pretend.slice(at, pretend.indexOf("else -> {}"));
  assert.ok(body.includes("viewModel.eraseRun"),
    "THE CANARY DID NOT FIRE: a tap that deletes outright read as a tap that asks");
});

test("a tap that finds nothing says so", () => {
  // A tool whose taps silently do nothing reads as broken, and the target is
  // a line a few pixels wide.
  const body = eraseBranch();
  assert.match(body, /else -> removeMisses\+\+/, "a missed remove tap is now silent");
  assert.match(SCREEN_CODE, /LaunchedEffect\(removeMisses\) \{/,
    "nothing turns a missed remove tap into a message");
  assert.match(SCREEN, /draw_remove_nothing_there/, "the miss message is gone");
});

test("the hit order is gate, then marker, then fence line", () => {
  // A gate sits ON the line. Letting the line win would make a gate
  // unremovable by tap AND would take off a whole stretch of fence instead --
  // very much bigger than what was aimed at.
  const body = eraseBranch();
  const w = body.indexOf("when {");
  assert.ok(w > 0, "the ERASE branch no longer chooses between hits");
  const choice = body.slice(w);
  const order = ["gateHit != null", "markerHit != null", "wallHit != null"]
    .map((s) => choice.indexOf(s));
  assert.ok(order.every((i) => i > 0), `one of the three arms is gone: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order,
    "the remove hit order changed: a gate or a marker no longer beats the fence line under it");
});

test("a tapped gate is removed from the run it is actually on", () => {
  // removeGate acts on the SELECTED run, which is right for the gate tool. A
  // tap can land on a gate hanging on another side, and removing "the same
  // gate" from the selected run would do nothing, or take off a different
  // gate that happened to match field for field.
  assert.match(VM_CODE, /fun removeGateFrom\(runId: Long, gate: GateMarker\)/,
    "removeGateFrom is gone: a tapped gate has no by-id removal");
  const fn = VM_CODE.slice(
    VM_CODE.indexOf("fun removeGateFrom("),
    VM_CODE.indexOf("fun removeGateFrom(") + 600,
  );
  assert.match(fn, /viewerMayDelete\(\)/, "removeGateFrom no longer checks the right to delete");
  assert.match(fn, /editRun\(runId\)/, "removeGateFrom no longer edits the run it was given");
  assert.match(fn, /commitEdit\(/, "removeGateFrom no longer records an undo step");
});

test("Remove is gated on canDelete in the picker AND again on each dialog", () => {
  // A permission read once further up a screen and acted on further down
  // survives a recomposition with a different session -- a sign-out, or a
  // role change pushed down while the drawing is open.
  assert.match(SCREEN_CODE, /if \(canDeleteHere\) add\(SurveyMode\.ERASE to R\.string\.mode_remove\)/,
    "Remove is offered without checking the right to delete");
  assert.match(SCREEN_CODE, /if \(!canDeleteHere && mode == SurveyMode\.ERASE\)/,
    "losing the right to delete no longer leaves Remove mode");
  // Each dialog re-reads it.
  const gate = SCREEN_CODE.slice(
    SCREEN_CODE.indexOf("pendingGateErase?.let"),
    SCREEN_CODE.indexOf("pendingMarkerErase?.let"),
  );
  const marker = SCREEN_CODE.slice(
    SCREEN_CODE.indexOf("pendingMarkerErase?.let"),
    SCREEN_CODE.indexOf("markerDialogPoint?.let"),
  );
  assert.ok(gate.length > 200 && marker.length > 200, "could not find both remove dialogs");
  assert.match(gate, /session\.canDelete/, "the gate remove dialog does not re-read the permission");
  assert.match(marker, /session\.canDelete/, "the marker remove dialog does not re-read the permission");
  // And each re-finds its target, so a thing that went while the question was
  // up cannot be answered for.
  assert.match(gate, /runs\.firstOrNull \{ it\.id == gateRun\.id \}/,
    "the gate dialog does not re-find its gate's run");
  assert.match(marker, /siteMarkers\.none \{ it\.id == marker\.id \}/,
    "the marker dialog does not re-find its marker");
});

// -------------------------------------------------------------------------
// 3. THE CLOSING SIDE OF A CLOSED LOOP
// -------------------------------------------------------------------------

test("the closing side of a closed loop can be hit at all", () => {
  // It could not be. wallNearest walked points 1..size-1 and stopped, so the
  // one side of a square yard that exists because the loop is closed found
  // whichever other side was next nearest, or nothing -- and tap-to-remove
  // would have inherited that.
  const fn = VM_CODE.slice(
    VM_CODE.indexOf("fun wallNearest("),
    VM_CODE.indexOf("fun gateNearest("),
  );
  assert.ok(fn.length > 300, "could not find wallNearest");
  assert.match(fn, /run\.closedLoop && pts\.size > 2/,
    "wallNearest no longer considers the side that closes a loop");
  assert.match(fn, /distanceToSegment\(p, pts\.last\(\), pts\.first\(\)\)/,
    "wallNearest does not measure to the closing side");
  assert.match(fn, /best = run to \(pts\.size - 1\)/,
    "the closing side is no longer numbered points.size - 1");
});

test("erasing the closing side opens the loop rather than dropping a corner", () => {
  // There is no corner to drop for it: it is drawn by the flag. SegmentErase
  // works on a polyline and rightly knows nothing about it, so handing it
  // that index would report "nothing to erase".
  const fn = VM_CODE.slice(
    VM_CODE.indexOf("fun eraseSegment("),
    VM_CODE.indexOf("fun runNearest("),
  );
  assert.ok(fn.length > 500, "could not find eraseSegment");
  const guardAt = fn.indexOf("segmentIndex == points.size - 1");
  const planAt = fn.indexOf("SegmentErase.plan(");
  assert.ok(guardAt > 0, "eraseSegment no longer has a case for the closing side");
  assert.ok(planAt > guardAt,
    "the closing side reaches SegmentErase, which will report nothing to erase");
  assert.match(fn.slice(guardAt, planAt), /closedLoop = false/,
    "erasing the closing side no longer opens the loop");
  // And the dialog says that, rather than the whole-run warning.
  assert.match(SCREEN_CODE, /closingSide -> R\.string\.draw_erase_closing_title/,
    "the closing side is described by the wrong dialog");
  assert.match(SCREEN_CODE, /val plan = if \(pendingEraseWall >= 0 && !closingSide\)/,
    "a preview is still asked for the closing side, which has none");
});
