// a40-height-engine -- a catalog panel can now say how tall it is, and the engine prefers the row of the run's height.
//
// THE DEFECT (docs/PANEL_HEIGHT_BLINDNESS.md, measured by tests/a32 and a34 BEFORE this change)
//   buildLineItems chose a PANEL by colour, manufacturer, NEAREST WIDTH, then CHEAPEST. Height was never read, so in the
//   starting catalog the 4'H and 6'H ornamental-iron panels (both 6 ft wide, 135.00 and 175.00) tied on width and the cheaper
//   4 ft high one priced every 6 ft high iron run: $40 a panel short, $727.60 on 100 ft. An UNDERCHARGE, and the thing that
//   blocked adding 4 ft fence rows.
//
// THE FIX, as built
//   material_items.height_ft / MaterialItem.heightFt, a column of its own (NOT covers_ft, which is width for a panel and
//   height for chain-link fabric). Between PANEL (or GATE_PANEL) rows of ONE width, a row whose height equals the run's panel
//   height beats a row that does not. Nothing else in the engine moves.
//
// WHAT THIS FILE HOLDS, each with a control or a mutant that must fail
//   1. THE FIX: the starting catalog, with the starting-list heights, prices a 6 ft iron run with the 6'H panel, and the quote
//      is the same as the quote with the 4'H row simply removed. 100 ft and 200 ft, 0% and 15% markup.
//   2. IT IS ADDITIVE, explicitly. All 85 recorded fixtures (the outputs of the engine BEFORE this change) are priced
//      identically when no row declares a height, and with the starting-list heights applied to every fixture's catalog exactly
//      TWO of the 85 change: the two iron ones. A catalog with no height anywhere prices as it always did, by construction.
//   3. WHOSE PRICE MOVES, and whose does not: a 4 ft iron run, 5/7/8 ft high iron runs (no row declares those heights), a 6 ft
//      high iron run at 8 ft panels (no 6'H x 8'W row exists), every gate, every non-iron fence.
//   4. THE SIBLING-WIDTH TRAP. A first draft dropped every row that did not declare the run's height. In the recorded fixtures
//      that hid a 4 ft and a 6 ft gate beside a 5 ft one that declared its height, and moved three quotes that have nothing to
//      do with height -- one DOWN by $117.59. Height now only separates rows of the same width.
//   5. THE OWNER'S 4 FT REQUEST: a new, shorter row at an existing width does not take over the taller quotes, even though the
//      catalog editor cannot set its height yet.
//   6. SCOPE: not posts, caps, rails, chain-link fabric or gate frame kits. Colour and manufacturer still come first.
//   7. THE CONTRACT: height_ft is optional on the wire, a Float like covers_ft, never emitted when empty, never read from a name.
//   8. TEETH: four mutants of the real engine (no height step; no role gate; the strict whole-list narrowing; and a name
//      parse) are each run through the same checks and each must FAIL one.
//
//   node --test tests/a40-height-engine.test.mjs        (no network, no writes)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import * as realIndex from "../supabase/functions/_shared/pricing/index.ts";
import * as realLoad from "../supabase/functions/_shared/pricing/load.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const PRICING_DIR = join(ROOT, "supabase/functions/_shared/pricing");
const SEED_SRC = read("app/src/main/java/com/fenceestimator/app/data/SeedData.kt");
const MIGRATION = read("supabase_a40_material_height.sql");

// ================================================================== readers ==

/** Index of the bracket that closes the one at openIdx, skipping string literals. */
function matchClose(text, openIdx) {
  const open = text[openIdx];
  const close = { "(": ")", "[": "]", "{": "}" }[open];
  let depth = 0;
  for (let j = openIdx; j < text.length; j++) {
    const c = text[j];
    if (c === '"') { j++; while (text[j] !== '"') { if (text[j] === "\\") j++; j++; } continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (!depth) return j; }
  }
  throw new Error("unbalanced bracket from " + openIdx);
}

/** Kotlin source with // and block comments blanked, string literals left whole. */
function stripKt(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '"') { let j = i + 1; while (src[j] !== '"') { if (src[j] === "\\") j++; j++; } out += src.slice(i, j + 1); i = j + 1; continue; }
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; out += " "; continue; }
    out += c; i++;
  }
  return out;
}

const unescapeKt = (s) => s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (m, c) =>
  c[0] === "u" ? String.fromCharCode(parseInt(c.slice(1), 16)) : ({ n: "\n", t: "\t", "\\": "\\", '"': '"', "'": "'", $: "$" }[c] ?? c));

