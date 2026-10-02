// a60-gate-hardware-by-fence-type -- which gate parts a fence type actually uses.
//
//   node --test tests/a60-gate-hardware-by-fence-type.test.mjs      (no network, no writes)
//
// WHY. All three starting catalogs (SeedData.kt, supabase_r20_seed_new_company_catalog.sql and
// dashboard.html's CATALOG_SEED) seeded HANDLE, BRACE and STIFFENER for VINYL only, and the
// takeoff asked every gate of every fence type for all three. On a fresh catalog a WOOD,
// CHAIN_LINK, ALUMINUM, ORNAMENTAL_IRON, SPLIT_RAIL or COMPOSITE gate therefore dropped three
// hardware lines: the roles were reported unmatched and billed nothing, with nothing on the
// quote looking wrong.
//
// THE FIX IS NOT "seed three rows for each of the six". Two of the three parts are vinyl parts:
//   STIFFENER  a 5" econo stiffener, an H-frame 5x5x96 sized to a 5x5 VINYL post (both
//              suppliers' own wording, SUPPLIER_QUOTES_2026-10-01.md). A chain-link gate is a
//              welded tube frame; aluminum and ornamental iron arrive as welded factory panels;
//              wood, split rail and composite are built on a GATE_FRAME_KIT (the seeded wood one
//              is "Steel-Reinforced", which IS the member that keeps the leaf square).
//   BRACE      "Gate Support Brace, 8'", White -- and the other supplier's equivalent is a
//              "V-brace white bevelled gate brace 8'". A white bevelled extrusion that goes
//              inside a vinyl gate frame. A wood gate's bracing is a different product and it
//              arrives in the frame kit the takeoff already asks for.
//   HANDLE     a 7" stainless pull that bolts through any leaf. Nothing about it is vinyl, and
//              it was filed VINYL by accident.
// So: the TAKEOFF stops asking for a brace and a stiffener where the gate does not take one, and
// the SEED moves the handle from VINYL to UNIVERSAL. Putting a 5x5 vinyl H-frame on a chain-link
// quote would be worse than the missing line it replaced -- he would order it and it would not fit.
//
// WHAT THIS FILE PINS
//   1. THE MATRIX, per fence type, read off the real engine's own takeoff entries.
//   2. THE WIDE-GATE RULE still splits correctly: the second hinge set is wanted on any leaf, the
//      second brace only where the first one was asked for.
//   3. THE MOUNTINGS are untouched. Posts, concrete and hole plugs are decided by where the gate
//      hangs and not by what it is made of, and they do NOT follow the stiffener out.
//   4. A VINYL GATE DID NOT MOVE -- the same lines, the same money, in the same order.
//   5. THE STARTING LIST now prices a gated quote for all seven types with nothing unmatched,
//      and the only money the change adds anywhere is the one handle.
//   6. THE TEETH, and this is the assertion that matters: with a BRACE row and a STIFFENER row
//      filed UNIVERSAL -- so the catalog CAN price them for every type -- a wood gate still bills
//      neither, because the takeoff no longer asks. Without this, every assertion in block 1 would
//      pass just as well on the old engine, where the roles were asked and merely went unmatched.
//   7. ALL THREE STARTING CATALOGS AGREE on where these three rows are filed. They agreed exactly
//      before this change and that is load-bearing: a row in one list and not another means two
//      companies get different catalogs depending which door they signed up through.
//
// EVERY NEGATIVE HAS A POSITIVE CONTROL BESIDE IT, produced by the same code on a planted case.
// A role that bills nothing and a role nobody asked for look identical on a quote; the only way to
// tell them apart is to read the takeoff entries and the unmatched list separately, which is what
// entryQty, billedQty and unmatchedOf below do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildPricingInput } from "../supabase/functions/_shared/pricing/load.ts";
import { PRICING_ENGINE_VERSION, priceJob } from "../supabase/functions/_shared/pricing/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/** The seven buildable types. UNIVERSAL is a catalog filing, not a fence. */
const FENCE_TYPES = ["VINYL", "WOOD", "CHAIN_LINK", "ALUMINUM", "ORNAMENTAL_IRON", "SPLIT_RAIL", "COMPOSITE"];
const NON_VINYL = FENCE_TYPES.filter((t) => t !== "VINYL");
/** The three roles this file is about. */
const ROLES = ["HANDLE", "BRACE", "STIFFENER"];

