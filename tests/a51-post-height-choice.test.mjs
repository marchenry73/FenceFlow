// a51-post-height-choice -- a POST is now chosen for the height of fence it is FOR, not for being the cheapest.
//
// THE DEFECT, found by running the real engine against the owner's real 128-row catalog, 72 ft at SIX feet high:
//
//     LINE_POST  11  $13.18  "5\"x5\" Utility Post White 6' (Flori, 4ft run)"
//
//   That is the post Flori sells for a FOUR foot fence. It is six feet long, so on a six foot fence there is
//   nothing of it in the ground. THIS IS NOT A PRICING ERROR: a fence built on it falls over. The right row is
//   Flori's 8.5 ft Co-Ex at $16.56 or Hartford's 5x5x102 (102 in = 8.5 ft) at $19.00.
//
//   Why it happened: posts have NO width (covers_ft is null on every post row), so buildLineItems chose one by
//   colour, manufacturer, then price -- cheapest wins. The height-aware narrowing that shipped earlier the same
//   day (PRICING_ENGINE_VERSION 2026.10.2, tests/a40-height-engine.test.mjs) covered PANEL and GATE_PANEL only.
//   It became reachable the day both suppliers' posts were loaded: before that the owner held one post per role
//   and there was nothing to choose wrongly between.
//
// THE FIX, pinned here: the SAME step, with the post roles added to its role gate --
//   LINE_POST, END_POST, CORNER_POST, GATE_POST, BLANK_POST. Nothing else about the step moves.
//   On a POST, height_ft means THE FENCE HEIGHT THE POST IS FOR, not the post's own length (the length stays in
//   the product name, which no engine reads). The owner's rows were filled in by supabase_a50_post_heights.sql.
//
// WHAT THIS FILE HOLDS, each with a control or a mutant that must fail
//   1. HARNESS: the real engine prices a vinyl run and a LINE_POST line exists.
//   2. THE OWNER'S CASE, on rows transcribed from his live catalog: the 6 ft run takes a 6-ft-fence post, the
//      4 ft run keeps the $13.18 one, and his END_POST moves too. Before/after is shown by a reference model of
//      the old rule (cheapest priced row) that is first proved to reproduce the old engine.
//   3. ADDITIVITY, asserted and not implied: a catalog in which NO post declares a height prices IDENTICALLY at
//      every run height, and the post chosen is exactly the cheapest priced candidate -- which is what the rule
//      answered before this change. Control: with heights filled in, the same comparison DOES report a move.
//   4. NULL WIDTH GROUPS WITH NULL. The step narrows WITHIN a width, and a post has no width. `null === null` is
//      true in TypeScript and `null == null` is true in Kotlin (Intrinsics.areEqual), so every post of a role
//      falls into ONE group and the whole list narrows. Had null not equalled null the rule would have done
//      NOTHING for posts, silently. Measured, with a mutant that makes null unequal to null and must fail.
//   5. PER-WIDTH IS STILL LIVE for panels: a gate of another width is not hidden by a gate that declares the
//      run's height (the first draft did that and moved 3 of the 85 fixtures, one DOWN). Mutant: whole-list.
//   6. EVERY POST ROLE, one by one: a cheap wrong-height row must lose for LINE_POST, END_POST, CORNER_POST and
//      BLANK_POST. GATE_POST is covered in both sources although the takeoff never asks for it -- both halves
//      of that sentence asserted.
//   7. BOTH ENGINES, character for character: the role list and the filter body are read out of line-items.ts
//      and out of EstimateEngine.kt and compared under a declared translation table. A planted difference must
//      break it.
//   8. THE FIXTURES: no recorded fixture's catalog carries a height_ft at all, so regenerating moves no priced
//      value -- only the version stamp. The manifest is current or exactly one bump behind (stale, awaiting the
//      Gradle regeneration the message names).
//   9. WHAT IS STILL CHOSEN BY PRICE ALONE, as an executable census, so the next role to go wrong is named here
//      rather than discovered on a job site.
//
//   node --test tests/a51-post-height-choice.test.mjs        (no network, no writes, no Gradle)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, copyFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import * as realIndex from "../supabase/functions/_shared/pricing/index.ts";
import * as realLoad from "../supabase/functions/_shared/pricing/load.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const PRICING_DIR = join(ROOT, "supabase/functions/_shared/pricing");
const TS_SRC = read("supabase/functions/_shared/pricing/line-items.ts");
const KT_SRC = read("app/src/main/java/com/fenceestimator/app/estimate/EstimateEngine.kt");
const TS_INDEX = read("supabase/functions/_shared/pricing/index.ts");
const TAKEOFF_SRC = read("supabase/functions/_shared/pricing/takeoff.ts");

const POST_ROLES = ["LINE_POST", "END_POST", "CORNER_POST", "GATE_POST", "BLANK_POST"];
const HEIGHT_AWARE = ["PANEL", "GATE_PANEL", ...POST_ROLES];

