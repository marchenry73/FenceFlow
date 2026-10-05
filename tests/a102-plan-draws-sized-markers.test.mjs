// a102: THE CREW'S PLAN MUST SHOW THE HOUSE AT THE SIZE HE MEASURED IT.
//
// A SiteMarker with a width and a depth is a box -- that is what the column
// comment on Entities.kt says, and it is why those columns exist. But only ONE
// place in the whole app read them: SurveyDrawScreen, the screen he draws on.
//
// FencePlanView -- the shared canvas behind the crew's plan and the plan that
// goes out with the quote -- drew every marker as drawCircle(radius = 13f).
// So a house measured at 40 by 30 and turned to face the road showed its real
// footprint to the man who measured it, and a dot to the crew building from
// it. The size, the shape and the rotation were invisible to everyone whose
// work depends on them.
//
// Source-level because this is a Compose canvas: there is no way to render it
// off-device, and the thing worth pinning is that both surfaces read the same
// two columns and convert them the same way.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const PLAN = read("app/src/main/java/com/fenceestimator/app/ui/components/FencePlanView.kt");
const SURVEY = read("app/src/main/java/com/fenceestimator/app/ui/survey/SurveyDrawScreen.kt");
const ENTITIES = read("app/src/main/java/com/fenceestimator/app/data/Entities.kt");

// The marker loop only. A comment elsewhere about houses must not satisfy any
// of this.
function markerLoop(src) {
  const i = src.indexOf("markers.forEach { marker ->");
  assert.ok(i > 0, "the marker loop is gone from FencePlanView");
  const end = src.indexOf("\n                }", i);
  return src.slice(i, end > i ? end : i + 2000);
}

test("the plan reads the marker's measured size at all", () => {
  const loop = markerLoop(PLAN);
  assert.match(loop, /marker\.widthFt/, "FencePlanView never reads widthFt");
  assert.match(loop, /marker\.heightFt/, "FencePlanView never reads heightFt");
});

test("it draws a box, not only a dot", () => {
  const loop = markerLoop(PLAN);
  assert.match(loop, /drawRect\(/, "no rectangle is drawn, so a house is still a dot");
  // Fill and outline, as on the survey screen: a hollow box over a photo is
  // hard to see, and a solid one hides the fence behind it.
  assert.ok((loop.match(/drawRect\(/g) || []).length >= 2,
    "expected a translucent fill and an outline, as the survey screen draws");
});

test("it honours the rotation, because a house is never square to the road", () => {
  const loop = markerLoop(PLAN);
  assert.match(loop, /rotate\(degrees = marker\.rotationDeg/,
    "an unrotated box is the wrong footprint on almost every lot");
});

test("a marker with no size is still just a dot", () => {
  // Zero means point, deliberately -- every marker made before those columns
  // existed has zero, and must go on drawing exactly as it did.
  const loop = markerLoop(PLAN);
  assert.match(loop, /if \(wFt > 0f && hFt > 0f\)/,
    "the box must be conditional on there being a size");
  assert.match(ENTITIES, /val widthFt: Float = 0f/,
    "the entity's default should still be zero");
});

test("the dot survives the box", () => {
  // The legend's colours refer to the dot, and on a plan with a large house it
  // is the only thing marking the exact spot.
  const loop = markerLoop(PLAN);
  assert.match(loop, /drawCircle\(colour, radius = 13f/);
});

test("both surfaces convert feet the same way", () => {
  // The survey screen uses gridPxPerFt * transform.scale; the plan uses
  // pxPerFoot * scale, which is what squarePx already uses for the grid. If
  // these ever disagree the box lands beside the squares it was drawn on
  // rather than over them.
  assert.match(SURVEY, /wFt \* scale \/ 2f/, "the survey screen's conversion moved");
  const loop = markerLoop(PLAN);
  assert.match(loop, /wFt \* pxPerFoot \* scale \/ 2f/,
    "the plan should use the same feet-to-pixels factor the grid uses");
  assert.match(PLAN, /val squarePx = feetPerSquare \* pxPerFoot \* scale/,
    "the grid's own conversion changed, so the box no longer matches it");
});

test("TEETH: putting the dot-only version back turns the first checks red", () => {
  const broken = PLAN.replace(
    markerLoop(PLAN),
    `markers.forEach { marker ->
                    val at = place(FencePoint(marker.x, marker.y))
                    drawCircle(PlanColors.marker(marker.kind), radius = 13f, center = at)
                    drawCircle(Color.White, radius = 13f, center = at, style = Stroke(width = 3f))`);
  assert.notEqual(broken, PLAN, "the mutation changed nothing");
  const loop = markerLoop(broken);
  assert.ok(!/marker\.widthFt/.test(loop), "the restored version should not read the size");
  assert.ok(!/drawRect\(/.test(loop), "the restored version should draw no box");
});