/** SeedData.materialItems(), read off the item(...) calls of each *Items() builder, comments ignored. */
function readSeed(kt) {
  const code = stripKt(kt);
  const consts = Object.fromEntries([...code.matchAll(/const val ([A-Za-z_]\w*)\s*=\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1], unescapeKt(m[2])]));
  const starts = [...code.matchAll(/private fun (\w+Items)\(\): List<MaterialItem> (?:=|\{)/g)].map((m) => m.index);
  const rows = [];
  starts.forEach((at, i) => {
    const body = code.slice(at, i + 1 < starts.length ? starts[i + 1] : code.length);
    const t = (body.match(/val t = FenceType\.(\w+)/) || [])[1];
    const re = /\bitem\(\s*MaterialCategory\./g;
    let m;
    while ((m = re.exec(body))) {
      const open = body.indexOf("(", m.index);
      const end = matchClose(body, open);
      const args = body.slice(open + 1, end);
      const ft = args.match(/,\s*(?:FenceType\.(\w+)|(t))\s*,\s*"/);
      const named = (k) => { const x = args.match(new RegExp("\\b" + k + "\\s*=\\s*([^,)]+?)\\s*(?:,|$)")); return x ? x[1].trim() : undefined; };
      const str = (k) => { const x = args.match(new RegExp("\\b" + k + "\\s*=\\s*\"((?:[^\"\\\\]|\\\\.)*)\"")); return x ? unescapeKt(x[1]) : undefined; };
      const cov = named("coversFt");
      rows.push({
        category: args.match(/MaterialCategory\.(\w+)/)[1], role: args.match(/MaterialRole\.(\w+)/)[1],
        fence_type: ft[1] || (ft[2] === "t" ? t : undefined), name: unescapeKt(args.match(/"((?:[^"\\]|\\.)*)"/)[1]),
        unit: str("unit") ?? "EA", unit_price: Number(named("unitPrice")), taxable: named("taxable") !== "false",
        covers_ft: cov === undefined ? null : Number(cov.replace(/f$/, "")), color_or_finish: str("colorOrFinish") ?? "",
      });
      re.lastIndex = end;
    }
  });
  return rows;
}

/** PART 3 of the migration: the fifteen (name, role, fence type) identities and the height each is given. SQL comments ignored. */
function readMigrationHeights(sql) {
  const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const from = code.indexOf("update public.material_items m");
  const to = code.indexOf(") as v(name, role, fence_type, h)");
  assert.ok(from > 0 && to > from, "PART 3 of supabase_a40_material_height.sql was not found");
  const heights = new Map();
  for (const t of code.slice(from, to).matchAll(/\(\s*'((?:[^']|'')*)'\s*,\s*'(\w+)'\s*,\s*'(\w+)'\s*,\s*(\d+(?:\.\d+)?)::real\s*\)/g))
    heights.set(t[1].replace(/''/g, "'") + "|" + t[2] + "|" + t[3], Number(t[4]));
  return heights;
}

const SEED = readSeed(SEED_SRC);
const HEIGHTS = readMigrationHeights(MIGRATION);
const identity = (r) => r.name + "|" + r.role + "|" + r.fence_type;

// ===================================================== the engine, any copy of it ==
const JOB_SYNC = "a4000000-0000-4000-8000-000000000001";
const RUN_SYNC = "a4000000-0000-4000-8000-000000000002";
const MFR_A = "a4000000-0000-4000-8000-0000000000a1";
const MFR_B = "a4000000-0000-4000-8000-0000000000b2";

const jobRow = (o = {}) => ({
  sync_id: JOB_SYNC, updated_at: "2026-10-01T12:00:00Z", calibration_pixels_per_foot: null,
  tax_rate_percent: 7, markup_percent: 0, discount_percent: 0, labor_rate_per_ft: 8, labor_flat_fee: 0,
  minimum_job_charge: 200, minimum_labor_charge: 0, waste_percent: 0, gate_rate_per_ft: 20, trash_haul_fee: 0,
  teardown_enabled: false, teardown_flat_fee: 0, teardown_rate_per_ft: 0, teardown_feet: 0,
  preferred_manufacturer_sync_id: null, survey_storage_path: null, ...o,
});
/** A run typed in by length (no drawing needed). Post spacing follows the panel width, as the UI keeps it. */
const runRow = (o = {}) => ({
  sync_id: RUN_SYNC, label: "Back", fence_type: "VINYL", color_or_finish: "", points_encoded: "",
  gates_encoded: "", closed_loop: false, manual_linear_feet: 100, manual_corner_count: 0, panel_width_ft: 6,
  panel_height_ft: 6, post_spacing_ft: o.panel_width_ft ?? 6, concrete_bags_per_post: 1, aluminum_style: "RACKABLE",
  wood_style: "PRIVACY", wood_rail_count: 3, picket_width_in: 5.5, picket_gap_in: 0, fabric_height_ft: 4,
  include_top_rail: true, include_tension_wire: false, include_barbed_wire_arms: false,
  include_privacy_slats: false, split_rail_count: 2, suppressed_roles: "", is_teardown: false, sort_order: 0, ...o,
});

/**
 * Catalog rows as price-job reads them. `heights` (a Map of identity -> feet) adds height_ft to the rows it names and to no
 * other; a row object that carries its own height_ft is passed through; every other row has NO such key at all, which is what
 * a database that predates the column hands over.
 */
const dbRows = (rows, heights = null) => rows.map((r, i) => {
  const row = {
    sync_id: "a4000000-0000-4000-8000-" + String(100 + i).padStart(12, "0"), name: r.name, category: r.category ?? r.role,
    role: r.role, fence_type: r.fence_type, color_or_finish: r.color_or_finish ?? "", unit: r.unit ?? "EA", unit_price: r.unit_price,
    taxable: r.taxable ?? true, covers_ft: r.covers_ft ?? null, manufacturer_sync_id: r.manufacturer_sync_id ?? null, is_active: r.is_active ?? true,
  };
  if (r.height_ft !== undefined) row.height_ft = r.height_ft;
  else if (heights && heights.has(identity(r))) row.height_ft = heights.get(identity(r));
  return row;
});

/** A copy of the engine: the repo's own (the default) or a mutant living in a temp directory. */
const engineOf = (mod, load) => ({
  version: mod.PRICING_ENGINE_VERSION,
  price(run, rows, o = {}) {
    return mod.priceJob(load.buildPricingInput({
      job: jobRow(o.job), runs: [run], catalog: dbRows(rows, o.heights ?? null), manufacturers: o.manufacturers ?? [],
      changeOrders: [], existingItems: [], engineVersion: mod.PRICING_ENGINE_VERSION,
    }));
  },
});
const REAL = engineOf(realIndex, realLoad);

/** Everything a quote is made of, as one comparable string. */
const quote = (out) => JSON.stringify({ items: out.items, unmatched: out.unmatched_roles, zero: out.zero_priced_names, totals: out.totals });
const line = (out, role) => out.items.find((i) => i.role === role);
const lines = (out, role) => out.items.filter((i) => i.role === role);
const cents = (x) => Math.round(x * 100) / 100;

const IRON_6 = (o = {}) => runRow({ fence_type: "ORNAMENTAL_IRON", color_or_finish: "Black", panel_width_ft: 6, panel_height_ft: 6, post_spacing_ft: 6, ...o });
const IRON_4H_6W = "Ornamental Steel Panel 4'H x 6'W, Black";
const IRON_6H_6W = "Ornamental Steel Panel 6'H x 6'W, Black";
const IRON_4H_8W = "Ornamental Steel Panel 4'H x 8'W, Black";
const withoutRow = (rows, name) => rows.filter((r) => r.name !== name);

/** One synthetic catalog row. Ids come from position, so every tie breaks the same way every time. */
const syn = (o) => ({ category: "PANEL", unit: "EA", taxable: true, color_or_finish: "", covers_ft: null, ...o });

// ================================================================ 0. HARNESS ==

test("harness: the seed is read, the migration's list is read, and the real engine prices an iron run with a panel line", () => {
  assert.ok(SEED.length >= 92, "found only " + SEED.length + " seed rows");
  assert.equal(HEIGHTS.size, 15, "PART 3 of the migration should name fifteen rows, found " + HEIGHTS.size);
  const out = REAL.price(IRON_6(), SEED);
  assert.ok(line(out, "PANEL"), "no PANEL line on a 100 ft iron quote -- the harness is dead, fix it before trusting anything below");
  assert.equal(line(out, "PANEL").quantity, 17, "100 ft at 6 ft a bay is 17 panels");
  // CONTROL: the quote responds to a change that is nothing to do with height, so "nothing moved" below can be a finding.
  assert.notEqual(quote(REAL.price(IRON_6({ manual_linear_feet: 110 }), SEED)), quote(out), "control: ten more feet moved nothing");
  assert.equal(REAL.version, "2026.10.2");
});

// ================================================================== 1. THE FIX ==

test("THE FIX: with the starting-list heights, a 6 ft high iron run is priced with the 6'H panel -- the quote is what it would be with the 4'H row removed", () => {
  const bug = REAL.price(IRON_6(), SEED); // no heights anywhere: today's behaviour, kept
  assert.equal(line(bug, "PANEL").description, IRON_4H_6W, "a catalog with no heights still takes the cheaper 4'H panel (the defect, unchanged for a catalog that never says)");
  const fixed = REAL.price(IRON_6(), SEED, { heights: HEIGHTS });
  const p = line(fixed, "PANEL");
  assert.equal(p.description, IRON_6H_6W);
  assert.equal(p.unit_price, 175);
  assert.equal(p.quantity, 17);
  // "Correct" is the same quote with the 4'H x 6'W row removed and nothing else changed (docs/PANEL_HEIGHT_BLINDNESS.md section 3).
  const correct = REAL.price(IRON_6(), withoutRow(SEED, IRON_4H_6W));
  assert.equal(quote(fixed), quote(correct), "the fixed quote differs from the 4'H-row-removed quote in more than the panel");
});

test("THE COST, now recovered: $40 a panel before tax and markup -- 100 ft and 200 ft, at 0% and 15% markup", () => {
  const table = [
    // [feet, markup %, panels, expected shortfall recovered]
    [100, 0, 17, 727.6], [200, 0, 34, 1455.2], [100, 15, 17, 836.74], [200, 15, 34, 1673.48],
  ];
  for (const [feet, markup, panels, expected] of table) {
    const before = REAL.price(IRON_6({ manual_linear_feet: feet }), SEED, { job: { markup_percent: markup } });
    const after = REAL.price(IRON_6({ manual_linear_feet: feet }), SEED, { job: { markup_percent: markup }, heights: HEIGHTS });
    assert.equal(line(before, "PANEL").quantity, panels);
    assert.equal(line(after, "PANEL").quantity, panels);
    const rise = cents(after.totals.grand_total - before.totals.grand_total);
    assert.ok(rise > 0, "the fix must RAISE a 6 ft iron quote (it was an undercharge)");
    assert.ok(Math.abs(rise - expected) <= 0.011, `${feet} ft at ${markup}%: the quote rose ${rise}, expected ${expected} (= ${panels} panels x $40 x 1.07 x ${1 + markup / 100})`);
    // Only the panel line differs: every other line of the two quotes is byte for byte the same.
    const rest = (o) => JSON.stringify(o.items.filter((i) => i.role !== "PANEL"));
    assert.equal(rest(after), rest(before), "something other than the panel line moved");
  }
});

test("a 4 ft high iron run is unaffected (its panel was always the 4'H one), and so is every iron run no row declares a height for", () => {
  const sameAsToday = (run, why) => assert.equal(quote(REAL.price(run, SEED, { heights: HEIGHTS })), quote(REAL.price(run, SEED)), why);
  sameAsToday(IRON_6({ panel_height_ft: 4 }), "a 4 ft iron run moved");
  assert.equal(line(REAL.price(IRON_6({ panel_height_ft: 4 }), SEED, { heights: HEIGHTS }), "PANEL").description, IRON_4H_6W, "control: the 4 ft run still takes the 4'H panel");
  // No iron row declares 5, 7 or 8: nothing is set aside, and the choice is today's. (A 5 ft run keeps the 4'H panel, as before --
  // this rule does not guess "the next size up"; see the report.)
  for (const h of [5, 7, 8, 3]) sameAsToday(IRON_6({ panel_height_ft: h }), `a ${h} ft iron run moved though no row declares ${h} ft`);
});

test("a 6 ft high iron run at 8 ft panels keeps the only 8 ft row (a 4'H one): there is no 6'H x 8'W row, and height never changes which WIDTHS are in the running", () => {
  const run = IRON_6({ panel_width_ft: 8, post_spacing_ft: 8 });
  const out = REAL.price(run, SEED, { heights: HEIGHTS });
  assert.equal(line(out, "PANEL").description, IRON_4H_8W);
  assert.equal(quote(out), quote(REAL.price(run, SEED)), "an iron run at 8 ft panels moved");
});

test("every gate, and every non-iron fence, prices as it did when the starting-list heights are filled in", () => {
  const gates = ["400.0:0.0:4.0:LINE:IN", "400.0:0.0:6.0:LINE:IN,1200.0:0.0:4.0:LINE:IN"];
  let compared = 0;
  for (const fence_type of ["VINYL", "ALUMINUM", "ORNAMENTAL_IRON", "WOOD", "CHAIN_LINK", "COMPOSITE", "SPLIT_RAIL"])
    for (const color_or_finish of ["", "White", "Black", "Tan"])
      for (const panel_height_ft of [3, 4, 5, 6, 8])
        for (const panel_width_ft of [4, 6, 8])
          for (const gates_encoded of ["", ...gates]) {
            // THE FIX, covered above: a 6 ft iron run at 4 or 6 ft panels is the one place a quote is meant to move. (At 8 ft panels the only row is the 4'H one: covered above too.)
            if (fence_type === "ORNAMENTAL_IRON" && panel_height_ft === 6 && panel_width_ft !== 8) continue;
            const run = runRow({ fence_type, color_or_finish, panel_height_ft, panel_width_ft, post_spacing_ft: panel_width_ft, gates_encoded });
            assert.equal(quote(REAL.price(run, SEED, { heights: HEIGHTS })), quote(REAL.price(run, SEED)),
              `moved: ${fence_type} "${color_or_finish}" ${panel_height_ft} ft high, ${panel_width_ft} ft panels, gates "${gates_encoded}"`);
            compared++;
          }
  assert.ok(compared > 800, "the sweep shrank to " + compared);
  // CONTROL: the very same comparison DOES see the fix, on the one run it must.
  assert.notEqual(quote(REAL.price(IRON_6(), SEED, { heights: HEIGHTS })), quote(REAL.price(IRON_6(), SEED)), "control: the sweep's comparison cannot see the iron fix");
});

// ======================================================= 2. IT IS ADDITIVE ==

const FIXTURE_DIR = join(ROOT, "fixtures/pricing");
const FIXTURES = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json") && f !== "manifest.json")
  .map((f) => ({ file: f, ...JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) }));

