-- ============================================================
-- FenceFlow -- company email PROOF, one rolled-back transaction.
-- Proves supabase_mail.sql. Nothing here survives: it ends in ROLLBACK, and
-- every subject is synthetic (a11a... ids, *.example / *.invalid addresses,
-- PROBE-MAIL companies) and created in-transaction.
--
-- Run it AFTER supabase_mail.sql is applied, as it stands. To prove the file
-- BEFORE it is applied, replace the line "-- @@MAIL@@" below with the whole of
-- supabase_mail.sql; the schema is then created inside this same transaction
-- and rolled back with everything else.
--
-- Every check is scored: the last statement returns
--   {failed, total, failures:[...], all:[...]}
-- and "failed": 0 is the only passing answer. Negatives are scored by the
-- error code or the row count that comes back, never by the absence of an
-- error, and each sits beside a positive control that would fail first if the
-- fixture were wrong: an owner who must see the canary before a crew member's
-- zero means anything, a secret that must round-trip before a refusal counts,
-- a grant query that must find the one grant that exists. Subjects are
-- asserted by property (role, has_permission, company_allowed) first. The
-- teeth section swaps the gate for "true" inside the transaction and shows
-- crew THEN sees the canary -- so the zero came from the gate, not from an
-- empty table.
--
-- Impersonation is the way PostgREST does it: set local role plus
-- request.jwt.claims including the role claim (without it auth.role() is
-- null and a correct policy looks broken).
-- ============================================================
begin;

-- @@MAIL@@

create temp table r (n serial, k text, v text, want text, ok boolean);
create temp table fx (k text primary key, id uuid not null);

-- who: 'anon' | 'auth' (JWT for uid) | 'svc' (service role) |
--      'pgauth' (postgres privileges but an authenticated JWT -- proves an
--      in-function check on its own, with the grant out of the way) |
--      'pg' (direct connection, no request context).
-- want: exact text, or a LIKE pattern ending in %. want_rows: run for effect
-- and report the real affected-row count.
create function pg_temp.t(label text, who text, uid uuid, q text, want text, want_rows boolean default false)
returns void language plpgsql as $fn$
declare v text; c int;
begin
  if who = 'anon' then
    perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  elsif who in ('auth', 'pgauth') then
    perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  elsif who = 'svc' then
    perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  else
    perform set_config('request.jwt.claims', '', true);
  end if;
  if who = 'anon' then execute 'set local role anon';
  elsif who = 'auth' then execute 'set local role authenticated';
  elsif who = 'svc' then execute 'set local role service_role';
  end if;
  begin
    if want_rows then
      execute q; get diagnostics c = row_count; v := 'rows=' || c;
    else
      execute q into v; v := coalesce(v, 'NULL');
    end if;
  exception when others then
    v := 'ERR ' || sqlstate || ': ' || left(sqlerrm, 160);
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  insert into r (k, v, want, ok)
  values (label, v, want, v = want or (right(want, 1) = '%' and v like want));
end $fn$;

create function pg_temp.fx(key text) returns uuid language sql as $$ select id from fx where k = key $$;

-- One ingest row, as the service role. Answers "inserted" for the row.
create function pg_temp.ingest(label text, acct uuid, row_json jsonb, want text)
returns void language plpgsql as $fn$
begin
  perform pg_temp.t(label, 'svc', null,
    format('select string_agg(inserted::text, '','') from public.mail_ingest(%L, %L::jsonb)',
           acct, jsonb_build_array(row_json)::text), want);
end $fn$;

-- ===========================================================================
-- 0. Fixtures (as postgres, no request context)
-- ===========================================================================
insert into fx values
  ('cA',    'a11a0000-0000-4000-8000-00000000000a'),
  ('cB',    'a11a0000-0000-4000-8000-00000000000b'),
  ('cC',    'a11a0000-0000-4000-8000-00000000000c'),
  ('uOWN',  'a11a0001-0000-4000-8000-000000000001'),  -- OWNER A
  ('uMGR',  'a11a0001-0000-4000-8000-000000000002'),  -- MANAGER A, no mail_access row
  ('uMGRX', 'a11a0001-0000-4000-8000-000000000003'),  -- MANAGER A, allowed=false
  ('uMGRN', 'a11a0001-0000-4000-8000-000000000004'),  -- MANAGER A, -SEE_MONEY
  ('uSAL',  'a11a0001-0000-4000-8000-000000000005'),  -- SALES A, allowed=true
  ('uSAL0', 'a11a0001-0000-4000-8000-000000000006'),  -- SALES A, no row
  ('uFOR',  'a11a0001-0000-4000-8000-000000000007'),  -- FOREMAN A, allowed=true, no SEE_MONEY
  ('uFORM', 'a11a0001-0000-4000-8000-000000000008'),  -- FOREMAN A, +SEE_MONEY, allowed=true
  ('uCRW',  'a11a0001-0000-4000-8000-000000000009'),  -- CREW A
  ('uCRWX', 'a11a0001-0000-4000-8000-00000000000a'),  -- CREW A, +SEE_MONEY AND allowed=true
  ('uBOWN', 'a11a0001-0000-4000-8000-00000000000b'),  -- OWNER B
  ('uCOWN', 'a11a0001-0000-4000-8000-00000000000c'),  -- OWNER C (suspended later)
  ('uADM',  'a11a0001-0000-4000-8000-00000000000d'),  -- platform admin, no company
  ('uACC',  'a11a0001-0000-4000-8000-00000000000e'),  -- ACCOUNTANT A, no row
  ('aA',    'a11a0002-0000-4000-8000-00000000000a'),  -- imap account A
  ('aB',    'a11a0002-0000-4000-8000-00000000000b'),
  ('aC',    'a11a0002-0000-4000-8000-00000000000c'),
  ('aS',    'a11a0002-0000-4000-8000-0000000000ff'),  -- scratch account for the cascade test
  ('tA',    'a11a0003-0000-4000-8000-00000000000a'),
  ('tB',    'a11a0003-0000-4000-8000-00000000000b'),
  ('tC',    'a11a0003-0000-4000-8000-00000000000c'),
  ('mA',    'a11a0004-0000-4000-8000-00000000000a'),
  ('mB',    'a11a0004-0000-4000-8000-00000000000b'),
  ('mC',    'a11a0004-0000-4000-8000-00000000000c'),
  ('jA',    'a11a0005-0000-4000-8000-00000000000a'),  -- live job, company A
  ('jB',    'a11a0005-0000-4000-8000-00000000000b'),  -- live job, company B
  ('jDEL',  'a11a0005-0000-4000-8000-0000000000de'),  -- soft-deleted job, company A
  ('cuA',   'a11a0006-0000-4000-8000-00000000000a'),  -- customer of jA
  ('csF',   'a11a0007-0000-4000-8000-000000000001'),  -- client_send_id of a FenceFlow send
  ('csJ',   'a11a0007-0000-4000-8000-000000000002');  -- client_send_id of a send from the job sheet

do $body$
declare
  cA uuid := pg_temp.fx('cA'); cB uuid := pg_temp.fx('cB'); cC uuid := pg_temp.fx('cC');
