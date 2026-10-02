// A JOIN CHANGES THE PRICE -- the wiring, end to end, through the real engine.
//
// Run:   node tests/a61-corner-post-pricing.test.mjs     (exit code 0 = every check passed)
//
// =============================================================================
// WHAT THIS FILE IS FOR
// =============================================================================
// tests/a33-join-arithmetic-posts.test.mjs proves the ARITHMETIC. It says, for
// any set of joints, how each run's post counts should move -- and it proved
// that while NOTHING CALLED IT: two sides the owner had joined still billed two
// end posts, two caps and two bags of concrete, and he was charged for a post
// that is not in the ground.
//
// This file is about the WIRING, which is the half that was missing:
//
//   1. the server port (supabase/functions/_shared/pricing/joins.ts) agrees
//      with a33's transcription -- which a33 in turn holds against a frozen
//      snapshot of the COMPILED Kotlin -- line for line, over every scenario
//      a33 registers. So neither port can drift alone.
//   2. the joint columns REACH the engine: a start_joint / end_joint on the
//      contract row comes out the other end as a post that is not billed.
//   3. a job with NO joint prices byte-identically, which is what protects
//      every quote he has already sent. Asserted against the real priceJob,
//      with a planted join as the positive control -- an additivity check that
//      cannot fail is worth nothing.
//   4. bad join data falls DEARER. Not a uuid, a joint only one run reaches,
//      both ends of one run, a teardown or closed or typed partner: every one
//      of them prices exactly as an unjoined job does.
//   5. the cap and the concrete come off WITH the post, and the two end posts
//      become one CORNER post -- a different catalog row at a different price.
//      Read off the engine's own entries and off real money, not asserted
//      about the counts alone.
//   6. a T and a chain, with numbers; and a chain closed back on itself is not
//      the same thing as a run whose closedLoop flag is set.
//
// WHAT IT DOES NOT DO. It cannot run Kotlin (Node has no Kotlin), so the phone
// engine is checked the only way it can be from here: by reading the source and
// asserting the plumbing is present and that the three copies of the
// owner-height rule agree. Every NUMBER below comes from the real TypeScript
// engine, which the parity fixtures hold to the Kotlin.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { priceJob, PRICING_ENGINE_VERSION } from "../supabase/functions/_shared/pricing/index.ts";
import { analyze, decodePoints } from "../supabase/functions/_shared/pricing/geometry.ts";
import { f32 } from "../supabase/functions/_shared/pricing/f32.ts";
import {
  adjustJoins, adjustmentForRun, applyJoinAdjustment, changesNothing, joinHeightFt,
  NO_JOIN_ADJUSTMENT, postsSaved, readJointId,
} from "../supabase/functions/_shared/pricing/joins.ts";
import { computePostCounts } from "../supabase/functions/_shared/pricing/takeoff.ts";
import { scenarios, serializeAll } from "./a33-join-arithmetic-posts.test.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const readRepo = (p) => readFileSync(join(REPO, p), "utf8");

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failedIds = [];
function ok(id, label, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok    ${id} ${label}`); }
  else { failed++; failedIds.push(id); console.log(`  FAIL  ${id} ${label}${detail ? `\n          ${detail}` : ""}`); }
}
function eq(id, label, got, want, why = "") {
  ok(id, label, JSON.stringify(got) === JSON.stringify(want),
    `RIGHT VALUE is ${JSON.stringify(want)}; got ${JSON.stringify(got)}.${why ? " " + why : ""}`);
}
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
// A job, built the way the contract carries one. Joint ids are real uuids,
// because runFromRow refuses anything else -- which is itself checked below.
// ---------------------------------------------------------------------------
const PPF = 20; // the grid's own scale: 6 ft = 120 px
const pts = (...p) => p.map(([x, y]) => `${x}:${y}`).join(",");
const U = (n) => `a61${String(n).padStart(5, "0")}-0000-4000-8000-000000000001`;

const JOB = {
  calibration_pixels_per_foot: null,
  tax_rate_percent: 0, markup_percent: 0, discount_percent: 0,
  labor_rate_per_ft: 0, labor_flat_fee: 0, minimum_job_charge: 0, minimum_labor_charge: 0,
  waste_percent: 0, gate_rate_per_ft: 0, trash_haul_fee: 0,
  teardown_enabled: false, teardown_flat_fee: 0, teardown_rate_per_ft: 0, teardown_feet: 0,
  preferred_manufacturer_sync_id: null,
};

function run(id, points, o = {}) {
  const r = {
    sync_id: id, label: id, fence_type: "VINYL", color_or_finish: "",
    points_encoded: points, gates_encoded: "", closed_loop: false,
    manual_linear_feet: null, manual_corner_count: 0,
    panel_width_ft: 6, panel_height_ft: 6, post_spacing_ft: 6, concrete_bags_per_post: 1,
    aluminum_style: "RACKABLE", wood_style: "PRIVACY", wood_rail_count: 3,
    picket_width_in: 5.5, picket_gap_in: 0, fabric_height_ft: 4,
    include_top_rail: true, include_tension_wire: false, include_barbed_wire_arms: false,
    include_privacy_slats: false, split_rail_count: 2, suppressed_roles: "",
    is_teardown: false, sort_order: 0,
    ...o,
  };
  return r;
}
/** The same row with both joint keys REMOVED, which is what every recorded fixture looks like. */
function withoutJointKeys(row) {
  const copy = { ...row };
  delete copy.start_joint;
  delete copy.end_joint;
  return copy;
}
function price(rows, catalog = [], jobOverrides = {}) {
  return priceJob({
    engine_version: PRICING_ENGINE_VERSION, pixels_per_foot: PPF,
    job: { ...JOB, ...jobOverrides }, runs: rows, catalog,
    manufacturers: [], change_orders: [], existing_items: [],
  });
}
const postsOf = (out, i) => out.runs[i].posts;
const sumPosts = (out) => out.runs.reduce((t, r) => ({
  line: t.line + r.posts.line, corner: t.corner + r.posts.corner, end: t.end + r.posts.end,
  gate: t.gate + r.posts.gate, terminal: t.terminal + r.posts.terminal, total: t.total + r.posts.total,
}), { line: 0, corner: 0, end: 0, gate: 0, terminal: 0, total: 0 });
/** Every entry quantity for one role, over the whole job. */
function roleQty(out, role) {
  let n = 0;
  for (const r of out.runs) for (const e of r.entries) if (e.role === role) n += e.quantity;
  return n;
}

// Three legs that meet: 30 ft east, then 17 ft (straight on, or turned 90).
const LEG_A = pts([0, 0], [600, 0]);
const LEG_B_STRAIGHT = pts([600, 0], [940, 0]);
const LEG_B_UP = pts([600, 0], [600, 340]);
const LEG_B_DOWN = pts([600, 0], [600, -340]);
const LEG_C = pts([940, 0], [1420, 0]);

// =============================================================================
section("1. THE PORT AGREES WITH THE COMPILED KOTLIN (via a33's transcription)");
// =============================================================================
// a33's serializeAll() is its transcription's answer for every scenario, in the
// same format as its KOTLIN_GOLDEN -- which a33 itself asserts the
// transcription reproduces line for line. Reproducing serializeAll() from
// joins.ts therefore ties joins.ts to the compiled Kotlin transitively.
{
  const geometryOf = (s) => {
    if (s.manual !== null && s.manual > 0) {
      return { totalLinearFeet: s.manual, segments: [], vertices: [], cornerCount: 0, endCount: s.closed ? 0 : 2, lineVertexCount: 0 };
    }
    return analyze(decodePoints(s.points), PPF, s.closed);
  };
  const toJoinable = (s) => ({
    id: s.id, geometry: geometryOf(s), heightFt: f32(s.height), sortOrder: s.sort,
    isTeardown: s.teardown, startJointId: s.start, endJointId: s.end,
  });

  const mine = [];
  for (const s of scenarios) {
    const adj = adjustJoins(s.specs.map(toJoinable));
    for (const id of [...adj.perRun.keys()].sort()) {
      const a = adj.perRun.get(id);
      mine.push(`${s.name}|ADJ|${id}|${a.linePostsDelta}|${a.cornerPostsDelta}|${a.endPostsDelta}`);
    }
    for (const p of adj.posts) mine.push(`${s.name}|POST|${p.jointId}|${p.kind}|${p.ownerRunId}|${p.memberRunIds.join(",")}`);
    for (const g of adj.ignored) mine.push(`${s.name}|IGN|${g.jointId}|${g.reason}`);
    mine.push(`${s.name}|SAVED|${postsSaved(adj)}`);
  }
  const golden = serializeAll();

  let firstDiff = -1;
  for (let i = 0; i < Math.max(golden.length, mine.length); i++) if (golden[i] !== mine[i]) { firstDiff = i; break; }
  ok("1a", `joins.ts reproduces a33's Kotlin-checked arithmetic line for line over all ${scenarios.length} scenarios (${golden.length} lines)`,
    firstDiff < 0,
    `first difference at line ${firstDiff + 1}: a33 (and the compiled Kotlin) say "${golden[firstDiff]}", joins.ts says "${mine[firstDiff]}". The Kotlin is the shipped one.`);

  // CANARY: the comparison above must be able to fail, and must be looking at
  // something. A wrong-by-one port has to show up as a difference.
  const kinds = new Set(golden.filter((l) => l.includes("|POST|")).map((l) => l.split("|")[3]));
  ok("1b-canary", "the comparison is not vacuous: LINE and CORNER posts, both ignore reasons, and over 100 adjustment lines",
    kinds.has("LINE") && kinds.has("CORNER")
    && golden.some((l) => l.includes("FEWER_THAN_TWO_LIVE_RUNS")) && golden.some((l) => l.includes("SAME_RUN_TWICE"))
    && golden.filter((l) => l.includes("|ADJ|")).length > 100,
    `kinds ${[...kinds]}, adj lines ${golden.filter((l) => l.includes("|ADJ|")).length}`);
  ok("1c-canary", "and it CAN fail: a deliberately corrupted line does not match",
    JSON.stringify(golden) !== JSON.stringify(["corrupted", ...mine.slice(1)]));

  // No count may go negative, over every scenario a33 knows about, run through
  // the REAL computePostCounts rather than a transcription of it.
  let worst = null;
  for (const s of scenarios) {
    const adj = adjustJoins(s.specs.map(toJoinable));
    for (const spec of s.specs) {
      const g = geometryOf(spec);
      const base = computePostCounts(g, [], spec.spacing, g.totalLinearFeet);
      const after = applyJoinAdjustment(base, adjustmentForRun(adj, spec.id));
      if (after.linePosts < 0 || after.cornerPosts < 0 || after.endPosts < 0 || after.totalPosts < 0) {
        worst = `${s.name}/${spec.id}: ${JSON.stringify(after)}`;
      }
    }
  }
  ok("1d", `no post count goes negative on any run of any of the ${scenarios.length} scenarios, through the real computePostCounts`,
    worst === null, worst ?? "");
}

