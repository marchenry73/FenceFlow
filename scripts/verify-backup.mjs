#!/usr/bin/env node
/**
 * Checks a backup folder against the live database.
 *
 * A backup nobody has ever read back is a folder, not a backup. This reads
 * every file, parses it, and compares its row count with the database it came
 * from -- and, separately, asks the database which tables exist so that a file
 * that is simply ABSENT is caught too.
 *
 * That second question is the one worth being careful about. The obvious way
 * to write this is to walk the files and ask about each one, which can only
 * ever find files that are there. A missing table would then be invisible,
 * which is the same failure the backup script itself had. Ask the database
 * first; compare the folder to it, never the other way round.
 *
 * Usage:
 *   node scripts/verify-backup.mjs "D:/FenceFlowBackups/fenceflow-..."
 *
 * Exits non-zero if anything is missing, unreadable, or short.
 */
import { readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT_REF = "newcrgafcptspmapacrx";

const folder = process.argv[2];
if (!folder) {
  console.error("Usage: node scripts/verify-backup.mjs <backup-folder>");
  process.exit(1);
}

function query(sql) {
  const file = join(tmpdir(), `ff-verify-${process.pid}.sql`);
  writeFileSync(file, sql);
  try {
    const raw = execFileSync(
      "npx.cmd",
      ["-y", "supabase", "db", "query", "--linked", "--project-ref", PROJECT_REF, "-f", `"${file}"`],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: true }
    );
    const start = raw.indexOf("{");
    if (start < 0) throw new Error("no JSON in CLI output");
    return JSON.parse(raw.slice(start)).rows ?? [];
  } finally {
    rmSync(file, { force: true });
  }
}

// The database is the source of truth for what SHOULD be in the folder.
const tables = query(
  "select table_name from information_schema.tables " +
  "where table_schema = 'public' and table_type = 'BASE TABLE' order by 1;"
).map((r) => r.table_name);

if (!tables.length) {
  console.error("The database returned no tables. Something is wrong with the connection,");
  console.error("not with the backup. Not calling this a pass.");
  process.exit(1);
}

const counts = Object.fromEntries(
  query(tables.map((t) => `select '${t}' as t, count(*) as n from public.${t}`).join(" union all ") + ";")
    .map((r) => [r.t, Number(r.n)])
);

// manifest.json is written BY the backup script, describing the run --
// it is not a table dump. Counting it as one made every verified backup
// report "NOT A TABLE manifest.json (dropped since the backup?)" and fail,
// which is a verifier that cries wolf on its own output. A checker nobody
// believes is worse than no checker, because the day it is right it reads
// exactly like the days it was wrong.
const NOT_A_TABLE_DUMP = new Set(["manifest.json"]);
const present = new Set(
  readdirSync(folder).filter((f) => f.endsWith(".json") && !NOT_A_TABLE_DUMP.has(f))
);
const problems = [];

for (const t of tables) {
  const name = `${t}.json`;
  if (!present.has(name)) { problems.push(`MISSING     ${t}`); continue; }
  let rows;
  try { rows = JSON.parse(readFileSync(join(folder, name), "utf8")); }
  catch (e) { problems.push(`UNREADABLE  ${t}: ${e.message}`); continue; }
  if (!Array.isArray(rows)) { problems.push(`NOT A LIST  ${t}`); continue; }
  // A backup taken earlier than now can legitimately hold FEWER rows than the
  // live table, but never more, and a table that has lost rows since is worth
  // a look either way. Both directions are reported; only a shortfall fails.
  if (rows.length !== counts[t]) {
    problems.push(`${rows.length < counts[t] ? "SHORT      " : "AHEAD      "} ${t}: file ${rows.length}, live ${counts[t]}`);
  }
}

const extra = [...present].filter((f) => !tables.includes(f.replace(/\.json$/, "")));
for (const f of extra) problems.push(`NOT A TABLE ${f} (dropped since the backup?)`);

console.log(`${tables.length} tables in the database, ${present.size} files in the folder.`);
if (!problems.length) {
  console.log("Every table is present and every count matches.");
  process.exit(0);
}
console.log(problems.join("\n"));
console.error(`\n${problems.length} problem(s). Do not rely on this backup.`);
process.exit(1);
