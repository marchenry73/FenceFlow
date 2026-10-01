// a40-height-carriers -- the height of a catalog row travels everywhere a catalog row travels, and both engines say the same thing.
//
// The Kotlin in this change could NOT be compiled when it was written (a release build was running and a second Gradle run was
// not allowed), so this file is the next best thing: it reads the Kotlin and the TypeScript as text and holds them to each other
// and to the SQL, with a mutant for every group of checks, so that a half-carried field (the Room column missing, the sync dropping
// it, the two engines drifting) fails here instead of on a phone. tests/a40-height-engine.test.mjs holds the BEHAVIOUR; this holds
// the PLUMBING.
//
//   1. THE FIELD, on every layer: TypeScript (types.ts, the wire row in index.ts, load.ts), Room (Entities.kt), the sync DTO and
//      its three pull copies and its push (EntitySync.kt), the Room migration (AppDatabase.kt, schema 49) and the SQL.
//   2. ITS OWN COMMENT says why it is not coversFt: width for PANEL and GATE_PANEL, HEIGHT for CHAIN_FABRIC.
//   3. THE TWO ENGINES, character for character where it counts: the same version, the same step, in the same place, with the
//      same roles and the same comparisons.
//   4. THE MIGRATION FILE: additive, nullable `real`, the crew door replaced with its live definition plus the one column and
//      nothing else, the one data write limited to fifteen named starting-list rows and tied to SeedData.kt.
//   5. ROOM: schema 49 is wired in with no gap in the chain, and its one statement builds the column the entity describes.
//   6. TEETH: every group above is a function of the sources it reads, and the last test feeds each one a mutant -- a pull copy
//      lost, a migration left out of the builder, a view that leaks unit_price -- which must fail it.
//
//   node --test tests/a40-height-carriers.test.mjs        (no network, no writes)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const KT = "app/src/main/java/com/fenceestimator/app/";
const TS = "supabase/functions/_shared/pricing/";
const SRC = {
  entities: read(KT + "data/Entities.kt"), appdb: read(KT + "data/AppDatabase.kt"), sync: read(KT + "cloud/EntitySync.kt"),
  engineKt: read(KT + "estimate/EstimateEngine.kt"), lineItems: read(TS + "line-items.ts"), types: read(TS + "types.ts"),
  index: read(TS + "index.ts"), load: read(TS + "load.ts"), sql: read("supabase_a40_material_height.sql"), seed: read(KT + "data/SeedData.kt"),
};
const mutate = (src, key, from, to) => {
  assert.ok(typeof from === "string" ? src[key].includes(from) : from.test(src[key]), `the mutation target is not in ${key}: ${String(from).slice(0, 70)}`);
  const next = src[key].replace(from, to);
  assert.notEqual(next, src[key], "the mutation changed nothing");
  return { ...src, [key]: next };
};

// ================================================================== readers ==
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
/** TypeScript with comments blanked (strings left whole). */
function stripTs(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '"' || c === "'" || c === "`") { let j = i + 1; while (j < src.length && src[j] !== c) { if (src[j] === "\\") j++; j++; } out += src.slice(i, j + 1); i = j + 1; continue; }
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; out += " "; continue; }
    out += c; i++;
  }
  return out;
}
const unescapeKt = (s) => s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (m, c) => c[0] === "u" ? String.fromCharCode(parseInt(c.slice(1), 16)) : ({ n: "\n", t: "\t", "\\": "\\", '"': '"', "'": "'", $: "$" }[c] ?? c));

/** The constructor parameter list of `data class <name>(` ... `)`, parenthesis-matched, comments stripped. */
function dataClassParams(code, name) {
  const at = code.indexOf("data class " + name + "(");
  assert.ok(at >= 0, "data class " + name + " not found");
  const open = code.indexOf("(", at);
  let depth = 0, j = open;
  for (; j < code.length; j++) { if (code[j] === "(") depth++; else if (code[j] === ")") { depth--; if (!depth) break; } }
  return code.slice(open + 1, j);
}
const paramNames = (params) => [...params.matchAll(/(?:^|\n)\s*(?:@\w+(?:\([^)]*\))?\s+)*val\s+(\w+)\s*:/g)].map((m) => m[1]);

