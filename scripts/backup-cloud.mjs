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

const TABLES = [
  "profiles", "jobs", "fence_runs", "estimate_line_items", "change_orders",
  "job_steps", "payment_records", "expenses", "time_entries", "employees",
  "material_items", "manufacturers", "pricing_tiers", "punch_list_items",
  "site_markers", "company_settings", "device_tokens", "app_releases",
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

let totalRows = 0;
const summary = [];
for (const table of TABLES) {
  try {
    const rows = query(`select * from public.${table};`);
    writeFileSync(join(folder, `${table}.json`), JSON.stringify(rows, null, 2));
    totalRows += rows.length;
    summary.push(`  ${table.padEnd(24)} ${String(rows.length).padStart(7)} rows`);
  } catch (e) {
    // One missing table must not abandon the rest of the backup.
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
    ``,
    `Tables:`,
    ...summary,
    ``,
    `This is a logical backup: the data, not the schema, policies or functions.`,
    `Restoring it into an empty project needs the schema recreated first from`,
    `the SQL patch files in the repository.`,
    ``,
    `CONTAINS CUSTOMER PERSONAL DATA. Do not put this in the public repository,`,
    `and do not share the folder.`,
  ].join("\n")
);

console.log(summary.join("\n"));
console.log(`\n${totalRows} rows -> ${folder}`);
if (totalRows === 0) {
  console.error("\nWARNING: nothing was captured. Treat this as a failed backup.");
  process.exit(1);
}
