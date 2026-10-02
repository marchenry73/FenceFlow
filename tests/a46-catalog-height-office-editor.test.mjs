// a46-catalog-height-office-editor -- the office catalog page can set a panel's height, and its list shows
// supplier and price together.
//
// WHY THIS EXISTS. Both pricing engines now choose between PANEL (or GATE_PANEL) rows of one width by the
// row's height_ft, and only where a row actually declares one. On the owner's real catalog the 32 supplier rows
// declared none, a 4 ft white vinyl run was priced with a 6 ft privacy panel, and the fix needed a hand-written
// SQL file because neither the phone nor the office had a field for it. The worst outcome of adding one is a
// box that saves and never reaches the engine, so this file calls the page's own functions the way the page
// calls them and reads back what would be sent.
//
//   1. THE HEIGHT BOX: where it shows, what it refuses (a typed 0 is not a blank), what it sends, and what it
//      deliberately does NOT send (a box nobody touched, so a save about a price cannot put a stale height back).
//   2. THE LIST: supplier and price beside each other and beside the name, the exact figure (54.99875 is not
//      $55.00), the height with a flag where a panel row does not say, one deterministic order.
//   3. CREW NEVER SEE MONEY: rows shaped like the crew door (no unit_price) render no dollar figure at all.
//   4. TEETH: each guard is run against a mutant of the page's own code and must fail it.
//
//   node --test tests/a46-catalog-height-office-editor.test.mjs        (no network, no writes)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Line endings normalised: a checkout with core.autocrlf turns every file CRLF, and these checks match across line breaks.
const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const SRC = read("website/dashboard.html");

// ============================================================== lifting the page's code ==
function grabFn(src, name) {
  const re = new RegExp("(^|\\n)(async )?function " + name + "\\(");
  const m = re.exec(src);
  if (!m) throw new Error("function not found: " + name);
  const start = m.index + m[1].length;
  const open = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error("unbalanced: " + name);
}
/** A one-line `const name = ...;` */
function grabLine(src, name) {
  const at = src.indexOf("\nconst " + name + " = ");
  if (at < 0) throw new Error("const not found: " + name);
  return src.slice(at + 1, src.indexOf("\n", at + 1));
}
/** A top-level `const NAME = [...]` balanced on its opening bracket. */
function grabConst(src, name) {
  const marker = "const " + name + " = ";
  const start = src.indexOf(marker);
  if (start < 0) throw new Error("const not found: " + name);
  const open = src[start + marker.length], close = { "[": "]", "{": "}" }[open];
  let depth = 0;
  for (let j = start + marker.length; j < src.length; j++) {
    if (src[j] === open) depth++;
    else if (src[j] === close) { depth--; if (!depth) return src.slice(start, j + 1) + ";"; }
  }
  throw new Error("unbalanced const: " + name);
}

// The page's own translation table, read in English (and the other two for the key checks).
const tlStart = SRC.indexOf("const TL = {");
let tlDepth = 0, tlEnd = -1;
for (let i = SRC.indexOf("{", tlStart); i < SRC.length; i++) {
  if (SRC[i] === "{") tlDepth++;
  else if (SRC[i] === "}") { tlDepth--; if (tlDepth === 0) { tlEnd = i + 1; break; } }
}
const TL = eval("(" + SRC.slice(SRC.indexOf("{", tlStart), tlEnd) + ")");
const tr = (k, ...a) => {
  if (!(k in TL.en)) throw new Error("tr(): no such key in the English table: " + k);
  let s = TL.en[k];
  for (const v of a) s = s.replace("%s", v);
  return s;
};

const FUNCS = [
  "catalogItemPayload", "catalogHeightApplies", "catalogReadHeight", "catMoney", "catalogSortRows", "catalogFilterItems",
  "catalogHasHeight", "catalogHasSupplierPrice", "catalogHasSupplierSku", "manufacturerName",
  "catItemRowHtml", "catSectionHtml", "catFenceTypeLabel", "wizFenceTypeLabel", "isSeededUnverifiedPrice", "bizPretty",
  "syncCatHeightField", "openCatItemDialog", "saveCatItemDialog",
];
const PAGE_CODE = [
  grabConst(SRC, "MATERIAL_CATEGORIES"), grabLine(SRC, "esc"), grabLine(SRC, "money"), grabLine(SRC, "num"),
  ...FUNCS.map((n) => grabFn(SRC, n)),
].join("\n\n");

/** The page's code, optionally with a mutation applied to its text, wrapped so its free variables are ours. */
function build(mutate = (s) => s) {
  const code = mutate(PAGE_CODE);
  return new Function("env", `
    const { $, tr, db, msg, canEdit, profile, refreshCatalog, crypto } = env;
    let catalog = [], manufacturers = [], openCatItem = null, catHeightLoaded = '';
    ${code}
    return { setData(c, m) { catalog = c; manufacturers = m; },
      catalogItemPayload, catalogHeightApplies, catalogReadHeight, catMoney, catalogSortRows, catalogFilterItems,
      catalogHasHeight, manufacturerName, catItemRowHtml, catSectionHtml, syncCatHeightField, openCatItemDialog, saveCatItemDialog };
  `);
}

