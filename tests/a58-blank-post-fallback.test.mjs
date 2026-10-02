// a58-blank-post-fallback -- a BLANK_POST entry with no BLANK_POST row is priced off GATE_POST.
//
//   node --test tests/a58-blank-post-fallback.test.mjs            (no network, no writes)
//
// WHY. BLANK_POST has never existed in any catalog, anywhere. gateAreaEntries asks for one on
// every WALL-mounted gate -- the undrilled post the gate bolts through, drilled, plugged, not set
// in concrete -- and no company has ever had a row to bill it against. Verified by read-only
// SELECT on 1 Oct 2026: zero BLANK_POST rows in the owner's catalog (company aba5b097-...) and
// zero across every company, against a positive control of 10 GATE_POST rows and 128 rows of his
// in total. It is in none of the three starting catalogs either -- SeedData.kt,
// supabase_r20_seed_new_company_catalog.sql, and website/dashboard.html's embedded list -- while
// MaterialRole defines it and the catalog editor offers it ("Blank post (wall-hung gate)"). So it
// looked available and has never once been usable: the role landed in unmatched_roles, no line
// appeared, and every wall-gate estimate ever written was short one post.
//
// THE OWNER'S DECISION, 1 Oct 2026: wire BLANK_POST to fall back to the GATE_POST rows. He has
// those prices typed already and two of his four vinyl ones are literally named "Blank Post".
// He knows it raises every wall-gate quote and said go.
//
// WHAT THIS FILE PINS
//   1. THE FIX. A wall gate with no BLANK_POST row now bills one, off the GATE_POST row, and the
//      role leaves unmatched_roles.
//   2. PREFERENCE, NOT REPLACEMENT. A company that DOES price a BLANK_POST row still gets its own
//      row -- asserted in both directions, with the two rows at different prices so the
//      assertion can tell them apart.
//   3. IT IS NOT FREE, and by how much, measured with the real engine on HIS OWN rows for all
//      seven fence types.
//   4. IT IS INERT EVERYWHERE ELSE. No WALL gate, no change -- penny for penny, item for item.
//   5. IT DOES NOT CHAIN. No BLANK_POST row and no GATE_POST row still reports BLANK_POST
//      unmatched and bills nothing. (The other half -- GATE_POST falling back to END_POST -- is
//      deliberately NOT wired; see tests/a53-gate-post-role.test.mjs block 5.)
//   6. A BORROWED ROW IS STILL CHOSEN PROPERLY. Colour, manufacturer and height all still narrow
//      it, because the fallback swaps the candidate LIST and never the entry's role.
//   7. unmatched_roles STILL REPORTS A GENUINE GAP, and the line names the row it really billed.
//   8. THE SWEEP: every role the takeoff can emit against what the three seeds actually ship,
//      both directions, with a positive control that the sweep can see a hit at all.
//
// "BEFORE" IS MODELLED BY SUPPRESSING THE ROLE (FenceRun.suppressedRoles), which makes the
// takeoff stop asking for it. That reproduces the pre-2026.10.5 BILL exactly -- same lines, same
// sort order, same money -- and differs in exactly one way, stated rather than hidden: the old
// engine also put BLANK_POST into unmatched_roles, and a suppressed role never gets there. Every
// comparison below is on money and lines, never on that list.
//
// EVERY NEGATIVE HAS A POSITIVE CONTROL beside it, produced by the same code on a planted case.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPricingInput } from "../supabase/functions/_shared/pricing/load.ts";
import { PRICING_ENGINE_VERSION, priceJob } from "../supabase/functions/_shared/pricing/index.ts";

// ============================================================ the real engine ==
const JOB_SYNC = "a5800000-0000-4000-8000-000000000001";
const RUN_SYNC = "a5800000-0000-4000-8000-000000000002";

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
  sync_id: "a5800000-0000-4000-8000-" + String(100 + i).padStart(12, "0"),
  name: r.name, category: r.category ?? "MISC", role: r.role, fence_type: r.fence_type ?? "VINYL",
  color_or_finish: r.color_or_finish ?? "", unit: r.unit ?? "EA", unit_price: r.unit_price, taxable: true,
  covers_ft: r.covers_ft ?? null, height_ft: r.height_ft ?? null, manufacturer_sync_id: null, is_active: true,
}));
const price = (run, rows, job = {}) => priceJob(buildPricingInput({
  job: jobRow(job), runs: [run], catalog: dbRows(rows), manufacturers: [], changeOrders: [], existingItems: [],
  engineVersion: PRICING_ENGINE_VERSION,
}));
const itemOf = (out, role) => out.items.find((i) => i.role === role);
const entryQty = (out, role) => out.runs[0].entries
  .filter((e) => e.role === role).reduce((s, e) => s + e.quantity, 0);
