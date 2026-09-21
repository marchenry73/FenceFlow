-- P4 / auth_events fix -- CANARY + FIX + PROOF, one rolled-back transaction.
-- Proves supabase_p4_auth_events_fix.sql. Nothing here survives: it ends in
-- ROLLBACK, every subject is synthetic (probe.invalid addresses, f5ae... ids)
-- and created in-transaction.
--
-- Section C is the canary. It puts the ORIGINAL record_sign_in_failure back
-- (verbatim from supabase_p4_auth_events.sql) inside this transaction, forges
-- a failed sign-in against the synthetic platform admin as anon, shows the row
-- shape leaks whether an address exists, and mutes the per-target cap. Then it
-- restores whatever definition is live, so everything after it tests the live
-- database -- or, when the line marked @@FIX@@ has the fix spliced in, the fix
-- applied inside this same transaction.
--
-- Every attack is scored by AFFECTED ROW COUNT or by reading the table back as
-- postgres (no RLS), because no error is not proof. Each negative sits next to
-- a positive control that would fail first if the fixture were wrong. Roles
-- are asserted by property (is_platform_admin()) before anything else.
begin;

create temp table r(n serial, k text, v text);
grant all on r to authenticated, anon;
grant usage on sequence r_n_seq to authenticated, anon;

-- One impersonation helper. who: 'anon' | 'auth' (needs uid) | 'pg' (postgres,
-- no request context). hdr: request.headers JSON as PostgREST would set it.
-- want_rows: run for effect and report the real row count.
create function pg_temp.t(label text, who text, uid uuid, hdr text, q text, want_rows boolean default false)
returns void language plpgsql as $fn$
declare v text; c int;
begin
  if who = 'anon' then
    perform set_config('request.jwt.claims', json_build_object('role','anon')::text, true);
  elsif who = 'auth' then
    perform set_config('request.jwt.claims', json_build_object('sub',uid,'role','authenticated')::text, true);
  else
    perform set_config('request.jwt.claims', '', true);
  end if;
  perform set_config('request.headers', coalesce(hdr, ''), true);
  if who = 'anon' then execute 'set local role anon';
  elsif who = 'auth' then execute 'set local role authenticated'; end if;
  begin
    if want_rows then
      execute q; get diagnostics c = row_count; v := 'rows=' || c;
    else
      execute q into v; v := coalesce(v, 'NULL');
    end if;
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm, 150);
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.headers', '', true);
  insert into r(k, v) values (label, v);
end $fn$;

-- N anonymous reports in a row. rotate=false: every call from source ip;
-- rotate=true: call i comes from ip || i. email may contain %s for i.
create function pg_temp.flood(label text, cnt int, ip text, rotate boolean, email text, ua text)
returns void language plpgsql as $fn$
declare i int; errs int := 0; src text;
begin
  for i in 1..cnt loop
    src := case when rotate then ip || i::text else ip end;
    perform set_config('request.jwt.claims', json_build_object('role','anon')::text, true);
    perform set_config('request.headers',
      case when ip is null then '' else json_build_object('cf-connecting-ip', src)::text end, true);
    execute 'set local role anon';
    begin
      perform public.record_sign_in_failure(format(email, i), ua);
    exception when others then errs := errs + 1;
    end;
    execute 'reset role';
  end loop;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.headers', '', true);
  insert into r(k, v) values (label, 'calls=' || cnt || ' errors=' || errs);
end $fn$;

-- ===========================================================================
-- A. Fixtures, asserted by property
-- ===========================================================================
insert into auth.users(id, email) values
  ('f5ae0001-0000-4000-8000-000000000001', 'p4ae-adm@probe.invalid'),
  ('f5ae0002-0000-4000-8000-000000000002', 'p4ae-usr@probe.invalid');
insert into public.profiles(id, full_name, is_platform_admin) values
  ('f5ae0001-0000-4000-8000-000000000001', 'P4AE Admin', true),
  ('f5ae0002-0000-4000-8000-000000000002', 'P4AE User',  false);

do $body$
declare
  uADM uuid := 'f5ae0001-0000-4000-8000-000000000001';
  uUSR uuid := 'f5ae0002-0000-4000-8000-000000000002';