// =============================================================================
section("2. ADDITIVITY: a job with no joint prices exactly as it did");
// =============================================================================
{
  const plainRows = [run(U(1), LEG_A, { sort_order: 0 }), run(U(2), LEG_B_UP, { sort_order: 1 })];
  const noKeys = plainRows.map(withoutJointKeys);
  const blank = plainRows.map((r) => ({ ...r, start_joint: "", end_joint: "" }));
  const base = price(noKeys);

  ok("2a", "a job whose rows do not carry the joint keys at all (every recorded fixture) prices byte-identically to one carrying ''",
    JSON.stringify(base) === JSON.stringify(price(blank)));

  // POSITIVE CONTROL. If a real join did not move the answer, 2a would be
  // proving that the wiring is absent rather than that it is additive.
  const joined = [
    { ...plainRows[0], end_joint: U(90) },
    { ...plainRows[1], start_joint: U(90) },
  ];
  const joinedOut = price(joined);
  ok("2b-canary", "POSITIVE CONTROL: the SAME two runs with one real joint price DIFFERENTLY -- so 2a is additivity, not a dead wire",
    JSON.stringify(base) !== JSON.stringify(joinedOut));

  // 30 ft is 4 line + 2 end = 6 posts; 17 ft is 2 line + 2 end = 4. Two sides
  // that meet at a point bill FOUR end posts, for two holes at that point.
  eq("2c", "unjoined, those two runs bill 4 end posts and 10 posts in all",
    { end: sumPosts(base).end, total: sumPosts(base).total }, { end: 4, total: 10 });
  eq("2d", "joined at a square corner they bill 2 end posts, 1 corner post and 9 posts in all -- one post fewer",
    { end: sumPosts(joinedOut).end, corner: sumPosts(joinedOut).corner, total: sumPosts(joinedOut).total },
    { end: 2, corner: 1, total: 9 });

  // Every OTHER figure on the job has to be untouched: a join moves posts, not
  // footage and not panels.
  eq("2e", "the footage and the panel count do not move when two runs are joined",
    { feet: joinedOut.linear_feet, panels: roleQty(joinedOut, "PANEL") },
    { feet: base.linear_feet, panels: roleQty(base, "PANEL") });

  ok("2f", "adjustJoins returns the shared NO_JOIN_ADJUSTMENT object for a job with no joint, before it reads any geometry",
    adjustJoins([{ id: "x", geometry: null, heightFt: 6, sortOrder: 0, isTeardown: false, startJointId: "", endJointId: "" }]) === NO_JOIN_ADJUSTMENT,
    "a null geometry would throw if the zero-joints early return were removed, which is the point of passing one");
  ok("2g", "changesNothing() is true for it", changesNothing(NO_JOIN_ADJUSTMENT));
}

