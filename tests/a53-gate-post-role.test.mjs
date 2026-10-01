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
// WHAT THIS FILE PINS
//   1. THE ROLES, per mounting, and that they follow the physical build:
//        WALL          BLANK_POST 1 + GATE_POST 1      (hinge bolts to the wall; latch is a post)
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

test("harness: the real engine prices this catalog with nothing unmatched but the blank post, in every mounting", () => {
  for (const m of ["LINE", "WALL", "LINE_TO_WALL"]) {
    const out = quote(m);
    assert.equal(out.engine_version, PRICING_ENGINE_VERSION);
    assert.deepEqual(unmatchedOf(out), m === "WALL" ? ["BLANK_POST"] : [],
      m + ": something other than BLANK_POST is unmatched -- the catalog above is incomplete, fix it before reading any number here");
    assert.ok(out.totals.grand_total > 0, m + ": no money came out");
  }
});

// =============================================== 1. THE ROLES, PER MOUNTING ==

test("THE ROLES: a gate asks for GATE_POST, and only the post where the RUN terminates is an END_POST", () => {
  // WALL: the hinge side is the blank post bolted through; the latch side is a post at the
  // opening, so it is a gate post. END_POST here is the run's own two open ends, nothing else.
  const wall = quote("WALL");
  assert.equal(entryQty(wall, "GATE_POST"), 1, "WALL: the latch-side post is not a GATE_POST");
  assert.equal(entryQty(wall, "BLANK_POST"), 1, "WALL: the hinge side is still a blank post");
  assert.equal(entryQty(wall, "END_POST"), 2, "WALL: END_POST should now be the run's two ends alone");

  // LINE: both posts stand at the opening. Neither is an end of the fence.
  const line = quote("LINE");
  assert.equal(entryQty(line, "GATE_POST"), 2, "LINE: both gate posts should be GATE_POST");
  assert.equal(entryQty(line, "BLANK_POST"), 0, "LINE: nothing bolts to a wall here");
  assert.equal(entryQty(line, "END_POST"), 2, "LINE: END_POST should be the run's two ends alone");

  // LINE_TO_WALL: the gate's own two, plus the post where the rest of the run meets the wall.
  // That third one is a real end post -- 2 + 1, not 3.
  const ltw = quote("LINE_TO_WALL");
  assert.equal(entryQty(ltw, "GATE_POST"), 2, "LINE_TO_WALL: the gate's own two posts");
  assert.equal(entryQty(ltw, "END_POST"), 3, "LINE_TO_WALL: the run's two ends plus the one at the wall");

  // CONTROL: with no gate at all, nothing asks for a gate post and END_POST is the geometry's.
  const none = price(runRow(WHITE), CATALOG);
  assert.equal(entryQty(none, "GATE_POST"), 0, "control: a gateless run asks for a gate post");
  assert.equal(entryQty(none, "END_POST"), 2, "control: a gateless open run has two end posts");
});

test("THE ROLES reach the QUOTE, not just the takeoff: a priced GATE_POST line appears, off his own row", () => {
  for (const [m, n] of [["WALL", 1], ["LINE", 2], ["LINE_TO_WALL", 2]]) {
    const gp = itemOf(quote(m), "GATE_POST");
    assert.ok(gp !== undefined, m + ": no GATE_POST line on the quote");
    assert.equal(gp.quantity, n, m + ": wrong gate-post count on the quote");
    assert.equal(gp.description, GATE_POST_ROW.name, m + ": the gate post was billed off some other row");
    assert.equal(gp.unit_price, 16.56);
  }
  // CONTROL: this is new. Under 2026.10.3 no fence type, no mounting, no catalog produced one.
  assert.ok(PRICING_ENGINE_VERSION > "2026.10.3",
    "the engine version did not move: this change bills a different catalog row and is a formula change");
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
  // line of 4 and now bills END_POST 2 + GATE_POST 2, both off a $16.56 row.
  const line = quote("LINE");
  assert.equal(itemOf(line, "END_POST").quantity, 2);
  assert.equal(itemOf(line, "GATE_POST").quantity, 2);
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
    // the 6 ft run picks a 6 ft post on both roles, at $16.56, not the 4 ft row and not the $19 one
    assert.equal(itemOf(now, "GATE_POST").unit_price, 16.56, m + ": his gate post was billed at the wrong price");
    assert.equal(itemOf(now, "END_POST").unit_price, 16.56, m + ": his end post was billed at the wrong price");
  }
  // CONTROL: the same comparison DOES see a move when one of his gate-post rows is re-priced,
  // so "his total does not move" is a measurement and not a tautology.
  const dearer = HIS_CATALOG.map((r) => (r.role === "GATE_POST" ? { ...r, unit_price: r.unit_price + 5 } : r));
  assert.notEqual(quote("LINE", dearer).totals.grand_total, quote("LINE", HIS_CATALOG).totals.grand_total);
});

