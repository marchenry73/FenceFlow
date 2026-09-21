-- P3 / approve_time_entry -- CANARY + FIX + PRIVACY, one rolled-back transaction.
--
-- Every subject is synthetic and created in-transaction. Every attack is scored
-- by AFFECTED ROW COUNT and by reading the value back through a second, plain
-- connection ("office"), because no error is not proof. Positive controls are
-- interleaved so a later 0 cannot be a broken fixture reading as a passing
-- guard. Roles are asserted by PROPERTY (has_permission) before anything else.
begin;

create temp table r(n serial, k text, v text);
grant all on r to authenticated, anon;
grant usage on sequence r_n_seq to authenticated, anon;

-- Impersonate a PostgREST caller.
create function pg_temp.p(label text, uid uuid, q text) returns void language plpgsql as $fn$
declare v text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub',uid,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  begin execute q into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,150); end;
  execute 'reset role';
  perform set_config('request.jwt.claims','',true);
  insert into r(k,v) values (label,v);
end $fn$;

-- Same, for a statement run for effect only: reports the real row count.
create function pg_temp.x(label text, uid uuid, q text) returns void language plpgsql as $fn$
declare c int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub',uid,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    execute q; get diagnostics c = row_count;
    execute 'reset role'; perform set_config('request.jwt.claims','',true);
    insert into r(k,v) values (label,'rows=' || c); return;
  exception when others then
    execute 'reset role'; perform set_config('request.jwt.claims','',true);
    insert into r(k,v) values (label,'ERR ' || sqlstate || ': ' || left(sqlerrm,150)); return;
  end;
end $fn$;

-- An anonymous phone: role anon, no sub at all.
create function pg_temp.a(label text, q text) returns void language plpgsql as $fn$
declare v text;
begin
  perform set_config('request.jwt.claims', json_build_object('role','anon')::text, true);
  execute 'set local role anon';
  begin execute q into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,150); end;
  execute 'reset role';
  perform set_config('request.jwt.claims','',true);
  insert into r(k,v) values (label,v);
end $fn$;

-- The office / a direct connection, for a statement run for effect only.
create function pg_temp.u(label text, q text) returns void language plpgsql as $fn$
declare c int;
begin
  perform set_config('request.jwt.claims','',true);
  begin execute q; get diagnostics c = row_count;
        insert into r(k,v) values (label,'rows=' || c); return;
  exception when others then
        insert into r(k,v) values (label,'ERR ' || sqlstate || ': ' || left(sqlerrm,150)); return; end;
end $fn$;

-- The office / a direct connection: no request context at all.
create function pg_temp.s(label text, q text) returns void language plpgsql as $fn$
declare v text;
begin
  perform set_config('request.jwt.claims','',true);
  begin execute q into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,150); end;
  insert into r(k,v) values (label,v);
end $fn$;

-- ===========================================================================
-- Fixtures
-- ===========================================================================
do $body$
declare
  SC    uuid := 'f0000001-0000-4000-8000-000000000001';
  SC2   uuid := 'f0000002-0000-4000-8000-000000000002';
  uOWN  uuid := 'f1000001-0000-4000-8000-000000000001';
  uMGR  uuid := 'f1000002-0000-4000-8000-000000000002';
  uFOR  uuid := 'f1000003-0000-4000-8000-000000000003';
  uCRW  uuid := 'f1000004-0000-4000-8000-000000000004';
  uSTR  uuid := 'f1000005-0000-4000-8000-000000000005';  -- MANAGER, -APPROVE_TIME
  uOTH  uuid := 'f1000006-0000-4000-8000-000000000006';  -- owner of the OTHER company
  eFOR  uuid := 'f2000003-0000-4000-8000-000000000003';
  eCRW  uuid := 'f2000004-0000-4000-8000-000000000004';
  eOTH  uuid := 'f2000006-0000-4000-8000-000000000006';
  jJOB  uuid := 'f3000001-0000-4000-8000-000000000001';
  jOTH  uuid := 'f3000002-0000-4000-8000-000000000002';
  tCRW  uuid := 'f4000001-0000-4000-8000-000000000001';  -- colleague's finished shift
  tFOR  uuid := 'f4000002-0000-4000-8000-000000000002';  -- the foreman's own shift
  tRUN  uuid := 'f4000005-0000-4000-8000-000000000005';  -- still running
  tDEL  uuid := 'f4000006-0000-4000-8000-000000000006';  -- soft-deleted
  tOTH  uuid := 'f4000007-0000-4000-8000-000000000007';  -- another company's shift
