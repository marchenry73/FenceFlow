#!/usr/bin/env node
// IS EACH "ADOPTED" MIGRATION ACTUALLY LIVE?
//
// public.schema_migrations records 208 files as origin='adopted', which that
// table defines as "already live, so recorded without running". The 5 November
// sweep never checked that claim. On 6 November one of them --
// supabase_crew_job_scope.sql -- turned out never to have run, while the
// runner reported pending=0.
//
// This reads each adopted file, extracts the objects it would create, and asks
// the database whether they exist. Read-only; it changes nothing.
//
// WHAT A VERDICT MEANS, because the limits are the useful part:
//
//   LIVE        every object the file creates exists.
//   NOT LIVE    none of them do. It has almost certainly never run.
//   PARTIAL     some do. Either it half-ran, or another file made the same
//               objects, or it was superseded. Needs reading.
//   UNJUDGEABLE the file creates no checkable object -- a data-only migration
//               (inserts, updates, backfills), a grant-only patch, or one that
//               only ALTERs. Existence cannot answer it. NOT a pass, and must
//               never be reported as live.
//
// THE LIMIT THAT MATTERS MOST: existence is not identity. A file doing
// `create or replace function f` reads LIVE whenever some f exists, even if a
// later file replaced its body entirely. LIVE here means "the objects are
// there", never "this file's version of them is what runs".
//
//   node scripts/ledger-liveness.mjs            # every adopted file
//   node scripts/ledger-liveness.mjs --canary   # prove the checker can say NOT LIVE

import { readFileSync, existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REF = "newcrgafcptspmapacrx";
const CANARY = process.argv.includes("--canary");
const WORK = mkdtempSync(join(tmpdir(), "ledger-live-"));

// The SQL goes through a FILE, not an argv string. With shell:true the shell
// split the query on spaces, and a query starting with a -- comment is parsed
// as a flag. Both made the harness crash instead of report -- which is why
// --canary runs first.
function sql(q) {
  const f = join(WORK, "q.sql");
  writeFileSync(f, q, "utf8");
  // Three Windows traps in a row here, hence the comment:
  //   * plain "npx" without shell:true -> spawnSync ENOENT (it is a .cmd shim)
  //   * "npx.cmd" without shell:true   -> spawnSync EINVAL (Node hardening
  //     refuses .cmd/.bat unless shell:true)
  //   * shell:true with the SQL in argv -> the shell split the query on spaces
  // So: shell:true, and the SQL travels in a FILE. The path is quoted because
  // shell:true re-parses the argument list.
  const out = execFileSync("npx",
    ["--no-install", "supabase@2.115.0", "db", "query", "--linked",
     "--project-ref", REF, "--file", JSON.stringify(f)],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: true });
  const first = out.indexOf("{");
  const last = out.lastIndexOf("}");
  if (first < 0 || last < first) throw new Error("no JSON back:\n" + out.slice(-600));
  const d = JSON.parse(out.slice(first, last + 1));
  if (!d.rows) throw new Error("query failed: " + JSON.stringify(d).slice(0, 400));
  return d.rows;
}

// Strip -- comments and every $$-quoted body, so statements INSIDE a function
// are not counted as objects the file itself creates.
function outerOnly(text) {
  let s = text.replace(/^\s*--.*$/gm, "").replace(/(\S)[ \t]+--[^\n]*/g, "$1");
  for (let i = 0; i < 25; i++) {
    const next = s.replace(/\$([a-zA-Z_]*)\$[\s\S]*?\$\1\$/g, " DOLLARBODY ");
    if (next === s) break;
    s = next;
  }
  return s;
}

const RULES = [
  ["table", /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_-]+)"?/gi],
  ["view", /create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_-]+)"?/gi],
  ["function", /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-z0-9_-]+)"?\s*\(/gi],
  ["type", /create\s+type\s+(?:public\.)?"?([a-z0-9_-]+)"?/gi],
  ["index", /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?"?([a-z0-9_-]+)"?/gi],
  ["trigger", /create\s+(?:or\s+replace\s+)?trigger\s+"?([a-z0-9_-]+)"?/gi],
  ["policy", /create\s+policy\s+"?([a-z0-9_ -]+?)"?\s+on\s+/gi],
];
const COLUMN_RE = /alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?/gi;

