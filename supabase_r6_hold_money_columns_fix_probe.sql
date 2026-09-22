-- supabase_r6_hold_money_columns_fix.sql, supabase_r6_crew_change_orders.sql
-- AND supabase_r6_change_order_feet_check.sql -- PROOF, one rolled-back transaction.
--
-- The first fix: hold_money_columns()'s INSERT branch built a text column's
-- zero with to_jsonb(''), which Postgres cannot type (42804), so every insert
-- by a caller money_caller_trusted() does not trust failed -- a crew phone's
-- new change order never reached the server. The fix is to_jsonb(''::text).
--
-- The second: even with that fixed, the phone's actual push -- an upsert, so
-- INSERT ... ON CONFLICT -- is refused for a crew login by the restrictive
-- SEE_MONEY read policy (2x explains). crew_push_change_orders(jsonb) is the
-- crew path now; 2x, 5x, 6x, 7x and 9x prove it. The third, the feet CHECK,
-- is 8x.
--
-- RUN IT
--   After ALL THREE files are applied: run this file as it is.
--   Before the last two are applied: splice them in, so they exist only
--   inside this transaction and go at the ROLLBACK:
--     { echo 'begin;'; cat supabase_r6_crew_change_orders.sql;
--       sed -e '/^begin;$/d' \
--           -e '/^-- @@FEET_CHECK@@$/r supabase_r6_change_order_feet_check.sql' \
--           supabase_r6_hold_money_columns_fix_probe.sql; } > spliced.sql
--     npx supabase db query --linked --project-ref <ref> -f spliced.sql --output json
--   (the first sed drops this file's own "begin;", the only line that is
--   exactly that; the second puts the CHECK file at the one marker line, just
--   before 8x, so its brief ACCESS EXCLUSIVE lock on change_orders is held
--   only for the last block. The spliced file ends in this file's ROLLBACK.)
--   Without the RPC, 07 fails first and says why, and every RPC row fails
--   with 42883; without the CHECK, 80 fails and says why.
--
-- Read-only in effect: every subject and row is synthetic, created in here,
-- and the transaction ends in ROLLBACK. The planted fault in 4x replaces the
-- function INSIDE this transaction only; 6x plants a stand-in can_see_job()
-- the same way when crew job scope is not applied, and for 68 hides
-- can_see_job(uuid) (renamed, live scope) or plants a job-scope marker
-- (stand-in); 9x turns triggers off with SET LOCAL session_replication_role,
-- which takes no lock and ends with the transaction. Other sessions keep
-- seeing the live catalog throughout.
--
-- What each block proves, and what would break first if it lied:
--   0x  the subjects have the property each check depends on (a crew login
--       that could see money would pass 1x without touching the INSERT
--       branch at all), the live body carries the cast, and the root cause
--       is real on this server (05: bare to_jsonb('') is 42804 here).
--   1x  a crew INSERT on a job they lead lands with its money zeroed; the
--       owner's identical insert keeps its money (the zeroing is the
--       shield, not the table); a crew insert into another company is still
--       refused (the fix opened nothing).
--   2x  the phone's push, end to end. The table upsert it sends today
--       (supabase-kt upsert, on_conflict=company_id,sync_id -> INSERT ... ON
--       CONFLICT DO UPDATE) is refused for crew by the SEE_MONEY read policy,
--       so crew now push through crew_push_change_orders: a new order lands
--       with its money 0 whatever the payload said; the office's priced order
--       keeps 300/40 while the customer's signature lands; once signed, its
--       terms and signature hold against a later crew push. STALE COPIES
--       (2C-2H): a phone re-sends every order before it pulls, so a crew copy
--       of an order the office has since re-priced must not put the old terms
--       back -- priced, accepted or signed, the terms are the office's -- and
--       a signature taken on that old copy is not attached to the new terms.
--       The crew's own unpriced order stays theirs to edit (2I). NEGATIVE
--       rows: the crew's direct upsert is STILL refused 42501 and a plain
--       UPDATE still reaches no row -- the policies were not loosened.
--       Control: the office's direct upsert still works and keeps its money.
--   3x  the other consumer of the INSERT branch: 00_protect_job_money on jobs.
--   4x  PLANTED FAULT: the unfixed body reinstalled (the one cast reversed,
--       anchored, exactly once). The crew insert from 10 must now fail with
--       42804, the owner's must still land (a trusted caller returns before
--       the CASE), and the body scan must find it. Then the fixed body is put
--       back and 10's insert lands again. A probe that stays green with the
--       fault planted proves nothing.
--   (06/43/46) every other user-defined routine, scanned for the same class:
--       a call to a built-in taking an anyelement-family argument with
--       nothing but bare, uncast literals or NULL. 06 is that scan on the live
--       bodies; 43 is the same scan catching the planted fault.
--   5x  what the RPC refuses, row by row, without failing the batch: a row
--       naming another company, a row on another company's job, another
--       company's owner pushing onto ours, a deleted job, a tombstoned order
--       (never edited, never brought back), an order moved between jobs,
--       malformed rows, feet that are NaN / infinite / negative, a signature
--       image outside this order's own folder, a signing date from the
--       future, and a crew login without RECORD_FIELD_WORK (the one
--       caller-wide refusal).
--   6x  job scope. crew see only their jobs once supabase_crew_job_scope.sql
--       is applied; the RPC asks public.can_see_job when it exists. When it
--       does not, a stand-in that hides job B from non-editors is planted in
--       this transaction so the branch is exercised either way, then dropped
--       to show the RPC falls back to the company-wide rule (67, stand-in
--       mode only -- the SUMMARY total is one lower once job scope is live).
--       68: job scope present but can_see_job(uuid) gone refuses the call
--       (fail closed), rather than widening it to the whole company.
--   7x  the allowlist itself: the RPC body names no money, acceptance or
--       tombstone column outside the one pinned read that holds the office's
--       terms (a scan), the scan catches a planted one, and the grants: not
--       anon, not PUBLIC, authenticated, SECURITY DEFINER, search_path=public.
--   9x  the same pushes with EVERY trigger off (session_replication_role =
--       replica): the money shield, acceptance latch and delete guard are not
--       underneath now, so a money, acceptance or tombstone write by the RPC
--       -- however it is spelled, dynamic SQL included -- lands and turns
--       these red. 90 proves the triggers really are off.
--   8x  the feet CHECK: a crew login's bare INSERT (the door the RPC cannot
--       close) and the office's upsert both refuse NaN, Infinity and
--       negative feet; ordinary feet still land; the RPC keeps its batch.
--
-- Output: one row per check, PASS or FAIL, and a SUMMARY row last. Anything
-- but "N/N" is a finding.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create temp table r(n serial, k text, got text, want text);
grant all on r to authenticated, anon;
grant usage on sequence r_n_seq to authenticated, anon;

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

-- The office / a direct connection (no claims: money_caller_trusted()), one scalar back.
create function pg_temp.s(label text, q text, want text) returns void language plpgsql as $fn$
declare v text;
begin
  perform set_config('request.jwt.claims','',true);
  begin execute q into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,150); end;
  insert into r(k,got,want) values (label,v,want);
end $fn$;

