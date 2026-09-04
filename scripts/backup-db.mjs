#!/usr/bin/env node
/**
 * A copy of the database that FenceFlow does not depend on anyone for.
 *
 * Supabase keeps its own backups, on its own plan, under its own account
 * status. This writes every table in the public schema to Google Drive as
 * JSON, one file per table, one folder per run -- so that whatever happens
 * to that account, the business's jobs, customers, ledger and crew exist
 * somewhere the owner holds the keys to.
 *
 * Deliberately a logical copy, not pg_dump: pg_dump needs Docker or a local
 * Postgres, neither of which this machine has, and it needs the database
 * password, which this script must never hold. `supabase db query` goes
 * through the CLI's own login instead. Restoring is upserting the JSON back
 * row by row, which the importer already knows how to do for jobs; for the
 * rest it is a SQL COPY away.
 *
 * Every failure is loud. A backup that quietly writes half the tables and
 * exits 0 is worse than none, because it is trusted. Any table that cannot
 * be read, or whose row count does not match what the database says it
 * holds, fails the whole run, leaves LAST_BACKUP_FAILED.txt in the folder,
 * and exits non-zero so a scheduler can notice.
 *
 * Runs weekly from Windows Task Scheduler ("FenceFlow DB backup", Sundays
 * 10:00, StartWhenAvailable) and by hand:
 *   node scripts/backup-db.mjs              -> writes to the Drive folder below
 *   node scripts/backup-db.mjs <out dir>    -> writes there instead
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const PROJECT_REF = "newcrgafcptspmapacrx";
const DRIVE_ROOT = "G:/My Drive/Professional Documents/Projects/FenceEstimator/backups";
const KEEP_RUNS = 12;   // three months of weekly copies

const outRoot = resolve(process.argv[2] || DRIVE_ROOT);
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const outDir = join(outRoot, stamp);
mkdirSync(outDir, { recursive: true });

const failedFlag = join(outRoot, "LAST_BACKUP_FAILED.txt");
const okFlag = join(outRoot, "LAST_BACKUP_OK.txt");

function query(sql) {
  const f = join(tmpdir(), `ff-backup-${process.pid}.sql`);
  writeFileSync(f, sql);
  try {
    const raw = execFileSync("npx", [
      "--no-install", "supabase@2.115.0", "db", "query",
      "--linked", "--project-ref", PROJECT_REF, "-f", f,
      // Explicit. Interactively the CLI answers in JSON; under Task Scheduler
      // it decided it had a console and drew a table, and the first scheduled
      // run failed with "no JSON in CLI output".
      "--output", "json",
    ], { encoding: "utf8", shell: true, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    return extractRows(raw);
  } finally {
    rmSync(f, { force: true });
  }
}

/**
 * The rows, wherever the CLI put them.
 *
 * Two shapes so far: `{ boundary, rows: [...] }` from a console, and a bare
 * `[...]` of rows from Task Scheduler. Rather than guess at the next one,
 * walk every balanced {...} or [...] in the output and take the first that
 * is a rows array or an object carrying one. Chatter before, between and
 * after is ignored; the raw text rides along in the failure so the next
 * surprise is diagnosable from the log alone.
 */
function extractRows(raw) {
  let i = -1;
  for (;;) {
    const nextObj = raw.indexOf("{", i + 1);
    const nextArr = raw.indexOf("[", i + 1);
    if (nextObj < 0 && nextArr < 0) break;
    i = nextObj < 0 ? nextArr : nextArr < 0 ? nextObj : Math.min(nextObj, nextArr);
    const end = matchingBracket(raw, i);
    if (end < 0) break;
    try {
      const o = JSON.parse(raw.slice(i, end + 1));
      if (Array.isArray(o) && o.every((r) => r && typeof r === "object")) return o;
      if (o && Array.isArray(o.rows)) return o.rows;
    } catch {
      // not this one
    }
  }
  throw new Error("no rows in CLI output: " + raw.slice(0, 400).replace(/\s+/g, " "));
}

function matchingBracket(s, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let k = start; k < s.length; k++) {
    const c = s[k];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

function fail(msg) {
  writeFileSync(failedFlag, `${new Date().toISOString()}\n${msg}\n`);
  console.error("BACKUP FAILED: " + msg);
  process.exit(1);
}

try {
  const tables = query(`
    select table_name as t,
           (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.' || quote_ident(table_name), false, true, '')))[1]::text::int as n
      from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
     order by table_name`);
  if (!tables.length) fail("the database reported no tables -- an empty answer is not a backup");

  const manifest = { taken_at: new Date().toISOString(), project: PROJECT_REF, tables: {} };
  for (const { t, n } of tables) {
    const rows = query(`select * from public.${t.replace(/[^a-z0-9_]/g, "")}`);
    if (rows.length !== Number(n)) {
      fail(`${t}: database says ${n} rows, read ${rows.length}`);
    }
    writeFileSync(join(outDir, `${t}.json`), JSON.stringify(rows));
    manifest.tables[t] = rows.length;
    console.log(`${t.padEnd(24)} ${String(rows.length).padStart(6)} rows`);
  }
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // Older runs go, newest kept. Never the one just written.
  const runs = readdirSync(outRoot)
    .filter((d) => /^\d{4}-\d{2}-\d{2}-/.test(d) && statSync(join(outRoot, d)).isDirectory())
    .sort();
  for (const old of runs.slice(0, Math.max(0, runs.length - KEEP_RUNS))) {
    rmSync(join(outRoot, old), { recursive: true, force: true });
  }

  rmSync(failedFlag, { force: true });
  writeFileSync(okFlag, `${manifest.taken_at}\n${outDir}\n${Object.values(manifest.tables).reduce((a, b) => a + b, 0)} rows across ${tables.length} tables\n`);
  console.log(`\nBacked up ${tables.length} tables to ${outDir}`);
} catch (e) {
  fail(String(e?.message ?? e));
}
