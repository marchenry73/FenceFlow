// SETTLING A CLAIM REFUTED ONCE, THEN FOUND AGAIN: stamp_time_entry_rate()'s
// privileged path -- the one that lets a caller state an unverified hourly
// rate -- reads can_see_pay(), and can_see_pay() answers SEE_MONEY, not
// SEE_PAY (see supabase_can_see_pay_restored.sql, which reverted can_see_pay()
// to SEE_MONEY on 2026-09-10 and gave payroll its own can_see_employee_pay()
// instead -- a function nothing ever calls, confirmed by
// `grep -rl can_see_employee_pay *.sql` naming only the file that defines it).
// SALES holds SEE_MONEY, not SEE_PAY. So the FUNCTION-LEVEL gate is wrong,
// exactly as claimed.
//
// What this file adds beyond the claim: whether that wrong gate is actually
// REACHABLE by a SALES account, traced end to end against the live schema
// rather than assumed from the function body alone. It is not, currently,
// for two independent reasons that have nothing to do with can_see_pay():
//
//   INSERT -- a genuinely new time_entries row must name a real employee
//   (time_entry_needs_a_person, BEFORE INSERT OR UPDATE, checked live: it
//   refuses a direct superuser connection just as readily as anyone else).
//   Whenever a real employee IS named, employees.hourly_rate is NOT NULL
//   DEFAULT 0 (confirmed live), so stamp_time_entry_rate's real_rate lookup
//   always succeeds and the "privileged" branch -- the one gated on the wrong
//   permission -- is never reached. Whenever no real employee is named,
//   time_entry_needs_a_person raises 23514 and the whole INSERT is rejected,
//   so nothing lands even though stamp_time_entry_rate ran first (it fires
//   before time_entry_needs_a_person in BEFORE-trigger name order: 's' < 't').
//
//   UPDATE -- the only rows where the flawed branch would matter are rows
//   that are ALREADY orphaned (2 exist in production, both predating
//   time_entry_needs_a_person, which cannot be re-created by any caller,
//   confirmed live). Reading or writing such a row needs SEE_PAY or
//   is_my_shift(), a RESTRICTIVE SELECT policy (time_entries_pay_needs_
//   see_pay) that Postgres also applies to the row an UPDATE or an
//   ON-CONFLICT-DO-UPDATE upsert reads -- and is_my_shift() can never be true
//   for an orphaned row, because it requires an actual employees row to
//   claim through. SALES has neither SEE_PAY nor a way to claim an orphaned
//   row as its own, so both write shapes are refused before
//   stamp_time_entry_rate's own permission check is ever consulted.
//
// So: a real, confirmed defect in stamp_time_entry_rate() (it asks the wrong
// permission), currently NOT exploitable by SALES, because two unrelated
// guards happen to close every path to it. Checks 40-42 prove this isn't
// hand-waving: with time_entry_needs_a_person disabled, the identical SALES
// INSERT that check 10 refused SUCCEEDS and an unverified rate lands. That is
// the fix's real justification -- not "nothing can go wrong", but "exactly
// one guard, in a file about crew-member existence, is the only thing
// stopping this from being exploitable today", which is a fragile way for a
// payroll permission to be enforced.
//
// Every check carries the discipline this project's history says was missing
// before: a POSITIVE CONTROL beside every negative (03 beside 00-02, 24-25
// beside 22-23), "refused" scored by SQLSTATE and "allowed" by affected rows,
// and a final read-back rather than trusting an absent error. Every subject
// and row is synthetic, created inside one transaction that is rolled back
// at the end (never committed) -- confirmed empirically after the fact with
// a read-only follow-up query that found zero residue. No real company,
// profile or shift is read or written. The supabase CLI is documented as
// flaky right now (roughly 1 login failure in 4); runSql() retries before
// treating any failure as a finding.
//
// Run:
//   node tests/a10-pay-rate-permission.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT = "newcrgafcptspmapacrx";

