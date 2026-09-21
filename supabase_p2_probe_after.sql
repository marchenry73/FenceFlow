-- P2 / crew data exposure + job-write permissions -- PROOF, run AFTER the three
-- patches. Same synthetic subjects, same attacks as supabase_p2_probe_before.sql,
-- now with an expected value per line so the output reads PASS/FAIL instead of
-- needing interpretation. Rolled back; nothing real is touched.
--
-- Two things make this proof stronger than "0 rows":
--
--  * The pins HOLD, they do not refuse -- deliberately, because a crew phone
--    pushes the whole job row and refusing would throw away a day of field
--    work. So a forbidden UPDATE still reports 1 row. Every forbidden write
--    below therefore changes an ALLOWED column in the same statement, and that
--    column is asserted to have moved. A pinned value plus a moved neighbour
--    proves the statement reached the row and only the guarded column was
--    held. A bare "0 rows" could just as easily be a broken fixture.
--  * Roles with EDIT_JOBS must still succeed at all of it. MANAGER is included
--    beside OWNER so the guard is proved to key on the PERMISSION, not on
--    being the owner.
begin;

create temp table r(n serial, k text, got text, want text, verdict text);
grant all on r to authenticated, anon;
grant usage on sequence r_n_seq to authenticated, anon;

create function pg_temp.expect(label text, uid uuid, q text, want text) returns void language plpgsql as $fn$
declare v text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub',uid,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  begin execute q into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR: ' || left(sqlerrm,110); end;
  execute 'reset role';
  perform set_config('request.jwt.claims','',true);
  insert into r(k,got,want,verdict) values (label, v, want, case when v = want then 'PASS' else 'FAIL' end);
end $fn$;

-- Read back with no request context: the value as the office and the database
-- really hold it, not as the attacker's own session is allowed to see it.
create function pg_temp.expects(label text, q text, want text) returns void language plpgsql as $fn$
declare v text;
begin
  perform set_config('request.jwt.claims','',true);
  begin execute q into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR: ' || left(sqlerrm,110); end;
  insert into r(k,got,want,verdict) values (label, v, want, case when v = want then 'PASS' else 'FAIL' end);
end $fn$;

create function pg_temp.setrole(uid uuid, nr text) returns void language plpgsql as $fn$
begin
  perform set_config('request.jwt.claims','',true);
  update public.profiles set role = nr::public.user_role, is_platform_admin = false,
         permission_overrides = '' where id = uid;
end $fn$;

do $body$
declare
  SC    uuid := 'e0000001-0000-4000-8000-000000000001';
  uOWN  uuid := 'e1000001-0000-4000-8000-000000000001';
  uCRW  uuid := 'e1000002-0000-4000-8000-000000000002';
  uACC  uuid := 'e1000003-0000-4000-8000-000000000003';
  uFOR  uuid := 'e1000004-0000-4000-8000-000000000004';
  uMGR  uuid := 'e1000005-0000-4000-8000-000000000005';
  eCRW  uuid := 'e2000001-0000-4000-8000-000000000001';
  jREAL uuid := 'e3000001-0000-4000-8000-000000000001';
  jFIX  uuid := 'e3000002-0000-4000-8000-000000000002';
  jNEW  uuid := 'e3000003-0000-4000-8000-000000000003';
  REALSIG text; FORGE text; RFSO text; FFSO text; NEWFSO text;