const billedQty = (out, role) => out.items
  .filter((i) => i.role === role).reduce((s, i) => s + i.quantity, 0);
const unmatchedOf = (out) => out.unmatched_roles.map((u) => u.role).sort();
const money = (n) => Math.round(n * 100) / 100;
/** Every line as a comparable tuple, so "item for item" means item for item. */
const linesOf = (out) => out.items
  .map((i) => [i.role, i.description, i.quantity, i.unit_price, i.sort_order].join("|")).sort();

// ======================================================= the catalog, as he has it ==
// A complete vinyl catalog so nothing goes unmatched by accident and a total means something.
// Post prices and heights are the owner's own, read 1 Oct 2026 (company aba5b097-...).
// BLANK_POST is absent, because no catalog anywhere has one -- that is the whole subject here.
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
const GATE = { LINE: "500.0:0.0:4.0:LINE:IN", WALL: "500.0:0.0:5.0:WALL:IN", LINE_TO_WALL: "500.0:0.0:6.0:LINE_TO_WALL:IN" };
const WHITE = { color_or_finish: "White" };
/** One gate of the named mounting, on a 100 ft open run with no corners. */
const quote = (mounting, rows = CATALOG, run = {}, job = {}) =>
  price(runRow({ ...WHITE, gates_encoded: GATE[mounting], ...run }), rows, job);
/** The same quote as the engine billed it BEFORE this change: the role simply never asked for. */
const asItWas = (mounting, rows = CATALOG, run = {}, job = {}) =>
  quote(mounting, rows, { suppressed_roles: "BLANK_POST", ...run }, job);

test("harness: the engine is at the version this file is about, and prices this catalog with nothing unmatched", () => {
  assert.equal(PRICING_ENGINE_VERSION, "2026.10.5",
    "the engine version moved without this file moving -- re-read it before trusting a number below");
  for (const m of ["LINE", "WALL", "LINE_TO_WALL"]) {
    const out = quote(m);
    assert.equal(out.engine_version, PRICING_ENGINE_VERSION);
    assert.deepEqual(unmatchedOf(out), [],
      m + ": something is unmatched -- the catalog above is incomplete, fix it before reading any number here");
    assert.ok(out.totals.grand_total > 0, m + ": no money came out");
  }
  // and the model of "before" really does remove the blank post and nothing else
  assert.equal(entryQty(asItWas("WALL"), "BLANK_POST"), 0, "the model did not suppress the role");
  assert.equal(entryQty(quote("WALL"), "BLANK_POST"), 1, "the takeoff stopped asking for a blank post");
  assert.equal(entryQty(asItWas("WALL"), "GATE_POST"), 1, "the model suppressed more than the one role");
  assert.equal(entryQty(asItWas("WALL"), "HOLE_PLUG"), entryQty(quote("WALL"), "HOLE_PLUG"), "the model moved the hole plugs");
  assert.equal(entryQty(asItWas("WALL"), "CONCRETE_BAG"), entryQty(quote("WALL"), "CONCRETE_BAG"), "the model moved the concrete");
});

// ================================================================= 1. THE FIX ==

test("THE FIX: a wall gate with no BLANK_POST row now bills one, off the GATE_POST row", () => {
  const out = quote("WALL");
  const line = itemOf(out, "BLANK_POST");
  assert.ok(line !== undefined, "no BLANK_POST line was billed -- the fallback did not fire");
  assert.equal(line.quantity, 1, "a wall gate takes exactly one blank post");
  assert.equal(line.unit_price, 16.56, "the blank post was billed at some other price");
  assert.equal(line.description, '5"x5" Co-Ex Gate Post, White',
    "the line must name the row it ACTUALLY billed, not a product he does not stock");
  assert.equal(line.role, "BLANK_POST", "the role itself must not be rewritten -- the quote still knows which post this is");
  // and the role has left the gap list, because something really was billed for it
  assert.ok(!unmatchedOf(out).includes("BLANK_POST"), "BLANK_POST is still reported as having nothing priced for it");
  // CONTROL: this is new. The same quote without the role asked for has no such line.
  assert.equal(itemOf(asItWas("WALL"), "BLANK_POST"), undefined);
});

// ============================================== 2. PREFERENCE, NOT REPLACEMENT ==

const BLANK_ROW = { name: '5"x5" Co-Ex Blank Post, White', category: "POST", role: "BLANK_POST", unit_price: 11.11, color_or_finish: "White", height_ft: 6 };

