// a25 -- WHAT A BRAND-NEW COMPANY CAN ACTUALLY DO.
//
// Nine of ten companies in the live database have no catalog rows. Before a
// public release the question is what a stranger who signs up on Tuesday can
// produce: a priced quote, or a screen that says nothing and a total that is
// wrong. docs/ONBOARDING_REALITY.md is the map; this file is the evidence for
// it, so each line of the map can be re-checked instead of believed.
//
// THREE KINDS OF TEST, and the name says which:
//
//   (no prefix)        a fact that holds today and should keep holding.
//   "GAP (pinned)"     a defect that EXISTS TODAY, asserted as it is. It passes
//                      because the defect is present, and it will fail the day
//                      somebody fixes it -- at which point the fix is real and
//                      the map (and this test) should be updated. A pin is a
//                      measurement, not an endorsement.
//   "SHOULD" (todo)    the same defect stated as the behaviour that is wanted.
//                      node:test's `todo` flag keeps them out of the exit code
//                      while they fail; they print as "not ok ... # TODO" and
//                      flip to "ok" by themselves when the code is fixed. None
//                      of them presumes HOW it is fixed, only what must be true.
//
// EVERY PROBE HAS A CONTROL, because "nothing came back" reads the same as
// "nothing is wrong" (this project has produced a false "verified" that way):
//   - the extractors are shown to find what they should (harness tests),
//   - a check that the code does NOT do X first proves the same reader finds X
//     where X is known to exist,
//   - a pinned defect is paired with the same harness run on a corrected copy,
//     which must come out right, so a pin cannot pass because the harness is dead,
//   - every live probe is paired with a query that must return a known row.
//
// THE ENGINE IS THE REAL ONE. Node 24 imports the TypeScript pricing modules
// that price-job runs (supabase/functions/_shared/pricing), so "what does an
// empty catalog quote" is answered by the engine, not by reading it.
//
// THE OFFICE PAGE IS RUN, NOT GREPPED. Functions are lifted whole out of
// website/dashboard.html and called with stubs for the DOM and the database,
// asserting on what comes back (the same idiom as tests/catalog-run-viewer).
//
// LIVE HALF (A25_ONBOARD_LIVE=1) reads the production catalogue and data
// through the Supabase CLI's own link. It never writes: every statement is a
// SELECT except one probe that inserts two synthetic companies named
// PROBE-A25-ONBOARD-* inside a transaction it ROLLS BACK, and the file asks the
// database afterwards whether any survived. No service_role key is named or
// read. No auth account is created. The real third-party companies (Horizon
// fence llc, PeterLLC, Legacy) are only ever SELECTed, are never written to or
// impersonated, and no email address or phone number is selected, printed or
// asserted on.
//
//   node --test tests/a25-new-company-onboarding.test.mjs              STATIC (no network)
//   A25_ONBOARD_LIVE=1 node --test tests/a25-new-company-onboarding.test.mjs   + LIVE (~1 min)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildCommitPlan, buildPricingInput } from "../supabase/functions/_shared/pricing/load.ts";
import { PRICING_ENGINE_VERSION, priceJob } from "../supabase/functions/_shared/pricing/index.ts";

const PROJECT = "newcrgafcptspmapacrx";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIVE = process.env.A25_ONBOARD_LIVE === "1";
const SKIP_LIVE = LIVE ? false : "set A25_ONBOARD_LIVE=1 to run against the production catalogue (read-only)";
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// ============================================================ extractors ====

/** Index of the bracket that closes the one at openIdx. Naive on purpose: the same
 *  idiom tests/catalog-run-viewer.test.mjs uses on this very file. */
function matchClose(text, openIdx) {
  const open = text[openIdx];
  const close = { "(": ")", "[": "]", "{": "}" }[open];
  assert.ok(close, `matchClose: not a bracket at ${openIdx}: ${JSON.stringify(open)}`);
  let depth = 0;
  for (let j = openIdx; j < text.length; j++) {
    const c = text[j];
    if (c === open) depth++;
    else if (c === close) { depth--; if (!depth) return j; }
  }
  throw new Error("unbalanced bracket starting at " + openIdx);
}

/** `[async ]function name(...) { ... }`, whole, from a JS/HTML source. */
function grabFn(src, name) {
  const at = src.indexOf("function " + name + "(");
  assert.ok(at >= 0, "function not found: " + name);
  const isAsync = src.slice(Math.max(0, at - 6), at) === "async ";
  const paramsOpen = src.indexOf("(", at);
  const bodyOpen = src.indexOf("{", matchClose(src, paramsOpen));
  return (isAsync ? "async " : "") + src.slice(at, matchClose(src, bodyOpen) + 1);
}

/** `const NAME = [...]` / `{...}` (whole statement), from a JS/HTML source. */
function grabConst(src, name) {
  const m = new RegExp("\\bconst " + name + "\\s*=\\s*").exec(src);
  assert.ok(m, "const not found: " + name);
  const i = m.index + m[0].length;
  return src.slice(m.index, matchClose(src, i) + 1) + ";";
}

