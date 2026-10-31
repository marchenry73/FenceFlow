#!/usr/bin/env node
// Which supabase_*.sql in this repo was never applied to the live database?
//
// WHY THIS EXISTS. A repo file says what somebody MEANT to apply. On
// 30-31 October 2026 four separate migrations turned out never to have run, and
// every one of them was invisible from the code alone because the code is
// written to degrade quietly when its table is missing:
//
//   * supabase_r9_displaced_device_push.sql -- the trigger that stops the other
//     phone when a login moves. Unapplied for a month, which was the whole of
//     why "use this phone only" never stopped anything. Its edge function had
//     been deployed and idle the entire time.
//   * supabase_r8_deposit_follows_price.sql -- HALF applied. The function was
//     live and its trigger on public.jobs was not, so a money rule the owner
//     decided on 24 September had never once taken effect.
//   * supabase_r42_product_key_test_and_real.sql -- owner-list item E2, worked
//     out in full and never run. It had been treated as an open design
//     question.
//   * supabase_r20_seed_new_company_catalog.sql -- why every new company's
//     catalog is empty.
//
// The half-applied case is the one that matters most: a file is not "applied"
// because SOME of it is there. Reporting per-object rather than per-file is
// what caught the deposit trigger.
//
// HOW IT WORKS. Parse each file for the objects it creates, ask the database
// which objects exist, and report the difference. No writes, no transaction.
//
// WHAT IT CANNOT TELL YOU, stated so a clean report is not over-read:
//   * An object may exist because something ELSE created it. Presence is not
//     proof that this file ran.
//   * A file that only does `alter table`, `grant`, `insert`, `update` or
//     `create policy` declares no object here and is skipped entirely. It is
//     counted in the "declares nothing" total so the skip is visible.
//   * A renamed object reads as missing. supabase_r8_drawing_versions.sql looks
//     absent if you grep for "drawing" because its objects are all named
//     reapp_*; this script compares real names, but a file whose object was
//     later renamed by a successor will still show up. Read before believing.
//   * Trigger names are matched bare, so a quoted name with a hyphen
//     ("job-change-push") reads as missing against an underscore guess.
//
// So this is a list of CANDIDATES to read, not a verdict. Every one of the four
// above was confirmed by reading the file and querying the live object.
//
//     node scripts/audit-unapplied-migrations.mjs            (read-only)
//     node scripts/audit-unapplied-migrations.mjs --all      (include probe files)
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "newcrgafcptspmapacrx";
const SHOW_ALL = process.argv.includes("--all");

/** Strip whole-line SQL comments, so a name mentioned only in prose is not counted. */
const stripSql = (s) => s.replace(/^[ \t]*--.*$/gm, "");

const PATTERNS = [
  [/\bcreate\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)/gis, "function"],
  [/\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z0-9_]+)/gis, "table"],
  [/\bcreate\s+(?:or\s+replace\s+)?view\s+(?:public\.)?([a-z0-9_]+)/gis, "view"],
  // A trigger name may be QUOTED and contain characters a bare identifier
  // cannot, which [a-z0-9_]+ silently truncates: "job-change-push" matched as
  // `job`, and two files that are both applied were reported as missing it.
  // Quoted names are taken whole, and the bare form is matched separately.
  [/\bcreate\s+trigger\s+"([^"]+)"/gis, "trigger"],
  [/\bcreate\s+trigger\s+([a-z0-9_]+)/gis, "trigger"],
];

const files = readdirSync(ROOT)
  .filter((f) => f.startsWith("supabase_") && f.endsWith(".sql")).sort();

const declared = new Map();
let declaresNothing = 0;
for (const f of files) {
  const code = stripSql(readFileSync(join(ROOT, f), "utf8"));
  const objs = new Set();
  for (const [re, kind] of PATTERNS) {
    for (const m of code.matchAll(re)) {
      // pg_temp is a throwaway namespace used by the probe files; a temp table
      // created inside a rolled-back probe is never meant to survive either.
      if (m[1] === "pg_temp") continue;
      objs.add(`${kind}:${m[1]}`);
    }
  }
  if (objs.size === 0) { declaresNothing++; continue; }
  declared.set(f, [...objs].sort());
}

const SQL = `
select 'function' as kind, proname as name from pg_proc where pronamespace='public'::regnamespace
union all
select 'table', table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'
union all
select 'view', table_name from information_schema.views where table_schema='public'
union all
select 'trigger', t.tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
  join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal;`;

const dir = mkdtempSync(join(tmpdir(), "mig-audit-"));
const qf = join(dir, "q.sql");
writeFileSync(qf, SQL, "utf8");
const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query",
  "--linked", "--project-ref", PROJECT, "-f", qf, "--output", "json"],
  { encoding: "utf8", shell: process.platform === "win32", timeout: 180_000 });
// The raw status first: a JSON parser that prints a header on an error response
// reads exactly like an empty-but-ok result, and an empty live set would report
// every migration in the repo as unapplied.
if (r.status !== 0) {
  console.error(`supabase db query failed (exit ${r.status}): ${r.stderr || r.stdout}`);
  process.exit(2);
}
let rows;
try { rows = JSON.parse(r.stdout); } catch { console.error(`unparseable: ${r.stdout.slice(0, 300)}`); process.exit(2); }
rows = Array.isArray(rows) ? rows : rows.rows;
const live = new Set(rows.map((x) => `${x.kind}:${x.name}`));
if (live.size < 50) {
  console.error(`only ${live.size} live objects came back -- refusing to report, that reads as everything being unapplied`);
  process.exit(2);
}

const PROBE = /_probe|_probe_|probe_|_teeth|_wal_shape/;
const full = [], part = [];
for (const [f, objs] of declared) {
  const miss = objs.filter((o) => !live.has(o));
  if (miss.length === 0) continue;
  (miss.length === objs.length ? full : part).push({ f, miss, n: objs.length });
}
const hide = (x) => !SHOW_ALL && PROBE.test(x.f);

console.log(`${files.length} migration files, ${declared.size} declaring objects, ` +
            `${declaresNothing} declaring none (alter/grant/insert only -- not checked), ` +
            `${live.size} live objects\n`);

console.log("EVERY OBJECT ABSENT -- candidates for never applied");
for (const x of full.filter((x) => !hide(x)).sort((a, b) => a.f.localeCompare(b.f))) {
  console.log(`  ${x.f.padEnd(56)} ${x.miss.length}/${x.n}  ${x.miss.slice(0, 4).join(", ")}`);
}
console.log("\nSOME OBJECTS ABSENT -- half applied, superseded, or renamed");
console.log("  (the half-applied case is the dangerous one: r8_deposit_follows_price");
console.log("   had its function live and its trigger missing, so a money rule never fired)");
for (const x of part.filter((x) => !hide(x)).sort((a, b) => a.f.localeCompare(b.f))) {
  console.log(`  ${x.f.padEnd(56)} ${x.miss.length}/${x.n}  ${x.miss.slice(0, 4).join(", ")}`);
}
const hidden = [...full, ...part].filter(hide).length;
if (hidden) console.log(`\n${hidden} probe file(s) hidden; --all to show them.`);
console.log("\nThese are CANDIDATES. An object can exist because something else made it,");
console.log("and a renamed object reads as missing. Read the file before concluding.");
