// §46 continued -- the parts of the COMPANY half that do NOT need a phone:
// crew membership and roles, scheduling, the time clock (including
// corrections and disputes), and job costing's dependence on approved hours.
//
// tests/company-golden-path.test.mjs already covers signup/onboarding
// (my_setup_progress), pricing through the real engine, production-stage
// gating, payment-to-job-total sync, and job_costing() agreeing with
// jobs.amount_paid. tests/golden-path.test.mjs covers the customer half
// (enquiry, quote, approval, first-signature-wins, bad input). Neither
// touches crew roles, scheduling, or the time clock -- this file is that
// other slice.
//
// Same technique as company-golden-path.test.mjs: `supabase db query
// --linked`, everything inside begin/rollback, nothing survives. Every
// synthetic identity is scoped to ZZ_BUSY (22222222-2222-4222-8222-222222222003,
// see supabase_test_companies.sql) and is created and destroyed inside the
// same transaction -- never a real profile, never a real employee.
//
// The rule that outranks the others: plant the exact failure a check exists
// to catch, watch it fail, undo the plant, then watch the real rule pass.
//
//   node tests/company-crew-golden-path.test.mjs

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT = "newcrgafcptspmapacrx";
const ZZ_BUSY = "22222222-2222-4222-8222-222222222003"; // Pro, active, jobs in every state
const JOB_ACCEPTED = "33333333-0000-4000-8000-000000000003"; // ACCEPTED, contract_total 8600

// Throwaway identities, fixed ids in their own namespace so they can never be
// mistaken for real people or collide with company-golden-path.test.mjs's own
// synthetic ids. All created and rolled back inside a single transaction.
const OWNER_ID  = "99999999-2000-4000-8000-0000000000b1"; // synthetic OWNER of ZZ_BUSY
const MGR_ID    = "99999999-2000-4000-8000-0000000000b2"; // synthetic MANAGER, no MANAGE_ACCESS override
const CREW_A_ID = "99999999-2000-4000-8000-0000000000b3"; // synthetic CREW -- "their own" shift
const CREW_B_ID = "99999999-2000-4000-8000-0000000000b4"; // synthetic CREW -- a DIFFERENT person's shift
// Section 3 only. SALES is the one stock role that holds SEE_MONEY and NOT
// SCHEDULE_AND_ASSIGN (supabase_permissions_patch.sql), which is what makes it
// the only honest subject for the assignment guard -- see that section's own
// note on the restrictive SELECT policy.
const SALES_ID  = "99999999-2000-4000-8000-0000000000b5"; // synthetic SALES
const EMP_A_SYNC = "99999999-2000-4000-8000-0000000000c1"; // employees.sync_id for CREW_A
const EMP_B_SYNC = "99999999-2000-4000-8000-0000000000c2"; // employees.sync_id for CREW_B
const SHIFT_SYNC = "99999999-2000-4000-8000-0000000000d1"; // time_entries.sync_id, CREW_A's shift

let failed = 0, checked = 0;
const ok = (name, cond, detail = "") => {
  checked++;
  if (cond) { console.log(`  ok    ${name}`); return; }
  failed++;
  console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
};

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), "crew-golden-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query",
    "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
    { encoding: "utf8", shell: process.platform === "win32", timeout: 180_000 });
  if (r.status !== 0) {
    throw new Error(`supabase db query failed: ${r.stderr || r.stdout}`);
  }
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { throw new Error(`could not parse CLI output: ${r.stdout}`); }
  return Array.isArray(parsed) ? parsed : (parsed.rows || []);
}

const asClaim = (sub) =>
  `select set_config('request.jwt.claims', json_build_object('sub','${sub}','role','authenticated')::text, true);`;

// Splits a Postgres pg_get_function_result() string of the shape
// "TABLE(col1 type1, col2 type2, ...)" into [{name, type}], tracking paren
// depth so a parameterised type (e.g. numeric(10,2)) can never be split on
// its own internal comma. Section 8 uses this to build a job_costing() plant
// whose OUT list is always whatever is actually live, never a hand-typed
// snapshot that rots the next time a column is added.
function parseTableColumns(resultClause) {
  const inner = resultClause.replace(/^\s*TABLE\(/i, "").replace(/\)\s*$/, "");
  const parts = [];
  let depth = 0, cur = "";
  for (const ch of inner) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(p => {
    const t = p.trim();
    const sp = t.indexOf(" ");
    return { name: t.slice(0, sp), type: t.slice(sp + 1).trim() };
  });
}

// Common setup shared by every section below: an OWNER, a MANAGER with no
// overrides, and two CREW members each backed by a real employees row (so
// employees.profile_id -> auth.uid() actually resolves, the same link
// acknowledge_my_shift/dispute_my_shift use).
const FIXTURES = `
insert into auth.users(id) values ('${OWNER_ID}'), ('${MGR_ID}'), ('${CREW_A_ID}'), ('${CREW_B_ID}');
insert into profiles(id, company_id, role, full_name) values
  ('${OWNER_ID}', '${ZZ_BUSY}', 'OWNER',   'ZZ TEST Crew Owner'),
  ('${MGR_ID}',   '${ZZ_BUSY}', 'MANAGER', 'ZZ TEST Crew Manager'),
  ('${CREW_A_ID}','${ZZ_BUSY}', 'CREW',    'ZZ TEST Crew A'),
  ('${CREW_B_ID}','${ZZ_BUSY}', 'CREW',    'ZZ TEST Crew B');
-- hourly_rate here is the figure that actually sticks: stamp_time_entry_rate()
-- (supabase_time_entry_rate_patch.sql) overwrites whatever a time_entries
-- INSERT/UPDATE states with the matching employees row's own rate whenever
-- one exists, precisely so a phone can never state its own pay unverified.
-- Section 8 depends on EMP_A and EMP_B carrying two DIFFERENT rates.
insert into employees(company_id, sync_id, name, profile_id, hourly_rate, is_active) values
  ('${ZZ_BUSY}', '${EMP_A_SYNC}', 'ZZ TEST Crew A', '${CREW_A_ID}', 22, true),
  ('${ZZ_BUSY}', '${EMP_B_SYNC}', 'ZZ TEST Crew B', '${CREW_B_ID}', 30, true);
`;

// Deliberately NOT folded into FIXTURES. Only section 3 needs a SALES account,
// and every other section resolves permissions and counts rows against the set
// of people FIXTURES describes -- quietly adding a sixth profile to all of them
// is how a check starts measuring something nobody asked it to.
const SALES_FIXTURE = `
insert into auth.users(id) values ('${SALES_ID}');
insert into profiles(id, company_id, role, full_name) values
  ('${SALES_ID}', '${ZZ_BUSY}', 'SALES', 'ZZ TEST Crew Sales');
`;

