-- P2 / crew data exposure + job-write permissions -- CANARY, run BEFORE the fixes.
--
-- Reproduces, live, every hole the three patches close. Every subject is
-- created inside the transaction and the whole thing is rolled back: no real
-- row is read into a decision and none is written. Each attack is scored by
-- AFFECTED ROW COUNT and by reading the value back -- "no error" is not proof.
--
-- Positive controls are interleaved on purpose:
--   * OWNER (has EDIT_JOBS) must succeed at everything the crew must not, so a
--     later "0 rows" cannot be a broken fixture reading as a passing guard.
--   * customer_name is ALREADY pinned by protect_customer_identity(), so a CREW
--     write of it must come back unchanged even now. If that one ever shows a
--     change, the harness itself is wrong.
--   * has_permission() is asserted per role before any attack, so each subject
--     is picked by property, not by name.
--   * is_platform_admin is false on every synthetic profile -- the real owner
--     account is also a platform admin, and that flag would fake a pass.
begin;

create temp table r(n serial, k text, v text);
grant all on r to authenticated, anon;
grant usage on sequence r_n_seq to authenticated, anon;

-- Run q as uid, impersonating a PostgREST caller. The role is reset before the
-- result is written, so the temp table is never touched as `authenticated`.
create function pg_temp.p(label text, uid uuid, q text) returns void language plpgsql as $fn$
declare v text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub',uid,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  begin execute q into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR: ' || left(sqlerrm,120); end;
  execute 'reset role';
  perform set_config('request.jwt.claims','',true);
  insert into r(k,v) values (label,v);
end $fn$;

-- Same, with no request context at all: the maintenance / direct-connection door.
create function pg_temp.s(label text, q text) returns void language plpgsql as $fn$
declare v text;
begin
  perform set_config('request.jwt.claims','',true);
  begin execute q into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR: ' || left(sqlerrm,120); end;
  insert into r(k,v) values (label,v);
end $fn$;

do $body$
declare
  SC    uuid := 'e0000001-0000-4000-8000-000000000001';
  uOWN  uuid := 'e1000001-0000-4000-8000-000000000001';
  uCRW  uuid := 'e1000002-0000-4000-8000-000000000002';
  uACC  uuid := 'e1000003-0000-4000-8000-000000000003';
  eCRW  uuid := 'e2000001-0000-4000-8000-000000000001';
  jREAL uuid := 'e3000001-0000-4000-8000-000000000001';  -- ordinary signed job
  jFIX  uuid := 'e3000002-0000-4000-8000-000000000002';  -- ZZ TEST fixture
  jNEW  uuid := 'e3000003-0000-4000-8000-000000000003';  -- nothing signed yet
  REALSIG text; FORGE text; RFSO text; FFSO text;
