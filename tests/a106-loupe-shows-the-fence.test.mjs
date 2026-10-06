// a106: THE ADJUST MAGNIFIER MUST SHOW THE FENCE.
//
// "When I use the adjust one I don't see the fence in the zoom so I can know
// where to drop it."
//
// MagnifierLoupe drew drawSurveyBackground -- the photo, the grid, the
// satellite tiles -- and then a crosshair, and stopped. The one thing he is
// aiming AT was the one thing not in it. A magnified aerial photo with a
// crosshair tells you where your finger is and nothing about where the line
// wants to go, which is the whole job of a loupe in Adjust.
//
// Source-level: a Compose Canvas inside a 130dp circle. What CANNOT be proven
// here is whether it looks right; what can be proven is that the fence is
// drawn at all, under the crosshair, with the same transform as the background
// so it lands where the photo says it does.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCREEN = readFileSync(
  join(ROOT, "app/src/main/java/com/fenceestimator/app/ui/survey/SurveyDrawScreen.kt"), "utf8");

function loupeBody() {
  const i = SCREEN.indexOf("private fun MagnifierLoupe(");
  assert.ok(i > 0, "MagnifierLoupe is gone -- renamed?");
  const end = SCREEN.indexOf("\n@Composable", i + 10);
  return SCREEN.slice(i, end > i ? end : i + 6000);
}

test("the loupe is given the runs to draw", () => {
  const body = loupeBody();
  assert.match(body, /runs: List<FenceRun>/, "the loupe cannot draw a fence it was never handed");
  assert.match(body, /activeRunId: Long/, "it needs to know which run is his, to draw it differently");
});

test("it actually draws the fence line", () => {
  const body = loupeBody();
  assert.match(body, /FenceCodec\.decodePoints\(r\.pointsEncoded\)/,
    "the loupe should decode each run's points");
  assert.match(body, /drawLine\(/, "no line is drawn, so the fence is still missing");
});

test("it uses the loupe's OWN transform, not the main canvas's", () => {
  // localTransform is what puts the dragged point at the circle's centre. Using
  // the screen transform instead would draw the fence somewhere else entirely
  // -- a loupe showing a fence that is not under the crosshair is worse than a
  // loupe showing no fence, because it is confidently wrong.
  const body = loupeBody();
  assert.match(body, /localTransform\.toCanvas\(pts\[i - 1\]\)/);
  assert.match(body, /localTransform\.toCanvas\(pts\[i\]\)/);
  assert.ok(!/\btransform\.toCanvas\(pts/.test(body),
    "the loupe must not use the outer canvas transform");
});

test("the fence is drawn UNDER the crosshair", () => {
  // The crosshair marks the point being dragged. Drawing the fence over it
  // would hide the one thing the loupe exists to show.
  const body = loupeBody();
  const fenceAt = body.indexOf("FenceCodec.decodePoints(r.pointsEncoded)");
  const crossAt = body.indexOf("A crosshair at the loupe's exact centre");
  assert.ok(fenceAt > 0 && crossAt > 0, "could not find both");
  assert.ok(fenceAt < crossAt, "the fence must be drawn before the crosshair");
});

test("the active side reads differently from the others", () => {
  // The main canvas already separates them. A loupe that drew every run
  // identically would invent a second visual language for the same drawing.
  const body = loupeBody();
  assert.match(body, /val isActive = r\.id == activeRunId/);
  assert.match(body, /if \(isActive\) colour else colour\.copy\(alpha = 0\.35f\)/,
    "the other runs should be faint, as they are on the main canvas");
  assert.match(body, /PlanColors\.teardownLine else PlanColors\.fenceLine/,
    "it should use the same colours the canvas uses, not new ones");
});

test("the active side's corners are marked", () => {
  // The commonest reason to be in Adjust is putting a corner back where the
  // tape says it is, so the corner is the thing to land on.
  const body = loupeBody();
  assert.match(body, /if \(isActive\) \{[\s\S]{0,260}?drawCircle\(colour/,
    "the corners of the run being adjusted should be visible");
});

test("a run with fewer than two points is skipped, not drawn as nothing", () => {
  const body = loupeBody();
  assert.match(body, /if \(pts\.size < 2\) continue/);
});

test("the call site passes them", () => {
  const i = SCREEN.indexOf("MagnifierLoupe(");
  assert.ok(i > 0);
  // Sliced to the END OF THE CALL, not a guessed number of characters. A fixed
  // window that happens to stop short fails against correct code and reads as
  // the argument being missing -- which is how this check first failed.
  const end = SCREEN.indexOf("\n                            )", i);
  assert.ok(end > i, "could not find the end of the MagnifierLoupe call");
  const call = SCREEN.slice(i, end);
  assert.match(call, /runs = runs/);
  assert.match(call, /activeRunId = activeRun\.id/);
});

test("TEETH: removing the fence drawing turns the first checks red", () => {
  const body = loupeBody();
  const broken = body.replace(/for \(r in runs\) \{[\s\S]*?\n                \}\n/, "");
  assert.notEqual(broken, body, "the mutation changed nothing -- anchor is stale");
  assert.ok(!/FenceCodec\.decodePoints\(r\.pointsEncoded\)/.test(broken),
    "the restored version should draw no fence");
});
