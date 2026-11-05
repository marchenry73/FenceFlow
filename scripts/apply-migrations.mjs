#!/usr/bin/env node
// Apply the SQL files in supabase/dev/apply-order.txt, in order, once each,
// and record what was applied in public.schema_migrations.
//
// WHY THIS EXISTS
//   Until 5 November 2026 nothing recorded which of these files had run. The
//   live database was the only place the answer existed, and reading it took a
//   query per migration. That is how supabase_r8_deposit_follows_price.sql sat
//   unapplied for six weeks -- a money rule decided on 24 September that had
//   never once fired, with its function live and its trigger missing, and
//   nothing able to say so. r20, r42 and crew_job_scope were the same.
//
//   scripts/audit-unapplied-migrations.mjs answers the other half: it reads the
//   live database and lists files whose objects are absent. That is a list of
//   CANDIDATES, because an object can exist for other reasons. This script is
//   the record: what was applied, when, and at which checksum.
//
// WHY IT WILL NOT BULK-APPLY HISTORY
//   On the day the ledger was created, 208 files were already in the order and
//   the schema already reflected most of them. Running them would not be a
//   no-op: plenty are not idempotent. So the first step is ADOPTION -- record
//   them as applied without running them, honestly marked `adopted`, meaning
//   "assumed from the pre-ledger past, never verified by running". Only after
//   that does "apply everything pending" mean "apply what is new".
//
// WHY A FILE MUST BE IN apply-order.txt TO BE APPLIED
//   The same day, 346 files were on disk and 138 were in no order at all,
//   including r20 and r42. A file outside the order is a file nobody can apply
//   in a known sequence. Rather than quietly apply it anyway, this refuses and
//   tells you to place it -- so the order list cannot drift again.
//
// USAGE
//   node scripts/apply-migrations.mjs                   report, read-only (default)
//   node scripts/apply-migrations.mjs --adopt --yes     record pending as adopted, running nothing
//   node scripts/apply-migrations.mjs --apply --yes     apply every pending file, in order
//   node scripts/apply-migrations.mjs --apply --only <file> --yes   apply one file
//
//   Nothing is written without --yes. Any file whose checksum has changed since
//   it was recorded stops the run before a single statement is sent.
import { readFileSync, existsSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "newcrgafcptspmapacrx";
const ORDER = join(ROOT, "supabase", "dev", "apply-order.txt");

// Pinned on purpose. `npx -y supabase` follows whatever was released last, and
// a release that threw `spawn UNKNOWN` once broke a publish after its gate had
// already passed.
const CLI = ["--no-install", "supabase@2.115.0"];

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const DO_ADOPT = has("--adopt");
const DO_APPLY = has("--apply");
const CONFIRMED = has("--yes");
const ONLY = valueOf("--only");

if (DO_ADOPT && DO_APPLY) {
  console.error("--adopt and --apply do different things; run one at a time.");
  process.exit(2);
}

/** Run one SQL file or statement through the Management API and return parsed rows. */
function query(sql) {
  const dir = mkdtempSync(join(tmpdir(), "ff-mig-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  const r = spawnSync("npx", [...CLI, "db", "query", "--linked", "--project-ref", PROJECT,
    "-f", file, "--output", "json"], { encoding: "utf8", shell: true });
  if (r.status !== 0) {
    throw new Error(`db query failed (exit ${r.status}): ${(r.stderr || r.stdout || "").slice(0, 600)}`);
  }
  const out = r.stdout || "";
  const a = out.indexOf("{"), b = out.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error(`no JSON in reply: ${out.slice(0, 300)}`);
  const parsed = JSON.parse(out.slice(a, b + 1));
  if (parsed._tag === "Error") {
    throw new Error(parsed.error?.message || "db query returned an error");
  }
  // `rows` carries data written by other people. It is read here only as file
  // names and checksums, and compared -- never executed, never interpolated
  // back into SQL unescaped.
  return parsed.rows || [];
}

function applyFile(absPath) {
  const r = spawnSync("npx", [...CLI, "db", "query", "--linked", "--project-ref", PROJECT,
    "-f", absPath, "--output", "json"], { encoding: "utf8", shell: true });
  const out = (r.stdout || "") + (r.stderr || "");
  if (r.status !== 0 || out.includes('"_tag":"Error"')) {
    throw new Error(out.slice(0, 1200));
  }
  return out;
}

const esc = (s) => String(s).replace(/'/g, "''");
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

// ---- the ordered list -------------------------------------------------------
if (!existsSync(ORDER)) {
  console.error(`missing ${ORDER}`);
  process.exit(2);
}
const ordered = readFileSync(ORDER, "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#") && !l.startsWith("--"))
  .map((l) => (l.match(/^[A-Za-z0-9_./-]+\.sql/) || [null])[0])
  .filter(Boolean);

const seen = new Set();
const order = ordered.filter((f) => (seen.has(f) ? false : seen.add(f)));

// ---- what the ledger already knows -----------------------------------------
let ledger;
try {
  ledger = new Map(query("select filename, sha256, origin from public.schema_migrations;")
    .map((r) => [r.filename, r]));
} catch (e) {
  console.error(`Could not read the ledger. Apply supabase_r63_migration_ledger.sql first.\n${e.message}`);
  process.exit(1);
}

const missingFromDisk = [];
const changed = [];
const recorded = [];
const pending = [];

for (const name of order) {
  const abs = join(ROOT, name);
  if (!existsSync(abs)) { missingFromDisk.push(name); continue; }
  const digest = sha(abs);
  const row = ledger.get(name);
  if (!row) pending.push({ name, abs, digest });
  else if (row.sha256 !== digest) changed.push({ name, was: row.sha256, now: digest, origin: row.origin });
  else recorded.push({ name, origin: row.origin });
}

// Files on disk that nobody placed in the order. These cannot be applied here.
const onDisk = readdirSync(ROOT).filter((f) => /^supabase_.*\.sql$/.test(f));
const unplaced = onDisk.filter((f) => !seen.has(f)).sort();

// ---- report ----------------------------------------------------------------
console.log(`apply-order.txt ....... ${order.length} file(s)`);
console.log(`  recorded ............ ${recorded.length}  (${recorded.filter((r) => r.origin === "applied").length} applied, ${recorded.filter((r) => r.origin === "adopted").length} adopted)`);
console.log(`  pending ............. ${pending.length}`);
console.log(`  checksum changed .... ${changed.length}`);
console.log(`  named but not on disk ${missingFromDisk.length}`);
console.log(`on disk, not in the order ${unplaced.length}  (cannot be applied until placed)`);

if (changed.length) {
  console.log("\nCHECKSUM CHANGED SINCE IT WAS RECORDED -- nothing will run:");
  for (const c of changed) console.log(`  ${c.name}  [${c.origin}]  recorded ${c.was.slice(0, 12)} -> now ${c.now.slice(0, 12)}`);
  console.log("\nEditing an applied migration in place is how two databases stop matching.");
  console.log("Write a new file instead. To accept the edit deliberately, update the row's");
  console.log("sha256 by hand and say why in notes.");
}
if (missingFromDisk.length) {
  console.log("\nNamed in the order but not on disk:");
  for (const m of missingFromDisk) console.log(`  ${m}`);
}
if (pending.length) {
  console.log("\nPENDING, in order:");
  for (const p of pending) console.log(`  ${p.name}`);
}
if (unplaced.length) {
  console.log(`\nNot in apply-order.txt (${unplaced.length}). Place a file here before applying it:`);
  for (const u of unplaced) console.log(`  ${u}`);
}

if (!DO_ADOPT && !DO_APPLY) {
  console.log("\nRead-only. --adopt --yes to record pending without running; --apply --yes to run them.");
  process.exit(0);
}
if (changed.length) {
  console.error("\nRefusing to write while a recorded file's checksum has changed.");
  process.exit(1);
}
if (!CONFIRMED) {
  console.error("\nRefusing to write without --yes.");
  process.exit(1);
}

let targets = pending;
if (ONLY) {
  targets = pending.filter((p) => p.name === ONLY);
  if (!targets.length) {
    const why = seen.has(ONLY)
      ? "it is already recorded, or its checksum changed"
      : "it is not in apply-order.txt -- place it there first";
    console.error(`\n--only ${ONLY}: nothing to do (${why}).`);
    process.exit(1);
  }
}
if (!targets.length) { console.log("\nNothing pending."); process.exit(0); }

const note = esc(DO_ADOPT
  ? "adopted by scripts/apply-migrations.mjs: recorded without running, pre-ledger history"
  : "applied by scripts/apply-migrations.mjs");

// Adoption writes no schema, so it is one statement rather than one round trip
// per file. At ~30s per call through the Management API, 208 separate inserts
// would take over an hour and could stop half way, leaving the ledger a
// partial claim about history. One insert either records all of them or none.
if (DO_ADOPT) {
  const values = targets
    .map((t) => `('${esc(t.name)}', '${t.digest}', 'adopted', '${note}')`)
    .join(",\n           ");
  try {
    query(`insert into public.schema_migrations (filename, sha256, origin, notes)
           values ${values}
           on conflict (filename) do nothing;`);
  } catch (e) {
    console.error(`\nAdoption failed, and recorded nothing:\n${e.message}`);
    process.exit(1);
  }
  const after = query("select count(*)::int as n from public.schema_migrations;");
  console.log(`\nAdopted ${targets.length} file(s). The ledger now holds ${after[0]?.n ?? "?"} row(s).`);
  console.log("These are recorded as `adopted`: assumed from before the ledger existed,");
  console.log("never verified by running. scripts/audit-unapplied-migrations.mjs is what");
  console.log("checks whether their objects are actually live.");
  process.exit(0);
}

let done = 0;
for (const t of targets) {
  try {
    if (DO_APPLY) {
      console.log(`\napplying ${t.name} ...`);
      applyFile(t.abs);
    }
    query(`insert into public.schema_migrations (filename, sha256, origin, notes)
           values ('${esc(t.name)}', '${t.digest}', '${DO_ADOPT ? "adopted" : "applied"}', '${note}')
           on conflict (filename) do nothing;`);
    done++;
    if (DO_ADOPT) console.log(`  adopted ${t.name}`);
    else console.log(`  applied and recorded ${t.name}`);
  } catch (e) {
    console.error(`\nSTOPPED at ${t.name}:\n${e.message}`);
    console.error(`\n${done} file(s) completed before this one. The ledger records exactly those,`);
    console.error("so re-running continues from here rather than repeating them.");
    process.exit(1);
  }
}
console.log(`\n${DO_ADOPT ? "Adopted" : "Applied"} ${done} file(s).`);
