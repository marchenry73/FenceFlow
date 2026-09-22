// Proves supabase_crew_job_scope.sql -- crew see only the jobs they are on,
// ask for the rest, and the office decides -- before it is ever applied.
//
// Two halves.
//
//   A. STATIC, pure: reads the migration's text and checks the four promises
//      that are easiest to break in a later edit -- every new function is
//      closed to anonymous callers, nothing is deleted, a shift's upload is
//      never narrowed, and the "what can I ask for" list carries no money or
//      contact column. The checker itself is proven by feeding it planted
//      bad copies of the file; each must be caught.
//
//   B. LIVE, rolled back: `begin;` + the migration + supabase_crew_job_scope_probe.sql
//      against production through `supabase db query --linked`, the same
//      technique as tests/release-audience-guard.test.mjs. Every subject and
//      row is synthetic and nothing survives the transaction. Then the SAME
//      probe runs again three times, each with one piece of the migration
//      sabotaged after it is applied -- scoping switched off, the view write
//      grants handed back, the pens' guard emptied -- and once more with the
//      verifier's findings undone together (a line moved off an unseen job,
//      the side-door and customer policies dropped, any status requestable,
//      a switched-off crew record still counted). The checks that protect
//      exactly that piece must go red. A probe that stays green under
//      sabotage proves nothing.
//
//   node tests/crew-job-scope.test.mjs            (both halves)
//   node tests/crew-job-scope.test.mjs --static   (A only; no network)

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT = "newcrgafcptspmapacrx";
const ROOT = process.cwd();
const migration = readFileSync(join(ROOT, "supabase_crew_job_scope.sql"), "utf8");
const probe = readFileSync(join(ROOT, "supabase_crew_job_scope_probe.sql"), "utf8");

let failed = 0, checked = 0;
// The lock line PART 3 takes before counting, reused by the plants below.
const LOCK = "    perform pg_advisory_xact_lock(hashtext('job_access_request:' || auth.uid()::text));\n";

const ok = (name, cond, detail = "") => {
  checked++;
  if (cond) { console.log(`  ok    ${name}`); return; }
  failed++;
  console.log(`  FAIL  ${name}${detail ? " -- " + detail : ""}`);
};

// ---------------------------------------------------------------------------
// A. Static
// ---------------------------------------------------------------------------

/** The file with every `--` comment removed, so prose cannot satisfy a check. */
function code(sql) {
  return sql.split("\n").map(l => l.replace(/--.*$/, "")).join("\n");
}

