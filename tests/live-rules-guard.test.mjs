// Five rules went live today, each proved once by hand in a rolled-back
// transaction. None of them was guarded by anything that would notice if it
// broke -- and one of them (payroll vs. job money) already broke once today,
// in a way that would have taken every salesperson's phone dark
// (supabase_can_see_pay_restored.sql tells the story). This file is that
// guard.
//
// Everything here runs inside `begin; ... rollback;`, via the same Supabase
// CLI technique tests/money-report-guard.test.mjs and tests/golden-path.test.mjs
// use (`supabase db query --linked`) -- not a service_role key, the CLI's own
// authenticated project session, used only to run plain SQL. Every check:
//
//   1. plants the exact failure the rule exists to catch -- by temporarily
//      replacing the guarding function/trigger with a broken version, or
//      dropping it -- runs the probe, and asserts it now gives the WRONG
//      answer (proving this test can actually fail), then explicitly recreates
//      the real, correct definition (not a savepoint rollback -- an INSERT
//      made after a SAVEPOINT is undone by ROLLBACK TO that savepoint too,
//      which would erase the very evidence being captured),
//   2. runs the REAL rule and asserts the right answer,
//   3. and the whole thing ends in ROLLBACK, so nothing -- including the
//      planted breakage or any of its side effects -- survives.
//
// Check 4 (the quote approval phone gate) is deliberately thin here: the
// end-to-end behaviour is already covered by tests/golden-path.test.mjs
// against the live edge function. This file only covers the database half
// that test doesn't reach -- touch_updated_at() treating the three gate
// columns as bookkeeping.
//
//   node tests/live-rules-guard.test.mjs

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT = "newcrgafcptspmapacrx";

// Real, live identifiers -- discovered read-only from the live database, not
// invented. All belong to one real company so cross-checks (SALES attached to
// it, CREW's own employee row, etc.) are internally consistent.
const CO      = "aba5b097-afc4-48dd-9851-b50200d5e8f4"; // real company
const OWNER   = "7bf38947-24cf-4e79-9af0-6100d04b166b";
// These two were labelled by job title and the job titles moved. 518fde2b
// was called MANAGER and is a FOREMAN; dabdbf64 was called CREW and is now a
// MANAGER, which grants both money permissions. So the check below spent an
// unknown length of time asserting that a manager cannot see money, which is
// false, and it read exactly like a leak. The same drift broke the job
// costing gate on 11 September.
//
// Named for the property the checks actually depend on, and asserted before
// anything is concluded from them. A promotion now produces a sentence
// saying the fixture drifted rather than a security alarm.
const NO_MONEY = "518fde2b-e689-4164-b900-85d8c7ca9748"; // must lack SEE_MONEY and SEE_PAY
const HAS_MONEY = "dabdbf64-8c89-4ec4-89c5-b33430462069"; // must hold both
const SALES   = "f7e1c214-cdd0-492a-84b4-02392b264690"; // live, but company_id is null
const OTHER_COMPANY_EMPLOYEE = "11111111-1111-4111-8111-111111111211"; // belongs to a DIFFERENT company
const OWN_EMPLOYEE = "c75a354a-a357-47d5-8368-c2a379928733"; // this company's own employee row
// Fixtures this suite OWNS, created by supabase_rules_guard_fixtures.sql.
// These used to be three real jobs in the real company. Two of them were
// retired as test data on 10 September and the whole suite went red -- not
// because a rule broke, but because the furniture moved. A guard that fails
// whenever the business changes is one people learn to ignore.
const COMPLETED_JOB = "44444444-0000-4000-8000-000000000001"; // ACCEPTED, sold, production may start
const DRAFT_JOB = "44444444-0000-4000-8000-000000000002"; // DRAFT, never approved
// A SECOND, untouched DRAFT job for check 4's "real rule" section. now() is
// the TRANSACTION timestamp -- frozen for the whole transaction, not the
// statement -- so once the planted-bug section above has bumped a row's
// updated_at to this transaction's now(), any later, correct write to that
// SAME row also sets updated_at to that identical now() and looks like no
// change happened even though the trigger ran perfectly. Using a job the
// planted section never touched keeps the "real rule" before/after
// comparison honest.
const DRAFT_JOB_2 = "44444444-0000-4000-8000-000000000003"; // DRAFT, and never written to by this suite
// The three historical blank-employee rows this database actually has.
const HISTORICAL_BLANK_SHIFTS = [
  "52129e05-62f7-49b0-9574-334689a5e4c1",
  "b4f56be7-fcd1-4bb2-979a-833197720ce7",
  "b2697031-f4e1-43a6-92cb-7a347dfb9acc",
];

