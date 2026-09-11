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
  console.log("\n3. SCHEDULING -- FINDING, not a planted-and-restored check:");
  console.log("   jobs_update carries `company_id = current_company_id()` and NOTHING else --");
  console.log("   no role or permission test at all (confirmed by reading pg_policies live).");
  console.log("   supabase_views_and_admin_patch.sql already found and partly fixed this for");
  console.log("   customer_name/address/phone/customer_id (protect_customer_identity trigger),");
  console.log("   but assigned_employee_sync_id -- the column scheduling actually writes -- has");
  console.log("   no equivalent guard. A plain CREW member, with no SCHEDULE_AND_ASSIGN");
  console.log("   permission at all, can reassign any job in the company by writing the column");
  console.log("   directly. This is demonstrated below as a real, RLS-scoped write -- not a");
  console.log("   rule this file invents and then proves can fail, because no such rule exists");
  console.log("   to plant against. It is reported here, not fixed: fixing RLS/triggers is");
  console.log("   outside this task's file ownership.");

  const check3 = runSql(`
begin;
${FIXTURES}
${asClaim(CREW_A_ID)}
set local role authenticated;
update jobs set assigned_employee_sync_id = '${EMP_A_SYNC}'
  where company_id = '${ZZ_BUSY}' and sync_id = '${JOB_ACCEPTED}';
reset role;
select (select assigned_employee_sync_id from jobs where sync_id = '${JOB_ACCEPTED}') as now_assigned;
rollback;
`);
  console.log(`  FINDING  a plain CREW member (no SCHEDULE_AND_ASSIGN permission) reassigned ` +
    `job ${JOB_ACCEPTED} to themselves via a direct UPDATE -- assigned_employee_sync_id is now ` +
    `${JSON.stringify(check3[0]?.now_assigned)}. Scheduling has no server-side permission gate; ` +
    `the app hiding the button is the only thing standing between a crew phone and reassigning ` +
    `any job in the company.`);

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
  console.log("    time_entries_update itself is company-wide with no such check)");

  const check6 = runSql(`
begin;
${FIXTURES}
insert into time_entries(company_id, sync_id, job_sync_id, employee_sync_id, started_at, ended_at, hourly_rate)
values ('${ZZ_BUSY}', '${SHIFT_SYNC}', '${JOB_ACCEPTED}', '${EMP_A_SYNC}',
        '2026-09-01T13:00:00Z', '2026-09-01T21:00:00Z', 22);

create temp table probe6(case_name text, disputed boolean, dispute_note text, ok_result boolean) on commit drop;
grant all on probe6 to authenticated;
create temp table probe6_call(disputed boolean) on commit drop;
grant all on probe6_call to authenticated;

-- ---- REAL rule: CREW_B (not the shift's owner) tries to dispute CREW_A's shift.
--
-- The function call and the read-back of dispute_note are deliberately split
-- into separate statements. A single command takes one snapshot for its whole
-- execution, so calling dispute_my_shift() (which does its own UPDATE) and
-- reading time_entries back in a SIBLING expression of the very same SELECT
-- would still see the pre-call row -- looking like the write never landed
-- even when it genuinely did, or vice versa. Two statements, two snapshots,
-- an honest read.
${asClaim(CREW_B_ID)}
set local role authenticated;
insert into probe6_call select dispute_my_shift('${SHIFT_SYNC}', 'That is not my shift.');
insert into probe6 select 'CREW_B (not this shift''s employee) tries to dispute CREW_A''s shift',
  (select disputed from probe6_call),
  (select dispute_note from time_entries where sync_id = '${SHIFT_SYNC}'),
  null;
reset role;

-- ---- PLANTED FAILURE: drop the profile_id match, so ANY company member can
-- dispute ANY shift -- the exact hole that would let one crew member forge
-- another's dispute.
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
insert into probe6 select 'PLANTED-BUG: ownership check removed, CREW_B disputes CREW_A''s shift',
  (select disputed from probe6_call),
  (select dispute_note from time_entries where sync_id = '${SHIFT_SYNC}'),
  null;
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

-- ---- REAL rule: CREW_A (the actual owner of the shift) disputes it, for real.
${asClaim(CREW_A_ID)}
set local role authenticated;
delete from probe6_call;
insert into probe6_call select dispute_my_shift('${SHIFT_SYNC}', 'I actually started at noon, not 1pm.');
insert into probe6 select 'CREW_A (the real owner) disputes their own shift',
  (select disputed from probe6_call),
  (select dispute_note from time_entries where sync_id = '${SHIFT_SYNC}'),
  null;
reset role;

select case_name, disputed, dispute_note, ok_result from probe6 order by case_name;
rollback;
`);
  const row6 = (name) => check6.find(r => r.case_name === name) || {};
  ok("REAL RULE: a crew member cannot dispute a shift that is not their own (returns false, no row touched)",
     row6("CREW_B (not this shift's employee) tries to dispute CREW_A's shift").disputed === false &&
     !row6("CREW_B (not this shift's employee) tries to dispute CREW_A's shift").dispute_note,
     JSON.stringify(row6("CREW_B (not this shift's employee) tries to dispute CREW_A's shift")));
  ok("PLANTED FAILURE: with the ownership check removed, CREW_B wrongly forges a dispute on " +
     "CREW_A's shift (proves this check can fail)",
     row6("PLANTED-BUG: ownership check removed, CREW_B disputes CREW_A's shift").disputed === true &&
     row6("PLANTED-BUG: ownership check removed, CREW_B disputes CREW_A's shift").dispute_note === "forged dispute",
     JSON.stringify(row6("PLANTED-BUG: ownership check removed, CREW_B disputes CREW_A's shift")));
  ok("REAL RULE: after restoring the real function, the shift's actual owner can dispute it and " +
     "the note lands",
     row6("CREW_A (the real owner) disputes their own shift").disputed === true &&
     row6("CREW_A (the real owner) disputes their own shift").dispute_note === "I actually started at noon, not 1pm.",
     JSON.stringify(row6("CREW_A (the real owner) disputes their own shift")));

  // =========================================================================
  console.log("\n7. THE TIME CLOCK -- FINDING: nothing stops a crew member approving their own hours:");
  console.log("   time_entries_update is `company_id = current_company_id()` only, exactly like");
  console.log("   jobs_update in section 3 -- no APPROVE_TIME check, and no trigger analogous to");
  console.log("   protect_customer_identity guards approved_at/approved_by. So the same crew");
  console.log("   member whose hours these are can set approved_at directly, which is the exact");
  console.log("   column job_costing()'s labour_cost gates on (section 8). Demonstrated as a");
  console.log("   real write, not invented and proven-failable, because no guard exists to plant");
  console.log("   against.");

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

  const APPROVED_RATE = 22, APPROVED_HOURS = 8; // 176.00
  const UNAPPROVED_RATE = 30, UNAPPROVED_HOURS = 5; // would add 150.00 if wrongly counted

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
create or replace function public.job_costing(from_date timestamptz default null, to_date timestamptz default null)
 returns table(job_sync_id text, customer_name text, status text, quoted numeric, collected numeric,
               material_cost numeric, labour_cost numeric, other_cost numeric, total_cost numeric,
               projected_profit numeric, margin_percent numeric, cash_position numeric,
               costs_are_sell_prices boolean, hours_worked numeric, unapproved_hours numeric)
 language sql stable security definer set search_path to 'public'