const V = realIndex.PRICING_ENGINE_VERSION;
/** A fixture's input with every catalog height removed / with the starting-list heights put on the rows the migration names. */
const noHeights = (fx) => ({ ...fx.input, engine_version: V, catalog: fx.input.catalog.map(({ height_ft, ...row }) => row) });
const starterHeights = (fx) => ({ ...fx.input, engine_version: V,
  catalog: fx.input.catalog.map((c) => HEIGHTS.has(identity(c)) ? { ...c, height_ft: HEIGHTS.get(identity(c)) } : c) });
const declaresAHeight = (fx) => fx.input.catalog.some((c) => c.height_ft !== undefined && c.height_ft !== null);

test("ADDITIVE: the 85 recorded fixtures -- outputs of the engine BEFORE this change -- are priced identically when no row declares a height", () => {
  assert.ok(FIXTURES.length >= 85, "the fixture set shrank to " + FIXTURES.length);
  const undeclared = FIXTURES.filter((fx) => !declaresAHeight(fx));
  assert.ok(undeclared.length >= 80, "control: only " + undeclared.length + " fixtures are free of heights, so this does not test the guarantee");
  for (const fx of FIXTURES) {
    // The recorded input carries the version it was written under, which priceJob refuses on purpose; everything else is the recorded price.
    // (Once the fixtures are regenerated under this version a fixture may declare heights itself; its recorded price then includes them.)
    assert.deepStrictEqual(realIndex.priceJob({ ...fx.input, engine_version: V }), { ...fx.expected, engine_version: V }, `${fx.file}: priced differently from its recording`);
    // And with every height stripped it prices the same as a catalog that never had the column, which is what a fixture without one is.
    if (!declaresAHeight(fx)) assert.deepStrictEqual(realIndex.priceJob(noHeights(fx)), { ...fx.expected, engine_version: V }, `${fx.file}: a catalog with no height priced differently`);
  }
  // CONTROL: the comparison is not blind. Give one fixture the starting-list heights and it must report a difference.
  const iron = FIXTURES.find((f) => f.file === "ornamental-iron-drawn-open-wall-gate.json");
  assert.notDeepStrictEqual(realIndex.priceJob(starterHeights(iron)), realIndex.priceJob(noHeights(iron)), "control: the comparison cannot see a height");
});