-- The class of fault, found in every user-defined routine body: a call whose
-- every argument is a bare, uncast string literal or NULL, to a built-in
-- that takes an anyelement-family argument (anycompatible resolves unknown
-- to text and is fine). '-' when there is none. pg_temp is not scanned, so
-- this probe's own helpers never match.
create function pg_temp.untyped_poly_calls() returns text language sql as $fn$
  with bodies as (
    select n.nspname, p.proname, p.prosrc
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
     where n.nspname not in ('pg_catalog', 'information_schema')
       and n.nspname not like 'pg\_%'
       and l.lanname in ('plpgsql', 'sql')
  ), calls as (
    select b.nspname, b.proname, lower(m[1]) as callee,
           regexp_replace(m[2], $r$'(?:[^']|'')*'$r$, '', 'g') as args_bare
      from bodies b,
           lateral regexp_matches(b.prosrc,
             $re$([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*((?:'(?:[^']|'')*'|null)(?:\s*,\s*(?:'(?:[^']|'')*'|null))*)\s*\)$re$,
             'gi') as mm(m)
  ), poly as (
    select distinct p.proname, p.pronargs
      from pg_proc p
     where p.pronamespace = 'pg_catalog'::regnamespace
       and exists (select 1 from unnest(p.proargtypes::oid[]) t
                    where t in ('anyelement'::regtype, 'anyarray'::regtype, 'anynonarray'::regtype,
                                'anyenum'::regtype, 'anyrange'::regtype, 'anymultirange'::regtype))
  )
  select coalesce(string_agg(distinct c.nspname || '.' || c.proname || ':' || c.callee, ','), '-')
    from calls c
    join poly on poly.proname = c.callee
             and poly.pronargs = 1 + length(c.args_bare) - length(replace(c.args_bare, ',', ''))
$fn$;