// =============================================================================
section("3. WHAT COMES OFF AT A JOINT: the post, its cap, its concrete, and END -> CORNER");
// =============================================================================
{
  const a = run(U(1), LEG_A, { sort_order: 0 });
  const b = run(U(2), LEG_B_UP, { sort_order: 1 });
  const apart = price([a, b]);
  const together = price([{ ...a, end_joint: U(91) }, { ...b, start_joint: U(91) }]);

  eq("3a", "ONE post comes off the job", sumPosts(together).total, sumPosts(apart).total - 1);
  eq("3b", "its CAP comes off with it (POST_CAP is priced off totalPosts)",
    roleQty(together, "POST_CAP"), roleQty(apart, "POST_CAP") - 1);
  eq("3c", "its CONCRETE comes off with it (one bag per post at 1 bag/post)",
    roleQty(together, "CONCRETE_BAG"), roleQty(apart, "CONCRETE_BAG") - 1);
  eq("3d", "TWO END posts become ONE CORNER post: the END_POST entry falls by 2 and CORNER_POST rises by 1",
    { end: roleQty(together, "END_POST"), corner: roleQty(together, "CORNER_POST") },
    { end: roleQty(apart, "END_POST") - 2, corner: roleQty(apart, "CORNER_POST") + 1 });
  eq("3e", "and the LINE posts do not quietly absorb it (the whole reason the adjustment is applied AFTER computePostCounts)",
    roleQty(together, "LINE_POST"), roleQty(apart, "LINE_POST"));

  // Concrete scales with the run's own bags-per-post, so the saving is not a
  // flat one bag.
  const apart2 = price([{ ...a, concrete_bags_per_post: 2 }, { ...b, concrete_bags_per_post: 2 }]);
  const together2 = price([
    { ...a, concrete_bags_per_post: 2, end_joint: U(92) },
    { ...b, concrete_bags_per_post: 2, start_joint: U(92) },
  ]);
  eq("3f", "at 2 bags a post, joining saves 2 bags, not 1 -- the concrete follows the post count, not a flat rule",
    roleQty(together2, "CONCRETE_BAG"), roleQty(apart2, "CONCRETE_BAG") - 2);

  // A GATE post is not touched by a join, and a WALL gate's post takes no
  // concrete from the run at all (nonGatePosts = total - gate), so the
  // concrete arithmetic is not bags-per-post everywhere.
  const gatedA = { ...a, gates_encoded: "300:0:4:LINE" };
  const gatedApart = price([gatedA, b]);
  const gatedTogether = price([{ ...gatedA, end_joint: U(93) }, { ...b, start_joint: U(93) }]);
  eq("3g", "a gate on a joined run keeps its 2 gate posts; the join takes a post from the fence line, never from the gate",
    { gate: sumPosts(gatedTogether).gate, total: sumPosts(gatedTogether).total },
    { gate: sumPosts(gatedApart).gate, total: sumPosts(gatedApart).total - 1 });

  const wallApart = price([{ ...a, gates_encoded: "300:0:4:WALL" }, b]);
  const wallTogether = price([{ ...a, gates_encoded: "300:0:4:WALL", end_joint: U(94) }, { ...b, start_joint: U(94) }]);
  eq("3h", "the same holds with a WALL gate, whose posts take no concrete from the run -- one post, one cap, one bag",
    {
      total: sumPosts(wallTogether).total, caps: roleQty(wallTogether, "POST_CAP"), bags: roleQty(wallTogether, "CONCRETE_BAG"),
    },
    {
      total: sumPosts(wallApart).total - 1, caps: roleQty(wallApart, "POST_CAP") - 1, bags: roleQty(wallApart, "CONCRETE_BAG") - 1,
    });

  // Chain link prices tension bands, brace bands and rail ends off
  // terminalPosts, which is corner + end + gate: two terminals becoming one
  // has to take that hardware with it too.
  const clA = run(U(1), LEG_A, { sort_order: 0, fence_type: "CHAIN_LINK", fabric_height_ft: 4 });
  const clB = run(U(2), LEG_B_UP, { sort_order: 1, fence_type: "CHAIN_LINK", fabric_height_ft: 4 });
  const clApart = price([clA, clB]);
  const clTogether = price([{ ...clA, end_joint: U(95) }, { ...clB, start_joint: U(95) }]);
  eq("3i", "chain link: one fewer terminal post, so one fewer brace band and one fewer rail end",
    {
      terminal: sumPosts(clTogether).terminal,
      brace: roleQty(clTogether, "BRACE_BAND"),
      railEnd: roleQty(clTogether, "RAIL_END"),
    },
    {
      terminal: sumPosts(clApart).terminal - 1,
      brace: roleQty(clApart, "BRACE_BAND") - 1,
      railEnd: roleQty(clApart, "RAIL_END") - 1,
    });
  eq("3j", "and the tension bands fall by one terminal post's worth (ceil(fabricHeightFt) per terminal), not by one band",
    roleQty(clTogether, "TENSION_BAND"), roleQty(clApart, "TENSION_BAND") - 4);
}