// ============================================================ the real engine ==
const JOB_SYNC = "a6000000-0000-4000-8000-000000000001";
const RUN_SYNC = "a6000000-0000-4000-8000-000000000002";

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
/** Sync ids are by position, so a price tie always breaks the same way. */
const dbRows = (rows) => rows.map((r, i) => ({
  sync_id: "a6000000-0000-4000-8000-" + String(100 + i).padStart(12, "0"),
  name: r.name, category: r.category ?? "MISC", role: r.role, fence_type: r.fence_type ?? "VINYL",
  color_or_finish: r.color_or_finish ?? "", unit: r.unit ?? "EA", unit_price: r.unit_price,
  taxable: r.taxable !== false, covers_ft: r.covers_ft ?? null, height_ft: r.height_ft ?? null,
  manufacturer_sync_id: null, is_active: true,
}));
const price = (run, rows, job = {}) => priceJob(buildPricingInput({
  job: jobRow(job), runs: [run], catalog: dbRows(rows), manufacturers: [], changeOrders: [], existingItems: [],
  engineVersion: PRICING_ENGINE_VERSION,
}));
/** What the TAKEOFF asked for, by role, before any catalog was consulted. */
const entryQty = (out, role) => out.runs[0].entries.filter((e) => e.role === role).reduce((s, e) => s + e.quantity, 0);
/** What the quote actually BILLS, by role. A role with no line bills nothing. */
const billedQty = (out, role) => out.items.filter((i) => i.role === role).reduce((s, i) => s + i.quantity, 0);
const unmatchedOf = (out) => [...new Set(out.unmatched_roles.map((u) => u.role))].sort();
const money = (n) => Math.round(n * 100) / 100;

const GATE = {
  LINE: "500.0:0.0:4.0:LINE:IN",
  WALL: "500.0:0.0:4.0:WALL:IN",
  LINE_TO_WALL: "500.0:0.0:4.0:LINE_TO_WALL:IN",
  WIDE: "500.0:0.0:10.0:LINE:IN",
};

// ====================================================== the starting catalog ==
// Read out of supabase_r20's VALUES list rather than retyped, so this file cannot pass against a
// list it has quietly drifted from. The r20 list, the phone's SeedData.kt and the office's
// CATALOG_SEED are checked against each other in block 7 and, column for column, by
// tests/a26-catalog-seed.test.mjs.
const SQL_PATH = "supabase_r20_seed_new_company_catalog.sql";
function seedFromSql(sql) {
  const from = sql.indexOf("from (values");
  const to = sql.indexOf(") as v(", from);
  assert.ok(from >= 0 && to > from, "no VALUES list in " + SQL_PATH);
  const rows = [];
  for (const rawLine of sql.slice(from, to).split("\n")) {
    const line = rawLine.replace(/\s--.*$/, "").trim();
    if (!line.startsWith("(")) continue;
    const f = [];
    let i = 1;
    while (i < line.length) {
      while (line[i] === " " || line[i] === ",") i++;
      if (line[i] === ")") break;
      if (line[i] === "'") {
        let j = i + 1, s = "";
        for (; j < line.length; j++) {
          if (line[j] === "'") { if (line[j + 1] === "'") { s += "'"; j++; continue; } break; }
          s += line[j];
        }
        f.push(s); i = j + 1;
      } else {
        let j = i; while (j < line.length && line[j] !== "," && line[j] !== ")") j++;
        f.push(line.slice(i, j).trim()); i = j;
      }
    }
    assert.equal(f.length, 9, "a VALUES tuple with " + f.length + " fields: " + line.slice(0, 80));
    rows.push({
      category: f[0], role: f[1], fence_type: f[2], name: f[3], unit: f[4], unit_price: Number(f[5]),
      taxable: f[6] === "true", covers_ft: f[7] === "null" ? null : Number(f[7]), color_or_finish: f[8],
    });
  }
  return rows;
}
const SEED = seedFromSql(read(SQL_PATH));
const seedWithout = (role) => SEED.filter((r) => r.role !== role);
/** One gate of the given mounting on a 100 ft open run of the given type. */
const quote = (type, mounting = "LINE", rows = SEED, run = {}, job = {}) =>
  price(runRow({ fence_type: type, gates_encoded: GATE[mounting], ...run }), rows, job);