begin
  perform set_config('request.jwt.claims', '', true);
  insert into auth.users (id, email)
  select id, 'probe-mail-' || k || '@probe.invalid' from fx where k like 'u%';
  insert into companies (id, name, subscription_status, subscription_plan, suspended, trial_ends_at,
                         admin_notes, leads_token, stripe_customer_id, invited_email, suspended_reason)
  values (cA, 'PROBE-MAIL-A', 'active', 'pro', false, now() + interval '30 days', '', gen_random_uuid(), 'cus_PMA', '', ''),
         (cB, 'PROBE-MAIL-B', 'active', 'pro', false, now() + interval '30 days', '', gen_random_uuid(), 'cus_PMB', '', ''),
         (cC, 'PROBE-MAIL-C', 'active', 'pro', false, now() + interval '30 days', '', gen_random_uuid(), 'cus_PMC', '', '');
  insert into profiles (id, company_id, full_name, role, is_platform_admin, permission_overrides) values
    (pg_temp.fx('uOWN'),  cA, 'PM Owner',        'OWNER',      false, ''),
    (pg_temp.fx('uMGR'),  cA, 'PM Manager',      'MANAGER',    false, ''),
    (pg_temp.fx('uMGRX'), cA, 'PM Manager Off',  'MANAGER',    false, ''),
    (pg_temp.fx('uMGRN'), cA, 'PM Manager NoMoney', 'MANAGER', false, '-SEE_MONEY'),
    (pg_temp.fx('uSAL'),  cA, 'PM Sales On',     'SALES',      false, ''),
    (pg_temp.fx('uSAL0'), cA, 'PM Sales',        'SALES',      false, ''),
    (pg_temp.fx('uFOR'),  cA, 'PM Foreman',      'FOREMAN',    false, ''),
    (pg_temp.fx('uFORM'), cA, 'PM Foreman Money','FOREMAN',    false, '+SEE_MONEY'),
    (pg_temp.fx('uCRW'),  cA, 'PM Crew',         'CREW',       false, ''),
    (pg_temp.fx('uCRWX'), cA, 'PM Crew Granted', 'CREW',       false, '+SEE_MONEY'),
    (pg_temp.fx('uBOWN'), cB, 'PM Owner B',      'OWNER',      false, ''),
    (pg_temp.fx('uCOWN'), cC, 'PM Owner C',      'OWNER',      false, ''),
    (pg_temp.fx('uADM'),  null, 'PM Admin',      'OWNER',      true,  ''),
    (pg_temp.fx('uACC'),  cA, 'PM Accountant',   'ACCOUNTANT', false, '');

  -- Grants written directly: the RPC would (rightly) refuse the CREW one.
  insert into public.mail_access (company_id, profile_id, allowed, set_by) values
    (cA, pg_temp.fx('uMGRX'), false, pg_temp.fx('uOWN')),
    (cA, pg_temp.fx('uSAL'),  true,  pg_temp.fx('uOWN')),
    (cA, pg_temp.fx('uFOR'),  true,  pg_temp.fx('uOWN')),
    (cA, pg_temp.fx('uFORM'), true,  pg_temp.fx('uOWN')),
    (cA, pg_temp.fx('uCRWX'), true,  pg_temp.fx('uOWN'));

  insert into public.mail_accounts (id, company_id, kind, provider, email_address, username,
                                    imap_host, smtp_host, imap_port, smtp_port, sent_folder, connected_by)
  values
    (pg_temp.fx('aA'), cA, 'imap', 'zoho', 'Office@Acme-Fence.example', 'office@acme-fence.example',
     'imappro.zoho.com', 'smtppro.zoho.com', 993, 465, 'Sent', pg_temp.fx('uOWN')),
    (pg_temp.fx('aB'), cB, 'imap', 'zoho', 'office@b-fence.example', 'office@b-fence.example',
     'imappro.zoho.com', 'smtppro.zoho.com', 993, 465, 'Sent', pg_temp.fx('uBOWN')),
    (pg_temp.fx('aC'), cC, 'imap', 'gmail', 'office@c-fence.example', 'office@c-fence.example',
     'imap.gmail.com', 'smtp.gmail.com', 993, 465, '[Gmail]/Sent Mail', pg_temp.fx('uCOWN'));

  insert into public.mail_threads (id, company_id, subject) values
    (pg_temp.fx('tA'), cA, 'Canary A'), (pg_temp.fx('tB'), cB, 'B only'), (pg_temp.fx('tC'), cC, 'C only');
  insert into public.mail_messages (id, company_id, account_id, thread_id, folder_role, source, uidvalidity, uid,
                                    message_id_header, from_address, from_name, subject, received_at,
                                    counterpart_emails, snippet)
  values
    (pg_temp.fx('mA'), cA, pg_temp.fx('aA'), pg_temp.fx('tA'), 'inbox', 'imap', 1, 1, 'canary-a@probe.invalid',
     'canary@probe.invalid', 'Canary', 'Canary A', now() - interval '3 days', '{canary@probe.invalid}', 'canary a'),
    (pg_temp.fx('mB'), cB, pg_temp.fx('aB'), pg_temp.fx('tB'), 'inbox', 'imap', 1, 1, 'canary-b@probe.invalid',
     'canary@probe.invalid', 'Canary', 'B only', now() - interval '3 days', '{canary@probe.invalid}', 'canary b'),
    (pg_temp.fx('mC'), cC, pg_temp.fx('aC'), pg_temp.fx('tC'), 'inbox', 'imap', 1, 1, 'canary-c@probe.invalid',
     'canary@probe.invalid', 'Canary', 'C only', now() - interval '3 days', '{canary@probe.invalid}', 'canary c');

  insert into customers (id, company_id, name, address, phone, email, notes, sync_id)
  values (pg_temp.fx('cuA'), cA, 'PM Customer', '1 Probe St', '555-0100', 'Pat.Home@Example.net', '', pg_temp.fx('cuA'));
  insert into jobs (id, company_id, customer_id, customer_name, address, phone, email, hoa_email, status, sync_id,
                    quote_token, is_test_fixture, notes, blocked_reason, deleted_at)
  values
    (pg_temp.fx('jA'), cA, pg_temp.fx('cuA'), 'PM Customer', '1 Probe St', '555-0100', ' PAT@example.org ',
     'board@hoa.example', 'DRAFT', pg_temp.fx('jA'), gen_random_uuid(), true, '', '', null),
    (pg_temp.fx('jB'), cB, null, 'PM B Customer', '2 Probe St', '555-0200', 'pat@example.org',
     '', 'DRAFT', pg_temp.fx('jB'), gen_random_uuid(), true, '', '', null),
    (pg_temp.fx('jDEL'), cA, null, 'PM Gone', '3 Probe St', '555-0300', 'pat@example.org',
     '', 'DRAFT', pg_temp.fx('jDEL'), gen_random_uuid(), true, '', '', now());
end $body$;

-- ===========================================================================
-- A. Fixtures asserted by property
-- ===========================================================================
do $body$
declare
  pm text := 'select (select role::text from profiles where id = auth.uid()) || ''/'' || has_permission(''SEE_MONEY'')::text';
begin
  perform pg_temp.t('A01 OWNER  role/SEE_MONEY',            'auth', pg_temp.fx('uOWN'),  pm, 'OWNER/true');
  perform pg_temp.t('A02 MGR    role/SEE_MONEY',            'auth', pg_temp.fx('uMGR'),  pm, 'MANAGER/true');
  perform pg_temp.t('A03 MGRX   role/SEE_MONEY',            'auth', pg_temp.fx('uMGRX'), pm, 'MANAGER/true');
  perform pg_temp.t('A04 MGRN   role/SEE_MONEY (override off)', 'auth', pg_temp.fx('uMGRN'), pm, 'MANAGER/false');
  perform pg_temp.t('A05 SAL    role/SEE_MONEY',            'auth', pg_temp.fx('uSAL'),  pm, 'SALES/true');
  perform pg_temp.t('A06 FOR    role/SEE_MONEY',            'auth', pg_temp.fx('uFOR'),  pm, 'FOREMAN/false');
  perform pg_temp.t('A07 FORM   role/SEE_MONEY (override on)', 'auth', pg_temp.fx('uFORM'), pm, 'FOREMAN/true');
  perform pg_temp.t('A08 CRW    role/SEE_MONEY',            'auth', pg_temp.fx('uCRW'),  pm, 'CREW/false');
  -- The crew member below HOLDS SEE_MONEY and a grant: only the hard-coded
  -- CREW exclusion stands between them and the mail.
  perform pg_temp.t('A09 CRWX   role/SEE_MONEY (override on)', 'auth', pg_temp.fx('uCRWX'), pm, 'CREW/true');
  perform pg_temp.t('A10 ADM    is_platform_admin, no company', 'auth', pg_temp.fx('uADM'),
    'select is_platform_admin()::text || ''/'' || coalesce(current_company_id()::text, ''none'')', 'true/none');
  perform pg_temp.t('A11 companies A/B/C allowed', 'pg', null,
    format('select company_allowed(%L)::text||''/''||company_allowed(%L)::text||''/''||company_allowed(%L)::text',
           pg_temp.fx('cA'), pg_temp.fx('cB'), pg_temp.fx('cC')), 'true/true/true');
  perform pg_temp.t('A12 canary rows exist (postgres sees 3)', 'pg', null,
    format('select count(*)::text from public.mail_messages where company_id in (%L,%L,%L)',
           pg_temp.fx('cA'), pg_temp.fx('cB'), pg_temp.fx('cC')), '3');
end $body$;

-- ===========================================================================
-- B. The gate, per subject
-- ===========================================================================
do $body$
declare g text := 'select public.can_use_company_mail()::text';
begin
  perform pg_temp.t('B01 POSITIVE OWNER gate',                 'auth', pg_temp.fx('uOWN'),  g, 'true');
  perform pg_temp.t('B02 POSITIVE MANAGER (no row) gate',      'auth', pg_temp.fx('uMGR'),  g, 'true');
  perform pg_temp.t('B03 MANAGER allowed=false gate',          'auth', pg_temp.fx('uMGRX'), g, 'false');
  perform pg_temp.t('B04 MANAGER without SEE_MONEY gate',      'auth', pg_temp.fx('uMGRN'), g, 'false');
  perform pg_temp.t('B05 POSITIVE SALES allowed=true gate',    'auth', pg_temp.fx('uSAL'),  g, 'true');
  perform pg_temp.t('B06 SALES no row gate',                   'auth', pg_temp.fx('uSAL0'), g, 'false');
  perform pg_temp.t('B07 FOREMAN allowed, no SEE_MONEY gate',  'auth', pg_temp.fx('uFOR'),  g, 'false');
  perform pg_temp.t('B08 POSITIVE FOREMAN allowed+money gate', 'auth', pg_temp.fx('uFORM'), g, 'true');
  perform pg_temp.t('B09 CREW gate',                           'auth', pg_temp.fx('uCRW'),  g, 'false');
  perform pg_temp.t('B10 CREW with money AND grant gate',      'auth', pg_temp.fx('uCRWX'), g, 'false');
  perform pg_temp.t('B11 platform admin gate',                 'auth', pg_temp.fx('uADM'),  g, 'false');
  perform pg_temp.t('B12 ACCOUNTANT no row gate',              'auth', pg_temp.fx('uACC'),  g, 'false');
  perform pg_temp.t('B13 POSITIVE OWNER B gate',               'auth', pg_temp.fx('uBOWN'), g, 'true');
  perform pg_temp.t('B14 anon cannot even call the gate',      'anon', null, g, 'ERR 42501%');
  perform pg_temp.t('B15 service role: no user, gate false',   'svc',  null, g, 'false');
end $body$;

-- ===========================================================================
-- C. Row security on the mail tables
-- ===========================================================================
do $body$
declare
  msgs text := 'select count(*)::text from public.mail_messages';
  thr  text := 'select count(*)::text from public.mail_threads';
  acc  text := 'select count(*)::text from public.mail_accounts';