test("PREFERENCE, NOT REPLACEMENT: a company that prices its own BLANK_POST row gets that row, not the gate post", () => {
  // Priced DELIBERATELY differently from the gate post, so the assertion can tell which row won.
  const own = quote("WALL", CATALOG.concat([BLANK_ROW]));
  assert.equal(itemOf(own, "BLANK_POST").description, '5"x5" Co-Ex Blank Post, White', "the fallback overrode a real row");
  assert.equal(itemOf(own, "BLANK_POST").unit_price, 11.11, "the real row's own price was not used");
  // the other direction, same catalog minus the real row: now the gate post carries it
  const borrowed = quote("WALL", CATALOG);
  assert.equal(itemOf(borrowed, "BLANK_POST").unit_price, 16.56);
  assert.notEqual(itemOf(own, "BLANK_POST").unit_price, itemOf(borrowed, "BLANK_POST").unit_price,
    "both directions produced the same price -- this test cannot tell preference from replacement");
  // and a real BLANK_POST row wins even with no GATE_POST row to fall back to at all
  const noGatePost = without(CATALOG, "GATE_POST").concat([BLANK_ROW]);
  assert.equal(itemOf(quote("WALL", noGatePost), "BLANK_POST").unit_price, 11.11);
});

// ==================================================== 3. IT IS NOT FREE ==

test("THE PRICE: every wall-gate quote goes UP by exactly one gate post plus tax, and the direction is up", () => {
  const now = quote("WALL");
  const before = asItWas("WALL");
  const moved = money(now.totals.grand_total - before.totals.grand_total);
  assert.equal(moved, money(16.56 * 1.07), "the move is not one post plus 7% tax");
  assert.equal(moved, 17.72, "the measured cost of this change on his vinyl rows");
  assert.ok(moved > 0, "the direction is wrong -- this change can only ever raise a wall-gate quote");
  // one post, not two, and nothing else on the order moved
  assert.equal(billedQty(now, "BLANK_POST") - billedQty(before, "BLANK_POST"), 1);
  assert.equal(billedQty(now, "GATE_POST"), billedQty(before, "GATE_POST"), "the gate post count moved");
  assert.equal(billedQty(now, "POST_CAP"), billedQty(before, "POST_CAP"), "the post caps moved");
  assert.equal(billedQty(now, "CONCRETE_BAG"), billedQty(before, "CONCRETE_BAG"), "the concrete moved -- a wall-hung hinge takes none");
  assert.equal(billedQty(now, "HOLE_PLUG"), billedQty(before, "HOLE_PLUG"), "the hole plugs moved");
  assert.equal(now.items.length, before.items.length + 1, "more than one line appeared");
  // with markup on, the same post is marked up like everything else
  const withMarkup = money(quote("WALL", CATALOG, {}, { markup_percent: 20 }).totals.grand_total
    - asItWas("WALL", CATALOG, {}, { markup_percent: 20 }).totals.grand_total);
  assert.equal(withMarkup, money(16.56 * 1.07 * 1.2), "the post is not being marked up with the rest of the job");
});

// HIS ROWS, not a stand-in: the GATE_POST row he has for each fence type, read 1 Oct 2026 by a
// read-only SELECT (company aba5b097-...). This is what the change costs him per wall gate.
const HIS_GATE_POSTS = [
  // fence type,       name,                                          price, height
  ["VINYL", '5"x5" Co-Ex Gate Post, White', 16.56, 6],
  ["VINYL", "5\"x5\" Co-Ex Utility Post White 8.5' - Blank (Flori)", 16.56, 6],
  ["VINYL", "5x5x72 HFS Blank Post White 4' Closed Top", 16.75, 4],
  ["VINYL", "5x5x102 HFS Blank Post White 6' Privacy", 19.0, 6],
  ["WOOD", "4x4x8' Pressure-Treated Post", 9.5, null],
  ["CHAIN_LINK", "2\" Galvanized Terminal Post, 8'", 19.75, null],
  ["ALUMINUM", "3\" Aluminum Post, 6', Black", 22.0, null],
  ["ORNAMENTAL_IRON", '4"x4" Steel Post, 6\', Black', 32.0, null],
  ["SPLIT_RAIL", "5\" Round Wood Post, 7'", 14.0, null],
  ["COMPOSITE", "4x4 Composite Post w/ Aluminum Insert, 8'", 28.0, null],
];

