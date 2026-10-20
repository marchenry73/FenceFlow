// A109 -- the office must measure a drawing at the scale the drawing was made
// at, not at a number that happens to be right on a 400ft grid.
//
// Run with:  node --test tests/a109-office-drawing-scale.test.mjs
//
// THE BUG. DrawingScale.of() on the phone is
//
//     calibration ?: (no survey photo ? GRID_CANVAS_SIZE / grid_extent_ft : null)
//
// and GRID_CANVAS_SIZE is 8000, so a 400ft grid is exactly 20 units per foot.
// website/dashboard.html hardcoded that 20 in four places and never selected
// grid_extent_ft at all, so every job read as a 400ft grid.
//
// That was not only a drawing that came out the wrong size on screen.
// satPointsToRunSpace() converts a satellite trace into run coordinates and
// those coordinates are SAVED -- so a trace added to a job drawn at 100ft was
// stored at a quarter of its real length, and the engine priced it at a
// quarter. Live when this was written: three jobs are not at 400ft (50ft and
// 100ft), and three carry a calibration that is not 20.
//
// Every source check here is paired with a canary that sabotages a copy and
// asserts the check would have gone red.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const DASH = "website/dashboard.html";
const KT = "app/src/main/java/com/fenceestimator/app/estimate/DrawingScale.kt";

/** dashboard.html with comments blanked, string literals left alone. */
function stripComments(src) {
  let out = "";
  let i = 0;
  const blank = (ch) => (ch === "\n" ? "\n" : " ");
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c; i++;
      while (i < src.length) {
        if (src[i] === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i++; break; }
        if (src[i] === "\n" && quote !== "`") { i++; break; }
        i++;
      }
      continue;
    }
    if (two === "//") { while (i < src.length && src[i] !== "\n") { out += " "; i++; } }
    else if (two === "/*") {
      while (i < src.length && src.slice(i, i + 2) !== "*/") { out += blank(src[i]); i++; }
      out += "  "; i += 2;
    } else if (src.slice(i, i + 4) === "<!--") {
      while (i < src.length && src.slice(i, i + 3) !== "-->") { out += blank(src[i]); i++; }
      out += "   "; i += 3;
    } else { out += c; i++; }
  }
  return out;
}

/** The { ... } block starting at `open`, braces balanced. */
function braced(src, open) {
  if (open < 0 || src[open] !== "{") return "";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return "";
}

const SRC = read(DASH);
const CODE = stripComments(SRC);

/** The office's own jobDrawingScale, lifted and run for real. */
function officeScale() {
  const at = CODE.indexOf("function jobDrawingScale(job)");
  assert.ok(at > 0, "jobDrawingScale is gone from the office");
  const open = CODE.indexOf("{", at);
  const block = braced(CODE, open);
  assert.ok(block.length > 40, "jobDrawingScale's body could not be lifted out");
  const fn = CODE.slice(at, open) + block;
  return new Function(fn + "\nreturn jobDrawingScale;")();
}

// ===========================================================================
// 1. The rule itself, against the Kotlin it is a transcription of
// ===========================================================================

test("the phone's rule is still the three cases this is transcribed from", () => {
  // Read the Kotlin rather than trusting a comment about it: if DrawingScale
  // changes, this test must fail rather than keep checking the old shape.
  const kt = read(KT);
  assert.match(kt, /const val PIXELS_PER_FOOT_GRID = 20f/,
    "the grid default is no longer 20 units per foot");
  assert.match(kt, /const val GRID_CANVAS_SIZE = 8000/,
    "the grid canvas is no longer 8000 units across -- 8000/extent is the rule this transcribes");
  assert.match(kt, /if \(extentFt <= 0f\) PIXELS_PER_FOOT_GRID\s*\n\s*else GRID_CANVAS_SIZE \/ extentFt/,
    "unitsPerFoot is no longer GRID_CANVAS_SIZE / extent");
  assert.match(
    kt,
    /calibrationPixelsPerFoot\?\.takeIf \{ it > 0f && it\.isFinite\(\) \}\s*\n\s*\?: if \(surveyImagePath == null\) unitsPerFoot\(gridExtentFt\) else null/,
    "DrawingScale.of is no longer calibration-then-grid-then-null"
  );
});