// ================================================================= 0. HARNESS ==

test("harness: the seed reader found the whole starting list, and the engine prices every type off it", () => {
  assert.equal(SEED.length, 92, "the starting list is 92 rows");
  const perType = SEED.reduce((m, r) => ((m[r.fence_type] = (m[r.fence_type] || 0) + 1), m), {});
  for (const t of FENCE_TYPES) assert.ok(perType[t] > 0, "no seed rows at all for " + t);
  assert.ok(perType.UNIVERSAL > 0, "no UNIVERSAL seed rows");
  for (const t of FENCE_TYPES) {
    const out = quote(t);
    assert.equal(out.engine_version, PRICING_ENGINE_VERSION);
    assert.ok(out.totals.grand_total > 0, t + ": no money came out, so no number below means anything");
  }
});

test("harness: entryQty and billedQty are different questions, and the reader can tell them apart", () => {
  // A role that was asked for and priced: both non-zero. The positive control for every zero
  // asserted anywhere below -- without it, a reader that always answers 0 would pass the lot.
  const vinyl = quote("VINYL");
  for (const role of ROLES) {
    assert.ok(entryQty(vinyl, role) > 0, "control: vinyl does not even ask for " + role);
    assert.ok(billedQty(vinyl, role) > 0, "control: vinyl asks for " + role + " but bills nothing");
  }
  // A role that was asked for and NOT priced: asked non-zero, billed zero, and named as unmatched.
  const noHandle = quote("VINYL", "LINE", seedWithout("HANDLE"));
  assert.ok(entryQty(noHandle, "HANDLE") > 0, "control: the takeoff stopped asking when the ROW went away");
  assert.equal(billedQty(noHandle, "HANDLE"), 0);
  assert.deepEqual(unmatchedOf(noHandle), ["HANDLE"], "control: an unpriced role is reported, not swallowed");
});

// ============================================================== 1. THE MATRIX ==

test("THE MATRIX: a gate asks for a handle on all seven types, and for a brace and a stiffener only on vinyl", () => {
  const got = {};
  for (const t of FENCE_TYPES) {
    const out = quote(t);
    got[t] = Object.fromEntries(ROLES.map((r) => [r, entryQty(out, r)]));
  }
  assert.deepEqual(got, {
    VINYL: { HANDLE: 1, BRACE: 1, STIFFENER: 1 },
    WOOD: { HANDLE: 1, BRACE: 0, STIFFENER: 0 },
    CHAIN_LINK: { HANDLE: 1, BRACE: 0, STIFFENER: 0 },
    ALUMINUM: { HANDLE: 1, BRACE: 0, STIFFENER: 0 },
    ORNAMENTAL_IRON: { HANDLE: 1, BRACE: 0, STIFFENER: 0 },
    SPLIT_RAIL: { HANDLE: 1, BRACE: 0, STIFFENER: 0 },
    COMPOSITE: { HANDLE: 1, BRACE: 0, STIFFENER: 0 },
  });
});