as $inner$
    with scope as (
        select j.sync_id, j.customer_name, j.status::text, j.contract_total
        from jobs j where j.company_id = money_scope_company_id() and j.deleted_at is null
    ),
    labour as (
        select t.job_sync_id,
               sum(extract(epoch from (t.ended_at - t.started_at)) / 3600.0 * t.hourly_rate) as cost, -- BUG: no approved_at filter
               sum(extract(epoch from (t.ended_at - t.started_at)) / 3600.0) as hours
        from time_entries t
        where t.company_id = money_scope_company_id() and t.deleted_at is null and t.ended_at is not null
        group by t.job_sync_id
    )
    select s.sync_id, s.customer_name, s.status, round(coalesce(s.contract_total,0)::numeric,2),
           0::numeric, 0::numeric, round(coalesce(l.cost,0)::numeric,2), 0::numeric, 0::numeric,
           0::numeric, null::numeric, 0::numeric, false, round(coalesce(l.hours,0)::numeric,2), 0::numeric
    from scope s left join labour l on l.job_sync_id = s.sync_id;
$inner$;

${asClaim(OWNER_ID)}
set local role authenticated;
insert into probe8 select 'PLANTED-BUG: no approved_at filter', labour_cost, hours_worked, unapproved_hours
  from job_costing() where job_sync_id = '${JOB_ACCEPTED}';
