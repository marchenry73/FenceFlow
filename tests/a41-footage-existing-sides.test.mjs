// FOOTAGE DRIFT -- "Sometimes on the grid when I add a side, the footage changes."
//
// Run:   node --test tests/a41-footage-existing-sides.test.mjs
//
// The diagnosis is in docs/FOOTAGE_DRIFT.md. This file is its evidence and its guard.
//
// =============================================================================
// WHAT THIS FILE PROVES, AND WHAT IT DOES NOT. READ BEFORE TRUSTING A GREEN RUN.
// =============================================================================
// THE QUESTION. When a side is added to a drawing, does the measured length of a side that was
// already there move? That would reprice the job without anybody looking.
//
// THE ANSWER THE CODE GIVES. No. Through the path the app adds a side by (snapForDraw, then
// addDrawPoint, then encode and decode through FenceCodec), 360 drawings -- six grid sizes from 25 ft
// to 2000 ft, three kinds of stored scale, one to three runs, open and closed -- come back with every
// pre-existing side BIT-IDENTICAL. Not "within a hundredth of a foot": identical Float bits, because
// the pre-existing corners are literally the same floats. The one place a side the user already saw
// does change is the CLOSING side of a closed loop, which is by construction replaced (section 3).
//
// THIS FILE CANNOT RUN KOTLIN. Node has no Kotlin. Sections 2-5 run a LINE-FOR-LINE TRANSCRIPTION of
// snapDrawPoint / landSide (FenceGeometry.kt, SideLength.kt) and of DrawingScale's rules, plus the REAL
// server port of FenceGeometryEngine.analyze and FenceCodec.decodePoints (supabase/functions/_shared/
// pricing/geometry.ts, parity-tested against the phone elsewhere). What holds the transcription to the
// Kotlin is section 1: the real Kotlin was compiled standalone (kotlinc 2.0.21, no Gradle -- the files
// FenceGeometry.kt, SideLength.kt, GateSpan.kt and DrawingScale.kt UNEDITED, plus a stub of the Room
// Job entity carrying only the five fields DrawingScale reads) and run over the same 360 scenarios on
// 2026-10-01; its output is frozen in KOTLIN_GOLDEN and the transcription must reproduce every line,
// bit for bit. The golden is a SNAPSHOT: this test does not re-run the Kotlin. A later edit to
// snapDrawPoint, landSide or DrawingScale is caught here only by the source checks in section 6 until
// someone re-runs the harness (recipe at the bottom of this file).
//
// WHAT IS NOT MODELLED. The sync (EntitySync.pullFenceRuns) and the screen. The strongest remaining
// suspect for a drift the owner can SEE is in the sync, not the geometry -- see docs/FOOTAGE_DRIFT.md.
// Nothing in this file says the sync is fine.
//
// CANARIES. A detector that cannot fail is worth nothing here (a checker that skips a case reports
// zero failures for it). Section 2 plants three drifts that the three suspects in the brief would each
// cause -- a snap that drags the previous corner, a rescale when the drawing grows, a scale re-derived
// from a grown extent -- and the same detector must catch every one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { analyze, decodePoints } from "../supabase/functions/_shared/pricing/geometry.ts";
import { kotlinFloatToString } from "../supabase/functions/_shared/pricing/kotlin-text.ts";
import { f32 } from "../supabase/functions/_shared/pricing/f32.ts";

// =============================================================================
// Float32 plumbing
// =============================================================================
const dv = new DataView(new ArrayBuffer(4));
const bitsOf = (x) => { dv.setFloat32(0, x); return dv.getInt32(0); };
const fromBits = (b) => { dv.setInt32(0, b | 0); return dv.getFloat32(0); };
const hex = (x) => (bitsOf(x) >>> 0).toString(16).padStart(8, "0");

function nextUp(x) {
  if (x !== x || x === Infinity) return x;
  if (x === 0) return fromBits(1);
  const u = bitsOf(x) >>> 0;
  return fromBits(((x > 0 ? u + 1 : u - 1) >>> 0) | 0);
}
function nextDown(x) {
  if (x !== x || x === -Infinity) return x;
  if (x === 0) return fromBits(0x80000001 | 0);
  const u = bitsOf(x) >>> 0;
  return fromBits(((x > 0 ? u - 1 : u + 1) >>> 0) | 0);
}
// kotlin.math.round(Float) is Math.rint: ties go to the EVEN integer, not up as Math.round does.
function rint(x) {
  const fl = Math.floor(x);
  const d = x - fl;
  if (d < 0.5) return f32(fl);
  if (d > 0.5) return f32(fl + 1);
  return f32(fl % 2 === 0 ? fl : fl + 1);
}
// sqrt(dx*dx + dy*dy) on Floats: each product and the sum rounded to Float, then sqrt of a Float.
const hyp2 = (dx, dy) => f32(Math.sqrt(f32(f32(dx * dx) + f32(dy * dy))));

// =============================================================================
// FenceCodec.encodePoints (FenceGeometry.kt): "${x}:${y}" joined by ",". Read back by the REAL decodePoints.
// =============================================================================
const encodePoints = (pts) => pts.map((p) => `${kotlinFloatToString(p.x)}:${kotlinFloatToString(p.y)}`).join(",");
const roundTrip = (pts) => decodePoints(encodePoints(pts));

// =============================================================================
// DrawingScale (estimate/DrawingScale.kt)
// =============================================================================
const GRID_CANVAS_SIZE = 8000;
const PIXELS_PER_FOOT_GRID = 20;
const unitsPerFoot = (extentFt) => (extentFt <= 0 ? PIXELS_PER_FOOT_GRID : f32(GRID_CANVAS_SIZE / extentFt));
const usable = (c) => c != null && c > 0 && Number.isFinite(c);
const photoMarker = (job) => job.surveyImagePath ?? job.surveyStoragePath ?? null;
const scaleOf = (job) => (usable(job.cal) ? job.cal : photoMarker(job) == null ? unitsPerFoot(job.ext) : null);
const isPhotoJob = (job) => job.surveyImagePath != null || job.surveyStoragePath != null;
const calibrationToSeed = (job) => (usable(job.cal) ? null : isPhotoJob(job) ? null : unitsPerFoot(job.ext));
function basisOf(job) {
  if (!isPhotoJob(job)) return "GRID";
  if (scaleOf(job) == null) return "NONE";
  return job.known != null && job.known > 0 && Number.isFinite(job.known) ? "MEASURED" : "UNMEASURED";
}
function gridBackdropPlan(job, anythingDrawn) {
  if (scaleOf(job) != null) return "ALLOWED:null";
  if (anythingDrawn) return "NEEDS";
  return "ALLOWED:" + hex(unitsPerFoot(job.ext));
}

// =============================================================================
// snapDrawPoint + landSide, transcribed from FenceGeometry.kt / SideLength.kt. Only the parts the
// drawing screen reaches: the default tolerances, no `avoid` list (that is the drag path).
// =============================================================================
const SAME_CORNER_PX = f32(0.01);
const VERTEX_SNAP_PX = 26;
const ANGLE_TOLERANCE_DEG = 7;
const LENGTH_SNAP_FT = f32(0.35);
const RAD2DEG = 57.29577951308232; // java.lang.Math.toDegrees since JDK 9
const DEG2RAD = 0.017453292519943295; // java.lang.Math.toRadians since JDK 9

const measuredFeet = (a, b, ppf) => analyze([a, b], ppf).totalLinearFeet;

function floatsAround(v, radius) {
  const below = [];
  let d = v;
  for (let i = 0; i < radius; i++) { d = nextDown(d); below.push(d); }
  const above = [];
  let u = v;
  for (let i = 0; i < radius; i++) { u = nextUp(u); above.push(u); }
  return [...below.reverse(), v, ...above];
}

function landSide(anchor, heading, feet, ppf) {
  const [ux, uy] = heading;
  const lengthPx = feet * ppf; // Double * Double, both widened from Float
  const idealX = anchor.x + ux * lengthPx;
  const idealY = anchor.y + uy * lengthPx;
  const seedX = f32(idealX);
  const seedY = f32(idealY);
  const target = feet;
  let radius = 6;
  for (;;) {
    let best = null;
    let bestShortfall = Number.MAX_VALUE;
    let bestDeviation = Number.MAX_VALUE;
    const xs = floatsAround(seedX, radius);
    const ys = floatsAround(seedY, radius);
    for (const x of xs) {
      for (const y of ys) {
        const candidate = { x, y };
        const measured = measuredFeet(anchor, candidate, ppf);
        if (measured > target) continue;
        const shortfall = target - measured;
        const ddx = x - idealX;
        const ddy = y - idealY;
        const deviation = ddx * ddx + ddy * ddy;
        if (shortfall < bestShortfall || (shortfall === bestShortfall && deviation < bestDeviation)) {
          best = candidate;
          bestShortfall = shortfall;
          bestDeviation = deviation;
        }
      }
    }
    if (best != null) return best;
    if (radius >= 96) return { x: seedX, y: seedY };
    radius *= 4;
  }
}

function angleDifference(a, b) {
  let d = f32(a - b) % 360;
  if (d > 180) d = f32(d - 360);
  if (d <= -180) d = f32(d + 360);
  return d;
}

function snapDrawPoint(candidate, previous, beforePrevious, otherVertices, ppf) {
  const neighbours = previous ? [previous] : [];
  const joinable = neighbours.length === 0
    ? otherVertices
    : otherVertices.filter((v) => neighbours.every((nb) =>
        !(Math.abs(f32(nb.x - v.x)) < SAME_CORNER_PX && Math.abs(f32(nb.y - v.y)) < SAME_CORNER_PX)));
  // 1. An existing corner wins outright.
  let nearest = null;
  let nearestD = Infinity;
  for (const v of joinable) {
    const dx = f32(v.x - candidate.x);
    const dy = f32(v.y - candidate.y);
    const d = f32(f32(dx * dx) + f32(dy * dy));
    if (nearest === null || d < nearestD) { nearest = v; nearestD = d; }
  }
  if (nearest) {
    const dx = f32(nearest.x - candidate.x);
    const dy = f32(nearest.y - candidate.y);
    if (hyp2(dx, dy) <= VERTEX_SNAP_PX) return { point: nearest, kind: "VERTEX" };
  }
  if (previous == null || ppf <= 0) return { point: candidate, kind: "NONE" };

  const vx = f32(candidate.x - previous.x);
  const vy = f32(candidate.y - previous.y);
  const distPx = hyp2(vx, vy);
  if (distPx < f32(0.001)) return { point: candidate, kind: "NONE" };
  const headingDeg = f32(Math.atan2(vy, vx) * RAD2DEG);

  const candidates = [];
  for (let k = 0; k < 8; k++) candidates.push({ heading: f32(k * 45) });
  if (beforePrevious != null) {
    const px = f32(previous.x - beforePrevious.x);
    const py = f32(previous.y - beforePrevious.y);
    if (hyp2(px, py) > f32(0.001)) {
      const prevHeading = f32(Math.atan2(py, px) * RAD2DEG);
      for (let k = 0; k < 8; k++) candidates.push({ heading: f32(prevHeading + f32(k * 45)) });
    }
  }
  let locked = null;
  let bestDelta = ANGLE_TOLERANCE_DEG;
  for (const c of candidates) {
    const delta = Math.abs(angleDifference(headingDeg, c.heading));
    if (delta <= bestDelta) { bestDelta = delta; locked = c; }
  }
  const lockedAngle = locked ? locked.heading : null;
  const finalHeadingDeg = lockedAngle ?? headingDeg;

  const distFt = f32(distPx / ppf);
  const roundedFt = rint(distFt);
  const lengthLocked = roundedFt >= 1 && Math.abs(f32(distFt - roundedFt)) <= LENGTH_SNAP_FT;
  const finalDistPx = lengthLocked ? f32(roundedFt * ppf) : distPx;
  if (lockedAngle == null && !lengthLocked) return { point: candidate, kind: "NONE" };

  const rad = finalHeadingDeg * DEG2RAD;
  const point = lengthLocked
    ? landSide(previous, [Math.cos(rad), Math.sin(rad)], roundedFt, ppf)
    : { x: f32(previous.x + f32(Math.cos(rad) * finalDistPx)), y: f32(previous.y + f32(Math.sin(rad) * finalDistPx)) };
  const kind = lockedAngle != null && lengthLocked ? "ANGLE_AND_LENGTH" : lockedAngle != null ? "ANGLE" : "LENGTH";
  return { point, kind };
}

