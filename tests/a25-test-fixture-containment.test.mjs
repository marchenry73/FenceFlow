// a25 -- TEST-FIXTURE CONTAINMENT. Fixtures live in the production database beside real
// customers. What exactly is a fixture, what excludes it from what a person is shown, what
// does not, which live suites need it, and how could it reach a real customer?
//
//   THIS FILE RECORDS GAPS. IT DOES NOT PROVE CONTAINMENT.
//   A green run means "the ledger in KNOWN_GAPS (and in supabase_r16_test_fixture_inventory.sql,
//   section 3b) is still accurate". Fix a gap and its test goes red until the gap is struck from
//   the ledger, so the record cannot go stale in either direction; a NEW fixture, a new consumer
//   or a new suite that leans on one turns a test red until it is written down.
//
// THREE LAYERS.
//   STATIC (always, pure, ~1 s): the seed files, the consumer map (which code reads the flag, which
//     reads the company NAME, which reads neither) and the findings file. Every checker matches CODE,
//     never comments (three checks in this project once read prose and called correct code broken),
//     and every checker is proven by a planted bad copy it must catch.
//   LIVE, read-only (A25FC_LIVE=1, ~30 s): SELECTs against production through the Supabase CLI
//     (`supabase db query --linked`), the technique of tests/a25-tenant-isolation.test.mjs. Each
//     block opens with POSITIVE CONTROLS: a marker query must find a fixture known to exist (Busy
//     season, by id AND by name AND by flag, or the result is INVALID, never "clean"). A failed CLI
//     call is retried and is never read as an empty answer. Function bodies are read from pg_proc,
//     never from a repo .sql file.
//   LIVE, rolled back (A25FC_LIVE=1): one transaction that builds SYNTHETIC companies and logins
//     (ids fc25xxxx-0000-4000-8000-..., names PROBE-FC25-..., addresses @probe.invalid), calls the
//     DEPLOYED admin_companies(), ar_aging(), job_costing() and business_report() as those logins
//     (`set local role authenticated` + a JWT, the strongest login a tenant can hold and a synthetic
//     platform operator), and ROLLS BACK. Real third-party rows are only COUNTED, never printed or
//     written. NEVER the service role: it bypasses row-level security, so nothing learned with it
//     would mean anything; this file never names it, never grants to it, never reads its key.
//     A25FC_FIXES=1 additionally applies blocks R1-R3 of the findings file INSIDE that rolled-back
//     transaction (they take a brief table lock on companies and jobs until the rollback) and demands
//     the new answers, the untouched row digests and the untouched suite fixtures.
//
//   node --test tests/a25-test-fixture-containment.test.mjs                       STATIC only
//   A25FC_LIVE=1 node --test tests/a25-test-fixture-containment.test.mjs           + LIVE
//   A25FC_LIVE=1 A25FC_FIXES=1 node --test tests/a25-test-fixture-containment.test.mjs   + the proposal, rolled back
//
// NOTHING SURVIVES. After each rolled-back run the catalogue is compared with what it was before:
// no synthetic row, column, function or trigger is left, and no HTTP call was queued.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT = "newcrgafcptspmapacrx";
const ROOT = process.cwd();
const LIVE = process.env.A25FC_LIVE === "1";
const FIXES = process.env.A25FC_FIXES === "1";
const THIS = "a25-test-fixture-containment.test.mjs";
const FINDINGS_FILE = "supabase_r16_test_fixture_inventory.sql";
const read = (f) => readFileSync(join(ROOT, f), "utf8");

// ================================================================= the ledger =====
/** Every gap this audit found, dated 2026-09-29. Struck only when the gap is genuinely closed. */
export const KNOWN_GAPS = {
  G1: "the admin portal counts fixture companies (Companies +4, On trial +2, MRR +$349, the table and the CSV), and its Jobs column counts a company's own flagged jobs",
  G2: "there is no company-level flag: jobs.is_test_fixture is the only fixture column in the schema",
  G3: "ar_aging() and job_costing() return flagged jobs; only their callers fence them (business_report() and the dashboard do; nothing forces a new caller to)",
  G4: "a tenant can write jobs.is_test_fixture on its own jobs, and can rename its company to or from a fixture name",
  G5: "fixtures live inside the real company (3 jobs, including the only live payment row) and live suites pin 13 real rows by id",
  G6: "fixture-shaped rows match no marker: 2 live jobs whose payments were retired as test data (plus a fictional-name job and 2 companies the database cannot classify)",
  G7: "public entry points carry FIXED tokens (2 quote tokens, 1 leads token) and quote-view, create-payment-link, notify-job-change and lead-intake never refuse a fixture",
  G8: "no seed file sets the flag on the jobs it inserts; it was applied once by a name-pattern backfill",
};

/** Which code reads which marker. "none" means the file never mentions any marker, comments included. */
export const CONSUMERS = [
  { id: "admin portal (tiles, table, CSV)", file: "website/admin.html", marker: "none" },
  { id: "office dashboard (job list)", file: "website/dashboard.html", marker: "flag", shape: /jobs\s*=\s*visibleJobs\(\s*allJobsLoaded/ },
  { id: "office dashboard (money rows)", file: "website/dashboard.html", marker: "flag", shape: /function\s+onlyVisibleRows\(/ },
  { id: "send-follow-ups (automatic email to customers)", file: "supabase/functions/send-follow-ups/index.ts", marker: "flag", shape: /\.eq\(\s*"is_test_fixture"\s*,\s*false\s*\)/ },
  { id: "send-welcome-email (to company owners)", file: "supabase/functions/send-welcome-email/index.ts", marker: "name", shape: /\^\\s\*zz test\/i\.test\(/ },
  { id: "phone JobSync pull", file: "app/src/main/java/com/fenceestimator/app/cloud/JobSync.kt", marker: "flag", shape: /filterNot\s*\{\s*it\.isTestFixture\s*\}/ },
  { id: "quote-view (public, by token)", file: "supabase/functions/quote-view/index.ts", marker: "none" },
  { id: "create-payment-link", file: "supabase/functions/create-payment-link/index.ts", marker: "none" },
  { id: "stripe-webhook", file: "supabase/functions/stripe-webhook/index.ts", marker: "none" },
  { id: "square-webhook", file: "supabase/functions/square-webhook/index.ts", marker: "none" },
  { id: "notify-job-change (push to that company's staff)", file: "supabase/functions/notify-job-change/index.ts", marker: "none" },
  // Reads the flag only THROUGH the function it calls: attention_sweep_candidates() tests it in every branch
  // (checked live by cat.objects_that_test_the_flag). The file itself never mentions a marker, so "rpc", not "none".
  { id: "attention-sweep (push to owners and managers)", file: "supabase/functions/attention-sweep/index.ts", marker: "rpc", shape: /\.rpc\(\s*"attention_sweep_candidates"\s*\)/ },
  { id: "lead-intake (public, by leads token)", file: "supabase/functions/lead-intake/index.ts", marker: "none" },
];

/** The seed files and what they insert into jobs; none of them sets the flag. */
export const SEEDS = {
  "supabase_test_company.sql": 1,
  "supabase_test_companies.sql": 1,
  "supabase_rules_guard_fixtures.sql": 1,
  "supabase_test_crew_fixtures.sql": 0,
  "supabase_fix_test_fixture_ledger.sql": 0,
};

// ==================================================================== helpers =====
/** Source with block comments and whole-line comments removed: what a checker may match against. */
export function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|--|\*)/.test(l))
    .join("\n");
}
/** SQL with `--` comments removed. */
export const sqlCode = (s) => s.replace(/--.*$/gm, "");

/** The insert-into-jobs statements in a SQL file, and whether each names is_test_fixture. */
export function jobInserts(sql) {
  const out = [];
  for (const m of sqlCode(sql).matchAll(/insert\s+into\s+(?:public\.)?jobs\s*\(([^)]*)\)/gi)) {
    const cols = m[1].split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
    out.push({ cols, setsFlag: cols.includes("is_test_fixture") });
  }
  return out;
}

/**
 * What a piece of code does about fixtures. "none": the source never mentions any marker (comments
 * included, which is the stronger claim). "flag"/"name": the code-shape that reads that marker is
 * present in CODE. "mentioned": a marker appears somewhere but the file was expected to have none.
 * "shape-missing": the file was expected to read a marker and the code shape is not there.
 */
export function consumerMarker(src, c) {
  if (c.marker === "none") return /is_test_fixture|isTestFixture|zz[ _]test/i.test(src) ? "mentioned" : "none";
  return c.shape.test(code(src)) ? c.marker : "shape-missing";
}

/** The SQL between `-- >>> Rn` and `-- <<< Rn` (R1, R2, R3, V). */
export function blocks(sql) {
  const out = {};
  for (const m of sql.matchAll(/^-- >>> (R\d|V)\s*$([\s\S]*?)^-- <<< \1\s*$/gm)) out[m[1]] = m[2].trim();
  return out;
}

/** What the findings file must never do. Reads CODE, function bodies included. Returns sentences. */
export function findingsProblems(sql) {
  const problems = [];
  const raw = sql;
  const src = sqlCode(raw);
  const outside = src.replace(/\$function\$[\s\S]*?\$function\$/g, "");
  if (!/STATUS: NOT APPLIED/.test(raw.slice(0, 800))) problems.push("header does not say NOT APPLIED");
  if (!/^begin;/i.test(src.trim())) problems.push("does not open with begin;");
  if (!/rollback;$/i.test(src.trim())) problems.push("does not end with rollback;");
  if ((src.match(/\bcommit\b/gi) ?? []).length) problems.push("commits");
  if ((src.match(/\brollback\b/gi) ?? []).length !== 1) problems.push("not exactly one rollback");
  if (/\bdelete\s+from\b/i.test(src)) problems.push("deletes rows");
  if (/\btruncate\b/i.test(src)) problems.push("truncates");
  if (/\bdrop\s+(table|column|schema|function|trigger|policy|view|index|type|constraint)\b/i.test(src)) problems.push("drops something");
  if (/\binsert\s+into\b/i.test(outside)) problems.push("inserts rows");
  if (/(?<!is_)service_role/i.test(src)) problems.push("names the service role");
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(raw)) problems.push("contains an email address");
  const updates = [...outside.matchAll(/\bupdate\s+(?:public\.)?\w+\s+set\b[\s\S]*?;/gi)].map((m) => m[0]);
  if (updates.length !== 1) problems.push(`has ${updates.length} UPDATE statements, expected exactly the four-company backfill`);
  else if (!/^update\s+public\.companies\s+set\s+is_test_fixture\s*=\s*true\s+where\s+id\s+in\s*\(\s*'11111111-1111-4111-8111-111111111111'\s*,\s*'22222222-2222-4222-8222-222222222001'\s*,\s*'22222222-2222-4222-8222-222222222002'\s*,\s*'22222222-2222-4222-8222-222222222003'\s*\)\s+and\s+name\s+ilike\s+'ZZ TEST%'\s*;$/i.test(updates[0].trim()))
    problems.push("the one UPDATE is not the by-id, by-name four-company backfill");
  for (const m of outside.matchAll(/\balter\s+table\b[^;]*;/gi))
    if (!/^alter\s+table\s+public\.companies\s+add\s+column\s+if\s+not\s+exists\s+is_test_fixture\s+boolean\s+not\s+null\s+default\s+false\s*;$/i.test(m[0].trim()))
      problems.push("an ALTER TABLE that is not the additive companies.is_test_fixture column");
  return problems;
}

