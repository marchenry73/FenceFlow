// a53-gate-post-role -- a gate now asks for a GATE_POST row instead of an END_POST row.
//
//   node --test tests/a53-gate-post-role.test.mjs            (no network, no writes)
//
// WHY. Nothing in either engine ever asked for GATE_POST. MaterialRole defines it, the catalog
// editor offers it, SeedData ships one per fence type, and the takeoff emitted END_POST at every
// gate. So a GATE_POST row was unreachable inventory: the owner's live catalog (read-only SELECT,
// 1 Oct 2026) holds TEN of them with prices typed in by hand, including both suppliers' blank
// posts, which are separate SKUs from their end posts. His gate post and end post happen to cost
// the same $16.56, so no money had moved yet -- luck, not design.
//
// RE-AIMED 2 Oct 2026 for TWO deliberate changes that landed after it was written. Neither is a
// regression and neither number below was chosen to make this file pass:
//
//   (D) A WALL GATE'S LATCH POST IS AN END POST, not a gate post -- the owner's own words on
//       1 Oct: "if it's against the wall, it's a blank post, and then an end post for the fence
//       line that the gate latches to." (commit 3c0b3df, EstimateEngine.gateAreaEntries carries
//       his sentence verbatim.) The reasoning: on a WALL gate the fence runs up to the latch post
//       and STOPS, so that post IS the end of the line; on a LINE gate the fence carries on past
//       both posts, so neither is. So WALL is BLANK_POST 1 + END_POST 1 from the gate area, and
//       asks for NO gate post at all. Every WALL expectation here moved for that reason.
//   (E) THE BLANK POST NOW HAS A ROW TO BILL (engine 2026.10.5, PRICING_FALLBACK_ROLE
//       BLANK_POST -> GATE_POST, pinned in full by a58-blank-post-fallback). So "BLANK_POST is
//       unmatched on every wall gate" -- block 6b's whole subject -- is CLOSED, and block 6b is
//       re-aimed onto the closure rather than deleted.
//
// WHAT THIS FILE PINS
//   1. THE ROLES, per mounting, and that they follow the physical build:
//        WALL          BLANK_POST 1 + END_POST 1        (hinge bolts to the wall; latch ENDS the line)
//        LINE          GATE_POST 2                      (both posts stand at the opening)
//        LINE_TO_WALL  GATE_POST 2 + END_POST 1         (the third is where the RUN terminates)
//      The third post on a LINE_TO_WALL is a genuine end post, not a gate post: it is where the
//      rest of the fence meets the wall, nowhere near the gate leaf. That is what decides 2+1
//      rather than 3, and GateMounting.LINE_TO_WALL's own wording agrees -- "the run terminates
//      twice and needs a second end post".
//   2. NO COUNT MOVED. gatePosts, totalPosts, POST_CAP and CONCRETE_BAG are identical to
//      2026.10.3 in every mounting, and a WALL gate still takes no concrete for its hinge side.
//      Asserted against literals derived from the formula, with the formula re-derived beside
//      them so a golden that drifts cannot pass quietly.
//   3. ADDITIVITY where a GATE_POST row exists at the end post's price -- which is the owner's
//      catalog and the shipped seed, every fence type. Penny for penny, the grand total does not
//      move. The LINE ITEMS do split one END_POST line into END_POST + GATE_POST, deliberately:
//      that split IS the change, and both lines price off the same row at the same money.
//   4. THE TEETH. With a GATE_POST row priced differently from the end post, the quote DOES move,
//      and by exactly (gate posts x the difference). Without this, every assertion above would
//      pass just as well on an engine that still billed END_POST.
//   5. THE MISSING HALF, and it is the whole risk. A catalog with NO GATE_POST row loses its gate
//      posts outright: buildLineItems reports the role unmatched and writes no line. The fallback
//      belongs in that matcher (prefer END_POST candidates for a GATE_POST entry with none) and
//      that file is held by another wave. Block 5 pins TODAY'S broken state so it is impossible to
//      forget, and block 6 proves the designed fallback is penny-for-penny additive using a
//      REFERENCE MODEL -- which is NOT the engine and which the engine does not do.
//   6. THE WALL GATE'S OTHER HOLE, found while in here: BLANK_POST is asked for on every WALL gate
//      and NO catalog anywhere has a row for it -- not the seed, not the owner's (verified by
//      SELECT across every company: zero). It is unmatched today, before this change and after.
//
// EVERY NEGATIVE HAS A POSITIVE CONTROL beside it, produced by the same code on a planted case.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPricingInput } from "../supabase/functions/_shared/pricing/load.ts";
import { PRICING_ENGINE_VERSION, priceJob } from "../supabase/functions/_shared/pricing/index.ts";

// ============================================================ the real engine ==
const JOB_SYNC = "a5300000-0000-4000-8000-000000000001";
const RUN_SYNC = "a5300000-0000-4000-8000-000000000002";