test("HIS CATALOG, per fence type: what the change costs him on a wall gate, measured with the real engine", () => {
  // A minimal catalog per type -- just the gate post, so the measurement is of THAT row and
  // nothing else. Every other role goes unmatched, which is fine here: an unmatched role bills
  // nothing on both sides of the comparison, so the difference is the blank post alone.
  // Every figure here came OUT of the engine, not out of a calculator. Three of the seven are a
  // cent off the row times 1.07, and that is the engine being right rather than wrong: tax is
  // taken on the whole taxable subtotal and each grand total is rounded to the cent, so the
  // DIFFERENCE of two totals can land either side of the per-line arithmetic.
  const expected = {
    VINYL: 17.72, WOOD: 10.16, CHAIN_LINK: 21.14,
    ALUMINUM: 23.54, ORNAMENTAL_IRON: 34.24, SPLIT_RAIL: 14.98, COMPOSITE: 29.96,
  };
  for (const [ft, cost] of Object.entries(expected)) {
    const rows = HIS_GATE_POSTS.filter(([t]) => t === ft)
      .map(([, name, unit_price, height_ft]) => ({ name, category: "POST", role: "GATE_POST", fence_type: ft, unit_price, height_ft, color_or_finish: ft === "VINYL" ? "White" : "" }));
    assert.ok(rows.length > 0, ft + ": no gate post row of his for this type -- the fixture list is wrong");
    const run = { fence_type: ft, color_or_finish: ft === "VINYL" ? "White" : "" };
    const moved = money(quote("WALL", rows, run).totals.grand_total - asItWas("WALL", rows, run).totals.grand_total);
    assert.equal(moved, cost, ft + ": the cost of this change on his own row for this type has moved");
    assert.ok(moved > 0, ft + ": the direction is wrong");
    // and it really is the row's price plus tax, re-derived rather than copied from the table --
    // to the cent, for the rounding reason above
    const billed = itemOf(quote("WALL", rows, run), "BLANK_POST").unit_price;
    // Compared in whole cents: |21.14 - 21.13| is 0.010000000000001563 as a double, so a
    // "<= 0.01" on the subtraction fails on float dust rather than on money.
    assert.ok(Math.round(Math.abs(moved - money(billed * 1.07)) * 100) <= 1,
      ft + ": the move (" + moved + ") is not that row's price plus 7% tax (" + money(billed * 1.07) + ")");
  }
  // 4 ft vinyl takes his 4 ft row, which costs MORE than the 6 ft one
  const vinylRows = HIS_GATE_POSTS.filter(([t]) => t === "VINYL")
    .map(([, name, unit_price, height_ft]) => ({ name, category: "POST", role: "GATE_POST", unit_price, height_ft, color_or_finish: "White" }));
  const four = { color_or_finish: "White", panel_height_ft: 4 };
  assert.equal(money(quote("WALL", vinylRows, four).totals.grand_total - asItWas("WALL", vinylRows, four).totals.grand_total),
    17.93, "the 4 ft vinyl figure has moved");
  // CONTROL: the measurement responds to the price. Double his vinyl rows and the cost doubles.
  const vinyl = HIS_GATE_POSTS.filter(([t]) => t === "VINYL")
    .map(([, name, unit_price, height_ft]) => ({ name, category: "POST", role: "GATE_POST", unit_price: unit_price * 2, height_ft, color_or_finish: "White" }));
  const run = { color_or_finish: "White" };
  assert.equal(money(quote("WALL", vinyl, run).totals.grand_total - asItWas("WALL", vinyl, run).totals.grand_total),
    money(2 * 16.56 * 1.07), "control: the cost does not follow the row's price");
});

test("MORE THAN ONE WALL GATE: the cost is per gate", () => {
  // decodeGates splits on COMMA, not semicolon -- a semicolon here parses as one gate with a
  // junk width and the test passes for the wrong reason.
  const two = { gates_encoded: GATE.WALL + ",700.0:0.0:5.0:WALL:IN" };
  const now = quote("WALL", CATALOG, two);
  const before = asItWas("WALL", CATALOG, two);
  assert.equal(entryQty(now, "BLANK_POST"), 2, "two wall gates do not ask for two blank posts");
  assert.equal(billedQty(now, "BLANK_POST"), 2, "two wall gates bill one blank post line of 2");
  assert.equal(money(now.totals.grand_total - before.totals.grand_total), money(2 * 16.56 * 1.07));
});

// ==================================== 4. INERT EVERYWHERE ELSE ==