-- The one read the RPC may make of a money/acceptance column (pinned in
-- supabase_r6_crew_change_orders.sql's self-check too), and the RPC body with
-- that read taken out: what is left must name none of them.
create function pg_temp.office_read() returns text language sql as $fn$
  select '(c.additional_cost <> 0 or c.material_cost <> 0 or c.in_accepted_total) as office_set'::text
$fn$;
create function pg_temp.rpc_body_stripped() returns text language sql as $fn$
  select replace(pg_get_functiondef('public.crew_push_change_orders(jsonb)'::regprocedure), pg_temp.office_read(), '')
$fn$;
create function pg_temp.forbidden_named(body text) returns text language sql as $fn$
  select coalesce((select string_agg(t, ',') from unnest(array['additional_cost','material_cost','in_accepted_total','deleted_by']) t
                    where position(t in body) > 0), '-')
         || case when body ~ 'deleted_at\s*=' then '+deleted_at=' else '' end
$fn$;

do $body$
declare
  SC    uuid := 'b7000001-0000-4000-8000-000000000001';
  SC2   uuid := 'b7000002-0000-4000-8000-000000000002';
  uOWN  uuid := 'b7100001-0000-4000-8000-000000000001';
  uCRW  uuid := 'b7100002-0000-4000-8000-000000000002';  -- crew, linked to eCRW, leads jA
  uOTH  uuid := 'b7100003-0000-4000-8000-000000000003';  -- owner of the OTHER company
  uNOF  uuid := 'b7100004-0000-4000-8000-000000000004';  -- crew with -RECORD_FIELD_WORK (5B)
  eCRW  uuid := 'b7200002-0000-4000-8000-000000000002';
  jA    uuid := 'b7300001-0000-4000-8000-000000000001';  -- lead: eCRW
  jO    uuid := 'b7300002-0000-4000-8000-000000000002';  -- the other company's job
  jC    uuid := 'b7300003-0000-4000-8000-000000000003';  -- a job the crew login inserts (3x)
  jB    uuid := 'b7300004-0000-4000-8000-000000000004';  -- ours, nobody leads it: not the crew's (6x)
  jD    uuid := 'b7300005-0000-4000-8000-000000000005';  -- ours, deleted
  coOff uuid := 'b7400000-0000-4000-8000-000000000000';  -- an order the office wrote, 300/40
  coB   uuid := 'b7400001-0000-4000-8000-000000000001';  -- an office order on job B, 75/10
  coDel uuid := 'b7400002-0000-4000-8000-000000000002';  -- an office order on job A, deleted
  coPr  uuid := 'b7400003-0000-4000-8000-000000000003';  -- office re-priced: 'flip v2'/20 ft at 300 (a phone may hold v1/10)
  coAcc uuid := 'b7400004-0000-4000-8000-000000000004';  -- office order inside an accepted price, 0/0
  coSNP uuid := 'b7400005-0000-4000-8000-000000000005';  -- office order, signed, no image path
  coFut uuid := 'b7400006-0000-4000-8000-000000000006';  -- office order, priced 80, unsigned (signing dates)
  co9P  uuid := 'b7400007-0000-4000-8000-000000000007';  -- office order, priced 300/40, unsigned (9x)
  co9U  uuid := 'b7400008-0000-4000-8000-000000000008';  -- office order, not priced (9x)
  co10  uuid := 'b7400010-0000-4000-8000-000000000010';
  co12  uuid := 'b7400012-0000-4000-8000-000000000012';
  co14  uuid := 'b7400014-0000-4000-8000-000000000014';
  co20  uuid := 'b7400020-0000-4000-8000-000000000020';
  co26  uuid := 'b7400026-0000-4000-8000-000000000026';
  co2A  uuid := 'b740002a-0000-4000-8000-00000000002a';
  co41  uuid := 'b7400041-0000-4000-8000-000000000041';
  co42  uuid := 'b7400042-0000-4000-8000-000000000042';
  co45  uuid := 'b7400045-0000-4000-8000-000000000045';
  co50  uuid := 'b7400050-0000-4000-8000-000000000050';
  co51  uuid := 'b7400051-0000-4000-8000-000000000051';
  co52  uuid := 'b7400052-0000-4000-8000-000000000052';
  co53  uuid := 'b7400053-0000-4000-8000-000000000053';
  co54  uuid := 'b7400054-0000-4000-8000-000000000054';
  co55  uuid := 'b7400055-0000-4000-8000-000000000055';
  co59  uuid := 'b7400059-0000-4000-8000-000000000059';
  co5B  uuid := 'b740005b-0000-4000-8000-00000000005b';
  co5C1 uuid := 'b74005c1-0000-4000-8000-0000000005c1';
  co5C2 uuid := 'b74005c2-0000-4000-8000-0000000005c2';
  co5C3 uuid := 'b74005c3-0000-4000-8000-0000000005c3';
  co5C4 uuid := 'b74005c4-0000-4000-8000-0000000005c4';
  co5C5 uuid := 'b74005c5-0000-4000-8000-0000000005c5';
  co61  uuid := 'b7400061-0000-4000-8000-000000000061';
  co64  uuid := 'b7400064-0000-4000-8000-000000000064';
  co65  uuid := 'b7400065-0000-4000-8000-000000000065';
  co66  uuid := 'b7400066-0000-4000-8000-000000000066';
  co68  uuid := 'b7400068-0000-4000-8000-000000000068';
  co90  uuid := 'b7400090-0000-4000-8000-000000000090';
  co91  uuid := 'b7400091-0000-4000-8000-000000000091';
  tok   uuid := 'b7500001-0000-4000-8000-000000000001';  -- the quote token the crew insert names
  -- A signature image where the app uploads one: <company>/<job>/change-order/<file>.
  sigA  text := 'b7000001-0000-4000-8000-000000000001/b7300001-0000-4000-8000-000000000001/change-order/signature_1_probe.png';
  sigA2 text := 'b7000001-0000-4000-8000-000000000001/b7300001-0000-4000-8000-000000000001/change-order/signature_2_probe.png';
  -- The change-order insert a crew phone makes, and the upsert it really
  -- sends: the columns CloudChangeOrder serialises (in_accepted_total is
  -- never named on an ordinary push), costs 999/55 so a zero is visible.
  ins  text := 'insert into change_orders(company_id,sync_id,job_sync_id,description,additional_feet,additional_cost,material_cost) '
               'values (%L,%L,%L,''probe order'',4,999,55)';
  -- supabase-kt upsert(onConflict = "company_id,sync_id") through PostgREST:
  -- INSERT ... SELECT FROM json_to_recordset ON CONFLICT DO UPDATE SET every
  -- payload column = EXCLUDED, wrapped in a CTE that counts RETURNING 1.
  ups  text := 'with pgrst_source as ('
               'insert into public.change_orders(company_id,sync_id,job_sync_id,description,additional_feet,additional_cost,material_cost,signed_at) '
               'select b.company_id,b.sync_id,b.job_sync_id,b.description,b.additional_feet,b.additional_cost,b.material_cost,b.signed_at '
               '  from json_to_recordset(%L::json) as b(company_id uuid, sync_id uuid, job_sync_id uuid, description text, '
               '       additional_feet double precision, additional_cost double precision, material_cost double precision, signed_at timestamptz) '
               'on conflict (company_id, sync_id) do update set company_id = excluded.company_id, sync_id = excluded.sync_id, '
               '  job_sync_id = excluded.job_sync_id, description = excluded.description, additional_feet = excluded.additional_feet, '
               '  additional_cost = excluded.additional_cost, material_cost = excluded.material_cost, signed_at = excluded.signed_at '
               'returning 1) select count(*)::text from pgrst_source';
  money text := 'select additional_cost::text || ''/'' || material_cost::text from change_orders where sync_id = %L';
  -- Everything a crew push must not move, in one string: money, acceptance, tombstone.
  guard text := 'select additional_cost::text || ''/'' || material_cost::text || ''/'' || in_accepted_total::text || ''/'' '
               '|| (deleted_at is null)::text || ''/'' || deleted_by from change_orders where sync_id = %L';
  -- The crew path: crew_push_change_orders, its summary as inserted/updated/unchanged/skipped.
  rpc  text := 'select (x->>''inserted'') || ''/'' || (x->>''updated'') || ''/'' || (x->>''unchanged'') || ''/'' || (x->>''skipped'') '
               '  from (select public.crew_push_change_orders(%L::jsonb) as x) t';
  fixed_def text;
  planted_def text;
  n int;
  live_scope boolean;
begin
  perform set_config('request.jwt.claims','',true);

  -- ======================================================================
  -- Fixtures (all synthetic; gone at ROLLBACK)
  -- ======================================================================
  insert into auth.users(id,email) values
    (uOWN,'hm-own@probe.invalid'),(uCRW,'hm-crw@probe.invalid'),(uOTH,'hm-oth@probe.invalid'),
    (uNOF,'hm-nof@probe.invalid');
  insert into companies(id,name,subscription_status,subscription_plan,suspended,trial_ends_at,
                        admin_notes,leads_token,stripe_customer_id,invited_email,suspended_reason) values
    (SC ,'PROBE-HOLD-MONEY','active','pro',false,now()+interval '30 days','',gen_random_uuid(),'cus_HM1','',''),
    (SC2,'PROBE-HOLD-MONEY-OTHER','active','pro',false,now()+interval '30 days','',gen_random_uuid(),'cus_HM2','','');
  insert into profiles(id,company_id,full_name,role,is_platform_admin,permission_overrides) values
    (uOWN,SC ,'HM Owner'      ,'OWNER',false,''),
    (uCRW,SC ,'HM Crew'       ,'CREW' ,false,''),
    (uOTH,SC2,'HM Other Owner','OWNER',false,''),
    (uNOF,SC ,'HM No Field Work','CREW',false,'-RECORD_FIELD_WORK');
  insert into employees(id,company_id,name,sync_id,hourly_rate,pay_type,profile_id,is_active) values
    (eCRW,SC,'HM Crew',eCRW,21.00,'HOURLY',uCRW,true);
  insert into jobs(id,company_id,customer_name,address,phone,email,status,sync_id,contract_total,
                   quote_token,is_test_fixture,notes,assigned_employee_sync_id) values
    (jA,SC ,'HM JOB A','1 Probe Way','555-0101','a@probe.invalid','ACCEPTED',jA,5000,gen_random_uuid(),false,'',eCRW::text),
    (jO,SC2,'HM JOB O','9 Other Rd' ,'555-0109','o@probe.invalid','ACCEPTED',jO,5000,gen_random_uuid(),false,'',null),
    (jB,SC ,'HM JOB B','2 Probe Way','555-0102','b@probe.invalid','ACCEPTED',jB,5000,gen_random_uuid(),false,'',null),
    (jD,SC ,'HM JOB D','4 Probe Way','555-0104','d@probe.invalid','ACCEPTED',jD,5000,gen_random_uuid(),false,'',null);
  update jobs set deleted_at = now(), deleted_by = 'probe office' where sync_id = jD;
  insert into change_orders(company_id,sync_id,job_sync_id,description,additional_feet,additional_cost,material_cost,
                            in_accepted_total,signed_at)
    values (SC,coOff,jA,'office order'       , 0,300,40,false,null),
           (SC,coB  ,jB,'office order on B'  , 0, 75,10,false,null),
           (SC,coDel,jA,'deleted order'      , 0, 50, 5,false,null),
           (SC,coPr ,jA,'flip v2'            ,20,300, 0,false,null),
           (SC,coAcc,jA,'accepted order'     , 6,  0, 0,true ,null),
           (SC,coSNP,jA,'signed no path'     , 2, 50, 0,false,now() - interval '1 day'),
           (SC,coFut,jA,'priced for signing' , 3, 80, 0,false,null),
           (SC,co9P ,jA,'replica priced'     , 5,300,40,false,null),
           (SC,co9U ,jA,'replica unpriced'   , 3,  0, 0,false,null);
  update change_orders set deleted_at = now(), deleted_by = 'probe office' where sync_id = coDel;

  -- ======================================================================
  -- 0x  Subjects by property; the live body; the root cause
  -- ======================================================================
  perform pg_temp.p('00 CREW      SEE_MONEY/money_caller_trusted', uCRW,
    'select has_permission(''SEE_MONEY'')::text||''/''||money_caller_trusted()::text', 'false/false');
  perform pg_temp.p('01 OWNER     SEE_MONEY/money_caller_trusted', uOWN,
    'select has_permission(''SEE_MONEY'')::text||''/''||money_caller_trusted()::text', 'true/true');
  perform pg_temp.p('02 CREW      sees job A, the job they lead', uCRW,
    format('select count(*)::text from jobs_crew where sync_id = %L', jA), '1');
  perform pg_temp.s('03 LIVE BODY bare to_jsonb('''') / to_jsonb(''''::text)',
    $q$select (select count(*) from regexp_matches(pg_get_functiondef('public.hold_money_columns()'::regprocedure), $re$to_jsonb\(''\)$re$, 'g'))::text
          || '/' || (select count(*) from regexp_matches(pg_get_functiondef('public.hold_money_columns()'::regprocedure), $re$to_jsonb\(''::text\)$re$, 'g'))::text$q$,
    '0/1');
  perform pg_temp.s('04 TRIGGERS  hold_money_columns runs BEFORE INSERT on change_orders and jobs',
    $q$select string_agg(tgrelid::regclass::text || ':' || tgname, ',' order by tgrelid::regclass::text)
         from pg_trigger where tgfoid = 'public.hold_money_columns()'::regprocedure and not tgisinternal
          and (tgtype & 4) <> 0$q$,
    'change_orders:00_zero_change_order_costs,jobs:00_protect_job_money');
  perform pg_temp.s('05 ROOT      bare to_jsonb('''') cannot be typed on this server', $q$select to_jsonb('')::text$q$, 'ERR 42804');
  perform pg_temp.s('05b          control: to_jsonb(''''::text)', $q$select to_jsonb(''::text)::text$q$, '""');
  perform pg_temp.s('06 SCAN      live routine bodies: untyped polymorphic calls', 'select pg_temp.untyped_poly_calls()', '-');
  perform pg_temp.s('07 RPC       crew_push_change_orders(jsonb) is here (applied, or spliced in -- see RUN IT)',
    $q$select (to_regprocedure('public.crew_push_change_orders(jsonb)') is not null)::text$q$, 'true');
  perform pg_temp.p('08 NO-FIELD  the -RECORD_FIELD_WORK crew login has neither pen (5B depends on it)', uNOF,
    'select has_permission(''RECORD_FIELD_WORK'')::text||''/''||has_permission(''EDIT_JOBS'')::text', 'false/false');

  -- ======================================================================
  -- 1x  A crew insert lands, zeroed; the owner's keeps its money; another
  --     company's job is still refused
  -- ======================================================================
  perform pg_temp.x('10 CREW      inserts a change order on the job they lead', uCRW, format(ins, SC, co10, jA), 'rows=1');
  perform pg_temp.s('11 OFFICE    it landed, costs zeroed by the shield', format(money, co10), '0/0');
  perform pg_temp.x('12 OWNER     the same insert (control: a trusted caller)', uOWN, format(ins, SC, co12, jA), 'rows=1');
  perform pg_temp.s('13 OFFICE    the owner''s costs kept', format(money, co12), '999/55');
  perform pg_temp.x('14 CREW      inserts a change order on another company''s job', uCRW, format(ins, SC2, co14, jO), 'ERR 42501');
  perform pg_temp.s('15 OFFICE    nothing landed for 14', format('select count(*)::text from change_orders where sync_id = %L', co14), '0');

  -- ======================================================================
  -- 2x  The phone's push: crew through crew_push_change_orders
  -- ======================================================================
  -- Found 2026-09-22: with the cast fixed, the table upsert the phone sends
  -- is refused by "change_orders_money_hidden_from_crew" (42501). Any ON
  -- CONFLICT names the arbiter columns, which needs SELECT on the table, so
  -- Postgres applies the SELECT policies to the new row as a check -- and the
  -- restrictive SEE_MONEY one fails for crew. DO NOTHING is refused too, and
  -- a plain UPDATE by sync_id silently touches 0 rows; only a bare INSERT (10)
  -- got through. So 20 and 22 now go through the definer RPC, and 26 and 28
  -- keep the old statements as NEGATIVE rows: they must stay refused, which
  -- is the proof the policies were not loosened to make this work.
  --
  -- 20's payload asserts everything a crew phone must not: costs 999/55,
  -- inside an accepted price, deleted. 21b reads back what landed.
  perform pg_temp.p('20 CREW      pushes a NEW order through the RPC (payload: 999/55, accepted, deleted)', uCRW,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',co20,'job_sync_id',jA,'description','probe order',
             'additional_feet',4,'additional_cost',999,'material_cost',55,'signed_at',null,'in_accepted_total',true,
             'deleted_at',now(),'deleted_by','crew'))), '1/0/0/0');
  perform pg_temp.s('21 OFFICE    it landed', format('select count(*)::text from change_orders where sync_id = %L', co20), '1');
  perform pg_temp.s('21b OFFICE   money 0/0, not accepted, not deleted; the phone''s text and feet, our company', format(
    'select additional_cost::text || ''/'' || material_cost::text || ''/'' || in_accepted_total::text || ''/'' '
    '|| (deleted_at is null)::text || ''/'' || deleted_by || ''/'' || description || ''/'' || additional_feet::text '
    '|| ''/'' || (company_id = %L)::text from change_orders where sync_id = %L', SC, co20),
    '0/0/false/true//probe order/4/true');
  -- 22: the terms the office priced, as a phone that has pulled since holds
  -- them, and the customer's signature with its image in the order's folder.
  perform pg_temp.p('22 CREW      signs the office''s priced order on the terms it holds (costs 0 in the payload)', uCRW,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',coOff,'job_sync_id',jA,'description','office order',
             'additional_feet',0,'additional_cost',0,'material_cost',0,'signed_at',now(),
             'signature_storage_path',sigA))), '0/1/0/0');
  perform pg_temp.s('23 OFFICE    the office''s costs held; the signature and its image path landed', format(
    'select additional_cost::text || ''/'' || material_cost::text || ''/'' || (signed_at is not null)::text || ''/'' '
    '|| coalesce(signature_storage_path,''null'') from change_orders where sync_id = %L', coOff),
    '300/40/true/' || sigA);
  -- The app clears a signature locally when the terms change, and a null is
  -- dropped from the payload -- so without the freeze, this would move the
  -- feet under the customer's signature and keep the signature.
  perform pg_temp.p('24 CREW      re-pushes the SIGNED order with new terms and no signature: nothing to write', uCRW,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',coOff,'job_sync_id',jA,
             'description','rewritten after signing','additional_feet',9,'additional_cost',0,'material_cost',0,
             'signed_at',null,'signature_storage_path',null))), '0/0/1/0');
  perform pg_temp.s('25 OFFICE    a signed order''s terms, signature and costs all held', format(
    'select description || ''/'' || additional_feet::text || ''/'' || (signed_at is not null)::text || ''/'' '
    '|| coalesce(signature_storage_path,''null'') || ''/'' || additional_cost::text || ''/'' || material_cost::text '
    '  from change_orders where sync_id = %L', coOff),
    'office order/0/true/' || sigA || '/300/40');
  perform pg_temp.p('26 NEGATIVE  the crew''s direct table upsert (the old push) is STILL refused', uCRW,
    format(ups, json_build_array(json_build_object('company_id',SC,'sync_id',co26,'job_sync_id',jA,'description','probe order',
             'additional_feet',4,'additional_cost',0,'material_cost',0,'signed_at',null))),
    '~^ERR 42501: .*change_orders_money_hidden_from_crew');
  perform pg_temp.s('27 OFFICE    nothing landed for 26', format('select count(*)::text from change_orders where sync_id = %L', co26), '0');
  perform pg_temp.x('28 NEGATIVE  a crew plain UPDATE by sync_id still reaches no row', uCRW,
    format('update change_orders set signed_at = null, description = ''crew wrote this'' where sync_id = %L', coOff), 'rows=0');
  perform pg_temp.s('29 OFFICE    28 changed nothing', format(
    'select description || ''/'' || (signed_at is not null)::text from change_orders where sync_id = %L', coOff),
    'office order/true');
  perform pg_temp.p('2A OWNER     control: the office''s direct upsert (SEE_MONEY) is unchanged', uOWN,
    format(ups, json_build_array(json_build_object('company_id',SC,'sync_id',co2A,'job_sync_id',jA,'description','office upsert',
             'additional_feet',2,'additional_cost',120,'material_cost',30,'signed_at',null))), '1');
  perform pg_temp.s('2B OFFICE    and keeps its money', format(money, co2A), '120/30');
  -- STALE COPIES (verifier O02/O05). A phone re-sends every order on every
  -- pass, and pushes before it pulls, so its copy is often older than the
  -- server's. coPr: the office changed 'flip v1'/10 to 'flip v2'/20 and priced
  -- it at 300; the crew phone still holds v1/10.
  perform pg_temp.p('2C CREW      a stale copy of the office''s PRICED order (flip v1/10 over flip v2/20 at 300)', uCRW,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',coPr,'job_sync_id',jA,'description','flip v1',
             'additional_feet',10,'additional_cost',0,'material_cost',0))), '0/0/1/0');
  perform pg_temp.s('2D OFFICE    the office''s terms held under its price', format(
    'select description || ''/'' || additional_feet::text || ''/'' || additional_cost::text || ''/'' || (signed_at is null)::text '
    '  from change_orders where sync_id = %L', coPr),
    'flip v2/20/300/true');
  -- The customer signed v1/10 on the phone: that signature is not for v2/20.
  perform pg_temp.p('2E CREW      the same stale copy carrying a signature taken on it', uCRW,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',coPr,'job_sync_id',jA,'description','flip v1',
             'additional_feet',10,'additional_cost',0,'material_cost',0,'signed_at',now(),'signature_storage_path',sigA2))), '0/0/0/1');
  perform pg_temp.s('2F OFFICE    nothing attached: still unsigned, no image, terms v2/20', format(
    'select description || ''/'' || additional_feet::text || ''/'' || (signed_at is null)::text || ''/'' '
    '|| coalesce(signature_storage_path,''null'') from change_orders where sync_id = %L', coPr),
    'flip v2/20/true/null');
  perform pg_temp.p('2G CREW      signed on the terms the server holds (a phone that pulled first)', uCRW,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',coPr,'job_sync_id',jA,'description','flip v2',
             'additional_feet',20,'additional_cost',0,'material_cost',0,'signed_at',now(),'signature_storage_path',sigA2))), '0/1/0/0');
  perform pg_temp.s('2H OFFICE    signed; the terms and price are the office''s', format(
    'select description || ''/'' || additional_feet::text || ''/'' || additional_cost::text || ''/'' || (signed_at is null)::text '
    '  from change_orders where sync_id = %L', coPr),
    'flip v2/20/300/false');
  -- Not priced, not accepted, not signed: still the crew's to edit.
  perform pg_temp.p('2I CREW      edits their own unpriced order (20''s): new text and feet', uCRW,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',co20,'job_sync_id',jA,'description','crew edit',
             'additional_feet',6,'additional_cost',0,'material_cost',0))), '0/1/0/0');
  perform pg_temp.s('2J OFFICE    the edit landed; money still 0/0', format(
    'select description || ''/'' || additional_feet::text || ''/'' || additional_cost::text || ''/'' || material_cost::text '
    '  from change_orders where sync_id = %L', co20),
    'crew edit/6/0/0');
  perform pg_temp.p('2K CREW      rewrites an unpriced office order inside an accepted price', uCRW,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',coAcc,'job_sync_id',jA,'description','crew rewrote',
             'additional_feet',60,'additional_cost',0,'material_cost',0))), '0/0/1/0');
  perform pg_temp.s('2L OFFICE    its terms held', format(
    'select description || ''/'' || additional_feet::text || ''/'' || in_accepted_total::text from change_orders where sync_id = %L', coAcc),
    'accepted order/6/true');

  -- ======================================================================
  -- 3x  The jobs trigger runs the same INSERT branch
  -- ======================================================================
  perform pg_temp.x('30 CREW      inserts a job directly (00_protect_job_money INSERT branch)', uCRW,
    format('insert into jobs(id,company_id,customer_name,address,phone,email,status,sync_id,contract_total,tax_rate_percent,'
           'quote_token,is_test_fixture,notes) values (%L,%L,''HM JOB C'',''3 Probe Way'',''555-0103'',''c@probe.invalid'','
           '''DRAFT'',%L,5000,8,%L,false,'''')', jC, SC, jC, tok), 'rows=1');
  perform pg_temp.s('31 OFFICE    its money held: contract_total/tax/payment_status/token replaced', format(
    'select coalesce(contract_total::text,''null'') || ''/'' || tax_rate_percent::text || ''/'' || payment_status || ''/'' '
    '|| (quote_token <> %L)::text from jobs where sync_id = %L', tok, jC), 'null/0/UNPAID/true');

  -- ======================================================================
  -- 4x  PLANTED FAULT: the unfixed body, in this transaction only
  -- ======================================================================
  fixed_def := pg_get_functiondef('public.hold_money_columns()'::regprocedure);
  select count(*) into n from regexp_matches(fixed_def, $re$to_jsonb\(''::text\)$re$, 'g');
  insert into r(k,got,want) values ('40 PLANT     the cast to reverse appears exactly once', n::text, '1');
  if n = 1 then
    planted_def := replace(fixed_def, $s$to_jsonb(''::text)$s$, $s$to_jsonb('')$s$);
    execute planted_def;
  end if;
  perform pg_temp.x('41 PLANTED   the crew insert from 10 now fails to type', uCRW, format(ins, SC, co41, jA), 'ERR 42804');
  perform pg_temp.x('42 PLANTED   the owner''s still lands (trusted returns before the CASE)', uOWN, format(ins, SC, co42, jA), 'rows=1');
  perform pg_temp.s('43 PLANTED   the scan finds it', 'select pg_temp.untyped_poly_calls()', 'public.hold_money_columns:to_jsonb');
  execute fixed_def;
  perform pg_temp.s('44 RESTORED  the live body is back', $q$select md5(pg_get_functiondef('public.hold_money_columns()'::regprocedure))$q$, md5(fixed_def));
  perform pg_temp.x('45 RESTORED  the crew insert lands again', uCRW, format(ins, SC, co45, jA), 'rows=1');
  perform pg_temp.s('46 RESTORED  the scan is clean again', 'select pg_temp.untyped_poly_calls()', '-');

  -- ======================================================================
  -- 5x  What the RPC refuses -- row by row, never the whole batch
  -- ======================================================================
  -- The third row is on OUR job but names the other company: only the
  -- company test refuses it (the job test alone would file it under ours).
  perform pg_temp.p('50 CREW      one batch: other company + its job, its job under ours, our job under theirs, a good row', uCRW,
    format(rpc, jsonb_build_array(
      jsonb_build_object('company_id',SC2,'sync_id',co50,'job_sync_id',jO,'description','other company'),
      jsonb_build_object('company_id',SC ,'sync_id',co51,'job_sync_id',jO,'description','their job, our company'),
      jsonb_build_object('company_id',SC2,'sync_id',co55,'job_sync_id',jA,'description','our job, their company'),
      jsonb_build_object('company_id',SC ,'sync_id',co52,'job_sync_id',jA,'description','good row'))), '1/0/0/3');
  perform pg_temp.s('51 OFFICE    the three refused rows are nowhere; the good row is ours', format(
    'select (select count(*) from change_orders where sync_id in (%L,%L,%L))::text || ''/'' '
    '|| (select count(*) from change_orders where sync_id = %L and company_id = %L)::text', co50, co51, co55, co52, SC), '0/1');
  perform pg_temp.p('52 OTHER CO  the other company''s owner pushes onto our job A', uOTH,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC2,'sync_id',co53,'job_sync_id',jA,'description','cross-company'))), '0/0/0/1');
  perform pg_temp.p('52b OTHER CO ... naming our company in the row', uOTH,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC ,'sync_id',co53,'job_sync_id',jA,'description','cross-company'))), '0/0/0/1');
  perform pg_temp.s('53 OFFICE    nothing landed for 52/52b', format('select count(*)::text from change_orders where sync_id = %L', co53), '0');
  perform pg_temp.p('54 CREW      an order on a deleted job', uCRW,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',co54,'job_sync_id',jD,'description','deleted job'))), '0/0/0/1');
  perform pg_temp.p('55 CREW      re-sends an order the office deleted (a stale phone)', uCRW,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',coDel,'job_sync_id',jA,'description','resurrected',
             'signed_at',now()))), '0/0/0/1');
  perform pg_temp.s('56 OFFICE    still deleted, untouched', format(
    'select description || ''/'' || (deleted_at is not null)::text || ''/'' || (signed_at is null)::text from change_orders where sync_id = %L', coDel),
    'deleted order/true/true');
  perform pg_temp.p('57 CREW      moves the office''s job-B order onto job A', uCRW,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',coB,'job_sync_id',jA,'description','moved'))), '0/0/0/1');
  perform pg_temp.s('58 OFFICE    still on job B, text unchanged', format(
    'select (job_sync_id = %L)::text || ''/'' || description from change_orders where sync_id = %L', jB, coB),
    'true/office order on B');
  perform pg_temp.p('59 CREW      malformed: not an object, a bad sync id, no job, feet not a number', uCRW,
    format(rpc, format('[5, {"sync_id":"nope","job_sync_id":"%s"}, {"sync_id":"%s"}, '
                       '{"sync_id":"%s","job_sync_id":"%s","additional_feet":"abc"}]', jA, co59, co59, jA)), '0/0/0/4');
  perform pg_temp.s('59b OFFICE   none of them landed', format('select count(*)::text from change_orders where sync_id = %L', co59), '0');
  perform pg_temp.p('5A CREW      not an array: nothing, and no error', uCRW, format(rpc, '{"sync_id":"x"}'), '0/0/0/0');
  perform pg_temp.p('5B NO-FIELD  a login with neither RECORD_FIELD_WORK nor EDIT_JOBS is refused outright', uNOF,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',co5B,'job_sync_id',jA,'description','no pen'))),
    'ERR 42501: Not allowed to write change orders');
  -- Feet (verifier O13-O15). NaN and Infinity cast, and to_json writes them
  -- as strings the app's JSON refuses: one such row failed every phone's
  -- change_orders pull. Negative feet cut the labour billed. 20's order is
  -- unpriced, so its terms are still the crew's -- only the value is wrong.
  perform pg_temp.p('5C CREW      feet NaN on their own unpriced order; Infinity, -Infinity, -500, NaN on new orders', uCRW,
    format(rpc, jsonb_build_array(
      jsonb_build_object('company_id',SC,'sync_id',co20 ,'job_sync_id',jA,'description','crew edit','additional_feet','NaN'),
      jsonb_build_object('company_id',SC,'sync_id',co5C1,'job_sync_id',jA,'description','inf','additional_feet','Infinity'),
      jsonb_build_object('company_id',SC,'sync_id',co5C2,'job_sync_id',jA,'description','-inf','additional_feet','-Infinity'),
      jsonb_build_object('company_id',SC,'sync_id',co5C3,'job_sync_id',jA,'description','neg','additional_feet',-500),
      jsonb_build_object('company_id',SC,'sync_id',co5C4,'job_sync_id',jA,'description','nan','additional_feet','NaN'),
      jsonb_build_object('company_id',SC,'sync_id',co5C5,'job_sync_id',jA,'description','zero is fine','additional_feet',0))), '1/0/0/5');
  perform pg_temp.s('5D OFFICE    none of the four new ones landed, the zero did; 20''s feet still 6', format(
    'select (select count(*) from change_orders where sync_id in (%L,%L,%L,%L))::text || ''/'' '
    '|| (select count(*) from change_orders where sync_id = %L)::text || ''/'' '
    '|| (select additional_feet::text from change_orders where sync_id = %L)', co5C1, co5C2, co5C3, co5C4, co5C5, co20), '0/1/6');
  -- The signature image (verifier O10/O12): only this order's own folder.
  perform pg_temp.p('5E CREW      image paths outside the order''s folder, onto a signed order with no image', uCRW,
    format(rpc, jsonb_build_array(
      jsonb_build_object('company_id',SC,'sync_id',coSNP,'job_sync_id',jA,'description','signed no path','additional_feet',2,
        'signature_storage_path', SC2::text || '/' || jO::text || '/change-order/theirs.png'),
      jsonb_build_object('company_id',SC,'sync_id',coSNP,'job_sync_id',jA,'description','signed no path','additional_feet',2,
        'signature_storage_path', SC::text || '/' || jB::text || '/change-order/other-job.png'),
      jsonb_build_object('company_id',SC,'sync_id',coSNP,'job_sync_id',jA,'description','signed no path','additional_feet',2,
        'signature_storage_path', SC::text || '/' || jA::text || '/change-order/../../x.png'),
      jsonb_build_object('company_id',SC,'sync_id',coSNP,'job_sync_id',jA,'description','signed no path','additional_feet',2,
        'signature_storage_path', SC::text || '/' || jA::text || '/change-order/..'),
      jsonb_build_object('company_id',SC,'sync_id',coSNP,'job_sync_id',jA,'description','signed no path','additional_feet',2,
        'signature_storage_path', SC::text || '/' || jA::text || '/contract/x.png'),
      jsonb_build_object('company_id',SC,'sync_id',coSNP,'job_sync_id',jA,'description','signed no path','additional_feet',2,
        'signature_storage_path', '../../x.png'))), '0/0/6/0');
  perform pg_temp.s('5F OFFICE    still no image', format(
    'select coalesce(signature_storage_path,''null'') from change_orders where sync_id = %L', coSNP), 'null');
  perform pg_temp.p('5G CREW      control: the image from the order''s own folder', uCRW,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',coSNP,'job_sync_id',jA,'description','signed no path',
             'additional_feet',2,'signature_storage_path',sigA))), '0/1/0/0');
  perform pg_temp.s('5H OFFICE    it landed', format(
    'select coalesce(signature_storage_path,''null'') from change_orders where sync_id = %L', coSNP), sigA);
  -- The signing date (verifier O12): a year-2999 date, or an infinite one,
  -- is dropped; the order is priced and the terms match, so nothing else moves.
  perform pg_temp.p('5I CREW      signs the office''s priced order dated 2999, infinity and -infinity', uCRW,
    format(rpc, jsonb_build_array(
      jsonb_build_object('company_id',SC,'sync_id',coFut,'job_sync_id',jA,'description','priced for signing','additional_feet',3,
                         'signed_at','2999-01-01T00:00:00Z'),
      jsonb_build_object('company_id',SC,'sync_id',coFut,'job_sync_id',jA,'description','priced for signing','additional_feet',3,
                         'signed_at','infinity'),
      jsonb_build_object('company_id',SC,'sync_id',coFut,'job_sync_id',jA,'description','priced for signing','additional_feet',3,
                         'signed_at','-infinity'))), '0/0/3/0');
  perform pg_temp.s('5J OFFICE    still unsigned', format(
    'select (signed_at is null)::text from change_orders where sync_id = %L', coFut), 'true');
  perform pg_temp.p('5K CREW      control: a phone clock two hours fast (within a day) still signs', uCRW,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',coFut,'job_sync_id',jA,'description','priced for signing',
             'additional_feet',3,'signed_at',now() + interval '2 hours'))), '0/1/0/0');
  perform pg_temp.s('5L OFFICE    signed; still 80', format(
    'select (signed_at is not null)::text || ''/'' || additional_cost::text from change_orders where sync_id = %L', coFut), 'true/80');

  -- ======================================================================
  -- 6x  Job scope: can_see_job, live or a stand-in planted here
  -- ======================================================================
  live_scope := to_regprocedure('public.can_see_job(uuid)') is not null;
  if not live_scope then
    -- Hides job B from anyone who cannot edit jobs -- the shape of the real
    -- sees_all_jobs() or on-the-job rule, for these fixtures.
    execute format($p$create function public.can_see_job(p_job_sync_id uuid) returns boolean
                      language sql stable security definer set search_path = public as
                      $s$ select coalesce(public.has_permission('EDIT_JOBS'), false) or p_job_sync_id is distinct from %L::uuid $s$$p$, jB);
  end if;
  perform pg_temp.p('61 SCOPE     precondition: the crew login sees job A and not job B -- can_see_job is '
                    || case when live_scope then 'LIVE (job scope applied)' else 'a STAND-IN planted in this transaction' end, uCRW,
    format('select public.can_see_job(%L)::text || ''/'' || public.can_see_job(%L)::text', jA, jB), 'true/false');
  perform pg_temp.p('62 CREW      a new order on job B (not theirs)', uCRW,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',co61,'job_sync_id',jB,'description','not my job'))), '0/0/0/1');
  perform pg_temp.p('63 CREW      signs the office''s job-B order', uCRW,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',coB,'job_sync_id',jB,'description','office order on B',
             'signed_at',now()))), '0/0/0/1');
  perform pg_temp.s('64 OFFICE    nothing landed for 62; the job-B order is unsigned and unchanged', format(
    'select (select count(*) from change_orders where sync_id = %L)::text || ''/'' '
    '|| (select (signed_at is null)::text || ''/'' || description || ''/'' || additional_cost::text from change_orders where sync_id = %L)', co61, coB),
    '0/true/office order on B/75');
  perform pg_temp.p('65 CREW      control, same state: a new order on job A still lands', uCRW,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',co64,'job_sync_id',jA,'description','my job'))), '1/0/0/0');
  perform pg_temp.p('66 OWNER     sees every job: the owner''s RPC push on job B lands', uOWN,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',co65,'job_sync_id',jB,'description','owner on B'))), '1/0/0/0');
  if not live_scope then
    execute 'drop function public.can_see_job(uuid)';
    perform pg_temp.p('67 CREW      stand-in dropped (no job scope): job B is company work they may push to', uCRW,
      format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',co66,'job_sync_id',jB,'description','company-wide'))), '1/0/0/0');
  end if;
  -- FAIL CLOSED (verifier J24): job scope is here but can_see_job(uuid) is
  -- not -- renamed away (live), or a scope marker plus a (text) look-alike
  -- (stand-in). The call must be refused, not widened to the company.
  if live_scope then
    execute 'alter function public.can_see_job(uuid) rename to can_see_job_probe_hidden';
  else
    execute $p$create function public.my_visible_job_sync_ids() returns setof uuid language sql stable as $s$ select null::uuid where false $s$$p$;
    execute $p$create function public.can_see_job(p text) returns boolean language sql stable as $s$ select false $s$$p$;
  end if;
  perform pg_temp.p('68 SCOPE     job scope present, can_see_job(uuid) gone: the call is refused, not widened', uCRW,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',co68,'job_sync_id',jA,'description','scope hole'))),
    'ERR 42501: Crew job scope is incomplete');
  if live_scope then
    execute 'alter function public.can_see_job_probe_hidden(uuid) rename to can_see_job';
  else
    execute 'drop function public.my_visible_job_sync_ids()';
    execute 'drop function public.can_see_job(text)';
  end if;
  perform pg_temp.p('69 SCOPE     put back: the same push lands', uCRW,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',co68,'job_sync_id',jA,'description','scope hole'))), '1/0/0/0');

  -- ======================================================================
  -- 7x  The allowlist itself, and the grants
  -- ======================================================================
  -- A text scan: fast, and it names the column. It cannot see a column
  -- spelled through dynamic SQL -- 9x is what catches a write however spelled.
  perform pg_temp.s('70 BODY      outside the one pinned read, the RPC names no money, acceptance or tombstone column',
    'select pg_temp.forbidden_named(pg_temp.rpc_body_stripped())', '-');
  perform pg_temp.s('70b BODY     the pinned read (the office''s terms held) appears exactly once',
    $q$select ((length(b) - length(replace(b, pg_temp.office_read(), ''))) / length(pg_temp.office_read()))::text
         from (select pg_get_functiondef('public.crew_push_change_orders(jsonb)'::regprocedure) as b) t$q$, '1');
  perform pg_temp.s('71 PLANTED   the same scan finds a money column swapped into the body',
    $q$select (position('additional_cost' in pg_temp.forbidden_named(replace(pg_temp.rpc_body_stripped(), 'additional_feet', 'additional_cost'))) > 0)::text$q$,
    'true');
  perform pg_temp.s('72 GRANTS    anon / PUBLIC / authenticated / definer / config',
    $q$select has_function_privilege('anon', p.oid, 'execute')::text
          || '/' || exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)::text
          || '/' || has_function_privilege('authenticated', p.oid, 'execute')::text
          || '/' || p.prosecdef::text || '/' || coalesce(array_to_string(p.proconfig, ','), '')
         from pg_proc p where p.oid = 'public.crew_push_change_orders(jsonb)'::regprocedure$q$,
    'false/false/true/true/search_path=public');

  -- ======================================================================
  -- 9x  The same pushes with every trigger OFF
  -- ======================================================================
  -- 2x reads end states the money triggers would keep right whatever the RPC
  -- tried. session_replication_role = replica (transaction-local, no lock)
  -- stops every ordinary trigger -- the 00_zero/00_hold money shield, the
  -- acceptance latch, the delete guard -- so here only the RPC's own code
  -- stands between the payload and the row.
  -- A SET statement, not set_config(): Supabase allows this parameter only
  -- through the utility path.
  execute 'set local session_replication_role = replica';
  perform pg_temp.x('90 TRIGGERS  off: a crew bare INSERT now keeps its 999/55 (no shield underneath)', uCRW, format(ins, SC, co90, jA), 'rows=1');
  perform pg_temp.s('90b OFFICE   it did', format(money, co90), '999/55');
  perform pg_temp.p('91 CREW      RPC, NEW order: payload 999/55, accepted, deleted', uCRW,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',co91,'job_sync_id',jA,'description','replica new',
             'additional_feet',4,'additional_cost',999,'material_cost',55,'in_accepted_total',true,
             'deleted_at',now(),'deleted_by','crew'))), '1/0/0/0');
  perform pg_temp.s('92 OFFICE    0/0, not accepted, not deleted -- the RPC''s own doing', format(guard, co91), '0/0/false/true/');
  perform pg_temp.p('93 CREW      RPC onto the office''s priced order: costs 1/1, accepted, deleted; signed on its terms', uCRW,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',co9P,'job_sync_id',jA,'description','replica priced',
             'additional_feet',5,'additional_cost',1,'material_cost',1,'in_accepted_total',true,
             'deleted_at',now(),'deleted_by','crew','signed_at',now()))), '0/1/0/0');
  perform pg_temp.s('94 OFFICE    300/40, not accepted, not deleted; signed', format(
    'select (%s) || ''/'' || (signed_at is not null)::text from change_orders where sync_id = %L',
    'additional_cost::text || ''/'' || material_cost::text || ''/'' || in_accepted_total::text || ''/'' || (deleted_at is null)::text || ''/'' || deleted_by',
    co9P), '300/40/false/true//true');
  perform pg_temp.p('95 CREW      RPC onto an unpriced order: costs 999/55, accepted, deleted; new terms', uCRW,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',co9U,'job_sync_id',jA,'description','replica edit',
             'additional_feet',7,'additional_cost',999,'material_cost',55,'in_accepted_total',true,
             'deleted_at',now(),'deleted_by','crew'))), '0/1/0/0');
  perform pg_temp.s('96 OFFICE    0/0, not accepted, not deleted; the new terms landed', format(
    'select (%s) || ''/'' || description || ''/'' || additional_feet::text from change_orders where sync_id = %L',
    'additional_cost::text || ''/'' || material_cost::text || ''/'' || in_accepted_total::text || ''/'' || (deleted_at is null)::text || ''/'' || deleted_by',
    co9U), '0/0/false/true//replica edit/7');
  perform pg_temp.p('97 CREW      RPC onto the tombstoned order, deleted_at null (bring it back)', uCRW,
    format(rpc, jsonb_build_array(jsonb_build_object('company_id',SC,'sync_id',coDel,'job_sync_id',jA,'description','deleted order',
             'additional_feet',0,'deleted_at',null,'deleted_by',''))), '0/0/0/1');
  perform pg_temp.s('98 OFFICE    still deleted, by the office', format(
    'select (deleted_at is not null)::text || ''/'' || deleted_by from change_orders where sync_id = %L', coDel), 'true/probe office');
  execute 'set local session_replication_role = origin';
