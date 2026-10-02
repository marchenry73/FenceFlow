// a63-office-height-parity -- the office re-price button selects its catalog columns BY NAME, and it was not asking for
// height_ft. So the OFFICE priced every panel and every post as if no height were set, while the PHONE, reading its own
// SQLite row, applied the height rule. Same job, two answers, on every job he has.
//
// THE DEFECT (fixed in supabase/functions/price-job/index.ts CATALOG_COLUMNS by the commit that adds this file)
//   PostgREST returns only the columns a .select() names. A column not named comes back as an ABSENT KEY -- not null, not
//   an error. load.ts materialItemRowToInput copies height_ft ONLY when the row has it; index.ts materialItemFromRow turns
//   the absent key into heightFt: null; and the engine then prices exactly as a catalog that declares no height at all.
//   Nothing logs, nothing throws, and `deno check` stays green because the row is cast `as DbMaterialItemRow` and the field
//   is optional. This is the same shape as the minimum_labor_charge and survey_storage_path notes already on JOB_COLUMNS.
//
//   It switched OFF two engine rules, from the office only:
//     2026.10.2  PANEL / GATE_PANEL: between rows of one width, the row whose height_ft equals the run's panel_height_ft
//                wins. Without it the cheaper, shorter panel won -- an UNDERCHARGE.
//     2026.10.3  LINE_POST / END_POST / CORNER_POST / GATE_POST / BLANK_POST: height_ft is the FENCE height the post is
//                for. A post has no width, so without the height it is chosen by PRICE ALONE -- the office quoted a six
//                foot fence the supplier's FOUR foot post. Nothing of it is in the ground. The fence falls over.
//
// WHAT WAS MEASURED on the real database (read-only SELECT, 2 Oct 2026, 9 priceable jobs, 123 catalog rows of which 39
// carry a height). One engine, real rows, and the ONLY thing varied was whether the catalog rows carried height_ft:
//     job 1 +$419.84   job 2 +$28.94   job 3 +$310.96   job 4 +$980.58   job 5 +$148.28
//     job 6 +$545.21   job 7 +$14.79   job 8 +$177.79   job 9 +$40.11          total +$2666.50
//   Every delta is POSITIVE: the office was undercharging on all nine. The role that moved on nearly every job is
//   LINE_POST, i.e. the falls-over one, not the panel one.
//
// WHAT THIS FILE HOLDS, each with a control or a canary that must fail
//   1. THE SOURCE: CATALOG_COLUMNS names height_ft, and the CANARY -- the same assertion against the list as it was must
//      FAIL, so this is not a check that cannot fail.
//   2. POSTGREST SEMANTICS: a column left out of the select is an absent key, and the load layer really does treat absent
//      differently from present. If that stopped being true the whole defect would be imaginary.
//   3. BEHAVIOUR: the real shared engine, one catalog, prices DIFFERENTLY through the old column list and the new one --
//      so the missing column was money, not cosmetics -- and the rows it picks wrongly are named.
//   4. ADDITIVITY, the positive control that stops this file passing vacuously: on a catalog where no row declares a
//      height, the two column lists must agree to the cent. A harness that always reports a difference would fail here.
//   5. NO OTHER GAP: every column list in price-job is diffed against the interface the engine actually consumes, so the
//      NEXT column added to the engine and forgotten in the select fails here. With a planted field as its canary.
//
//   node --test tests/a63-office-height-parity.test.mjs        (no network, no writes, no database)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import * as idx from "../supabase/functions/_shared/pricing/index.ts";
import * as load from "../supabase/functions/_shared/pricing/load.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Line endings normalised: a checkout with core.autocrlf turns every file CRLF, and these checks match across line breaks.
const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const PRICE_JOB = read("supabase/functions/price-job/index.ts");
const ENGINE_SRC = read("supabase/functions/_shared/pricing/index.ts");

// ============================================================ the column lists, read from the source ==

/** A `const NAME = "a, b, " + "c";` column list, as the set of column names it asks Postgres for. */
function columnList(name, src = PRICE_JOB) {
  const m = new RegExp("const " + name + " = ([\\s\\S]*?);\\n").exec(src);
  if (!m) throw new Error("column list not found: " + name);
  const joined = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]).join("");
  return new Set(joined.split(",").map((s) => s.trim()).filter(Boolean));
}