begin
  perform pg_temp.t('C01 POSITIVE OWNER A reads messages (1)',  'auth', pg_temp.fx('uOWN'),  msgs, '1');
  perform pg_temp.t('C02 POSITIVE OWNER A reads threads (1)',   'auth', pg_temp.fx('uOWN'),  thr,  '1');
  perform pg_temp.t('C03 POSITIVE OWNER A reads accounts (1)',  'auth', pg_temp.fx('uOWN'),  acc,  '1');
  perform pg_temp.t('C04 POSITIVE MANAGER reads messages (1)',  'auth', pg_temp.fx('uMGR'),  msgs, '1');
  perform pg_temp.t('C05 POSITIVE SALES granted reads (1)',     'auth', pg_temp.fx('uSAL'),  msgs, '1');
  perform pg_temp.t('C06 POSITIVE FOREMAN granted+money (1)',   'auth', pg_temp.fx('uFORM'), msgs, '1');
  perform pg_temp.t('C07 MANAGER allowed=false reads (0)',      'auth', pg_temp.fx('uMGRX'), msgs, '0');
  perform pg_temp.t('C08 MANAGER without money reads (0)',      'auth', pg_temp.fx('uMGRN'), msgs, '0');
  perform pg_temp.t('C09 SALES without grant reads (0)',        'auth', pg_temp.fx('uSAL0'), msgs, '0');
  perform pg_temp.t('C10 FOREMAN granted, no money reads (0)',  'auth', pg_temp.fx('uFOR'),  msgs, '0');
  perform pg_temp.t('C11 CREW reads messages (0)',              'auth', pg_temp.fx('uCRW'),  msgs, '0');
  perform pg_temp.t('C12 CREW reads threads (0)',               'auth', pg_temp.fx('uCRW'),  thr,  '0');
  perform pg_temp.t('C13 CREW reads accounts (0)',              'auth', pg_temp.fx('uCRW'),  acc,  '0');
  perform pg_temp.t('C14 CREW with money+grant reads (0)',      'auth', pg_temp.fx('uCRWX'), msgs, '0');
  perform pg_temp.t('C15 platform admin reads (0)',             'auth', pg_temp.fx('uADM'),  msgs, '0');
  perform pg_temp.t('C16 OWNER B sees only B''s canary',        'auth', pg_temp.fx('uBOWN'),
    'select string_agg(subject, '','') from public.mail_messages', 'B only');
  perform pg_temp.t('C17 anon reads messages',                  'anon', null, msgs, 'ERR 42501%');
  perform pg_temp.t('C18 anon reads accounts',                  'anon', null, acc,  'ERR 42501%');
  perform pg_temp.t('C19 POSITIVE OWNER C reads (1) while active', 'auth', pg_temp.fx('uCOWN'), msgs, '1');
end $body$;

-- Suspend company C inside the transaction.
update companies set suspended = true, suspended_reason = 'probe' where id = pg_temp.fx('cC');
do $body$
begin
  perform pg_temp.t('C20 FIXTURE company C now not allowed', 'pg', null,
    format('select company_allowed(%L)::text', pg_temp.fx('cC')), 'false');
  perform pg_temp.t('C21 OWNER of suspended company reads (0)', 'auth', pg_temp.fx('uCOWN'),
    'select count(*)::text from public.mail_messages', '0');
end $body$;

-- ===========================================================================
-- T. TEETH: the gate replaced by "true" inside the transaction
-- ===========================================================================
create temp table saved_gate as
  select pg_get_functiondef('public.can_use_company_mail()'::regprocedure) as d;
create or replace function public.can_use_company_mail()
returns boolean language sql stable security definer set search_path = public as $$ select true $$;
do $body$
begin
  perform pg_temp.t('T01 TEETH gate forced true: CREW now reads the canary (1)', 'auth', pg_temp.fx('uCRW'),
    'select count(*)::text from public.mail_messages', '1');
  perform pg_temp.t('T02 TEETH ...and still only its own company''s', 'auth', pg_temp.fx('uCRW'),
    'select string_agg(subject, '','') from public.mail_messages', 'Canary A');
end $body$;
do $$ begin execute (select d from saved_gate); end $$;
do $body$
begin
  perform pg_temp.t('T03 gate restored: CREW reads (0)', 'auth', pg_temp.fx('uCRW'),
    'select count(*)::text from public.mail_messages', '0');
  perform pg_temp.t('T04 gate restored: OWNER reads (1)', 'auth', pg_temp.fx('uOWN'),
    'select count(*)::text from public.mail_messages', '1');
end $body$;

-- ===========================================================================
-- D. What a client can never touch (as the MOST privileged client: the owner)
-- ===========================================================================
do $body$
declare u uuid := pg_temp.fx('uOWN'); a uuid := pg_temp.fx('aA'); c uuid := pg_temp.fx('cA');
begin
  perform pg_temp.t('D01 owner selects mail_account_secrets',   'auth', u, 'select count(*)::text from public.mail_account_secrets', 'ERR 42501%');
  perform pg_temp.t('D02 owner selects mail_folder_state',      'auth', u, 'select count(*)::text from public.mail_folder_state', 'ERR 42501%');
  perform pg_temp.t('D03 owner selects mail_events',            'auth', u, 'select count(*)::text from public.mail_events', 'ERR 42501%');
  perform pg_temp.t('D04 owner selects mail_inbound_events',    'auth', u, 'select count(*)::text from public.mail_inbound_events', 'ERR 42501%');
  perform pg_temp.t('D05 owner selects mail_platform_settings', 'auth', u, 'select count(*)::text from public.mail_platform_settings', 'ERR 42501%');
  perform pg_temp.t('D06 owner inserts a message', 'auth', u,
    format('insert into public.mail_messages (company_id, account_id, thread_id, folder_role, source, uidvalidity, uid, received_at) values (%L, %L, %L, ''inbox'', ''imap'', 1, 999, now())',
           c, a, pg_temp.fx('tA')), 'ERR 42501%', true);
  perform pg_temp.t('D07 owner marks a message read directly', 'auth', u,
    'update public.mail_messages set is_seen = true', 'ERR 42501%', true);
  perform pg_temp.t('D08 owner deletes a thread', 'auth', u, 'delete from public.mail_threads', 'ERR 42501%', true);
  perform pg_temp.t('D09 owner edits an account', 'auth', u,
    'update public.mail_accounts set status = ''connected''', 'ERR 42501%', true);
  perform pg_temp.t('D10 owner writes mail_access directly', 'auth', u,
    format('insert into public.mail_access (company_id, profile_id, allowed, set_by) values (%L, %L, true, %L)',
           c, pg_temp.fx('uSAL0'), u), 'ERR 42501%', true);
  perform pg_temp.t('D11 owner links a thread to a job directly', 'auth', u,
    format('insert into public.mail_thread_jobs (thread_id, company_id, job_sync_id) values (%L, %L, %L)',
           pg_temp.fx('tA'), c, pg_temp.fx('jA')), 'ERR 42501%', true);
  perform pg_temp.t('D12 owner calls mail_secret_get',   'auth', u, format('select public.mail_secret_get(%L)', a), 'ERR 42501%');
  perform pg_temp.t('D13 owner calls mail_secret_put',   'auth', u, format('select public.mail_secret_put(%L, ''x'')::text', a), 'ERR 42501%');
  perform pg_temp.t('D14 owner calls mail_secret_forget','auth', u, format('select public.mail_secret_forget(%L)::text', a), 'ERR 42501%');
  perform pg_temp.t('D15 owner calls mail_ingest',       'auth', u, format('select count(*)::text from public.mail_ingest(%L, ''[]'')', a), 'ERR 42501%');
  perform pg_temp.t('D16 owner calls mail_claim_sync',   'auth', u, format('select public.mail_claim_sync(%L, 60)::text', a), 'ERR 42501%');
  perform pg_temp.t('D17 owner calls note_mail_event',   'auth', u, format('select public.note_mail_event(%L, %L, ''send_smtp'', ''1 hour'')::text', c, u), 'ERR 42501%');
  perform pg_temp.t('D18 owner calls mail_event_count',  'auth', u, format('select public.mail_event_count(%L, ''send_smtp'', ''1 hour'')::text', c), 'ERR 42501%');
  perform pg_temp.t('D19 owner calls mail_set_flags',    'auth', u, format('select public.mail_set_flags(%L, ''inbox'', 1, ''[{"uid":1,"seen":true}]'')::text', a), 'ERR 42501%');
  perform pg_temp.t('D20 owner calls mail_mark_gone',    'auth', u, format('select public.mail_mark_gone(%L, ''inbox'', 1, array[1::bigint])::text', a), 'ERR 42501%');
  perform pg_temp.t('D21 owner calls mail_refresh_threads', 'auth', u, format('select public.mail_refresh_threads(array[%L::uuid])::text', pg_temp.fx('tA')), 'ERR 42501%');
  perform pg_temp.t('D22 owner calls mail_refresh_threads_core', 'auth', u, format('select public.mail_refresh_threads_core(array[%L::uuid])::text', pg_temp.fx('tA')), 'ERR 42501%');
  perform pg_temp.t('D23 owner calls mail_fenceflow_account', 'auth', u, format('select public.mail_fenceflow_account(%L, ''x@y.example'')::text', c), 'ERR 42501%');
  perform pg_temp.t('D24 anon calls mail_list_threads',  'anon', null, 'select count(*)::text from public.mail_list_threads()', 'ERR 42501%');
  perform pg_temp.t('D25 anon calls mail_unread_count',  'anon', null, 'select public.mail_unread_count()::text', 'ERR 42501%');
  perform pg_temp.t('D26 anon calls set_mail_access',    'anon', null, format('select public.set_mail_access(%L, true)::text', pg_temp.fx('uSAL0')), 'ERR 42501%');
  perform pg_temp.t('D27 anon calls mail_secret_get',    'anon', null, format('select public.mail_secret_get(%L)', a), 'ERR 42501%');
  -- The second lock on the wrappers, with the grant out of the way: postgres
  -- privileges but an authenticated caller's JWT is still refused.
  perform pg_temp.t('D28 in-function check alone refuses an authenticated JWT', 'pgauth', u,
    format('select public.mail_secret_get(%L)', a), 'ERR 42501: Service role only%');
  perform pg_temp.t('D29 in-function check alone refuses ingest for an authenticated JWT', 'pgauth', u,
    format('select count(*)::text from public.mail_ingest(%L, ''[]'')', a), 'ERR 42501: Service role only%');
end $body$;