/** The doc comment (/** ... *\/) immediately above the line that declares `needle`, with its own line breaks and asterisks flattened. */
function docAbove(src, needle) {
  const at = src.indexOf(needle);
  assert.ok(at >= 0, "not found: " + needle);
  const end = src.lastIndexOf("*/", at);
  const start = src.lastIndexOf("/**", end);
  assert.ok(start >= 0 && end > start && src.slice(end + 2, at).trim() === "", "no doc comment directly above " + needle);
  return src.slice(start, end).replace(/\s*\*\s*/g, " ").replace(/\s+/g, " ");
}

// ====================================================== 1. THE FIELD, EVERYWHERE ==

const checkTypeScript = (s) => {
  const item = s.types.match(/export interface MaterialItem \{([\s\S]*?)\r?\n\}/)[1];
  assert.match(item, /\bheightFt: number \| null;/, "MaterialItem has no heightFt: number | null");
  assert.match(item, /\bcoversFt: number \| null;/, "control: coversFt is still there beside it");
  assert.match(s.index, /\bheight_ft\?: number \| null;/, "the wire row (MaterialItemRow) has no optional height_ft");
  const adapter = stripTs(s.index).match(/export function materialItemFromRow[\s\S]*?\r?\n\}/)[0];
  assert.match(adapter, /heightFt: row\.height_ft === null \|\| row\.height_ft === undefined\s*\?\s*null\s*:\s*floatExact\(row\.height_ft, `catalog\[\$\{index\}\]\.height_ft`\)/, "materialItemFromRow does not carry height_ft as an exact Float");
  const loadCode = stripTs(s.load).match(/export function materialItemRowToInput[\s\S]*?\r?\n\}/)[0];
  assert.match(loadCode, /row\.height_ft === null \|\| row\.height_ft === undefined \? \{\} : \{ height_ft: f32\(row\.height_ft\) \}/, "load.ts does not carry height_ft (fround'd, and only when present)");
  // CONTROL: the same readers do see covers_ft, so a miss above is a miss and not a blind reader.
  assert.match(adapter, /coversFt: row\.covers_ft/);
  assert.match(loadCode, /covers_ft: row\.covers_ft/);
};
test("TypeScript: MaterialItem.heightFt, the wire row's optional height_ft, the adapter and load.ts", () => checkTypeScript(SRC));

const checkRoomEntity = (s) => {
  const params = dataClassParams(stripKt(s.entities), "MaterialItem");
  const names = paramNames(params);
  assert.equal(names[names.length - 1], "heightFt", "heightFt is not last: " + names.join(","));
  assert.match(params, /val heightFt: Float\? = null\s*$/, "heightFt is not a Float? defaulting to null");
  assert.ok(names.includes("coversFt") && names.indexOf("coversFt") < names.indexOf("heightFt"), "control: coversFt is in the same constructor, earlier");
};
test("Room: MaterialItem.heightFt is the LAST property, nullable, defaulted -- so no positional call moves", () => checkRoomEntity(SRC));

const checkComments = (s) => {
  const kt = docAbove(s.entities, "val heightFt: Float? = null");
  const ts = docAbove(s.types, "heightFt: number | null;");
  for (const [side, doc] of [["Entities.kt", kt], ["types.ts", ts]]) {
    assert.match(doc, /coversFt/, side + ": does not name coversFt");
    assert.match(doc, /WIDTH of a PANEL or GATE_PANEL/i, side + ": does not say coversFt is the width of a PANEL or GATE_PANEL");
    assert.match(doc, /HEIGHT of CHAIN_FABRIC/i, side + ": does not say coversFt is the height of CHAIN_FABRIC");
    assert.match(doc, /NAME/, side + ": does not say the name is never read");
  }
};
test("its own comment says why it is not coversFt: width for PANEL and GATE_PANEL, HEIGHT for CHAIN_FABRIC -- on both sides", () => checkComments(SRC));

