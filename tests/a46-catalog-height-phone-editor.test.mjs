// a46-catalog-height-phone-editor -- the phone's catalog editor can SET a panel's height, the list says who supplied each row, and the
// height typed there is held to every hop it has to cross to reach a price.
//
// WHY THIS FILE READS THE KOTLIN AS TEXT. The Kotlin in this change was NOT compiled when it was written: a release publish was
// running its Gradle gates and a second Gradle run starves it. So, like tests/a40-height-carriers.test.mjs, this reads the Kotlin, the
// TypeScript, the SQL and the three strings files, holds them to each other, and gives every group of checks a mutant that must fail it.
// Where a check needs BEHAVIOUR (what "6", "4,5", "" and "72" parse to) it uses a JS port of the Kotlin decision functions; the port is
// pinned to the Kotlin text (the constants, the order of the checks, the role lists are all READ from the Kotlin, not retyped here), so
// a Kotlin edit that changes the decision breaks the pin. The port proves the decision table the Kotlin text encodes; it is not a
// substitute for compiling the app, and the report for this change says the Kotlin was not compiled.
//
// WHAT WAS PROBED LIVE (SELECT only, 1 Oct 2026; no names here):
//   - material_items.height_ft exists (real, nullable); the crew door material_items_crew carries it and carries no unit_price and no
//     supplier_sku.
//   - the signed-in role may INSERT and UPDATE height_ft (column privileges, with covers_ft and unit_price as controls), and the
//     triggers on material_items are only the money hold on unit_price, the delete guard and the updated_at clock.
//   - the owner's catalog: 126 live rows, 32 with a supplier, 23 PANEL/GATE_PANEL rows, every one of the 23 with a height.
//   - two prices carry digits below a cent (54.99875 and 18.99929).
//
//   node --test tests/a46-catalog-height-phone-editor.test.mjs        (no network, no writes)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const KT = "app/src/main/java/com/fenceestimator/app/";
const RES = "app/src/main/res/";
/** Every strings*.xml of one locale folder, joined: Android merges them into one namespace, and the catalog's strings are spread over several. */
const readStrings = (dir) => readdirSync(join(ROOT, RES + dir)).filter((n) => /^strings.*\.xml$/.test(n)).sort().map((n) => read(RES + dir + "/" + n)).join("\n");
const SRC = {
  screen: read(KT + "ui/catalog/CatalogScreen.kt"),
  fields: read(KT + "ui/catalog/CatalogFields.kt"),
  vm: read(KT + "ui/catalog/CatalogViewModel.kt"),
  entities: read(KT + "data/Entities.kt"),
  appdb: read(KT + "data/AppDatabase.kt"),
  repo: read(KT + "data/Repository.kt"),
  sync: read(KT + "cloud/EntitySync.kt"),
  supa: read(KT + "cloud/SupabaseModule.kt"),
  main: read(KT + "MainActivity.kt"),
  perms: read(KT + "cloud/Permissions.kt"),
  engine: read(KT + "estimate/EstimateEngine.kt"),
  lineItems: read("supabase/functions/_shared/pricing/line-items.ts"),
  priceJob: read("supabase/functions/price-job/index.ts"),
  sqlA40: read("supabase_a40_material_height.sql"),
  en: readStrings("values"),
  es: readStrings("values-es"),
  fr: readStrings("values-fr"),
};
const mutate = (src, key, from, to) => {
  assert.ok(typeof from === "string" ? src[key].includes(from) : from.test(src[key]), `the mutation target is not in ${key}: ${String(from).slice(0, 80)}`);
  const next = src[key].replace(from, to);
  assert.notEqual(next, src[key], "the mutation changed nothing");
  return { ...src, [key]: next };
};

// ================================================================== readers ==
/**
 * Kotlin (default) or TypeScript ("ts") with comments blanked and string literals kept whole. Kotlin strings are "..." only: a backtick
 * there quotes an identifier (and appears inside the SQL strings of AppDatabase.kt), so it must not open a string.
 */