/** Kotlin with comments removed, so prose cannot satisfy a check about code. */
const stripKt = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === "build") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** The name of the `fun` a character offset sits inside. */
function enclosingFun(src, idx) {
  let name = null;
  for (const m of src.slice(0, idx).matchAll(/\bfun\s+(?:<[^>]*>\s*)?(?:\w+\.)?(\w+)\s*\(/g)) name = m[1];
  return name;
}

const androidString = (name) => {
  const m = read("app/src/main/res/values/strings.xml").match(new RegExp('<string name="' + name + '"[^>]*>([\\s\\S]*?)</string>'));
  assert.ok(m, "no such phone string: " + name);
  return m[1].replace(/\\'/g, "'");
};

// ================================================= the office page, lifted ===
const DASH = read("website/dashboard.html");

const office = new Function("tr", `
  let catalog = [], items = [];
  ${grabConst(DASH, "CATALOG_SEED")}
  ${["isSeededUnverifiedPrice", "catalogExpectedRoles", "catalogMissingRoles", "catalogItemPayload",
     "unverifiedPricesOn", "starterTierRows"].map((n) => grabFn(DASH, n)).join("\n")}
  return { CATALOG_SEED, isSeededUnverifiedPrice, catalogExpectedRoles, catalogMissingRoles,
           catalogItemPayload, unverifiedPricesOn, starterTierRows,
           load(c, i) { catalog = c; items = i; } };
`)((k) => k);

const OFFICE_EN = (() => {
  const start = DASH.indexOf("const TL = {");
  assert.ok(start >= 0, "const TL not found");
  const open = DASH.indexOf("{", start);
  return new Function("return (" + DASH.slice(open, matchClose(DASH, open) + 1) + ");")().en;
})();

const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

/** Runs the office wizard's REAL "Next" on step 1 (wizSaveWho) against a stub page and
 *  a stub database, and returns the row it tried to insert. `dom` maps element ids to
 *  the value the field holds; `settings` is company_settings. */
async function runWizSaveWho(fnSource, dom, settings = {}) {
  let inserted = null;
  const build = new Function("$", "db", "companySetting", "profile", "wiz", "msg", "tr", "jobs", "num",
    fnSource + "\nreturn wizSaveWho;");
  const fields = { wz_customer_name: "A. Homeowner", ...dom };
  const db = {
    from: () => ({
      insert: (row) => {
        inserted = row;
        return { select: () => ({ maybeSingle: async () => ({ data: { ...row, id: 1 }, error: null }) }) };
      },
    }),
  };
  const fn = build((id) => ({ value: fields[id] ?? "" }), db, async (k, fb) => (settings[k] ?? fb),
    { company_id: "c-1" }, { job: null, revisit: false }, () => {}, (k) => k, [], num);
  const ok = await fn();
  return { ok, row: inserted };
}

// ================================================ the real pricing engine ===
const JOB_SYNC = "a2500000-0000-4000-8000-000000000001";
const RUN_SYNC = "a2500000-0000-4000-8000-000000000002";
const jobRow = (o = {}) => ({
  sync_id: JOB_SYNC, updated_at: "2026-09-29T12:00:00Z", calibration_pixels_per_foot: null,
  tax_rate_percent: 7, markup_percent: 0, discount_percent: 0, labor_rate_per_ft: 8, labor_flat_fee: 0,
  minimum_job_charge: 200, minimum_labor_charge: 0, waste_percent: 0, gate_rate_per_ft: 20, trash_haul_fee: 0,
  teardown_enabled: false, teardown_flat_fee: 0, teardown_rate_per_ft: 0, teardown_feet: 0,
  preferred_manufacturer_sync_id: null, survey_storage_path: null, ...o,
});
const runRow = (fenceType, o = {}) => ({
  sync_id: RUN_SYNC, label: "Back", fence_type: fenceType, color_or_finish: "", points_encoded: "",
  gates_encoded: "", closed_loop: false, manual_linear_feet: 100, manual_corner_count: 0, panel_width_ft: 6,
  panel_height_ft: 6, post_spacing_ft: 6, concrete_bags_per_post: 1, aluminum_style: "RACKABLE",
  wood_style: "PRIVACY", wood_rail_count: 3, picket_width_in: 5.5, picket_gap_in: 0, fabric_height_ft: 4,
  include_top_rail: true, include_tension_wire: false, include_barbed_wire_arms: false,
  include_privacy_slats: false, split_rail_count: 2, suppressed_roles: "", is_teardown: false, sort_order: 0, ...o,
});
const GATE_4FT = "500.0:0.0:4.0:LINE:IN";
/** The office's starting list, as the material_items rows price-job would read. */
const seedRows = () => office.CATALOG_SEED.map((r, i) => ({
  sync_id: "a2500000-0000-4000-8000-" + String(100 + i).padStart(12, "0"), name: r.name, category: r.category,
  role: r.role, fence_type: r.fence_type, color_or_finish: r.color_or_finish, unit: r.unit, unit_price: r.unit_price,
  taxable: r.taxable, covers_ft: r.covers_ft, manufacturer_sync_id: null, is_active: true,
}));
const price = (job, runs, catalog) => priceJob(buildPricingInput({
  job, runs, catalog, manufacturers: [], changeOrders: [], existingItems: [], engineVersion: PRICING_ENGINE_VERSION,
}));
const roles = (out) => [...new Set(out.unmatched_roles.map((u) => u.role))].sort();
const FENCE_TYPES = ["VINYL", "WOOD", "CHAIN_LINK", "ALUMINUM", "ORNAMENTAL_IRON", "SPLIT_RAIL", "COMPOSITE"];

// ---------------------------------------------------------------- Kotlin ----
const SEED_KT_PATH = "app/src/main/java/com/fenceestimator/app/data/SeedData.kt";
const seedKt = read(SEED_KT_PATH);
const seedKtCode = stripKt(seedKt);
/** Rows of SeedData.materialItems(), read off the item(...) calls. */
const kotlinSeed = seedKt.slice(seedKt.indexOf("object SeedData")).split("\n")
  .filter((l) => /^\s+item\(MaterialCategory\./.test(l)).map((l) => {
    const name = l.match(/"((?:[^"\\]|\\.)*)"/)[1].replace(/\\"/g, '"');
    const n = (k) => { const m = l.match(new RegExp(k + " = ([0-9.]+)")); return m ? Number(m[1]) : undefined; };
    return { name, unit: (l.match(/unit = "([A-Z]+)"/) || [])[1] || "EA", unit_price: n("unitPrice"), taxable: !/taxable = false/.test(l) };
  });

// ============================================================== 0. HARNESS ==

test("harness: the real engine reproduces the parity gate's own empty-catalog fixture", (t) => {
  const fx = JSON.parse(read("fixtures/pricing/catalog-empty.json"));
  assert.equal(fx.input.engine_version, PRICING_ENGINE_VERSION,
    "the fixture and the engine disagree on version -- regenerate the fixtures before trusting anything below");
  const out = priceJob(fx.input);
  assert.equal(out.items.length, 0);
  assert.equal(out.totals.grand_total, fx.expected.totals.grand_total);
  assert.equal(out.unmatched_roles.length, fx.expected.unmatched_roles.length);
  assert.ok(out.totals.grand_total > 0, "the pinned contract is that an empty catalog still prices labour");
  t.diagnostic(`engine ${PRICING_ENGINE_VERSION}. The parity gate itself pins this as intended: "${fx.note}"`);
});

test("harness: the office page's functions are lifted whole and its list is what the phone ships", () => {
  for (const n of ["wizSaveWho", "wizStepSendHtml", "renderQuoteBlock", "unverifiedPricesOn", "catalogItemPayload"]) {
    assert.match(grabFn(DASH, n), /^(async )?function /, n);
  }
  assert.ok(grabFn(DASH, "wizSaveWho").startsWith("async function wizSaveWho"), "wizSaveWho is async and must stay so");
  assert.ok(office.CATALOG_SEED.length >= 90, "the office starting list has " + office.CATALOG_SEED.length + " rows");
  assert.equal(kotlinSeed.length, office.CATALOG_SEED.length, "the phone's list and the office's list differ in size");
  assert.ok(OFFICE_EN.setupStepCatalogDetail && OFFICE_EN.catEmptyMsg, "the office's English strings did not load");
});

// ============================================== 1. NOTHING SEEDS A NEW COMPANY ==

test("phone: automatic seeding of the catalog and the tiers is switched off (and the reader can see it switched on)", () => {
  const policy = (src, fn) => {
    const m = src.match(new RegExp("fun\\s+" + fn + "\\s*\\([^)]*\\)\\s*:\\s*Boolean\\s*=\\s*([^\\n]+)"));
    return m ? m[1].trim() : null;
  };
  assert.equal(policy(seedKtCode, "shouldAutoSeedMaterialItems"), "false");
  assert.equal(policy(seedKtCode, "shouldAutoSeedPricingTiers"), "false");
  // Teeth: the same reader, on a copy where the policy is switched on, must not say "false".
  const on = seedKtCode.replace(/(shouldAutoSeedMaterialItems[^\n]*=\s*)false/, "$1currentCount == 0");
  assert.notEqual(on, seedKtCode, "the sabotage did not change anything");
  assert.notEqual(policy(on, "shouldAutoSeedMaterialItems"), "false");
});

test("phone: the starting catalog is inserted from exactly two places -- the switched-off start-up seed and the explicit copy", () => {
  const sites = [];
  const filesMentioningSeedData = new Set();
  for (const f of walk(join(ROOT, "app/src/main/java"))) {
    if (!f.endsWith(".kt")) continue;
    const code = stripKt(readFileSync(f, "utf8"));
    if (/\bSeedData\./.test(code)) filesMentioningSeedData.add(relative(ROOT, f).split(sep).join("/"));
    for (const m of code.matchAll(/\bSeedData\.materialItems\(\)/g)) {
      sites.push(relative(ROOT, f).split(sep).join("/") + "::" + enclosingFun(code, m.index));
    }
  }
  assert.deepEqual([...filesMentioningSeedData], ["app/src/main/java/com/fenceestimator/app/data/Repository.kt"],
    "only the repository may touch SeedData -- a new caller needs a decision");
  assert.deepEqual(sites.sort(), [
    "app/src/main/java/com/fenceestimator/app/data/Repository.kt::copyFenceFlowStartingCatalog",
    "app/src/main/java/com/fenceestimator/app/data/Repository.kt::ensureSeedDataPresent",
  ]);
});

