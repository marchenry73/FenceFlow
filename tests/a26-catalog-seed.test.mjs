// a26-catalog-seed -- supabase_r20_seed_new_company_catalog.sql is the phone's starting list, and safe.
//
// WHAT THIS PINS
//   1. The 92 rows the SQL writes are the rows SeedData.kt (the phone) and CATALOG_SEED in dashboard.html (the office)
//      carry, column for column, with ONE documented deviation: the four rows the owner's own A1 correction fixed are
//      seeded taxable = true. The test allows exactly those four booleans and nothing else, and fails on any other drift
//      in either direction (a row, a price, a label, a role).
//   2. The SQL is what its header says: a dry run that ends in ROLLBACK, an apply block that is the SAME text as the
//      dry run's change, a reverse that deletes no data, no COMMIT anywhere that runs, no bypass role named anywhere,
//      no destructive statement in the change, and every probe run as `authenticated` or `anon`.
//   3. The change has the properties the dry run relies on: an AFTER INSERT trigger on companies (so every creation
//      path is covered), a guard that leaves a company that ever held a row alone, EXECUTE revoked from the callers a
//      stranger could be, a trigger function that cannot stop a sign-up.
//   4. The phone's SeedData.kt points at this file.
//
// EVERY EXTRACTOR HAS TEETH: the same analysis is run on a copy with one thing broken and must complain. A checker that
// finds nothing wrong because it cannot read the file reports exactly what a checker on a clean file reports.
//
//   node --test tests/a26-catalog-seed.test.mjs                  STATIC (no network)
//   A26_LIVE=1 node --test tests/a26-catalog-seed.test.mjs       + runs PART 1 against production (it ROLLS BACK), then
//                                                                asks a separate query whether anything survived
//
// LIVE never writes: the file's PART 1 is one transaction that ends in ROLLBACK, every probe in it runs as `authenticated`
// or `anon` with a synthetic user's claims, no bypass role is named, the real third-party companies are only counted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const SQL_REL = "supabase_r20_seed_new_company_catalog.sql";
const SQL = read(SQL_REL);
const SEED_KT = read("app/src/main/java/com/fenceestimator/app/data/SeedData.kt");
const DASH = read("website/dashboard.html");
const PROJECT = "newcrgafcptspmapacrx";
const LIVE = process.env.A26_LIVE === "1";
const SKIP_LIVE = LIVE ? false : "set A26_LIVE=1 to run PART 1 against production (rolled back)";

// The four rows supabase_r9_taxable_panels.sql corrected on the owner's live catalog, and the ONLY deviation allowed.
const A1_ROWS = new Set([
  "Panel T&G Vinyl Privacy 6'H x 6'W - White", "Panel T&G Vinyl Privacy 6'H x 6'W - Tan",
  "Panel T&G Vinyl Privacy 6'H x 6'W - Gray", "Regular PVC Gate 6'H x 5'W, White",
]);
const COLS = ["category", "role", "fence_type", "name", "unit", "unit_price", "taxable", "covers_ft", "color_or_finish"];
const rowKey = (r) => [r.fence_type, r.role, r.name].join("|");

// ===================================================================== readers ==

/** Index of the bracket that closes the one at openIdx, skipping string literals. */
function matchClose(text, openIdx) {
  const open = text[openIdx];
  const close = { "(": ")", "[": "]", "{": "}" }[open];
  let depth = 0;
  for (let j = openIdx; j < text.length; j++) {
    const c = text[j];
    if (c === '"' || c === "'" && open === "[") { const q = c; j++; while (text[j] !== q) { if (text[j] === "\\") j++; j++; } continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (!depth) return j; }
  }
  throw new Error("unbalanced bracket from " + openIdx);
}

const unescapeKt = (s) => s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (m, c) =>
  c[0] === "u" ? String.fromCharCode(parseInt(c.slice(1), 16)) : ({ n: "\n", t: "\t", "\\": "\\", '"': '"', "'": "'", $: "$" }[c] ?? c));

