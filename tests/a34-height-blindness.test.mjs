// a34-height-blindness -- the engine chooses a catalog row by WIDTH (panels, gates) or by PRICE (everything
// else), and never by HEIGHT. This file measures what that costs, against the real engine and the real
// starting catalog. The write-up is docs/PANEL_HEIGHT_BLINDNESS.md; every number in it comes from here.
//
//   node --test tests/a34-height-blindness.test.mjs                   (no network, no writes)
//   A34_TABLE=1 node --test tests/a34-height-blindness.test.mjs       (also prints the tables the doc quotes)
//   A34_LIVE=1  node --test tests/a34-height-blindness.test.mjs       (also runs the READ-ONLY live probe, ~2-10 min)
//
// WHAT IT PINS
//   1. THE CENSUS. Every group of PANEL / GATE_PANEL / GATE_FRAME_KIT rows that share a fence type and a
//      width is listed -- the collisions AND the ones that are clean, because a list of only hits cannot be
//      told from a list that stopped looking. Exactly one collision ships: ornamental steel 4'H and 6'H, both
//      6 ft wide. A planted pair proves the detector can see one.
//   2. THE COST, from the real priceJob: the iron 6'H run is priced with the 4'H panel -- an UNDERCHARGE of
//      $40 a panel before tax and markup, $727.60 on 100 ft and $1,455.20 on 200 ft at 7% tax.
//   3. THE SCOPE. panel_height_ft is read by NO pricing code on either side, so it changes no quote for any
//      fence type. Every role the takeoff asks for is chosen by width or by price alone: proved row by row by
//      planting a cheaper decoy that wins whatever height its name claims.
//   4. THE FIX, as a REFERENCE MODEL kept in this file (a tie-break between equal-width rows). It is NOT the
//      engine and the engine does not do it. The model is first proved to reproduce today's engine exactly,
//      then used to show what the fix would and would not change: no single-height catalog, no catalog without
//      heights in its names, and 83 of the 85 parity fixtures. It is the executable spec for the fix.
//   5. THE LIVE DATA (A34_LIVE=1 only): a read-only SELECT with a synthetic canary company that must be found.
//
// THE TRIPWIRES. Blocks 2 and 3 pin how the engine behaves TODAY. The day line-items.ts and
// EstimateEngine.buildLineItems read height, they go red, and the failure messages say what to rewrite. Do not
// loosen them. The census (block 1) goes red the day a row is ADDED that shares a fence type and width with a
// row of another height: that is this bug being shipped again, and the message says so.
//
// EVERY CHECK HAS A CONTROL. "Nothing found" reads the same as "the checker cannot see", so each negative
// result here sits beside a positive one produced by the same code on a planted case.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { buildPricingInput } from "../supabase/functions/_shared/pricing/load.ts";
import { PRICING_ENGINE_VERSION, priceJob } from "../supabase/functions/_shared/pricing/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const TABLE = process.env.A34_TABLE === "1";
const show = (...a) => { if (TABLE) console.log(...a); };

const SEED_PATH = "app/src/main/java/com/fenceestimator/app/data/SeedData.kt";
const KT_ENGINE = "app/src/main/java/com/fenceestimator/app/estimate/EstimateEngine.kt";
const KT_ENTITIES = "app/src/main/java/com/fenceestimator/app/data/Entities.kt";
const TS_DIR = "supabase/functions/_shared/pricing/";
const PROJECT = "newcrgafcptspmapacrx";

// ================================================================== readers ==
// The seed reader is the one tests/a32-transition-item.test.mjs and tests/a31-seed-panels-are-taxable.test.mjs
// use: it reads the item(...) calls of SeedData.kt, comments ignored.

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

/** Source with comments blanked and string/char literals left whole. kind: "kt" or "ts". */
function stripCode(src, kind) {
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '"' || (kind === "ts" && (c === "'" || c === "`"))) {
      let j = i + 1; while (j < src.length && src[j] !== c) { if (src[j] === "\\") j++; j++; }
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    if (kind === "kt" && c === "'") { // a char literal: 'x' or '\n' or '\''
      const j = src[i + 1] === "\\" ? i + 3 : i + 2;
      if (src[j] === "'") { out += src.slice(i, j + 1); i = j + 1; continue; }
    }
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; out += " "; continue; }
    out += c; i++;
  }
  return out;
}

const unescapeKt = (s) => s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (m, c) =>
  c[0] === "u" ? String.fromCharCode(parseInt(c.slice(1), 16)) : ({ n: "\n", t: "\t", "\\": "\\", '"': '"', "'": "'", $: "$" }[c] ?? c));

function readSeed(kt) {
  const code = stripCode(kt, "kt");
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
        source_doc: consts[args.match(/sourceDoc\s*=\s*([A-Za-z_]\w*)/)[1]],
      });
      re.lastIndex = end;
    }
  });
  return { rows, seeded: consts.SEEDED };
}

const SEED = readSeed(read(SEED_PATH));
const ROWS = SEED.rows;

// ------------------------------------------------------------- the name grammar --
// THE ONLY PLACE A ROW'S HEIGHT APPEARS IS ITS NAME (block 4 proves there is no height field anywhere). This is
// the narrow grammar the starting list is written in: "6'H", "6 ft high", "6 foot tall". It is a MODEL of a parse,
// kept here to measure what parsing a display name would and would not catch. Nothing in the app does this.
const HEIGHT_RE = /(\d+(?:\.\d+)?) ?(?:'|ft|feet|foot|-foot) ?(?:H|h|high|tall)(?![a-zA-Z])/;
const WIDTH_RE = /[xX] ?(\d+(?:\.\d+)?) ?(?:'|ft|feet|foot|-foot) ?(?:W|w|wide)(?![a-zA-Z])/;
const heightOf = (name) => { const m = HEIGHT_RE.exec(name); return m ? Number(m[1]) : null; };
const widthOf = (name) => { const m = WIDTH_RE.exec(name); return m ? Number(m[1]) : null; };

// ============================================================ the real engine ==
const JOB_SYNC = "a3400000-0000-4000-8000-000000000001";
const RUN_SYNC = "a3400000-0000-4000-8000-000000000002";
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
  panel_height_ft: 6, post_spacing_ft: o.panel_width_ft ?? 6, concrete_bags_per_post: 1, aluminum_style: "RACKABLE",
  wood_style: "PRIVACY", wood_rail_count: 3, picket_width_in: 5.5, picket_gap_in: 0, fabric_height_ft: 4,
  include_top_rail: true, include_tension_wire: false, include_barbed_wire_arms: false,
  include_privacy_slats: false, split_rail_count: 2, suppressed_roles: "", is_teardown: false, sort_order: 0, ...o,
});
/** Catalog rows as price-job reads them. Ids are by position, so a price tie always resolves the same way. */
const dbRows = (rows) => rows.map((r, i) => ({
  sync_id: "a3400000-0000-4000-8000-" + String(100 + i).padStart(12, "0"), name: r.name, category: r.category,
  role: r.role, fence_type: r.fence_type, color_or_finish: r.color_or_finish, unit: r.unit, unit_price: r.unit_price,
  taxable: r.taxable, covers_ft: r.covers_ft, manufacturer_sync_id: null, is_active: true,
}));
const price = (run, rows, job = {}) => priceJob(buildPricingInput({
  job: jobRow(job), runs: [run], catalog: dbRows(rows), manufacturers: [], changeOrders: [], existingItems: [],
  engineVersion: PRICING_ENGINE_VERSION,
}));
const itemOf = (out, role) => out.items.find((i) => i.role === role);
const money = (n) => Math.round(n * 100) / 100;
const GATE_4FT = "500.0:0.0:4.0:LINE:IN";

const IRON_4 = "Ornamental Steel Panel 4'H x 6'W, Black";
const IRON_6 = "Ornamental Steel Panel 6'H x 6'W, Black";
const IRON_4_WIDE = "Ornamental Steel Panel 4'H x 8'W, Black";
const withoutRow = (name) => ROWS.filter((r) => r.name !== name);

// ============================================================== 0. HARNESS ==

test("harness: the reader finds the starting list and the rows this file depends on", () => {
  assert.ok(ROWS.length >= 90, "found only " + ROWS.length + " rows in " + SEED_PATH);
  for (const n of [IRON_4, IRON_6, IRON_4_WIDE]) {
    const r = ROWS.find((x) => x.name === n);
    assert.ok(r, "control: the seed row '" + n + "' is read");
    assert.equal(r.role, "PANEL");
    assert.equal(r.fence_type, "ORNAMENTAL_IRON");
  }
  assert.equal(ROWS.find((r) => r.name === IRON_4).unit_price, 135);
  assert.equal(ROWS.find((r) => r.name === IRON_6).unit_price, 175);
  assert.equal(ROWS.find((r) => r.name === IRON_4).covers_ft, 6);
  assert.equal(ROWS.find((r) => r.name === IRON_6).covers_ft, 6);
});

test("harness: the real engine prices an iron run from the seed and the quote has a panel line", () => {
  const out = price(runRow({ fence_type: "ORNAMENTAL_IRON", color_or_finish: "Black" }), ROWS);
  const p = itemOf(out, "PANEL");
  assert.ok(p, "no PANEL line: the engine harness is dead, fix it before trusting anything below");
  assert.equal(p.quantity, 17, "100 ft at 6 ft a bay is 17 panels");
  assert.ok(out.totals.grand_total > 0);
});

// ============================================================ 1. THE CENSUS ==

const KEYED_ROLES = ["PANEL", "GATE_PANEL", "GATE_FRAME_KIT"]; // chosen by width, so these can collide on width
/** Every (fence type, role, width) group of width-keyed rows, with the heights the names carry. */
function census(rows) {
  const groups = new Map();
  for (const r of rows.filter((x) => KEYED_ROLES.includes(x.role))) {
    const k = [r.fence_type, r.role, r.covers_ft].join("|");
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups].map(([key, g]) => {
    const heights = [...new Set(g.map((r) => heightOf(r.name)).filter((h) => h !== null))].sort((a, b) => a - b);
    return { key, rows: g, heights, unknown: g.filter((r) => heightOf(r.name) === null).length, collision: heights.length >= 2 };
  });
}

