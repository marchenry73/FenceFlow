// a104: LONG-PRESS A SIDE TO ERASE IT.
//
// He asked to be able to remove a fence from the drawing and chose
// long-press-and-confirm. The erase ITSELF already existed -- a bin in the top
// tool bar, acting on the selected run, behind session.canDelete -- but that
// bar overflows, so the control sat off the end of it and was effectively
// unreachable. This is a second way to reach the same dialog, not a second
// delete path.
//
// THE TRAP THIS FILE EXISTS FOR. `pendingRunErase` was
// `remember(selectedRunId)`: a boolean meaning "erase the selected one". The
// obvious implementation -- select the pressed side, then raise the flag --
// SILENTLY FAILS, because changing the selection rebuilds that state and
// resets it to false, so the dialog never opens. And it would have passed a
// casual test, because long-pressing the ALREADY-SELECTED side changes no key
// and works. viewZoom and viewPan are keyed the same way, so selecting on
// long-press would also have thrown away his zoom and pan on every press.
//
// So the run id travels instead and nothing touches the selection.
//
// Source-level, like a95/a100/a103: a Compose gesture and a ViewModel needing
// a repository and a coroutine scope. The GESTURE ITSELF CANNOT BE PROVEN
// HERE -- whether a long press is felt, and whether consuming the lift really
// stops the tap layer dropping a corner, is a device question. What is pinned
// is everything that would be wrong on ANY device.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const SCREEN = read("app/src/main/java/com/fenceestimator/app/ui/survey/SurveyDrawScreen.kt");
const VM = read("app/src/main/java/com/fenceestimator/app/ui/survey/SurveyViewModel.kt");
const LIST_VM = read("app/src/main/java/com/fenceestimator/app/ui/runs/FenceRunListViewModel.kt");

test("the erase target is carried by ID, not keyed on the selection", () => {
  assert.match(SCREEN, /var pendingEraseRunId by remember \{ mutableStateOf<Long\?>\(null\) \}/,
    "the pending-erase state must be a run id and must NOT be remember(selectedRunId)");
  assert.ok(!/var pendingRunErase by remember\(selectedRunId\)/.test(SCREEN),
    "the selection-keyed boolean is back; the dialog will never open for a long-pressed side");
});

test("the long-press does not touch the selection", () => {
  // Selecting would reset pendingEraseRunId only if it were keyed -- but it
  // would still throw away viewZoom and viewPan, which ARE keyed.
  const i = SCREEN.indexOf("val hit = viewModel.runNearest(at, reach)");
  assert.ok(i > 0, "the long-press hit test is gone");
  const branch = SCREEN.slice(i, i + 700);
  assert.ok(!/selectRun\(/.test(branch), "the long-press must not select the run it is about to erase");
  assert.match(branch, /pendingEraseRunId = hit\.id/);
});

test("the dialog erases the run it NAMED, not the selected one", () => {
  assert.match(VM, /fun eraseRun\(runId: Long\)/, "there should be an erase-by-id");
  assert.match(SCREEN, /viewModel\.eraseRun\(target\)/,
    "the confirm button must erase the id the dialog is about, not the selection");
  assert.match(SCREEN, /val target = eraseTarget\.id/);
});

test("both ways in ask the permission, and so does the dialog", () => {
  // Three layers. A guard that lives only on the path you happened to read is
  // a guard the other path does not have.
  assert.match(SCREEN, /if \(session\.canDelete\) \{/, "the toolbar button stays gated");
  assert.match(SCREEN, /pendingEraseRunId != null && session\.canDelete/, "the dialog re-reads it");
  assert.match(SCREEN, /if \(session\.canDelete && eraseMode\)/, "the gesture layer is gated");
  const eraseById = VM.slice(VM.indexOf("fun eraseRun(runId: Long)"));
  assert.match(eraseById.slice(0, 200), /if \(!viewerMayDelete\(\)\) return/,
    "eraseRun must ask viewerMayDelete() first, like eraseSelectedRun does");
  const eraseSel = VM.slice(VM.indexOf("fun eraseSelectedRun()"));
  assert.match(eraseSel.slice(0, 160), /if \(!viewerMayDelete\(\)\) return/,
    "eraseSelectedRun must keep its own first check -- GuestReadOnlyTest pins it");
});

test("erasing a side he long-pressed does not move the selection out from under him", () => {
  const body = VM.slice(VM.indexOf("fun eraseRun(runId: Long)"));
  assert.match(body.slice(0, 1800), /if \(_selectedRunId\.value == run\.id\) \{/,
    "the selection should only be reassigned when the erased run WAS the selected one");
});

test("the hit test takes the NEAREST side, and scales its reach with zoom", () => {
  assert.match(VM, /fun runNearest\(p: FencePoint, reach: Float\): FenceRun\?/);
  const near = VM.slice(VM.indexOf("fun runNearest("), VM.indexOf("fun runNearest(") + 900);
  assert.match(near, /bestDistance/, "it must keep the closest, not the first within reach");
  // A fixed distance in drawing units makes every side pressable at once when
  // zoomed out, and none of them reachable when zoomed in.
  assert.match(SCREEN, /VERTEX_HIT_RADIUS_PX \/ transform\.scale/,
    "the reach must be divided by the view scale so it is constant on screen");
});

test("a zero-length segment does not divide by zero", () => {
  // Two coincident points is exactly what a double-tap used to leave behind.
  const d = VM.slice(VM.indexOf("private fun distanceToSegment("));
  assert.match(d.slice(0, 700), /if \(lengthSq <= 0f\) return/);
});

test("the gesture is its own layer, so a slow tap still places a corner", () => {
  // Compose does not fire onTap after a long press, so onLongPress on the
  // shared detectTapGestures would swallow a slow, careful tap -- and in GATE
  // and MARKER a held finger IS a placement.
  assert.ok(!/detectTapGestures\(\s*onLongPress/.test(SCREEN),
    "the long press must not be bolted onto the shared tap detector");
  assert.match(SCREEN, /awaitLongPressOrCancellation\(down\.id\)/);
  // On a miss: nothing consumed, so every existing gesture behaves as before.
  const i = SCREEN.indexOf("val hit = viewModel.runNearest(at, reach)");
  assert.ok(i > 0, "the hit test is gone");
  assert.match(SCREEN.slice(i, i + 900), /if \(hit != null\) \{/,
    "consuming must be conditional on a hit");
});

test("a duplicated run gets its own cloud identity", () => {
  // Not this feature, found while building it: run.copy() does not re-evaluate
  // the syncId default, so a copy carried the ORIGINAL's id. Deleting the copy
  // would then tombstone the original on every phone -- which long-press erase
  // makes a great deal easier to do by accident.
  const dup = LIST_VM.slice(LIST_VM.indexOf("fun duplicateRun("));
  assert.match(dup.slice(0, 2600), /syncId = java\.util\.UUID\.randomUUID\(\)\.toString\(\)/,
    "a duplicate must get a fresh syncId, or deleting it kills the original everywhere");
  assert.match(dup.slice(0, 2600), /startJoint = ""/, "a copy is not standing at the original's shared post");
  assert.match(dup.slice(0, 2600), /endJoint = ""/);
});