function objectsIn(text) {
  const body = outerOnly(text);
  const found = [];
  for (const [kind, re] of RULES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body)) !== null) found.push({ kind, name: m[1].toLowerCase() });
  }
  COLUMN_RE.lastIndex = 0;
  let c;
  while ((c = COLUMN_RE.exec(body)) !== null) {
    found.push({ kind: "column", name: (c[1] + "." + c[2]).toLowerCase() });
  }
  const seen = new Set();
  return found.filter((o) => {
    const k = o.kind + ":" + o.name;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

console.log("reading the catalog...");
const lower = (rows) => new Set(rows.map((r) => String(r.n).toLowerCase()));
const have = {
  table: lower(sql("select relname as n from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p')")),
  view: lower(sql("select relname as n from pg_class where relnamespace='public'::regnamespace and relkind in ('v','m')")),
  function: lower(sql("select distinct proname as n from pg_proc where pronamespace='public'::regnamespace")),
  type: lower(sql("select typname as n from pg_type where typnamespace='public'::regnamespace")),
  index: lower(sql("select relname as n from pg_class where relnamespace='public'::regnamespace and relkind='i'")),
  trigger: lower(sql("select tgname as n from pg_trigger where not tgisinternal")),
  policy: lower(sql("select policyname as n from pg_policies")),   // every schema: storage.objects policies are not in public
  column: lower(sql("select table_name || '.' || column_name as n from information_schema.columns where table_schema='public'")),
};
for (const k of Object.keys(have)) console.log("  " + k.padEnd(9) + have[k].size);

const adopted = sql("select filename from public.schema_migrations where origin='adopted' order by filename")
  .map((r) => r.filename);
console.log("\n" + adopted.length + " file(s) recorded as adopted.");

const verdicts = { LIVE: [], "NOT LIVE": [], PARTIAL: [], UNJUDGEABLE: [], MISSING_FILE: [] };
let n = 0;
for (const f of adopted) {
  const p = join(ROOT, f);
  if (!existsSync(p)) { verdicts.MISSING_FILE.push({ f }); continue; }
  let objs = objectsIn(readFileSync(p, "utf8"));
  // The canary plants an object nobody could have created, in EVERY file. Any
  // file still reading LIVE means the checker is not really asking.
  if (CANARY) objs = objs.concat([{ kind: "table", name: "zz_canary_never_created_" + (n++) }]);
  if (objs.length === 0) { verdicts.UNJUDGEABLE.push({ f, why: "creates no checkable object" }); continue; }
  const missing = objs.filter((o) => !have[o.kind].has(o.name));
  if (missing.length === 0) verdicts.LIVE.push({ f, n: objs.length });
  else if (missing.length === objs.length) verdicts["NOT LIVE"].push({ f, missing: missing.slice(0, 6) });
  else verdicts.PARTIAL.push({ f, missing: missing.slice(0, 6), of: objs.length });
}

for (const k of ["NOT LIVE", "PARTIAL", "UNJUDGEABLE", "MISSING_FILE", "LIVE"]) {
  const rows = verdicts[k];
  console.log("\n=== " + k + " (" + rows.length + ") ===");
  const show = k === "LIVE" && !CANARY ? rows.slice(0, 5) : rows.slice(0, 400);
  for (const r of show) {
    const detail = r.missing ? "  missing: " + r.missing.map((m) => m.kind + " " + m.name).join(", ")
      : r.why ? "  " + r.why : "";
    console.log("  " + r.f + detail);
  }
  if (show.length < rows.length) console.log("  ... and " + (rows.length - show.length) + " more");
}

if (CANARY) {
  const stillLive = verdicts.LIVE.length;
  console.log("\nCANARY: " + stillLive + " file(s) still read LIVE with an impossible object planted in each.");
  console.log(stillLive === 0
    ? "CANARY BITES -- the checker really does ask the database."
    : "CANARY FAILED -- the checker is not checking; every verdict is worthless.");
  process.exit(stillLive === 0 ? 0 : 1);
}

console.log("\nLIVE means the objects exist, NOT that this file's version of them is what runs:");
console.log("a later file may have replaced a function body wholesale.");
console.log("UNJUDGEABLE is not a pass -- those need reading by hand.");