end $body$;

-- ======================================================================
-- 8x  The feet CHECK (supabase_r6_change_order_feet_check.sql). When it is
--     not applied yet, the RUN IT recipe splices it in at the marker below.
-- ======================================================================
-- @@FEET_CHECK@@
do $feet$
declare
  SC    uuid := 'b7000001-0000-4000-8000-000000000001';
  uOWN  uuid := 'b7100001-0000-4000-8000-000000000001';
  uCRW  uuid := 'b7100002-0000-4000-8000-000000000002';
  jA    uuid := 'b7300001-0000-4000-8000-000000000001';
  co81  uuid := 'b7400081-0000-4000-8000-000000000081';
  co82  uuid := 'b7400082-0000-4000-8000-000000000082';
  co83  uuid := 'b7400083-0000-4000-8000-000000000083';
  co84  uuid := 'b7400084-0000-4000-8000-000000000084';
  co85  uuid := 'b7400085-0000-4000-8000-000000000085';
  co86  uuid := 'b7400086-0000-4000-8000-000000000086';
  co87  uuid := 'b7400087-0000-4000-8000-000000000087';
  -- The crew's bare INSERT (PostgREST return=minimal), feet as given.
  bare text := 'insert into change_orders(company_id,sync_id,job_sync_id,description,additional_feet) '
               'values (%L,%L,%L,''feet probe'',%L::double precision)';
  rpc  text := 'select (x->>''inserted'') || ''/'' || (x->>''updated'') || ''/'' || (x->>''unchanged'') || ''/'' || (x->>''skipped'') '
               '  from (select public.crew_push_change_orders(%L::jsonb) as x) t';