function stripCode(src, lang = "kt") {
  const quotes = lang === "ts" ? ['"', "'", "`"] : ['"'];
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (quotes.includes(c)) { let j = i + 1; while (j < src.length && src[j] !== c) { if (src[j] === "\\") j++; j++; } out += src.slice(i, j + 1); i = j + 1; continue; }
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; out += " "; continue; }
    out += c; i++;
  }
  return out;
}
/** Same, with the INSIDE of every string literal emptied, so a brace in a string cannot unbalance a count. */
function blankStrings(code) {
  let out = "", i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '"') { let j = i + 1; while (j < code.length && code[j] !== '"') { if (code[j] === "\\") j++; j++; } out += '""'; i = j + 1; continue; }
    out += c; i++;
  }
  return out;
}
/** The text between the parentheses that open at the end of `headerRe`'s match (a constructor's parameter list). */
function parenBody(code, headerRe) {
  const m = headerRe.exec(code);
  assert.ok(m, "not found in the source: " + headerRe);
  let i = m.index + m[0].length, depth = 1;
  const start = i;
  while (i < code.length && depth > 0) { if (code[i] === "(") depth++; else if (code[i] === ")") depth--; i++; }
  assert.equal(depth, 0, "unbalanced parentheses after " + headerRe);
  return code.slice(start, i - 1);
}
/** The text between the braces that open at the end of `headerRe`'s match. */
function braceBody(code, headerRe) {
  const m = headerRe.exec(code);
  assert.ok(m, "not found in the source: " + headerRe);
  let i = m.index + m[0].length, depth = 1;
  const start = i;
  while (i < code.length && depth > 0) { if (code[i] === "{") depth++; else if (code[i] === "}") depth--; i++; }
  assert.equal(depth, 0, "unbalanced braces after " + headerRe);
  return code.slice(start, i - 1);
}
const stringNames = (xml) => new Set([...xml.matchAll(/<string name="([^"]+)"/g)].map((m) => m[1]));
const stringValue = (xml, name) => { const m = new RegExp('<string name="' + name + '">([\\s\\S]*?)</string>').exec(xml); return m ? m[1] : null; };
const NEW_KEYS = ["cat_width_ft", "cat_width_hint", "cat_height_ft", "cat_height_hint", "cat_size_explain_panel", "cat_fabric_height_ft",
  "cat_fabric_height_hint", "cat_height_invalid", "cat_height_cannot_clear", "cat_supplier_named", "cat_supplier_none", "cat_size_wide",
  "cat_size_tall", "cat_size_height_missing"];

// ============================================================ the Kotlin port ==
// Pinned to CatalogFields.kt: MAX_HEIGHT_FT and the role lists are READ from it.
function kotlinFloatOrNull(s) {
  if (/^[+-]?(NaN|Infinity)$/.test(s)) return s.includes("Infinity") ? (s.startsWith("-") ? -Infinity : Infinity) : NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[fFdD]?$/.test(s)) return null;
  return Math.fround(Number(s.replace(/[fFdD]$/, "")));
}
function port(fieldsSrc) {
  const code = stripCode(fieldsSrc);
  const MAX = Number(/const val MAX_HEIGHT_FT = (\d+(?:\.\d+)?)f/.exec(code)[1]);
  const body = braceBody(code, /internal fun sizeFieldsFor\(role: MaterialRole\): SizeFields = when \(role\) \{/);
  const map = {};
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*(.+?)\s*->\s*SizeFields\.(\w+)/);
    if (!m) continue;
    (map[m[2]] ||= []).push(...[...m[1].matchAll(/MaterialRole\.(\w+)/g)].map((x) => x[1]));
  }
  const sizeFieldsFor = (role) => (map.WIDTH_AND_HEIGHT.includes(role) ? "WIDTH_AND_HEIGHT" : map.FABRIC_HEIGHT.includes(role) ? "FABRIC_HEIGHT" : "OTHER");
  const parseHeightEntry = (text) => {
    const cleaned = text.trim().split(",").join(".");
    if (cleaned === "") return { kind: "blank" };
    const feet = kotlinFloatOrNull(cleaned);
    if (feet === null) return { kind: "notAHeight" };
    if (Number.isNaN(feet) || !Number.isFinite(feet) || feet <= 0 || feet > MAX) return { kind: "notAHeight" };
    return { kind: "feet", feet };
  };
  const heightProblem = (role, typed, saved) => {
    if (sizeFieldsFor(role) !== "WIDTH_AND_HEIGHT") return null;
    const e = parseHeightEntry(typed);
    if (e.kind === "notAHeight") return "NOT_A_HEIGHT";
    if (e.kind === "blank") return saved !== null ? "CANNOT_BE_CLEARED" : null;
    return null;
  };
  const heightToSave = (role, typed, saved) => {
    if (sizeFieldsFor(role) !== "WIDTH_AND_HEIGHT") return saved;
    const e = parseHeightEntry(typed);
    return e.kind === "feet" ? e.feet : saved;
  };
  const feetText = (v) => (v % 1 === 0 ? String(Math.trunc(v)) : String(v));
  const hasSubCentDigits = (price) => {
    if (!Number.isFinite(price)) return false;
    const cents = price * 100;
    return Math.abs(cents - Math.round(cents)) > 1e-6;
  };
  const exact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 5 });
  const standard = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const listPriceText = (price) => (hasSubCentDigits(price) ? exact.format(price) : standard.format(price));
  return { MAX, map, sizeFieldsFor, parseHeightEntry, heightProblem, heightToSave, feetText, hasSubCentDigits, listPriceText };
}