const jobRow = (o = {}) => ({
  sync_id: JOB_SYNC, updated_at: "2026-10-01T12:00:00Z", calibration_pixels_per_foot: null,
  tax_rate_percent: 7, markup_percent: 0, discount_percent: 0, labor_rate_per_ft: 8, labor_flat_fee: 0,
  minimum_job_charge: 200, minimum_labor_charge: 0, waste_percent: 0, gate_rate_per_ft: 20, trash_haul_fee: 0,
  teardown_enabled: false, teardown_flat_fee: 0, teardown_rate_per_ft: 0, teardown_feet: 0,
  preferred_manufacturer_sync_id: null, survey_storage_path: null, ...o,
});
const runRow = (o = {}) => ({
  sync_id: RUN_SYNC, label: "Back", fence_type: "VINYL", color_or_finish: "", points_encoded: "",
  gates_encoded: "", closed_loop: false, manual_linear_feet: 100, manual_corner_count: 0, panel_width_ft: 6,
  panel_height_ft: 6, post_spacing_ft: 6, concrete_bags_per_post: 1, aluminum_style: "RACKABLE",
  wood_style: "PRIVACY", wood_rail_count: 3, picket_width_in: 5.5, picket_gap_in: 0, fabric_height_ft: 4,
  include_top_rail: true, include_tension_wire: false, include_barbed_wire_arms: false,
  include_privacy_slats: false, split_rail_count: 2, suppressed_roles: "", is_teardown: false, sort_order: 0, ...o,
});
/** Catalog rows as price-job reads them. Sync ids are by position, so a price tie always breaks the same way. */
const dbRows = (rows) => rows.map((r, i) => ({
  sync_id: "a5300000-0000-4000-8000-" + String(100 + i).padStart(12, "0"),
  name: r.name, category: r.category ?? "MISC", role: r.role, fence_type: r.fence_type ?? "VINYL",
  color_or_finish: r.color_or_finish ?? "", unit: "EA", unit_price: r.unit_price, taxable: true,
  covers_ft: r.covers_ft ?? null, height_ft: r.height_ft ?? null, manufacturer_sync_id: null, is_active: true,
}));
const price = (run, rows, job = {}) => priceJob(buildPricingInput({
  job: jobRow(job), runs: [run], catalog: dbRows(rows), manufacturers: [], changeOrders: [], existingItems: [],
  engineVersion: PRICING_ENGINE_VERSION,
}));
const itemOf = (out, role) => out.items.find((i) => i.role === role);
/** What the takeoff asked for, by role, before the catalog is consulted. */
const entryQty = (out, role) => out.runs[0].entries
  .filter((e) => e.role === role).reduce((s, e) => s + e.quantity, 0);
/** What the quote actually bills, by role. A role with no line bills nothing. */
const billedQty = (out, role) => out.items
  .filter((i) => i.role === role).reduce((s, i) => s + i.quantity, 0);
const unmatchedOf = (out) => out.unmatched_roles.map((u) => u.role).sort();
const money = (n) => Math.round(n * 100) / 100;

// ======================================================= the catalog, as he has it ==
// A complete vinyl catalog, so nothing goes unmatched by accident and a total means something.
// The post prices and heights are the owner's own, read 1 Oct 2026 by a read-only SELECT against
// his company (aba5b097-...): END_POST "5x5 Co-Ex End Post, White" $16.56 h6, and GATE_POST
// "5x5 Co-Ex Gate Post, White" $16.56 h6. BLANK_POST is deliberately absent, because no catalog
// anywhere has one -- see block 6.
const GATE_POST_ROW = { name: '5"x5" Co-Ex Gate Post, White', category: "POST", role: "GATE_POST", unit_price: 16.56, color_or_finish: "White", height_ft: 6 };
const CATALOG = [
  { name: "Vinyl Privacy Panel 6'H x 6'W, White", category: "PANEL", role: "PANEL", unit_price: 120, color_or_finish: "White", covers_ft: 6, height_ft: 6 },
  { name: "Vinyl Privacy Gate 4'W, White", category: "GATE", role: "GATE_PANEL", unit_price: 290, color_or_finish: "White", covers_ft: 4, height_ft: 6 },
  { name: '5"x5" Co-Ex Line Post, White', category: "POST", role: "LINE_POST", unit_price: 16.56, color_or_finish: "White", height_ft: 6 },
  { name: '5"x5" Co-Ex Corner Post, White', category: "POST", role: "CORNER_POST", unit_price: 16.56, color_or_finish: "White", height_ft: 6 },
  { name: '5"x5" Co-Ex End Post, White', category: "POST", role: "END_POST", unit_price: 16.56, color_or_finish: "White", height_ft: 6 },
  GATE_POST_ROW,
  { name: '5"x5" Post Cap, White', category: "POST", role: "POST_CAP", unit_price: 3.5, color_or_finish: "White" },
  { name: "Concrete Mix 60 lb", category: "CONCRETE", role: "CONCRETE_BAG", fence_type: "UNIVERSAL", unit_price: 6.25 },
  { name: "Gate Hinge Set, White", category: "HARDWARE", role: "HINGE_SET", unit_price: 24, color_or_finish: "White" },
  { name: "Gate Latch, White", category: "HARDWARE", role: "LATCH", unit_price: 18, color_or_finish: "White" },
  { name: "Gate Handle, White", category: "HARDWARE", role: "HANDLE", unit_price: 12, color_or_finish: "White" },
  { name: "Gate Brace Kit", category: "HARDWARE", role: "BRACE", fence_type: "UNIVERSAL", unit_price: 9 },
  { name: "Econo Gate Stiffener", category: "HARDWARE", role: "STIFFENER", fence_type: "UNIVERSAL", unit_price: 15 },
  { name: '5/8" Hole Plug, White', category: "HARDWARE", role: "HOLE_PLUG", unit_price: 0.15, color_or_finish: "White" },
  { name: "Vinyl Trim, White", category: "TRIM", role: "TRIM", unit_price: 4, color_or_finish: "White" },
];
const without = (rows, role) => rows.filter((r) => r.role !== role);
const replacePrice = (rows, role, unit_price) => rows.map((r) => (r.role === role ? { ...r, unit_price } : r));