test("WHOSE PRICE MOVES, on the recorded fixtures: with the starting-list heights applied to every catalog, exactly the two iron ones change, both UP", () => {
  const moved = [];
  for (const fx of FIXTURES) {
    const base = realIndex.priceJob(noHeights(fx)), withHeights = realIndex.priceJob(starterHeights(fx));
    if (JSON.stringify(withHeights) !== JSON.stringify(base)) moved.push([fx.file, cents(withHeights.totals.grand_total - base.totals.grand_total)]);
  }
  assert.deepEqual(moved, [["ornamental-iron-drawn-open-wall-gate.json", 856], ["template-08-ornamental-iron-6ft.json", 836.74]],
    "the set of fixtures that change is not the two iron ones: " + JSON.stringify(moved));
});

test("ADDITIVE, by construction: height_ft null, undefined and absent are the same row, and mean 'does not say'", () => {
  const run = IRON_6();
  const absent = REAL.price(run, SEED);
  const explicitNull = realIndex.priceJob(realLoad.buildPricingInput({
    job: jobRow(), runs: [run], catalog: dbRows(SEED).map((r) => ({ ...r, height_ft: null })), manufacturers: [], changeOrders: [], existingItems: [],
    engineVersion: realIndex.PRICING_ENGINE_VERSION }));
  const undef = realIndex.priceJob(realLoad.buildPricingInput({
    job: jobRow(), runs: [run], catalog: dbRows(SEED).map((r) => ({ ...r, height_ft: undefined })), manufacturers: [], changeOrders: [], existingItems: [],
    engineVersion: realIndex.PRICING_ENGINE_VERSION }));
  assert.equal(quote(explicitNull), quote(absent));
  assert.equal(quote(undef), quote(absent));
});