// =============================================================================
// The scenario generator -- the same one the Kotlin harness runs. 32-bit LCG, 24-bit outputs.
// =============================================================================
class Lcg {
  constructor(seed) { this.s = seed >>> 0; }
  next24() { this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0; return this.s >>> 8; }
  unit() { return this.next24() / 16777216; }
  pick(n) { return Math.trunc(f32(this.unit() * n)); }
}
const EXTENTS = [25, 50, 100, 400, 1000, 2000];
const TWO_PI = f32(6.2831855);

function jobFor(i) {
  const ext = EXTENTS[i % 6];
  if (i % 3 === 0) return { ext, cal: null };
  if (i % 3 === 1) return { ext, cal: unitsPerFoot(ext) };
  return { ext, cal: f32(unitsPerFoot(ext) * f32(1.37)) };
}
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
function tapFrom(prev, rnd, minFt, spanFt, ppf) {
  const ft = f32(minFt + f32(rnd.unit() * spanFt));
  const ang = f32(rnd.unit() * TWO_PI);
  const x = clamp(f32(prev.x + f32(f32(f32(Math.cos(ang)) * ft) * ppf)), 0, 8000);
  const y = clamp(f32(prev.y + f32(f32(f32(Math.sin(ang)) * ft) * ppf)), 0, 8000);
  return { x, y };
}

/** The drawing screen's add: snapForDraw (every vertex of every run offered), addDrawPoint (append, encode, decode). */
function addTheWayTheAppDoes(runs, active, tap, ppf) {
  const pts = runs[active];
  const snap = snapDrawPoint(tap, pts.length ? pts[pts.length - 1] : null, pts.length > 1 ? pts[pts.length - 2] : null, runs.flat(), ppf);
  const grown = roundTrip([...pts, snap.point]);
  return { runs: runs.map((r, k) => (k === active ? grown : roundTrip(r))), snap };
}

function build(i) {
  const job = jobFor(i);
  const ppf = scaleOf(job);
  const rnd = new Lcg(i + 1);
  const runCount = 1 + (Math.trunc(i / 6) % 3);
  const closed = i % 5 === 0;
  let runs = Array.from({ length: runCount }, () => []);
  for (let r = 0; r < runCount; r++) {
    const n = 2 + rnd.pick(5);
    for (let k = 0; k < n; k++) {
      const prev = runs[r].length ? runs[r][runs[r].length - 1] : null;
      const tap = prev == null
        ? { x: f32(500 + f32(rnd.unit() * 7000)), y: f32(500 + f32(rnd.unit() * 7000)) }
        : tapFrom(prev, rnd, 3, 57, ppf);
      runs = addTheWayTheAppDoes(runs, r, tap, ppf).runs;
    }
  }
  return { job, runs, closed };
}

const sideBits = (pts, ppf, closed) => analyze(pts, ppf, closed).segments.map((s) => bitsOf(s.lengthFt));
const samePoint = (a, b) => bitsOf(a.x) === bitsOf(b.x) && bitsOf(a.y) === bitsOf(b.y);

/**
 * THE DETECTOR. For one drawing, adds one side with `add` and reports whether any side that already
 * existed changed -- in position or in measured length at the scale the drawing is measured at after.
 * `add` returns { runs, ppf } so that a drift caused by the SCALE moving (not just a corner) is seen.
 * For a closed run the old closing side is, by construction, replaced; sides 0..n-2 are compared.
 */
function addAndCheck(i, add) {
  const { job, runs, closed } = build(i);
  const ppf = scaleOf(job);
  const active = runs.length - 1;
  const rnd = new Lcg((i + 1) * 7919);
  const tap = tapFrom(runs[active][runs[active].length - 1], rnd, 2, 70, ppf);
  const sidesBefore = runs.map((r, k) => sideBits(r, ppf, k === active && closed));
  const out = add(runs, active, tap, ppf, job);
  let unchanged = true;
  runs.forEach((r, k) => {
    const closedHere = k === active && closed;
    const after = sideBits(out.runs[k], out.ppf, closedHere);
    const comparable = closedHere ? sidesBefore[k].length - 1 : sidesBefore[k].length;
    for (let s = 0; s < comparable; s++) if (sidesBefore[k][s] !== after[s]) unchanged = false;
    r.forEach((p, idx) => { if (!samePoint(p, out.runs[k][idx])) unchanged = false; });
  });
  const totalBefore = analyze(runs[active], ppf, closed).totalLinearFeet;
  const totalAfter = analyze(out.runs[active], out.ppf, closed).totalLinearFeet;
  return { i, job, closed, runCount: runs.length, snap: out.snap, unchanged, totalBefore, totalAfter, ppf };
}

const realAdd = (runs, active, tap, ppf) => ({ ...addTheWayTheAppDoes(runs, active, tap, ppf), ppf });

// =============================================================================
// Three planted drifts. Each is what one suspect in the brief WOULD do. They must all be caught.
// =============================================================================
// Suspect 2: a snap that moves an EXISTING corner (the previous one) onto the snap target.
const canarySnapDragsPrevious = (runs, active, tap, ppf) => {
  const r = addTheWayTheAppDoes(runs, active, tap, ppf);
  const g = r.runs[active].slice();
  if (g.length >= 3) g[g.length - 2] = { x: f32(g[g.length - 2].x + 40), y: g[g.length - 2].y };
  return { runs: r.runs.map((x, k) => (k === active ? g : x)), snap: r.snap, ppf };
};
// Suspect 1: the drawing is refitted -- every corner rescaled -- when it grows. The scale is NOT carried along.
const canaryRefitWithoutScale = (runs, active, tap, ppf) => {
  const r = addTheWayTheAppDoes(runs, active, tap, ppf);
  return { runs: r.runs.map((x) => x.map((p) => ({ x: f32(p.x * f32(1.1)), y: f32(p.y * f32(1.1)) }))), snap: r.snap, ppf };
};
// Suspect 3: the scale is re-derived from an extent that has grown to hold the new side.
const canaryScaleFromGrownExtent = (runs, active, tap, ppf, job) => {
  const r = addTheWayTheAppDoes(runs, active, tap, ppf);
  return { runs: r.runs, snap: r.snap, ppf: unitsPerFoot(f32(job.ext * f32(1.25))) };
};

const ALL = Array.from({ length: 360 }, (_, i) => i);

