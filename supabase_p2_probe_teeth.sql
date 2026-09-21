-- P2 -- does the proof have teeth?
--
-- supabase_p2_probe_after.sql returns 74/74 PASS. A suite that would pass
-- anyway proves nothing, so this file removes each new guard INSIDE a
-- rolled-back transaction and re-runs the attack it is supposed to stop. Every
-- line here must come back BROKEN. A line that says STILL HELD means the PASS
-- in the proof was being produced by something other than this patch, and the
-- patch is not the thing protecting the contract.
--
-- Nothing is committed: the DDL is rolled back with the data.
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

create function pg_temp.expects(label text, q text, want text) returns void language plpgsql as $fn$
declare v text;
begin
  perform set_config('request.jwt.claims','',true);
  begin execute q into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR: ' || left(sqlerrm,110); end;
  insert into r(k,got,want,verdict) values (label, v, want, case when v = want then 'PASS' else 'FAIL' end);
end $fn$;

do $body$
declare
  SC    uuid := 'e0000001-0000-4000-8000-000000000001';
  uOWN  uuid := 'e1000001-0000-4000-8000-000000000001';
  uCRW  uuid := 'e1000002-0000-4000-8000-000000000002';
  uACC  uuid := 'e1000003-0000-4000-8000-000000000003';
  eCRW  uuid := 'e2000001-0000-4000-8000-000000000001';
  jREAL uuid := 'e3000001-0000-4000-8000-000000000001';
  jFIX  uuid := 'e3000002-0000-4000-8000-000000000002';
begin
  perform set_config('request.jwt.claims','',true);
  insert into auth.users(id,email) values
    (uOWN,'p2-owner@probe.invalid'),(uCRW,'p2-crew@probe.invalid'),(uACC,'p2-acct@probe.invalid');
  insert into companies(id,name,subscription_status,subscription_plan,suspended,trial_ends_at,
                        admin_notes,leads_token,stripe_customer_id,invited_email,suspended_reason)
  values (SC,'PROBE-P2','active','pro',false,now()+interval '30 days','',gen_random_uuid(),'cus_P2','','');
  insert into profiles(id,company_id,full_name,role,is_platform_admin,permission_overrides) values
    (uOWN,SC,'P2 Owner','OWNER',false,''),(uCRW,SC,'P2 Crew','CREW',false,''),
    (uACC,SC,'P2 Acct','ACCOUNTANT',false,'');
  insert into employees(id,company_id,name,sync_id,hourly_rate,pay_type,profile_id,is_active)
  values (eCRW,SC,'P2 Crew',eCRW,20.00,'HOURLY',uCRW,true);
  insert into jobs(id,company_id,customer_name,address,phone,email,status,sync_id,contract_total,
                   quote_token,signature_storage_path,signed_at,is_test_fixture,assigned_employee_sync_id)
  values
    (jREAL,SC,'REAL CUSTOMER','1 Real St','555-0001','real-customer@probe.invalid','ACCEPTED',jREAL,9000,
     gen_random_uuid(), SC::text||'/'||jREAL::text||'/signature/REAL-sig.png','2026-09-01 12:00:00+00',
     false,eCRW::text),
    (jFIX,SC,'ZZ TEST FIXTURE','2 Test St','555-0002','fixture@probe.invalid','DRAFT',jFIX,0,
     gen_random_uuid(),null,null,true,eCRW::text);

  -- Baseline: with everything in place the attacks are held. (If these two
  -- already read BROKEN the transaction is not seeing the patch at all.)
  perform pg_temp.expect('T0a baseline CREW repoints signature', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''signature_storage_path'',''x/x/signature/F.png''))::text', jREAL),
    'true');
  perform pg_temp.expects('T0b baseline signature', format(
    'select case when split_part(signature_storage_path,''/'',4)=''REAL-sig.png'' then ''STILL HELD'' else ''BROKEN'' end from jobs where sync_id=%L', jREAL),
    'STILL HELD');
  perform pg_temp.expect('T0c baseline CREW sees fixture', uCRW,
    format('select case when count(*)=0 then ''STILL HIDDEN'' else ''BROKEN'' end from jobs_crew where sync_id=%L', jFIX),
    'STILL HIDDEN');
end $body$;

-- ---- CANARY 1: neuter the contract pin. The forge must come back. ----------
-- The trigger's FUNCTION is replaced with a pass-through rather than the
-- trigger being dropped. Same effect on behaviour, and it takes no lock on
-- public.jobs -- other tracks are working in this database, and an ACCESS
-- EXCLUSIVE lock on the busiest table is not worth taking to prove a point.
create or replace function public.hold_contract_columns() returns trigger
 language plpgsql security definer set search_path to 'public'