/** Fake page elements: a value that stringifies like a real input's, the dialog's classList, and a number box's validity. */
function makeEnv() {
  const els = {}, upserts = [], msgs = [];
  const mkEl = () => {
    const el = { _v: "", checked: false, style: {}, className: "", textContent: "", innerHTML: "", validity: { badInput: false },
      classList: { on: false, add(c) { if (c === "on") this.on = true; }, remove(c) { if (c === "on") this.on = false; }, contains(c) { return c === "on" && this.on; } } };
    Object.defineProperty(el, "value", { get() { return this._v; }, set(x) { this._v = x == null ? "" : String(x); } });
    return el;
  };
  return {
    els, upserts, msgs,
    env: {
      $: (id) => (els[id] ||= mkEl()), tr, canEdit: () => true, profile: { company_id: "co-1" },
      refreshCatalog: async () => {}, crypto: { randomUUID: () => "new-uuid" },
      db: { from: (t) => ({ upsert: async (row, opts) => { upserts.push({ table: t, row, opts }); return { error: null }; } }) },
      msg: (el, text, kind) => msgs.push({ el, text, kind }),
    },
  };
}

// ============================================================================== fixtures ==
// Invented names and the shape of the real catalog: white 6x6 vinyl panels at 52.35, 54.15 and 54.99875 from no
// supplier, supplier A and supplier B, a fourth at 53.00 from supplier C (so that price order and supplier-name order
// DIFFER, and a sort by price can be told from a sort by supplier), and a 4 ft panel from each of A and B.
const SUP_A = "sup-a", SUP_B = "sup-b", SUP_C = "sup-c";
const MANUFACTURERS = [{ sync_id: SUP_A, name: "Supplier A" }, { sync_id: SUP_B, name: "Supplier B" }, { sync_id: SUP_C, name: "Supplier C" }];
const row = (o) => ({
  company_id: "co-1", sync_id: "s-" + o.name, name: "x", category: "PANEL", role: "PANEL", fence_type: "VINYL",
  color_or_finish: "White", unit: "EA", unit_price: 50, taxable: true, is_active: true, source_doc: "",
  covers_ft: 6, height_ft: null, manufacturer_sync_id: null, supplier_sku: null, ...o,
});
const CATALOG = [
  row({ name: "Seed 6x6 White", unit_price: 52.35, height_ft: 6, source_doc: "Starting price" }),
  row({ name: "A 6x6 White", unit_price: 54.15, height_ft: 6, manufacturer_sync_id: SUP_A }),
  row({ name: "B 6x6 White", unit_price: 54.99875, height_ft: 6, manufacturer_sync_id: SUP_B }),
  row({ name: "C 6x6 White", unit_price: 53, height_ft: 6, manufacturer_sync_id: SUP_C }),
  row({ name: "Seed 6x6 Tan", unit_price: 54.5, height_ft: 6, color_or_finish: "Tan" }),
  row({ name: "Seed 6x6 Gray", unit_price: 54.5, height_ft: 6, color_or_finish: "Gray" }),
  row({ name: "A 4x6 White", unit_price: 61.74, height_ft: 4, manufacturer_sync_id: SUP_A }),
  row({ name: "B 4x6 White", unit_price: 71.5, height_ft: 4, manufacturer_sync_id: SUP_B }),
  row({ name: "Seed 6x8 White", unit_price: 71.4, height_ft: 6, covers_ft: 8 }),
  row({ name: "Seed no-height panel", unit_price: 60, height_ft: null, covers_ft: 10 }),
  row({ name: "Seed gate no-height", role: "GATE_PANEL", category: "GATE", unit_price: 145.05, covers_ft: 5, height_ft: null }),
  row({ name: "Line post", role: "LINE_POST", category: "POST", unit_price: 19, covers_ft: null, height_ft: null }),
  row({ name: "Post with a stray height", role: "LINE_POST", category: "POST", unit_price: 18.99929, covers_ft: null, height_ft: 7 }),
];
const byName = (n) => CATALOG.find((c) => c.name === n);

function fresh(mutate) {
  const E = makeEnv();
  const H = build(mutate)(E.env);
  H.setData(CATALOG, MANUFACTURERS);
  return { H, E };
}
/** Open the dialog on `existing` (null = new), apply `edits` (element id -> value) and press Save. Returns what was upserted. */
async function editAndSave({ H, E }, existing, edits = {}, { badInput = false, forcedType = "VINYL" } = {}) {
  H.openCatItemDialog(existing, forcedType);
  for (const [id, v] of Object.entries(edits)) E.els[id].value = v;
  if (badInput) E.els.ci_height.validity.badInput = true;
  await H.saveCatItemDialog();
  return E.upserts;
}