/** Everything wrong with a copy of the migration, as readable sentences. */
export function staticProblems(sql) {
  const src = code(sql);
  const problems = [];

  // 1. Every function this file creates is revoked from anon.
  const revoked = new Set();
  for (const m of src.matchAll(/revoke\s+execute\s+on\s+function([\s\S]*?)from\s+([^;]+);/gi)) {
    if (!/\banon\b/i.test(m[2])) continue;
    for (const f of m[1].matchAll(/public\.(\w+)\s*\(/g)) revoked.add(f[1]);
  }
  for (const m of src.matchAll(/create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(/gi)) {
    if (!revoked.has(m[1])) problems.push(`${m[1]} is never revoked from anon`);
  }

  // 2. Nothing is deleted: no DELETE, TRUNCATE or DROP TABLE anywhere, and
  //    no DROP of anything but a policy or the push trigger being recreated.
  if (/\bdelete\s+from\b/i.test(src)) problems.push("deletes rows");
  if (/\btruncate\s+(table\s+)?public\./i.test(src)) problems.push("truncates a table");
  for (const m of src.matchAll(/\bdrop\s+(\w+)/gi)) {
    const what = m[1].toLowerCase();
    if (what === "policy") continue;
    if (what === "trigger" && /drop trigger "job-change-push"/i.test(src.slice(m.index, m.index + 40))) continue;
    problems.push(`drops a ${what}`);
  }

  // 3. A worked shift always uploads: no policy on time_entries is created.
  if (/create\s+policy[\s\S]{0,120}?\bon\s+public\.time_entries\b/i.test(src)) {
    problems.push("creates a policy on time_entries (shift uploads must never be narrowed)");
  }

  // 4. The requestable list carries no money, phone or email.
  const rt = src.match(/function\s+public\.list_requestable_jobs\(\)\s*returns\s+table\s*\(([\s\S]*?)\)\s*language/i);
  if (!rt) problems.push("list_requestable_jobs has no RETURNS TABLE to check");
  else if (/phone|email|total|price|amount|paid|cost|rate|deposit|fee/i.test(rt[1])) {
    problems.push("list_requestable_jobs returns a money or contact column");
  }

  // 5. The crew views are rebuilt from the live definition, never retyped.
  if (/create\s+or\s+replace\s+view\s+public\.\w+_crew[^;]*\bas\s+select\b/i.test(src)) {
    problems.push("a crew view is retyped instead of built from pg_get_viewdef");
  }

  // 6. The request limits are counted under a per-caller lock. Counted
  //    without one, parallel asks each read a count under the cap.
  const ask = fnBody(src, "request_job_access");
  if (!ask) problems.push("request_job_access not found");
  else {
    const lock = ask.search(/pg_advisory_xact_lock\s*\(/i);
    const firstCount = ask.search(/count\(\*\)/i);
    if (lock < 0) problems.push("request_job_access counts its limits without a lock");
    else if (firstCount >= 0 && lock > firstCount) problems.push("request_job_access takes its lock after counting");
  }

  // 7. What the list offers and what the ask accepts are one rule.
  for (const name of ["list_requestable_jobs", "request_job_access"]) {
    const body = fnBody(src, name);
    if (body && !/job_status_is_requestable\s*\(/i.test(body)) {
      problems.push(`${name} does not apply job_status_is_requestable (the list and the ask would disagree)`);
    }
  }

  // 8. crew_push_line_items checks both jobs: the one a line names, and the
  //    one it is on now (the upsert rewrites job_sync_id, in a definer).
  if (!/and public\.can_see_job\(j\.sync_id\)/.test(src)) problems.push("crew_push_line_items no longer checks the job a line names");
  if (!/not public\.can_see_job\(e\.job_sync_id\)/.test(src)) problems.push("crew_push_line_items can move a line off a job the caller cannot see");

  // 9. A switched-off crew record is no record.
  const mine = fnBody(src, "my_employee_sync_ids");
  if (!mine || !/\bis_active\b/i.test(mine)) problems.push("my_employee_sync_ids counts a switched-off crew record");
  return problems;
}

/** The text of one CREATE FUNCTION, between its first pair of $$ quotes. */
function fnBody(src, name) {
  const at = src.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, "i"));
  if (at < 0) return null;
  const open = src.indexOf("$$", at);
  const close = open < 0 ? -1 : src.indexOf("$$", open + 2);
  return close < 0 ? null : src.slice(open + 2, close);
}

function staticHalf() {
  console.log("\nA. Static checks on supabase_crew_job_scope.sql:");
  const real = staticProblems(migration);
  ok("the real file has no problems", real.length === 0, real.join("; "));

  // Planted failures: each is one realistic bad edit, and each must be caught.
  const plants = [
    ["a new function nobody revoked from anon",
      migration.replace(/revoke execute on function public\.my_job_scope\(\), public\.list_requestable_jobs\(\),\s*public\.request_job_access\(uuid, text\),/,
        "revoke execute on function public.my_job_scope(), public.list_requestable_jobs(),"),
      /request_job_access is never revoked/],
    ["a clean-up that deletes rows",
      migration + "\ndelete from public.job_assignments where ended_at is not null;\n", /deletes rows/],
    ["a policy that narrows shift uploads",
      migration + "\ncreate policy te_scope on public.time_entries as restrictive for insert to authenticated with check (true);\n",
      /policy on time_entries/],
    ["the customer's phone added to the requestable list",
      migration.replace("returns table(job_sync_id uuid, customer_name text,", "returns table(job_sync_id uuid, customer_name text, phone text,"),
      /money or contact column/],
    ["a crew view retyped by hand",
      migration + "\ncreate or replace view public.jobs_crew with (security_barrier = true) as select id, company_id from jobs;\n",
      /retyped/],
    ["a dropped table",
      migration + "\ndrop table public.job_access_requests;\n", /drops a table/],
    ["the per-caller lock removed from request_job_access",
      migration.replace(LOCK, ""), /without a lock/],
    ["the lock moved after the counts",
      migration.replace(LOCK, "").replace("    -- A double tap racing itself", LOCK + "    -- A double tap racing itself"),
      /lock after counting/],
    ["request_job_access accepting any status again",
      migration.replaceAll("and public.job_status_is_requestable(j.status::text)) then", ") then"),
      /request_job_access does not apply job_status_is_requestable/],
    ["the line-move guard emptied",
      migration.replaceAll("and not public.can_see_job(e.job_sync_id)) then", "and false) then"),
      /move a line off a job/],
    ["is_active dropped from my_employee_sync_ids",
      migration.replace(/\n\s+and e\.is_active\n/, "\n"), /switched-off crew record/],
  ];
  // Each planted copy must really differ from the file, or the plant tested nothing.
  for (const [name, bad] of plants) {
    if (bad === migration) ok(`PLANTED: ${name} -- the plant changed the file`, false, "replace() found nothing to change");
  }
  for (const [name, bad, expect] of plants) {
    const found = staticProblems(bad);
    ok(`PLANTED: ${name} is caught`, found.some(p => expect.test(p)), `checker said: ${found.join("; ") || "nothing"}`);
  }
  // A comment is not code: prose mentioning a DELETE must not trip the check.
  ok("a DELETE mentioned only in a comment is not flagged",
     !staticProblems(migration + "\n-- someone could `delete from jobs_crew` here\n").some(p => /deletes rows/.test(p)));
}

// ---------------------------------------------------------------------------
// B. Live, rolled back
// ---------------------------------------------------------------------------

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), "crew-job-scope-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query",
    "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
    { encoding: "utf8", shell: process.platform === "win32", timeout: 180_000 });
  if (r.status !== 0) throw new Error(`supabase db query failed: ${r.stderr || r.stdout}`);
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { throw new Error(`could not parse CLI output: ${r.stdout}`); }
  return Array.isArray(parsed) ? parsed : (parsed.rows || []);
}