const checkSync = (s) => {
  const code = stripKt(s.sync);
  const dto = dataClassParams(code, "CloudMaterialItem");
  const names = paramNames(dto);
  assert.equal(names[names.length - 1], "heightFt", "CloudMaterialItem.heightFt is not last: " + names.join(","));
  assert.match(dto, /@SerialName\("height_ft"\) val heightFt: Float\? = null\s*$/);
  const pushAt = code.indexOf("private suspend fun pushCatalog");
  const push = code.slice(pushAt, code.indexOf("private suspend fun pushPricingTiers", pushAt));
  assert.match(push, /CloudMaterialItem\(\s*companyId, it\.syncId[\s\S]*?it\.sourceDoc,\s*heightFt = it\.heightFt\s*\)/, "pushCatalog does not send heightFt (positional arguments, then the named one)");
  const pullAt = code.indexOf("private suspend fun pullCatalog");
  const pull = code.slice(pullAt, code.indexOf("private suspend fun pullJobChildren", pullAt));
  assert.equal([...pull.matchAll(/coversFt = row\.coversFt,/g)].length, 3, "control: the pull copies coversFt in three places");
  assert.equal([...pull.matchAll(/coversFt = row\.coversFt,\s*heightFt = row\.heightFt,/g)].length, 3, "every pull copy that takes coversFt must take heightFt beside it");
};
test("the sync: the DTO field is last with a null default, the push sends it, and all three pull copies take it", () => checkSync(SRC));

// ================================================================= 2. TWO ENGINES ==

const checkVersions = (s) => {
  const ts = s.index.match(/export const PRICING_ENGINE_VERSION = "([^"]+)";/)[1];
  const kt = s.engineKt.match(/const val PRICING_ENGINE_VERSION = "([^"]+)"/)[1];
  assert.equal(kt, ts, "the two engines disagree on their own version");
  assert.equal(ts, "2026.10.2");
  assert.notEqual(ts, "2026.10.1");
  // The comment on each says what moved, so the next reader is not left to guess why the number changed.
  for (const [side, src] of [["index.ts", s.index], ["EstimateEngine.kt", s.engineKt]])
    assert.match(src, /Bumped 2026\.10\.1 -> 2026\.10\.2 \(1 Oct 2026\) for panel height/, side + ": the version comment does not say why it moved");
};
test("both engines carry the SAME new version, and it moved off 2026.10.1", () => checkVersions(SRC));