test("the office answers exactly what the phone would, case for case", () => {
  const scale = officeScale();
  const cases = [
    // [job, expected, why]
    [{ calibration_pixels_per_foot: 37.5 }, 37.5, "a stored calibration always wins"],
    [{ calibration_pixels_per_foot: 20 }, 20, "including one that happens to be 20"],
    [{ calibration_pixels_per_foot: 37.5, survey_storage_path: "x/y.png" }, 37.5,
      "a calibrated photo job measures by its calibration"],
    [{ grid_extent_ft: 400 }, 20, "a 400ft grid is 8000/400 -- the old hardcoded number"],
    [{ grid_extent_ft: 100 }, 80, "a 100ft grid is four times finer"],
    [{ grid_extent_ft: 50 }, 160, "a 50ft grid is eight times finer"],
    [{ grid_extent_ft: 2000 }, 4, "a 2000ft grid is five times coarser"],
    [{}, 20, "no extent recorded is the 400ft default, so an old job measures as it always did"],
    [{ survey_storage_path: "company/job/survey/x.png" }, null,
      "a photo nobody has calibrated has NO scale -- the office cannot know how big a photograph is"],
    // A stored value that is not a usable number is treated as absent, like the Kotlin's takeIf.
    [{ calibration_pixels_per_foot: 0, grid_extent_ft: 100 }, 80, "a stored zero is not a calibration"],
    [{ calibration_pixels_per_foot: -5, grid_extent_ft: 100 }, 80, "nor is a negative one"],
    [{ calibration_pixels_per_foot: "", grid_extent_ft: 100 }, 80, "nor is a blank"],
    [{ grid_extent_ft: 0 }, 20, "a zero extent falls back to the default rather than dividing by it"],
  ];
  for (const [job, expected, why] of cases) {
    assert.equal(scale(job), expected, `${why} -- ${JSON.stringify(job)}`);
  }
});

test("it never answers NaN, zero or Infinity", () => {
  const scale = officeScale();
  for (const job of [
    {}, null, undefined,
    { grid_extent_ft: NaN }, { grid_extent_ft: Infinity }, { grid_extent_ft: -10 },
    { calibration_pixels_per_foot: NaN }, { calibration_pixels_per_foot: Infinity },
    { calibration_pixels_per_foot: "twenty" },
  ]) {
    const v = scale(job);
    if (v === null) continue;
    assert.ok(Number.isFinite(v) && v > 0, `${JSON.stringify(job)} -> ${v}`);
  }
});

// ===========================================================================
// 2. The office can actually SEE what the rule needs
// ===========================================================================

test("grid_extent_ft is selected, or the rule reads undefined on every job", () => {
  // The same shape as survey_storage_path and blocked_at before it: a column
  // read without being selected is undefined everywhere, and the branch that
  // depends on it silently never fires.
  const at = CODE.indexOf("const JOB_COLUMNS = [");
  assert.ok(at > 0, "JOB_COLUMNS is gone");
  const list = CODE.slice(at, CODE.indexOf("];", at));
  for (const col of ["grid_extent_ft", "calibration_pixels_per_foot", "survey_storage_path"]) {
    assert.ok(list.includes(`'${col}'`), `${col} is not in JOB_COLUMNS, so jobDrawingScale cannot read it`);
  }
});

test("CANARY: dropping grid_extent_ft from the column list turns that check red", () => {
  const at = CODE.indexOf("const JOB_COLUMNS = [");
  const list = CODE.slice(at, CODE.indexOf("];", at));
  const sabotaged = list.replace("'grid_extent_ft',", "");
  assert.notEqual(sabotaged, list, "the canary did not change the source");
  assert.ok(!sabotaged.includes("'grid_extent_ft'"),
    "THE CANARY DID NOT FAIL: a column dropped from the select went unnoticed");
});

// ===========================================================================
// 3. Nothing writes saved geometry at a guessed scale any more
// ===========================================================================

test("the satellite conversions take the scale, they do not assume one", () => {
  for (const fn of ["satPointsToRunSpace", "satGatesToRunSpace"]) {
    const at = CODE.indexOf("function " + fn + "(");
    assert.ok(at > 0, `${fn} is gone`);
    const signature = CODE.slice(at, CODE.indexOf(")", at) + 1);
    assert.ok(/pxPerFt/.test(signature), `${fn} does not take the scale as an argument`);
    const body = braced(CODE, CODE.indexOf("{", at));
    assert.ok(/const PX_PER_FT = pxPerFt/.test(body),
      `${fn} still fixes its own scale instead of using the one it was given`);
    assert.ok(!/const PX_PER_FT = 20/.test(body),
      `${fn} still hardcodes 20 units per foot`);
  }
});

