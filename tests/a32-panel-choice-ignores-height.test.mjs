// a32-panel-choice-ignores-height -- the pricing engine chooses a PANEL row by width, then cheapest, and never reads height.
//
// WHY THIS FILE EXISTS
//   Found on 1 October 2026 while a vinyl "height transition" catalog row was being defended, and worth far more than the
//   row, which was retracted the same day. (The owner decided a 6 ft fence that steps down to 4 ft needs no transition
//   product: the raked bay is a standard 6 ft panel he cuts on site, priced as 6 ft. So no catalog item, no role, no
//   engine rule.) What survives of that work is the discovery, run against the REAL engine -- the one price-job runs --
//   so it is a measurement and not a reading of the code:
//
//     The engine picks a PANEL row by colour, then nearest width (coversFt), then CHEAPEST (priced rows first), then id.
//     The run's panel height is parsed into the run and never consulted by the takeoff or by panel choice. The phone's
//     engine is no different: the only other reader of panelHeightFt in the app's estimate code is PdfExporter, which prints it.
//
// WHAT FOLLOWS FROM IT, each pinned below
//   1. A SHIPPED BUG, TODAY. The starting catalog holds "Ornamental Steel Panel 4'H x 6'W, Black" (135.00) and
//      "Ornamental Steel Panel 6'H x 6'W, Black" (175.00). Both are coversFt 6, so a 6 ft iron run ties on width and the
//      cheaper -- the 4 ft HIGH panel -- wins, whatever height the run says. The 6 ft high panel ships and is never
//      chosen. Every bay of every 6 ft ornamental-iron quote is short by the difference. This file measures it; it does
//      not fix it (the fix belongs in line-items.ts and EstimateEngine.buildLineItems, which are not touched here).
//   2. IT IS WHAT BLOCKS 4 FT FENCE ROWS. A 4'H x 6'W vinyl panel priced under the 6'H one would take over every 6 ft
//      white vinyl quote the same way. Those rows cannot be added to the catalog until panel choice reads height, so the
//      request for 4 ft fences was never a catalog task.
//   3. A DIFFERENT-HEIGHT PANEL PRICED OVER THE STANDARD ONE IS NEVER CHOSEN, even when the run asks for its height. So a
//      taller or shorter row can only misprice (when it is the cheaper) or sit unused (when it is the dearer).
//   The panels these tests add to the catalog are SYNTHETIC: the test defines them, none is in the seed.
//
// THE TRIPWIRE. These tests pin how the engine behaves TODAY. The day panel choice learns to read height they go RED, and
// that red is the FIX LANDING, not a regression: the 4 ft rows can then be added, and the ornamental-iron run
// will take the panel its height asks for. The failure messages say so. Do not "fix" them by loosening; rewrite them for
// the new rule.
//
//   LIMIT OF THE TRIPWIRE, so nobody is surprised by silence. A catalog row carries no height today: the only place a
//   panel's height appears is in its NAME. dbRows() below hands the engine exactly the columns price-job reads, so if the
//   fix reads a NEW height column, dbRows() and readSeed() must be taught that column or the fix will pass these tests
//   unseen (a row with no height falls back to today's behaviour). This was checked against an engine that reads height off
//   the name: the grid, the 4 ft run, the dearer 8 ft panel, the 4 ft probe and the iron defect all went red.
//
// EVERY CHECK HAS A CONTROL. "Nothing differs" reads the same as "the comparison cannot see a difference", so each
// unchanged-quote check is paired with the same comparison on something that DOES change a quote, and must report a change.
//
//   node --test tests/a32-panel-choice-ignores-height.test.mjs        (no network, no writes)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { buildPricingInput } from "../supabase/functions/_shared/pricing/load.ts";
import { PRICING_ENGINE_VERSION, priceJob } from "../supabase/functions/_shared/pricing/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const SEED_PATH = "app/src/main/java/com/fenceestimator/app/data/SeedData.kt";
const SEED_SRC = read(SEED_PATH);

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
        source_doc: consts[args.match(/sourceDoc\s*=\s*([A-Za-z_]\w*)/)[1]],
      });
      re.lastIndex = end;
    }
  });
  return { rows, seeded: consts.SEEDED };
}

const SEED = readSeed(SEED_SRC);