// One rolled-back transaction. Fixed synthetic UUIDs (aa100001-...), matching
// the idiom already used by supabase_p3_probe_approve_time_entry.sql and
// supabase_crew_job_scope_probe.sql -- nothing in this file's shape is new,
// only its subject.
const PROBE = String.raw`
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

do $body$
declare
  SC       uuid := 'aa100001-0000-4000-8000-0000000000a1';
  uOWN     uuid := 'aa100001-0000-4000-8000-0000000000b1';
  uSAL     uuid := 'aa100001-0000-4000-8000-0000000000b2';
  eOWN     uuid := 'aa100001-0000-4000-8000-0000000000c1';
  jJOB     uuid := 'aa100001-0000-4000-8000-0000000000d1';
  tORPHAN  uuid := 'aa100001-0000-4000-8000-0000000000e1';
  tORPHAN2 uuid := 'aa100001-0000-4000-8000-0000000000e3';
  tGOOD    uuid := 'aa100001-0000-4000-8000-0000000000e2';
  fakeEmpId text := 'aa100001-0000-4000-8000-0000000000ff';
begin
  perform set_config('request.jwt.claims','',true);

  insert into auth.users(id,email) values
    (uOWN,'a10-own@probe.invalid'),(uSAL,'a10-sal@probe.invalid');
  insert into companies(id,name,subscription_status,subscription_plan,suspended,trial_ends_at,
                        admin_notes,leads_token,stripe_customer_id,invited_email,suspended_reason) values
    (SC,'PROBE-A10','active','pro',false,now()+interval '30 days','',gen_random_uuid(),'cus_A10','','');
  insert into profiles(id,company_id,full_name,role,is_platform_admin,permission_overrides) values
    (uOWN,SC,'A10 Owner','OWNER',false,''),
    (uSAL,SC,'A10 Sales','SALES',false,'');
  insert into employees(id,company_id,name,sync_id,hourly_rate,pay_type,profile_id,is_active) values
    (eOWN,SC,'A10 Owner Emp',eOWN,50.00,'HOURLY',uOWN,true);
  insert into jobs(id,company_id,customer_name,address,phone,email,status,sync_id,contract_total,
                   quote_token,is_test_fixture,notes,assigned_employee_sync_id) values
    (jJOB,SC,'A10 CUSTOMER','1 Probe Way','555-0000','a10@probe.invalid','ACCEPTED',jJOB,1000,
     gen_random_uuid(),false,'',eOWN::text);

  -- Two ORPHANED shifts -- employee_sync_id names nobody. This is the state
  -- supabase_shift_needs_a_person.sql / sec_sync_fix_needs_person_existing_
  -- rows.sql describe as already existing on production (2 real rows).
  -- time_entry_needs_a_person refuses this on INSERT for EVERY caller,
  -- including a direct connection with no impersonation at all (that is how
  -- this fixture line was proven, not assumed: the plain version of this
  -- INSERT was refused, errcode 23514, while writing this file) -- there is
  -- no bypass for who is connecting, only for whether the row already
  -- exists. So the only way such a row can exist at all, today, is to
  -- predate the trigger. The trigger is disabled for these two rows only,
  -- and re-enabled immediately, before any permission probe below runs.
  alter table time_entries disable trigger time_entry_needs_a_person;
  insert into time_entries(id,company_id,sync_id,job_sync_id,employee_sync_id,started_at,ended_at,
                           hourly_rate,notes,updated_at,deleted_at) values
    (tORPHAN ,SC,tORPHAN ,jJOB,fakeEmpId,now()-interval '9 hours',now()-interval '1 hour',0,'',now(),null),
    (tORPHAN2,SC,tORPHAN2,jJOB,fakeEmpId,now()-interval '9 hours',now()-interval '1 hour',0,'',now(),null);
  alter table time_entries enable trigger time_entry_needs_a_person;

  ------------------------------------------------------------ 0x fixture facts
  perform pg_temp.p('00 SALES has_permission SEE_MONEY/SEE_PAY', uSAL,
    'select has_permission(''SEE_MONEY'')::text||''/''||has_permission(''SEE_PAY'')::text', 'true/false');
  perform pg_temp.p('01 SALES can_see_pay() -- the gate stamp_time_entry_rate actually reads', uSAL,
    'select can_see_pay()::text', 'true');
  perform pg_temp.p('02 SALES can_see_employee_pay() -- the correct payroll gate, unused by the trigger', uSAL,
    'select can_see_employee_pay()::text', 'false');
  perform pg_temp.p('03 POSITIVE CONTROL: OWNER has_permission SEE_MONEY/SEE_PAY', uOWN,
    'select has_permission(''SEE_MONEY'')::text||''/''||has_permission(''SEE_PAY'')::text', 'true/true');

  ------------------------------------------------------------ 1x INSERT: a brand-new orphaned shift
  perform pg_temp.x('10 SALES INSERTs a NEW shift naming a nonexistent employee, fake rate 777', uSAL,
    format($q$insert into time_entries(company_id,sync_id,job_sync_id,employee_sync_id,started_at,ended_at,hourly_rate,notes)
             values (%L,gen_random_uuid(),%L,%L,now()-interval '2 hours',now(),777,'')$q$,
           SC, jJOB, fakeEmpId), 'ERR 23514');
  perform pg_temp.s('11 office: how many such fake-employee rows exist now (0 = the insert never landed)',
    format('select count(*)::text from time_entries where company_id=%L and employee_sync_id=%L and hourly_rate=777', SC, fakeEmpId), '0');

  ------------------------------------------------------------ 2x UPDATE: a pre-existing orphaned row
  perform pg_temp.p('20 SALES SELECT count of the orphaned row (0 = invisible)', uSAL,
    format('select count(*)::text from time_entries where sync_id=%L', tORPHAN), '0');
  perform pg_temp.p('21 SALES is_my_shift(fake employee id) on the orphaned row', uSAL,
    format('select is_my_shift(%L)::text', fakeEmpId), 'false');
  perform pg_temp.x('22 SALES UPDATEs the orphaned row''s hourly_rate to 999 (unverified)', uSAL,
    format('update time_entries set hourly_rate=999 where sync_id=%L', tORPHAN), 'rows=0');
  perform pg_temp.s('23 office reads hourly_rate on the orphaned row after SALES''s attempt',
    format('select hourly_rate::text from time_entries where sync_id=%L', tORPHAN), '0');
  perform pg_temp.x('24 POSITIVE CONTROL: OWNER UPDATEs the same orphaned row to 888', uOWN,
    format('update time_entries set hourly_rate=888 where sync_id=%L', tORPHAN), 'rows=1');
  perform pg_temp.s('25 office reads hourly_rate after OWNER''s control update',
    format('select hourly_rate::text from time_entries where sync_id=%L', tORPHAN), '888');

  -- The REAL client shape, on a SEPARATE fresh orphaned row (tORPHAN2) so
  -- this check's precondition does not depend on what 22-25 already did to
  -- tORPHAN. EntitySync.pushTimeEntries's merge pass is an upsert (ON
  -- CONFLICT ... DO UPDATE), not a plain UPDATE, and sec_time_entries_write_
  -- permission.sql documents that Postgres applies the SELECT-side
  -- RESTRICTIVE policy to the CONFLICTING row an upsert touches, same as a
  -- plain UPDATE -- but that is a claim about THIS shape, so it is tested for
  -- real rather than assumed identical to 22 above.
  perform pg_temp.x('26 SALES real upsert shape (ON CONFLICT DO UPDATE) on a fresh orphaned row, fake rate 999', uSAL,
    format($q$insert into time_entries (company_id, sync_id, job_sync_id, employee_sync_id,
                hourly_rate, notes, started_at, ended_at)
             values (%L,%L,%L,%L,999,'',now()-interval '9 hours',now()-interval '1 hour')
             on conflict (company_id, sync_id) do update
                set hourly_rate = excluded.hourly_rate, notes = excluded.notes$q$,
           SC, tORPHAN2, jJOB, fakeEmpId),
           'ERR 42501');
  perform pg_temp.s('27 office reads hourly_rate on the fresh orphaned row after SALES''s upsert attempt',
    format('select hourly_rate::text from time_entries where sync_id=%L', tORPHAN2), '0');

  ------------------------------------------------------------ 3x sanity: a row with a REAL employee
  perform pg_temp.x('30 SALES INSERTs a shift for the REAL employee, fake rate 555', uSAL,
    format($q$insert into time_entries(id,company_id,sync_id,job_sync_id,employee_sync_id,started_at,ended_at,hourly_rate,notes)
             values (%L,%L,%L,%L,%L,now()-interval '3 hours',now(),555,'')$q$,
           tGOOD, SC, tGOOD, jJOB, eOWN::text), 'rows=1');
  perform pg_temp.s('31 office reads that row''s hourly_rate (must be 50, the real employee rate, not 555)',
    format('select hourly_rate::text from time_entries where sync_id=%L', tGOOD), '50');
end $body$;

-- SABOTAGE, outside the do-block: disabling a trigger needs the connecting
-- (table-owner) role, not the impersonated 'authenticated' role used above.
-- Isolates WHETHER time_entry_needs_a_person specifically is what kept 10-11
-- safe, by removing only that guard and repeating the identical attack.
alter table time_entries disable trigger time_entry_needs_a_person;

do $body2$
declare
  SC   uuid := 'aa100001-0000-4000-8000-0000000000a1';
  uSAL uuid := 'aa100001-0000-4000-8000-0000000000b2';
  jJOB uuid := 'aa100001-0000-4000-8000-0000000000d1';
  fakeEmpId text := 'aa100001-0000-4000-8000-0000000000ff';
begin
  perform pg_temp.x('41 SABOTAGE (time_entry_needs_a_person disabled): SALES INSERTs orphaned shift, fake rate 777', uSAL,
    format($q$insert into time_entries(company_id,sync_id,job_sync_id,employee_sync_id,started_at,ended_at,hourly_rate,notes)
             values (%L,gen_random_uuid(),%L,%L,now()-interval '2 hours',now(),777,'')$q$,
           SC, jJOB, fakeEmpId), 'rows=1');
  perform pg_temp.s('42 office: fake-rate-777 rows now (1 = the bug IS exploitable once that ONE guard is gone)',
    format('select count(*)::text from time_entries where company_id=%L and employee_sync_id=%L and hourly_rate=777', SC, fakeEmpId), '1');
end $body2$;

alter table time_entries enable trigger time_entry_needs_a_person;

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

function runSql(sql, { retries = 4 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "a10-pay-rate-"));
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
  throw new Error(`supabase db query failed after ${retries} attempts: ${lastErr}`);
}

function liveProbe() {
  const parsed = runSql(PROBE);
  const rows = Array.isArray(parsed) ? parsed : (parsed.rows || []);
  return rows;
}

test("stamp_time_entry_rate()'s SEE_MONEY-not-SEE_PAY gate: real defect, not currently reachable by SALES", () => {
  const rows = liveProbe();
  const summary = rows.find(r => r.result === "SUMMARY");
  assert.ok(summary, `probe did not report a summary; rows: ${JSON.stringify(rows).slice(0, 500)}`);
  const [pass, total] = String(summary.got).split("/").map(Number);
  const fails = rows.filter(r => r.result === "FAIL");
  assert.equal(total, 18, `expected 18 checks, the probe reported ${total} -- it lost or gained checks`);
  assert.equal(pass, total,
    `not every check matched: ${fails.map(f => `${f.check_name} -> got ${JSON.stringify(f.got)}, want ${JSON.stringify(f.want)}`).join(" | ")}`);
});