begin
  perform pg_temp.s('80 CHECK     change_orders_feet_finite_nonnegative is here and validated (applied, or spliced in -- see RUN IT)',
    $q$select exists (select 1 from pg_constraint where conrelid = 'public.change_orders'::regclass
                        and conname = 'change_orders_feet_finite_nonnegative' and contype = 'c' and convalidated)::text$q$, 'true');
  perform pg_temp.x('81 CREW      bare INSERT with feet NaN (verifier T05 stored it)', uCRW, format(bare, SC, co81, jA, 'NaN'), 'ERR 23514');
  perform pg_temp.x('82 CREW      bare INSERT with feet Infinity', uCRW, format(bare, SC, co82, jA, 'Infinity'), 'ERR 23514');
  perform pg_temp.x('83 CREW      bare INSERT with feet -1', uCRW, format(bare, SC, co83, jA, '-1'), 'ERR 23514');
  perform pg_temp.x('84 OWNER     the office''s insert with feet NaN: every door, not just the crew''s', uOWN, format(bare, SC, co84, jA, 'NaN'), 'ERR 23514');
  perform pg_temp.x('85 CREW      control: bare INSERT with feet 12.5 lands', uCRW, format(bare, SC, co85, jA, '12.5'), 'rows=1');
  perform pg_temp.p('86 CREW      RPC batch: a NaN row beside a good one -- skipped, the batch stands', uCRW,
    format(rpc, jsonb_build_array(
      jsonb_build_object('company_id',SC,'sync_id',co86,'job_sync_id',jA,'description','nan','additional_feet','NaN'),
      jsonb_build_object('company_id',SC,'sync_id',co87,'job_sync_id',jA,'description','good','additional_feet',8))), '1/0/0/1');
  perform pg_temp.s('87 OFFICE    no stored feet anywhere is negative or not finite', $q$select count(*)::text from change_orders
     where not (additional_feet >= 0 and additional_feet < 'Infinity'::double precision)$q$, '0');
end $feet$;

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