begin
  perform set_config('request.jwt.claims','',true);
  REALSIG := SC::text||'/'||jREAL::text||'/signature/REAL-sig.png';
  FORGE   := SC::text||'/'||jREAL::text||'/signature/CREW-injected.png';
  RFSO    := SC::text||'/'||jREAL::text||'/final-sign-off/REAL-fso.png';
  FFSO    := SC::text||'/'||jREAL::text||'/final-sign-off/CREW-injected.png';

  insert into auth.users(id,email) values
    (uOWN,'p2-owner@probe.invalid'),(uCRW,'p2-crew@probe.invalid'),(uACC,'p2-acct@probe.invalid');
  insert into companies(id,name,subscription_status,subscription_plan,suspended,trial_ends_at,
                        admin_notes,leads_token,stripe_customer_id,invited_email,suspended_reason)
  values (SC,'PROBE-P2','active','pro',false,now()+interval '30 days','',gen_random_uuid(),'cus_P2','','');
  insert into profiles(id,company_id,full_name,role,is_platform_admin,permission_overrides) values
    (uOWN,SC,'P2 Owner','OWNER',false,''),
    (uCRW,SC,'P2 Crew','CREW',false,''),
    (uACC,SC,'P2 Acct','ACCOUNTANT',false,'');
  insert into employees(id,company_id,name,sync_id,hourly_rate,pay_type,profile_id,is_active)
  values (eCRW,SC,'P2 Crew',eCRW,20.00,'HOURLY',uCRW,true);

  insert into jobs(id,company_id,customer_name,address,phone,email,hoa_email,status,sync_id,
                   contract_total,quote_token,signature_storage_path,signed_at,signed_contract_total,
                   signed_linear_feet,final_sign_off_storage_path,final_sign_off_at,
                   is_test_fixture,notes,assigned_employee_sync_id)
  values
    (jREAL,SC,'REAL CUSTOMER','1 Real St','555-0001','real-customer@probe.invalid','hoa@probe.invalid',
     'ACCEPTED',jREAL,9000,gen_random_uuid(),REALSIG,now()-interval '1 day',9000,180,
     RFSO,now()-interval '2 hours',false,'real note',eCRW::text),
    (jFIX,SC,'ZZ TEST FIXTURE','2 Test St','555-0002','fixture@probe.invalid','',
     'DRAFT',jFIX,0,gen_random_uuid(),null,null,0,0,null,null,true,'',eCRW::text),
    (jNEW,SC,'FRESH CUSTOMER','3 New St','555-0003','fresh@probe.invalid','',
     'DRAFT',jNEW,0,gen_random_uuid(),null,null,0,0,null,null,false,'',eCRW::text);

  -- The re-approval the office raised. Written with no request context so
  -- hold_reapproval_columns() lets it through, exactly as the real trigger does.
  update jobs set reapproval_required_at = now()-interval '30 minutes',
                  reapproval_reason = 'DO NOT BUILD: layout changed',
                  reapproval_count = 2
   where sync_id = jREAL;

  ------------------------------------------------------------------ subjects
  perform pg_temp.p('00 CREW  perms MONEY/EDIT_JOBS/FIELD', uCRW,
    'select has_permission(''SEE_MONEY'')::text||''/''||has_permission(''EDIT_JOBS'')::text||''/''||has_permission(''RECORD_FIELD_WORK'')::text');
  perform pg_temp.p('01 ACCT  perms MONEY/EDIT_JOBS/FIELD', uACC,
    'select has_permission(''SEE_MONEY'')::text||''/''||has_permission(''EDIT_JOBS'')::text||''/''||has_permission(''RECORD_FIELD_WORK'')::text');
  perform pg_temp.p('02 OWNER perms MONEY/EDIT_JOBS/FIELD', uOWN,
    'select has_permission(''SEE_MONEY'')::text||''/''||has_permission(''EDIT_JOBS'')::text||''/''||has_permission(''RECORD_FIELD_WORK'')::text');

  -------------------------------------------- A. test jobs reach crew phones
  perform pg_temp.p('A1 CREW jobs_crew rows visible (3 = leak)', uCRW,
    'select count(*)::text from jobs_crew');
  perform pg_temp.p('A2 CREW sees the ZZ TEST fixture (1 = leak)', uCRW,
    format('select count(*)::text from jobs_crew where sync_id=%L', jFIX));
  perform pg_temp.p('A3 CREW sees its REAL job (must stay 1)', uCRW,
    format('select count(*)::text from jobs_crew where sync_id=%L', jREAL));
  perform pg_temp.p('A4 CREW base table jobs is closed (expect 0)', uCRW,
    'select count(*)::text from jobs');

  --------------------------------------- B. re-approval never reaches crew
  perform pg_temp.p('B1 CREW reads reapproval_reason from jobs_crew', uCRW,
    format('select reapproval_reason from jobs_crew where sync_id=%L', jREAL));
  perform pg_temp.p('B2 CREW reads reapproval_required_at from jobs_crew', uCRW,
    format('select reapproval_required_at::text from jobs_crew where sync_id=%L', jREAL));
  perform pg_temp.p('B3 CREW reads reapproval_count from jobs_crew', uCRW,
    format('select reapproval_count::text from jobs_crew where sync_id=%L', jREAL));
  -- Exactly the JSON a crew phone sends. SyncJson has encodeDefaults=true, so
  -- the non-null defaults "" and 0 go on the wire; the null timestamp is
  -- dropped by explicitNulls=false. crew_save_job is SECURITY DEFINER, so
  -- current_user is postgres inside it and hold_reapproval_columns() -- which
  -- only pins for current_user in (authenticated, anon) -- does not fire.
  perform pg_temp.p('B4 CREW crew_save_job with the phone reapproval defaults', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''reapproval_reason'','''',''reapproval_count'',0,''notes'',''field note''))::text', jREAL));
  perform pg_temp.s('B5 reapproval reason|count after that push',
    format('select coalesce(nullif(reapproval_reason,''''),''<BLANKED>'')||'' | ''||reapproval_count::text from jobs where sync_id=%L', jREAL));
  perform pg_temp.s('B6 restore reapproval state',
    format('with u as (update jobs set reapproval_reason=''DO NOT BUILD: layout changed'', reapproval_count=2 where sync_id=%L returning 1) select count(*)::text from u', jREAL));

  -------------------------------------------------------- C. customer identity
  perform pg_temp.p('C1 CREW crew_save_job sets jobs.email', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''email'',''crew-attacker@probe.invalid''))::text', jREAL));
  perform pg_temp.s('C2 email after CREW push',
    format('select email from jobs where sync_id=%L', jREAL));
  perform pg_temp.p('C3 CREW crew_save_job sets hoa_email', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''hoa_email'',''crew-hoa@probe.invalid''))::text', jREAL));
  perform pg_temp.s('C4 hoa_email after CREW push',
    format('select hoa_email from jobs where sync_id=%L', jREAL));
  perform pg_temp.p('C5 ACCOUNTANT direct UPDATE jobs.email (rows)', uACC,
    format('with u as (update jobs set email=''acct-attacker@probe.invalid'' where sync_id=%L returning 1) select count(*)::text from u', jREAL));
  perform pg_temp.s('C6 email after ACCOUNTANT update',
    format('select email from jobs where sync_id=%L', jREAL));
  perform pg_temp.p('C7 CONTROL CREW crew_save_job sets customer_name', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''customer_name'',''CREW RENAMED''))::text', jREAL));
  perform pg_temp.s('C8 CONTROL customer_name after (must be REAL CUSTOMER)',
    format('select customer_name from jobs where sync_id=%L', jREAL));
  perform pg_temp.p('C9 POSITIVE OWNER direct UPDATE jobs.email (rows)', uOWN,
    format('with u as (update jobs set email=''office-corrected@probe.invalid'' where sync_id=%L returning 1) select count(*)::text from u', jREAL));
  perform pg_temp.s('C10 POSITIVE email after OWNER update',
    format('select email from jobs where sync_id=%L', jREAL));

  --------------------------------------------------------- D. contract forging
  perform pg_temp.p('D1 CREW crew_save_job repoints signature_storage_path', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''signature_storage_path'',%L))::text', jREAL, FORGE));
  perform pg_temp.s('D2 signature FILE after CREW push',
    format('select split_part(signature_storage_path,''/'',4) from jobs where sync_id=%L', jREAL));
  perform pg_temp.p('D3 CREW crew_save_job signs an unsigned job', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''signed_at'',now(),''signed_linear_feet'',250))::text', jNEW));
  perform pg_temp.s('D4 unsigned job signed_at after',
    format('select coalesce(signed_at::text,''STILL NULL'')||'' | ft=''||signed_linear_feet::text from jobs where sync_id=%L', jNEW));
  perform pg_temp.p('D5 CREW crew_save_job repoints final_sign_off_storage_path', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''final_sign_off_storage_path'',%L))::text', jREAL, FFSO));
  perform pg_temp.s('D6 final sign-off FILE after CREW push',
    format('select split_part(final_sign_off_storage_path,''/'',4) from jobs where sync_id=%L', jREAL));
  perform pg_temp.p('D7 ACCOUNTANT direct UPDATE clears signed_at (rows)', uACC,
    format('with u as (update jobs set signed_at=null where sync_id=%L returning 1) select count(*)::text from u', jREAL));
  perform pg_temp.s('D8 signed_at after ACCOUNTANT update',
    format('select coalesce(signed_at::text,''CLEARED'') from jobs where sync_id=%L', jREAL));
  perform pg_temp.p('D9 ACCOUNTANT direct UPDATE repoints signature (rows)', uACC,
    format('with u as (update jobs set signature_storage_path=''x/x/signature/ACCT-FORGED.png'' where sync_id=%L returning 1) select count(*)::text from u', jREAL));
  perform pg_temp.s('D10 signature FILE after ACCOUNTANT update',
    format('select split_part(signature_storage_path,''/'',4) from jobs where sync_id=%L', jREAL));

  -- Legitimate field work that MUST keep working after the fix.
  perform pg_temp.p('D11 LEGIT CREW first final sign-off on a fresh job', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''final_sign_off_at'',now(),''final_sign_off_storage_path'',%L))::text',
           jNEW, SC::text||'/'||jNEW::text||'/final-sign-off/crew-captured.png'));
  perform pg_temp.s('D12 LEGIT fresh job sign-off after',
    format('select coalesce(split_part(final_sign_off_storage_path,''/'',4),''NONE'')||'' | ''||coalesce(final_sign_off_at::text,''NULL'') from jobs where sync_id=%L', jNEW));
  perform pg_temp.p('D13 LEGIT CREW saves ordinary job fields', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''notes'',''crew updated note'',''blocked_reason'',''gate locked''))::text', jREAL));
  perform pg_temp.s('D14 LEGIT notes|blocked_reason after',
    format('select notes||'' | ''||blocked_reason from jobs where sync_id=%L', jREAL));
  perform pg_temp.p('D15 POSITIVE OWNER writes a real signature (rows)', uOWN,
    format('with u as (update jobs set signature_storage_path=''ok/ok/signature/office-real.png'', signed_at=now(), signed_linear_feet=181 where sync_id=%L returning 1) select count(*)::text from u', jREAL));
  perform pg_temp.s('D16 POSITIVE signature after OWNER write',
    format('select split_part(signature_storage_path,''/'',4)||'' | ''||coalesce(signed_at::text,''NULL'')||'' | ft=''||signed_linear_feet::text from jobs where sync_id=%L', jREAL));

  ------------------------------------------- E. the fixture flag itself
  -- A fixture row that reached a phone before the view was filtered is still
  -- on that phone, and CloudJob.isTestFixture defaults to false with
  -- encodeDefaults=true -- so the ordinary push carries is_test_fixture:false
  -- and crew_save_job writes it, turning the office's own test row back into a
  -- real job. Same shape as B4: a default on the wire read as an assertion.
  perform pg_temp.p('E1 CREW crew_save_job pushes is_test_fixture:false', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''is_test_fixture'',false,''notes'',''pushed''))::text', jFIX));
  perform pg_temp.s('E2 fixture flag after CREW push',
    format('select case when is_test_fixture then ''STILL A FIXTURE'' else ''<CLEARED>'' end from jobs where sync_id=%L', jFIX));
end $body$;

select jsonb_pretty(jsonb_agg(jsonb_build_array(n,k,v) order by n)) as probe from r;
rollback;