/** SeedData.materialItems(), read off the item(...) calls of each *Items() builder. Also returns the SEEDED label. */
function readKotlin(kt) {
  const consts = Object.fromEntries([...kt.matchAll(/const val ([A-Za-z_]\w*)\s*=\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1], unescapeKt(m[2])]));
  const starts = [...kt.matchAll(/private fun (\w+Items)\(\): List<MaterialItem> (?:=|\{)/g)].map((m) => m.index);
  const rows = [];
  starts.forEach((at, i) => {
    const body = kt.slice(at, i + 1 < starts.length ? starts[i + 1] : kt.length);
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

/** CATALOG_SEED, evaluated. */
function readOffice(dash) {
  const at = dash.indexOf("const CATALOG_SEED");
  const open = dash.indexOf("[", at);
  return new Function("return (" + dash.slice(open, matchClose(dash, open) + 1) + ");")();
}

/** What Postgres would actually run: comments removed the way its lexer does it. A line comment ends at the newline and may
 *  contain a block opener; block comments NEST; strings, including $tag$ ... $tag$ bodies, are kept whole and may contain
 *  either. A regex that strips block comments first mistakes a quoted marker inside a line comment for the start of one. */
function executable(sql) {
  let out = "", i = 0;
  while (i < sql.length) {
    const c = sql[i], d = sql[i + 1];
    if (c === "-" && d === "-") { while (i < sql.length && sql[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") {
      let depth = 1; i += 2;
      while (i < sql.length && depth) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
      out += " "; continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      out += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 40));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        assert.ok(end > 0, "unterminated " + m[0]);
        out += sql.slice(i, end + m[0].length); i = end + m[0].length; continue;
      }
    }
    out += c; i++;
  }
  return out;
}

/** The text between the two THE CHANGE markers, for the dry run (first pair) and the apply block (second). */
function changeBlocks(sql) {
  const out = [];
  const re = /-- ==== THE CHANGE: BEGIN ====\n([\s\S]*?)\n-- ==== THE CHANGE: END ====/g;
  let m;
  while ((m = re.exec(sql))) out.push(m[1]);
  return out;
}

/** The seeded tuples of the VALUES list inside a change block. */
function parseValues(change) {
  const from = change.indexOf("from (values");
  assert.ok(from >= 0, "no VALUES list in the change");
  const to = change.indexOf(") as v(", from);
  const body = change.slice(from + "from (values".length, to);
  const rows = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\s--.*$/, "").trim();
    if (!line.startsWith("(")) continue;
    // fields: 'text' x5, number, bool, number|null, 'text'
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
        f.push({ t: "s", v: s }); i = j + 1;
      } else {
        let j = i; while (j < line.length && line[j] !== "," && line[j] !== ")") j++;
        f.push({ t: "x", v: line.slice(i, j).trim() }); i = j;
      }
    }
    assert.equal(f.length, 9, "a VALUES tuple with " + f.length + " fields: " + line.slice(0, 80));
    rows.push({
      category: f[0].v, role: f[1].v, fence_type: f[2].v, name: f[3].v, unit: f[4].v, unit_price: Number(f[5].v),
      taxable: f[6].v === "true", covers_ft: f[7].v === "null" ? null : Number(f[7].v), color_or_finish: f[8].v,
    });
  }
  return rows;
}