// ================================================================== 1. THE HEIGHT BOX ==
const checkMarkup = () => {
  assert.equal([...SRC.matchAll(/id="ci_height"/g)].length, 1, "ci_height must exist exactly once");
  assert.equal([...SRC.matchAll(/id="ci_height_wrap"/g)].length, 1, "ci_height_wrap must exist exactly once");
  assert.match(SRC, /<div id="ci_height_wrap" class="wiz-row2" style="display:none">/, "the wrapper starts hidden");
  assert.match(SRC, /<input id="ci_height" type="number" step="0.5" min="0"/, "the box is a number box");
  assert.match(SRC, /\$\('ci_role'\)\.addEventListener\('change', syncCatHeightField\)/, "changing the role re-evaluates the box");
};
test("the markup: one height box, hidden until a role that has a height is picked, and the role change is wired", checkMarkup);

const checkTranslations = () => {
  for (const key of ["ciLabelHeight", "ciHeightHelp", "ciHeightBadMsg", "catColHeightFt", "catHeightNotSetTitle"]) {
    for (const lang of ["en", "es", "fr"]) assert.ok(TL[lang][key] && TL[lang][key].length > 3, `${lang}.${key} is missing`);
    // Not a copy of the English: the page falls back to English silently, so a copy reads as finished work.
    assert.notEqual(TL.es[key], TL.en[key], `es.${key} is the English`);
    assert.notEqual(TL.fr[key], TL.en[key], `fr.${key} is the English`);
  }
  // The search box now matches a supplier's name, and says so in all three languages.
  for (const lang of ["en", "es", "fr"]) assert.ok(/supplier|proveedor|fournisseur/i.test(TL[lang].catFilterPh), `${lang}.catFilterPh does not mention the supplier`);
  // No bare apostrophe can have broken the string: the table evaluated, and these read back intact.
  assert.match(TL.fr.ciHeightHelp, /s’en servent/);
};
test("all five new strings exist in English, Spanish and French, and the filter placeholder names the supplier", checkTranslations);

const ROLE_OPTIONS = [...SRC.slice(SRC.indexOf('<select id="ci_role">'), SRC.indexOf("</select>", SRC.indexOf('<select id="ci_role">')))
  .matchAll(/<option value="([A-Z_]+)"/g)].map((m) => m[1]);