test("office: the starting catalog is written only by a click, and material_items is written from four functions", () => {
  // The seed is bound to buttons and called from nowhere else.
  assert.equal((DASH.match(/addEventListener\('click',\s*startFromSeedCatalog\)/g) || []).length, 2, "the catalog tab button and the wizard's supplier step");
  assert.equal((DASH.match(/startFromSeedCatalog\s*\(/g) || []).length, 1, "only the definition may call it by name");
  // And the only writers of material_items, by enclosing function.
  const writers = new Set();
  for (const m of DASH.matchAll(/from\('material_items'\)\s*\.(insert|upsert)\(/g)) {
    const head = DASH.slice(0, m.index);
    const fns = [...head.matchAll(/function\s+(\w+)\s*\(/g)];
    writers.add(fns.length ? fns[fns.length - 1][1] : "?");
  }
  // startFromSeedCatalog: the seed button; wizAddCatalogItem: the wizard's "add it and re-price" form;
  // saveCatItemDialog: the catalog editor; runImport: the price-list import. Each is somebody pressing a button.
  assert.deepEqual([...writers].sort(), ["runImport", "saveCatItemDialog", "startFromSeedCatalog", "wizAddCatalogItem"],
    "material_items is written from: " + [...writers].join(", ") + " -- a new writer needs a decision");
});

// ============================================== 2. WHAT AN EMPTY CATALOG QUOTES ==

test("GAP (pinned): an empty catalog still prices a job -- labour only, every material role unmatched -- and a commit stamps it as the contract total", (t) => {
  const empty = price(jobRow(), [runRow("VINYL")], []);
  assert.equal(empty.items.length, 0, "nothing is priced");
  assert.deepEqual(roles(empty), ["CONCRETE_BAG", "END_POST", "LINE_POST", "PANEL", "POST_CAP"], "the engine says exactly what is missing");
  assert.equal(empty.totals.materials_subtotal, 0);
  assert.equal(empty.totals.tax, 0, "tax is taken on materials, so an empty catalog also collects no tax");
  assert.ok(empty.totals.grand_total > 0, "yet the total is a real, sendable-looking number");
  assert.ok(empty.totals.grand_total >= empty.totals.labor_cost && empty.totals.grand_total < empty.totals.labor_cost + 10.01,
    "and it is labour and nothing else (rounded up to the next ten)");
  // What price-job does with it: nothing in the commit path looks at unmatched_roles.
  const plan = buildCommitPlan({ output: empty, companyId: "c", jobSyncId: JOB_SYNC, pricedRunSyncIds: [RUN_SYNC], existingItems: [], nowIso: "2026-09-29T12:00:00Z" });
  assert.equal(plan.jobPatch.contract_total, empty.totals.grand_total, "commit writes the labour-only figure as contract_total");
  assert.equal(plan.upsertItems.length, 0);
  // Control: the SAME job on the starting list is a complete quote, so the number above is the catalog's absence, not the harness.
  const full = price(jobRow(), [runRow("VINYL")], seedRows());
  assert.deepEqual(roles(full), []);
  assert.ok(full.items.length >= 5 && full.totals.materials_subtotal > 0);
  assert.ok(full.totals.grand_total > empty.totals.grand_total * 2, "the honest number is more than double");
  t.diagnostic(`100 ft vinyl, phone-default rates: empty catalog $${empty.totals.grand_total} (materials $0, tax $0); starting list $${full.totals.grand_total} (materials $${full.totals.materials_subtotal}, tax $${full.totals.tax.toFixed(2)})`);
});

test("GAP (pinned): one catalog row prices a partial quote -- four roles unmatched, a total between nothing and complete (the checklist's catalog step counts rows: see the LIVE checklist test)", (t) => {
  const seed = seedRows();
  const concreteOnly = seed.filter((r) => r.role === "CONCRETE_BAG");
  const onePanel = seed.filter((r) => r.role === "PANEL" && r.fence_type === "VINYL").slice(0, 1);
  const empty = price(jobRow(), [runRow("VINYL")], []);
  const full = price(jobRow(), [runRow("VINYL")], seed);
  for (const [label, cat] of [["one concrete row", concreteOnly], ["one vinyl panel", onePanel]]) {
    assert.equal(cat.length, 1, label);
    const out = price(jobRow(), [runRow("VINYL")], cat);
    assert.equal(out.items.length, 1, label + " prices one line");
    assert.equal(roles(out).length, 4, label + " leaves four roles unmatched");
    assert.ok(out.totals.grand_total > empty.totals.grand_total && out.totals.grand_total < full.totals.grand_total, label + " is a quote between nothing and complete");
    t.diagnostic(`${label}: $${out.totals.grand_total} against $${full.totals.grand_total} for the complete list`);
    // The office's own catalog check knows -- but the setup checklist does not ask it (see the LIVE test on my_setup_progress).
    assert.ok(office.catalogMissingRoles(cat, "VINYL").length >= 4, "Check my catalog lists what is missing");
  }
});

test("GAP (pinned): a job born with the database's own defaults -- a website lead, an import -- has no labour rate at all", () => {
  const lead = read("supabase/functions/lead-intake/index.ts");
  const at = lead.indexOf('.from("jobs").insert(');
  assert.ok(at >= 0, "the lead-intake insert was not found");
  const open = lead.indexOf("{", at);
  const literal = lead.slice(open, matchClose(lead, open) + 1);
  assert.match(literal, /company_id/, "control: the reader captured the insert");
  assert.match(literal, /referral_source/, "control: the reader captured the insert");
  for (const k of ["labor_rate_per_ft", "tax_rate_percent", "markup_percent", "minimum_job_charge", "gate_rate_per_ft"]) {
    assert.ok(!literal.includes(k), `lead-intake sets ${k}`);
  }
  const zeroRates = jobRow({ tax_rate_percent: 0, markup_percent: 0, labor_rate_per_ft: 0, minimum_job_charge: 0, minimum_labor_charge: 0, gate_rate_per_ft: 0 });
  assert.equal(price(zeroRates, [runRow("VINYL")], []).totals.grand_total, 0, "no catalog and no rates: $0");
  const withList = price(zeroRates, [runRow("VINYL")], seedRows());
  assert.equal(withList.totals.labor_cost, 0, "labour is priced at nothing");
  assert.ok(withList.totals.grand_total > 0, "and the total is materials alone");
});

// RE-AIMED 2 Oct 2026. This pinned a GAP: on the six non-vinyl types a gated quote left BRACE,
// HANDLE and STIFFENER unmatched, because all three were seeded for VINYL only. The gap was
// CLOSED on purpose on 1 Oct (change E, pinned in full by a60-gate-hardware-by-fence-type), in
// two opposite directions:
//   * the TAKEOFF stopped asking for a BRACE or a STIFFENER outside vinyl -- a chain-link gate is
//     a welded tube frame, aluminium and iron arrive as welded factory panels, and wood, split
//     rail and composite are built on the steel-reinforced GATE_FRAME_KIT the takeoff already
//     asks for, so a brace on top of it would bill that member twice
//     (takeoff.ts BRACED_GATE_TYPES / STIFFENED_GATE_TYPES, EstimateEngine.kt's copies);
//   * the HANDLE was re-filed VINYL -> UNIVERSAL in the seed, because a 7" stainless gate handle
//     is the same product whatever the fence is made of.
// So the pinned expectation is now [] for every type, and this test is no longer a gap.
//
// IT IS LEFT RED, with ["HANDLE"] on the six non-vinyl types, and that is a REGRESSION and not
// this change: these two tests price the OFFICE copy of the starting list (seedRows() reads
// office.CATALOG_SEED), and website/dashboard.html was the one copy of three that did not get the
// handle re-filed. SeedData.kt and supabase_r20_seed_new_company_catalog.sql both say UNIVERSAL.
// Do not put HANDLE back into these expectations; fix dashboard.html.
test("the starting list prices a complete 100 ft run for all seven fence types, gate included, with nothing unmatched", () => {
  const seed = seedRows();
  for (const ft of FENCE_TYPES) {
    assert.deepEqual(roles(price(jobRow(), [runRow(ft)], seed)), [], ft + " with no gate");
  }
  assert.deepEqual(roles(price(jobRow(), [runRow("VINYL", { gates_encoded: GATE_4FT })], seed)), [], "vinyl with a gate");
  for (const ft of FENCE_TYPES.filter((f) => f !== "VINYL")) {
    assert.deepEqual(roles(price(jobRow(), [runRow(ft, { gates_encoded: GATE_4FT })], seed)), [], ft + " with a 4 ft gate");
  }
  // CONTROL: the reader is not blind to an unmatched role. Take the concrete out and it says so.
  assert.deepEqual(roles(price(jobRow(), [runRow("WOOD", { gates_encoded: GATE_4FT })], seed.filter((r) => r.role !== "CONCRETE_BAG"))),
    ["CONCRETE_BAG"], "control: an unmatched role is reported");
});

test("the office's Check my catalog and the engine agree that the starting list covers every fence type", () => {
  // WAS a pinned GAP: catalogMissingRoles said "every role is covered" for WOOD while the engine
  // left THREE roles unmatched -- the check does not know a role can be stocked for vinyl only.
  // Change E closed the engine's half, so the two should now agree at zero. See the note above
  // for why the engine's half is 1 and not 0 today: the office seed's handle is still VINYL.
  const seed = office.CATALOG_SEED;
  const wood = price(jobRow(), [runRow("WOOD", { gates_encoded: GATE_4FT })], seedRows());
  assert.deepEqual(office.catalogMissingRoles(seed, "WOOD"), [], "the check says a role is missing");
  assert.equal(roles(wood).length, 0, "the engine leaves roles unmatched that the check calls covered: " + roles(wood));
  // Control: the check is not blind -- with the concrete row removed it says so.
  assert.deepEqual(office.catalogMissingRoles(seed.filter((r) => r.role !== "CONCRETE_BAG"), "WOOD"), ["CONCRETE_BAG"]);
});

// ============================================== 3. THE STARTING LIST ITSELF ==

// LEFT RED ON PURPOSE, 2 Oct 2026. Nothing here is a stale expectation: the two lists really do
// differ, on five rows, and this test is the one that says so. website/dashboard.html's
// CATALOG_SEED is behind SeedData.kt (and behind supabase_r20_seed_new_company_catalog.sql, which
// agrees with the phone) on two deliberate changes:
//   * the 7" SS gate handle is UNIVERSAL on the phone and still VINYL in the office copy;
//   * the four A1 rows are taxable on the phone and still taxable:false in the office copy.
// a60-gate-hardware-by-fence-type's failure message gives the handle edit word for word.
test("the phone's starting list and the office's copy are the same rows, price for price", () => {
  const key = (r) => [r.name, r.unit, r.unit_price, r.taxable].join("|");
  assert.deepEqual(kotlinSeed.map(key).sort(), office.CATALOG_SEED.map(key).sort());
});

// RE-AIMED 2 Oct 2026. This pinned a GAP: four rows of the starting list shipped untaxed -- the
// three 6'x6' vinyl privacy panels and the 6'x5' PVC gate -- the same four-of-ninety-two defect
// that had been corrected in the owner's LIVE rows on 25 September while the thing generating
// them was left alone. It was fixed in the seed on 1 Oct (commit 87639fc, "Fix the tax bug in the
// STARTING catalog, not just in the live rows"), so `want` is now the empty list and the test
// asserts the fix instead of the bug. a31-seed-panels-are-taxable is the shape-level guard.
//
// It is LEFT RED on its second line: the office copy still carries all four untaxed. Same
// regression as the test above -- one of three copies did not get the change.
test("no row of the starting list ships untaxed -- the four rows the A1 correction fixed are fixed at the source", (t) => {
  const untaxed = (rows) => rows.filter((r) => r.taxable === false).map((r) => r.name).sort();
  const A1 = [
    "Panel T&G Vinyl Privacy 6'H x 6'W - Gray", "Panel T&G Vinyl Privacy 6'H x 6'W - Tan",
    "Panel T&G Vinyl Privacy 6'H x 6'W - White", "Regular PVC Gate 6'H x 5'W, White",
  ].sort();
  assert.deepEqual(untaxed(kotlinSeed), [], "the phone's copy");
  assert.deepEqual(untaxed(office.CATALOG_SEED), [], "the office's copy still ships these untaxed: " + untaxed(office.CATALOG_SEED));
  // CONTROL: the reader does find those four rows, so "[]" above cannot mean it found nothing.
  for (const n of A1) assert.ok(kotlinSeed.some((r) => r.name === n), "control: the A1 row " + n + " is not in the phone's list at all");
  // THE CONSEQUENCE, measured: with the list taxed as shipped, marking every row taxable must now
  // change nothing. Before the fix this was a $50+ shortfall on 100 ft of vinyl.
  const as = price(jobRow(), [runRow("VINYL")], seedRows()).totals;
  const fixed = price(jobRow(), [runRow("VINYL")], seedRows().map((r) => ({ ...r, taxable: true }))).totals;
  assert.equal(Math.round(fixed.tax * 100), Math.round(as.tax * 100), "tax is still short by " + (fixed.tax - as.tax).toFixed(2) + " on 100 ft of vinyl");
  // CONTROL: that comparison can see a shortfall -- untax the panels again and it reappears.
  const broken = price(jobRow(), [runRow("VINYL")], seedRows().map((r) => (A1.includes(r.name) ? { ...r, taxable: false } : r))).totals;
  assert.ok(fixed.tax > broken.tax + 50, "control: untaxing the A1 rows no longer shows up in the tax at all");
  t.diagnostic(`tax on 100 ft vinyl: $${as.tax.toFixed(2)} as shipped, $${fixed.tax.toFixed(2)} fully taxed, $${broken.tax.toFixed(2)} with the A1 rows untaxed again`);
});

test("no category/role in the PHONE's starting list mixes taxed and untaxed rows -- nothing in it is untaxed at all", () => {
  // Promoted from a todo on 2 Oct 2026: the phone's half is fixed, and a todo that has started
  // passing reports as a pass and would never tell anyone it had been fixed. The office's half is
  // still a todo below, because dashboard.html still carries the four untaxed rows.
  assert.deepEqual(kotlinSeed.filter((r) => r.taxable === false).map((r) => r.name), []);
  assert.ok(kotlinSeed.length >= 90, "control: the phone's list was read (" + kotlinSeed.length + " rows)");
});

test("SHOULD (todo): no category/role in the OFFICE's starting list mixes taxed and untaxed rows", { todo: "website/dashboard.html's CATALOG_SEED still ships the three 6x6 vinyl panels and the PVC gate untaxed, while the 8 ft panel and every other gate beside them are taxed. SeedData.kt and the r20 SQL were both corrected on 1 Oct (87639fc); this copy was not. Fixing it makes this a real assertion." }, () => {
  const groups = new Map();
  for (const r of office.CATALOG_SEED) {
    const k = r.category + "/" + r.role;
    if (!groups.has(k)) groups.set(k, new Set());
    groups.get(k).add(r.taxable);
  }
  const mixed = [...groups].filter(([, s]) => s.size > 1).map(([k]) => k);
  assert.deepEqual(mixed, []);
});

test("GAP (pinned): the phone's starter tiers carry the founder's rates and discounts; the office's are blank", () => {
  const body = seedKtCode.slice(seedKtCode.indexOf("fun pricingTiers()"));
  const phone = [...body.slice(0, body.indexOf("private fun item(")).matchAll(/PricingTier\(([^)]*)\)/g)].map((m) => {
    const a = m[1];
    const n = (k) => { const x = a.match(new RegExp(k + " = ([0-9.]+)")); return x ? Number(x[1]) : 0; };
    return { name: a.match(/name = "([^"]+)"/)[1], labor: n("laborRatePerFt"), markup: n("markupPercent"), discount: n("discountPercent") };
  });
  assert.equal(phone.length, 5);
  assert.ok(phone.every((p) => p.labor > 0 && p.markup > 0), "every phone tier is priced");
  assert.ok(phone.some((p) => p.discount > 0), "and three of them carry a discount");
  const web = office.starterTierRows();
  assert.equal(web.length, 5);
  assert.ok(web.every((r) => r.labor_rate_per_ft === 0 && r.markup_percent === 0 && r.discount_percent === 0), "the office's are names only");
  assert.notDeepEqual(phone.map((p) => p.name).sort(), web.map((r) => r.name).sort(), "and they are not even the same five names");
});

// ============================================== 4. CONFIRMING A STARTING PRICE ==

const SEEDED_LABEL = "Starting price — verify with your supplier";
const jobWithSeededLines = () => {
  const out = price(jobRow(), [runRow("VINYL")], seedRows());
  const catalog = seedRows().map((r) => ({ ...r, source_doc: SEEDED_LABEL }));
  const items = out.items.map((i) => ({ job_sync_id: JOB_SYNC, description: i.description, auto_generated: i.auto_generated !== false }));
  return { catalog, items, job: { sync_id: JOB_SYNC } };
};

/** PostgREST's upsert names only the columns present in the payload in ON CONFLICT DO UPDATE. */
const upsertMerge = (existing, payload) => ({ ...existing, ...payload });

test("harness: a payload that carried source_doc would clear the flag, and a clean catalog is not blocked", () => {
  const { catalog, items, job } = jobWithSeededLines();
  office.load(catalog, items);
  assert.ok(office.unverifiedPricesOn(job).length >= 5, "control: the seeded lines are flagged");
  const confirmed = catalog.map((r) => ({ ...r, source_doc: "Confirmed" }));
  office.load(confirmed, items);
  assert.deepEqual(office.unverifiedPricesOn(job), [], "control: confirmed rows are not");
  const existing = catalog[0];
  const payload = office.catalogItemPayload(existing, { name: existing.name, fence_type: existing.fence_type, category: existing.category, role: existing.role,
    color_or_finish: "", unit: existing.unit, unit_price: 99, covers_ft: null, taxable: true, is_active: true, manufacturer_sync_id: "" }, "x");
  assert.equal(office.isSeededUnverifiedPrice(upsertMerge(existing, { ...payload, source_doc: "Confirmed" }).source_doc), false, "sabotage: with source_doc in the payload the flag clears");
});

test("GAP (pinned): the office catalog editor cannot mark a starting price as checked, so its send gate can never be satisfied there", () => {
  const { catalog, items, job } = jobWithSeededLines();
  const existing = catalog.find((r) => r.role === "PANEL");
  const payload = office.catalogItemPayload(existing, { name: existing.name, fence_type: existing.fence_type, category: existing.category, role: existing.role,
    color_or_finish: "", unit: existing.unit, unit_price: 61.5, covers_ft: existing.covers_ft, taxable: true, is_active: true, manufacturer_sync_id: "" }, "x");
  assert.ok(!("source_doc" in payload), "the editor's payload has no source_doc");
  assert.equal(payload.unit_price, 61.5, "control: the edit itself is in the payload");
  const edited = catalog.map((r) => (r.sync_id === existing.sync_id ? upsertMerge(r, payload) : r));
  assert.equal(edited.find((r) => r.sync_id === existing.sync_id).unit_price, 61.5);
  assert.equal(office.isSeededUnverifiedPrice(edited.find((r) => r.sync_id === existing.sync_id).source_doc), true, "the edited row is still flagged");
  office.load(edited, items);
  assert.ok(office.unverifiedPricesOn(job).length >= 5, "and the job is still blocked on it");
});

test("SHOULD (todo): editing a starting-price row in the office editor clears its unverified flag", { todo: "there is no way to confirm a price on the web; only the phone's Confirm box (source_doc = Confirmed) does" }, () => {
  const existing = { ...office.CATALOG_SEED.find((r) => r.role === "PANEL"), sync_id: "s" };
  const payload = office.catalogItemPayload(existing, { name: existing.name, fence_type: existing.fence_type, category: existing.category, role: existing.role,
    color_or_finish: "", unit: existing.unit, unit_price: 61.5, covers_ft: existing.covers_ft, taxable: true, is_active: true, manufacturer_sync_id: "" }, "x");
  assert.equal(office.isSeededUnverifiedPrice(upsertMerge(existing, payload).source_doc), false);
});

test("GAP (pinned): a price imported on the phone, and a price imported on the web, are both treated as checked by the office's send gate", () => {
  const kt = Object.fromEntries([...seedKtCode.matchAll(/const val (\w+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
  assert.ok(kt.SEEDED && kt.PLACEHOLDER && kt.IMPORTED_UNVERIFIED, "control: the phone's three labels were read");
  assert.match(seedKtCode, /fun isPlaceholderPrice\([^)]*\)[^=]*=\s*[^\n]*IMPORTED_UNVERIFIED/, "the phone flags its own imports");
  assert.equal(office.isSeededUnverifiedPrice(kt.SEEDED), true, "control: the office flags the shipped label");
  assert.equal(office.isSeededUnverifiedPrice(kt.IMPORTED_UNVERIFIED), false, "but not the phone's import label");
  const webImport = (DASH.match(/source_doc:'(Imported[^']*)'/) || [])[1];
  assert.ok(webImport, "control: the office's import label was read");
  assert.equal(office.isSeededUnverifiedPrice(webImport), false, "nor its own");
  assert.ok(![kt.SEEDED, kt.PLACEHOLDER, kt.IMPORTED_UNVERIFIED].includes(webImport), "and the phone does not know it either");
});

test("GAP (pinned): the New client wizard's send step applies no unverified-price gate; the job sheet's quote block does", () => {
  const { catalog, items, job } = jobWithSeededLines();
  office.load(catalog, items);
  assert.ok(office.unverifiedPricesOn(job).length >= 5, "control: this job would be blocked at the job sheet");
  assert.match(grabFn(DASH, "renderQuoteBlock"), /unverifiedPricesOn\(/, "control: the job sheet's quote block asks");
  const wizStep = new Function("wiz", "zeroQuoteBlockedOn", "runs", "esc", "tr", "quoteLinkFor", "d", "WIZ_STEP_NAMES",
    grabFn(DASH, "wizStepSendHtml") + "\nreturn wizStepSendHtml;")(
    { job: { ...job, quote_sent_at: null } }, () => false, [], (s) => String(s), (k) => k, () => "https://example.invalid/q", (v) => new Date(v),
    ["a", "b", "c", "d", "e", "f"]);
  const html = wizStep();
  const disabled = (id) => new RegExp('id="' + id + '"[^>]*\\bdisabled\\b').test(html);
  for (const id of ["wz_q_copy", "wz_q_open", "wz_q_sent"]) assert.ok(html.includes('id="' + id + '"'), "control: " + id + " is rendered");
  for (const id of ["wz_q_copy", "wz_q_open", "wz_q_sent"]) assert.equal(disabled(id), false, id + " is enabled with unchecked prices on the quote");
  // Teeth: the same renderer with the zero-quote gate ON does disable them, so the check can see a disabled button.
  const gated = new Function("wiz", "zeroQuoteBlockedOn", "runs", "esc", "tr", "quoteLinkFor", "d", "WIZ_STEP_NAMES",
    grabFn(DASH, "wizStepSendHtml") + "\nreturn wizStepSendHtml;")(
    { job: { ...job, quote_sent_at: null } }, () => true, [], (s) => String(s), (k) => k, () => "https://example.invalid/q", (v) => new Date(v),
    ["a", "b", "c", "d", "e", "f"])();
  assert.ok(new RegExp('id="wz_q_copy"[^>]*\\bdisabled\\b').test(gated), "control: a gated step disables Copy link");
});

// ============================================== 5. THE FOUNDER'S NUMBERS ==

const WIZ_SRC = grabFn(DASH, "wizSaveWho");
const WIZ_FIXED = WIZ_SRC
  .replace("num($('s_tax').value)||7", "num($('s_tax').value)")
  .replace("num($('s_markup').value)||15", "num($('s_markup').value)");
const chose = (o) => ({ s_tax: "", s_markup: "", s_labor: "", s_min: "", s_min_labor: "", ...o });

test("harness: with the fallbacks removed, a company's zero survives the wizard (so the pin below can tell)", async () => {
  assert.notEqual(WIZ_FIXED, WIZ_SRC, "the corrected copy is not different");
  const r = await runWizSaveWho(WIZ_FIXED, chose({ s_tax: "0", s_markup: "0", s_labor: "9", s_min: "250" }));
  assert.equal(r.row.tax_rate_percent, 0);
  assert.equal(r.row.markup_percent, 0);
  assert.equal(r.row.labor_rate_per_ft, 9);
});

test("GAP (pinned): the office wizard replaces a company's zero tax and zero markup with 7 and 15, and a blank company gets the founder's five numbers", async (t) => {
  const zero = await runWizSaveWho(WIZ_SRC, chose({ s_tax: "0", s_markup: "0", s_labor: "9", s_min: "250" }));
  assert.equal(zero.row.tax_rate_percent, 7, "a company that decided on no tax is given 7%");
  assert.equal(zero.row.markup_percent, 15, "and one that decided on no markup is given 15%");
  assert.equal(zero.row.labor_rate_per_ft, 9, "control: a real number passes straight through");
  assert.equal(zero.row.minimum_job_charge, 250, "control: so does the minimum charge");
  const real = await runWizSaveWho(WIZ_SRC, chose({ s_tax: "6.5", s_markup: "22", s_labor: "9", s_min: "250" }));
  assert.deepEqual([real.row.tax_rate_percent, real.row.markup_percent], [6.5, 22], "control: 6.5 and 22 survive");
  const blank = await runWizSaveWho(WIZ_SRC, chose({}));
  assert.deepEqual(
    [blank.row.tax_rate_percent, blank.row.markup_percent, blank.row.labor_rate_per_ft, blank.row.minimum_job_charge, blank.row.gate_rate_per_ft],
    [7, 15, 8, 200, 20], "a company with nothing set is quoted at 7 / 15 / 8 / 200 / 20");
  t.diagnostic("blank company -> tax 7, markup 15, labour $8/ft, minimum $200, gate $20/ft");
});

test("SHOULD (todo): a company that set tax 0 and markup 0 gets a job at tax 0 and markup 0", { todo: "wizSaveWho uses num(x)||7 and num(x)||15, so zero reads as unset" }, async () => {
  const r = await runWizSaveWho(WIZ_SRC, chose({ s_tax: "0", s_markup: "0", s_labor: "9", s_min: "250" }));
  assert.deepEqual([r.row.tax_rate_percent, r.row.markup_percent], [0, 0]);
});

test("GAP (pinned): the customer/job import applies the same fallback to every imported job", () => {
  const iPrice = DASH.indexOf("if(kind==='pricelist'){");
  assert.ok(iPrice >= 0, "control: the import handler was found");
  const iBase = DASH.indexOf("const base={", iPrice);
  assert.ok(iBase > iPrice);
  const open = DASH.indexOf("{", iBase);
  const literal = DASH.slice(open, matchClose(DASH, open) + 1);
  const at = (vals) => new Function("$", "num", "profile", "return (" + literal + ");")((id) => ({ value: vals[id] ?? "" }), num, { company_id: "c" });
  const zero = at({ s_tax: "0", s_markup: "0", s_labor: "9", s_min: "250" });
  assert.equal(zero.tax_rate_percent, 7);
  assert.equal(zero.markup_percent, 15);
  assert.equal(zero.labor_rate_per_ft, 9, "control: real numbers pass");
  assert.equal(zero.referral_source, "Imported", "control: this is the import's row");
});

test("GAP (pinned): the phone's defaults are literals -- 7% tax, 0 markup, $8/ft, $200 minimum, $20 gate -- and a new job takes them with no setup step", () => {
  const settings = stripKt(read("app/src/main/java/com/fenceestimator/app/data/SettingsStore.kt"));
  const cls = settings.slice(settings.indexOf("data class BusinessProfile("));
  const params = cls.slice(0, matchClose(cls, cls.indexOf("(")));
  const dflt = (name) => Number((params.match(new RegExp("val " + name + ":\\s*Double\\s*=\\s*([0-9.]+)")) || [])[1]);
  assert.deepEqual([dflt("defaultTaxRatePercent"), dflt("defaultMarkupPercent"), dflt("defaultLaborRatePerFt"), dflt("defaultMinimumJobCharge")], [7, 0, 8, 200]);
  const entities = stripKt(read("app/src/main/java/com/fenceestimator/app/data/Entities.kt"));
  const job = entities.slice(entities.indexOf("data class Job("));
  assert.match(job.slice(0, matchClose(job, job.indexOf("("))), /val gateRatePerFt:\s*Double\s*=\s*20\.0/);
  const vm = stripKt(read("app/src/main/java/com/fenceestimator/app/ui/jobs/JobsViewModel.kt"));
  const at = vm.indexOf("fun createJob(");
  const create = vm.slice(at, matchClose(vm, vm.indexOf("{", vm.indexOf(")", at))) + 1);
  assert.match(create, /taxRatePercent\s*=\s*defaults\.defaultTaxRatePercent/, "control: this is the function that builds the job from those defaults");
  assert.match(create, /laborRatePerFt\s*=\s*defaults\.defaultLaborRatePerFt/);
  assert.ok(!/setup|essential|companySetting|catalogCount|observeCatalog/i.test(create), "createJob asks nothing about setup or the catalog");
});

test("GAP (pinned): gate_rate has no field on the Settings tab or the phone -- only the setup wizard does (the checklist makes it essential: see the LIVE checklist test)", () => {
  const SET = new Function(grabConst(DASH, "SET") + "; return SET;")();
  assert.ok(SET.s_tax && SET.s_labor && SET.s_min, "control: the Settings tab's map holds the other essentials");
  assert.ok(!Object.values(SET).includes("gate_rate"), "the Settings tab writes no gate_rate");
  const sync = stripKt(read("app/src/main/java/com/fenceestimator/app/cloud/SettingsSync.kt"));
  const cloud = sync.slice(sync.indexOf("data class CloudSettings("));
  const fields = cloud.slice(0, matchClose(cloud, cloud.indexOf("(")));
  assert.match(fields, /@SerialName\("labor_rate"\)/, "control: the phone syncs labour rate");
  assert.ok(!/gate_rate/.test(fields), "the phone syncs no gate_rate");
  assert.match(grabFn(DASH, "swRatesHtml"), /id="sw_gate_rate"/, "control: the setup wizard's Rates step has it");
  assert.match(grabFn(DASH, "swSaveRates"), /gate_rate:/, "and saves it");
});

// ============================================== 6. BEING TOLD ==

test("GAP (pinned): the phone tells a new owner the catalog and rates 'came pre-filled', with automatic seeding off", () => {
  const body = androidString("jobs_make_prices_yours_body");
  assert.match(body, /pre-filled/);
  assert.match(seedKtCode, /fun shouldAutoSeedMaterialItems\([^)]*\)\s*:\s*Boolean\s*=\s*false/, "the catalog arrives empty");
  // The two buttons on the same card: "They're right" clears it for good and pushes the profile.
  assert.ok(androidString("jobs_prices_right").length > 0);
});

test("SHOULD (todo): nothing shown to a new owner says the catalog came pre-filled while automatic seeding is off", { todo: "jobs_make_prices_yours_body still says so" }, () => {
  assert.doesNotMatch(androidString("jobs_make_prices_yours_body"), /pre-filled|came pre/i);
});

test("the phone's first-run tour and its empty-catalog message never name the copy button; only the Catalog screen's empty card does", () => {
  const card = androidString("cat_empty_body");
  assert.match(card, /starting list/i, "control: the empty card names it");
  for (let i = 1; i <= 5; i++) {
    assert.doesNotMatch(androidString(`onb_step${i}_body`), /starting list|catalog is empty|empty/i, `tour step ${i}`);
  }
  assert.doesNotMatch(androidString("evm_catalog_empty"), /starting list|copy/i, "the message shown when Suggest quantities finds no catalog");
  assert.doesNotMatch(androidString("jobs_make_prices_yours_body"), /starting list|copy|empty/i, "the Home banner that leads to the Catalog");
});

test("the office tells a new owner where to add prices in the phone app; the button is named on the Catalog tab and in the welcome email, not on the checklist", () => {
  assert.match(OFFICE_EN.setupStepCatalogDetail, /phone app/i);
  assert.doesNotMatch(OFFICE_EN.setupStepCatalogDetail, /Start from FenceFlow/i);
  assert.match(OFFICE_EN.catEmptyMsg, /%s/, "control: the Catalog tab's empty message names a button");
  assert.match(OFFICE_EN.catStartSeedBtn, /Start from FenceFlow/i);
  assert.match(read("supabase/functions/_shared/welcome-email.ts"), /Start from FenceFlow/, "control: the welcome email names it");
});

test("GAP (pinned): the public site never links to a way to get the phone app, though the last screen of sign-up says to install it", () => {
  const pages = readdirSync(join(ROOT, "website")).filter((f) => f.endsWith(".html"));
  assert.ok(pages.includes("index.html") && pages.includes("welcome.html") && pages.includes("dashboard.html"));
  const hrefs = pages.flatMap((p) => [...read("website/" + p).matchAll(/\bhref\s*=\s*["']([^"']+)["']/g)].map((m) => [p, m[1]]));
  assert.ok(hrefs.some(([p, h]) => p === "index.html" && /dashboard\.html#signup/.test(h)), "control: the reader finds the sign-up call to action");
  const store = hrefs.filter(([, h]) => /\.apk\b|play\.google\.com|apps\.apple\.com|market:\/\/|apk-proxy/i.test(h));
  assert.deepEqual(store, [], "no page links to an install source");
  assert.match(read("website/welcome.html"), /Install the FenceFlow app on your phone/, "control: the instruction is there");
});

// =========================================================== LIVE (read-only) ==

function runSql(sql, label) {
  const dir = mkdtempSync(join(tmpdir(), "a25-onboard-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  let last = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query", "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
      { encoding: "utf8", shell: process.platform === "win32", timeout: 240_000 });
    const out = r.stdout || "";
    if (r.status === 0 && out.trim()) {
      const parsed = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
      return Array.isArray(parsed) ? parsed : (parsed.rows || []);
    }
    last = `status ${r.status}: ${(r.stderr || out).slice(0, 400)}`;
    // The CLI's login is flaky ("password authentication failed", SQLSTATE 28P01). A real SQL
    // error is not: it is thrown at once, and a failed call is NEVER read as an empty answer.
    if (!/28P01|failed to connect|timeout|EOF|reset|ECONN|ETIMEDOUT/i.test(last)) break;
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{},3000)"]);
  }
  throw new Error(`${label}: supabase db query failed -- ${last}`);
}
const asMap = (rows, k, v) => Object.fromEntries(rows.map((r) => [r[k], r[v]]));

test("LIVE control: the catalogue reader finds a function and a trigger that are known to exist", { skip: SKIP_LIVE }, () => {
  const rows = runSql(`
    select 'fn_current_company_id' as k, count(*)::int as n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
     where ns.nspname='public' and p.proname='current_company_id'
    union all select 'trigger_companies_audit', count(*)::int from pg_trigger t join pg_class c on c.oid=t.tgrelid
     where c.relname='companies' and t.tgname='companies_audit' and not t.tgisinternal
    union all select 'companies', count(*)::int from public.companies;`, "control");
  const m = asMap(rows, "k", "n");
  assert.ok(m.fn_current_company_id >= 1 && m.trigger_companies_audit >= 1 && m.companies >= 1, JSON.stringify(m));
});

test("LIVE: nothing in the database creates or seeds anything when somebody signs up", { skip: SKIP_LIVE }, () => {
  const rows = runSql(`
    select 'auth_users_triggers' as k, count(*)::int as n
      from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace ns on ns.oid=c.relnamespace
     where ns.nspname='auth' and c.relname='users' and not t.tgisinternal
    union all select 'control_companies_triggers', count(*)::int
      from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace ns on ns.oid=c.relnamespace
     where ns.nspname='public' and c.relname='companies' and not t.tgisinternal
    union all select 'fns_inserting_material_items', count(*)::int from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
     where ns.nspname='public' and p.prokind='f' and pg_get_functiondef(p.oid) ~* 'insert[[:space:]]+into[[:space:]]+(public[.])?material_items'
    union all select 'fns_inserting_pricing_tiers', count(*)::int from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
     where ns.nspname='public' and p.prokind='f' and pg_get_functiondef(p.oid) ~* 'insert[[:space:]]+into[[:space:]]+(public[.])?pricing_tiers'
    union all select 'control_fns_inserting_company_settings', count(*)::int from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
     where ns.nspname='public' and p.prokind='f' and pg_get_functiondef(p.oid) ~* 'insert[[:space:]]+into[[:space:]]+(public[.])?company_settings'
    union all select 'control_fns_inserting_companies', count(*)::int from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
     where ns.nspname='public' and p.prokind='f' and pg_get_functiondef(p.oid) ~* 'insert[[:space:]]+into[[:space:]]+(public[.])?companies';`, "no seeding");
  const m = asMap(rows, "k", "n");
  assert.ok(m.control_companies_triggers >= 1, "control: triggers on companies are visible, so zero on auth.users means zero");
  assert.ok(m.control_fns_inserting_company_settings >= 1 && m.control_fns_inserting_companies >= 1, "control: the body search finds inserts that exist");
  assert.equal(m.auth_users_triggers, 0, "no trigger on auth.users");
  assert.equal(m.fns_inserting_material_items, 0, "no function seeds a catalog");
  assert.equal(m.fns_inserting_pricing_tiers, 0, "no function seeds tiers");
});

test("LIVE: the five ways a company or its owner comes to exist write only companies, profiles and setup codes", { skip: SKIP_LIVE }, () => {
  const rows = runSql(`
    select p.proname as fn, array_agg(distinct lower(regexp_replace(m[1], '^public[.]', ''))
           order by lower(regexp_replace(m[1], '^public[.]', ''))) as inserts
      from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace,
           lateral regexp_matches(pg_get_functiondef(p.oid), 'insert[[:space:]]+into[[:space:]]+([a-zA-Z_.]+)', 'gi') as m
     where ns.nspname='public' and p.prokind='f'
       and p.proname in ('create_company_with_owner','claim_company_setup','claim_invited_company','admin_create_company','join_company')
     group by p.proname order by 1;`, "creation writes");
  const m = Object.fromEntries(rows.map((r) => [r.fn, r.inserts]));
  assert.deepEqual(Object.keys(m).sort(), ["admin_create_company", "claim_company_setup", "claim_invited_company", "create_company_with_owner", "join_company"]);
  assert.deepEqual(m.create_company_with_owner, ["companies", "profiles"], "website and phone self-signup");
  assert.deepEqual(m.admin_create_company, ["companies", "company_setup_codes"], "staff-created");
  for (const f of ["claim_company_setup", "claim_invited_company", "join_company"]) assert.deepEqual(m[f], ["profiles"], f);
});

test("LIVE: a company row holding only a name is not allowed to use the product until a plan exists (rolled-back probe)", { skip: SKIP_LIVE }, () => {
  const rows = runSql(`
    begin;
    create temp table a25_probe(label text, allowed boolean, status text, plan text, trial timestamptz, suspended boolean);
    insert into public.companies (id, name) values ('a2500000-0000-4000-8000-0000000000f1', 'PROBE-A25-ONBOARD-FRESH');
    insert into public.companies (id, name, subscription_status, trial_ends_at)
      values ('a2500000-0000-4000-8000-0000000000f2', 'PROBE-A25-ONBOARD-TRIALING', 'trialing', now() + interval '10 days');
    insert into a25_probe select 'fresh', public.company_allowed(c.id), c.subscription_status, c.subscription_plan, c.trial_ends_at, c.suspended
      from public.companies c where c.id = 'a2500000-0000-4000-8000-0000000000f1';
    insert into a25_probe select 'control_trialing', public.company_allowed(c.id), c.subscription_status, c.subscription_plan, c.trial_ends_at, c.suspended
      from public.companies c where c.id = 'a2500000-0000-4000-8000-0000000000f2';
    insert into a25_probe select 'control_paid', public.company_allowed(c.id), c.subscription_status, c.subscription_plan, c.trial_ends_at, c.suspended
      from public.companies c where c.name = 'Fence solutions';
    select * from a25_probe order by label;
    rollback;`, "fresh company");
  const by = Object.fromEntries(rows.map((r) => [r.label, r]));
  assert.equal(by.control_trialing?.allowed, true, "control: a synthetic company on a live trial is allowed");
  assert.equal(by.control_paid?.allowed, true, "control: an existing paid company is allowed");
  assert.deepEqual([by.fresh?.status, by.fresh?.plan, by.fresh?.trial, by.fresh?.suspended], ["pending", "", null, false], "what a signup starts as");
  assert.equal(by.fresh?.allowed, false, "and it is not allowed");
  const left = runSql(`select count(*)::int as leftovers from public.companies where name like 'PROBE-A25-ONBOARD-%';`, "leftovers");
  assert.equal(left[0].leftovers, 0, "nothing of the probe survived");
});

test("LIVE: the not-suspended policies are restrictive on every table a first quote touches, and they ask company_allowed", { skip: SKIP_LIVE }, () => {
  const pol = runSql(`select tablename, permissive, cmd, qual from pg_policies where schemaname='public' and policyname like '%not_suspended' order by tablename;`, "policies");
  const tables = pol.map((p) => p.tablename);
  for (const t of ["jobs", "material_items", "company_settings", "pricing_tiers", "fence_runs", "estimate_line_items"]) assert.ok(tables.includes(t), t);
  assert.ok(pol.every((p) => p.permissive === "RESTRICTIVE" && p.cmd === "ALL" && /company_is_suspended\(\)/.test(p.qual)));
  const fn = runSql(`select pg_get_functiondef('public.company_is_suspended'::regproc) as def;`, "company_is_suspended")[0].def;
  assert.match(fn, /company_allowed/);
  assert.match(fn, /coalesce\([\s\S]*true\)/, "and it fails OPEN when there is no company to judge");
});

test("LIVE: the setup checklist has six essential steps, and 'catalog' is satisfied by a bare row count", { skip: SKIP_LIVE }, (t) => {
  const def = runSql(`select pg_get_functiondef('public.my_setup_progress'::regproc) as def;`, "my_setup_progress")[0].def;
  const block = def.slice(def.indexOf("from (values")).replace(/^\s*--.*$/gm, "");
  const steps = [...block.matchAll(/^\s{2}\('([a-z_]+)',[\s\S]*?,\s*(true|false),\s*'([a-z]+)'\)/gm)].map((m) => ({ step: m[1], essential: m[2] === "true", where: m[3] }));
  assert.equal(steps.length, 13, "control: all thirteen steps parsed -- " + steps.map((s) => s.step).join(","));
  assert.deepEqual(steps.filter((s) => s.essential).map((s) => s.step).sort(), ["catalog", "gate_rate", "labour_rate", "markup", "min_charge", "tax_rate"]);
  assert.match(def, /\(select catalog from counts\)\s*>\s*0\)\s+as catalog_ok/, "catalog is done when count(*) > 0 -- one row, active or not, priced or not");
  assert.ok(!/role/i.test(def.slice(def.indexOf("counts as"), def.indexOf("essentials as"))), "the counts do not look at roles");
  assert.equal(steps.find((s) => s.step === "gate_rate").where, "settings", "gate_rate sends the owner to the Settings tab");
  assert.match(def, /add items in the phone app under Catalog/, "and the catalog step's own words point at the phone");
  t.diagnostic("essential: " + steps.filter((s) => s.essential).map((s) => s.step).join(", "));
});

test("LIVE: the database's own defaults -- company, job pricing columns -- are the blanks the map says", { skip: SKIP_LIVE }, () => {
  const rows = runSql(`select table_name as t, column_name as c, column_default as d from information_schema.columns
    where table_schema='public' and ((table_name='jobs' and column_name in ('tax_rate_percent','markup_percent','labor_rate_per_ft','minimum_job_charge','gate_rate_per_ft','status'))
      or (table_name='companies' and column_name in ('subscription_status','subscription_plan','trial_ends_at','suspended','name')));`, "defaults");
  const d = Object.fromEntries(rows.map((r) => [r.t + "." + r.c, r.d]));
  assert.equal(d["jobs.status"], "'DRAFT'::text", "control: the reader sees defaults");
  for (const c of ["tax_rate_percent", "markup_percent", "labor_rate_per_ft", "minimum_job_charge", "gate_rate_per_ft"]) assert.equal(d["jobs." + c], "0", "jobs." + c);
  assert.equal(d["companies.subscription_status"], "'pending'::text");
  assert.equal(d["companies.subscription_plan"], "''::text");
  assert.equal(d["companies.trial_ends_at"], null);
  assert.equal(d["companies.suspended"], "false");
});

test("LIVE: no trigger on material_items rewrites source_doc, so only a payload that names it can change a price's checked-ness", { skip: SKIP_LIVE }, () => {
  const rows = runSql(`select p.proname as fn, (pg_get_functiondef(p.oid) ilike '%source_doc%') as mentions_source_doc, (pg_get_functiondef(p.oid) ilike '%updated_at%') as mentions_updated_at
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace ns on ns.oid=c.relnamespace join pg_proc p on p.oid=t.tgfoid
    where not t.tgisinternal and ns.nspname='public' and c.relname='material_items';`, "material_items triggers");
  assert.ok(rows.length >= 3, "control: the triggers are visible");
  assert.equal(rows.find((r) => r.fn === "touch_updated_at")?.mentions_updated_at, true, "control: the text search sees a word that is there");
  assert.deepEqual(rows.filter((r) => r.mentions_source_doc), []);
});

test("LIVE REPORT: the companies, and the three real signups that have produced nothing (printed, not asserted)", { skip: SKIP_LIVE }, (t) => {
  const rows = runSql(`
    select c.name, c.subscription_status as status, c.subscription_plan as plan, public.company_allowed(c.id) as allowed,
           (c.stripe_subscription_id is not null) as has_sub, c.trial_ends_at::date as trial_end,
           (select count(*) from public.company_settings s where s.company_id=c.id)::int as settings_rows,
           (select count(*) from public.material_items m where m.company_id=c.id and m.deleted_at is null)::int as catalog,
           (select count(*) from public.pricing_tiers x where x.company_id=c.id and x.deleted_at is null)::int as tiers,
           (select count(*) from public.jobs j where j.company_id=c.id and j.deleted_at is null)::int as jobs,
           (select count(*) from public.profiles p where p.company_id=c.id)::int as logins,
           c.created_at::timestamp(0) as created, c.details_completed_at::timestamp(0) as details_done,
           c.agreement_signed_at::timestamp(0) as agreement_signed, c.welcome_sent_at::timestamp(0) as welcome_sent
      from public.companies c order by c.created_at;`, "census");
  assert.ok(rows.length >= 1, "control: rows came back");
  assert.ok(Math.max(...rows.map((r) => r.catalog)) > 0, "control: the catalog count can be non-zero, so a zero means zero");
  const empty = rows.filter((r) => r.catalog === 0).length;
  t.diagnostic(`${rows.length} companies, ${empty} with no catalog rows, ${rows.filter((r) => r.settings_rows === 0).length} with no company_settings row`);
  for (const r of rows) {
    t.diagnostic(`${String(r.name).slice(0, 34).padEnd(34)} ${String(r.status).padEnd(8)} ${String(r.plan || "-").padEnd(5)} allowed=${r.allowed} sub=${r.has_sub} settings=${r.settings_rows} catalog=${r.catalog} jobs=${r.jobs} logins=${r.logins} created=${r.created}`);
  }
  const stuck = rows.filter((r) => r.status === "trialing" && r.has_sub && r.trial_end && new Date(r.trial_end) < new Date());
  t.diagnostic("trialing with a subscription id and a trial end in the past: " + (stuck.map((r) => r.name).join("; ") || "none"));
  const real = rows.filter((r) => ["Legacy", "Horizon fence llc", "PeterLLC"].includes(r.name));
  for (const r of real) {
    t.diagnostic(`${r.name}: created ${r.created}, details ${r.details_done ?? "-"}, agreement ${r.agreement_signed ?? "-"}, trial end ${r.trial_end ?? "-"}, welcome email ${r.welcome_sent ?? "-"}`);
  }
});