// ============================================== 3. THE SIBLING-WIDTH TRAP (4) ==

const GATES_4_AND_6 = "400.0:0.0:4.0:LINE:IN,1200.0:0.0:6.0:LINE:IN";
/** Vinyl gates of three widths, all White, all 6 ft high by name; only the 5 ft one DECLARES it. (The shape of three recorded fixtures.) */
const gateCatalog = (declare) => [
  syn({ name: "Vinyl Panel 6'H x 6'W - White", role: "PANEL", fence_type: "VINYL", unit_price: 52, covers_ft: 6, color_or_finish: "White" }),
  syn({ name: "Vinyl Gate 6'H x 4'W, White", category: "GATE", role: "GATE_PANEL", fence_type: "VINYL", unit_price: 170, covers_ft: 4, color_or_finish: "White" }),
  syn({ name: "Regular PVC Gate 6'H x 5'W, White", category: "GATE", role: "GATE_PANEL", fence_type: "VINYL", unit_price: 145.05, covers_ft: 5, color_or_finish: "White", ...(declare ? { height_ft: 6 } : {}) }),
  syn({ name: "Vinyl Gate 6'H x 6'W, White", category: "GATE", role: "GATE_PANEL", fence_type: "VINYL", unit_price: 230, covers_ft: 6, color_or_finish: "White" }),
];
const checkSiblingWidths = (E) => {
  const run = runRow({ color_or_finish: "White", gates_encoded: GATES_4_AND_6 });
  const none = E.price(run, gateCatalog(false)), one = E.price(run, gateCatalog(true));
  assert.deepEqual(lines(none, "GATE_PANEL").map((l) => l.description).sort(), ["Vinyl Gate 6'H x 4'W, White", "Vinyl Gate 6'H x 6'W, White"], "control: with no height declared a 4 ft and a 6 ft gate take the 4 ft and 6 ft rows");
  assert.equal(quote(one), quote(none), "declaring a height on the 5 ft gate hid the 4 ft and 6 ft gates beside it, and moved a quote that has nothing to do with height");
};

test("THE SIBLING-WIDTH TRAP: a height declared on one gate row does not hide the gate rows of other widths", () => checkSiblingWidths(REAL));

// ========================================== 4. THE OWNER'S 4 FT REQUEST (5) ==

const vinylWithShortNewcomer = (newcomerHeight) => [
  syn({ name: "Vinyl Panel 6'H x 6'W - White", role: "PANEL", fence_type: "VINYL", unit_price: 52.35, covers_ft: 6, color_or_finish: "White", height_ft: 6 }),
  syn({ name: "Vinyl Panel 4'H x 6'W - White", role: "PANEL", fence_type: "VINYL", unit_price: 40, covers_ft: 6, color_or_finish: "White", ...(newcomerHeight === undefined ? {} : { height_ft: newcomerHeight }) }),
];

test("THE OWNER'S 4 FT REQUEST: a cheaper 4 ft panel added at an existing width does not take over the 6 ft quotes -- with or without its own height", () => {
  for (const newcomer of [undefined, 4]) {
    const six = REAL.price(runRow({ color_or_finish: "White", panel_height_ft: 6 }), vinylWithShortNewcomer(newcomer));
    assert.equal(line(six, "PANEL").description, "Vinyl Panel 6'H x 6'W - White", `6 ft run, newcomer height ${newcomer}`);
    const four = REAL.price(runRow({ color_or_finish: "White", panel_height_ft: 4 }), vinylWithShortNewcomer(newcomer));
    // A 4 ft run: with the newcomer declared it is chosen on height; undeclared, nothing declares 4 ft, so the old rule applies
    // (nearest width, then cheapest) and the cheaper 4 ft row still wins. Either way the 4 ft fence gets the 4 ft panel.
    assert.equal(line(four, "PANEL").description, "Vinyl Panel 4'H x 6'W - White", `4 ft run, newcomer height ${newcomer}`);
  }
  // CONTROL: without the 6'H row's declared height the newcomer takes over the 6 ft quote -- the defect this fixes.
  const undeclared = vinylWithShortNewcomer(undefined).map((r) => { const { height_ft, ...rest } = r; return rest; });
  assert.equal(line(REAL.price(runRow({ color_or_finish: "White", panel_height_ft: 6 }), undeclared), "PANEL").description, "Vinyl Panel 4'H x 6'W - White", "control: with no heights declared the cheaper 4 ft panel takes the 6 ft quote");
});

