// JOINING RUNS -- the post arithmetic at a join, as it SHOULD be.
//
// Spec:  docs/JOINING_RUNS.md (read it first; section numbers below point at it).
// Run:   npx tsx tests/a32-join-posts.test.mjs
//
// =============================================================================
// THIS FILE IS RED ON PURPOSE, AND ONLY IN ITS "PENDING" SECTION.
// =============================================================================
// Joining does not exist yet. The files it has to change -- the Kotlin engine,
// the drawing screen and view model, pricing/index.ts -- were all held by other
// waves when this was written, so the intended numbers are pinned here first and
// the implementation follows. A deliberate red with a clear message is the
// precedent this repo already uses (tests/a30-use-grid-persists.test.mjs).
//
// If you are reading this because the suite is red:
//   * lines starting "PENDING" are the join arithmetic that has not landed. They
//     print what was expected and what the engine produced today. They go green
//     when joining is implemented to docs/JOINING_RUNS.md. Do NOT weaken the
//     numbers to make them pass: each one is derived in the document, and four of
//     them are cross-checked against what the engine already prints for one
//     run drawn through the same points (section 1 below proves that, today).
//   * lines starting "FAIL" are REGRESSIONS: a number that is true today and must
//     stay true. Those are real.
//   * lines starting "vacuous" are guards whose control is not live yet (see
//     below). They prove nothing until the matching PENDING case goes green.
//
// HOW EACH SECTION IS BUILT
//   1. BASELINE  -- numbers the engine produces TODAY, with no join anywhere. They
//      pass now and must keep passing. They are also the evidence for the spec:
//      the formula in the document is run (the small reference model below)
//      against the per-run numbers and must reproduce what the real engine says
//      for ONE run drawn through the same points.
//   2. PENDING   -- the join arithmetic itself, through priceJob (the exact
//      function price-job calls). Reads fence-level sums, so it does not depend
//      on which run of a pair the shared post is billed to; the few cases that DO
//      depend on that are in their own group, labelled POLICY.
//   3. GUARDS    -- things a join-aware engine must NOT do (infer a join from
//      coordinates, bill a post to a run that bills nothing, ...). A guard that
//      passes only because joins are ignored is worthless -- that is the exact
//      "a checker that skips the case reports zero failures" trap -- so each guard
//      carries a CONTROL: the same wiring without the disqualifying detail, which
//      must visibly join. While the control is not live the guard prints
//      "vacuous", not "ok".
//
// The new input fields are start_joint, end_joint (strings; "" = not joined) on
// every PricingInput run, as specified in docs/JOINING_RUNS.md section 1. Today
// the engine ignores unknown run keys, which is why these cases fail with a wrong
// NUMBER and not a crash.

import { priceJob, PRICING_ENGINE_VERSION } from "../supabase/functions/_shared/pricing/index.ts";

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
const tally = { baselineOk: 0, baselineFail: 0, pendingRed: 0, pendingLanded: 0, guardOk: 0, guardVacuous: 0, guardFail: 0 };

function baseline(id, label, cond, detail = "") {
  if (cond) { tally.baselineOk++; console.log(`  ok        ${id} ${label}`); }
  else { tally.baselineFail++; console.log(`  FAIL      ${id} ${label} -- REGRESSION: ${detail}`); }
}

/** A join case. `expected`/`got` are strings so the red line says what to build. */
function pending(id, label, cond, expected, got) {
  if (cond) { tally.pendingLanded++; console.log(`  ok        ${id} ${label}   (joining has landed for this case)`); }
  else {
    tally.pendingRed++;
    console.log(`  PENDING   ${id} ${label}`);
    console.log(`            expected ${expected}`);
    console.log(`            got      ${got}`);
    console.log(`            red on purpose until joining is implemented -- docs/JOINING_RUNS.md`);
  }
}

/** A guard. `controlLive` = the same wiring, minus the disqualifier, really joins. */
function guard(id, label, controlLive, cond, detail = "") {
  if (!controlLive) {
    tally.guardVacuous++;
    console.log(`  vacuous   ${id} ${label}`);
    console.log(`            (control not live: joining is not implemented, so this proves nothing yet)`);
  } else if (cond) { tally.guardOk++; console.log(`  ok        ${id} ${label}`); }
  else { tally.guardFail++; console.log(`  FAIL      ${id} ${label} -- ${detail}`); }
}

