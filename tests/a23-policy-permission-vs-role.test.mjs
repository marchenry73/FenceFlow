// THE MISMATCH, PROVEN LIVE: field_changes_update, job_payments_insert and
// job_payments_update test the caller's ROLE directly (role = ANY ('OWNER',
// 'MANAGER', ...)) while every other write policy this sweep found tests a
// PERMISSION (has_permission('SOME_PERM')) -- the thing profiles.
// permission_overrides exists to adjust per person, and the thing the app's
// own UI gates its buttons on (SessionManager.can(Permission.X)). A role
// check cannot see an override at all, in either direction:
//
//   * an owner who REVOKES a permission from a specific MANAGER (an
//     override the Team access screen writes today) does not lose the
//     ability these three policies guard, because the policy never asked
//     the permission in the first place;
//   * an owner who GRANTS a permission to a SALES/ACCOUNTANT profile that
//     does not hold it by role sees the app light up the matching control
//     (it asks the permission), and the server silently refuses the write
//     anyway (it asks the role) -- a control that does not do the thing,
//     the exact "fake feature" this wave was told to find.
//
// This file proves both directions are real on the LIVE, CURRENT (unfixed)
// policies -- it does not apply supabase_r13_permission_aware_policies.sql
// (unapplied, for the owner to review) and every assertion below is the
// TODAY, PRE-FIX answer. A synthetic profile shaped exactly like the one
// real override this database carries right now (SALES with
// +REQUEST_PAYMENT, confirmed live 2026-09-29) is included on purpose, so
// this is not a hypothetical.
//
// Every check carries a POSITIVE CONTROL beside it (a profile the policy is
// supposed to let through, and one it is supposed to refuse, under the
// CURRENT role-only rule) so a query that quietly matched nothing cannot
// read as "no bug found" -- see supabase_r10/r11's own use of this shape,
// and the project's own "positive control in every probe" rule. Everything
// below runs inside one transaction that is ROLLED BACK, never committed --
// no real company, profile, job, field_changes or job_payments row is read
// or written. The CLI is documented as flaky (~1 login failure in 4);
// runSql() retries before treating any failure as a finding, same as
// tests/a10-pay-rate-permission.test.mjs.
//
// Run:
//   node tests/a23-policy-permission-vs-role.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT = "newcrgafcptspmapacrx";