// ============================================================ the real engine ==
const JOB_SYNC = "a3200000-0000-4000-8000-000000000001";
const RUN_SYNC = "a3200000-0000-4000-8000-000000000002";
const jobRow = (o = {}) => ({
  sync_id: JOB_SYNC, updated_at: "2026-10-01T12:00:00Z", calibration_pixels_per_foot: null,
  tax_rate_percent: 7, markup_percent: 0, discount_percent: 0, labor_rate_per_ft: 8, labor_flat_fee: 0,
  minimum_job_charge: 200, minimum_labor_charge: 0, waste_percent: 0, gate_rate_per_ft: 20, trash_haul_fee: 0,
  teardown_enabled: false, teardown_flat_fee: 0, teardown_rate_per_ft: 0, teardown_feet: 0,
  preferred_manufacturer_sync_id: null, survey_storage_path: null, ...o,
});
/** A vinyl run typed in by length (no drawing needed). Post spacing follows the panel width, as the UI keeps it. */
const runRow = (o = {}) => ({
  sync_id: RUN_SYNC, label: "Back", fence_type: "VINYL", color_or_finish: "", points_encoded: "",
  gates_encoded: "", closed_loop: false, manual_linear_feet: 100, manual_corner_count: 0, panel_width_ft: 6,
  panel_height_ft: 6, post_spacing_ft: o.panel_width_ft ?? 6, concrete_bags_per_post: 1, aluminum_style: "RACKABLE",
  wood_style: "PRIVACY", wood_rail_count: 3, picket_width_in: 5.5, picket_gap_in: 0, fabric_height_ft: 4,
  include_top_rail: true, include_tension_wire: false, include_barbed_wire_arms: false,
  include_privacy_slats: false, split_rail_count: 2, suppressed_roles: "", is_teardown: false, sort_order: 0, ...o,
});
/** Catalog rows as price-job reads them. Ids are by position so a tie always resolves the same way. */
const dbRows = (rows) => rows.map((r, i) => ({
  sync_id: "a3200000-0000-4000-8000-" + String(100 + i).padStart(12, "0"), name: r.name, category: r.category,
  role: r.role, fence_type: r.fence_type, color_or_finish: r.color_or_finish, unit: r.unit, unit_price: r.unit_price,
  taxable: r.taxable, covers_ft: r.covers_ft, manufacturer_sync_id: null, is_active: true,
}));
const price = (run, rows) => priceJob(buildPricingInput({
  job: jobRow(), runs: [run], catalog: dbRows(rows), manufacturers: [], changeOrders: [], existingItems: [],
  engineVersion: PRICING_ENGINE_VERSION,
}));
/** Everything a quote is made of, as one comparable string. */
const quote = (out) => JSON.stringify({
  items: out.items, unmatched: out.unmatched_roles, zero: out.zero_priced_names, totals: out.totals,
});
const panelLine = (out) => out.items.find((i) => i.role === "PANEL");
const GATE_4FT = "500.0:0.0:4.0:LINE:IN";

/**
 * A PANEL row this test invents -- it is NOT in the seed. White vinyl, 6 ft wide, so it ties on width with the standard
 * 6'H x 6'W white panel and only its price tells the two apart. `label` is what the row stands for in the test.
 */
const synthPanel = (label, unitPrice) => ({
  category: "PANEL", role: "PANEL", fence_type: "VINYL", name: "SYNTHETIC " + label + " x 6'W - White",
  unit: "EA", unit_price: unitPrice, taxable: true, covers_ft: 6, color_or_finish: "White", source_doc: SEED.seeded,
});
const catalogWith = (row) => [...SEED.rows, row];

// ============================================================== 0. HARNESS ==

test("harness: the reader finds the starting list and the rows it must", () => {
  assert.ok(SEED.rows.length >= 92, "found only " + SEED.rows.length + " rows in " + SEED_PATH);
  assert.equal(SEED.seeded, "Starting price \u2014 verify with your supplier", "the SEEDED label was read");
  const white6 = SEED.rows.find((r) => r.name === "Panel T&G Vinyl Privacy 6'H x 6'W - White");
  assert.ok(white6, "control: the 6'H x 6'W white vinyl panel is in the reader's output");
  assert.equal(white6.role, "PANEL");
  assert.equal(white6.unit_price, 52.35);
  assert.equal(white6.covers_ft, 6);
  assert.equal(white6.fence_type, "VINYL");
});

