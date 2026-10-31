// a91 -- the drawing measures by the grid's extent; the pricing measures by a
//        flat 20. They agree at exactly one grid size, and nothing said so.
//
// WHY THIS EXISTS. The owner's list carries this as still open: "Office and
// phone measure an uncalibrated job differently -- the office assumes 20 px/ft
// and never reads the grid size, so they agree only at 400 ft. Unreachable
// today, but the new grid sizes raise the possible error from 5x to 25x."
//
// Half of that is now fixed: the office page used to hardcode 20 in four
// places and `jobDrawingScale()` is extent-aware today. The other half is
// real and deliberate, and PricingAdapters.kt names it in its own words --
// "a different, still-open split (between this flat fallback and the drawing
// screen's own DrawingScale.of, which IS extent-aware) that SurveyViewModel
// closes by never leaving such a job uncalibrated in the first place".
//
// So four pieces of code resolve a drawing's scale:
//
//   phone drawing   DrawingScale.of           extent-aware: 8000 / extent
//   office page     jobDrawingScale()         extent-aware: 8000 / extent
//   phone engine    footageOf's fallback      FLAT: PIXELS_PER_FOOT_GRID
//   server pricing  load.ts buildPricingInput FLAT: calibration ?? 20
//
// Points are STORED in canvas units. Draw at 8000/extent and price at 20 and
// the billed length is real_feet * 400 / extent:
//
//      25 ft grid   ->  16x    the fence is billed SIXTEEN TIMES too long
//     400 ft grid   ->   1x    the one size where the two rules coincide
//   10000 ft grid   ->  1/25   billed at four per cent of its real length
//
// The whole thing is safe for exactly one reason: no job can have a
// non-default extent AND no calibration. setGridExtent writes
// calibrationPixelsPerFoot whenever it changes the scale, and -- the part
// that is easy to break and impossible to see -- THE OFFICE NEVER WRITES
// grid_extent_ft AT ALL. It reads the column and offers no control for it.
// The day the office gains a grid-size picker, or load.ts starts reading the
// extent without the engine following, the server prices a fence at up to
// sixteen times its length with every test green.
//
// This file pins the agreement, measures the divergence so the numbers above
// are under test rather than asserted in prose, and guards the absence the
// safety rests on.
//
//   node tests/a91-one-scale-for-pricing.test.mjs      (no network, no writes)
import { readFileSync } from "node:fs";

const dashboardSrc = readFileSync("website/dashboard.html", "utf8");
const loadTs = readFileSync("supabase/functions/_shared/pricing/load.ts", "utf8");
const drawingScaleKt = readFileSync(
  "app/src/main/java/com/fenceestimator/app/estimate/DrawingScale.kt", "utf8");
const surveyVmKt = readFileSync(
  "app/src/main/java/com/fenceestimator/app/ui/survey/SurveyViewModel.kt", "utf8");

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? " — " + detail : "")); }
};

/** Comment-stripped source, so a number quoted in prose is never read as code. */
function stripCode(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '"' || c === "'" || c === "`") {
      const q = c; let j = i + 1;
      while (j < src.length && src[j] !== q) { if (src[j] === "\\") j++; j++; }
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; out += " "; continue; }
    out += c; i++;
  }
  return out;
}

function grabFn(src, name) {
  let start = src.indexOf("async function " + name + "(");
  if (start < 0) start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("not found: " + name);
  let depth = 0;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error("unbalanced: " + name);
}

// ---- Every number below is READ FROM SOURCE, never typed in here. A test
// that hardcodes 8000 and 20 keeps passing after somebody changes them.
const KT = stripCode(drawingScaleKt);
const CANVAS = Number(/const val GRID_CANVAS_SIZE\s*=\s*([0-9]+)/.exec(KT)[1]);
const FLAT_KT = Number(/const val PIXELS_PER_FOOT_GRID\s*=\s*([0-9.]+)f/.exec(KT)[1]);
const FLAT_SERVER = Number(
  /calibration_pixels_per_foot\s*\?\?\s*([0-9.]+)/.exec(stripCode(loadTs))[1]);
const GRID_SIZES = /val GRID_SIZES_FT = listOf\(([^)]*)\)/.exec(stripCode(surveyVmKt))[1]
  .split(",").map((s) => Number(s.trim().replace(/f$/, "")));

const office = new Function(grabFn(dashboardSrc, "jobDrawingScale")
  + "; return jobDrawingScale;")();

/** The flat rule, as the server and the phone's engine both apply it. */
const pricingScale = (job) => {
  const cal = Number(job && job.calibration_pixels_per_foot);
  return Number.isFinite(cal) && cal > 0 ? cal : FLAT_SERVER;
};

const grid = (extent, cal = null) => ({
  calibration_pixels_per_foot: cal, survey_storage_path: null, grid_extent_ft: extent,
});

console.log("\n0. The real rules were extracted and every constant read from source:");
ok(`GRID_CANVAS_SIZE read from DrawingScale.kt (${CANVAS})`, CANVAS === 8000, `got ${CANVAS}`);
ok(`PIXELS_PER_FOOT_GRID read from DrawingScale.kt (${FLAT_KT})`, FLAT_KT > 0);
ok(`the server's fallback read from load.ts (${FLAT_SERVER})`, FLAT_SERVER > 0);
ok(`GRID_SIZES_FT read from SurveyViewModel.kt (${GRID_SIZES.length} sizes)`,
  GRID_SIZES.length >= 5 && GRID_SIZES.every((n) => Number.isFinite(n) && n > 0),
  JSON.stringify(GRID_SIZES));
ok("jobDrawingScale is callable", typeof office === "function" && office(grid(400)) === 20);