const CATALOG_NEW = columnList("CATALOG_COLUMNS");
/** The list exactly as it was before this fix: everything except height_ft. This is the canary's input. */
const CATALOG_OLD = new Set([...CATALOG_NEW].filter((c) => c !== "height_ft"));

test("control: CATALOG_COLUMNS is readable, is the real list, and is what both catalog reads use", () => {
  // If this parse silently returned an empty set, every check below would pass for the wrong reason.
  assert.ok(CATALOG_NEW.size >= 12, "parsed only " + CATALOG_NEW.size + " catalog columns -- the reader is broken");
  for (const known of ["sync_id", "name", "role", "unit_price", "covers_ft", "is_active"]) {
    assert.ok(CATALOG_NEW.has(known), "the parsed list should name " + known);
  }
  assert.equal([...PRICE_JOB.matchAll(/\.select\(CATALOG_COLUMNS\)/g)].length, 2,
    "both catalog reads -- pricing a job, and pricing a sample -- must go through the one list");
});

// ====================================================================== 1. THE SOURCE, with its canary ==

/** The assertion under test, as a function of a column list, so it can be run against the OLD list too. */
const namesHeight = (list) => list.has("height_ft");

test("THE FIX: price-job's CATALOG_COLUMNS names height_ft, so a height on the catalog page reaches the OFFICE re-price", () => {
  assert.equal(namesHeight(CATALOG_NEW), true,
    "CATALOG_COLUMNS does not name height_ft; the office prices every panel and post as if no height were set");
});

test("CANARY: that same check FAILS against the column list as it was, so it is not a check that cannot fail", () => {
  assert.equal(namesHeight(CATALOG_OLD), false,
    "the old list appears to name height_ft -- the canary is not reproducing the defect, so test 1 proves nothing");
});

// ============================================== 2. why a missing column is silent, not an error ==

/**
 * What PostgREST hands back for a given select: ONLY the named columns, and a column that was not named is an
 * ABSENT KEY. That distinction is the entire bug -- `null` would have been read as "the row says it has no height",
 * which is the same answer; an absent key is read as "there is no such field", which is also the same answer, and
 * neither is "nobody asked".
 */
const project = (rows, list) => rows.map((r) => {
  const out = {};
  for (const col of list) if (col in r) out[col] = r[col];
  return out;
});

test("a column left out of the select is an ABSENT KEY, and the load layer treats absent differently from present", () => {
  const full = { ...CATALOG_ROW_6FT };
  const blind = project([full], CATALOG_OLD)[0];
  const seeing = project([full], CATALOG_NEW)[0];
  assert.equal("height_ft" in blind, false, "the old list must not deliver the key at all");
  assert.equal("height_ft" in seeing, true, "the new list must deliver it");
  assert.equal(seeing.height_ft, 6);

  // And the load layer really does diverge on it -- if it stopped doing so, the defect would not exist and this
  // whole file should be deleted rather than left passing.
  const asBlind = load.materialItemRowToInput(blind);
  const asSeeing = load.materialItemRowToInput(seeing);
  assert.equal("height_ft" in asBlind, false, "an absent height must not be invented as null on the contract row");
  assert.equal(asSeeing.height_ft, 6);
  const mfr = new Set();
  assert.equal(idx.materialItemFromRow(asBlind, 0, mfr).heightFt, null, "absent reads as 'the row does not say'");
  assert.equal(idx.materialItemFromRow(asSeeing, 0, mfr).heightFt, 6);
});

// ========================================================= 3. the behaviour: it was money, not cosmetics ==