// ============================================================= STATIC tests =====
test("STATIC: no seed file sets is_test_fixture on the jobs it inserts (RECORDED GAP G8)", () => {
  const seen = {};
  for (const f of Object.keys(SEEDS)) seen[f] = jobInserts(read(f));
  for (const [f, n] of Object.entries(SEEDS)) assert.equal(seen[f].length, n, `${f}: ${seen[f].length} inserts into jobs, ledger says ${n}`);
  const withFlag = Object.entries(seen).flatMap(([f, ins]) => ins.filter((i) => i.setsFlag).map(() => f));
  assert.deepEqual(withFlag, [], `G8 is no longer present: ${withFlag.join(", ")} now set the flag. Strike G8 from KNOWN_GAPS and from section 3b of ${FINDINGS_FILE}.`);
  // The flag is applied once, by a name pattern, in a file that inserts nothing.
  const backfill = sqlCode(read("supabase_test_fixture_flag.sql"));
  assert.match(backfill, /update\s+public\.jobs\s+set\s+is_test_fixture\s*=\s*true\s+where\s+customer_name\s+ilike\s+'ZZ TEST%'/i);
  assert.deepEqual(jobInserts(read("supabase_test_fixture_flag.sql")), []);
});

test("STATIC planted: the seed checker sees a flag in the column list and ignores one in a comment", () => {
  assert.deepEqual(jobInserts("insert into jobs (id, company_id, is_test_fixture) values (1,2,true);").map((i) => i.setsFlag), [true]);
  assert.deepEqual(jobInserts("-- is_test_fixture\ninsert into public.jobs (id, company_id) values (1,2);").map((i) => i.setsFlag), [false]);
  assert.deepEqual(jobInserts("select 1;"), []);
});

test("STATIC: who reads which marker -- the consumer map matches the ledger (RECORDED GAPS G1, G3, G7)", () => {
  const drift = [];
  for (const c of CONSUMERS) {
    const got = consumerMarker(read(c.file), c);
    if (got !== c.marker) drift.push(`${c.id} (${c.file}): ledger says ${c.marker}, code says ${got}`);
  }
  assert.deepEqual(drift, [], "a consumer changed how it treats fixtures: update CONSUMERS, and strike the gap it closes from KNOWN_GAPS and section 3b of " + FINDINGS_FILE);
  // The admin portal builds every tile from admin_companies() rows and applies no fixture test of its own.
  const admin = read("website/admin.html");
  assert.match(admin, /db\.rpc\('admin_companies'\)/);
  assert.match(admin, /<b>\$\{clients\.length\}\$\{floorMark\}<\/b><span>\$\{esc\(tr\('kpiCompanies'\)\)\}/);
  assert.match(admin, /const PLAN_PRICE = \{ solo: 99, crew: 199, pro: 349 \}/);
  assert.match(admin, /const activeNow = clients\.filter\(c => c\.subscription_status === 'active' && !c\.suspended\)/);
});

test("STATIC planted: the consumer checker is not fooled by a comment, and sees real code", () => {
  const flag = { marker: "flag", shape: /\.eq\(\s*"is_test_fixture"\s*,\s*false\s*\)/ };
  assert.equal(consumerMarker('// never a is_test_fixture job\nconst q = db.from("jobs");', flag), "shape-missing");
  assert.equal(consumerMarker('/* .eq("is_test_fixture", false) */\nconst q = 1;', flag), "shape-missing");
  assert.equal(consumerMarker('const q = db.from("jobs").eq("is_test_fixture", false);', flag), "flag");
  assert.equal(consumerMarker("// tests ZZ TEST names\nconst a = 1;", { marker: "none" }), "mentioned");
  assert.equal(consumerMarker("const a = 1;", { marker: "none" }), "none");
  assert.equal(code("a\n// b\n  * c\n/* d\ne */ f"), "a\n f");
});

test("STATIC: the fixed public tokens are written into a repo file (RECORDED GAP G7)", () => {
  const golden = code(read("tests/golden-path.test.mjs"));
  assert.match(golden, /ES_QUOTE_TOKEN\s*=\s*"11111111-1111-4111-8111-111111111501"/);
  assert.match(golden, /LEADS_TOKEN\s*=\s*"22222222-2222-4222-8222-222222222222"/);
  assert.match(golden, /functions\/v1\/quote-view\?t=\$\{ES_QUOTE_TOKEN\}/);
  assert.match(golden, /functions\/v1\/lead-intake\?c=\$\{LEADS_TOKEN\}/);
  // quote-view finds a job by token alone.
  assert.match(code(read("supabase/functions/quote-view/index.ts")), /\.eq\(\s*"quote_token"\s*,\s*token\s*\)/);
});

test("STATIC: the gap ledger and section 3b of the findings file list the same gaps", () => {
  const sql = read(FINDINGS_FILE);
  const listed = [...sql.matchAll(/^--\s+(G\d)\s{2}/gm)].map((m) => m[1]).sort();
  assert.deepEqual(listed, Object.keys(KNOWN_GAPS).sort());
});

test("STATIC: the findings file says it is unapplied, is one rolled-back transaction, and touches only what it says", () => {
  const sql = read(FINDINGS_FILE);
  assert.deepEqual(findingsProblems(sql), []);
  const b = blocks(sql);
  assert.deepEqual(Object.keys(b).sort(), ["R1", "R2", "R3", "V"]);
  for (const [n, body] of Object.entries(b)) assert.ok(body.length > 200, `${n} is nearly empty`);
  // R2 needs R1's column: R1 must come first in the file.
  assert.ok(sql.indexOf("-- >>> R1") < sql.indexOf("-- >>> R2") && sql.indexOf("-- >>> R2") < sql.indexOf("-- >>> R3"));
  // The four ids R1 flags are exactly the four ZZ TEST company ids the seed files create.
  const seedIds = new Set([...read("supabase_test_company.sql").matchAll(/'(11111111-1111-4111-8111-111111111111)'/g), ...read("supabase_test_companies.sql").matchAll(/'(22222222-2222-4222-8222-2222222220\d\d)'/g)].map((m) => m[1]));
  const r1Ids = new Set([...b.R1.matchAll(/'((?:11111111|22222222)-[0-9a-f-]{27})'/g)].map((m) => m[1]));
  assert.deepEqual([...r1Ids].sort(), [...seedIds].sort());
});

test("STATIC planted: the findings checker catches a delete, a drop, a commit, a second update, an email and the service role", () => {
  const good = "-- STATUS: NOT APPLIED\nbegin;\nselect 1;\nrollback;\n";
  assert.deepEqual(findingsProblems(good).filter((p) => !/UPDATE/.test(p)), []);
  const bad = (extra) => findingsProblems(`-- STATUS: NOT APPLIED\nbegin;\n${extra}\nrollback;\n`);
  assert.ok(bad("delete from public.jobs;").includes("deletes rows"));
  assert.ok(bad("truncate public.jobs;").includes("truncates"));
  assert.ok(bad("drop table public.jobs;").includes("drops something"));
  assert.ok(bad("commit;").includes("commits"));
  assert.ok(bad("insert into public.jobs(id) values (1);").includes("inserts rows"));
  assert.ok(bad("grant all on public.jobs to service_role;").includes("names the service role"));
  assert.ok(!bad("select public.is_service_role();").includes("names the service role"), "is_service_role() is a helper, not the role");
  assert.ok(bad("select 'someone@example.com';").includes("contains an email address"));
  assert.ok(bad("update public.jobs set notes = '';").some((p) => /UPDATE/.test(p)));
  assert.ok(bad("alter table public.jobs drop column notes;").length > 0);
  assert.ok(bad("alter table public.jobs add column x int;").includes("an ALTER TABLE that is not the additive companies.is_test_fixture column"));
  assert.ok(findingsProblems("begin;\nselect 1;\nrollback;\n").includes("header does not say NOT APPLIED"));
  assert.ok(findingsProblems("-- STATUS: NOT APPLIED\nselect 1;\ncommit;\n").includes("does not open with begin;"));
  assert.deepEqual(blocks("-- >>> R9\nselect 1;\n-- <<< R9\n"), { R9: "select 1;" });
  // A destructive statement inside a function body is still read.
  assert.ok(bad("create function f() returns void as $function$ begin delete from x where true; end $function$ language plpgsql;").includes("deletes rows"));
});

test("STATIC: the file does not change source it does not own", () => {
  // The two files this audit owns; the rest of the tree is only read.
  assert.ok(readFileSync(join(ROOT, "tests", THIS), "utf8").length > 1000);
  assert.ok(read(FINDINGS_FILE).length > 1000);
});