as $function$
begin
    return new;   -- CANARY: the guard removed. Rolled back with everything else.
end;
$function$;

do $body$
declare
  uCRW  uuid := 'e1000002-0000-4000-8000-000000000002';
  uACC  uuid := 'e1000003-0000-4000-8000-000000000003';
  jREAL uuid := 'e3000001-0000-4000-8000-000000000001';
begin
  -- crew_save_job still drops signature_storage_path, so with the trigger gone
  -- the RPC door stays shut -- that is the second layer doing its job, and it
  -- is worth seeing separately from the trigger.
  perform pg_temp.expect('T1a no pin: CREW via crew_save_job', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''signature_storage_path'',''x/x/signature/F.png''))::text', jREAL),
    'true');
  perform pg_temp.expects('T1b   -> RPC drop list alone still holds it', format(
    'select case when split_part(signature_storage_path,''/'',4)=''REAL-sig.png'' then ''STILL HELD'' else ''BROKEN'' end from jobs where sync_id=%L', jREAL),
    'STILL HELD');
  -- The ACCOUNTANT's direct UPDATE has no second layer. This MUST break.
  perform pg_temp.expect('T1c no pin: ACCOUNTANT direct UPDATE (rows)', uACC,
    format('with u as (update jobs set signature_storage_path=''x/x/signature/ACCT-FORGED.png'', signed_at=null where sync_id=%L returning 1) select count(*)::text from u', jREAL),
    '1');
  perform pg_temp.expects('T1d   -> signature MUST be BROKEN without the pin', format(
    'select case when split_part(signature_storage_path,''/'',4)=''REAL-sig.png'' then ''STILL HELD'' else ''BROKEN'' end from jobs where sync_id=%L', jREAL),
    'BROKEN');
  perform pg_temp.expects('T1e   -> signed_at MUST be BROKEN without the pin', format(
    'select case when signed_at is null then ''BROKEN'' else ''STILL HELD'' end from jobs where sync_id=%L', jREAL),
    'BROKEN');
end $body$;

-- ---- CANARY 2: put the OLD crew_save_job drop list back. -------------------
create or replace function public.crew_save_job(row_in jsonb)
 returns boolean language plpgsql security definer set search_path to 'public'
as $function$
declare
    co uuid := public.current_company_id();
    drop_keys text[] := public.job_money_columns()
        || array['id', 'company_id', 'local_id', 'created_at', 'updated_at', 'deleted_at', 'deleted_by'];
    clean jsonb := coalesce(row_in, '{}'::jsonb) - drop_keys;
    cols text[];
    n int;
begin
    if auth.uid() is null or co is null then raise exception 'Not signed in' using errcode='42501'; end if;
    if not (public.has_permission('RECORD_FIELD_WORK') or public.has_permission('EDIT_JOBS')) then
        raise exception 'Not allowed to write jobs' using errcode='42501'; end if;
    select array_agg(c.column_name::text order by c.ordinal_position) into cols
      from information_schema.columns c
     where c.table_schema='public' and c.table_name='jobs'
       and c.column_name <> all(drop_keys) and c.column_name <> 'sync_id'
       and clean ? c.column_name::text;
    if cols is null then return true; end if;
    execute format(
        'update public.jobs j set (%s) = (select %s from jsonb_populate_record(j, $1) r)
          where j.company_id = $2 and j.sync_id = ($1->>''sync_id'')::uuid and j.deleted_at is null',
        (select string_agg(quote_ident(k), ', ') from unnest(cols) k),
        (select string_agg('r.' || quote_ident(k), ', ') from unnest(cols) k))
    using clean, co;
    get diagnostics n = row_count;
    return n > 0;
end $function$;

do $body$
declare
  uCRW  uuid := 'e1000002-0000-4000-8000-000000000002';
  jREAL uuid := 'e3000001-0000-4000-8000-000000000001';
  jFIX  uuid := 'e3000002-0000-4000-8000-000000000002';