// ================================================= 5. SCOPE, AND THE ORDER (6) ==

test("colour and manufacturer come FIRST: height only chooses among what they leave", () => {
  // Black 4'H (declared) and White 6'H (declared). The run wants Black, 6 ft high: colour leaves one row, so height has nothing to choose.
  const rows = [
    syn({ name: "Panel 4'H Black", role: "PANEL", fence_type: "VINYL", unit_price: 100, covers_ft: 6, color_or_finish: "Black", height_ft: 4 }),
    syn({ name: "Panel 6'H White", role: "PANEL", fence_type: "VINYL", unit_price: 50, covers_ft: 6, color_or_finish: "White", height_ft: 6 }),
  ];
  assert.equal(line(REAL.price(runRow({ color_or_finish: "Black", panel_height_ft: 6 }), rows), "PANEL").description, "Panel 4'H Black", "height overrode the run's colour");
  // The job prefers manufacturer A, whose only row is undeclared; manufacturer B's row declares 6 ft. A stays.
  const mfr = [
    syn({ name: "A panel", role: "PANEL", fence_type: "VINYL", unit_price: 90, covers_ft: 6, manufacturer_sync_id: MFR_A }),
    syn({ name: "B panel 6'H", role: "PANEL", fence_type: "VINYL", unit_price: 60, covers_ft: 6, manufacturer_sync_id: MFR_B, height_ft: 6 }),
  ];
  const manufacturers = [{ sync_id: MFR_A, name: "A" }, { sync_id: MFR_B, name: "B" }];
  assert.equal(line(REAL.price(runRow(), mfr, { manufacturers, job: { preferred_manufacturer_sync_id: MFR_A } }), "PANEL").description, "A panel", "height overrode the job's preferred manufacturer");
  // CONTROL: with no preference, the declared 6'H row wins at the same width.
  assert.equal(line(REAL.price(runRow(), mfr, { manufacturers }), "PANEL").description, "B panel 6'H");
});

test("only PANEL and GATE_PANEL read height: not posts, not chain-link fabric, not a gate frame kit", () => {
  // POSTS: a cheap undeclared post and a dearer one that declares 6. The cheapest still wins -- a post's number is a length, not a fence height.
  const posts = [
    syn({ name: "Post cheap", category: "POST", role: "LINE_POST", fence_type: "VINYL", unit_price: 5 }),
    syn({ name: "Post dear", category: "POST", role: "LINE_POST", fence_type: "VINYL", unit_price: 9, height_ft: 6 }),
  ];
  assert.equal(line(REAL.price(runRow({ panel_height_ft: 6 }), posts), "LINE_POST").description, "Post cheap");
  // CHAIN-LINK FABRIC: its height is its covers_ft. Two rows of one covers_ft, the cheaper undeclared; the dearer one declares 6.
  const fabric = [
    syn({ name: "Fabric cheap 4ft", category: "FABRIC", role: "CHAIN_FABRIC", fence_type: "CHAIN_LINK", unit_price: 10, covers_ft: 4, unit: "FT" }),
    syn({ name: "Fabric dear 4ft", category: "FABRIC", role: "CHAIN_FABRIC", fence_type: "CHAIN_LINK", unit_price: 20, covers_ft: 4, unit: "FT", height_ft: 6 }),
  ];
  assert.equal(line(REAL.price(runRow({ fence_type: "CHAIN_LINK", fabric_height_ft: 4, panel_height_ft: 6 }), fabric), "CHAIN_FABRIC").description, "Fabric cheap 4ft");
  // A GATE FRAME KIT (wood / chain link / composite gates): same.
  const kits = [
    syn({ name: "Kit cheap", category: "GATE", role: "GATE_FRAME_KIT", fence_type: "WOOD", unit_price: 50, covers_ft: 4 }),
    syn({ name: "Kit dear", category: "GATE", role: "GATE_FRAME_KIT", fence_type: "WOOD", unit_price: 80, covers_ft: 4, height_ft: 6 }),
  ];
  assert.equal(line(REAL.price(runRow({ fence_type: "WOOD", panel_height_ft: 6, gates_encoded: "400.0:0.0:4.0:LINE:IN" }), kits), "GATE_FRAME_KIT").description, "Kit cheap");
});

const checkRoleGate = (E) => {
  const posts = [
    syn({ name: "Post cheap", category: "POST", role: "LINE_POST", fence_type: "VINYL", unit_price: 5 }),
    syn({ name: "Post dear", category: "POST", role: "LINE_POST", fence_type: "VINYL", unit_price: 9, height_ft: 6 }),
  ];
  assert.equal(line(E.price(runRow({ panel_height_ft: 6 }), posts), "LINE_POST").description, "Post cheap", "a post was chosen by height");
};