test("INERT: a quote with no WALL gate is identical -- item for item, penny for penny", () => {
  for (const m of ["LINE", "LINE_TO_WALL"]) {
    const now = quote(m);
    const before = asItWas(m);
    assert.equal(entryQty(now, "BLANK_POST"), 0, m + ": this mounting should never ask for a blank post");
    assert.equal(now.totals.grand_total, before.totals.grand_total, m + ": the grand total moved");
    assert.equal(now.totals.materials_subtotal, before.totals.materials_subtotal, m + ": materials moved");
    assert.equal(now.totals.tax, before.totals.tax, m + ": tax moved");
    assert.deepEqual(linesOf(now), linesOf(before), m + ": a line changed");
  }
  // a run with no gate at all
  const plain = price(runRow(WHITE), dbRows(CATALOG));
  const plainBefore = price(runRow({ ...WHITE, suppressed_roles: "BLANK_POST" }), dbRows(CATALOG));
  assert.equal(plain.totals.grand_total, plainBefore.totals.grand_total, "a gateless run moved");
  assert.deepEqual(linesOf(plain), linesOf(plainBefore), "a gateless run's lines moved");
  // CONTROL: the same comparison DOES see the WALL gate move, so "identical" is a measurement
  assert.notEqual(quote("WALL").totals.grand_total, asItWas("WALL").totals.grand_total,
    "control: the comparison above cannot detect a change at all");
});

// ========================================================= 5. IT DOES NOT CHAIN ==

test("NO CHAINING: with neither a BLANK_POST row nor a GATE_POST row, the role is still unmatched and bills nothing", () => {
  const bare = without(CATALOG, "GATE_POST");
  const out = quote("WALL", bare);
  assert.ok(unmatchedOf(out).includes("BLANK_POST"),
    "BLANK_POST resolved with no GATE_POST row in the catalog -- the fallback is chaining to END_POST, which it must not");
  assert.equal(billedQty(out, "BLANK_POST"), 0, "a BLANK_POST line was billed with no row to bill it against");
  // it is NOT quietly buying an end post instead, which the catalog does still have
  assert.equal(billedQty(out, "END_POST"), billedQty(asItWas("WALL", bare), "END_POST"),
    "the end post count moved -- something is being borrowed from END_POST");
  assert.equal(out.totals.grand_total, asItWas("WALL", bare).totals.grand_total,
    "money moved on a catalog with nothing to bill the blank post against");
  // CONTROL: put the gate post back and it resolves, so this is the absence of a row and not a dead test
  assert.ok(!unmatchedOf(quote("WALL", CATALOG)).includes("BLANK_POST"),
    "control: BLANK_POST is unmatched even WITH a gate post row -- the fallback is not firing at all");
});

// ======================================= 6. A BORROWED ROW IS STILL CHOSEN PROPERLY ==

test("THE BORROWED ROW IS STILL FILTERED: colour and height narrow it exactly as they narrow a real one", () => {
  // His four vinyl gate posts: three declare 6 ft ($16.56, $16.56, $19.00), one declares 4 ft ($16.75).
  const his = HIS_GATE_POSTS.filter(([t]) => t === "VINYL")
    .map(([, name, unit_price, height_ft]) => ({ name, category: "POST", role: "GATE_POST", unit_price, height_ft, color_or_finish: "White" }));
  const rows = without(CATALOG, "GATE_POST").concat(his);
  // HEIGHT: a 6 ft run takes a 6 ft row at the cheaper price, never the 4 ft row and never the $19 one
  const six = itemOf(quote("WALL", rows, { panel_height_ft: 6 }), "BLANK_POST");
  assert.equal(six.unit_price, 16.56, "a 6 ft run borrowed the wrong-height or dearer gate post");
  // and a 4 ft run takes the 4 ft row even though it costs MORE -- which is the height rule working
  const four = itemOf(quote("WALL", rows, { panel_height_ft: 4 }), "BLANK_POST");
  assert.equal(four.unit_price, 16.75, "a 4 ft run did not get the 4 ft row -- the height filter is not reaching a borrowed row");
  assert.equal(four.description, "5x5x72 HFS Blank Post White 4' Closed Top");
  assert.notEqual(six.unit_price, four.unit_price, "the two heights chose the same row -- this test cannot see the filter");
  // COLOUR: a Tan run with a Tan gate post takes the Tan one, not the cheaper White
  const tanRows = rows.concat([{ name: '5"x5" Co-Ex Gate Post, Tan', category: "POST", role: "GATE_POST", unit_price: 21.5, color_or_finish: "Tan", height_ft: 6 }]);
  const tan = itemOf(quote("WALL", tanRows, { color_or_finish: "Tan" }), "BLANK_POST");
  assert.equal(tan.unit_price, 21.5, "the run's colour did not reach the borrowed row");
  assert.equal(itemOf(quote("WALL", tanRows, { color_or_finish: "White" }), "BLANK_POST").unit_price, 16.56,
    "control: colour is being ignored in both directions");
  // PRICED BEATS UNPRICED, as on any other row: a $0 placeholder gate post does not carry the line
  const withZero = rows.concat([{ name: "Placeholder Gate Post", category: "POST", role: "GATE_POST", unit_price: 0, color_or_finish: "White", height_ft: 6 }]);
  assert.equal(itemOf(quote("WALL", withZero), "BLANK_POST").unit_price, 16.56, "a $0 placeholder carried the borrowed line");
  // and a catalog whose ONLY gate post is $0 reports it as zero-priced, by the name it billed
  const onlyZero = without(CATALOG, "GATE_POST").concat([{ name: "Placeholder Gate Post", category: "POST", role: "GATE_POST", unit_price: 0, color_or_finish: "White", height_ft: 6 }]);
  const zeroOut = quote("WALL", onlyZero);
  assert.equal(itemOf(zeroOut, "BLANK_POST").unit_price, 0);
  assert.ok(zeroOut.zero_priced_names.some((z) => z.name === "Placeholder Gate Post"),
    "a borrowed $0 row must still be reported as zero-priced -- otherwise a $0 blank post is invisible");
});