const GATE = { LINE: "500.0:0.0:4.0:LINE:IN", WALL: "500.0:0.0:5.0:WALL:IN", LINE_TO_WALL: "500.0:0.0:6.0:LINE_TO_WALL:IN" };
const WHITE = { color_or_finish: "White" };
/** One gate of the named mounting, on a 100 ft open run with no corners. */
const quote = (mounting, rows = CATALOG, run = {}, job = {}) =>
  price(runRow({ ...WHITE, gates_encoded: GATE[mounting], ...run }), rows, job);

test("harness: the real engine prices this catalog with nothing unmatched, in every mounting", () => {
  // WAS: WALL expected ["BLANK_POST"] unmatched, because no catalog anywhere stocked one.
  // NOW: []. Change (E) above -- a BLANK_POST entry with no BLANK_POST row is priced off the
  // company's GATE_POST rows, and this catalog has one. Not a pin moved to go green: the
  // description of that line is asserted to be the gate-post row's name in block 6b below, so
  // "nothing unmatched" cannot be satisfied by a blank post appearing out of nowhere.
  for (const m of ["LINE", "WALL", "LINE_TO_WALL"]) {
    const out = quote(m);
    assert.equal(out.engine_version, PRICING_ENGINE_VERSION);
    assert.deepEqual(unmatchedOf(out), [],
      m + ": something is unmatched -- the catalog above is incomplete, fix it before reading any number here");
    assert.ok(out.totals.grand_total > 0, m + ": no money came out");
  }
  // CONTROL: the reader is not blind. Take the gate post away and WALL has nothing left to bill
  // a blank post off, so the role is named again.
  assert.deepEqual(unmatchedOf(quote("WALL", without(CATALOG, "GATE_POST"))), ["BLANK_POST"]);
});

// =============================================== 1. THE ROLES, PER MOUNTING ==

test("THE ROLES: a gate asks for GATE_POST, and every post where a RUN terminates is an END_POST", () => {
  // WALL: the hinge side is the blank post bolted through. The latch side is where the fence
  // line STOPS, so it is an END_POST -- change (D) at the top of this file, the owner's own
  // correction of 1 Oct. WAS: GATE_POST 1 + END_POST 2 (the run's two open ends). NOW:
  // GATE_POST 0 + END_POST 3 (those two open ends plus the latch post). The sum is unchanged at
  // FOUR posts asked for (1 + 1 + 2 before, 1 + 0 + 3 now), so nothing was added or lost -- one
  // of them changed which role, and so which catalog row, it bills.
  const wall = quote("WALL");
  assert.equal(entryQty(wall, "GATE_POST"), 0, "WALL: a wall gate asks for no gate post -- its hinge side is the wall and its latch side ends the line");
  assert.equal(entryQty(wall, "BLANK_POST"), 1, "WALL: the hinge side is still a blank post");
  assert.equal(entryQty(wall, "END_POST"), 3, "WALL: the run's two ends plus the post the gate latches to");
  assert.equal(entryQty(wall, "BLANK_POST") + entryQty(wall, "END_POST") + entryQty(wall, "GATE_POST"), 4,
    "WALL: the NUMBER of posts asked for has moved, not just their roles -- change (D) was a re-labelling, not an addition");

  // LINE: one gate post and one latch post.
  //
  // MOVED 5 Oct 2026, and it is the same re-labelling as change (D) above, one
  // mounting over. WAS: GATE_POST 2 + END_POST 2 -- both posts at the opening
  // billed as gate posts. NOW: GATE_POST 1 + END_POST 3 -- the HINGE side is
  // the gate post (it carries the gate), and the latch side is just a post the
  // gate shuts against, which is the same thing the fence line ends on.
  //
  // The sum is unchanged at FOUR, measured not assumed, which is the invariant
  // this block exists to protect: one of them changed which role -- and so
  // which catalog row -- it bills, and nothing was added or lost.
  //
  // Where the latch post has no fence line to be the end OF, the engine asks
  // for a BLANK_POST instead; that case is a free-standing gate and is covered
  // by the gate-only-run parity fixture rather than here.
  const line = quote("LINE");
  assert.equal(entryQty(line, "GATE_POST"), 1, "LINE: the hinge side is the gate post");
  assert.equal(entryQty(line, "BLANK_POST"), 0, "LINE: nothing bolts to a wall here");
  assert.equal(entryQty(line, "END_POST"), 3, "LINE: the run's two ends plus the post the gate latches to");
  assert.equal(entryQty(line, "BLANK_POST") + entryQty(line, "END_POST") + entryQty(line, "GATE_POST"), 4,
    "LINE: the NUMBER of posts asked for has moved, not just their roles -- this was a re-labelling, not an addition");

  // LINE_TO_WALL: one gate post on the hinge side; the latch side meets the
  // wall, and the rest of the run ends where it ends.
  //
  // MOVED with LINE, same re-labelling. WAS: GATE_POST 2 + END_POST 3. NOW:
  // GATE_POST 1 + END_POST 4. Sum unchanged at FIVE, measured, so once again a
  // post changed which catalog row it bills and none was added or lost.
  const ltw = quote("LINE_TO_WALL");
  assert.equal(entryQty(ltw, "GATE_POST"), 1, "LINE_TO_WALL: the gate hangs on one gate post");
  assert.equal(entryQty(ltw, "END_POST"), 4, "LINE_TO_WALL: the run's two ends, the one at the wall, and the latch post");
  assert.equal(entryQty(ltw, "BLANK_POST") + entryQty(ltw, "END_POST") + entryQty(ltw, "GATE_POST"), 5,
    "LINE_TO_WALL: the NUMBER of posts asked for has moved, not just their roles");

  // CONTROL: with no gate at all, nothing asks for a gate post and END_POST is the geometry's.
  const none = price(runRow(WHITE), CATALOG);
  assert.equal(entryQty(none, "GATE_POST"), 0, "control: a gateless run asks for a gate post");
  assert.equal(entryQty(none, "END_POST"), 2, "control: a gateless open run has two end posts");
});