let failed = 0, checked = 0;
const ok = (name, cond, detail = "") => {
  checked++;
  if (cond) { console.log(`  ok    ${name}`); return; }
  failed++;
  console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
};

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), "live-rules-"));
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

const asClaim = (sub) => `select set_config('request.jwt.claims', json_build_object('sub','${sub}','role','authenticated')::text, true);`;

async function main() {
  // =========================================================================
  console.log("\n1. Payroll is separate from job money:");
  console.log("   (can_see_pay() answers job money, can_see_employee_pay() answers payroll --");
  console.log("    this is the exact split that broke once today, see supabase_can_see_pay_restored.sql)");

  const check1 = runSql(`
begin;

-- The live SALES profile has no company. Attach it to the real company for
-- the duration of this transaction only.
update profiles set company_id = '${CO}' where id = '${SALES}';

create temp table probe1(who text, can_pay boolean, can_emp_pay boolean,
                          employees_n bigint, jobs_n bigint, ar_rows bigint) on commit drop;
grant all on probe1 to authenticated;

-- ---- PLANTED FAILURE: recreate today's actual bug. can_see_employee_pay()
-- briefly answered SEE_MONEY (the same permission behind can_see_pay()), which
-- would hand every salesperson their colleagues' pay. Reproduce it, watch a
-- salesperson wrongly pass the payroll check, then undo.
create or replace function public.can_see_employee_pay()
returns boolean language sql stable security definer set search_path to 'public' as $inner$
  select coalesce(public.has_permission('SEE_MONEY'), false);
$inner$;
${asClaim(SALES)}
set local role authenticated;
insert into probe1(who, can_pay, can_emp_pay)
  select 'SALES-WITH-PLANTED-BUG', can_see_pay(), can_see_employee_pay();
reset role;
-- undo the plant: restore the real, fixed definition (supabase_can_see_pay_restored.sql)
-- so every check below this line runs against the actual live rule.
create or replace function public.can_see_employee_pay()
returns boolean language sql stable security definer set search_path to 'public' as $inner$
  select coalesce(public.has_permission('SEE_PAY'), false);
$inner$;

-- ---- REAL rule, current (fixed) definitions ----
${asClaim(OWNER)}
set local role authenticated;
insert into probe1 select 'OWNER', can_see_pay(), can_see_employee_pay(),
  (select count(*) from employees), (select count(*) from jobs), (select count(*) from ar_aging());
reset role;

${asClaim(SALES)}
set local role authenticated;
insert into probe1 select 'SALES', can_see_pay(), can_see_employee_pay(),
  (select count(*) from employees), (select count(*) from jobs), (select count(*) from ar_aging());
reset role;

${asClaim(NO_MONEY)}
set local role authenticated;
insert into probe1 select 'NO_MONEY', can_see_pay(), can_see_employee_pay(),
  (select count(*) from employees), (select count(*) from jobs), (select count(*) from ar_aging());
reset role;

select * from probe1 order by who;
rollback;
`);
  const row1 = (who) => check1.find(r => r.who === who) || {};
  ok("PLANTED FAILURE: the reproduced bug wrongly answers SALES payroll = true (proves this check can fail)",
     row1("SALES-WITH-PLANTED-BUG").can_emp_pay === true,
     `got ${JSON.stringify(row1("SALES-WITH-PLANTED-BUG"))}`);
  ok("SALES sees job money (can_see_pay = true)", row1("SALES").can_pay === true);
  ok("SALES does NOT see payroll (can_see_employee_pay = false)", row1("SALES").can_emp_pay === false,
     `got ${JSON.stringify(row1("SALES"))}`);
  ok("SALES reads zero rows from employees", Number(row1("SALES").employees_n) === 0,
     `got ${row1("SALES").employees_n}`);
  ok("SALES still reads jobs", Number(row1("SALES").jobs_n) > 0, `got ${row1("SALES").jobs_n}`);
  ok("SALES can still call ar_aging()", row1("SALES").ar_rows !== null && row1("SALES").ar_rows !== undefined,
     `got ${JSON.stringify(row1("SALES"))}`);
  ok("OWNER sees both job money and payroll",
     row1("OWNER").can_pay === true && row1("OWNER").can_emp_pay === true, `got ${JSON.stringify(row1("OWNER"))}`);
  ok("an account without SEE_MONEY or SEE_PAY sees neither job money nor payroll",
     row1("NO_MONEY").can_pay === false && row1("NO_MONEY").can_emp_pay === false, `got ${JSON.stringify(row1("NO_MONEY"))}`);

  // =========================================================================
  console.log("\n2. A shift must name one of our own people:");

  const check2 = runSql(`
begin;
create temp table probe2(case_name text, ok_result boolean, detail text) on commit drop;
grant all on probe2 to authenticated;

-- ---- PLANTED FAILURE: disable the guard entirely and show a blank-employee
-- shift now gets through -- this is exactly the bug the trigger exists to stop.
drop trigger if exists time_entry_needs_a_person on public.time_entries;
do $inner$
begin
  begin
    insert into time_entries(company_id, sync_id, job_sync_id, employee_sync_id, started_at)
    values ('${CO}', gen_random_uuid(), '${DRAFT_JOB}', '', now());
    insert into probe2 values ('PLANTED-BUG: blank employee (guard disabled)', true, 'insert succeeded -- guard is not enforcing');
  exception when others then
    insert into probe2 values ('PLANTED-BUG: blank employee (guard disabled)', false, sqlerrm);
  end;
end $inner$;
-- undo the plant: restore the real trigger (supabase_shift_names_our_person.sql)
create trigger time_entry_needs_a_person
    before insert or update on public.time_entries
    for each row execute function public.time_entry_needs_a_person();

-- ---- REAL rule ----
do $inner$
begin
  begin
    insert into time_entries(company_id, sync_id, job_sync_id, employee_sync_id, started_at)
    values ('${CO}', gen_random_uuid(), '${DRAFT_JOB}', '', now());
    insert into probe2 values ('blank employee is refused', false, 'insert succeeded, should have raised');
  exception when others then
    insert into probe2 values ('blank employee is refused', true, sqlerrm);
  end;

  begin
    insert into time_entries(company_id, sync_id, job_sync_id, employee_sync_id, started_at)
    values ('${CO}', gen_random_uuid(), '${DRAFT_JOB}', '${OTHER_COMPANY_EMPLOYEE}', now());
    insert into probe2 values ('different-company employee is refused', false, 'insert succeeded, should have raised');
  exception when others then
    insert into probe2 values ('different-company employee is refused', true, sqlerrm);
  end;

  begin
    insert into time_entries(company_id, sync_id, job_sync_id, employee_sync_id, started_at)
    values ('${CO}', gen_random_uuid(), '${DRAFT_JOB}', '${OWN_EMPLOYEE}', now());
    insert into probe2 values ('this company''s own employee is accepted', true, 'inserted ok');
  exception when others then
    insert into probe2 values ('this company''s own employee is accepted', false, sqlerrm);
  end;

  begin
    update time_entries set notes = coalesce(notes, '') || '' where sync_id = '${HISTORICAL_BLANK_SHIFTS[0]}'::uuid;
    update time_entries set notes = coalesce(notes, '') || '' where sync_id = '${HISTORICAL_BLANK_SHIFTS[1]}'::uuid;
    update time_entries set notes = coalesce(notes, '') || '' where sync_id = '${HISTORICAL_BLANK_SHIFTS[2]}'::uuid;
    insert into probe2 values ('the 3 historical blank rows stay editable', true, 'updates ok');
  exception when others then
    insert into probe2 values ('the 3 historical blank rows stay editable', false, sqlerrm);
  end;
end $inner$;

select * from probe2 order by case_name;
rollback;
`);
  const row2 = (name) => check2.find(r => r.case_name === name) || {};
  ok("PLANTED FAILURE: with the trigger dropped, a blank-employee shift wrongly gets through (proves this check can fail)",
     row2("PLANTED-BUG: blank employee (guard disabled)").ok_result === true,
     `got ${JSON.stringify(row2("PLANTED-BUG: blank employee (guard disabled)"))}`);
  ok("blank employee is refused", row2("blank employee is refused").ok_result === true,
     row2("blank employee is refused").detail);
  ok("an employee from a different company is refused", row2("different-company employee is refused").ok_result === true,
     row2("different-company employee is refused").detail);
  ok("this company's own employee is accepted", row2("this company's own employee is accepted").ok_result === true,
     row2("this company's own employee is accepted").detail);
  ok("the 3 historical blank rows stay editable", row2("the 3 historical blank rows stay editable").ok_result === true,
     row2("the 3 historical blank rows stay editable").detail);

  // =========================================================================
  console.log("\n3. Production stages (set_production_stage):");

  const check3 = runSql(`
begin;
create temp table probe3(case_name text, ok_result boolean, detail text) on commit drop;
grant all on probe3 to authenticated;

-- ---- PLANTED FAILURE: remove the "must be approved" gate and show a DRAFT
-- job (never sold) wrongly starts production.
create or replace function public.set_production_stage(job_sid text, next_stage text)
returns boolean language plpgsql security definer set search_path to 'public' as $inner$
declare
    co uuid := public.current_company_id();
    current_stage production_stage;
    wanted production_stage;
    job_status text;
begin
    if not (coalesce(public.has_permission('RECORD_FIELD_WORK'), false)
            or coalesce(public.has_permission('SCHEDULE_AND_ASSIGN'), false)) then
        raise exception 'You cannot move jobs through the build.' using errcode = '42501';
    end if;
    wanted := next_stage::production_stage;
    select j.production_stage, j.status::text into current_stage, job_status
      from jobs j where j.company_id = co and j.sync_id::text = job_sid and j.deleted_at is null;
    -- THE APPROVED-STATUS CHECK IS DELIBERATELY MISSING HERE.
    if current_stage is not distinct from wanted then return false; end if;
    update jobs set production_stage = wanted where company_id = co and sync_id::text = job_sid;
    insert into job_stage_events (company_id, job_sync_id, stage, entered_by, left_stage)
    values (co, job_sid::uuid, wanted, auth.uid(), current_stage);
    return true;
end;
$inner$;
${asClaim(NO_MONEY)}
set local role authenticated;
do $inner$
begin
  begin
    perform set_production_stage('${DRAFT_JOB}', 'MATERIALS');
    insert into probe3 values ('PLANTED-BUG: unapproved job starts production', true, 'wrongly succeeded, no exception');
  exception when others then
    insert into probe3 values ('PLANTED-BUG: unapproved job starts production', false, sqlerrm);
  end;
end $inner$;
reset role;
-- undo the plant: restore the real function (supabase_production_stages.sql)
create or replace function public.set_production_stage(job_sid text, next_stage text)
returns boolean language plpgsql security definer set search_path to 'public' as $inner$
declare
    co uuid := public.current_company_id();
    current_stage production_stage;
    wanted production_stage;
    job_status text;
begin
    if co is null then
        raise exception 'Sign in first.' using errcode = '42501';
    end if;
    if not (coalesce(public.has_permission('RECORD_FIELD_WORK'), false)
            or coalesce(public.has_permission('SCHEDULE_AND_ASSIGN'), false)) then
        raise exception 'You cannot move jobs through the build.' using errcode = '42501';
    end if;
    begin
        wanted := next_stage::production_stage;
    exception when others then
        raise exception 'There is no build stage called %.', next_stage using errcode = '22023';
    end;
    select j.production_stage, j.status::text into current_stage, job_status
      from jobs j where j.company_id = co and j.sync_id::text = job_sid and j.deleted_at is null;
    if job_status is null then
        raise exception 'That job is not on this company.' using errcode = '23503';
    end if;
    if job_status not in ('ACCEPTED', 'COMPLETED') then
        raise exception 'This job has not been approved yet, so the build cannot start.'
            using errcode = '23514';
    end if;
    if current_stage is not distinct from wanted then
        return false;
    end if;
    update jobs set production_stage = wanted where company_id = co and sync_id::text = job_sid;
    insert into job_stage_events (company_id, job_sync_id, stage, entered_by, left_stage)
    values (co, job_sid::uuid, wanted, auth.uid(), current_stage);
    return true;
end;
$inner$;

-- ---- REAL rule ----
${asClaim(NO_MONEY)}
set local role authenticated;
do $inner$
declare moved boolean; again boolean; events_before int; events_after int;
begin
  select count(*) into events_before from job_stage_events where job_sync_id = '${COMPLETED_JOB}';

  begin
    moved := set_production_stage('${COMPLETED_JOB}', 'MATERIALS');
    insert into probe3 values ('a crew account can move a sold (COMPLETED) job', moved is true, 'returned ' || moved);
  exception when others then
    insert into probe3 values ('a crew account can move a sold (COMPLETED) job', false, sqlerrm);
  end;

  begin
    again := set_production_stage('${COMPLETED_JOB}', 'MATERIALS');
    select count(*) into events_after from job_stage_events where job_sync_id = '${COMPLETED_JOB}';
    insert into probe3 values ('moving to the same stage returns false and writes no 2nd event',
      again is false and events_after = events_before + 1,
      format('again=%s events_before=%s events_after=%s', again, events_before, events_after));
  exception when others then
    insert into probe3 values ('moving to the same stage returns false and writes no 2nd event', false, sqlerrm);
  end;

  begin
    perform set_production_stage('${DRAFT_JOB}', 'MATERIALS');
    insert into probe3 values ('an unapproved (DRAFT) job raises', false, 'wrongly succeeded, no exception');
  exception when others then
    insert into probe3 values ('an unapproved (DRAFT) job raises', true, sqlerrm);
  end;

  begin
    perform set_production_stage('${COMPLETED_JOB}', 'NOT_A_REAL_STAGE');
    insert into probe3 values ('an unknown stage name raises', false, 'wrongly succeeded, no exception');
  exception when others then
    insert into probe3 values ('an unknown stage name raises', true, sqlerrm);
  end;
end $inner$;
reset role;

${asClaim(SALES)}
update profiles set company_id = '${CO}' where id = '${SALES}';
set local role authenticated;
do $inner$
begin
  begin
    perform set_production_stage('${COMPLETED_JOB}', 'DIG');
    insert into probe3 values ('an account with neither RECORD_FIELD_WORK nor SCHEDULE_AND_ASSIGN raises',
      false, 'wrongly succeeded, no exception');
  exception when others then
    insert into probe3 values ('an account with neither RECORD_FIELD_WORK nor SCHEDULE_AND_ASSIGN raises', true, sqlerrm);
  end;
end $inner$;
reset role;

select * from probe3 order by case_name;
rollback;
`);
  const row3 = (name) => check3.find(r => r.case_name === name) || {};
  ok("PLANTED FAILURE: with the approved-status gate removed, a DRAFT job wrongly starts production (proves this check can fail)",
     row3("PLANTED-BUG: unapproved job starts production").ok_result === true,
     `got ${JSON.stringify(row3("PLANTED-BUG: unapproved job starts production"))}`);
  ok("a crew account can move a sold (COMPLETED) job", row3("a crew account can move a sold (COMPLETED) job").ok_result === true,
     row3("a crew account can move a sold (COMPLETED) job").detail);
  ok("moving to the same stage returns false and writes no 2nd event",
     row3("moving to the same stage returns false and writes no 2nd event").ok_result === true,
     row3("moving to the same stage returns false and writes no 2nd event").detail);
  ok("an unapproved (DRAFT) job raises", row3("an unapproved (DRAFT) job raises").ok_result === true,
     row3("an unapproved (DRAFT) job raises").detail);
  ok("an unknown stage name raises", row3("an unknown stage name raises").ok_result === true,
     row3("an unknown stage name raises").detail);
  ok("an account with neither RECORD_FIELD_WORK nor SCHEDULE_AND_ASSIGN raises",
     row3("an account with neither RECORD_FIELD_WORK nor SCHEDULE_AND_ASSIGN raises").ok_result === true,
     row3("an account with neither RECORD_FIELD_WORK nor SCHEDULE_AND_ASSIGN raises").detail);

  // =========================================================================
  console.log("\n4. The quote approval phone gate -- the database half:");
  console.log("   (touch_updated_at() must treat quote_phone_attempts, quote_phone_locked_until and");
  console.log("    quote_approved_without_phone_check as bookkeeping, not an edit -- the app-level gate");
  console.log("    itself is covered end to end by tests/golden-path.test.mjs)");

  const check4 = runSql(`
begin;
create temp table probe4(case_name text, ok_result boolean, detail text) on commit drop;
grant all on probe4 to authenticated;

-- ---- PLANTED FAILURE: restore the OLDER touch_updated_at() (before the three
-- gate columns were added to its quiet list) and show a failed phone guess
-- wrongly moves jobs.updated_at.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $inner$
declare
    quiet constant text[] := array[
        'updated_at', 'amount_paid', 'refunded_amount', 'payment_status', 'payments_from_processor',
        'contract_total', 'quote_viewed_at', 'site_lat', 'site_lon', 'last_seen_at'
    ];
begin
    if (to_jsonb(new) - quiet) is distinct from (to_jsonb(old) - quiet) then
        new.updated_at = now();
    else
        new.updated_at = old.updated_at;
    end if;
    return new;
end $inner$;

do $inner$
declare before_ts timestamptz; after_ts timestamptz;
begin
  select updated_at into before_ts from jobs where sync_id::text = '${DRAFT_JOB}';
  update jobs set quote_phone_attempts = quote_phone_attempts + 1 where sync_id::text = '${DRAFT_JOB}';
  select updated_at into after_ts from jobs where sync_id::text = '${DRAFT_JOB}';
  insert into probe4 values ('PLANTED-BUG: old quiet list lets a wrong phone guess move updated_at',
    after_ts is distinct from before_ts, format('before=%s after=%s', before_ts, after_ts));
end $inner$;
-- undo the plant: restore the real function (supabase_quiet_quote_gate_columns.sql)
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $inner$
declare
    quiet constant text[] := array[
        'updated_at',
        'amount_paid', 'refunded_amount', 'payment_status', 'payments_from_processor',
        'contract_total',
        'quote_viewed_at', 'site_lat', 'site_lon',
        'last_seen_at',
        'priced_by', 'priced_at', 'pricing_engine_version', 'wizard_step',
        'quote_phone_attempts', 'quote_phone_locked_until',
        'quote_approved_without_phone_check'
    ];
begin
    if (to_jsonb(new) - quiet) is distinct from (to_jsonb(old) - quiet) then
        new.updated_at = now();
    else
        new.updated_at = old.updated_at;
    end if;
    return new;
end $inner$;

-- ---- REAL rule ----
-- Uses DRAFT_JOB_2, not DRAFT_JOB: now() is the TRANSACTION timestamp, frozen
-- for the whole transaction. The planted-bug section above already bumped
-- DRAFT_JOB's updated_at to this transaction's now(). Any later write to that
-- SAME row -- even a correctly-quiet one, even a real edit -- would also set
-- updated_at to that identical now() and be indistinguishable from "nothing
-- changed", even though the trigger ran perfectly both times. A job the
-- planted section never touched keeps the before/after comparison honest.
do $inner$
declare before_ts timestamptz; after_real timestamptz; after_quiet timestamptz;
begin
  select updated_at into before_ts from jobs where sync_id::text = '${DRAFT_JOB_2}';

  update jobs set customer_name = coalesce(customer_name, '') || ' '
   where sync_id::text = '${DRAFT_JOB_2}';
  select updated_at into after_real from jobs where sync_id::text = '${DRAFT_JOB_2}';
  insert into probe4 values ('CANARY: a real column edit still moves updated_at (proves the trigger runs at all)',
    after_real is distinct from before_ts, format('before=%s after_real_edit=%s', before_ts, after_real));

  update jobs set quote_phone_attempts = quote_phone_attempts + 1,
                  quote_phone_locked_until = now() + interval '1 minute',
                  quote_approved_without_phone_check = true
   where sync_id::text = '${DRAFT_JOB_2}';
  select updated_at into after_quiet from jobs where sync_id::text = '${DRAFT_JOB_2}';
  insert into probe4 values ('writing only the 3 gate columns does not move updated_at',
    after_quiet is not distinct from after_real, format('after_real=%s after_gate_write=%s', after_real, after_quiet));
end $inner$;

select * from probe4 order by case_name;
rollback;
`);
  const row4 = (name) => check4.find(r => r.case_name === name) || {};
  ok("PLANTED FAILURE: the pre-fix touch_updated_at wrongly moves updated_at on a failed phone guess (proves this check can fail)",
     row4("PLANTED-BUG: old quiet list lets a wrong phone guess move updated_at").ok_result === true,
     row4("PLANTED-BUG: old quiet list lets a wrong phone guess move updated_at").detail);
  ok("writing only the 3 gate columns does not move jobs.updated_at",
     row4("writing only the 3 gate columns does not move updated_at").ok_result === true,
     row4("writing only the 3 gate columns does not move updated_at").detail);
  ok("CANARY: a real column edit still moves updated_at (mechanism actually runs)",
     row4("CANARY: a real column edit still moves updated_at (proves the trigger runs at all)").ok_result === true,
     row4("CANARY: a real column edit still moves updated_at (proves the trigger runs at all)").detail);

  // =========================================================================
  console.log("\n5. The shift dispute (dispute_my_shift / acknowledge_my_shift):");

  const check5 = runSql(`
begin;
create temp table probe5(case_name text, ok_result boolean, detail text) on commit drop;
grant all on probe5 to authenticated;

-- Wire the CREW profile to a real employee row and give that employee one
-- shift, so "your own shift" and "somebody else's shift" both have a real
-- row to test against. This is undone by the final ROLLBACK.
update employees set profile_id = '${NO_MONEY}' where sync_id::text = '${OWN_EMPLOYEE}';
insert into time_entries (company_id, sync_id, job_sync_id, employee_sync_id, started_at)
values ('${CO}', 'aaaaaaaa-0000-0000-0000-0000000000f1', '${COMPLETED_JOB}', '${OWN_EMPLOYEE}', now() - interval '2 hours');

-- ---- PLANTED FAILURE: drop the "must be the named employee" ownership check
-- and show a stranger can dispute somebody else's shift.
create or replace function public.dispute_my_shift(shift_sync_id text, note text)
returns boolean language plpgsql security definer set search_path to 'public' as $inner$
declare touched int; clean text;
begin
    clean := left(btrim(coalesce(note, '')), 1000);
    if clean = '' then
        raise exception 'Say what was wrong with the hours.' using errcode = '23514';
    end if;
    update time_entries t
       set correction_disputed_at = now(), dispute_note = clean,
           correction_seen_at = coalesce(t.correction_seen_at, now())
     where t.sync_id::text = shift_sync_id
       and t.company_id = public.current_company_id();
       -- THE "and this is MY shift" CHECK IS DELIBERATELY MISSING HERE.
    get diagnostics touched = row_count;
    return touched > 0;
end;
$inner$;
${asClaim(OWNER)}
set local role authenticated;
do $inner$
begin
  insert into probe5 values ('PLANTED-BUG: a stranger (OWNER, not the crew member) disputes somebody else''s shift',
    dispute_my_shift('aaaaaaaa-0000-0000-0000-0000000000f1', 'not my shift but the check is gone'), 'called ok');
end $inner$;
reset role;
-- undo the plant: restore the real function (supabase_shift_dispute.sql)
create or replace function public.dispute_my_shift(shift_sync_id text, note text)
returns boolean language plpgsql security definer set search_path to 'public' as $inner$
declare touched int; clean text;
begin
    clean := left(btrim(coalesce(note, '')), 1000);
    if clean = '' then
        raise exception 'Say what was wrong with the hours.' using errcode = '23514';
    end if;
    update time_entries t
       set correction_disputed_at = now(), dispute_note = clean,
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
$inner$;

-- ---- REAL rule ----
${asClaim(NO_MONEY)}
set local role authenticated;
do $inner$
begin
  begin
    perform dispute_my_shift('aaaaaaaa-0000-0000-0000-0000000000f1', '');
    insert into probe5 values ('an empty note is refused', false, 'wrongly succeeded, no exception');
  exception when others then
    insert into probe5 values ('an empty note is refused', true, sqlerrm);
  end;

  insert into probe5 values ('works on your own shift',
    dispute_my_shift('aaaaaaaa-0000-0000-0000-0000000000f1', 'the hours are wrong, I left at 3pm'), 'called ok');
  insert into probe5 values ('acknowledge_my_shift also works on your own shift',
    acknowledge_my_shift('aaaaaaaa-0000-0000-0000-0000000000f1'), 'called ok');
end $inner$;
reset role;

${asClaim(OWNER)}
set local role authenticated;
do $inner$
begin
  insert into probe5 values ('dispute_my_shift returns false for somebody else''s shift',
    dispute_my_shift('aaaaaaaa-0000-0000-0000-0000000000f1', 'trying to dispute a shift that is not mine') = false, 'called ok');
  insert into probe5 values ('acknowledge_my_shift returns false for somebody else''s shift',
    acknowledge_my_shift('aaaaaaaa-0000-0000-0000-0000000000f1') = false, 'called ok');
end $inner$;
reset role;

select * from probe5 order by case_name;
rollback;
`);
  const row5 = (name) => check5.find(r => r.case_name === name) || {};
  ok("PLANTED FAILURE: with the ownership check removed, a stranger wrongly disputes somebody else's shift (proves this check can fail)",
     row5("PLANTED-BUG: a stranger (OWNER, not the crew member) disputes somebody else's shift").ok_result === true,
     JSON.stringify(row5("PLANTED-BUG: a stranger (OWNER, not the crew member) disputes somebody else's shift")));
  ok("an empty note is refused", row5("an empty note is refused").ok_result === true,
     row5("an empty note is refused").detail);
  ok("dispute_my_shift works on your own shift", row5("works on your own shift").ok_result === true);
  ok("acknowledge_my_shift also works on your own shift",
     row5("acknowledge_my_shift also works on your own shift").ok_result === true);
  ok("dispute_my_shift returns false for somebody else's shift",
     row5("dispute_my_shift returns false for somebody else's shift").ok_result === true);
  ok("acknowledge_my_shift returns false for somebody else's shift",
     row5("acknowledge_my_shift returns false for somebody else's shift").ok_result === true);

  // =========================================================================
  console.log("\nFinally: prove nothing was left behind.");
  const after = runSql(`
    select
      (select company_id from profiles where id = '${SALES}') as sales_company_id,
      (select count(*) from employees where profile_id = '${NO_MONEY}') as crew_linked_employees,
      (select count(*) from time_entries where sync_id::text = 'aaaaaaaa-0000-0000-0000-0000000000f1') as probe_shift_rows,
      (select count(*) from time_entries where company_id = '${CO}' and employee_sync_id = '${OTHER_COMPANY_EMPLOYEE}') as leaked_foreign_shifts,
      (select production_stage::text from jobs where sync_id::text = '${COMPLETED_JOB}') as completed_job_stage,
      (select status::text from jobs where sync_id::text = '${DRAFT_JOB}') as draft_job_status,
      (select quote_phone_attempts from jobs where sync_id::text = '${DRAFT_JOB}') as draft_job_phone_attempts,
      (select count(*) from job_stage_events where job_sync_id = '${COMPLETED_JOB}') as stage_events_for_completed_job;
  `);
  const a = after[0] || {};
  ok("SALES profile's company_id is null again (attach-to-company rolled back)",
     a.sales_company_id === null, `got ${JSON.stringify(a)}`);
  ok("the no-money profile is not linked to any employee row (link rolled back)",
     Number(a.crew_linked_employees) === 0, `got ${a.crew_linked_employees}`);
  ok("the probe shift row is gone", Number(a.probe_shift_rows) === 0, `got ${a.probe_shift_rows}`);
  ok("no shift attributes to the other company's employee", Number(a.leaked_foreign_shifts) === 0,
     `got ${a.leaked_foreign_shifts}`);
  ok("the COMPLETED job's production_stage is null again (stage move rolled back)",
     a.completed_job_stage === null, `got ${JSON.stringify(a.completed_job_stage)}`);
  ok("the DRAFT job is still DRAFT", a.draft_job_status === "DRAFT", `got ${a.draft_job_status}`);
  ok("the DRAFT job's phone-attempt counter is back to 0", Number(a.draft_job_phone_attempts) === 0,
     `got ${a.draft_job_phone_attempts}`);
  ok("no stage event survived for the COMPLETED job", Number(a.stage_events_for_completed_job) === 0,
     `got ${a.stage_events_for_completed_job}`);

  console.log(`\n${checked - failed} of ${checked} checks passed`);
  if (failed) process.exit(1);
}

main().catch(e => { console.error("could not run:", e.message); process.exit(2); });