test("the hinge set and the latch stayed universal, because they genuinely are", () => {
  for (const t of FENCE_TYPES) {
    const out = quote(t);
    assert.equal(entryQty(out, "HINGE_SET"), 1, t + " hinge set");
    assert.equal(entryQty(out, "LATCH"), 1, t + " latch");
    assert.ok(billedQty(out, "HINGE_SET") > 0 && billedQty(out, "LATCH") > 0, t + ": hinges or latch bill nothing");
  }
});

test("an ungated run of any type asks for none of the three", () => {
  for (const t of FENCE_TYPES) {
    const out = price(runRow({ fence_type: t }), SEED);
    for (const r of ROLES) assert.equal(entryQty(out, r), 0, t + " with no gate asks for " + r);
  }
});

// ========================================================== 2. THE WIDE GATE ==

test("a 10 ft gate gets the second hinge set on every type, and the second brace only where the first was asked for", () => {
  for (const t of FENCE_TYPES) {
    const out = quote(t, "WIDE");
    assert.equal(entryQty(out, "HINGE_SET"), 2, t + ": a wide gate wants the heavier hinge set whatever the leaf is");
    assert.equal(entryQty(out, "BRACE"), t === "VINYL" ? 2 : 0, t + " braces on a 10 ft gate");
    assert.equal(entryQty(out, "STIFFENER"), t === "VINYL" ? 1 : 0, t + " stiffeners on a 10 ft gate");
    assert.equal(entryQty(out, "HANDLE"), 1, t + ": one handle per gate however wide");
  }
});

// =========================================================== 3. THE MOUNTINGS ==

test("the gate AREA is still decided by where the gate hangs, not by what the fence is made of", () => {
  // The wall-gate wave's numbers (PRICING_ENGINE_VERSION 2026.10.6) on a 100 ft open run at 6 ft
  // spacing with one 4 ft gate, and this change must not have touched one of them. END_POST counts
  // the run's own two ends as well as anything the gate area adds: WALL and LINE_TO_WALL each add
  // one, LINE adds none. HOLE_PLUG is the interesting case -- the holes are drilled into the POST,
  // so the plugs do NOT follow the stiffener out on a non-vinyl wall gate.
  const want = {
    WALL: { BLANK_POST: 1, GATE_POST: 0, END_POST: 3, HOLE_PLUG: 4, CONCRETE_BAG: 17 },
    LINE: { BLANK_POST: 0, GATE_POST: 2, END_POST: 2, HOLE_PLUG: 0, CONCRETE_BAG: 19 },
    LINE_TO_WALL: { BLANK_POST: 0, GATE_POST: 2, END_POST: 3, HOLE_PLUG: 0, CONCRETE_BAG: 20 },
  };
  for (const [mounting, roles] of Object.entries(want)) {
    for (const t of FENCE_TYPES) {
      const out = quote(t, mounting);
      for (const [role, n] of Object.entries(roles)) {
        // Asserted for EVERY type, which is the claim: identical across all seven. A pin on vinyl
        // alone could not tell "the gate area ignores the fence type" from "I only looked at vinyl".
        assert.equal(entryQty(out, role), n, `${t} ${mounting}: ${role}`);
      }
      assert.equal(entryQty(out, "STIFFENER"), t === "VINYL" ? 1 : 0, `${t} ${mounting}: stiffeners`);
      assert.equal(entryQty(out, "BRACE"), t === "VINYL" ? 1 : 0, `${t} ${mounting}: braces`);
      assert.equal(entryQty(out, "HANDLE"), 1, `${t} ${mounting}: handles`);
    }
  }
  // Control: the numbers above are not all-zero defaults from a role name nobody emits.
  assert.equal(entryQty(quote("VINYL", "WALL"), "NOT_A_ROLE"), 0, "control");
  assert.ok(Object.values(want).every((r) => Object.values(r).some((n) => n > 0)));
});