// A job and a run with no drawing: 100 ft typed in, six feet high, black ornamental iron. post_spacing follows the
// panel width, as the UI keeps it. Nothing here depends on a clock or on the live database.
const jobRow = (o = {}) => ({
  sync_id: "a6300000-0000-4000-8000-000000000001", updated_at: "2026-10-02T12:00:00Z",
  calibration_pixels_per_foot: null, tax_rate_percent: 7, markup_percent: 0, discount_percent: 0,
  labor_rate_per_ft: 8, labor_flat_fee: 0, minimum_job_charge: 0, minimum_labor_charge: 0,
  waste_percent: 0, gate_rate_per_ft: 20, trash_haul_fee: 0, teardown_enabled: false,
  teardown_flat_fee: 0, teardown_rate_per_ft: 0, teardown_feet: 0,
  preferred_manufacturer_sync_id: null, survey_storage_path: null, ...o,
});
const runRow = (o = {}) => ({
  sync_id: "a6300000-0000-4000-8000-000000000002", label: "Back", fence_type: "ORNAMENTAL_IRON",
  color_or_finish: "Black", points_encoded: "", gates_encoded: "", closed_loop: false,
  manual_linear_feet: 100, manual_corner_count: 0, panel_width_ft: 6, panel_height_ft: 6,
  post_spacing_ft: 6, concrete_bags_per_post: 1, aluminum_style: "RACKABLE", wood_style: "PRIVACY",
  wood_rail_count: 3, picket_width_in: 5.5, picket_gap_in: 0, fabric_height_ft: 4,
  include_top_rail: true, include_tension_wire: false, include_barbed_wire_arms: false,
  include_privacy_slats: false, split_rail_count: 2, suppressed_roles: "", is_teardown: false,
  sort_order: 0, start_joint: "", end_joint: "", ...o,
});

let seq = 0;
/** One catalog row, shaped as price-job's select delivers it. Ids come from position, so every tie breaks the same way. */
const row = (o) => ({
  sync_id: "a6300000-0000-4000-8000-" + String(++seq).padStart(12, "0"),
  category: "MISC", fence_type: "ORNAMENTAL_IRON", color_or_finish: "Black", unit: "EA",
  taxable: true, covers_ft: null, height_ft: null, manufacturer_sync_id: null, is_active: true, ...o,
});
const CATALOG_ROW_6FT = row({ name: "Line Post 6ft fence", role: "LINE_POST", unit_price: 19.5, height_ft: 6 });

/**
 * The shape of his real catalog where it matters: for one role, two rows that differ ONLY in the height they are
 * for, the shorter one cheaper. That is the tie the height rule exists to break, and the tie that price alone
 * breaks the wrong way. Panels tie on width (2026.10.2); posts have no width at all (2026.10.3).
 */
const CATALOG = [
  row({ name: "Iron Panel 4'H x 6'W, Black", role: "PANEL", category: "PANEL", unit_price: 135, covers_ft: 6, height_ft: 4 }),
  row({ name: "Iron Panel 6'H x 6'W, Black", role: "PANEL", category: "PANEL", unit_price: 175, covers_ft: 6, height_ft: 6 }),
  row({ name: "5x5 Utility Post White 6' (4ft run)", role: "LINE_POST", unit_price: 13.18, height_ft: 4 }),
  row({ name: "5x5 Utility Post White 8' (6ft run)", role: "LINE_POST", unit_price: 19.50, height_ft: 6 }),
  row({ name: "End Post, 4ft fence", role: "END_POST", unit_price: 15.00, height_ft: 4 }),
  row({ name: "End Post, 6ft fence", role: "END_POST", unit_price: 22.00, height_ft: 6 }),
  row({ name: "Post Cap, Black", role: "POST_CAP", unit_price: 3.00 }),
  row({ name: "Concrete, 50lb", role: "CONCRETE_BAG", unit: "BAG", unit_price: 6.00 }),
];

/** Price one job through a given column list -- i.e. as the office function sees the catalog with that select. */
const priceThrough = (list, catalog = CATALOG, o = {}) => idx.priceJob(load.buildPricingInput({
  job: jobRow(o.job), runs: [runRow(o.run)], catalog: project(catalog, list),
  manufacturers: [], changeOrders: [], existingItems: [], engineVersion: idx.PRICING_ENGINE_VERSION,
}));
const lineFor = (out, role) => out.items.find((i) => i.role === role);