async function main() {
  // =========================================================================
  console.log("\n1. CREW ROLES -- has_permission(): a revocation must beat a grant:");
  console.log("   (permission_overrides stores +GRANT/-REVOKE diffs from the role default;");
  console.log("    a contradictory override -- both present at once -- must deny, not allow,");
  console.log("    because someone asking to be let in is cheaper than someone quietly");
  console.log("    holding access nobody granted -- see supabase_permissions_patch.sql)");

  const check1 = runSql(`
begin;
${FIXTURES}
create temp table probe1(case_name text, has_it boolean) on commit drop;
grant all on probe1 to authenticated;

-- CREW's role default carries RECORD_FIELD_WORK only. Give CREW_A both a
-- grant AND a revoke for the SAME permission it does not hold by role default
-- (SEE_MONEY) -- the contradictory case the "revoke wins" rule exists for.
update profiles set permission_overrides = '+SEE_MONEY,-SEE_MONEY' where id = '${CREW_A_ID}';

${asClaim(CREW_A_ID)}
set local role authenticated;
insert into probe1 select 'REAL RULE: contradictory override (+ and - for the same permission)', has_permission('SEE_MONEY');
reset role;

-- ---- PLANTED FAILURE: swap the two branches so a grant is checked before a
-- revoke -- the exact inversion that would let "+SEE_MONEY,-SEE_MONEY" read
-- as granted.
create or replace function public.has_permission(perm text)
returns boolean language sql stable security definer set search_path = public as $inner$
  with me as (
    select role::text as role_text, coalesce(permission_overrides, '') as overrides
    from profiles where id = auth.uid()
  )
  select case
    when position('+' || perm in (select overrides from me)) > 0 then true
    when position('-' || perm in (select overrides from me)) > 0 then false
    else case (select role_text from me)
      when 'OWNER' then true
      when 'MANAGER' then perm in (
        'SEE_MONEY','SEE_PAY','EDIT_JOBS','EDIT_CATALOG_AND_SETTINGS','SCHEDULE_AND_ASSIGN',
        'REQUEST_PAYMENT','RECORD_FIELD_WORK','SEE_CUSTOMER_CONTACT','SEE_REPORTS',
        'APPROVE_TIME','APPROVE_PLAN_CHANGES')
      when 'SALES' then perm in ('SEE_MONEY','EDIT_JOBS','SEE_CUSTOMER_CONTACT')
      when 'ACCOUNTANT' then perm in (
        'SEE_MONEY','SEE_PAY','REQUEST_PAYMENT','RECORD_REFUNDS','SEE_CUSTOMER_CONTACT','SEE_REPORTS')
      when 'FOREMAN' then perm in (
        'SCHEDULE_AND_ASSIGN','RECORD_FIELD_WORK','SEE_CUSTOMER_CONTACT',
        'APPROVE_TIME','APPROVE_PLAN_CHANGES')
      when 'CREW' then perm in ('RECORD_FIELD_WORK')
      else false
    end
  end;
$inner$;

${asClaim(CREW_A_ID)}
set local role authenticated;
insert into probe1 select 'PLANTED-BUG: grant-checked-first wrongly reads the contradictory override as granted', has_permission('SEE_MONEY');
reset role;

-- undo the plant: restore the real, live definition (revoke branch first)
CREATE OR REPLACE FUNCTION public.has_permission(perm text)
 RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  with me as (
    select role::text as role_text, coalesce(permission_overrides, '') as overrides
    from profiles where id = auth.uid()
  )
  select case
    when position('-' || perm in (select overrides from me)) > 0 then false
    when position('+' || perm in (select overrides from me)) > 0 then true
    else case (select role_text from me)
      when 'OWNER' then true
      when 'MANAGER' then perm in (
        'SEE_MONEY','SEE_PAY','EDIT_JOBS','EDIT_CATALOG_AND_SETTINGS','SCHEDULE_AND_ASSIGN',
        'REQUEST_PAYMENT','RECORD_FIELD_WORK','SEE_CUSTOMER_CONTACT','SEE_REPORTS',
        'APPROVE_TIME','APPROVE_PLAN_CHANGES')
      when 'SALES' then perm in ('SEE_MONEY','EDIT_JOBS','SEE_CUSTOMER_CONTACT')
      when 'ACCOUNTANT' then perm in (
        'SEE_MONEY','SEE_PAY','REQUEST_PAYMENT','RECORD_REFUNDS','SEE_CUSTOMER_CONTACT','SEE_REPORTS')
      when 'FOREMAN' then perm in (
        'SCHEDULE_AND_ASSIGN','RECORD_FIELD_WORK','SEE_CUSTOMER_CONTACT',
        'APPROVE_TIME','APPROVE_PLAN_CHANGES')
      when 'CREW' then perm in ('RECORD_FIELD_WORK')
      else false
    end
  end;
$function$;

${asClaim(CREW_A_ID)}
set local role authenticated;
insert into probe1 select 'after restoring the real function, the SAME contradictory override', has_permission('SEE_MONEY');
reset role;

-- CANARY: prove CREW_A really has no SEE_MONEY by role default absent any override.
update profiles set permission_overrides = '' where id = '${CREW_A_ID}';
${asClaim(CREW_A_ID)}
set local role authenticated;
insert into probe1 select 'CANARY: CREW role default has no SEE_MONEY at all', has_permission('SEE_MONEY');
reset role;

select * from probe1 order by case_name;
rollback;
`);
  const row1 = (name) => check1.find(r => r.case_name === name) || {};
  ok("CANARY: a plain CREW profile has no SEE_MONEY by role default",
     row1("CANARY: CREW role default has no SEE_MONEY at all").has_it === false,
     JSON.stringify(row1("CANARY: CREW role default has no SEE_MONEY at all")));
  ok("REAL RULE: a contradictory override (both +SEE_MONEY and -SEE_MONEY set) denies access",
     row1("REAL RULE: contradictory override (+ and - for the same permission)").has_it === false,
     JSON.stringify(row1("REAL RULE: contradictory override (+ and - for the same permission)")));
  ok("PLANTED FAILURE: checking the grant branch first wrongly grants the SAME contradictory " +
     "override (proves this check can fail)",
     row1("PLANTED-BUG: grant-checked-first wrongly reads the contradictory override as granted").has_it === true,
     JSON.stringify(row1("PLANTED-BUG: grant-checked-first wrongly reads the contradictory override as granted")));
  ok("after restoring the real function, the contradictory override denies access again",
     row1("after restoring the real function, the SAME contradictory override").has_it === false,
     JSON.stringify(row1("after restoring the real function, the SAME contradictory override")));

  // =========================================================================
  console.log("\n2. CREW ROLES -- changing who someone IS is owner-only:");
  console.log("   (profiles has two UPDATE policies OR'd together: profiles_manage, which needs");
  console.log("    MANAGE_ACCESS and is not-self, and profiles_update_own_company, which needs");
  console.log("    role = OWNER. MANAGER is not in has_permission's MANAGE_ACCESS list by");
  console.log("    default, so a bare MANAGER should NOT be able to promote anybody.)");

  const check2 = runSql(`
begin;
${FIXTURES}
create temp table probe2(case_name text, new_role text, rows_touched int) on commit drop;
grant all on probe2 to authenticated;

-- ---- REAL rule: a bare MANAGER (no MANAGE_ACCESS override) tries to promote
-- CREW_B to OWNER. Both RLS policies should refuse: profiles_manage because
-- MANAGER lacks MANAGE_ACCESS by default, profiles_update_own_company because
-- the caller is not OWNER.
--
-- The UPDATE and the read-back are deliberately TWO statements, not a
-- data-modifying CTE feeding a sibling subquery in the same command: a single
-- command takes one snapshot for its whole execution, so a subquery reading
-- the same table elsewhere in that command would not see the CTE's own write
-- even when the write succeeded -- it would report the pre-update row every
-- time, whether the UPDATE was refused OR happened to actually go through.
${asClaim(MGR_ID)}
set local role authenticated;
create temp table touched2a(n int) on commit drop;
with u as (update profiles set role = 'OWNER' where id = '${CREW_B_ID}' returning 1) insert into touched2a select count(*) from u;
insert into probe2 select 'a bare MANAGER tries to promote someone to OWNER', (select role::text from profiles where id='${CREW_B_ID}'), (select n from touched2a);
reset role;

-- ---- PLANTED FAILURE: recreate profiles_manage with the permission check
-- removed -- exactly the shape of bug that would let any company member
-- reassign anyone's role.
drop policy if exists profiles_manage on profiles;
create policy profiles_manage on profiles
  for update using (company_id = current_company_id() and id <> auth.uid());

${asClaim(MGR_ID)}
set local role authenticated;
create temp table touched2b(n int) on commit drop;
with u as (update profiles set role = 'OWNER' where id = '${CREW_B_ID}' returning 1) insert into touched2b select count(*) from u;
insert into probe2 select 'PLANTED-BUG: permission check removed, bare MANAGER promotes to OWNER', (select role::text from profiles where id='${CREW_B_ID}'), (select n from touched2b);
reset role;

-- undo the plant: restore the real, live policy (supabase_permissions_patch.sql)
drop policy if exists profiles_manage on profiles;
create policy profiles_manage on profiles
  for update
  using (
    company_id = current_company_id()
    and public.has_permission('MANAGE_ACCESS')
    and id <> auth.uid()
  );
-- CREW_B's role was actually changed by the plant (it is a real UPDATE, not RLS-refused),
-- so put it back before the real-owner case below.
update profiles set role = 'CREW' where id = '${CREW_B_ID}';

-- ---- REAL rule: the OWNER changes CREW_B's role. This is allowed --
-- profiles_update_own_company checks role = 'OWNER' with no MANAGE_ACCESS gate at all.
${asClaim(OWNER_ID)}
set local role authenticated;
create temp table touched2c(n int) on commit drop;
with u as (update profiles set role = 'MANAGER' where id = '${CREW_B_ID}' returning 1) insert into touched2c select count(*) from u;
insert into probe2 select 'the OWNER promotes CREW_B to MANAGER', (select role::text from profiles where id='${CREW_B_ID}'), (select n from touched2c);
reset role;

select * from probe2 order by case_name;
rollback;
`);
  const row2 = (name) => check2.find(r => r.case_name === name) || {};
  ok("REAL RULE: a bare MANAGER cannot promote anybody -- 0 rows touched, role unchanged",
     Number(row2("a bare MANAGER tries to promote someone to OWNER").rows_touched) === 0 &&
     row2("a bare MANAGER tries to promote someone to OWNER").new_role === "CREW",
     JSON.stringify(row2("a bare MANAGER tries to promote someone to OWNER")));
  ok("PLANTED FAILURE: with the permission check removed from profiles_manage, the same bare " +
     "MANAGER wrongly promotes CREW_B to OWNER (proves this check can fail)",
     Number(row2("PLANTED-BUG: permission check removed, bare MANAGER promotes to OWNER").rows_touched) === 1 &&
     row2("PLANTED-BUG: permission check removed, bare MANAGER promotes to OWNER").new_role === "OWNER",
     JSON.stringify(row2("PLANTED-BUG: permission check removed, bare MANAGER promotes to OWNER")));
  ok("REAL RULE: the OWNER can change a crew member's role",
     Number(row2("the OWNER promotes CREW_B to MANAGER").rows_touched) === 1 &&
     row2("the OWNER promotes CREW_B to MANAGER").new_role === "MANAGER",
     JSON.stringify(row2("the OWNER promotes CREW_B to MANAGER")));

  // =========================================================================
  console.log("\n3. SCHEDULING -- reassigning a job needs SCHEDULE_AND_ASSIGN:");
  console.log("   (guard_job_assignment, supabase_approval_and_assignment_guard.sql. jobs_update");
  console.log("    is still `company_id = current_company_id()` and nothing else, so the policy");
  console.log("    grants the write; the trigger is what takes assigned_employee_sync_id back.");
  console.log("    A trigger and not a policy because crew must keep updating their own jobs to");
  console.log("    push a production stage -- only these columns are refused.)");
  console.log("");
  console.log("   The refused subject is a SALES account, NOT a crew member, and that choice is");
  console.log("   the whole assertion. jobs carries a RESTRICTIVE SELECT policy");
  console.log("   (jobs_money_hidden_from_crew: has_permission('SEE_MONEY')). A CREW caller");
  console.log("   cannot see the row at all, so their UPDATE ... WHERE matches nothing and");
  console.log("   returns zero rows touched and no error -- which is indistinguishable from the");
  console.log("   assignment guard refusing, and would have proved the money lockdown while");
  console.log("   claiming to prove scheduling. SALES holds SEE_MONEY and does NOT hold");
  console.log("   SCHEDULE_AND_ASSIGN, so the row is visible and the guard is the only thing");
  console.log("   that can stop the write. That confound is measured below, not assumed.");

  const check3 = runSql(`
begin;
${FIXTURES}
${SALES_FIXTURE}
create temp table probe3(label text, touched int, refused text, assigned text) on commit drop;
grant all on probe3 to authenticated;

-- ---- CONFOUND CONTROL: how many rows each candidate subject can even SEE.
-- Measured rather than asserted from memory, because the whole choice of a
-- SALES subject rests on it: if SALES could not see the row either, every
-- "0 rows touched" below would mean nothing.
do $g3v$
declare seen int;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub','${CREW_A_ID}','role','authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into seen from jobs where sync_id = '${JOB_ACCEPTED}' and company_id = '${ZZ_BUSY}';
  execute 'reset role';
  insert into probe3 values ('CONFOUND: rows a CREW caller can see', seen, null, null);

  perform set_config('request.jwt.claims',
    json_build_object('sub','${SALES_ID}','role','authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into seen from jobs where sync_id = '${JOB_ACCEPTED}' and company_id = '${ZZ_BUSY}';
  execute 'reset role';
  insert into probe3 values ('CONFOUND: rows a SALES caller can see', seen, null, null);
end $g3v$;

-- ---- PLANTED FAILURE: drop the guard trigger, leaving jobs_update's bare
-- company_id test as the only thing in the way -- the state this section
-- originally reported as a finding. The same SALES account must now succeed.
drop trigger if exists job_assignment_needs_permission on jobs;

do $g3a$
declare n int;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub','${SALES_ID}','role','authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    update jobs set assigned_employee_sync_id = '${EMP_A_SYNC}'
      where sync_id = '${JOB_ACCEPTED}' and company_id = '${ZZ_BUSY}';
    -- An UPDATE that matches no rows raises nothing at all. Counting the rows
    -- it actually touched is the only way to tell "the write was allowed"
    -- from "the row was never visible to this caller" -- reading the absence
    -- of an error as permission granted is exactly how this section came to
    -- report a finding it had never measured.
    get diagnostics n = row_count;
    execute 'reset role';
    insert into probe3 values ('PLANTED-BUG: guard dropped, SALES reassigns', n, null,
      (select assigned_employee_sync_id from jobs where sync_id = '${JOB_ACCEPTED}'));
  exception when others then
    execute 'reset role';
    insert into probe3 values ('PLANTED-BUG: guard dropped, SALES reassigns', 0, SQLERRM, null);
  end;
end $g3a$;

-- undo the plant: restore the real trigger (supabase_approval_and_assignment_guard.sql)
drop trigger if exists job_assignment_needs_permission on jobs;
create trigger job_assignment_needs_permission
  before update on jobs
  for each row execute function public.guard_job_assignment();

-- Put the column back to unset before the real cases, so the read-back below
-- can only be showing a write that just happened. This runs as the outer
-- (non-authenticated) role, which guard_job_assignment deliberately waves
-- through -- current_user is checked, not auth.uid(), so a definer-owned
-- server job stays possible without that same hole opening for anon.
update jobs set assigned_employee_sync_id = null where sync_id = '${JOB_ACCEPTED}';

-- ---- REAL RULE: SALES can see the row and still cannot reassign it.
do $g3b$
declare n int;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub','${SALES_ID}','role','authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    update jobs set assigned_employee_sync_id = '${EMP_A_SYNC}'
      where sync_id = '${JOB_ACCEPTED}' and company_id = '${ZZ_BUSY}';
    get diagnostics n = row_count;
    execute 'reset role';
    insert into probe3 values ('REAL RULE: SALES reassigns a job', n, null,
      (select assigned_employee_sync_id from jobs where sync_id = '${JOB_ACCEPTED}'));
  exception when others then
    execute 'reset role';
    insert into probe3 values ('REAL RULE: SALES reassigns a job', 0, SQLERRM,
      (select assigned_employee_sync_id from jobs where sync_id = '${JOB_ACCEPTED}'));
  end;
end $g3b$;

-- ---- REAL RULE, positive half: a MANAGER holds both SEE_MONEY (so the row is
-- visible) and SCHEDULE_AND_ASSIGN. Scheduling must still work, or the guard
-- has simply broken the feature rather than gated it.
do $g3c$
declare n int;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub','${MGR_ID}','role','authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    update jobs set assigned_employee_sync_id = '${EMP_B_SYNC}'
      where sync_id = '${JOB_ACCEPTED}' and company_id = '${ZZ_BUSY}';
    get diagnostics n = row_count;
    execute 'reset role';
    insert into probe3 values ('REAL RULE: MANAGER reassigns a job', n, null,
      (select assigned_employee_sync_id from jobs where sync_id = '${JOB_ACCEPTED}'));
  exception when others then
    execute 'reset role';
    insert into probe3 values ('REAL RULE: MANAGER reassigns a job', 0, SQLERRM,
      (select assigned_employee_sync_id from jobs where sync_id = '${JOB_ACCEPTED}'));
  end;
end $g3c$;

select label, touched, refused, assigned from probe3 order by label;
rollback;
`);
  const row3 = (name) => check3.find(r => r.label === name) || {};
  const crewSees = row3("CONFOUND: rows a CREW caller can see");
  const salesSees = row3("CONFOUND: rows a SALES caller can see");
  const planted3 = row3("PLANTED-BUG: guard dropped, SALES reassigns");
  const salesReal = row3("REAL RULE: SALES reassigns a job");
  const mgrReal = row3("REAL RULE: MANAGER reassigns a job");

  ok("CONFOUND: a SALES caller can see the job row (1) -- so a refusal below is the " +
     "assignment guard, not the money lockdown hiding the row",
     Number(salesSees.touched) === 1, JSON.stringify(salesSees));
  ok("CONFOUND: a CREW caller cannot see it (0) -- the reason CREW is the wrong subject " +
     "for this check, measured rather than assumed",
     Number(crewSees.touched) === 0, JSON.stringify(crewSees));
  ok("PLANTED FAILURE: with job_assignment_needs_permission dropped, SALES reassigns the " +
     "job anyway -- 1 row touched, column written (proves this check can fail)",
     Number(planted3.touched) === 1 && planted3.assigned === EMP_A_SYNC && !planted3.refused,
     JSON.stringify(planted3));
  // Both halves asserted together on purpose. Zero rows alone would also be
  // what an invisible row looks like; a refusal alone could be raised by
  // anything. Zero rows AND a 42501 naming the permission is the guard.
  ok("REAL RULE: SALES (SEE_MONEY, no SCHEDULE_AND_ASSIGN) is refused -- 0 rows touched " +
     "AND an explicit error naming SCHEDULE_AND_ASSIGN, not silence",
     Number(salesReal.touched) === 0 &&
     typeof salesReal.refused === "string" &&
     salesReal.refused.includes("SCHEDULE_AND_ASSIGN"),
     JSON.stringify(salesReal));
  ok("REAL RULE: the refused write left assigned_employee_sync_id unset",
     salesReal.assigned === null, JSON.stringify(salesReal));
  ok("REAL RULE, positive half: a MANAGER (holds SCHEDULE_AND_ASSIGN) reassigns the job -- " +
     "1 row touched, no error, the column now names the employee they chose",
     Number(mgrReal.touched) === 1 && !mgrReal.refused && mgrReal.assigned === EMP_B_SYNC,
     JSON.stringify(mgrReal));

  // =========================================================================
  console.log("\n4. THE TIME CLOCK -- a shift must name a person:");
  console.log("   (time_entry_needs_a_person, supabase_shift_needs_a_person.sql -- an unassigned");
  console.log("    clock-in becomes free labour: no rate, no pay owed, invisible in every list)");

  const check4 = runSql(`
begin;
${FIXTURES}
create temp table probe4(case_name text, ok_result boolean, detail text) on commit drop;
grant all on probe4 to authenticated;

-- ---- PLANTED FAILURE: drop the trigger entirely.
drop trigger if exists time_entry_needs_a_person on public.time_entries;

${asClaim(CREW_A_ID)}
set local role authenticated;
do $inner$
begin
  begin
    insert into time_entries(company_id, sync_id, job_sync_id, employee_sync_id, started_at)
    values ('${ZZ_BUSY}', gen_random_uuid(), '${JOB_ACCEPTED}', '', now());
    insert into probe4 values ('PLANTED-BUG: trigger dropped, a shift with no crew member is accepted', true, 'wrongly succeeded');
  exception when others then
    insert into probe4 values ('PLANTED-BUG: trigger dropped, a shift with no crew member is accepted', false, sqlerrm);
  end;
end $inner$;
reset role;
delete from time_entries where company_id = '${ZZ_BUSY}' and employee_sync_id = '';

-- undo the plant: restore the real trigger (supabase_shift_needs_a_person.sql)
create trigger time_entry_needs_a_person
    before insert or update on public.time_entries
    for each row execute function public.time_entry_needs_a_person();

-- ---- REAL rule ----
${asClaim(CREW_A_ID)}
set local role authenticated;
do $inner$
begin
  begin
    insert into time_entries(company_id, sync_id, job_sync_id, employee_sync_id, started_at)
    values ('${ZZ_BUSY}', gen_random_uuid(), '${JOB_ACCEPTED}', '', now());
    insert into probe4 values ('a shift with a blank employee_sync_id is refused', false, 'wrongly succeeded');
  exception when others then
    insert into probe4 values ('a shift with a blank employee_sync_id is refused', true, sqlerrm);
  end;

  begin
    insert into time_entries(company_id, sync_id, job_sync_id, employee_sync_id, started_at)
    values ('${ZZ_BUSY}', '${SHIFT_SYNC}', '${JOB_ACCEPTED}', '${EMP_A_SYNC}', now());
    insert into probe4 values ('a shift naming a real crew member is accepted', true, 'accepted');
  exception when others then
    insert into probe4 values ('a shift naming a real crew member is accepted', false, sqlerrm);
  end;
end $inner$;
reset role;

select case_name, ok_result, detail from probe4 order by case_name;
rollback;
`);
  const row4 = (name) => check4.find(r => r.case_name === name) || {};
  ok("PLANTED FAILURE: with the trigger dropped, a shift with no crew member is wrongly accepted " +
     "(proves this check can fail)",
     row4("PLANTED-BUG: trigger dropped, a shift with no crew member is accepted").ok_result === true,
     row4("PLANTED-BUG: trigger dropped, a shift with no crew member is accepted").detail);
  ok("REAL RULE: a shift with a blank employee_sync_id is refused",
     row4("a shift with a blank employee_sync_id is refused").ok_result === true,
     row4("a shift with a blank employee_sync_id is refused").detail);
  ok("REAL RULE: a shift naming a real crew member is accepted (the trigger doesn't overreach)",
     row4("a shift naming a real crew member is accepted").ok_result === true,
     row4("a shift naming a real crew member is accepted").detail);

  // =========================================================================
  console.log("\n5. THE TIME CLOCK -- a correction keeps what the clock originally said:");
  console.log("   (preserve_original_shift, supabase_time_corrections.sql -- the office may");
  console.log("    correct a shift, but the original must survive, even through a SECOND");
  console.log("    correction, because the clock is the record a pay dispute is settled from)");

  const check5 = runSql(`
begin;
${FIXTURES}
insert into time_entries(company_id, sync_id, job_sync_id, employee_sync_id, started_at, ended_at, hourly_rate)
values ('${ZZ_BUSY}', '${SHIFT_SYNC}', '${JOB_ACCEPTED}', '${EMP_A_SYNC}',
        '2026-09-01T13:00:00Z', '2026-09-01T21:00:00Z', 22);

create temp table probe5(case_name text, started_at timestamptz, original_started_at timestamptz) on commit drop;
grant all on probe5 to authenticated;

-- First correction: the crew member actually started at 12:47, not 13:00.
update time_entries set started_at = '2026-09-01T12:47:00Z'
  where sync_id = '${SHIFT_SYNC}' and company_id = '${ZZ_BUSY}';
insert into probe5 select 'after the FIRST correction', started_at, original_started_at
  from time_entries where sync_id = '${SHIFT_SYNC}';

-- ---- PLANTED FAILURE: a version of the trigger that always overwrites
-- original_started_at with the NEW value instead of coalescing the old one --
-- the exact bug that would let a second correction launder the first one away.
create or replace function public.preserve_original_shift()
returns trigger language plpgsql security definer set search_path to 'public' as $inner$
begin
    if new.started_at is distinct from old.started_at then
        new.original_started_at := new.started_at; -- BUG: should be coalesce(old.original_started_at, old.started_at)
    end if;
    return new;
end;
$inner$;

update time_entries set started_at = '2026-09-01T12:50:00Z'
  where sync_id = '${SHIFT_SYNC}' and company_id = '${ZZ_BUSY}';
insert into probe5 select 'PLANTED-BUG: after a SECOND correction with the broken trigger', started_at, original_started_at
  from time_entries where sync_id = '${SHIFT_SYNC}';

-- undo the plant: restore the real trigger (supabase_time_corrections.sql)
CREATE OR REPLACE FUNCTION public.preserve_original_shift()
 RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
    if new.started_at is distinct from old.started_at then
        new.original_started_at := coalesce(old.original_started_at, old.started_at);
    end if;
    if new.ended_at is distinct from old.ended_at then
        new.original_ended_at := coalesce(old.original_ended_at, old.ended_at);
    end if;
    if old.ended_at is null and new.ended_at is not null then
        new.original_ended_at := old.original_ended_at;
    end if;
    if (new.started_at is distinct from old.started_at)
       or (old.ended_at is not null and new.ended_at is distinct from old.ended_at) then
        new.corrected_at := now();
        new.corrected_by := coalesce(auth.uid(), new.corrected_by);
    end if;
    return new;
end;
$function$;

-- Put the row back to "after the first correction" state, then apply a real
-- THIRD correction, and prove the ORIGINAL (13:00) survives.
--
-- Three separate statements, deliberately: the (now-restored) real trigger
-- re-derives original_started_at from old.started_at/old.original_started_at
-- whenever started_at itself changes in the SAME statement, so setting both
-- columns together would have the trigger immediately overwrite the
-- original_started_at this reset is trying to force. Changing started_at
-- first, then original_started_at alone (started_at unchanged, so the
-- trigger's "did it move" branch does not fire), leaves the reset state
-- exactly as intended before the real third correction runs.
update time_entries set started_at = '2026-09-01T12:47:00Z'
  where sync_id = '${SHIFT_SYNC}' and company_id = '${ZZ_BUSY}';
update time_entries set original_started_at = '2026-09-01T13:00:00Z'
  where sync_id = '${SHIFT_SYNC}' and company_id = '${ZZ_BUSY}';
update time_entries set started_at = '2026-09-01T12:45:00Z'
  where sync_id = '${SHIFT_SYNC}' and company_id = '${ZZ_BUSY}';
insert into probe5 select 'after restoring the real trigger and a further correction', started_at, original_started_at
  from time_entries where sync_id = '${SHIFT_SYNC}';

select case_name, started_at, original_started_at from probe5 order by case_name;
rollback;
`);
  // The CLI's json output renders timestamptz as "YYYY-MM-DD HH:MM:SS+00", not
  // ISO's "T" separator -- compare on the substring that's actually present.
  const has = (v, s) => typeof v === "string" && v.includes(s);
  const row5 = (name) => check5.find(r => r.case_name === name) || {};
  ok("REAL RULE: the first correction moves started_at and stamps the ORIGINAL clock time (13:00)",
     has(row5("after the FIRST correction").original_started_at, "13:00:00"),
     JSON.stringify(row5("after the FIRST correction")));
  // The planted trigger always writes new.original_started_at := new.started_at,
  // so after this second correction original_started_at reads the SAME as the
  // just-corrected started_at (12:50) instead of the real original (13:00) --
  // the true original is gone the moment a second correction happens.
  ok("PLANTED FAILURE: the broken trigger lets a second correction overwrite original_started_at " +
     "with the just-corrected value, losing the real original (proves this check can fail)",
     has(row5("PLANTED-BUG: after a SECOND correction with the broken trigger").original_started_at, "12:50:00") &&
     !has(row5("PLANTED-BUG: after a SECOND correction with the broken trigger").original_started_at, "13:00:00"),
     JSON.stringify(row5("PLANTED-BUG: after a SECOND correction with the broken trigger")));
  ok("REAL RULE: after restoring the real trigger, a further correction still leaves the " +
     "ORIGINAL 13:00 clock time untouched",
     has(row5("after restoring the real trigger and a further correction").original_started_at, "13:00:00") &&
     has(row5("after restoring the real trigger and a further correction").started_at, "12:45:00"),
     JSON.stringify(row5("after restoring the real trigger and a further correction")));

  // =========================================================================
  console.log("\n6. THE TIME CLOCK -- disputing a shift only works on YOUR OWN shift:");
  console.log("   (dispute_my_shift/acknowledge_my_shift, supabase_shift_dispute.sql -- these are");
  console.log("    SECURITY DEFINER and check the caller IS the named employee via profile_id;");
  console.log("    time_entries_update itself is company-wide with no such check.");
  console.log("");
  console.log("   A second, independent layer sits one level further out: guard_time_entry_write_");
  console.log("   permission (supabase_sec_time_entries_write_permission.sql) ALSO refuses a raw");
  console.log("   PostgREST PATCH that writes correction_disputed_at/dispute_note/correction_seen_at");
  console.log("   on somebody else's shift -- but it explicitly exempts SECURITY DEFINER callers by");
  console.log("   current_user (its own comment: 'these keep working untouched'), so it does NOT");
  console.log("   re-guard THIS RPC. dispute_my_shift()'s own ownership check remains the only thing");
  console.log("   stopping a forged dispute through the RPC; the trigger guards a DIFFERENT path -- a");
  console.log("   raw UPDATE straight against time_entries, skipping the RPC. Both are real, and both");
  console.log("   are proved below, on the vector each one actually covers.");
  console.log("");
  console.log("   CONFOUND, measured before trusting any read-back: time_entries carries a");
  console.log("   RESTRICTIVE SELECT policy, time_entries_pay_needs_see_pay -- has_permission");
  console.log("   ('SEE_PAY') OR is_my_shift(employee_sync_id). CREW_B has neither for CREW_A's");
  console.log("   shift, so the WHOLE ROW -- not just its rate -- is invisible to a read done as");
  console.log("   CREW_B, UPDATE included (RLS needs SELECT visibility to know which rows a WHERE");
  console.log("   clause may even touch). A read-back taken through CREW_B's own eyes cannot tell");
  console.log("   'the write was refused' from 'the write landed and I am simply not allowed to see");
  console.log("   it' -- which is exactly what made the forged-dispute canary below look toothless");
  console.log("   the day this guard trigger shipped. Every read-back below goes through a caller");
  console.log("   who can actually see the row.");

  const check6 = runSql(`
begin;
${FIXTURES}
insert into time_entries(company_id, sync_id, job_sync_id, employee_sync_id, started_at, ended_at, hourly_rate)
values ('${ZZ_BUSY}', '${SHIFT_SYNC}', '${JOB_ACCEPTED}', '${EMP_A_SYNC}',
        '2026-09-01T13:00:00Z', '2026-09-01T21:00:00Z', 22);

create temp table probe6(case_name text, disputed boolean, dispute_note text, touched int, refused text) on commit drop;
grant all on probe6 to authenticated;
create temp table probe6_call(disputed boolean) on commit drop;
grant all on probe6_call to authenticated;

-- ---- CONFOUND CONTROL, measured rather than assumed (same discipline as
-- section 3's SALES/CREW split): can CREW_B even see the row before trying to
-- dispute it?
do $g6v$
declare seen int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub','${CREW_B_ID}','role','authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into seen from time_entries where sync_id = '${SHIFT_SYNC}';
  execute 'reset role';
  insert into probe6 values ('CONFOUND: rows CREW_B (no SEE_PAY, not the shift''s owner) can see', null, null, seen, null);

  perform set_config('request.jwt.claims', json_build_object('sub','${OWNER_ID}','role','authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into seen from time_entries where sync_id = '${SHIFT_SYNC}';
  execute 'reset role';
  insert into probe6 values ('CONFOUND: rows OWNER (holds SEE_PAY) can see', null, null, seen, null);
end $g6v$;

-- ---- REAL rule: CREW_B (not the shift's owner) tries to dispute CREW_A's shift.
--
-- The function call and the read-back of dispute_note are deliberately split
-- into separate statements (a single command takes one snapshot for its whole
-- execution -- see section 2's note). The read-back is ALSO deliberately taken
-- as OWNER, never CREW_B: CREW_B's own read is blind per the CONFOUND above,
-- so it could not tell "refused" from "landed but invisible to me".
${asClaim(CREW_B_ID)}
set local role authenticated;
insert into probe6_call select dispute_my_shift('${SHIFT_SYNC}', 'That is not my shift.');
reset role;
${asClaim(OWNER_ID)}
set local role authenticated;
insert into probe6 select 'CREW_B (not this shift''s employee) tries to dispute CREW_A''s shift',
  (select disputed from probe6_call),
  (select dispute_note from time_entries where sync_id = '${SHIFT_SYNC}'),
  null, null;
reset role;

-- ---- PLANTED FAILURE (layer 1 -- the RPC's own ownership check): drop the
-- profile_id match, so ANY company member can dispute ANY shift THROUGH
-- dispute_my_shift() itself -- the exact hole that would let one crew member
-- forge another's dispute. guard_time_entry_write_permission does NOT catch
-- this: dispute_my_shift is SECURITY DEFINER, so current_user inside its
-- UPDATE is the function's owner, never 'authenticated' -- proved live in the
-- probe that diagnosed this file (current_user = 'postgres' there, so the
-- trigger's own "current_user not in ('authenticated','anon')" returns early).
-- Read back as OWNER, never as CREW_B, or the confound above hides a real
-- forged write behind a null and makes this canary look toothless again.
create or replace function public.dispute_my_shift(shift_sync_id text, note text)
returns boolean language plpgsql security definer set search_path to 'public' as $inner$
declare touched int; clean text;
begin
    clean := left(btrim(coalesce(note, '')), 1000);
    if clean = '' then raise exception 'Say what was wrong with the hours.' using errcode = '23514'; end if;
    update time_entries t
       set correction_disputed_at = now(), dispute_note = clean,
           correction_seen_at = coalesce(t.correction_seen_at, now())
     where t.sync_id::text = shift_sync_id
       and t.company_id = public.current_company_id();
       -- BUG: the "exists (... e.profile_id = auth.uid())" ownership check is gone.
    get diagnostics touched = row_count;
    return touched > 0;
end;
$inner$;

${asClaim(CREW_B_ID)}
set local role authenticated;
delete from probe6_call;
insert into probe6_call select dispute_my_shift('${SHIFT_SYNC}', 'forged dispute');
reset role;
${asClaim(OWNER_ID)}
set local role authenticated;
insert into probe6 select 'PLANTED-BUG (layer 1, the RPC): ownership check removed, CREW_B forges a dispute via dispute_my_shift()',
  (select disputed from probe6_call),
  (select dispute_note from time_entries where sync_id = '${SHIFT_SYNC}'),
  null, null;
reset role;

-- undo the plant: restore the real, live definition, and the shift's dispute state
CREATE OR REPLACE FUNCTION public.dispute_my_shift(shift_sync_id text, note text)
 RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare touched int; clean text;
begin
    clean := left(btrim(coalesce(note, '')), 1000);
    if clean = '' then
        raise exception 'Say what was wrong with the hours.' using errcode = '23514';
    end if;
    update time_entries t
       set correction_disputed_at = now(),
           dispute_note = clean,
           correction_seen_at = coalesce(t.correction_seen_at, now())
     where t.sync_id::text = shift_sync_id
       and t.company_id = public.current_company_id()
       and exists (select 1 from employees e
                    where e.company_id = t.company_id
                      and e.sync_id::text = t.employee_sync_id
                      and e.profile_id = auth.uid());
    get diagnostics touched = row_count;
    return touched > 0;
end;
$function$;
update time_entries set correction_disputed_at = null, dispute_note = null
  where sync_id = '${SHIFT_SYNC}' and company_id = '${ZZ_BUSY}';

-- ---- PLANTED FAILURE (layer 2 -- the trigger): the OTHER route to the same
-- forged dispute is a raw PostgREST PATCH straight against time_entries,
-- skipping the RPC entirely. That path has no SECURITY DEFINER wrapper, so
-- current_user really is 'authenticated' there and guard_time_entry_write_
-- permission is live for it. CREW_B cannot be the subject here: the SAME
-- SEE_PAY confound measured above means CREW_B's raw UPDATE cannot even see
-- CREW_A's row to match it -- 0 rows touched, no error, proved live, true
-- whether the trigger is enabled or disabled, so that alone would prove
-- nothing about the trigger. The reachable subject is a caller who HAS
-- SEE_PAY but is not the shift's owner -- MGR_ID, exactly the profile
-- supabase_sec_time_entries_write_permission.sql's own preamble names as the
-- hole this trigger was written to close.
${asClaim(MGR_ID)}
set local role authenticated;
do $g6a$
declare n int;
begin
  begin
    update time_entries set dispute_note = 'direct forge, trigger enabled', correction_disputed_at = now()
      where sync_id = '${SHIFT_SYNC}' and company_id = '${ZZ_BUSY}';
    get diagnostics n = row_count;
    insert into probe6 values ('REAL RULE (layer 2, the trigger): MANAGER''s raw UPDATE of the dispute columns on someone else''s shift is refused', null, null, n, null);
  exception when others then
    insert into probe6 values ('REAL RULE (layer 2, the trigger): MANAGER''s raw UPDATE of the dispute columns on someone else''s shift is refused', null, null, 0, sqlerrm);
  end;
end $g6a$;
reset role;

alter table public.time_entries disable trigger time_entry_write_needs_permission;

${asClaim(MGR_ID)}
set local role authenticated;
do $g6b$
declare n int;
begin
  begin
    update time_entries set dispute_note = 'direct forge, trigger disabled', correction_disputed_at = now()
      where sync_id = '${SHIFT_SYNC}' and company_id = '${ZZ_BUSY}';
    get diagnostics n = row_count;
    insert into probe6 values ('PLANTED-BUG (layer 2, the trigger): with it disabled, MANAGER''s same raw UPDATE succeeds', null, null, n, null);
  exception when others then
    insert into probe6 values ('PLANTED-BUG (layer 2, the trigger): with it disabled, MANAGER''s same raw UPDATE succeeds', null, null, 0, sqlerrm);
  end;
end $g6b$;
reset role;

-- undo the plant: re-enable the real trigger, and put the shift's dispute
-- state back before the real-owner case below.
alter table public.time_entries enable trigger time_entry_write_needs_permission;
update time_entries set correction_disputed_at = null, dispute_note = null
  where sync_id = '${SHIFT_SYNC}' and company_id = '${ZZ_BUSY}';

-- ---- REAL rule: CREW_A (the actual owner of the shift) disputes it, for real.
${asClaim(CREW_A_ID)}
set local role authenticated;
delete from probe6_call;
insert into probe6_call select dispute_my_shift('${SHIFT_SYNC}', 'I actually started at noon, not 1pm.');
insert into probe6 select 'CREW_A (the real owner) disputes their own shift',
  (select disputed from probe6_call),
  (select dispute_note from time_entries where sync_id = '${SHIFT_SYNC}'),
  null, null;
reset role;

select case_name, disputed, dispute_note, touched, refused from probe6 order by case_name;
rollback;
`);
  const row6 = (name) => check6.find(r => r.case_name === name) || {};
  const confoundCrewB6 = row6("CONFOUND: rows CREW_B (no SEE_PAY, not the shift's owner) can see");
  const confoundOwner6 = row6("CONFOUND: rows OWNER (holds SEE_PAY) can see");
  ok("CONFOUND: CREW_B (no SEE_PAY, not the shift's owner) cannot see the row at all (0) -- the " +
     "reason a read-back through their eyes cannot be trusted, measured rather than assumed",
     Number(confoundCrewB6.touched) === 0, JSON.stringify(confoundCrewB6));
  ok("CONFOUND: OWNER (holds SEE_PAY) can see it (1) -- so a read-back through OWNER is trustworthy",
     Number(confoundOwner6.touched) === 1, JSON.stringify(confoundOwner6));
  ok("REAL RULE: a crew member cannot dispute a shift that is not their own (returns false, no row touched)",
     row6("CREW_B (not this shift's employee) tries to dispute CREW_A's shift").disputed === false &&
     !row6("CREW_B (not this shift's employee) tries to dispute CREW_A's shift").dispute_note,
     JSON.stringify(row6("CREW_B (not this shift's employee) tries to dispute CREW_A's shift")));
  ok("PLANTED FAILURE (layer 1, the RPC's own ownership check): with it removed, CREW_B's forged " +
     "dispute via dispute_my_shift() actually lands -- read back through OWNER, not the blind " +
     "CREW_B view (proves this check can fail)",
     row6("PLANTED-BUG (layer 1, the RPC): ownership check removed, CREW_B forges a dispute via dispute_my_shift()").disputed === true &&
     row6("PLANTED-BUG (layer 1, the RPC): ownership check removed, CREW_B forges a dispute via dispute_my_shift()").dispute_note === "forged dispute",
     JSON.stringify(row6("PLANTED-BUG (layer 1, the RPC): ownership check removed, CREW_B forges a dispute via dispute_my_shift()")));
  const layer2Real = row6("REAL RULE (layer 2, the trigger): MANAGER's raw UPDATE of the dispute columns on someone else's shift is refused");
  ok("REAL RULE (layer 2, the trigger): a MANAGER's raw UPDATE of the dispute columns on someone " +
     "else's shift is refused -- 0 rows touched AND an explicit error, not silence",
     Number(layer2Real.touched) === 0 &&
     typeof layer2Real.refused === "string" &&
     layer2Real.refused.includes("Only the person a shift belongs to"),
     JSON.stringify(layer2Real));
  const layer2Planted = row6("PLANTED-BUG (layer 2, the trigger): with it disabled, MANAGER's same raw UPDATE succeeds");
  ok("PLANTED FAILURE (layer 2, the trigger): with guard_time_entry_write_permission disabled, the " +
     "SAME MANAGER's raw UPDATE succeeds -- 1 row touched, no error (proves this check can fail too)",
     Number(layer2Planted.touched) === 1 && !layer2Planted.refused,
     JSON.stringify(layer2Planted));
  ok("REAL RULE: after restoring the real function, the shift's actual owner can dispute it and " +
     "the note lands",
     row6("CREW_A (the real owner) disputes their own shift").disputed === true &&
     row6("CREW_A (the real owner) disputes their own shift").dispute_note === "I actually started at noon, not 1pm.",
     JSON.stringify(row6("CREW_A (the real owner) disputes their own shift")));

  // =========================================================================
  console.log("\n7. THE TIME CLOCK -- approving hours needs APPROVE_TIME:");
  console.log("   (guard_time_entry_approval, the other half of the same patch section 3 checks.");
  console.log("    time_entries_update is `company_id = current_company_id()` only, exactly like");
  console.log("    jobs_update -- no APPROVE_TIME check in the policy -- so the same crew member");
  console.log("    whose hours these are could set approved_at directly, which is the exact");
  console.log("    column job_costing()'s labour_cost gates on (section 8). Started life here as");
  console.log("    a bare FINDING; it is an assertion now because a permission that is only");
  console.log("    described is a permission nobody is enforcing.)");

  const check7 = runSql(`
begin;
${FIXTURES}
insert into time_entries(company_id, sync_id, job_sync_id, employee_sync_id, started_at, ended_at, hourly_rate)
values ('${ZZ_BUSY}', '${SHIFT_SYNC}', '${JOB_ACCEPTED}', '${EMP_A_SYNC}',
        '2026-09-01T13:00:00Z', '2026-09-01T21:00:00Z', 22);

create temp table probe7(label text, touched int, refused text) on commit drop;
grant all on probe7 to authenticated;

do $g7$
declare n int;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub','${CREW_A_ID}','role','authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    update time_entries set approved_at = now(), approved_by = 'self'
      where sync_id = '${SHIFT_SYNC}' and company_id = '${ZZ_BUSY}';
    -- An UPDATE matching no rows raises nothing, so counting rows is the only
    -- way to tell "allowed" from "silently changed nothing". Reading a missing
    -- error as permission granted is what made the first version of this proof
    -- report a working guard as broken.
    get diagnostics n = row_count;
    execute 'reset role';
    insert into probe7 values ('crew self-approval', n, null);
  exception when others then
    execute 'reset role';
    insert into probe7 values ('crew self-approval', 0, SQLERRM);
  end;
end $g7$;
select touched, refused from probe7;
rollback;
`);
  // This began life as a FINDING: a crew member could stamp approved_at on
  // their own shift with no permission and no manager involved, and section
  // 8 then counted those hours as real labour cost exactly as if somebody had
  // signed them off. Manager correction and the dispute flow are both built on
  // approval meaning a second person looked, so self-approval turned that whole
  // record into decoration -- and the hours it certifies into wages.
  //
  // Closed by guard_time_entry_approval (supabase_approval_and_assignment_guard.sql).
  // It stays here as a check rather than a note, because a permission that is
  // only described is a permission nobody is enforcing.
  ok("a crew member cannot approve their own shift (needs APPROVE_TIME)",
    Number(check7[0]?.touched) === 0,
    `got ${JSON.stringify(check7[0])}`);

  // =========================================================================
  console.log("\n8. JOB COSTING -- labour_cost must count ONLY approved hours:");
  console.log("   (job_costing()'s labour subquery filters on t.approved_at is not null --");
  console.log("    unapproved hours must not inflate cost, and job_costing() also reports them");
  console.log("    back separately as unapproved_hours, which the office chase list reads)");
  console.log("");
  console.log("   job_costing()'s OUT list has already changed shape twice this month --");
  console.log("   quoted_material was appended (supabase_job_costing_material_budget.sql) and its");
  console.log("   scoping function became money_scope_company_id() (supabase_sec_job_costing_money_");
  console.log("   guard.sql) -- both AFTER a hand-typed copy of this exact plant last rotted");
  console.log("   (42P13: cannot change return type of existing function). So neither the plant nor");
  console.log("   the restore below hand-types job_costing()'s signature: both are built from");
  console.log("   pg_get_function_identity_arguments()/pg_get_function_result()/pg_get_functiondef()");
  console.log("   read off the LIVE function moments before either runs.");

  const APPROVED_RATE = 22, APPROVED_HOURS = 8; // 176.00
  const UNAPPROVED_RATE = 30, UNAPPROVED_HOURS = 5; // would add 150.00 if wrongly counted

  // Read job_costing()'s CURRENT identity (for DROP) and OUT shape (for a
  // plant that can never again go stale) before touching anything. This is a
  // separate, read-only round trip: the shape has to be known in JS before the
  // plant's SQL text can even be built.
  const meta8 = runSql(`
begin;
select
  pg_get_function_identity_arguments('public.job_costing(timestamptz,timestamptz)'::regprocedure) as identity_args,
  pg_get_function_arguments('public.job_costing(timestamptz,timestamptz)'::regprocedure) as full_args,
  pg_get_function_result('public.job_costing(timestamptz,timestamptz)'::regprocedure) as result_clause,
  pg_get_functiondef('public.job_costing(timestamptz,timestamptz)'::regprocedure) as full_def;
rollback;
`);
  // Two different argument strings, deliberately: pg_get_function_identity_arguments()
  // omits DEFAULT clauses (that is the whole point of "identity" -- defaults
  // are not part of what makes an overload distinct), which is exactly the
  // form DROP FUNCTION needs. pg_get_function_arguments() keeps them, which is
  // what the plant's CREATE needs -- every call site in this file, and the
  // real app, calls job_costing() with zero arguments, so a plant built from
  // the identity form alone would require two arguments and break on the
  // first call.
  const JC_IDENTITY_ARGS = meta8[0] && meta8[0].identity_args;
  const JC_FULL_ARGS = meta8[0] && meta8[0].full_args;
  const JC_RESULT_CLAUSE = meta8[0] && meta8[0].result_clause;
  const JC_LIVE_DEF = meta8[0] && meta8[0].full_def;
  if (!JC_IDENTITY_ARGS || !JC_FULL_ARGS || !JC_RESULT_CLAUSE || !JC_LIVE_DEF) {
    throw new Error(`could not read job_costing()'s live signature: ${JSON.stringify(meta8)}`);
  }
  const jcColumns = parseTableColumns(JC_RESULT_CLAUSE);
  if (!jcColumns.some(c => c.name === "job_sync_id") || !jcColumns.some(c => c.name === "labour_cost")) {
    throw new Error(`job_costing()'s OUT list no longer has job_sync_id/labour_cost: ${JC_RESULT_CLAUSE}`);
  }
  // Every column the plant does not need to fake is a typed null in its own
  // position, so the plant's shape always matches whatever is live right now,
  // no matter how many columns get added later.
  const jcPlantSelectList = jcColumns.map(c => {
    if (c.name === "job_sync_id") return "s.sync_id";
    if (c.name === "labour_cost") return "round(coalesce(l.cost,0)::numeric,2)";
    return `null::${c.type}`;
  }).join(",\n           ");

  const check8 = runSql(`
begin;
${FIXTURES}
insert into time_entries(company_id, sync_id, job_sync_id, employee_sync_id, started_at, ended_at, hourly_rate, approved_at, approved_by)
values ('${ZZ_BUSY}', '${SHIFT_SYNC}', '${JOB_ACCEPTED}', '${EMP_A_SYNC}',
        '2026-09-01T08:00:00Z', '2026-09-01T${8+APPROVED_HOURS}:00:00Z'::timestamptz, ${APPROVED_RATE},
        '2026-09-01T21:00:00Z', 'ZZ TEST Manager');
insert into time_entries(company_id, sync_id, job_sync_id, employee_sync_id, started_at, ended_at, hourly_rate)
values ('${ZZ_BUSY}', gen_random_uuid(), '${JOB_ACCEPTED}', '${EMP_B_SYNC}',
        '2026-09-02T08:00:00Z', '2026-09-02T${8+UNAPPROVED_HOURS}:00:00Z'::timestamptz, ${UNAPPROVED_RATE});
-- (second row's approved_at is left NULL: clocked out, never signed off)

create temp table probe8(case_name text, labour_cost numeric, hours_worked numeric, unapproved_hours numeric) on commit drop;
grant all on probe8 to authenticated;

${asClaim(OWNER_ID)}
set local role authenticated;
insert into probe8 select 'REAL RULE: labour_cost, hours_worked, unapproved_hours', labour_cost, hours_worked, unapproved_hours
  from job_costing() where job_sync_id = '${JOB_ACCEPTED}';
reset role;

-- ---- PLANTED FAILURE: a job_costing() that forgets the approved_at filter on
-- the labour subquery -- the exact bug that would let a crew member's
-- self-approval (section 7) or a plain clock-out with no review at all
-- inflate a job's cost and silently shrink its reported margin.
--
-- Drop-before-create, using the ARGS and OUT list read off the live function
-- moments ago -- not a hand-typed copy. job_costing()'s OUT list has already
-- changed shape twice this month, and CREATE OR REPLACE cannot change an
-- existing function's return type (42P13: "cannot change return type of
-- existing function") -- which is exactly what crashed this whole test file
-- before this fix. Every column this plant does not need to fake is a typed
-- null in its own position, so the shape always matches whatever is live.
drop function if exists public.job_costing(${JC_IDENTITY_ARGS});
create function public.job_costing(${JC_FULL_ARGS})
returns ${JC_RESULT_CLAUSE}
language sql stable security definer set search_path to public as $plant$
    with scope as (
        select j.sync_id
        from jobs j
        where j.company_id = money_scope_company_id() and j.deleted_at is null
    ),
    labour as (
        select t.job_sync_id,
               sum(extract(epoch from (t.ended_at - t.started_at)) / 3600.0 * t.hourly_rate) as cost -- BUG: no approved_at filter
        from time_entries t
        where t.company_id = money_scope_company_id() and t.deleted_at is null and t.ended_at is not null
        group by t.job_sync_id
    )
    select
           ${jcPlantSelectList}
    from scope s left join labour l on l.job_sync_id = s.sync_id;
$plant$;

${asClaim(OWNER_ID)}
set local role authenticated;
insert into probe8 select 'PLANTED-BUG: no approved_at filter', labour_cost, hours_worked, unapproved_hours
  from job_costing() where job_sync_id = '${JOB_ACCEPTED}';
reset role;

-- undo the plant: drop it and recreate EXACTLY the definition that was live
-- before this test touched anything -- captured verbatim via pg_get_functiondef
-- moments ago, never retyped by hand, so this restore cannot drift from
-- reality the way the hand-typed copy it replaces did.
drop function if exists public.job_costing(${JC_IDENTITY_ARGS});
${JC_LIVE_DEF};

${asClaim(OWNER_ID)}
set local role authenticated;
insert into probe8 select 'after restoring the real function', labour_cost, hours_worked, unapproved_hours
  from job_costing() where job_sync_id = '${JOB_ACCEPTED}';
reset role;

select case_name, labour_cost, hours_worked, unapproved_hours from probe8 order by case_name;
rollback;
`);
  const row8 = (name) => check8.find(r => r.case_name === name) || {};
  const approvedCost = APPROVED_RATE * APPROVED_HOURS; // 176.00
  const bothCost = approvedCost + UNAPPROVED_RATE * UNAPPROVED_HOURS; // 326.00 if wrongly counted
  ok("REAL RULE: labour_cost counts only the APPROVED shift (176.00), not the unapproved one",
     Number(row8("REAL RULE: labour_cost, hours_worked, unapproved_hours").labour_cost) === approvedCost,
     JSON.stringify(row8("REAL RULE: labour_cost, hours_worked, unapproved_hours")));
  ok("REAL RULE: hours_worked reports the approved 8 hours, unapproved_hours reports the other 5",
     Number(row8("REAL RULE: labour_cost, hours_worked, unapproved_hours").hours_worked) === APPROVED_HOURS &&
     Number(row8("REAL RULE: labour_cost, hours_worked, unapproved_hours").unapproved_hours) === UNAPPROVED_HOURS,
     JSON.stringify(row8("REAL RULE: labour_cost, hours_worked, unapproved_hours")));
  ok("PLANTED FAILURE: without the approved_at filter, labour_cost wrongly includes the " +
     "unapproved shift too (326.00 instead of 176.00) (proves this check can fail)",
     Number(row8("PLANTED-BUG: no approved_at filter").labour_cost) === bothCost,
     JSON.stringify(row8("PLANTED-BUG: no approved_at filter")));
  ok("REAL RULE: after restoring the real function, labour_cost is back to counting only " +
     "approved hours",
     Number(row8("after restoring the real function").labour_cost) === approvedCost,
     JSON.stringify(row8("after restoring the real function")));

  // =========================================================================
  console.log("\nFinally: prove nothing survived.");
  const after = runSql(`
    select
      (select count(*) from auth.users where id in ('${OWNER_ID}','${MGR_ID}','${CREW_A_ID}','${CREW_B_ID}','${SALES_ID}')) as synthetic_users,
      (select count(*) from profiles where id in ('${OWNER_ID}','${MGR_ID}','${CREW_A_ID}','${CREW_B_ID}','${SALES_ID}')) as synthetic_profiles,
      (select count(*) from employees where sync_id in ('${EMP_A_SYNC}','${EMP_B_SYNC}')) as synthetic_employees,
      (select count(*) from time_entries where sync_id = '${SHIFT_SYNC}' or employee_sync_id in ('${EMP_A_SYNC}','${EMP_B_SYNC}')) as synthetic_time_entries,
      (select assigned_employee_sync_id from jobs where sync_id = '${JOB_ACCEPTED}') as job_accepted_assignment,
      (select proname from pg_proc where pronamespace='public'::regnamespace and proname='has_permission'
         and position('MANAGER' in prosrc) > 0) as has_permission_still_real,
      (select proname from pg_proc where pronamespace='public'::regnamespace and proname='job_costing'
         and position('money_scope_company_id' in prosrc) > 0) as job_costing_still_guarded,
      (select proname from pg_proc where pronamespace='public'::regnamespace and proname='dispute_my_shift'
         and position('profile_id = auth.uid()' in prosrc) > 0) as dispute_still_scoped,
      (select count(*) from pg_trigger where tgname = 'time_entry_needs_a_person'
         and tgrelid = 'public.time_entries'::regclass and not tgisinternal) as needs_a_person_trigger_present,
      (select count(*) from pg_trigger where tgname = 'job_assignment_needs_permission'
         and tgrelid = 'public.jobs'::regclass and not tgisinternal) as assignment_trigger_present,
      (select tgenabled from pg_trigger where tgname = 'time_entry_write_needs_permission'
         and tgrelid = 'public.time_entries'::regclass and not tgisinternal) as write_permission_trigger_enabled,
      pg_get_functiondef('public.job_costing(timestamptz,timestamptz)'::regprocedure) as job_costing_full_def_now,
      (select count(*) from companies where id = '${ZZ_BUSY}') as zz_busy_still_present;
  `);
  const a = after[0] || {};
  ok("no synthetic auth user survived", Number(a.synthetic_users) === 0, `got ${a.synthetic_users}`);
  ok("no synthetic profile survived", Number(a.synthetic_profiles) === 0, `got ${a.synthetic_profiles}`);
  ok("no synthetic employee survived", Number(a.synthetic_employees) === 0, `got ${a.synthetic_employees}`);
  ok("no synthetic time_entries row survived", Number(a.synthetic_time_entries) === 0, `got ${a.synthetic_time_entries}`);
  ok("JOB_ACCEPTED's assignment rolled back to unset (section 3's successful MANAGER " +
     "reassignment did not persist)",
     a.job_accepted_assignment === null, `got ${JSON.stringify(a.job_accepted_assignment)}`);
  ok("has_permission() is back to its real, MANAGER-aware definition, not a planted one",
     a.has_permission_still_real === "has_permission", `got ${JSON.stringify(a.has_permission_still_real)}`);
  ok("job_costing() is back to its real, guarded definition, not the planted one",
     a.job_costing_still_guarded === "job_costing", `got ${JSON.stringify(a.job_costing_still_guarded)}`);
  ok("dispute_my_shift() is back to its real, ownership-scoped definition, not the planted one",
     a.dispute_still_scoped === "dispute_my_shift", `got ${JSON.stringify(a.dispute_still_scoped)}`);
  ok("time_entry_needs_a_person trigger is present (the drop-and-restore in section 4 left it in place)",
     Number(a.needs_a_person_trigger_present) === 1, `got ${a.needs_a_person_trigger_present}`);
  ok("job_assignment_needs_permission trigger is present (the drop-and-restore in section 3 " +
     "left it in place)",
     Number(a.assignment_trigger_present) === 1, `got ${a.assignment_trigger_present}`);
  ok("time_entry_write_needs_permission trigger is present AND enabled (section 6's disable/" +
     "enable dance around the layer-2 canary did not leak past rollback)",
     a.write_permission_trigger_enabled === "O", `got ${JSON.stringify(a.write_permission_trigger_enabled)}`);
  ok("job_costing() is restored, byte-for-byte, to the exact definition captured live before " +
     "section 8 planted anything (the drop-before-create using pg_get_functiondef did not drift, " +
     "and did not merely look right inside the rolled-back transaction)",
     a.job_costing_full_def_now === JC_LIVE_DEF,
     `definitions differ (captured ${JC_LIVE_DEF.length} chars, now ${(a.job_costing_full_def_now || "").length} chars)`);
  ok("ZZ_BUSY itself is untouched (not deleted)", Number(a.zz_busy_still_present) === 1,
     `got ${a.zz_busy_still_present}`);

  console.log(`\n${checked - failed} of ${checked} checks passed`);
  if (failed) process.exit(1);
}

main().catch(e => { console.error("company-crew-golden-path test could not run:", e.message); process.exit(2); });
