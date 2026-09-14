-- CLOSED. BOTH OF THEM. This file is history plus the proof, not a warning.
--
-- Read the block immediately below before anything else here, because the
-- rest of this file describes holes that no longer exist -- and an earlier
-- reader of a similar file in this repo came away from one convinced that
-- crew money was still exposed, and nearly filed it as a live security
-- report. A stale warning is not caution; it costs somebody a day and spends
-- the credibility of the warnings that are real.
--
--   * Unguarded job assignment  -- CLOSED
--   * Self-approval of hours    -- CLOSED
--   Closed on 12 September 2026 by supabase_approval_and_assignment_guard.sql,
--   which installed two BEFORE triggers, time_entry_approval_needs_permission
--   on time_entries and job_assignment_needs_permission on jobs.
--   Verified against the live project (newcrgafcptspmapacrx) on
--   14 September 2026. The probe is at the bottom of this file; run it again
--   any time, it rolls everything back.
--
-- HOW THEY WERE PROVED, in two parts, because either alone is worth little.
--
-- 1. The code that is installed is the code in that file. The two trigger
--    functions were read straight back out of pg_proc and match
--    supabase_approval_and_assignment_guard.sql character for character,
--    including the part that matters most -- both are language plpgsql and
--    NOT security definer. Inside a definer function current_user is the
--    function's owner rather than the caller, which would make the
--    `current_user in ('authenticated','anon')` test false for every real end
--    user and wave every write through; the guard would look installed and do
--    nothing. pg_proc.prosecdef reads false for both.
--
-- 2. They actually refuse the write. Not "the trigger exists" -- a trigger
--    that exists and never fires produces exactly the same clean output as
--    one that works. The probe below runs as a real end user (set role
--    authenticated, request.jwt.claims carrying a real profile id, so
--    auth.uid() and has_permission() resolve the way PostgREST would resolve
--    them) and every refusal is paired with two things:
--
--      a CONTROL that must SUCCEED -- the same caller, the same row, holding
--      the permission -- because a write that fails for want of RLS
--      visibility fails exactly like a write a trigger refused. That is not
--      hypothetical here: the first run of this probe picked a FOREMAN, who
--      cannot SELECT from jobs at all (jobs_money_hidden_from_crew is
--      RESTRICTIVE and FOREMAN has no SEE_MONEY), so the attack reported "0
--      rows changed" and read as a guard doing its job. It was the guard
--      never running. The control caught it; without the control this file
--      would be claiming a proof it did not have.
--
--      a NEGATIVE-SPACE check that must also SUCCEED -- the same unpermitted
--      caller editing something the guard does not name -- because a guard
--      that refuses everything would pass the attack test and stop crew from
--      clocking out.
--
--    Results on 14 September 2026, every step as expected:
--      1  fixture holds APPROVE_TIME ............................. true
--      2  CONTROL  permitted caller stamps approved_at ........... 1 row
--      3  same fixture, permission stripped ...................... false
--      4  MUST FAIL  stamps approved_at .......................... 42501, guard's message
--      5  same caller edits notes ................................ 1 row
--      11 fixture holds SCHEDULE_AND_ASSIGN ...................... true
--      12 CONTROL  permitted caller reassigns a job .............. 1 row
--      13 same fixture, permission stripped ...................... false
--      14 MUST FAIL  reassigns a job ............................. 42501, guard's message
--      15 same caller writes the SAME assignment back ............ 1 row
--      20 MUST FAIL  insert a shift that arrives pre-approved .... 42501
--      21 CONTROL   insert an ordinary shift ..................... 1 row
--      30 review_note written by an unpermitted caller .......... accepted (see below)
--      31 correction_disputed_at, same ........................... accepted (see below)
--      40 time_entry_approval_needs_permission ................... invoker, enabled
--      41 job_assignment_needs_permission ........................ invoker, enabled
--    Steps 20-21 cover the INSERT path, which the original finding never
--    mentioned: an approval smuggled in on the insert rather than a later
--    update would have gone straight past a trigger that only watched UPDATE.
--
-- WHAT IS STILL NOT HELD, said here so this file does not become false in the
-- other direction. The original finding named four columns as the manager's
-- signature: approved_at, approved_by, rejected_at and review_note. The
-- shipped trigger holds the first three. review_note is not held, and neither
-- is correction_disputed_at -- steps 30 and 31 of the probe write both as an
-- unpermitted caller and both are accepted. That is a smaller thing than it
-- sounds and is deliberately not filed as an open hole: job_costing() decides
-- what counts as paid labour from approved_at alone, so no wage follows from
-- either column, and the dispute flow is meant to be written BY the employee
-- whose shift it is. It is recorded because "three of the four columns" is
-- the truth and "the approval columns are guarded" is not quite.
--
-- ---------------------------------------------------------------------------
-- WHAT THE GAPS WERE (history; both fixed, nothing below is actionable)
-- ---------------------------------------------------------------------------
-- Found by tests/company-crew-golden-path.test.mjs against the live database.
-- At the time, both update policies read, in full,
--
--     (company_id = current_company_id())
--
-- with no permission test in USING and no WITH CHECK at all.
--
-- 1. SCHEDULING. Any company member -- OWNER, MANAGER, SALES, ACCOUNTANT,
--    FOREMAN or a plain CREW phone -- could write assigned_employee_sync_id on
--    any job in the company with no SCHEDULE_AND_ASSIGN check anywhere in the
--    path. The same shape as the bug supabase_views_and_admin_patch.sql closed
--    for customer_name/address/phone with the protect_customer_identity
--    trigger, after a real CREW profile blanked the customer on every job with
--    one UPDATE.
--
-- 2. TIME CLOCK. approved_at/approved_by/rejected_at are a manager's
--    signature -- "until this is set the hours do not count towards pay or job
--    cost" (supabase_time_approval_patch.sql) -- gated by APPROVE_TIME in
--    has_permission(). RLS never checked APPROVE_TIME and no trigger held the
--    columns, so the person being paid for the shift could stamp their own
--    approval, and job_costing()'s labour_cost and hours_worked then counted
--    it as reviewed labour, because approved_at is all job_costing() looks at.
--
-- The fix took the predicted shape (a BEFORE trigger holding named columns,
-- mirroring protect_customer_identity) with three differences worth knowing:
-- it also covers jobs.scheduled_date, it also covers the INSERT path on
-- time_entries so a shift cannot simply arrive pre-approved, and it refuses to
-- exempt callers whose auth.uid() is null -- that escape hatch reads as "a
-- trusted server job" but is equally true of an anonymous caller, which is how
-- a definer function gets opened to the world.