// =============================================================================
section("4. VALIDATE ON READ: every bad shape falls back to today's DEARER price");
// =============================================================================
{
  const a = run(U(1), LEG_A, { sort_order: 0 });
  const b = run(U(2), LEG_B_UP, { sort_order: 1 });
  /**
   * The baseline is THESE rows with the joint columns blanked, never one
   * fixed pair: 4h-4j deliberately change the partner run (to a teardown, to
   * a closed loop, to nothing drawn), and those jobs do not cost the same as
   * the plain one for reasons that have nothing to do with the joint.
   */
  const sameAsUnjoined = (id, label, rows) => {
    const blanked = rows.map((r) => ({ ...r, start_joint: "", end_joint: "" }));
    ok(id, label, JSON.stringify(price(rows)) === JSON.stringify(price(blanked)),
      "this priced DIFFERENTLY from the SAME rows with the joint columns blanked. Invalid join data must fail toward the higher post count, never a cheaper one.");
  };

  sameAsUnjoined("4a", "a joint id that is not a uuid ('J1') reads as not joined",
    [{ ...a, end_joint: "J1" }, { ...b, start_joint: "J1" }]);
  sameAsUnjoined("4b", "a short non-canonical uuid ('1-1-1-1-1', which UUID.fromString accepts) reads as not joined",
    [{ ...a, end_joint: "1-1-1-1-1" }, { ...b, start_joint: "1-1-1-1-1" }]);
  sameAsUnjoined("4c", "whitespace reads as not joined", [{ ...a, end_joint: "   " }, { ...b, start_joint: "   " }]);
  sameAsUnjoined("4d", "null reads as not joined", [{ ...a, end_joint: null }, { ...b, start_joint: null }]);
  sameAsUnjoined("4e", "a uuid on ONE end only -- the partner run deleted, or not synced down yet -- reads as not joined",
    [{ ...a, end_joint: U(96) }, b]);
  sameAsUnjoined("4f", "a joint naming a run that is not on this job reads as not joined",
    [{ ...a, end_joint: U(97) }, { ...b, start_joint: U(98) }]);
  sameAsUnjoined("4g", "BOTH ends of ONE run at one joint is not a way to close it (that is closedLoop, which has different arithmetic)",
    [{ ...a, start_joint: U(99), end_joint: U(99) }, b]);
  sameAsUnjoined("4h", "a TEARDOWN partner gives up nothing: the old fence bills no posts, so it cannot save one",
    [{ ...a, end_joint: U(100) }, { ...b, start_joint: U(100), is_teardown: true }]);
  sameAsUnjoined("4i", "a CLOSED-LOOP partner has no free end to give",
    [{ ...a, end_joint: U(101) }, { ...b, start_joint: U(101), closed_loop: true, points_encoded: pts([600, 0], [600, 340], [900, 340]) }]);
  sameAsUnjoined("4j", "a partner with nothing drawn and nothing typed has no end at all",
    [{ ...a, end_joint: U(102) }, { ...b, start_joint: U(102), points_encoded: "" }]);

  // ... and the control: the SAME helper, with a valid pair, must NOT match.
  ok("4k-canary", "POSITIVE CONTROL: a valid uuid pair on two live runs does NOT price as unjoined, so 4a-4j are real refusals",
    JSON.stringify(price([{ ...a, end_joint: U(103) }, { ...b, start_joint: U(103) }])) !== JSON.stringify(price([a, b])));

  // readJointId itself, directly.
  eq("4l", "readJointId: undefined, null, '', whitespace, 'J1' and a short uuid all read ''",
    [readJointId(undefined), readJointId(null), readJointId(""), readJointId("  "), readJointId("J1"), readJointId("1-1-1-1-1")],
    ["", "", "", "", "", ""]);
  eq("4m", "readJointId keeps a canonical uuid, trims it, and accepts upper case (Postgres stores the text as it arrives)",
    [readJointId(U(1)), readJointId(` ${U(1)} `), readJointId(U(1).toUpperCase())],
    [U(1), U(1), U(1).toUpperCase()]);

  // A TYPED-FOOTAGE run is live for the arithmetic (it has two ends) but has
  // no drawing, so there is no angle to read -- which must mean CORNER, the
  // dearer and stronger post, never LINE.
  const typedA = run(U(1), "", { sort_order: 0, manual_linear_feet: 30 });
  const typedB = run(U(2), "", { sort_order: 1, manual_linear_feet: 17 });
  const typedJoined = price([{ ...typedA, end_joint: U(104) }, { ...typedB, start_joint: U(104) }]);
  eq("4n", "two TYPED runs joined share a post, and with no drawing to measure the angle from it is a CORNER, not a line post",
    { corner: sumPosts(typedJoined).corner, end: sumPosts(typedJoined).end, total: sumPosts(typedJoined).total },
    { corner: 1, end: 2, total: sumPosts(price([typedA, typedB])).total - 1 });
}