// ============================================================= the engine ==

const JOB = "a5100000-0000-4000-8000-000000000001";
const RUN = "a5100000-0000-4000-8000-000000000002";

const jobRow = (o = {}) => ({
  sync_id: JOB, updated_at: "2026-10-01T12:00:00Z", calibration_pixels_per_foot: null,
  tax_rate_percent: 7, markup_percent: 0, discount_percent: 0, labor_rate_per_ft: 8, labor_flat_fee: 0,
  minimum_job_charge: 200, minimum_labor_charge: 0, waste_percent: 0, gate_rate_per_ft: 20, trash_haul_fee: 0,
  teardown_enabled: false, teardown_flat_fee: 0, teardown_rate_per_ft: 0, teardown_feet: 0,
  preferred_manufacturer_sync_id: null, survey_storage_path: null, ...o,
});

/** A vinyl run typed in by length. Post spacing follows the panel width, as the UI keeps it. */
const runRow = (o = {}) => ({
  sync_id: RUN, label: "Back", fence_type: "VINYL", color_or_finish: "White", points_encoded: "",
  gates_encoded: "", closed_loop: false, manual_linear_feet: 72, manual_corner_count: 0, panel_width_ft: 6,
  panel_height_ft: 6, post_spacing_ft: o.panel_width_ft ?? 6, concrete_bags_per_post: 1, aluminum_style: "RACKABLE",
  wood_style: "PRIVACY", wood_rail_count: 3, picket_width_in: 5.5, picket_gap_in: 0, fabric_height_ft: 4,
  include_top_rail: true, include_tension_wire: false, include_barbed_wire_arms: false,
  include_privacy_slats: false, split_rail_count: 2, suppressed_roles: "", is_teardown: false, sort_order: 0, ...o,
});

/**
 * One catalog row as price-job reads it. `height_ft` is OMITTED, not nulled, when the row does not declare
 * one -- that is how the wire carries "the row does not say", and nulling it instead would not test the same
 * thing (see MaterialItemRow.height_ft).
 */
let synthSeq = 0;
function syn(o) {
  const row = {
    sync_id: "a5100000-0000-4000-8000-" + String(100 + synthSeq++).padStart(12, "0"),
    name: o.name, category: o.category ?? "POST", role: o.role, fence_type: o.fence_type ?? "VINYL",
    color_or_finish: o.color_or_finish ?? "White", unit: o.unit ?? "EA", unit_price: o.unit_price,
    taxable: o.taxable ?? true, covers_ft: o.covers_ft ?? null, manufacturer_sync_id: null, is_active: true,
  };
  if (o.height_ft !== undefined) row.height_ft = o.height_ft;
  return row;
}
/** The same rows with every height_ft key removed: "no post in this catalog says how tall it is for". */
const withoutHeights = (rows) => rows.map((r) => { const c = { ...r }; delete c.height_ft; return c; });

const engineOf = (idx, load) => ({
  version: idx.PRICING_ENGINE_VERSION,
  price: (run, catalog) => idx.priceJob(load.buildPricingInput({
    job: jobRow(), runs: [run], catalog, manufacturers: [], changeOrders: [], existingItems: [],
    engineVersion: idx.PRICING_ENGINE_VERSION,
  })),
});
const REAL = engineOf(realIndex, realLoad);

const line = (out, role) => out.items.find((i) => i.role === role);
/** Everything a quote is made of, as one comparable string. The engine version is left out on purpose: a
 *  mutant carries the same constant, and this compares OUTPUTS. */
const quote = (out) => JSON.stringify({ items: out.items, unmatched: out.unmatched_roles, zero: out.zero_priced_names, totals: out.totals });

/**
 * THE OLD RULE for a role with no width, written out: priced rows first, then cheapest, then lowest sync id.
 * This is what buildLineItems' no-preferCoversFt branch does, with no height step at all. It is used as the
 * "before" figure, and test 3 proves it reproduces the real engine on a catalog that declares no height.
 */
function oldRuleChoice(rows, role, run) {
  const pool = rows.filter((r) => r.is_active && (r.fence_type === run.fence_type || r.fence_type === "UNIVERSAL") && r.role === role)
    .filter((r) => run.color_or_finish.trim() === "" || r.color_or_finish.toLowerCase() === run.color_or_finish.toLowerCase());
  const sorted = [...pool].sort((a, b) =>
    (a.unit_price <= 0) - (b.unit_price <= 0) || a.unit_price - b.unit_price || (a.sync_id < b.sync_id ? -1 : a.sync_id > b.sync_id ? 1 : 0));
  return sorted[0];
}