// ================================================================ 4. THE TEETH ==

test("THE TEETH: price the GATE_POST row differently and the quote DOES move, by exactly the gate posts times the difference", () => {
  for (const [m, n] of [["WALL", 1], ["LINE", 2], ["LINE_TO_WALL", 2]]) {
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

test("THE MISSING HALF: a catalog with NO GATE_POST row loses its gate posts outright -- the matcher fallback has NOT landed", () => {
  const bare = without(CATALOG, "GATE_POST");
  for (const [m, lost] of [["WALL", 1], ["LINE", 2], ["LINE_TO_WALL", 2]]) {
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
  assert.equal(money(2 * 16.56 * 1.07), 35.44);
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
  for (const m of ["LINE", "WALL", "LINE_TO_WALL"]) {
    const fixed = quote(m, modelFallback(bare));
    // the gate post is billed off the END_POST row, by name and by price
    const gp = itemOf(fixed, "GATE_POST");
    assert.ok(gp !== undefined, m + ": the model did not produce a gate-post line");
    assert.equal(gp.description, '5"x5" Co-Ex End Post, White', m + ": the fallback chose some other row");
    assert.equal(gp.unit_price, 16.56);
    assert.deepEqual(unmatchedOf(fixed), m === "WALL" ? ["BLANK_POST"] : [], m + ": something is still unmatched");

    // and the money is the money a catalog WITH a gate post at the same price produces
    const withRow = quote(m, CATALOG);
    assert.equal(fixed.totals.grand_total, withRow.totals.grand_total,
      m + ": the modelled fallback does not reproduce the gate-post-present quote");
    // no post lost, none gained
    assert.equal(billedQty(fixed, "GATE_POST") + billedQty(fixed, "END_POST"),
      billedQty(withRow, "GATE_POST") + billedQty(withRow, "END_POST"),
      m + ": the post total under the fallback is wrong");
  }
  // CONTROL: the model is inert where a GATE_POST row already exists, so block 3 and block 4 are
  // not quietly measuring the model instead of the catalog.
  assert.equal(modelFallback(CATALOG), CATALOG);
  assert.equal(modelFallback(without(CATALOG, "END_POST")).length, without(CATALOG, "END_POST").length,
    "with no end post to copy, the model must add nothing rather than invent a row");
});

// =================================== 6b. THE WALL GATE'S UNMATCHED ROLE: BLANK_POST ==

test("THE WALL GATE'S OTHER HOLE: BLANK_POST is asked for and NO catalog has a row -- unmatched before this change and after", () => {
  // Reproduced, and the role named: BLANK_POST, on WALL only.
  assert.deepEqual(unmatchedOf(quote("WALL")), ["BLANK_POST"]);
  assert.deepEqual(unmatchedOf(quote("LINE")), [], "control: a LINE gate needs no blank post, and reports none");
  assert.equal(entryQty(quote("WALL"), "BLANK_POST"), 1, "the takeoff does ask for one");
  assert.equal(billedQty(quote("WALL"), "BLANK_POST"), 0, "and nothing is billed for it");

  // It is NOT this change: removing the gate post entirely leaves BLANK_POST unmatched just the same.
  assert.ok(unmatchedOf(quote("WALL", modelFallback(without(CATALOG, "GATE_POST")))).includes("BLANK_POST"),
    "BLANK_POST is unmatched independently of the gate-post role change");

  // WHAT IT WOULD COST: one post per wall gate, at the price of the blank post he already has
  // typed in -- under GATE_POST, where two of the three rows are literally named "Blank Post".
  // Flori $16.56, Hartford 6' $19.00. Not fixed here: which row a BLANK_POST should bill is his
  // call, not a guess made in a takeoff.
  assert.equal(money(16.56 * 1.07), 17.72);
  assert.equal(money(19.0 * 1.07), 20.33);

  // CONTROL that the unmatched reader works at all: plant a blank post and it goes quiet.
  const withBlank = quote("WALL", CATALOG.concat([
    { name: '5"x5" Co-Ex Blank Post, White', category: "POST", role: "BLANK_POST", unit_price: 16.56, color_or_finish: "White", height_ft: 6 },
  ]));
  assert.deepEqual(unmatchedOf(withBlank), [], "control: with a BLANK_POST row nothing is unmatched");
  assert.equal(itemOf(withBlank, "BLANK_POST").quantity, 1);
  assert.equal(money(withBlank.totals.grand_total - quote("WALL").totals.grand_total), 17.72,
    "the cost of the missing blank post, measured: one post plus tax");
});