test("THE ROLES reach the QUOTE, not just the takeoff: a priced line off his own GATE_POST row appears", () => {
  // WAS: a GATE_POST line in all three mountings, quantity 1 / 2 / 2.
  // THEN 1 / 2 / 2 became 0 / 2 / 2 with change (D), and 5 Oct 2026 made the
  // two LINE mountings 1 apiece: the HINGE side carries the gate, the LATCH
  // side is just a post the gate shuts against. The totals in
  // "THE ROLES" above are unchanged either way -- a post swapped roles, none
  // was added or lost -- so what moved here is which row is billed, which is
  // exactly what this test is for.
  // NOW: WALL has no GATE_POST line (change D -- it asks for none). His GATE_POST row is still
  //      reached on a wall gate, but under BLANK_POST, through the fallback of change (E). So
  //      the point of this test -- a hand-priced GATE_POST row is no longer unreachable
  //      inventory -- is asserted in all three, with WALL naming the role that now carries it.
  for (const [m, role, n] of [["WALL", "BLANK_POST", 1], ["LINE", "GATE_POST", 1], ["LINE_TO_WALL", "GATE_POST", 1]]) {
    const gp = itemOf(quote(m), role);
    assert.ok(gp !== undefined, m + ": no " + role + " line on the quote");
    assert.equal(gp.quantity, n, m + ": wrong post count on the quote");
    assert.equal(gp.description, GATE_POST_ROW.name, m + ": the post was billed off some other row than his GATE_POST row");
    assert.equal(gp.unit_price, 16.56);
    assert.equal(gp.role, role, m + ": the role on the line was rewritten, so the quote no longer says which post this is");
  }
  assert.equal(itemOf(quote("WALL"), "GATE_POST"), undefined,
    "WALL: a GATE_POST line is back on a wall gate -- change (D) says its two posts are a blank post and an end post");
  // CONTROL: this is new. Under 2026.10.3 no fence type, no mounting, no catalog produced one.
  // COMPONENT-WISE, not a string compare.
  //
  // This read `PRICING_ENGINE_VERSION > "2026.10.3"`, which is a STRING
  // comparison: "2026.10.11" > "2026.10.3" is FALSE, because at the ninth
  // character '1' sorts below '3'. The engine had not gone backwards; the
  // assertion simply stopped being able to pass the moment the patch number
  // reached double digits, and it would have fired on 2026.10.10 just the same.
  //
  // a26, a29, a40-engine and a40-carriers each hit this and each grew their own
  // comparator with the same warning in the comment. This is the fifth.
  const newer = (a, b) => {
    const pa = String(a).split(".").map(Number);
    const pb = String(b).split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d !== 0) return d > 0;
    }
    return false;
  };
  assert.ok(newer(PRICING_ENGINE_VERSION, "2026.10.3"),
    `the engine version did not move: this change bills a different catalog row and is a formula change (version is ${PRICING_ENGINE_VERSION})`);
  // CONTROL: the comparison is the component-wise one, not the string compare
  // that put this check beyond reach for two patch numbers.
  assert.ok(newer("2026.10.11", "2026.10.3") && !newer("2026.10.3", "2026.10.11"),
    "control: the version comparison is still a string compare");
});

// ===================================== 2. NOT ONE COUNT MOVED (POST_CAP, CONCRETE) ==

// feet, gate width, bays, linePosts, gatePosts, totalPosts, concrete bags. Re-derived below so a
// drifting literal cannot pass: net = 100 - gate; bays = ceil(net / 6); open run so
// standard = bays + 1 - 1 gate; linePosts = standard - 0 corners - 2 ends; total = line + 2 + gate;
// bags = ceil((total - gatePosts) x 1 + the gate area's own).
const COUNTS = {
  //              net  bays  line  gate  total  bags   gate-area bags
  LINE: /*     */ [96, 16, 14, 2, 18, 19, 2.5],
  WALL: /*     */ [95, 16, 14, 2, 18, 17, 1.0],
  LINE_TO_WALL: [94, 16, 14, 3, 19, 20, 3.5],
};

test("NO COUNT MOVED: gatePosts, totalPosts, POST_CAP and CONCRETE_BAG are 2026.10.3's numbers exactly", () => {
  for (const [m, [net, bays, line, gate, total, bags, areaBags]] of Object.entries(COUNTS)) {
    const out = quote(m);
    const posts = out.runs[0].posts;

    // the derivation, so the literals above are checked and not merely trusted
    assert.equal(out.runs[0].net_feet, net, m + ": net feet");
    assert.equal(Math.ceil(net / 6), bays, m + ": bays");
    assert.equal(bays + 1 - 1 - 0 - 2, line, m + ": line posts by formula");
    assert.equal(line + 0 + 2 + gate, total, m + ": total posts by formula");
    assert.equal(Math.ceil((total - gate) * 1 + areaBags), bags, m + ": bags by formula");

    assert.equal(posts.line, line, m + ": line posts moved");
    assert.equal(posts.end, 2, m + ": the geometry's end-post COUNT moved (this is the takeoff line, not the role)");
    assert.equal(posts.gate, gate, m + ": gatePosts moved -- POST_CAP is priced off this");
    assert.equal(posts.total, total, m + ": totalPosts moved");
    assert.equal(billedQty(out, "POST_CAP"), total, m + ": POST_CAP no longer matches totalPosts");
    assert.equal(billedQty(out, "CONCRETE_BAG"), bags, m + ": concrete moved");
  }
});