// =============================================================================
section("5. A T, AND A CHAIN");
// =============================================================================
{
  const mk = (joints) => [
    run(U(1), LEG_A, { sort_order: 0, ...joints[0] }),
    run(U(2), LEG_B_STRAIGHT, { sort_order: 1, ...joints[1] }),
    run(U(3), LEG_C, { sort_order: 2, ...joints[2] }),
  ];
  const apart = price(mk([{}, {}, {}]));
  eq("5a", "three separate sides, 30 + 17 + 24 ft: 9 line + 6 end = 15 posts",
    { line: sumPosts(apart).line, end: sumPosts(apart).end, total: sumPosts(apart).total },
    { line: 9, end: 6, total: 15 });

  // A CHAIN: A-B at one joint, B-C at another. Two joints, two posts gone.
  const chain = price(mk([{ end_joint: U(10) }, { start_joint: U(10), end_joint: U(11) }, { start_joint: U(11) }]));
  eq("5b", "a CHAIN of three joined end to end has TWO joints and loses TWO posts: 11 line + 2 end = 13",
    { line: sumPosts(chain).line, corner: sumPosts(chain).corner, end: sumPosts(chain).end, total: sumPosts(chain).total },
    { line: 11, corner: 0, end: 2, total: 13 });
  eq("5c", "its caps and bags fall by two as well",
    { caps: roleQty(chain, "POST_CAP"), bags: roleQty(chain, "CONCRETE_BAG") },
    { caps: roleQty(apart, "POST_CAP") - 2, bags: roleQty(apart, "CONCRETE_BAG") - 2 });
  ok("5d", "the three legs joined straight price as the one polyline through the same points does",
    sumPosts(chain).total === sumPosts(price([run(U(1), pts([0, 0], [600, 0], [940, 0], [1420, 0]))])).total,
    `chain ${sumPosts(chain).total} vs polyline ${sumPosts(price([run(U(1), pts([0, 0], [600, 0], [940, 0], [1420, 0]))])).total}`);

  // A T: three run ends at ONE joint id. One post, not two.
  const tee = price([
    run(U(1), LEG_A, { sort_order: 0, end_joint: U(12) }),
    run(U(2), LEG_B_STRAIGHT, { sort_order: 1, start_joint: U(12) }),
    run(U(3), LEG_B_DOWN, { sort_order: 2, start_joint: U(12) }),
  ]);
  eq("5e", "a T -- THREE ends at one joint -- is ONE post, not two: ends fall by 3, one CORNER appears, the total falls by 2",
    { line: sumPosts(tee).line, corner: sumPosts(tee).corner, end: sumPosts(tee).end, total: sumPosts(tee).total },
    // 30 ft (6 posts) + 17 ft (4) + 17 ft (4) = 14 apart. Three ends meet:
    // ends 6 -> 3, one corner post appears, 14 -> 12.
    { line: 8, corner: 1, end: 3, total: 12 });
  ok("5f", "and a T is a CORNER post however the legs lie: two of these three ARE collinear, and a post three runs leave from is not a pass-through",
    adjustJoins([
      { id: "A", geometry: analyze(decodePoints(LEG_A), PPF, false), heightFt: 6, sortOrder: 0, isTeardown: false, startJointId: "", endJointId: "T" },
      { id: "B", geometry: analyze(decodePoints(LEG_B_STRAIGHT), PPF, false), heightFt: 6, sortOrder: 1, isTeardown: false, startJointId: "T", endJointId: "" },
      { id: "C", geometry: analyze(decodePoints(LEG_B_DOWN), PPF, false), heightFt: 6, sortOrder: 2, isTeardown: false, startJointId: "T", endJointId: "" },
    ]).posts[0].kind === "CORNER");

  // FOUR ends at one joint is still ONE post.
  const cross = price([
    run(U(1), LEG_A, { sort_order: 0, end_joint: U(13) }),
    run(U(2), LEG_B_STRAIGHT, { sort_order: 1, start_joint: U(13) }),
    run(U(3), LEG_B_DOWN, { sort_order: 2, start_joint: U(13) }),
    run(U(4), LEG_B_UP, { sort_order: 3, start_joint: U(13) }),
  ]);
  const crossApart = price([
    run(U(1), LEG_A, { sort_order: 0 }), run(U(2), LEG_B_STRAIGHT, { sort_order: 1 }),
    run(U(3), LEG_B_DOWN, { sort_order: 2 }), run(U(4), LEG_B_UP, { sort_order: 3 }),
  ]);
  eq("5g", "FOUR ends at one joint is still ONE post: the total falls by 3, ends by 4, one corner appears",
    { total: sumPosts(cross).total, end: sumPosts(cross).end, corner: sumPosts(cross).corner },
    { total: sumPosts(crossApart).total - 3, end: sumPosts(crossApart).end - 4, corner: sumPosts(crossApart).corner + 1 });

  // A CHAIN CLOSED BACK ON ITSELF is not the same as closedLoop, and the two
  // must not be conflated: four open runs round a rectangle, joined at all
  // four corners, lose FOUR posts and keep no free end.
  const R1 = pts([0, 0], [600, 0]), R2 = pts([600, 0], [600, 400]);
  const R3 = pts([600, 400], [0, 400]), R4 = pts([0, 400], [0, 0]);
  const ringApart = price([
    run(U(1), R1, { sort_order: 0 }), run(U(2), R2, { sort_order: 1 }),
    run(U(3), R3, { sort_order: 2 }), run(U(4), R4, { sort_order: 3 }),
  ]);
  const ring = price([
    run(U(1), R1, { sort_order: 0, start_joint: U(20), end_joint: U(21) }),
    run(U(2), R2, { sort_order: 1, start_joint: U(21), end_joint: U(22) }),
    run(U(3), R3, { sort_order: 2, start_joint: U(22), end_joint: U(23) }),
    run(U(4), R4, { sort_order: 3, start_joint: U(23), end_joint: U(20) }),
  ]);
  eq("5h", "a RING of four open runs joined at all four corners: 4 corner posts, NO free end, four posts fewer than apart",
    { corner: sumPosts(ring).corner, end: sumPosts(ring).end, total: sumPosts(ring).total },
    { corner: 4, end: 0, total: sumPosts(ringApart).total - 4 });
  ok("5i", "a ring closed by JOINTS is NOT the same as one run with closedLoop set -- a closed run has one position fewer in the estimate, and the two arithmetics are not interchangeable",
    sumPosts(ring).total !== sumPosts(price([run(U(1), pts([0, 0], [600, 0], [600, 400], [0, 400]), { closed_loop: true })])).total,
    "if these agreed, one of the two rules would be redundant and a joint could stand in for closing a loop, which the arithmetic refuses on purpose (SAME_RUN_TWICE)");
  eq("5j", "one joint short of closed, the ring is an open chain again: 3 corners and 2 free ends",
    (() => {
      const open = price([
        run(U(1), R1, { sort_order: 0, end_joint: U(21) }),
        run(U(2), R2, { sort_order: 1, start_joint: U(21), end_joint: U(22) }),
        run(U(3), R3, { sort_order: 2, start_joint: U(22), end_joint: U(23) }),
        run(U(4), R4, { sort_order: 3, start_joint: U(23) }),
      ]);
      return { corner: sumPosts(open).corner, end: sumPosts(open).end, total: sumPosts(open).total };
    })(),
    { corner: 3, end: 2, total: sumPosts(ringApart).total - 3 });
}