// =============================================================================
// KOTLIN_GOLDEN -- the real Kotlin's answers (see the header). Hex of Float bits.
//   A|scenario|snapKind|newX|newY|existingSidesUnchanged|runTotalBefore|runTotalAfter
//   D|scenarios in which a pre-existing side changed
//   C|before/after|per-side lengths of the closed-loop example|total
//   R|scenario|worst change of any side in feet over eleven consecutive grid-size changes|final scale
//   S|job shape|scale|calibration to seed|basis|backdrop plan if drawn|backdrop plan if empty
// =============================================================================
const KOTLIN_GOLDEN = `
A|0|LENGTH|441c8111|c102aadb|1|4274f492|42a18c32
A|1|LENGTH|459c4a5c|c0c76f93|1|41c80000|42300000
A|2|ANGLE_AND_LENGTH|453e8928|45c0ebb6|1|429ae4c9|42dce4c8
A|3|ANGLE_AND_LENGTH|45bacaad|45a57095|1|42af042b|42fb042b
A|4|LENGTH|45a37c11|44b856b4|1|42965144|42ec5144
A|5|NONE|45c68516|45df4d28|1|42d943ea|430ee9d9
A|6|VERTEX|80000006|45fa0000|1|41400000|41cc0456
A|7|VERTEX|00000000|00000000|1|42fedfbb|4302c716
A|8|ANGLE_AND_LENGTH|45925523|80000006|1|42b4d077|42eed076
A|9|ANGLE_AND_LENGTH|45831b67|453d1765|1|42d656d5|432e2b6a
A|10|ANGLE_AND_LENGTH|43863290|452d752a|1|43545e62|43b1d590
A|11|NONE|4596405d|452460a2|1|42ed1ec8|42fa22e0
A|12|LENGTH|45effd78|459dae9f|1|42720c1d|428f060e
A|13|ANGLE_AND_LENGTH|44bfbeea|45200000|1|42bfb460|42dfb460
A|14|LENGTH|c20f579a|44b8db86|1|42bf0439|42e1043a
A|15|LENGTH|45f46fa3|44a66d7e|1|43241f2c|4347ddd3
A|16|LENGTH|4572b5a1|455a7f5a|1|432511da|434411da
A|17|ANGLE|4343b7b2|44be029a|1|425a37cd|42b41bb4
A|18|ANGLE|41eeba42|bdc30000|1|424c0000|4283444c
A|19|ANGLE_AND_LENGTH|45fb428a|423592b3|1|42740000|42960000
A|20|LENGTH|445c1cef|45f94447|1|42927139|42f102d8
A|21|ANGLE_AND_LENGTH|44f5e62e|45d265aa|1|4215f29f|42b8f950
A|22|LENGTH|45428f54|4581e2c5|1|42a5319a|430e98cd
A|23|ANGLE|456ddfa2|4513b2ac|1|428bffff|43067dc3
A|24|ANGLE_AND_LENGTH|80000006|45fa0001|1|421603fc|427a03fd
A|25|NONE|00000000|00000000|1|42900000|42900000
A|26|ANGLE_AND_LENGTH|447a478f|c2b12ba3|1|42080000|4227ffff
A|27|LENGTH|45a406b0|44bbbcae|1|42b31e75|42cf1e75
A|28|ANGLE_AND_LENGTH|44a764c6|44f66c56|1|42e4d7fc|43056bfe
A|29|VERTEX|45b7e4ff|4524cc42|1|41cffffe|424ffffe
A|30|LENGTH|45f78392|452c315c|1|42df996e|430cfd16
A|31|ANGLE|45a2eefe|45fa2c07|1|42bc0000|42deeb12
A|32|ANGLE|44cd20e8|2acf7241|1|424580c6|4299a91f
A|33|LENGTH|45ef4e68|44977938|1|42cdff96|4311ffcb
A|34|ANGLE|45cc6369|45ac4fd0|1|43358afa|43652f77
A|35|NONE|4575e9a9|455044e4|1|42c3ffff|43494658
A|36|ANGLE_AND_LENGTH|45968829|c1c79000|1|41c2ec04|42457602
A|37|ANGLE_AND_LENGTH|45f09b8b|45de41d0|1|41400000|420c0000
A|38|ANGLE_AND_LENGTH|45a08bdb|45f12012|1|42376e2f|4295b717
A|39|ANGLE_AND_LENGTH|45a46fa9|446c2287|1|4231dce6|42e8ee73
A|40|ANGLE|45eedf7c|45ce6b6a|1|4253bccb|42845ea4
A|41|NONE|4484c6ae|4591cf07|1|41a3b3e4|41ff6e70
A|42|LENGTH|4449cd36|45fa1032|1|41a3f596|4211facb
A|43|ANGLE_AND_LENGTH|459b0000|2ad19506|1|41f16458|4200b22c
A|44|ANGLE_AND_LENGTH|45302037|43147952|1|42dd310f|43089887
A|45|LENGTH|45f3e367|45293014|1|434f2bd3|436de6a3
A|46|NONE|45468709|45118012|1|430e7554|43321588
A|47|ANGLE|45dde799|450ee346|1|43045ee4|432cd412
A|48|LENGTH|45f90a70|45f9b375|1|41800000|42280000
A|49|LENGTH|442636d6|45d733fd|1|42940000|42f80000
A|50|ANGLE_AND_LENGTH|45b39e09|c1f17ecf|1|432628b3|4329b58d
A|51|ANGLE_AND_LENGTH|45e2a524|45e78df3|1|4333a2af|436fa2b0
A|52|NONE|452e816e|44d7ff43|1|41cb50d3|42b41052
A|53|NONE|4510185d|4526be8c|1|4252354b|42f400b6
A|54|ANGLE|45fa0000|45d424bf|1|41b4814c|41d037f3
A|55|ANGLE_AND_LENGTH|44843c4c|44af00b5|1|423092de|42351310
A|56|ANGLE_AND_LENGTH|4396566c|45f4be41|1|42540000|42860000
A|57|LENGTH|458b3afe|459f3720|1|42d9a3ad|42ffa3ad
A|58|ANGLE|459d900f|449ea586|1|42c11be2|42f053ba
A|59|ANGLE|45a8312d|45e5658e|1|42a93a70|42e21c41
A|60|ANGLE_AND_LENGTH|c1d2e300|404fa414|1|424a52da|429acd96
A|61|LENGTH|45d95f3c|452629db|1|428c0000|42d80000
A|62|NONE|45fa0000|45407a06|1|41ffffff|4276204b
A|63|LENGTH|3f107e75|450e6e62|1|4274baf0|42b45d78
A|64|NONE|4587baec|451b55db|1|419bbc30|42902294
A|65|NONE|44c9c29b|45381f9c|1|42b40000|434c71c6
A|66|ANGLE_AND_LENGTH|45f42c89|45f76956|1|41400000|42140000
A|67|LENGTH|bf7ca320|446183b0|1|429b2dde|42b52dde
A|68|LENGTH|45925038|443699b0|1|422da619|42e6d30d
A|69|ANGLE|45a3e3e0|45f9ad06|1|428120e8|428c46fb
A|70|ANGLE|458d66ed|4595811d|1|42e3aabd|43089b9d
A|71|ANGLE|4563f119|44f97e07|1|42fec4b3|430fcef3
A|72|ANGLE_AND_LENGTH|45fa0000|448e2530|1|41a4bc02|41dcbc02
A|73|ANGLE|45d26066|45fa9564|1|4298e536|429fb4fd
A|74|ANGLE|34800000|ba800000|1|426d9d6b|426db9ec
A|75|LENGTH|4538c8de|45c47fb2|1|42e9329d|431e768f
A|76|NONE|45186637|45828266|1|423a2208|42ae3bfa
A|77|ANGLE|45398abc|45118ccc|1|42b74951|43090f1d
A|78|ANGLE_AND_LENGTH|c2758c00|41fae335|1|41100000|42080000
A|79|ANGLE|45f7c044|408a7ff8|1|42f272f2|432abe89
A|80|ANGLE|45899e39|45f5b010|1|433019c6|433a24fc
A|81|ANGLE_AND_LENGTH|449e9b4c|448d74fc|1|42db2ace|432e9567
A|82|NONE|45b2856c|45161ace|1|4319d19c|435f64f1
A|83|ANGLE|450eac1e|4554bfc1|1|42db39c6|42e40a65
A|84|LENGTH|45af88ab|4551c7cd|1|427e1563|42910ab2
A|85|ANGLE_AND_LENGTH|45c179c9|45cca818|1|43123daa|4313bd62
A|86|LENGTH|45aef3eb|45ae2257|1|430d7612|43207612
A|87|LENGTH|45773a47|44c49149|1|42200000|42800000
A|88|NONE|4595df62|4549224d|1|430862a2|4324f3d1
A|89|ANGLE|4581c4e5|4585dccd|1|42c8d17f|4305cee8
A|90|NONE|45fa0000|45669abf|1|42180000|42825e82
A|91|ANGLE|459ce8c0|45fe3890|1|41e80000|425e6396
A|92|ANGLE_AND_LENGTH|42f51b0b|44dad269|1|41a7ffff|42840000
A|93|ANGLE_AND_LENGTH|45f65ef9|43926b4c|1|4284cde0|42eecde0
A|94|ANGLE|45d6f2f1|45e02d76|1|42560c51|42de243c
A|95|ANGLE|45da2bb5|45878f08|1|427b4f87|4335078b
A|96|LENGTH|45c07908|c2bce782|1|42027d82|423a7d82
A|97|ANGLE|45fa0000|45dd3671|1|427de170|427f1d10
A|98|LENGTH|454c77e3|4569cfee|1|4282d519|4290d519
A|99|LENGTH|4552711d|453fcfef|1|42029923|42329923
A|100|ANGLE|45dcb799|45367a05|1|429a0c32|42dbe036
A|101|NONE|454ebb42|45652ff9|1|40ebfa28|41e60d7d
A|102|ANGLE_AND_LENGTH|43579260|45f8e70c|1|42400000|42900000
A|103|LENGTH|43dd61b9|4542baf9|1|42440000|42a00000
A|104|ANGLE_AND_LENGTH|45c09afe|45fa0000|1|41fbbc2e|4286ef0b
A|105|LENGTH|458da7f6|45d632dc|1|41e7d310|42d4038b
A|106|ANGLE|456a8c48|4567373d|1|42cc0793|43138e8a
A|107|NONE|45e8bffa|4593249a|1|4243fffe|42c6bf73
A|108|ANGLE|45fa4e6e|45f42887|1|41e3c276|420837e9
A|109|ANGLE|43cd799f|458ee9a6|1|419c9c06|4240a796
A|110|LENGTH|c0958aed|44902c54|1|4282917d|4322af7b
A|111|ANGLE_AND_LENGTH|45aed2db|4572b49b|1|4292c305|430f6182
A|112|NONE|4580c233|44be3510|1|4273c21c|4282f245
A|113|NONE|458613f9|45d544de|1|42d3339c|42e5eecd
A|114|ANGLE|451175ae|42041600|1|42a13a96|42affb68
A|115|ANGLE_AND_LENGTH|45b6c5dd|45f1cefe|1|430f1562|431e8fca
A|116|ANGLE|457a7c1a|45f9dc91|1|4319ffff|432d9497
A|117|LENGTH|455da11d|4577c528|1|4333d01d|4350d01d
A|118|NONE|44df50c6|45897bf1|1|4328ffff|434a8675
A|119|ANGLE|458dfd54|458381a3|1|42bc0000|43045b72
A|120|ANGLE|ab1eb353|459a15c5|1|4276d66e|427eb46b
A|121|VERTEX|45f9e44e|3f11351c|1|42780000|429835f3
A|122|LENGTH|45fa0859|45fa2666|1|414ffffe|42180000
A|123|ANGLE_AND_LENGTH|44dc1ebb|45dde981|1|424e0d28|42db0693
A|124|ANGLE|45d7b68f|4568e6fc|1|43130000|43518452
A|125|LENGTH|45d1e44f|45af64e7|1|43075775|438443e3
A|126|NONE|45fa0000|45fa0000|1|41200000|41255634
A|127|ANGLE_AND_LENGTH|442331ac|41b23912|1|423a80ba|425680ba
A|128|LENGTH|45c6bd93|4508b9b1|1|420d71b1|423d71b1
A|129|LENGTH|44932836|45e3e6ce|1|42a0b828|42c2b828
A|130|ANGLE|44be994f|4569523d|1|4302f81e|430ad7ce
A|131|LENGTH|44ff4e5f|44ff20d4|1|425e516a|42a328b4
A|132|LENGTH|45f7157f|4161b048|1|41a00000|42340000
A|133|ANGLE_AND_LENGTH|45cd6276|45fbad1c|1|42a80000|42e00000
A|134|LENGTH|c1961021|45b0bf6d|1|42080000|420c0000
A|135|LENGTH|45b206e0|45178d89|1|428c5fb0|4318f8f7
A|136|ANGLE|44e86bb7|4563df43|1|42663a50|42d81d36
A|137|LENGTH|45a591d2|458b4fc1|1|41d35aa9|42a2d6aa
A|138|LENGTH|4255a3ea|429c0f24|1|421d76ce|428abb67
A|139|LENGTH|45fb315f|c130f4dc|1|41e80000|42940000
A|140|ANGLE|459353f1|45fc852c|1|43477a58|43491c38
A|141|ANGLE_AND_LENGTH|4540f3f0|458ee316|1|42bb0b93|42c50b93
A|142|ANGLE|4566041d|45360155|1|408fd7c0|415fca00
A|143|ANGLE_AND_LENGTH|458b8a88|454e049c|1|431488d0|432288cf
A|144|ANGLE_AND_LENGTH|4522a6c8|45a10439|1|41200000|41e80000
A|145|ANGLE_AND_LENGTH|c1bcc180|45ab862a|1|422e3ec2|42974c9e
A|146|ANGLE_AND_LENGTH|45b5db67|43976391|1|422a0cad|42870656
A|147|LENGTH|45c072e9|451ec4a6|1|41effffd|427ffffe
A|148|NONE|45b162ea|45c63ed1|1|41939659|4263ba24
A|149|ANGLE_AND_LENGTH|45d78567|457ac78d|1|427bb779|42d3dbba
A|150|NONE|45fa0000|452f4741|1|42a8042d|42e76588
A|151|ANGLE_AND_LENGTH|c1868f78|45fb12cc|1|42f6379b|431b1bce
A|152|NONE|00000000|00000000|1|4296b5a0|42c3f3cb
A|153|ANGLE|45e189e9|454fead3|1|429f45ca|430e4785
A|154|ANGLE|454759bd|457592b4|1|428a07f3|43087d92
A|155|LENGTH|45c81545|458b16ee|1|42e95943|42f11406
A|156|LENGTH|45f1d49d|45b58be4|1|42a40000|42b20000
A|157|ANGLE_AND_LENGTH|44f026fa|45851f1d|1|41980000|41f80000
A|158|ANGLE_AND_LENGTH|457620d9|458368b8|1|4289feda|42abfed9
A|159|NONE|449d676b|45164759|1|42e6c8de|430906e9
A|160|ANGLE|44a90099|45b25f86|1|43400ed9|43579279
A|161|ANGLE_AND_LENGTH|44c05517|45e6769f|1|4326fff9|4345fff9
A|162|ANGLE_AND_LENGTH|2ab07d7e|45a00000|1|42509572|42884ab9
A|163|ANGLE|448b70b2|41e3dc40|1|41f00000|422235d6
A|164|ANGLE_AND_LENGTH|459d4f64|45f9aaa7|1|41e80000|42960000
A|165|ANGLE|4589cbe4|45871efa|1|43370645|4361f9c8
A|166|ANGLE|452fd6c9|44a95a7d|1|42a4daba|4309e2ab
A|167|LENGTH|4580e311|45c5a632|1|428c1e6a|43020f34
A|168|ANGLE_AND_LENGTH|45fc71d3|45fd0c73|1|424c0000|42980000
A|169|ANGLE_AND_LENGTH|c407bdac|45e759cd|1|42940000|42f80000
A|170|ANGLE_AND_LENGTH|452138ad|41539367|1|42a66efd|42abe306
A|171|NONE|433de8ad|4541a886|1|424c4e93|4272c750
A|172|ANGLE|45819b3a|4589d1b4|1|419cd0c6|42083503
A|173|LENGTH|443f60db|45886cc4|1|4235db7f|4280edc0
A|174|ANGLE|45efc895|448291e4|1|42840000|42af2a96
A|175|ANGLE_AND_LENGTH|458d4109|45323ed9|1|427482e0|427482e0
A|176|ANGLE_AND_LENGTH|458ffce6|454adcfb|1|42892151|42cd2151
A|177|ANGLE|452af0e6|44e2329a|1|42ce0000|430d9c0a
A|178|NONE|452bfc28|45198a1c|1|4310c910|433c3a15
A|179|ANGLE_AND_LENGTH|4494ef30|44d474bf|1|428b008c|42eb008a
A|180|ANGLE|aaf8f2ea|45aec53e|1|4250912b|42691928
A|181|ANGLE_AND_LENGTH|45f9590c|c2000629|1|42119055|42419055
A|182|LENGTH|45f94cb7|45f9b9ac|1|42640001|42a40000
A|183|ANGLE|45d32b7a|45d655b8|1|4231bd06|42e0124d
A|184|NONE|4493c5b5|4574c94d|1|42b2cfde|42b7ad9c
A|185|LENGTH|449ac1be|44e97387|1|4312568c|431257d6
A|186|LENGTH|44c4775e|45f9ba00|1|429035d2|429835d2
A|187|ANGLE_AND_LENGTH|44f72b50|45fa0000|1|42db890e|42fd890e
A|188|ANGLE_AND_LENGTH|45fa1c29|45b25cf9|1|42caccad|42f4ccac
A|189|ANGLE|4533dee1|459c90b6|1|42b8ca79|42edf9f8
A|190|ANGLE|45904601|459581dd|1|4348b14c|4381dc38
A|191|ANGLE_AND_LENGTH|44eedbfd|4598d08a|1|42edfffa|431afffc
A|192|NONE|45fa0000|00000000|1|41a00000|41a1b61e
A|193|LENGTH|4522e88f|45fa4b2f|1|42700000|42c40000
A|194|ANGLE|bcae0000|45fa5701|1|42940000|42c6b5d1
A|195|ANGLE|45fb2f03|45481ace|1|4353b912|439dbbde
A|196|NONE|456fa0d7|45e88e5e|1|41affff6|42a4d524
A|197|LENGTH|453b3953|4513ffff|1|4243ffff|42e3ffff
A|198|ANGLE_AND_LENGTH|44053cf4|c40f4bd4|1|41d3e69a|426df34d
A|199|LENGTH|44de1b87|4569c57a|1|41980000|41c00000
A|200|ANGLE_AND_LENGTH|45f7cb63|458e422d|1|42aa6e82|42be71d3
A|201|NONE|4576970e|44ecac38|1|424e5803|428452ed
A|202|ANGLE|45a9044e|45b4bb4a|1|421d8a0d|426b2bcd
A|203|ANGLE_AND_LENGTH|45bcfbdd|4581e527|1|41dbf534|424dfa9a
A|204|ANGLE_AND_LENGTH|45820000|45fa0000|1|418a2fe5|41ea2fe5
A|205|ANGLE|456260dc|2b16e93b|1|42aa9916|42be2880
A|206|LENGTH|45fa0f1d|bf5f9240|1|42bc0001|42e40001
A|207|ANGLE|454a3080|45a3a564|1|414ffffd|42624540
A|208|NONE|45c05939|458d484e|1|421a968f|42ae17da
A|209|ANGLE_AND_LENGTH|4530a686|45937966|1|40f04cb8|42720993
A|210|NONE|45fa0000|45b447e4|1|423c68d6|429d14c3
A|211|ANGLE_AND_LENGTH|458b0a75|45f10b98|1|41980000|42820000
A|212|ANGLE|42bbdb20|43d962d8|1|4305d3ec|433671ee
A|213|ANGLE|458dd73e|4533bb30|1|42c00000|42c51e57
A|214|NONE|45197336|44bd907a|1|42b90ca4|42c7d4ed
A|215|ANGLE_AND_LENGTH|458512ef|45d7e751|1|433bd0a2|43539505
A|216|ANGLE_AND_LENGTH|45cf1e7e|bf886800|1|41776cad|419bb656
A|217|ANGLE_AND_LENGTH|45525ae2|45b69a9b|1|42340000|42860000
A|218|VERTEX|00000000|45fa0000|1|423e530a|428f2985
A|219|ANGLE|4522c332|45660b20|1|426c0000|42b51a0d
A|220|ANGLE|45172e3d|441df86d|1|434ced9a|437ed4d0
A|221|ANGLE_AND_LENGTH|45619a3f|45d2215b|1|42b6f271|43047938
A|222|NONE|00000000|45fa0000|1|42e20000|42e24da2
A|223|ANGLE_AND_LENGTH|457b5829|4402e864|1|4268d6d8|42da6b6d
A|224|LENGTH|45f9df7b|440b18ad|1|42a4383c|42ca383b
A|225|ANGLE|458829de|4590f447|1|43238493|4341e1a6
A|226|NONE|45dc84c6|45a0596d|1|43189884|4359f85f
A|227|LENGTH|4586de19|459461f8|1|4237fffc|42e7fffe
A|228|NONE|45fa0000|45fa0000|1|4230b798|4230b798
A|229|ANGLE_AND_LENGTH|c16ebab4|45b51b71|1|429c0000|42a80000
A|230|LENGTH|45a5d5ef|45cc77ba|1|43381f61|43383797
A|231|NONE|45a444c1|45dcb86e|1|42a73c5d|42ce4dd8
A|232|ANGLE|45aa6357|4501f9e4|1|4274c4e2|42ab1ddf
A|233|ANGLE_AND_LENGTH|458a7c4f|4557534e|1|420fffff|4281ffff
A|234|LENGTH|45df2b85|c0e7882b|1|4201d62e|4235d62e
A|235|ANGLE_AND_LENGTH|45f72e86|457b1acf|1|424bb070|42a00a04
A|236|ANGLE|bd0c0000|45def031|1|42872ef3|42c42407
A|237|NONE|45e401d2|459720e5|1|42840000|42e50d2e
A|238|NONE|45e5be70|455aeb00|1|42560858|42d5bb50
A|239|LENGTH|4446081b|44f83dc2|1|4225cf27|42c6e794
A|240|ANGLE_AND_LENGTH|c2a38500|43855142|1|41fe21fb|421f9b8a
A|241|LENGTH|4539846f|41b558d0|1|420d6df2|4298b6fa
A|242|LENGTH|459f121d|45f9b157|1|42340000|42400000
A|243|ANGLE|45a0dffc|45849bd4|1|42000000|421e11d0
A|244|ANGLE_AND_LENGTH|4472412b|459d26ef|1|42680000|428c0000
A|245|LENGTH|45a225f2|45aedbb3|1|42546f5e|42914a5d
A|246|NONE|45fa0000|45fa0000|1|413802d2|413802d2
A|247|ANGLE_AND_LENGTH|418a5080|45fa0000|1|42da0dee|42ee0dee
A|248|LENGTH|45d6bdea|458db30f|1|42836afc|42c36afc
A|249|NONE|45732525|452bb42c|1|41880000|42560933
A|250|LENGTH|44a772ff|45404aee|1|42000000|42b81ae6
A|251|ANGLE_AND_LENGTH|449c44c6|4595bc8d|1|4207433f|429fa19f
A|252|ANGLE_AND_LENGTH|45f80ede|423407bf|1|41f00000|42820000
A|253|ANGLE_AND_LENGTH|45df5050|4601c691|1|42200000|42bc0000
A|254|LENGTH|408e6453|45eb8207|1|41e35d23|4261ae92
A|255|ANGLE_AND_LENGTH|45826eb4|3f957800|1|41d1f933|43075020
A|256|LENGTH|45a8601c|45c65084|1|4273fff7|4302fffd
A|257|LENGTH|459d5c43|45714b38|1|4241b96e|4255b968
A|258|ANGLE_AND_LENGTH|424f86b0|45bdcbd6|1|423d0bbe|42550bbe
A|259|ANGLE_AND_LENGTH|4582cd3e|4594bb1b|1|42fc0000|430d0000
A|260|ANGLE_AND_LENGTH|450bf764|45fa0323|1|42d33f0b|42e19205
A|261|NONE|459d4f60|45d1e93d|1|433054f8|4348d2fb
A|262|ANGLE_AND_LENGTH|452afaca|45a64eaa|1|4243fffc|429bfffe
A|263|LENGTH|45c057ef|45b63696|1|42adffff|42f1ffff
A|264|NONE|4568d0b0|45fa0000|1|4221f9e5|4281f062
A|265|NONE|00000000|44be99c8|1|42e7fe0b|43122ac5
A|266|ANGLE_AND_LENGTH|460156f2|458ad08e|1|42adca85|4304e542
A|267|NONE|45ea68a4|45035e90|1|4290d2a7|42fbca62
A|268|ANGLE_AND_LENGTH|45d53944|4546dcc7|1|429fffff|430a0000
A|269|LENGTH|45d593f9|4595c4a1|1|424a2f6d|42e317b6
A|270|LENGTH|45faa7dd|45ed71c5|1|42038413|420af5a8
A|271|ANGLE_AND_LENGTH|bb000000|43f1e229|1|42358775|42418775
A|272|NONE|45827259|45eeca41|1|42860000|4295497d
A|273|NONE|44f54f7f|455b3128|1|429fffff|42b8f370
A|274|ANGLE_AND_LENGTH|44fe2db8|446e236b|1|42880000|42aa0000
A|275|LENGTH|450f2cc8|45d14200|1|4361ae36|43856502
A|276|ANGLE|ab171327|00000000|1|4200f44d|4223630a
A|277|LENGTH|45f852ad|45eb5487|1|421219fb|424619fb
A|278|ANGLE|454b3fd4|45d3bc8f|1|42140000|42934533
A|279|NONE|45a689b0|45996db5|1|424c0000|42b8ef26
A|280|LENGTH|4577839a|45a8a1f9|1|42200000|42d35985
A|281|ANGLE_AND_LENGTH|45e8f6b4|45af5e24|1|43291b6c|435c1b69
A|282|VERTEX|2a3e042c|45fa0000|1|41b00000|42321ffd
A|283|ANGLE_AND_LENGTH|44480000|80000006|1|42761260|42df0930
A|284|NONE|45e7f2df|459c23fe|1|427721f8|42fed1e6
A|285|ANGLE|45255d8b|457d9159|1|4360c86a|43b6254d
A|286|VERTEX|45a1b3f3|44066e6b|1|42972f6a|42a52f6a
A|287|ANGLE_AND_LENGTH|459cd22a|4523eb1a|1|4322fffe|432cfffe
A|288|ANGLE_AND_LENGTH|45fd3d7a|45319924|1|41f00000|421c0000
A|289|ANGLE_AND_LENGTH|41897fd3|45b8be2a|1|42518b33|4282c59a
A|290|ANGLE_AND_LENGTH|452225fd|4240a64f|1|426609ee|42b6c693
A|291|ANGLE|45e4d8be|45d1fad8|1|42ae0000|42e8e690
A|292|ANGLE_AND_LENGTH|45bea999|4553b258|1|4295fffe|42d9fffe
A|293|ANGLE_AND_LENGTH|45d972e8|44c8add1|1|427be1b8|42cbf0d5
A|294|VERTEX|45f978b3|408731f0|1|429e0000|42d00000
A|295|ANGLE|45fe37d8|45f5fe56|1|42f8ea76|43273bb7
A|296|ANGLE|45742c98|45cd424b|1|430d0d95|4342a9c0
A|297|LENGTH|3e945e79|4576e155|1|4298cb5e|430265af
A|298|LENGTH|4595a9b3|45ad07b5|1|42b544c6|4319a263
A|299|ANGLE_AND_LENGTH|449ce367|45ddac84|1|42ffffff|4343ffff
A|300|ANGLE_AND_LENGTH|44700000|45fa0000|1|42def07a|42e90283
A|301|LENGTH|45debb01|453f57c9|1|430a5fb6|43125fb6
A|302|ANGLE_AND_LENGTH|45f98db6|440b0085|1|41bfffff|41e7ffff
A|303|NONE|4514951f|459321a8|1|42ae0000|42d0ddfe
A|304|ANGLE_AND_LENGTH|446d8b97|45a48f3e|1|42d7abf5|4301d5fa
A|305|ANGLE_AND_LENGTH|45bd8a57|4583bf9b|1|43288437|433d7633
A|306|ANGLE_AND_LENGTH|45986605|45f4cd55|1|41300000|42180000
A|307|ANGLE|450a9b22|45fabe28|1|42580000|42b4d8d0
A|308|ANGLE|422a387a|c18c0980|1|41f80001|426d7745
A|309|NONE|4599552c|4495774c|1|4215f9e7|42a7d6aa
A|310|LENGTH|455fec1b|45c0f66c|1|422ac444|43061cc7
A|311|ANGLE_AND_LENGTH|458a4300|4549affc|1|428cbc1f|42fcbc1c
A|312|ANGLE_AND_LENGTH|45f8346d|c2ade440|1|42100000|42180000
A|313|NONE|45d67641|45fa0000|1|41f00000|42af33b2
A|314|LENGTH|be95687d|45c4b15b|1|42831045|42a71044
A|315|ANGLE|451d42b6|45b2e14b|1|41cffff8|41e2d5ba
A|316|LENGTH|45bef33e|45b4c24b|1|421c0000|4243ffff
A|317|LENGTH|450f58f0|45c45ffb|1|42e8185b|43030c2d
A|318|ANGLE|bc380000|b6e00000|1|42593ec6|42595e80
A|319|ANGLE_AND_LENGTH|4530ba93|44e29019|1|42b20000|42e40000
A|320|NONE|4505e20c|45577ec8|1|42795943|428863df
A|321|NONE|45094577|44bc4178|1|42cc0000|43086890
A|322|LENGTH|44fa2306|45b916aa|1|40e00000|42380000
A|323|ANGLE_AND_LENGTH|44e4c474|44ad6515|1|42e00000|431c0000
A|324|LENGTH|c0edf316|45f8e3fa|1|42180000|422c0000
A|325|ANGLE|bc100000|41145bd0|1|425283f2|42e23a73
A|326|LENGTH|45f9fec2|453b325e|1|42040000|42b20001
A|327|ANGLE|4516a59e|45470ca2|1|42cb4a72|43250ba4
A|328|LENGTH|44476009|44a0b5ff|1|42b20000|431d0000
A|329|ANGLE_AND_LENGTH|44d83da1|45bedaf2|1|4299ffff|429ffffe
A|330|ANGLE_AND_LENGTH|45fa1d10|45f94e06|1|42cf6805|42ddf422
A|331|ANGLE_AND_LENGTH|45f04544|45fa5486|1|43140000|43160000
A|332|NONE|452a49c6|45285b08|1|42bf48fb|42e26792
A|333|NONE|4535b4fd|45b06864|1|4311ea2b|43284e71
A|334|ANGLE_AND_LENGTH|45e20a81|45bf8d1f|1|43030000|431dfffe
A|335|LENGTH|455e236f|45ce88cc|1|431a7a27|431f076d
A|336|ANGLE_AND_LENGTH|43a085d0|c33a9e70|1|42833feb|42a13feb
A|337|LENGTH|45ce71c1|45d674f0|1|41d80000|428a0000
A|338|ANGLE|439e9d23|459f35c3|1|4286f653|42e410a0
A|339|ANGLE|454e2f9d|4587fd02|1|431b0ea9|434e70ca
A|340|ANGLE_AND_LENGTH|45893210|45c24994|1|43235706|4378d363
A|341|LENGTH|446b86fd|45a99c04|1|43187faa|43557faa
A|342|LENGTH|4257881f|45f9bb2b|1|41b2f90a|423d7c85
A|343|NONE|00000000|00000000|1|41fb612d|41fb612d
A|344|ANGLE|45e96335|459b2e3a|1|42800000|428b1603
A|345|ANGLE|45a573e6|45b57d5d|1|42700000|4296f3bb
A|346|ANGLE_AND_LENGTH|45ad4791|4543f5b7|1|421daa44|4259aa43
A|347|LENGTH|45c22ba8|44b91a26|1|42a80000|42d00000
A|348|ANGLE_AND_LENGTH|45fa0000|45fc5df8|1|42178b5a|42338b5a
A|349|ANGLE_AND_LENGTH|44f3edc4|45f96729|1|42800000|42a80000
A|350|NONE|4522b55d|451d9bd8|1|428fa109|42d0ae07
A|351|ANGLE|45a7f520|459fc538|1|42000000|428ebbad
A|352|ANGLE_AND_LENGTH|442ac00d|45d906d3|1|42680000|42cc0000
A|353|ANGLE_AND_LENGTH|458049c8|45cedf57|1|43288f79|43598f73
A|354|VERTEX|45fa0000|00000000|1|42396956|42596956
A|355|ANGLE_AND_LENGTH|4603d3a1|45594e76|1|4318af2b|433c96de
A|356|LENGTH|455a531b|45fa40a7|1|43164091|43554091
A|357|ANGLE|44a6d4da|45c91aaf|1|42719086|4300bfd3
A|358|ANGLE_AND_LENGTH|45c65c3d|459a2007|1|43517a80|43547a80
A|359|LENGTH|45bec0f0|45d42ab5|1|430b0d95|43130d95
D|0
C|before|42200000,42200000,42624630|4308918c
C|after|42200000,42200000,42340000,42708022|43392008
R|0|36000000|41a00000
R|1|36400000|41a00000
R|2|36800000|41a00000
R|3|38600000|41a00000
R|4|38c80000|41a00000
R|5|399d0000|41a00000
R|6|36000000|41a00000
R|7|36800000|41a00000
R|8|37000000|41a00000
R|9|380c0000|41a00000
R|10|38880000|41a00000
R|11|38b80000|41a00000
R|12|36800000|41a00000
R|13|37000000|41a00000
R|14|37000000|41a00000
R|15|38a40000|41a00000
R|16|38920000|41a00000
R|17|39860000|41a00000
R|18|36000000|41a00000
R|19|36800000|41a00000
R|20|36800000|41a00000
R|21|37000000|41a00000
R|22|38500000|41a00000
R|23|38980000|41a00000
R|24|36160000|41a00000
R|25|36800000|41a00000
R|26|37000000|41a00000
R|27|38b00000|41a00000
R|28|38500000|41a00000
R|29|390c0000|41a00000
R|30|36800000|41a00000
R|31|37100000|41a00000
R|32|37000000|41a00000
R|33|38580000|41a00000
R|34|38cc0000|41a00000
R|35|39410000|41a00000
R|36|36000000|41a00000
R|37|35800000|41a00000
R|38|37000000|41a00000
R|39|37c00000|41a00000
R|40|394c0000|41a00000
R|41|38300000|41a00000
R|42|36800000|41a00000
R|43|36800000|41a00000
R|44|37200000|41a00000
R|45|38980000|41a00000
R|46|38aa0000|41a00000
R|47|39200000|41a00000
R|48|36400000|41a00000
R|49|37000000|41a00000
R|50|37400000|41a00000
R|51|38940000|41a00000
R|52|38b00000|41a00000
R|53|39100000|41a00000
R|54|36000000|41a00000
R|55|36000000|41a00000
R|56|37000000|41a00000
R|57|38100000|41a00000
R|58|38400000|41a00000
R|59|39ae0000|41a00000
S|grid-null-400|41a00000|41a00000|GRID|ALLOWED:null|ALLOWED:null
S|grid-null-100|42a00000|42a00000|GRID|ALLOWED:null|ALLOWED:null
S|grid-cal-20-ext-25|41a00000|-|GRID|ALLOWED:null|ALLOWED:null
S|grid-cal-zero|42a00000|42a00000|GRID|ALLOWED:null|ALLOWED:null
S|grid-cal-nan|42a00000|42a00000|GRID|ALLOWED:null|ALLOWED:null
S|photo-null|-|-|NONE|NEEDS|ALLOWED:41a00000
S|photo-cal|406ccccd|-|MEASURED|ALLOWED:null|ALLOWED:null
S|photo-local-only|406ccccd|-|UNMEASURED|ALLOWED:null|ALLOWED:null
S|ext-zero|41a00000|41a00000|GRID|ALLOWED:null|ALLOWED:null
`;
const golden = KOTLIN_GOLDEN.trim().split("\n");
const goldenOf = (tag) => golden.filter((l) => l.startsWith(tag + "|"));