const PROBE = String.raw`
begin;
set local lock_timeout = '5s';

create temp table r(n serial, k text, got text, want text);
grant all on r to authenticated, anon;
grant usage on sequence r_n_seq to authenticated, anon;

-- Same three helpers as tests/a10-pay-rate-permission.test.mjs: p() reads a
-- SELECT as the impersonated user, x() attempts a write and reports either
-- the affected row count or the error's SQLSTATE, s() reads back as the
-- connecting (service) role with no impersonation at all.
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
  SC      uuid := 'a2300001-0000-4000-8000-0000000000a0';
  uOWN    uuid := 'a2300001-0000-4000-8000-0000000000b0';
  uMGR    uuid := 'a2300001-0000-4000-8000-0000000000b1'; -- MANAGER, no override: baseline
  uMGRR   uuid := 'a2300001-0000-4000-8000-0000000000b2'; -- MANAGER, -APPROVE_PLAN_CHANGES override
  uSPLAN  uuid := 'a2300001-0000-4000-8000-0000000000b3'; -- SALES, +APPROVE_PLAN_CHANGES override
  uSPLAIN uuid := 'a2300001-0000-4000-8000-0000000000b4'; -- SALES, no override: baseline
  uACCT   uuid := 'a2300001-0000-4000-8000-0000000000b5'; -- ACCOUNTANT, no override
  uSPAY   uuid := 'a2300001-0000-4000-8000-0000000000b6'; -- SALES, +REQUEST_PAYMENT -- shaped
                                                           -- exactly like the one real
                                                           -- override this database
                                                           -- carries today (profile
                                                           -- f7e1c214-cdd0-492a-84b4-
                                                           -- 02392b264690, confirmed
                                                           -- live 2026-09-29).
  jJOB    uuid := 'a2300001-0000-4000-8000-0000000000d1';
begin
  perform set_config('request.jwt.claims','',true);

  insert into auth.users(id,email) values
    (uOWN,'a23-own@probe.invalid'),(uMGR,'a23-mgr@probe.invalid'),
    (uMGRR,'a23-mgrr@probe.invalid'),(uSPLAN,'a23-splan@probe.invalid'),
    (uSPLAIN,'a23-splain@probe.invalid'),(uACCT,'a23-acct@probe.invalid'),
    (uSPAY,'a23-spay@probe.invalid');

  -- subscription_status defaults to 'pending', which company_allowed()
  -- (and so company_is_suspended(), and so every _not_suspended RESTRICTIVE
  -- policy) treats as NOT allowed -- a fresh company with no plan yet is
  -- not the state being probed here, so it is stated explicitly.
  insert into companies(id,name,subscription_status) values (SC,'PROBE-A23','active');

  insert into profiles(id,company_id,full_name,role,is_platform_admin,permission_overrides) values
    (uOWN,   SC,'A23 Owner',              'OWNER',     false,''),
    (uMGR,   SC,'A23 Manager',            'MANAGER',   false,''),
    (uMGRR,  SC,'A23 Manager Revoked',    'MANAGER',   false,'-APPROVE_PLAN_CHANGES'),
    (uSPLAN, SC,'A23 Sales Plan-Approve', 'SALES',     false,'+APPROVE_PLAN_CHANGES'),
    (uSPLAIN,SC,'A23 Sales Plain',        'SALES',     false,''),
    (uACCT,  SC,'A23 Accountant',         'ACCOUNTANT',false,''),
    (uSPAY,  SC,'A23 Sales Pay',          'SALES',     false,'+REQUEST_PAYMENT');

  insert into jobs(id,company_id,sync_id,customer_name) values (jJOB,SC,jJOB,'A23 CUSTOMER');

  insert into field_changes(company_id,sync_id,job_sync_id,is_request,summary) values
    (SC,'a23-fc-mgr',   jJOB,true,'mgr row'),
    (SC,'a23-fc-mgrr',  jJOB,true,'mgrr row'),
    (SC,'a23-fc-splan', jJOB,true,'splan row'),
    (SC,'a23-fc-splain',jJOB,true,'splain row');

  insert into job_payments(company_id,job_sync_id,amount_cents,status) values
    (SC,jJOB,201,'pending'), -- mgr's pre-existing row (amount_cents doubles as the row tag)
    (SC,jJOB,202,'pending'), -- accountant's
    (SC,jJOB,203,'pending'), -- sales-pay's
    (SC,jJOB,204,'pending'); -- sales-plain's

  ------------------------------------------------------------ 0x ground truth: has_permission() itself
  perform pg_temp.p('00 POSITIVE CONTROL: OWNER has_permission APPROVE_PLAN_CHANGES/REQUEST_PAYMENT', uOWN,
    'select has_permission(''APPROVE_PLAN_CHANGES'')::text||''/''||has_permission(''REQUEST_PAYMENT'')::text', 'true/true');
  perform pg_temp.p('01 MANAGER (baseline) has_permission APPROVE_PLAN_CHANGES', uMGR,
    'select has_permission(''APPROVE_PLAN_CHANGES'')::text', 'true');
  perform pg_temp.p('02 MANAGER with -APPROVE_PLAN_CHANGES override has_permission APPROVE_PLAN_CHANGES', uMGRR,
    'select has_permission(''APPROVE_PLAN_CHANGES'')::text', 'false');
  perform pg_temp.p('03 SALES with +APPROVE_PLAN_CHANGES override has_permission APPROVE_PLAN_CHANGES', uSPLAN,
    'select has_permission(''APPROVE_PLAN_CHANGES'')::text', 'true');
  perform pg_temp.p('04 SALES (baseline, no override) has_permission APPROVE_PLAN_CHANGES', uSPLAIN,
    'select has_permission(''APPROVE_PLAN_CHANGES'')::text', 'false');
  perform pg_temp.p('05 ACCOUNTANT (default role set) has_permission REQUEST_PAYMENT', uACCT,
    'select has_permission(''REQUEST_PAYMENT'')::text', 'true');
  perform pg_temp.p('06 SALES with +REQUEST_PAYMENT override has_permission REQUEST_PAYMENT (real account''s own shape)', uSPAY,
    'select has_permission(''REQUEST_PAYMENT'')::text', 'true');
  perform pg_temp.p('07 SALES (baseline, no override) has_permission REQUEST_PAYMENT', uSPLAIN,
    'select has_permission(''REQUEST_PAYMENT'')::text', 'false');
  perform pg_temp.p('08 MANAGER (baseline) has_permission REQUEST_PAYMENT', uMGR,
    'select has_permission(''REQUEST_PAYMENT'')::text', 'true');

  ------------------------------------------------------------ 1x field_changes_update, LIVE, UNFIXED
  perform pg_temp.x('10 POSITIVE CONTROL: MANAGER (role+permission agree) approves its own field_changes row', uMGR,
    format($q$update field_changes set approved_at = now() where company_id=%L and sync_id='a23-fc-mgr'$q$, SC), 'rows=1');
  perform pg_temp.s('11 service confirms mgr row is now approved', $q$select (approved_at is not null)::text from field_changes where sync_id='a23-fc-mgr'$q$, 'true');
  perform pg_temp.x('12 MISMATCH: MANAGER whose APPROVE_PLAN_CHANGES was REVOKED still approves (role check never asked)', uMGRR,
    format($q$update field_changes set approved_at = now() where company_id=%L and sync_id='a23-fc-mgrr'$q$, SC), 'rows=1');
  perform pg_temp.s('13 service confirms mgrr row was approved anyway -- the revoked ability was never actually revoked', $q$select (approved_at is not null)::text from field_changes where sync_id='a23-fc-mgrr'$q$, 'true');
  perform pg_temp.x('14 POSITIVE CONTROL: SALES (role+permission agree, both false) is refused', uSPLAIN,
    format($q$update field_changes set approved_at = now() where company_id=%L and sync_id='a23-fc-splain'$q$, SC), 'rows=0');
  perform pg_temp.s('15 service confirms splain row was not touched', $q$select (approved_at is not null)::text from field_changes where sync_id='a23-fc-splain'$q$, 'false');
  perform pg_temp.x('16 MISMATCH: SALES GRANTED APPROVE_PLAN_CHANGES is still refused (role check never asked) -- the fake button', uSPLAN,
    format($q$update field_changes set approved_at = now() where company_id=%L and sync_id='a23-fc-splan'$q$, SC), 'rows=0');
  perform pg_temp.s('17 service confirms splan row is still unapproved despite the owner having granted the permission', $q$select (approved_at is not null)::text from field_changes where sync_id='a23-fc-splan'$q$, 'false');

  ------------------------------------------------------------ 2x job_payments_insert, LIVE, UNFIXED
  perform pg_temp.x('20 POSITIVE CONTROL: MANAGER (role+REQUEST_PAYMENT agree) inserts a job_payments row', uMGR,
    format($q$insert into job_payments(company_id,job_sync_id,amount_cents,status) values (%L,%L,101,'pending')$q$, SC, jJOB), 'rows=1');
  perform pg_temp.x('21 MISMATCH: ACCOUNTANT holds REQUEST_PAYMENT by default ("ask customers for money") but is refused', uACCT,
    format($q$insert into job_payments(company_id,job_sync_id,amount_cents,status) values (%L,%L,102,'pending')$q$, SC, jJOB), 'ERR 42501');
  perform pg_temp.x('22 MISMATCH: SALES with +REQUEST_PAYMENT (the real account''s own override) is refused -- the fake button, live-shaped', uSPAY,
    format($q$insert into job_payments(company_id,job_sync_id,amount_cents,status) values (%L,%L,103,'pending')$q$, SC, jJOB), 'ERR 42501');
  perform pg_temp.x('23 POSITIVE CONTROL: SALES (role+permission agree, both false) is refused', uSPLAIN,
    format($q$insert into job_payments(company_id,job_sync_id,amount_cents,status) values (%L,%L,104,'pending')$q$, SC, jJOB), 'ERR 42501');
  perform pg_temp.s('24 service: of the four insert attempts (101-104), exactly the manager''s landed',
    format('select count(*)::text from job_payments where company_id=%L and amount_cents in (101,102,103,104)', SC), '1');

  ------------------------------------------------------------ 3x job_payments_update, LIVE, UNFIXED
  -- All four acting profiles hold SEE_MONEY (MANAGER and SALES always do,
  -- ACCOUNTANT always does), which is what job_payments_money_hidden_from_
  -- crew (a RESTRICTIVE SELECT policy Postgres also applies to the row an
  -- UPDATE reads) requires -- so a refusal below is job_payments_update's
  -- own role check, not a row nobody could see in the first place.
  perform pg_temp.x('30 POSITIVE CONTROL: MANAGER (role+REQUEST_PAYMENT agree) marks its row paid', uMGR,
    format($q$update job_payments set status='paid' where company_id=%L and amount_cents=201$q$, SC), 'rows=1');
  perform pg_temp.x('31 MISMATCH: ACCOUNTANT holds REQUEST_PAYMENT by default but cannot update its own row', uACCT,
    format($q$update job_payments set status='paid' where company_id=%L and amount_cents=202$q$, SC), 'rows=0');
  perform pg_temp.x('32 MISMATCH: SALES with +REQUEST_PAYMENT (real account''s own override) cannot update its own row', uSPAY,
    format($q$update job_payments set status='paid' where company_id=%L and amount_cents=203$q$, SC), 'rows=0');
  perform pg_temp.x('33 POSITIVE CONTROL: SALES (role+permission agree, both false) is refused', uSPLAIN,
    format($q$update job_payments set status='paid' where company_id=%L and amount_cents=204$q$, SC), 'rows=0');
  perform pg_temp.s('34 service reads all four rows'' status back, in amount_cents order (only 201 -- the manager''s -- moved)',
    format('select string_agg(status, '','' order by amount_cents) from job_payments where company_id=%L and amount_cents in (201,202,203,204)', SC),
    'paid,pending,pending,pending');
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

function runSql(sql, { retries = 4 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "a23-policy-"));
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

test("field_changes_update / job_payments_insert / job_payments_update test ROLE, not the PERMISSION the rest of the schema and the app itself use", () => {
  const rows = liveProbe();
  const summary = rows.find(r => r.result === "SUMMARY");
  assert.ok(summary, `probe did not report a summary; rows: ${JSON.stringify(rows).slice(0, 500)}`);
  const [pass, total] = String(summary.got).split("/").map(Number);
  const fails = rows.filter(r => r.result === "FAIL");
  assert.equal(total, 27, `expected 27 checks, the probe reported ${total} -- it lost or gained checks`);
  assert.equal(pass, total,
    `not every check matched: ${fails.map(f => `${f.check_name} -> got ${JSON.stringify(f.got)}, want ${JSON.stringify(f.want)}`).join(" | ")}`);
});
