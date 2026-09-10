#!/usr/bin/env node
/**
 * Dumps every table in the cloud database to JSON files.
 *
 * Why this exists rather than `supabase db dump`: that command shells out to
 * Docker, and Docker is not installed on the machine this project is built on.
 * A backup procedure that only works somewhere else is not a backup procedure.
 * This one needs nothing but the Supabase CLI, which is already used here.
 *
 * Usage:
 *   node scripts/backup-cloud.mjs "D:/FenceFlowBackups"
 *
 * The destination MUST be outside the repository. The repository is public;
 * a backup committed to it would publish every company's customer records.
 * The script refuses to write inside the repo rather than trusting you to
 * remember that at 11pm.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT_REF = "newcrgafcptspmapacrx";
const REPO_ROOT = resolve(import.meta.dirname, "..");

// The tables a restore is worthless without. This is not the backup list --
// the backup list is whatever the database actually contains, discovered at
// run time. This is the floor: if discovery comes back without one of these,
// something is wrong with discovery itself and the backup stops.
//
// A hand-maintained list WAS the backup list, and it had drifted thirteen
// tables behind the database -- among them companies, customers and
// job_payments. Restoring from one of those backups would have produced jobs
// belonging to no customer, in no company, with no payment history, and the
// script would have reported success while doing it. A list somebody has to
// remember to update is not a backup procedure.
const MUST_HAVE = [
  "companies", "customers", "profiles", "jobs", "estimate_line_items",
  "job_payments", "payment_records", "time_entries", "employees", "audit_log",
];

function usage(message) {
  console.error(message);
  console.error("\nUsage: node scripts/backup-cloud.mjs <destination-folder>");
  process.exit(1);
}

const destArg = process.argv[2];
if (!destArg) usage("No destination folder given.");

const dest = resolve(destArg);
if (dest === REPO_ROOT || dest.startsWith(REPO_ROOT + "\\") || dest.startsWith(REPO_ROOT + "/")) {
  usage(
    `Refusing to write a backup inside the repository (${REPO_ROOT}).\n` +
    "This repo is public. Pick a folder somewhere else."
  );
}

/** Runs one query through the CLI and returns the parsed rows. */
function query(sql) {
  const file = join(tmpdir(), `ff-backup-${process.pid}.sql`);
  writeFileSync(file, sql);
  try {
    // shell:true because npx is a .cmd on Windows and Node refuses to exec one
    // directly (EINVAL). The file path is quoted since it comes from tmpdir().
    const raw = execFileSync(
      "npx.cmd",
      ["-y", "supabase", "db", "query", "--linked", "--project-ref", PROJECT_REF, "-f", `"${file}"`],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, shell: true }
    );
    // The CLI prints a banner line before the JSON payload.
    const start = raw.indexOf("{");
    if (start < 0) throw new Error("no JSON in CLI output");
    return JSON.parse(raw.slice(start)).rows ?? [];
  } finally {
    rmSync(file, { force: true });
  }
}

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const folder = join(dest, `fenceflow-${stamp}`);
mkdirSync(folder, { recursive: true });

// Ask the database what it holds. Anything added since the last backup is
// captured without anyone having to think about it, which is the whole point.
let TABLES;
try {
  TABLES = query(
    "select table_name from information_schema.tables " +
    "where table_schema = 'public' and table_type = 'BASE TABLE' order by 1;"
  ).map((r) => r.table_name);
} catch (e) {
  console.error("Could not ask the database which tables exist: " + e.message);
  console.error("Refusing to write a backup that might be missing tables.");
  process.exit(1);
}

const absent = MUST_HAVE.filter((t) => !TABLES.includes(t));
if (absent.length) {
  console.error("Discovery did not return these, which cannot be right: " + absent.join(", "));
  console.error("Refusing to write a backup that is missing them.");
  process.exit(1);
}
console.log("Backing up " + TABLES.length + " tables, discovered from the database.");

let totalRows = 0;
const failed = [];
const summary = [];
for (const table of TABLES) {
  try {
    const rows = query(`select * from public.${table};`);
    writeFileSync(join(folder, `${table}.json`), JSON.stringify(rows, null, 2));
    totalRows += rows.length;
    summary.push(`  ${table.padEnd(24)} ${String(rows.length).padStart(7)} rows`);
  } catch (e) {
    // One failure must not abandon the rest of the backup -- but it must not
    // be forgotten either. This used to land in the manifest and then exit 0,
    // so a backup missing a table looked exactly like a good one to anything
    // checking the exit code.
    failed.push(table);
    summary.push(`  ${table.padEnd(24)} FAILED: ${String(e.message).slice(0, 60)}`);
  }
}

writeFileSync(
  join(folder, "MANIFEST.txt"),
  [
    `FenceFlow cloud backup`,
    `Taken:   ${new Date().toISOString()}`,
    `Project: ${PROJECT_REF}`,
    `Rows:    ${totalRows}`,
    `Tables:  ${TABLES.length} captured${failed.length ? ", " + failed.length + " FAILED" : ""}`,
    ``,
    `Tables:`,
    ...summary,
    ``,
    `WHAT THIS IS, AND WHAT IT IS NOT.`,
    ``,
    `This is every row of every table in the public schema. It is a data`,
    `snapshot for recovery by hand, or for comparing against a later state.`,
    `It is NOT a disaster-recovery restore path, and the difference is worth`,
    `being blunt about, because a folder called "backup" invites the`,
    `assumption that it is one.`,
    ``,
    `Not captured, and needed before any of this data would work again:`,
    ``,
    `  Sign-in accounts. Supabase Auth lives in the auth schema, which this`,
    `  never touches. Every profile, company and employee row here points at`,
    `  an auth identity by id. Restore this into a fresh project and those`,
    `  ids lead nowhere: nobody can sign in, and every security policy keyed`,
    `  on the signed-in user refuses everyone.`,
    ``,
    `  Uploaded files. Photos and documents live in Storage buckets. The rows`,
    `  that reference them are here; the files themselves are not. A restored`,
    `  database would know a file existed at a path with nothing there.`,
    ``,
    `  The schema itself: tables, columns, row level security, policies,`,
    `  functions, triggers, sequences and extensions. Recreate those from the`,
    `  SQL patch files in the repository FIRST, then load this data.`,
    ``,
    `CONTAINS CUSTOMER PERSONAL DATA. Do not put this in the public repository,`,
    `and do not share the folder.`,
  ].join("\n")
);

console.log(summary.join("\n"));
console.log(`\n${totalRows} rows -> ${folder}`);
if (failed.length) {
  console.error("\nINCOMPLETE BACKUP. These tables were not captured: " + failed.join(", "));
  console.error("Do not rely on this folder. Fix the cause and run it again.");
  process.exit(1);
}
if (totalRows === 0) {
  console.error("\nWARNING: nothing was captured. Treat this as a failed backup.");
  process.exit(1);
}