// ================================================================ LIVE machinery =====
const jsq = (s) => String(s).replace(/'/g, "''");
const L = (s) => `'${jsq(s)}'`;
const q = (s) => `'${s}'`;

/** Runs SQL through the Supabase CLI. A SQL error is an answer and is thrown; a flake is retried; a failed call is never an empty result. */
function runSql(sql, label) {
  const dir = mkdtempSync(join(tmpdir(), "a25fc-"));
  const file = join(dir, "probe.sql");
  writeFileSync(file, sql, "utf8");
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query", "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
      { encoding: "utf8", shell: process.platform === "win32", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
    const err = `${r.stderr ?? ""}${r.stdout ?? ""}`;
    if (/Failed to run sql query|ERROR:/.test(err) && !/"rows"/.test(r.stdout ?? "")) {
      throw new Error(`${label}: the database refused the query:\n${err.slice(0, 1800)}`);
    }
    if (r.status === 0) {
      const out = r.stdout ?? "";
      const a = out.indexOf("{"), b = out.lastIndexOf("}");
      if (a >= 0 && b > a) {
        const parsed = JSON.parse(out.slice(a, b + 1));
        const rows = Array.isArray(parsed) ? parsed : parsed.rows;
        if (Array.isArray(rows) && rows.length > 0) return rows;
      }
    }
    last = err.slice(0, 600);
  }
  throw new Error(`${label}: no usable answer after 3 attempts (a failed call is not an empty result): ${last}`);
}

/** exact | >=N | ERR sqlstate-prefix | a|b alternatives | info */
export function matches(got, want) {
  if (want === "info") return true;
  return String(want).split("|").some((alt) => {
    if (alt.startsWith(">=")) return Number(got) >= Number(alt.slice(2));
    if (alt.startsWith("ERR ")) return String(got).startsWith(alt);
    return String(got) === alt;
  });
}
test("STATIC: the answer matcher (exact, >=N, ERR prefix, alternatives, info)", () => {
  assert.ok(matches("4", "4") && !matches("5", "4") && !matches("40", "4"));
  assert.ok(matches("10", ">=4") && !matches("3", ">=4"));
  assert.ok(matches("ERR 42501: permission denied", "ERR 42501") && !matches("ERR 42883: x", "ERR 42501"));
  assert.ok(matches("b", "a|b") && !matches("c", "a|b"));
  assert.ok(matches("anything", "info"));
  assert.ok(!matches("NULL", "0"), "a null is not a zero");
});

// ================================================================ the inventory =====
const NS = "^(11111111|22222222|33333333|44444444|55555555)-";   // the persistent fixture id namespaces
const BUSY = "22222222-2222-4222-8222-222222222003";
const ZZ = "ilike 'ZZ TEST%'";
const FIXTURE_JOB = (j, c) => `(${j}.is_test_fixture or ${c}.name ${ZZ})`;
const ON_FIXTURE_JOB = (x) => `exists (select 1 from public.jobs j join public.companies c on c.id = j.company_id where j.company_id = ${x}.company_id and j.sync_id = ${x}.job_sync_id and ${FIXTURE_JOB("j", "c")})`;
const PAY_ON_FIXTURE = `from public.payment_records p join public.jobs j on j.company_id = p.company_id and j.sync_id = p.job_sync_id join public.companies c on c.id = p.company_id where p.deleted_at is null and ${FIXTURE_JOB("j", "c")}`;
const LOOKALIKE = `from public.jobs j join public.companies c on c.id = j.company_id where j.deleted_at is null and not j.is_test_fixture and c.name not ${ZZ} and exists (select 1 from public.payment_records p where p.company_id = j.company_id and p.job_sync_id = j.sync_id and p.deleted_at is not null and p.deleted_by ilike 'retired % test job%')`;
const NS_TOTAL = (t, col) => `select count(*) from public.${t} x where x.${col}::text ~ '${NS}'`;
const UNREACHED = (t, col) => `select count(*) from public.${t} x where x.${col}::text ~ '${NS}' and not ${ON_FIXTURE_JOB("x")}`;

// Every public base table that has a company_id column: the universe the table sweep below walks, so the
// answer does not depend on a hand-picked list of tables. (query_to_xml runs one SELECT per table.)
const COMPANY_KEYED = `from information_schema.columns c join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE' where c.table_schema = 'public' and c.column_name = 'company_id'`;
const COMPANY_KEYED_TABLES_COUNT = `select count(*) ${COMPANY_KEYED}`;
// "offset 0" is a fence: without it the planner may run the per-table count on a table that has no company_id before the column filter.
const TABLES_HOLDING_FIXTURE_ROWS = `select coalesce(string_agg(s.table_name, ',' order by s.table_name), 'NONE') from (select t.table_name from (select c.table_name ${COMPANY_KEYED} offset 0) t where (xpath('/row/a/text()', query_to_xml(format('select count(*) as a from public.%I x where x.company_id in (select id from public.companies where name ilike ''ZZ TEST%%'')', t.table_name), false, true, '')))[1]::text::int > 0) s`;
const ROWS_IN_FIXTURE_COMPANIES = (t) => `select count(*) from public.${t} x join public.companies c on c.id = x.company_id where c.name ${ZZ}`;

// Would send-follow-ups (supabase/functions/_shared/follow-up-logic.ts dueFollowUp) pick this job? The four conditions are
// copied from that function and use the company's OWN thresholds. The kind is decided by timestamps, NOT by status.
// onlyOn = true also requires the master switch and that kind's own switch, i.e. "would be emailed on the next run".
const FOLLOW_UP_CONDITIONS = (onlyOn) => {
  const on = (col) => (onlyOn ? `f.enabled and f.${col} and ` : "");
  return `(${on("approved_no_deposit_enabled")}j.quote_approved_at is not null and coalesce(j.deposit_amount, 0) > 0.005 and coalesce(j.amount_paid, 0) < 0.005 and extract(epoch from now() - j.quote_approved_at) / 86400 >= f.approved_no_deposit_days)` +
    ` or (${on("quote_viewed_not_approved_enabled")}j.quote_viewed_at is not null and j.quote_approved_at is null and extract(epoch from now() - j.quote_viewed_at) / 86400 >= f.quote_viewed_not_approved_days)` +
    ` or (${on("quote_sent_no_view_enabled")}j.quote_sent_at is not null and j.quote_viewed_at is null and j.quote_approved_at is null and extract(epoch from now() - j.quote_sent_at) / 86400 >= f.quote_sent_no_view_days)` +
    ` or (${on("new_lead_not_contacted_enabled")}j.status in ('DRAFT', 'SENT') and j.first_contact_at is null and extract(epoch from now() - j.created_at) / 3600 >= f.new_lead_not_contacted_hours)`;
};
const LOOKALIKES_REACHED = (onlyOn) => `select count(*) ${LOOKALIKE} and j.opted_out_at is null and j.email <> '' and exists (select 1 from public.follow_up_settings f where f.company_id = j.company_id and (${FOLLOW_UP_CONDITIONS(onlyOn)}))`;

/** [key, scalar SQL, recorded answer, gap]. ctl.* are the positive controls: they must hold or nothing after them means anything. */
const INVENTORY = [
  // ---- controls: each marker must be able to SEE a fixture known to exist
  ["ctl.companies", "select count(*) from public.companies", ">=4", null],
  ["ctl.busy_found_by_id", `select count(*) from public.companies where id = '${BUSY}'`, "1", null],
  ["ctl.busy_found_by_name", `select count(*) from public.companies where id = '${BUSY}' and name ${ZZ}`, "1", null],
  ["ctl.busy_jobs_found_by_flag", `select count(*) from public.jobs where company_id = '${BUSY}' and is_test_fixture`, ">=1", null],
  ["ctl.busy_jobs_found_by_namespace", `select count(*) from public.jobs where company_id = '${BUSY}' and sync_id::text ~ '${NS}'`, ">=1", null],
  ["ctl.a_real_company_is_not_a_fixture", `select count(*) from public.companies where name not ${ZZ}`, ">=1", null],
  ["ctl.profiles", "select count(*) from public.profiles", ">=1", null],
  ["ctl.payment_rows", "select count(*) from public.payment_records", ">=1", null],
  ["ctl.job_payment_rows", "select count(*) from public.job_payments", ">=1", null],
  ["ctl.rows_in_a_fixture_namespace", `select ((${NS_TOTAL("jobs", "sync_id")}) + (${NS_TOTAL("estimate_line_items", "job_sync_id")}))`, ">=10", null],
  ["ctl.views", "select count(*) from pg_views where schemaname = 'public'", ">=1", null],
  ["ctl.admin_read_policy_on_companies", "select count(*) from pg_policies where schemaname = 'public' and tablename = 'companies' and qual ilike '%is_platform_admin%'", ">=1", null],
  ["ctl.hold_triggers_on_jobs", "select count(*) from pg_trigger where tgrelid = 'public.jobs'::regclass and not tgisinternal and tgname like '00%hold%'", ">=1", null],
  ["ctl.jobs_with_a_quote_token", "select count(*) from public.jobs where quote_token is not null", ">=1", null],
  ["ctl.company_keyed_tables", COMPANY_KEYED_TABLES_COUNT, ">=40", null],
  ["ctl.follow_up_settings_rows", "select count(*) from public.follow_up_settings", ">=1", null],
  // ---- what the markers find (fixture side only, so a real customer signing up never turns this red)
  ["m.companies_by_name", `select count(*) from public.companies where name ${ZZ}`, "4", "G1"],
  ["m.companies_by_namespace", `select count(*) from public.companies where id::text ~ '${NS}'`, "4", null],
  ["m.jobs_by_flag", "select count(*) from public.jobs where is_test_fixture", "10", null],
  ["m.jobs_by_name", `select count(*) from public.jobs where customer_name ${ZZ}`, "10", null],
  ["m.jobs_by_namespace", `select count(*) from public.jobs where sync_id::text ~ '${NS}'`, "10", null],
  ["m.jobs_where_all_three_markers_agree", `select count(*) from public.jobs where is_test_fixture and customer_name ${ZZ} and sync_id::text ~ '${NS}'`, "10", null],
  ["m.jobs_in_a_fixture_company_not_flagged", `select count(*) from public.jobs j join public.companies c on c.id = j.company_id where c.name ${ZZ} and not j.is_test_fixture`, "0", "G8"],
  ["m.jobs_flagged_inside_a_real_company", `select count(*) from public.jobs j join public.companies c on c.id = j.company_id where j.is_test_fixture and c.name not ${ZZ}`, "3", "G5"],
  ["m.logins_inside_fixture_companies", `select count(*) from public.profiles p join public.companies c on c.id = p.company_id where c.name ${ZZ}`, "0", null],
  // ---- a fixture row that matches no marker cannot be excluded by anything
  ["m.namespace_rows_reachable_by_no_marker",
    `select ((${UNREACHED("estimate_line_items", "job_sync_id")}) + (${UNREACHED("payment_records", "job_sync_id")}) + (${UNREACHED("job_steps", "job_sync_id")})` +
    ` + (select count(*) from public.jobs j join public.companies c on c.id = j.company_id where j.sync_id::text ~ '${NS}' and not ${FIXTURE_JOB("j", "c")})` +
    ` + (select count(*) from public.employees x join public.companies c on c.id = x.company_id where x.sync_id::text ~ '${NS}' and c.name not ${ZZ})` +
    ` + (select count(*) from public.customers x join public.companies c on c.id = x.company_id where x.sync_id::text ~ '${NS}' and c.name not ${ZZ})` +
    ` + (select count(*) from public.time_entries x join public.companies c on c.id = x.company_id where x.sync_id::text ~ '${NS}' and c.name not ${ZZ}))`, "0", null],
  // ---- the fixture rows underneath the jobs and companies
  ["kids.employees_in_fixture_companies", `select count(*) from public.employees x join public.companies c on c.id = x.company_id where c.name ${ZZ}`, "2", null],
  ["kids.customers_in_fixture_companies", `select count(*) from public.customers x join public.companies c on c.id = x.company_id where c.name ${ZZ}`, "2", null],
  ["kids.time_entries_in_fixture_companies", `select count(*) from public.time_entries x join public.companies c on c.id = x.company_id where c.name ${ZZ}`, "1", null],
  ["kids.line_items_on_fixture_jobs", `select count(*) from public.estimate_line_items x where ${ON_FIXTURE_JOB("x")}`, "9", null],
  ["kids.fence_runs_on_fixture_jobs", `select count(*) from public.fence_runs x where ${ON_FIXTURE_JOB("x")}`, "1", null],
  ["kids.job_steps_on_fixture_jobs", `select count(*) from public.job_steps x where ${ON_FIXTURE_JOB("x")}`, "25", null],
  ["kids.stored_files_on_fixture_jobs", "select count(*) from storage.objects o where o.bucket_id = 'job-files' and exists (select 1 from public.jobs j where o.name like j.company_id::text || '/' || j.sync_id::text || '/%' and j.is_test_fixture)", "1", null],
  // ---- payments: the two records on the Busy-season company, and the one in the real company
  ["pay.live_rows_on_fixtures", `select count(*) ${PAY_ON_FIXTURE}`, "3", "G5"],
  ["pay.live_sum_on_fixtures", `select coalesce(round(sum(p.amount)::numeric, 2), 0) ${PAY_ON_FIXTURE}`, "26374.00", null],
  ["pay.live_rows_in_fixture_companies", `select count(*) from public.payment_records p join public.companies c on c.id = p.company_id where p.deleted_at is null and c.name ${ZZ}`, "2", null],
  ["pay.live_sum_in_fixture_companies", `select coalesce(round(sum(p.amount)::numeric, 2), 0) from public.payment_records p join public.companies c on c.id = p.company_id where p.deleted_at is null and c.name ${ZZ}`, "19204.00", null],
  ["pay.live_rows_on_fixtures_in_the_real_company", `select count(*) ${PAY_ON_FIXTURE} and c.name not ${ZZ}`, "1", "G5"],
  ["pay.live_sum_on_fixtures_in_the_real_company", `select coalesce(round(sum(p.amount)::numeric, 2), 0) ${PAY_ON_FIXTURE} and c.name not ${ZZ}`, "7170.00", "G5"],
  ["jp.rows_on_fixture_jobs", "select count(*) from public.job_payments jp join public.jobs j on j.company_id = jp.company_id and j.sync_id = jp.job_sync_id where j.is_test_fixture", "1", null],
  ["jp.live_mode_rows_on_fixture_jobs", "select count(*) from public.job_payments jp join public.jobs j on j.company_id = jp.company_id and j.sync_id = jp.job_sync_id where j.is_test_fixture and jp.livemode", "0", null],
  // ---- no marker: rows the owner himself called test data, live and unflagged
  ["lk.live_unflagged_jobs_whose_payments_were_retired_as_test", `select count(*) ${LOOKALIKE}`, "2", "G6"],
  ["lk.their_contract_total", `select coalesce(round(sum(j.contract_total)::numeric, 2), 0) ${LOOKALIKE}`, "35810.00", "G6"],
  ["lk.their_retired_payment_rows", `select count(*) from public.payment_records p where p.deleted_by ilike 'retired % test job%' and exists (select 1 ${LOOKALIKE} and j.company_id = p.company_id and j.sync_id = p.job_sync_id)`, "11", "G6"],
  // ---- which tables hold a fixture company's rows at all (a table missing from this list is one nobody has looked at)
  ["cat.tables_holding_rows_of_a_fixture_company", TABLES_HOLDING_FIXTURE_ROWS, "audit_log,customers,employees,estimate_line_items,jobs,payment_records,sync_signals,time_entries", null],
  // ---- the follow-up mailer: the one AUTOMATIC sender to a customer address. Dormant only while its switches stay off.
  ["fu.lookalikes_reached_if_every_kind_were_on", LOOKALIKES_REACHED(false), "2", "G6"],
  ["danger.follow_up_kinds_switched_on", "select count(*) from public.follow_up_settings f, lateral (values (f.new_lead_not_contacted_enabled), (f.quote_sent_no_view_enabled), (f.quote_viewed_not_approved_enabled), (f.approved_no_deposit_enabled)) v(k) where f.enabled and v.k", "0", null],
  ["danger.lookalikes_a_kind_that_is_on_would_email", LOOKALIKES_REACHED(true), "0", null],
  // ---- the catalogue: which columns, functions, policies and triggers exist
  ["cat.fixture_columns_in_the_schema", "select coalesce(string_agg(c.table_name || '.' || c.column_name, ',' order by c.table_name, c.column_name), 'NONE') from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE' where c.table_schema = 'public' and c.column_name in ('is_test_fixture', 'is_fixture', 'is_test', 'is_demo', 'is_sandbox', 'is_synthetic')", "jobs.is_test_fixture", "G2"],
  ["cat.functions_reading_payment_records", "select coalesce(string_agg(proname, ',' order by proname), 'NONE') from pg_proc where pronamespace = 'public'::regnamespace and prosrc ~* 'payment_records'", "ar_aging,audit_changes,job_costing,recompute_job_totals", null],
  ["cat.views_reading_payment_records", "select count(*) from pg_views where schemaname = 'public' and definition ~* 'payment_records'", "0", null],
  ["cat.platform_admin_read_policies_on_money_tables", "select count(*) from pg_policies where schemaname = 'public' and tablename in ('payment_records', 'job_payments', 'jobs', 'estimate_line_items', 'employees', 'customers') and (qual ilike '%is_platform_admin%' or with_check ilike '%is_platform_admin%')", "0", null],
  ["cat.business_report_is_built_on_ar_aging_and_job_costing", "select coalesce((prosrc ~ 'public[.]job_costing[(]' and prosrc ~ 'public[.]ar_aging[(]')::text, 'NULL') from pg_proc where pronamespace = 'public'::regnamespace and proname = 'business_report'", "true", "G3"],
  ["cat.ar_aging_and_job_costing_test_the_flag", "select coalesce(string_agg(proname, ',' order by proname), 'NONE') from pg_proc where pronamespace = 'public'::regnamespace and proname in ('ar_aging', 'job_costing', 'admin_companies', 'admin_companies_count') and prosrc ilike '%is_test_fixture%'", "NONE", "G1|G3"],
  ["cat.objects_that_test_the_flag", "select string_agg(n, ',' order by n) from (select proname::text as n from pg_proc where pronamespace = 'public'::regnamespace and prosrc ilike '%is_test_fixture%' union all select viewname::text from pg_views where schemaname = 'public' and definition ilike '%is_test_fixture%') x", "attention_sweep_candidates,business_report,crew_save_job,jobs_crew", "G1|G3"],
  ["cat.objects_that_read_the_fixture_company_name", "select coalesce(string_agg(proname, ',' order by proname), 'NONE') from pg_proc where pronamespace = 'public'::regnamespace and prosrc ilike '%zz test%'", "NONE", null],
  ["cat.jobs_update_policy", "select coalesce(string_agg(qual, ' | '), 'NONE') from pg_policies where schemaname = 'public' and tablename = 'jobs' and cmd = 'UPDATE' and policyname = 'jobs_update'", "(company_id = current_company_id())", "G4"],
  ["cat.job_triggers_that_hold_the_flag", "select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid where t.tgrelid = 'public.jobs'::regclass and not t.tgisinternal and p.prosrc ilike '%is_test_fixture%'", "0", "G4"],
  ["cat.companies_update_policy", "select coalesce(string_agg(qual, ' | '), 'NONE') from pg_policies where schemaname = 'public' and tablename = 'companies' and cmd = 'UPDATE' and policyname = 'companies_update'", "((id = current_company_id()) AND (current_user_role() = 'OWNER'::user_role))", "G4"],
  // ---- public entry points
  ["tok.fixed_quote_tokens_on_fixture_jobs", `select count(*) from public.jobs where quote_token::text ~ '${NS}'`, "2", "G7"],
  ["tok.fixed_leads_tokens_on_fixture_companies", `select count(*) from public.companies where leads_token::text ~ '${NS}'`, "1", "G7"],
  // ---- facts to know, not asserted (they change legitimately at launch)
  ["info.live_payment_rows_that_are_not_fixtures", `select count(*) from public.payment_records p join public.jobs j on j.company_id = p.company_id and j.sync_id = p.job_sync_id join public.companies c on c.id = p.company_id where p.deleted_at is null and not ${FIXTURE_JOB("j", "c")}`, "info", null],
  ["info.live_mode_online_payment_rows", "select count(*) from public.job_payments where livemode", "info", null],
  ["info.audit_rows_in_fixture_companies", ROWS_IN_FIXTURE_COMPANIES("audit_log"), "info", null],
  ["info.sync_signal_rows_in_fixture_companies", ROWS_IN_FIXTURE_COMPANIES("sync_signals"), "info", null],
  ["info.sync_signal_rows_in_all_companies", "select count(*) from public.sync_signals", "info", null],
  ["info.companies_that_are_not_fixtures", `select count(*) from public.companies where name not ${ZZ}`, "info", null],
];

function inventoryQuery() {
  return INVENTORY.map(([k, sql], i) => `select ${i} as n, ${L(k)} as k, coalesce((${sql})::text, 'NULL') as v`).join("\nunion all\n") + "\norder by n;";
}
let inventoryRows = null;
const inventory = () => {
  if (!inventoryRows) {
    const rows = runSql(inventoryQuery(), "inventory");
    assert.equal(rows.length, INVENTORY.length, `${rows.length} answers for ${INVENTORY.length} questions: a question was lost`);
    INVENTORY.forEach(([k], i) => assert.equal(rows[i].k, k, `answer ${i} is ${rows[i].k}, expected ${k}`));
    inventoryRows = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  }
  return inventoryRows;
};
const invKeys = (gap) => INVENTORY.filter(([, , , g]) => g && g.split("|").includes(gap));
const explain = (gap, k, got, want) => `${gap} is no longer present as recorded (${k}: got ${got}, recorded ${want}). If that is a fix, strike ${gap} from KNOWN_GAPS and from section 3b of ${FINDINGS_FILE}.`;

test("LIVE: positive controls -- every marker can see a fixture known to exist, or nothing below means anything", { skip: !LIVE, timeout: 300_000 }, () => {
  const inv = inventory();
  const dead = INVENTORY.filter(([k, , want]) => k.startsWith("ctl.") && !matches(inv[k], want)).map(([k, , want]) => `${k}: got ${inv[k]}, want ${want}`);
  assert.deepEqual(dead, [], "INVALID: a control died, so the marker queries below could be blind. This is a broken probe, not a clean database.");
});

test("LIVE: the fixture inventory equals the recorded ledger (fixture side only; the real side is free to grow)", { skip: !LIVE, timeout: 300_000 }, () => {
  const inv = inventory();
  const off = INVENTORY.filter(([k, , want, gap]) => !k.startsWith("ctl.") && !k.startsWith("danger.") && !gap && !matches(inv[k], want)).map(([k, , want]) => `${k}: got ${inv[k]}, recorded ${want}`);
  assert.deepEqual(off, [], "the set of fixtures changed: a new fixture, or one removed. Update INVENTORY and section 1 of " + FINDINGS_FILE);
  console.log("\nFACTS TO KNOW (not asserted): " + INVENTORY.filter(([k]) => k.startsWith("info.")).map(([k]) => `${k.slice(5)} = ${inv[k]}`).join("; "));
});

test("LIVE: the three markers agree on jobs, and no fixture-namespace row is reachable by no marker", { skip: !LIVE, timeout: 300_000 }, () => {
  const inv = inventory();
  assert.equal(inv["m.jobs_by_flag"], inv["m.jobs_by_name"]);
  assert.equal(inv["m.jobs_by_flag"], inv["m.jobs_by_namespace"]);
  assert.equal(inv["m.jobs_by_flag"], inv["m.jobs_where_all_three_markers_agree"]);
  assert.equal(inv["m.namespace_rows_reachable_by_no_marker"], "0", "a fixture-namespace row hangs from no flagged job and no ZZ TEST company: nothing can exclude it");
  assert.equal(inv["m.logins_inside_fixture_companies"], "0", "a fixture company acquired a login: it is no longer only a fixture");
});

// ============================================================ the gaps, one by one =====
for (const gap of ["G2", "G5", "G6", "G7"]) {
  test(`LIVE: RECORDED GAP ${gap} (still present): ${KNOWN_GAPS[gap]}`, { skip: !LIVE, timeout: 300_000 }, () => {
    const inv = inventory();
    const bad = invKeys(gap).filter(([k, , want]) => !matches(inv[k], want)).map(([k, , want]) => explain(gap, k, inv[k], want));
    assert.deepEqual(bad, []);
  });
}
test("LIVE: RECORDED GAP G3/G1/G4 catalogue evidence (still present): the functions test no flag, the policies let a tenant write it", { skip: !LIVE, timeout: 300_000 }, () => {
  const inv = inventory();
  for (const gap of ["G1", "G3", "G4"]) {
    const bad = invKeys(gap).filter(([k, , want]) => !matches(inv[k], want)).map(([k, , want]) => explain(gap, k, inv[k], want));
    assert.deepEqual(bad, []);
  }
});

test("LIVE: what the automatic mailer would send on its next run reaches no lookalike (G6 is dormant ONLY while the follow-up kinds are off)", { skip: !LIVE, timeout: 300_000 }, () => {
  const inv = inventory();
  // Control: with every switch ignored, the same conditions DO reach the lookalikes (G6 test pins this at 2). If that ever reads 0
  // the "0" below no longer proves anything about the switches, so say so instead of passing quietly.
  assert.ok(Number(inv["fu.lookalikes_reached_if_every_kind_were_on"]) >= 1, "control: the reach query finds no lookalike even with every kind on, so the danger query below is blind (or G6 was resolved: strike it)");
  assert.equal(inv["danger.lookalikes_a_kind_that_is_on_would_email"], "0",
    `DANGER: ${inv["danger.follow_up_kinds_switched_on"]} follow-up kind(s) are switched on, and ${inv["danger.lookalikes_a_kind_that_is_on_would_email"]} job(s) the owner called test data (live, unflagged, their payments retired as test) match one. ` +
    `send-follow-ups emails the customer address on those jobs. Classify them (section 9 (a) of ${FINDINGS_FILE}: flag them, or opt them out) BEFORE the next run. Nothing in this database schedules the function (no pg_cron); an external caller is not visible from here.`);
  console.log(`\nFOLLOW-UP MAILER: kinds switched on = ${inv["danger.follow_up_kinds_switched_on"]}; lookalikes it would email today = ${inv["danger.lookalikes_a_kind_that_is_on_would_email"]}; lookalikes it WOULD reach with every kind on = ${inv["fu.lookalikes_reached_if_every_kind_were_on"]}`);
});

test("LIVE planted: the danger query has teeth -- it finds the lookalikes once the right kind is on, and not when only the master switch or the wrong kind is", { skip: !LIVE, timeout: 300_000 }, () => {
  // A TEMP COPY of the settings row is edited; no real table is written, not even inside a transaction that rolls back.
  const probe = (edit) => runSql(`begin;
create temp table fus as select * from public.follow_up_settings;
${edit};
select (select count(*) from pg_temp.fus)::text as copy_rows, (${LOOKALIKES_REACHED(true).replaceAll("public.follow_up_settings", "pg_temp.fus")})::text as reached;
rollback;`, "danger teeth")[0];
  const today = probe("select 1");
  assert.ok(Number(today.copy_rows) >= 1, "control: the temp copy is empty, so nothing below means anything");
  assert.equal(today.reached, "0", "with the settings as they are, nothing is reached");
  assert.equal(probe("update fus set quote_viewed_not_approved_enabled = true").reached, "2", "the viewed-not-approved kind reaches both lookalikes");
  assert.equal(probe("update fus set quote_viewed_not_approved_enabled = true, enabled = false").reached, "0", "a kind with the master switch off reaches nobody");
  assert.equal(probe("update fus set quote_sent_no_view_enabled = true, new_lead_not_contacted_enabled = true").reached, "0", "kinds that do not match these jobs reach nobody");
  assert.equal(Number(catalogue().http_calls), 0);
});

// ===================================================== the suites that need the fixtures =====
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
/** Every id the seed files create (companies, jobs, children, tokens), plus the leads token that was set by hand: the persistent fixtures. */
const SEED_IDS = new Set([
  ...["supabase_test_company.sql", "supabase_test_companies.sql", "supabase_rules_guard_fixtures.sql", "supabase_test_crew_fixtures.sql", "supabase_fix_test_fixture_ledger.sql"]
    .flatMap((f) => read(f).match(UUID) ?? []),
  "22222222-2222-4222-8222-222222222222",
]);
/** For every test file: does its CODE talk to the live database, and which ids does its CODE name? */
export function suiteFacts(dir = join(ROOT, "tests")) {
  return readdirSync(dir).filter((f) => /\.(mjs|mts)$/.test(f) && f !== THIS).map((f) => {
    const c = code(readFileSync(join(dir, f), "utf8"));
    return { f, live: c.includes("--linked"), ids: [...new Set(c.match(UUID) ?? [])] };
  });
}
test("STATIC planted: the suite scanner counts ids in code and ignores them in comments", () => {
  const dir = mkdtempSync(join(tmpdir(), "a25fc-suites-"));
  writeFileSync(join(dir, "live.test.mjs"), '// id 11111111-1111-4111-8111-111111111111 in a comment\nconst A = "22222222-2222-4222-8222-222222222003"; // spawn --linked\nspawnSync("x", ["--linked"]);\n');
  writeFileSync(join(dir, "mock.test.mjs"), 'const A = "22222222-2222-4222-8222-222222222003";\n');
  const facts = suiteFacts(dir);
  assert.deepEqual(facts.map((x) => [x.f, x.live, x.ids]).sort(), [["live.test.mjs", true, ["22222222-2222-4222-8222-222222222003"]], ["mock.test.mjs", false, ["22222222-2222-4222-8222-222222222003"]]]);
});

/** The recorded answer: live suites (their CODE touches production) that name a persistent fixture row, and live suites that pin a REAL row. */
export const LIVE_SUITES_READING_FIXTURES = [
  "company-crew-golden-path.test.mjs", "company-golden-path.test.mjs", "golden-path.test.mjs", "live-rules-guard.test.mjs", "shift-answer-and-followup-settings.test.mjs",
];
export const LIVE_SUITES_PINNING_REAL_ROWS = [
  "a4-labour.test.mjs", "downstream-job-costing.test.mjs", "live-rules-guard.test.mjs", "release-audience-guard.test.mjs", "shift-answer-and-followup-settings.test.mjs", "sync-clock-guard.test.mjs",
];

test("LIVE: which live suites read a fixture, which pin a real row, and that every fixture a suite needs still exists (RECORDED GAP G5)", { skip: !LIVE, timeout: 300_000 }, () => {
  const facts = suiteFacts();
  const all = [...new Set(facts.flatMap((x) => x.ids))];
  // The classifier: what is each id in the database, and is that a fixture (flagged job, ZZ TEST company, a token on one)?
  const zz = `co.name ${ZZ}`;
  const sql = `with t(id) as (values ${all.map((i) => `(${q(i)}::uuid)`).join(",")}),
hits as (
  select t.id, 'company' as kind, (c.name ${ZZ}) as fixture from t join public.companies c on c.id = t.id
  union all select t.id, 'job', (j.is_test_fixture or ${zz}) from t join public.jobs j on j.id = t.id or j.sync_id = t.id join public.companies co on co.id = j.company_id
  union all select t.id, 'employee', (${zz}) from t join public.employees e on e.id = t.id or e.sync_id = t.id join public.companies co on co.id = e.company_id
  union all select t.id, 'time_entry', (${zz}) from t join public.time_entries e on e.id = t.id or e.sync_id = t.id join public.companies co on co.id = e.company_id
  union all select t.id, 'customer', (${zz}) from t join public.customers e on e.id = t.id or e.sync_id = t.id join public.companies co on co.id = e.company_id
  union all select t.id, 'profile', coalesce(${zz}, false) from t join public.profiles e on e.id = t.id left join public.companies co on co.id = e.company_id
  union all select t.id, 'login_without_profile', false from t join auth.users u on u.id = t.id where not exists (select 1 from public.profiles p where p.id = t.id)
  union all select t.id, 'payment', (${zz}) from t join public.payment_records e on e.id = t.id join public.companies co on co.id = e.company_id
  union all select t.id, 'line_item', (${zz}) from t join public.estimate_line_items e on e.id = t.id or e.sync_id::text = t.id::text join public.companies co on co.id = e.company_id
  union all select t.id, 'quote_token', true from t join public.jobs j on j.quote_token = t.id
  union all select t.id, 'leads_token', (${zz}) from t join public.companies co on co.leads_token = t.id
)
select id::text as id, kind, fixture::text as fixture from hits order by 1, 2;`;
  const rows = runSql(sql, "suite dependencies");
  const hit = new Map();
  for (const r of rows) hit.set(r.id, { fixture: r.fixture === "true" || (hit.get(r.id)?.fixture ?? false), kind: r.kind });
  // Control: the scan must find rows at all, and must find a row that is certainly a fixture.
  assert.ok(hit.size >= 10, `only ${hit.size} pinned ids resolved to a row: the classifier is blind`);
  assert.ok(hit.get(BUSY)?.fixture === true, "the Busy-season company was not classified as a fixture: the classifier is wrong");
  const fixtureFiles = new Set(), realFiles = new Set(), fixtureRows = new Set(), realRows = new Set();
  for (const f of facts) if (f.live) for (const id of f.ids) {
    const h = hit.get(id);
    if (!h) continue;
    if (h.fixture) { fixtureFiles.add(f.f); fixtureRows.add(id); } else { realFiles.add(f.f); realRows.add(id); }
  }
  assert.deepEqual([...fixtureFiles].sort(), LIVE_SUITES_READING_FIXTURES, "the set of live suites that read a fixture changed: a suite started or stopped depending on one. Update the ledger; this decides whether a fixture can ever be removed.");
  assert.deepEqual([...realFiles].sort(), LIVE_SUITES_PINNING_REAL_ROWS, "the set of live suites pinned to a REAL row changed");
  assert.equal(fixtureRows.size, 13, `live suites name ${fixtureRows.size} distinct fixture rows, ledger says 13`);
  assert.equal(realRows.size, 13, `live suites pin ${realRows.size} distinct real rows, ledger says 13 (G5)`);
  // Every persistent-namespace id a live suite names must still be a row: removing a fixture would already have broken it.
  const needed = [...new Set(facts.filter((f) => f.live).flatMap((f) => f.ids.filter((i) => SEED_IDS.has(i))))];
  assert.ok(needed.length >= 8, `control: the live suites name only ${needed.length} seeded fixture ids, so the seeded-id set is wrong`);
  const missing = needed.filter((i) => !hit.has(i)).map((i) => `${i} (${facts.filter((f) => f.live && f.ids.includes(i)).map((f) => f.f).join(", ")})`);
  assert.deepEqual(missing, [], "a seeded fixture id that a live suite names no longer exists in the database: that suite is red, or about to be");
});

// ========================================================= the rolled-back probe =====
const hex = (n, w) => n.toString(16).padStart(w, "0");
/** kind 0 company, 1 login, 2 job, 3 payment. fc25xxxx-0000-4000-8000-...: never a real id, never a fixture namespace. */
export const fc = (kind, idx, n = 1) => `fc25${kind}${hex(idx, 3)}-0000-4000-8000-${hex(n, 12)}`;
const CO = { R: fc("0", 1), F: fc("0", 2), X: fc("0", 3) };
const U = { R: fc("1", 1), F: fc("1", 2), ADM: fc("1", 3), CREW: fc("1", 4), MGR: fc("1", 5) };
const J = { REAL: fc("2", 1), FIX: fc("2", 2), FCO: fc("2", 3), SELF: fc("2", 4), INH: fc("2", 5), INH2: fc("2", 6) };
const P = { REAL: fc("3", 1), FIX: fc("3", 2) };
const DIGESTED = ["jobs", "payment_records", "job_payments", "estimate_line_items", "employees", "customers", "time_entries", "material_items", "pricing_tiers", "profiles", "fence_runs", "job_steps"];

const jobInsert = (id, co, name, status, total, flag) =>
  `insert into public.jobs(id,company_id,sync_id,customer_name,address,phone,email,status,contract_total,quote_token,is_test_fixture,notes,hoa_name,permit_number,priced_by,pricing_engine_version,estimated_duration_hours,waste_percent,updated_at) values (${q(id)},${q(co)},${q(id)},${L(name)},'1 Probe Way','555-0100','fc25@probe.invalid','${status}',${total},gen_random_uuid(),${flag},'','','','','',4,10,'2026-01-01 00:00:00+00')`;

/** The helpers, the digest snapshot, and (with fixes) the proposal itself, applied at top level so the DDL is real inside the transaction. */
function prelude(fixes) {
  const digest = (tb) => `execute format('select coalesce(md5(string_agg(md5(x::text), '''' order by md5(x::text))), ''-'') from public.%I x where x.company_id not in (%L, %L, %L)', tb, '${CO.R}', '${CO.F}', '${CO.X}') into v;`;
  const b = fixes ? blocks(read(FINDINGS_FILE)) : null;
  return `
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create temp table r(n serial primary key, k text, got text, want text);
grant all on r to authenticated, anon;
grant usage on sequence r_n_seq to authenticated, anon;
create temp table snap(k text primary key, v text);

-- The caller's JWT and role are set INLINE: once the role is switched nothing else is called until it is reset.
create function pg_temp.q(kk text, who uuid, sq text, wt text) returns void language plpgsql as $fn$
declare v text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub',who,'role','authenticated','aud','authenticated')::text, true);
  execute 'set local role authenticated';
  begin execute sq into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,140); end;
  execute 'reset role';
  perform set_config('request.jwt.claims','',true);
  insert into r(k,got,want) values (kk,v,wt);
end $fn$;
create function pg_temp.x(kk text, who uuid, sq text, wt text) returns void language plpgsql as $fn$
declare c int; v text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub',who,'role','authenticated','aud','authenticated')::text, true);
  execute 'set local role authenticated';
  begin execute sq; get diagnostics c = row_count; v := 'rows=' || c;
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,140); end;
  execute 'reset role';
  perform set_config('request.jwt.claims','',true);
  insert into r(k,got,want) values (kk,v,wt);
end $fn$;
-- The reading-back side: the database owner, no JWT. It never attacks; it only looks.
create function pg_temp.s(kk text, sq text, wt text) returns void language plpgsql as $fn$
declare v text;
begin
  perform set_config('request.jwt.claims','',true);
  begin execute sq into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,140); end;
  insert into r(k,got,want) values (kk,v,wt);
end $fn$;

-- A fingerprint of every row a real company owns in one table (the probe's own three companies excluded).
create function pg_temp.dig(tb text) returns text language plpgsql as $fn$
declare v text;
begin
  ${digest("tb")}
  return v;
end $fn$;
create function pg_temp.dig_companies() returns text language plpgsql as $fn$
declare v text;
begin
  select coalesce(md5(string_agg(md5(row(id,name,phone,email,subscription_status,subscription_plan,suspended,monthly_price,trial_ends_at,leads_token,admin_notes)::text), '' order by id)), '-') into v
    from public.companies where id not in ('${CO.R}','${CO.F}','${CO.X}');
  return v;
end $fn$;
create function pg_temp.cmp(tb text) returns void language plpgsql as $fn$
declare now_v text; was text;
begin
  now_v := case when tb = 'companies' then pg_temp.dig_companies() else pg_temp.dig(tb) end;
  select v into was from snap where k = tb;
  insert into r(k,got,want) values ('DIG.' || tb, case when was = now_v then 'same' else 'CHANGED' end, 'same');
end $fn$;

insert into snap(k,v) select 'companies', pg_temp.dig_companies();
${DIGESTED.map((t) => `insert into snap(k,v) select '${t}', pg_temp.dig('${t}');`).join("\n")}

${b ? `-- ======== THE PROPOSAL, blocks R1, R2, R3 of ${FINDINGS_FILE}, applied inside this transaction only ========\n${b.R1}\n${b.R2}\n${b.R3}\n` : ""}
`;
}

/** The whole probe as one SQL text plus the ordered list of checks it makes. */
export function buildProbe({ fixes = false } = {}) {
  const body = [];
  const checks = [];
  const emit = (s) => body.push(s);
  // want: the answer today; wantFix: the answer with R1-R3 applied. null = the check only exists in that mode.
  const chk = (fn, k, who, sql, want, wantFix = want) => {
    const w = fixes ? wantFix : want;
    if (w === null) return;
    checks.push({ k, want: w });
    if (fn === "s") emit(`  perform pg_temp.s(${L(k)},$q$${sql}$q$,${L(w)});`);
    else emit(`  perform pg_temp.${fn}(${L(k)},${q(who)}::uuid,$q$${sql}$q$,${L(w)});`);
  };
  const count = (sql) => `select count(*)::text from ${sql}`;

  // ---------------------------------------------------------------- fixtures --
  emit(`  perform set_config('request.jwt.claims','',true);`);
  emit(`  insert into auth.users(id,email) values (${q(U.R)},'fc25-r@probe.invalid'),(${q(U.F)},'fc25-f@probe.invalid'),(${q(U.ADM)},'fc25-adm@probe.invalid'),(${q(U.CREW)},'fc25-crew@probe.invalid'),(${q(U.MGR)},'fc25-mgr@probe.invalid');`);
  const coRow = (id, name, lead) => `(${q(id)},${L(name)},'active','pro',false,now()+interval '30 days','',${q(lead)},'cus_FC25','','')`;
  emit(`  insert into public.companies(id,name,subscription_status,subscription_plan,suspended,trial_ends_at,admin_notes,leads_token,stripe_customer_id,invited_email,suspended_reason) values
    ${coRow(CO.R, "PROBE-FC25-REAL", fc("f", 1))}, ${coRow(CO.F, "PROBE-FC25-FIXTURE-CO", fc("f", 2))}, ${coRow(CO.X, "PROBE-FC25-OPERATOR", fc("f", 3))};`);
  emit(`  insert into public.profiles(id,company_id,full_name,role,is_platform_admin,permission_overrides) values
    (${q(U.R)},${q(CO.R)},'FC25 Owner R','OWNER',false,''), (${q(U.F)},${q(CO.F)},'FC25 Owner F','OWNER',false,''), (${q(U.ADM)},${q(CO.X)},'FC25 Operator','OWNER',true,''),
    (${q(U.CREW)},${q(CO.R)},'FC25 Crew R','CREW',false,''), (${q(U.MGR)},${q(CO.R)},'FC25 Manager R','MANAGER',false,'');`);
  emit(`  ${jobInsert(J.REAL, CO.R, "FC25 REAL CUSTOMER", "ACCEPTED", 10000, false)};`);
  emit(`  ${jobInsert(J.FIX, CO.R, "ZZ TEST FC25 fixture inside a real company", "ACCEPTED", 4200, true)};`);
  emit(`  ${jobInsert(J.FCO, CO.F, "ZZ TEST FC25 fixture in a fixture company", "ACCEPTED", 2000, true)};`);
  emit(`  insert into public.payment_records(id,sync_id,company_id,job_sync_id,amount,method,received_at,note,recorded_by) values
    (${q(P.REAL)},${q(P.REAL)},${q(CO.R)},${q(J.REAL)},2500,'check',now(),'','FC25'), (${q(P.FIX)},${q(P.FIX)},${q(CO.R)},${q(J.FIX)},300,'check',now(),'','FC25');`);
  if (fixes) {
    // The operator flags the synthetic fixture company through the same door a real operator would use.
    chk("x", "R1.the_operator_can_flag_a_company", U.ADM, `update public.companies set is_test_fixture = true where id = ${q(CO.F)}`, null, "rows=1");
  }

  // ---- controls: the probe can see its own rows
  chk("s", "ctl.the_three_probe_companies_exist", null, count(`public.companies where id in (${q(CO.R)},${q(CO.F)},${q(CO.X)})`), "3");
  chk("q", "ctl.the_owner_reads_its_own_real_job", U.R, count(`public.jobs where id = ${q(J.REAL)}`), "1");
  chk("q", "ctl.the_owner_reads_its_own_fixture_job", U.R, count(`public.jobs where id = ${q(J.FIX)}`), "1");
  chk("q", "ctl.the_operator_is_a_platform_admin", U.ADM, "select public.is_platform_admin()::text", "true");
  chk("q", "ctl.a_tenant_owner_is_not_a_platform_admin", U.R, "select public.is_platform_admin()::text", "false");

  // ---------------------------------------------------- G1: the admin portal --
  const trialing = "not c.suspended and (c.subscription_status = 'trialing' or (c.trial_ends_at is not null and c.trial_ends_at > now()))";
  const listPrice = "case lower(coalesce(c.subscription_plan,'')) when 'solo' then 99 when 'crew' then 199 when 'pro' then 349 else 0 end";
  chk("q", "G1.ctl.the_operator_lists_the_probe_companies", U.ADM, count("public.admin_companies() c where c.name like 'PROBE-FC25%'"), "3", "2");
  chk("q", "G1.the_operator_list_holds_fixture_companies", U.ADM, count("public.admin_companies() c where c.name like 'ZZ TEST%'"), "4", "0");
  chk("q", "G1.the_count_door_agrees_with_the_list", U.ADM, "select (public.admin_companies_count() - (select count(*) from public.admin_companies()))::text", "0");
  chk("q", "G1.the_count_door_counts_fixture_companies", U.ADM, "select (public.admin_companies_count() - (select count(*) from public.admin_companies() c where c.name not like 'ZZ TEST%'))::text", "4", "0");
  // Nothing else falls out of the operator's list: every company that is neither a fixture nor one of this probe's is still there.
  chk("q", "R2.ctl.every_real_company_is_still_listed", U.ADM, "select ((select count(*) from public.admin_companies() c where c.name not like 'ZZ TEST%' and c.name not like 'PROBE-FC25%') - (select count(*) from public.companies where name not like 'ZZ TEST%' and name not like 'PROBE-FC25%'))::text", "0");
  chk("q", "G1.tile_on_trial_counts_fixture_companies", U.ADM, count(`public.admin_companies() c where c.name like 'ZZ TEST%' and ${trialing}`), "2", "0");
  chk("q", "G1.tile_mrr_counts_fixture_companies", U.ADM, `select coalesce(sum(${listPrice}), 0)::text from public.admin_companies() c where c.name like 'ZZ TEST%' and c.subscription_status = 'active' and not c.suspended`, "349", "0");
  chk("q", "G1.jobs_column_counts_a_companys_flagged_jobs", U.ADM, `select c.jobs::text from public.admin_companies() c where c.id = ${q(CO.R)}`, "2", "1");

  // ------------------------------------------------- G3: the report functions --
  const bizJobs = (inc) => `select count(*)::text from jsonb_array_elements(coalesce((public.business_report(null, null, ${inc}))->'jobs', '[]'::jsonb)) e where e->>'job_sync_id' = ${q(J.FIX)}`;
  chk("q", "G3.ctl.ar_aging_lists_the_real_job", U.R, count(`public.ar_aging() where job_sync_id = ${q(J.REAL)}`), "1");
  chk("q", "G3.ar_aging_lists_the_fixture_job", U.R, count(`public.ar_aging() where job_sync_id = ${q(J.FIX)}`), "1");
  chk("q", "G3.ctl.job_costing_lists_the_real_job", U.R, count(`public.job_costing() where job_sync_id = ${q(J.REAL)}`), "1");
  chk("q", "G3.job_costing_lists_the_fixture_job", U.R, count(`public.job_costing() where job_sync_id = ${q(J.FIX)}`), "1");
  chk("q", "G3.ctl.business_report_lists_the_real_job", U.R, `select count(*)::text from jsonb_array_elements(coalesce((public.business_report(null, null, false))->'jobs', '[]'::jsonb)) e where e->>'job_sync_id' = ${q(J.REAL)}`, "1");
  chk("q", "G3.business_report_drops_the_fixture_job_by_default", U.R, bizJobs("false"), "0");
  chk("q", "G3.business_report_lists_it_when_the_owner_opts_in", U.R, bizJobs("true"), "1");
  chk("q", "G3.a_fixture_company_sees_its_own_fixture_job_in_ar_aging", U.F, count(`public.ar_aging() where job_sync_id = ${q(J.FCO)}`), "1");
  chk("q", "G3.a_fixture_company_sees_its_own_fixture_job_in_job_costing", U.F, count(`public.job_costing() where job_sync_id = ${q(J.FCO)}`), "1");

  // -------------------------------------------- G4: who may write the marker --
  chk("x", "G4.ctl.the_owner_updates_its_own_job", U.R, `update public.jobs set notes = 'FC25 touch' where id = ${q(J.REAL)}`, "rows=1");
  chk("x", "G4.a_tenant_sets_is_test_fixture_on_its_own_job", U.R, `update public.jobs set is_test_fixture = true where id = ${q(J.REAL)}`, "rows=1");
  chk("s", "G4.the_flag_after_the_tenant_wrote_it", null, `select is_test_fixture::text from public.jobs where id = ${q(J.REAL)}`, "true", "false");
  emit(`  update public.jobs set is_test_fixture = false where id = ${q(J.REAL)};`);
  chk("x", "G4.a_tenant_inserts_a_self_flagged_job", U.R, jobInsert(J.SELF, CO.R, "FC25 self-flagged", "DRAFT", 0, true), "rows=1");
  chk("s", "G4.the_flag_on_the_job_it_inserted", null, `select is_test_fixture::text from public.jobs where id = ${q(J.SELF)}`, "true", "false");
  // Who besides the owner may write the marker? A MANAGER and a CREW login of the same company (the crew phone's own write
  // funnel, crew_save_job(), refuses the column by design; this asks about a direct write to the table).
  chk("q", "G4.ctl.the_crew_login_is_a_crew_login", U.CREW, "select public.current_user_role()::text", "CREW");
  chk("q", "G4.ctl.the_manager_login_is_a_manager_login", U.MGR, "select public.current_user_role()::text", "MANAGER");
  chk("x", "G4.a_manager_sets_is_test_fixture_on_a_job", U.MGR, `update public.jobs set is_test_fixture = true where id = ${q(J.REAL)}`, "rows=1");
  chk("s", "G4.the_flag_after_the_manager_wrote_it", null, `select is_test_fixture::text from public.jobs where id = ${q(J.REAL)}`, "true", "false");
  emit(`  update public.jobs set is_test_fixture = false where id = ${q(J.REAL)};`);
  // A crew login cannot: 0 rows for the flag AND for an ordinary column (jobs_money_hidden_from_crew hides the row; crew work through jobs_crew and crew_save_job).
  chk("x", "G4.a_crew_touches_a_job_notes", U.CREW, `update public.jobs set notes = 'FC25 crew touch' where id = ${q(J.REAL)}`, "rows=0");
  chk("x", "G4.a_crew_sets_is_test_fixture_on_a_job", U.CREW, `update public.jobs set is_test_fixture = true where id = ${q(J.REAL)}`, "rows=0");
  chk("s", "G4.the_flag_after_the_crew_wrote_it", null, `select is_test_fixture::text from public.jobs where id = ${q(J.REAL)}`, "false");
  emit(`  update public.jobs set is_test_fixture = false where id = ${q(J.REAL)};`);
  chk("x", "G4.a_tenant_renames_its_company_to_a_fixture_name", U.R, `update public.companies set name = 'ZZ TEST FC25 renamed' where id = ${q(CO.R)}`, "rows=1");
  chk("s", "G4.the_name_after_the_tenant_wrote_it", null, `select name from public.companies where id = ${q(CO.R)}`, "ZZ TEST FC25 renamed");
  emit(`  update public.companies set name = 'PROBE-FC25-REAL' where id = ${q(CO.R)};`);
  chk("s", "G2.ctl.the_database_owner_flag_on_the_fixture_job_is_intact", null, `select is_test_fixture::text from public.jobs where id = ${q(J.FIX)}`, "true");

  // ------------------------------------------- the proposal (fixes only) ------
  chk("s", "G2.the_companies_table_has_a_flag_column", null, "select count(*)::text from information_schema.columns where table_schema = 'public' and table_name = 'companies' and column_name = 'is_test_fixture'", "0", "1");
  chk("q", "R1.the_helper_is_not_callable_by_a_tenant", U.R, `select public.is_fixture_company(${q(CO.R)})::text`, "ERR 42883", "ERR 42501");
  if (fixes) {
    chk("x", "R1.a_tenant_tries_to_flag_its_own_company", U.R, `update public.companies set is_test_fixture = true where id = ${q(CO.R)}`, null, "rows=1");
    chk("s", "R1.the_company_flag_after_the_tenant_wrote_it", null, `select is_test_fixture::text from public.companies where id = ${q(CO.R)}`, null, "false");
    chk("s", "R1.the_operator_flag_is_held", null, `select is_test_fixture::text from public.companies where id = ${q(CO.F)}`, null, "true");
    chk("x", "R3.a_tenant_inserts_into_a_fixture_company", U.F, jobInsert(J.INH, CO.F, "FC25 lead into a fixture company", "DRAFT", 0, false), null, "rows=1");
    chk("s", "R3.that_job_was_born_flagged", null, `select is_test_fixture::text from public.jobs where id = ${q(J.INH)}`, null, "true");
    chk("s", "R3.the_database_owner_may_set_the_flag_true", null, `select is_test_fixture::text from public.jobs where id = ${q(J.FIX)}`, null, "true");
    // The trusted branch (no request context: a seed file, a migration, a suite): a job inserted into a flagged company inherits it even when the insert says false.
    emit(`  ${jobInsert(J.INH2, CO.F, "FC25 seeded into a fixture company", "DRAFT", 0, false)};`);
    chk("s", "R3.a_database_owner_insert_into_a_fixture_company_inherits_the_flag", null, `select is_test_fixture::text from public.jobs where id = ${q(J.INH2)}`, null, "true");
    // ...and may still clear it (the owner-decision statement in the findings file is one such write).
    emit(`  update public.jobs set is_test_fixture = false where id = ${q(J.INH2)};`);
    chk("s", "R3.the_database_owner_may_clear_the_flag", null, `select is_test_fixture::text from public.jobs where id = ${q(J.INH2)}`, null, "false");
    chk("q", "R2.ctl.the_flag_is_visible_to_the_owner_of_a_fixture_company_job", U.F, count(`public.jobs where id = ${q(J.INH)}`), null, "1");
  }

  // -------------------------------- nothing real was touched, in either mode --
  for (const t of ["companies", ...DIGESTED]) {
    checks.push({ k: `DIG.${t}`, want: "same" });
    emit(`  perform pg_temp.cmp('${t}');`);
  }

  const sql = `${prelude(fixes)}
do $body$
begin
${body.join("\n")}
end $body$;

select n, k, got, want from r order by n;
rollback;
`;
  return { sql, checks };
}

/** The shape of the catalogue that must be identical before and after a rolled-back run. */
const CATALOGUE_SQL = `select
  (select count(*) from auth.users where email like 'fc25-%@probe.invalid') as users,
  (select count(*) from public.companies where name like 'PROBE-FC25%' or id::text like 'fc25%') as companies,
  (select count(*) from public.profiles where id::text like 'fc25%') as profiles,
  (select count(*) from public.jobs where id::text like 'fc25%' or company_id::text like 'fc25%') as jobs,
  (select count(*) from public.payment_records where company_id::text like 'fc25%') as payments,
  (select count(*) from public.audit_log where company_id::text like 'fc25%') as audit,
  (select count(*) from net.http_request_queue where body::text ilike '%fc25%' or url ilike '%fc25%') as http_calls,
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'companies' and column_name = 'is_test_fixture') as company_flag_column,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('hold_company_test_fixture', 'hold_job_test_fixture', 'is_fixture_company')) as proposed_functions,
  (select count(*) from pg_trigger where tgname in ('00_hold_company_test_fixture', '00_hold_test_fixture')) as proposed_triggers,
  (select md5(string_agg(md5(pg_get_functiondef(p.oid)), '' order by p.proname)) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('admin_companies', 'admin_companies_count', 'ar_aging', 'job_costing', 'business_report')) as report_functions;`;
const catalogue = () => runSql(CATALOGUE_SQL, "catalogue")[0];
const assertNothingLeft = (before) => {
  const after = catalogue();
  assert.deepEqual(after, before, "the probe left something behind (or queued an HTTP call): the rollback did not happen");
  for (const k of ["users", "companies", "profiles", "jobs", "payments", "audit", "http_calls"]) assert.equal(Number(after[k]), 0, `${k}: a synthetic row survived`);
};

function landed(rows, checks, label) {
  assert.equal(rows.length, checks.length, `${label}: ${rows.length} answers for ${checks.length} checks: a check was lost`);
  checks.forEach((c, i) => assert.equal(rows[i].k, c.k, `${label}: answer ${i} is ${rows[i].k}, expected ${c.k}`));
}

let probeBase = null;
const baseline = () => {
  if (!probeBase) {
    const before = catalogue();
    const probe = buildProbe({ fixes: false });
    if (process.env.A25FC_DUMP) writeFileSync(process.env.A25FC_DUMP, probe.sql, "utf8");
    const rows = runSql(probe.sql, "probe");
    landed(rows, probe.checks, "probe");
    assertNothingLeft(before);
    if (process.env.A25FC_VERDICT) writeFileSync(process.env.A25FC_VERDICT, JSON.stringify(rows, null, 1), "utf8");
    probeBase = Object.fromEntries(rows.map((r) => [r.k, r]));
    probeBase.__rows = rows;
  }
  return probeBase;
};

test("LIVE (rolled back): the probe's own controls hold -- it can see its rows, the operator is an operator, a tenant is not", { skip: !LIVE, timeout: 600_000 }, () => {
  const p = baseline();
  const bad = p.__rows.filter((r) => r.k.startsWith("ctl.") || r.k.includes(".ctl.")).filter((r) => !matches(r.got, r.want));
  assert.deepEqual(bad.map((r) => `${r.k}: got ${r.got}, want ${r.want}`), [], "INVALID: a control died, so the answers below prove nothing");
  const dig = p.__rows.filter((r) => r.k.startsWith("DIG.") && r.got !== "same");
  assert.deepEqual(dig.map((r) => r.k), [], "the probe changed a real row: it is not read-only against real data");
});

for (const [gap, prefix, note] of [
  ["G1", "G1.", "the operator's list, count, tiles and Jobs column all include fixtures"],
  ["G3", "G3.", "ar_aging() and job_costing() return the flagged job to its own company; business_report() drops it and lets an owner opt in"],
  ["G4", "G4.", "a tenant (owner or manager; a crew login cannot) writes the flag on its own jobs and renames its company to a fixture name"],
]) {
  test(`LIVE (rolled back): RECORDED GAP ${gap} (still present): ${note}`, { skip: !LIVE, timeout: 600_000 }, () => {
    const p = baseline();
    const rows = p.__rows.filter((r) => r.k.startsWith(prefix));
    assert.ok(rows.length >= 3, `${gap}: only ${rows.length} answers`);
    const bad = rows.filter((r) => !matches(r.got, r.want)).map((r) => explain(gap, r.k, r.got, r.want));
    assert.deepEqual(bad, []);
    if (gap === "G1") {
      const g = (k) => p[k].got;
      console.log(`\nADMIN PORTAL, fixture contribution (from the DEPLOYED admin_companies()): Companies +${g("G1.the_operator_list_holds_fixture_companies")}, On trial +${g("G1.tile_on_trial_counts_fixture_companies")}, MRR +$${g("G1.tile_mrr_counts_fixture_companies")}`);
    }
  });
}

// ===================================== the proposal is what it says it is (live, read-only) =====
export const R2_UNDO = {
  admin_companies: (t) => t
    .replace(/\n {19}and not j\.is_test_fixture\)/g, ")")
    .replace(/ {4}-- A fixture company is not a client\.[\s\S]*?\n {4}where is_platform_admin\(\)\n {6}and not c\.is_test_fixture\n/, "    where is_platform_admin()\n"),
  admin_companies_count: (t) => t.replace("where is_platform_admin() and not is_test_fixture;", "where is_platform_admin();"),
};
test("LIVE: block R2 is the LIVE body of each function plus the marked edits, nothing else (the proposal is not stale)", { skip: !LIVE, timeout: 300_000 }, () => {
  const r2 = blocks(read(FINDINGS_FILE)).R2;
  const rows = runSql(`select p.proname, pg_get_functiondef(p.oid) as def from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('admin_companies', 'admin_companies_count');`, "live definitions");
  assert.equal(rows.length, 2, "control: both live definitions must be read");
  for (const { proname, def } of rows) {
    const m = r2.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${proname}\\(\\)[\\s\\S]*?\\$function\\$;`));
    assert.ok(m, `${proname} is not in block R2`);
    const proposed = m[0].replace(/;$/, "");
    assert.notEqual(proposed.trim(), def.trim(), `${proname}: the proposal equals the live body, so it changes nothing`);
    assert.equal(R2_UNDO[proname](proposed).trim(), def.trim(), `${proname}: the live body has drifted from the one block R2 was written against, or R2 edits more than it says. Regenerate R2 from pg_get_functiondef.`);
  }
});

test("STATIC planted: the R2 undo function really undoes the edits it names, and only those", () => {
  const live = "select (select count(*) from jobs j where j.company_id = c.id and j.deleted_at is null),\n    from companies c\n    where is_platform_admin()\n    order by c.name;\n$function$";
  const edited = "select (select count(*) from jobs j where j.company_id = c.id and j.deleted_at is null\n                   and not j.is_test_fixture),\n    from companies c\n    -- A fixture company is not a client. still.\n    -- second line\n    where is_platform_admin()\n      and not c.is_test_fixture\n    order by c.name;\n$function$";
  assert.equal(R2_UNDO.admin_companies(edited), live);
  assert.notEqual(R2_UNDO.admin_companies(edited + "\n-- an extra edit\nselect 1;"), live, "an extra edit must not be undone silently");
  assert.equal(R2_UNDO.admin_companies_count("select count(*) from companies where is_platform_admin() and not is_test_fixture;"), "select count(*) from companies where is_platform_admin();");
});

// ============================= the proposal, applied inside a rolled-back transaction =====
/** The checks whose answer R1-R3 change, in probe order. Everything else answers identically with and without them. */
export const PROPOSAL_CHANGES = [
  "G1.ctl.the_operator_lists_the_probe_companies",
  "G1.the_operator_list_holds_fixture_companies",
  "G1.the_count_door_counts_fixture_companies",
  "G1.tile_on_trial_counts_fixture_companies",
  "G1.tile_mrr_counts_fixture_companies",
  "G1.jobs_column_counts_a_companys_flagged_jobs",
  "G4.the_flag_after_the_tenant_wrote_it",
  "G4.the_flag_on_the_job_it_inserted",
  "G4.the_flag_after_the_manager_wrote_it",
  "G2.the_companies_table_has_a_flag_column",
  "R1.the_helper_is_not_callable_by_a_tenant",
];
test("STATIC: the proposal changes exactly the recorded answers and nothing in G3 (both probes are built, neither is run)", () => {
  const today = new Map(buildProbe({ fixes: false }).checks.map((c) => [c.k, c.want]));
  const withIt = buildProbe({ fixes: true }).checks;
  assert.deepEqual(withIt.filter((c) => today.has(c.k) && today.get(c.k) !== c.want).map((c) => c.k), PROPOSAL_CHANGES);
  assert.ok(withIt.filter((c) => c.k.startsWith("G3.")).length >= 9 && withIt.filter((c) => c.k.startsWith("G3.")).every((c) => today.get(c.k) === c.want));
  // every check that exists today still exists with the proposal in
  assert.deepEqual([...today.keys()].filter((k) => !withIt.some((c) => c.k === k)), []);
  // the probe never names the service role
  const sql = buildProbe({ fixes: true }).sql;
  assert.doesNotMatch(sql.replace(/is_service_role/g, ""), /service_role/i);
  assert.doesNotMatch(sql, /\b(delete\s+from|truncate|drop\s+(table|column|function|trigger))\b/i, "the probe deletes and drops nothing");
});
test("LIVE (rolled back): R1-R3 applied inside the transaction correct the operator's numbers, hold the marker against tenants, and touch no real row", { skip: !(LIVE && FIXES), timeout: 900_000 }, () => {
  const before = catalogue();
  const probe = buildProbe({ fixes: true });
  if (process.env.A25FC_DUMP) writeFileSync(process.env.A25FC_DUMP.replace(/(\.\w+)?$/, ".fixes$1"), probe.sql, "utf8");
  const rows = runSql(probe.sql, "probe with the proposal");
  landed(rows, probe.checks, "probe with the proposal");
  if (process.env.A25FC_VERDICT) writeFileSync(process.env.A25FC_VERDICT.replace(/(\.\w+)?$/, ".fixes$1"), JSON.stringify(rows, null, 1), "utf8");
  const bad = rows.filter((r) => !matches(r.got, r.want)).map((r) => `${r.k}: got ${r.got}, want ${r.want}`);
  assert.deepEqual(bad, [], "with R1-R3 applied inside the transaction, these answers are not the ones the proposal promises");
  assertNothingLeft(before);
  // What the proposal changes is written down, not implied: these checks are the only ones whose recorded answer differs from today's.
  const today = new Map(buildProbe({ fixes: false }).checks.map((c) => [c.k, c.want]));
  const changed = probe.checks.filter((c) => today.has(c.k) && today.get(c.k) !== c.want).map((c) => c.k);
  assert.deepEqual(changed, PROPOSAL_CHANGES, "the set of answers R1-R3 change is not the set recorded in PROPOSAL_CHANGES");
  assert.ok(probe.checks.filter((c) => c.k.startsWith("G3.")).every((c) => today.get(c.k) === c.want), "R1-R3 must leave ar_aging()/job_costing()/business_report() (G3) exactly as they are");
  assert.equal(today.get("G4.the_name_after_the_tenant_wrote_it"), probe.checks.find((c) => c.k === "G4.the_name_after_the_tenant_wrote_it").want, "the company NAME stays tenant-writable under R1-R3: the flag, not the name, becomes the marker");
  const onlyProof = probe.checks.filter((c) => !today.has(c.k)).length;
  console.log(`\nWITH R1-R3 (rolled back): ${rows.length} checks all answered as recorded. ${changed.length} answers differ from today's (check groups: ${changed.map((k) => k.split(".")[0]).filter((v, i, a) => a.indexOf(v) === i).join(", ")}), ${onlyProof} checks exist only to prove the proposal, ar_aging()/job_costing()/business_report() are unchanged, and every real row's digest is identical.`);
});

test("LIVE: the run left the catalogue exactly as it found it (no proposal applied, no synthetic row)", { skip: !LIVE, timeout: 300_000 }, () => {
  const c = catalogue();
  for (const k of ["users", "companies", "profiles", "jobs", "payments", "audit", "http_calls"]) assert.equal(Number(c[k]), 0, `${k}`);
  // The proposal is unapplied: none of its objects exist unless the owner has since applied it (then this line is the record).
  console.log(`\nPROPOSAL STATE: companies.is_test_fixture column = ${c.company_flag_column}, proposed functions = ${c.proposed_functions}, proposed triggers = ${c.proposed_triggers}`);
});