begin
  perform set_config('request.jwt.claims','',true);
  update jobs set signature_storage_path = 'a/b/signature/REAL-sig.png',
                  reapproval_reason = 'DO NOT BUILD: layout changed', reapproval_count = 2
   where sync_id = jREAL;

  perform pg_temp.expect('T2a old list + no pin: CREW repoints signature', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''signature_storage_path'',''x/x/signature/F.png''))::text', jREAL),
    'true');
  perform pg_temp.expects('T2b   -> signature MUST be BROKEN', format(
    'select case when split_part(signature_storage_path,''/'',4)=''REAL-sig.png'' then ''STILL HELD'' else ''BROKEN'' end from jobs where sync_id=%L', jREAL),
    'BROKEN');
  perform pg_temp.expect('T2c old list: CREW push blanks the re-approval', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''reapproval_reason'','''',''reapproval_count'',0))::text', jREAL),
    'true');
  perform pg_temp.expects('T2d   -> re-approval MUST be BROKEN', format(
    'select case when reapproval_reason=''DO NOT BUILD: layout changed'' then ''STILL HELD'' else ''BROKEN'' end from jobs where sync_id=%L', jREAL),
    'BROKEN');
  perform pg_temp.expect('T2e old list: CREW push clears the fixture flag', uCRW,
    format('select crew_save_job(jsonb_build_object(''sync_id'',%L,''is_test_fixture'',false))::text', jFIX),
    'true');
  perform pg_temp.expects('T2f   -> fixture flag MUST be BROKEN', format(
    'select case when is_test_fixture then ''STILL HELD'' else ''BROKEN'' end from jobs where sync_id=%L', jFIX),
    'BROKEN');
end $body$;

-- ---- CANARY 3: put the OLD jobs_crew filter back. --------------------------
create or replace view public.jobs_crew with (security_barrier = true) as
 SELECT id, company_id, customer_id, local_id, customer_name, address, phone, email, notes, status,
    referral_source, scheduled_date, estimated_duration_hours, assigned_employee_id, teardown_enabled,
    hoa_name, hoa_email, hoa_approval_status, permit_number, permit_status, signed_at, updated_at,
    created_at, sync_id, waste_percent, blocked_reason, customer_must_clear, duration_manually_set,
    survey_storage_path, signature_storage_path, signed_linear_feet, final_sign_off_storage_path,
    final_sign_off_at, deleted_at, deleted_by, material_prices_confirmed_at, grid_extent_ft,
    locate_ticket_no, locate_called_at, locate_dig_after, locate_expires_at, locate_notes,
    overrun_reason, teardown_feet, assigned_employee_sync_id, grid_feet_per_square,
    calibration_pixels_per_foot, calibration_known_feet, blocked_at, customer_notified_at,
    preferred_manufacturer_sync_id, quote_approved_at, quote_approved_name, site_lat, site_lon,
    build_template_sync_id, wizard_step, priced_by, priced_at, pricing_engine_version, production_stage,
    is_test_fixture, reapproval_required_at, reapproval_reason, reapproval_count
   FROM jobs
  WHERE company_id = current_company_id() AND NOT company_is_suspended();

do $body$
declare
  uCRW uuid := 'e1000002-0000-4000-8000-000000000002';
  jFIX uuid := 'e3000002-0000-4000-8000-000000000002';
begin
  perform pg_temp.expect('T3a no WHERE filter: CREW sees the fixture again', uCRW,
    format('select case when count(*)=0 then ''STILL HIDDEN'' else ''BROKEN'' end from jobs_crew where sync_id=%L', jFIX),
    'BROKEN');
end $body$;

-- ---- CANARY 4: put the OLD protect_customer_identity() back. ---------------
create or replace function public.protect_customer_identity()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare claims text := nullif(current_setting('request.jwt.claims', true), '');
begin
    if claims is not null and not public.is_service_role() and not has_permission('EDIT_JOBS') then
        new.customer_name := old.customer_name;
        new.address       := old.address;
        new.phone         := old.phone;
        new.customer_id   := old.customer_id;
    end if;
    return new;
end;
$function$;

do $body$
declare
  uACC  uuid := 'e1000003-0000-4000-8000-000000000003';
  jREAL uuid := 'e3000001-0000-4000-8000-000000000001';
begin
  perform set_config('request.jwt.claims','',true);
  update jobs set email = 'real-customer@probe.invalid' where sync_id = jREAL;
  perform pg_temp.expect('T4a old identity guard: ACCOUNTANT sets email (rows)', uACC,
    format('with u as (update jobs set email=''acct-attacker@probe.invalid'' where sync_id=%L returning 1) select count(*)::text from u', jREAL),
    '1');
  perform pg_temp.expects('T4b   -> email MUST be BROKEN', format(
    'select case when email=''real-customer@probe.invalid'' then ''STILL HELD'' else ''BROKEN'' end from jobs where sync_id=%L', jREAL),
    'BROKEN');
end $body$;

select count(*) filter (where verdict='PASS') as with_teeth,
       count(*) filter (where verdict='FAIL') as toothless,
       coalesce(string_agg(k, ' | ') filter (where verdict='FAIL'), 'none') as lines_without_teeth
  from r;
select jsonb_pretty(jsonb_agg(jsonb_build_array(n, verdict, k, got, want) order by n)) as teeth from r;
rollback;