test("a stiffener is per gate and not per mounting: two gates on one vinyl run ask for two", () => {
  // Gates are comma-separated (geometry.ts decodeGates), not semicolon-separated.
  const out = price(runRow({ gates_encoded: GATE.LINE + ",600.0:0.0:4.0:LINE:IN" }), SEED);
  assert.equal(entryQty(out, "GATE_PANEL"), 2, "control: the second gate was not decoded, so the counts below mean nothing");
  assert.equal(entryQty(out, "STIFFENER"), 2);
  assert.equal(entryQty(out, "BRACE"), 2);
  assert.equal(entryQty(out, "HANDLE"), 2);
});

// ================================================ 4. A VINYL GATE DID NOT MOVE ==

test("a vinyl gated quote on the starting list is the same lines, the same money and the same order", () => {
  const out = quote("VINYL");
  // The gate hardware, priced off the starting list's own rows. Pinned as literals: a golden that
  // can only be re-derived from the thing it checks cannot catch the thing it checks changing.
  const line = (role) => {
    const i = out.items.find((x) => x.role === role);
    assert.ok(i, "no line at all for " + role);
    return [i.quantity, money(i.unit_price), i.unit];
  };
  assert.deepEqual(line("HINGE_SET"), [1, 32.25, "BOX"]);
  assert.deepEqual(line("LATCH"), [1, 25.87, "BOX"]);
  assert.deepEqual(line("HANDLE"), [1, 5, "BOX"], "the handle is the same row at the same price after the move to UNIVERSAL");
  assert.deepEqual(line("BRACE"), [1, 6.5, "EA"]);
  assert.deepEqual(line("STIFFENER"), [1, 52.75, "EA"]);
  assert.deepEqual(line("TRIM"), [4, 2, "EA"]);
  // ORDER. A line's sort order follows the order its role is first asked for, and a reordered
  // quote is a changed quote even when every number on it is the same.
  const seen = [];
  for (const e of out.runs[0].entries) if (!seen.includes(e.role)) seen.push(e.role);
  const gateRun = seen.slice(seen.indexOf("GATE_PANEL"));
  assert.deepEqual(gateRun.slice(0, 7),
    ["GATE_PANEL", "HINGE_SET", "LATCH", "HANDLE", "BRACE", "TRIM", "STIFFENER"],
    "a vinyl gate's entry order moved, so its line items would reorder on the quote");
  assert.deepEqual(unmatchedOf(out), ["BLANK_POST"].filter(() => false),
    "a vinyl gate in the line has nothing unmatched on the starting list");
});

test("re-filing the handle back to VINYL prices a vinyl quote identically -- the move cost nothing", () => {
  const asVinyl = SEED.map((r) => (r.role === "HANDLE" ? { ...r, fence_type: "VINYL" } : r));
  assert.ok(SEED.some((r) => r.role === "HANDLE" && r.fence_type === "UNIVERSAL"), "control: the seed has it UNIVERSAL");
  assert.ok(asVinyl.some((r) => r.role === "HANDLE" && r.fence_type === "VINYL"), "control: the probe really re-filed it");
  for (const mounting of ["LINE", "WALL", "LINE_TO_WALL"]) {
    assert.equal(quote("VINYL", mounting, asVinyl).totals.grand_total, quote("VINYL", mounting).totals.grand_total,
      "vinyl " + mounting);
  }
  // Teeth for this one: on WOOD the two filings must NOT agree, or the comparison above proves nothing.
  assert.notEqual(quote("WOOD", "LINE", asVinyl).totals.grand_total, quote("WOOD", "LINE").totals.grand_total,
    "control: a wood gate is the case the filing changes, and it came out the same");
});

// ====================================================== 5. THE STARTING LIST ==

test("the starting list now prices a gated quote for all seven types with nothing unmatched", () => {
  for (const t of FENCE_TYPES) {
    assert.deepEqual(unmatchedOf(quote(t)), [], t + " with a 4 ft gate in the line");
  }
  // The wall mounting still has its own genuine gap, and it is not this file's: BLANK_POST has no
  // row in any catalog and is priced off GATE_POST by the matcher's fallback.
  for (const t of FENCE_TYPES) {
    assert.deepEqual(unmatchedOf(quote(t, "WALL")), [], t + " with a wall gate");
  }
});