// =============================================================================
section("6. WHO IS BILLED THE SHARED POST");
// =============================================================================
{
  // The SHORTER run keeps the post where the heights differ. March's field
  // rule, 2 Oct 2026: where a 6 ft side meets a 4 ft side the fence steps DOWN
  // onto a 4 ft post, rather than a 6 ft post standing two feet proud of the
  // low side. This reverses the original rule here, which read "the taller run
  // keeps the post, because that is the post that has to be built" -- true of
  // a post carrying two runs of EQUAL height, and not how he builds a step.
  //
  // It matters in money, and the direction is not free: the post is billed in
  // the OWNER run's own catalog at its own height, so this corner now wants a
  // 4 ft corner post row. Equal heights never reach this branch and still fall
  // through to sort order, then id.
  const tall = run(U(1), LEG_A, { sort_order: 1, panel_height_ft: 6 });
  const short = run(U(2), LEG_B_UP, { sort_order: 0, panel_height_ft: 4, panel_width_ft: 6 });
  const out = price([{ ...tall, end_joint: U(30) }, { ...short, start_joint: U(30) }]);
  const cornerOn = out.runs.filter((r) => r.posts.corner > 0).map((r) => r.run_sync_id);
  eq("6a", "the SHORTER run is billed the shared post -- the 6 ft side steps down onto the 4 ft post",
    cornerOn, [U(2)]);
  eq("6a-ii", "and it is billed to exactly ONE of them, never both",
    out.runs.filter((r) => r.posts.corner > 0).length, 1);

  // Equal heights: the lower sort order, then the lower id. Never list order.
  const e1 = run(U(1), LEG_A, { sort_order: 5 });
  const e2 = run(U(2), LEG_B_UP, { sort_order: 2 });
  const byOrder = price([{ ...e1, end_joint: U(31) }, { ...e2, start_joint: U(31) }]);
  eq("6b", "equal heights: the LOWER sort order is billed", byOrder.runs.filter((r) => r.posts.corner > 0).map((r) => r.run_sync_id), [U(2)]);
  const rev = price([{ ...e2, start_joint: U(31) }, { ...e1, end_joint: U(31) }]);
  eq("6c", "and reversing the two rows in the input changes nothing -- the answer never depends on list order",
    rev.runs.filter((r) => r.posts.corner > 0).map((r) => r.run_sync_id), [U(2)]);

  // joinHeightFt is NOT panelHeightFt for chain link and split rail, and the
  // SAME rule is written in three places. If one of them drops a branch, the
  // gesture, the phone and the office can name three different owners.
  eq("6d", "joinHeightFt reads fabricHeightFt on chain link, 0 on split rail, panelHeightFt otherwise",
    [
      joinHeightFt({ fenceType: "CHAIN_LINK", fabricHeightFt: 4, panelHeightFt: 6 }),
      joinHeightFt({ fenceType: "SPLIT_RAIL", fabricHeightFt: 4, panelHeightFt: 6 }),
      joinHeightFt({ fenceType: "VINYL", fabricHeightFt: 4, panelHeightFt: 6 }),
    ], [4, 0, 6]);

  const sources = {
    "joins.ts": readRepo("supabase/functions/_shared/pricing/joins.ts"),
    "EstimateEngine.kt": readRepo("app/src/main/java/com/fenceestimator/app/estimate/EstimateEngine.kt"),
    "SurveyViewModel.kt": readRepo("app/src/main/java/com/fenceestimator/app/ui/survey/SurveyViewModel.kt"),
  };
  for (const [name, text] of Object.entries(sources)) {
    // Each file has exactly one copy; find its body and check both branches.
    const at = /CHAIN_LINK/.test(text) && /SPLIT_RAIL/.test(text);
    // Kotlin:      FenceType.CHAIN_LINK -> run.fabricHeightFt
    // TypeScript:  if (run.fenceType === "CHAIN_LINK") return run.fabricHeightFt;
    const chain = /CHAIN_LINK"?\)?\s*(->|return)\s*(run\.)?fabricHeightFt/.test(text);
    const split = /SPLIT_RAIL"?\)?\s*(->|return)\s*0f?\s*[;\r\n]/.test(text);
    ok(`6e-${name}`, `${name} carries the owner-height rule with BOTH special branches (chain link -> fabric height, split rail -> 0)`,
      at && chain && split,
      `found CHAIN_LINK+SPLIT_RAIL=${at}, fabric branch=${chain}, split branch=${split}. All three copies must agree or one post gets three different owners.`);
  }
  ok("6f-canary", "scanner canary: the same patterns do NOT match a file that has no such rule, so 6e can fail",
    !/CHAIN_LINK"?\)?\s*(->|return)\s*(run\.)?fabricHeightFt/.test(readRepo("supabase/functions/_shared/pricing/f32.ts")));
}

// =============================================================================
section("7. THE WIRING IS ACTUALLY THERE, on both engines");
// =============================================================================
{
  const kt = readRepo("app/src/main/java/com/fenceestimator/app/estimate/EstimateEngine.kt");
  const srvIndex = readRepo("supabase/functions/_shared/pricing/index.ts");
  const srvTakeoff = readRepo("supabase/functions/_shared/pricing/takeoff.ts");
  const priceJobFn = readRepo("supabase/functions/price-job/index.ts");

  ok("7a", "priceJob calls adjustJoins ONCE, outside the per-run loop, and hands each run its own slice",
    /const joins = adjustJoins\(/.test(srvIndex) && /adjustmentForRun\(joins, run\.syncId\)/.test(srvIndex));
  ok("7b", "runFromRow validates both joint columns through readJointId",
    /startJointId: readJointId\(row\.start_joint\)/.test(srvIndex) && /endJointId: readJointId\(row\.end_joint\)/.test(srvIndex));
  ok("7c", "load.ts carries both columns onto the contract row, defaulting to '' when the select left them out",
    /start_joint: row\.start_joint \?\? ""/.test(readRepo("supabase/functions/_shared/pricing/load.ts"))
    && /end_joint: row\.end_joint \?\? ""/.test(readRepo("supabase/functions/_shared/pricing/load.ts")));
  ok("7d", "price-job SELECTS both columns (JOIN_COLUMNS_LIVE), or the office would read no joint and price a job differently from the phone",
    /const JOIN_COLUMNS_LIVE = true;/.test(priceJobFn) && /start_joint, end_joint/.test(priceJobFn));
  ok("7e", "takeoff.ts applies the adjustment at the END of computePostCounts, not into it",
    /applyJoinAdjustment\(counts, joinAdjustment\)/.test(srvTakeoff));
  ok("7f", "the phone's engine has the same three pieces: joinAdjustments over all runs, an optional argument on suggestQuantities and explainPosts, and the apply inside computePostCounts",
    /fun joinAdjustments\(runs: List<FenceRun>, pixelsPerFoot: Float\)/.test(kt)
    && /RunJoinArithmetic\.adjust\(/.test(kt)
    && /joinAdjustment: RunPostAdjustment\? = null/.test(kt)
    && /postsSharedAtJoints = -joinAdjustment\.totalPostsDelta/.test(kt));
  ok("7g", "the phone's engine validates a stored joint id before using it",
    /private fun usableJointId\(stored: String\)/.test(kt) && /stored\.length == 36/.test(kt));

  // THE CAPABILITY IS NOT THE FEATURE. An optional argument nobody passes
  // means the phone goes on billing two end posts while the office bills one
  // -- and SurveyViewModel.JOIN_PRICING_READY would then be claiming
  // something untrue. Every screen and refresher that prices a run has to
  // pass one, and has to work it out over the WHOLE job.
  const callers = {
    "TakeoffRefresher.kt (the automatic refresh)": "app/src/main/java/com/fenceestimator/app/estimate/TakeoffRefresher.kt",
    "EstimateViewModel.kt (the takeoff readout, the why sheet and Suggest)": "app/src/main/java/com/fenceestimator/app/ui/estimate/EstimateViewModel.kt",
  };
  for (const [label, path] of Object.entries(callers)) {
    const text = readRepo(path);
    const asks = (text.match(/EstimateEngine\.joinAdjustments\(/g) ?? []).length;
    const passes = (text.match(/joinAdjustment = /g) ?? []).length;
    const prices = (text.match(/EstimateEngine\.(suggestQuantities|explainPosts)\(/g) ?? []).length;
    ok(`7k-${label.split(" ")[0]}`, `${label} asks for the job's joins and passes one to EVERY place it prices a run (${prices} call sites)`,
      asks > 0 && prices > 0 && passes === prices,
      `${asks} joinAdjustments() calls, ${passes} joinAdjustment arguments, ${prices} pricing calls. Every pricing call needs one, or that screen bills a post that is not in the ground.`);
  }
  ok("7k-canary", "scanner canary: a file that prices nothing matches zero pricing calls, so 7k can distinguish",
    (readRepo("app/src/main/java/com/fenceestimator/app/geometry/FenceGeometry.kt").match(/EstimateEngine\.(suggestQuantities|explainPosts)\(/g) ?? []).length === 0);

  // The flag that TELLS the owner the price moves has to agree with the
  // engine, and the engine is now wired. a57 2h holds the other direction.
  ok("7l", "SurveyViewModel.JOIN_PRICING_READY is true, so the attach confirmation no longer says the materials and the price do not change",
    /const val JOIN_PRICING_READY = true/.test(readRepo("app/src/main/java/com/fenceestimator/app/ui/survey/SurveyViewModel.kt")));

  const ktVersion = /const val PRICING_ENGINE_VERSION = "([^"]+)"/.exec(kt);
  ok("7h", "PRICING_ENGINE_VERSION is the SAME on both engines -- a join changes prices, so it had to move, and it cannot move on one side only",
    ktVersion !== null && ktVersion[1] === PRICING_ENGINE_VERSION,
    `Kotlin ${ktVersion && ktVersion[1]}, TypeScript ${PRICING_ENGINE_VERSION}`);

  // The fixtures are written by Kotlin and must be regenerated whenever the
  // version moves. Printed loudly rather than asserted: this file must not be
  // the thing that is red for a reason only `gradlew` can fix, or it becomes a
  // red light everyone learns to walk past. The PARITY GATE
  // (scripts/check-parity.mjs) is what refuses to ship on it, and it is red
  // now -- which is correct.
  const fixture = JSON.parse(readRepo("fixtures/pricing/aluminum-drawn-closed.json"));
  const fixtureVersion = fixture.input?.engine_version ?? fixture.engine_version;
  if (fixtureVersion !== PRICING_ENGINE_VERSION) {
    console.log(`  NOTE  7i THE RECORDED FIXTURES ARE STALE: they are at ${fixtureVersion}, both engines at ${PRICING_ENGINE_VERSION}.`);
    console.log(`          A join changes prices, so the version HAD to move. Regenerate in this commit:`);
    console.log(`            export JAVA_HOME=/c/Users/march/.jdks/jdk-17.0.20+8`);
    console.log(`            FENCEFLOW_PARITY_OUT=$(pwd)/fixtures/pricing ./gradlew testDebugUnitTest --tests "*ParityFixtureWriter*" -q`);
    console.log(`          NOT while another wave is compiling Kotlin, and never piped into tail or grep.`);
  } else {
    ok("7i", "the recorded fixtures are at the engines' current version", true);
  }

  // No recorded fixture may carry a joint: the columns are new and nothing was
  // backfilled, so every fixture must still describe an unjoined job. That is
  // what makes "regenerating moves nothing because of THIS change" checkable.
  const dir = join(REPO, "fixtures", "pricing");
  const names = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const withJoint = names.filter((f) => /"(start|end)_joint"\s*:\s*"[^"]+"/.test(readFileSync(join(dir, f), "utf8")));
  ok("7j", `none of the ${names.length} recorded fixtures carries a joint id, so regenerating cannot move one because of this change`,
    names.length > 0 && withJoint.length === 0, `${withJoint.join(", ")} carry one`);
}

// =============================================================================
section("8. HIS JOB: three sides, 72 + 52 + 74 ft, one gate -- before and after");
// =============================================================================
// Priced on his own catalog, read read-only from production on 2 Oct 2026 (the
// vinyl and universal rows the post roles reach). Money, not just counts,
// because the two end posts becoming one corner post is a change of CATALOG
// ROW and the count alone cannot show it.
{
  const CATALOG = [
    { sync_id: U(201), name: "5\"x5\" Co-Ex Line Post, White", category: "POSTS", role: "LINE_POST", fence_type: "VINYL", color_or_finish: "White", unit: "EA", unit_price: 16.56, taxable: true, covers_ft: null, height_ft: 6, is_active: true, manufacturer_sync_id: null },
    { sync_id: U(202), name: "5\"x5\" Co-Ex Corner Post, White", category: "POSTS", role: "CORNER_POST", fence_type: "VINYL", color_or_finish: "White", unit: "EA", unit_price: 16.56, taxable: true, covers_ft: null, height_ft: 6, is_active: true, manufacturer_sync_id: null },
    { sync_id: U(203), name: "5\"x5\" Co-Ex End Post, White", category: "POSTS", role: "END_POST", fence_type: "VINYL", color_or_finish: "White", unit: "EA", unit_price: 16.56, taxable: true, covers_ft: null, height_ft: 6, is_active: true, manufacturer_sync_id: null },
    { sync_id: U(204), name: "5\"x5\" Co-Ex Gate Post, White", category: "POSTS", role: "GATE_POST", fence_type: "VINYL", color_or_finish: "White", unit: "EA", unit_price: 16.56, taxable: true, covers_ft: null, height_ft: 6, is_active: true, manufacturer_sync_id: null },
    { sync_id: U(205), name: "5\" External Pyramid PVC Post Cap, White", category: "POSTS", role: "POST_CAP", fence_type: "VINYL", color_or_finish: "White", unit: "EA", unit_price: 0.74, taxable: true, covers_ft: null, height_ft: null, is_active: true, manufacturer_sync_id: null },
    { sync_id: U(206), name: "Concrete Mix 60lb Bag", category: "MISC", role: "CONCRETE_BAG", fence_type: "UNIVERSAL", color_or_finish: "", unit: "BAG", unit_price: 4.75, taxable: true, covers_ft: null, height_ft: null, is_active: true, manufacturer_sync_id: null },
    { sync_id: U(207), name: "Panel T&G Vinyl Privacy 6'H x 6'W - White", category: "PANELS", role: "PANEL", fence_type: "VINYL", color_or_finish: "White", unit: "EA", unit_price: 52.35, taxable: true, covers_ft: 6, height_ft: 6, is_active: true, manufacturer_sync_id: null },
  ];
  // 20 px/ft: 72 ft = 1440 px, 52 ft = 1040 px, 74 ft = 1480 px. Drawn as the
  // three sides of a yard, so the two joints turn square corners.
  const S1 = pts([0, 0], [1440, 0]);
  const S2 = pts([1440, 0], [1440, 1040]);
  const S3 = pts([1440, 1040], [-40, 1040]);
  const mk = (j) => [
    run(U(41), S1, { sort_order: 0, gates_encoded: "700:0:4:LINE", ...j[0] }),
    run(U(42), S2, { sort_order: 1, ...j[1] }),
    run(U(43), S3, { sort_order: 2, ...j[2] }),
  ];
  const before = price(mk([{}, {}, {}]), CATALOG);
  const after = price(mk([
    { end_joint: U(50) },
    { start_joint: U(50), end_joint: U(51) },
    { start_joint: U(51) },
  ]), CATALOG);

  const b = sumPosts(before), a = sumPosts(after);
  eq("8a", "BEFORE, drawn as three separate sides: 6 end posts",
    { end: b.end, corner: b.corner }, { end: 6, corner: 0 });
  // Three sides have SIX free ends. Joining at two corners consumes FOUR of
  // them and puts two corner posts in their place, leaving the two ends at
  // the open ends of the chain. (Not "4 end posts and 2 corner posts": that
  // would be six terminal posts, which is what he is billed TODAY, and would
  // mean no post had come off at all.)
  eq("8b", "AFTER, joined at the two corners: 2 end posts and 2 CORNER posts -- four terminal posts where six stood",
    { end: a.end, corner: a.corner }, { end: 2, corner: 2 });
  eq("8b2", "which is four terminal posts against six, and the two that went were END posts",
    { terminalBefore: b.corner + b.end, terminalAfter: a.corner + a.end }, { terminalBefore: 6, terminalAfter: 4 });
  eq("8c", "two fewer posts in all", a.total, b.total - 2);
  eq("8d", "two fewer caps and two fewer bags of concrete",
    { caps: roleQty(after, "POST_CAP"), bags: roleQty(after, "CONCRETE_BAG") },
    { caps: roleQty(before, "POST_CAP") - 2, bags: roleQty(before, "CONCRETE_BAG") - 2 });
  eq("8e", "the gate's two posts are untouched", a.gate, b.gate);
  eq("8f", "the footage and the panels do not move",
    { feet: after.linear_feet, panels: roleQty(after, "PANEL") },
    { feet: before.linear_feet, panels: roleQty(before, "PANEL") });
  ok("8g", "and the TOTAL falls, on his own catalog",
    after.totals.grand_total < before.totals.grand_total,
    `before ${before.totals.grand_total}, after ${after.totals.grand_total}`);
  eq("8h", "by exactly two posts, two caps and two bags at his own prices: 2x16.56 + 2x0.74 + 2x4.75 = 44.10",
    Number((before.totals.grand_total - after.totals.grand_total).toFixed(2)), 44.10);

  console.log(`\n          HIS JOB, on his own catalog, with every other rate at zero so the`);
  console.log(`          post arithmetic is the only thing moving:`);
  const row = (label, out) => {
    const p = sumPosts(out);
    console.log(`            ${label.padEnd(8)} line ${String(p.line).padStart(2)}  corner ${p.corner}  end ${p.end}  gate ${p.gate}  ` +
      `total ${String(p.total).padStart(2)}  caps ${String(roleQty(out, "POST_CAP")).padStart(2)}  ` +
      `bags ${String(roleQty(out, "CONCRETE_BAG")).padStart(2)}  materials $${out.totals.materials_subtotal.toFixed(2)}  grand $${out.totals.grand_total.toFixed(2)}`);
  };
  row("before", before);
  row("after", after);
  console.log(`            saving  $${(before.totals.grand_total - after.totals.grand_total).toFixed(2)} at zero tax and markup\n`);
}

// ---------------------------------------------------------------------------
console.log("\n----------------------------------------------------------------------");
console.log(`${passed} ok, ${failed} FAIL`);
if (failed > 0) { console.log(`FAILED: ${failedIds.join(", ")}`); process.exitCode = 1; }
else console.log("A join changes the price, a job with no join does not move, and bad join data stays dear.");