const canonicalMd5 = (rows, label) => createHash("md5").update(
  [...rows].sort((a, b) => (a.fence_type < b.fence_type ? -1 : a.fence_type > b.fence_type ? 1 : a.role < b.role ? -1 : a.role > b.role ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((r) => [r.fence_type, r.role, r.category, r.name, r.unit, String(r.unit_price), String(r.taxable), r.covers_ft === null ? "" : String(r.covers_ft), r.color_or_finish, label].join("|"))
    .join("\n"), "utf8").digest("hex");

/** Everything wrong with a seed SQL text, as a list of strings. Empty means clean. */
function problems(sql, kotlin, office) {
  const bad = [];
  const blocks = changeBlocks(sql);
  if (blocks.length !== 2) return ["expected two THE CHANGE blocks (dry run, apply), found " + blocks.length];
  if (blocks[0] !== blocks[1]) bad.push("the apply block is not the same text as the dry run's change");
  const rows = parseValues(blocks[0]);
  if (rows.length !== 92) bad.push("expected 92 rows, found " + rows.length);
  if (new Set(rows.map(rowKey)).size !== rows.length) bad.push("(fence_type, role, name) is not unique");
  const label = (blocks[0].match(/^\s+'(Starting price[^']*)'\s*$/m) || [])[1];
  if (label !== kotlin.seeded) bad.push("label " + JSON.stringify(label) + " is not SeedData.SEEDED " + JSON.stringify(kotlin.seeded));
  for (const [who, ref] of [["SeedData.kt", kotlin.rows], ["dashboard.html CATALOG_SEED", office]]) {
    const refMap = new Map(ref.map((r) => [rowKey(r), r]));
    for (const r of rows) {
      const o = refMap.get(rowKey(r));
      if (!o) { bad.push(`row not in ${who}: ${rowKey(r)}`); continue; }
      for (const c of COLS) {
        if (String(o[c] ?? null) === String(r[c] ?? null)) continue;
        const allowed = c === "taxable" && A1_ROWS.has(r.name) && o.taxable === false && r.taxable === true;
        if (!allowed) bad.push(`${who} differs at ${rowKey(r)} :: ${c}: ${JSON.stringify(o[c])} vs SQL ${JSON.stringify(r[c])}`);
      }
      if (o.source_doc !== undefined && o.source_doc !== label) bad.push(`${who} label differs at ${rowKey(r)}`);
    }
    for (const r of ref) if (!rows.some((x) => rowKey(x) === rowKey(r))) bad.push(`row missing from SQL but in ${who}: ${rowKey(r)}`);
  }
  for (const n of A1_ROWS) if (rows.find((r) => r.name === n)?.taxable !== true) bad.push("A1 row is not seeded taxable: " + n);
  // the constants the dry run checks against
  const sums = [...sql.matchAll(/'([0-9a-f]{32})'/g)].map((m) => m[1]);
  if (new Set(sums).size !== 1) bad.push("the dry run carries " + new Set(sums).size + " different checksums");
  else if (sums[0] !== canonicalMd5(rows, label)) bad.push("the dry run's checksum is not the checksum of the rows it writes");
  const hex = (sql.match(/label_hex constant text := '([0-9a-f]+)'/) || [])[1];
  if (hex !== Buffer.from(label ?? "", "utf8").toString("hex")) bad.push("label_hex is not the hex of the label");
  return bad;
}

const KOTLIN = readKotlin(SEED_KT);
const OFFICE = readOffice(DASH);

// ================================================================ 0. HARNESS ==

test("harness: the readers find the phone's 92 rows, the office's 92 rows and the SQL's 92 rows", () => {
  assert.equal(KOTLIN.rows.length, 92, "SeedData.kt");
  assert.equal(OFFICE.length, 92, "CATALOG_SEED");
  const perType = KOTLIN.rows.reduce((m, r) => ((m[r.fence_type] = (m[r.fence_type] || 0) + 1), m), {});
  assert.deepEqual(perType, { VINYL: 19, WOOD: 10, CHAIN_LINK: 18, ALUMINUM: 14, ORNAMENTAL_IRON: 11, SPLIT_RAIL: 8, COMPOSITE: 10, UNIVERSAL: 2 });
  assert.equal(KOTLIN.seeded, "Starting price \u2014 verify with your supplier", "control: the label constant was read");
  const blocks = changeBlocks(SQL);
  assert.equal(blocks.length, 2);
  assert.equal(parseValues(blocks[0]).length, 92);
  assert.ok(blocks[0].length > 5000, "the change block was captured whole");
});

test("harness: the analysis is clean on the real file", () => {
  assert.deepEqual(problems(SQL, KOTLIN, OFFICE), []);
});

// ============================================== 1. THE ROWS ARE THE PHONE'S ROWS ==

test("the SQL's 92 rows equal the phone's and the office's, column for column, except four taxable booleans", () => {
  const rows = parseValues(changeBlocks(SQL)[0]);
  const untaxedPhone = KOTLIN.rows.filter((r) => !r.taxable).map((r) => r.name).sort();
  const changed = rows.filter((r) => { const k = KOTLIN.rows.find((x) => rowKey(x) === rowKey(r)); return k && k.taxable !== r.taxable; }).map((r) => r.name).sort();
  // The deviation is exactly the phone's untaxed rows today (and shrinks to none the day the lists are fixed).
  assert.deepEqual(changed, untaxedPhone.filter((n) => A1_ROWS.has(n)));
  assert.deepEqual([...A1_ROWS].filter((n) => !untaxedPhone.includes(n)), [...A1_ROWS].filter((n) => !changed.includes(n)),
    "every A1 row is either still untaxed on the phone (and deviates) or has been fixed there (and does not)");
  assert.equal(rows.filter((r) => !r.taxable).length, 0, "the SQL seeds nothing untaxed");
});

test("TEETH: one mistyped price, one dropped row, one changed label, one untaxed A1 row and one extra deviation are each reported", () => {
  const swap = (a, b) => { assert.ok(SQL.includes(a), "sabotage anchor: " + a); return SQL.split(a).join(b); };
  const price = swap("'Concrete Mix 60lb Bag', 'EA', 4.75,", "'Concrete Mix 60lb Bag', 'EA', 4.57,");
  assert.ok(problems(price, KOTLIN, OFFICE).length > 0, "a mistyped price");
  const drop = SQL.replace(/\n\s+\('MISC', 'HOLE_PLUG'[^\n]*/g, "");
  assert.notEqual(drop, SQL);
  assert.ok(problems(drop, KOTLIN, OFFICE).some((p) => /expected 92|missing from SQL|not the checksum/.test(p)), "a dropped row");
  const label = swap("'Starting price \u2014 verify with your supplier'", "'Starting price - verify with your supplier'");
  assert.ok(problems(label, KOTLIN, OFFICE).some((p) => /label/.test(p)), "a changed label");
  const a1 = swap("'Regular PVC Gate 6''H x 5''W, White', 'EA', 145.05, true,", "'Regular PVC Gate 6''H x 5''W, White', 'EA', 145.05, false,");
  assert.ok(problems(a1, KOTLIN, OFFICE).some((p) => /A1 row/.test(p)), "an A1 row left untaxed");
  const extra = swap("'Concrete Mix 60lb Bag', 'EA', 4.75, true,", "'Concrete Mix 60lb Bag', 'EA', 4.75, false,");
  assert.ok(problems(extra, KOTLIN, OFFICE).some((p) => /differs at .*taxable/.test(p)), "an unauthorised taxable deviation");
  const apply = SQL.replace(/(\/\* PART 2 BEGINS[\s\S]*?)'Concrete Mix 60lb Bag', 'EA', 4\.75,/, "$1'Concrete Mix 60lb Bag', 'EA', 4.76,");
  assert.notEqual(apply, SQL);
  assert.ok(problems(apply, KOTLIN, OFFICE).some((p) => /not the same text/.test(p)), "the apply block drifting from the dry run");
});

test("the office copy and the phone copy still agree with each other on every column but the label (so this test compares one list, not two)", () => {
  const office = new Map(OFFICE.map((r) => [rowKey(r), r]));
  for (const r of KOTLIN.rows) {
    const o = office.get(rowKey(r));
    assert.ok(o, "office is missing " + rowKey(r));
    for (const c of COLS) assert.equal(String(o[c] ?? null), String(r[c] ?? null), rowKey(r) + " :: " + c);
    assert.equal(o.source_doc, r.source_doc, rowKey(r) + " label");
  }
});

// ========================================================== 2. THE FILE IS SAFE ==

test("the dry run is one transaction that rolls back, and nothing that runs commits", () => {
  const code = executable(SQL);
  assert.equal((code.match(/^\s*begin;/gim) || []).length, 1, "one BEGIN runs");
  assert.equal((code.match(/^\s*rollback;/gim) || []).length, 1, "one ROLLBACK runs");
  assert.ok(!/\bcommit\b/i.test(code), "no COMMIT outside a block comment");
  assert.ok(code.indexOf("begin;") < code.indexOf("create or replace function public.seed_starting_catalog"), "BEGIN comes before the first DDL");
  assert.ok(code.trimEnd().endsWith("rollback;"), "the last statement that runs is the ROLLBACK");
  // TEETH: a COMMIT outside a comment is seen.
  assert.ok(/\bcommit\b/i.test(executable(SQL.replace("\nrollback;\n", "\ncommit;\n"))));
  assert.ok(/\bcommit\b/i.test(executable(SQL + "\ncommit;\n")));
});

test("the three block comments hold the apply, the reverse and the backfill, and the apply commits", () => {
  for (const part of ["PART 2", "PART 3", "PART 4"]) {
    const m = SQL.match(new RegExp("^/\\* " + part + " BEGINS\\n([\\s\\S]*?)\\n" + part + " ENDS \\*/$", "m"));
    assert.ok(m, part + " block");
    assert.ok(!/\/\*/.test(m[1]), part + " contains a nested block-comment opener (Postgres nests them)");
    if (part !== "PART 4") assert.match(m[1], /\bcommit;/, part + " commits when applied");
    if (part === "PART 3") assert.ok(!/\bdelete\b|\btruncate\b|drop table|drop column/i.test(m[1]), "the reverse deletes no data");
  }
});

test("no bypass role, no e-mail but @probe.invalid, and every role switch is authenticated or anon", () => {
  assert.ok(!/service_role|supabase_admin|bypassrls|\bset role\b(?!\s+(authenticated|anon))/i.test(SQL), "no bypass role named");
  const emails = [...SQL.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+/g)].map((m) => m[0]).filter((e) => !e.endsWith("@probe.invalid"));
  assert.deepEqual(emails, [], "an address of somebody real in the file");
  const roles = [...new Set([...executable(SQL).matchAll(/set local role (\w+)/gi)].map((m) => m[1].toLowerCase()))].sort();
  assert.deepEqual(roles, ["anon", "authenticated"]);
  // TEETH
  assert.ok(/service_role/.test(SQL + " service_role"));
  assert.ok(![...("x set local role postgres".matchAll(/set local role (\w+)/gi))].every((m) => ["anon", "authenticated"].includes(m[1])));
});

test("the change itself writes nothing but the list: no delete, update, drop, truncate or alter, and no write to any table but material_items and app_errors", () => {
  const change = executable(changeBlocks(SQL)[0]);
  assert.ok(!/\b(delete|update|truncate|alter|drop)\b/i.test(change), "a destructive or altering statement in the change");
  const inserts = [...change.matchAll(/insert\s+into\s+(public\.\w+)/gi)].map((m) => m[1].toLowerCase()).sort();
  assert.deepEqual(inserts, ["public.app_errors", "public.material_items"]);
  // TEETH
  assert.ok(/\bdelete\b/i.test(executable("delete from public.material_items;")));
});

test("the whole file has exactly the statements the header promises that touch data: probe deletes are crew attempts, and nothing else", () => {
  const code = executable(SQL);
  const deletes = [...code.matchAll(/\bdelete\s+from\s+([\w.]+)/gi)].map((m) => m[1]);
  assert.deepEqual(deletes, ["public.material_items"], "one delete in the whole file: the crew-member probe, run as `authenticated`");
  assert.match(code, /u_crew1,format\(\$q\$delete from public\.material_items/, "...and it is run as company 1's crew member");
  assert.ok(!/\btruncate\b/i.test(code));
  assert.ok(!/\bdrop\s+(table|column|schema|policy)\b/i.test(code));
});

// ============================================ 3. THE CHANGE HAS THE SHAPE THE DRY RUN RELIES ON ==

test("the change: an AFTER INSERT trigger on companies, a guard, a swallowed failure, revoked callers", () => {
  const c = executable(changeBlocks(SQL)[0]);
  assert.match(c, /create or replace trigger companies_seed_starting_catalog\s+after insert on public\.companies\s+for each row execute function public\.companies_seed_catalog_trigger\(\)/i);
  assert.equal((c.match(/create or replace function/gi) || []).length, 2);
  assert.equal((c.match(/security definer/gi) || []).length, 2);
  assert.equal((c.match(/set search_path = public, pg_temp/gi) || []).length, 2);
  assert.match(c, /if exists \(select 1 from public\.material_items m where m\.company_id = p_company_id\) then\s+return 0;/i, "the guard counts deleted rows too");
  assert.ok(!/deleted_at/i.test(c.slice(c.indexOf("if exists"), c.indexOf("insert into public.material_items"))), "the guard does not exclude deleted rows");
  assert.match(c, /on conflict \(company_id, sync_id\) do nothing/i);
  assert.match(c, /revoke all on function public\.seed_starting_catalog\(uuid\) from public, anon, authenticated;/i);
  assert.match(c, /revoke all on function public\.companies_seed_catalog_trigger\(\) from public, anon, authenticated;/i);
  // the trigger function: the seed call is inside a block whose handler is `when others`, and the handler logs then returns new
  const trg = c.slice(c.indexOf("function public.companies_seed_catalog_trigger"));
  assert.match(trg, /perform public\.seed_starting_catalog\(new\.id\);\s+exception when others then/i);
  assert.match(trg, /insert into public\.app_errors[\s\S]*?false\)/i, "logged with fatal = false");
  assert.match(trg, /return new;/i);
  // TEETH: the reader sees a handler that only catches something narrow, and a missing revoke
  assert.ok(!/exception when others then/.test("exception when no_data_found then"));
  assert.ok(!/revoke all on function public\.seed_starting_catalog/.test(c.replace("revoke all on function public.seed_starting_catalog(uuid)", "revoke all on function public.other(uuid)")));
});

test("the ids are derived from the company and the row, so a repeat call cannot double a catalog", () => {
  const c = changeBlocks(SQL)[0];
  assert.match(c, /md5\(p_company_id::text \|\| ':starting-catalog:' \|\| v\.fence_type \|\| ':' \|\| v\.role \|\| ':' \|\| v\.name\)::uuid/);
});

test("the header says what it must: a STATUS line, where creation happens, the deviation, the backfill, what applying changes elsewhere", () => {
  const head = SQL.slice(0, SQL.indexOf("-- PART 1 -- DRY RUN"));
  assert.match(head, /STATUS: (NOT )?APPLIED/);
  for (const phrase of ["create_company_with_owner", "admin_create_company", "AFTER INSERT TRIGGER ON companies", "ONE DELIBERATE DEVIATION", "supabase_r9_taxable_panels.sql", "THE BACKFILL", "WHAT APPLYING CHANGES ELSEWHERE", "my_setup_progress", "unverifiedPricesOn"]) {
    assert.ok(head.includes(phrase), "header does not mention: " + phrase);
  }
  assert.ok(!/Horizon fence llc[^\n]*@|PeterLLC[^\n]*@/.test(head), "no address next to a real company's name");
});

test("SeedData.kt points at this file, and says the file (not the code) is where its applied status lives", () => {
  assert.ok(SEED_KT.includes(SQL_REL), "SeedData.kt does not name " + SQL_REL);
  assert.match(SEED_KT, /says in its header whether it has been applied/);
});

// ================================================== 4. LIVE: the dry run itself ==

function runSql(sql, label) {
  const dir = mkdtempSync(join(tmpdir(), "a26-catalog-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  let last = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query", "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
      { encoding: "utf8", shell: process.platform === "win32", timeout: 280_000, cwd: ROOT });
    const out = r.stdout || "";
    if (r.status === 0 && out.includes('"rows"')) {
      const parsed = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
      return Array.isArray(parsed) ? parsed : (parsed.rows || []);
    }
    last = `status ${r.status}: ${(r.stderr || out).slice(0, 400)}`;
    // The CLI's login is flaky. A real SQL error is not: it is thrown at once, and a failed call is NEVER read as an empty answer.
    if (!/28P01|failed to connect|timeout|EOF|reset|ECONN|ETIMEDOUT/i.test(last)) break;
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{},3000)"]);
  }
  throw new Error(`${label}: supabase db query failed -- ${last}`);
}

test("LIVE: PART 1 against production passes every check, and leaves nothing behind", { skip: SKIP_LIVE }, (t) => {
  const residueSql = `
    select 'companies' as k, count(*)::int as n from public.companies where name like 'PROBE-A26C-%'
    union all select 'auth_users', count(*)::int from auth.users where email like 'a26c%@probe.invalid'
    union all select 'catalog_rows', count(*)::int from public.material_items where name in ('Hand-made concrete row','Deleted concrete row') or company_id::text like 'a26c%'
    union all select 'seed_functions', count(*)::int from pg_proc where pronamespace='public'::regnamespace and proname in ('seed_starting_catalog','companies_seed_catalog_trigger')
    union all select 'seed_trigger', count(*)::int from pg_trigger where tgname='companies_seed_starting_catalog' and not tgisinternal
    union all select 'control_companies', count(*)::int from public.companies;`;
  const asMap = (rows) => Object.fromEntries(rows.map((r) => [r.k, r.n]));
  const before = asMap(runSql(residueSql, "residue before"));
  assert.ok(before.control_companies >= 1, "control: the residue reader sees companies");
  const rows = runSql(SQL, "PART 1");
  const summary = rows.find((r) => r.subject === "SUMMARY");
  assert.ok(summary, "no SUMMARY row: the file did not run to its end");
  const [passed, total] = summary.got.split("/").map(Number);
  const failed = rows.filter((r) => r.result === "FAIL");
  assert.deepEqual(failed.map((r) => `${r.subject}/${r.pair}/${r.role}: ${r.k} -> ${r.got}`), [], "checks that failed");
  assert.equal(passed, total);
  assert.ok(total >= 80, "the dry run scored " + total + " checks");
  // controls inside the run: the baseline sign-up and the positive controls ran and were seen
  assert.ok(rows.some((r) => r.pair === "before" && r.role === "baseline"), "the baseline sign-up ran");
  assert.ok(rows.some((r) => r.subject === "backfill" && r.pair === "TOTAL"), "the backfill table printed");
  const after = asMap(runSql(residueSql, "residue after"));
  assert.deepEqual(after, before, "the dry run changed something that was still there afterwards");
  assert.equal(after.companies, 0);
  assert.equal(after.auth_users, 0);
  assert.equal(after.catalog_rows, 0);
  t.diagnostic(`${passed}/${total} checks; backfill: ${rows.find((r) => r.pair === "TOTAL")?.got}`);
});