// ====================================================== the owner's rows ==
// TRANSCRIBED from the live catalog of company aba5b097-afc4-48dd-9851-b50200d5e8f4, read-only, 1 Oct 2026,
// after supabase_a50_post_heights.sql. Only the VINYL / White rows the roles below choose between; the names,
// prices and heights are his. Nothing here is written back anywhere.
const OWNER_POSTS = [
  syn({ name: "5\"x5\" Utility Post White 6' (Flori, 4ft run)", role: "LINE_POST", unit_price: 13.18, height_ft: 4 }),
  syn({ name: "5\"x5\" Co-Ex Utility Post White 8.5' (Flori)", role: "LINE_POST", unit_price: 16.56, height_ft: 6 }),
  syn({ name: "5\"x5\" Co-Ex Line Post, White", role: "LINE_POST", unit_price: 16.56, height_ft: 6 }),
  syn({ name: "5x5x72 HFS Line Post White 4' Closed Top", role: "LINE_POST", unit_price: 16.75, height_ft: 4 }),
  syn({ name: "5x5x102 HFS Line Post White 1.75 6' Privacy", role: "LINE_POST", unit_price: 19.0, height_ft: 6 }),
  syn({ name: "5\"x5\" Co-Ex End Post, White", role: "END_POST", unit_price: 16.56, height_ft: 6 }),
  syn({ name: "5\"x5\" Co-Ex Utility Post White 8.5' - End (Flori)", role: "END_POST", unit_price: 16.56, height_ft: 6 }),
  syn({ name: "5x5x72 HFS End Post White 4' Closed Top", role: "END_POST", unit_price: 16.75, height_ft: 4 }),
  syn({ name: "5x5x102 HFS End Post White 1.75 6' Privacy", role: "END_POST", unit_price: 19.0, height_ft: 6 }),
  // One panel per height so the run has something to put in the bays and the quote is a real quote.
  syn({ name: "Panel T&G Vinyl Privacy 6'H x 6'W - White", category: "PANEL", role: "PANEL", unit_price: 52.35, covers_ft: 6, height_ft: 6 }),
  syn({ name: "Panel Melrose Flat Top 2-Rail 4'H x 6'W White (Flori)", category: "PANEL", role: "PANEL", unit_price: 61.74, covers_ft: 6, height_ft: 4 }),
];
const FLORI_4FT_POST = "5\"x5\" Utility Post White 6' (Flori, 4ft run)";

// ================================================================ 1. HARNESS ==

test("harness: the real engine prices a 72 ft vinyl run off these rows and the quote carries posts", () => {
  const out = REAL.price(runRow({ panel_height_ft: 6 }), OWNER_POSTS);
  assert.ok(line(out, "PANEL"), "no PANEL line: the harness is dead, fix it before trusting anything below");
  assert.ok(line(out, "LINE_POST"), "no LINE_POST line: there is nothing for this file to measure");
  assert.ok(line(out, "END_POST"), "no END_POST line");
  assert.equal(line(out, "LINE_POST").quantity, 11, "72 ft at 6 ft a bay is 12 bays, 13 posts, 11 of them line posts");
  assert.ok(out.totals.grand_total > 0);
});

// ================================================= 2. THE OWNER'S OWN CASE ==

test("THE DEFECT, and the fix: a 6 ft run no longer buys the FOUR foot post, and the 4 ft run still does", () => {
  const six = runRow({ panel_height_ft: 6 }), four = runRow({ panel_height_ft: 4 });

  // BEFORE, from the old rule written out above: cheapest priced row, whatever height it is for.
  assert.equal(oldRuleChoice(OWNER_POSTS, "LINE_POST", six).name, FLORI_4FT_POST,
    "control: the old rule is the one that picked the 4 ft post for a 6 ft fence -- if this is not reproduced the before/after below means nothing");
  assert.equal(oldRuleChoice(OWNER_POSTS, "LINE_POST", six).unit_price, 13.18);

  // AFTER, from the real engine.
  const sixOut = REAL.price(six, OWNER_POSTS);
  const sixPost = line(sixOut, "LINE_POST");
  assert.notEqual(sixPost.description, FLORI_4FT_POST,
    "A SIX FOOT FENCE IS STILL BEING QUOTED THE FOUR FOOT POST. This is the defect this file exists for; it is not a price, it is a fence that falls over.");
  assert.equal(OWNER_POSTS.find((r) => r.name === sixPost.description).height_ft, 6,
    "the 6 ft run took a post that is not for a 6 ft fence: " + sixPost.description);
  assert.equal(sixPost.unit_price, 16.56, "the cheapest 6-ft-fence line post he stocks is $16.56");

  // The 4 ft run keeps the $13.18 post: that row is CORRECT for a 4 ft fence and must not be driven out.
  const fourPost = line(REAL.price(four, OWNER_POSTS), "LINE_POST");
  assert.equal(fourPost.description, FLORI_4FT_POST, "the 4 ft run must still take the post made for a 4 ft fence");
  assert.equal(fourPost.unit_price, 13.18);

  // END_POST moves as well: the cheapest end post is a 6-ft-fence row, so a 4 ft run was buying it too.
  assert.equal(oldRuleChoice(OWNER_POSTS, "END_POST", four).height_ft, 6, "control: the old rule gave the 4 ft run a 6-ft-fence end post");
  const fourEnd = line(REAL.price(four, OWNER_POSTS), "END_POST");
  assert.equal(fourEnd.description, "5x5x72 HFS End Post White 4' Closed Top");
  assert.equal(fourEnd.unit_price, 16.75);
  assert.equal(line(REAL.price(six, OWNER_POSTS), "END_POST").unit_price, 16.56, "the 6 ft run's end post is a 6-ft-fence row and is unchanged");
});

