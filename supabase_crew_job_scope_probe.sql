-- supabase_crew_job_scope.sql -- PROOF, one rolled-back transaction.
--
-- Run AFTER the migration is applied (or, to prove it before, run
-- `begin;` + the migration + this file in one go -- tests/crew-job-scope.test.mjs
-- does exactly that, and nothing survives either way).
--
-- Every subject and every row is synthetic and created in here; no real
-- person, job or company is read or written. Subjects are chosen by the
-- PROPERTY each check depends on and that property is asserted first (row
-- 0x), so a changed role table reads as "fixture drifted", never as a breach
-- or a pass. Every negative has a positive control in the same run that
-- would break first:
--   * a crew member seeing ONE job means nothing unless a manager sees ALL of
--     them in the same transaction (10 vs 14), and an unlinked login seeing
--     none means nothing unless the linked one sees theirs (16 vs 14);
--   * "refused" is scored by SQLSTATE and "allowed" by AFFECTED ROWS, then
--     read back by the office, because no error is not proof;
--   * the sweep's "not flagged" is only trusted beside a job that IS flagged
--     (81, the canary that never gets anyone).
--
-- Output: one row per check, PASS or FAIL, and a SUMMARY row last. Anything
-- but "N/N" is a finding.
begin;
set local lock_timeout = '5s';

create temp table r(n serial, k text, got text, want text);
grant all on r to authenticated, anon;
grant usage on sequence r_n_seq to authenticated, anon;

-- Short labels for the fixture jobs, so "which jobs does X see" reads as a
-- string like 'A,U' instead of a list of uuids.
create temp table lbl(s uuid primary key, l text);
grant select on lbl to authenticated, anon;

-- A signed-in caller, one scalar back.
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

-- A signed-in caller, a statement run for effect: the real row count.
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

-- An anonymous phone: role anon, no sub.
create function pg_temp.a(label text, q text, want text) returns void language plpgsql as $fn$
declare v text;
begin
  perform set_config('request.jwt.claims', json_build_object('role','anon')::text, true);
  execute 'set local role anon';
  begin execute q into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,150); end;
  execute 'reset role';
  perform set_config('request.jwt.claims','',true);
  insert into r(k,got,want) values (label,v,want);
end $fn$;

-- The office / a direct connection, one scalar back.
create function pg_temp.s(label text, q text, want text) returns void language plpgsql as $fn$
declare v text;
begin
  perform set_config('request.jwt.claims','',true);
  begin execute q into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,150); end;
  insert into r(k,got,want) values (label,v,want);
end $fn$;

-- A caller's identity WITHOUT dropping to their role: for the internal
-- helpers, which no client may execute but which answer per caller.
create function pg_temp.c(label text, uid uuid, q text, want text) returns void language plpgsql as $fn$
declare v text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub',uid,'role','authenticated')::text, true);
  begin execute q into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,150); end;
  perform set_config('request.jwt.claims','',true);
  insert into r(k,got,want) values (label,v,want);
end $fn$;

do $body$
declare
  SC    uuid := 'c5000001-0000-4000-8000-000000000001';
  SC2   uuid := 'c5000002-0000-4000-8000-000000000002';
  uOWN  uuid := 'c5100001-0000-4000-8000-000000000001';
  uMGR  uuid := 'c5100002-0000-4000-8000-000000000002';
  uFOR  uuid := 'c5100003-0000-4000-8000-000000000003';
  uCRW  uuid := 'c5100004-0000-4000-8000-000000000004';  -- crew, linked to eCRW
  uCR2  uuid := 'c5100005-0000-4000-8000-000000000005';  -- crew, linked to eCR2
  uUNL  uuid := 'c5100006-0000-4000-8000-000000000006';  -- crew, NOT linked
  uFSC  uuid := 'c5100007-0000-4000-8000-000000000007';  -- foreman with -SCHEDULE_AND_ASSIGN
  uCRE  uuid := 'c5100008-0000-4000-8000-000000000008';  -- crew with +EDIT_JOBS
  uOTH  uuid := 'c5100009-0000-4000-8000-000000000009';  -- owner of the OTHER company
  uOC   uuid := 'c510000a-0000-4000-8000-00000000000a';  -- crew of the OTHER company
  eCRW  uuid := 'c5200004-0000-4000-8000-000000000004';
  eCR2  uuid := 'c5200005-0000-4000-8000-000000000005';
  eFSC  uuid := 'c5200007-0000-4000-8000-000000000007';
  eLONE uuid := 'c520000b-0000-4000-8000-00000000000b';  -- a crew record with no login
  eOC   uuid := 'c520000a-0000-4000-8000-00000000000a';
  jA    uuid := 'c5300001-0000-4000-8000-000000000001';  -- lead: eCRW
  jB    uuid := 'c5300002-0000-4000-8000-000000000002';  -- lead: eCR2
  jU    uuid := 'c5300003-0000-4000-8000-000000000003';  -- nobody (asked for, granted, taken back)
  jQ    uuid := 'c5300004-0000-4000-8000-000000000004';  -- nobody, still a DRAFT
  jX    uuid := 'c5300005-0000-4000-8000-000000000005';  -- nobody, then extra crew eCR2, then ended
  jN    uuid := 'c5300006-0000-4000-8000-000000000006';  -- nobody, ever: the sweep's canary
  jF    uuid := 'c5300007-0000-4000-8000-000000000007';  -- lead: eFSC
  jO    uuid := 'c5300009-0000-4000-8000-000000000009';  -- the other company's job
  lA    uuid := 'c5700001-0000-4000-8000-000000000001';  -- the line on A
  lB    uuid := 'c5700002-0000-4000-8000-000000000002';  -- the line on B
  lU    uuid := 'c5700003-0000-4000-8000-000000000003';  -- the line on U
  jobs_q text := 'select coalesce(string_agg(l.l, '','' order by l.l), ''-'') from jobs_crew v join lbl l on l.s = v.sync_id';
  child_q text := 'select coalesce(string_agg(distinct l.l, '','' order by l.l), ''-'') from %I v join lbl l on l.s = v.job_sync_id';
  t text;
  rid1 uuid; rid2 uuid; rid3 uuid; aid uuid; pending_id uuid;
  n_ok int; first_err text;
  i int;
  -- supabase_r6_price_stability.sql makes every crew line push a no-op (0
  -- rows) before it reaches this file's guard. The 9x line rows expect that
  -- when it is live, and the plain push when it is not, so the probe is
  -- right in either apply order. Row 0i records which one ran.
  r6_lines boolean := position('r6_crew_lines_read_only'
                               in pg_get_functiondef('public.crew_push_line_items(jsonb)'::regprocedure)) > 0;
  -- The same file's PART 6b closes estimate_line_items to a direct INSERT
  -- without EDIT_JOBS or SEE_MONEY -- so to every crew login, on every job,
  -- whatever job scope says. Row 37 expects that refusal when it is live,
  -- and the plain insert when it is not. Row 0j records which one ran.
  r6_insert_gate boolean := exists (select 1 from pg_policies
                                     where schemaname = 'public' and tablename = 'estimate_line_items'
                                       and policyname = 'line_items_insert_needs_money_or_edit');