test("NO COUNT MOVED: the gate area's posts still add up to gatePosts, and a WALL hinge still takes no concrete", () => {
  for (const m of ["LINE", "WALL", "LINE_TO_WALL"]) {
    const out = quote(m);
    const posts = out.runs[0].posts;
    // Every post-ish role the takeoff asks for, less the run's own ends, is the gate's share.
    const asked = entryQty(out, "GATE_POST") + entryQty(out, "BLANK_POST") + entryQty(out, "END_POST");
    assert.equal(asked - posts.end, posts.gate,
      m + ": the gate area builds a different number of posts than computePostCounts bills caps for");
  }
  // A wall gate's hinge side is set in nothing: 1 bag for the latch, not 2.5 like a LINE gate.
  assert.equal(COUNTS.WALL[6], 1.0);
  assert.equal(billedQty(quote("WALL"), "CONCRETE_BAG"), 17);
  assert.equal(billedQty(quote("LINE"), "CONCRETE_BAG"), 19);
  // CONTROL: the same reader DOES see concrete change when the mounting changes, so 17 is a
  // measurement and not a constant this test cannot move.
  assert.notEqual(billedQty(quote("WALL"), "CONCRETE_BAG"), billedQty(quote("LINE"), "CONCRETE_BAG"));
});

test("NO COUNT MOVED: the takeoff summary lines are untouched, label for label", () => {
  // runOutput and PricingAdapters.kt read the post counts back off these labels, so a label that
  // moves breaks the parity contract on both sides. This change must not move one.
  const labels = quote("LINE_TO_WALL").runs[0].takeoff.map((t) => t.label);
  assert.ok(labels.includes("Gate posts (end posts + stiffener)"),
    "the gate-post takeoff label moved: index.ts runOutput and PricingAdapters.kt key on this exact string and 30 fixtures carry it");
  assert.ok(labels.includes("Total posts") && labels.includes("End posts"));
});

// ======================================== 3. ADDITIVITY WHERE A GATE_POST ROW EXISTS ==

test("ADDITIVITY: with a GATE_POST row at the end post's price -- his catalog, and the seed -- the grand total does not move a penny", () => {
  // The comparison is against the SAME catalog with the gate post removed and the fallback
  // modelled (block 6), which is exactly what 2026.10.3 billed: the END_POST row, for all of them.
  for (const m of ["LINE", "WALL", "LINE_TO_WALL"]) {
    const now = quote(m);
    const asItWas = quote(m, modelFallback(without(CATALOG, "GATE_POST")));
    assert.equal(now.totals.grand_total, asItWas.totals.grand_total,
      m + ": the grand total moved on a catalog whose gate post costs what its end post costs");
    assert.equal(now.totals.materials_subtotal, asItWas.totals.materials_subtotal, m + ": materials moved");
    assert.equal(now.totals.tax, asItWas.totals.tax, m + ": tax moved");
    // Same money, same number of posts -- what changed is that one line became two.
    assert.equal(billedQty(now, "GATE_POST") + billedQty(now, "END_POST"),
      billedQty(asItWas, "GATE_POST") + billedQty(asItWas, "END_POST"), m + ": a post appeared or vanished");
  }
  // THE SPLIT IS THE CHANGE, stated rather than hidden: a LINE gate used to bill one END_POST
  // line of 4; it then billed END_POST 2 + GATE_POST 2, and since 5 Oct 2026 it bills
  // END_POST 3 + GATE_POST 1 -- the hinge post carries the gate, the latch post is one more
  // post the fence ends on. Still four posts, still both off the same $16.56 row, so the
  // grand total above is unmoved and only the labelling differs.
  const line = quote("LINE");
  assert.equal(itemOf(line, "END_POST").quantity, 3);
  assert.equal(itemOf(line, "GATE_POST").quantity, 1);
  assert.equal(itemOf(line, "END_POST").unit_price, itemOf(line, "GATE_POST").unit_price);
});

// HIS CATALOG, not a stand-in. Every vinyl post row he actually has, read 1 Oct 2026 by a
// read-only SELECT (company aba5b097-...). Four GATE_POST rows and three END_POST rows, two
// suppliers plus the seed's own. The prices are his; heights are his height_ft column.
const HIS_VINYL_POSTS = [
  // role,        name,                                                 price,   height
  ["END_POST", '5"x5" Co-Ex End Post, White', 16.56, 6],
  ["END_POST", "5\"x5\" Co-Ex Utility Post White 8.5' - End (Flori)", 16.56, 6],
  ["END_POST", "5x5x72 HFS End Post White 4' Closed Top", 16.75, 4],
  ["END_POST", "5x5x102 HFS End Post White 1.75 6' Privacy", 19.0, 6],
  ["GATE_POST", "5\"x5\" Co-Ex Utility Post White 8.5' - Blank (Flori)", 16.56, 6],
  ["GATE_POST", '5"x5" Co-Ex Gate Post, White', 16.56, 6],
  ["GATE_POST", "5x5x72 HFS Blank Post White 4' Closed Top", 16.75, 4],
  ["GATE_POST", "5x5x102 HFS Blank Post White 6' Privacy", 19.0, 6],
].map(([role, name, unit_price, height_ft]) => ({ name, category: "POST", role, unit_price, color_or_finish: "White", height_ft }));
/** CATALOG with his real end-post and gate-post rows in place of the single ones above. */
const HIS_CATALOG = without(without(CATALOG, "END_POST"), "GATE_POST").concat(HIS_VINYL_POSTS);