// ================================================ 3. ADDITIVITY, EXPLICITLY ==

test("ADDITIVE: a catalog where NO post declares a height prices identically at every run height", () => {
  const bare = withoutHeights(OWNER_POSTS);
  assert.ok(bare.every((r) => !("height_ft" in r)), "control: the height keys really were removed");
  const base = quote(REAL.price(runRow({ panel_height_ft: 6 }), bare));
  for (const h of [4, 5, 6, 7, 8]) {
    assert.equal(quote(REAL.price(runRow({ panel_height_ft: h }), bare)), base,
      `a run ${h} ft high priced differently from a 6 ft one on a catalog that declares NO height. The height step is no longer additive: every company that has filled nothing in would see its quotes move.`);
  }
  // ...and the row chosen is exactly what the OLD rule answers, not merely "something stable".
  for (const h of [4, 6, 8]) {
    for (const role of ["LINE_POST", "END_POST"]) {
      const run = runRow({ panel_height_ft: h });
      assert.equal(line(REAL.price(run, bare), role).description, oldRuleChoice(bare, role, run).name,
        `on a heightless catalog the ${role} is no longer the cheapest priced row, so this change is not additive`);
    }
  }
  // CONTROL: the very same comparison DOES report a move once the heights are there. Otherwise the loop above
  // is only proving that the comparison is blind.
  const moved = [4, 6].filter((h) => quote(REAL.price(runRow({ panel_height_ft: h }), OWNER_POSTS)) !== quote(REAL.price(runRow({ panel_height_ft: h }), bare)));
  assert.deepEqual(moved, [4, 6], "control: filling the heights in moved neither the 4 ft nor the 6 ft quote, so the additivity check above cannot see anything");
});

// ======================================== 4. NULL WIDTH GROUPS WITH NULL ==

/**
 * The step narrows within a width, and a post has NO width. Two posts, both covers_ft null, one declaring the
 * run's height: the other must be set aside. If null did not group with null they would be two groups of one
 * and neither would ever be set aside -- the rule would be a no-op on posts and nobody would be told.
 */
const NULL_WIDTH_PAIR = [
  syn({ name: "Post cheap, for a 4 ft fence", role: "LINE_POST", unit_price: 5, height_ft: 4 }),
  syn({ name: "Post dear, for a 6 ft fence", role: "LINE_POST", unit_price: 50, height_ft: 6 }),
  syn({ name: "Panel 6'H x 6'W", category: "PANEL", role: "PANEL", unit_price: 60, covers_ft: 6, height_ft: 6 }),
];
const checkNullWidthGroups = (E) => {
  const out = E.price(runRow({ panel_height_ft: 6 }), NULL_WIDTH_PAIR);
  assert.equal(line(out, "LINE_POST").description, "Post dear, for a 6 ft fence",
    "two posts of null width were NOT compared: the dearer right-height post lost to the cheap wrong-height one, so the per-width grouping is treating null as unequal to null and the rule does nothing for posts");
};

test("null covers_ft groups with null, so the whole post list narrows (the rule's one load-bearing assumption)", () => {
  checkNullWidthGroups(REAL);
  // CONTROL: the same pair with NO heights goes back to the cheap one, so the check above is reading the height
  // step and not some accident of ordering.
  assert.equal(line(REAL.price(runRow({ panel_height_ft: 6 }), withoutHeights(NULL_WIDTH_PAIR)), "LINE_POST").description,
    "Post cheap, for a 4 ft fence", "control: with no heights declared the cheap post wins, as it always did");
  // And the same for a role whose only candidate declares the WRONG height: nothing to choose, nothing set
  // aside, the row is still used. The engine cannot invent a post the company does not stock.
  const only = [syn({ name: "Only post, for a 4 ft fence", role: "CORNER_POST", unit_price: 9, height_ft: 4 }), ...NULL_WIDTH_PAIR];
  assert.equal(line(REAL.price(runRow({ panel_height_ft: 6, manual_corner_count: 2 }), only), "CORNER_POST").description,
    "Only post, for a 4 ft fence", "a row that declares the wrong height is still used when it is the only one: the step narrows, it never empties the list");
});

// ============================================ 5. PER-WIDTH IS STILL LIVE ==

/**
 * The first draft of the panel rule dropped every row that did not declare the run's height, which hid a 4 ft
 * and a 6 ft gate behind a 5 ft one that did, and moved 3 of the 85 recorded fixtures -- one DOWN. Adding posts
 * must not quietly reintroduce that.
 */