test("heights are exact Floats: 4.1 matches 4.1 (the way covers_ft does), 4.2 does not", () => {
  const rows = (h) => [
    syn({ name: "Panel declared " + h, role: "PANEL", fence_type: "VINYL", unit_price: 80, covers_ft: 6, height_ft: h }),
    syn({ name: "Panel plain", role: "PANEL", fence_type: "VINYL", unit_price: 60, covers_ft: 6 }),
  ];
  assert.equal(line(REAL.price(runRow({ panel_height_ft: 4.1 }), rows(4.1)), "PANEL").description, "Panel declared 4.1", "4.1 did not match 4.1 across the Float boundary");
  assert.equal(line(REAL.price(runRow({ panel_height_ft: 4.1 }), rows(4.2)), "PANEL").description, "Panel plain", "4.2 matched 4.1");
  assert.equal(line(REAL.price(runRow({ panel_height_ft: 4.5 }), rows(4.5)), "PANEL").description, "Panel declared 4.5", "4.5, exactly a Float");
});

test("an unpriced row of the right height is not quietly replaced by a priced row of the wrong one: the quote shows $0 and names it", () => {
  // The old rule would have taken the priced 4'H panel and said nothing. A catalog row that is the right height and has no price yet
  // is something the owner must see, and zero_priced_names is where the app already says so.
  const rows = [
    syn({ name: "Panel 6'H unpriced", role: "PANEL", fence_type: "VINYL", unit_price: 0, covers_ft: 6, height_ft: 6 }),
    syn({ name: "Panel 4'H priced", role: "PANEL", fence_type: "VINYL", unit_price: 40, covers_ft: 6, height_ft: 4 }),
  ];
  const out = REAL.price(runRow({ panel_height_ft: 6 }), rows);
  assert.equal(line(out, "PANEL").description, "Panel 6'H unpriced");
  assert.equal(line(out, "PANEL").unit_price, 0);
  assert.deepEqual(out.zero_priced_names.map((z) => z.name), ["Panel 6'H unpriced"]);
});

// ====================================================== 6. THE CONTRACT (7) ==

test("the wire contract: height_ft is optional, a Float like covers_ft, null when absent, and never emitted for a row that has none", () => {
  const row = (extra = {}) => ({ sync_id: "a4000000-0000-4000-8000-0000000000c1", name: "P", category: "PANEL", role: "PANEL", fence_type: "VINYL",
    color_or_finish: "", unit: "EA", unit_price: 1, taxable: true, covers_ft: 6, is_active: true, manufacturer_sync_id: null, ...extra });
  const ids = new Set();
  assert.equal(realIndex.materialItemFromRow(row(), 0, ids).heightFt, null, "absent key");
  assert.equal(realIndex.materialItemFromRow(row({ height_ft: null }), 0, ids).heightFt, null, "null");
  assert.equal(realIndex.materialItemFromRow(row({ height_ft: 6 }), 0, ids).heightFt, 6, "6");
  assert.equal(realIndex.materialItemFromRow(row({ height_ft: 4.5 }), 0, ids).heightFt, 4.5, "4.5 is exactly a Float");
  assert.throws(() => realIndex.materialItemFromRow(row({ height_ft: 4.1 }), 3, ids), /catalog\[3\]\.height_ft = 4\.1 is not representable as a Float/, "an un-fround'd value is refused, as covers_ft is");
  // load.ts: fround'd on the way in (a Postgres real arrives as a double), and the key is left off when there is nothing to say.
  const fromDb = realLoad.materialItemRowToInput(row({ height_ft: 4.1 }));
  assert.equal(fromDb.height_ft, Math.fround(4.1));
  assert.equal(realIndex.materialItemFromRow(fromDb, 0, ids).heightFt, Math.fround(4.1), "what load.ts writes, index.ts accepts");
  for (const none of [{}, { height_ft: null }, { height_ft: undefined }])
    assert.equal("height_ft" in realLoad.materialItemRowToInput(row(none)), false, "an empty height must not appear on the wire: the phone's test-side decoder refuses unknown keys");
});