test("harness: the run prices, nothing is unmatched, and the quote responds to a change that has nothing to do with height", () => {
  const out = priceThrough(CATALOG_NEW);
  assert.ok(lineFor(out, "PANEL"), "no PANEL line -- the harness is dead, fix it before trusting anything below");
  assert.equal(lineFor(out, "PANEL").quantity, 17, "100 ft at 6 ft a bay is 17 panels");
  assert.deepEqual(out.unmatched_roles, [], "a role with no catalog row would make a missing line look like a height bug");
  // CONTROL: the total moves for an unrelated reason, so "nothing moved" below can be a real finding.
  const longer = priceThrough(CATALOG_NEW, CATALOG, { run: { manual_linear_feet: 110 } });
  assert.notEqual(longer.totals.grand_total, out.totals.grand_total, "control: ten more feet moved nothing");
});

test("THE DEFECT, priced: the old column list and the new one give DIFFERENT totals on one catalog", () => {
  const blind = priceThrough(CATALOG_OLD);
  const seeing = priceThrough(CATALOG_NEW);
  assert.notEqual(blind.totals.grand_total, seeing.totals.grand_total,
    "the two column lists agree, so either the fix does nothing or the harness is not exercising it");
  // The office was UNDERcharging, which is the direction that matters to him.
  assert.ok(seeing.totals.grand_total > blind.totals.grand_total,
    "the height rule should raise this quote: " + blind.totals.grand_total + " -> " + seeing.totals.grand_total);
});

test("THE FALLS-OVER ONE: blind to the height, the office buys the FOUR foot post for a six foot fence", () => {
  const blind = priceThrough(CATALOG_OLD);
  const seeing = priceThrough(CATALOG_NEW);
  // A post has no width, so with no height to go on it is chosen by price alone -- the cheapest, which is the short one.
  assert.match(lineFor(blind, "LINE_POST").description, /4ft run/, "the defect: the post for a 4 ft fence");
  assert.equal(lineFor(blind, "LINE_POST").unit_price, 13.18);
  assert.match(lineFor(seeing, "LINE_POST").description, /6ft run/, "fixed: the post for a 6 ft fence");
  assert.equal(lineFor(seeing, "LINE_POST").unit_price, 19.50);
  // Same count either way: this is never a quantity bug, only ever the wrong row at the wrong price.
  assert.equal(lineFor(blind, "LINE_POST").quantity, lineFor(seeing, "LINE_POST").quantity);
  // And the end posts move with them.
  assert.equal(lineFor(blind, "END_POST").unit_price, 15.00);
  assert.equal(lineFor(seeing, "END_POST").unit_price, 22.00);
});

test("and the panel rule (2026.10.2) is reached from the office too: the cheaper 4'H panel was winning on width", () => {
  assert.equal(lineFor(priceThrough(CATALOG_OLD), "PANEL").unit_price, 135, "the defect: the 4 ft high panel");
  assert.equal(lineFor(priceThrough(CATALOG_NEW), "PANEL").unit_price, 175, "fixed: the 6 ft high panel");
});

// ================================================ 4. ADDITIVITY -- the control that stops this passing vacuously ==

test("POSITIVE CONTROL: on a catalog where no row declares a height, the two column lists agree to the cent", () => {
  // Strip the heights from the CATALOG (not from the select). The height rule only ever breaks a tie between rows
  // that already tie, so a silent catalog must price identically whichever list is used. If this fails, the
  // comparison above is picking up something other than the height rule and none of its numbers mean anything.
  const silent = CATALOG.map((r) => ({ ...r, height_ft: null }));
  const blind = priceThrough(CATALOG_OLD, silent);
  const seeing = priceThrough(CATALOG_NEW, silent);
  assert.equal(seeing.totals.grand_total, blind.totals.grand_total,
    "selecting height_ft changed a quote on a catalog that declares no height -- the fix is NOT additive");
  assert.deepEqual(seeing.items, blind.items, "and not one line may differ");
  // TEETH: the same comparison on the real catalog DOES differ, so this control is not simply always true.
  assert.notEqual(priceThrough(CATALOG_NEW).totals.grand_total, priceThrough(CATALOG_OLD).totals.grand_total,
    "the control passes even on a catalog WITH heights -- it is not discriminating, so it proves nothing");
});