// =============================================================================
// 1. The transcription IS the Kotlin.
// =============================================================================
test("1. the transcription reproduces the real Kotlin's snap and measurement, bit for bit, on all 360 drawings", () => {
  const want = goldenOf("A");
  assert.equal(want.length, 360, "the golden must hold every scenario or this proves nothing");
  const got = ALL.map((i) => {
    const r = addAndCheck(i, realAdd);
    return ["A", i, r.snap.kind, hex(r.snap.point.x), hex(r.snap.point.y), r.unchanged ? "1" : "0", hex(r.totalBefore), hex(r.totalAfter)].join("|");
  });
  const bad = got.map((l, i) => (l === want[i] ? null : `got  ${l}\nwant ${want[i]}`)).filter(Boolean);
  assert.equal(bad.length, 0,
    `${bad.length} of 360 differ from what the Kotlin did. The transcription has drifted from the Kotlin, or the Kotlin ` +
    `changed and the golden is stale (re-run the harness, recipe at the bottom). First:\n${bad.slice(0, 2).join("\n")}`);
});

test("1b. the Kotlin itself reported zero drift (its own comparison, not this file's)", () => {
  assert.deepEqual(goldenOf("D"), ["D|0"]);
  assert.ok(goldenOf("A").every((l) => l.split("|")[5] === "1"), "every Kotlin scenario says its pre-existing sides were unchanged");
});