test("HIS CATALOG: with all four of his GATE_POST rows and all three of his END_POST rows, his total does not move", () => {
  // Every pairing of his blank/gate post against his end post of the same height is the same
  // money, which is WHY nothing moves. Listed so the day a supplier re-prices one, this says so.
  for (const h of [4, 6]) {
    const cheapest = (role) => Math.min(...HIS_VINYL_POSTS.filter((r) => r.role === role && r.height_ft === h).map((r) => r.unit_price));
    assert.equal(cheapest("GATE_POST"), cheapest("END_POST"),
      h + " ft: his cheapest gate post and cheapest end post no longer cost the same. This change now MOVES his quotes -- re-measure before shipping.");
  }
  for (const m of ["LINE", "WALL", "LINE_TO_WALL"]) {
    const now = quote(m, HIS_CATALOG);
    const asItWas = quote(m, modelFallback(without(HIS_CATALOG, "GATE_POST")));
    assert.equal(now.totals.grand_total, asItWas.totals.grand_total,
      m + ": HIS grand total moved");
    // the 6 ft run picks a 6 ft post on every role, at $16.56, not the 4 ft row and not the $19 one.
    // WAS: GATE_POST and END_POST on all three mountings. NOW: a wall gate carries his gate-post
    // row under BLANK_POST instead (changes D and E), so the role to read differs by mounting --
    // the price asserted is the same $16.56 either way.
    const gatePostRole = m === "WALL" ? "BLANK_POST" : "GATE_POST";
    assert.equal(itemOf(now, gatePostRole).unit_price, 16.56, m + ": his gate post was billed at the wrong price");
    assert.equal(itemOf(now, "END_POST").unit_price, 16.56, m + ": his end post was billed at the wrong price");
  }
  // CONTROL: the same comparison DOES see a move when one of his gate-post rows is re-priced,
  // so "his total does not move" is a measurement and not a tautology.
  const dearer = HIS_CATALOG.map((r) => (r.role === "GATE_POST" ? { ...r, unit_price: r.unit_price + 5 } : r));
  assert.notEqual(quote("LINE", dearer).totals.grand_total, quote("LINE", HIS_CATALOG).totals.grand_total);
});

// ================================================================ 4. THE TEETH ==

test("THE TEETH: price the GATE_POST row differently and the quote DOES move, by exactly the gate posts times the difference", () => {
  // n is how many posts bill off the GATE_POST row. WALL reaches it through
  // the BLANK_POST fallback; the two LINE mountings each hang their gate on
  // ONE gate post since 5 Oct 2026, the latch post having become an end post.
  for (const [m, n] of [["WALL", 1], ["LINE", 1], ["LINE_TO_WALL", 1]]) {
    const base = quote(m);
    const dearer = quote(m, replacePrice(CATALOG, "GATE_POST", 26.56)); // +$10 a post
    const moved = money(dearer.totals.grand_total - base.totals.grand_total);
    assert.equal(moved, money(n * 10 * 1.07), m + ": a dearer gate post did not reach the quote (markup 0%, tax 7%)");
    assert.ok(moved > 0, m + ": the direction is wrong");
  }
  // And this is the whole point of the change: under 2026.10.3 the same edit moved NOTHING,
  // because no estimate could reach a GATE_POST row at all. Modelled by removing it, which is
  // what the old engine effectively did to every one of the owner's ten rows.
  const blind = quote("LINE", modelFallback(without(CATALOG, "GATE_POST")));
  const blindDearer = quote("LINE", modelFallback(without(replacePrice(CATALOG, "GATE_POST", 26.56), "GATE_POST")));
  assert.equal(blind.totals.grand_total, blindDearer.totals.grand_total,
    "control: with no reachable GATE_POST row, its price cannot matter -- that was the bug");
});

// ============================ 5. THE MISSING HALF: NO GATE_POST ROW LOSES THE POSTS ==

