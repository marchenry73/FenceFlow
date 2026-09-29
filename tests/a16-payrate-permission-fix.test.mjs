// PROOF that supabase_r11_time_entry_rate_permission.sql's fix does what it
// claims: after it is applied, a SEE_MONEY-only caller (SALES, unchanged
// base role) can no longer have an unverified time-entry rate trusted by
// stamp_time_entry_rate(), and a SEE_PAY caller (ACCOUNTANT) still can.
//
// This file does not hand-copy the fix. It reads the actual
// supabase_r11_time_entry_rate_permission.sql from the repo root and splices
// the exact text between its "-- === FIX BEGIN ===" / "-- === FIX END ==="
// markers into a transaction that is ALWAYS rolled back -- so the live
// database is never actually changed by running this test, and the SQL
// under test can never drift from the SQL the owner would actually apply.
//
// Why an INSERT against a deliberately orphaned row, with
// time_entry_needs_a_person disabled, rather than a "real" clock-in:
// supabase_r11_time_entry_rate_permission.sql's own header (re-verified live
// 2026-09-28) establishes that no legitimate path -- not the app, not any
// Edge Function -- ever reaches the branch this fix changes, because a real
// employee is always named and its stored rate always wins. The only way to
// exercise the changed branch at all, honestly, is the same one
// tests/a10-pay-rate-permission.test.mjs already uses for the CURRENT (buggy)
// behaviour: disable the one guard that stands in the way, on a synthetic
// row, inside a transaction that is never committed.
//
// Every subject and row is synthetic (company PROBE-A16, ids under the
// aa160001- prefix -- a10 uses aa100001-, chosen distinct so the two files
// can never collide if ever run concurrently). Nothing is committed: the
// whole probe is one `begin; ... rollback;`, verified after the fact below
// by a separate, real, read-only query for PROBE-A16 residue. No real
// company, profile, employee or shift is read or written. Fixed synthetic
// uuids and the p/x/s impersonation helpers are copied from
// tests/a10-pay-rate-permission.test.mjs, not reinvented.
//
// Positive controls (per-check, and required by the task, not optional):
//   - 00/01: the two subjects genuinely differ (SALES: SEE_MONEY yes, SEE_PAY
//     no; ACCOUNTANT: both yes) -- fixture sanity, not assumed from role name.
//   - 03/04: can_see_employee_pay() and can_see_pay() are asked directly, so
//     a check that the FIX file's own text is what actually ran, not a
//     coincidence of some other function.
//   - 12/13: the ACCOUNTANT's identical insert MUST land with rate 777, or
//     check 11's "0" for SALES would prove nothing -- it would be equally
//     consistent with the whole insert silently failing, or with nobody's
//     rate ever landing for any reason. 13 is what makes 11 mean something.
//
// The supabase CLI is documented as flaky right now (roughly 1 login failure
// in 4); runSql() retries before treating any failure as a finding.
//
// Run:
//   node tests/a16-payrate-permission-fix.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const PROJECT = "newcrgafcptspmapacrx";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX_FILE = join(REPO_ROOT, "supabase_r11_time_entry_rate_permission.sql");

// Extract the exact fix text between the file's own markers, so this test
// exercises the SQL the owner would actually run, not a hand copy of it.
function extractFix() {
  const src = readFileSync(FIX_FILE, "utf8");
  const beginMarker = "-- === FIX BEGIN ===";
  const endMarker = "-- === FIX END ===";
  const start = src.indexOf(beginMarker);
  const end = src.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      `could not find FIX BEGIN/END markers in ${FIX_FILE} -- has the file been renamed or the markers removed?`
    );
  }
  return src.slice(start + beginMarker.length, end);
}