// The ledger. A group appearing here means "looked at"; the two lists are the whole answer.
const CLEAN = [
  "ALUMINUM|GATE_PANEL|4", "ALUMINUM|PANEL|6", "ALUMINUM|PANEL|8",
  "CHAIN_LINK|GATE_FRAME_KIT|4", "COMPOSITE|GATE_FRAME_KIT|4",
  "ORNAMENTAL_IRON|GATE_PANEL|4", "ORNAMENTAL_IRON|PANEL|8",
  "SPLIT_RAIL|GATE_FRAME_KIT|10",
  "VINYL|GATE_PANEL|5", "VINYL|PANEL|6", "VINYL|PANEL|8",
  "WOOD|GATE_FRAME_KIT|4",
];
const COLLISIONS = ["ORNAMENTAL_IRON|PANEL|6"];

test("the census: one collision ships (iron 4'H and 6'H, both 6 ft wide), and these twelve groups are clean", () => {
  const c = census(ROWS);
  show("\nCENSUS (" + c.length + " groups of width-keyed rows)");
  for (const g of c) show("  " + g.key.padEnd(34), "rows", g.rows.length, "heights", JSON.stringify(g.heights), g.unknown ? "(" + g.unknown + " with no height in the name)" : "", g.collision ? "<-- COLLISION" : "clean");
  assert.deepEqual(c.filter((g) => g.collision).map((g) => g.key), COLLISIONS,
    "THE COLLISION SET CHANGED. A row now shares a fence type and a width with a row of another height (or the iron pair is gone). " +
    "Today's engine picks the CHEAPER of the two for every run, whatever height the run says -- docs/PANEL_HEIGHT_BLINDNESS.md. " +
    "If a row was ADDED, do not ship it as a PANEL until the selector reads height. If the iron pair was fixed, strike it from COLLISIONS.");
  assert.deepEqual(c.filter((g) => !g.collision).map((g) => g.key).sort(), [...CLEAN].sort(),
    "the set of CLEAN groups changed: a width the starting list stocks was added or removed. Re-run this with A34_TABLE=1, look at it, then update CLEAN.");
  const iron = c.find((g) => g.key === COLLISIONS[0]);
  assert.deepEqual(iron.heights, [4, 6]);
  assert.deepEqual(iron.rows.map((r) => r.unit_price).sort((a, b) => a - b), [135, 175], "the shorter panel is the cheaper one: that is the direction of the error");
});