// ============================================================= 5. NO OTHER GAP, for the next column ==

/** The fields of an `export interface Name { ... }`, mapped to whether they are optional. Comments ignored. */
function interfaceFields(name, src = ENGINE_SRC) {
  const m = new RegExp("export interface " + name + " \\{([\\s\\S]*?)\\n\\}").exec(src);
  if (!m) throw new Error("interface not found: " + name);
  const body = m[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const out = new Map();
  for (const f of body.matchAll(/^\s*([a-z_][a-z0-9_]*)(\??):/gm)) out.set(f[1], f[2] === "?");
  return out;
}

/**
 * Every row price-job loads, the interface the engine consumes it as, and the columns that are supplied from
 * somewhere other than the table's own shape.
 *
 * NOT listed, on purpose: build templates. price-job's sample mode gets a template from the `my_build_templates`
 * RPC, whose live body is `select to_jsonb(t) || ...` -- the whole row, every column (read from pg_proc, 2 Oct
 * 2026). There is no column list there to drift.
 */
const ROW_SOURCES = [
  ["JOB_COLUMNS", "JobRow", ["sync_id", "updated_at", "survey_storage_path"]],
  ["RUN_COLUMNS", "FenceRunRow", []],
  ["CATALOG_COLUMNS", "MaterialItemRow", []],
  ["MANUFACTURER_COLUMNS", "ManufacturerRow", []],
  ["CHANGE_ORDER_COLUMNS", "ChangeOrderRow", []],
  ["LINE_ITEM_COLUMNS", "LineItemRow", []],
];

/**
 * Columns an interface declares that the matching select does not ask for, EXCEPT the ones recorded below as
 * deliberately unselected. A name here is a silent wrong answer waiting to happen, not an error.
 */
const DELIBERATELY_NOT_SELECTED = new Map([
  // Copied onto the contract row by load.ts so the recorded fixtures match, but NO engine reads it off a catalog
  // row: materialItemFromRow never puts it on MaterialItem, which has no such field, and withQuotedPrices
  // (line-items.ts) reads the supplier price off the EXISTING ESTIMATE LINES, which LINE_ITEM_COLUMNS does select.
  // Selecting it here would cost a column and change no number.
  ["MaterialItemRow", new Set(["supplier_unit_price"])],
]);

const gapsFor = (listName, ifaceName, extra, src = PRICE_JOB) => {
  const selected = columnList(listName, src);
  const fields = interfaceFields(ifaceName);
  for (const e of extra) fields.set(e, false);
  const allowed = DELIBERATELY_NOT_SELECTED.get(ifaceName) ?? new Set();
  return [...fields.keys()].filter((f) => !selected.has(f) && !allowed.has(f));
};

test("NO OTHER GAP: every column the engine's row interfaces declare is named by the matching select", () => {
  const found = [];
  for (const [listName, ifaceName, extra] of ROW_SOURCES) {
    // control: both sides of each comparison were really read
    assert.ok(columnList(listName).size > 1, "control: " + listName + " parsed as " + columnList(listName).size + " columns");
    assert.ok(interfaceFields(ifaceName).size > 1, "control: " + ifaceName + " parsed as " + interfaceFields(ifaceName).size + " fields");
    for (const g of gapsFor(listName, ifaceName, extra)) found.push(listName + " does not select " + ifaceName + "." + g);
  }
  assert.deepEqual(found, []);
});

test("CANARY: the no-other-gap check reports height_ft when run against the column list as it was", () => {
  // Re-run the same comparison against a source whose CATALOG_COLUMNS has height_ft removed. If this reports
  // nothing, the check above cannot see a missing column and its empty result is meaningless.
  const asItWas = PRICE_JOB.replace(/, height_ft,/, ",");
  assert.notEqual(asItWas, PRICE_JOB, "control: the height_ft column was not found in the source to remove");
  assert.deepEqual(gapsFor("CATALOG_COLUMNS", "MaterialItemRow", [], asItWas), ["height_ft"]);
});