test("the only money this adds anywhere is the one handle, and only for a NEW company's non-vinyl gate", () => {
  const TAX = 1.07;
  for (const t of NON_VINYL) {
    const withHandle = quote(t).totals.grand_total;
    const without = quote(t, "LINE", seedWithout("HANDLE")).totals.grand_total;
    assert.equal(money(withHandle - without), money(5 * TAX), t + ": the gain is not exactly one $5 handle plus tax");
    // And nothing else: the brace and the stiffener are not asked for, so removing their rows
    // cannot change this type's total by a cent.
    for (const role of ["BRACE", "STIFFENER"]) {
      assert.equal(quote(t, "LINE", seedWithout(role)).totals.grand_total, withHandle,
        `${t}: dropping the ${role} row moved the total, so the takeoff is still asking for it`);
    }
  }
  // Positive control: on VINYL those same two rows DO carry money, so the loop above is measuring
  // something real rather than reading a column that is always equal.
  const vinyl = quote("VINYL").totals.grand_total;
  for (const role of ["BRACE", "STIFFENER"]) {
    assert.notEqual(quote("VINYL", "LINE", seedWithout(role)).totals.grand_total, vinyl,
      "control: dropping the " + role + " row did not move a VINYL quote");
  }
});

// =================================================================== 6. TEETH ==

test("TEETH: with a brace and a stiffener filed UNIVERSAL, a non-vinyl gate still bills neither -- the TAKEOFF stopped asking", () => {
  // This is the assertion that separates the fix from the bug it replaced. On the old engine the
  // roles were asked for on every type and merely went unmatched, so every "0" in block 1 would
  // have passed there too. Here the catalog CAN price them for any type.
  const universal = SEED.map((r) => (r.role === "BRACE" || r.role === "STIFFENER" ? { ...r, fence_type: "UNIVERSAL" } : r));
  assert.equal(universal.filter((r) => r.fence_type === "UNIVERSAL" && (r.role === "BRACE" || r.role === "STIFFENER")).length, 2,
    "control: the probe catalog does not actually hold the two universal rows");
  for (const t of NON_VINYL) {
    const out = quote(t, "LINE", universal);
    assert.equal(entryQty(out, "BRACE"), 0, t + ": the takeoff is still asking for a brace");
    assert.equal(entryQty(out, "STIFFENER"), 0, t + ": the takeoff is still asking for a stiffener");
    assert.equal(billedQty(out, "BRACE"), 0, t + ": a brace was BILLED off a universal row");
    assert.equal(billedQty(out, "STIFFENER"), 0, t + ": a stiffener was BILLED off a universal row");
    assert.deepEqual(unmatchedOf(out), [], t + ": a role nobody asked for is being reported unmatched");
    assert.equal(out.totals.grand_total, quote(t).totals.grand_total,
      t + ": the universal rows changed the total, so they reached the quote");
  }
  // POSITIVE CONTROL: the same two universal rows on a VINYL gate ARE billed. So the catalog is
  // reachable and the zeros above are the takeoff's doing, not a catalog that cannot be read.
  const vinyl = quote("VINYL", "LINE", universal);
  assert.equal(billedQty(vinyl, "BRACE"), 1, "control: a universal brace row is not reachable at all");
  assert.equal(billedQty(vinyl, "STIFFENER"), 1, "control: a universal stiffener row is not reachable at all");
});