const GATE_WIDTHS = [
  syn({ name: "Gate 5 ft wide, 6'H", category: "GATE", role: "GATE_PANEL", unit_price: 200, covers_ft: 5, height_ft: 6 }),
  syn({ name: "Gate 4 ft wide, height not stated", category: "GATE", role: "GATE_PANEL", unit_price: 150, covers_ft: 4 }),
  syn({ name: "Panel 6'H x 6'W", category: "PANEL", role: "PANEL", unit_price: 60, covers_ft: 6, height_ft: 6 }),
  syn({ name: "Post for a 6 ft fence", role: "LINE_POST", unit_price: 20, height_ft: 6 }),
  syn({ name: "End post for a 6 ft fence", role: "END_POST", unit_price: 20, height_ft: 6 }),
];
const checkSiblingWidths = (E) => {
  const out = E.price(runRow({ panel_height_ft: 6, gates_encoded: "500.0:0.0:4.0:LINE:IN" }), GATE_WIDTHS);
  assert.equal(line(out, "GATE_PANEL").description, "Gate 4 ft wide, height not stated",
    "the 4 ft wide gate was hidden by a 5 ft one that declared the run's height: height must only separate rows of the SAME width");
};

test("height still only separates rows of ONE width: a 4 ft gate is not hidden by a 5 ft gate that states its height", () => {
  checkSiblingWidths(REAL);
  // CONTROL: the 4 ft gate is reachable at all -- a 4 ft opening asks for it, and a 9 ft opening does not.
  assert.equal(line(REAL.price(runRow({ panel_height_ft: 6, gates_encoded: "500.0:0.0:9.0:LINE:IN" }), GATE_WIDTHS), "GATE_PANEL").description,
    "Gate 5 ft wide, 6'H", "control: a 9 ft opening takes the nearest width, the 5 ft gate");
});

// ======================================================= 6. EVERY POST ROLE ==

/** A run shaped so that `role` actually appears on the quote, with a cheap wrong-height decoy for it. */
const ROLE_RUNS = {
  LINE_POST: () => runRow({ panel_height_ft: 6 }),
  END_POST: () => runRow({ panel_height_ft: 6 }),
  CORNER_POST: () => runRow({ panel_height_ft: 6, manual_corner_count: 2 }),
  GATE_POST: () => runRow({ panel_height_ft: 6, gates_encoded: "500.0:0.0:4.0:LINE:IN" }),
  BLANK_POST: () => runRow({ panel_height_ft: 6, gates_encoded: "500.0:0.0:4.0:WALL:IN" }),
};

test("every post role the takeoff asks for refuses a cheap wrong-height row", () => {
  const base = [
    syn({ name: "Panel 6'H x 6'W", category: "PANEL", role: "PANEL", unit_price: 60, covers_ft: 6, height_ft: 6 }),
    syn({ name: "Gate 4 ft wide 6'H", category: "GATE", role: "GATE_PANEL", unit_price: 200, covers_ft: 4, height_ft: 6 }),
  ];
  for (const role of Object.keys(ROLE_RUNS)) {
    const rows = [...base,
      syn({ name: role + " cheap, for a 4 ft fence", role, unit_price: 5, height_ft: 4 }),
      syn({ name: role + " right, for a 6 ft fence", role, unit_price: 50, height_ft: 6 })];
    const chosen = line(REAL.price(ROLE_RUNS[role](), rows), role);
    assert.ok(chosen, `control: no ${role} line on the quote, so this case tests nothing -- fix the run shape`);
    assert.equal(chosen.description, role + " right, for a 6 ft fence",
      `${role} took the cheap row made for a 4 ft fence on a 6 ft run: this role is not in the height gate`);
    // CONTROL, per role: strip the heights and the cheap row wins again, so the assertion above is the height
    // step talking and not the price order.
    assert.equal(line(REAL.price(ROLE_RUNS[role](), withoutHeights(rows)), role).description, role + " cheap, for a 4 ft fence",
      `control: with no heights the cheap ${role} should win`);
  }
});