// STILL TRUE, and still the whole risk: the fallback that landed is BLANK_POST -> GATE_POST
// (change E), NOT GATE_POST -> END_POST. So a company with no GATE_POST row still loses the gate
// posts of a LINE or LINE_TO_WALL gate outright, and nothing on the estimate looks wrong.
// WALL has LEFT this loop, because change (D) means a wall gate asks for no gate post at all --
// there is nothing for it to lose. What WALL loses with no GATE_POST row is its BLANK_POST, and
// that is asserted separately below (and in a58's "NO CHAINING").
test("THE MISSING HALF: a catalog with NO GATE_POST row loses the gate posts of a LINE gate outright -- the GATE_POST fallback has NOT landed", () => {
  const bare = without(CATALOG, "GATE_POST");
  // ONE post apiece since 5 Oct 2026, not two: each LINE mounting now hangs
  // its gate on a single GATE_POST, and the latch post bills off END_POST --
  // which this catalog still has, so only the hinge post goes missing.
  for (const [m, lost] of [["LINE", 1], ["LINE_TO_WALL", 1]]) {
    const out = quote(m, bare);
    assert.ok(unmatchedOf(out).includes("GATE_POST"),
      m + ": GATE_POST is no longer reported unmatched. If the role preference has LANDED in " +
      "buildLineItems (line-items.ts and EstimateEngine.kt), this whole block is stale -- delete it " +
      "and turn block 6's reference model into an assertion against the engine itself.");
    assert.equal(billedQty(out, "GATE_POST"), 0, m + ": a GATE_POST line was billed with no row to bill");
    // and the posts really are GONE from the order, not merely renamed
    const withRow = quote(m, CATALOG);
    assert.equal(billedQty(withRow, "GATE_POST") - billedQty(out, "GATE_POST"), lost,
      m + ": " + lost + " post(s) should be missing from this estimate");
    assert.ok(out.totals.grand_total < withRow.totals.grand_total,
      m + ": the estimate is SHORT and nothing on it looks wrong");
  }
  // THE SIZE OF IT, on his own prices: $16.56 a post, before markup, with 7% tax.
  // One post now rather than two, so half what it was.
  assert.equal(money(1 * 16.56 * 1.07), 17.72);
  // WALL, the case that left the loop: no gate post is ASKED for, so none is lost -- but the
  // blank post that borrows that row is, and it is reported under its own name.
  const wall = quote("WALL", bare);
  assert.equal(entryQty(wall, "GATE_POST"), 0, "WALL asks for a gate post again");
  assert.deepEqual(unmatchedOf(wall), ["BLANK_POST"], "WALL: with no gate post to borrow, the blank post must be named");
  assert.equal(billedQty(wall, "BLANK_POST"), 0, "WALL: a blank post was billed with no row to bill");
  assert.ok(wall.totals.grand_total < quote("WALL", CATALOG).totals.grand_total,
    "WALL: the estimate is SHORT and nothing on it looks wrong");
  assert.equal(money(quote("WALL", CATALOG).totals.grand_total - wall.totals.grand_total), 17.72,
    "WALL: one post at $16.56 plus 7% tax");
});

// ======================= 6. THE DESIGNED FALLBACK, AS A REFERENCE MODEL (NOT THE ENGINE) ==

/**
 * The fallback the matcher must do, modelled HERE because line-items.ts and
 * EstimateEngine.buildLineItems are held by another wave.
 *
 * The engine does NOT do this. In buildLineItems it is one line: when a GATE_POST entry has no
 * candidates, use the END_POST candidates instead -- `candidatesByRole.get("END_POST")`, before
 * the colour, manufacturer and height filters, so the gate post is then chosen among end posts
 * by exactly the rules an end post is chosen by. Modelled by handing the catalog a GATE_POST
 * copy of each END_POST row, which produces the identical candidate set and so the identical
 * choice; the only thing it cannot model is the sync-id tie-break between two rows at one price,
 * which cannot bite here because the copies are of the same rows.
 */
function modelFallback(rows) {
  if (rows.some((r) => r.role === "GATE_POST")) return rows;
  const ends = rows.filter((r) => r.role === "END_POST");
  if (ends.length === 0) return rows;
  return rows.concat(ends.map((r) => ({ ...r, role: "GATE_POST" })));
}

test("THE FALLBACK, modelled: a catalog with no GATE_POST row prices EXACTLY as 2026.10.3 did -- item for item, penny for penny", () => {
  const bare = without(CATALOG, "GATE_POST");
  // WALL has left this loop for the same reason as block 5: change (D) means it asks for no gate
  // post, so there is no GATE_POST line for the model to produce. It is still checked below, for
  // the thing the model DOES reach there -- the blank post.
  for (const m of ["LINE", "LINE_TO_WALL"]) {
    const fixed = quote(m, modelFallback(bare));
    // the gate post is billed off the END_POST row, by name and by price
    const gp = itemOf(fixed, "GATE_POST");
    assert.ok(gp !== undefined, m + ": the model did not produce a gate-post line");
    assert.equal(gp.description, '5"x5" Co-Ex End Post, White', m + ": the fallback chose some other row");
    assert.equal(gp.unit_price, 16.56);
    assert.deepEqual(unmatchedOf(fixed), [], m + ": something is still unmatched");

    // and the money is the money a catalog WITH a gate post at the same price produces
    const withRow = quote(m, CATALOG);
    assert.equal(fixed.totals.grand_total, withRow.totals.grand_total,
      m + ": the modelled fallback does not reproduce the gate-post-present quote");
    // no post lost, none gained
    assert.equal(billedQty(fixed, "GATE_POST") + billedQty(fixed, "END_POST"),
      billedQty(withRow, "GATE_POST") + billedQty(withRow, "END_POST"),
      m + ": the post total under the fallback is wrong");
  }
  // WALL, the case that left the loop. Its blank post borrows whatever GATE_POST rows exist, so
  // under the model it borrows the END_POST copies -- same row, same name, same money as the
  // gate-post-present quote. That is the same additivity claim, read through the role WALL uses.
  {
    const fixed = quote("WALL", modelFallback(bare));
    const withRow = quote("WALL", CATALOG);
    const bp = itemOf(fixed, "BLANK_POST");
    assert.ok(bp !== undefined, "WALL: the model left the blank post with nothing to bill");
    assert.equal(bp.description, '5"x5" Co-Ex End Post, White', "WALL: the fallback chose some other row");
    assert.equal(bp.unit_price, 16.56);
    assert.equal(itemOf(fixed, "GATE_POST"), undefined, "WALL: a gate-post line appeared on a mounting that asks for none");
    assert.deepEqual(unmatchedOf(fixed), [], "WALL: something is still unmatched");
    assert.equal(fixed.totals.grand_total, withRow.totals.grand_total,
      "WALL: the modelled fallback does not reproduce the gate-post-present quote");
    assert.equal(billedQty(fixed, "BLANK_POST") + billedQty(fixed, "END_POST"),
      billedQty(withRow, "BLANK_POST") + billedQty(withRow, "END_POST"),
      "WALL: the post total under the fallback is wrong");
  }
  // CONTROL: the model is inert where a GATE_POST row already exists, so block 3 and block 4 are
  // not quietly measuring the model instead of the catalog.
  assert.equal(modelFallback(CATALOG), CATALOG);
  assert.equal(modelFallback(without(CATALOG, "END_POST")).length, without(CATALOG, "END_POST").length,
    "with no end post to copy, the model must add nothing rather than invent a row");
});