test("THE SAME LIST SHIPS IN THREE PLACES, and every copy carries the same pair: the phone's seed, the office console's, and the new-company SQL (not applied)", () => {
  const norm = (rows) => [...new Map(rows.map((r) => [r.fence_type + "|" + r.role + "|" + r.name, r])).values()];
  // the office console's copy: JS object literals in website/dashboard.html
  const dash = [...read("website/dashboard.html").matchAll(/role:"(PANEL|GATE_PANEL|GATE_FRAME_KIT)",fence_type:"([A-Z_]+)",name:"((?:[^"\\]|\\.)*)",[^}]*?covers_ft:(\d+(?:\.\d+)?)/g)]
    .map((m) => ({ role: m[1], fence_type: m[2], name: m[3].replace(/\\"/g, '"'), covers_ft: Number(m[4]) }));
  // the new-company seed: SQL tuples, quotes doubled. It holds the list twice (the dry run and the apply block).
  const sqlSrc = read("supabase_r20_seed_new_company_catalog.sql");
  const sql = [...sqlSrc.matchAll(/\('(?:PANEL|GATE)', '(PANEL|GATE_PANEL|GATE_FRAME_KIT)', '([A-Z_]+)', '((?:[^']|'')*)', '[A-Z]+', [\d.]+, (?:true|false), (\d+(?:\.\d+)?|null), '[^']*'\)/g)]
    .map((m) => ({ role: m[1], fence_type: m[2], name: m[3].replace(/''/g, "'"), covers_ft: m[4] === "null" ? null : Number(m[4]) }));
  assert.ok(dash.length >= 15 && sql.length >= 30, "control: the readers found " + dash.length + " console rows and " + sql.length + " SQL rows");
  for (const [label, rows] of [["website/dashboard.html", dash], ["supabase_r20_seed_new_company_catalog.sql", sql]]) {
    assert.deepEqual(census(norm(rows)).filter((g) => g.collision).map((g) => g.key), COLLISIONS, label + ": the collision set is not the phone's");
    assert.ok(rows.some((r) => r.name === IRON_4) && rows.some((r) => r.name === IRON_6), label + " does not carry both iron rows");
  }
  assert.equal(sql.filter((r) => r.name === IRON_4).length, 2, "r20 holds the list twice, so the pair is in it twice");
  assert.match(sqlSrc.slice(0, 400), /STATUS: NOT APPLIED/, "r20 was applied (or its header changed): a new company is now seeded WITH the colliding pair -- read the doc's section on the real data");
  // and all three copies agree with each other on every panel and gate row
  const key = (rows) => norm(rows).map((r) => [r.fence_type, r.role, r.name, r.covers_ft].join("|")).sort();
  const seedRows = ROWS.filter((r) => KEYED_ROLES.includes(r.role));
  assert.deepEqual(key(dash), key(seedRows), "the console's list and the phone's list differ in their panel/gate rows");
  assert.deepEqual(key(sql), key(seedRows), "the new-company SQL list and the phone's list differ in their panel/gate rows");
  // TEETH: a row only one copy holds is a disagreement the comparison reports.
  assert.notDeepEqual(key([...dash, { role: "PANEL", fence_type: "VINYL", name: "x", covers_ft: 6 }]), key(seedRows));
});

test("CONTROL: the detector sees a planted collision, and sees none once the iron 4'H row is gone", () => {
  const planted = { category: "PANEL", role: "PANEL", fence_type: "VINYL", name: "Panel T&G Vinyl Privacy 4'H x 6'W - White",
    unit: "EA", unit_price: 40, taxable: true, covers_ft: 6, color_or_finish: "White", source_doc: SEED.seeded };
  assert.deepEqual(census([...ROWS, planted]).filter((g) => g.collision).map((g) => g.key).sort(), [...COLLISIONS, "VINYL|PANEL|6"].sort());
  assert.equal(census(withoutRow(IRON_4)).filter((g) => g.collision).length, 0);
  // and a row with NO height in its name is not a collision, it is unknown -- counted separately
  const nameless = { ...planted, name: "Custom white panel" };
  const g = census([...ROWS, nameless]).find((x) => x.key === "VINYL|PANEL|6");
  assert.equal(g.collision, false);
  assert.equal(g.unknown, 1);
});

test("chain-link fabric is the one role whose covers_ft IS a height, and no two rows share one", () => {
  const fabric = ROWS.filter((r) => r.role === "CHAIN_FABRIC");
  assert.ok(fabric.length >= 3, "control: the seed has chain-link fabric rows");
  assert.equal(new Set(fabric.map((r) => r.covers_ft)).size, fabric.length, "two fabric rows share a height");
  assert.deepEqual(fabric.map((r) => r.covers_ft).sort((a, b) => a - b), [4, 6, 8]);
  // TEETH: two rows at one height is what the check above would catch.
  assert.notEqual(new Set([...fabric, { ...fabric[0], name: "dup" }].map((r) => r.covers_ft)).size, [...fabric, { ...fabric[0] }].length);
});

test("roles chosen by PRICE ALONE: no (fence type, role, colour) group holds two rows in the starting list", () => {
  const priceOnly = ROWS.filter((r) => !KEYED_ROLES.includes(r.role) && r.role !== "CHAIN_FABRIC" && r.role !== "NONE");
  const groups = new Map();
  for (const r of priceOnly) {
    const k = [r.fence_type, r.role, r.color_or_finish.toLowerCase()].join("|");
    groups.set(k, [...(groups.get(k) || []), r]);
  }
  assert.ok(groups.size >= 40, "control: the scan examined " + groups.size + " groups, expected dozens");
  const multi = [...groups].filter(([, g]) => g.length > 1).map(([k]) => k);
  show("\nPRICE-ONLY GROUPS examined:", groups.size, " with more than one row of one colour:", multi.length);
  assert.deepEqual(multi, [], "a price-only role now has two rows of one colour: the cheaper one will win every quote whatever it is (block 3)");
  // TEETH: a planted second post row IS found by the same grouping.
  const post = priceOnly.find((r) => r.role === "LINE_POST" && r.fence_type === "WOOD");
  const k = ["WOOD", "LINE_POST", post.color_or_finish.toLowerCase()].join("|");
  assert.equal([...priceOnly, { ...post, name: "4x4x6' Post" }].filter((r) => [r.fence_type, r.role, r.color_or_finish.toLowerCase()].join("|") === k).length, 2);
});

test("every PANEL and GATE_PANEL row names its height AND its width, and the name's width equals covers_ft", () => {
  const rows = ROWS.filter((r) => r.role === "PANEL" || r.role === "GATE_PANEL");
  assert.ok(rows.length >= 15, "control: " + rows.length + " panel/gate rows read");
  for (const r of rows) {
    assert.notEqual(heightOf(r.name), null, "no height in the name of: " + r.name);
    assert.equal(widthOf(r.name), r.covers_ft, "the name's width and covers_ft disagree for: " + r.name);
  }
  // so covers_ft is the WIDTH of a panel, which is why a height cannot be put there. Frame kits carry neither.
  for (const r of ROWS.filter((x) => x.role === "GATE_FRAME_KIT")) assert.equal(heightOf(r.name), null, r.name);
});

// ============================================================= 2. THE COST ==

/** An iron run priced from `catalog`. 100 or 200 ft, 6 ft panels, no gates, black. */
const iron = (height, feet, markup = 0, catalog = ROWS, extra = {}) =>
  price(runRow({ fence_type: "ORNAMENTAL_IRON", color_or_finish: "Black", panel_width_ft: 6, panel_height_ft: height, manual_linear_feet: feet, ...extra }),
    catalog, { markup_percent: markup });

test("ENGINE FACT: a 6 ft high iron run is priced with the 4 ft high panel, because both are 6 ft wide and 135 < 175", () => {
  const out = iron(6, 100);
  const p = itemOf(out, "PANEL");
  assert.equal(p.description, IRON_4,
    "FIXED? the 6 ft high iron run no longer takes the 4 ft high panel. Panel choice may now read height: rewrite blocks 2 and 3.");
  assert.equal(p.unit_price, 135);
  assert.equal(p.quantity, 17);
  // CONTROL: the same row is CORRECT for a 4 ft high run, so the defect bites the taller height only.
  assert.equal(itemOf(iron(4, 100), "PANEL").description, IRON_4);
  // CONTROL: remove the wrong row and the engine, with nothing else changed, picks the right one.
  assert.equal(itemOf(iron(6, 100, 0, withoutRow(IRON_4)), "PANEL").description, IRON_6);
  // TRIPWIRE for the height column of the table: the run says 6 and the engine's own input says so.
  assert.equal(runRow({ panel_height_ft: 6 }).panel_height_ft, 6);
});

// The table the doc quotes: what the owner is short on a 6 ft high iron job. CORRECT = the same quote with the
// wrong row removed from the catalog (nothing else changed); that is the quote a height-aware engine would give.
const COST = [
  // feet, markup %, engine grand total today, correct grand total, shortfall
  [100, 0, 4079.02, 4806.62, 727.60],
  [200, 0, 8112.29, 9567.49, 1455.20],
  [100, 15, 4690.87, 5527.61, 836.74],
  [200, 15, 9329.13, 11002.61, 1673.48],
];

test("THE COST: an UNDERCHARGE on every 6 ft high iron job -- $40 a panel before tax, $727.60 on 100 ft, $1,455.20 on 200 ft", () => {
  show("\nCOST OF THE COLLISION (6 ft high ornamental iron, 6 ft panels, black, no gate, 7% tax, labour $8/ft)");
  for (const [feet, markup, today, correct, short] of COST) {
    const a = iron(6, feet, markup), b = iron(6, feet, markup, withoutRow(IRON_4));
    const qty = itemOf(a, "PANEL").quantity;
    show("  " + String(feet).padStart(3) + " ft, markup " + String(markup).padStart(2) + "%: engine " + a.totals.grand_total.toFixed(2) +
      "  correct " + b.totals.grand_total.toFixed(2) + "  short " + money(b.totals.grand_total - a.totals.grand_total).toFixed(2) +
      "  (" + (((b.totals.grand_total - a.totals.grand_total) / b.totals.grand_total) * 100).toFixed(1) + "% of the right price)  panels " + qty);
    assert.equal(a.totals.grand_total, today, feet + " ft / " + markup + "%: the quote today moved");
    assert.equal(b.totals.grand_total, correct, feet + " ft / " + markup + "%: the correct quote moved");
    assert.equal(money(b.totals.grand_total - a.totals.grand_total), short);
    assert.ok(b.totals.grand_total > a.totals.grand_total, "the direction is an UNDERCHARGE: the engine's quote is the lower one");
    // the shortfall is exactly panels x $40 x tax x markup -- the panel row is the only thing that differs
    assert.ok(Math.abs((b.totals.grand_total - a.totals.grand_total) - qty * 40 * 1.07 * (1 + markup / 100)) < 0.011, "the shortfall is not just the panel price difference");
    assert.equal(itemOf(b, "PANEL").quantity, qty, "same number of panels either way");
  }
  // CONTROL: a 4 ft high run has NO shortfall: the quote is identical with or without the 6'H row.
  assert.equal(iron(4, 100).totals.grand_total, iron(4, 100, 0, withoutRow(IRON_6)).totals.grand_total);
});

test("ENGINE FACT: where only ONE width has a row, there is nothing to choose between -- iron 6 ft high at 8 ft wide has no right row at all", () => {
  const out = iron(6, 100, 0, ROWS, { panel_width_ft: 8, post_spacing_ft: 8 });
  assert.equal(itemOf(out, "PANEL").description, IRON_4_WIDE);
  assert.ok(!ROWS.some((r) => r.fence_type === "ORNAMENTAL_IRON" && r.role === "PANEL" && r.covers_ft === 8 && heightOf(r.name) === 6),
    "a 6'H x 8'W iron row now exists: this case is a collision, not a catalog gap");
  // the gates: iron ships ONE gate and it is 4'H; aluminium ships one and it is 6'H. No row to prefer either way.
  for (const [type, gate, h] of [["ORNAMENTAL_IRON", "GATE_PANEL", 4], ["ALUMINUM", "GATE_PANEL", 6], ["VINYL", "GATE_PANEL", 6]]) {
    const g = ROWS.filter((r) => r.fence_type === type && r.role === gate);
    assert.equal(g.length, 1, type + " ships " + g.length + " gate panels");
    assert.equal(heightOf(g[0].name), h);
  }
});

test("ENGINE FACT, same family: a chain-link fabric height between two rows ties on distance and the CHEAPER, shorter row wins", () => {
  const fab = (h) => itemOf(price(runRow({ fence_type: "CHAIN_LINK", fabric_height_ft: h }), ROWS), "CHAIN_FABRIC");
  assert.equal(fab(4).unit_price, 3.1);
  assert.equal(fab(6).unit_price, 4.35);
  assert.equal(fab(8).unit_price, 5.6);
  assert.equal(fab(5).unit_price, 3.1, "a 5 ft fabric run is priced as 4 ft fabric (tie at distance 1, cheaper wins)");
  assert.equal(fab(7).unit_price, 4.35, "a 7 ft fabric run is priced as 6 ft fabric");
  assert.equal(fab(9).unit_price, 5.6, "above the tallest row the tallest is used");
  // 100 LF of 5 ft fabric priced as 4 ft is short by (4.35 - 3.10) x 100 against pricing it as the next size up
  assert.equal(money((4.35 - 3.1) * 100), 125);
  // CONTROL: unlike panels, fabric height DOES change the quote -- covers_ft is its height.
  assert.notEqual(fab(4).description, fab(6).description);
});

// ============================================================= 3. THE SCOPE ==

const FENCE_TYPES = ["VINYL", "ALUMINUM", "ORNAMENTAL_IRON", "WOOD", "COMPOSITE", "SPLIT_RAIL", "CHAIN_LINK"];
const quoteJson = (o) => JSON.stringify({ items: o.items, totals: o.totals, unmatched: o.unmatched_roles });

test("ENGINE FACT: panel_height_ft changes NO quote for ANY fence type, with or without a gate", () => {
  for (const type of FENCE_TYPES) {
    for (const gates of ["", GATE_4FT]) {
      const seen = new Set();
      for (const h of [3, 4, 5, 6, 7, 8]) seen.add(quoteJson(price(runRow({ fence_type: type, panel_height_ft: h, gates_encoded: gates }), ROWS)));
      assert.equal(seen.size, 1,
        "TRIPWIRE: " + type + (gates ? " with a gate" : "") + " now prices differently by panel_height_ft. Height is read somewhere: rewrite blocks 2 and 3.");
    }
  }
  // CONTROLS: the same sweep CAN see a difference when something the engine reads changes.
  const base = (o) => quoteJson(price(runRow({ fence_type: "VINYL", ...o }), ROWS));
  assert.notEqual(base({ panel_width_ft: 6 }), base({ panel_width_ft: 8 }), "width is read");
  assert.notEqual(quoteJson(price(runRow({ fence_type: "CHAIN_LINK", fabric_height_ft: 4 }), ROWS)),
    quoteJson(price(runRow({ fence_type: "CHAIN_LINK", fabric_height_ft: 6 }), ROWS)), "fabric height is read");
  assert.notEqual(quoteJson(price(runRow({ fence_type: "WOOD", wood_rail_count: 2 }), ROWS)),
    quoteJson(price(runRow({ fence_type: "WOOD", wood_rail_count: 3 }), ROWS)), "the rail count is read (the editor sets it from the height, the engine does not)");
});

/** The (role, preferCoversFt) pairs a run asks for -- merged as buildLineItems merges them. */
function entriesOf(out) {
  const merged = new Map();
  for (const e of out.runs[0].entries) {
    if (!(e.quantity > 0)) continue;
    const k = e.role + "|" + e.prefer_covers_ft;
    if (!merged.has(k)) merged.set(k, { role: e.role, prefer_covers_ft: e.prefer_covers_ft });
  }
  return [...merged.values()];
}
const ALL_GATES = ["500.0:0.0:4.0:LINE:IN", "500.0:0.0:5.0:WALL:IN", "500.0:0.0:6.0:LINE_TO_WALL:IN"].join(",");

test("every role the takeoff asks for is chosen by WIDTH or by PRICE; a cheaper decoy that names ANY height wins, in every one", () => {
  const widthKeyed = new Set(), priceOnly = new Set(), proved = [];
  for (const type of FENCE_TYPES) {
    const run = runRow({ fence_type: type, gates_encoded: ALL_GATES, manual_linear_feet: 120 });
    const out = price(run, ROWS);
    for (const e of entriesOf(out)) {
      if (e.prefer_covers_ft !== null) widthKeyed.add(e.role); else priceOnly.add(e.role);
      // Plant a decoy: same fence type and role, 1 cent, a different height in the name, the width the run asks for.
      const have = ROWS.filter((r) => r.fence_type === type && r.role === e.role);
      if (!have.length || e.role === "CHAIN_FABRIC") continue; // CHAIN_FABRIC is keyed by covers_ft = height: handled above
      const decoy = { category: have[0].category, role: e.role, fence_type: type, name: "DECOY 3'H shorter " + e.role, unit: have[0].unit,
        unit_price: 0.01, taxable: true, covers_ft: e.prefer_covers_ft, color_or_finish: "", source_doc: SEED.seeded };
      const lines = price(run, [...ROWS, decoy]).items.filter((i) => i.role === e.role);
      assert.ok(lines.some((i) => i.description === decoy.name),
        "TRIPWIRE: " + type + " " + e.role + " no longer takes a cheaper same-width decoy. Selection has changed: rewrite this block.");
      proved.push(type + "/" + e.role);
    }
  }
  show("\nROLES PROVED CHOSEN BY WIDTH OR PRICE ALONE (decoy won): " + proved.length + " (type, role) pairs");
  show("  width-keyed (preferCoversFt set):", [...widthKeyed].sort().join(", "));
  show("  price-only:", [...priceOnly].sort().join(", "));
  assert.deepEqual([...widthKeyed].sort(), ["CHAIN_FABRIC", "GATE_FRAME_KIT", "GATE_PANEL", "PANEL"]);
  assert.ok(priceOnly.has("LINE_POST") && priceOnly.has("END_POST") && priceOnly.has("POST_CAP") && priceOnly.has("WOOD_RAIL") && priceOnly.has("TOP_RAIL"),
    "control: posts, caps and rails are in the price-only set");
  assert.ok(proved.length >= 40, "control: only " + proved.length + " (type, role) pairs were exercised");
  // the one role family that is height-aware is the one whose covers_ft means height
  assert.ok(!widthKeyed.has("LINE_POST"));
});

test("POSTS: a shorter, cheaper post row wins every quote of its fence type -- latent in the seed (one row per colour), real the day a company adds a second length", () => {
  const post = ROWS.find((r) => r.fence_type === "WOOD" && r.role === "LINE_POST");
  const shorter = { ...post, name: "4x4x6' Pressure-Treated Post (HYPOTHETICAL second length)", unit_price: post.unit_price - 2 };
  for (const h of [4, 6, 8]) {
    const out = price(runRow({ fence_type: "WOOD", panel_height_ft: h }), [...ROWS, shorter]);
    assert.equal(itemOf(out, "LINE_POST").description, shorter.name, "a " + h + " ft fence is given the shorter, cheaper post");
  }
  // and the seed itself ships exactly one row per (type, role, colour): so this cannot happen from the seed alone
  assert.equal(ROWS.filter((r) => r.fence_type === "WOOD" && r.role === "LINE_POST").length, 1);
});

test("GATE_POST is never asked for by the takeoff (gate posts are END_POST), so the seed's GATE_POST rows can never be priced onto a quote", () => {
  const code = stripCode(read(TS_DIR + "takeoff.ts"), "ts");
  assert.ok(/qty\("END_POST"/.test(code) && /qty\("PANEL"/.test(code), "control: the scan sees the roles the takeoff does build");
  assert.ok(!/qty\(\s*"GATE_POST"/.test(code), "the takeoff now builds GATE_POST: posts for gates are chosen by a different row than today");
  for (const type of FENCE_TYPES) {
    const out = price(runRow({ fence_type: type, gates_encoded: ALL_GATES, manual_linear_feet: 120 }), ROWS);
    assert.ok(!out.items.some((i) => i.role === "GATE_POST"), type + " quote carries a GATE_POST line");
  }
  assert.ok(ROWS.filter((r) => r.role === "GATE_POST").length >= 6, "control: the seed does hold GATE_POST rows");
});

// ====================================== 4. WHERE HEIGHT IS, AND WHERE IT IS NOT ==

test("SOURCE: no pricing code on either side reads the run's height (comments stripped; the scan has a control)", () => {
  const ts = (f) => stripCode(read(TS_DIR + f), "ts");
  const kt = (rel) => stripCode(read(rel), "kt");
  const files = [["takeoff.ts", ts("takeoff.ts")], ["line-items.ts", ts("line-items.ts")], ["totals.ts", ts("totals.ts")],
    ["EstimateEngine.kt", kt(KT_ENGINE)], ["JobMoney.kt", kt("app/src/main/java/com/fenceestimator/app/estimate/JobMoney.kt")],
    ["TakeoffRefresher.kt", kt("app/src/main/java/com/fenceestimator/app/estimate/TakeoffRefresher.kt")]];
  for (const [name, code] of files) {
    assert.ok(code.length > 2000, "control: " + name + " was read (" + code.length + " chars of code)");
    assert.ok(!/panelHeightFt|panel_height_ft/.test(code),
      "TRIPWIRE: " + name + " now reads the run's panel height. Panel choice may be height-aware: rewrite blocks 2 to 4 and the doc.");
  }
  // CONTROLS: the same scan finds the width and the fabric height, which the engine DOES read.
  const take = files[0][1], items = files[1][1], eng = files[3][1];
  assert.ok(/run\.panelWidthFt/.test(take), "control: takeoff.ts reads panelWidthFt");
  assert.ok(/run\.fabricHeightFt/.test(take), "control: takeoff.ts reads fabricHeightFt");
  assert.ok(/panelWidthFt/.test(eng) && /fabricHeightFt/.test(eng), "control: EstimateEngine.kt reads the width and the fabric height");
  assert.ok(/preferCoversFt/.test(items) && /preferCoversFt/.test(eng), "control: both selectors read preferCoversFt");
  // the ONE place TS touches it is the input adapter: the row is mapped into the run and nothing reads it back
  const idx = ts("index.ts");
  assert.equal((idx.match(/panelHeightFt/g) || []).length, 1, "index.ts mentions panelHeightFt once: the adapter");
  assert.ok(/panelHeightFt:\s*flt\(row\.panel_height_ft/.test(idx));
});

test("SOURCE: the run, height included, IS in scope where a catalog row is chosen -- on both sides", () => {
  const items = stripCode(read(TS_DIR + "line-items.ts"), "ts");
  assert.ok(/export function buildLineItems\(\s*run: FenceRun,/.test(items), "TS buildLineItems takes the run");
  const types = stripCode(read(TS_DIR + "types.ts"), "ts");
  assert.ok(/export interface FenceRun \{[\s\S]*?panelHeightFt: number;/.test(types), "TS FenceRun carries panelHeightFt");
  const eng = stripCode(read(KT_ENGINE), "kt");
  assert.ok(/fun buildLineItems\(\s*jobId: Long,\s*fenceRunId: Long,\s*run: FenceRun,/.test(eng), "Kotlin buildLineItems takes the run");
  const ent = stripCode(read(KT_ENTITIES), "kt");
  assert.ok(/data class FenceRun\([\s\S]*?val panelHeightFt: Float/.test(ent), "Kotlin FenceRun carries panelHeightFt");
  const job = stripCode(read("supabase/functions/price-job/index.ts"), "ts");
  assert.ok(/RUN_COLUMNS = [^;]*panel_height_ft/.test(job), "price-job selects panel_height_ft for the run, so it reaches the engine");
  // both sides' selectors compare on exactly: distance, price, sync id -- the three terms a height term would sit among
  assert.ok(/compareIeee\(distance\(a\), distance\(b\)\) \|\|\s*compareIeee\(a\.unitPrice, b\.unitPrice\) \|\|\s*compareString\(a\.syncId, b\.syncId\)/.test(items), "TS comparator is distance, price, sync id");
  assert.ok(/compareBy\(\s*\{ kotlin\.math\.abs\(\(it\.coversFt \?: entry\.preferCoversFt\) - entry\.preferCoversFt\) \},\s*\{ it\.unitPrice \},\s*\{ it\.syncId \}/.test(eng), "Kotlin comparator is distance, price, sync id");
  // the two call sites that choose rows on the phone both pass the run
  for (const f of ["app/src/main/java/com/fenceestimator/app/estimate/TakeoffRefresher.kt", "app/src/main/java/com/fenceestimator/app/ui/estimate/EstimateViewModel.kt"])
    assert.ok(/EstimateEngine\.buildLineItems\([\s\S]*?run = run,/.test(stripCode(read(f), "kt")), f + " passes run = run");
});

test("SOURCE: a catalog row has NO height field anywhere -- the only place its height appears is its NAME", () => {
  const tsTypes = stripCode(read(TS_DIR + "types.ts"), "ts");
  const tsItem = tsTypes.match(/export interface MaterialItem \{([\s\S]*?)\n\}/)[1];
  assert.ok(/coversFt: number \| null;/.test(tsItem), "control: the interface body was captured");
  assert.ok(!/height/i.test(tsItem), "TS MaterialItem now has a height-like field: the name need not be parsed");
  const ktItem = stripCode(read(KT_ENTITIES), "kt").match(/data class MaterialItem\(([\s\S]*?)\n\)/)[1];
  assert.ok(/val coversFt: Float\?/.test(ktItem), "control: the Kotlin class body was captured");
  assert.ok(!/height/i.test(ktItem), "Kotlin MaterialItem now has a height-like field");
  // The cloud table and every migration that has ever ALTERed or CREATEd it. Only those statements are read: the
  // body of a function that merely mentions the table is not a column.
  const sqlFiles = readdirSync(ROOT).filter((f) => /^supabase.*\.sql$/.test(f));
  const alters = [], creates = [];
  for (const f of sqlFiles) {
    const sql = readFileSync(join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
    for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?material_items\b[^;]*;/gi)) alters.push([f, m[0]]);
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?material_items\s*\(([\s\S]*?)\n\)\s*;/gi)) creates.push([f, m[1]]);
  }
  // CONTROLS: the scan sees the column additions that DO exist, and the table definition with covers_ft in it.
  assert.ok(sqlFiles.length > 100, "control: only " + sqlFiles.length + " migrations scanned");
  assert.ok(alters.some(([, t]) => /edit_version/.test(t)) && alters.some(([, t]) => /supplier_sku/.test(t)), "control: the ALTERs that added edit_version and supplier_sku were found");
  assert.ok(alters.length >= 5 && creates.length >= 1 && creates.every(([, t]) => /covers_ft/.test(t)), "control: " + alters.length + " ALTERs and " + creates.length + " CREATEs of material_items found");
  for (const [f, t] of [...alters, ...creates]) assert.ok(!/height/i.test(t), f + " adds a height to material_items:\n" + t.trim().slice(0, 300));
  // TEETH: the same scan flags a column that WOULD be a height.
  assert.ok(/height/i.test("alter table public.material_items add column height_ft real;".match(/alter\s+table\s+(?:public\.)?material_items\b[^;]*;/i)[0]));
  // the price-job catalog read, and the editor's single field
  assert.ok(/CATALOG_COLUMNS = [^;]*covers_ft[^;]*;/.test(stripCode(read("supabase/functions/price-job/index.ts"), "ts")), "control: price-job's catalog column list found");
  assert.ok(!/CATALOG_COLUMNS = [^;]*height/.test(read("supabase/functions/price-job/index.ts")));
  assert.match(read("app/src/main/res/values/strings.xml"), /name="cat_covers_ft">Width\/height it covers, ft \(panels &amp; fabric only\)</,
    "the catalog editor has ONE number for 'width/height it covers'; if this label changed, a height field may have been added");
});

test("A parse of the NAME works on every seed row and fails SILENTLY on a rename -- which is the standing rule against comparing display text", () => {
  assert.equal(heightOf("Ornamental Steel Panel 6'H x 6'W, Black"), 6);
  assert.equal(heightOf("Vinyl panel 6 ft high"), 6);
  assert.equal(heightOf("Vinyl panel 4 foot tall"), 4);
  assert.equal(heightOf("Vinyl panel 4.5'H"), 4.5);
  // These are what a person types. Each one returns null: the row becomes an UNKNOWN height and the fix falls back to today.
  const lost = ["Panel 6\u2019H x 6\u2019W", "Panel 72\"H x 6'W", "Panel 6 ft. tall","Panel 6-ft H", "Panel six foot", "Panel 6' x 6' privacy", "Panel 6\u2032H"];
  show("\nNAMES A HEIGHT PARSE LOSES:"); for (const n of lost) show("  " + JSON.stringify(n), "->", heightOf(n));
  for (const n of lost) assert.equal(heightOf(n), null, JSON.stringify(n) + " was parsed: the grammar changed, re-read the doc's list of lost names");
  // and a gate support brace is 8' LONG, not 8' high: the grammar must not read a length as a height
  assert.equal(heightOf("Gate Support Brace, 8'"), null);
  assert.equal(heightOf("5\" Econo Stiffener x 8'(H)"), null);
  assert.equal(heightOf("3\" Aluminum Post, 6', Black"), null, "a post's number is its LENGTH");
  // the seed, by role: every width-keyed panel row parses, every other row does not
  const parsed = ROWS.filter((r) => heightOf(r.name) !== null);
  assert.deepEqual([...new Set(parsed.map((r) => r.role))].sort(), ["GATE_PANEL", "PANEL"]);
});

// ===================================================== 5. THE REFERENCE MODEL ==
// A MODEL of the fix, kept here so it can be measured. It is NOT the engine and the engine does not do this.
//
// THE RULE (a tie-break, nothing more): when two candidates are the same distance from the width asked for, prefer
// the one whose height fits the run, BEFORE price. Fit, for a row whose name carries a height h and a run of height H:
//     unknown height          0        (a wildcard: never dropped, never penalised -- today's behaviour)
//     h >= H                  h - H    (exact is 0; taller is allowed and the closest taller wins: it is cut on site)
//     h <  H                  1000 + H - h   (too short is worse than any taller panel)
// Only PANEL and GATE_PANEL, and only the run's height. It cannot remove a candidate, so a catalog with no height
// that matches can never be left with nothing to price from: the order simply falls through to price, as today.
const heightFit = (name, runHeight) => {
  const h = heightOf(name);
  if (h === null) return 0;
  return h >= runHeight - 0.01 ? Math.max(0, h - runHeight) : 1000 + (runHeight - h);
};
const f32 = Math.fround;
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * buildLineItems' choice for one entry. withHeight: false = today's engine; true = the height TIE-BREAK (the rule
 * above); "narrow" = the ALTERNATIVE kept only to measure it: drop rows that name a different height, if any remain.
 */
function choose(run, entry, catalog, mfr, withHeight) {
  let c = catalog.filter((i) => i.is_active && (i.fence_type === run.fence_type || i.fence_type === "UNIVERSAL") && i.role === entry.role);
  if (!c.length) return null;
  if (run.color_or_finish.trim() !== "") {
    const m = c.filter((i) => i.color_or_finish.toLowerCase() === run.color_or_finish.toLowerCase());
    if (m.length) c = m;
  }
  if (mfr !== null) { const m = c.filter((i) => i.manufacturer_sync_id === mfr); if (m.length) c = m; }
  const panelish = entry.role === "PANEL" || entry.role === "GATE_PANEL";
  if (withHeight === "narrow" && panelish) {
    const keep = c.filter((i) => { const h = heightOf(i.name); return h === null || Math.abs(h - run.panel_height_ft) < 0.01; });
    if (keep.length) c = keep;
  }
  if (entry.prefer_covers_ft !== null) {
    const priced = c.filter((i) => i.unit_price > 0);
    const pool = priced.length ? priced : c;
    const d = (i) => Math.abs(f32((i.covers_ft ?? entry.prefer_covers_ft) - entry.prefer_covers_ft));
    const fit = (i) => (withHeight === true && panelish ? heightFit(i.name, run.panel_height_ft) : 0);
    return [...pool].sort((a, b) => d(a) - d(b) || fit(a) - fit(b) || a.unit_price - b.unit_price || cmpStr(a.sync_id, b.sync_id))[0];
  }
  return [...c].sort((a, b) => (a.unit_price <= 0) - (b.unit_price <= 0) || a.unit_price - b.unit_price || cmpStr(a.sync_id, b.sync_id))[0];
}

/** role -> sorted names the model chooses for the run's entries, as the engine's own output reports them. */
function modelPicks(run, out, catalog, mfr, withHeight) {
  const picks = {};
  for (const e of entriesOf(out)) {
    const r = choose(run, e, catalog, mfr, withHeight);
    if (r) (picks[e.role] ||= []).push(r.name);
  }
  return Object.fromEntries(Object.entries(picks).map(([k, v]) => [k, v.sort()]).sort());
}
function enginePicks(out) {
  const picks = {};
  for (const i of out.items) (picks[i.role] ||= []).push(i.description);
  return Object.fromEntries(Object.entries(picks).map(([k, v]) => [k, v.sort()]).sort());
}
/** What the model and the engine each pick for one run over `rows`. */
function both(run, rows) {
  const out = price(run, rows);
  const cat = dbRows(rows);
  return { engine: enginePicks(out), off: modelPicks(run, out, cat, null, false), on: modelPicks(run, out, cat, null, true),
    narrow: modelPicks(run, out, cat, null, "narrow"), out };
}

const SWEEP_TYPES = ["VINYL", "ALUMINUM", "ORNAMENTAL_IRON"];
function* sweep() {
  for (const type of SWEEP_TYPES)
    for (const colour of ["", "Black", "White", "Tan"])
      for (const width of [5, 6, 7, 8])
        for (const height of [3, 4, 5, 6, 7, 8])
          for (const gates of ["", GATE_4FT, "500.0:0.0:5.0:LINE:IN,800.0:0.0:6.0:WALL:IN"])
            yield runRow({ fence_type: type, color_or_finish: colour, panel_width_ft: width, panel_height_ft: height, gates_encoded: gates });
}

test("MODEL IS FAITHFUL: with the height tie-break OFF it reproduces the real engine's choice of every row, across the whole sweep", () => {
  let n = 0, rowsChecked = 0;
  for (const run of sweep()) {
    const { engine, off } = both(run, ROWS);
    assert.deepEqual(off, engine, `the model disagrees with the engine: ${run.fence_type} colour "${run.color_or_finish}" width ${run.panel_width_ft} height ${run.panel_height_ft} gates "${run.gates_encoded}"`);
    n++; rowsChecked += Object.values(engine).reduce((s, v) => s + v.length, 0);
  }
  assert.ok(n >= 800, "control: only " + n + " runs in the sweep");
  assert.ok(rowsChecked >= 6000, "control: only " + rowsChecked + " chosen rows compared");
  // CONTROL: the model is not just an echo -- switched ON it does differ from the engine, on exactly the collision.
  const iron6 = runRow({ fence_type: "ORNAMENTAL_IRON", color_or_finish: "Black", panel_height_ft: 6 });
  const r = both(iron6, ROWS);
  assert.deepEqual(r.engine.PANEL, [IRON_4]);
  assert.deepEqual(r.on.PANEL, [IRON_6]);
});

test("WHAT THE FIX WOULD DO to the starting list: iron 6 ft -> the 6'H panel; 4 ft -> the 4'H; 5 ft and 8 ft -> the taller 6'H; nothing else moves", () => {
  const moved = [], unmoved = [];
  for (const run of sweep()) {
    const { engine, on } = both(run, ROWS);
    (JSON.stringify(engine) === JSON.stringify(on) ? unmoved : moved).push({ run, engine, on });
  }
  show("\nREFERENCE FIX over the sweep: " + moved.length + " of " + (moved.length + unmoved.length) + " runs choose a different row; every one is iron");
  assert.ok(moved.length > 0, "control: the model moves something");
  assert.ok(moved.every((m) => m.run.fence_type === "ORNAMENTAL_IRON"), "a non-iron quote moved: the starting list has no other collision");
  assert.ok(moved.every((m) => m.on.PANEL?.[0] === IRON_6 && m.engine.PANEL?.[0] === IRON_4), "the only role that moves is the iron PANEL, 4'H -> 6'H");
  assert.ok(moved.every((m) => m.run.panel_width_ft === 6 || m.run.panel_width_ft === 7 || m.run.panel_width_ft === 5), "only widths whose nearest rows are the 6 ft pair");
  const heightsMoved = [...new Set(moved.map((m) => m.run.panel_height_ft))].sort((a, b) => a - b);
  show("  run heights that move:", heightsMoved.join(", "));
  assert.deepEqual(heightsMoved, [5, 6, 7, 8], "6 ft, and the heights ABOVE 4 ft, move to the 6'H panel; 3 and 4 ft stay on the 4'H");
  // an 8-wide iron run keeps the only 8-wide row (4'H x 8'W): a height fit cannot invent a 6'H x 8'W panel
  const wide = both(runRow({ fence_type: "ORNAMENTAL_IRON", color_or_finish: "Black", panel_width_ft: 8, panel_height_ft: 6 }), ROWS);
  assert.deepEqual(wide.on.PANEL, [IRON_4_WIDE]);
  assert.deepEqual(wide.on.PANEL, wide.engine.PANEL, "no change: that is a catalog GAP, not a collision");
});

test("WHY A TIE-BREAK AND NOT 'DROP THE WRONG-HEIGHT ROWS FIRST': narrowing fixes less and lets height override width", () => {
  let runs = 0, tie = 0, narrow = 0, widthJumps = 0;
  const unfixedHeights = new Set();
  for (const run of sweep()) {
    const { engine, on, narrow: nar } = both(run, ROWS);
    runs++;
    if (JSON.stringify(on) !== JSON.stringify(engine)) tie++;
    if (JSON.stringify(nar) !== JSON.stringify(engine)) narrow++;
    // a width jump: the narrowed choice has a different width than today's, i.e. height beat width
    const w = (name) => widthOf(name);
    if (nar.PANEL && engine.PANEL && w(nar.PANEL[0]) !== w(engine.PANEL[0])) widthJumps++;
    // an in-between or taller height that the tie-break moves to the 6'H panel and narrowing leaves on the 4'H
    if (run.fence_type === "ORNAMENTAL_IRON" && run.panel_width_ft === 6 && run.color_or_finish === "" && run.gates_encoded === ""
      && JSON.stringify(on.PANEL) !== JSON.stringify(engine.PANEL) && JSON.stringify(nar.PANEL) === JSON.stringify(engine.PANEL)) unfixedHeights.add(run.panel_height_ft);
  }
  show("\nTIE-BREAK vs NARROWING over " + runs + " runs: tie-break changes " + tie + ", narrowing changes " + narrow + " (" + widthJumps + " of them jump to another WIDTH); heights narrowing leaves on the 4'H panel: " + [...unfixedHeights].sort().join(", "));
  assert.equal(runs, 864);
  assert.equal(tie, 144);
  assert.equal(narrow, 48);
  assert.equal(widthJumps, 12, "narrowing sends an 8 ft-panel 6 ft-high iron run to the 6 ft panel");
  assert.deepEqual([...unfixedHeights].sort((a, b) => a - b), [5, 7, 8], "5, 7 and 8 ft iron match no row exactly, so narrowing falls back and leaves them undercharged");
  // CONTROL: the tie-break has no width jumps (it cannot, width comes first).
  for (const run of sweep()) {
    const { engine, on } = both(run, ROWS);
    if (on.PANEL && engine.PANEL) assert.equal(widthOf(on.PANEL[0]), widthOf(engine.PANEL[0]), "the tie-break changed a panel's width");
  }
});

test("THE FALLBACK: a catalog that holds one height, or names no height at all, prices EXACTLY as today -- nothing is dropped, nothing goes to zero", () => {
  const oneHeight = ROWS.filter((r) => !(r.fence_type === "ORNAMENTAL_IRON" && r.role === "PANEL" && heightOf(r.name) === 4)); // iron: 6'H only (width 8 gone too)
  const noHeights = ROWS.map((r) => ({ ...r, name: r.name.replace(/\d+'H /g, "").replace(/\d+'H/g, "") }));
  assert.ok(noHeights.every((r) => heightOf(r.name) === null), "control: no row names a height any more");
  assert.ok(noHeights.some((r, i) => r.name !== ROWS[i].name), "control: the rename changed names");
  let runs = 0, panelsChecked = 0;
  for (const run of sweep()) {
    for (const [label, rows] of [["a catalog with ONE height per fence type", oneHeight], ["a catalog whose names carry no height", noHeights]]) {
      const { engine, on, out } = both(run, rows);
      assert.deepEqual(on, engine, label + ": the fix moved a quote -- " + run.fence_type + " w" + run.panel_width_ft + " h" + run.panel_height_ft);
      const p = out.items.find((i) => i.role === "PANEL");
      if (p) { assert.ok(p.unit_price > 0, label + ": a panel priced at zero"); panelsChecked++; }
    }
    runs++;
  }
  assert.ok(runs >= 800 && panelsChecked >= 1000, "control: " + runs + " runs, " + panelsChecked + " panel lines");
  // a company holding ONLY 6'H panels and quoting a 4 ft fence: today it is priced with the 6'H panel, and so it is after.
  const sixOnly = ROWS.filter((r) => r.fence_type === "VINYL");
  const four = both(runRow({ fence_type: "VINYL", panel_height_ft: 4 }), sixOnly);
  assert.equal(four.on.PANEL[0], "Panel T&G Vinyl Privacy 6'H x 6'W - White");
  assert.deepEqual(four.on, four.engine);
  // a row with NO height in its name is a wildcard: it is neither dropped nor preferred over an exact match by being unknown
  const wild = { category: "PANEL", role: "PANEL", fence_type: "ORNAMENTAL_IRON", name: "House special black panel", unit: "EA", unit_price: 120, taxable: true, covers_ft: 6, color_or_finish: "Black", source_doc: SEED.seeded };
  const w = both(runRow({ fence_type: "ORNAMENTAL_IRON", color_or_finish: "Black", panel_height_ft: 6 }), [...ROWS, wild]);
  assert.deepEqual(w.on.PANEL, [wild.name], "the unknown-height row is still the cheapest candidate and still wins, as today");
  assert.deepEqual(w.on.PANEL, w.engine.PANEL);
  // TEETH: the same comparison on the real collision DOES report a move.
  const iron6 = both(runRow({ fence_type: "ORNAMENTAL_IRON", color_or_finish: "Black", panel_height_ft: 6 }), ROWS);
  assert.notDeepEqual(iron6.on, iron6.engine);
});

test("THE OWNER'S 4 FT REQUEST, once the selector reads height: a cheap 4'H vinyl panel stops taking over 6 ft quotes", () => {
  const four = { category: "PANEL", role: "PANEL", fence_type: "VINYL", name: "Panel T&G Vinyl Privacy 4'H x 6'W - White",
    unit: "EA", unit_price: 40, taxable: true, covers_ft: 6, color_or_finish: "White", source_doc: SEED.seeded };
  const rows = [...ROWS, four];
  const six = both(runRow({ fence_type: "VINYL", color_or_finish: "White", panel_height_ft: 6 }), rows);
  assert.deepEqual(six.engine.PANEL, [four.name], "TODAY the 4'H panel takes every 6 ft white vinyl quote (this is why it was never added)");
  assert.deepEqual(six.on.PANEL, ["Panel T&G Vinyl Privacy 6'H x 6'W - White"], "with the fix, the 6 ft run keeps the 6'H panel");
  assert.deepEqual(both(runRow({ fence_type: "VINYL", color_or_finish: "White", panel_height_ft: 4 }), rows).on.PANEL, [four.name], "and the 4 ft run gets the 4'H");
  // the step-down needs no product: a 6 ft run whose last bay is cut to 4 ft is just a 6 ft run
  assert.deepEqual(both(runRow({ fence_type: "VINYL", color_or_finish: "White", panel_height_ft: 6, manual_linear_feet: 106 }), rows).on.PANEL, six.on.PANEL);
});

test("BLAST RADIUS on the parity fixtures: the fix would change the chosen rows in exactly TWO of the 85 (both ornamental iron, height 6)", () => {
  const dir = join(ROOT, "fixtures", "pricing");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "manifest.json");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(files.length, 85);
  assert.equal(manifest.case_count, files.length, "control: the manifest counts the fixtures it ships");
  const changed = [], subsetBad = [];
  let runsChecked = 0, withHeightRows = 0;
  for (const f of files) {
    const fx = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const input = { ...fx.input, engine_version: PRICING_ENGINE_VERSION }; // the fixture's own version stamp is not what is being tested
    const out = priceJob(input);
    const ids = new Set((input.manufacturers || []).map((m) => m.sync_id));
    const pref = input.job.preferred_manufacturer_sync_id;
    const mfr = pref && ids.has(pref) ? pref : null;
    const catalog = input.catalog.map((c) => ({ ...c, manufacturer_sync_id: c.manufacturer_sync_id && ids.has(c.manufacturer_sync_id) ? c.manufacturer_sync_id : null }));
    if (catalog.some((c) => (c.role === "PANEL" || c.role === "GATE_PANEL") && heightOf(c.name) !== null)) withHeightRows++;
    for (const run of input.runs) {
      const ro = out.runs.find((r) => r.run_sync_id === run.sync_id);
      if (!ro || run.is_teardown) continue;
      const merged = new Map();
      for (const e of ro.entries) if (e.quantity > 0) merged.set(e.role + "|" + e.prefer_covers_ft, { role: e.role, prefer_covers_ft: e.prefer_covers_ft });
      const eng = {}, off = {}, on = {};
      for (const i of out.items.filter((x) => x.fence_run_sync_id === run.sync_id && x.auto_generated)) (eng[i.role] ||= []).push(i.description);
      for (const e of merged.values()) {
        const a = choose(run, e, catalog, mfr, false), b = choose(run, e, catalog, mfr, true);
        if (a) (off[e.role] ||= []).push(a.name);
        if (b) (on[e.role] ||= []).push(b.name);
      }
      // the engine may OMIT a built line an edited line stands in for; it may never choose something the model did not
      for (const [role, names] of Object.entries(eng)) {
        const pool = [...(off[role] || [])];
        for (const n of names) { const k = pool.indexOf(n); if (k < 0) subsetBad.push(f + " " + role + " " + n); else pool.splice(k, 1); }
      }
      runsChecked++;
      const norm = (o) => JSON.stringify(Object.entries(o).map(([k, v]) => [k, [...v].sort()]).sort());
      if (norm(off) !== norm(on)) changed.push({ f, input, height: run.panel_height_ft, from: off.PANEL, to: on.PANEL });
    }
  }
  show("\nFIXTURES THE FIX WOULD CHANGE:", changed.map((c) => c.f + " (height " + c.height + ": " + JSON.stringify(c.from) + " -> " + JSON.stringify(c.to) + ")").join("\n  "));
  assert.deepEqual(subsetBad, [], "the model chose differently from the engine on a fixture, so the blast-radius count below is not trustworthy");
  assert.ok(runsChecked >= 85 && withHeightRows >= 55, "control: " + runsChecked + " runs checked, " + withHeightRows + " fixtures with a height in a panel name");
  assert.deepEqual(changed.map((c) => c.f).sort(), ["ornamental-iron-drawn-open-wall-gate.json", "template-08-ornamental-iron-6ft.json"]);
  for (const c of changed) { assert.equal(c.height, 6); assert.deepEqual(c.from, [IRON_4]); assert.deepEqual(c.to, [IRON_6]); }
  // In DOLLARS, from the real engine alone: the same fixture priced with the wrong-height row taken out of its catalog.
  // (Both are the current engine's totals; the fixtures' own expected totals still carry the older round-up-to-ten.)
  const DOLLARS = { "ornamental-iron-drawn-open-wall-gate.json": [5147.36, 6003.36], "template-08-ornamental-iron-6ft.json": [4690.87, 5527.61] };
  for (const c of changed) {
    const today = priceJob(c.input).totals.grand_total;
    const right = priceJob({ ...c.input, catalog: c.input.catalog.filter((r) => r.name !== IRON_4) }).totals.grand_total;
    show("  " + c.f + ": grand total today " + today + ", with the 6'H panel " + right + ", short " + money(right - today));
    assert.deepEqual([today, right], DOLLARS[c.f], c.f + ": the dollars moved");
    assert.ok(right > today, "UNDERCHARGE: the fixture's own quote is the lower one");
  }
});

test("A FORMULA CHANGE needs the version bumped on BOTH engines: both constants exist, and the fixtures carry a version of their own", () => {
  const ts = stripCode(read(TS_DIR + "index.ts"), "ts").match(/export const PRICING_ENGINE_VERSION = "([^"]+)"/);
  const kt = stripCode(read(KT_ENGINE), "kt").match(/const val PRICING_ENGINE_VERSION = "([^"]+)"/);
  assert.ok(ts && kt, "both engines declare PRICING_ENGINE_VERSION");
  assert.match(ts[1], /^\d{4}\.\d{2}\.\d+$/);
  assert.match(kt[1], /^\d{4}\.\d{2}\.\d+$/);
  assert.equal(PRICING_ENGINE_VERSION, ts[1], "control: the imported constant is the one in the file");
  const manifest = JSON.parse(readFileSync(join(ROOT, "fixtures", "pricing", "manifest.json"), "utf8"));
  assert.match(manifest.version, /^\d{4}\.\d{2}\.\d+$/);
  show("\nVERSIONS: ts", ts[1], " kotlin", kt[1], " fixture manifest", manifest.version);
});

// ================================================================== 6. LIVE ==
// READ-ONLY. One SELECT. A synthetic CANARY company (ordinal -1, built from VALUES inside the statement) carries a
// known collision, a known mispriced line (17 panels x ($175 - $135) = $680) and a known two-row post group; the
// probe is INVALID unless it reports all of them. Real companies come back as arbitrary ordinals: no names, no
// contact data, no catalog names or prices, no customer data.
const LIVE_SQL = String.raw`
with
k as (
  select
    '([0-9]+(?:\.[0-9]+)?) ?(?:''|ft|feet|foot|-foot) ?(?:H|h|high|tall)(?![a-zA-Z])'::text as hre,
    '[xX] ?([0-9]+(?:\.[0-9]+)?) ?(?:''|ft|feet|foot|-foot) ?(?:W|w|wide)(?![a-zA-Z])'::text as wre
),
co as (
  select id, row_number() over (order by id)::int as ord, (name ilike 'ZZ TEST%') as is_fixture
  from public.companies
  union all
  select '00000000-0000-0000-0000-00000000ca7a'::uuid, -1, false
),
cat as (
  select m.company_id, co.ord, co.is_fixture, m.sync_id::text as sid, m.name, m.role, m.fence_type,
         lower(m.color_or_finish) as colour, m.unit_price::numeric as unit_price, m.covers_ft::numeric as covers_ft,
         nullif(substring(m.name from k.hre), '')::numeric as h,
         nullif(substring(m.name from k.wre), '')::numeric as w
  from public.material_items m
  join co on co.id = m.company_id
  cross join k
  where m.deleted_at is null and m.is_active
  union all
  select c.company_id, -1, false, c.sid, c.name, c.role, c.fence_type, ''::text, c.unit_price, c.covers_ft,
         nullif(substring(c.name from k.hre), '')::numeric, nullif(substring(c.name from k.wre), '')::numeric
  from (values
    ('00000000-0000-0000-0000-00000000ca7a'::uuid, 'c1', 'Canary Panel 4''H x 6''W', 'PANEL', 'ORNAMENTAL_IRON', 135.0::numeric, 6.0::numeric),
    ('00000000-0000-0000-0000-00000000ca7a'::uuid, 'c2', 'Canary Panel 6''H x 6''W', 'PANEL', 'ORNAMENTAL_IRON', 175.0::numeric, 6.0::numeric),
    ('00000000-0000-0000-0000-00000000ca7a'::uuid, 'c3', 'Canary Panel 4''H x 8''W', 'PANEL', 'ORNAMENTAL_IRON', 165.0::numeric, 8.0::numeric),
    ('00000000-0000-0000-0000-00000000ca7a'::uuid, 'c4', 'Canary Line Post 6''', 'LINE_POST', 'WOOD', 7.5::numeric, null::numeric),
    ('00000000-0000-0000-0000-00000000ca7a'::uuid, 'c5', 'Canary Line Post 8''', 'LINE_POST', 'WOOD', 9.5::numeric, null::numeric)
  ) as c(company_id, sid, name, role, fence_type, unit_price, covers_ft)
  cross join k
),
runs as (
  select r.company_id, r.sync_id::text as sid, r.fence_type, r.panel_height_ft::numeric as run_h,
         r.panel_width_ft::numeric as run_w, r.job_sync_id::text as job_sid
  from public.fence_runs r
  where r.deleted_at is null
  union all
  select '00000000-0000-0000-0000-00000000ca7a'::uuid, 'r1', 'ORNAMENTAL_IRON', 6.0::numeric, 6.0::numeric, 'j1'
),
jobs_ as (
  select j.company_id, j.sync_id::text as sid, (to_jsonb(j) ->> 'status') as status,
         coalesce((to_jsonb(j) ->> 'is_test_fixture')::boolean, false) as is_test
  from public.jobs j
  where j.deleted_at is null
  union all
  select '00000000-0000-0000-0000-00000000ca7a'::uuid, 'j1', 'CANARY', false
),
lines as (
  select l.company_id, l.sync_id::text as sid, l.job_sync_id::text as job_sid, l.fence_run_sync_id::text as run_sid,
         l.role, l.description, l.quantity::numeric as qty, l.unit_price::numeric as price, l.auto_generated
  from public.estimate_line_items l
  where l.deleted_at is null and l.role in ('PANEL', 'GATE_PANEL')
  union all
  select '00000000-0000-0000-0000-00000000ca7a'::uuid, 'l1', 'j1', 'r1', 'PANEL', 'Canary Panel 4''H x 6''W',
         17::numeric, 135.0::numeric, true
),
cls as (
  select ln.company_id, co.ord, co.is_fixture, j.status, coalesce(j.is_test, false) as job_test, ln.job_sid,
         ln.role, ln.qty, ln.price, ln.auto_generated, r.run_h, r.fence_type as run_type,
         nullif(substring(ln.description from k.hre), '')::numeric as line_h,
         ch.covers_ft as chosen_cov
  from lines ln
  join co on co.id = ln.company_id
  cross join k
  left join runs r on r.company_id = ln.company_id and r.sid = ln.run_sid
  left join jobs_ j on j.company_id = ln.company_id and j.sid = ln.job_sid
  left join lateral (
    select c.covers_ft from cat c
    where c.company_id = ln.company_id and c.name = ln.description and c.role = ln.role
    limit 1
  ) ch on true
),
fin as (
  select cls.*,
    (select min(c.unit_price) from cat c
      where c.company_id = cls.company_id and c.role = cls.role and c.fence_type = cls.run_type
        and c.covers_ft = cls.chosen_cov and c.h is not null and abs(c.h - cls.run_h) < 0.01) as right_price
  from cls
)
select 'A_groups'::text as probe,
       jsonb_build_object(
         'company', ord, 'fixture', is_fixture, 'fence_type', fence_type, 'role', role, 'covers_ft', covers_ft,
         'rows', count(*), 'distinct_heights', count(distinct h),
         'heights', to_jsonb(array_agg(distinct h order by h) filter (where h is not null)),
         'unknown_height_rows', count(*) filter (where h is null),
         'cheapest_row_height', (array_agg(h order by unit_price, sid))[1],
         'collision', (count(distinct h) >= 2)
       ) as payload
from cat
where role in ('PANEL', 'GATE_PANEL', 'GATE_FRAME_KIT')
group by ord, is_fixture, fence_type, role, covers_ft
union all
select 'B_name_parse',
       jsonb_build_object(
         'company', ord, 'fixture', is_fixture, 'rows', count(*),
         'height_in_name', count(*) filter (where h is not null),
         'width_in_name', count(*) filter (where w is not null),
         'width_in_name_equals_covers_ft', count(*) filter (where w is not null and w = covers_ft),
         'width_in_name_differs_from_covers_ft', count(*) filter (where w is not null and w <> covers_ft)
       )
from cat
where role in ('PANEL', 'GATE_PANEL', 'GATE_FRAME_KIT')
group by ord, is_fixture
union all
select 'D_price_only_groups',
       jsonb_build_object(
         'company', ord, 'fixture', is_fixture, 'fence_type', fence_type, 'role', role,
         'rows_same_colour_max', max(n), 'rows', sum(n)
       )
from (
  select ord, is_fixture, fence_type, role, colour, count(*) as n
  from cat
  where role not in ('PANEL', 'GATE_PANEL', 'GATE_FRAME_KIT', 'CHAIN_FABRIC', 'NONE')
  group by ord, is_fixture, fence_type, role, colour
) g
group by ord, is_fixture, fence_type, role
having max(n) > 1
union all
select 'C_lines',
       jsonb_build_object(
         'company', ord, 'fixture_company', is_fixture, 'job_is_test_fixture', job_test, 'job_status', status,
         'lines', count(*), 'auto_generated', count(*) filter (where auto_generated),
         'run_found', count(*) filter (where run_h is not null),
         'height_in_description', count(*) filter (where line_h is not null),
         'height_matches_run', count(*) filter (where line_h is not null and run_h is not null and abs(line_h - run_h) < 0.01),
         'height_differs_from_run', count(*) filter (where line_h is not null and run_h is not null and abs(line_h - run_h) >= 0.01),
         'differs_and_a_right_height_row_existed',
            count(*) filter (where right_price is not null and abs(line_h - run_h) >= 0.01),
         'of_which_undercharged', count(*) filter (where right_price is not null and abs(line_h - run_h) >= 0.01 and right_price > price),
         'of_which_overcharged', count(*) filter (where right_price is not null and abs(line_h - run_h) >= 0.01 and right_price < price),
         'jobs_affected', count(distinct job_sid) filter (where right_price is not null and abs(line_h - run_h) >= 0.01),
         'materials_shortfall_dollars_pre_markup_pre_tax',
            round(coalesce(sum((right_price - price) * qty) filter (where right_price is not null and abs(line_h - run_h) >= 0.01), 0), 2)
       )
from fin
group by ord, is_fixture, job_test, status
union all
select 'F_run_heights',
       jsonb_build_object('fence_type', r.fence_type, 'panel_height_ft', r.run_h, 'runs', count(*))
from runs r
join co on co.id = r.company_id
left join jobs_ j on j.company_id = r.company_id and j.sid = r.job_sid
where co.ord <> -1 and not co.is_fixture and not coalesce(j.is_test, false)
group by r.fence_type, r.run_h
order by 1;
`;

/** SQL with comments removed and string literals emptied: what Postgres would execute, not the words in a label. */
const executable = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");

test("the live probe is a single read-only SELECT (and the guard that says so can see a write)", () => {
  const code = executable(LIVE_SQL);
  assert.ok(/\bselect\b/i.test(code) && /\bwith\b/i.test(code), "control: the guard sees the statement");
  assert.ok(!/\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|commit|begin|set|call|do|execute|copy)\b/i.test(code), "the probe contains a write or a state change:\n" + code.slice(0, 300));
  assert.ok(!/@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(LIVE_SQL), "an e-mail address in the probe");
  // TEETH: the same guard fires on a write hidden after the select.
  assert.ok(/\b(insert|update|delete)\b/i.test(executable(LIVE_SQL + "\nupdate public.companies set name = 'x';")));
  assert.ok(!/\bupdate\b/i.test(executable("select 'update me' as a -- delete everything")), "words in a string or a comment are not statements");
});

/** One CLI call. A failed call is a FAILED CALL, never an empty result: the CLI fails about one call in four. */
function runLive(sql) {
  const dir = mkdtempSync(join(tmpdir(), "a34-live-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  let last = "";
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query", "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
      { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32", timeout: 280_000 });
    const out = r.stdout || "";
    const err = (r.stderr || "").replace(/Initialising login role\.\.\./g, "");
    last = "attempt " + attempt + ": status " + r.status + " " + (err + out).slice(0, 200).replace(/\s+/g, " ");
    // The raw output is checked for the word ERROR before anything is parsed.
    if (r.status !== 0 || /\bERROR\b|failed|denied|\bFATAL\b/i.test(err) || /\bERROR\b/.test(out) || !/"rows"\s*:/.test(out)) continue;
    const parsed = JSON.parse(out.slice(out.indexOf("{")));
    return parsed.rows;
  }
  throw new Error("every attempt failed (this is NOT an empty result): " + last);
}

test("LIVE (A34_LIVE=1): the canary is found, and no real job is priced off a wrong-height row", { timeout: 1_500_000, skip: process.env.A34_LIVE !== "1" && "set A34_LIVE=1 to run the read-only live probe" }, () => {
  const rows = runLive(LIVE_SQL);
  const by = (p) => rows.filter((r) => r.probe === p).map((r) => r.payload);
  assert.ok(rows.length >= 10, "control: only " + rows.length + " rows came back");
  // ---- the canary must be found, with the exact numbers it was built to produce, or the whole result is INVALID
  const canA = by("A_groups").filter((p) => p.company === -1);
  assert.deepEqual(canA.filter((p) => p.collision).map((p) => p.fence_type + "|" + p.role + "|" + p.covers_ft), ["ORNAMENTAL_IRON|PANEL|6"], "INVALID: the canary collision was not found");
  assert.deepEqual(canA.find((p) => p.collision).heights, [4, 6]);
  const canC = by("C_lines").filter((p) => p.company === -1);
  assert.equal(canC.length, 1, "INVALID: the canary line is missing");
  assert.equal(canC[0].differs_and_a_right_height_row_existed, 1, "INVALID: the canary mispriced line was not flagged");
  assert.equal(canC[0].of_which_undercharged, 1);
  assert.equal(Number(canC[0].materials_shortfall_dollars_pre_markup_pre_tax), 680, "INVALID: the canary shortfall is not 17 x (175 - 135)");
  const canD = by("D_price_only_groups").filter((p) => p.company === -1);
  assert.deepEqual(canD.map((p) => p.fence_type + "|" + p.role), ["WOOD|LINE_POST"], "INVALID: the canary two-row post group was not found");
  assert.equal(by("B_name_parse").find((p) => p.company === -1).height_in_name, 3, "INVALID: the canary names were not parsed");
  // ---- the real data
  const real = (p) => p.company !== -1 && !p.fixture && !p.fixture_company;
  const realA = by("A_groups").filter(real), realC = by("C_lines").filter(real), realB = by("B_name_parse").filter(real);
  const companiesWithCatalog = new Set(realA.map((p) => p.company));
  const colliding = new Set(realA.filter((p) => p.collision).map((p) => p.company));
  const lines = realC.filter((p) => !p.job_is_test_fixture);
  const sum = (k, ps) => ps.reduce((s, p) => s + Number(p[k] || 0), 0);
  console.log("LIVE (read-only; ordinals are arbitrary, no company is named):");
  console.log("  non-fixture companies holding an active catalog:", companiesWithCatalog.size, " of which hold a colliding pair:", colliding.size);
  console.log("  collisions found:", JSON.stringify(realA.filter((p) => p.collision).map((p) => ({ company: p.company, fence_type: p.fence_type, role: p.role, covers_ft: p.covers_ft, heights: p.heights, cheapest_row_height: p.cheapest_row_height }))));
  console.log("  name parse (width-keyed rows):", JSON.stringify(realB.map((p) => ({ company: p.company, rows: p.rows, height_in_name: p.height_in_name, width_in_name_differs_from_covers_ft: p.width_in_name_differs_from_covers_ft }))));
  console.log("  panel/gate lines on non-test jobs:", sum("lines", lines), " height matches run:", sum("height_matches_run", lines), " differs:", sum("height_differs_from_run", lines),
    " differs where a right row existed:", sum("differs_and_a_right_height_row_existed", lines), " shortfall $:", sum("materials_shortfall_dollars_pre_markup_pre_tax", lines));
  console.log("  by job status:", JSON.stringify(lines.map((p) => ({ status: p.job_status, lines: p.lines, differs: p.height_differs_from_run }))));
  console.log("  real run heights:", JSON.stringify(by("F_run_heights")));
  console.log("  price-only groups with two rows of one colour (real):", by("D_price_only_groups").filter(real).length);
  // ---- the alarm: a real job priced off a wrong-height row where a right one existed
  assert.equal(sum("differs_and_a_right_height_row_existed", lines), 0,
    "A REAL JOB IS NOW PRICED OFF A WRONG-HEIGHT ROW where a right-height row existed. See docs/PANEL_HEIGHT_BLINDNESS.md: the latent defect is realised.");
  assert.equal(sum("width_in_name_differs_from_covers_ft", realB), 0, "a real catalog row names one width and carries another in covers_ft");
});