reset role;

-- undo the plant: restore the real, live definition (supabase_money_report_guard.sql)
CREATE OR REPLACE FUNCTION public.job_costing(from_date timestamp with time zone DEFAULT NULL::timestamp with time zone, to_date timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(job_sync_id text, customer_name text, status text, quoted numeric, collected numeric, material_cost numeric, labour_cost numeric, other_cost numeric, total_cost numeric, projected_profit numeric, margin_percent numeric, cash_position numeric, costs_are_sell_prices boolean, hours_worked numeric, unapproved_hours numeric)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
    with scope as (
        select j.sync_id, j.customer_name, j.status::text, j.contract_total
        from jobs j
        where j.company_id = money_scope_company_id()
          and j.deleted_at is null
          and (from_date is null or j.created_at >= from_date)
          and (to_date   is null or j.created_at <= to_date)
    ),
    money as (
        select p.job_sync_id, sum(p.amount) as collected
        from payment_records p
        where p.company_id = money_scope_company_id() and p.deleted_at is null
        group by p.job_sync_id
    ),
    materials as (
        select i.job_sync_id,
               sum(i.quantity * coalesce(i.supplier_unit_price, i.unit_price)) as cost,
               sum(i.quantity * i.unit_price) as sell,
               bool_and(i.supplier_unit_price is null) as all_fallback
        from estimate_line_items i
        where i.company_id = money_scope_company_id() and i.deleted_at is null
        group by i.job_sync_id
    ),
    labour as (
        select t.job_sync_id,
               sum(case when t.approved_at is not null
                        then extract(epoch from (t.ended_at - t.started_at)) / 3600.0 * t.hourly_rate
                        else 0 end) as cost,
               sum(case when t.approved_at is not null
                        then extract(epoch from (t.ended_at - t.started_at)) / 3600.0
                        else 0 end) as hours,
               sum(case when t.approved_at is null and t.ended_at is not null
                        then extract(epoch from (t.ended_at - t.started_at)) / 3600.0
                        else 0 end) as pending_hours
        from time_entries t
        where t.company_id = money_scope_company_id() and t.deleted_at is null
          and t.ended_at is not null
        group by t.job_sync_id
    ),
    extras as (
        select c.job_sync_id, sum(c.additional_cost) as total
        from change_orders c
        where c.company_id = money_scope_company_id() and c.deleted_at is null
        group by c.job_sync_id
    ),
    other as (
        select e.job_sync_id, sum(e.amount) as cost
        from expenses e
        where e.company_id = money_scope_company_id() and e.deleted_at is null
        group by e.job_sync_id
    ),
    figured as (
        select s.sync_id, s.customer_name, s.status,
               coalesce(s.contract_total,
                        coalesce(m.sell, 0) + coalesce(x.total, 0)) as quoted,
               coalesce(mo.collected, 0) as collected,
               coalesce(m.cost, 0)  as material_cost,
               coalesce(l.cost, 0)  as labour_cost,
               coalesce(o.cost, 0)  as other_cost,
               coalesce(m.all_fallback, false) as all_fallback,
               coalesce(l.hours, 0) as hours,
               coalesce(l.pending_hours, 0) as pending
        from scope s
        left join money     mo on mo.job_sync_id = s.sync_id
        left join materials m  on m.job_sync_id  = s.sync_id
        left join labour    l  on l.job_sync_id  = s.sync_id
        left join extras    x  on x.job_sync_id  = s.sync_id
        left join other     o  on o.job_sync_id  = s.sync_id
    )
    select f.sync_id, f.customer_name, f.status,
           round(f.quoted::numeric, 2),
           round(f.collected::numeric, 2),
           round(f.material_cost::numeric, 2),
           round(f.labour_cost::numeric, 2),
           round(f.other_cost::numeric, 2),
           round((f.material_cost + f.labour_cost + f.other_cost)::numeric, 2),
           round((f.quoted - f.material_cost - f.labour_cost - f.other_cost)::numeric, 2),
           case when f.quoted > 0
                then round(((f.quoted - f.material_cost - f.labour_cost - f.other_cost)
                            / f.quoted * 100)::numeric, 1) end,
           round((f.collected - f.material_cost - f.labour_cost - f.other_cost)::numeric, 2),
           f.all_fallback,
           round(f.hours::numeric, 2),
           round(f.pending::numeric, 2)
    from figured f
    order by f.quoted desc;
$function$;

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
      (select count(*) from auth.users where id in ('${OWNER_ID}','${MGR_ID}','${CREW_A_ID}','${CREW_B_ID}')) as synthetic_users,
      (select count(*) from profiles where id in ('${OWNER_ID}','${MGR_ID}','${CREW_A_ID}','${CREW_B_ID}')) as synthetic_profiles,
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
      (select count(*) from companies where id = '${ZZ_BUSY}') as zz_busy_still_present;
  `);
  const a = after[0] || {};
  ok("no synthetic auth user survived", Number(a.synthetic_users) === 0, `got ${a.synthetic_users}`);
  ok("no synthetic profile survived", Number(a.synthetic_profiles) === 0, `got ${a.synthetic_profiles}`);
  ok("no synthetic employee survived", Number(a.synthetic_employees) === 0, `got ${a.synthetic_employees}`);
  ok("no synthetic time_entries row survived", Number(a.synthetic_time_entries) === 0, `got ${a.synthetic_time_entries}`);
  ok("JOB_ACCEPTED's assignment rolled back to unset (the section-3 finding's write did not persist)",
     a.job_accepted_assignment === null, `got ${JSON.stringify(a.job_accepted_assignment)}`);
  ok("has_permission() is back to its real, MANAGER-aware definition, not a planted one",
     a.has_permission_still_real === "has_permission", `got ${JSON.stringify(a.has_permission_still_real)}`);
  ok("job_costing() is back to its real, guarded definition, not the planted one",
     a.job_costing_still_guarded === "job_costing", `got ${JSON.stringify(a.job_costing_still_guarded)}`);
  ok("dispute_my_shift() is back to its real, ownership-scoped definition, not the planted one",
     a.dispute_still_scoped === "dispute_my_shift", `got ${JSON.stringify(a.dispute_still_scoped)}`);
  ok("time_entry_needs_a_person trigger is present (the drop-and-restore in section 4 left it in place)",
     Number(a.needs_a_person_trigger_present) === 1, `got ${a.needs_a_person_trigger_present}`);
  ok("ZZ_BUSY itself is untouched (not deleted)", Number(a.zz_busy_still_present) === 1,
     `got ${a.zz_busy_still_present}`);

  console.log(`\n${checked - failed} of ${checked} checks passed`);
  if (failed) process.exit(1);
}

main().catch(e => { console.error("company-crew-golden-path test could not run:", e.message); process.exit(2); });