test("FENCE TYPE STILL SCOPES IT: a vinyl run does not borrow a wood gate post", () => {
  const woodOnly = without(CATALOG, "GATE_POST")
    .concat([{ name: "4x4x8' Pressure-Treated Post", category: "POST", role: "GATE_POST", fence_type: "WOOD", unit_price: 9.5 }]);
  const out = quote("WALL", woodOnly);
  assert.ok(unmatchedOf(out).includes("BLANK_POST"), "a vinyl run borrowed a WOOD gate post row");
  assert.equal(billedQty(out, "BLANK_POST"), 0);
  // CONTROL: the same row filed UNIVERSAL is reachable, so this is the fence-type filter and not a dead probe
  const universal = without(CATALOG, "GATE_POST")
    .concat([{ name: "Universal Gate Post", category: "POST", role: "GATE_POST", fence_type: "UNIVERSAL", unit_price: 9.5 }]);
  assert.equal(itemOf(quote("WALL", universal), "BLANK_POST").unit_price, 9.5);
  // and an INACTIVE gate post is not borrowed either
  const inactiveRows = dbRows(without(CATALOG, "GATE_POST")).concat(
    dbRows([GATE_POST_ROW]).map((r) => ({ ...r, sync_id: "a5800000-0000-4000-8000-000000000999", is_active: false })));
  const inactive = priceJob(buildPricingInput({
    job: jobRow(), runs: [runRow({ ...WHITE, gates_encoded: GATE.WALL })], catalog: inactiveRows,
    manufacturers: [], changeOrders: [], existingItems: [], engineVersion: PRICING_ENGINE_VERSION,
  }));
  assert.ok(unmatchedOf(inactive).map((r) => r).includes("BLANK_POST"), "an inactive gate post row was borrowed");
});

// ======================== 7. unmatched_roles STILL REPORTS A GENUINE GAP ==

test("THE GAP SIGNAL: a role that truly has nothing is still named, and the billed line names the row it used", () => {
  // Genuine gap: no gate post anywhere -> BLANK_POST is still reported, under its OWN name.
  // GATE_POST is in that list too and belongs there -- a wall gate asks for one of those as
  // well, and nothing is wired to fall back FOR it (see a53 block 5). Both named, neither hidden.
  assert.deepEqual(unmatchedOf(quote("WALL", without(CATALOG, "GATE_POST"))), ["BLANK_POST", "GATE_POST"]);
  // Other roles are unaffected: strip the latch and it is still reported.
  assert.deepEqual(unmatchedOf(quote("WALL", without(CATALOG, "LATCH"))), ["LATCH"],
    "the fallback is interfering with the gap list for other roles");
  // And where it DOES resolve, the quote tells the truth about what it bought: role BLANK_POST,
  // description the gate post row. It never claims a blank post product he does not stock.
  const line = itemOf(quote("WALL"), "BLANK_POST");
  assert.equal(line.description, GATE_POST_ROW.name);
  assert.ok(!CATALOG.some((r) => r.role === "BLANK_POST"),
    "this catalog grew a BLANK_POST row -- the assertion above no longer means anything");
});