test("every post role the takeoff can emit is in the height gate -- read off the takeoff, not listed from memory", () => {
  // GATE_POST was in the gate before anything emitted it (the role existed, the editor offered it, the seed
  // shipped one per fence type, and no takeoff ever asked). A gate started asking for it the same day
  // (PRICING_ENGINE_VERSION 2026.10.4), which is exactly why the gate is read off the takeoff here instead of
  // being a list someone keeps up to date: a post role that starts being emitted while it is outside the gate
  // can buy a 4 ft post for a 6 ft fence and nothing says so.
  const emitted = [...new Set([...TAKEOFF_SRC.matchAll(/qty\(\s*"([A-Z_]+)"/g)].map((m) => m[1]))];
  assert.ok(emitted.includes("LINE_POST") && emitted.includes("END_POST"),
    "control: the takeoff reader found nothing like the real entry list: " + emitted.join(","));
  const postsEmitted = emitted.filter((r) => r.endsWith("_POST")).sort();
  assert.ok(postsEmitted.length >= 4, "control: only " + postsEmitted.length + " post roles read out of the takeoff");
  for (const r of postsEmitted) {
    assert.ok(tsRoles().includes(r), r + " is emitted by the takeoff but is NOT in line-items.ts's height gate");
    assert.ok(ktRoles().includes(r), r + " is emitted by the takeoff but is NOT in EstimateEngine.kt's height gate");
  }
});

// =============================================== 7. BOTH ENGINES, CHARACTER FOR CHARACTER ==

/** The `if (...)` condition that gates the height step, and the filter body under it. */
function heightStep(src, anchor, arrow) {
  const at = src.indexOf(anchor);
  if (at < 0) return null;
  // Walk back to the `if (` that opens the block this anchor sits in.
  const ifAt = src.lastIndexOf("if (", at);
  if (ifAt < 0) return null;
  const open = src.indexOf("(", ifAt);
  let depth = 0, close = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") { depth--; if (!depth) { close = i; break; } }
  }
  if (close < 0) return null;
  // The PREDICATE of the filter under it -- where the equality test, the null handling and the order of
  // narrowing all live. From just after the lambda's arrow to the bracket that closes the lambda, found by
  // balancing brackets rather than by matching indentation, so a reformat cannot quietly empty this check.
  const arrowAt = src.indexOf(arrow, at);
  if (arrowAt < 0 || arrowAt > at + 400) return null;
  let d = 0, end = -1;
  for (let i = arrowAt + arrow.length; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") d++;
    else if (c === ")" || c === "]" || c === "}") { if (d === 0) { end = i; break; } d--; }
  }
  if (end < 0) return null;
  return { cond: src.slice(open + 1, close), predicate: src.slice(arrowAt + arrow.length, end) };
}
const TS_STEP = heightStep(TS_SRC, "const current = candidates;", "current.filter((c) =>");
const KT_STEP = heightStep(KT_SRC, "val current = candidates", "current.filter { c ->");
const roles = (step, re) => step === null ? [] : [...step.cond.matchAll(re)].map((m) => m[1]);
const tsRoles = () => roles(TS_STEP, /"([A-Z_]+)"/g);
const ktRoles = () => roles(KT_STEP, /MaterialRole\.([A-Z_]+)/g);

/** Kotlin spelled as TypeScript. The ONLY differences allowed between the two filter bodies. */
function ktToTs(s) {
  return s
    .replace(/\s+/g, "")
    .replace(/current\.none\{d->/g, "!current.some((d)=>")
    .replace(/\}$/, ")")
    .replace(/==/g, "===")
    .replace(/val/g, "const");
}
const normTs = (s) => s.replace(/\s+/g, "").replace(/let/g, "const");

test("BOTH ENGINES: the height gate names the same roles on both sides, in the same order", () => {
  assert.ok(TS_STEP, "the TypeScript height step was not found -- this file's reader is broken, or the step moved");
  assert.ok(KT_STEP, "the Kotlin height step was not found -- this file's reader is broken, or the step moved");
  assert.deepEqual(tsRoles(), HEIGHT_AWARE, "line-items.ts's height gate is not the role list this file pins");
  assert.deepEqual(ktRoles(), HEIGHT_AWARE, "EstimateEngine.kt's height gate is not the role list this file pins");
  assert.deepEqual(tsRoles(), ktRoles(), "THE PHONE AND THE OFFICE WOULD BUY DIFFERENT POSTS: the two height gates name different roles");
  for (const r of POST_ROLES) assert.ok(tsRoles().includes(r), r + " is missing from the height gate, so it can still take a 4 ft post for a 6 ft fence");
});

test("BOTH ENGINES: the filter predicate is the same expression under a declared translation, and a planted difference breaks it", () => {
  const ts = normTs(TS_STEP.predicate), kt = ktToTs(KT_STEP.predicate);
  assert.equal(kt, ts, "the two height filters are not the same expression. Order of narrowing, the equality test or the null handling differing means the phone and the office choose different posts:\n  TS: " + ts + "\n  KT: " + kt);
  // TEETH: the comparison must be able to see a difference. Flip the quantifier on the Kotlin side only.
  assert.notEqual(ktToTs(KT_STEP.predicate.replace("current.none", "current.any")), ts,
    "control: swapping Kotlin's `none` for `any` did not break the comparison, so it cannot see a difference at all");
  assert.notEqual(ktToTs(KT_STEP.predicate.replace("d.coversFt == c.coversFt", "true")), ts,
    "control: dropping the per-width clause from the Kotlin did not break the comparison");
});