// =============================================================================
// 2. THE REPRODUCTION ATTEMPT, and the canaries that give it teeth.
// =============================================================================
test("2. adding a side does not change a side that was already there -- 360 drawings", () => {
  const results = ALL.map((i) => addAndCheck(i, realAdd));
  const drifted = results.filter((r) => !r.unchanged);
  assert.equal(drifted.length, 0, `drift in scenarios ${drifted.map((r) => r.i).join(",")}`);

  // Coverage: a green run over drawings that never exercised the interesting cases is not a green run.
  assert.deepEqual([...new Set(results.map((r) => r.job.ext))].sort((a, b) => a - b), EXTENTS, "every grid size");
  assert.deepEqual([...new Set(results.map((r) => (r.job.cal == null ? "none" : r.job.cal === unitsPerFoot(r.job.ext) ? "agrees" : "hand")))].sort(),
    ["agrees", "hand", "none"], "no calibration, a calibration that agrees with the grid, and a hand calibration");
  assert.deepEqual([...new Set(results.map((r) => r.runCount))].sort(), [1, 2, 3], "one to three runs");
  assert.ok(results.some((r) => r.closed) && results.some((r) => !r.closed), "open and closed runs");
  for (const kind of ["NONE", "VERTEX", "ANGLE", "LENGTH", "ANGLE_AND_LENGTH"]) {
    assert.ok(results.some((r) => r.snap.kind === kind), `a ${kind} snap was exercised`);
  }
});