// ============================================================= 8. THE SWEEP ==
//
// Every role the takeoff can emit against what the three starting catalogs actually ship, both
// directions. BLANK_POST was asked-for-and-never-stocked; GATE_POST was stocked-and-never-asked-for
// until 2026.10.4 closed it. This pins both lists so a new role cannot be added to one side alone.
const ROOT = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), "utf8");
const TYPES = ["VINYL", "WOOD", "CHAIN_LINK", "ALUMINUM", "ORNAMENTAL_IRON", "SPLIT_RAIL", "COMPOSITE"];
const FRAME_KIT = new Set(["WOOD", "CHAIN_LINK", "SPLIT_RAIL", "COMPOSITE"]);
/** Transcribed from takeoff.ts: the most any run of this type can ask for (all three gate mountings, every chain-link flag on). */
const BODY = {
  VINYL: ["PANEL", "LINE_POST", "CORNER_POST", "END_POST", "POST_CAP"],
  ALUMINUM: ["PANEL", "LINE_POST", "CORNER_POST", "END_POST", "POST_CAP"],
  ORNAMENTAL_IRON: ["PANEL", "LINE_POST", "CORNER_POST", "END_POST", "POST_CAP"],
  WOOD: ["WOOD_PICKET", "WOOD_RAIL", "LINE_POST", "CORNER_POST", "END_POST", "POST_CAP"],
  COMPOSITE: ["WOOD_PICKET", "WOOD_RAIL", "LINE_POST", "CORNER_POST", "END_POST", "POST_CAP"],
  SPLIT_RAIL: ["WOOD_RAIL", "LINE_POST", "CORNER_POST", "END_POST"],
  CHAIN_LINK: ["CHAIN_FABRIC", "LINE_POST", "CORNER_POST", "END_POST", "POST_CAP", "TENSION_BAND",
    "BRACE_BAND", "TOP_RAIL", "RAIL_END", "TENSION_WIRE", "BARBED_WIRE_ARM", "PRIVACY_SLAT"],
};
const askedBy = (t) => new Set([...BODY[t],
  FRAME_KIT.has(t) ? "GATE_FRAME_KIT" : "GATE_PANEL",
  "HINGE_SET", "LATCH", "HANDLE", "BRACE", ...(t === "VINYL" ? ["TRIM"] : []),
  "STIFFENER", "BLANK_POST", "GATE_POST", "HOLE_PLUG", "END_POST", "CONCRETE_BAG"]);
const ROLES = read("supabase/functions/_shared/pricing/types.ts")
  .match(/MATERIAL_ROLES = \[([\s\S]*?)\] as const/)[1].match(/"([A-Z_]+)"/g).map((s) => s.replaceAll('"', ""));