begin
  perform set_config('request.jwt.claims','',true);
  insert into r(k,got,want) values ('0i INFO     r6 crew line pushes are no-ops', r6_lines::text, r6_lines::text);
  insert into r(k,got,want) values ('0j INFO     r6 line insert needs EDIT_JOBS or SEE_MONEY', r6_insert_gate::text, r6_insert_gate::text);

  -- ======================================================================
  -- Fixtures
  -- ======================================================================
  insert into auth.users(id,email) values
    (uOWN,'cs-own@probe.invalid'),(uMGR,'cs-mgr@probe.invalid'),(uFOR,'cs-for@probe.invalid'),
    (uCRW,'cs-crw@probe.invalid'),(uCR2,'cs-cr2@probe.invalid'),(uUNL,'cs-unl@probe.invalid'),
    (uFSC,'cs-fsc@probe.invalid'),(uCRE,'cs-cre@probe.invalid'),(uOTH,'cs-oth@probe.invalid'),
    (uOC,'cs-oc@probe.invalid');
  insert into companies(id,name,subscription_status,subscription_plan,suspended,trial_ends_at,
                        admin_notes,leads_token,stripe_customer_id,invited_email,suspended_reason) values
    (SC ,'PROBE-CREW-SCOPE','active','pro',false,now()+interval '30 days','',gen_random_uuid(),'cus_CS1','',''),
    (SC2,'PROBE-CREW-SCOPE-OTHER','active','pro',false,now()+interval '30 days','',gen_random_uuid(),'cus_CS2','','');
  insert into profiles(id,company_id,full_name,role,is_platform_admin,permission_overrides) values
    (uOWN,SC ,'CS Owner'   ,'OWNER'  ,false,''),
    (uMGR,SC ,'CS Manager' ,'MANAGER',false,''),
    (uFOR,SC ,'CS Foreman' ,'FOREMAN',false,''),
    (uCRW,SC ,'CS Crew'    ,'CREW'   ,false,''),
    (uCR2,SC ,'CS Crew Two','CREW'   ,false,''),
    (uUNL,SC ,'CS Unlinked','CREW'   ,false,''),
    (uFSC,SC ,'CS Scoped Foreman','FOREMAN',false,'-SCHEDULE_AND_ASSIGN'),
    (uCRE,SC ,'CS Crew Editor','CREW',false,'+EDIT_JOBS'),
    (uOTH,SC2,'CS Other Owner','OWNER',false,''),
    (uOC ,SC2,'CS Other Crew' ,'CREW' ,false,'');
  insert into employees(id,company_id,name,sync_id,hourly_rate,pay_type,profile_id,is_active) values
    (eCRW ,SC ,'CS Crew'          ,eCRW ,21.00,'HOURLY',uCRW,true),
    (eCR2 ,SC ,'CS Crew Two'      ,eCR2 ,22.00,'HOURLY',uCR2,true),
    (eFSC ,SC ,'CS Scoped Foreman',eFSC ,30.00,'HOURLY',uFSC,true),
    (eLONE,SC ,'CS No Login'      ,eLONE,20.00,'HOURLY',null,true),
    (eOC  ,SC2,'CS Other Crew'    ,eOC  ,25.00,'HOURLY',uOC ,true);
  insert into jobs(id,company_id,customer_name,address,phone,email,status,sync_id,contract_total,
                   quote_token,is_test_fixture,notes,assigned_employee_sync_id,scheduled_date) values
    (jA,SC ,'CS JOB A','1 Probe Way','555-0101','a@probe.invalid','ACCEPTED',jA,5000,gen_random_uuid(),false,'',eCRW::text,'2030-06-01 12:00+00'),
    (jB,SC ,'CS JOB B','2 Probe Way','555-0102','b@probe.invalid','ACCEPTED',jB,5000,gen_random_uuid(),false,'',eCR2::text,null),
    (jU,SC ,'CS JOB U','3 Probe Way','555-0103','u@probe.invalid','ACCEPTED',jU,5000,gen_random_uuid(),false,'',null,null),
    (jQ,SC ,'CS JOB Q','4 Probe Way','555-0104','q@probe.invalid','DRAFT'   ,jQ,5000,gen_random_uuid(),false,'',null,null),
    (jX,SC ,'CS JOB X','5 Probe Way','555-0105','x@probe.invalid','ACCEPTED',jX,5000,gen_random_uuid(),false,'',null,'2030-06-02 12:00+00'),
    (jN,SC ,'CS JOB N','6 Probe Way','555-0106','n@probe.invalid','ACCEPTED',jN,5000,gen_random_uuid(),false,'',null,'2030-06-03 12:00+00'),
    (jF,SC ,'CS JOB F','7 Probe Way','555-0107','f@probe.invalid','ACCEPTED',jF,5000,gen_random_uuid(),false,'',eFSC::text,null),
    (jO,SC2,'CS JOB O','9 Other Rd','555-0109','o@probe.invalid','ACCEPTED',jO,5000,gen_random_uuid(),false,'',eOC::text,null);
  -- Twenty-five more won jobs nobody is on, for the request limits.
  insert into jobs(id,company_id,customer_name,address,phone,email,status,sync_id,contract_total,
                   quote_token,is_test_fixture,notes)
  select g.u, SC, 'CS RATE ' || g.k, g.k || ' Rate St', '555-0200', 'r@probe.invalid', 'ACCEPTED', g.u, 1000,
         gen_random_uuid(), false, ''
    from (select gs.k, ('c5300100-0000-4000-8000-' || lpad(gs.k::text, 12, '0'))::uuid u
            from generate_series(1, 25) gs(k)) g;
  insert into lbl values (jA,'A'),(jB,'B'),(jU,'U'),(jQ,'Q'),(jX,'X'),(jN,'N'),(jF,'F'),(jO,'O');

  -- One row of every job-bound table a crew phone touches, on A, B and U.
  insert into fence_runs(company_id,sync_id,job_sync_id,label)
    select SC, gen_random_uuid(), j, 'run' from unnest(array[jA,jB,jU]) j;
  insert into job_steps(company_id,sync_id,job_sync_id,kind,description)
    select SC, gen_random_uuid(), j, 'CHECK', 'step' from unnest(array[jA,jB,jU]) j;
  insert into site_markers(company_id,sync_id,job_sync_id,kind,x,y)
    select SC, gen_random_uuid(), j, 'GAS', 1, 1 from unnest(array[jA,jB,jU]) j;
  insert into punch_list_items(company_id,sync_id,job_sync_id,description)
    select SC, gen_random_uuid(), j, 'punch' from unnest(array[jA,jB,jU]) j;
  insert into field_changes(company_id,sync_id,job_sync_id,summary)
    select SC, gen_random_uuid()::text, j, 'change' from unnest(array[jA,jB,jU]) j;
  insert into job_stage_events(company_id,job_sync_id,stage)
    select SC, j, 'MATERIALS' from unnest(array[jA,jB,jU]) j;
  insert into quote_reapprovals(company_id,job_id,job_sync_id,reason)
    select SC, j, j, 'probe' from unnest(array[jA,jB,jU]) j;
  -- Line ids are fixed: 9a pushes U's line back at the server by its id, the
  -- way a phone holding it from an old company-wide pull could.
  insert into estimate_line_items(company_id,sync_id,job_sync_id,description,quantity,unit_price) values
    (SC, lA, jA, 'line', 1, 10), (SC, lB, jB, 'line', 1, 10), (SC, lU, jU, 'line', 1, 10);
  insert into change_orders(company_id,sync_id,job_sync_id,description)
    select SC, gen_random_uuid(), j, 'co' from unnest(array[jA,jB,jU]) j;
  insert into expenses(company_id,sync_id,job_sync_id,description,amount)
    select SC, gen_random_uuid(), j, 'expense', 0 from unnest(array[jA,jB,jU]) j;
  -- The side doors: rows only the server writes, one per job. The attention
  -- text carries a dollar figure the way the sweep writes a failed payment.
  insert into attention_findings(company_id,job_sync_id,detector,severity,message,fp)
    select SC, j, 'payment_failed', 'critical', 'Payment attempt failed ($1,234.00): probe', 'probe'
      from unnest(array[jA,jB,jU]) j;
  insert into automation_flags(company_id,job_sync_id,rule_key,message)
    select SC, j, 'probe_rule', 'probe flag' from unnest(array[jA,jB,jU]) j;
  insert into automation_runs(company_id,rule_key,job_sync_id)
    select SC, 'probe_rule', j from unnest(array[jA,jB,jU]) j;
  insert into follow_up_log(company_id,job_sync_id,kind,stage_key)
    select SC, j, 'quote_sent_no_view', 'probe' from unnest(array[jA,jB,jU]) j;
  insert into customers(company_id,name,address,phone,email) values
    (SC ,'CS Customer One','1 Probe Way','555-0301','c1@probe.invalid'),
    (SC ,'CS Customer Two','3 Probe Way','555-0303','c2@probe.invalid'),
    (SC2,'CS Other Customer','9 Other Rd','555-0309','c9@probe.invalid');
  -- Shifts: the crew member's own on A, and a colleague's on A and on B.
  insert into time_entries(id,company_id,sync_id,job_sync_id,employee_sync_id,started_at,ended_at,hourly_rate,notes,updated_at) values
    ('c5500001-0000-4000-8000-000000000001',SC,'c5500001-0000-4000-8000-000000000001',jA,eCRW::text,now()-interval '9 hours',now()-interval '1 hour',21,'',now()),
    ('c5500002-0000-4000-8000-000000000002',SC,'c5500002-0000-4000-8000-000000000002',jA,eCR2::text,now()-interval '9 hours',now()-interval '1 hour',22,'',now()),
    ('c5500003-0000-4000-8000-000000000003',SC,'c5500003-0000-4000-8000-000000000003',jB,eCR2::text,now()-interval '9 hours',now()-interval '1 hour',22,'',now());
  insert into attention_sweep_settings(company_id, enabled) values (SC, true);

  -- ======================================================================
  -- 0x  Subjects, by property
  -- ======================================================================
  perform pg_temp.p('00 CREW      sees_all/RECORD_FIELD_WORK/SEE_MONEY', uCRW,
    'select sees_all_jobs()::text||''/''||has_permission(''RECORD_FIELD_WORK'')::text||''/''||has_permission(''SEE_MONEY'')::text', 'false/true/false');
  perform pg_temp.p('01 CREW TWO  sees_all/RECORD_FIELD_WORK/SEE_MONEY', uCR2,
    'select sees_all_jobs()::text||''/''||has_permission(''RECORD_FIELD_WORK'')::text||''/''||has_permission(''SEE_MONEY'')::text', 'false/true/false');
  perform pg_temp.p('02 UNLINKED  sees_all/RECORD_FIELD_WORK/linked', uUNL,
    'select sees_all_jobs()::text||''/''||has_permission(''RECORD_FIELD_WORK'')::text||''/''||(my_job_scope()->>''linked'')', 'false/true/false');
  perform pg_temp.p('03 MANAGER   sees_all', uMGR, 'select sees_all_jobs()::text', 'true');
  perform pg_temp.p('04 FOREMAN   sees_all/SCHEDULE_AND_ASSIGN/SEE_MONEY', uFOR,
    'select sees_all_jobs()::text||''/''||has_permission(''SCHEDULE_AND_ASSIGN'')::text||''/''||has_permission(''SEE_MONEY'')::text', 'true/true/false');
  perform pg_temp.p('05 OWNER     sees_all', uOWN, 'select sees_all_jobs()::text', 'true');
  perform pg_temp.p('06 FOREMAN -SCHEDULE_AND_ASSIGN: sees_all/SCHEDULE_AND_ASSIGN/APPROVE_TIME', uFSC,
    'select sees_all_jobs()::text||''/''||has_permission(''SCHEDULE_AND_ASSIGN'')::text||''/''||has_permission(''APPROVE_TIME'')::text', 'false/false/true');
  perform pg_temp.p('07 CREW +EDIT_JOBS: sees_all', uCRE, 'select sees_all_jobs()::text', 'true');
  perform pg_temp.p('08 CREW      my crew record', uCRW, 'select string_agg(s::text, '','') from my_employee_sync_ids() s', eCRW::text);

  -- ======================================================================
  -- 1x  Which jobs reach whose phone
  -- ======================================================================
  perform pg_temp.p('10 MANAGER   jobs_crew count (positive control)', uMGR, 'select count(*)::text from jobs_crew',
    (select count(*)::text from jobs where company_id = SC));
  perform pg_temp.p('11 OWNER     jobs_crew count', uOWN, 'select count(*)::text from jobs_crew',
    (select count(*)::text from jobs where company_id = SC));
  perform pg_temp.p('12 FOREMAN   jobs_crew count', uFOR, 'select count(*)::text from jobs_crew',
    (select count(*)::text from jobs where company_id = SC));
  perform pg_temp.p('13 CREW +EDIT_JOBS jobs_crew count (override un-scopes)', uCRE, 'select count(*)::text from jobs_crew',
    (select count(*)::text from jobs where company_id = SC));
  perform pg_temp.p('14 CREW      sees only the job they lead', uCRW, jobs_q, 'A');
  perform pg_temp.p('15 CREW TWO  sees only the job they lead', uCR2, jobs_q, 'B');
  perform pg_temp.p('16 UNLINKED  sees nothing (canary; 14 is its control)', uUNL, jobs_q, '-');
  perform pg_temp.p('17 FOREMAN -SCHEDULE_AND_ASSIGN is scoped (override scopes)', uFSC, jobs_q, 'F');
  perform pg_temp.p('18 OTHER CO  crew sees only their own company''s job', uOC, jobs_q, 'O');
  perform pg_temp.p('19 MANAGER   sees every job here and none of the other company', uMGR, jobs_q, 'A,B,F,N,Q,U,X');

  -- ======================================================================
  -- 2x  Job-bound tables and views follow the same rule
  -- ======================================================================
  foreach t in array array['fence_runs','job_steps','site_markers','punch_list_items','field_changes',
                           'job_stage_events','quote_reapprovals','estimate_line_items_crew','change_orders_crew',
                           'automation_flags','automation_runs','follow_up_log'] loop
    perform pg_temp.p('20 CREW      ' || t, uCRW, format(child_q, t), 'A');
    perform pg_temp.p('21 MANAGER   ' || t || ' (positive control)', uMGR, format(child_q, t), 'A,B,U');
  end loop;
  perform pg_temp.p('22 UNLINKED  fence_runs', uUNL, format(child_q, 'fence_runs'), '-');
  -- The attention text carries money, so it follows SEE_MONEY, not the job:
  -- crew see none of it, not even on their own job, and neither does a
  -- foreman, who sees every job without SEE_MONEY (property in row 04).
  perform pg_temp.p('23 CREW      attention_findings, even on their own job', uCRW, format(child_q, 'attention_findings'), '-');
  perform pg_temp.p('23b FOREMAN  attention_findings (every job, no SEE_MONEY)', uFOR, format(child_q, 'attention_findings'), '-');
  perform pg_temp.p('23c MANAGER  attention_findings (positive control)', uMGR, format(child_q, 'attention_findings'), 'A,B,U');
  -- customers has no job column: contact data needs "sees every job" and
  -- SEE_CUSTOMER_CONTACT, and writing needs EDIT_JOBS.
  perform pg_temp.p('24 CREW      customers readable', uCRW, 'select count(*)::text from customers', '0');
  perform pg_temp.p('24b FOREMAN  customers readable (sees all, SEE_CUSTOMER_CONTACT)', uFOR, 'select count(*)::text from customers', '2');
  perform pg_temp.p('24c MANAGER  customers readable, this company only (positive)', uMGR, 'select count(*)::text from customers', '2');
  perform pg_temp.x('24d CREW     edit every customer', uCRW, 'update customers set notes = ''crew'' where name is not null', 'rows=0');
  perform pg_temp.x('24e CREW     add a customer', uCRW,
    format('insert into customers(company_id,name) values (%L,''crew made this'')', SC), 'ERR 42501');
  perform pg_temp.x('24f FOREMAN  edit every customer (no EDIT_JOBS)', uFOR, 'update customers set notes = ''foreman'' where name is not null', 'rows=0');
  perform pg_temp.x('24g MANAGER  edit every customer (positive)', uMGR, 'update customers set notes = ''office'' where name is not null', 'rows=2');

  -- ======================================================================
  -- 3x  Writes on a job the caller is not on are refused; on theirs, allowed
  -- ======================================================================
  perform pg_temp.x('30 CREW      add a checklist step to a job they are not on', uCRW,
    format('insert into job_steps(company_id,sync_id,job_sync_id,kind,description) values (%L,gen_random_uuid(),%L,''CHECK'',''x'')', SC, jU), 'ERR 42501');
  perform pg_temp.x('31 CREW      add a checklist step to their own job (positive)', uCRW,
    format('insert into job_steps(company_id,sync_id,job_sync_id,kind,description) values (%L,gen_random_uuid(),%L,''CHECK'',''x'')', SC, jA), 'rows=1');
  perform pg_temp.x('32 CREW      edit a run on a job they are not on', uCRW,
    format('update fence_runs set sort_order = 7 where job_sync_id = %L', jU), 'rows=0');
  perform pg_temp.x('33 CREW      edit a run on their own job (positive)', uCRW,
    format('update fence_runs set sort_order = 7 where job_sync_id = %L', jA), 'rows=1');
  perform pg_temp.x('34 CREW      send a field change on a job they are not on', uCRW,
    format('insert into field_changes(company_id,sync_id,job_sync_id,summary) values (%L,gen_random_uuid()::text,%L,''x'')', SC, jU), 'ERR 42501');
  perform pg_temp.x('35 MANAGER   add a checklist step anywhere (positive)', uMGR,
    format('insert into job_steps(company_id,sync_id,job_sync_id,kind,description) values (%L,gen_random_uuid(),%L,''CHECK'',''x'')', SC, jU), 'rows=1');
  -- The money tables take company-wide writes; job scope now bounds them.
  -- A crew INSERT into any of the three is refused today by something else
  -- as well (see PART 1c of the migration): r6's money/edit gate on lines
  -- (37: even on their own job, while it is live), guard_expense_amount on
  -- expenses, and the 42804 in hold_money_columns() on change orders. So 36
  -- is refused either way and cannot show job scope deciding. 36b/37b do:
  -- the expense amount guard is switched off for those two rows only -- in
  -- this transaction, which rolls back -- leaving this file's INSERT policy
  -- as the one gate. 36b must be refused BY THAT POLICY, by name, and 37b,
  -- the same insert on their own job, must land.
  perform pg_temp.x('36 CREW      plant a line item on a job they are not on', uCRW,
    format('insert into estimate_line_items(company_id,sync_id,job_sync_id,description,quantity) values (%L,gen_random_uuid(),%L,''x'',1)', SC, jU), 'ERR 42501');
  perform pg_temp.x('37 CREW      add a line item to their own job (r6 live: refused by its money/edit gate)', uCRW,
    format('insert into estimate_line_items(company_id,sync_id,job_sync_id,description,quantity) values (%L,gen_random_uuid(),%L,''x'',1)', SC, jA),
    case when r6_insert_gate then 'ERR 42501' else 'rows=1' end);
  if exists (select 1 from pg_trigger where tgrelid = 'public.expenses'::regclass
                                        and tgname = 'expense_amount_needs_permission') then
    alter table public.expenses disable trigger expense_amount_needs_permission;
  end if;
  perform pg_temp.x('36b CREW     plant an expense on a job they are not on (amount guard off)', uCRW,
    format('insert into expenses(company_id,sync_id,job_sync_id,description,amount) values (%L,gen_random_uuid(),%L,''x'',0)', SC, jU),
    'ERR 42501: new row violates row-level security policy "expenses_insert_only_visible_jobs"');
  perform pg_temp.x('37b CREW     add an expense to their own job (amount guard off; positive for 36b)', uCRW,
    format('insert into expenses(company_id,sync_id,job_sync_id,description,amount) values (%L,gen_random_uuid(),%L,''x'',0)', SC, jA), 'rows=1');
  if exists (select 1 from pg_trigger where tgrelid = 'public.expenses'::regclass
                                        and tgname = 'expense_amount_needs_permission') then
    alter table public.expenses enable trigger expense_amount_needs_permission;
  end if;
  -- An UPDATE with no WHERE touches exactly the rows already on their own
  -- job -- counted here by the office rather than assumed, because 37 lands
  -- a second line only when r6 is not live. 39 is the canary: nothing on B
  -- or U moved.
  perform pg_temp.x('38 CREW      one UPDATE, no WHERE: every line onto their job', uCRW,
    format('update estimate_line_items set job_sync_id = %L', jA),
    (select 'rows=' || count(*) from estimate_line_items where job_sync_id = jA));
  perform pg_temp.x('38b CREW     the same for change orders', uCRW,
    format('update change_orders set job_sync_id = %L', jA),
    (select 'rows=' || count(*) from change_orders where job_sync_id = jA));
  perform pg_temp.x('38c CREW     the same for expenses', uCRW,
    format('update expenses set job_sync_id = %L', jA),
    (select 'rows=' || count(*) from expenses where job_sync_id = jA));
  perform pg_temp.s('39 OFFICE    lines / change orders / expenses on B and U did not move', format(
    'select (select count(*) from estimate_line_items where job_sync_id in (%1$L,%2$L))::text || ''/'' || '
    '(select count(*) from change_orders where job_sync_id in (%1$L,%2$L))::text || ''/'' || '
    '(select count(*) from expenses where job_sync_id in (%1$L,%2$L))::text', jB, jU), '2/2/2');

  -- ======================================================================
  -- 4x  The crew doors are read-only (the hard-delete hole)
  -- ======================================================================
  perform pg_temp.x('40 CREW      delete a job through jobs_crew', uCRW, format('delete from jobs_crew where sync_id = %L', jA), 'ERR 42501');
  perform pg_temp.x('41 CREW      update a job through jobs_crew', uCRW, format('update jobs_crew set notes = ''x'' where sync_id = %L', jA), 'ERR 42501');
  perform pg_temp.x('42 CREW      insert a shift through time_entries_crew', uCRW,
    format('insert into time_entries_crew(company_id,sync_id,job_sync_id,employee_sync_id,started_at) values (%L,gen_random_uuid(),%L,%L,now())', SC, jA, eCRW), 'ERR 42501');
  perform pg_temp.x('43 CREW      delete a shift through time_entries_crew', uCRW, 'delete from time_entries_crew', 'ERR 42501');
  perform pg_temp.x('44 CREW      delete through estimate_line_items_crew', uCRW, 'delete from estimate_line_items_crew', 'ERR 42501');
  perform pg_temp.x('45 CREW      delete through change_orders_crew', uCRW, 'delete from change_orders_crew', 'ERR 42501');
  perform pg_temp.x('46 CREW      delete through material_items_crew', uCRW, 'delete from material_items_crew', 'ERR 42501');
  perform pg_temp.s('47 OFFICE    job A and its shifts are all still there', format(
    'select (select count(*) from jobs where sync_id = %L)::text || ''/'' || (select count(*) from time_entries where company_id = %L)::text', jA, SC), '1/3');

  -- ======================================================================
  -- 5x  Nobody writes the two new tables directly
  -- ======================================================================
  perform pg_temp.x('50 CREW      insert job_assignments directly', uCRW,
    format('insert into job_assignments(company_id,job_sync_id,employee_sync_id,kind) values (%L,%L,%L,''ACCESS'')', SC, jU, eCRW), 'ERR 42501');
  perform pg_temp.x('51 CREW      insert job_access_requests directly', uCRW,
    format('insert into job_access_requests(company_id,job_sync_id,requested_by,employee_sync_id,status) values (%L,%L,%L,%L,''APPROVED'')', SC, jU, uCRW, eCRW), 'ERR 42501');
  perform pg_temp.x('52 MANAGER   insert job_assignments directly (RPCs only, for everyone)', uMGR,
    format('insert into job_assignments(company_id,job_sync_id,employee_sync_id,kind) values (%L,%L,%L,''CREW'')', SC, jU, eCR2), 'ERR 42501');
  perform pg_temp.x('53 CREW      update job_access_requests directly', uCRW, 'update job_access_requests set status = ''APPROVED''', 'ERR 42501');
  perform pg_temp.x('54 CREW      delete job_assignments directly', uCRW, 'delete from job_assignments', 'ERR 42501');

  -- ======================================================================
  -- 6x  Asking for a job
  -- ======================================================================
  perform pg_temp.p('60 UNLINKED  ask for a job', uUNL, format('select request_job_access(%L)::text', jU), 'ERR 23514');
  perform pg_temp.p('61 MANAGER   ask for a job (already sees all)', uMGR, format('select request_job_access(%L)::text', jU), 'ERR 22023');
  perform pg_temp.p('62 CREW      ask for their own job', uCRW, format('select request_job_access(%L)::text', jA), 'ERR 22023');
  perform pg_temp.p('63 CREW      ask for another company''s job', uCRW, format('select request_job_access(%L)::text', jO), 'ERR 23503');
  perform pg_temp.a('64 ANON      ask for a job', format('select request_job_access(%L)::text', jU), 'ERR 42501');
  perform pg_temp.p('65 CREW      ask for job U', uCRW, format('select request_job_access(%L, ''I was on site Tuesday'')::text', jU),
    '~^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
  select id into rid1 from job_access_requests where company_id = SC and job_sync_id = jU and requested_by = uCRW;
  perform pg_temp.p('66 CREW      ask again: same request, not a second one', uCRW, format('select request_job_access(%L)::text', jU), rid1::text);
  perform pg_temp.p('67 CREW      reads own requests', uCRW, 'select count(*)::text from job_access_requests', '1');
  perform pg_temp.p('68 CREW TWO  reads nobody else''s requests', uCR2, 'select count(*)::text from job_access_requests', '0');
  perform pg_temp.p('69 MANAGER   reads the request (positive control)', uMGR, 'select count(*)::text from job_access_requests', '1');
  perform pg_temp.p('6a CREW      my_job_scope sees_all/linked/visible/pending', uCRW,
    'select concat_ws(''/'', my_job_scope()->>''sees_all'', my_job_scope()->>''linked'', my_job_scope()->>''visible'', my_job_scope()->>''pending_requests'')',
    'false/true/1/1');
  perform pg_temp.p('6b CREW      requestable list shows U as PENDING', uCRW,
    format('select coalesce(my_request_status, ''none'') from list_requestable_jobs() where job_sync_id = %L', jU), 'PENDING');
  perform pg_temp.p('6c CREW      requestable list offers B (won, not theirs)', uCRW,
    format('select count(*)::text from list_requestable_jobs() where job_sync_id = %L', jB), '1');
  perform pg_temp.p('6d CREW      requestable list leaves out their own job', uCRW,
    format('select count(*)::text from list_requestable_jobs() where job_sync_id = %L', jA), '0');
  perform pg_temp.p('6e CREW      requestable list leaves out a draft', uCRW,
    format('select count(*)::text from list_requestable_jobs() where job_sync_id = %L', jQ), '0');
  perform pg_temp.p('6h CREW      ask for a DRAFT (the list never offers it)', uCRW, format('select request_job_access(%L)::text', jQ), 'ERR 23503');
  perform pg_temp.p('6f MANAGER   requestable list is empty (sees all)', uMGR, 'select count(*)::text from list_requestable_jobs()', '0');
  perform pg_temp.s('6g OFFICE    requestable list carries no money, phone or email',
    'select (pg_get_function_result(''public.list_requestable_jobs()''::regprocedure) !~* ''phone|email|total|price|amount|paid|cost|rate|deposit|fee'')::text', 'true');

  -- ======================================================================
  -- 7x  Answering
  -- ======================================================================
  perform pg_temp.p('70 CREW TWO  approve someone''s request', uCR2, format('select decide_job_access(%L, true)::text', rid1), 'ERR 42501');
  perform pg_temp.p('71 OTHER CO  owner approves this company''s request', uOTH, format('select decide_job_access(%L, true)::text', rid1), 'ERR 23503');
  update profiles set permission_overrides = '+SCHEDULE_AND_ASSIGN' where id = uCRW;
  perform pg_temp.p('72 CREW promoted: holds SCHEDULE_AND_ASSIGN (property for 73)', uCRW, 'select has_permission(''SCHEDULE_AND_ASSIGN'')::text', 'true');
  perform pg_temp.p('73 CREW promoted: approve their OWN request', uCRW, format('select decide_job_access(%L, true)::text', rid1), 'ERR 42501');
  update profiles set permission_overrides = '' where id = uCRW;
  perform pg_temp.p('74 CREW      still only A before the answer', uCRW, jobs_q, 'A');
  perform pg_temp.p('75 MANAGER   approves', uMGR, format('select decide_job_access(%L, true, ''ok'')::text', rid1), 'true');
  perform pg_temp.p('76 MANAGER   approves again: nothing changes', uMGR, format('select decide_job_access(%L, true)::text', rid1), 'false');
  perform pg_temp.p('77 CREW      now sees A and U', uCRW, jobs_q, 'A,U');
  perform pg_temp.p('78 CREW      sees the grant in job_assignments', uCRW, 'select count(*)::text || ''/'' || min(kind) from job_assignments', '1/ACCESS');
  perform pg_temp.p('79 CREW      U''s runs arrive too', uCRW, format(child_q, 'fence_runs'), 'A,U');
  perform pg_temp.p('7a CREW TWO  the grant was not theirs', uCR2, jobs_q, 'B');
  perform pg_temp.p('7b CREW      asks for B', uCRW, format('select request_job_access(%L)::text', jB), '~^[0-9a-f-]{36}$');
  select id into rid2 from job_access_requests where company_id = SC and job_sync_id = jB and requested_by = uCRW;
  perform pg_temp.p('7c FOREMAN   denies', uFOR, format('select decide_job_access(%L, false, ''not this week'')::text', rid2), 'true');
  perform pg_temp.p('7d CREW      a denial grants nothing', uCRW, jobs_q, 'A,U');
  perform pg_temp.s('7e OFFICE    no assignment row for the denial',
    format('select count(*)::text from job_assignments where job_sync_id = %L and employee_sync_id = %L', jB, eCRW), '0');
  perform pg_temp.p('7f CREW      sees the answer on B', uCRW,
    format('select my_request_status from list_requestable_jobs() where job_sync_id = %L', jB), 'DENIED');

  -- ======================================================================
  -- 8x  Putting people on jobs, taking them off, and the sweep
  -- ======================================================================
  perform pg_temp.s('80 SWEEP     X (dated, nobody on it) is flagged',
    format('select count(*)::text from attention_sweep_candidates() where detector = ''unassigned_scheduled'' and job_sync_id = %L', jX), '1');
  perform pg_temp.s('81 SWEEP     N is flagged (canary: the sweep is looking at this company)',
    format('select count(*)::text from attention_sweep_candidates() where detector = ''unassigned_scheduled'' and job_sync_id = %L', jN), '1');
  perform pg_temp.s('82 SWEEP     A has a lead, so it is NOT "nobody assigned"',
    format('select count(*)::text from attention_sweep_candidates() where detector = ''unassigned_scheduled'' and job_sync_id = %L', jA), '0');
  perform pg_temp.p('83 CREW      put someone on a job', uCRW, format('select set_job_crew(%L, array[%L]::uuid[])::text', jX, eCR2), 'ERR 42501');
  perform pg_temp.p('84 FOREMAN   puts crew two on X', uFOR, format('select set_job_crew(%L, array[%L]::uuid[])::text', jX, eCR2), '1');
  perform pg_temp.p('85 CREW TWO  now sees B and X', uCR2, jobs_q, 'B,X');
  perform pg_temp.s('86 SWEEP     X is no longer flagged',
    format('select count(*)::text from attention_sweep_candidates() where detector = ''unassigned_scheduled'' and job_sync_id = %L', jX), '0');
  perform pg_temp.s('86b SWEEP    N still flagged (canary)',
    format('select count(*)::text from attention_sweep_candidates() where detector = ''unassigned_scheduled'' and job_sync_id = %L', jN), '1');
  perform pg_temp.p('87 FOREMAN   clears X''s extra crew', uFOR, format('select set_job_crew(%L, array[]::uuid[])::text', jX), '0');
  perform pg_temp.s('88 OFFICE    the row is kept, ended (total/open)',
    format('select count(*)::text || ''/'' || count(*) filter (where ended_at is null)::text from job_assignments where job_sync_id = %L', jX), '1/0');
  perform pg_temp.p('89 CREW TWO  X is gone from their phone', uCR2, jobs_q, 'B');
  perform pg_temp.s('8a SWEEP     X is flagged again',
    format('select count(*)::text from attention_sweep_candidates() where detector = ''unassigned_scheduled'' and job_sync_id = %L', jX), '1');
  select id into aid from job_assignments where job_sync_id = jU and employee_sync_id = eCRW and kind = 'ACCESS';
  perform pg_temp.p('8b CREW      end an assignment', uCRW, format('select end_job_assignment(%L)::text', aid), 'ERR 42501');
  perform pg_temp.p('8c MANAGER   takes the grant on U back', uMGR, format('select end_job_assignment(%L)::text', aid), 'true');
  perform pg_temp.p('8d CREW      back to A only', uCRW, jobs_q, 'A');
  perform pg_temp.s('8e OFFICE    the grant row is kept, ended',
    format('select count(*)::text from job_assignments where id = %L and ended_at is not null', aid), '1');
  perform pg_temp.p('8f MANAGER   ending it twice changes nothing', uMGR, format('select end_job_assignment(%L)::text', aid), 'false');
  perform pg_temp.p('8g FOREMAN   put crew on another company''s job', uFOR, format('select set_job_crew(%L, array[%L]::uuid[])::text', jO, eCR2), 'ERR 23503');
  perform pg_temp.p('8h FOREMAN   a crew record with no login can be put on a job', uFOR, format('select set_job_crew(%L, array[%L]::uuid[])::text', jN, eLONE), '1');
  perform pg_temp.s('8i SWEEP     ...and that counts as assigned',
    format('select count(*)::text from attention_sweep_candidates() where detector = ''unassigned_scheduled'' and job_sync_id = %L', jN), '0');

  -- ======================================================================
  -- 9x  The crew pens
  -- ======================================================================
  perform pg_temp.p('90 CREW      save their job, trying to reassign and reschedule it', uCRW,
    format('select crew_save_job(%L::jsonb)::text', json_build_object('sync_id', jA, 'assigned_employee_sync_id', eCR2,
           'scheduled_date', '2031-01-01T00:00:00Z', 'locate_notes', 'probe crew note')), 'true');
  perform pg_temp.s('91 OFFICE    assignee and date unchanged, the note landed (the write happened)',
    format('select assigned_employee_sync_id || ''|'' || to_char(scheduled_date at time zone ''UTC'', ''YYYY-MM-DD'') || ''|'' || locate_notes from jobs where sync_id = %L', jA),
    eCRW::text || '|2030-06-01|probe crew note');
  perform pg_temp.p('92 CREW      save a job they are not on', uCRW,
    format('select crew_save_job(%L::jsonb)::text', json_build_object('sync_id', jB, 'locate_notes', 'x')), 'ERR 42501');
  perform pg_temp.c('93 HELPER    strip keeps who-and-when for SCHEDULE_AND_ASSIGN (positive)', uMGR,
    'select (crew_strip_assignment(''{"assigned_employee_sync_id":"x","scheduled_date":"2030-01-01","locate_notes":"y"}''::jsonb) ?& array[''assigned_employee_sync_id'',''scheduled_date''])::text', 'true');
  perform pg_temp.c('94 HELPER    strip drops who-and-when for crew, keeps the rest', uCRW,
    'select (crew_strip_assignment(''{"assigned_employee_sync_id":"x","scheduled_date":"2030-01-01","locate_notes":"y"}''::jsonb))::text', '{"locate_notes": "y"}');
  perform pg_temp.p('95 CREW      push two lines, one on a job they are not on', uCRW,
    format('select crew_push_line_items(%L::jsonb)::text', json_build_array(
      json_build_object('sync_id','c5600001-0000-4000-8000-000000000001','job_sync_id',jA,'description','probe line','quantity',3,'unit_price',999),
      json_build_object('sync_id','c5600002-0000-4000-8000-000000000002','job_sync_id',jB,'description','probe line','quantity',3))),
    case when r6_lines then '0' else '1' end);
  perform pg_temp.s('96 OFFICE    only the line on their job landed, and without their price',
    'select (select count(*) from estimate_line_items where sync_id = ''c5600001-0000-4000-8000-000000000001'' and coalesce(unit_price, 0) <> 999)::text || ''/'' || '
    '(select count(*) from estimate_line_items where sync_id = ''c5600002-0000-4000-8000-000000000002'')::text',
    case when r6_lines then '0/0' else '1/0' end);
  perform pg_temp.p('9a CREW      push U''s line by its id, re-pointed at their own job', uCRW,
    format('select crew_push_line_items(%L::jsonb)::text', json_build_array(
      json_build_object('sync_id',lU,'job_sync_id',jA,'description','moved by crew','quantity',1))), '0');
  perform pg_temp.s('9b OFFICE    that line is still on U, as it was',
    format('select job_sync_id::text || ''|'' || description from estimate_line_items where sync_id = %L', lU), jU::text || '|line');
  perform pg_temp.p('9c CREW      re-push the line already on their job (positive: it still updates, or r6 no-op)', uCRW,
    format('select crew_push_line_items(%L::jsonb)::text', json_build_array(
      json_build_object('sync_id',lA,'job_sync_id',jA,'description','edited on the phone','quantity',2))),
    case when r6_lines then '0' else '1' end);
  perform pg_temp.s('9d OFFICE    the edit landed',
    format('select description from estimate_line_items where sync_id = %L', lA),
    case when r6_lines then 'line' else 'edited on the phone' end);
  perform pg_temp.p('97 CREW      move a job they are not on through the build', uCRW, format('select set_production_stage(%L, ''DIG'')::text', jB), 'ERR 42501');
  perform pg_temp.p('98 CREW      move their own job (positive)', uCRW, format('select set_production_stage(%L, ''DIG'')::text', jA), 'true');
  perform pg_temp.p('99 FOREMAN   moves any job (positive)', uFOR, format('select set_production_stage(%L, ''DIG'')::text', jB), 'true');

  -- ======================================================================
  -- 10x  A worked shift always uploads; the crew door shows only your own
  -- ======================================================================
  perform pg_temp.x('100 CREW     clock a shift on U, which they have lost', uCRW,
    format('insert into time_entries(company_id,sync_id,job_sync_id,employee_sync_id,started_at,ended_at,notes,updated_at) '
           'values (%L,''c5500004-0000-4000-8000-000000000004'',%L,%L,now()-interval ''3 hours'',now()-interval ''2 hours'','''',now())', SC, jU, eCRW), 'rows=1');
  perform pg_temp.x('101 CREW     clock a shift on B, never theirs', uCRW,
    format('insert into time_entries(company_id,sync_id,job_sync_id,employee_sync_id,started_at,ended_at,notes,updated_at) '
           'values (%L,''c5500005-0000-4000-8000-000000000005'',%L,%L,now()-interval ''5 hours'',now()-interval ''4 hours'','''',now())', SC, jB, eCRW), 'rows=1');
  perform pg_temp.x('102 CREW     re-push that shift as the app does (upsert)', uCRW,
    format('insert into time_entries(company_id,sync_id,job_sync_id,employee_sync_id,started_at,ended_at,notes,updated_at) '
           'values (%L,''c5500005-0000-4000-8000-000000000005'',%L,%L,now()-interval ''5 hours'',now()-interval ''3 hours'','''',now()) '
           'on conflict (company_id, sync_id) do update set ended_at = excluded.ended_at', SC, jB, eCRW), 'rows=1');
  perform pg_temp.s('103 OFFICE   both shifts are in, the re-push landed',
    'select count(*)::text || ''/'' || count(*) filter (where ended_at > now() - interval ''3 hours 1 minute'' and ended_at < now() - interval ''2 hours 59 minutes'' and job_sync_id = ''c5300002-0000-4000-8000-000000000002'')::text '
    'from time_entries where sync_id in (''c5500004-0000-4000-8000-000000000004'',''c5500005-0000-4000-8000-000000000005'')', '2/1');
  perform pg_temp.p('104 CREW     time_entries_crew: own / anyone else''s', uCRW,
    format('select count(*) filter (where employee_sync_id = %L)::text || ''/'' || count(*) filter (where employee_sync_id <> %L)::text from time_entries_crew', eCRW, eCRW), '3/0');
  perform pg_temp.p('105 CREW TWO time_entries_crew: own / anyone else''s', uCR2,
    format('select count(*) filter (where employee_sync_id = %L)::text || ''/'' || count(*) filter (where employee_sync_id <> %L)::text from time_entries_crew', eCR2, eCR2), '2/0');
  perform pg_temp.p('106 FOREMAN  time_entries_crew: every shift (approver, positive)', uFOR, 'select count(*)::text from time_entries_crew', '5');
  perform pg_temp.p('107 FOREMAN -SCHEDULE_AND_ASSIGN still approves, still sees every shift', uFSC, 'select count(*)::text from time_entries_crew', '5');
  perform pg_temp.p('108 MANAGER  base time_entries: every shift', uMGR, 'select count(*)::text from time_entries', '5');

  -- ======================================================================
  -- 11x  Withdrawing
  -- ======================================================================
  perform pg_temp.p('110 CREW     asks for X', uCRW, format('select request_job_access(%L)::text', jX), '~^[0-9a-f-]{36}$');
  select id into rid3 from job_access_requests where company_id = SC and job_sync_id = jX and requested_by = uCRW;
  perform pg_temp.p('111 CREW TWO withdraws someone else''s request', uCR2, format('select withdraw_job_access_request(%L)::text', rid3), 'false');
  perform pg_temp.p('112 CREW     withdraws their own', uCRW, format('select withdraw_job_access_request(%L)::text', rid3), 'true');
  perform pg_temp.p('113 CREW     withdrawing twice changes nothing', uCRW, format('select withdraw_job_access_request(%L)::text', rid3), 'false');

  -- ======================================================================
  -- 12x  Limits
  -- ======================================================================
  -- Three asks so far this hour (U, B, X). The hourly limit is ten, so seven
  -- more go through and the eighth is refused as "the last hour".
  for i in 1..25 loop
    perform pg_temp.p('.rate', uCRW,
      format('select request_job_access(%L)::text', ('c5300100-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid), null);
  end loop;
  select count(*) filter (where got !~ '^ERR') into n_ok from r where k = '.rate';
  select got into first_err from r where k = '.rate' and got ~ '^ERR' order by n limit 1;
  delete from r where k = '.rate';
  insert into r(k,got,want) values ('120 CREW     hourly limit: asks accepted | refusal | says "last hour"',
    n_ok || '|' || coalesce(substr(first_err, 5, 5), 'none') || '|' || coalesce((first_err ~ 'last hour')::text, 'false'),
    '7|54000|true');
  -- Push every ask back two hours, then top the waiting list up to twenty
  -- by hand: the next ask must meet the OTHER limit.
  update job_access_requests set created_at = created_at - interval '2 hours' where requested_by = uCRW;
  insert into job_access_requests(company_id, job_sync_id, requested_by, employee_sync_id, status, created_at)
  select SC, ('c5300100-0000-4000-8000-' || lpad(gs.k::text, 12, '0'))::uuid, uCRW, eCRW, 'PENDING', now() - interval '2 hours'
    from generate_series(8, 20) gs(k);
  perform pg_temp.s('121 OFFICE   property: twenty waiting',
    format('select count(*)::text from job_access_requests where requested_by = %L and status = ''PENDING''', uCRW), '20');
  perform pg_temp.p('122 CREW     a 21st ask is refused', uCRW,
    format('select request_job_access(%L)::text', 'c5300100-0000-4000-8000-000000000021'::uuid), '~^ERR 54000: You already have 20');
  select id into pending_id from job_access_requests
   where requested_by = uCRW and job_sync_id = 'c5300100-0000-4000-8000-000000000001' and status = 'PENDING';
  perform pg_temp.p('123 CREW     re-asking a job already waiting still answers, at the limit', uCRW,
    format('select request_job_access(%L)::text', 'c5300100-0000-4000-8000-000000000001'::uuid), pending_id::text);

  -- ======================================================================
  -- 13x  The app's scope answer, and the anonymous caller
  -- ======================================================================
  perform pg_temp.a('130 ANON     my_job_scope', 'select my_job_scope()::text', 'ERR 42501');
  perform pg_temp.a('131 ANON     list_requestable_jobs', 'select count(*)::text from list_requestable_jobs()', 'ERR 42501');
  perform pg_temp.p('132 UNLINKED my_job_scope sees_all/linked/visible', uUNL,
    'select concat_ws(''/'', my_job_scope()->>''sees_all'', my_job_scope()->>''linked'', my_job_scope()->>''visible'')', 'false/false/0');
  perform pg_temp.p('133 MANAGER  my_job_scope sees_all', uMGR, 'select my_job_scope()->>''sees_all''', 'true');

  -- ======================================================================
  -- 14x  What is installed
  -- ======================================================================
  perform pg_temp.s('140 INSTALL  the three pens carry the guard',
    'select (position(''crew_job_guard'' in pg_get_functiondef(''public.crew_save_job(jsonb)''::regprocedure)) > 0
         and position(''can_see_job'' in pg_get_functiondef(''public.crew_push_line_items(jsonb)''::regprocedure)) > 0
         and position(''crew_job_guard'' in pg_get_functiondef(''public.set_production_stage(text,text)''::regprocedure)) > 0)::text', 'true');
  perform pg_temp.s('141 INSTALL  job-change-push listens to the real assignee column',
    'select bool_and(position(''assigned_employee_sync_id'' in pg_get_triggerdef(t.oid)) > 0)::text from pg_trigger t
      where t.tgrelid = ''public.jobs''::regclass and t.tgname = ''job-change-push''', 'true');
  perform pg_temp.s('142 INSTALL  no time_entries policy depends on job visibility',
    'select (not exists (select 1 from pg_policies where schemaname = ''public'' and tablename = ''time_entries''
       and (coalesce(qual, '''') || coalesce(with_check, '''')) ~ ''my_visible_job_sync_ids|can_see_job|sees_all_jobs''))::text', 'true');
  perform pg_temp.s('143 INSTALL  crew_push_line_items checks the line''s current job too',
    'select (position(''can_see_job(e.job_sync_id)'' in pg_get_functiondef(''public.crew_push_line_items(jsonb)''::regprocedure)) > 0)::text', 'true');
  perform pg_temp.s('144 INSTALL  request_job_access counts its limits under a lock',
    'select (position(''pg_advisory_xact_lock'' in pg_get_functiondef(''public.request_job_access(uuid,text)''::regprocedure)) > 0)::text', 'true');

  -- ======================================================================
  -- 15x  Switched off in the office: jobs leave the phone, shifts still upload
  -- ======================================================================
  update employees set is_active = false where id = eCR2;
  perform pg_temp.p('150 CREW TWO switched off: sees no job', uCR2, jobs_q, '-');
  perform pg_temp.p('151 CREW TWO switched off: my_job_scope linked', uCR2, 'select my_job_scope()->>''linked''', 'false');
  perform pg_temp.p('152 CREW TWO switched off: cannot ask for a job', uCR2, format('select request_job_access(%L)::text', jU), 'ERR 23514');
  perform pg_temp.x('153 CREW TWO switched off: a worked shift still uploads', uCR2,
    format('insert into time_entries(company_id,sync_id,job_sync_id,employee_sync_id,started_at,ended_at,notes,updated_at) '
           'values (%L,''c5500006-0000-4000-8000-000000000006'',%L,%L,now()-interval ''7 hours'',now()-interval ''6 hours'','''',now())', SC, jB, eCR2), 'rows=1');
  perform pg_temp.p('154 CREW     still active: still sees A (positive control)', uCRW, jobs_q, 'A');

  -- ======================================================================
  -- 16x  A kept job the office deletes (deleted_job_sync_ids)
  -- ======================================================================
  -- U was granted to the crew member and taken back (8c), so their phone
  -- keeps it and jobs_crew no longer sends it -- not even as a tombstone.
  -- They ask about U, their own A and the other company's O. Nothing is
  -- deleted yet (the control), then the owners delete U and O: only U comes
  -- back -- never a live job, never another company's.
  perform pg_temp.p('160 CREW     kept-job deletions, before any delete', uCRW,
    format('select coalesce(string_agg(l.l, '','' order by l.l), ''-'') from deleted_job_sync_ids(array[%L,%L,%L]::uuid[]) d join lbl l on l.s = d', jU, jA, jO), '-');
  perform pg_temp.x('161 OWNER    deletes U', uOWN, format('update jobs set deleted_at = now() where sync_id = %L', jU), 'rows=1');
  perform pg_temp.x('162 OTHER CO owner deletes O', uOTH, format('update jobs set deleted_at = now() where sync_id = %L', jO), 'rows=1');
  perform pg_temp.p('163 CREW     jobs_crew sends no tombstone for U (why the phone must ask)', uCRW,
    format('select count(*)::text from jobs_crew where sync_id = %L', jU), '0');
  perform pg_temp.p('164 CREW     kept-job deletions: U, not A, not the other company''s O', uCRW,
    format('select coalesce(string_agg(l.l, '','' order by l.l), ''-'') from deleted_job_sync_ids(array[%L,%L,%L]::uuid[]) d join lbl l on l.s = d', jU, jA, jO), 'U');
  perform pg_temp.p('165 CREW     an empty ask answers nothing', uCRW,
    'select count(*)::text from deleted_job_sync_ids(array[]::uuid[])', '0');
  perform pg_temp.a('166 ANON     kept-job deletions', format('select count(*)::text from deleted_job_sync_ids(array[%L]::uuid[])', jU), 'ERR 42501');
end $body$;

select n, case when ok then 'PASS' else 'FAIL' end as result, k as check_name, got, want
  from (select n, k, got, want,
               coalesce(got = want
                        or (want like 'ERR %' and got like want || '%')
                        or (want like '~%' and got ~ substr(want, 2)), false) as ok
          from r) t
union all
select 1000000, 'SUMMARY',
       'passed/total',
       (select count(*) filter (where coalesce(got = want
                                  or (want like 'ERR %' and got like want || '%')
                                  or (want like '~%' and got ~ substr(want, 2)), false))::text
               || '/' || count(*)::text from r),
       (select count(*)::text || '/' || count(*)::text from r)
 order by 1;

rollback;


-- ----------------------------------------------------------------------
-- WHO IS NOT LINKED YET -- run on its own, read-only. Counts only, no
-- names: the owner links people in the office (Crew tab -> Linked login),
-- never by script, because a wrong link shows someone another person's
-- jobs and shifts.
--
-- select c.name as company,
--        count(*) filter (where p.role = 'CREW')                                   as crew_logins,
--        count(*) filter (where p.role = 'CREW' and e.id is null)                  as crew_logins_not_linked,
--        count(*) filter (where p.role <> 'CREW' and e.id is null)                 as other_logins_not_linked,
--        (select count(*) from employees x where x.company_id = c.id and x.deleted_at is null
--            and x.profile_id is null)                                             as crew_records_without_login,
--        (select count(*) from jobs j where j.company_id = c.id and j.deleted_at is null
--            and coalesce(j.assigned_employee_sync_id, '') <> '')                  as jobs_with_a_lead
--   from companies c
--   join profiles p on p.company_id = c.id
--   left join employees e on e.company_id = c.id and e.profile_id = p.id and e.deleted_at is null
--  group by c.id, c.name
--  order by c.name;