-- ===========================================================================
-- E. The app password in Vault
-- ===========================================================================
do $body$
declare a uuid := pg_temp.fx('aA'); s uuid := pg_temp.fx('aS');
begin
  perform pg_temp.t('E01 POSITIVE service role stores a password', 'svc', null,
    format('select ''stored'' from public.mail_secret_put(%L, ''probe-app-pw-7f3a'')', a), 'stored');
  perform pg_temp.t('E02 POSITIVE service role reads the same value back', 'svc', null,
    format('select (public.mail_secret_get(%L) = ''probe-app-pw-7f3a'')::text', a), 'true');
  perform pg_temp.t('E03 one Vault secret, named by account id', 'pg', null,
    format('select count(*)::text from vault.secrets where name = ''mail_account:'' || %L', a), '1');
  perform pg_temp.t('E04 the link row holds an id, and the Vault row is encrypted', 'pg', null,
    format('select (count(*) = 1 and bool_and(v.secret <> ''probe-app-pw-7f3a''))::text from public.mail_account_secrets s join vault.secrets v on v.id = s.vault_secret_id where s.account_id = %L', a), 'true');
  perform pg_temp.t('E05 rotate: store a new password', 'svc', null,
    format('select ''stored'' from public.mail_secret_put(%L, ''probe-app-pw-rotated'')', a), 'stored');
  perform pg_temp.t('E06 rotate: reads the new one, still one secret, rotated_at set', 'pg', null,
    format('select (public.mail_secret_get(%1$L) = ''probe-app-pw-rotated'')::text || ''/'' || (select count(*) from vault.secrets where name = ''mail_account:'' || %1$L)::text || ''/'' || (select (rotated_at is not null)::text from public.mail_account_secrets where account_id = %1$L)', a),
    'true/1/true');
  perform pg_temp.t('E07 empty password refused', 'svc', null,
    format('select ''stored'' from public.mail_secret_put(%L, '''')', a), 'ERR 22023%');
  perform pg_temp.t('E08 257-character password refused', 'svc', null,
    format('select ''stored'' from public.mail_secret_put(%L, repeat(''x'', 257))', a), 'ERR 22023%');
  -- PLANTED: the refused value must not come back in the error.
  perform pg_temp.t('E09 PLANTED control character refused, message names no value', 'svc', null,
    format('select ''stored'' from public.mail_secret_put(%L, ''PLANTED-SECRET-q9'' || chr(10) || ''RCPT'')', a),
    'ERR 22023: The app password contains a character that cannot be used');
  perform pg_temp.t('E10 FenceFlow-mail account cannot hold a password', 'svc', null,
    format('select ''stored'' from public.mail_secret_put(public.mail_fenceflow_account(%L, ''mail@send.fenceflow.example''), ''x'')', pg_temp.fx('cA')), 'ERR 22023%');
  perform pg_temp.t('E11 unknown account refused', 'svc', null,
    'select ''stored'' from public.mail_secret_put(''00000000-0000-4000-8000-000000000000'', ''x'')', 'ERR P0002%');
  perform pg_temp.t('E12 forget: answers true', 'svc', null,
    format('select public.mail_secret_forget(%L)::text', a), 'true');
  perform pg_temp.t('E13 forget: Vault row gone, read answers NULL', 'svc', null,
    format('select (select count(*) from vault.secrets where name = ''mail_account:'' || %1$L)::text || ''/'' || coalesce(public.mail_secret_get(%1$L), ''NULL'')', a), '0/NULL');
  perform pg_temp.t('E14 forget again: answers false', 'svc', null,
    format('select public.mail_secret_forget(%L)::text', a), 'false');
  -- A cascade from a deleted account must not orphan the password.
  insert into public.mail_accounts (id, company_id, kind, provider, email_address, username, imap_host, smtp_host, imap_port, smtp_port)
  values (s, pg_temp.fx('cA'), 'imap', 'custom', 'scratch@acme-fence.example', 'scratch@acme-fence.example',
          'mail.acme-fence.example', 'mail.acme-fence.example', 993, 465);
  perform pg_temp.t('E15 cascade: store for a scratch account', 'svc', null,
    format('select ''stored'' from public.mail_secret_put(%L, ''probe-app-pw-scratch'')', s), 'stored');
  delete from public.mail_accounts where id = s;
  perform pg_temp.t('E16 cascade: deleting the account deleted the Vault secret', 'pg', null,
    format('select count(*)::text from vault.secrets where name = ''mail_account:'' || %L', s), '0');
  perform pg_temp.t('E17 direct connection (no request context) may use the wrapper', 'pg', null,
    format('select ''stored'' from public.mail_secret_put(%L, ''probe-app-pw-direct'')', a), 'stored');
end $body$;

-- ===========================================================================
-- F. Grants, read straight from the catalog
-- ===========================================================================
do $body$
declare
  fns text := $q$ from pg_proc p where p.pronamespace = 'public'::regnamespace
                  and (p.proname like 'mail\_%' or p.proname in ('can_use_company_mail', 'note_mail_event', 'set_mail_access')) $q$;
  tbl text := $q$ from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
                  and c.relname like 'mail\_%' $q$;
begin
  perform pg_temp.t('F01 POSITIVE the grant query sees a grant that exists', 'pg', null,
    'select has_function_privilege(''authenticated'', ''public.can_use_company_mail()'', ''EXECUTE'')::text', 'true');
  perform pg_temp.t('F02 anon can execute no mail function', 'pg', null,
    'select coalesce(string_agg(p.proname, '','' order by p.proname), ''none'')' || fns || ' and has_function_privilege(''anon'', p.oid, ''EXECUTE'')', 'none');
  perform pg_temp.t('F03 authenticated can execute exactly the office RPCs', 'pg', null,
    'select string_agg(p.proname, '','' order by p.proname)' || fns || ' and has_function_privilege(''authenticated'', p.oid, ''EXECUTE'')',
    'can_use_company_mail,mail_for_job,mail_link_thread,mail_list_threads,mail_search_query,mail_unlink_thread,mail_unread_count,set_mail_access');
  perform pg_temp.t('F04 PUBLIC can execute no mail function', 'pg', null,
    'select coalesce(string_agg(p.proname, '','' order by p.proname), ''none'')' || fns ||
    ' and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault(''f'', p.proowner))) x where x.grantee = 0 and x.privilege_type = ''EXECUTE'')', 'none');
  perform pg_temp.t('F05 POSITIVE service role can execute the Vault wrappers', 'pg', null,
    'select (has_function_privilege(''service_role'', ''public.mail_secret_put(uuid,text)'', ''EXECUTE'') and has_function_privilege(''service_role'', ''public.mail_secret_get(uuid)'', ''EXECUTE'') and has_function_privilege(''service_role'', ''public.mail_ingest(uuid,jsonb)'', ''EXECUTE''))::text', 'true');
  perform pg_temp.t('F06 anon holds no privilege on any mail table', 'pg', null,
    'select coalesce(string_agg(c.relname, '','' order by c.relname), ''none'')' || tbl ||
    ' and has_table_privilege(''anon'', c.oid, ''SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'')', 'none');
  perform pg_temp.t('F07 authenticated may SELECT exactly the five office tables', 'pg', null,
    'select string_agg(c.relname, '','' order by c.relname)' || tbl || ' and has_table_privilege(''authenticated'', c.oid, ''SELECT'')',
    'mail_access,mail_accounts,mail_messages,mail_thread_jobs,mail_threads');
  perform pg_temp.t('F08 authenticated may write no mail table', 'pg', null,
    'select coalesce(string_agg(c.relname, '','' order by c.relname), ''none'')' || tbl ||
    ' and has_table_privilege(''authenticated'', c.oid, ''INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'')', 'none');
  perform pg_temp.t('F09 RLS is on for all ten mail tables', 'pg', null,
    'select count(*) filter (where c.relrowsecurity)::text || ''/'' || count(*)::text' || tbl, '10/10');
  perform pg_temp.t('F10 the rate ledger sequence is not reachable by clients', 'pg', null,
    'select (has_sequence_privilege(''anon'', ''public.mail_events_id_seq'', ''USAGE,SELECT,UPDATE'') or has_sequence_privilege(''authenticated'', ''public.mail_events_id_seq'', ''USAGE,SELECT,UPDATE''))::text', 'false');
  perform pg_temp.t('F11 the Vault wrappers are SECURITY DEFINER, owned by postgres', 'pg', null,
    'select string_agg(p.proname || ''='' || p.prosecdef::text || '':'' || pg_get_userbyid(p.proowner), '','' order by p.proname) from pg_proc p where p.pronamespace = ''public''::regnamespace and p.proname like ''mail\_secret\_%''',
    'mail_secret_forget=true:postgres,mail_secret_get=true:postgres,mail_secret_put=true:postgres');
end $body$;

-- ===========================================================================
-- G. Storage: mail-files
-- ===========================================================================
do $body$
declare
  cA uuid := pg_temp.fx('cA'); cB uuid := pg_temp.fx('cB'); u uuid := pg_temp.fx('uOWN');
  ins text := 'insert into storage.objects (bucket_id, name, owner, owner_id) values (''mail-files'', %L, %L, %L)';
begin
  perform pg_temp.t('G01 bucket exists and is private', 'pg', null,
    'select public::text || ''/'' || file_size_limit::text from storage.buckets where id = ''mail-files''', 'false/26214400');
  perform pg_temp.t('G02 POSITIVE owner uploads to own outgoing folder', 'auth', u,
    format(ins, cA || '/outgoing/' || u || '/' || gen_random_uuid() || '/quote.pdf', u, u), 'rows=1', true);
  perform pg_temp.t('G03 POSITIVE manager uploads to own outgoing folder', 'auth', pg_temp.fx('uMGR'),
    format(ins, cA || '/outgoing/' || pg_temp.fx('uMGR') || '/' || gen_random_uuid() || '/photo.jpg', pg_temp.fx('uMGR'), pg_temp.fx('uMGR')), 'rows=1', true);
  perform pg_temp.t('G04 owner uploads into another company''s folder', 'auth', u,
    format(ins, cB || '/outgoing/' || u || '/' || gen_random_uuid() || '/x.pdf', u, u), 'ERR 42501%', true);
  perform pg_temp.t('G05 owner uploads into the stored-mail (inbox) path', 'auth', u,
    format(ins, cA || '/' || pg_temp.fx('aA') || '/' || pg_temp.fx('mA') || '/0-x.pdf', u, u), 'ERR 42501%', true);
  perform pg_temp.t('G06 owner uploads into another user''s outgoing folder', 'auth', u,
    format(ins, cA || '/outgoing/' || pg_temp.fx('uMGR') || '/' || gen_random_uuid() || '/x.pdf', u, u), 'ERR 42501%', true);
  perform pg_temp.t('G07 owner uploads one level too deep', 'auth', u,
    format(ins, cA || '/outgoing/' || u || '/' || gen_random_uuid() || '/deeper/x.pdf', u, u), 'ERR 42501%', true);
  perform pg_temp.t('G08 crew uploads to its own outgoing folder', 'auth', pg_temp.fx('uCRW'),
    format(ins, cA || '/outgoing/' || pg_temp.fx('uCRW') || '/' || gen_random_uuid() || '/x.pdf', pg_temp.fx('uCRW'), pg_temp.fx('uCRW')), 'ERR 42501%', true);
  perform pg_temp.t('G09 anon uploads', 'anon', null,
    format(ins, cA || '/outgoing/' || u || '/' || gen_random_uuid() || '/x.pdf', null, null), 'ERR 42501%', true);
  perform pg_temp.t('G10 POSITIVE the uploads are there (postgres sees 2)', 'pg', null,
    'select count(*)::text from storage.objects where bucket_id = ''mail-files''', '2');
  perform pg_temp.t('G11 owner cannot list or read mail-files, even own uploads (0)', 'auth', u,
    'select count(*)::text from storage.objects where bucket_id = ''mail-files''', '0');
  perform pg_temp.t('G12 owner cannot overwrite an upload (0 rows)', 'auth', u,
    'update storage.objects set name = name || ''x'' where bucket_id = ''mail-files''', 'rows=0', true);
end $body$;

-- ===========================================================================
-- H. mail_ingest: de-duplication, re-binding, threading, cleaning
-- ===========================================================================
do $body$
declare
  cA uuid := pg_temp.fx('cA'); aA uuid := pg_temp.fx('aA'); aB uuid := pg_temp.fx('aB');
  fA uuid; tokA text; tokB text; tX uuid;
  own uuid := pg_temp.fx('uOWN');
  q text;
begin
  -- The message the rest of this section builds on.
  perform pg_temp.ingest('H01 POSITIVE a new inbox message is inserted', aA, jsonb_build_object(
    'folder_role', 'inbox', 'source', 'imap', 'uidvalidity', 7, 'uid', 101,
    'message_id_header', '<m1@example.org>', 'from_address', ' Pat@Example.org ', 'from_name', 'Pat Customer',
    'subject', 'Coffee order for the fence' || chr(13) || chr(10) || 'Bcc: evil@example.com',
    'to_text', 'Acme Fence <office@acme-fence.example>',
    'counterpart_emails', jsonb_build_array('Pat@Example.org', 'office@acme-fence.example'),
    'received_at', '2026-09-20T10:00:00Z', 'snippet', 'Can you   quote' || chr(10) || 'a cedar fence?'), 'true');
  perform pg_temp.ingest('H02 the same uid again is not inserted', aA, jsonb_build_object(
    'folder_role', 'inbox', 'source', 'imap', 'uidvalidity', 7, 'uid', 101,
    'message_id_header', 'm1@example.org', 'received_at', '2026-09-20T10:00:00Z'), 'false');
  perform pg_temp.t('H03 ...one row for that uid', 'pg', null,
    format('select count(*)::text from public.mail_messages where account_id = %L and uid = 101', aA), '1');
  perform pg_temp.t('H04 own mailbox address stripped from counterparts; from lower-cased; CR/LF gone from subject', 'pg', null,
    format('select counterpart_emails::text || ''|'' || from_address || ''|'' || (subject !~ ''[[:cntrl:]]'')::text || ''|'' || snippet from public.mail_messages where account_id = %L and uid = 101', aA),
    '{pat@example.org}|pat@example.org|true|Can you quote a cedar fence?');
  select thread_id into tX from public.mail_messages where account_id = aA and uid = 101;
  insert into fx values ('tX', tX);

  perform pg_temp.ingest('H05 a reply is inserted', aA, jsonb_build_object(
    'folder_role', 'inbox', 'source', 'imap', 'uidvalidity', 7, 'uid', 102,
    'message_id_header', 'm2@example.org', 'parent_ids', jsonb_build_array('<m1@example.org>', 'm1@example.org', ''),
    'from_address', 'pat@example.org', 'subject', 'Re: Coffee order for the fence',
    'counterpart_emails', jsonb_build_array('pat@example.org'), 'received_at', '2026-09-20T11:00:00Z'), 'true');
  perform pg_temp.t('H06 ...joins its parent''s thread; parent_ids de-duplicated', 'pg', null,
    format('select (thread_id = %L)::text || ''|'' || parent_ids::text from public.mail_messages where account_id = %L and uid = 102', tX, aA),
    'true|{m1@example.org}');

  perform pg_temp.ingest('H07 a reply that arrives BEFORE its parent', aA, jsonb_build_object(
    'folder_role', 'inbox', 'source', 'imap', 'uidvalidity', 7, 'uid', 201,
    'message_id_header', 'c2@example.org', 'parent_ids', jsonb_build_array('c1@example.org'),
    'subject', 'Re: Gate hinge', 'received_at', '2026-09-19T11:00:00Z'), 'true');
  perform pg_temp.ingest('H08 ...then the parent', aA, jsonb_build_object(
    'folder_role', 'inbox', 'source', 'imap', 'uidvalidity', 7, 'uid', 200,
    'message_id_header', 'c1@example.org', 'subject', 'Gate hinge', 'received_at', '2026-09-19T10:00:00Z'), 'true');
  perform pg_temp.t('H09 ...the parent joined the early reply''s thread, a different one from Coffee', 'pg', null,
    format('select ((select thread_id from public.mail_messages where account_id = %1$L and uid = 200) = (select thread_id from public.mail_messages where account_id = %1$L and uid = 201))::text || ''/'' || ((select thread_id from public.mail_messages where account_id = %1$L and uid = 200) <> %2$L)::text', aA, tX),
    'true/true');

  -- FenceFlow sends a reply from the Zoho account; its Sent copy turns up later.
  perform pg_temp.ingest('H10 POSITIVE a FenceFlow send claims its row', aA, jsonb_build_object(
    'folder_role', 'sent', 'source', 'fenceflow_send', 'client_send_id', pg_temp.fx('csF'),
    'message_id_header', 'ff1@acme-fence.example', 'parent_ids', jsonb_build_array('m2@example.org'),
    'send_state', 'sending', 'subject', 'Re: Coffee order for the fence', 'from_address', 'office@acme-fence.example',
    'counterpart_emails', jsonb_build_array('pat@example.org'), 'sent_by', own,
    'received_at', '2026-09-20T12:00:00Z'), 'true');
  perform pg_temp.ingest('H11 a second claim with the same client_send_id sends nothing (not inserted)', aA, jsonb_build_object(
    'folder_role', 'sent', 'source', 'fenceflow_send', 'client_send_id', pg_temp.fx('csF'),
    'message_id_header', 'ff1@acme-fence.example', 'send_state', 'sending', 'received_at', '2026-09-20T12:00:01Z'), 'false');
  perform pg_temp.ingest('H12 the Sent copy re-binds the FenceFlow row (not inserted)', aA, jsonb_build_object(
    'folder_role', 'sent', 'source', 'imap', 'uidvalidity', 9, 'uid', 55,
    'message_id_header', '<ff1@acme-fence.example>', 'received_at', '2026-09-20T12:00:05Z'), 'false');
  perform pg_temp.t('H13 ...one row, now uid 55, in the Coffee thread, and marked sent', 'pg', null,
    format('select count(*)::text || ''|'' || max(uid)::text || ''|'' || bool_and(thread_id = %L)::text || ''|'' || max(send_state) from public.mail_messages where account_id = %L and message_id_header = ''ff1@acme-fence.example''', tX, aA),
    '1|55|true|sent');

  perform pg_temp.ingest('H14 UIDVALIDITY reset: the same message under a new epoch re-binds (not inserted)', aA, jsonb_build_object(
    'folder_role', 'inbox', 'source', 'imap', 'uidvalidity', 8, 'uid', 5,
    'message_id_header', 'm1@example.org', 'received_at', '2026-09-20T10:00:00Z'), 'false');
  perform pg_temp.t('H15 ...still one row, now 8/5', 'pg', null,
    format('select count(*)::text || ''|'' || max(uidvalidity)::text || ''/'' || max(uid)::text from public.mail_messages where account_id = %L and message_id_header = ''m1@example.org''', aA),
    '1|8/5');

  -- FenceFlow mail (Resend) in the same company.
  select public.mail_fenceflow_account(cA, 'Mail@Send.FenceFlow.example') into fA;
  insert into fx values ('fA', fA);
  select reply_token into tokA from public.mail_threads where id = tX;
  select reply_token into tokB from public.mail_threads where id = pg_temp.fx('tB');
  perform pg_temp.t('H16 FenceFlow account: created once, token filled, address lower-cased', 'svc', null,
    format('select (public.mail_fenceflow_account(%L, ''mail@send.fenceflow.example'') = %L)::text || ''|'' || (select (inbound_token ~ ''^[a-f0-9]{16}$'')::text || ''|'' || email_address from public.mail_accounts where id = %L)', cA, fA, fA),
    'true|true|mail@send.fenceflow.example');
  perform pg_temp.ingest('H17 an inbound reply routed by reply_token', fA, jsonb_build_object(
    'folder_role', 'inbox', 'source', 'resend_inbound', 'provider_message_id', 'rs-1', 'reply_token', tokA,
    'message_id_header', 'rs1@mailer.example', 'from_address', 'pat@example.org', 'subject', 'Re: quote',
    'counterpart_emails', jsonb_build_array('pat@example.org'), 'received_at', '2026-09-20T13:00:00Z'), 'true');
  perform pg_temp.t('H18 ...joined the Coffee thread', 'pg', null,
    format('select (thread_id = %L)::text from public.mail_messages where provider_message_id = ''rs-1''', tX), 'true');
  -- PLANTED: another company's reply_token must not route mail into that company.
  perform pg_temp.ingest('H19 PLANTED an inbound message carrying company B''s reply_token', fA, jsonb_build_object(
    'folder_role', 'inbox', 'source', 'resend_inbound', 'provider_message_id', 'rs-2', 'reply_token', tokB,
    'message_id_header', 'cross1@mailer.example', 'subject', 'cross', 'received_at', '2026-09-20T13:30:00Z'), 'true');
  perform pg_temp.t('H20 ...stayed in company A, never in B''s thread', 'pg', null,
    format('select (m.thread_id <> %L)::text || ''/'' || (t.company_id = %L)::text from public.mail_messages m join public.mail_threads t on t.id = m.thread_id where m.provider_message_id = ''rs-2''', pg_temp.fx('tB'), cA),
    'true/true');
  -- PLANTED: a parent Message-ID that exists only in company A must not pull B's mail into A's thread.
  perform pg_temp.ingest('H21 PLANTED company B receives a reply to company A''s Message-ID', aB, jsonb_build_object(
    'folder_role', 'inbox', 'source', 'imap', 'uidvalidity', 1, 'uid', 77,
    'message_id_header', 'b-reply@example.org', 'parent_ids', jsonb_build_array('m1@example.org'),
    'subject', 'Re: Coffee', 'received_at', '2026-09-20T14:00:00Z'), 'true');
  perform pg_temp.t('H22 ...threaded inside company B', 'pg', null,
    format('select (t.company_id = %L)::text from public.mail_messages m join public.mail_threads t on t.id = m.thread_id where m.account_id = %L and m.uid = 77', pg_temp.fx('cB'), aB),
    'true');
  perform pg_temp.t('H23 an IMAP row into the FenceFlow account is refused', 'svc', null,
    format('select count(*)::text from public.mail_ingest(%L, %L::jsonb)', fA,
           '[{"folder_role":"inbox","source":"imap","uidvalidity":1,"uid":1,"received_at":"2026-09-20T00:00:00Z"}]'), 'ERR 22023%');
  perform pg_temp.t('H24 an inbound row into the IMAP account is refused', 'svc', null,
    format('select count(*)::text from public.mail_ingest(%L, %L::jsonb)', aA,
           '[{"folder_role":"inbox","source":"resend_inbound","provider_message_id":"zz","received_at":"2026-09-20T00:00:00Z"}]'), 'ERR 22023%');
  perform pg_temp.t('H25 p_rows that is not an array is refused', 'svc', null,
    format('select count(*)::text from public.mail_ingest(%L, ''{}''::jsonb)', aA), 'ERR 22023%');
  perform pg_temp.t('H26 sent_by from another company is refused', 'svc', null,
    format('select count(*)::text from public.mail_ingest(%L, %L::jsonb)', aA,
           jsonb_build_array(jsonb_build_object('folder_role', 'sent', 'source', 'fenceflow_send',
             'client_send_id', gen_random_uuid(), 'send_state', 'sending', 'sent_by', pg_temp.fx('uBOWN'),
             'received_at', '2026-09-20T00:00:00Z'))::text), 'ERR 22023%');
  perform pg_temp.ingest('H27 a bogus date is survived, a future date clamped', aA, jsonb_build_object(
    'folder_role', 'inbox', 'source', 'imap', 'uidvalidity', 7, 'uid', 300,
    'message_id_header', 'future@example.org', 'sent_at', 'not a date', 'received_at', '2099-01-01T00:00:00Z',
    'subject', 'From the future'), 'true');
  perform pg_temp.t('H28 ...sent_at null, received_at at most a day ahead', 'pg', null,
    format('select (sent_at is null)::text || ''/'' || (received_at <= now() + interval ''1 day'')::text from public.mail_messages where account_id = %L and uid = 300', aA),
    'true/true');
  perform pg_temp.ingest('H29 a send from the job sheet links the thread to the job', aA, jsonb_build_object(
    'folder_role', 'sent', 'source', 'fenceflow_send', 'client_send_id', pg_temp.fx('csJ'),
    'message_id_header', 'job1@acme-fence.example', 'send_state', 'sending', 'subject', 'Your fence quote',
    'counterpart_emails', jsonb_build_array('pat@example.org'), 'sent_by', own, 'job_sync_id', pg_temp.fx('jA'),
    'received_at', '2026-09-20T09:00:00Z'), 'true');
  perform pg_temp.t('H30 ...mail_thread_jobs row written for that thread', 'pg', null,
    format('select count(*)::text from public.mail_thread_jobs j join public.mail_messages m on m.thread_id = j.thread_id where m.client_send_id = %L and j.job_sync_id = %L', pg_temp.fx('csJ'), pg_temp.fx('jA')),
    '1');

  -- Aggregates: Coffee thread = m1 (inbox, unseen), m2 (inbox, unseen),
  -- ff1 (sent, seen), rs-1 (inbox, unseen) -> 4 messages, 3 unread.
  perform pg_temp.t('H31 thread aggregates recomputed (count/unread/inbox/sent/subject)', 'pg', null,
    format('select message_count || ''/'' || unread_count || ''/'' || in_inbox || ''/'' || in_sent || ''/'' || subject from public.mail_threads where id = %L', tX),
    '4/3/true/true/Coffee order for the fence Bcc: evil@example.com');
  perform pg_temp.t('H32 set_flags: uid 102 seen (1 row changed)', 'svc', null,
    format('select public.mail_set_flags(%L, ''inbox'', 7, ''[{"uid":102,"seen":true},{"uid":999999,"seen":true}]'')::text', aA), '1');
  perform pg_temp.t('H33 ...unread now 2', 'pg', null,
    format('select unread_count::text from public.mail_threads where id = %L', tX), '2');
  perform pg_temp.t('H34 mark_gone: uid 102 (1 row)', 'svc', null,
    format('select public.mail_mark_gone(%L, ''inbox'', 7, array[102::bigint, 424242::bigint])::text', aA), '1');
  perform pg_temp.t('H35 ...hidden from the thread (3 messages), row kept', 'pg', null,
    format('select (select message_count from public.mail_threads where id = %L)::text || ''/'' || (select count(*) from public.mail_messages where account_id = %L and uid = 102)::text', tX, aA),
    '3/1');
  perform pg_temp.t('H36 set_flags on a gone uid brings it back', 'svc', null,
    format('select public.mail_set_flags(%L, ''inbox'', 7, ''[{"uid":102}]'')::text', aA), '1');
  perform pg_temp.t('H37 ...4 messages again', 'pg', null,
    format('select message_count::text from public.mail_threads where id = %L', tX), '4');
  -- The statement trigger: a plain UPDATE by the service role (as mail-message
  -- does when a message is opened) keeps the badge right with no extra call.
  perform pg_temp.t('H38 a direct service-role UPDATE marks m1 read', 'svc', null,
    format('update public.mail_messages set is_seen = true where account_id = %L and message_id_header = ''m1@example.org''', aA), 'rows=1', true);
  perform pg_temp.t('H39 ...the trigger refreshed unread to 1', 'pg', null,
    format('select unread_count::text from public.mail_threads where id = %L', tX), '1');
  perform pg_temp.t('H40 an over-long body is capped and flagged, not refused', 'svc', null,
    format('update public.mail_messages set body_text = repeat(''é'', 200000), body_state = ''cached'' where account_id = %L and uid = 102', aA), 'rows=1', true);
  perform pg_temp.t('H41 ...262144 bytes at most, valid text, body_truncated', 'pg', null,
    format('select (octet_length(body_text) <= 262144 and octet_length(body_text) > 262000)::text || ''/'' || body_truncated::text from public.mail_messages where account_id = %L and uid = 102', aA),
    'true/true');
end $body$;

-- ===========================================================================
-- I. The thread list, called the way the office calls it
-- ===========================================================================
do $body$
declare
  u uuid := pg_temp.fx('uOWN'); tX uuid := pg_temp.fx('tX');
  lt text := 'select count(*)::text from public.mail_list_threads(%L, %L, %L, null, 50) where id = %L';
  all_ text := 'select count(*)::text from public.mail_list_threads(%L, %L, %L, null, 50)';
  unread_pg integer;
begin
  perform pg_temp.t('I01 POSITIVE inbox list includes the Coffee thread', 'auth', u, format(lt, 'inbox', null, null, tX), '1');
  perform pg_temp.t('I02 POSITIVE search "coffee" (subject word) finds it', 'auth', u, format(lt, 'inbox', null, 'coffee', tX), '1');
  perform pg_temp.t('I03 search "cof" (prefix) finds it', 'auth', u, format(lt, 'inbox', null, 'cof', tX), '1');
  perform pg_temp.t('I04 search "Pat" (sender name) finds it', 'auth', u, format(lt, 'inbox', null, 'Pat', tX), '1');
  perform pg_temp.t('I05 search "example.org" (domain alone) finds it', 'auth', u, format(lt, 'inbox', null, 'example.org', tX), '1');
  perform pg_temp.t('I06 search "pat@example.org" (whole address) finds it', 'auth', u, format(lt, 'inbox', null, 'pat@example.org', tX), '1');
  perform pg_temp.t('I07 search "coffee fence" (two words) finds it', 'auth', u, format(lt, 'inbox', null, 'coffee fence', tX), '1');
  perform pg_temp.t('I08 search for a word in no message: 0 results', 'auth', u, format(all_, 'inbox', null, 'zzqxnomatch'), '0');
  perform pg_temp.t('I09 search of punctuation only: 0 results, no error', 'auth', u, format(all_, 'inbox', null, '!!! ''"&|:*'), '0');
  perform pg_temp.t('I10 search with tsquery syntax is harmless', 'auth', u, format(lt, 'inbox', null, 'coffee & | ! :* (', tX), '1');
  perform pg_temp.t('I11 CREW lists nothing, even searching', 'auth', pg_temp.fx('uCRW'), format(all_, 'inbox', null, 'coffee'), '0');
  perform pg_temp.t('I12 OWNER B cannot find A''s thread', 'auth', pg_temp.fx('uBOWN'), format(lt, 'inbox', null, null, tX), '0');
  perform pg_temp.t('I13 sent folder includes it (FenceFlow reply)', 'auth', u, format(lt, 'sent', null, null, tX), '1');
  perform pg_temp.t('I14 FenceFlow account''s inbox includes it (rs-1)', 'auth', u, format(lt, 'inbox', pg_temp.fx('fA'), null, tX), '1');
  perform pg_temp.t('I15 another company''s account id lists nothing', 'auth', u, format(all_, 'inbox', pg_temp.fx('aB'), null), '0');
  perform pg_temp.t('I16 unknown folder refused', 'auth', u, format(all_, 'trash', null, null), 'ERR 22023%');
  perform pg_temp.t('I17 per-filter unread and latest sender', 'auth', u,
    format('select unread_count::text || ''/'' || coalesce(latest_from_address, ''NULL'') from public.mail_list_threads(''inbox'', null, null, null, 50) where id = %L', tX),
    '1/pat@example.org');
  perform pg_temp.t('I18 linked job ids come back with the thread', 'auth', u,
    format('select (%L = any(job_sync_ids))::text from public.mail_list_threads(''sent'', null, ''quote'', null, 50) where subject = ''Your fence quote''', pg_temp.fx('jA')), 'true');
  -- Paging, as the owner (postgres would see every company): page 1 of one
  -- row, then the rest with its last_message_at/id. The first row is not
  -- repeated, and page 1 + page 2 = the whole list (nothing skipped on a tie).
  perform pg_temp.t('I19 paging: next page skips nothing and repeats nothing', 'auth', u,
    $q$with f as (select id, last_message_at from public.mail_list_threads('inbox', null, null, null, 1)),
          p2 as (select n.id from f, lateral public.mail_list_threads('inbox', null, null, f.last_message_at, 100, f.id) n)
     select (select count(*) from p2 where id in (select id from f))::text || '/' ||
            ((select count(*) from p2) + 1 = (select count(*) from public.mail_list_threads('inbox', null, null, null, 100)))::text || '/' ||
            ((select count(*) from p2) > 0)::text$q$,
    '0/true/true');
  select count(*) into unread_pg from public.mail_messages
   where company_id = pg_temp.fx('cA') and folder_role = 'inbox' and not is_seen and server_gone_at is null;
  perform pg_temp.t('I20 POSITIVE unread badge = unread inbox messages postgres counts for A', 'auth', u,
    format('select public.mail_unread_count()::text || ''/'' || (%s > 0)::text', unread_pg),
    unread_pg::text || '/true');
  perform pg_temp.t('I21 CREW unread badge (0)', 'auth', pg_temp.fx('uCRW'), 'select public.mail_unread_count()::text', '0');
end $body$;

-- ===========================================================================
-- J. Mail for a job, by address
-- ===========================================================================
do $body$
declare
  u uuid := pg_temp.fx('uOWN'); aA uuid := pg_temp.fx('aA'); tX uuid := pg_temp.fx('tX'); jA uuid := pg_temp.fx('jA');
  tHOA uuid; tCUST uuid; tPLUS uuid;
  fj text := 'select %s from public.mail_for_job(%L) where id = %L';
begin
  perform pg_temp.ingest('J00 seed: a message from the HOA board', aA, jsonb_build_object(
    'folder_role', 'inbox', 'source', 'imap', 'uidvalidity', 7, 'uid', 400, 'message_id_header', 'hoa1@hoa.example',
    'from_address', 'board@hoa.example', 'subject', 'HOA approval', 'counterpart_emails', jsonb_build_array('Board@HOA.example'),
    'received_at', '2026-09-18T10:00:00Z'), 'true');
  perform pg_temp.ingest('J00 seed: a message from the customer record''s address', aA, jsonb_build_object(
    'folder_role', 'inbox', 'source', 'imap', 'uidvalidity', 7, 'uid', 401, 'message_id_header', 'home1@example.net',
    'from_address', 'pat.home@example.net', 'subject', 'From home', 'counterpart_emails', jsonb_build_array('pat.home@example.net'),
    'received_at', '2026-09-18T11:00:00Z'), 'true');
  perform pg_temp.ingest('J00 seed: a plus-address that must NOT match', aA, jsonb_build_object(
    'folder_role', 'inbox', 'source', 'imap', 'uidvalidity', 7, 'uid', 402, 'message_id_header', 'plus1@example.org',
    'from_address', 'pat+fence@example.org', 'subject', 'Plus', 'counterpart_emails', jsonb_build_array('pat+fence@example.org'),
    'received_at', '2026-09-18T12:00:00Z'), 'true');
  select thread_id into tHOA  from public.mail_messages where account_id = aA and uid = 400;
  select thread_id into tCUST from public.mail_messages where account_id = aA and uid = 401;
  select thread_id into tPLUS from public.mail_messages where account_id = aA and uid = 402;
  insert into fx values ('tPLUS', tPLUS);

  perform pg_temp.t('J01 POSITIVE job email (upper-case, padded) matches the Coffee thread', 'auth', u,
    format(fj, 'matched_customer::text || ''/'' || matched_hoa::text', jA, tX), 'true/false');
  perform pg_temp.t('J02 HOA email matches, tagged HOA', 'auth', u,
    format(fj, 'matched_customer::text || ''/'' || matched_hoa::text', jA, tHOA), 'false/true');
  perform pg_temp.t('J03 the customer record''s email (jobs.customer_id) matches', 'auth', u,
    format(fj, 'matched_customer::text', jA, tCUST), 'true');
  perform pg_temp.t('J04 a plus-address does not match (no plus stripping)', 'auth', u,
    format('select count(*)::text from public.mail_for_job(%L) where id = %L', jA, tPLUS), '0');
  perform pg_temp.t('J05 CREW gets nothing for the job', 'auth', pg_temp.fx('uCRW'),
    format('select count(*)::text from public.mail_for_job(%L)', jA), '0');
  perform pg_temp.t('J06 OWNER B gets nothing for A''s job', 'auth', pg_temp.fx('uBOWN'),
    format('select count(*)::text from public.mail_for_job(%L)', jA), '0');
  perform pg_temp.t('J07 OWNER B''s own job with the same address sees only B''s mail', 'auth', pg_temp.fx('uBOWN'),
    format('select count(*)::text from public.mail_for_job(%L) where id in (%L, %L)', pg_temp.fx('jB'), tX, tHOA), '0');
  perform pg_temp.t('J08 a deleted job shows nothing', 'auth', u,
    format('select count(*)::text from public.mail_for_job(%L)', pg_temp.fx('jDEL')), '0');
end $body$;

-- ===========================================================================
-- K. Linking a thread to a job by hand
-- ===========================================================================
do $body$
declare u uuid := pg_temp.fx('uOWN'); jA uuid := pg_temp.fx('jA'); tP uuid := pg_temp.fx('tPLUS');
begin
  perform pg_temp.t('K01 POSITIVE owner links the plus-address thread to the job', 'auth', u,
    format('select public.mail_link_thread(%L, %L)::text', tP, jA), 'true');
  perform pg_temp.t('K02 linking again adds nothing', 'auth', u,
    format('select public.mail_link_thread(%L, %L)::text', tP, jA), 'false');
  perform pg_temp.t('K03 ...mail_for_job now lists it as linked', 'auth', u,
    format('select linked::text from public.mail_for_job(%L) where id = %L', jA, tP), 'true');
  perform pg_temp.t('K04 CREW cannot link', 'auth', pg_temp.fx('uCRW'),
    format('select public.mail_link_thread(%L, %L)::text', tP, jA), 'ERR 42501%');
  perform pg_temp.t('K05 OWNER B cannot link A''s thread (to B''s job)', 'auth', pg_temp.fx('uBOWN'),
    format('select public.mail_link_thread(%L, %L)::text', tP, pg_temp.fx('jB')), 'ERR P0002%');
  perform pg_temp.t('K06 owner cannot link to another company''s job', 'auth', u,
    format('select public.mail_link_thread(%L, %L)::text', tP, pg_temp.fx('jB')), 'ERR P0002%');
  perform pg_temp.t('K07 owner cannot link to a deleted job', 'auth', u,
    format('select public.mail_link_thread(%L, %L)::text', tP, pg_temp.fx('jDEL')), 'ERR P0002%');
  perform pg_temp.t('K08 CREW reads no links', 'auth', pg_temp.fx('uCRW'), 'select count(*)::text from public.mail_thread_jobs', '0');
  perform pg_temp.t('K09 POSITIVE owner reads the links (2: job-sheet send + manual)', 'auth', u, 'select count(*)::text from public.mail_thread_jobs', '2');
  perform pg_temp.t('K10 CREW cannot unlink', 'auth', pg_temp.fx('uCRW'),
    format('select public.mail_unlink_thread(%L, %L)::text', tP, jA), 'ERR 42501%');
  perform pg_temp.t('K11 owner unlinks', 'auth', u, format('select public.mail_unlink_thread(%L, %L)::text', tP, jA), 'true');
  perform pg_temp.t('K12 unlinking again removes nothing', 'auth', u, format('select public.mail_unlink_thread(%L, %L)::text', tP, jA), 'false');
end $body$;

-- ===========================================================================
-- L. set_mail_access (the owner's switch)
-- ===========================================================================
do $body$
declare u uuid := pg_temp.fx('uOWN'); acc uuid := pg_temp.fx('uACC'); mgr uuid := pg_temp.fx('uMGR');
begin
  perform pg_temp.t('L01 POSITIVE owner grants the accountant', 'auth', u,
    format('select ''set'' from public.set_mail_access(%L, true)', acc), 'set');
  perform pg_temp.t('L02 ...the accountant now passes the gate and reads mail', 'auth', acc,
    'select public.can_use_company_mail()::text || ''/'' || (select count(*) > 0 from public.mail_messages)::text', 'true/true');
  perform pg_temp.t('L03 ...and the change is in the audit log', 'pg', null,
    format('select count(*)::text || ''/'' || max(new_value) || ''/'' || coalesce(max(old_value), ''NULL'') from public.audit_log where table_name = ''mail_access'' and record_id = %L', acc::text),
    '1/true/NULL');
  perform pg_temp.t('L04 owner switching crew ON is refused', 'auth', u,
    format('select ''set'' from public.set_mail_access(%L, true)', pg_temp.fx('uCRW')), 'ERR 22023: Crew never gets company email%');
  perform pg_temp.t('L05 owner switching crew OFF is allowed; crew still has no mail', 'auth', u,
    format('select ''set'' from public.set_mail_access(%L, false)', pg_temp.fx('uCRW')), 'set');
  perform pg_temp.t('L06 a manager cannot change access', 'auth', mgr,
    format('select ''set'' from public.set_mail_access(%L, true)', pg_temp.fx('uSAL0')), 'ERR 42501%');
  perform pg_temp.t('L07 owner cannot reach another company''s member', 'auth', u,
    format('select ''set'' from public.set_mail_access(%L, false)', pg_temp.fx('uBOWN')), 'ERR P0002%');
  perform pg_temp.t('L08 owner target (self) refused', 'auth', u,
    format('select ''set'' from public.set_mail_access(%L, false)', u), 'ERR 22023%');
  perform pg_temp.t('L09 owner switches the manager off', 'auth', u,
    format('select ''set'' from public.set_mail_access(%L, false)', mgr), 'set');
  perform pg_temp.t('L10 ...manager gate false', 'auth', mgr, 'select public.can_use_company_mail()::text', 'false');
  perform pg_temp.t('L11 owner resets the manager to the default (null)', 'auth', u,
    format('select ''set'' from public.set_mail_access(%L, null)', mgr), 'set');
  perform pg_temp.t('L12 ...manager gate true again, no row left', 'auth', mgr,
    'select public.can_use_company_mail()::text || ''/'' || (select count(*) from public.mail_access where profile_id = auth.uid())::text', 'true/0');
  perform pg_temp.t('L13 POSITIVE owner reads every grant in the company', 'auth', u,
    'select count(*)::text from public.mail_access', '7');
  perform pg_temp.t('L14 a granted salesperson reads only their own row', 'auth', pg_temp.fx('uSAL'),
    'select count(*)::text || ''/'' || bool_and(profile_id = auth.uid())::text from public.mail_access', '1/true');
  perform pg_temp.t('L15 OWNER B reads none of A''s grants', 'auth', pg_temp.fx('uBOWN'), 'select count(*)::text from public.mail_access', '0');
end $body$;

-- ===========================================================================
-- M. Sync lock and rate ledger
-- ===========================================================================
do $body$
declare a uuid := pg_temp.fx('aA'); c uuid := pg_temp.fx('cA'); u uuid := pg_temp.fx('uOWN');
begin
  perform pg_temp.t('M01 POSITIVE first claim wins', 'svc', null, format('select public.mail_claim_sync(%L, 60)::text', a), 'true');
  perform pg_temp.t('M02 second claim while held loses', 'svc', null, format('select public.mail_claim_sync(%L, 60)::text', a), 'false');
  update public.mail_accounts set sync_lock_until = now() - interval '1 second' where id = a;
  perform pg_temp.t('M03 an expired lock can be claimed', 'svc', null, format('select public.mail_claim_sync(%L, 60)::text', a), 'true');
  perform pg_temp.t('M04 the FenceFlow account is never synced', 'svc', null, format('select public.mail_claim_sync(%L, 60)::text', pg_temp.fx('fA')), 'false');
  perform pg_temp.t('M05 ledger: first connect attempt counts 1', 'svc', null,
    format('select public.note_mail_event(%L, %L, ''connect_attempt'', ''1 hour'')::text', c, u), '1');
  perform pg_temp.t('M06 ledger: second counts 2', 'svc', null,
    format('select public.note_mail_event(%L, %L, ''connect_attempt'', ''1 hour'')::text', c, u), '2');
  perform pg_temp.t('M07 ledger: count without recording is still 2', 'svc', null,
    format('select public.mail_event_count(%L, ''connect_attempt'', ''1 day'')::text || ''/'' || public.mail_event_count(%L, ''connect_attempt'', ''1 day'')::text', c, c), '2/2');
  perform pg_temp.t('M08 ledger: another company is not charged', 'svc', null,
    format('select public.mail_event_count(%L, ''connect_attempt'', ''1 hour'')::text', pg_temp.fx('cB')), '0');
  perform pg_temp.t('M09 ledger: a window over 7 days is refused', 'svc', null,
    format('select public.note_mail_event(%L, %L, ''send_smtp'', ''30 days'')::text', c, u), 'ERR 22023%');
  perform pg_temp.t('M10 ledger: an unknown-token drop is counted with no company', 'svc', null,
    'select public.note_mail_event(null, null, ''inbound_dropped'', ''1 day'')::text', '1%');
  perform pg_temp.t('M11 ledger: any other kind needs a company', 'svc', null,
    'select public.note_mail_event(null, null, ''send_smtp'', ''1 day'')::text', 'ERR 23514%');
  perform pg_temp.t('M12 ledger: an unknown kind is refused', 'svc', null,
    format('select public.note_mail_event(%L, %L, ''spam_blast'', ''1 day'')::text', c, u), 'ERR 23514%');
  perform pg_temp.t('M13 ledger: a mail-message sign-in counts over a minute', 'svc', null,
    format('select public.note_mail_event(%L, %L, ''message_session'', ''1 minute'')::text', c, u), '1');
  perform pg_temp.t('M14 ledger: and the same one over the hour, recorded once', 'svc', null,
    format('select public.mail_event_count(%L, ''message_session'', ''1 hour'')::text', c), '1');
  perform pg_temp.t('M15 ledger: the office cannot spend or read it', 'auth', u,
    format('select public.note_mail_event(%L, %L, ''message_session'', ''1 minute'')::text', c, u), 'ERR 42501%');
  -- Two calls at once cannot both count before either records: M13 left its
  -- turn-taking lock (company + kind) held until this transaction ends.
  perform pg_temp.t('M16 ledger: recording takes the per-company, per-kind lock', 'pg', null,
    format('select (count(*) = 1)::text from pg_locks where locktype = ''advisory'' and pid = pg_backend_pid() '
           'and objsubid = 1 and objid::bigint = (hashtext(%L)::bigint & 4294967295)', 'mail_events:' || c || ':message_session'), 'true');
end $body$;

-- ===========================================================================
-- N. Table rules (as postgres, so only the constraints and triggers decide)
-- ===========================================================================
do $body$
declare
  c uuid := pg_temp.fx('cA');
  ins text := 'insert into public.mail_accounts (company_id, kind, provider, email_address, username, imap_host, smtp_host, imap_port, smtp_port) values (%L, ''imap'', ''custom'', %L, %L, %L, %L, %s, %s)';
begin
  perform pg_temp.t('N01 an IP literal host is refused', 'pg', null,
    format(ins, c, 'n1@acme.example', 'n1', '10.0.0.1', 'smtp.acme.example', 993, 465), 'ERR 23514%', true);
  perform pg_temp.t('N02 localhost is refused', 'pg', null,
    format(ins, c, 'n2@acme.example', 'n2', 'localhost', 'smtp.acme.example', 993, 465), 'ERR 23514%', true);
  perform pg_temp.t('N03 a .internal name is refused', 'pg', null,
    format(ins, c, 'n3@acme.example', 'n3', 'mail.corp.internal', 'smtp.acme.example', 993, 465), 'ERR 23514%', true);
  perform pg_temp.t('N04 port 587 is refused', 'pg', null,
    format(ins, c, 'n4@acme.example', 'n4', 'imap.acme.example', 'smtp.acme.example', 993, 587), 'ERR 23514%', true);
  perform pg_temp.t('N05 an address with a newline is refused', 'pg', null,
    format(ins, c, 'n5@acme.example' || chr(10) || 'bcc@x.example', 'n5', 'imap.acme.example', 'smtp.acme.example', 993, 465), 'ERR 23514%', true);
  perform pg_temp.t('N06 POSITIVE a 2nd mailbox (mixed-case host) is accepted', 'pg', null,
    format(ins, c, 'N6@Acme.example', 'n6', 'IMAP.Acme.example', 'smtp.acme.example', 993, 465), 'rows=1', true);
  perform pg_temp.t('N07 ...stored lower-cased', 'pg', null,
    'select email_address || ''|'' || imap_host from public.mail_accounts where username = ''n6''', 'n6@acme.example|imap.acme.example');
  perform pg_temp.t('N08 POSITIVE a 3rd mailbox is accepted', 'pg', null,
    format(ins, c, 'n8@acme.example', 'n8', 'imap.acme.example', 'smtp.acme.example', 993, 465), 'rows=1', true);
  perform pg_temp.t('N09 a 4th live mailbox is refused', 'pg', null,
    format(ins, c, 'n9@acme.example', 'n9', 'imap.acme.example', 'smtp.acme.example', 993, 465), 'ERR 23514: A company can connect at most 3 mailboxes.%', true);
  perform pg_temp.t('N10 a second FenceFlow account for one company is refused', 'pg', null,
    format('insert into public.mail_accounts (company_id, kind, provider, email_address) values (%L, ''fenceflow'', ''resend'', ''x@send.fenceflow.example'')', c), 'ERR 23505%', true);
  perform pg_temp.t('N11 an account cannot move to another company', 'pg', null,
    format('update public.mail_accounts set company_id = %L where id = %L', pg_temp.fx('cB'), pg_temp.fx('aA')), 'ERR 42501%', true);
  perform pg_temp.t('N12 a message cannot sit in another company''s thread', 'pg', null,
    format('insert into public.mail_messages (company_id, account_id, thread_id, folder_role, source, uidvalidity, uid, received_at) values (%L, %L, %L, ''inbox'', ''imap'', 1, 5000, now())',
           c, pg_temp.fx('aA'), pg_temp.fx('tB')), 'ERR 23503%', true);
  perform pg_temp.t('N13 the platform settings row exists; a second is refused', 'pg', null,
    'select (select count(*) from public.mail_platform_settings where id = 1)::text', '1');
  perform pg_temp.t('N14 ...a second row', 'pg', null,
    'insert into public.mail_platform_settings (id) values (2)', 'ERR 23514%', true);
end $body$;

-- ===========================================================================
-- Z. Nothing secret came back in any answer above
-- ===========================================================================
do $body$
begin
  perform pg_temp.t('Z01 no answer contains a stored or planted password', 'pg', null,
    'select count(*)::text from r where v like ''%probe-app-pw%'' or v like ''%PLANTED%''', '0');
end $body$;

select jsonb_pretty(jsonb_build_object(
  'failed',   (select count(*) from r where not ok),
  'total',    (select count(*) from r),
  'failures', coalesce((select jsonb_agg(jsonb_build_array(n, k, v, want) order by n) from r where not ok), '[]'::jsonb),
  'all',      (select jsonb_agg(jsonb_build_array(n, k, v) order by n) from r))) as mail_probe;
rollback;