test("harness: the real engine prices a plain vinyl run from the seed and the quote has panels on it", () => {
  const out = price(runRow(), SEED.rows);
  const p = panelLine(out);
  assert.ok(p, "no PANEL line on a 100 ft vinyl quote -- the engine harness is dead, fix it before trusting anything below");
  assert.equal(p.description, "Panel T&G Vinyl Privacy 6'H x 6'W - White", "with no colour chosen, the cheapest nearest-width panel is the white 6 ft one");
  assert.equal(p.quantity, 17, "100 ft at 6 ft a bay is 17 panels");
  assert.ok(out.totals.grand_total > 0);
});

// ============================================= 1. HEIGHT IS NEVER READ, ACROSS THE GRID ==

/** Every spec a vinyl run can be set to that matters to panel choice. */
function grid() {
  const cases = [];
  for (const width of [6, 8, 7, 5])
    for (const color of ["", "White", "Tan", "Gray", "white"])
      for (const gates of ["", GATE_4FT])
        for (const feet of [100, 37])
          cases.push(runRow({ panel_width_ft: width, color_or_finish: color, gates_encoded: gates, manual_linear_feet: feet }));
  return cases;
}
const describeRun = (run) => `width ${run.panel_width_ft}, colour "${run.color_or_finish}", gates "${run.gates_encoded}", ${run.manual_linear_feet} ft`;

// The shipped catalog stocks vinyl panels at ONE height, so on its own it cannot tell a height-blind engine from a
// height-aware one with nothing to choose between. This catalog adds a 4'H and an 8'H white panel (synthetic), so a
// height-aware engine would take a different panel for a 4 ft, a 6 ft and an 8 ft run, and these quotes would differ.
const MIXED_HEIGHTS = [...SEED.rows, synthPanel("white vinyl panel 4'H", 40), synthPanel("white vinyl panel 8'H", 70)];

test("ENGINE FACT, across the grid: a run's height changes no vinyl quote, even with panels of three heights in the catalog", () => {
  const cases = grid();
  assert.ok(cases.length >= 80, "the grid shrank to " + cases.length);
  let withPanels = 0, sawLength = 0, tookSynthetic = 0;
  for (const run of cases) {
    const base = price({ ...run, panel_height_ft: 6 }, MIXED_HEIGHTS);
    for (const h of [4, 8])
      assert.equal(quote(price({ ...run, panel_height_ft: h }, MIXED_HEIGHTS)), quote(base),
        "TRIPWIRE: a run's height now changes the quote (" + h + " ft against 6 ft, " + describeRun(run) + "). Panel choice may be height-aware: " +
        "that is the fix landing, not a regression. The 4 ft rows can be added and the ornamental-iron defect below should be gone; rewrite this file for the new rule.");
    if (panelLine(base)) withPanels++;
    if (panelLine(base)?.description.startsWith("SYNTHETIC")) tookSynthetic++;
    // The comparison is not blind: ten more feet is a change it must report on every case.
    if (quote(price({ ...run, manual_linear_feet: run.manual_linear_feet + 10 }, MIXED_HEIGHTS)) !== quote(base)) sawLength++;
  }
  // CONTROL: the synthetic panels are in play. A 6 ft run on this grid is billed with the 4'H panel in some cases, which is the
  // defect itself, and is what a height-aware engine would stop doing. If none did, the catalog above would be a decoration.
  assert.ok(tookSynthetic > 0, "control: no 6 ft run in the grid took a synthetic panel, so the mixed-height catalog tests nothing");
  assert.ok(withPanels >= cases.length * 0.9, "control: nearly every quote in the grid should carry a panel line, only " + withPanels + " did");
  assert.equal(sawLength, cases.length, "control: ten more feet of fence changed only " + sawLength + " of " + cases.length + " quotes, so this comparison cannot see a change");
});

test("CONTROL: the same grid comparison does see a catalog row that moves quotes (the check is not blind)", () => {
  // A 6'H row against the default 6 ft run: it moves quotes whether or not the engine reads height, so this control does not
  // depend on the thing the check above is testing.
  const cheap = catalogWith(synthPanel("white vinyl panel 6'H", 40));
  const moved = grid().filter((run) => quote(price(run, cheap)) !== quote(price(run, SEED.rows)));
  assert.ok(moved.length > 0, "a PANEL row priced under the standard panel moved no quote in the grid: the unchanged-quote check above proves nothing");
  assert.ok(moved.length < grid().length, "a cheaper white 6 ft panel moved EVERY quote, including the Tan and Gray ones it cannot match: the comparison is reporting noise");
});