begin
  perform set_config('request.jwt.claims','',true);
  REALSIG := SC::text||'/'||jREAL::text||'/signature/REAL-sig.png';
  FORGE   := SC::text||'/'||jREAL::text||'/signature/CREW-injected.png';
  RFSO    := SC::text||'/'||jREAL::text||'/final-sign-off/REAL-fso.png';
  FFSO    := SC::text||'/'||jREAL::text||'/final-sign-off/CREW-injected.png';
  NEWFSO  := SC::text||'/'||jNEW::text||'/final-sign-off/crew-captured.png';

  insert into auth.users(id,email) values
    (uOWN,'p2-owner@probe.invalid'),(uCRW,'p2-crew@probe.invalid'),(uACC,'p2-acct@probe.invalid'),
    (uFOR,'p2-foreman@probe.invalid'),(uMGR,'p2-mgr@probe.invalid');
  insert into companies(id,name,subscription_status,subscription_plan,suspended,trial_ends_at,
                        admin_notes,leads_token,stripe_customer_id,invited_email,suspended_reason)
  values (SC,'PROBE-P2','active','pro',false,now()+interval '30 days','',gen_random_uuid(),'cus_P2','','');
  insert into profiles(id,company_id,full_name,role,is_platform_admin,permission_overrides) values
    (uOWN,SC,'P2 Owner','OWNER',false,''),
    (uCRW,SC,'P2 Crew','CREW',false,''),
    (uACC,SC,'P2 Acct','ACCOUNTANT',false,''),
    (uFOR,SC,'P2 Foreman','FOREMAN',false,''),
    (uMGR,SC,'P2 Manager','MANAGER',false,'');
  insert into employees(id,company_id,name,sync_id,hourly_rate,pay_type,profile_id,is_active)
  values (eCRW,SC,'P2 Crew',eCRW,20.00,'HOURLY',uCRW,true);

  insert into jobs(id,company_id,customer_name,address,phone,email,hoa_email,status,sync_id,
                   contract_total,quote_token,signature_storage_path,signed_at,signed_contract_total,
                   signed_linear_feet,final_sign_off_storage_path,final_sign_off_at,
                   is_test_fixture,notes,blocked_reason,assigned_employee_sync_id)
  values
    (jREAL,SC,'REAL CUSTOMER','1 Real St','555-0001','real-customer@probe.invalid','hoa@probe.invalid',
     'ACCEPTED',jREAL,9000,gen_random_uuid(),REALSIG,'2026-09-01 12:00:00+00',9000,180,
     RFSO,'2026-09-02 12:00:00+00',false,'real note','',eCRW::text),
    (jFIX,SC,'ZZ TEST FIXTURE','2 Test St','555-0002','fixture@probe.invalid','',
     'DRAFT',jFIX,0,gen_random_uuid(),null,null,0,0,null,null,true,'','',eCRW::text),
    (jNEW,SC,'FRESH CUSTOMER','3 New St','555-0003','fresh@probe.invalid','',
     'DRAFT',jNEW,0,gen_random_uuid(),null,null,0,0,null,null,false,'','',eCRW::text);

  update jobs set reapproval_required_at = '2026-09-20 09:00:00+00',
                  reapproval_reason = 'DO NOT BUILD: layout changed',
                  reapproval_count = 2
   where sync_id = jREAL;

  -- The office seed path still works with no request context (migrations,
  -- backups, the reapproval trigger itself). If this ever fails, the pins have
  -- caught the wrong caller.
  perform pg_temp.expects('00 SETUP office wrote the re-approval state',
    format('select reapproval_reason||'' | ''||reapproval_count::text from jobs where sync_id=%L', jREAL),
    'DO NOT BUILD: layout changed | 2');

  ------------------------------------------------------------------ subjects
  perform pg_temp.expect('01 CREW  perms MONEY/EDIT_JOBS/FIELD', uCRW,
    'select has_permission(''SEE_MONEY'')::text||''/''||has_permission(''EDIT_JOBS'')::text||''/''||has_permission(''RECORD_FIELD_WORK'')::text',
    'false/false/true');
  perform pg_temp.expect('02 FOREMAN perms MONEY/EDIT_JOBS/FIELD', uFOR,
    'select has_permission(''SEE_MONEY'')::text||''/''||has_permission(''EDIT_JOBS'')::text||''/''||has_permission(''RECORD_FIELD_WORK'')::text',
    'false/false/true');
  perform pg_temp.expect('03 ACCT  perms MONEY/EDIT_JOBS/FIELD', uACC,
    'select has_permission(''SEE_MONEY'')::text||''/''||has_permission(''EDIT_JOBS'')::text||''/''||has_permission(''RECORD_FIELD_WORK'')::text',
    'true/false/false');
  perform pg_temp.expect('04 MGR   perms MONEY/EDIT_JOBS/FIELD', uMGR,
    'select has_permission(''SEE_MONEY'')::text||''/''||has_permission(''EDIT_JOBS'')::text||''/''||has_permission(''RECORD_FIELD_WORK'')::text',
    'true/true/true');
  perform pg_temp.expect('05 OWNER perms MONEY/EDIT_JOBS/FIELD', uOWN,
    'select has_permission(''SEE_MONEY'')::text||''/''||has_permission(''EDIT_JOBS'')::text||''/''||has_permission(''RECORD_FIELD_WORK'')::text',
    'true/true/true');

  ------------------------------------- A. FIX 1: test jobs out of the field
  perform pg_temp.expect('A1 CREW jobs_crew row count (was 3)', uCRW,
    'select count(*)::text from jobs_crew', '2');
  perform pg_temp.expect('A2 CREW cannot see the ZZ TEST fixture', uCRW,
    format('select count(*)::text from jobs_crew where sync_id=%L', jFIX), '0');
  perform pg_temp.expect('A3 FOREMAN cannot see the ZZ TEST fixture', uFOR,
    format('select count(*)::text from jobs_crew where sync_id=%L', jFIX), '0');
  perform pg_temp.expect('A4 LEGIT CREW still sees its real job', uCRW,
    format('select customer_name from jobs_crew where sync_id=%L', jREAL), 'REAL CUSTOMER');
  perform pg_temp.expect('A5 LEGIT CREW still sees the other real job', uCRW,
    format('select customer_name from jobs_crew where sync_id=%L', jNEW), 'FRESH CUSTOMER');
  perform pg_temp.expect('A6 CREW base table jobs still closed', uCRW,
    'select count(*)::text from jobs', '0');
  perform pg_temp.expect('A7 LEGIT office still sees the fixture on jobs', uOWN,
    format('select count(*)::text from jobs where sync_id=%L', jFIX), '1');
  perform pg_temp.expect('A8 no money column reached jobs_crew', uCRW,
    'select count(*)::text from information_schema.columns where table_schema=''public'' and table_name=''jobs_crew'' and column_name = any(job_money_columns())',
    '0');

  ------------------------------- B. FIX 2: re-approval reaches the field
  perform pg_temp.expect('B1 CREW reads reapproval_reason', uCRW,
    format('select reapproval_reason from jobs_crew where sync_id=%L', jREAL),
    'DO NOT BUILD: layout changed');
  perform pg_temp.expect('B2 CREW reads reapproval_required_at', uCRW,
    format('select reapproval_required_at::text from jobs_crew where sync_id=%L', jREAL),
    '2026-09-20 09:00:00+00');
  perform pg_temp.expect('B3 CREW reads reapproval_count', uCRW,
    format('select reapproval_count::text from jobs_crew where sync_id=%L', jREAL), '2');
  perform pg_temp.expect('B4 FOREMAN reads reapproval_reason', uFOR,
    format('select reapproval_reason from jobs_crew where sync_id=%L', jREAL),
    'DO NOT BUILD: layout changed');
  -- The clear-to-null case the app relies on: no `?: local` fallback on these
  -- three in mergeOnto, so an office CLEAR propagates as null/''/0.
  perform pg_temp.expects('B5 office clears the re-approval',
    format('with u as (update jobs set reapproval_required_at=null, reapproval_reason='''' where sync_id=%L returning 1) select count(*)::text from u', jREAL),
    '1');
  perform pg_temp.expect('B6 CREW sees the CLEAR (null, not a stale value)', uCRW,
    format('select coalesce(reapproval_required_at::text,''CLEARED'')||'' | ''||coalesce(nullif(reapproval_reason,''''),''<empty>'') from jobs_crew where sync_id=%L', jREAL),
    'CLEARED | <empty>');
  perform pg_temp.expects('B7 restore the re-approval',
    format('with u as (update jobs set reapproval_required_at=''2026-09-20 09:00:00+00'', reapproval_reason=''DO NOT BUILD: layout changed'' where sync_id=%L returning 1) select count(*)::text from u', jREAL),
    '1');
  -- The phone's real push shape: encodeDefaults=true puts "" and 0 on the wire.
  perform pg_temp.expect('B8 CREW push with reapproval defaults is accepted', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''reapproval_reason'','''',''reapproval_count'',0,''notes'',''field note''))::text', jREAL),
    'true');
  perform pg_temp.expects('B9 re-approval SURVIVED that push',
    format('select reapproval_reason||'' | ''||reapproval_count::text from jobs where sync_id=%L', jREAL),
    'DO NOT BUILD: layout changed | 2');
  perform pg_temp.expects('B10 and the legitimate field in it landed',
    format('select notes from jobs where sync_id=%L', jREAL), 'field note');

  --------------------------------- C. FIX 3: the quote link cannot be moved
  perform pg_temp.expect('C1 CREW crew_save_job email is refused', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''email'',''crew-attacker@probe.invalid'',''notes'',''crew rode along''))::text', jREAL),
    'true');
  perform pg_temp.expects('C2 email UNCHANGED',
    format('select email from jobs where sync_id=%L', jREAL), 'real-customer@probe.invalid');
  perform pg_temp.expects('C3 CONTROL the same push DID move notes',
    format('select notes from jobs where sync_id=%L', jREAL), 'crew rode along');
  perform pg_temp.expect('C4 FOREMAN crew_save_job email is refused', uFOR,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''email'',''foreman-attacker@probe.invalid''))::text', jREAL),
    'true');
  perform pg_temp.expects('C5 email still UNCHANGED',
    format('select email from jobs where sync_id=%L', jREAL), 'real-customer@probe.invalid');
  perform pg_temp.expect('C6 CREW crew_save_job hoa_email is refused', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''hoa_email'',''crew-hoa@probe.invalid''))::text', jREAL),
    'true');
  perform pg_temp.expects('C7 hoa_email UNCHANGED',
    format('select hoa_email from jobs where sync_id=%L', jREAL), 'hoa@probe.invalid');
  perform pg_temp.expect('C8 ACCOUNTANT direct UPDATE email (rows, holds)', uACC,
    format('with u as (update jobs set email=''acct-attacker@probe.invalid'', blocked_reason=''acct rode along'' where sync_id=%L returning 1) select count(*)::text from u', jREAL),
    '1');
  perform pg_temp.expects('C9 email UNCHANGED after ACCOUNTANT',
    format('select email from jobs where sync_id=%L', jREAL), 'real-customer@probe.invalid');
  perform pg_temp.expects('C10 CONTROL that same UPDATE DID move blocked_reason',
    format('select blocked_reason from jobs where sync_id=%L', jREAL), 'acct rode along');
  perform pg_temp.expect('C11 POSITIVE OWNER may still set email (rows)', uOWN,
    format('with u as (update jobs set email=''office-corrected@probe.invalid'' where sync_id=%L returning 1) select count(*)::text from u', jREAL),
    '1');
  perform pg_temp.expects('C12 POSITIVE email moved for OWNER',
    format('select email from jobs where sync_id=%L', jREAL), 'office-corrected@probe.invalid');
  perform pg_temp.expect('C13 POSITIVE MANAGER may still set email (rows)', uMGR,
    format('with u as (update jobs set email=''real-customer@probe.invalid'' where sync_id=%L returning 1) select count(*)::text from u', jREAL),
    '1');
  perform pg_temp.expects('C14 POSITIVE email moved for MANAGER',
    format('select email from jobs where sync_id=%L', jREAL), 'real-customer@probe.invalid');

  -------------------------------- D. FIX 4: the signed contract is not forgeable
  perform pg_temp.expect('D1 CREW crew_save_job repoints signature', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''signature_storage_path'',%L,''notes'',''crew rode along 2''))::text', jREAL, FORGE),
    'true');
  perform pg_temp.expects('D2 signature FILE UNCHANGED',
    format('select split_part(signature_storage_path,''/'',4) from jobs where sync_id=%L', jREAL),
    'REAL-sig.png');
  perform pg_temp.expects('D3 CONTROL that same push DID move notes',
    format('select notes from jobs where sync_id=%L', jREAL), 'crew rode along 2');
  perform pg_temp.expect('D4 CREW crew_save_job signs an unsigned job', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''signed_at'',now(),''signed_linear_feet'',250))::text', jNEW),
    'true');
  perform pg_temp.expects('D5 unsigned job STILL UNSIGNED',
    format('select coalesce(signed_at::text,''STILL NULL'')||'' | ft=''||signed_linear_feet::text from jobs where sync_id=%L', jNEW),
    'STILL NULL | ft=0');
  perform pg_temp.expect('D6 CREW repoints an EXISTING final sign-off', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''final_sign_off_storage_path'',%L))::text', jREAL, FFSO),
    'true');
  perform pg_temp.expects('D7 final sign-off FILE UNCHANGED (write-once)',
    format('select split_part(final_sign_off_storage_path,''/'',4) from jobs where sync_id=%L', jREAL),
    'REAL-fso.png');
  perform pg_temp.expect('D8 CREW clears an EXISTING final sign-off', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''final_sign_off_at'',null))::text', jREAL),
    'true');
  perform pg_temp.expects('D9 final_sign_off_at NOT cleared',
    format('select final_sign_off_at::text from jobs where sync_id=%L', jREAL),
    '2026-09-02 12:00:00+00');
  perform pg_temp.expect('D10 FOREMAN crew_save_job repoints signature', uFOR,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''signature_storage_path'',%L))::text', jREAL, FORGE),
    'true');
  perform pg_temp.expects('D11 signature FILE still UNCHANGED',
    format('select split_part(signature_storage_path,''/'',4) from jobs where sync_id=%L', jREAL),
    'REAL-sig.png');
  perform pg_temp.expect('D12 ACCOUNTANT clears signed_at (rows, holds)', uACC,
    format('with u as (update jobs set signed_at=null, blocked_reason=''acct rode along 2'' where sync_id=%L returning 1) select count(*)::text from u', jREAL),
    '1');
  perform pg_temp.expects('D13 signed_at UNCHANGED',
    format('select signed_at::text from jobs where sync_id=%L', jREAL), '2026-09-01 12:00:00+00');
  perform pg_temp.expects('D14 CONTROL that same UPDATE DID move blocked_reason',
    format('select blocked_reason from jobs where sync_id=%L', jREAL), 'acct rode along 2');
  perform pg_temp.expect('D15 ACCOUNTANT repoints signature (rows, holds)', uACC,
    format('with u as (update jobs set signature_storage_path=''x/x/signature/ACCT-FORGED.png'' where sync_id=%L returning 1) select count(*)::text from u', jREAL),
    '1');
  perform pg_temp.expects('D16 signature FILE UNCHANGED after ACCOUNTANT',
    format('select split_part(signature_storage_path,''/'',4) from jobs where sync_id=%L', jREAL),
    'REAL-sig.png');
  perform pg_temp.expect('D17 ACCOUNTANT repoints final sign-off (rows, holds)', uACC,
    format('with u as (update jobs set final_sign_off_storage_path=''x/x/final-sign-off/ACCT.png'' where sync_id=%L returning 1) select count(*)::text from u', jREAL),
    '1');
  perform pg_temp.expects('D18 final sign-off FILE UNCHANGED after ACCOUNTANT',
    format('select split_part(final_sign_off_storage_path,''/'',4) from jobs where sync_id=%L', jREAL),
    'REAL-fso.png');

  ------------------------------------- legitimate work that must still work
  perform pg_temp.expect('D19 LEGIT CREW first final sign-off (null -> value)', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''final_sign_off_at'',''2026-09-20 17:00:00+00'',''final_sign_off_storage_path'',%L))::text', jNEW, NEWFSO),
    'true');
  perform pg_temp.expects('D20 LEGIT the crew sign-off LANDED',
    format('select split_part(final_sign_off_storage_path,''/'',4)||'' | ''||final_sign_off_at::text from jobs where sync_id=%L', jNEW),
    'crew-captured.png | 2026-09-20 17:00:00+00');
  perform pg_temp.expect('D21 LEGIT CREW saves ordinary job fields', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''notes'',''crew updated note'',''blocked_reason'',''gate locked'',''locate_ticket_no'',''TX-991''))::text', jREAL),
    'true');
  perform pg_temp.expects('D22 LEGIT those fields LANDED',
    format('select notes||'' | ''||blocked_reason||'' | ''||locate_ticket_no from jobs where sync_id=%L', jREAL),
    'crew updated note | gate locked | TX-991');
  perform pg_temp.expect('D23 POSITIVE OWNER writes a real signature (rows)', uOWN,
    format('with u as (update jobs set signature_storage_path=''ok/ok/signature/office-real.png'', signed_at=''2026-09-20 18:00:00+00'', signed_linear_feet=181 where sync_id=%L returning 1) select count(*)::text from u', jREAL),
    '1');
  perform pg_temp.expects('D24 POSITIVE the OWNER signature LANDED',
    format('select split_part(signature_storage_path,''/'',4)||'' | ''||signed_at::text||'' | ft=''||signed_linear_feet::text from jobs where sync_id=%L', jREAL),
    'office-real.png | 2026-09-20 18:00:00+00 | ft=181');
  perform pg_temp.expect('D25 POSITIVE MANAGER writes a real signature (rows)', uMGR,
    format('with u as (update jobs set signature_storage_path=''ok/ok/signature/mgr-real.png'', signed_at=''2026-09-20 19:00:00+00'' where sync_id=%L returning 1) select count(*)::text from u', jREAL),
    '1');
  perform pg_temp.expects('D26 POSITIVE the MANAGER signature LANDED',
    format('select split_part(signature_storage_path,''/'',4)||'' | ''||signed_at::text from jobs where sync_id=%L', jREAL),
    'mgr-real.png | 2026-09-20 19:00:00+00');
  perform pg_temp.expect('D27 POSITIVE MANAGER may repoint the final sign-off (rows)', uMGR,
    format('with u as (update jobs set final_sign_off_storage_path=''ok/ok/final-sign-off/mgr.png'' where sync_id=%L returning 1) select count(*)::text from u', jREAL),
    '1');
  perform pg_temp.expects('D28 POSITIVE that repoint LANDED',
    format('select split_part(final_sign_off_storage_path,''/'',4) from jobs where sync_id=%L', jREAL),
    'mgr.png');

  --------------------------------------------------- E. the fixture flag itself
  -- Accepted -- the push still lands the crew's own field work (notes). Only
  -- the key a phone has no business asserting is dropped. Proof is E2.
  perform pg_temp.expect('E1 CREW push with is_test_fixture:false accepted', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''is_test_fixture'',false,''notes'',''pushed''))::text', jFIX),
    'true');
  perform pg_temp.expects('E2 the fixture is STILL a fixture',
    format('select case when is_test_fixture then ''STILL A FIXTURE'' else ''<CLEARED>'' end from jobs where sync_id=%L', jFIX),
    'STILL A FIXTURE');
  perform pg_temp.expect('E3 POSITIVE OWNER may still mark a job a fixture (rows)', uOWN,
    format('with u as (update jobs set is_test_fixture=true where sync_id=%L returning 1) select count(*)::text from u', jNEW),
    '1');
  perform pg_temp.expects('E4 POSITIVE that flag LANDED',
    format('select is_test_fixture::text from jobs where sync_id=%L', jNEW), 'true');
  perform pg_temp.expect('E5 and that job left the crew view at once', uCRW,
    format('select count(*)::text from jobs_crew where sync_id=%L', jNEW), '0');

  --------------------------------- F. nothing here broke company isolation
  perform pg_temp.setrole(uCRW, 'CREW');
  perform pg_temp.expects('F1 jobs_crew still filters by company',
    'select case when position(''current_company_id()'' in pg_get_viewdef(''public.jobs_crew''::regclass, true)) > 0 then ''YES'' else ''NO'' end',
    'YES');
  perform pg_temp.expects('F2 jobs_crew still filters suspended companies',
    'select case when position(''company_is_suspended()'' in pg_get_viewdef(''public.jobs_crew''::regclass, true)) > 0 then ''YES'' else ''NO'' end',
    'YES');
  perform pg_temp.expects('F3 jobs_crew column count (61 + 4 new)',
    'select count(*)::text from information_schema.columns where table_schema=''public'' and table_name=''jobs_crew''',
    '65');
end $body$;

select count(*) filter (where verdict='PASS') as passed,
       count(*) filter (where verdict='FAIL') as failed,
       coalesce(string_agg(k, ' | ') filter (where verdict='FAIL'), 'none') as failures
  from r;
select jsonb_pretty(jsonb_agg(jsonb_build_array(n, verdict, k, got, want) order by n)) as proof from r;
rollback;