test("BOTH ENGINES: one version, moved off the panel-height release", () => {
  const ts = (TS_INDEX.match(/export const PRICING_ENGINE_VERSION = "([^"]+)"/) || [])[1];
  const kt = (KT_SRC.match(/const val PRICING_ENGINE_VERSION = "([^"]+)"/) || [])[1];
  assert.ok(ts && kt, "control: both version constants were read");
  assert.equal(ts, kt, "the two engines carry different PRICING_ENGINE_VERSIONs");
  assert.notEqual(ts, "2026.10.2", "post height changes a price that is wrong today, so it is a formula change and the version must move off the panel-height release");
});

// ====================================================== 8. THE FIXTURES ==

test("the 85 recorded fixtures carry no catalog height at all, so regenerating them moves no priced value", () => {
  const dir = join(ROOT, "fixtures/pricing");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "manifest.json");
  assert.ok(files.length >= 85, "only " + files.length + " fixtures found");
  let withHeight = 0, withPanelHeight = 0;
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    if (/"height_ft"/.test(src)) withHeight++;
    if (/"panel_height_ft"/.test(src)) withPanelHeight++;
  }
  assert.ok(withPanelHeight >= 80, "control: the reader cannot see the run height key either, so the count below proves nothing (" + withPanelHeight + " of " + files.length + ")");
  assert.equal(withHeight, 0,
    withHeight + " fixture(s) now carry a catalog height_ft. Those are the ones whose priced values can move when the fixtures are regenerated; read them before accepting the diff.");
});

test("the fixture manifest is this engine's version, or the release the height work started from (stale, awaiting regeneration)", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "fixtures/pricing/manifest.json"), "utf8"));
  const engine = REAL.version;
  assert.equal(manifest.case_count, 85);
  assert.ok(manifest.version === engine || manifest.version === "2026.10.2",
    `the fixture manifest is ${manifest.version} and the engine is ${engine}. Regenerate in the same commit as the engine change:\n` +
    "  export JAVA_HOME=/c/Users/march/.jdks/jdk-17.0.20+8\n" +
    "  FENCEFLOW_PARITY_OUT=$(pwd)/fixtures/pricing ./gradlew testDebugUnitTest --tests \"*ParityFixtureWriter*\" -q\n" +
    "  ./gradlew testDebugUnitTest --tests \"*Parity*\" -q");
  if (manifest.version !== engine) console.log(`  note: fixtures are at ${manifest.version}, engine at ${engine} -- regeneration is pending (needs Gradle).`);
});

// ============================= 9. WHAT IS STILL CHOSEN BY PRICE ALONE ==