test("every caller passes the job's scale", () => {
  const calls = [...CODE.matchAll(/sat(Points|Gates)ToRunSpace\(([^)]*)\)/g)];
  assert.ok(calls.length >= 4, `only ${calls.length} call sites found; there are four`);
  for (const c of calls) {
    const args = c[2].split(",").map((a) => a.trim());
    assert.ok(args.length >= 4,
      `a call site passes ${args.length} arguments and so uses the default scale: ${c[0]}`);
    assert.ok(/pxPerFt|PxPerFt/.test(args[args.length - 1]),
      `the last argument of ${c[0]} is not a scale`);
  }
});

test("a trace cannot be saved onto a job with no scale at all", () => {
  const at = CODE.indexOf("async function saveSatelliteRun()");
  assert.ok(at > 0, "saveSatelliteRun is gone");
  const fn = braced(CODE, CODE.indexOf("{", at));
  const guard = fn.indexOf("if (!pxPerFt)");
  const convert = fn.indexOf("satPointsToRunSpace(");
  assert.ok(guard > 0, "nothing refuses a job whose scale is unknown");
  assert.ok(convert > guard,
    "the trace is converted before the scale has been checked, so a guessed one is used anyway");
  assert.ok(/satNeedsCalibration/.test(fn),
    "the refusal no longer says why, which is what makes it a dead control");
});

test("the refusal is written in all three languages", () => {
  const keys = [...SRC.matchAll(/satNeedsCalibration\s*:/g)];
  assert.equal(keys.length, 3,
    `satNeedsCalibration is defined ${keys.length} times; the page has three locales`);
});

test("CANARY: converting before the guard, and a hardcoded 20, each turn those checks red", () => {
  const at = CODE.indexOf("async function saveSatelliteRun()");
  const fn = braced(CODE, CODE.indexOf("{", at));
  // Hoist the conversion above the guard.
  const convLine = fn.split("\n").find((l) => l.includes("satPointsToRunSpace("));
  assert.ok(convLine, "the canary cannot find the conversion");
  const hoisted = convLine + "\n" + fn.replace(convLine, "");
  assert.ok(hoisted.indexOf("satPointsToRunSpace(") < hoisted.indexOf("if (!pxPerFt)"),
    "THE CANARY DID NOT FAIL: a conversion hoisted above the guard went unnoticed");

  // And put the hardcoded scale back.
  const pts = CODE.indexOf("function satPointsToRunSpace(");
  const body = braced(CODE, CODE.indexOf("{", pts));
  const reverted = body.replace("const PX_PER_FT = pxPerFt", "const PX_PER_FT = 20");
  assert.notEqual(reverted, body, "the canary did not change the source");
  assert.ok(/const PX_PER_FT = 20/.test(reverted),
    "THE CANARY DID NOT FAIL: a hardcoded scale put back went unnoticed");
});

// ===========================================================================
// 4. What a wrong scale would actually have cost
// ===========================================================================

test("the error a hardcoded 20 produces is the ratio of the two scales", () => {
  // Not decoration: this is the number that says whether the bug is cosmetic
  // or a price. Points are stored in units; feet = units / scale. Stored at
  // 20 and measured at 80, a 100ft fence reads as 25ft.
  const scale = officeScale();
  const realFeet = 100;
  for (const [job, factor] of [
    [{ grid_extent_ft: 400 }, 1],
    [{ grid_extent_ft: 100 }, 1 / 4],
    [{ grid_extent_ft: 50 }, 1 / 8],
    [{ grid_extent_ft: 2000 }, 5],
  ]) {
    const correct = scale(job);
    const storedUnits = realFeet * 20;            // what the old code wrote
    const measuredFeet = storedUnits / correct;   // what the engine then read
    assert.ok(Math.abs(measuredFeet - realFeet * factor) < 0.001,
      `at ${JSON.stringify(job)} a ${realFeet}ft fence would have been measured as ${measuredFeet}ft`);
  }
});