begin
  perform pg_temp.t('A00 FIXTURE admin is_platform_admin() (must be true)', 'auth', uADM, null,
    'select is_platform_admin()::text');
  perform pg_temp.t('A01 FIXTURE user  is_platform_admin() (must be false)', 'auth', uUSR, null,
    'select is_platform_admin()::text');
  perform pg_temp.t('A02 FIXTURE the admin address has an account (1)', 'pg', null, null,
    'select count(*)::text from auth.users where lower(email) = ''p4ae-adm@probe.invalid''');
  perform pg_temp.t('A03 FIXTURE the nobody address has none (0)', 'pg', null, null,
    'select count(*)::text from auth.users where lower(email) = ''p4ae-nobody@probe.invalid''');
end $body$;

-- ===========================================================================
-- C. CANARY -- the original function, reinstalled in-transaction
-- ===========================================================================
create temp table saved_def as
  select pg_get_functiondef('public.record_sign_in_failure(text,text)'::regprocedure) as d;

-- Verbatim from supabase_p4_auth_events.sql, section 4.
create or replace function public.record_sign_in_failure(
    p_email      text,
    p_user_agent text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    resolved_id uuid;
    recent_count integer;
begin
    if p_email is null or btrim(p_email) = '' then
        return; -- nothing to attribute; not worth a row
    end if;

    select id into resolved_id
    from auth.users
    where lower(email) = lower(btrim(p_email))
    limit 1;

    if resolved_id is not null then
        select count(*) into recent_count
        from public.auth_events
        where user_id = resolved_id
          and event_type = 'sign_in_failure'
          and created_at > now() - interval '15 minutes';
        if recent_count >= 20 then
            return; -- already well past "somebody is guessing this password"; skip logging more
        end if;
    else
        select count(*) into recent_count
        from public.auth_events
        where user_id is null
          and event_type = 'sign_in_failure'
          and created_at > now() - interval '5 minutes';
        if recent_count >= 200 then
            return; -- crude flood guard against scripted attempts with made-up addresses
        end if;
    end if;

    insert into public.auth_events (user_id, event_type, success, user_agent, detail)
    values (resolved_id, 'sign_in_failure', false, left(coalesce(p_user_agent, ''), 500), null);
end;
$$;

do $body$
declare
  uADM uuid := 'f5ae0001-0000-4000-8000-000000000001';
begin
  perform pg_temp.t('C10 CANARY anon reports a failure naming the ADMIN address', 'anon', null, null,
    'select public.record_sign_in_failure(''p4ae-adm@probe.invalid'', ''CANARY-1 attacker text'')::text');
  perform pg_temp.t('C11 CANARY rows now ATTRIBUTED to the admin user_id (HOLE if 1)', 'pg', null, null,
    format('select count(*)::text from public.auth_events where user_id = %L and user_agent like ''CANARY-1%%''', uADM));
  perform pg_temp.t('C12 CANARY anon reports a failure naming an address with NO account', 'anon', null, null,
    'select public.record_sign_in_failure(''p4ae-nobody@probe.invalid'', ''CANARY-2'')::text');
  perform pg_temp.t('C13 CANARY row shape, real vs no account (HOLE if they differ: existence oracle)', 'pg', null, null,
    $q$select (select case when user_id is null then 'user_id=null' else 'user_id=SET' end from public.auth_events where user_agent = 'CANARY-1 attacker text')
          || ' vs ' ||
              (select case when user_id is null then 'user_id=null' else 'user_id=SET' end from public.auth_events where user_agent = 'CANARY-2')$q$);
  perform pg_temp.flood('C14 CANARY anon floods the admin address x25', 25, null, false,
    'p4ae-adm@probe.invalid', 'CANARY-FLOOD');
  perform pg_temp.t('C15 CANARY then a REAL attempt at the admin address', 'anon', null, null,
    'select public.record_sign_in_failure(''p4ae-adm@probe.invalid'', ''CANARY-REAL'')::text');
  perform pg_temp.t('C16 CANARY admin-attributed rows | REAL rows kept (HOLE if 20 | 0: muted)', 'pg', null, null,
    format($q$select (select count(*) from public.auth_events where user_id = %L)::text
               || ' | ' || (select count(*) from public.auth_events where user_agent = 'CANARY-REAL')::text$q$, uADM));
end $body$;

-- Put back whatever is live.
do $body$ begin execute (select d from saved_def); end $body$;

-- ===========================================================================
-- The fix, when this probe runs before it is applied live.
-- @@FIX@@
-- ===========================================================================

do $body$
begin
  perform pg_temp.t('C19 the function now in force is the FIX (client_reported, no auth.users)', 'pg', null, null,
    $q$select (prosrc ilike '%client_reported%' and prosrc not ilike '%auth.users%')::text
         from pg_proc where oid = 'public.record_sign_in_failure(text,text)'::regprocedure$q$);
end $body$;

-- ===========================================================================
-- 2x. Anon cannot attribute, and cannot learn whether an address exists
-- ===========================================================================
do $body$
declare
  uADM uuid := 'f5ae0001-0000-4000-8000-000000000001';
  kA1 text;
begin
  perform pg_temp.t('20 anon: failure naming the ADMIN address -> response', 'anon', null, null,
    'select public.record_sign_in_failure(''p4ae-adm@probe.invalid'', ''AFTER-A1'')::text');
  perform pg_temp.t('21 anon: failure naming the NOBODY address -> response (same as 20)', 'anon', null, null,
    'select public.record_sign_in_failure(''p4ae-nobody@probe.invalid'', ''AFTER-A2'')::text');
  perform pg_temp.t('22 rows written by 20 | 21 (1 | 1: both kept alike)', 'pg', null, null,
    $q$select (select count(*) from public.auth_events where user_agent = 'AFTER-A1')::text || ' | ' ||
              (select count(*) from public.auth_events where user_agent = 'AFTER-A2')::text$q$);
  perform pg_temp.t('23 row shape of 20', 'pg', null, null,
    $q$select json_build_object('user_id', user_id, 'client_reported', client_reported, 'event_type', event_type,
             'success', success, 'detail', detail, 'attempt_key_len', length(attempt_key),
             'source_key_null', source_key is null)::text
         from public.auth_events where user_agent = 'AFTER-A1'$q$);
  perform pg_temp.t('24 row shape of 20 = row shape of 21 (must be true)', 'pg', null, null,
    $q$select ((select json_build_object('u', user_id, 'c', client_reported, 'e', event_type, 's', success, 'd', detail,
                   'k', length(attempt_key), 'src', source_key is null)::jsonb
                from public.auth_events where user_agent = 'AFTER-A1')
             = (select json_build_object('u', user_id, 'c', client_reported, 'e', event_type, 's', success, 'd', detail,
                   'k', length(attempt_key), 'src', source_key is null)::jsonb
                from public.auth_events where user_agent = 'AFTER-A2'))::text$q$);
  perform pg_temp.t('25 rows attributed to the admin user_id outside the canary (must be 0)', 'pg', null, null,
    format('select count(*)::text from public.auth_events where user_id = %L and user_agent not like ''CANARY%%''', uADM));
  perform pg_temp.t('26 endpoint source mentions auth.users (must be false)', 'pg', null, null,
    $q$select (pg_get_functiondef('public.record_sign_in_failure(text,text)'::regprocedure) ilike '%auth.users%')::text$q$);
  perform pg_temp.t('27 attempt_key differs between the two addresses (grouping works: true)', 'pg', null, null,
    $q$select ((select attempt_key from public.auth_events where user_agent = 'AFTER-A1')
            <> (select attempt_key from public.auth_events where user_agent = 'AFTER-A2'))::text$q$);
  perform pg_temp.t('28 anon: admin address in caps, padded, tab + zero-width space inside', 'anon', null, null,
    $q$select public.record_sign_in_failure('  P4AE-' || chr(8203) || 'ADM@Probe.Invalid' || chr(9) || ' ', 'AFTER-A3')::text$q$);
  perform pg_temp.t('29 ...groups with the plain admin address (same key: true)', 'pg', null, null,
    $q$select ((select attempt_key from public.auth_events where user_agent = 'AFTER-A1')
             = (select attempt_key from public.auth_events where user_agent = 'AFTER-A3'))::text$q$);
  perform pg_temp.t('2A anon: blank address writes nothing (rows=0 delta)', 'pg', null, null,
    $q$select count(*)::text from public.auth_events$q$);
  perform pg_temp.t('2A.. (call)', 'anon', null, null,
    $q$select public.record_sign_in_failure('   ', 'AFTER-BLANK')::text$q$);
  perform pg_temp.t('2A.. count after (must equal the line above)', 'pg', null, null,
    $q$select count(*)::text from public.auth_events$q$);
  perform pg_temp.t('2B anon: direct INSERT naming the admin (must be ERR 42501)', 'anon', null, null,
    format('insert into public.auth_events(user_id, event_type, success) values (%L, ''sign_in_failure'', false)', uADM), true);
  perform pg_temp.t('2C anon: record_auth_event (must be ERR 42501)', 'anon', null, null,
    'select public.record_auth_event(''sign_in_success'', true, ''x'', null)::text');
  perform pg_temp.t('2D anon: my_auth_attempt_key() (must be ERR 42501)', 'anon', null, null,
    'select public.my_auth_attempt_key()');
  perform pg_temp.t('2E anon: auth_events_hmac() (must be ERR 42501)', 'anon', null, null,
    'select public.auth_events_hmac(''identifier'', ''p4ae-adm@probe.invalid'')');
  perform pg_temp.t('2F anon: SELECT auth_events (must be ERR 42501)', 'anon', null, null,
    'select count(*)::text from public.auth_events');
  perform pg_temp.t('2G anon: SELECT auth_events_suppressed (must be ERR 42501)', 'anon', null, null,
    'select count(*)::text from public.auth_events_suppressed');
  perform pg_temp.t('2H anon: admin_sign_in_attempt_groups() (must be ERR 42501)', 'anon', null, null,
    'select count(*)::text from public.admin_sign_in_attempt_groups()');
  perform pg_temp.t('2I the TABLE refuses a client_reported row with a user_id, even as postgres (ERR 23514)', 'pg', null, null,
    format($q$insert into public.auth_events(user_id, event_type, success, client_reported, attempt_key)
              values (%L, 'sign_in_failure', false, true, 'x')$q$, uADM), true);
  perform pg_temp.t('2J grants: helpers not executable by anon/authenticated; RPCs as intended', 'pg', null, null,
    $q$select json_build_object(
         'helpers_anon',  bool_or(has_function_privilege('anon', f, 'execute')) filter (where h),
         'helpers_auth',  bool_or(has_function_privilege('authenticated', f, 'execute')) filter (where h),
         'failure_anon',  bool_or(has_function_privilege('anon', f, 'execute')) filter (where f = 'public.record_sign_in_failure(text,text)'::regprocedure),
         'mykey_anon',    bool_or(has_function_privilege('anon', f, 'execute')) filter (where f = 'public.my_auth_attempt_key()'::regprocedure),
         'mykey_auth',    bool_or(has_function_privilege('authenticated', f, 'execute')) filter (where f = 'public.my_auth_attempt_key()'::regprocedure),
         'groups_anon',   bool_or(has_function_privilege('anon', f, 'execute')) filter (where f = 'public.admin_sign_in_attempt_groups(integer,integer)'::regprocedure),
         'groups_auth',   bool_or(has_function_privilege('authenticated', f, 'execute')) filter (where f = 'public.admin_sign_in_attempt_groups(integer,integer)'::regprocedure),
         'tbl_auth_write', has_table_privilege('authenticated', 'public.auth_events', 'insert,update,delete,truncate'),
         'tbl_anon_any',   has_table_privilege('anon', 'public.auth_events', 'select,insert,update,delete,truncate'),
         'sup_auth_write', has_table_privilege('authenticated', 'public.auth_events_suppressed', 'insert,update,delete,truncate'),
         'sup_anon_any',   has_table_privilege('anon', 'public.auth_events_suppressed', 'select,insert,update,delete,truncate'))::text
       from (select p.oid::regprocedure as f,
                    p.proname in ('auth_events_clean_text','auth_events_normalise_identifier','auth_events_hmac',
                                  'auth_events_request_source','auth_events_before_insert') as h
               from pg_proc p where p.pronamespace = 'public'::regnamespace
                and p.proname in ('auth_events_clean_text','auth_events_normalise_identifier','auth_events_hmac',
                                  'auth_events_request_source','auth_events_before_insert',
                                  'record_sign_in_failure','my_auth_attempt_key','admin_sign_in_attempt_groups')) s$q$);
end $body$;

-- ===========================================================================
-- 3x. Client text is capped and cleaned, on both write paths
-- ===========================================================================
do $body$
declare
  uUSR uuid := 'f5ae0002-0000-4000-8000-000000000002';
begin
  perform pg_temp.t('30 anon: user agent with newline, ESC, RLO override, zero-width, 5000 chars', 'anon', null, null,
    $q$select public.record_sign_in_failure('p4ae-adm@probe.invalid',
         'AFTER-S1' || chr(10) || chr(27) || '[31m' || chr(8238) || 'evil' || chr(8203) || repeat('x', 5000))::text$q$);
  perform pg_temp.t('31 stored: length | any control/invisible left | head (300 | false | ...)', 'pg', null, null,
    $q$select length(user_agent)::text || ' | ' ||
              (user_agent ~ '[--؜᠎​-‏ -‮⁠-⁩﻿]')::text
              || ' | ' || left(user_agent, 20)
         from public.auth_events where user_agent like 'AFTER-S1%'$q$);
  perform pg_temp.t('32 signed-in user: record_auth_event with CR/LF-forged detail, 1000 chars', 'auth', uUSR, null,
    $q$select public.record_auth_event('sign_out', true, 'AFTER-S2' || chr(13) || chr(10) || 'x',
         'local' || chr(13) || chr(10) || 'sign_in_success FAKE LINE' || repeat('y', 1000))::text$q$);
  perform pg_temp.t('33 stored: detail length | control left | user_agent (200 | false | AFTER-S2x)', 'pg', null, null,
    $q$select length(detail)::text || ' | ' || (detail ~ '[-]')::text || ' | ' || user_agent
         from public.auth_events where user_agent like 'AFTER-S2%'$q$);
end $body$;

-- ===========================================================================
-- 4x. A signed-in NON-admin cannot attribute an event to anyone else
-- ===========================================================================
do $body$
declare
  uADM uuid := 'f5ae0001-0000-4000-8000-000000000001';
  uUSR uuid := 'f5ae0002-0000-4000-8000-000000000002';
begin
  perform pg_temp.t('40 POSITIVE user: record_auth_event(sign_in_failure) for self', 'auth', uUSR, null,
    'select public.record_auth_event(''sign_in_failure'', false, ''AFTER-D1'', null)::text');
  perform pg_temp.t('41 ...lands on the user''s OWN id (self)', 'pg', null, null,
    format('select case user_id when %L then ''self'' when %L then ''ADMIN'' else coalesce(user_id::text,''null'') end from public.auth_events where user_agent = ''AFTER-D1''', uUSR, uADM));
  perform pg_temp.t('42 user: record_sign_in_failure naming the ADMIN address', 'auth', uUSR, null,
    'select public.record_sign_in_failure(''p4ae-adm@probe.invalid'', ''AFTER-D2'')::text');
  perform pg_temp.t('43 ...stored unattributed: user_id | client_reported (null | true)', 'pg', null, null,
    $q$select coalesce(user_id::text, 'null') || ' | ' || client_reported::text from public.auth_events where user_agent = 'AFTER-D2'$q$);
  perform pg_temp.t('44 user: direct INSERT naming the admin (must be ERR 42501)', 'auth', uUSR, null,
    format('insert into public.auth_events(user_id, event_type, success) values (%L, ''sign_in_success'', true)', uADM), true);
  perform pg_temp.t('45 rows attributed to the admin by any of the above (must be 0)', 'pg', null, null,
    format('select count(*)::text from public.auth_events where user_id = %L and user_agent like ''AFTER-D%%''', uADM));
  perform pg_temp.t('46 record_auth_event: args | body md5 unchanged (dd6faeab... = original)', 'pg', null, null,
    $q$select pg_get_function_arguments(oid) || ' | ' || (md5(prosrc) = 'dd6faeab285473efa368cc9210a99eb2')::text
         from pg_proc where oid = 'public.record_auth_event(text,boolean,text,text)'::regprocedure$q$);
end $body$;

-- ===========================================================================
-- 5x. Real staff events are still recorded
-- ===========================================================================
do $body$
declare
  uADM uuid := 'f5ae0001-0000-4000-8000-000000000001';
  uUSR uuid := 'f5ae0002-0000-4000-8000-000000000002';
  kA1 text;
begin
  perform pg_temp.t('50 staff sign-in: record_auth_event(sign_in_success)', 'auth', uADM, null,
    'select public.record_auth_event(''sign_in_success'', true, ''AFTER-E1'', null)::text');
  perform pg_temp.t('51 ...row: attributed to | client_reported (ADMIN | false)', 'pg', null, null,
    format('select case user_id when %L then ''ADMIN'' else coalesce(user_id::text,''null'') end || '' | '' || client_reported from public.auth_events where user_agent = ''AFTER-E1''', uADM));
  perform pg_temp.t('52 staff password failure: the browser reports it anonymously', 'anon', null,
    '{"cf-connecting-ip":"192.0.2.50"}',
    'select public.record_sign_in_failure(''p4ae-adm@probe.invalid'', ''AFTER-E2'')::text');
  perform pg_temp.t('53 ...kept: rows | client_reported (1 | true)', 'pg', null, null,
    $q$select count(*)::text || ' | ' || coalesce(bool_and(client_reported)::text, 'none') from public.auth_events where user_agent = 'AFTER-E2'$q$);
  perform pg_temp.t('54 ...and the staff console recognises it as ITS address (true)', 'auth', uADM, null,
    $q$select (public.my_auth_attempt_key() = (select attempt_key from public.auth_events where user_agent = 'AFTER-E2'))::text$q$);
  select attempt_key into kA1 from public.auth_events where user_agent = 'AFTER-A1';
  perform pg_temp.t('55 the other user''s key is its own, not the admin''s (true)', 'auth', uUSR, null,
    format('select (public.my_auth_attempt_key() is not null and public.my_auth_attempt_key() <> %L)::text', kA1));
  perform pg_temp.t('56 staff two-factor failure: record_auth_event(mfa_challenge_failure)', 'auth', uADM, null,
    'select public.record_auth_event(''mfa_challenge_failure'', false, ''AFTER-E3'', null)::text');
  perform pg_temp.t('57 ...attributed to (ADMIN)', 'pg', null, null,
    format('select case user_id when %L then ''ADMIN'' else coalesce(user_id::text,''null'') end from public.auth_events where user_agent = ''AFTER-E3''', uADM));
  perform pg_temp.t('58 panel groups, as the admin: top group', 'auth', uADM, null,
    $q$select json_build_object('is_mine', is_mine, 'attempts', attempts, 'sources', sources,
                                'key_is_mine', attempt_key = public.my_auth_attempt_key(), 'groups', total_groups)::text
         from public.admin_sign_in_attempt_groups(7, 20) limit 1$q$);
  perform pg_temp.t('59 ...attempts at the admin address, counted as postgres (= attempts above)', 'pg', null, null,
    format('select count(*)::text from public.auth_events where client_reported and attempt_key = %L', kA1));
end $body$;

-- ===========================================================================
-- 6x. Flood guard: per source and global, never per target
-- ===========================================================================
do $body$
declare
  kA1 text;
begin
  select attempt_key into kA1 from public.auth_events where user_agent = 'AFTER-A1';

  perform pg_temp.t('60 source parsing: cf-connecting-ip', 'anon', null, '{"cf-connecting-ip":"192.0.2.9"}',
    'select public.record_sign_in_failure(''p4ae-h@probe.invalid'', ''AFTER-H1'')::text');
  perform pg_temp.t('60.. x-forwarded-for, first hop', 'anon', null, '{"x-forwarded-for":"192.0.2.9, 10.0.0.1"}',
    'select public.record_sign_in_failure(''p4ae-h@probe.invalid'', ''AFTER-H2'')::text');
  perform pg_temp.t('60.. no headers at all', 'anon', null, null,
    'select public.record_sign_in_failure(''p4ae-h@probe.invalid'', ''AFTER-H3'')::text');
  perform pg_temp.t('61 same source both ways | no-header source is null (true | true)', 'pg', null, null,
    $q$select ((select source_key from public.auth_events where user_agent = 'AFTER-H1')
             = (select source_key from public.auth_events where user_agent = 'AFTER-H2'))::text || ' | ' ||
              ((select source_key from public.auth_events where user_agent = 'AFTER-H3') is null)::text$q$);

  perform pg_temp.t('62 suppressed tally before (source | global)', 'pg', null, null,
    $q$select coalesce(sum(suppressed) filter (where reason = 'source'), 0)::text || ' | ' ||
              coalesce(sum(suppressed) filter (where reason = 'global'), 0)::text
         from public.auth_events_suppressed where bucket = date_trunc('hour', now())$q$);
  perform pg_temp.flood('63 ONE source hammers the ADMIN address x35', 35, '198.51.100.7', false,
    'p4ae-adm@probe.invalid', 'AFTER-F1');
  perform pg_temp.t('64 ...kept from that source (30: per-source cap)', 'pg', null, null,
    $q$select count(*)::text from public.auth_events where user_agent = 'AFTER-F1'$q$);
  perform pg_temp.t('65 a REAL attempt at the admin address from another source', 'anon', null, '{"cf-connecting-ip":"198.51.100.8"}',
    'select public.record_sign_in_failure(''p4ae-adm@probe.invalid'', ''AFTER-F2'')::text');
  perform pg_temp.t('66 ...kept (1: the flood did not mute the account)', 'pg', null, null,
    $q$select count(*)::text from public.auth_events where user_agent = 'AFTER-F2'$q$);
  perform pg_temp.flood('67 60 ROTATING sources all name the admin address', 60, '203.0.113.', true,
    'p4ae-adm@probe.invalid', 'AFTER-F3');
  perform pg_temp.t('68 ...kept (60: nothing caps a target)', 'pg', null, null,
    $q$select count(*)::text from public.auth_events where user_agent = 'AFTER-F3'$q$);
  perform pg_temp.t('69 then a REAL attempt at the admin address from a fresh source', 'anon', null, '{"cf-connecting-ip":"198.51.100.9"}',
    'select public.record_sign_in_failure(''p4ae-adm@probe.invalid'', ''AFTER-F4'')::text');
  perform pg_temp.t('6A ...kept (1; the canary''s same attack kept 0)', 'pg', null, null,
    $q$select count(*)::text from public.auth_events where user_agent = 'AFTER-F4'$q$);
  perform pg_temp.t('6B client rows in the last 5 minutes, before the global fill', 'pg', null, null,
    $q$select count(*)::text from public.auth_events where client_reported and created_at > now() - interval '5 minutes'$q$);
  perform pg_temp.flood('6C 250 rotating sources, random addresses (global fill)', 250, '10.77.', true,
    'p4ae-g%s@probe.invalid', 'AFTER-G');
  perform pg_temp.t('6D client rows in the last 5 minutes (200: global cap)', 'pg', null, null,
    $q$select count(*)::text from public.auth_events where client_reported and created_at > now() - interval '5 minutes'$q$);
  perform pg_temp.t('6E past the global cap: a report from a fresh source -> response (same NULL)', 'anon', null, '{"cf-connecting-ip":"198.51.100.10"}',
    'select public.record_sign_in_failure(''p4ae-adm@probe.invalid'', ''AFTER-G-OVER'')::text');
  perform pg_temp.t('6F ...not kept (0)', 'pg', null, null,
    $q$select count(*)::text from public.auth_events where user_agent = 'AFTER-G-OVER'$q$);
  perform pg_temp.t('6G suppressed tally after (source | global): +5 | +(250-kept)+1', 'pg', null, null,
    $q$select coalesce(sum(suppressed) filter (where reason = 'source'), 0)::text || ' | ' ||
              coalesce(sum(suppressed) filter (where reason = 'global'), 0)::text
         from public.auth_events_suppressed where bucket = date_trunc('hour', now())$q$);
  perform pg_temp.t('6H AFTER-G rows kept', 'pg', null, null,
    $q$select count(*)::text from public.auth_events where user_agent = 'AFTER-G'$q$);
end $body$;

-- ===========================================================================
-- 7x. Nobody can update or delete
-- ===========================================================================
create temp table snap as
  select (select md5(coalesce(string_agg(row_to_json(e)::text, '' order by e.id), '')) from public.auth_events e) as ev,
         (select count(*) from public.auth_events) as ev_n,
         (select md5(coalesce(string_agg(row_to_json(s)::text, '' order by s.bucket, s.reason), '')) from public.auth_events_suppressed s) as sup;

do $body$
declare
  uADM uuid := 'f5ae0001-0000-4000-8000-000000000001';
  uUSR uuid := 'f5ae0002-0000-4000-8000-000000000002';
begin
  perform pg_temp.t('70 anon  UPDATE auth_events (ERR 42501)', 'anon', null, null,
    format('update public.auth_events set user_id = %L', uADM), true);
  perform pg_temp.t('71 anon  DELETE auth_events (ERR 42501)', 'anon', null, null,
    'delete from public.auth_events', true);
  perform pg_temp.t('72 user  UPDATE auth_events (ERR 42501)', 'auth', uUSR, null,
    format('update public.auth_events set user_id = %L', uUSR), true);
  perform pg_temp.t('73 user  DELETE auth_events (ERR 42501)', 'auth', uUSR, null,
    'delete from public.auth_events', true);
  perform pg_temp.t('74 ADMIN UPDATE auth_events: claim the unverified rows (ERR 42501)', 'auth', uADM, null,
    format('update public.auth_events set client_reported = false, attempt_key = null, source_key = null, user_id = %L where client_reported', uADM), true);
  perform pg_temp.t('75 ADMIN DELETE auth_events (ERR 42501)', 'auth', uADM, null,
    'delete from public.auth_events', true);
  perform pg_temp.t('76 ADMIN TRUNCATE auth_events (ERR 42501)', 'auth', uADM, null,
    'truncate public.auth_events', true);
  perform pg_temp.t('77 ADMIN UPDATE auth_events_suppressed (ERR 42501)', 'auth', uADM, null,
    'update public.auth_events_suppressed set suppressed = 0', true);
  perform pg_temp.t('78 ADMIN DELETE auth_events_suppressed (ERR 42501)', 'auth', uADM, null,
    'delete from public.auth_events_suppressed', true);
  perform pg_temp.t('79 anon  INSERT auth_events_suppressed (ERR 42501)', 'anon', null, null,
    'insert into public.auth_events_suppressed(bucket, reason, suppressed) values (now(), ''global'', 0)', true);
  perform pg_temp.t('7A both tables byte-identical to the snapshot (true | true)', 'pg', null, null,
    $q$select ((select md5(coalesce(string_agg(row_to_json(e)::text, '' order by e.id), '')) from public.auth_events e) = (select ev from snap))::text
         || ' | ' ||
              ((select md5(coalesce(string_agg(row_to_json(s)::text, '' order by s.bucket, s.reason), '')) from public.auth_events_suppressed s) = (select sup from snap))::text$q$);
end $body$;

-- ===========================================================================
-- 8x. Non-admins still cannot read
-- ===========================================================================
do $body$
declare
  uADM uuid := 'f5ae0001-0000-4000-8000-000000000001';
  uUSR uuid := 'f5ae0002-0000-4000-8000-000000000002';
begin
  perform pg_temp.t('80 rows in auth_events, as postgres', 'pg', null, null,
    'select count(*)::text from public.auth_events');
  perform pg_temp.t('81 POSITIVE admin reads (= line 80)', 'auth', uADM, null,
    'select count(*)::text from public.auth_events');
  perform pg_temp.t('82 user reads auth_events (0)', 'auth', uUSR, null,
    'select count(*)::text from public.auth_events');
  perform pg_temp.t('83 user reads even its OWN rows (0)', 'auth', uUSR, null,
    format('select count(*)::text from public.auth_events where user_id = %L', uUSR));
  perform pg_temp.t('84 POSITIVE admin: attempt groups returned', 'auth', uADM, null,
    'select count(*)::text from public.admin_sign_in_attempt_groups(7, 100)');
  perform pg_temp.t('85 user: attempt groups returned (0)', 'auth', uUSR, null,
    'select count(*)::text from public.admin_sign_in_attempt_groups(7, 100)');
  perform pg_temp.t('86 POSITIVE admin reads auth_events_suppressed (rows)', 'auth', uADM, null,
    'select count(*)::text from public.auth_events_suppressed');
  perform pg_temp.t('87 user reads auth_events_suppressed (0)', 'auth', uUSR, null,
    'select count(*)::text from public.auth_events_suppressed');
end $body$;

select jsonb_pretty(jsonb_agg(jsonb_build_array(n, k, v) order by n)) as p4_auth_events_fix from r;
rollback;