begin
  perform set_config('request.jwt.claims','',true);

  insert into auth.users(id,email) values
    (uOWN,'p3-own@probe.invalid'),(uMGR,'p3-mgr@probe.invalid'),
    (uFOR,'p3-for@probe.invalid'),(uCRW,'p3-crw@probe.invalid'),
    (uSTR,'p3-str@probe.invalid'),(uOTH,'p3-oth@probe.invalid');
  insert into companies(id,name,subscription_status,subscription_plan,suspended,trial_ends_at,
                        admin_notes,leads_token,stripe_customer_id,invited_email,suspended_reason) values
    (SC ,'PROBE-P3','active','pro',false,now()+interval '30 days','',gen_random_uuid(),'cus_P3','',''),
    (SC2,'PROBE-P3-OTHER','active','pro',false,now()+interval '30 days','',gen_random_uuid(),'cus_P3b','','');
  insert into profiles(id,company_id,full_name,role,is_platform_admin,permission_overrides) values
    (uOWN,SC ,'P3 Owner'  ,'OWNER'  ,false,''),
    (uMGR,SC ,'P3 Manager','MANAGER',false,''),
    (uFOR,SC ,'P3 Foreman','FOREMAN',false,''),
    (uCRW,SC ,'P3 Crew'   ,'CREW'   ,false,''),
    (uSTR,SC ,'P3 Stripped','MANAGER',false,'-APPROVE_TIME'),
    (uOTH,SC2,'P3 Other'  ,'OWNER'  ,false,'');
  insert into employees(id,company_id,name,sync_id,hourly_rate,pay_type,profile_id,is_active) values
    (eFOR,SC ,'P3 Foreman',eFOR,33.00,'HOURLY',uFOR,true),
    (eCRW,SC ,'P3 Crew'   ,eCRW,21.50,'HOURLY',uCRW,true),
    (eOTH,SC2,'P3 Other'  ,eOTH,99.00,'HOURLY',uOTH,true);
  insert into jobs(id,company_id,customer_name,address,phone,email,status,sync_id,contract_total,
                   quote_token,is_test_fixture,notes,assigned_employee_sync_id) values
    (jJOB,SC ,'P3 CUSTOMER','9 Probe Way','555-0900','p3@probe.invalid','ACCEPTED',jJOB,5000,
     gen_random_uuid(),false,'',eCRW::text),
    (jOTH,SC2,'P3 OTHER CUSTOMER','1 Other Rd','555-0901','p3b@probe.invalid','ACCEPTED',jOTH,4000,
     gen_random_uuid(),false,'',eOTH::text);
  insert into time_entries(id,company_id,sync_id,job_sync_id,employee_sync_id,started_at,ended_at,
                           hourly_rate,notes,updated_at,deleted_at) values
    (tCRW,SC ,tCRW,jJOB,eCRW::text,now()-interval '9 hours',now()-interval '1 hour',21.50,'',now(),null),
    (tFOR,SC ,tFOR,jJOB,eFOR::text,now()-interval '9 hours',now()-interval '1 hour',33.00,'',now(),null),
    (tRUN,SC ,tRUN,jJOB,eCRW::text,now()-interval '2 hours',null                   ,21.50,'',now(),null),
    (tDEL,SC ,tDEL,jJOB,eCRW::text,now()-interval '30 hours',now()-interval '25 hours',21.50,'',now(),now()),
    (tOTH,SC2,tOTH,jOTH,eOTH::text,now()-interval '9 hours',now()-interval '1 hour',99.00,'',now(),null);

  ------------------------------------------------ subjects, picked by property
  perform pg_temp.p('00 FOREMAN  APPROVE_TIME/SEE_PAY/SEE_MONEY', uFOR,
    'select has_permission(''APPROVE_TIME'')::text||''/''||has_permission(''SEE_PAY'')::text||''/''||has_permission(''SEE_MONEY'')::text');
  perform pg_temp.p('01 MANAGER  APPROVE_TIME/SEE_PAY/SEE_MONEY', uMGR,
    'select has_permission(''APPROVE_TIME'')::text||''/''||has_permission(''SEE_PAY'')::text||''/''||has_permission(''SEE_MONEY'')::text');
  perform pg_temp.p('02 CREW     APPROVE_TIME/SEE_PAY/SEE_MONEY', uCRW,
    'select has_permission(''APPROVE_TIME'')::text||''/''||has_permission(''SEE_PAY'')::text||''/''||has_permission(''SEE_MONEY'')::text');
  perform pg_temp.p('03 OWNER    APPROVE_TIME/SEE_PAY/SEE_MONEY', uOWN,
    'select has_permission(''APPROVE_TIME'')::text||''/''||has_permission(''SEE_PAY'')::text||''/''||has_permission(''SEE_MONEY'')::text');
  perform pg_temp.p('04 STRIPPED MANAGER -APPROVE_TIME: APPROVE_TIME/SEE_PAY', uSTR,
    'select has_permission(''APPROVE_TIME'')::text||''/''||has_permission(''SEE_PAY'')::text');
  perform pg_temp.p('05 FOREMAN is_my_shift(colleague)/is_my_shift(own)', uFOR,
    format('select is_my_shift(%L)::text||''/''||is_my_shift(%L)::text', eCRW::text, eFOR::text));

  -- =========================================================================
  -- BEFORE -- the canary. The function does not exist yet.
  -- =========================================================================
  perform pg_temp.p('10 BEFORE FOREMAN sees colleague shift in time_entries (0 = hidden)', uFOR,
    format('select count(*)::text from time_entries where sync_id=%L', tCRW));
  perform pg_temp.p('11 BEFORE FOREMAN sees it in time_entries_crew (the crew door)', uFOR,
    format('select count(*)::text from time_entries_crew where sync_id=%L', tCRW));
  perform pg_temp.p('12 BEFORE MANAGER sees it in time_entries (positive control)', uMGR,
    format('select count(*)::text from time_entries where sync_id=%L', tCRW));

  perform pg_temp.x('13 BEFORE FOREMAN plain UPDATE approves colleague', uFOR,
    format('update time_entries set approved_at=now(), approved_by=''P3 Foreman'' where sync_id=%L', tCRW));
  perform pg_temp.s('14 BEFORE office reads approved_at (silent no-op)',
    format('select coalesce(approved_at::text,''STILL NULL'') from time_entries where sync_id=%L', tCRW));

  perform pg_temp.x('15 BEFORE FOREMAN push shape (upsert) approves colleague  <== THE 42501', uFOR,
    format($q$insert into time_entries (company_id, sync_id, job_sync_id, employee_sync_id,
                hourly_rate, notes, started_at, ended_at, approved_at, approved_by, rejected_at, review_note)
             values (%L,%L,%L,%L,0,'',now()-interval '9 hours',now()-interval '1 hour',now(),'P3 Foreman',null,'looks right')
             on conflict (company_id, sync_id) do update
                set approved_at = excluded.approved_at, approved_by = excluded.approved_by,
                    rejected_at = excluded.rejected_at, review_note = excluded.review_note$q$,
           SC, tCRW, jJOB, eCRW::text));
  perform pg_temp.x('16 BEFORE FOREMAN push shape with NO approval columns (ordinary sync)', uFOR,
    format($q$insert into time_entries (company_id, sync_id, job_sync_id, employee_sync_id,
                hourly_rate, notes, started_at, ended_at)
             values (%L,%L,%L,%L,0,'',now()-interval '9 hours',now()-interval '1 hour')
             on conflict (company_id, sync_id) do update set notes = excluded.notes$q$,
           SC, tCRW, jJOB, eCRW::text));
  perform pg_temp.x('17 BEFORE FOREMAN insert-only pass on an existing colleague row', uFOR,
    format($q$insert into time_entries (company_id, sync_id, job_sync_id, employee_sync_id,
                hourly_rate, notes, started_at, ended_at)
             values (%L,%L,%L,%L,0,'',now()-interval '9 hours',now()-interval '1 hour')
             on conflict (company_id, sync_id) do nothing$q$,
           SC, tCRW, jJOB, eCRW::text));

  perform pg_temp.x('18 BEFORE POSITIVE MANAGER same push shape approves colleague', uMGR,
    format($q$insert into time_entries (company_id, sync_id, job_sync_id, employee_sync_id,
                hourly_rate, notes, started_at, ended_at, approved_at, approved_by, rejected_at, review_note)
             values (%L,%L,%L,%L,0,'',now()-interval '9 hours',now()-interval '1 hour',now(),'P3 Manager',null,'manager control')
             on conflict (company_id, sync_id) do update
                set approved_at = excluded.approved_at, approved_by = excluded.approved_by,
                    rejected_at = excluded.rejected_at, review_note = excluded.review_note$q$,
           SC, tCRW, jJOB, eCRW::text));
  perform pg_temp.s('19 BEFORE office reads approved_by after the MANAGER control',
    format('select coalesce(approved_at::text,''STILL NULL'')||'' | ''||approved_by from time_entries where sync_id=%L', tCRW));
  perform pg_temp.u('1A reset the colleague shift to pending',
    format('update time_entries set approved_at=null, approved_by='''', rejected_at=null, review_note='''' where sync_id=%L', tCRW));

  perform pg_temp.x('1B BEFORE FOREMAN approves their OWN shift (base table has no own-shift rule)', uFOR,
    format('update time_entries set approved_at=now(), approved_by=''P3 Foreman'' where sync_id=%L', tFOR));
  perform pg_temp.s('1C BEFORE foreman OWN shift approved_at (1 row above = the rule is only a sentence)',
    format('select coalesce(approved_at::text,''STILL NULL'') from time_entries where sync_id=%L', tFOR));
  perform pg_temp.u('1D reset the foreman own shift',
    format('update time_entries set approved_at=null, approved_by='''' where sync_id=%L', tFOR));

  -- privacy, BEFORE, so the AFTER numbers have something to be identical to
  perform pg_temp.p('1E BEFORE FOREMAN reads colleague hourly_rate from time_entries (rows)', uFOR,
    format('select count(*)::text from time_entries where sync_id=%L and hourly_rate is not null', tCRW));
  perform pg_temp.p('1F BEFORE FOREMAN reads hourly_rate from time_entries_crew', uFOR,
    format('select hourly_rate::text from time_entries_crew where sync_id=%L', tCRW));
  perform pg_temp.p('1G BEFORE FOREMAN rows from job_costing()', uFOR,
    'select count(*)::text from job_costing(null,null)');
  perform pg_temp.s('1H BEFORE approve_time_entry exists?',
    'select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=''public'' and p.proname=''approve_time_entry''');
end $body$;

-- ===========================================================================
-- THE FIX, applied inside the same transaction (identical text to
-- supabase_p3_approve_time_entry.sql; the header comments are the file's).
-- ===========================================================================
create or replace function public.approve_time_entry(
    shift_sync_id text,
    approve       boolean,
    note          text default ''
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
    shift    time_entries%rowtype;
    saved    time_entries%rowtype;
    clean    text;
    approver text;
    touched  int;
begin
    if auth.uid() is null then
        raise exception 'Sign in before signing off a shift.'
            using errcode = '42501';
    end if;

    if coalesce(public.company_is_suspended(), true) then
        raise exception 'This company''s subscription is not active. Hours cannot be signed off.'
            using errcode = '42501';
    end if;

    if not coalesce(public.has_permission('APPROVE_TIME'), false) then
        raise exception
            'Approving or rejecting hours needs APPROVE_TIME. What the clock says is payroll.'
            using errcode = '42501';
    end if;

    if approve is null then
        raise exception 'Say whether this shift is approved or rejected.'
            using errcode = '23514';
    end if;

    clean := left(btrim(coalesce(note, '')), 1000);
    if not approve and clean = '' then
        raise exception
            'Say what is wrong with the hours. The crew member reads this, and it is what settles a dispute.'
            using errcode = '23514';
    end if;

    select * into shift
      from public.time_entries t
     where t.sync_id::text = shift_sync_id
       and t.company_id = public.current_company_id()
       and t.deleted_at is null
     limit 1;

    if not found then
        return jsonb_build_object('outcome', 'not_found', 'rows', 0,
                                  'sync_id', shift_sync_id);
    end if;

    if coalesce(public.is_my_shift(shift.employee_sync_id), false) then
        raise exception
            'A shift cannot be signed off by the person being paid for it. Ask somebody else to review it.'
            using errcode = '42501';
    end if;

    if shift.ended_at is null then
        raise exception 'This shift is still running. Clock it out before signing it off.'
            using errcode = '23514';
    end if;

    select coalesce(
             nullif(btrim(p.full_name), ''),
             nullif(btrim(u.email), ''),
             auth.uid()::text)
      into approver
      from public.profiles p
      left join auth.users u on u.id = p.id
     where p.id = auth.uid();
    approver := coalesce(approver, auth.uid()::text);

    update public.time_entries t
       set approved_at = case when approve then now() else null end,
           approved_by = case when approve then approver else '' end,
           rejected_at = case when approve then null else now() end,
           review_note = clean
     where t.id = shift.id
    returning * into saved;
    get diagnostics touched = row_count;

    if touched <> 1 then
        raise exception 'The sign-off did not save. Nothing was changed.'
            using errcode = '25000';
    end if;

    return jsonb_build_object(
        'outcome',     case when approve then 'approved' else 'rejected' end,
        'rows',        touched,
        'sync_id',     saved.sync_id,
        'approved_at', saved.approved_at,
        'approved_by', coalesce(saved.approved_by, ''),
        'rejected_at', saved.rejected_at,
        'review_note', coalesce(saved.review_note, ''));
end;
$fn$;

revoke execute on function public.approve_time_entry(text, boolean, text) from public, anon;
grant  execute on function public.approve_time_entry(text, boolean, text) to authenticated;

-- ===========================================================================
-- AFTER
-- ===========================================================================
do $body$
declare
  uOWN  uuid := 'f1000001-0000-4000-8000-000000000001';
  uMGR  uuid := 'f1000002-0000-4000-8000-000000000002';
  uFOR  uuid := 'f1000003-0000-4000-8000-000000000003';
  uCRW  uuid := 'f1000004-0000-4000-8000-000000000004';
  uSTR  uuid := 'f1000005-0000-4000-8000-000000000005';
  eCRW  uuid := 'f2000004-0000-4000-8000-000000000004';
  eFOR  uuid := 'f2000003-0000-4000-8000-000000000003';
  tCRW  uuid := 'f4000001-0000-4000-8000-000000000001';
  tFOR  uuid := 'f4000002-0000-4000-8000-000000000002';
  tRUN  uuid := 'f4000005-0000-4000-8000-000000000005';
  tDEL  uuid := 'f4000006-0000-4000-8000-000000000006';
  tOTH  uuid := 'f4000007-0000-4000-8000-000000000007';
begin
  ---------------------------------------------------------------- the fix
  perform pg_temp.p('20 AFTER  FOREMAN approve_time_entry(colleague, true)', uFOR,
    format('select approve_time_entry(%L, true, ''Checked against the gate log'')::text', tCRW::text));
  perform pg_temp.s('21 AFTER  THE OFFICE sees it: approved_at | approved_by | review_note',
    format('select coalesce(approved_at::text,''STILL NULL'')||'' | ''||approved_by||'' | ''||review_note from time_entries where sync_id=%L', tCRW));
  perform pg_temp.p('22 AFTER  MANAGER (office reader) sees the approval in time_entries', uMGR,
    format('select coalesce(approved_at::text,''STILL NULL'')||'' | ''||approved_by from time_entries where sync_id=%L', tCRW));
  perform pg_temp.p('23 AFTER  the CREW MEMBER sees it on their own phone (time_entries_crew)', uCRW,
    format('select coalesce(approved_at::text,''STILL NULL'')||'' | ''||approved_by from time_entries_crew where sync_id=%L', tCRW));

  perform pg_temp.p('24 AFTER  FOREMAN rejects the colleague shift with a note', uFOR,
    format('select approve_time_entry(%L, false, ''Clock ran all night -- redo this one'')::text', tCRW::text));
  perform pg_temp.s('25 AFTER  office: rejected_at | approved_at | review_note',
    format('select coalesce(rejected_at::text,''NULL'')||'' | ''||coalesce(approved_at::text,''NULL'')||'' | ''||review_note from time_entries where sync_id=%L', tCRW));
  perform pg_temp.p('26 AFTER  FOREMAN rejects with a BLANK note (must refuse)', uFOR,
    format('select approve_time_entry(%L, false, ''   '')::text', tCRW::text));

  perform pg_temp.p('27 AFTER  FOREMAN approves their OWN shift (must refuse)', uFOR,
    format('select approve_time_entry(%L, true, ''signing my own day off'')::text', tFOR::text));
  perform pg_temp.s('28 AFTER  foreman own shift approved_at (must still be null)',
    format('select coalesce(approved_at::text,''STILL NULL'') from time_entries where sync_id=%L', tFOR));

  perform pg_temp.p('29 AFTER  CREW approves a colleague (must refuse -- no APPROVE_TIME)', uCRW,
    format('select approve_time_entry(%L, true, ''ok by me'')::text', tCRW::text));
  perform pg_temp.p('2A AFTER  CREW approves their OWN shift (must refuse)', uCRW,
    format('select approve_time_entry(%L, true, ''ok by me'')::text', tCRW::text));
  perform pg_temp.p('2B AFTER  MANAGER with -APPROVE_TIME override (must refuse)', uSTR,
    format('select approve_time_entry(%L, true, ''stripped manager'')::text', tCRW::text));

  perform pg_temp.p('2C AFTER  POSITIVE MANAGER approves', uMGR,
    format('select approve_time_entry(%L, true, ''office sign-off'')::text', tCRW::text));
  perform pg_temp.p('2D AFTER  POSITIVE OWNER approves', uOWN,
    format('select approve_time_entry(%L, true, ''owner sign-off'')::text', tCRW::text));
  perform pg_temp.s('2E AFTER  office: who is on it now',
    format('select approved_by||'' | ''||review_note from time_entries where sync_id=%L', tCRW));

  perform pg_temp.a('2F AFTER  anon calls approve_time_entry (must refuse)',
    format('select approve_time_entry(%L, true, ''anon'')::text', tCRW::text));
  perform pg_temp.a('2G AFTER  anon reads the shift at all',
    format('select count(*)::text from time_entries where sync_id=%L', tCRW));

  perform pg_temp.p('2H AFTER  FOREMAN approves a RUNNING shift (must refuse)', uFOR,
    format('select approve_time_entry(%L, true, ''still going'')::text', tRUN::text));
  perform pg_temp.p('2I AFTER  FOREMAN approves a SOFT-DELETED shift (not_found)', uFOR,
    format('select approve_time_entry(%L, true, ''deleted'')::text', tDEL::text));
  perform pg_temp.p('2J AFTER  FOREMAN approves ANOTHER COMPANY''S shift (not_found)', uFOR,
    format('select approve_time_entry(%L, true, ''not mine'')::text', tOTH::text));
  perform pg_temp.p('2K AFTER  FOREMAN approves a sync_id that does not exist (not_found)', uFOR,
    'select approve_time_entry(''f9999999-0000-4000-8000-000000000009'', true, ''nothing there'')::text');
  perform pg_temp.s('2L AFTER  the other company''s shift is untouched',
    format('select coalesce(approved_at::text,''STILL NULL'') from time_entries where sync_id=%L', tOTH));

  -- =======================================================================
  -- PRIVACY, AFTER. The rule that must not have moved by a single row.
  -- =======================================================================
  perform pg_temp.p('30 PRIV FOREMAN rows visible in time_entries, whole company (own shift only)', uFOR,
    'select count(*)::text from time_entries');
  perform pg_temp.p('31 PRIV FOREMAN reads colleague hourly_rate from time_entries (rows)', uFOR,
    format('select count(*)::text from time_entries where sync_id=%L and hourly_rate is not null', tCRW));
  perform pg_temp.p('32 PRIV FOREMAN selects hourly_rate from time_entries_crew', uFOR,
    format('select hourly_rate::text from time_entries_crew where sync_id=%L', tCRW));
  perform pg_temp.p('33 PRIV money-named columns on time_entries_crew (must be 0)', uFOR,
    'select count(*)::text from information_schema.columns where table_schema=''public'' and table_name=''time_entries_crew'' and column_name ~* ''(rate|pay|amount|cost|total|price|wage|earn|money)''');
  perform pg_temp.p('34 PRIV every public view over time_entries FOREMAN can reach, with a money column', uFOR,
    'select count(*)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=''public'' and c.relkind in (''v'',''m'') and pg_get_viewdef(c.oid) ilike ''%time_entries%'' and exists (select 1 from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped and a.attname ~* ''(rate|pay|amount|cost|total|price|wage|earn|money)'')');
  perform pg_temp.p('35 PRIV FOREMAN rows from job_costing() (labour cost)', uFOR,
    'select count(*)::text from job_costing(null,null)');
  perform pg_temp.p('36 PRIV does the RPC answer carry any money key?', uFOR,
    format('select (select string_agg(k,'','' order by k) from jsonb_object_keys(approve_time_entry(%L, true, ''key check'')) k)', tCRW::text));
  perform pg_temp.p('37 PRIV CONTROL FOREMAN reads their OWN rate (is_my_shift, unchanged)', uFOR,
    format('select coalesce((select hourly_rate::text from time_entries where sync_id=%L),''HIDDEN'')', tFOR));
  perform pg_temp.p('38 PRIV CONTROL MANAGER reads the colleague rate (a working fixture)', uMGR,
    format('select coalesce((select hourly_rate::text from time_entries where sync_id=%L),''HIDDEN'')', tCRW));
  perform pg_temp.p('39 PRIV CONTROL CREW reads a COLLEAGUE rate (the foreman''s shift -- must be hidden)', uCRW,
    format('select coalesce((select hourly_rate::text from time_entries where sync_id=%L),''HIDDEN'')', tFOR));
  perform pg_temp.p('3A PRIV CONTROL CREW reads their OWN rate (must still work)', uCRW,
    format('select coalesce((select hourly_rate::text from time_entries where sync_id=%L),''HIDDEN'')', tCRW));
  perform pg_temp.p('3B PRIV FOREMAN rows in audit_log naming hourly_rate', uFOR,
    'select count(*)::text from audit_log where field = ''hourly_rate''');
  perform pg_temp.p('3C PRIV FOREMAN rows in audit_log at all', uFOR,
    'select count(*)::text from audit_log');
  -- Without these two, 3B/3C would be the "empty answer reads as good news"
  -- trap: a zero from a table that simply has nothing in it proves nothing.
  perform pg_temp.s('3C1 CONTROL audit_log rows this transaction actually wrote (office view)',
    'select count(*)::text from audit_log where company_id=''f0000001-0000-4000-8000-000000000001''');
  perform pg_temp.p('3C2 CONTROL MANAGER rows in audit_log (>0, so FOREMAN''s 0 is a guard not an empty table)', uMGR,
    'select count(*)::text from audit_log');
  -- The policy itself: still exactly as strict as it was before this file.
  perform pg_temp.x('3D PRIV the base-table push shape is STILL refused after the fix', uFOR,
    format($q$insert into time_entries (company_id, sync_id, job_sync_id, employee_sync_id,
                hourly_rate, notes, started_at, ended_at, approved_at, approved_by)
             values (%L,%L,%L,%L,0,'',now()-interval '9 hours',now()-interval '1 hour',now(),'P3 Foreman')
             on conflict (company_id, sync_id) do update
                set approved_at = excluded.approved_at$q$,
           'f0000001-0000-4000-8000-000000000001'::uuid, tCRW,
           'f3000001-0000-4000-8000-000000000001'::uuid, eCRW::text));
  perform pg_temp.p('3E PRIV the policy expression, read back unchanged', uFOR,
    'select pg_get_expr(polqual, polrelid) from pg_policy where polname=''time_entries_pay_needs_see_pay''');

  -- =======================================================================
  -- The office's own time_entries write -- dashboard.html saveFixTime.
  -- The ONLY write website/dashboard.html makes to this table (grep:
  -- db.from('time_entries') appears exactly once, at saveFixTime). There is
  -- no office approve path to break. Proved still working, unchanged.
  -- =======================================================================
  perform pg_temp.x('40 OFFICE MANAGER saveFixTime patch (times + reason + break)', uMGR,
    format($q$update time_entries
                set started_at = now() - interval '8 hours',
                    ended_at   = now() - interval '1 hour',
                    correction_reason = 'Clock left running',
                    break_minutes = 30
              where id = (select id from time_entries where sync_id=%L)$q$, tCRW));
  perform pg_temp.s('41 OFFICE correction landed: original_started_at | corrected_by | reason',
    format('select coalesce(original_started_at::text,''NULL'')||'' | ''||coalesce(corrected_by::text,''NULL'')||'' | ''||correction_reason from time_entries where sync_id=%L', tCRW));
  perform pg_temp.x('42 OFFICE CONTROL stripped MANAGER (-APPROVE_TIME) same patch (must refuse)', uSTR,
    format($q$update time_entries
                set started_at = now() - interval '7 hours',
                    correction_reason = 'should be refused'
              where id = (select id from time_entries where sync_id=%L)$q$, tCRW));
end $body$;

select jsonb_pretty(jsonb_agg(jsonb_build_array(n,k,v) order by n)) as p3 from r;
rollback;
