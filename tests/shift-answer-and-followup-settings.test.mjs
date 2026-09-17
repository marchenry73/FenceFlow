// Two live rules that live-rules-guard.test.mjs and follow-ups.test.mjs
// don't reach:
//
//   1. my_shift_answer(shift_sync_id) -- supabase_shift_answer_readback.sql.
//      live-rules-guard.test.mjs proves dispute_my_shift/acknowledge_my_shift
//      write correctly and stay scoped to your own shift, but nothing reads
//      the answer BACK. This is the function the phone polls to show
//      "accepted" / "disputed" / nothing yet, and to show it only to the
//      person the shift belongs to.
//
//   2. set_follow_up_settings(jsonb) -- supabase_followups_settings.sql.
//      follow-ups.test.mjs is a pure-logic file against dueFollowUp() etc.,
//      not the DB half. This is the one write path into follow_up_settings,
//      gated by EDIT_CATALOG_AND_SETTINGS, and it is the thing the office
//      settings screen calls -- untested until now.
//
// Same technique as tests/live-rules-guard.test.mjs: everything runs inside
// begin/rollback via `supabase db query --linked`, using a synthetic
// no-permission subject created inside the same transaction (never a real
// person's role, which drifted three times in that file already), and every
// check that claims a rule works also proves a positive control first.
//
//   node tests/shift-answer-and-followup-settings.test.mjs

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT = "newcrgafcptspmapacrx";

// Same real company + fixtures live-rules-guard.test.mjs already uses.
const CO = "aba5b097-afc4-48dd-9851-b50200d5e8f4";
const OWNER = "7bf38947-24cf-4e79-9af0-6100d04b166b"; // has EDIT_CATALOG_AND_SETTINGS
const OWN_EMPLOYEE = "c75a354a-a357-47d5-8368-c2a379928733"; // this company's own employee row
const COMPLETED_JOB = "44444444-0000-4000-8000-000000000001";

// A synthetic subject created and destroyed inside the probe's own
// transaction -- never a real person, so a promotion elsewhere can't turn
// this into a false alarm the way HAS_MONEY/NO_MONEY drifted in
// live-rules-guard.test.mjs.
const CREW_SUBJECT = "99999999-0000-4000-8000-0000000000bb";
const STRANGER_SUBJECT = "99999999-0000-4000-8000-0000000000cc";

const SUBJECT_SETUP = `
do $mk$
declare co uuid;
begin
  select company_id into co from profiles where id = '${OWNER}';
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  values ('${CREW_SUBJECT}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'zz-shift-answer-probe@example.invalid', 'x', now(), now(), now())
  on conflict (id) do nothing;
  insert into profiles (id, role, company_id, full_name)
  values ('${CREW_SUBJECT}', 'CREW', co, 'ZZ PROBE crew subject')
  on conflict (id) do update set role = 'CREW', company_id = excluded.company_id;

  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  values ('${STRANGER_SUBJECT}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'zz-shift-answer-stranger@example.invalid', 'x', now(), now(), now())
  on conflict (id) do nothing;
  insert into profiles (id, role, company_id, full_name)
  values ('${STRANGER_SUBJECT}', 'CREW', co, 'ZZ PROBE stranger subject')
  on conflict (id) do update set role = 'CREW', company_id = excluded.company_id;
end $mk$;`;