// ======================================================= 2. THE MECHANISM, RUN ==

test("ENGINE FACT: height is never read when a panel is chosen -- a 4 ft run and a 6 ft run quote identically", () => {
  // On the shipped catalog. It stocks one height of vinyl panel, so this half alone could not tell a height-aware engine
  // from a blind one: the second half below is the one with teeth.
  for (const width of [6, 8]) {
    const six = price(runRow({ panel_width_ft: width, panel_height_ft: 6 }), SEED.rows);
    const four = price(runRow({ panel_width_ft: width, panel_height_ft: 4 }), SEED.rows);
    assert.equal(quote(six), quote(four),
      "TRIPWIRE: the engine now prices a 4 ft run differently from a 6 ft one. That is what blocked the 4 ft vinyl rows and " +
      "made the 6 ft ornamental-iron run take the 4 ft panel. If panel choice is now height-aware, add those rows as PANEL and rewrite this file for the new rule.");
  }
  // With a 4'H white panel (synthetic, cheaper) in the catalog, a height-aware engine would give the 4 ft run that panel and
  // the 6 ft run the 6'H one. Today both take the 4'H -- the 6 ft run is billed with the 4 ft panel, which is the defect.
  const alt = synthPanel("white vinyl panel 4'H", 40);
  for (const color of ["", "White"]) {
    const six = price(runRow({ color_or_finish: color, panel_height_ft: 6 }), catalogWith(alt));
    const four = price(runRow({ color_or_finish: color, panel_height_ft: 4 }), catalogWith(alt));
    assert.equal(quote(six), quote(four),
      `TRIPWIRE: with a 4 ft panel in the catalog the engine now quotes a 4 ft run differently from a 6 ft one (colour "${color}"). That is the fix landing, not a regression: rewrite this file for the new rule.`);
    assert.equal(panelLine(six).description, alt.name, `the 6 ft run (colour "${color}") is billed with the 4 ft high panel, since height is never read`);
  }
  // CONTROL: the same two-run comparison reports a difference when the width differs, so "identical" above is not blindness.
  assert.notEqual(quote(price(runRow({ panel_width_ft: 6 }), SEED.rows)), quote(price(runRow({ panel_width_ft: 8 }), SEED.rows)),
    "control: a 6 ft and an 8 ft panel width quoted identically, so the height comparison above cannot see anything");
});

test("ENGINE FACT: the width tie goes to the cheapest, so a one-bay stepped panel stocked as PANEL and priced UNDER the standard one is billed for the whole fence", () => {
  const stepped = synthPanel("stepped bay 6'H to 4'H", 40);
  const out = price(runRow({ panel_width_ft: 6, color_or_finish: "White" }), catalogWith(stepped));
  const p = panelLine(out);
  assert.equal(p.description, stepped.name,
    "TRIPWIRE: a cheaper same-width PANEL row no longer wins the width tie. The tie-break has changed -- if it is height-aware now, that is the fix landing, not a regression; rewrite this file for the new rule.");
  assert.equal(p.quantity, 17, "all seventeen bays of a 100 ft fence, billed as the one-bay product");
  assert.equal(p.unit_price, 40);
});

test("ENGINE FACT: a different-height PANEL priced OVER the standard panel is never chosen -- even when the run asks for its height", () => {
  const tall = synthPanel("white vinyl panel 8'H", 100);
  const rows = catalogWith(tall);
  // CONTROL: the very same row, cheaper, IS chosen -- so "never chosen" below is the price, not a row the engine cannot see.
  const cheapTall = synthPanel("white vinyl panel 8'H", 40);
  assert.equal(panelLine(price(runRow({ panel_width_ft: 6, color_or_finish: "White", panel_height_ft: 8 }), catalogWith(cheapTall))).description, cheapTall.name,
    "control: the same 8 ft high row at 40 should win the width tie, otherwise the checks below prove nothing");
  for (const width of [5, 6, 7, 8]) {
    for (const color of ["", "White"]) {
      const p = panelLine(price(runRow({ panel_width_ft: width, color_or_finish: color, panel_height_ft: 8 }), rows));
      assert.ok(p, `control: a panel line exists at width ${width}, colour "${color}"`);
      assert.notEqual(p.description, tall.name,
        `TRIPWIRE: the dearer 8 ft high panel was chosen for an 8 ft run at width ${width}, colour "${color}". Panel choice has changed; it may now be height-aware -- read this file's header.`);
    }
  }
});