function buildProbe(fixSql) {
  return String.raw`
begin;
set local lock_timeout = '5s';

create temp table r(n serial, k text, got text, want text);
grant all on r to authenticated, anon;
grant usage on sequence r_n_seq to authenticated, anon;

create function pg_temp.p(label text, uid uuid, q text, want text) returns void language plpgsql as $fn$
declare v text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub',uid,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  begin execute q into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,150); end;
  execute 'reset role';
  perform set_config('request.jwt.claims','',true);
  insert into r(k,got,want) values (label,v,want);
end $fn$;

create function pg_temp.x(label text, uid uuid, q text, want text) returns void language plpgsql as $fn$
declare c int; v text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub',uid,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  begin execute q; get diagnostics c = row_count; v := 'rows=' || c;
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,150); end;
  execute 'reset role';
  perform set_config('request.jwt.claims','',true);
  insert into r(k,got,want) values (label,v,want);
end $fn$;

create function pg_temp.s(label text, q text, want text) returns void language plpgsql as $fn$
declare v text;
begin
  perform set_config('request.jwt.claims','',true);
  begin execute q into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,150); end;
  insert into r(k,got,want) values (label,v,want);
end $fn$;

-- The fix under test, scoped to this transaction only -- rolled back at the
-- end along with every synthetic row below. Spliced verbatim from
-- supabase_r11_time_entry_rate_permission.sql.
${fixSql}

do $body$
declare
  SC     uuid := 'aa160001-0000-4000-8000-0000000000a1';
  uSAL   uuid := 'aa160001-0000-4000-8000-0000000000b1';
  uACC   uuid := 'aa160001-0000-4000-8000-0000000000b2';
  eREAL  uuid := 'aa160001-0000-4000-8000-0000000000c1';
  jJOB   uuid := 'aa160001-0000-4000-8000-0000000000d1';
  tSAL   uuid := 'aa160001-0000-4000-8000-0000000000e1';
  tACC   uuid := 'aa160001-0000-4000-8000-0000000000e2';
  tGOOD  uuid := 'aa160001-0000-4000-8000-0000000000e3';
  fakeEmpId text := 'aa160001-0000-4000-8000-0000000000ff';
begin
  perform set_config('request.jwt.claims','',true);

  insert into auth.users(id,email) values
    (uSAL,'a16-sal@probe.invalid'),(uACC,'a16-acc@probe.invalid');
  insert into companies(id,name,subscription_status,subscription_plan,suspended,trial_ends_at,
                        admin_notes,leads_token,stripe_customer_id,invited_email,suspended_reason) values
    (SC,'PROBE-A16','active','pro',false,now()+interval '30 days','',gen_random_uuid(),'cus_A16','','');
  insert into profiles(id,company_id,full_name,role,is_platform_admin,permission_overrides) values
    (uSAL,SC,'A16 Sales','SALES',false,''),
    (uACC,SC,'A16 Accountant','ACCOUNTANT',false,'');
  insert into employees(id,company_id,name,sync_id,hourly_rate,pay_type,profile_id,is_active) values
    (eREAL,SC,'A16 Real Emp',eREAL,42.00,'HOURLY',null,true);
  insert into jobs(id,company_id,customer_name,address,phone,email,status,sync_id,contract_total,
                   quote_token,is_test_fixture,notes,assigned_employee_sync_id) values
    (jJOB,SC,'A16 CUSTOMER','1 Probe Way','555-0000','a16@probe.invalid','ACCEPTED',jJOB,1000,
     gen_random_uuid(),false,'',eREAL::text);

  ------------------------------------------------------- 0x fixture + direct gate checks, AFTER the fix
  perform pg_temp.p('00 SALES has_permission SEE_MONEY/SEE_PAY (fixture sanity)', uSAL,
    'select has_permission(''SEE_MONEY'')::text||''/''||has_permission(''SEE_PAY'')::text', 'true/false');
  perform pg_temp.p('01 POSITIVE CONTROL: ACCOUNTANT has_permission SEE_MONEY/SEE_PAY', uACC,
    'select has_permission(''SEE_MONEY'')::text||''/''||has_permission(''SEE_PAY'')::text', 'true/true');
  perform pg_temp.p('02 SALES can_see_employee_pay() -- the gate stamp_time_entry_rate now reads, after the fix', uSAL,
    'select can_see_employee_pay()::text', 'false');
  perform pg_temp.p('03 POSITIVE CONTROL: ACCOUNTANT can_see_employee_pay() after the fix', uACC,
    'select can_see_employee_pay()::text', 'true');
  perform pg_temp.p('04 SALES can_see_pay() is untouched by this fix -- still answers SEE_MONEY', uSAL,
    'select can_see_pay()::text', 'true');

  ------------------------------------------------------- 1x the branch the fix actually changes
  -- No legitimate path reaches this branch today (see the fix file's own
  -- header, re-verified live 2026-09-28) -- so the only honest way to
  -- exercise it is the same technique tests/a10-pay-rate-permission.test.mjs
  -- uses for the CURRENT bug: disable the one guard that stands in the way,
  -- on synthetic rows only, inside this same rolled-back transaction.
  alter table time_entries disable trigger time_entry_needs_a_person;

  perform pg_temp.x('10 SALES (SEE_MONEY only) inserts an orphaned shift, submitted rate 777', uSAL,
    format($q$insert into time_entries(company_id,sync_id,job_sync_id,employee_sync_id,started_at,ended_at,hourly_rate,notes)
             values (%L,%L,%L,%L,now()-interval '2 hours',now(),777,'')$q$,
           SC, tSAL, jJOB, fakeEmpId), 'rows=1');
  perform pg_temp.s('11 stored rate for SALES''s row after the fix -- must be 0, not 777 (no longer trusted)',
    format('select hourly_rate::text from time_entries where sync_id=%L', tSAL), '0');

  perform pg_temp.x('12 POSITIVE CONTROL: ACCOUNTANT (SEE_PAY) inserts an orphaned shift, submitted rate 777', uACC,
    format($q$insert into time_entries(company_id,sync_id,job_sync_id,employee_sync_id,started_at,ended_at,hourly_rate,notes)
             values (%L,%L,%L,%L,now()-interval '2 hours',now(),777,'')$q$,
           SC, tACC, jJOB, fakeEmpId), 'rows=1');
  perform pg_temp.s('13 stored rate for ACCOUNTANT''s row after the fix -- must be 777 (still trusted: proves 11 is a real refusal)',
    format('select hourly_rate::text from time_entries where sync_id=%L', tACC), '777');

  alter table time_entries enable trigger time_entry_needs_a_person;

  ------------------------------------------------------- 2x sanity: the untouched branch still works
  perform pg_temp.x('20 SALES inserts a shift for a REAL employee, submitted rate 555', uSAL,
    format($q$insert into time_entries(id,company_id,sync_id,job_sync_id,employee_sync_id,started_at,ended_at,hourly_rate,notes)
             values (%L,%L,%L,%L,%L,now()-interval '3 hours',now(),555,'')$q$,
           tGOOD, SC, tGOOD, jJOB, eREAL::text), 'rows=1');
  perform pg_temp.s('21 stored rate for that row must be the REAL employee rate (42), not 555 -- fix did not touch this branch',
    format('select hourly_rate::text from time_entries where sync_id=%L', tGOOD), '42');
end $body$;

select n, case when ok then 'PASS' else 'FAIL' end as result, k as check_name, got, want
  from (select n, k, got, want,
               coalesce(got = want
                        or (want like 'ERR %' and got like want || '%'), false) as ok
          from r) t
union all
select 1000000, 'SUMMARY',
       'passed/total',
       (select count(*) filter (where coalesce(got = want
                                  or (want like 'ERR %' and got like want || '%'), false))::text
               || '/' || count(*)::text from r),
       (select count(*)::text || '/' || count(*)::text from r)
 order by 1;

rollback;
`;
}