test("CENSUS: which roles read a height, which are chosen by width, and which are still price alone", () => {
  // The roles the takeoff can emit, read off takeoff.ts rather than listed from memory.
  const emitted = [...new Set([...TAKEOFF_SRC.matchAll(/qty\(\s*"([A-Z_]+)"/g)].map((m) => m[1]))];
  emitted.push(...[...TAKEOFF_SRC.matchAll(/qty\(panelRole/g)].length ? ["GATE_PANEL", "GATE_FRAME_KIT"] : []);
  assert.ok(emitted.includes("LINE_POST") && emitted.includes("PANEL") && emitted.includes("CONCRETE_BAG"),
    "control: the takeoff reader found nothing like the real entry list: " + emitted.join(","));

  const heightAware = new Set(tsRoles());
  // Chosen by nearest WIDTH (the takeoff passes a preferCoversFt for these), so a wrong physical size is
  // already prevented in that dimension.
  const widthKeyed = new Set(["PANEL", "GATE_PANEL", "GATE_FRAME_KIT", "CHAIN_FABRIC"]);
  const priceOnly = emitted.filter((r) => !heightAware.has(r) && !widthKeyed.has(r)).sort();

  // PINNED, so the next role to go physically wrong is named here. GATE_FRAME_KIT is the one to watch: it is
  // the gate "panel" for wood, chain-link, split-rail and composite, it is chosen by width then price, and no
  // engine reads its height -- the same shape as GATE_PANEL before 2026.10.2. It is width-keyed, not price-only,
  // so it is not in the list below; that is exactly why it needs saying here.
  assert.ok(!heightAware.has("GATE_FRAME_KIT"),
    "GATE_FRAME_KIT is now in the height gate: good, but update this census and the comment above it");
  assert.deepEqual(priceOnly, [
    "BARBED_WIRE_ARM", "BRACE", "BRACE_BAND", "CONCRETE_BAG", "HANDLE", "HINGE_SET", "HOLE_PLUG", "LATCH",
    "POST_CAP", "PRIVACY_SLAT", "RAIL_END", "STIFFENER", "TENSION_BAND", "TENSION_WIRE", "TOP_RAIL", "TRIM",
    "WOOD_PICKET", "WOOD_RAIL",
  ], "the set of roles chosen by PRICE ALONE has changed. Each new entry is a role where the cheapest row wins whatever it physically is; say which, and whether a wrong one is dangerous, a bad fit or only a price.");

  // CHAIN_FABRIC is the one role whose physical height is already the thing it is chosen by: covers_ft IS the
  // fabric height for it. Measured, not asserted from the comment.
  const fabric = [
    syn({ name: "Fabric 4 ft, cheap", category: "FABRIC", role: "CHAIN_FABRIC", fence_type: "CHAIN_LINK", color_or_finish: "", unit: "FT", unit_price: 3, covers_ft: 4 }),
    syn({ name: "Fabric 6 ft, dear", category: "FABRIC", role: "CHAIN_FABRIC", fence_type: "CHAIN_LINK", color_or_finish: "", unit: "FT", unit_price: 6, covers_ft: 6 }),
    syn({ name: "Terminal post", role: "END_POST", fence_type: "CHAIN_LINK", color_or_finish: "", unit_price: 20 }),
    syn({ name: "Line post", role: "LINE_POST", fence_type: "CHAIN_LINK", color_or_finish: "", unit_price: 11 }),
  ];
  for (const h of [4, 6]) {
    assert.equal(line(REAL.price(runRow({ fence_type: "CHAIN_LINK", color_or_finish: "", fabric_height_ft: h, panel_height_ft: 6 }), fabric), "CHAIN_FABRIC").description,
      h === 4 ? "Fabric 4 ft, cheap" : "Fabric 6 ft, dear",
      "chain-link fabric is not being chosen by its own height (covers_ft): the census above is wrong about it");
  }
});

// ===================================================== 10. TEETH (mutants) ==
// Three mutants of the real engine, built in a temp directory from the real source. A check that cannot fail on
// the engine it guards is decoration.

const ROLE_GATE_TS = TS_STEP === null ? "" : "if (" + TS_STEP.cond + ") {";

async function mutant(mutate, label) {
  const dir = mkdtempSync(join(tmpdir(), "a51-mutant-"));
  for (const f of readdirSync(PRICING_DIR)) if (/^(f32|geometry|index|kotlin-text|line-items|load|takeoff|totals|types|uuid3)\.ts$/.test(f)) copyFileSync(join(PRICING_DIR, f), join(dir, f));
  const src = readFileSync(join(dir, "line-items.ts"), "utf8");
  const next = mutate(src);
  assert.notEqual(next, src, `the ${label} mutation did not change line-items.ts: the mutant is the real engine`);
  writeFileSync(join(dir, "line-items.ts"), next);
  const [idx, load] = await Promise.all([import(pathToFileURL(join(dir, "index.ts")).href), import(pathToFileURL(join(dir, "load.ts")).href)]);
  return engineOf(idx, load);
}

test("TEETH: the real engine passes every check this file guards", () => {
  assert.doesNotThrow(() => checkNullWidthGroups(REAL), "nullWidthGroups");
  assert.doesNotThrow(() => checkSiblingWidths(REAL), "siblingWidths");
});

test("TEETH: with the post roles taken OUT of the gate, the post checks fail -- the defect itself", async () => {
  const E = await mutant((s) => s.replace(ROLE_GATE_TS, 'if (entry.role === "PANEL" || entry.role === "GATE_PANEL") {'), "posts-out-of-the-gate");
  assert.throws(() => checkNullWidthGroups(E), /were NOT compared/);
  assert.equal(line(E.price(runRow({ panel_height_ft: 6 }), OWNER_POSTS), "LINE_POST").description, FLORI_4FT_POST,
    "control: the pre-fix engine is the one that quotes the 4 ft post for a 6 ft fence");
  assert.doesNotThrow(() => checkSiblingWidths(E), "control: taking the posts out does not touch the gate-width rule, so only the post checks catch it");
});

test("TEETH: if null width did not group with null, the rule would silently do NOTHING for posts", async () => {
  const E = await mutant((s) => s.replace("d.coversFt === c.coversFt", "(d.coversFt !== null && d.coversFt === c.coversFt)"), "null-width-never-equal");
  assert.throws(() => checkNullWidthGroups(E), /were NOT compared/);
  assert.equal(line(E.price(runRow({ panel_height_ft: 6 }), OWNER_POSTS), "LINE_POST").description, FLORI_4FT_POST,
    "control: this mutant is exactly the silent no-op the per-width grouping would have been on posts");
  assert.doesNotThrow(() => checkSiblingWidths(E), "control: panels have widths, so this mutant leaves them alone");
});

test("TEETH: whole-list narrowing (no per-width clause) hides the other widths of a gate", async () => {
  const E = await mutant((s) => s.replace("!current.some((d) => d.coversFt === c.coversFt && d.heightFt === run.panelHeightFt)",
    "!current.some((d) => d.heightFt === run.panelHeightFt)"), "whole-list-narrowing");
  assert.throws(() => checkSiblingWidths(E), /hidden by a 5 ft one/);
  assert.doesNotThrow(() => checkNullWidthGroups(E), "control: whole-list narrowing fixes the posts too, so only the gate-width check tells it from the real rule");
});