test("the engines never read a name for a height: no name, no parse and no pattern in the height step, on either side", () => {
  const ts = read("supabase/functions/_shared/pricing/line-items.ts");
  const kt = stripKt(read("app/src/main/java/com/fenceestimator/app/estimate/EstimateEngine.kt"));
  const tsCode = ts.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const block = (code, start, end) => { const a = code.indexOf(start), b = code.indexOf(end, a); assert.ok(a > 0 && b > a, "block not found: " + start); return code.slice(a, b); };
  const tsBlock = block(tsCode, 'if (entry.role === "PANEL" || entry.role === "GATE_PANEL")', "let chosen: MaterialItem | null;");
  const ktBlock = block(kt, "if (entry.role == MaterialRole.PANEL || entry.role == MaterialRole.GATE_PANEL)", "val chosen = if (entry.preferCoversFt != null)");
  for (const [side, code] of [["line-items.ts", tsBlock], ["EstimateEngine.kt", ktBlock]]) {
    assert.ok(/heightFt/.test(code), side + ": control: the block is the height step");
    for (const bad of [/\bname\b/, /\.match\(|\.test\(|RegExp|Regex|toRegex/, /parseFloat|toFloat|Number\(|parseInt/, /\.description\b/])
      assert.ok(!bad.test(code), `${side}: the height step reads or parses text (${bad})`);
  }
});

// ============================================================ 7. TEETH (8) ==
// Four mutants of the engine, built in a temp directory from the real source, each run through the checks. A check that cannot
// fail on the engine it guards is decoration.

const scenarioFix = (E) => {
  const out = E.price(IRON_6(), SEED, { heights: HEIGHTS });
  assert.equal(line(out, "PANEL").description, IRON_6H_6W, "the 6 ft iron run was not priced with the 6'H panel");
};
const scenarioOwner = (E) => {
  const out = E.price(runRow({ color_or_finish: "White", panel_height_ft: 6 }), vinylWithShortNewcomer(undefined));
  assert.equal(line(out, "PANEL").description, "Vinyl Panel 6'H x 6'W - White", "a cheaper shorter panel took the 6 ft quote");
};
const scenarioFabricOrPosts = (E) => {
  checkRoleGate(E);
  const fabric = [
    syn({ name: "Fabric cheap 4ft", category: "FABRIC", role: "CHAIN_FABRIC", fence_type: "CHAIN_LINK", unit_price: 10, covers_ft: 4, unit: "FT" }),
    syn({ name: "Fabric dear 4ft", category: "FABRIC", role: "CHAIN_FABRIC", fence_type: "CHAIN_LINK", unit_price: 20, covers_ft: 4, unit: "FT", height_ft: 6 }),
  ];
  assert.equal(line(E.price(runRow({ fence_type: "CHAIN_LINK", fabric_height_ft: 4, panel_height_ft: 6 }), fabric), "CHAIN_FABRIC").description, "Fabric cheap 4ft", "fabric was chosen by panel height");
};
const scenarioNoNameParse = (E) => {
  // Two same-width rows that NAME a height and declare none. A name read as a height would pick the 6'H one; the engine must not.
  const rows = [
    syn({ name: "Panel 6'H x 6'W - White", role: "PANEL", fence_type: "VINYL", unit_price: 70, covers_ft: 6, color_or_finish: "White" }),
    syn({ name: "Panel 4'H x 6'W - White", role: "PANEL", fence_type: "VINYL", unit_price: 40, covers_ft: 6, color_or_finish: "White" }),
  ];
  assert.equal(line(E.price(runRow({ color_or_finish: "White", panel_height_ft: 6 }), rows), "PANEL").description, "Panel 4'H x 6'W - White", "a height was read out of a NAME");
};

const ALL_CHECKS = { fix: scenarioFix, owner: scenarioOwner, siblingWidths: checkSiblingWidths, fabricOrPosts: scenarioFabricOrPosts, noNameParse: scenarioNoNameParse };

/** Copies the pricing source to a temp dir, applies `mutate` to line-items.ts (asserting it changed something), and loads that copy. */
async function mutant(mutate, label) {
  const dir = mkdtempSync(join(tmpdir(), "a40-mutant-"));
  for (const f of readdirSync(PRICING_DIR)) if (/^(f32|geometry|index|kotlin-text|line-items|load|takeoff|totals|types|uuid3)\.ts$/.test(f)) copyFileSync(join(PRICING_DIR, f), join(dir, f));
  const src = readFileSync(join(dir, "line-items.ts"), "utf8");
  const next = mutate(src);
  assert.notEqual(next, src, `the ${label} mutation did not change line-items.ts: the mutant is the real engine`);
  writeFileSync(join(dir, "line-items.ts"), next);
  const [idx, load] = await Promise.all([import(pathToFileURL(join(dir, "index.ts")).href), import(pathToFileURL(join(dir, "load.ts")).href)]);
  return engineOf(idx, load);
}

const STEP = /    if \(entry\.role === "PANEL" \|\| entry\.role === "GATE_PANEL"\) \{[\s\S]*?\r?\n    \}\r?\n/;

test("TEETH: the real engine passes every check", () => {
  for (const [name, check] of Object.entries(ALL_CHECKS)) assert.doesNotThrow(() => check(REAL), name);
});

test("TEETH: with the height step REMOVED the 6 ft iron run and the owner's 4 ft request both fail -- the defect itself", async () => {
  const E = await mutant((s) => s.replace(STEP, ""), "remove-the-step");
  assert.throws(() => scenarioFix(E), /6'H panel/);
  assert.throws(() => scenarioOwner(E), /cheaper shorter panel took the 6 ft quote/);
});

test("TEETH: with the ROLE GATE removed, posts and chain-link fabric are chosen by panel height", async () => {
  const E = await mutant((s) => s.replace('if (entry.role === "PANEL" || entry.role === "GATE_PANEL") {', "if (true) {"), "remove-the-role-gate");
  assert.throws(() => scenarioFabricOrPosts(E), /by height|panel height/);
  assert.doesNotThrow(() => scenarioFix(E), "control: the role-gate mutant still fixes the iron run, so it is only the scope check that catches it");
});

test("TEETH: the strict whole-list narrowing (the first draft) hides the sibling widths of a gate", async () => {
  const E = await mutant((s) => s.replace(STEP,
    '    if (entry.role === "PANEL" || entry.role === "GATE_PANEL") {\n      const heightMatches = candidates.filter((c) => c.heightFt === run.panelHeightFt);\n      if (heightMatches.length > 0) candidates = heightMatches;\n    }\n'), "strict-narrowing");
  assert.doesNotThrow(() => scenarioFix(E), "control: the strict mutant fixes the iron run too, so only the sibling-width check can tell it from the real rule");
  assert.throws(() => checkSiblingWidths(E), /hid the 4 ft and 6 ft gates/);
});

test("TEETH: an engine that reads the height out of the NAME fails the no-name-parse check (and the real one does not)", async () => {
  const E = await mutant((s) => s.replace(STEP,
    '    if (entry.role === "PANEL" || entry.role === "GATE_PANEL") {\n      const named = candidates.filter((c) => c.name.includes(String(run.panelHeightFt) + "\'H"));\n      if (named.length > 0) candidates = named;\n    }\n'), "name-parse");
  assert.throws(() => scenarioNoNameParse(E), /read out of a NAME/);
});