// =================================== 6b. THE WALL GATE'S UNMATCHED ROLE: BLANK_POST ==

// RE-AIMED 2 Oct 2026. This block's subject was a HOLE: BLANK_POST was asked for on every wall
// gate and no catalog anywhere stocked one, so it was unmatched and billed nothing -- one post
// missing from every wall-gate estimate, with nothing on screen looking wrong.
//
// THE HOLE IS CLOSED (engine 2026.10.5, change E at the top of this file): a BLANK_POST entry
// with no BLANK_POST row is priced off the company's GATE_POST rows -- which is where two of his
// three blank-post SKUs are actually typed in. So the old assertions could only fail. Re-aimed
// onto the closure, keeping every tooth: that it fires, that the line still says BLANK_POST, that
// it names the row it really billed, that it does not chain any further, and that it is a
// PREFERENCE -- a real BLANK_POST row still wins. a58-blank-post-fallback is the full pin; this
// is the wall-gate-shaped half of it, kept here so block 6b cannot go quiet.
test("THE WALL GATE'S OTHER HOLE IS CLOSED: BLANK_POST is asked for, has no row of its own, and is billed off his GATE_POST row", () => {
  // Still asked for, on WALL only, exactly one.
  assert.equal(entryQty(quote("WALL"), "BLANK_POST"), 1, "the takeoff does ask for one");
  assert.equal(entryQty(quote("LINE"), "BLANK_POST"), 0, "control: a LINE gate needs no blank post");
  assert.ok(!CATALOG.some((r) => r.role === "BLANK_POST"),
    "this catalog grew a BLANK_POST row -- the assertions below no longer mean anything");

  // And now billed, off the gate post, under its OWN role and the row's real name.
  const bp = itemOf(quote("WALL"), "BLANK_POST");
  assert.ok(bp !== undefined, "the blank post is unmatched again -- the fallback of 2026.10.5 has gone");
  assert.equal(bp.quantity, 1);
  assert.equal(bp.unit_price, 16.56);
  assert.equal(bp.description, GATE_POST_ROW.name,
    "the line must name the row it ACTUALLY billed, not a blank-post product he does not stock");
  assert.equal(bp.role, "BLANK_POST", "the role was rewritten, so the quote no longer says which post this is");
  assert.deepEqual(unmatchedOf(quote("WALL")), [], "nothing should be left unmatched on a wall gate");

  // NO CHAINING: with neither a blank post nor a gate post, the role is named and bills nothing.
  // END_POST is NOT borrowed for it -- that pair is deliberately not in PRICING_FALLBACK_ROLE.
  const neither = quote("WALL", without(without(CATALOG, "GATE_POST"), "BLANK_POST"));
  assert.deepEqual(unmatchedOf(neither), ["BLANK_POST"], "the gap signal went quiet with nothing to bill");
  assert.equal(billedQty(neither, "BLANK_POST"), 0, "a blank post was billed off an end post -- the fallback chained");
  assert.ok(neither.items.some((i) => i.role === "END_POST"), "control: this catalog still has an end post to have chained to");

  // PREFERENCE, NOT REPLACEMENT: a company that does price its own blank post gets that row.
  const withBlank = quote("WALL", CATALOG.concat([
    { name: '5"x5" Co-Ex Blank Post, White', category: "POST", role: "BLANK_POST", unit_price: 11.11, color_or_finish: "White", height_ft: 6 },
  ]));
  assert.deepEqual(unmatchedOf(withBlank), []);
  assert.equal(itemOf(withBlank, "BLANK_POST").quantity, 1);
  assert.equal(itemOf(withBlank, "BLANK_POST").unit_price, 11.11, "his own blank post lost to the borrowed gate post");
  assert.equal(itemOf(withBlank, "BLANK_POST").description, '5"x5" Co-Ex Blank Post, White');

  // WHAT IT IS WORTH, on his own prices: one post per wall gate. Measured against the estimate
  // that has nothing to bill it off, which is what every wall gate looked like before 2026.10.5.
  assert.equal(money(16.56 * 1.07), 17.72);
  assert.equal(money(19.0 * 1.07), 20.33);
  assert.equal(money(quote("WALL").totals.grand_total - quote("WALL", without(CATALOG, "GATE_POST")).totals.grand_total),
    17.72, "the blank post the fallback recovers, measured: one post plus tax");
});