/** begin; migration; [sabotage]; probe (which rolls everything back). */
function runProbe(sabotage = "") {
  const rows = runSql(`begin;\n${migration}\n${sabotage}\n${probe}`);
  const byName = new Map();
  for (const r of rows) {
    if (!byName.has(r.check_name)) byName.set(r.check_name, []);
    byName.get(r.check_name).push(r);
  }
  return { rows, byName };
}

const failing = (res) => res.rows.filter(r => r.result === "FAIL").map(r => r.check_name);
const startsWith = (names, prefix) => names.some(n => n.startsWith(prefix));

function liveHalf() {
  console.log("\nB1. The migration and the probe, as written:");
  const real = runProbe();
  const summary = real.rows.find(r => r.result === "SUMMARY");
  const fails = failing(real);
  ok("the probe ran and reported a summary", !!summary, JSON.stringify(real.rows.slice(-2)));
  if (summary) {
    const [pass, total] = String(summary.got).split("/").map(Number);
    ok(`every check passes (${summary.got})`, pass === total && fails.length === 0, fails.join(" | "));
    // A probe that quietly lost most of its checks would still say N/N.
    ok("the probe really ran its checks (at least 175)", total >= 175, `only ${total}`);
  }

  console.log("\nB2. PLANTED: scoping switched off (sees_all_jobs() says yes to everyone):");
  const everyone = runProbe(`
create or replace function public.sees_all_jobs() returns boolean
language sql stable security definer set search_path = public as $$ select true $$;`);
  const f1 = failing(everyone);
  ok("crew now see every job -- 14 goes red", startsWith(f1, "14 CREW"), f1.join(" | "));
  ok("the unlinked canary goes red -- 16", startsWith(f1, "16 UNLINKED"), f1.join(" | "));
  ok("a crew phone reads other jobs' runs -- 20 goes red", startsWith(f1, "20 CREW      fence_runs"), f1.join(" | "));
  ok("crew read colleagues' shifts -- 104 goes red", startsWith(f1, "104 CREW"), f1.join(" | "));
  ok("the office-side controls stay green (10, 19)",
     !startsWith(f1, "10 MANAGER") && !startsWith(f1, "19 MANAGER"), f1.join(" | "));

  console.log("\nB3. PLANTED: the crew doors writable again (the hard-delete hole):");
  const writable = runProbe(`grant insert, update, delete on public.jobs_crew to authenticated;`);
  const f2 = failing(writable);
  ok("DELETE through jobs_crew is no longer refused -- 40 goes red", startsWith(f2, "40 CREW"), f2.join(" | "));
  ok("the other doors, still revoked, stay green (43-46)",
     !startsWith(f2, "43 ") && !startsWith(f2, "44 ") && !startsWith(f2, "45 ") && !startsWith(f2, "46 "), f2.join(" | "));

  console.log("\nB4. PLANTED: the pens' guard emptied (crew_job_guard does nothing):");
  const unguarded = runProbe(`
create or replace function public.crew_job_guard(p_job_sync_id uuid) returns void
language plpgsql security definer set search_path = public as $$ begin return; end $$;`);
  const f3 = failing(unguarded);
  ok("crew can save a job they are not on -- 92 goes red", startsWith(f3, "92 CREW"), f3.join(" | "));
  ok("crew can move a job they are not on -- 97 goes red", startsWith(f3, "97 CREW"), f3.join(" | "));
  ok("reading is unaffected -- 14 stays green", !startsWith(f3, "14 CREW"), f3.join(" | "));

  // One run for the verifier's findings, each undone after the migration;
  // every one maps to its own rows, and the controls beside them stay green.
  console.log("\nB5. PLANTED: the verifier's findings undone (one run):");
  const undone = runProbe(`
do $s$ declare d text; begin
  d := pg_get_functiondef('public.crew_push_line_items(jsonb)'::regprocedure);
  d := regexp_replace(d, '-- supabase_crew_job_scope\\.sql: never move.*?continue;\\s+end if;', '');
  execute d;
end $s$;
drop policy automation_flags_only_visible_jobs on public.automation_flags;
drop policy attention_findings_money_hidden_from_crew on public.attention_findings;
drop policy customers_need_contact_permission on public.customers;
drop policy estimate_line_items_insert_only_visible_jobs on public.estimate_line_items;
drop policy expenses_insert_only_visible_jobs on public.expenses;
create or replace function public.deleted_job_sync_ids(p_job_sync_ids uuid[]) returns setof uuid
language sql stable security definer set search_path = public as $$
    select j.sync_id from public.jobs j where j.sync_id = any (p_job_sync_ids) $$;
create or replace function public.job_status_is_requestable(p_status text) returns boolean
language sql immutable as $$ select true $$;
create or replace function public.my_employee_sync_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
    select e.sync_id from public.employees e
     where e.company_id = public.current_company_id() and e.profile_id = auth.uid()
       and e.deleted_at is null and e.sync_id is not null $$;`);
  const f4 = failing(undone);
  const r6 = undone.byName.get("0i INFO     r6 crew line pushes are no-ops")?.[0]?.got === "true";
  if (r6) {
    // With r6 live a crew line push stops before the guard, so the guard
    // cannot be seen from here; r6's own probe covers that door.
    ok("line move: r6 is live, so the push is a no-op either way -- 9a stays green", !startsWith(f4, "9a CREW"), f4.join(" | "));
  } else {
    ok("a line moves off an unseen job -- 9a and 9b go red",
       startsWith(f4, "9a CREW") && startsWith(f4, "9b OFFICE"), f4.join(" | "));
  }
  ok("an automation flag on another job reaches crew -- 20 automation_flags goes red",
     startsWith(f4, "20 CREW      automation_flags"), f4.join(" | "));
  ok("attention text with money reaches crew and foreman -- 23 and 23b go red",
     startsWith(f4, "23 CREW") && startsWith(f4, "23b FOREMAN"), f4.join(" | "));
  ok("every customer reaches crew -- 24 goes red", startsWith(f4, "24 CREW "), f4.join(" | "));
  // r6's own insert gate (PART 6b of supabase_r6_price_stability.sql)
  // refuses a crew login's line on any job whatever job scope says, so with
  // r6 live 36 cannot go red when this file's line policy is dropped. 36b,
  // on expenses with the amount guard switched off for that row, is where
  // the insert half is the only gate and can be seen deciding.
  const r6Insert = undone.byName.get("0j INFO     r6 line insert needs EDIT_JOBS or SEE_MONEY")?.[0]?.got === "true";
  if (r6Insert) {
    ok("a line planted on an unseen job: r6's gate still refuses it -- 36 stays green", !startsWith(f4, "36 CREW"), f4.join(" | "));
  } else {
    ok("a line planted on an unseen job -- 36 goes red", startsWith(f4, "36 CREW"), f4.join(" | "));
  }
  ok("an expense planted on an unseen job -- 36b goes red", startsWith(f4, "36b CREW"), f4.join(" | "));
  ok("a live job, and another company's, reported deleted -- 160 and 164 go red",
     startsWith(f4, "160 CREW") && startsWith(f4, "164 CREW"), f4.join(" | "));
  ok("a DRAFT can be asked for -- 6h goes red", startsWith(f4, "6h CREW"), f4.join(" | "));
  ok("a switched-off crew record still sees its jobs -- 150 goes red", startsWith(f4, "150 CREW TWO"), f4.join(" | "));
  ok("the controls beside them stay green (14, 20 follow_up_log, 23c, 24c, 37b, 38, 9c, 154, 165)",
     !startsWith(f4, "14 CREW") && !startsWith(f4, "20 CREW      follow_up_log") && !startsWith(f4, "23c MANAGER")
       && !startsWith(f4, "24c MANAGER") && !startsWith(f4, "37b CREW") && !startsWith(f4, "38 CREW")
       && !startsWith(f4, "9c CREW") && !startsWith(f4, "154 CREW") && !startsWith(f4, "165 CREW"), f4.join(" | "));
}

staticHalf();
if (!process.argv.includes("--static")) {
  try { liveHalf(); }
  catch (e) { failed++; checked++; console.log(`  FAIL  live half could not run -- ${e.message.slice(0, 400)}`); }
}
console.log(`\n${checked - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