-- ---------------------------------------------------------------------------
-- THE PROOF. Read-only in effect: one transaction, always rolled back. Safe to
-- run against the live project. Nothing here is a fix; the fix shipped on
-- 12 September and lives in supabase_approval_and_assignment_guard.sql.
-- ---------------------------------------------------------------------------
begin;

create temp table proof(step int, what text, expected text, observed text, verdict text) on commit drop;

do $proof$
declare
  v_actor uuid; v_entry uuid; v_job uuid;
  v_had boolean; v_n int; v_state text; v_err text;
  r record;
begin
  -- ------------------------------ 40-41  the shape of the guards themselves
  -- The one thing the behavioural steps cannot see from the outside. As
  -- SECURITY DEFINER, current_user inside a guard is the function's owner, so
  -- its `current_user in ('authenticated','anon')` test is false for every
  -- real end user and both guards wave every write through -- installed,
  -- listed, enabled, and doing nothing. tgenabled 'O' is the normal origin
  -- setting; 'D' is a disabled trigger, which also looks fine in a list of
  -- trigger names.
  for r in
    select t.tgname, p.prosecdef, t.tgenabled
      from pg_trigger t join pg_proc p on p.oid = t.tgfoid
     where t.tgname in ('time_entry_approval_needs_permission','job_assignment_needs_permission')
       and not t.tgisinternal
     order by t.tgname
  loop
    insert into proof values (
      case when r.tgname like 'job%' then 41 else 40 end,
      r.tgname, 'invoker (prosecdef false) and enabled (tgenabled O)',
      'prosecdef=' || r.prosecdef::text || ', tgenabled=' || r.tgenabled::text,
      case when not r.prosecdef and r.tgenabled = 'O' then 'PASS'
           else 'FAIL - the guard is installed but cannot do its job' end);
  end loop;
  if not exists (select 1 from proof where step in (40,41)) then
    insert into proof values (40,'the two guard triggers','both present','neither found',
      'FAIL - supabase_approval_and_assignment_guard.sql is not installed here');
    return;
  end if;

  -- ------------------------------------------------- 1-5  approving hours
  -- Fixture chosen BY PROPERTY and then asserted: somebody who holds
  -- APPROVE_TIME today and shares a company with a live shift. Never by name
  -- and never by id -- a fixture pinned to a person stops having the property
  -- it was picked for the moment that person is promoted, and a security
  -- proof that quietly lost its premise still prints PASS.
  select p.id, t.id into v_actor, v_entry
    from profiles p
    join time_entries t on t.company_id = p.company_id and t.deleted_at is null
   where p.role::text in ('OWNER','MANAGER','FOREMAN')
   limit 1;
  if v_actor is null then
    insert into proof values (0,'fixture','a profile with APPROVE_TIME sharing a company with a shift',
      'none found','ABORT - nothing below means anything');
    return;
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_actor::text, 'role','authenticated')::text, true);
  select has_permission('APPROVE_TIME') into v_had;
  insert into proof values (1,'fixture assertion','has_permission(APPROVE_TIME) = true',
    coalesce(v_had::text,'null'),
    case when v_had then 'PASS' else 'ABORT - the fixture does not have the permission it was picked for' end);
  if not v_had then return; end if;

  -- CONTROL. Must succeed, or step 4 proves nothing.
  set local role authenticated;
  begin
    update time_entries set approved_at = now(), approved_by = 'ZZ PROOF' where id = v_entry;
    get diagnostics v_n = row_count;
    reset role;
    insert into proof values (2,'CONTROL: permitted caller stamps approved_at','1 row updated',
      v_n::text || ' row(s)', case when v_n = 1 then 'PASS' else 'ABORT - control failed' end);
    if v_n <> 1 then return; end if;
  exception when others then
    reset role;
    insert into proof values (2,'CONTROL: permitted caller stamps approved_at','1 row updated',
      sqlstate || ' ' || sqlerrm, 'ABORT - control failed');
    return;
  end;

  -- Same person, same row, one variable changed: has_permission() reads
  -- '-PERM' out of permission_overrides before it looks at the role.
  reset role;
  update profiles set permission_overrides = '-APPROVE_TIME' where id = v_actor;
  select has_permission('APPROVE_TIME') into v_had;
  insert into proof values (3,'fixture assertion','has_permission(APPROVE_TIME) = false',
    coalesce(v_had::text,'null'),
    case when v_had then 'ABORT - the strip did not take' else 'PASS' end);
  if v_had then return; end if;

  -- MUST FAIL.
  set local role authenticated;
  begin
    update time_entries set approved_at = now(), approved_by = 'ZZ PROOF 2' where id = v_entry;
    get diagnostics v_n = row_count;
    reset role;
    insert into proof values (4,'MUST FAIL: unpermitted caller stamps approved_at','refused, SQLSTATE 42501',
      'ACCEPTED, ' || v_n::text || ' row(s)', 'FAIL - THE HOLE IS OPEN AGAIN');
  exception when others then
    v_state := sqlstate; v_err := sqlerrm; reset role;
    insert into proof values (4,'MUST FAIL: unpermitted caller stamps approved_at','refused, SQLSTATE 42501',
      v_state || ' ' || v_err,
      case when v_state = '42501' and v_err like '%APPROVE_TIME%' then 'PASS - refused by the guard'
           else 'INCONCLUSIVE - refused, but not by the guard' end);
  end;

  -- NEGATIVE SPACE. Crew write this row every time they clock out.
  set local role authenticated;
  begin
    update time_entries set notes = coalesce(notes,'') where id = v_entry;
    get diagnostics v_n = row_count;
    reset role;
    insert into proof values (5,'unpermitted caller edits a column the guard does not name','1 row updated',
      v_n::text || ' row(s)',
      case when v_n = 1 then 'PASS - column-scoped, not a blanket denial'
           else 'FAIL - the guard is refusing ordinary work' end);
  exception when others then
    reset role;
    insert into proof values (5,'unpermitted caller edits a column the guard does not name','1 row updated',
      sqlstate || ' ' || sqlerrm, 'FAIL - the guard is refusing ordinary work');
  end;

  -- ------------------------------------------- 20-21  the INSERT path too
  set local role authenticated;
  begin
    insert into time_entries (sync_id, company_id, employee_sync_id, employee_id, job_sync_id,
                              started_at, ended_at, approved_at, approved_by)
    select gen_random_uuid(), company_id, employee_sync_id, employee_id, job_sync_id,
           now() - interval '2 hours', now(), now(), 'ZZ PROOF self-signed'
      from time_entries where id = v_entry;
    get diagnostics v_n = row_count;
    reset role;
    insert into proof values (20,'MUST FAIL: unpermitted caller inserts a shift that arrives pre-approved',
      'refused, SQLSTATE 42501', 'ACCEPTED, ' || v_n::text || ' row(s)',
      'FAIL - an approval can be smuggled in on the insert instead');
  exception when others then
    v_state := sqlstate; v_err := sqlerrm; reset role;
    insert into proof values (20,'MUST FAIL: unpermitted caller inserts a shift that arrives pre-approved',
      'refused, SQLSTATE 42501', v_state || ' ' || v_err,
      case when v_state = '42501' and v_err like '%APPROVE_TIME%' then 'PASS - refused by the guard'
           else 'INCONCLUSIVE' end);
  end;

  set local role authenticated;
  begin
    insert into time_entries (sync_id, company_id, employee_sync_id, employee_id, job_sync_id,
                              started_at, ended_at)
    select gen_random_uuid(), company_id, employee_sync_id, employee_id, job_sync_id,
           now() - interval '2 hours', now()
      from time_entries where id = v_entry;
    get diagnostics v_n = row_count;
    reset role;
    insert into proof values (21,'CONTROL: unpermitted caller inserts an ordinary shift','1 row inserted',
      v_n::text || ' row(s)',
      case when v_n = 1 then 'PASS - clocking in still works' else 'FAIL - crew cannot clock in' end);
  exception when others then
    reset role;
    insert into proof values (21,'CONTROL: unpermitted caller inserts an ordinary shift','1 row inserted',
      sqlstate || ' ' || sqlerrm, 'FAIL - crew cannot clock in');
  end;

  -- --------------------------------- 30-31  the two columns NOT held
  -- Recorded, not alarmed about: see "WHAT IS STILL NOT HELD" above. These
  -- steps exist so the claim in the header is a measurement rather than a
  -- reading of the trigger source, and so that if somebody later extends the
  -- guard to cover them, this file notices.
  set local role authenticated;
  begin
    update time_entries set review_note = 'ZZ PROOF' where id = v_entry;
    get diagnostics v_n = row_count;
    reset role;
    insert into proof values (30,'unpermitted caller writes review_note',
      'accepted -- the guard does not name this column', v_n::text || ' row(s)',
      case when v_n = 1 then 'as documented - not held' else 'CHANGED - the guard now covers it; update the header' end);
  exception when others then
    reset role;
    insert into proof values (30,'unpermitted caller writes review_note',
      'accepted -- the guard does not name this column', sqlstate || ' ' || sqlerrm,
      'CHANGED - the guard now covers it; update the header');
  end;

  set local role authenticated;
  begin
    update time_entries set correction_disputed_at = now() where id = v_entry;
    get diagnostics v_n = row_count;
    reset role;
    insert into proof values (31,'unpermitted caller writes correction_disputed_at',
      'accepted -- the employee disputes their own correction', v_n::text || ' row(s)',
      case when v_n = 1 then 'as documented - not held' else 'CHANGED - update the header' end);
  exception when others then
    reset role;
    insert into proof values (31,'unpermitted caller writes correction_disputed_at',
      'accepted -- the employee disputes their own correction', sqlstate || ' ' || sqlerrm,
      'CHANGED - update the header');
  end;

  -- Hand the fixture back before the jobs half runs, or its own fixture
  -- assertion aborts it -- correctly, but having measured nothing.
  reset role;
  update profiles set permission_overrides = '' where id = v_actor;

  -- ------------------------------------------ 11-15  assigning a job
  -- Two properties here, not one: the caller must hold SCHEDULE_AND_ASSIGN and
  -- must also be able to SEE the job. jobs_money_hidden_from_crew is
  -- RESTRICTIVE on SELECT, so a caller without SEE_MONEY cannot select from
  -- jobs at all, and an UPDATE ... WHERE that cannot find its row reports zero
  -- rows -- indistinguishable from a guard refusing the write.
  v_actor := null;
  for v_actor, v_job in
    select p.id, j.id
      from profiles p
      join jobs j on j.company_id = p.company_id and j.deleted_at is null
     where p.role::text in ('OWNER','MANAGER','FOREMAN')
  loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_actor::text, 'role','authenticated')::text, true);
    exit when has_permission('SCHEDULE_AND_ASSIGN') and has_permission('SEE_MONEY');
    v_actor := null;
  end loop;
  if v_actor is null then
    insert into proof values (10,'fixture',
      'a profile holding SCHEDULE_AND_ASSIGN that can also read jobs','none found','ABORT');
    return;
  end if;

  select has_permission('SCHEDULE_AND_ASSIGN') into v_had;
  insert into proof values (11,'fixture assertion','has_permission(SCHEDULE_AND_ASSIGN) = true',
    coalesce(v_had::text,'null'), case when v_had then 'PASS' else 'ABORT' end);
  if not v_had then return; end if;

  set local role authenticated;
  begin
    update jobs set assigned_employee_sync_id = 'ZZ-PROOF-A' where id = v_job;
    get diagnostics v_n = row_count;
    reset role;
    insert into proof values (12,'CONTROL: permitted caller reassigns a job','1 row updated',
      v_n::text || ' row(s)', case when v_n = 1 then 'PASS' else 'ABORT - control failed' end);
    if v_n <> 1 then return; end if;
  exception when others then
    reset role;
    insert into proof values (12,'CONTROL: permitted caller reassigns a job','1 row updated',
      sqlstate || ' ' || sqlerrm, 'ABORT - control failed');
    return;
  end;

  reset role;
  update profiles set permission_overrides = '-SCHEDULE_AND_ASSIGN' where id = v_actor;
  select has_permission('SCHEDULE_AND_ASSIGN') into v_had;
  insert into proof values (13,'fixture assertion','has_permission(SCHEDULE_AND_ASSIGN) = false',
    coalesce(v_had::text,'null'),
    case when v_had then 'ABORT - the strip did not take' else 'PASS' end);
  if v_had then return; end if;

  -- MUST FAIL.
  set local role authenticated;
  begin
    update jobs set assigned_employee_sync_id = 'ZZ-PROOF-B' where id = v_job;
    get diagnostics v_n = row_count;
    reset role;
    insert into proof values (14,'MUST FAIL: unpermitted caller reassigns a job','refused, SQLSTATE 42501',
      'ACCEPTED, ' || v_n::text || ' row(s)', 'FAIL - THE HOLE IS OPEN AGAIN');
  exception when others then
    v_state := sqlstate; v_err := sqlerrm; reset role;
    insert into proof values (14,'MUST FAIL: unpermitted caller reassigns a job','refused, SQLSTATE 42501',
      v_state || ' ' || v_err,
      case when v_state = '42501' and v_err like '%SCHEDULE_AND_ASSIGN%' then 'PASS - refused by the guard'
           else 'INCONCLUSIVE - refused, but not by the guard' end);
  end;

  -- NEGATIVE SPACE. A sync writing the row back unchanged must not be refused,
  -- or every ordinary push from a phone fails.
  set local role authenticated;
  begin
    update jobs set assigned_employee_sync_id = assigned_employee_sync_id where id = v_job;
    get diagnostics v_n = row_count;
    reset role;
    insert into proof values (15,'unpermitted caller writes the SAME assignment back','1 row updated',
      v_n::text || ' row(s)',
      case when v_n = 1 then 'PASS - the guard refuses the change, not the column'
           else 'FAIL - ordinary sync would be refused' end);
  exception when others then
    reset role;
    insert into proof values (15,'unpermitted caller writes the SAME assignment back','1 row updated',
      sqlstate || ' ' || sqlerrm, 'FAIL - ordinary sync would be refused');
  end;
  reset role;
end
$proof$;

select * from proof order by step;

rollback;