const checkRoles = (mk = () => fresh()) => {
  const { H } = mk();
  assert.ok(ROLE_OPTIONS.length >= 25 && ROLE_OPTIONS.includes("PANEL") && ROLE_OPTIONS.includes("CHAIN_FABRIC"), "control: the whole role dropdown was read, " + ROLE_OPTIONS.length);
  const applies = ROLE_OPTIONS.filter((r) => H.catalogHeightApplies(r)).sort();
  // The set the ENGINES read a height on, read out of their own source: a role added to one and
  // not the other, or to the box and not the engines, fails here.
  //
  // RE-AIMED 2 Oct 2026. These two controls matched a literal two-role condition. Engine
  // 2026.10.2/.3/.4/.5 deliberately widened the height rule to the POST roles as well -- a 6 ft
  // fence had been given a 4 ft post -- so it now reads PANEL, GATE_PANEL, LINE_POST, END_POST,
  // CORNER_POST, GATE_POST and BLANK_POST. The controls now read WHATEVER roles each engine
  // names and require the two engines to agree, which is the thing that mattered.
  //
  // THE EDITOR WAS NOT WIDENED WITH THEM, and that is a GAP, pinned here rather than papered
  // over: the engines choose a post row by height, but nobody can TYPE a height on a post row
  // from this page. A post row added here lands with height_ft null, and the rule drops a
  // null-height row whenever a same-width sibling declares the run's height -- so a new, cheaper
  // post can be silently passed over. The phone editor has the same gap (CatalogFields.kt
  // sizeFieldsFor); a46-catalog-height-phone-editor pins it there.
  const heightRoles = (src, re) => {
    const m = re.exec(src);
    return m ? [...m[1].matchAll(/\b([A-Z][A-Z_]+)\b/g)].map((x) => x[1]).sort() : null;
  };
  const ts = heightRoles(read("supabase/functions/_shared/pricing/line-items.ts"),
    /if \(\s*((?:entry\.role === "[A-Z_]+"\s*(?:\|\|\s*)?)+)\)\s*\{\s*const current = candidates;/);
  assert.ok(ts && ts.length >= 2, "control: the TypeScript engine's height step was not found");
  const kt = heightRoles(read("app/src/main/java/com/fenceestimator/app/estimate/EstimateEngine.kt"),
    /if \(\s*((?:entry\.role == MaterialRole\.[A-Z_]+\s*(?:\|\|\s*)?)+)\)\s*\{\s*val current = candidates/);
  assert.ok(kt && kt.length >= 2, "control: the Kotlin engine's height step was not found");
  assert.deepEqual(kt, ts, "the two engines read a height on DIFFERENT roles -- the phone and the office would price a post differently");
  assert.deepEqual(ts, ["BLANK_POST", "CORNER_POST", "END_POST", "GATE_PANEL", "GATE_POST", "LINE_POST", "PANEL"],
    "the set of roles the engines read a height on has changed -- decide whether the height box should follow before touching this list");
  // The box itself: still the two panel roles, and a strict subset of what the engines read.
  assert.deepEqual(applies, ["GATE_PANEL", "PANEL"]);
  assert.deepEqual(ts.filter((r) => !applies.includes(r)),
    ["BLANK_POST", "CORNER_POST", "END_POST", "GATE_POST", "LINE_POST"],
    "GAP (pinned): the five post roles the engines height-match but this page offers no height box for");
  assert.deepEqual(applies.filter((r) => !ts.includes(r)), [],
    "the box is offered for a role no engine reads a height on, which would store a number nothing uses");
  assert.equal(H.catalogHeightApplies(undefined), false);
  assert.equal(H.catalogHeightApplies(""), false);
  assert.equal(H.catalogHeightApplies("panel"), false, "role values are compared exactly, as the engines compare them");
};
test("the box applies to exactly the two roles both engines read a height on -- not to the 25 others in the dropdown", () => checkRoles());

const readHeightCases = (H) => {
  const r = H.catalogReadHeight;
  assert.deepEqual(r("", false), { ok: true, value: null }, "blank stays blank");
  assert.deepEqual(r("   ", false), { ok: true, value: null }, "spaces are blank");
  assert.deepEqual(r(undefined, false), { ok: true, value: null });
  assert.deepEqual(r("4", false), { ok: true, value: 4 });
  assert.deepEqual(r("4.5", false), { ok: true, value: 4.5 });
  assert.deepEqual(r(" 6 ", false), { ok: true, value: 6 });
  assert.deepEqual(r(5, false), { ok: true, value: 5 });
  assert.deepEqual(r("0", false), { ok: false }, "a typed 0 is NOT a blank, and it is not a height either");
  assert.deepEqual(r(0, false), { ok: false });
  assert.deepEqual(r("0.0", false), { ok: false });
  assert.deepEqual(r("-4", false), { ok: false });
  assert.deepEqual(r("abc", false), { ok: false });
  assert.deepEqual(r("4 ft", false), { ok: false }, "text is refused, not read as the 4 in front of it");
  assert.deepEqual(r("1e999", false), { ok: false }, "infinity is not a height");
  assert.deepEqual(r("", true), { ok: false }, "a number box holding text reports '' and badInput: that is not a blank");
};
test("catalogReadHeight: blank is null, a number above 0 is itself, and 0, negatives, text and swallowed text are refused", () => readHeightCases(fresh().H));

const payloadCases = (H) => {
  const form = { name: "P", fence_type: "VINYL", category: "PANEL", role: "PANEL", color_or_finish: "", unit: "EA", unit_price: 54.99875,
    covers_ft: 6, taxable: true, is_active: true, manufacturer_sync_id: "" };
  const without = H.catalogItemPayload(null, form, "id");
  assert.equal("height_ft" in without, false, "no height on the form -> the column is not named in the write at all");
  assert.equal(without.unit_price, 54.99875, "control: the price travels at full precision");
  assert.equal("updated_at" in without, false, "the touch trigger owns that clock");
  assert.equal(H.catalogItemPayload(null, { ...form, height_ft: 4 }, "id").height_ft, 4);
  const cleared = H.catalogItemPayload(null, { ...form, height_ft: null }, "id");
  assert.ok("height_ft" in cleared && cleared.height_ft === null, "null IS written: blank means the row does not say");
  assert.equal(H.catalogItemPayload({ sync_id: "keep" }, { ...form, height_ft: 6 }, "id").sync_id, "keep");
};
test("catalogItemPayload: height_ft is named only when the caller set it; null is a value, undefined is not", () => payloadCases(fresh().H));

// -------- the real save path, called the way the page calls it
const saveCases = async (mk) => {
  const panel = byName("A 4x6 White");        // height 4, supplier A, 61.74
  const unset = byName("Seed no-height panel");
  // a. only the price edited: the untouched height box must not be sent, so a height changed elsewhere since the page loaded survives.
  {
    const u = await editAndSave(mk(), panel, { ci_price: "62.5" });
    assert.equal(u.length, 1);
    assert.equal(u[0].row.unit_price, 62.5, "control: the edit itself is in the write");
    assert.equal("height_ft" in u[0].row, false, "an untouched height box is not sent");
  }
  // b. height typed on a row that had none
  {
    const u = await editAndSave(mk(), unset, { ci_height: "6" });
    assert.equal(u[0].row.height_ft, 6);
    assert.equal(u[0].table, "material_items");
    assert.equal(u[0].opts.onConflict, "company_id,sync_id", "the page's one save path, not a second one");
    assert.equal(u[0].row.sync_id, unset.sync_id, "the write targets the row that was opened");
  }
  // c. height cleared to blank on a row that had one -> null, and it is sent
  {
    const u = await editAndSave(mk(), panel, { ci_height: "" });
    assert.ok("height_ft" in u[0].row && u[0].row.height_ft === null, "blank is sent as null");
  }
  // d. a typed 0 is refused: nothing is written, and the person is told why
  {
    const m = mk();
    const u = await editAndSave(m, unset, { ci_height: "0" });
    assert.equal(u.length, 0, "no write happened");
    assert.deepEqual(m.E.msgs.map((x) => [x.el, x.kind]), [["catItemDialogMsg", "err"]]);
    assert.equal(m.E.msgs[0].text, TL.en.ciHeightBadMsg);
    assert.equal(m.E.els.catItemOverlay.classList.on, true, "the dialog stays open");
  }
  // e. text the number box swallowed
  {
    const u = await editAndSave(mk(), unset, {}, { badInput: true });
    assert.equal(u.length, 0, "a box holding text is not an empty box");
  }
  // f. a role the engines read no height on: the box is hidden and a stale value in it is not sent
  {
    const m = mk();
    const post = byName("Post with a stray height");
    const u = await editAndSave(m, post, { ci_height: "9" });
    assert.equal(m.E.els.ci_height_wrap.style.display, "none", "no box on a post");
    assert.equal("height_ft" in u[0].row, false, "and nothing about height is written for it");
  }
  // g. the same row, role switched to PANEL in the dialog -> the box appears and its value is read
  {
    const m = mk();
    const post = byName("Line post");
    m.H.openCatItemDialog(post, "VINYL");
    assert.equal(m.E.els.ci_height_wrap.style.display, "none");
    m.E.els.ci_role.value = "PANEL"; m.H.syncCatHeightField();
    assert.equal(m.E.els.ci_height_wrap.style.display, "", "the box shows once the role is a panel");
    m.E.els.ci_height.value = "4";
    await m.H.saveCatItemDialog();
    assert.equal(m.E.upserts[0].row.height_ft, 4);
    m.E.els.ci_role.value = "GATE_PANEL"; m.H.syncCatHeightField();
    assert.equal(m.E.els.ci_height_wrap.style.display, "", "a gate panel has a height too");
    m.E.els.ci_role.value = "TOP_RAIL"; m.H.syncCatHeightField();
    assert.equal(m.E.els.ci_height_wrap.style.display, "none");
  }
  // h. a brand-new panel: a typed height is sent; a blank one is sent as null (the column's own default)
  {
    const u = await editAndSave(mk(), null, { ci_name: "New panel", ci_role: "PANEL", ci_height: "5" });
    assert.equal(u[0].row.height_ft, 5);
    assert.equal(u[0].row.sync_id, "new-uuid");
    const u2 = await editAndSave(mk(), null, { ci_name: "New panel", ci_role: "PANEL", ci_height: "" });
    assert.ok(u2[0].row.height_ft === null);
  }
  // i. THE PRICE IS NOT ROUNDED ON SAVE. Open a row whose price has five decimals, change nothing, save.
  {
    const b = byName("B 6x6 White");
    const m = mk();
    const u = await editAndSave(m, b, {});
    assert.equal(m.E.els.ci_price.value, "54.99875", "the box shows the exact price");
    assert.strictEqual(u[0].row.unit_price, 54.99875, "an unchanged save writes the exact price back, not 55");
    assert.equal("height_ft" in u[0].row, false, "and nothing else about the row moved");
  }
  // j. the box shows what the row holds, for every row that has a height
  for (const c of CATALOG.filter((x) => x.height_ft != null)) {
    const m = mk();
    m.H.openCatItemDialog(c, c.fence_type);
    assert.equal(m.E.els.ci_height.value, String(c.height_ft), c.name);
  }
  // k. a deployment whose rows have no height_ft column: no box, and no write that names it
  {
    const m = mk();
    const noColumn = CATALOG.map(({ height_ft, ...rest }) => rest);
    m.H.setData(noColumn, MANUFACTURERS);
    const p = noColumn.find((c) => c.name === "A 4x6 White");
    m.H.openCatItemDialog(p, "VINYL");
    assert.equal(m.H.catalogHasHeight(), false);
    assert.equal(m.E.els.ci_height_wrap.style.display, "none", "no column, no box");
    m.E.els.ci_height.value = "4";
    await m.H.saveCatItemDialog();
    assert.equal("height_ft" in m.E.upserts[0].row, false, "a write that named a missing column would be refused as a whole");
  }
  // l. an empty catalog cannot show the column either way
  {
    const m = mk();
    m.H.setData([], MANUFACTURERS);
    assert.equal(m.H.catalogHasHeight(), false);
  }
};
test("the save path, called as the page calls it: what is sent, what is refused, what is deliberately left out", async () => saveCases(() => fresh()));

// =================================================================== 2. THE LIST ==
const cellsOf = (html) => {
  const heads = [...html.matchAll(/<th>([\s\S]*?)<\/th>/g)].map((m) => m[1].trim());
  const rows = [...html.matchAll(/<tr class="(mcat-inactive|)">([\s\S]*?)<\/tr>/g)].map((m) => {
    const cells = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
    return cells;
  });
  return { heads, rows };
};
const sectionFor = (H, items) => H.catSectionHtml({ type: "VINYL", items, missing: [] }, items, true, false);

const listCases = (H) => {
  const html = sectionFor(H, CATALOG);
  const { heads, rows } = cellsOf(html);
  // The columns, with supplier and price straight after the name.
  assert.deepEqual(heads.slice(0, 3), ["Item", "Supplier", "Price"]);
  assert.ok(heads.includes("Height ft") && heads.includes("Covers ft") && heads.includes("Colour"));
  assert.equal(heads.indexOf("Height ft"), heads.indexOf("Covers ft") + 1, "height sits beside width");
  // Every body row has one cell per heading, and the category band spans them all (it spanned one fewer before).
  assert.equal(rows.length, CATALOG.length);
  for (const r of rows) assert.equal(r.length, heads.length, "cells vs headings: " + JSON.stringify(r));
  const spans = [...html.matchAll(/colspan="(\d+)"/g)].map((m) => Number(m[1]));
  assert.ok(spans.length >= 2 && spans.every((s) => s === heads.length), "the band spans every column: " + spans + " vs " + heads.length);

  const at = (r, h) => r[heads.indexOf(h)];
  const rowOf = (name) => rows.find((r) => r[0].startsWith(name));
  // THE OWNER'S CASE: three white 6 ft panels, each with its supplier and its own exact price.
  assert.equal(at(rowOf("Seed 6x6 White"), "Supplier"), "—");
  assert.equal(at(rowOf("Seed 6x6 White"), "Price"), "$52.35");
  assert.equal(at(rowOf("A 6x6 White"), "Supplier"), "Supplier A");
  assert.equal(at(rowOf("A 6x6 White"), "Price"), "$54.15");
  assert.equal(at(rowOf("B 6x6 White"), "Supplier"), "Supplier B");
  assert.equal(at(rowOf("B 6x6 White"), "Price"), "$54.99875", "the supplier's own five-place figure, not $55.00");
  assert.equal(at(rowOf("Post with a stray height"), "Price"), "$18.99929");
  assert.equal(at(rowOf("Line post"), "Price"), "$19.00", "an ordinary price still reads as cents");
  // Height: a number where stated; a flag on a panel or gate that does not say; a dash on a role with none.
  assert.equal(at(rowOf("A 4x6 White"), "Height ft"), "4 ft");
  assert.equal(at(rowOf("Seed 6x6 White"), "Height ft"), "6 ft");
  assert.equal(at(rowOf("Seed no-height panel"), "Height ft"), TL.en.ciNotSetOption, "an unstated panel height is flagged");
  assert.equal(at(rowOf("Seed gate no-height"), "Height ft"), TL.en.ciNotSetOption, "so is an unstated gate height");
  assert.equal(at(rowOf("Line post"), "Height ft"), "—", "a post has no height the engines read");
  assert.match(html, /<span class="mcat-flag" title="No height set\./, "the flag carries its explanation");
  // Width is still there.
  assert.equal(at(rowOf("Seed 6x8 White"), "Covers ft"), "8 ft");
};
test("the list: supplier and price beside the name, the exact price, height beside width, a flag where a panel does not say", () => listCases(fresh().H));

const orderCases = (H) => {
  const names = (items) => cellsOf(sectionFor(H, items)).rows.map((r) => r[0].replace(/ ◆$/, ""));
  const base = names(CATALOG);
  // The white 6x6x6 panels are adjacent and lowest price first, whatever order the database handed them over. The
  // order is the PRICE order (52.35, 53, 54.15, 54.99875), which is not the suppliers' alphabetical order.
  const quartet = ["Seed 6x6 White", "C 6x6 White", "A 6x6 White", "B 6x6 White"];
  const first = base.indexOf(quartet[0]);
  assert.deepEqual(base.slice(first, first + 4), quartet, "adjacent and cheapest first: " + base.join(" | "));
  // Same width and colour, a different height: the 4 ft rows sort before the 6 ft rows, each supplier beside the other.
  assert.deepEqual(base.filter((n) => n.includes("4x6")), ["A 4x6 White", "B 4x6 White"]);
  assert.ok(base.indexOf("B 4x6 White") < base.indexOf("Seed 6x6 Gray") && base.indexOf("A 4x6 White") < base.indexOf("Seed 6x6 Gray"),
    "the 4 ft rows come before the 6 ft rows of the same width");
  // Deterministic: forty different input orders, one output. (The database moves a row to the end every time it is saved.)
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let n = 0; n < 40; n++) {
    const shuffled = CATALOG.map((c) => [rnd(), c]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    assert.deepEqual(names(shuffled), base, "order depended on input order (round " + n + ")");
  }
  // A row with no width or price sorts after rows that have one, and the sort never mutates what it is given.
  const copy = CATALOG.slice();
  H.catalogSortRows(copy, H.manufacturerName);
  assert.deepEqual(copy, CATALOG, "the caller's array is not reordered");
  const two = [row({ name: "no width", covers_ft: null }), row({ name: "has width", covers_ft: 6 })];
  assert.deepEqual(H.catalogSortRows(two).map((c) => c.name), ["has width", "no width"]);
  const noPrice = [row({ name: "a", unit_price: undefined }), row({ name: "b", unit_price: 3 })];
  assert.deepEqual(H.catalogSortRows(noPrice).map((c) => c.name), ["b", "a"]);
};
test("the order: the same product from different suppliers is adjacent, cheapest first, and the same whatever order the rows arrive in", () => orderCases(fresh().H));

const filterCases = (H) => {
  const all = CATALOG;
  const sup = (id) => H.manufacturerName(id);
  assert.deepEqual(H.catalogFilterItems(all, "supplier a", sup).map((c) => c.name), ["A 6x6 White", "A 4x6 White"], "a supplier's name finds what that supplier sells");
  assert.deepEqual(H.catalogFilterItems(all, "SUPPLIER B", sup).map((c) => c.name), ["B 6x6 White", "B 4x6 White"], "case-insensitive");
  assert.deepEqual(H.catalogFilterItems(all, "supplier a").map((c) => c.name), [], "called as before (no resolver) it matches what it always matched");
  assert.ok(H.catalogFilterItems(all, "gate", sup).length === 1, "name, role, category matching is unchanged");
  assert.equal(H.catalogFilterItems(all, "", sup), all, "blank filter returns everything");
  assert.deepEqual(H.catalogFilterItems(all, "zzz", sup), []);
};
test("the search box finds a supplier's rows, and matches exactly what it matched before when called without a resolver", () => filterCases(fresh().H));

const moneyCases = (H) => {
  const m = H.catMoney;
  assert.equal(m(52.35), "$52.35");
  assert.equal(m(54.99875), "$54.99875");
  assert.equal(m(18.99929), "$18.99929");
  assert.equal(m(19), "$19.00");
  assert.equal(m(0), "$0.00", "a real zero price is a zero");
  assert.equal(m(1234.5), "$1,234.50");
  assert.equal(m(0.1 + 0.2), "$0.30", "float dust is not shown");
  assert.equal(m(null), "—");
  assert.equal(m(undefined), "—", "no price is a dash, never $0.00");
  assert.equal(m(""), "—");
  assert.equal(m("abc"), "—");
};
test("catMoney: the figure as stored to as many places as it has, a dash when there is none", () => moneyCases(fresh().H));

// ============================================================== 3. CREW NEVER SEE MONEY ==
const crewCases = (H) => {
  // Rows shaped like material_items_crew: the columns that view has, and no unit_price and no supplier_sku.
  const crewRows = CATALOG.map(({ unit_price, supplier_sku, source_doc, ...rest }) => ({ ...rest }));
  assert.ok(crewRows.every((r) => !("unit_price" in r)), "control: the rows really have no price");
  H.setData(crewRows, MANUFACTURERS);
  const html = sectionFor(H, crewRows);
  assert.equal(html.includes("$"), false, "no dollar figure anywhere in a list built from crew-shaped rows");
  assert.equal(/\bNaN\b|undefined|null/.test(html), false, "and no leaked 'undefined' or 'NaN'");
  const { heads, rows } = cellsOf(html);
  assert.ok(rows.every((r) => r[heads.indexOf("Price")] === "—"), "the price column reads as a dash, not as $0.00");
  // The height is not money and still shows.
  assert.equal(rows.find((r) => r[0].startsWith("A 4x6"))[heads.indexOf("Height ft")], "4 ft");
};
test("crew never see money: a list built from rows without unit_price shows no dollar figure and no $0.00", () => crewCases(fresh().H));

test("crew never see money: the office reads the BASE table (no crew view), and the base table is closed to anyone without SEE_MONEY", () => {
  assert.equal(SRC.includes("material_items_crew"), false, "the office page never reads the crew view, so it cannot show a crew-shaped list as if it were the catalog");
  assert.match(SRC, /q\('material_items'\)/, "control: the catalog is read from material_items");
  const sql = read("supabase_crew_money_lockdown.sql");
  assert.match(sql, /create policy materials_money_hidden_from_crew on material_items\s+as restrictive for select using \(has_permission\('SEE_MONEY'\)\)/,
    "the restrictive SELECT policy that hides the whole catalog (unit_price included) from anyone without SEE_MONEY");
  // Nothing the height work adds names a price column.
  for (const fn of ["catalogHeightApplies", "catalogReadHeight", "syncCatHeightField"]) {
    const body = grabFn(SRC, fn);
    assert.equal(/unit_price|supplier_unit_price|money\(/.test(body), false, fn + " touches a price");
  }
});

// ========================================================================= 4. TEETH ==
// Each guard above is only worth something if the page's own code, broken in the obvious way, fails it.
const TOUCH_GUARD = "if(!openCatItem || rawHeight !== catHeightLoaded || $('ci_height').validity.badInput){";
const mutants = [
  { name: "a typed 0 read as a blank or accepted (the `|| null` mistake)", check: (mk) => readHeightCases(mk().H),
    mutate: (s) => s.replace("if(!Number.isFinite(n) || n <= 0) return { ok:false };", "if(!Number.isFinite(n)) return { ok:false };") },
  { name: "text swallowed by the number box read as a blank", check: (mk) => readHeightCases(mk().H),
    mutate: (s) => s.replace("return badInput ? { ok:false } : { ok:true, value:null };", "return { ok:true, value:null };") },
  { name: "the box is sent even when nobody touched it", check: (mk) => saveCases(mk),
    mutate: (s) => s.replace(TOUCH_GUARD, "if(true){") },
  { name: "swallowed text does not count as touching the box", check: (mk) => saveCases(mk),
    mutate: (s) => s.replace(" || $('ci_height').validity.badInput){", "){") },
  { name: "the typed height never reaches the write", check: (mk) => saveCases(mk),
    mutate: (s) => s.replace("form.height_ft = h.value;", "") },
  { name: "the height box is offered on every role", check: (mk) => checkRoles(mk),
    mutate: (s) => s.replace("return role==='PANEL' || role==='GATE_PANEL';", "return true;") },
  { name: "the payload names height_ft even when the form did not", check: (mk) => payloadCases(mk().H),
    mutate: (s) => s.replace("if(form.height_ft !== undefined) row.height_ft = form.height_ft;", "row.height_ft = form.height_ft;") },
  { name: "the price is rounded to cents on screen", check: (mk) => listCases(mk().H),
    mutate: (s) => s.replace("maximumFractionDigits:6", "maximumFractionDigits:2") },
  { name: "a missing price shows as a dollar figure", check: (mk) => crewCases(mk().H),
    mutate: (s) => s.replace("if(n === null || n === undefined || n === '' || !Number.isFinite(Number(n))) return '—';", "") },
  { name: "the supplier column is dropped from the row", check: (mk) => listCases(mk().H),
    mutate: (s) => s.replace("<td>${supName?esc(supName):'—'}</td>", "") },
  { name: "price is dropped from the sort (the order falls back to the suppliers' names)", check: (mk) => orderCases(mk().H),
    mutate: (s) => s.replace("|| byNum(last(a.unit_price), last(b.unit_price))", "") },
  { name: "height is dropped from the sort (4 ft rows land among the 6 ft ones)", check: (mk) => orderCases(mk().H),
    mutate: (s) => s.replace("|| byNum(last(a.height_ft), last(b.height_ft))", "") },
  { name: "the sort reorders the caller's own array", check: (mk) => orderCases(mk().H),
    mutate: (s) => s.replace("return (items||[]).slice().sort((a, b) =>", "return (items||[]).sort((a, b) =>") },
  { name: "the category band is one column short again", check: (mk) => listCases(mk().H),
    mutate: (s) => s.replace("const colCount = 9 +", "const colCount = 8 +") },
  { name: "the supplier is not searchable", check: (mk) => filterCases(mk().H),
    mutate: (s) => s.replace("String(supplier(c.manufacturer_sync_id)||'').toLowerCase().includes(f)", "false") },
];
for (const m of mutants) {
  test("TEETH: " + m.name + " is caught", async () => {
    // The mutation is applied once, here, outside the try: a mutation whose target text is not in the page would otherwise
    // throw inside it and be counted as "caught".
    assert.notEqual(m.mutate(PAGE_CODE), PAGE_CODE, "the mutation changed nothing -- its target text is not in the page: " + m.name);
    let caught = false;
    try { await m.check(() => fresh(m.mutate)); } catch (e) { caught = true; }
    assert.ok(caught, "the mutant passed: this guard cannot fail for: " + m.name);
  });
}
test("TEETH control: with no mutation every guard above passes on the page as it is", async () => {
  readHeightCases(fresh().H); payloadCases(fresh().H); await saveCases(() => fresh());
  listCases(fresh().H); orderCases(fresh().H); filterCases(fresh().H); moneyCases(fresh().H); crewCases(fresh().H);
});