console.log("\n1. The phone's engine and the server use the SAME flat fallback:");
// If one of them became extent-aware without the other, a drawing would be
// billed at two different lengths by the two engines that are meant to agree.
ok(`PIXELS_PER_FOOT_GRID (${FLAT_KT}) === load.ts's fallback (${FLAT_SERVER})`,
  FLAT_KT === FLAT_SERVER,
  "the phone's engine and the server no longer fall back to the same scale");

console.log("\n2. There is exactly ONE grid size where drawing and pricing agree:");
const DEFAULT_EXTENT = CANVAS / FLAT_SERVER;
ok(`that size is ${DEFAULT_EXTENT} ft, derived from the constants and not typed here`,
  DEFAULT_EXTENT === 400, `got ${DEFAULT_EXTENT}`);
ok("and it is one of the sizes actually offered", GRID_SIZES.includes(DEFAULT_EXTENT));
{
  const agree = GRID_SIZES.filter((e) => office(grid(e)) === pricingScale(grid(e)));
  ok(`only ${DEFAULT_EXTENT} ft agrees, out of ${GRID_SIZES.length} sizes offered`,
    agree.length === 1 && agree[0] === DEFAULT_EXTENT, `agreeing: ${JSON.stringify(agree)}`);
}

console.log("\n3. The divergence, measured -- these are the numbers in the comment:");
for (const extent of GRID_SIZES) {
  const factor = office(grid(extent)) / pricingScale(grid(extent));
  const want = DEFAULT_EXTENT / extent;
  ok(`${extent} ft grid: a fence is billed ${factor}x its length`,
    Math.abs(factor - want) < 1e-9, `got ${factor}, want ${want}`);
}
{
  const worstOver = Math.max(...GRID_SIZES.map((e) => DEFAULT_EXTENT / e));
  const worstUnder = Math.min(...GRID_SIZES.map((e) => DEFAULT_EXTENT / e));
  ok(`the worst overcharge is ${worstOver}x, at the ${DEFAULT_EXTENT / worstOver} ft grid`,
    worstOver === 16, `got ${worstOver}`);
  ok(`the worst undercharge is 1/${Math.round(1 / worstUnder)}, at the `
    + `${DEFAULT_EXTENT / worstUnder} ft grid -- the owner's list says 25`,
    Math.round(1 / worstUnder) === 25, `got 1/${1 / worstUnder}`);
}

console.log("\n4. A calibrated job cannot diverge at all, whatever its extent:");
for (const extent of GRID_SIZES) {
  const j = grid(extent, 37.5);
  ok(`${extent} ft grid with a stored calibration: both read 37.5`,
    office(j) === 37.5 && pricingScale(j) === 37.5,
    `office ${office(j)}, pricing ${pricingScale(j)}`);
}

console.log("\n5. An uncalibrated photo has no scale, and the office says so:");
{
  const photo = { calibration_pixels_per_foot: null, survey_storage_path: "s/p.jpg",
                  grid_extent_ft: 100 };
  ok("jobDrawingScale returns null rather than guessing", office(photo) === null,
    `got ${office(photo)}`);
  ok("and never returns 0, NaN or Infinity for any input",
    [grid(0), grid(-5), grid(null), grid(NaN), {}].every((j) => {
      const v = office(j);
      return v === null || (Number.isFinite(v) && v > 0);
    }));
}

console.log("\n6. THE GUARD: the office must not write grid_extent_ft:");
// This absence is the entire reason the split above is safe. The office reads
// the column and offers no control for it, so a non-default extent can only
// come from the phone -- which writes a calibration alongside it. A
// grid-size picker added to this page would reintroduce the 16x silently.
{
  const code = stripCode(dashboardSrc);
  const writes = [...code.matchAll(/grid_extent_ft\s*:/g)];
  ok("no insert/update payload in the office sets grid_extent_ft",
    writes.length === 0, `${writes.length} writer(s) found`);
  ok("but the office DOES read it, or jobDrawingScale could not be extent-aware",
    code.includes("grid_extent_ft"));
  // CANARY: plant the writer a future feature would add.
  const mutated = code.replace("sort_order: mine.length,",
    "sort_order: mine.length, grid_extent_ft: 100,");
  // Counted RELATIVE to the baseline, not against a bare 1: if the guard
  // above is ever genuinely violated, this canary must still be testing the
  // detector rather than failing a second time for the same reason.
  ok("THE CANARY FIRES: a planted grid_extent_ft writer is detected",
    mutated !== code
      && [...mutated.matchAll(/grid_extent_ft\s*:/g)].length === writes.length + 1,
    "the planted writer was not seen, so the check above proves nothing");
}

console.log("\n7. The satellite trace refuses to be saved into a guessed scale:");
// satSave encodes its points AT jobDrawingScale and writes them to
// fence_runs. With no scale it must refuse rather than store a trace that
// prices as a different length than it was drawn.
{
  const sat = dashboardSrc.slice(dashboardSrc.indexOf("const pxPerFt = jobDrawingScale(j);"));
  const guard = sat.slice(0, 400);
  ok("it asks jobDrawingScale for the scale", guard.includes("jobDrawingScale(j)"));
  ok("and returns with a message when there is none",
    /if\s*\(!pxPerFt\)/.test(guard) && /return msg\(/.test(guard),
    "the refusal is gone -- a trace could be stored at a guessed scale");
  ok("and it encodes the points in that same scale, not a constant",
    /satPointsToRunSpace\([^)]*pxPerFt\)/.test(sat));
  ok("and it writes no calibration of its own, so the job's scale is unchanged",
    !/calibration_pixels_per_foot\s*:/.test(sat.slice(0, 2000)));
}

console.log(`\n${pass} of ${pass + fail} checks passed`);
if (fail) process.exit(1);