// ---------------------------------------------------------------------------
// Builders. 20 px per foot is the grid's own scale; a 6 ft bay is 120 px.
// ---------------------------------------------------------------------------
const JOB = {
  calibration_pixels_per_foot: null,
  tax_rate_percent: 0, markup_percent: 0, discount_percent: 0,
  labor_rate_per_ft: 8, labor_flat_fee: 0, minimum_job_charge: 0, minimum_labor_charge: 0,
  waste_percent: 0, gate_rate_per_ft: 20, trash_haul_fee: 0,
  teardown_enabled: false, teardown_flat_fee: 0, teardown_rate_per_ft: 0, teardown_feet: 0,
  preferred_manufacturer_sync_id: null,
};

function run(sync_id, o = {}) {
  return {
    sync_id, label: sync_id, fence_type: "VINYL", color_or_finish: "",
    points_encoded: "", gates_encoded: "", closed_loop: false,
    manual_linear_feet: null, manual_corner_count: 0,
    panel_width_ft: 6, panel_height_ft: 6, post_spacing_ft: 6, concrete_bags_per_post: 1,
    aluminum_style: "RACKABLE", wood_style: "PRIVACY", wood_rail_count: 3, picket_width_in: 5.5, picket_gap_in: 0,
    fabric_height_ft: 4, include_top_rail: true, include_tension_wire: false, include_barbed_wire_arms: false,
    include_privacy_slats: false, split_rail_count: 2, suppressed_roles: "",
    is_teardown: false, sort_order: 0,
    // The new fields (docs/JOINING_RUNS.md section 1). "" = this end is not joined.
    start_joint: "", end_joint: "",
    ...o,
  };
}

function price(runs, jobOverrides = {}) {
  return priceJob({
    engine_version: PRICING_ENGINE_VERSION, pixels_per_foot: 20,
    job: { ...JOB, ...jobOverrides }, runs, catalog: [], manufacturers: [], change_orders: [], existing_items: [],
  });
}

const pts = (...p) => p.map(([x, y]) => `${x}:${y}`).join(",");
const J1 = "a32a0001-0000-4000-8000-000000000001";
const J2 = "a32a0001-0000-4000-8000-000000000002";
const J3 = "a32a0001-0000-4000-8000-000000000003";
const J4 = "a32a0001-0000-4000-8000-000000000004";

/** Posts summed over every run: the fence-level counts. */
function fence(out) {
  const t = { line: 0, corner: 0, end: 0, gate: 0, total: 0 };
  for (const r of out.runs) for (const k of Object.keys(t)) t[k] += r.posts[k];
  return t;
}
const roles = (out, role) => out.runs.reduce((s, r) => s + (r.entries.find((e) => e.role === role)?.quantity ?? 0), 0);
const byId = (out, id) => out.runs.find((r) => r.run_sync_id === id).posts;
const fmt = (p) => `${p.line} line + ${p.corner} corner + ${p.end} end = ${p.total} posts`;
const same = (a, b) => a.line === b.line && a.corner === b.corner && a.end === b.end && a.total === b.total;
const S = (line, corner, end, total) => ({ line, corner, end, total });

