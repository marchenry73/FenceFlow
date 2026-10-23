// HOW TO RUN IT, since it needs a dump of the live runs first:
//
//   npx.cmd -y --no-install supabase@2.115.0 db query --linked //     --project-ref newcrgafcptspmapacrx //     -f docs/measurements/affected_jobs_query.sql --output json > runs.json
//   node docs/measurements/affected_jobs.mjs runs.json
//
// The CLI prints an upgrade notice after the JSON, so strip anything after the
// final closing brace before parsing, or JSON.parse stops on it.
//
// WHAT IT ANSWERED, 23 October 2026, before the 0.001 ft tolerance shipped:
//   live runs examined: 31
//   runs whose counts the tolerance would change: 0
//   closest any run comes to a boundary from above: 0.058685 ft (59x the
//   tolerance)
//
// WHICH LIVE JOBS WOULD THE 0.001 ft TOLERANCE CHANGE?
//
// Read-only. The question is narrow: a bay, panel or picket count is
// ceil(feet / size), and the tolerance subtracts 0.001 ft from the feet
// first. The two answers differ ONLY when the footage lands in the sliver
// (N*size, N*size + 0.001] -- that is, within a thousandth of a foot ABOVE an
// exact multiple. A round typed number like 96 ft at 8 ft spacing is exactly
// on the multiple, not above it, so it is unaffected either way.
//
// Footage is recomputed here the way both engines do it: float32 throughout,
// via Math.fround, which is the same discipline
// supabase/functions/_shared/pricing/f32.ts documents.
//
// WHAT THIS DOES NOT SEE: gate openings are deducted from the footage before
// the counts, and a joint between two runs moves a post. So the figure here is
// the drawn footage, not necessarily the engine's netFt. It is therefore used
// as a FILTER, not a verdict: anything it flags gets priced properly, and a
// run it does not flag is nowhere near a boundary and cannot be touched by a
// thousandth of a foot.

import { readFileSync } from "node:fs";

const f = Math.fround;
const RAW = readFileSync(process.argv[2], "utf8");
const rows = JSON.parse(RAW.slice(RAW.indexOf("{"))).rows;

const GRID_PX_PER_FT = 20; // SurveyViewModel.PIXELS_PER_FOOT_GRID

function points(encoded) {
  if (!encoded || !encoded.trim()) return [];
  return encoded.split(",").flatMap((pair) => {
    const [x, y] = pair.split(":");
    const px = Number(x);
    const py = Number(y);
    return Number.isFinite(px) && Number.isFinite(py) ? [{ x: f(px), y: f(py) }] : [];
  });
}

/** FenceGeometryEngine.analyze's totalLinearFeet, in float32. */
function drawnFeet(pts, closed, pxPerFt) {
  if (pts.length < 2 || !(pxPerFt > 0)) return 0;
  const n = pts.length;
  const segs = closed ? n : n - 1;
  let totalPx = 0;
  for (let i = 0; i < segs; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    totalPx = f(totalPx + f(Math.sqrt(dx * dx + dy * dy)));
  }
  return f(totalPx / pxPerFt);
}

const TOL = 0.001;
const ceilRound = (x) => Math.round(Math.ceil(x));

/** Does the tolerance change ceil(feet / size)? */
function changes(feet, size) {
  if (!(size > 0) || !(feet > 0)) return null;
  const before = ceilRound(f(feet / size));
  const after = ceilRound(f(f(feet - TOL) / size));
  return before === after ? null : { size, before, after };
}

let flagged = 0;
const seen = [];
for (const r of rows) {
  const typed = r.manual_linear_feet;
  const usesTyped = typed != null && typed > 0;
  const pxPerFt = r.calibration_pixels_per_foot > 0
    ? r.calibration_pixels_per_foot
    : GRID_PX_PER_FT;
  const feet = usesTyped ? f(typed) : drawnFeet(points(r.points_encoded), r.closed_loop, pxPerFt);

  const checks = [
    ["post spacing", r.post_spacing_ft],
    ["panel width", r.panel_width_ft],
  ];
  // Pickets divide inches by a pitch in inches.
  const pitch = Math.max(0.5, f(f(r.picket_width_in ?? 0) + f(r.picket_gap_in ?? 0)));

  const hits = [];
  for (const [what, size] of checks) {
    const c = changes(feet, size);
    if (c) hits.push(`${what} ${size}: ${c.before} -> ${c.after}`);
  }
  const pk = changes(f(feet * 12), pitch);
  if (pk) hits.push(`pickets at ${pitch} in pitch: ${pk.before} -> ${pk.after}`);

  seen.push({
    who: r.customer_name,
    run: r.label || "(unnamed)",
    status: r.job_status,
    signed: !!r.signed_at,
    teardown: r.is_teardown,
    source: usesTyped ? "typed" : "drawn",
    feet: Number(feet.toFixed(6)),
    hits,
  });
  if (hits.length) flagged++;
}

console.log(`live runs examined: ${seen.length}`);
console.log(`runs whose counts the 0.001 ft tolerance would change: ${flagged}\n`);
for (const s of seen) {
  if (s.hits.length) {
    console.log(`  CHANGES  ${s.who} / ${s.run} (${s.status}${s.signed ? ", SIGNED" : ""}) ` +
      `${s.source} ${s.feet} ft -> ${s.hits.join("; ")}`);
  }
}

// How close does the nearest run come? If the closest is far from the sliver,
// nothing is marginal and the answer is robust rather than lucky.
let worst = null;
for (const r of rows) {
  const typed = r.manual_linear_feet;
  const usesTyped = typed != null && typed > 0;
  const pxPerFt = r.calibration_pixels_per_foot > 0 ? r.calibration_pixels_per_foot : GRID_PX_PER_FT;
  const feet = usesTyped ? f(typed) : drawnFeet(points(r.points_encoded), r.closed_loop, pxPerFt);
  for (const size of [r.post_spacing_ft, r.panel_width_ft]) {
    if (!(size > 0) || !(feet > 0)) continue;
    // Distance ABOVE the nearest multiple at or below feet.
    const over = feet - Math.floor(feet / size) * size;
    if (over > 0 && (worst === null || over < worst.over)) {
      worst = { over, who: r.customer_name, run: r.label, feet, size };
    }
  }
}
if (worst) {
  console.log(`\nclosest any run comes to a boundary from above: ${worst.over.toFixed(6)} ft ` +
    `(${worst.who} / ${worst.run}, ${worst.feet.toFixed(4)} ft at ${worst.size} ft)`);
  console.log(`the tolerance acts only below ${TOL} ft, so the margin is ${(worst.over / TOL).toFixed(0)}x`);
}