test("ENGINE FACT, the 4 ft case: a 4'H x 6'W white vinyl panel cheaper than the 6'H one takes over every 6 ft white quote", () => {
  // Not a row in the seed -- a probe of what adding one as PANEL would do. It is why the 4 ft vinyl panel was NOT added.
  const four = { category: "PANEL", role: "PANEL", fence_type: "VINYL", name: "Panel T&G Vinyl Privacy 4'H x 6'W - White",
    unit: "EA", unit_price: 40, taxable: true, covers_ft: 6, color_or_finish: "White", source_doc: SEED.seeded };
  const out = price(runRow({ panel_width_ft: 6, panel_height_ft: 6, color_or_finish: "White" }), [...SEED.rows, four]);
  assert.equal(panelLine(out).description, four.name,
    "TRIPWIRE: the cheaper 4 ft panel no longer takes a 6 ft run. Height-aware panel choice may have landed; the 4 ft rows can be added.");
  const without = price(runRow({ panel_width_ft: 6, panel_height_ft: 6, color_or_finish: "White" }), SEED.rows);
  assert.ok(out.totals.grand_total < without.totals.grand_total, "a 6 ft fence quoted cheaper because of a 4 ft panel it does not use");
});

test("KNOWN DEFECT (pinned), already in the shipped list: a 6 ft ornamental-iron run is priced with the 4 ft HIGH panel", () => {
  // The same mechanism, on rows that already ship. The 4'H x 6'W steel panel (135) and the 6'H x 6'W one (175) are both
  // coversFt 6, so a run spec'd 6 ft wide ties on width and the cheaper one wins -- whatever height the run says.
  // Not fixed here (the engine is held by another wave). It is the proof that the hazard in this file is not hypothetical.
  const iron = (h) => price(runRow({ fence_type: "ORNAMENTAL_IRON", color_or_finish: "Black", panel_width_ft: 6, panel_height_ft: h }), SEED.rows);
  const six = panelLine(iron(6));
  assert.ok(six, "control: an ornamental-iron quote carries a panel line");
  assert.equal(six.description, "Ornamental Steel Panel 4'H x 6'W, Black",
    "FIXED? the 6 ft high iron run no longer takes the 4 ft high panel. Panel choice may now be height-aware: that is the fix landing, not a regression. Rewrite this file for the new rule.");
  assert.equal(panelLine(iron(4)).description, six.description, "...and the 4 ft run takes the same panel, as height is never read");
  const taller = SEED.rows.find((r) => r.name === "Ornamental Steel Panel 6'H x 6'W, Black" && r.role === "PANEL");
  assert.ok(taller, "control: the 6 ft high panel exists to be chosen");
  // MEASURED: every bay is billed at the 4 ft high price instead of the 6 ft high one, so the quote is short by the gap on each.
  assert.ok(taller.unit_price > six.unit_price, "control: the 6 ft high panel costs more than the one the quote used (" + taller.unit_price + " against " + six.unit_price + ")");
});

test("ENGINE FACT: role NONE is no way round it -- the takeoff never asks for a NONE row, and the engine's output carries none", () => {
  const takeoff = read("supabase/functions/_shared/pricing/takeoff.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(/qty\("PANEL"/.test(takeoff) && /qty\("HINGE_SET"/.test(takeoff), "control: the reader sees the entries the takeoff does build");
  assert.ok(!/qty\(\s*"NONE"/.test(takeoff), "the takeoff now asks for role NONE: a NONE catalog row could be billed, so a different-height row held as NONE would no longer sit unused");
  const out = price(runRow({ gates_encoded: GATE_4FT }), SEED.rows);
  const emitted = new Set(out.items.map((i) => i.role));
  assert.ok(emitted.size >= 6, "control: a gated vinyl quote emits several roles, got " + [...emitted].join(","));
  assert.ok(!emitted.has("NONE"));
});