// =============================================================== the groups ==
// Each takes the sources and returns the list of things wrong. [] is a pass. The last test feeds each one a mutant.
const GROUPS = {
  // 1. THE SCREEN: the box exists, it is seeded from the row, it reaches the saved row, and Save / Duplicate check it first.
  screenToRoom(s) {
    const f = [];
    const code = stripCode(s.screen);
    const edits = braceBody(code, /fun currentEdits\(\): MaterialItem \{/);
    if (!/heightFt = heightToSave\(role, heightFtText, item\.heightFt\)/.test(edits)) f.push("currentEdits() does not write heightFt = heightToSave(role, heightFtText, item.heightFt)");
    if (!/var heightFtText by remember \{ mutableStateOf\(item\.heightFt\?\.let \{ feetText\(it\) \} \?: ""\) \}/.test(code)) f.push("the height box is not seeded from item.heightFt (null must seed an EMPTY box)");
    if (!/value = heightFtText,[\s\S]{0,200}label = \{ Text\(stringResource\(R\.string\.cat_height_ft\)\) \}/.test(code)) f.push("no height box labelled cat_height_ft bound to heightFtText");
    const dialogAt = code.indexOf("private fun EditItemDialog");
    const confirmAt = code.indexOf("confirmButton = {", dialogAt);
    const confirm = dialogAt < 0 || confirmAt < 0 ? "" : code.slice(confirmAt, code.indexOf("dismissButton = {", confirmAt));
    if (!/heightProblem\(role, heightFtText, item\.heightFt\)/.test(confirm)) f.push("Save does not ask heightProblem() before saving");
    if (!/if \(!priceBad && problem == null\) onSave\(currentEdits\(\)\)/.test(confirm)) f.push("Save can reach onSave() with a height problem standing");
    const dupAt = code.indexOf("onDuplicateForManufacturer(\n");
    const dup = dupAt < 0 ? "" : code.slice(Math.max(0, dupAt - 700), dupAt + 400);
    if (!/heightProblem\(role, heightFtText, item\.heightFt\)/.test(dup)) f.push("Duplicate does not ask heightProblem() first");
    if (!/syncId = java\.util\.UUID\.randomUUID\(\)\.toString\(\)/.test(dup)) f.push("the duplicated row keeps its source's sync id");
    if (/heightFt = 0/.test(code)) f.push("the screen writes a literal 0 height");
    // a routine save must not erase a row's source reference (14 of the owner's rows carry an invoice reference there)
    if (!/val keepsSource = !startedUnverified && item\.sourceDoc\.isNotBlank\(\) && price == item\.unitPrice/.test(edits)) f.push("currentEdits() does not work out whether the row keeps its source");
    if (!/sourceDoc = if \(priceConfirmed && !keepsSource\) com\.fenceestimator\.app\.data\.CONFIRMED else item\.sourceDoc/.test(edits)) f.push("a save can overwrite a row's source reference with the bare word Confirmed");
    return f;
  },

  // 2. BLANK STAYS BLANK: an empty box is "this row does not say", never a zero-foot fence.
  blankIsNotZero(s) {
    const f = [];
    const code = stripCode(s.fields);
    const parse = braceBody(code, /internal fun parseHeightEntry\(text: String\): HeightEntry \{/);
    const iBlank = parse.search(/if \(cleaned\.isEmpty\(\)\) return HeightEntry\.Blank/);
    const iNum = parse.search(/toFloatOrNull\(\)/);
    if (iBlank < 0 || iNum < 0 || iBlank > iNum) f.push("blank is not decided BEFORE the number parse");
    if (/\?:\s*0(\.0)?f?\b/.test(parse) || /orZero|coerceAtLeast\(0|\.toFloat\(\)/.test(parse)) f.push("the parse can fall back to zero");
    if (!/feet <= 0f/.test(parse)) f.push("a zero or negative height is accepted");
    if (!/feet\.isNaN\(\) \|\| feet\.isInfinite\(\)/.test(parse)) f.push("NaN and Infinity are accepted");
    if (!/feet > MAX_HEIGHT_FT/.test(parse)) f.push("there is no upper bound for a height typed in the wrong unit");
    const save = braceBody(code, /internal fun heightToSave\(role: MaterialRole, typed: String, saved: Float\?\): Float\? \{/);
    if (!/if \(sizeFieldsFor\(role\) != SizeFields\.WIDTH_AND_HEIGHT\) return saved/.test(save)) f.push("a hidden height box can change the saved height");
    if (!/return if \(entry is HeightEntry\.Feet\) entry\.feet else saved/.test(save)) f.push("a blank or bad height does not fall back to what the row already said");
    const prob = braceBody(code, /internal fun heightProblem\(role: MaterialRole, typed: String, saved: Float\?\): HeightProblem\? \{/);
    if (!/is HeightEntry\.Blank -> if \(saved != null\) HeightProblem\.CANNOT_BE_CLEARED else null/.test(prob)) f.push("a blank over an existing height is not refused");
    return f;
  },

  // 3. THE ROLES: the editor's boxes follow what the two engines actually read.
  roles(s) {
    const f = [];
    const p = port(s.fields);
    const editorWH = [...p.map.WIDTH_AND_HEIGHT].sort().join(",");
    const ktCode = stripCode(s.engine);
    const ktBlock = /if \(entry\.role == MaterialRole\.(\w+) \|\| entry\.role == MaterialRole\.(\w+)\) \{\s*val current = candidates\s*candidates = current\.filter \{ c ->\s*c\.heightFt == run\.panelHeightFt/.exec(ktCode);
    const tsCode = stripCode(s.lineItems, "ts");
    const tsBlock = /if \(entry\.role === "(\w+)" \|\| entry\.role === "(\w+)"\) \{\s*const current = candidates;\s*candidates = current\.filter\(\(c\) =>\s*c\.heightFt === run\.panelHeightFt/.exec(tsCode);
    if (!ktBlock) f.push("EstimateEngine's height step (the roles it applies to) was not found");
    if (!tsBlock) f.push("line-items.ts's height step (the roles it applies to) was not found");
    if (ktBlock && [ktBlock[1], ktBlock[2]].sort().join(",") !== editorWH) f.push(`EstimateEngine applies height to ${[ktBlock[1], ktBlock[2]].sort()} but the editor shows a height box for ${editorWH}`);
    if (tsBlock && [tsBlock[1], tsBlock[2]].sort().join(",") !== editorWH) f.push(`line-items.ts applies height to ${[tsBlock[1], tsBlock[2]].sort()} but the editor shows a height box for ${editorWH}`);
    if (editorWH !== "GATE_PANEL,PANEL") f.push("the height box is not exactly PANEL and GATE_PANEL: " + editorWH);
    if ((p.map.FABRIC_HEIGHT || []).join(",") !== "CHAIN_FABRIC") f.push("chain-link fabric is not the one role with the single fabric-height box");
    if (!/QtyEntry\(MaterialRole\.CHAIN_FABRIC, netFt\.toDouble\(\), preferCoversFt = run\.fabricHeightFt\)/.test(ktCode)) f.push("the engine no longer reads a fabric's coversFt as its HEIGHT, so the single fabric box is mislabelled");
    if (!/else -> SizeFields\.OTHER/.test(stripCode(s.fields))) f.push("no catch-all: a new role would not map to a box");
    const enumRoles = /enum class MaterialRole \{([\s\S]*?)\n\}/.exec(stripCode(s.entities));
    const roleNames = enumRoles ? [...enumRoles[1].matchAll(/\b([A-Z][A-Z_]+)\b/g)].map((m) => m[1]) : [];
    if (roleNames.length < 20) f.push("control: the MaterialRole enum was not read (" + roleNames.length + " roles)");
    return f;
  },

  // 4. THE SCREEN SHOWS WHAT IT SHOULD: two different boxes, one box for fabric, a supplier on every row, a height flag on panels.
  screenShape(s) {
    const f = [];
    const code = stripCode(s.screen);
    const whenAt = code.indexOf("when (sizeFieldsFor(role)) {");
    if (whenAt < 0) { f.push("the editor's size boxes do not follow sizeFieldsFor(role)"); return f; }
    const block = braceBody(code.slice(whenAt), /^when \(sizeFieldsFor\(role\)\) \{/);
    const branch = (name) => { const m = new RegExp("SizeFields\\." + name + " -> \\{").exec(block); if (!m) return ""; return braceBody(block.slice(m.index), new RegExp("^SizeFields\\." + name + " -> \\{")); };
    const wh = branch("WIDTH_AND_HEIGHT"), fabric = branch("FABRIC_HEIGHT"), other = branch("OTHER");
    if (!/cat_width_ft/.test(wh) || !/coversFtText/.test(wh)) f.push("the panel branch has no width box on coversFt");
    if (!/cat_height_ft/.test(wh) || !/heightFtText/.test(wh)) f.push("the panel branch has no height box on heightFt");
    if (!fabric) f.push("no fabric branch");
    if (/heightFtText/.test(fabric) || /cat_height_ft/.test(fabric)) f.push("the chain-link branch shows a second height box");
    if (!/cat_fabric_height_ft/.test(fabric) || !/coversFtText/.test(fabric)) f.push("the chain-link branch is not ONE fabric-height box on coversFt");
    if (/heightFtText/.test(other) || !/cat_covers_ft/.test(other)) f.push("the other-roles branch changed what it was");
    if (/value = coversFtText/.test(code.slice(0, whenAt).slice(code.indexOf("fun currentEdits")))) f.push("a width box still sits above the role dropdown, so it would show twice");
    if (!/verticalScroll\(rememberScrollState\(\)\)/.test(code.slice(code.indexOf("private fun EditItemDialog")))) f.push("the editor dialog does not scroll, so the new box can push the lower fields out of reach");
    // the list row
    if (!/val supplier = supplierOf\(item, manufacturers\)/.test(code)) f.push("the row does not look its supplier up with supplierOf");
    if (!/stringResource\(R\.string\.cat_supplier_named, supplier\.name\.ifBlank/.test(code) || !/else stringResource\(R\.string\.cat_supplier_none\)/.test(code)) f.push("the row does not say the supplier, or does not say plainly that it has none");
    if (/R\.string\.cat_default_price\b/.test(code)) f.push("the row still labels a supplier-less row 'Default price'");
    if (!/if \(size\.heightMissing\) sizeParts\.add\(stringResource\(R\.string\.cat_size_height_missing\)\)/.test(code)) f.push("a panel row with no height does not say so");
    if (!/supplierOf\(it, manufacturers\)\?\.name\?\.lowercase\(\)\?\.contains\(needle\) == true/.test(code)) f.push("searching a supplier's name finds nothing");
    return f;
  },

  // 5. STRINGS: every string the catalog code names exists in all three locales (a missing one breaks the build), and the new ones are translated.
  strings(s) {
    const f = [];
    const locales = { en: s.en, es: s.es, fr: s.fr };
    const names = Object.fromEntries(Object.entries(locales).map(([k, v]) => [k, stringNames(v)]));
    const used = new Set();
    for (const key of ["screen", "fields", "vm"]) for (const m of stripCode(s[key]).matchAll(/R\.string\.(\w+)/g)) used.add(m[1]);
    if (used.size < 40) f.push("control: only " + used.size + " string references were read from the catalog code");
    for (const name of used) for (const [loc, set] of Object.entries(names)) if (!set.has(name)) f.push(`R.string.${name} is missing from the ${loc} strings`);
    for (const key of NEW_KEYS) {
      if (!used.has(key)) f.push(`the new string ${key} is not used by any catalog code`);
      const en = stringValue(s.en, key), es = stringValue(s.es, key), fr = stringValue(s.fr, key);
      if (en === null || es === null || fr === null) { f.push(`${key} is missing from a locale`); continue; }
      for (const [loc, xml] of Object.entries(locales)) {
        const defs = (xml.match(new RegExp('<string name="' + key + '"', "g")) || []).length;
        if (defs !== 1) f.push(`${key} is defined ${defs} times in the ${loc} resource files (two definitions of one name break the resource merge)`);
      }
      if (es === en) f.push(`${key} in Spanish is the English text`);
      if (fr === en) f.push(`${key} in French is the English text`);
      if (es === fr) f.push(`${key} in Spanish and French are identical`);
      const ph = (t) => [...t.matchAll(/%\d\$[sd]/g)].map((m) => m[0]).sort().join(",");
      if (ph(en) !== ph(es) || ph(en) !== ph(fr)) f.push(`${key} has different placeholders across locales`);
      if (/(^|[^\\])'/.test(es) || /(^|[^\\])'/.test(fr) || /(^|[^\\])'/.test(en)) f.push(`${key} has an unescaped apostrophe`);
    }
    for (const key of ["cat_supplier_named", "cat_size_wide", "cat_size_tall"]) if (!/%1\$s/.test(stringValue(s.en, key) || "")) f.push(`${key} lost its %1$s`);
    return f;
  },

  // 6. CREW NEVER SEE MONEY: who can open this screen, what a no-money phone holds, and that nothing added here carries a price.
  money(s) {
    const f = [];
    const main = stripCode(s.main);
    if (!/composable\(Routes\.CATALOG\) \{\s*com\.fenceestimator\.app\.ui\.components\.AccessGuard\(\s*allowed = session\.canEditCatalogAndSettings,/.test(main)) f.push("the catalog route is not behind AccessGuard(canEditCatalogAndSettings)");
    const perms = stripCode(s.perms);
    const at = perms.indexOf("val UserRole.defaultPermissions");
    const holders = [];
    if (at >= 0) {
      const table = braceBody(perms.slice(at), /^val UserRole\.defaultPermissions: Set<Permission>\s*get\(\) = when \(this\) \{/);
      const segs = table.split(/UserRole\.(\w+) ->/);
      for (let i = 1; i < segs.length; i += 2) if (/EDIT_CATALOG_AND_SETTINGS|Permission\.ALL/.test(segs[i + 1])) holders.push(segs[i]);
      if (segs.length < 13) f.push("control: only " + ((segs.length - 1) / 2) + " roles were read from the default permission table");
    }
    if (at < 0 || holders.join(",") !== "OWNER,MANAGER") f.push("the roles holding Change catalog and settings by default are " + holders.join(",") + ", not OWNER,MANAGER");
    const sync = stripCode(s.sync);
    if (!/pagedList<CloudMaterialItem>\("material_items_crew"\)/.test(sync)) f.push("a no-money phone no longer pulls the catalog through material_items_crew");
    const catalogPull = braceBody(sync, /private suspend fun pullCatalog\(repository: Repository, companyId: String, scope: MoneyScope\): Int \{/);
    for (const [tail, what] of [["existing\\.unitPrice", "an existing row"], ["sameThing\\.unitPrice", "a row adopted by identity"], ["0\\.0", "a new row"]]) {
      if (!new RegExp("unitPrice = if \\(scope == MoneyScope\\.ALLOWED\\) row\\.unitPrice else " + tail).test(catalogPull)) f.push("a no-money pull no longer keeps the phone's own price for " + what + ", so the view's missing price could overwrite it");
    }
    const door = /create or replace view public\.material_items_crew[\s\S]*?select([\s\S]*?)\n\s*from public\.material_items/i.exec(s.sqlA40);
    if (!door) f.push("the crew door's select list was not found in the a40 SQL");
    else {
      if (/unit_price|supplier_sku/.test(door[1])) f.push("the crew door selects a money or SKU column");
      if (!/height_ft/.test(door[1])) f.push("the crew door does not carry height_ft");
    }
    // what this change added
    const fields = stripCode(s.fields);
    for (const fn of ["sizeFieldsFor", "parseHeightEntry", "heightProblem", "heightToSave", "feetText", "rowSizeOf", "supplierOf"]) {
      const m = new RegExp("internal fun " + fn + "\\(").exec(fields);
      if (!m) { f.push("control: " + fn + " not found"); continue; }
      // from this function to the next top-level declaration (comments are already gone)
      const next = fields.slice(m.index + 1).search(/\n(internal|private|public) /);
      const body = next < 0 ? fields.slice(m.index) : fields.slice(m.index, m.index + 1 + next);
      if (/unitPrice|Money|supplierUnitPrice|price/i.test(body)) f.push(fn + " touches a price");
    }
    if (/import com\.fenceestimator\.app\.ui\.components\.Money/.test(fields)) f.push("the helper file imports Money");
    const screen = stripCode(s.screen);
    const sizeBlock = screen.slice(screen.indexOf("val sizeParts = ArrayList<String>()"), screen.indexOf("if (showFenceType) {"));
    if (!sizeBlock || /unitPrice|Money|price/i.test(sizeBlock)) f.push("the size line carries a price");
    const heightBlock = screen.slice(screen.indexOf("when (sizeFieldsFor(role)) {"), screen.indexOf("EnumDropdown(\n                    stringResource(R.string.cat_priced_from)"));
    if (!heightBlock || /unitPrice|Money|supplierUnitPrice/.test(heightBlock)) f.push("the size boxes carry a price");
    // Money is formatted in exactly two places on this screen: the row's one price line (above the import review) and the import review itself.
    const importAt = screen.indexOf("private fun ImportReviewDialog");
    const moneyBeforeImport = importAt < 0 ? -1 : (screen.slice(0, importAt).match(/Money\.format\(/g) || []).length;
    if (moneyBeforeImport !== 1) f.push("Money.format is called " + moneyBeforeImport + " times outside the import review; the row's price line is the only one allowed");
    if ((screen.match(/listPriceText\(/g) || []).length !== 1) f.push("listPriceText is called other than once");
    if (!/if \(unpriced\) stringResource\(R\.string\.cat_no_price\) else stringResource\(R\.string\.cat_price_per_unit, listPriceText\(item\.unitPrice\) \{ Money\.format\(it\) \}, item\.unit\)/.test(screen)) f.push("the exact-price text is not confined to the row's existing price line");
    return f;
  },

  // 7. THE HOPS a typed height crosses after the screen: Room, the push, the pull, the engines.
  hops(s) {
    const f = [];
    const ent = stripCode(s.entities);
    const item = parenBody(ent, /data class MaterialItem\(/);
    if (!/val heightFt: Float\? = null/.test(item)) f.push("MaterialItem has no nullable heightFt");
    const db = stripCode(s.appdb);
    if (!/ALTER TABLE `material_items` ADD COLUMN `heightFt` REAL"/.test(db)) f.push("no Room migration adds heightFt");
    if (!/MIGRATION_48_49|SchemaV49/.test(db)) f.push("schema 49 is not wired");
    if (!/materialDao\.update\(item\.copy\(lastUpdated = System\.currentTimeMillis\(\)\)\)/.test(stripCode(s.repo))) f.push("updateMaterialItem no longer bumps lastUpdated, the clock the push compares");
    const sync = stripCode(s.sync);
    const push = braceBody(sync, /private suspend fun pushCatalog\(repository: Repository, companyId: String\): Int \{/);
    if (!/heightFt = it\.heightFt/.test(push)) f.push("pushCatalog does not send heightFt");
    if (!/@SerialName\("height_ft"\) val heightFt: Float\? = null/.test(sync)) f.push("CloudMaterialItem has no height_ft");
    if ((sync.match(/heightFt = row\.heightFt/g) || []).length < 3) f.push("a pull path does not copy height_ft onto the phone (" + (sync.match(/heightFt = row\.heightFt/g) || []).length + " of 3)");
    const pull = braceBody(sync, /private suspend fun pullCatalog\(repository: Repository, companyId: String, scope: MoneyScope\): Int \{/);
    if (/Columns\.list|select\(Columns/.test(pull) || !/pagedList<CloudMaterialItem>\("material_items"\)/.test(pull)) f.push("the catalog pull no longer reads every column");
    if (!/ADD COLUMN IF NOT EXISTS height_ft real|add column if not exists height_ft real/i.test(s.sqlA40)) f.push("the SQL does not add height_ft");
    if (!/c\.heightFt == run\.panelHeightFt/.test(stripCode(s.engine))) f.push("the phone engine does not read heightFt");
    if (!/c\.heightFt === run\.panelHeightFt/.test(stripCode(s.lineItems, "ts"))) f.push("the server engine does not read heightFt");
    return f;
  },

  // 8. THE ONE LIMITATION, held in step: while the push drops a null, the editor must refuse to clear a height.
  clearing(s) {
    const f = [];
    const nullsDropped = /explicitNulls = false/.test(stripCode(s.supa));
    const refuses = /CANNOT_BE_CLEARED/.test(stripCode(s.fields)) && /is HeightEntry\.Blank -> if \(saved != null\)/.test(stripCode(s.fields));
    if (nullsDropped && !refuses) f.push("the push drops a null height (explicitNulls = false) but the editor lets a height be cleared, so the clear would undo itself on the next pull");
    if (!nullsDropped && refuses) f.push("the push no longer drops a null, so the editor's refusal to clear a height can be lifted; read CANNOT_BE_CLEARED before deleting it");
    return f;
  },

  // 9. THE KOTLIN IS AT LEAST BALANCED, since nothing compiled it.
  balanced(s) {
    const f = [];
    for (const key of ["screen", "fields"]) {
      const code = blankStrings(stripCode(s[key]));
      for (const [o, c] of [["{", "}"], ["(", ")"], ["[", "]"]]) {
        const a = code.split(o).length - 1, b = code.split(c).length - 1;
        if (a !== b) f.push(`${key}: ${a} '${o}' against ${b} '${c}'`);
      }
    }
    return f;
  },
};

// ============================================================ the real checks ==
for (const [name, fn] of Object.entries(GROUPS)) {
  test(`REAL SOURCES: ${name}`, () => assert.deepEqual(fn(SRC), []));
}

// ================================================ behaviour, via the port ==
const P = port(SRC.fields);
test("PORT CONTROL: the role lists and the bound were READ from CatalogFields.kt, not retyped", () => {
  assert.equal(P.MAX, 20);
  assert.deepEqual([...P.map.WIDTH_AND_HEIGHT].sort(), ["GATE_PANEL", "PANEL"]);
  assert.deepEqual(P.map.FABRIC_HEIGHT, ["CHAIN_FABRIC"]);
});

test("the box reads what a person types, and a blank is a blank", () => {
  const table = [
    ["", "blank"], ["   ", "blank"], ["\t", "blank"],
    ["6", 6], ["6.0", 6], ["4.5", 4.5], ["4,5", 4.5], [" 4 ", 4], ["20", 20], [".5", 0.5],
    ["0", "notAHeight"], ["0.0", "notAHeight"], ["-6", "notAHeight"], ["72", "notAHeight"], ["20.5", "notAHeight"],
    ["NaN", "notAHeight"], ["Infinity", "notAHeight"], ["abc", "notAHeight"], ["6'", "notAHeight"], ["6 ft", "notAHeight"], [".", "notAHeight"], ["4..5", "notAHeight"],
  ];
  for (const [typed, want] of table) {
    const got = P.parseHeightEntry(typed);
    if (typeof want === "number") assert.deepEqual(got, { kind: "feet", feet: want }, JSON.stringify(typed));
    else assert.equal(got.kind, want, JSON.stringify(typed));
  }
});

test("EMPTY STAYS EMPTY: no blank-ish text, for any role, ever stores a 0", () => {
  const roles = ["PANEL", "GATE_PANEL", "CHAIN_FABRIC", "HINGE_SET", "NONE", "LINE_POST"];
  for (const role of roles) for (const typed of ["", " ", "\t", "  \t "]) {
    const got = P.heightToSave(role, typed, null);
    assert.equal(got, null, `${role} ${JSON.stringify(typed)} saved ${got}`);
    assert.notEqual(got, 0);
  }
});

test("a height is only ever set from the box when the box is on screen", () => {
  assert.equal(P.heightToSave("PANEL", "4", null), 4);
  assert.equal(P.heightToSave("GATE_PANEL", "6", 4), 6);
  assert.equal(P.heightToSave("PANEL", "4,5", 6), 4.5);
  for (const role of ["HINGE_SET", "LINE_POST", "NONE", "CHAIN_FABRIC", "TRIM"]) {
    assert.equal(P.heightToSave(role, "9", 6), 6, role + ": a hidden box changed the height");
    assert.equal(P.heightToSave(role, "9", null), null, role + ": a hidden box set a height");
    assert.equal(P.heightProblem(role, "nonsense", 6), null, role + ": a hidden box blocked a save");
    assert.equal(P.heightProblem(role, "", 6), null, role + ": a hidden box blocked a save");
  }
});

test("the three ways a save is refused, and the ways it is not", () => {
  assert.equal(P.heightProblem("PANEL", "abc", null), "NOT_A_HEIGHT");
  assert.equal(P.heightProblem("PANEL", "72", 6), "NOT_A_HEIGHT");
  assert.equal(P.heightProblem("GATE_PANEL", "0", null), "NOT_A_HEIGHT");
  assert.equal(P.heightProblem("PANEL", "", 6), "CANNOT_BE_CLEARED");
  assert.equal(P.heightProblem("PANEL", "   ", 4.5), "CANNOT_BE_CLEARED");
  assert.equal(P.heightProblem("PANEL", "", null), null, "a row with no height may stay without one");
  assert.equal(P.heightProblem("PANEL", "6", 6), null);
  assert.equal(P.heightProblem("PANEL", "4", 6), null, "changing a height is allowed");
});

test("which box each role gets: width AND height for the two panel roles, ONE box for fabric, the old box for the rest", () => {
  assert.equal(P.sizeFieldsFor("PANEL"), "WIDTH_AND_HEIGHT");
  assert.equal(P.sizeFieldsFor("GATE_PANEL"), "WIDTH_AND_HEIGHT");
  assert.equal(P.sizeFieldsFor("CHAIN_FABRIC"), "FABRIC_HEIGHT");
  for (const role of ["LINE_POST", "END_POST", "CORNER_POST", "GATE_POST", "POST_CAP", "HINGE_SET", "LATCH", "TRIM", "WOOD_PICKET", "WOOD_RAIL", "TOP_RAIL", "NONE"]) {
    assert.equal(P.sizeFieldsFor(role), "OTHER", role);
  }
});

test("the box reads a whole number the way a person types it", () => {
  assert.equal(P.feetText(6), "6");
  assert.equal(P.feetText(4.5), "4.5");
});

test("a save keeps a row's source reference while its price is unchanged, and stamps Confirmed in every case it did before", () => {
  // A port of the one expression in currentEdits(); the screen test above pins the Kotlin text to it.
  const stamp = ({ started, ticked, source, oldPrice, newPrice }) => {
    const priceConfirmed = ticked ?? !started;          // the switch starts ON for a row that was not unverified
    const keepsSource = !started && source !== "" && newPrice === oldPrice;
    return priceConfirmed && !keepsSource ? "Confirmed" : source;
  };
  const invoice = "Supplier invoice 1234 (real prices)";
  assert.equal(stamp({ started: false, source: invoice, oldPrice: 52.35, newPrice: 52.35 }), invoice, "adding a height must not erase the invoice reference");
  assert.equal(stamp({ started: false, source: invoice, oldPrice: 52.35, newPrice: 54.5 }), "Confirmed", "a changed price no longer matches the invoice");
  assert.equal(stamp({ started: false, source: "Confirmed", oldPrice: 52.35, newPrice: 52.35 }), "Confirmed");
  assert.equal(stamp({ started: false, source: "", oldPrice: 0, newPrice: 12.5 }), "Confirmed", "a new custom row is stamped as before");
  const placeholder = "Placeholder, verify with your supplier";
  assert.equal(stamp({ started: true, source: placeholder, oldPrice: 52.35, newPrice: 52.35 }), placeholder, "an unchecked row stays unchecked unless the switch is ticked");
  assert.equal(stamp({ started: true, ticked: true, source: placeholder, oldPrice: 52.35, newPrice: 52.35 }), "Confirmed");
});

test("PRICES ON THE LIST: the live rows with digits below a cent show the exact figure, every ordinary price reads as it always did", () => {
  // Read from the live catalog on 1 Oct 2026: the supplier's panel and line post.
  assert.equal(P.listPriceText(54.99875), "$54.99875");
  assert.equal(P.listPriceText(18.99929), "$18.99929");
  for (const [price, shown] of [[52.35, "$52.35"], [54.15, "$54.15"], [61.74, "$61.74"], [71.5, "$71.50"], [113.75, "$113.75"], [170, "$170.00"], [120.66, "$120.66"], [0.1 + 0.2, "$0.30"], [1234.5, "$1,234.50"]]) {
    assert.equal(P.listPriceText(price), shown, String(price));
    assert.equal(P.hasSubCentDigits(price), false, String(price));
  }
  assert.equal(P.listPriceText(1234.56789), "$1,234.56789");
  // the Kotlin carries the same pattern and the same threshold
  const code = stripCode(SRC.fields);
  assert.ok(code.includes('DecimalFormat("\\$#,##0.00###"'), "the exact-money pattern changed");
  assert.ok(/Math\.abs\(cents - Math\.rint\(cents\)\) > 1e-6/.test(code), "the sub-cent threshold changed");
});

test("THE LIVE PANEL ROWS as the list will draw them: size line and price, from the rows read out of the live catalog on 1 Oct 2026", () => {
  // [role, width, height, price] -- the VINYL PANEL and GATE_PANEL rows, no names. Read with SELECT only.
  const live = [
    ["GATE_PANEL", 5, 4, 113.75], ["GATE_PANEL", 5, 6, 120.66], ["GATE_PANEL", 5, 6, 145.05], ["GATE_PANEL", 5, 6, 149.99], ["GATE_PANEL", 5, 4, 170],
    ["PANEL", 6, 6, 52.35], ["PANEL", 6, 6, 54.15], ["PANEL", 6, 6, 54.5], ["PANEL", 6, 6, 54.5], ["PANEL", 6, 6, 54.99875],
    ["PANEL", 6, 4, 61.74], ["PANEL", 8, 6, 71.4], ["PANEL", 6, 4, 71.5], ["PANEL", 8, 6, 73.9],
  ];
  const sep = /sizeParts\.joinToString\("([^"]*)"\)/.exec(stripCode(SRC.screen))[1];
  const fmt = (key, arg) => stringValue(SRC.en, key).replace("%1$s", arg);
  const sizeLine = (role, width, height) => {
    if (P.sizeFieldsFor(role) !== "WIDTH_AND_HEIGHT") return null;
    const parts = [];
    if (width !== null) parts.push(fmt("cat_size_wide", P.feetText(width)));
    if (height !== null) parts.push(fmt("cat_size_tall", P.feetText(height)));
    if (height === null) parts.push(stringValue(SRC.en, "cat_size_height_missing"));
    return parts.join(sep);
  };
  const shown = live.map(([role, w, h, price]) => `${sizeLine(role, w, h)} | ${P.listPriceText(price)}`);
  assert.deepEqual(shown, [
    "5 ft wide  ·  4 ft tall | $113.75", "5 ft wide  ·  6 ft tall | $120.66", "5 ft wide  ·  6 ft tall | $145.05", "5 ft wide  ·  6 ft tall | $149.99", "5 ft wide  ·  4 ft tall | $170.00",
    "6 ft wide  ·  6 ft tall | $52.35", "6 ft wide  ·  6 ft tall | $54.15", "6 ft wide  ·  6 ft tall | $54.50", "6 ft wide  ·  6 ft tall | $54.50", "6 ft wide  ·  6 ft tall | $54.99875",
    "6 ft wide  ·  4 ft tall | $61.74", "8 ft wide  ·  6 ft tall | $71.40", "6 ft wide  ·  4 ft tall | $71.50", "8 ft wide  ·  6 ft tall | $73.90",
  ]);
  // three different 6 ft white vinyl panels are told apart by price to the last digit the supplier quoted, and not one is flagged "height not set"
  assert.equal(shown.filter((s) => s.includes(stringValue(SRC.en, "cat_size_height_missing"))).length, 0);
  // and a panel row that really has no height is the one thing that is flagged
  assert.equal(sizeLine("PANEL", 6, null), "6 ft wide  ·  height not set");
  assert.equal(sizeLine("LINE_POST", 6, null), null, "a post row is not given a size line");
});

// ================================================== the findings, as todos ==
// These two assert what SHOULD be true. They fail today, which is the finding, and a failing todo does not fail the run. They flip to
// passing the day the file they name is fixed; delete the todo flag then.
const priceJobColumns = (src) => { const m = /const CATALOG_COLUMNS = ([^;]*);/.exec(stripCode(src, "ts")); assert.ok(m, "CATALOG_COLUMNS not found"); return m[1]; };
test("TODO the office re-price (price-job) reads heightFt, so a height typed on the phone reaches the server engine", { todo: "price-job's CATALOG_COLUMNS has no height_ft, and the live function was last deployed 5 Sep 2026, before the height engine" }, () => {
  assert.match(priceJobColumns(SRC.priceJob), /height_ft/);
});
test("TODO the phone learns a catalog row's supplier from the cloud, so the supplier on the list is the office's", { todo: "CloudMaterialItem has no manufacturer_sync_id and pullCatalog never sets manufacturerId, so a row the office gave a supplier shows none on the phone" }, () => {
  const sync = stripCode(SRC.sync);
  assert.match(sync, /@SerialName\("manufacturer_sync_id"\)/);
  const pull = braceBody(sync, /private suspend fun pullCatalog\(repository: Repository, companyId: String, scope: MoneyScope\): Int \{/);
  assert.match(pull, /manufacturerId = /);
});

// =============================================================== the teeth ==
test("TEETH: every group fails on a mutant of what it guards", () => {
  const fails = (group, mutant) => {
    const found = GROUPS[group](mutant);
    // A46_SHOW=1 prints what each mutant tripped, to read that it tripped the check it was written for.
    if (process.env.A46_SHOW) console.log(`  mutant -> ${group}: ${found.join(" | ")}`);
    assert.ok(found.length > 0, `${group} passed on a mutant`);
  };

  // the screen
  fails("screenToRoom", mutate(SRC, "screen", "            heightFt = heightToSave(role, heightFtText, item.heightFt),\n", ""));
  fails("screenToRoom", mutate(SRC, "screen", "if (!priceBad && problem == null) onSave(currentEdits())", "onSave(currentEdits())"));
  fails("screenToRoom", mutate(SRC, "screen", "syncId = java.util.UUID.randomUUID().toString(),", ""));
  fails("screenToRoom", mutate(SRC, "screen", "if (priceConfirmed && !keepsSource) com.fenceestimator.app.data.CONFIRMED", "if (priceConfirmed) com.fenceestimator.app.data.CONFIRMED"));
  fails("screenToRoom", mutate(SRC, "screen", "&& price == item.unitPrice", "&& true"));
  fails("screenToRoom", mutate(SRC, "screen", "mutableStateOf(item.heightFt?.let { feetText(it) } ?: \"\")", "mutableStateOf(item.heightFt?.let { feetText(it) } ?: \"0\")"));
  // blank is not zero
  fails("blankIsNotZero", mutate(SRC, "fields", "if (cleaned.isEmpty()) return HeightEntry.Blank", "if (cleaned.isEmpty()) return HeightEntry.Feet(0f)"));
  fails("blankIsNotZero", mutate(SRC, "fields", "if (feet.isNaN() || feet.isInfinite() || feet <= 0f || feet > MAX_HEIGHT_FT)", "if (feet.isNaN() || feet.isInfinite() || feet > MAX_HEIGHT_FT)"));
  fails("blankIsNotZero", mutate(SRC, "fields", "val feet = cleaned.toFloatOrNull() ?: return HeightEntry.NotAHeight", "val feet = cleaned.toFloatOrNull() ?: 0f"));
  fails("blankIsNotZero", mutate(SRC, "fields", "return if (entry is HeightEntry.Feet) entry.feet else saved", "return if (entry is HeightEntry.Feet) entry.feet else null"));
  // the roles
  fails("roles", mutate(SRC, "fields", "MaterialRole.PANEL, MaterialRole.GATE_PANEL -> SizeFields.WIDTH_AND_HEIGHT", "MaterialRole.PANEL, MaterialRole.GATE_PANEL, MaterialRole.HINGE_SET -> SizeFields.WIDTH_AND_HEIGHT"));
  fails("roles", mutate(SRC, "fields", "MaterialRole.CHAIN_FABRIC -> SizeFields.FABRIC_HEIGHT", "MaterialRole.TOP_RAIL -> SizeFields.FABRIC_HEIGHT"));
  fails("roles", mutate(SRC, "lineItems", 'entry.role === "PANEL" || entry.role === "GATE_PANEL"', 'entry.role === "PANEL" || entry.role === "LINE_POST"'));
  fails("roles", mutate(SRC, "engine", "if (entry.role == MaterialRole.PANEL || entry.role == MaterialRole.GATE_PANEL) {", "if (entry.role == MaterialRole.PANEL || entry.role == MaterialRole.GATE_POST) {"));
  // the screen's shape
  fails("screenShape", mutate(SRC, "screen", "label = { Text(stringResource(R.string.cat_fabric_height_ft)) },", "label = { Text(stringResource(R.string.cat_height_ft)) },"));
  fails("screenShape", mutate(SRC, "screen", "stringResource(R.string.cat_supplier_none)", "stringResource(R.string.cat_default_price)"));
  fails("screenShape", mutate(SRC, "screen", "Column(modifier = Modifier.verticalScroll(rememberScrollState())) {", "Column {"));
  fails("screenShape", mutate(SRC, "screen", "if (size.heightMissing) sizeParts.add(stringResource(R.string.cat_size_height_missing))", ""));
  // strings
  fails("strings", { ...SRC, es: SRC.es.replace(/ *<string name="cat_height_hint">[^\n]*\n/, "") });
  fails("strings", { ...SRC, fr: SRC.fr + '\n<string name="cat_height_hint">Hauteur</string>\n' });
  fails("strings", { ...SRC, fr: SRC.fr.replace(/(<string name="cat_height_invalid">)[^<]*/, "$1" + stringValue(SRC.en, "cat_height_invalid")) });
  fails("strings", { ...SRC, fr: SRC.fr.replace(/(<string name="cat_height_hint">)[^<]*/, "$1Laissez vide si l'article ne l'indique pas.") });
  fails("strings", { ...SRC, en: SRC.en.replace('<string name="cat_supplier_named">Supplier: %1$s</string>', '<string name="cat_supplier_named">Supplier</string>') });
  // money
  fails("money", mutate(SRC, "fields", "internal fun supplierOf(item: MaterialItem, manufacturers: List<Manufacturer>): Manufacturer? =\n    manufacturers.firstOrNull { it.id == item.manufacturerId }", "internal fun supplierOf(item: MaterialItem, manufacturers: List<Manufacturer>): Manufacturer? =\n    manufacturers.firstOrNull { it.id == item.manufacturerId && item.unitPrice > 0.0 }"));
  fails("money", mutate(SRC, "screen", 'sizeParts.joinToString("  ·  ")', 'sizeParts.joinToString("  ·  ") + Money.format(item.unitPrice)'));
  fails("money", mutate(SRC, "main", /(composable\(Routes\.CATALOG\) \{\s*com\.fenceestimator\.app\.ui\.components\.AccessGuard\(\s*allowed = )session\.canEditCatalogAndSettings/, "$1true"));
  fails("money", mutate(SRC, "perms", "UserRole.CREW -> setOf(Permission.RECORD_FIELD_WORK)", "UserRole.CREW -> setOf(Permission.RECORD_FIELD_WORK, Permission.EDIT_CATALOG_AND_SETTINGS)"));
  fails("money", mutate(SRC, "sqlA40", "covers_ft, manufacturer_sync_id, is_active, source_doc, updated_at, deleted_at, deleted_by,\n       height_ft", "covers_ft, manufacturer_sync_id, is_active, source_doc, updated_at, deleted_at, deleted_by, unit_price,\n       height_ft"));
  fails("money", mutate(SRC, "sync", "unitPrice = if (scope == MoneyScope.ALLOWED) row.unitPrice else existing.unitPrice,", "unitPrice = row.unitPrice,"));
  // the hops
  fails("hops", mutate(SRC, "sync", "heightFt = it.heightFt", "heightFt = null"));
  fails("hops", mutate(SRC, "sync", /@SerialName\("height_ft"\) val heightFt: Float\? = null/, '@SerialName("height") val heightFt: Float? = null'));
  fails("hops", mutate(SRC, "repo", "materialDao.update(item.copy(lastUpdated = System.currentTimeMillis()))", "materialDao.update(item)"));
  fails("hops", mutate(SRC, "appdb", '"ALTER TABLE `material_items` ADD COLUMN `heightFt` REAL"', '"ALTER TABLE `material_items` ADD COLUMN `height` REAL"'));
  fails("hops", mutate(SRC, "engine", "c.heightFt == run.panelHeightFt ||", "c.coversFt == run.panelHeightFt ||"));
  // the limitation pair
  fails("clearing", mutate(SRC, "supa", "explicitNulls = false", "explicitNulls = true"));
  fails("clearing", mutate(SRC, "fields", "is HeightEntry.Blank -> if (saved != null) HeightProblem.CANNOT_BE_CLEARED else null", "is HeightEntry.Blank -> null"));
  // balance
  fails("balanced", mutate(SRC, "fields", "internal fun feetText(value: Float): String =", "internal fun feetText(value: Float): String = {"));
  fails("balanced", mutate(SRC, "screen", "private fun CatalogRow(", "private fun CatalogRow(("));
  // the price-job todo can tell the two cases apart, whichever one the repo is in today
  const has = /height_ft/.test(priceJobColumns(SRC.priceJob));
  const withHeight = has ? SRC.priceJob : mutate(SRC, "priceJob", '"unit_price, taxable, covers_ft, manufacturer_sync_id, is_active"', '"unit_price, taxable, covers_ft, height_ft, manufacturer_sync_id, is_active"').priceJob;
  const withoutHeight = has ? mutate(SRC, "priceJob", /covers_ft, height_ft,/, "covers_ft,").priceJob : SRC.priceJob;
  assert.match(priceJobColumns(withHeight), /height_ft/);
  assert.doesNotMatch(priceJobColumns(withoutHeight), /height_ft/);
});