const RESIDUE_CHECK = String.raw`
select count(*)::text as n from public.companies where name = 'PROBE-A16';
`;

function runSql(sql, { retries = 4, label = "probe" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "a16-payrate-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  let lastErr = "";
  for (let attempt = 1; attempt <= retries; attempt++) {
    const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query",
      "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
      { encoding: "utf8", shell: process.platform === "win32", timeout: 180_000 });
    const stdout = r.stdout || "";
    const stderr = r.stderr || "";
    // The CLI is documented as flaky (~1 in 4 calls fails with a login
    // error) and prints an ERROR where rows would be on that path. Retry
    // before treating any failure as a finding -- never read a failed call
    // as an empty result.
    if (r.status === 0 && stdout.trim() && !/^\s*ERROR/im.test(stdout)) {
      try { return JSON.parse(stdout); }
      catch { lastErr = `could not parse CLI output: ${stdout}`; continue; }
    }
    lastErr = stderr || stdout || `exit ${r.status}`;
  }
  throw new Error(`supabase db query (${label}) failed after ${retries} attempts: ${lastErr}`);
}

function liveProbe() {
  const fixSql = extractFix();
  const parsed = runSql(buildProbe(fixSql), { label: "a16 probe" });
  const rows = Array.isArray(parsed) ? parsed : (parsed.rows || []);
  return rows;
}

test("stamp_time_entry_rate() after supabase_r11_time_entry_rate_permission.sql: SALES (SEE_MONEY only) no longer trusted, ACCOUNTANT (SEE_PAY) still is", () => {
  const rows = liveProbe();
  const summary = rows.find(r => r.result === "SUMMARY");
  assert.ok(summary, `probe did not report a summary; rows: ${JSON.stringify(rows).slice(0, 500)}`);
  const [pass, total] = String(summary.got).split("/").map(Number);
  const fails = rows.filter(r => r.result === "FAIL");
  assert.equal(total, 11, `expected 11 checks, the probe reported ${total} -- it lost or gained checks`);
  assert.equal(pass, total,
    `not every check matched: ${fails.map(f => `${f.check_name} -> got ${JSON.stringify(f.got)}, want ${JSON.stringify(f.want)}`).join(" | ")}`);
});

test("rollback actually took: no PROBE-A16 residue in the live database", () => {
  const parsed = runSql(RESIDUE_CHECK, { label: "a16 residue check" });
  const rows = Array.isArray(parsed) ? parsed : (parsed.rows || []);
  assert.equal(rows[0]?.n, "0", `expected zero PROBE-A16 companies after rollback, found ${rows[0]?.n}`);
});