let failed = 0, checked = 0;
const ok = (name, cond, detail = "") => {
  checked++;
  if (cond) { console.log(`  ok    ${name}`); return; }
  failed++;
  console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
};

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), "shift-answer-"));
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
  console.log("\n1. my_shift_answer -- the shift-dispute readback:");

  const check1 = runSql(`
begin;
${SUBJECT_SETUP}
create temp table probe1(case_name text, answer text, note text) on commit drop;
grant all on probe1 to authenticated;

-- Wire the two synthetic subjects: CREW_SUBJECT owns the shift, STRANGER
-- does not. Both belong to the same company (only ownership should gate
-- the read).
update employees set profile_id = '${CREW_SUBJECT}' where sync_id::text = '${OWN_EMPLOYEE}';
insert into time_entries (company_id, sync_id, job_sync_id, employee_sync_id, started_at, corrected_at)
values ('${CO}', 'aaaaaaaa-0000-0000-0000-0000000000f9', '${COMPLETED_JOB}', '${OWN_EMPLOYEE}',
        now() - interval '2 hours', now() - interval '1 hour');

${asClaim(CREW_SUBJECT)}
set local role authenticated;
insert into probe1 select 'before any answer, my_shift_answer is null',
  (my_shift_answer('aaaaaaaa-0000-0000-0000-0000000000f9')->>'answer'), null;
reset role;

-- ---- PLANTED FAILURE: recreate a version of my_shift_answer that forgets
-- the "and this shift belongs to me" ownership check, and show a stranger
-- can read someone else's dispute note.
create or replace function public.my_shift_answer(shift_sync_id text)
returns jsonb language sql stable security definer set search_path to 'public' as $inner$
    select case
        when t.correction_disputed_at is not null and t.correction_disputed_at >= coalesce(t.corrected_at, '-infinity')
          then jsonb_build_object('answer','disputed','note',t.dispute_note)
        when t.correction_seen_at is not null and t.correction_seen_at >= coalesce(t.corrected_at, '-infinity')
          then jsonb_build_object('answer','accepted')
        end
      from time_entries t
     where t.sync_id::text = shift_sync_id
       and t.company_id = public.current_company_id();
       -- THE "and this is MY shift" CHECK IS DELIBERATELY MISSING HERE.
$inner$;

${asClaim(CREW_SUBJECT)}
set local role authenticated;
select dispute_my_shift('aaaaaaaa-0000-0000-0000-0000000000f9', 'the hours are wrong, secret detail 42');
reset role;

${asClaim(STRANGER_SUBJECT)}
set local role authenticated;
insert into probe1 select 'PLANTED-BUG: a stranger reads the dispute answer/note',
  (my_shift_answer('aaaaaaaa-0000-0000-0000-0000000000f9')->>'answer'),
  (my_shift_answer('aaaaaaaa-0000-0000-0000-0000000000f9')->>'note');
reset role;

-- undo the plant: restore the real, correct definition
create or replace function public.my_shift_answer(shift_sync_id text)
returns jsonb language sql stable security definer set search_path to 'public' as $inner$
    select case
        when t.correction_disputed_at is not null and t.correction_disputed_at >= coalesce(t.corrected_at, '-infinity')
          then jsonb_build_object('answer','disputed','note',t.dispute_note)
        when t.correction_seen_at is not null and t.correction_seen_at >= coalesce(t.corrected_at, '-infinity')
          then jsonb_build_object('answer','accepted')
        end
      from time_entries t
     where t.sync_id::text = shift_sync_id
       and t.company_id = public.current_company_id()
       and exists (select 1 from employees e
                    where e.company_id = t.company_id
                      and e.sync_id::text = t.employee_sync_id
                      and e.profile_id = auth.uid());
$inner$;

-- ---- REAL rule ----
${asClaim(STRANGER_SUBJECT)}
set local role authenticated;
insert into probe1 select 'a stranger gets null, not the dispute', (my_shift_answer('aaaaaaaa-0000-0000-0000-0000000000f9')->>'answer'),
  (my_shift_answer('aaaaaaaa-0000-0000-0000-0000000000f9')->>'note');
reset role;

${asClaim(CREW_SUBJECT)}
set local role authenticated;
insert into probe1 select 'the owner reads back their own dispute answer/note',
  (my_shift_answer('aaaaaaaa-0000-0000-0000-0000000000f9')->>'answer'),
  (my_shift_answer('aaaaaaaa-0000-0000-0000-0000000000f9')->>'note');
reset role;

select * from probe1 order by case_name;
rollback;
`);
  const row1 = (name) => check1.find(r => r.case_name === name) || {};
  ok("before any answer, my_shift_answer is null", row1("before any answer, my_shift_answer is null").answer === null,
     JSON.stringify(row1("before any answer, my_shift_answer is null")));
  ok("PLANTED FAILURE: with ownership removed, a stranger wrongly reads someone else's dispute note (proves this check can fail)",
     row1("PLANTED-BUG: a stranger reads the dispute answer/note").answer === "disputed" &&
     row1("PLANTED-BUG: a stranger reads the dispute answer/note").note === "the hours are wrong, secret detail 42",
     JSON.stringify(row1("PLANTED-BUG: a stranger reads the dispute answer/note")));
  ok("a stranger gets null, not the dispute", row1("a stranger gets null, not the dispute").answer === null,
     JSON.stringify(row1("a stranger gets null, not the dispute")));
  ok("the owner reads back their own dispute answer and note",
     row1("the owner reads back their own dispute answer/note").answer === "disputed" &&
     row1("the owner reads back their own dispute answer/note").note === "the hours are wrong, secret detail 42",
     JSON.stringify(row1("the owner reads back their own dispute answer/note")));

  // =========================================================================
  console.log("\n2. set_follow_up_settings -- the DB-side write for the follow-up settings RPC:");

  const check2 = runSql(`
begin;
${SUBJECT_SETUP}
create temp table probe2(case_name text, ok_result boolean, detail text) on commit drop;
grant all on probe2 to authenticated;

-- ---- positive control: OWNER has EDIT_CATALOG_AND_SETTINGS and must succeed ----
${asClaim(OWNER)}
set local role authenticated;
select set_follow_up_settings(jsonb_build_object(
  'enabled', true, 'quote_sent_no_view_enabled', true, 'quote_sent_no_view_days', 5,
  'daily_cap', 7, 'timezone', 'America/Denver'));
insert into probe2 select 'OWNER can write settings', true, 'called ok';
reset role;

insert into probe2
  select 'the row landed with the values sent, scoped to this company', enabled = true and quote_sent_no_view_days = 5
    and daily_cap = 7 and timezone = 'America/Denver', 'row=' || row_to_json(f)::text
  from follow_up_settings f where f.company_id = '${CO}';

-- ---- CANARY: an update (not just an insert) is honoured, not silently ignored ----
${asClaim(OWNER)}
set local role authenticated;
select set_follow_up_settings(jsonb_build_object('enabled', false, 'daily_cap', 3));
reset role;
insert into probe2
  select 'CANARY: a second call updates rather than being ignored', enabled = false and daily_cap = 3, 'row=' || row_to_json(f)::text
  from follow_up_settings f where f.company_id = '${CO}';

-- ---- REAL rule: a CREW subject without EDIT_CATALOG_AND_SETTINGS is refused ----
${asClaim(CREW_SUBJECT)}
set local role authenticated;
do $inner$
begin
  begin
    perform set_follow_up_settings(jsonb_build_object('enabled', true));
    insert into probe2 values ('a subject without EDIT_CATALOG_AND_SETTINGS is refused', false, 'wrongly succeeded, no exception');
  exception when others then
    insert into probe2 values ('a subject without EDIT_CATALOG_AND_SETTINGS is refused', true, sqlerrm);
  end;
end $inner$;
reset role;

-- ---- PLANTED FAILURE: recreate a version of the guard that only checks
-- sign-in, not the permission, and show the same CREW subject now gets through.
create or replace function public.set_follow_up_settings(p jsonb)
returns void language plpgsql security definer set search_path to 'public' as $inner$
declare co uuid := public.current_company_id();
begin
    if co is null then
        raise exception 'Sign in first.' using errcode = '42501';
    end if;
    -- THE has_permission('EDIT_CATALOG_AND_SETTINGS') CHECK IS DELIBERATELY MISSING HERE.
    insert into public.follow_up_settings (company_id, enabled, updated_at, updated_by)
    values (co, coalesce((p->>'enabled')::boolean, false), now(), auth.uid())
    on conflict (company_id) do update set enabled = excluded.enabled, updated_at = now(), updated_by = excluded.updated_by;
end;
$inner$;
${asClaim(CREW_SUBJECT)}
set local role authenticated;
do $inner$
begin
  begin
    perform set_follow_up_settings(jsonb_build_object('enabled', true));
    insert into probe2 values ('PLANTED-BUG: without the permission check, the same crew subject is let through', true, 'wrongly succeeded');
  exception when others then
    insert into probe2 values ('PLANTED-BUG: without the permission check, the same crew subject is let through', false, sqlerrm);
  end;
end $inner$;
reset role;
-- undo the plant: restore the real definition
create or replace function public.set_follow_up_settings(p jsonb)
returns void language plpgsql security definer set search_path to 'public' as $inner$
declare co uuid := public.current_company_id();
begin
    if co is null then
        raise exception 'Sign in first.' using errcode = '42501';
    end if;
    if not coalesce(public.has_permission('EDIT_CATALOG_AND_SETTINGS'), false) then
        raise exception 'You cannot change follow-up settings.' using errcode = '42501';
    end if;
    insert into public.follow_up_settings (
        company_id, enabled, new_lead_not_contacted_enabled, quote_sent_no_view_enabled,
        quote_viewed_not_approved_enabled, approved_no_deposit_enabled,
        new_lead_not_contacted_hours, quote_sent_no_view_days, quote_viewed_not_approved_days,
        approved_no_deposit_days, quiet_hours_start, quiet_hours_end, timezone, daily_cap,
        updated_at, updated_by
    )
    values (
        co, coalesce((p->>'enabled')::boolean, false),
        coalesce((p->>'new_lead_not_contacted_enabled')::boolean, false),
        coalesce((p->>'quote_sent_no_view_enabled')::boolean, false),
        coalesce((p->>'quote_viewed_not_approved_enabled')::boolean, false),
        coalesce((p->>'approved_no_deposit_enabled')::boolean, false),
        coalesce((p->>'new_lead_not_contacted_hours')::integer, 4),
        coalesce((p->>'quote_sent_no_view_days')::integer, 2),
        coalesce((p->>'quote_viewed_not_approved_days')::integer, 3),
        coalesce((p->>'approved_no_deposit_days')::integer, 2),
        coalesce((p->>'quiet_hours_start')::smallint, 21),
        coalesce((p->>'quiet_hours_end')::smallint, 8),
        coalesce(p->>'timezone', 'America/New_York'),
        coalesce((p->>'daily_cap')::integer, 25),
        now(), auth.uid()
    )
    on conflict (company_id) do update set
        enabled = excluded.enabled,
        new_lead_not_contacted_enabled = excluded.new_lead_not_contacted_enabled,
        quote_sent_no_view_enabled = excluded.quote_sent_no_view_enabled,
        quote_viewed_not_approved_enabled = excluded.quote_viewed_not_approved_enabled,
        approved_no_deposit_enabled = excluded.approved_no_deposit_enabled,
        new_lead_not_contacted_hours = excluded.new_lead_not_contacted_hours,
        quote_sent_no_view_days = excluded.quote_sent_no_view_days,
        quote_viewed_not_approved_days = excluded.quote_viewed_not_approved_days,
        approved_no_deposit_days = excluded.approved_no_deposit_days,
        quiet_hours_start = excluded.quiet_hours_start,
        quiet_hours_end = excluded.quiet_hours_end,
        timezone = excluded.timezone,
        daily_cap = excluded.daily_cap,
        updated_at = now(), updated_by = auth.uid();
end;
$inner$;

select * from probe2 order by case_name;
rollback;
`);
  const row2 = (name) => check2.find(r => r.case_name === name) || {};
  ok("OWNER (has EDIT_CATALOG_AND_SETTINGS) can write settings", row2("OWNER can write settings").ok_result === true);
  ok("the row landed with the values sent, scoped to this company",
     row2("the row landed with the values sent, scoped to this company").ok_result === true,
     row2("the row landed with the values sent, scoped to this company").detail);
  ok("CANARY: a second call updates rather than being ignored",
     row2("CANARY: a second call updates rather than being ignored").ok_result === true,
     row2("CANARY: a second call updates rather than being ignored").detail);
  ok("a subject without EDIT_CATALOG_AND_SETTINGS is refused",
     row2("a subject without EDIT_CATALOG_AND_SETTINGS is refused").ok_result === true,
     row2("a subject without EDIT_CATALOG_AND_SETTINGS is refused").detail);
  ok("PLANTED FAILURE: with the permission check removed, the same crew subject wrongly gets through (proves this check can fail)",
     row2("PLANTED-BUG: without the permission check, the same crew subject is let through").ok_result === true,
     row2("PLANTED-BUG: without the permission check, the same crew subject is let through").detail);

  // =========================================================================
  console.log("\nFinally: prove nothing was left behind.");
  const after = runSql(`
    select
      (select count(*) from follow_up_settings where company_id = '${CO}') as settings_rows,
      (select count(*) from employees where profile_id in ('${CREW_SUBJECT}', '${STRANGER_SUBJECT}')) as crew_linked_employees,
      (select count(*) from time_entries where sync_id::text = 'aaaaaaaa-0000-0000-0000-0000000000f9') as probe_shift_rows,
      (select count(*) from profiles where id in ('${CREW_SUBJECT}', '${STRANGER_SUBJECT}')) as probe_profiles;
  `);
  const a = after[0] || {};
  ok("the follow_up_settings write was rolled back", Number(a.settings_rows) === 0, `got ${JSON.stringify(a)}`);
  ok("no employee is linked to a probe subject", Number(a.crew_linked_employees) === 0, `got ${a.crew_linked_employees}`);
  ok("the probe shift row is gone", Number(a.probe_shift_rows) === 0, `got ${a.probe_shift_rows}`);
  ok("the synthetic subjects themselves did not survive (transaction rolled back)",
     Number(a.probe_profiles) === 0, `got ${a.probe_profiles}`);

  console.log(`\n${checked - failed} of ${checked} checks passed`);
  if (failed) process.exit(1);
}

main().catch(e => { console.error("could not run:", e.message); process.exit(2); });