test("2b. CANARIES: the detector catches every drift the brief's suspects would cause", () => {
  const caught = (add) => ALL.filter((i) => !addAndCheck(i, add).unchanged).length;
  const control = caught(realAdd);
  assert.equal(control, 0, "control: the real add path is clean, so a non-zero count below is the planted drift and nothing else");
  assert.ok(caught(canarySnapDragsPrevious) > 100, "a snap that drags the previous corner must be caught (suspect 2)");
  assert.equal(caught(canaryRefitWithoutScale), ALL.length, "a refit that rescales every corner without the scale must be caught (suspect 1)");
  assert.equal(caught(canaryScaleFromGrownExtent), ALL.length, "a scale re-derived from a grown extent must be caught (suspect 3)");
});

// =============================================================================
// 3. The one side that DOES change: the closing side of a closed loop.
// =============================================================================
test("3. a closed loop: the old closing side is replaced by two, and every other side stays", () => {
  const sq = [{ x: 1000, y: 1000 }, { x: 1800, y: 1000 }, { x: 1800, y: 1800 }];
  const before = analyze(sq, 20, true);
  const { runs } = addTheWayTheAppDoes([sq], 0, { x: 1000, y: 2200 }, 20);
  const after = analyze(runs[0], 20, true);

  assert.equal(before.segments.length, 3);
  assert.equal(after.segments.length, 4);
  for (const s of [0, 1]) assert.equal(bitsOf(after.segments[s].lengthFt), bitsOf(before.segments[s].lengthFt), `side ${s + 1} is untouched`);
  // The side that WAS number 3 -- the closing side, 56.57 ft -- is now the side from the last corner to the new
  // one (45 ft after the whole-foot snap), and the closing side is a new one, from the new corner back to the start
  // (60.125 ft). Side "3" changed, by design: the loop closes on whatever corner is last.
  assert.ok(Math.abs(before.segments[2].lengthFt - 56.57) < 0.01);
  assert.equal(after.segments[2].lengthFt, 45);
  assert.ok(after.segments[3].lengthFt > 60 && after.segments[3].lengthFt < 60.2);
  assert.notEqual(after.totalLinearFeet, before.totalLinearFeet, "the perimeter changes: that is the new corner, not a drift");

  const want = goldenOf("C");
  assert.deepEqual(
    [`C|before|${before.segments.map((s) => hex(s.lengthFt)).join(",")}|${hex(before.totalLinearFeet)}`,
     `C|after|${after.segments.map((s) => hex(s.lengthFt)).join(",")}|${hex(after.totalLinearFeet)}`],
    want, "and the real Kotlin agrees with all of it");
});

// =============================================================================
// 4. The other way a side can move: the scale. This is the only path that rescales anything.
// =============================================================================
function rescaleChain(i) {
  const { job: job0, runs: runs0 } = build(i);
  let job = { ...job0 };
  const original = runs0.map((r) => analyze(r, scaleOf(job), false).segments.map((s) => s.lengthFt));
  let runs = runs0;
  let worst = 0;
  for (const extentFt of [100, 25, 400, 2000, 50, 1000, 400, 300, 400, 37, 400]) {
    const before = scaleOf(job);
    const after = unitsPerFoot(extentFt);
    if (before <= 0 || Math.abs(before - after) < 0.0001) { job = { ...job, ext: extentFt }; continue; }
    const ratio = f32(after / before);
    runs = runs.map((r) => r.map((p) => ({ x: f32(p.x * ratio), y: f32(p.y * ratio) })));
    job = { ...job, ext: extentFt, cal: after };
    const ppf = scaleOf(job);
    runs.forEach((r, k) => {
      analyze(r, ppf, false).segments.forEach((s, idx) => { worst = Math.max(worst, Math.abs(f32(s.lengthFt - original[k][idx]))); });
    });
  }
  return { worst, ppf: scaleOf(job) };
}

test("4. changing the grid size preserves every length: eleven consecutive changes move no side by more than a thousandth of a foot", () => {
  const want = goldenOf("R");
  assert.equal(want.length, 60);
  let max = 0;
  for (let i = 0; i < 60; i++) {
    const r = rescaleChain(i);
    assert.equal(`R|${i}|${hex(r.worst)}|${hex(r.ppf)}`, want[i], `scenario ${i}: the transcription agrees with the Kotlin`);
    max = Math.max(max, r.worst);
    assert.equal(r.ppf, 20, "and a chain that ends on 400 ft ends on exactly 20 units per foot");
  }
  assert.ok(max < 0.001, `worst single-side change over eleven rescales was ${max} ft -- cosmetic, and nowhere near the 0.01 ft that a display rounds to`);
  assert.ok(max > 0, "control: the chain does exercise float rounding, so a zero here would mean the scenario did nothing");
});

// =============================================================================
// 5. DrawingScale: the rule every caller reads, held to the Kotlin.
// =============================================================================
test("5. DrawingScale answers the same for every job shape that matters", () => {
  const shapes = [
    ["grid-null-400", { ext: 400, cal: null }],
    ["grid-null-100", { ext: 100, cal: null }],
    ["grid-cal-20-ext-25", { ext: 25, cal: 20 }],
    ["grid-cal-zero", { ext: 100, cal: 0 }],
    ["grid-cal-nan", { ext: 100, cal: NaN }],
    ["photo-null", { ext: 400, cal: null, surveyStoragePath: "x" }],
    ["photo-cal", { ext: 400, cal: f32(3.7), known: 40, surveyStoragePath: "x" }],
    ["photo-local-only", { ext: 400, cal: f32(3.7), surveyImagePath: "/p.jpg" }],
    ["ext-zero", { ext: 0, cal: null }],
  ];
  const h = (x) => (x == null ? "-" : hex(x));
  const got = shapes.map(([name, j]) => ["S", name, h(scaleOf(j)), h(calibrationToSeed(j)), basisOf(j), gridBackdropPlan(j, true), gridBackdropPlan(j, false)].join("|"));
  assert.deepEqual(got, goldenOf("S"));
});

test("5b. the screen and the billing disagree on a grid job's scale ONLY when it has no stored calibration and is not the 400 ft default", () => {
  // The screen measures at DrawingScale.of: stored calibration, else the grid's own 8000/extent.
  // EstimateEngine.footageOf and the server (totals.ts) measure at: stored calibration, else a flat 20.
  // They agree whenever a calibration is stored, and without one only at 400 ft. This is the a21 split.
  const billing = (job) => (usable(job.cal) ? job.cal : PIXELS_PER_FOOT_GRID);
  for (const ext of EXTENTS) {
    const noCal = { ext, cal: null };
    assert.equal(scaleOf(noCal) === billing(noCal), ext === 400, `no calibration, ${ext} ft grid`);
    const stored = { ext, cal: unitsPerFoot(ext) };
    assert.equal(scaleOf(stored), billing(stored), `calibration stored, ${ext} ft grid`);
  }
  // The one live job that had a 25 ft grid and a stored 20 (patched 29 September): screen and billing AGREE (both read 20) -- and are both
  // sixteen times too long against the 320 the grid would have used. Agreement is not correctness.
  assert.equal(scaleOf({ ext: 25, cal: 20 }), 20);
  assert.equal(unitsPerFoot(25), 320);
});

// =============================================================================
// 6. Source checks: the claims the diagnosis stands on, tied to the code that makes them.
//    These read the Kotlin. A failure here is NOT a drift in anyone's footage: it says a premise of
//    docs/FOOTAGE_DRIFT.md has changed and the diagnosis needs reading again.
//
//    Each probe takes the source text and returns the list of problems it finds, so the same probe can
//    be run on the real file (must be empty) and on a doctored copy (must not be) -- 6e.
// =============================================================================
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const GEOM = "app/src/main/java/com/fenceestimator/app/geometry/FenceGeometry.kt";
const VM = "app/src/main/java/com/fenceestimator/app/ui/survey/SurveyViewModel.kt";
const SCREEN = "app/src/main/java/com/fenceestimator/app/ui/survey/SurveyDrawScreen.kt";