/** The height step of each engine, comments stripped. */
function heightStepTs(s) {
  const code = stripTs(s.lineItems);
  const a = code.indexOf('if (entry.role === "PANEL" || entry.role === "GATE_PANEL") {');
  const b = code.indexOf("let chosen: MaterialItem | null;", a);
  assert.ok(a > 0 && b > a, "TypeScript height step not found");
  return code.slice(a, b);
}
function heightStepKt(s) {
  const code = stripKt(s.engineKt);
  const a = code.indexOf("if (entry.role == MaterialRole.PANEL || entry.role == MaterialRole.GATE_PANEL) {");
  const b = code.indexOf("val chosen = if (entry.preferCoversFt != null)", a);
  assert.ok(a > 0 && b > a, "Kotlin height step not found");
  return code.slice(a, b);
}
/** Both languages, spelled the same: no whitespace, `===` as `==`, strings and enum prefixes gone, lambda and declaration syntax unified. */
const canon = (t) => t.replace(/\s+/g, "")
  .replace(/===/g, "==").replace(/"/g, "").replace(/MaterialRole\./g, "")
  .replace(/\.filter\(\(c\)=>/g, ".filter{c->").replace(/\(d\)=>/g, "{d->").replace(/constcurrent=/g, "valcurrent=")
  .replace(/!current\.some\(\{d->/g, "current.none{d->")
  .replace(/\)\);\}$/, "}}}").replace(/;/g, "");

const checkSameStep = (s) => {
  const ts = heightStepTs(s), kt = heightStepKt(s);
  for (const [side, step, role] of [["TypeScript", ts, /entry\.role === "PANEL" \|\| entry\.role === "GATE_PANEL"/], ["Kotlin", kt, /entry\.role == MaterialRole\.PANEL \|\| entry\.role == MaterialRole\.GATE_PANEL/]]) {
    assert.match(step, role, side + ": the role gate differs");
    assert.match(step.replace(/\s+/g, " "), /c\.heightFt (===|==) run\.panelHeightFt \|\|/, side + ": a row of the run's height must survive on its own");
    assert.match(step.replace(/\s+/g, " "), /d\.coversFt (===|==) c\.coversFt && d\.heightFt (===|==) run\.panelHeightFt/, side + ": the same-width, declared-height test differs");
    assert.ok(!/\b(isNotEmpty|length > 0|isEmpty)\b/.test(step), side + ": the step must never need an emptiness check -- a matching row cannot set itself aside");
  }
  assert.ok(/!current\.some\(/.test(ts) && /current\.none \{/.test(kt), "the quantifier: `not some` in TypeScript is `none` in Kotlin");
  assert.equal(canon(ts), canon(kt), "the two height steps are not the same step\n  TS: " + canon(ts) + "\n  KT: " + canon(kt));
};
test("the height step is the same step on both sides: same roles, same comparisons, same quantifier", () => checkSameStep(SRC));

const checkPlacement = (s) => {
  const order = (code, marks) => {
    const at = marks.map((m) => code.indexOf(m));
    assert.ok(at.every((x) => x > 0), "a landmark is missing: " + marks[at.indexOf(-1)]);
    assert.deepEqual(at, [...at].sort((x, y) => x - y), "out of order: " + marks.join(" < "));
  };
  const tsCode = stripTs(s.lineItems), ktCode = stripKt(s.engineKt);
  order(tsCode, ["const colorMatches", "const manufacturerMatches", 'entry.role === "PANEL" || entry.role === "GATE_PANEL"', "let chosen: MaterialItem | null;"]);
  order(ktCode, ["val colorMatches", "val manufacturerMatches", "entry.role == MaterialRole.PANEL || entry.role == MaterialRole.GATE_PANEL", "val chosen = if (entry.preferCoversFt != null)"]);
  // Immediately after: nothing sits between the manufacturer step and the height step but its closing brace.
  const gapTs = tsCode.slice(tsCode.indexOf("if (manufacturerMatches.length > 0) candidates = manufacturerMatches;"), tsCode.indexOf('if (entry.role === "PANEL"'));
  const gapKt = ktCode.slice(ktCode.indexOf("if (manufacturerMatches.isNotEmpty()) candidates = manufacturerMatches"), ktCode.indexOf("if (entry.role == MaterialRole.PANEL"));
  assert.equal(gapTs.replace(/\s+/g, ""), "if(manufacturerMatches.length>0)candidates=manufacturerMatches;}", "something sits between the manufacturer step and the height step (TypeScript)");
  assert.equal(gapKt.replace(/\s+/g, ""), "if(manufacturerMatches.isNotEmpty())candidates=manufacturerMatches}", "something sits between the manufacturer step and the height step (Kotlin)");
};
test("the step sits where colour and manufacturer are, immediately after them and before the choice -- on both sides", () => checkPlacement(SRC));

// ============================================================= 3. THE MIGRATION ==

const code = (sql) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

const checkMigrationShape = (s) => {
  const sql = s.sql, c = code(sql);
  assert.match(sql, /STATUS: WRITTEN, NOT APPLIED\./);
  assert.match(c, /^\s*begin;/m);
  assert.match(c, /^\s*commit;/m);
  assert.match(c, /alter table public\.material_items add column if not exists height_ft real;/, "PART 1 is not a nullable `real` column added if missing");
  const part1 = c.match(/alter table public\.material_items add column[^;]*;/)[0];
  assert.ok(!/not null|default/i.test(part1), "the column must be nullable with no default: NULL means 'the row does not say'");
  // Nothing destructive, and nothing that touches a policy, grant, trigger or function.
  const stripped = c.replace(/\$a40_(guard|check)\$[\s\S]*?\$a40_\1\$/g, " DO ");
  for (const bad of [/\bdrop\b/i, /\bdelete\b/i, /\btruncate\b/i, /\bgrant\b/i, /\brevoke\b/i, /\bcreate (or replace )?(policy|trigger|function)\b/i, /\balter (policy|function|table [^;]* (drop|alter column|disable|enable))/i])
    assert.ok(!bad.test(stripped), "the migration contains " + bad);
  assert.ok(!/@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(sql), "an e-mail address in the migration");
  assert.ok(!/ZZ TEST|company_id\s*=\s*'[0-9a-f-]{36}'/i.test(sql), "a company is named in the migration");
  assert.equal((c.match(/\bupdate public\./g) || []).length, 1, "the migration must hold exactly one UPDATE");
};
test("the migration is written, NOT applied, additive, and says so", () => checkMigrationShape(SRC));

const LIVE_CREW_COLUMNS = ["id", "company_id", "sync_id", "name", "category", "role", "fence_type", "color_or_finish", "unit", "taxable", "covers_ft", "manufacturer_sync_id", "is_active", "source_doc", "updated_at", "deleted_at", "deleted_by"];
const checkCrewDoor = (s) => {
  const c = code(s.sql);
  // The live columns were read on 1 Oct 2026 (pg_attribute, in order). The guard in the file holds the same list; both must say it.
  const guard = c.match(/\$a40_guard\$[\s\S]*?\$a40_guard\$/)[0];
  const guardCols = [...guard.match(/want constant text\[\] := array\[([\s\S]*?)\];/)[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(guardCols, LIVE_CREW_COLUMNS, "the guard's column list is not the live view's");
  const view = c.match(/create or replace view public\.material_items_crew\s+with \(security_barrier = true, security_invoker = false\) as\s+select ([\s\S]*?)\s+from public\.material_items\s+where company_id = public\.current_company_id\(\) and not public\.company_is_suspended\(\);/);
  assert.ok(view, "the view is not `create or replace` with both live options, selecting from material_items under the live WHERE");
  const cols = view[1].split(",").map((x) => x.trim());
  assert.deepEqual(cols, [...LIVE_CREW_COLUMNS, "height_ft"], "the view's select list is not the live one plus height_ft last");
  assert.ok(!cols.includes("unit_price") && !cols.includes("supplier_sku"), "the crew door must stay free of unit_price and supplier_sku");
  for (const must of [/raise exception 'a40: public\.material_items_crew does not exist/, /raise exception 'a40: material_items_crew has columns this file was not written against/, /raise exception 'a40: material_items_crew options are not exactly/,
    /raise exception 'a40: height_ft is not the last column/, /raise exception 'a40: the crew door lost an option when it was replaced/, /raise exception 'a40: the crew door carries a column it must not/, /raise exception 'a40: the crew door is more open than it was/])
    assert.match(c, must);
  assert.match(guard, /have is distinct from want and have is distinct from \(want \|\| array\['height_ft'\]::text\[\]\)/);
  assert.match(guard, /opts @> array\['security_barrier=true', 'security_invoker=false'\]/);
};
test("PART 2: the crew door is its live definition plus height_ft LAST, with its live options, guarded both ways", () => checkCrewDoor(SRC));

/** SeedData.kt's PANEL / GATE_PANEL rows, and PART 3's identities. */
function seedPanelRows(seed) {
  const k = stripKt(seed);
  const rows = []; let t = null;
  for (const line of k.split("\n")) {
    const ft = line.match(/val t = FenceType\.(\w+)/); if (ft) t = ft[1];
    const m = line.match(/\bitem\(\s*MaterialCategory\.\w+,\s*MaterialRole\.(PANEL|GATE_PANEL),\s*(?:FenceType\.(\w+)|(t)),\s*"((?:[^"\\]|\\.)*)"/);
    if (!m) continue;
    const cov = line.match(/coversFt = ([0-9.]+)f/);
    rows.push({ role: m[1], fence_type: m[2] || t, name: unescapeKt(m[4]), covers_ft: cov ? Number(cov[1]) : null });
  }
  return rows;
}
function migrationHeights(sql) {
  const c = code(sql);
  const from = c.indexOf("update public.material_items m"), to = c.indexOf(") as v(name, role, fence_type, h)");
  assert.ok(from > 0 && to > from, "PART 3 not found");
  return [...c.slice(from, to).matchAll(/\(\s*'((?:[^']|'')*)'\s*,\s*'(\w+)'\s*,\s*'(\w+)'\s*,\s*(\d+(?:\.\d+)?)::real\s*\)/g)]
    .map((m) => ({ name: m[1].replace(/''/g, "'"), role: m[2], fence_type: m[3], h: Number(m[4]) }));
}
const checkPart3 = (s) => {
  const seed = seedPanelRows(s.seed), list = migrationHeights(s.sql);
  assert.equal(seed.length, 15, "control: the seed reader found " + seed.length + " PANEL / GATE_PANEL rows, expected 15");
  const key = (r) => r.name + "|" + r.role + "|" + r.fence_type;
  assert.deepEqual(list.map(key).sort(), seed.map(key).sort(), "PART 3 is not the starting list's panel and gate-panel rows: a row is missing from it, or it names one the seed does not ship");
  assert.equal(new Set(list.map(key)).size, list.length, "a row is listed twice");
  // The ONE place this suite reads a product name for a height: to check the hand-entered list against it, once. The engines never do.
  for (const r of list) {
    const stated = r.name.match(/(\d+(?:\.\d+)?)'H/);
    assert.ok(stated, "no height stated in the name of " + r.name);
    assert.equal(r.h, Number(stated[1]), `${r.name}: PART 3 says ${r.h} ft, the name says ${stated[1]}`);
    const width = r.name.match(/(\d+(?:\.\d+)?)'W/);
    assert.equal(Number(width[1]), seed.find((x) => key(x) === key(r)).covers_ft, `${r.name}: the name's width is not the row's covers_ft`);
  }
  const c = code(s.sql);
  const upd = c.slice(c.indexOf("update public.material_items m"), c.indexOf("commit;"));
  assert.match(upd, /set height_ft = v\.h/);
  assert.match(upd, /where m\.name = v\.name and m\.role = v\.role and m\.fence_type = v\.fence_type\s+and m\.height_ft is null and m\.deleted_at is null;/, "PART 3 must only fill an empty height on a live row");
};
test("PART 3 is exactly the starting list's panels and gate panels, by name, role and fence type, each with the height its name states, and fills only an empty height", () => checkPart3(SRC));

test("no other repo-root SQL file defines height_ft, so there is one owner of the column", () => {
  const others = readdirSync(ROOT).filter((f) => /^supabase.*\.sql$/.test(f) && f !== "supabase_a40_material_height.sql")
    .filter((f) => /\bheight_ft\b/.test(code(readFileSync(join(ROOT, f), "utf8")).replace(/panel_height_ft|fabric_height_ft/g, "")));
  assert.deepEqual(others, [], "another migration mentions height_ft: " + others.join(", "));
});

// ================================================================== 4. ROOM ==

const checkRoomChain = (s) => {
  const k = stripKt(s.appdb);
  assert.match(k, /version = 49,/, "the database version is not 49");
  assert.match(k, /private val MIGRATION_48_49 = object : Migration\(48, 49\)/);
  assert.match(k, /SchemaV49\.MIGRATION_48_49_STATEMENTS\.forEach \{ db\.execSQL\(it\) \}/, "MIGRATION_48_49 does not run SchemaV49's statements");
  const declared = [...k.matchAll(/private val MIGRATION_(\d+)_(\d+) = object : Migration\((\d+), (\d+)\)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]);
  for (const [a, b, c, d] of declared) assert.deepEqual([a, b], [c, d], `MIGRATION_${a}_${b} is declared as Migration(${c}, ${d})`);
  assert.deepEqual(declared.map((x) => x[0]), Array.from({ length: 45 }, (_, i) => i + 4), "the declared migrations are not exactly 4_5 ... 48_49");
  const added = k.match(/\.addMigrations\(([^)]*)\)/)[1].split(",").map((x) => x.trim());
  assert.deepEqual(added, declared.map(([a, b]) => `MIGRATION_${a}_${b}`), "the builder does not hand over every declared migration exactly once, in order");
  // 48 shipped (or may have): its statements are the four it always had.
  const v48 = k.match(/internal object SchemaV48 \{[\s\S]*?\r?\n\}/)[0];
  assert.equal((v48.match(/"CREATE /g) || []).length, 4, "SchemaV48 changed: a build at 48 may already exist, so a change belongs in 49");
  assert.ok(!/material_items/.test(v48), "SchemaV48 touches material_items: the column belongs in SchemaV49");
};
test("Room: schema 49 is wired in, the chain 4 -> 49 has no gap and no repeat, and 48 was left as it shipped", () => checkRoomChain(SRC));

const checkRoomStatement = (s) => {
  const k = stripKt(s.appdb);
  const v49 = k.match(/internal object SchemaV49 \{[\s\S]*?\r?\n\}/)[0];
  const stmts = [...v49.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  assert.deepEqual(stmts, ["ALTER TABLE `material_items` ADD COLUMN `heightFt` REAL"], "SchemaV49 is not exactly the one ALTER");
  // Run it for real against a table in the shape the entity had at 48, and read the column back the way Room reads it.
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE `material_items` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `name` TEXT NOT NULL, `coversFt` REAL)");
  db.exec("INSERT INTO material_items (name, coversFt) VALUES ('Existing row', 6.0)");
  db.exec(stmts[0]);
  const col = db.prepare("PRAGMA table_info(material_items)").all().find((c) => c.name === "heightFt");
  assert.ok(col, "the column was not added");
  assert.deepEqual({ type: col.type, notnull: col.notnull, dflt: col.dflt_value }, { type: "REAL", notnull: 0, dflt: null }, "Room expects Float? as REAL, nullable, no default");
  assert.equal(db.prepare("SELECT heightFt FROM material_items").get().heightFt, null, "an existing row must read NULL: 'the row does not say'");
  // The entity says what Room will expect, so the two are held to each other here and not on a phone.
  assert.match(dataClassParams(stripKt(s.entities), "MaterialItem"), /val heightFt: Float\? = null/);
};
test("Room: SchemaV49's one statement builds the nullable REAL column a Float? entity field needs", () => {
  checkRoomStatement(SRC);
  // CONTROL: the comparison would see a NOT NULL column.
  const bad = new DatabaseSync(":memory:"); bad.exec("CREATE TABLE t (id INTEGER)"); bad.exec("ALTER TABLE t ADD COLUMN heightFt REAL NOT NULL DEFAULT 0");
  assert.notEqual(bad.prepare("PRAGMA table_info(t)").all().find((c) => c.name === "heightFt").notnull, 0, "control: the reader cannot see NOT NULL");
});

// ============================================================== 5. TEETH ==

const KT_STEP_MUT = (s, from, to) => mutate(s, "engineKt", from, to);

test("TEETH: the real sources pass every group, and each mutant of the plumbing fails the group built for it", () => {
  const groups = { checkTypeScript, checkRoomEntity, checkComments, checkSync, checkVersions, checkSameStep, checkPlacement, checkMigrationShape, checkCrewDoor, checkPart3, checkRoomChain, checkRoomStatement };
  for (const [name, check] of Object.entries(groups)) assert.doesNotThrow(() => check(SRC), name);

  const mutants = [
    // TypeScript carriers
    ["types.ts loses the field", checkTypeScript, mutate(SRC, "types", /\r?\n  heightFt: number \| null;/, "")],
    ["load.ts stops carrying height_ft", checkTypeScript, mutate(SRC, "load", "...(row.height_ft === null || row.height_ft === undefined ? {} : { height_ft: f32(row.height_ft) }),", "")],
    ["index.ts reads height_ft without the Float check", checkTypeScript, mutate(SRC, "index", "floatExact(row.height_ft, `catalog[${index}].height_ft`)", "row.height_ft")],
    // Room
    ["Entities.kt: heightFt is no longer last", checkRoomEntity, mutate(SRC, "entities", /val heightFt: Float\? = null\r?\n\)/, "val heightFt: Float? = null,\r\n    val extra: Int = 0\r\n)")],
    ["Entities.kt: heightFt is not nullable", checkRoomEntity, mutate(SRC, "entities", "val heightFt: Float? = null", "val heightFt: Float = 0f")],
    ["Entities.kt: the comment forgets CHAIN_FABRIC", checkComments, mutate(SRC, "entities", /and the\r?\n\s+\* HEIGHT of CHAIN_FABRIC;/, "and nothing else;")],
    // The sync
    ["EntitySync: one pull copy forgets heightFt", checkSync, mutate(SRC, "sync", "                    coversFt = row.coversFt,\n                    heightFt = row.heightFt,", "                    coversFt = row.coversFt,")],
    ["EntitySync: the push forgets heightFt", checkSync, mutate(SRC, "sync", ",\n                heightFt = it.heightFt", "")],
    ["EntitySync: the DTO field is not last", checkSync, mutate(SRC, "sync", '@SerialName("height_ft") val heightFt: Float? = null', '@SerialName("height_ft") val heightFt: Float? = null,\n    val extra: String? = null')],
    // Versions and the step
    ["Kotlin keeps the old version", checkVersions, KT_STEP_MUT(SRC, 'const val PRICING_ENGINE_VERSION = "2026.10.2"', 'const val PRICING_ENGINE_VERSION = "2026.10.1"')],
    ["TypeScript keeps the old version", checkVersions, mutate(SRC, "index", 'export const PRICING_ENGINE_VERSION = "2026.10.2";', 'export const PRICING_ENGINE_VERSION = "2026.10.1";')],
    ["TS: === becomes !==", checkSameStep, mutate(SRC, "lineItems", "c.heightFt === run.panelHeightFt", "c.heightFt !== run.panelHeightFt")],
    ["TS: the role gate loses GATE_PANEL", checkSameStep, mutate(SRC, "lineItems", ' || entry.role === "GATE_PANEL") {\r\n      const current', ") {\r\n      const current")],
    ["KT: none becomes any", checkSameStep, KT_STEP_MUT(SRC, "current.none {", "current.any {")],
    ["KT: the width comparison goes", checkSameStep, KT_STEP_MUT(SRC, "d.coversFt == c.coversFt && ", "")],
    ["KT: the step moves above the manufacturer step", checkPlacement, (() => {
      const k = SRC.engineKt, a = k.indexOf("            // Height, for the two roles"), b = k.indexOf("            val chosen = if (entry.preferCoversFt != null)");
      const block = k.slice(a, b), c0 = k.indexOf("            if (preferredManufacturerId != null) {");
      assert.ok(a > 0 && b > a && c0 > 0 && c0 < a);
      return { ...SRC, engineKt: k.slice(0, c0) + block + k.slice(c0, a) + k.slice(b) };
    })()],
    // The SQL
    ["SQL: the column is NOT NULL", checkMigrationShape, mutate(SRC, "sql", "add column if not exists height_ft real;", "add column if not exists height_ft real not null default 0;")],
    ["SQL: a DROP sneaks in", checkMigrationShape, mutate(SRC, "sql", "commit;\n", "drop view public.material_items_crew;\ncommit;\n")],
    ["SQL: the crew view leaks unit_price", checkCrewDoor, mutate(SRC, "sql", "covers_ft, manufacturer_sync_id, is_active, source_doc, updated_at, deleted_at, deleted_by,\n       height_ft", "covers_ft, manufacturer_sync_id, is_active, source_doc, updated_at, deleted_at, deleted_by, unit_price,\n       height_ft")],
    ["SQL: the crew view loses an option", checkCrewDoor, mutate(SRC, "sql", "with (security_barrier = true, security_invoker = false) as", "with (security_barrier = true) as")],
    ["SQL: the guard stops checking the options", checkCrewDoor, mutate(SRC, "sql", "opts @> array['security_barrier=true', 'security_invoker=false']", "true")],
    ["SQL: the post-check stops checking the options", checkCrewDoor, mutate(SRC, "sql", "raise exception 'a40: the crew door lost an option when it was replaced (%)', opts;", "null;")],
    ["SQL: PART 3 forgets a row", checkPart3, mutate(SRC, "sql", /\s+\('Ornamental Steel Panel 6''H x 6''W, Black',[^\n]*\n/, "\n")],
    ["SQL: PART 3 types a height wrong", checkPart3, mutate(SRC, "sql", /(6''H x 6''W, Black',\s+'PANEL',\s+'ORNAMENTAL_IRON', )6::real/, (m, head) => head + "4::real")],
    ["SQL: PART 3 may overwrite a typed height", checkPart3, mutate(SRC, "sql", "and m.height_ft is null and m.deleted_at is null;", "and m.deleted_at is null;")],
    // Room's chain
    ["Room: the version stays 48", checkRoomChain, mutate(SRC, "appdb", "version = 49,", "version = 48,")],
    ["Room: 48 -> 49 is not handed to the builder", checkRoomChain, mutate(SRC, "appdb", "MIGRATION_47_48, MIGRATION_48_49)", "MIGRATION_47_48)")],
    ["Room: the column went into SchemaV48 instead", checkRoomChain, mutate(SRC, "appdb", "\"CREATE UNIQUE INDEX IF NOT EXISTS `index_run_joins_syncId` ON `run_joins` (`syncId`)\"", "\"CREATE UNIQUE INDEX IF NOT EXISTS `index_run_joins_syncId` ON `run_joins` (`syncId`)\",\n        \"ALTER TABLE `material_items` ADD COLUMN `heightFt` REAL\"")],
    ["Room: the statement makes the column NOT NULL", checkRoomStatement, mutate(SRC, "appdb", "ADD COLUMN `heightFt` REAL\"", "ADD COLUMN `heightFt` REAL NOT NULL DEFAULT 0\"")],
  ];
  assert.ok(mutants.length >= 25, "the mutant list shrank to " + mutants.length);
  for (const [label, check, sources] of mutants) assert.throws(() => check(sources), undefined, `NOT CAUGHT: ${label}`);
});