/** role -> fence types, per starting catalog. */
function seedMatrix(which) {
  const m = {};
  const add = (ft, role) => ((m[ft] ??= new Set()).add(role));
  if (which === "SeedData.kt") {
    let cur = null;
    for (const line of read("app/src/main/java/com/fenceestimator/app/data/SeedData.kt").split("\n")) {
      const t = line.match(/val t = FenceType\.([A-Z_]+)/);
      if (t) { cur = t[1]; continue; }
      const it = line.match(/item\(MaterialCategory\.[A-Z_]+, MaterialRole\.([A-Z_]+), (t|FenceType\.[A-Z_]+)/);
      if (it) add(it[2] === "t" ? cur : it[2].split(".")[1], it[1]);
    }
  } else if (which === "supabase_r20 seed") {
    for (const [, role, ft] of read("supabase_r20_seed_new_company_catalog.sql")
      .matchAll(/\(\s*'[A-Z_]+',\s*'([A-Z_]+)',\s*'([A-Z_]+)',\s*'/g)) add(ft, role);
  } else {
    for (const [, role, ft] of read("website/dashboard.html")
      .matchAll(/\{category:"[A-Z_]+",role:"([A-Z_]+)",fence_type:"([A-Z_]+)"/g)) add(ft, role);
  }
  return m;
}
const SEEDS = ["SeedData.kt", "supabase_r20 seed", "office dashboard.html"];

test("THE SWEEP, direction A: which roles the takeoff asks for that no starting catalog stocks", () => {
  const askedAnywhere = new Set(TYPES.flatMap((t) => [...askedBy(t)]));
  for (const which of SEEDS) {
    const m = seedMatrix(which);
    assert.ok(Object.keys(m).length >= TYPES.length, which + ": the parser found almost nothing -- it has stopped matching this file's shape");
    const stockedAnywhere = new Set(Object.values(m).flatMap((s) => [...s]));
    // Never stocked for ANY type: BLANK_POST, and only BLANK_POST.
    assert.deepEqual(ROLES.filter((r) => askedAnywhere.has(r) && !stockedAnywhere.has(r)), ["BLANK_POST"],
      which + ": the set of roles asked for and stocked nowhere has changed");
    // Per fence type. Vinyl is clean apart from the blank post; the other six are also missing
    // the three gate-hardware roles that are seeded for VINYL only -- stocked, but not for them.
    for (const t of TYPES) {
      const stocked = new Set([...(m[t] ?? []), ...(m.UNIVERSAL ?? [])]);
      const gap = [...askedBy(t)].filter((r) => !stocked.has(r)).sort();
      assert.deepEqual(gap, t === "VINYL" ? ["BLANK_POST"] : ["BLANK_POST", "BRACE", "HANDLE", "STIFFENER"],
        which + " / " + t + ": this type's missing roles have changed");
    }
  }
});

test("THE SWEEP, direction B: which roles the catalogs stock that the takeoff never asks for -- none, and the check can see one", () => {
  const askedAnywhere = new Set(TYPES.flatMap((t) => [...askedBy(t)]));
  // NONE is the hand-typed-extra role and is deliberately never emitted; it is also never seeded.
  assert.deepEqual(ROLES.filter((r) => !askedAnywhere.has(r)), ["NONE"],
    "a role has stopped being asked for by the takeoff");
  for (const which of SEEDS) {
    const stockedAnywhere = new Set(Object.values(seedMatrix(which)).flatMap((s) => [...s]));
    assert.deepEqual(ROLES.filter((r) => stockedAnywhere.has(r) && !askedAnywhere.has(r)), [],
      which + ": a role is stocked that nothing ever asks for -- unreachable inventory, the GATE_POST bug again");
  }
  // POSITIVE CONTROL: model the pre-2026.10.4 takeoff, which never asked for GATE_POST, and the
  // same check must name it. Without this, "[]" above could just as well mean the check is dead.
  const asked1043 = new Set([...askedAnywhere].filter((r) => r !== "GATE_POST"));
  for (const which of SEEDS) {
    const stockedAnywhere = new Set(Object.values(seedMatrix(which)).flatMap((s) => [...s]));
    assert.deepEqual(ROLES.filter((r) => stockedAnywhere.has(r) && !asked1043.has(r)), ["GATE_POST"],
      which + ": control -- the sweep cannot see a stocked-but-never-asked role even when one is planted");
  }
});

// ============================================== the two engines say the same thing ==

test("BOTH SIDES: the fallback table and its call site exist in Kotlin as well, with the same single entry", () => {
  const kt = read("app/src/main/java/com/fenceestimator/app/estimate/EstimateEngine.kt");
  const ts = read("supabase/functions/_shared/pricing/line-items.ts");
  // the table, one entry, same roles
  assert.match(kt, /private val PRICING_FALLBACK_ROLE: Map<MaterialRole, MaterialRole> = mapOf\(\s*MaterialRole\.BLANK_POST to MaterialRole\.GATE_POST\s*\)/,
    "EstimateEngine.kt's fallback table is missing or holds something else");
  assert.match(ts, /const PRICING_FALLBACK_ROLE: Partial<Record<MaterialRole, MaterialRole>> = \{\s*BLANK_POST: "GATE_POST",\s*\}/,
    "line-items.ts's fallback table is missing or holds something else");
  // exactly one entry each, so a role cannot be added to one side alone. Block comments are
  // stripped first: the doc comment above the table NAMES the pair that is deliberately not
  // wired (GATE_POST to END_POST), and counting that as code would make this assertion a lie.
  const ktCode = kt.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal((ktCode.match(/MaterialRole\.[A-Z_]+ to MaterialRole\.[A-Z_]+/g) ?? []).length, 1,
    "EstimateEngine.kt has more than one fallback pair -- the server side must match it");
  const tsEntries = ts.match(/const PRICING_FALLBACK_ROLE[^}]*\}/)[0].match(/^\s+[A-Z_]+: "[A-Z_]+",$/gm) ?? [];
  assert.equal(tsEntries.length, 1, "line-items.ts has more than one fallback pair -- the phone must match it");
  // the call site, in both, reading the table and falling through to unmatched
  assert.match(kt, /val fallbackRole = PRICING_FALLBACK_ROLE\[entry\.role\]\s*\n\s*if \(fallbackRole != null\) candidates = candidatesByRole\[fallbackRole\]\.orEmpty\(\)/,
    "EstimateEngine.kt's call site does not read the table the way line-items.ts does");
  assert.match(ts, /const fallbackRole = PRICING_FALLBACK_ROLE\[entry\.role\];\s*\n\s*if \(fallbackRole !== undefined\) candidates = candidatesByRole\.get\(fallbackRole\) \?\? \[\];/,
    "line-items.ts's call site does not read the table the way EstimateEngine.kt does");
  // and the version constant moved on both
  assert.match(kt, /const val PRICING_ENGINE_VERSION = "2026\.10\.5"/, "EstimateEngine.kt's engine version did not move");
  assert.equal(PRICING_ENGINE_VERSION, "2026.10.5");
});