/** Text of `fun <name>(` through its matching close brace, or a loud failure rather than an empty string. */
function bodyOf(src, where, name) {
  const at = src.indexOf(`fun ${name}(`);
  assert.notEqual(at, -1, `could not find "fun ${name}(" in ${where}: renamed or removed, so this probe needs updating`);
  const open = src.indexOf("{", src.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  assert.fail(`braces never balanced for fun ${name} in ${where}: file mid-edit?`);
}
/** The function a character offset sits in, by the nearest `fun x(` before it. */
function functionAt(src, index) {
  const f = [...src.slice(0, index).matchAll(/\bfun\s+(?:[\w.<>]+\.)?(\w+)\s*\(/g)].pop();
  return f ? f[1] : "(top level)";
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const uniqueSorted = (xs) => [...new Set(xs)].sort();

/** 6a. snapDrawPoint is handed read-only lists and returns one SnapResult: it can only POSITION the new point. */
function snapProblems(geomSrc) {
  const body = stripComments(bodyOf(geomSrc, GEOM, "snapDrawPoint"));
  const problems = [];
  if (!/otherVertices:\s*List<FencePoint>/.test(body)) problems.push("the corners to join are no longer a read-only List");
  if (/MutableList<FencePoint>/.test(body)) problems.push("a mutable corner list is taken or built");
  if (/otherVertices\s*(\[|\.(add|remove|set|clear|plusAssign))/.test(body)) problems.push("something writes into the corners it was given");
  if (!/\):\s*SnapResult\s*\{/.test(body)) problems.push("it no longer returns one SnapResult");
  const returns = [...body.matchAll(/return\s+([A-Za-z]+)\(/g)].map((m) => m[1]);
  if (returns.length < 4) problems.push(`expected at least four returns, saw ${returns.length}: the probe is reading the wrong text`);
  if (!returns.every((r) => r === "SnapResult")) problems.push(`a return that is not a SnapResult: ${returns}`);
  return problems;
}

/** 6b. addDrawPoint appends one point and writes the run; neither it nor writePoints touches a scale. */
function addProblems(vmSrc) {
  const add = stripComments(bodyOf(vmSrc, VM, "addDrawPoint"));
  const write = stripComments(bodyOf(vmSrc, VM, "writePoints"));
  const problems = [];
  if (!/decodePoints\(run\.pointsEncoded\)\s*\+\s*point/.test(add)) problems.push("addDrawPoint no longer appends one point to what was read");
  if (!/writePoints\(run,\s*points\)/.test(add)) problems.push("addDrawPoint no longer writes through writePoints");
  if (/updateJob|calibration|gridExtent|setGridExtent|unitsPerFoot/.test(add)) problems.push("addDrawPoint touches the job's scale");
  if (/updateJob|calibration|gridExtent/.test(write)) problems.push("writePoints touches the job's scale");
  return problems;
}

/** 6c. The tap that adds a side calls only snapForDraw and addDrawPoint. */
function tapProblems(screenSrc) {
  const src = stripComments(screenSrc);
  const snap = src.indexOf("viewModel.snapForDraw(");
  if (snap === -1) return ["the tap handler no longer calls viewModel.snapForDraw"];
  const from = src.lastIndexOf("SurveyMode.DRAW ->", snap);
  const to = src.indexOf("SurveyMode.CALIBRATE ->", snap);
  if (from === -1 || to === -1 || to < snap) return ["could not bound the DRAW branch of the tap handler"];
  const calls = [...src.slice(from, to).matchAll(/viewModel\.(\w+)\(/g)].map((m) => m[1]).sort();
  // WIDENED 2026-10-02, and only by one name.
  //
  // This demanded exactly "addDrawPoint,snapForDraw". Snap-to-connect added a
  // third call: when the snap lands the new point on another side's free end,
  // the tap also raises the "make it one post?" offer. That is a question on
  // screen, not a write.
  //
  // The guarantee underneath is unchanged and is NOT about how many calls the
  // branch makes -- it is that adding a side cannot move the job's SCALE, which
  // is what docs/FOOTAGE_DRIFT.md is about. So the allowance is a named list,
  // not a relaxation to "anything", and the new name is held to the same rule
  // by the scale check below (6d/6f read every writer in the view model, and
  // offerJoinAfterDraw is not one of them: it delegates to offerJoinFromSnap,
  // which raises a StateFlow and writes nothing).
  //
  // A FOURTH arrived, and this check did its job: it stopped the change and
  // made somebody look. finishSideByDoubleTap -- tap the same spot twice to
  // say "this side is done" instead of hunting for a button.
  //
  // Checked against the guarantee rather than waved through. It reads the
  // run's points, removes the duplicate point the SECOND tap just created,
  // writes the points back through writePoints, and raises a StateFlow so the
  // screen can offer to start the next side. writePoints copies exactly
  // pointsEncoded and gatesEncoded. Nothing in that path names
  // calibrationPixelsPerFoot or gridExtentFt, or calls any of the scale
  // writers 6d/6f enumerate. So adding a side still cannot move the job's
  // scale, which is the whole of what docs/FOOTAGE_DRIFT.md is about.
  //
  // Any FIFTH name still fails here, deliberately, for the same reason this
  // one was caught.
  const ALLOWED = ["addDrawPoint", "finishSideByDoubleTap", "offerJoinAfterDraw", "snapForDraw"];
  const unexpected = calls.filter((c) => !ALLOWED.includes(c));
  if (unexpected.length) return [`the DRAW tap now calls: ${calls} (unexpected: ${unexpected})`];
  // And the two that do the work must still both be there.
  for (const required of ["snapForDraw", "addDrawPoint"]) {
    if (!calls.includes(required)) return [`the DRAW tap no longer calls ${required}: ${calls}`];
  }
  return [];
}

/**
 * `calibrationPixelsPerFoot = <value>` or `gridExtentFt = <value>`: an assignment or a named argument, never a
 * comparison (`== null`, `!= null`). Group 1 is the field, group 2 the value.
 */
const ASSIGNS_SCALE = /\b(calibrationPixelsPerFoot|gridExtentFt)\s*=(?!=)\s*([^\s,)]+)/g;

/** 6d. The functions that can move a job's scale, and who calls them. */
const WRITERS =["applyCalibration", "clearSurveyImage", "ensureGridCalibration", "fitSurvey", "setGridExtent"];
function scaleWriterProblems(vmSrc, screenSrc) {
  const vm = stripComments(vmSrc);
  const problems = [];
  // Every assignment of a non-null value to the calibration or the extent, and the function it sits in.
  const assigned = [...vm.matchAll(ASSIGNS_SCALE)].filter((m) => m[2] !== "null");
  if (assigned.length < 6) problems.push(`control failed: the pattern found only ${assigned.length} assignments, so a clean list means nothing`);
  const writers = uniqueSorted(assigned.map((m) => functionAt(vm, m.index)).filter((n) => n !== "(top level)"));
  if (writers.join() !== WRITERS.join()) problems.push(`writers of the scale are now: ${writers}`);
  // Callers of setGridExtent, the only function that rescales the drawing itself.
  const callers = uniqueSorted([...vm.matchAll(/(?<!fun\s)\bsetGridExtent\(/g)].map((m) => functionAt(vm, m.index)));
  if (callers.join() !== "ensureSatelliteCalibration,resetGridCalibration") problems.push(`callers of setGridExtent are now: ${callers}`);
  const screen = stripComments(screenSrc);
  const calls = [...screen.matchAll(/viewModel\.(setGridExtent|resetGridCalibration|ensureGridCalibration|ensureSatelliteCalibration|applyCalibration|clearSurveyImage|fitSurvey)\(/g)].map((m) => m[1]).sort();
  const want = ["applyCalibration", "clearSurveyImage", "ensureGridCalibration", "ensureSatelliteCalibration", "fitSurvey", "setGridExtent"];
  if (calls.join() !== want.join()) problems.push(`the screen now calls the scale writers: ${calls}`);
  return problems;
}

const NEW_WRITER = "A new way to change the scale appeared. Before updating docs/FOOTAGE_DRIFT.md and this list, confirm it cannot run when a side is added: that is the one thing the diagnosis rules out.";

test("6a. snapDrawPoint can only POSITION the new point", () => {
  assert.deepEqual(snapProblems(read(GEOM)), []);
});
test("6b. addDrawPoint appends one point and writes the run -- it touches no scale", () => {
  assert.deepEqual(addProblems(read(VM)), []);
});
test("6c. the tap that adds a side calls only snapForDraw and addDrawPoint", () => {
  assert.deepEqual(tapProblems(read(SCREEN)), []);
});
test("6d. the functions that can move a job's scale are exactly the ones the diagnosis names", () => {
  assert.deepEqual(scaleWriterProblems(read(VM), read(SCREEN)), [], NEW_WRITER);
});

test("6e. CANARIES: each probe goes red on code that does the thing the diagnosis says nothing does", () => {
  const geom = read(GEOM), vm = read(VM), screen = read(SCREEN);
  // Doctor `src` by replacing the first match of `re` at or after `after`; the anchor must exist, or the canary proves nothing.
  const doctor = (src, re, to, after = "") => {
    const start = after ? src.indexOf(after) : 0;
    assert.ok(start !== -1, `canary anchor missing: ${after}`);
    const head = src.slice(0, start), tail = src.slice(start);
    assert.ok(re.test(tail), `canary anchor missing: ${re}`);
    return head + tail.replace(re, to);
  };

  // snapDrawPoint handed a list it could write into.
  const mutableSnap = doctor(geom, /otherVertices:\s*List<FencePoint>/, "otherVertices: MutableList<FencePoint>", "fun snapDrawPoint(");
  assert.notDeepEqual(snapProblems(mutableSnap), []);
  // addDrawPoint that also rewrites the job.
  const rewritesJob = doctor(vm, /writePoints\(run,\s*points\)/, "repository.updateJob(job.value!!.copy(gridExtentFt = 1f)); writePoints(run, points)", "fun addDrawPoint(");
  assert.notDeepEqual(addProblems(rewritesJob), []);
  // A tap that also resizes the grid.
  const tapResizes = doctor(screen, /viewModel\.addDrawPoint\(snap\.point\)/, "viewModel.addDrawPoint(snap.point); viewModel.setGridExtent(100f)");
  assert.notDeepEqual(tapProblems(tapResizes), []);
  // An auto-fit that grows the extent: a new function writing the scale.
  const autoFit = doctor(vm, /fun resetGridCalibration\(\)\s*\{/,
    "fun autoFit() { viewModelScope.launch { repository.updateJob(job.value!!.copy(gridExtentFt = 800f)) } }\n    fun resetGridCalibration() {");
  assert.notDeepEqual(scaleWriterProblems(autoFit, screen), []);
  // And the same probes on the untouched files stay clean, so the reds above are the doctoring and nothing else.
  assert.deepEqual([...snapProblems(geom), ...addProblems(vm), ...tapProblems(screen), ...scaleWriterProblems(vm, screen)], []);
});

// =============================================================================
// 6f. The WHOLE app: every function anywhere that can write a job's calibration or grid extent. The drawing screen
//     is not the only door. Two others are the ones a person reaches on purpose, and neither runs when a side is
//     added: Suggest Quantities (EstimateViewModel.regenerateInternal) stores the grid's own scale on a grid job that
//     has none, and "make the drawing match N ft" (EstimateViewModel.recalibrateFromRun) retypes the scale of EVERY run
//     from one -- the one deliberate path by which a single number moves every side at once. JobSync only maps a
//     job row to and from the cloud.
// =============================================================================
const APP_ROOT = new URL("../app/src/main/java/", import.meta.url);
function kotlinFiles(dir = APP_ROOT) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? kotlinFiles(new URL(e.name + "/", dir)) : e.name.endsWith(".kt") ? [new URL(e.name, dir)] : []);
}
function scaleWritersAnywhere(readFile) {
  const found = [];
  for (const file of kotlinFiles()) {
    const src = stripComments(readFile(file));
    for (const m of src.matchAll(ASSIGNS_SCALE)) {
      if (m[2] === "null") continue;
      found.push(`${file.pathname.split("/com/fenceestimator/app/")[1]}#${functionAt(src, m.index)}`);
    }
  }
  return uniqueSorted(found);
}
const WRITERS_ANYWHERE = [
  "cloud/JobSync.kt#mergeOnto",
  "cloud/JobSync.kt#toCloud",
  "cloud/JobSync.kt#toLocalJob",
  "estimate/DrawingScale.kt#jobAfter",
  "ui/estimate/EstimateViewModel.kt#recalibrateFromRun",
  "ui/estimate/EstimateViewModel.kt#regenerateInternal",
  "ui/survey/SurveyViewModel.kt#applyCalibration",
  "ui/survey/SurveyViewModel.kt#clearSurveyImage",
  "ui/survey/SurveyViewModel.kt#ensureGridCalibration",
  "ui/survey/SurveyViewModel.kt#fitSurvey",
  "ui/survey/SurveyViewModel.kt#setGridExtent",
];
test("6f. the complete list of places in the app that can write a job's scale", () => {
  assert.ok(kotlinFiles().length > 100, "control: the walk found the app's source (a walk that finds nothing passes every list)");
  assert.deepEqual(scaleWritersAnywhere((u) => readFileSync(u, "utf8")), WRITERS_ANYWHERE, NEW_WRITER);
});
test("6f-canary. a function added anywhere that writes the scale is seen", () => {
  const planted = new URL("com/fenceestimator/app/ui/jobs/JobDetailViewModel.kt", APP_ROOT).href;
  const real = (u) => readFileSync(u, "utf8");
  const withPlanted = scaleWritersAnywhere((u) => (u.href === planted
    ? real(u) + "\nfun refit() { repository.updateJob(job.copy(calibrationPixelsPerFoot = 1f)) }\n"
    : real(u)));
  assert.ok(withPlanted.includes("ui/jobs/JobDetailViewModel.kt#refit"), "the planted writer shows up in the list");
  assert.notDeepEqual(withPlanted, WRITERS_ANYWHERE);
});

// =============================================================================
// THE KOTLIN HARNESS: the whole of the program that produced KOTLIN_GOLDEN. To regenerate after editing
// snapDrawPoint, landSide, DrawingScale or the scenarios above (nothing here needs Gradle, and nothing may touch
// the Gradle build while other waves compile):
//   1. node --input-type=module -e "import fs from 'node:fs'; const m = await import('./tests/a41-footage-existing-sides.test.mjs'); fs.writeFileSync('Harness.kt', m.KOTLIN_HARNESS); fs.writeFileSync('JobStub.kt', m.KOTLIN_JOB_STUB)"
//   2. java -Xmx768m -XX:+UseSerialGC -cp <kotlin-compiler-embeddable-2.0.21 + kotlin-stdlib + kotlin-script-runtime
//        + kotlin-reflect 1.6.10 + kotlin-daemon-embeddable + trove4j + annotations + kotlinx-coroutines-core-jvm
//        jars from ~/.gradle/caches> org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -no-reflect
//        -cp kotlin-stdlib-2.0.21.jar -d out geometry/FenceGeometry.kt geometry/SideLength.kt geometry/GateSpan.kt
//        estimate/DrawingScale.kt JobStub.kt Harness.kt      (classpath separator is ; on Windows)
//   3. java -cp "out;kotlin-stdlib-2.0.21.jar" HarnessKt, then fold each line to the compact hex form of KOTLIN_GOLDEN
//      (ADD -> A with the Float bits in hex, ADD_DRIFT_COUNT -> D, CLOSED -> C, RESCALE -> R, SCALE -> S).
// It compiles four pure files (kotlin.math and java.lang.Math only) so it never touches the code other waves are
// editing. One JVM at about 700 MB for half a minute: run it when the machine has memory to spare.
// =============================================================================
export const KOTLIN_JOB_STUB = `package com.fenceestimator.app.data

// Harness-only stand-in for the Room entity: exactly the fields DrawingScale reads, same names, same defaults.
data class Job(
    val surveyImagePath: String? = null,
    val surveyStoragePath: String? = null,
    val calibrationPixelsPerFoot: Float? = null,
    val calibrationKnownFeet: Float? = null,
    val gridExtentFt: Float = 400f,
)
`;

export const KOTLIN_HARNESS = `import com.fenceestimator.app.data.Job
import com.fenceestimator.app.estimate.DrawingScale
import com.fenceestimator.app.estimate.GridBackdropPlan
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FenceGeometryEngine
import com.fenceestimator.app.geometry.FencePoint
import com.fenceestimator.app.geometry.SnapResult
import com.fenceestimator.app.geometry.snapDrawPoint

// Deterministic generator that this harness and the JS test both run: Numerical Recipes LCG, 32-bit, 24-bit outputs.
class Lcg(seed: Long) {
    private var s: Long = seed and 0xFFFFFFFFL
    fun next24(): Int { s = (s * 1664525L + 1013904223L) and 0xFFFFFFFFL; return (s ushr 8).toInt() }
    fun unit(): Float = next24() / 16777216f
    fun pick(n: Int): Int = (unit() * n).toInt()
}

fun bits(f: Float): Int = java.lang.Float.floatToIntBits(f)

val EXTENTS = floatArrayOf(25f, 50f, 100f, 400f, 1000f, 2000f)

fun jobFor(i: Int): Job {
    val ext = EXTENTS[i % 6]
    return when (i % 3) {
        0 -> Job(gridExtentFt = ext)
        1 -> Job(gridExtentFt = ext, calibrationPixelsPerFoot = DrawingScale.unitsPerFoot(ext))
        else -> Job(gridExtentFt = ext, calibrationPixelsPerFoot = DrawingScale.unitsPerFoot(ext) * 1.37f)
    }
}

fun sideBits(points: List<FencePoint>, ppf: Float, closed: Boolean): List<Int> =
    FenceGeometryEngine.analyze(points, ppf, closed).segments.map { bits(it.lengthFt) }

/** The add path of the drawing screen: snapForDraw (snapDrawPoint, every vertex of every run offered) then addDrawPoint (append, encode, decode). */
fun addTheWayTheAppDoes(
    runs: List<List<FencePoint>>, active: Int, tap: FencePoint, ppf: Float
): Pair<List<List<FencePoint>>, SnapResult> {
    val pts = runs[active]
    val snap = snapDrawPoint(
        candidate = tap,
        previous = pts.lastOrNull(),
        beforePrevious = pts.getOrNull(pts.size - 2),
        otherVertices = runs.flatMap { it },
        pxPerFt = ppf,
    )
    val grown = FenceCodec.decodePoints(FenceCodec.encodePoints(pts + snap.point))
    return runs.mapIndexed { k, r ->
        if (k == active) grown else FenceCodec.decodePoints(FenceCodec.encodePoints(r))
    } to snap
}

fun tapFrom(prev: FencePoint, rnd: Lcg, minFt: Float, spanFt: Float, ppf: Float): FencePoint {
    val ft = minFt + rnd.unit() * spanFt
    val ang = rnd.unit() * 6.2831855f
    val x = (prev.x + kotlin.math.cos(ang.toDouble()).toFloat() * ft * ppf).coerceIn(0f, 8000f)
    val y = (prev.y + kotlin.math.sin(ang.toDouble()).toFloat() * ft * ppf).coerceIn(0f, 8000f)
    return FencePoint(x, y)
}

class Built(val job: Job, val runs: List<List<FencePoint>>, val closed: Boolean)

fun build(i: Int): Built {
    val job = jobFor(i)
    val ppf = DrawingScale.of(job)!!
    val rnd = Lcg((i + 1).toLong())
    val runCount = 1 + (i / 6) % 3
    val closed = i % 5 == 0
    var runs = List(runCount) { emptyList<FencePoint>() }
    for (r in 0 until runCount) {
        val n = 2 + rnd.pick(5)
        for (k in 0 until n) {
            val prev = runs[r].lastOrNull()
            val tap = if (prev == null) FencePoint(500f + rnd.unit() * 7000f, 500f + rnd.unit() * 7000f)
            else tapFrom(prev, rnd, 3f, 57f, ppf)
            runs = addTheWayTheAppDoes(runs, r, tap, ppf).first
        }
    }
    return Built(job, runs, closed)
}

fun planWords(p: GridBackdropPlan): String = when (p) {
    is GridBackdropPlan.NeedsScale -> "NEEDS"
    is GridBackdropPlan.Allowed -> "ALLOWED:" + (p.seed?.let { bits(it).toString() } ?: "null")
}

fun main() {
    // 1. Adding a side the way the app adds one. Every side that already existed must come back bit-identical.
    var drift = 0
    for (i in 0 until 360) {
        val b = build(i)
        val ppf = DrawingScale.of(b.job)!!
        val active = b.runs.size - 1
        val rnd = Lcg((i + 1).toLong() * 7919L)
        val tap = tapFrom(b.runs[active].last(), rnd, 2f, 70f, ppf)
        val sidesBefore = b.runs.mapIndexed { k, r -> sideBits(r, ppf, k == active && b.closed) }
        val (after, snap) = addTheWayTheAppDoes(b.runs, active, tap, ppf)
        var unchanged = true
        for (k in b.runs.indices) {
            val closedHere = k == active && b.closed
            val sidesAfter = sideBits(after[k], ppf, closedHere)
            val comparable = if (closedHere) sidesBefore[k].size - 1 else sidesBefore[k].size
            for (s in 0 until comparable) if (sidesBefore[k][s] != sidesAfter[s]) unchanged = false
            for (p in b.runs[k].indices) if (b.runs[k][p] != after[k][p]) unchanged = false
        }
        if (!unchanged) drift++
        val totalBefore = FenceGeometryEngine.analyze(b.runs[active], ppf, b.closed).totalLinearFeet
        val totalAfter = FenceGeometryEngine.analyze(after[active], ppf, b.closed).totalLinearFeet
        println("ADD|$i|\${b.job.gridExtentFt}|\${bits(ppf)}|\${b.runs.size}|\${b.closed}|\${snap.kind}|\${bits(snap.point.x)}|\${bits(snap.point.y)}|$unchanged|\${bits(totalBefore)}|\${bits(totalAfter)}")
    }
    println("ADD_DRIFT_COUNT|$drift")

    // 2. A closed loop, spelled out: what adding a corner does to the side that was last.
    run {
        val sq = listOf(FencePoint(1000f, 1000f), FencePoint(1800f, 1000f), FencePoint(1800f, 1800f))
        val ppf = 20f
        val before = FenceGeometryEngine.analyze(sq, ppf, true)
        val (a, _) = addTheWayTheAppDoes(listOf(sq), 0, FencePoint(1000f, 2200f), ppf)
        val after = FenceGeometryEngine.analyze(a[0], ppf, true)
        println("CLOSED|before|" + before.segments.joinToString(",") { bits(it.lengthFt).toString() } + "|total|" + bits(before.totalLinearFeet))
        println("CLOSED|after|" + after.segments.joinToString(",") { bits(it.lengthFt).toString() } + "|total|" + bits(after.totalLinearFeet))
    }

    // 3. The scale-change path: the Float arithmetic of SurveyViewModel.setGridExtent, over a chain of grid sizes.
    //    Measured: the worst change in any side, in feet, against the sides as first drawn.
    for (i in 0 until 60) {
        val b = build(i)
        var job = b.job
        val ppf0 = DrawingScale.of(job)!!
        var runs = b.runs
        val original = runs.map { FenceGeometryEngine.analyze(it, ppf0, false).segments.map { s -> s.lengthFt } }
        var worst = 0f
        for (extentFt in floatArrayOf(100f, 25f, 400f, 2000f, 50f, 1000f, 400f, 300f, 400f, 37f, 400f)) {
            val before = DrawingScale.of(job)!!
            val after = DrawingScale.unitsPerFoot(extentFt)
            if (before <= 0f || kotlin.math.abs(before - after) < 0.0001f) { job = job.copy(gridExtentFt = extentFt); continue }
            val ratio = after / before
            runs = runs.map { r -> r.map { FencePoint(it.x * ratio, it.y * ratio) } }
            job = job.copy(gridExtentFt = extentFt, calibrationPixelsPerFoot = after)
            val ppf = DrawingScale.of(job)!!
            for (k in runs.indices) {
                val now = FenceGeometryEngine.analyze(runs[k], ppf, false).segments.map { s -> s.lengthFt }
                for (s in now.indices) worst = maxOf(worst, kotlin.math.abs(now[s] - original[k][s]))
            }
        }
        println("RESCALE|$i|\${bits(worst)}|\${bits(DrawingScale.of(job)!!)}")
    }

    // 4. DrawingScale answers for the job shapes that matter.
    val shapes = listOf(
        "grid-null-400" to Job(),
        "grid-null-100" to Job(gridExtentFt = 100f),
        "grid-cal-20-ext-25" to Job(gridExtentFt = 25f, calibrationPixelsPerFoot = 20f),
        "grid-cal-zero" to Job(gridExtentFt = 100f, calibrationPixelsPerFoot = 0f),
        "grid-cal-nan" to Job(gridExtentFt = 100f, calibrationPixelsPerFoot = Float.NaN),
        "photo-null" to Job(surveyStoragePath = "x"),
        "photo-cal" to Job(surveyStoragePath = "x", calibrationPixelsPerFoot = 3.7f, calibrationKnownFeet = 40f),
        "photo-local-only" to Job(surveyImagePath = "/p.jpg", calibrationPixelsPerFoot = 3.7f),
        "ext-zero" to Job(gridExtentFt = 0f),
    )
    for ((name, j) in shapes) {
        println("SCALE|$name|\${DrawingScale.of(j)?.let { bits(it) }}|\${DrawingScale.calibrationToSeed(j)?.let { bits(it) }}|\${DrawingScale.basisOf(j)}|\${planWords(DrawingScale.gridBackdropPlan(j, true))}|\${planWords(DrawingScale.gridBackdropPlan(j, false))}")
    }
}
`;