test("TEETH: suppressing a role still suppresses it, and suppressing one the type never asked for is a no-op", () => {
  const vinyl = price(runRow({ gates_encoded: GATE.LINE, suppressed_roles: "BRACE,STIFFENER" }), SEED);
  assert.equal(entryQty(vinyl, "BRACE"), 0);
  assert.equal(entryQty(vinyl, "STIFFENER"), 0);
  assert.equal(entryQty(vinyl, "HANDLE"), 1, "control: suppression did not swallow the whole gate");
  const wood = price(runRow({ fence_type: "WOOD", gates_encoded: GATE.LINE, suppressed_roles: "BRACE,STIFFENER" }), SEED);
  assert.equal(wood.totals.grand_total, quote("WOOD").totals.grand_total,
    "suppressing a role wood never asked for changed the total");
});

// ============================================ 7. ALL THREE CATALOGS MUST AGREE ==

test("the phone's list, the r20 SQL and the office's CATALOG_SEED file these three rows identically", () => {
  // Read with three small readers rather than one shared one, so a reader that silently matches
  // nothing shows up as a missing row instead of as agreement. Column-for-column agreement across
  // the whole 92 is tests/a26-catalog-seed.test.mjs's job; this is the one invariant this change
  // turns on.
  const kt = read("app/src/main/java/com/fenceestimator/app/data/SeedData.kt");
  const dash = read("website/dashboard.html");
  const fromKt = {};
  for (const role of ROLES) {
    const re = new RegExp("item\\(MaterialCategory\\.\\w+, MaterialRole\\." + role + ", (t|FenceType\\.(\\w+))[,)]", "g");
    const hits = [...kt.matchAll(re)];
    assert.equal(hits.length, 1, `SeedData.kt has ${hits.length} ${role} rows, expected 1`);
    // `t` is the enclosing <type>Items() function's local; resolve it from that function's header.
    const before = kt.slice(0, hits[0].index);
    const fn = [...before.matchAll(/val t = FenceType\.(\w+)/g)].pop();
    fromKt[role] = hits[0][2] ?? (fn ? fn[1] : "(unresolved)");
  }
  const fromSql = {};
  for (const role of ROLES) {
    const rows = SEED.filter((r) => r.role === role);
    assert.equal(rows.length, 1, `${SQL_PATH} has ${rows.length} ${role} rows, expected 1`);
    fromSql[role] = rows[0].fence_type;
  }
  const fromOffice = {};
  for (const role of ROLES) {
    const re = new RegExp('\\{category:"\\w+",role:"' + role + '",fence_type:"(\\w+)"', "g");
    const hits = [...dash.matchAll(re)];
    assert.equal(hits.length, 1, `dashboard.html CATALOG_SEED has ${hits.length} ${role} rows, expected 1`);
    fromOffice[role] = hits[0][1];
  }
  const want = { HANDLE: "UNIVERSAL", BRACE: "VINYL", STIFFENER: "VINYL" };
  assert.deepEqual(fromKt, want, "SeedData.kt");
  assert.deepEqual(fromSql, want, SQL_PATH);
  assert.deepEqual(fromOffice, want,
    "dashboard.html CATALOG_SEED is out of step. Change the HANDLE row's fence_type from \"VINYL\" to " +
    "\"UNIVERSAL\" and MOVE the row out of the VINYL block to the end of the UNIVERSAL block -- " +
    "catalogSeedCounts() keys the counts in array order and catalog-run-viewer.test.mjs compares " +
    "that object to SeedData.kt's, key order included, so a UNIVERSAL row left among the vinyl ones " +
    "fails even with the right count. Also update the two block comments (vinyl 19 -> 18, " +
    "universal 2 -> 3).");
});

test("the two copies of the r20 VALUES list are still the same list", () => {
  const sql = read(SQL_PATH);
  const blocks = [...sql.matchAll(/-- ==== THE CHANGE: BEGIN ====\n([\s\S]*?)\n-- ==== THE CHANGE: END ====/g)].map((m) => m[1]);
  assert.equal(blocks.length, 2, "expected a dry-run block and an apply block");
  assert.equal(blocks[0], blocks[1], "the apply block is not the same text as the dry run's -- one was edited alone");
});