// ---------------------------------------------------------------------------
// The reference model: docs/JOINING_RUNS.md section 2, in a dozen lines.
//
// A joint of degree d replaces d billed END posts with ONE post -- a LINE post
// if two runs meet nearly straight, otherwise a CORNER post. Line posts and
// corners strictly inside a run are untouched. So, from the per-run numbers of
// the UN-joined runs:
//     total  = sum(total)  - sum over joints of (d - 1)
//     end    = sum(end)    - sum over joints of d
//     corner = sum(corner) + number of CORNER joints
//     line   = sum(line)   + number of LINE joints
// ---------------------------------------------------------------------------
function model(perRun, joints) {
  const t = { line: 0, corner: 0, end: 0, total: 0 };
  for (const p of perRun) { t.line += p.line; t.corner += p.corner; t.end += p.end; t.total += p.total; }
  for (const j of joints) {
    t.end -= j.degree; t.total -= j.degree - 1;
    if (j.kind === "CORNER") t.corner += 1; else t.line += 1;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Scenarios. Legs are 30 ft (5 bays), 17 ft (3 bays) and 24 ft (4 bays) so the
// per-leg bay counts add up to the whole-polyline count: that is what lets a
// joined chain be compared with ONE run through the same points.
// ---------------------------------------------------------------------------
const A_PTS = pts([0, 0], [600, 0]);                 // 30 ft east
const B_STRAIGHT = pts([600, 0], [940, 0]);          // 17 ft, carries on east
const C_STRAIGHT = pts([940, 0], [1420, 0]);         // 24 ft, carries on east

const twoStraight = (joined) => [
  run("A", { points_encoded: A_PTS, sort_order: 0, end_joint: joined ? J1 : "" }),
  run("B", { points_encoded: B_STRAIGHT, sort_order: 1, start_joint: joined ? J1 : "" }),
];
const threeStraight = (joined) => [
  run("A", { points_encoded: A_PTS, sort_order: 0, end_joint: joined ? J1 : "" }),
  run("B", { points_encoded: B_STRAIGHT, sort_order: 1, start_joint: joined ? J1 : "", end_joint: joined ? J2 : "" }),
  run("C", { points_encoded: C_STRAIGHT, sort_order: 2, start_joint: joined ? J2 : "" }),
];
const rectangle = (joined) => [
  run("A", { points_encoded: pts([0, 0], [600, 0]), sort_order: 0, end_joint: joined ? J1 : "", start_joint: joined ? J4 : "" }),
  run("B", { points_encoded: pts([600, 0], [600, 340]), sort_order: 1, start_joint: joined ? J1 : "", end_joint: joined ? J2 : "" }),
  run("C", { points_encoded: pts([600, 340], [0, 340]), sort_order: 2, start_joint: joined ? J2 : "", end_joint: joined ? J3 : "" }),
  run("D", { points_encoded: pts([0, 340], [0, 0]), sort_order: 3, start_joint: joined ? J3 : "", end_joint: joined ? J4 : "" }),
];
const tee = (joined) => [
  run("A", { points_encoded: pts([-600, 0], [0, 0]), sort_order: 0, end_joint: joined ? J1 : "" }),
  run("B", { points_encoded: pts([0, 0], [340, 0]), sort_order: 1, start_joint: joined ? J1 : "" }),
  run("C", { points_encoded: pts([0, 0], [0, 480]), sort_order: 2, start_joint: joined ? J1 : "" }),
];

// =============================================================================
console.log("\n1. BASELINE -- what the engine says today, and the spec checked against it");
// =============================================================================
const single = (points, extra = {}) => price([run("S", { points_encoded: points, ...extra })]).runs[0].posts;

const oneStraight47 = single(pts([0, 0], [940, 0]));
const oneStraight71 = single(pts([0, 0], [1420, 0]));
const oneClosedRect = single(pts([0, 0], [600, 0], [600, 340], [0, 340]), { closed_loop: true });
const oneOpenL = single(pts([0, 0], [600, 0], [600, 340]));

baseline("B1", "one open 47 ft run: 7 line + 2 end = 9 posts", same(oneStraight47, S(7, 0, 2, 9)), fmt(oneStraight47));
baseline("B2", "one open 71 ft run: 11 line + 2 end = 13 posts", same(oneStraight71, S(11, 0, 2, 13)), fmt(oneStraight71));
baseline("B3", "one CLOSED 30x17 loop: 12 line + 4 corner = 16 posts, no end posts", same(oneClosedRect, S(12, 4, 0, 16)), fmt(oneClosedRect));
baseline("B4", "one open L (30 ft then 17 ft): 6 line + 1 corner + 2 end = 9 posts", same(oneOpenL, S(6, 1, 2, 9)), fmt(oneOpenL));

const k10 = single(pts([0, 0], [600, 0], [600 + 340 * Math.cos(10 * Math.PI / 180), 340 * Math.sin(10 * Math.PI / 180)]));
const k20 = single(pts([0, 0], [600, 0], [600 + 340 * Math.cos(20 * Math.PI / 180), 340 * Math.sin(20 * Math.PI / 180)]));
baseline("B5", "the corner threshold: a 10 degree kink is a LINE post, a 20 degree bend is a CORNER (15 degrees is the line)",
  k10.corner === 0 && k20.corner === 1, `10deg -> ${k10.corner} corners, 20deg -> ${k20.corner} corners`);
// Either side of the line, close enough that only a threshold of 15 (+-0.5) gets both right. Not AT 15:
// the pricing contract documents a corner at exactly 15.000 degrees and asserts nothing about it.
const bend = (deg) => pts([0, 0], [600, 0], [600 + 340 * Math.cos(deg * Math.PI / 180), 340 * Math.sin(deg * Math.PI / 180)]);
// The second leg alone, for the joined version of the same bend.
const legB = (deg) => pts([600, 0], [600 + 340 * Math.cos(deg * Math.PI / 180), 340 * Math.sin(deg * Math.PI / 180)]);
const k14 = single(bend(14.5)), k15 = single(bend(15.5));
baseline("B5b", "the threshold is 15: a 14.5 degree bend is a LINE post, a 15.5 degree bend is a CORNER",
  k14.corner === 0 && k15.corner === 1, `14.5deg -> ${k14.corner} corners, 15.5deg -> ${k15.corner} corners`);

// The per-run numbers each join subtracts from.
const perRunAlone = (runs) => runs.map((r) => price([{ ...r, start_joint: "", end_joint: "" }]).runs[0].posts);
const alone = perRunAlone(threeStraight(false));
baseline("B6", "each leg alone: 30 ft = 6 posts, 17 ft = 4 posts, 24 ft = 5 posts (the figures a join subtracts from)",
  alone[0].total === 6 && alone[1].total === 4 && alone[2].total === 5, alone.map((p) => p.total).join(", "));

// The spec, checked against the real engine's own answer for ONE run through the
// same points. If these four fail, the arithmetic in the document is wrong and
// every PENDING number below is wrong with it -- so they come first.
{
  const m2 = model(perRunAlone(twoStraight(false)), [{ degree: 2, kind: "LINE" }]);
  baseline("B7", "SPEC CHECK: two straight runs joined = one 47 ft run (model " + fmt(m2) + ")", same(m2, oneStraight47), `model ${fmt(m2)} vs engine one-run ${fmt(oneStraight47)}`);
  const m3 = model(perRunAlone(threeStraight(false)), [{ degree: 2, kind: "LINE" }, { degree: 2, kind: "LINE" }]);
  baseline("B8", "SPEC CHECK: three straight runs joined = one 71 ft run (model " + fmt(m3) + ")", same(m3, oneStraight71), `model ${fmt(m3)} vs engine one-run ${fmt(oneStraight71)}`);
  const m4 = model(perRunAlone(rectangle(false)), [1, 2, 3, 4].map(() => ({ degree: 2, kind: "CORNER" })));
  baseline("B9", "SPEC CHECK: four runs joined end to end AND closed = one closed loop (model " + fmt(m4) + ")", same(m4, oneClosedRect), `model ${fmt(m4)} vs engine closed loop ${fmt(oneClosedRect)}`);
  const mL = model(perRunAlone(twoStraight(false).map((r, i) => i === 1 ? { ...r, points_encoded: pts([600, 0], [600, 340]) } : r)), [{ degree: 2, kind: "CORNER" }]);
  baseline("B10", "SPEC CHECK: two runs meeting at 90 degrees = one L polyline (model " + fmt(mL) + ")", same(mL, oneOpenL), `model ${fmt(mL)} vs engine one-run ${fmt(oneOpenL)}`);
}

// Today nothing collapses a shared post -- not even when the drawing tool snapped
// the ends onto each other. This is the double count the whole feature exists for.
{
  const f = fence(price(twoStraight(false)));
  baseline("B11", "TODAY two runs meeting at one point bill 10 posts (4 end posts, one of them redundant): the double charge to remove",
    f.total === 10 && f.end === 4, fmt(f));
}

// Section 3 of the document: things that are per run and are NOT changed by joining.
{
  const sep = price([
    run("A", { points_encoded: pts([0, 0], [480, 0]), concrete_bags_per_post: 1.5, sort_order: 0 }),
    run("B", { points_encoded: pts([480, 0], [720, 0]), concrete_bags_per_post: 1.5, sort_order: 1 }),
  ]);
  const one = price([run("S", { points_encoded: pts([0, 0], [720, 0]), concrete_bags_per_post: 1.5 })]);
  const bagsSeparate = sep.runs.map((r) => r.entries.find((e) => e.role === "CONCRETE_BAG").quantity);
  const bagsOne = one.runs[0].entries.find((e) => e.role === "CONCRETE_BAG").quantity;
  baseline("B12", "concrete is rounded up to whole bags PER RUN: 24 ft + 12 ft unjoined = 8 + 5 = 13 bags, one 36 ft run = 11 (documented, not a join defect)",
    bagsSeparate[0] === 8 && bagsSeparate[1] === 5 && bagsOne === 11, `separate ${bagsSeparate}, one ${bagsOne}`);
}

// =============================================================================
console.log("\n2. PENDING -- the join arithmetic (fence-level sums; docs/JOINING_RUNS.md section 2)");
// =============================================================================
{
  const out = price(twoStraight(true)); const f = fence(out);
  pending("P1", "two runs joined at one end, straight: 9 posts, not 10 (7 line + 2 end; the join is a LINE post)",
    same(f, oneStraight47), fmt(oneStraight47), fmt(f));
}
{
  const out = price(threeStraight(true)); const f = fence(out);
  pending("P2", "three runs joined in a line: 13 posts, not 15 (11 line + 2 end)",
    same(f, oneStraight71), fmt(oneStraight71), fmt(f));
}
{
  const out = price(rectangle(true)); const f = fence(out);
  pending("P3", "four runs joined end to end AND back to the start: 16 posts, not 20 (12 line + 4 corner, NO end posts)",
    same(f, oneClosedRect), fmt(oneClosedRect), fmt(f));
}
{
  const out = price(tee(true)); const f = fence(out);
  pending("P4", "a T where three runs meet at one point: 13 posts, not 15 (9 line + 1 corner + 3 end). The T post is ONE corner post",
    same(f, S(9, 1, 3, 13)), "9 line + 1 corner + 3 end = 13 posts", fmt(f));
}
{
  // A joint is classified exactly as the same two legs would be if they were one polyline.
  const L = (b) => [run("A", { points_encoded: A_PTS, sort_order: 0, end_joint: J1 }), run("B", { points_encoded: b, sort_order: 1, start_joint: J1 })];
  const f90 = fence(price(L(pts([600, 0], [600, 340]))));
  pending("P5a", "two runs meeting at 90 degrees: the join is a CORNER post (6 line + 1 corner + 2 end = 9), same as one L polyline",
    same(f90, oneOpenL), fmt(oneOpenL), fmt(f90));
  const f10 = fence(price(L(pts([600, 0], [600 + 340 * Math.cos(10 * Math.PI / 180), 340 * Math.sin(10 * Math.PI / 180)]))));
  pending("P5b", "a join with a 10 degree kink is a LINE post (below the 15 degree corner threshold), same as the polyline",
    same(f10, k10), fmt(k10), fmt(f10));
  const f20 = fence(price(L(pts([600, 0], [600 + 340 * Math.cos(20 * Math.PI / 180), 340 * Math.sin(20 * Math.PI / 180)]))));
  pending("P5c", "a join with a 20 degree bend is a CORNER post, same as the polyline",
    same(f20, k20), fmt(k20), fmt(f20));
  // The threshold itself is the polyline's: 15, not 10, not 20, not 45.
  const f14 = fence(price(L(legB(14.5))));
  pending("P5d", "a join with a 14.5 degree bend is a LINE post: the joint uses the same 15 degree threshold as an interior vertex",
    same(f14, k14), fmt(k14), fmt(f14));
  const f15 = fence(price(L(legB(15.5))));
  pending("P5e", "a join with a 15.5 degree bend is a CORNER post, the same 15 degree threshold",
    same(f15, k15), fmt(k15), fmt(f15));
}
{
  // Which END of each run touches the joint must not matter. These four are the same L.
  const cases = [
    ["A.end - B.start", [run("A", { points_encoded: pts([0, 0], [600, 0]), end_joint: J1 }), run("B", { points_encoded: pts([600, 0], [600, 340]), sort_order: 1, start_joint: J1 })]],
    ["A.end - B.end", [run("A", { points_encoded: pts([0, 0], [600, 0]), end_joint: J1 }), run("B", { points_encoded: pts([600, 340], [600, 0]), sort_order: 1, end_joint: J1 })]],
    ["A.start - B.start", [run("A", { points_encoded: pts([600, 0], [0, 0]), start_joint: J1 }), run("B", { points_encoded: pts([600, 0], [600, 340]), sort_order: 1, start_joint: J1 })]],
    ["A.start - B.end", [run("A", { points_encoded: pts([600, 0], [0, 0]), start_joint: J1 }), run("B", { points_encoded: pts([600, 340], [600, 0]), sort_order: 1, end_joint: J1 })]],
  ];
  let n = 0;
  for (const [name, runs] of cases) {
    const f = fence(price(runs));
    pending("P6" + "abcd"[n++], `orientation (${name}), 90 degree corner: 6 line + 1 corner + 2 end = 9`, same(f, oneOpenL), fmt(oneOpenL), fmt(f));
  }
  // The one a naive "heading of the second run's first segment" gets wrong: B is drawn
  // right-to-left, so its END is at the joint, yet the fence carries straight on.
  const rev = fence(price([
    run("A", { points_encoded: pts([0, 0], [600, 0]), end_joint: J1 }),
    run("B", { points_encoded: pts([940, 0], [600, 0]), sort_order: 1, end_joint: J1 }),
  ]));
  pending("P6e", "orientation (A.end - B.end), STRAIGHT on: B drawn toward the joint is still a LINE post (7 line + 2 end = 9), not a U-turn corner",
    same(rev, oneStraight47), fmt(oneStraight47), fmt(rev));
}
{
  // A gate sits inside one run. It does not change what a join saves.
  const runs = twoStraight(true); runs[0].gates_encoded = "300:0:4:LINE:IN";
  const unjoined = twoStraight(false); unjoined[0].gates_encoded = "300:0:4:LINE:IN";
  const base = fence(price(unjoined)); const f = fence(price(runs));
  pending("P7", "a gate in one of the joined runs: the join still saves exactly one post (gate run 7 + 4 = 11 unjoined -> 10), gate posts untouched",
    base.total === 11 && f.total === 10 && f.gate === 2, "11 -> 10 posts, 2 gate posts", `${base.total} -> ${f.total} posts, ${f.gate} gate posts`);
}
{
  // Caps and concrete follow the post count (Q3). 1 bag per post, no waste.
  const out = price(twoStraight(true));
  pending("P8", "post caps and concrete follow the joined count: 9 caps and 9 bags, not 10 and 10 (a shared post is capped and set once)",
    roles(out, "POST_CAP") === 9 && roles(out, "CONCRETE_BAG") === 9, "9 caps, 9 bags", `${roles(out, "POST_CAP")} caps, ${roles(out, "CONCRETE_BAG")} bags`);
}
{
  // Fractional concrete: the shared post's bag is billed ONCE. 24 ft + 12 ft at 1.5 bags/post.
  const mk = (joined) => [
    run("A", { points_encoded: pts([0, 0], [480, 0]), concrete_bags_per_post: 1.5, sort_order: 0, end_joint: joined ? J1 : "" }),
    run("B", { points_encoded: pts([480, 0], [720, 0]), concrete_bags_per_post: 1.5, sort_order: 1, start_joint: joined ? J1 : "" }),
  ];
  const out = price(mk(true));
  const bags = out.runs.map((r) => r.entries.find((e) => e.role === "CONCRETE_BAG").quantity);
  pending("P9", "fractional concrete across a join: 7 posts at 1.5 bags = 8 + 3 = 11 bags (unjoined was 8 + 5 = 13); the shared post's bag is counted once",
    bags[0] + bags[1] === 11, "A 8 bags + B 3 bags = 11", `A ${bags[0]} + B ${bags[1]} = ${bags[0] + bags[1]}`);
}

{
  // The 6-to-4 fence as JOINING ALONE expresses it: 30 ft of 6 ft fence, ONE ordinary 6 ft bay, 24 ft of
  // 4 ft fence, three runs end to end. Whether that middle bay is a distinct transition product is a separate
  // question and a contested one (docs/JOINING_RUNS.md section 4 and 6; a32-join-transition.test.mjs). This
  // case does not need the answer: it holds either way, and it is the whole of what "the owner's 6-to-4 fence
  // is priced as the 6 ft fence" asks of the engine.
  const mk = (joined) => [
    run("A", { points_encoded: pts([0, 0], [600, 0]), sort_order: 0, panel_height_ft: 6, end_joint: joined ? J1 : "" }),
    run("M", { points_encoded: pts([600, 0], [720, 0]), sort_order: 1, panel_height_ft: 6, start_joint: joined ? J1 : "", end_joint: joined ? J2 : "" }),
    run("C", { points_encoded: pts([720, 0], [1200, 0]), sort_order: 2, panel_height_ft: 4, start_joint: joined ? J2 : "" }),
  ];
  const before = fence(price(mk(false))), out = price(mk(true)), f = fence(out);
  pending("P10", "the 6-to-4 fence as three joined runs (30 ft of 6 ft, one ordinary 6 ft bay, 24 ft of 4 ft): 11 posts, not 13, and 10 ordinary panels",
    before.total === 13 && f.total === 11 && roles(out, "PANEL") === 10 && roles(out, "TRANSITION_PANEL") === 0,
    "13 -> 11 posts, 10 PANEL, 0 TRANSITION_PANEL",
    `${before.total} -> ${f.total} posts, ${roles(out, "PANEL")} PANEL, ${roles(out, "TRANSITION_PANEL")} TRANSITION_PANEL`);
}

// =============================================================================
console.log("\n3. PENDING / POLICY -- which run is billed the shared post (docs/JOINING_RUNS.md section 2.4)");
// =============================================================================
// Fence-level counts above do not care. Per-run lines do: each run has its own
// line items, so the post has to be billed to exactly one of them. These are
// decisions the owner can overturn, which is why they are separate.
{
  const out = price(twoStraight(true));
  pending("D1", "POLICY: equal heights -> the run with the lower sort_order is billed the shared post (A keeps 6 posts, B drops 4 -> 3)",
    byId(out, "A").total === 6 && byId(out, "B").total === 3, "A 6, B 3", `A ${byId(out, "A").total}, B ${byId(out, "B").total}`);
}
{
  // The taller run owns the post, even when it sorts later. B is 4 ft and first, A is 6 ft and second.
  const runs = [
    run("B", { points_encoded: B_STRAIGHT, sort_order: 0, panel_height_ft: 4, start_joint: J1 }),
    run("A", { points_encoded: A_PTS, sort_order: 1, panel_height_ft: 6, end_joint: J1 }),
  ];
  const out = price(runs);
  pending("D2", "POLICY: the TALLER run is billed the shared post, even with the higher sort_order (6 ft A keeps 6 posts, 4 ft B drops 4 -> 3)",
    byId(out, "A").total === 6 && byId(out, "B").total === 3, "A 6, B 3", `A ${byId(out, "A").total}, B ${byId(out, "B").total}`);
}
{
  // Typed runs carry no drawing, so there is no angle: the join is a CORNER post (section 2.3).
  const out = price([
    run("A", { manual_linear_feet: 30, sort_order: 0, end_joint: J1 }),
    run("B", { manual_linear_feet: 17, sort_order: 1, start_joint: J1 }),
  ]);
  const f = fence(out);
  pending("D3", "POLICY: a join between TYPED runs has no angle to measure, so it is billed as a CORNER post (6 line + 1 corner + 2 end = 9)",
    same(f, S(6, 1, 2, 9)), "6 line + 1 corner + 2 end = 9 posts", fmt(f));
}

// =============================================================================
console.log("\n4. GUARDS -- what a join-aware engine must not do (each has a control)");
// =============================================================================
const pairJoins = fence(price(twoStraight(true))).total === 9;   // the control most guards share

{
  // G1. Coordinates alone must never join runs. Two runs that end on the very same
  // pixel but carry no joint ids still bill every end, because closing/joining is an
  // explicit choice the owner made (and may NOT have made), not something the engine
  // may deduce -- section 1.2.
  const f = fence(price(twoStraight(false)));
  guard("G1", "NO INFERENCE: two runs ending on exactly the same pixel, with no joint recorded, are NOT merged (10 posts, 4 ends)",
    pairJoins, f.total === 10 && f.end === 4, fmt(f));
}
{
  // G2. A joint id on only one end, with nobody on the other side, is a plain free end.
  const out = price([run("A", { points_encoded: A_PTS, end_joint: J1 }), run("B", { points_encoded: B_STRAIGHT, sort_order: 1 })]);
  guard("G2", "a joint recorded on ONE end only (the partner run deleted, or not synced yet) leaves that end free: A still bills its end post",
    pairJoins, byId(out, "A").total === 6 && byId(out, "A").end === 2, `A ${fmt(byId(out, "A"))}`);
}
{
  // G3. A run joined to itself is not a second way to say "closed loop".
  const out = price([run("A", { points_encoded: pts([0, 0], [600, 0], [600, 340], [0, 340]), start_joint: J1, end_joint: J1 })]);
  const open = byId(price([run("A", { points_encoded: pts([0, 0], [600, 0], [600, 340], [0, 340]) })]), "A");
  guard("G3", "a run whose two ends carry the SAME joint id stays an OPEN run (closed_loop is the only way to close one run on itself)",
    pairJoins, same(byId(out, "A"), open), `joined-to-self ${fmt(byId(out, "A"))} vs open ${fmt(open)}`);
}
{
  // G4. The old fence is not a neighbour. A teardown run bills no materials, so a post
  // handed to it is a post nobody pays for. Its sort_order is LOWER on purpose: the
  // owner rule would pick it if teardown runs were not excluded.
  const mk = (teardown) => [
    run("T", { points_encoded: B_STRAIGHT, sort_order: 0, is_teardown: teardown, start_joint: J1 }),
    run("A", { points_encoded: A_PTS, sort_order: 1, end_joint: J1 }),
  ];
  const withTeardown = price(mk(true));
  const control = fence(price(mk(false))).total === 9;
  guard("G4", "a joint to a TEARDOWN run is ignored: the new run A keeps both its end posts (a teardown run bills nothing, so it can never be handed the post)",
    control, byId(withTeardown, "A").total === 6 && byId(withTeardown, "A").end === 2,
    `A ${fmt(byId(withTeardown, "A"))}; control (same wiring, T not a teardown) fence total was ${fence(price(mk(false))).total}`);
}
{
  // G5. A run with no length bills no posts, so it cannot be the owner of one either.
  // Covers an empty run, and a photo-job run whose drawing the loader blanked.
  const withEmpty = price([run("E", { sort_order: 0, start_joint: J1 }), run("A", { points_encoded: A_PTS, sort_order: 1, end_joint: J1 })]);
  const control = fence(price([run("B", { points_encoded: B_STRAIGHT, sort_order: 0, start_joint: J1 }), run("A", { points_encoded: A_PTS, sort_order: 1, end_joint: J1 })])).total === 9;
  guard("G5", "a joint to a run with NO length (nothing drawn, or its drawing blanked) is ignored: A keeps both its end posts",
    control, byId(withEmpty, "A").total === 6 && byId(withEmpty, "A").end === 2, `A ${fmt(byId(withEmpty, "A"))}`);
}
{
  // G6. A closed run has no ends to join.
  const withClosed = price([
    run("R", { points_encoded: pts([0, 0], [600, 0], [600, 340], [0, 340]), closed_loop: true, sort_order: 0, start_joint: J1 }),
    run("B", { points_encoded: pts([600, 0], [940, 0]), sort_order: 1, start_joint: J1 }),
  ]);
  guard("G6", "joint ids on a CLOSED run are ignored (it has no free end): the open run B still bills both its ends",
    pairJoins, byId(withClosed, "B").total === 4 && byId(withClosed, "B").end === 2, `B ${fmt(byId(withClosed, "B"))}`);
}
{
  // G7. A shared post has no length: footage, and so labour, must not move.
  const out = price(threeStraight(true));
  const control = fence(out).total === 13;
  guard("G7", "joining changes no footage: three joined runs still bill 71 ft of fence and 71 ft of labour",
    control, out.linear_feet === 71 && out.billable_linear_feet === 71, `linear_feet ${out.linear_feet}, billable ${out.billable_linear_feet}`);
}
{
  // G8. The minimum labour charge is per JOB (totals.ts), so three joined runs must not
  // triple it. Raw labour is 71 ft x $1 = $71; the floor is $500; it must read $500, not $1,500.
  const out = price(threeStraight(true), { labor_rate_per_ft: 1, minimum_labor_charge: 500 });
  const control = fence(out).total === 13;
  guard("G8", "the minimum labour charge is applied ONCE for the job, not once per joined run ($500, not $1,500)",
    control, out.totals.labor_cost === 500, `labor_cost ${out.totals.labor_cost}`);
}

// ---------------------------------------------------------------------------
const real = tally.baselineFail + tally.guardFail;
console.log("\n----------------------------------------------------------------------");
console.log(`BASELINE  ${tally.baselineOk} ok, ${tally.baselineFail} FAIL`);
console.log(`PENDING   ${tally.pendingRed} red (expected until joining lands), ${tally.pendingLanded} landed`);
console.log(`GUARDS    ${tally.guardOk} ok, ${tally.guardVacuous} vacuous (control not live), ${tally.guardFail} FAIL`);
if (real > 0) console.log(`\n${real} REGRESSION(S): a number that is true today stopped being true.`);
else if (tally.pendingRed > 0) console.log(`\nRed on purpose: ${tally.pendingRed} case(s) wait for joining. Spec: docs/JOINING_RUNS.md`);
else if (tally.guardVacuous > 0) console.log(`\n${tally.guardVacuous} guard(s) are still vacuous.`);
else console.log("\nJoining has landed and every guard has a live control.");
process.exit(real > 0 || tally.pendingRed > 0 || tally.guardVacuous > 0 ? 1 : 0);
