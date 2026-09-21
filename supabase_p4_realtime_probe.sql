-- P4 / Realtime isolation probe -- one rolled-back transaction, synthetic subjects.
--
-- WHAT THIS RUNS. Supabase Realtime's Postgres-Changes path is SQL inside this
-- database: the Realtime server calls realtime.list_changes(), which reads the
-- publication, pulls wal2json from a logical slot and hands every change to
-- realtime.apply_rls(). apply_rls decides WHICH subscription ids receive the
-- change and builds the exact payload (record -> payload.new, old_record ->
-- payload.old). This probe calls the DEPLOYED apply_rls against synthetic
-- subscriptions, so delivery and payload are the production decision, not a
-- re-implementation of it.
--
-- WHAT IT CANNOT RUN. The websocket itself, and the wal2json record. The record
-- is built by pg_temp.wal() in the shape wal2json was OBSERVED to emit on this
-- database (supabase_p4_realtime_wal_shape.sql): an UPDATE or DELETE carries
-- "identity" = every old column under REPLICA IDENTITY FULL and the primary key
-- only under DEFAULT; a DELETE carries no "columns" at all.
--
-- Subjects: company A (SC) with an owner, a crew member and a plain member;
-- company B (SC2) with an owner who is the attacker; and an anonymous client
-- holding only the public anon key. Every subject is picked by
-- PROPERTY first (has_permission / current_company_id), and every "not
-- delivered" is paired with a positive control on the same subscription so a
-- broken fixture cannot read as a working guard.
--
-- Phases:
--   LIVE     whatever replica identity and publication flags are live when
--            this runs (run it before and after the fix)
--   DRYRUN   the planned fix applied in-transaction (4 tables -> DEFAULT,
--            publication stops publishing DELETE); jobs stays FULL
--   DEPTH    DEFAULT on the four tables with DELETE still published
--   ALT      the rejected alternative: jobs -> DEFAULT (shows the dashboard
--            approval banner would fire on an ordinary edit)
begin;

create temp table r(n serial, k text, v text);
grant all on r to authenticated, anon;
grant usage on sequence r_n_seq to authenticated, anon;
create temp table subs(label text, sid uuid, tbl regclass, sens text[]);
create temp table outp(wal jsonb, is_rls bool, sids uuid[], errors text[]);
create temp table ev(n serial, phase text, tbl text, tag text, label text, delivered bool, detail text);

-- Impersonate a PostgREST caller (same helper as the P3 probes).
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

-- A wal2json format-version-2 record for one existing row.
--   act   I / U / D
--   ri    'live' reads pg_class.relreplident; 'f' or 'd' forces it (dry run)
--   new_over / old_over  values that differ between the new and old tuple
create function pg_temp.wal(act text, tbl regclass, rid uuid, ri text,
                            new_over jsonb default '{}', old_over jsonb default '{}')
returns jsonb language plpgsql as $fn$
declare expr text; rowj jsonb; newj jsonb; oldj jsonb; cols jsonb; ident jsonb; pk jsonb; pkatt int2[];
begin
  select string_agg(format('jsonb_build_object(%s)', parts), ' || ') into expr from (
    select (n-1)/40 grp, string_agg(format('%L, x.%I::text', attname, attname), ', ' order by n) parts
      from (select attname, row_number() over (order by attnum) n
              from pg_attribute where attrelid = tbl and attnum > 0 and not attisdropped) s
     group by grp) g;
  execute format('select %s from %s x where x.id = $1', expr, tbl) into rowj using rid;
  if rowj is null then raise exception 'fixture % % missing', tbl, rid; end if;
  newj := rowj || new_over;
  oldj := rowj || old_over;
  if ri = 'live' then select relreplident::text into ri from pg_class where oid = tbl; end if;
  select conkey into pkatt from pg_constraint where conrelid = tbl and contype = 'p';

  select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,null),
                   'typeoid',a.atttypid::int,'value',newj->a.attname) order by a.attnum)
    into cols from pg_attribute a where a.attrelid = tbl and a.attnum > 0 and not a.attisdropped;
  select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,null),
                   'typeoid',a.atttypid::int,'value',oldj->a.attname) order by a.attnum)
    into ident from pg_attribute a where a.attrelid = tbl and a.attnum > 0 and not a.attisdropped
     and (ri = 'f' or (ri in ('d','i') and a.attnum = any(pkatt)));
  select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,null),
                   'typeoid',a.atttypid::int) order by a.attnum)
    into pk from pg_attribute a where a.attrelid = tbl and a.attnum = any(pkatt);

  return jsonb_build_object('action', act,
           'timestamp', to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD HH24:MI:SS.US') || '+00',
           'schema', (select n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = tbl),
           'table', (select relname from pg_class where oid = tbl),
           'pk', pk)
      || case when act in ('I','U') then jsonb_build_object('columns', cols) else '{}'::jsonb end
      || case when act in ('U','D') and ident is not null then jsonb_build_object('identity', ident) else '{}'::jsonb end;
end $fn$;

-- What wal2json is ASKED for, computed exactly as realtime.list_changes does.
create function pg_temp.w2j_actions() returns text language sql as $fn$
  select concat_ws(',',
           case when bool_or(pubinsert) then 'insert' end,
           case when bool_or(pubupdate) then 'update' end,
           case when bool_or(pubdelete) then 'delete' end)
    from pg_publication where pubname = 'supabase_realtime'
$fn$;

-- Hand one change to the deployed apply_rls and score every synthetic
-- subscription on that table. A DELETE is only scored as reaching apply_rls if
-- the publication still asks wal2json for deletes.
create function pg_temp.deliver(ph text, tag text, w jsonb) returns void language plpgsql as $fn$
declare emitted bool := (w->>'action') <> 'D' or pg_temp.w2j_actions() like '%delete%';
begin
  delete from outp;
  if emitted then
    insert into outp select * from realtime.apply_rls(w);
  end if;
  insert into ev(phase, tbl, tag, label, delivered, detail)
  select ph, w->>'table', tag, s.label, o.wal is not null,
         case when not emitted then 'not emitted: publication does not publish DELETE'
              when o.wal is null then '-'
              else format('new[%s keys]%s old[%s keys]%s%s',
                     coalesce((select count(*) from jsonb_object_keys(coalesce(o.wal->'record','{}'::jsonb))),0),
                     coalesce((select string_agg(format(' %s=%s', c, o.wal->'record'->>c), '' order by c)
                                 from unnest(s.sens) c where o.wal->'record' ? c), ''),
                     coalesce((select count(*) from jsonb_object_keys(coalesce(o.wal->'old_record','{}'::jsonb))),0),
                     coalesce((select string_agg(format(' %s=%s', c, coalesce(o.wal->'old_record'->>c,'null')), '' order by c)
                                 from unnest(s.sens) c where o.wal->'old_record' ? c), ''),
                     case when array_length(o.errors,1) > 0 then ' errors=' || array_to_string(o.errors, ';') else '' end)
         end
    from subs s
    left join lateral (select * from outp where s.sid = any(outp.sids) limit 1) o on true
   where s.tbl = format('%I.%I', w->>'schema', w->>'table')::regclass;
end $fn$;

-- dashboard.html line ~17164, in SQL: fires when payload.new.quote_approved_at
-- is set and payload.old.quote_approved_at is falsy (null OR ABSENT).
create function pg_temp.banner(ph text, tag text, uid_label text, w jsonb) returns void language plpgsql as $fn$
declare o record; fires text;
begin
  delete from outp;
  insert into outp select * from realtime.apply_rls(w);
  select case when (x.wal->'record'->>'quote_approved_at') is not null
               and (x.wal->'old_record'->>'quote_approved_at') is null then 'BANNER FIRES' else 'quiet' end
    into fires
    from outp x join subs s on s.sid = any(x.sids) and s.label = uid_label;
  insert into r(k,v) values (format('%s %s dashboard banner', ph, tag), coalesce(fires, 'NOT DELIVERED'));
end $fn$;

-- ===========================================================================
-- Fixtures (all synthetic, all rolled back)
-- ===========================================================================
do $body$
declare
  SC   uuid := 'e0000001-0000-4000-8000-0000000000a1';
  SC2  uuid := 'e0000002-0000-4000-8000-0000000000b2';
  uOWN uuid := 'e1000001-0000-4000-8000-000000000001';
  uCRW uuid := 'e1000002-0000-4000-8000-000000000002';
  uMEM uuid := 'e1000003-0000-4000-8000-000000000003';
  uOTH uuid := 'e1000004-0000-4000-8000-000000000004';
  eCRW uuid := 'e2000002-0000-4000-8000-000000000002';
  eOTH uuid := 'e2000004-0000-4000-8000-000000000004';
  jA   uuid := 'e3000001-0000-4000-8000-000000000001';
  jB   uuid := 'e3000002-0000-4000-8000-000000000002';
  pA   uuid := 'e4000001-0000-4000-8000-000000000001';
  rA   uuid := 'e5000001-0000-4000-8000-000000000001';
  fA   uuid := 'e6000001-0000-4000-8000-000000000001';
  tA   uuid := 'e7000001-0000-4000-8000-000000000001';
  eCOL uuid := 'e2000005-0000-4000-8000-000000000005';  -- a colleague on better pay
  tCOL uuid := 'e7000002-0000-4000-8000-000000000002';
begin
  perform set_config('request.jwt.claims','',true);
  insert into auth.users(id,email) values
    (uOWN,'p4-own@probe.invalid'),(uCRW,'p4-crw@probe.invalid'),
    (uMEM,'p4-mem@probe.invalid'),(uOTH,'p4-oth@probe.invalid');
  insert into companies(id,name,subscription_status,subscription_plan,suspended,trial_ends_at,
                        admin_notes,leads_token,stripe_customer_id,invited_email,suspended_reason) values
    (SC ,'PROBE-P4-A','active','pro',false,now()+interval '30 days','',gen_random_uuid(),'cus_P4a','',''),
    (SC2,'PROBE-P4-B','active','pro',false,now()+interval '30 days','',gen_random_uuid(),'cus_P4b','','');
  insert into profiles(id,company_id,full_name,role,is_platform_admin,permission_overrides) values
    (uOWN,SC ,'Probe Owner A' ,'OWNER',false,''),
    (uCRW,SC ,'Probe Crew A'  ,'CREW' ,false,''),
    (uMEM,SC ,'Probe Member A','CREW' ,false,''),
    (uOTH,SC2,'Probe Owner B' ,'OWNER',false,'');
  insert into employees(id,company_id,name,sync_id,hourly_rate,pay_type,profile_id,is_active) values
    (eCRW,SC ,'Probe Crew A' ,eCRW,21.50,'HOURLY',uCRW,true),
    (eOTH,SC2,'Probe Owner B',eOTH,99.00,'HOURLY',uOTH,true),
    (eCOL,SC ,'Probe Colleague A',eCOL,33.00,'HOURLY',null,true);
  insert into jobs(id,company_id,customer_name,address,phone,email,status,sync_id,contract_total,
                   quote_token,is_test_fixture,notes,assigned_employee_sync_id) values
    (jA,SC ,'Probe Homeowner A','1 Probe Way','555-0100','p4a@probe.invalid','ACCEPTED',jA,18500,
     gen_random_uuid(),true,'',eCRW::text),
    (jB,SC2,'Probe Homeowner B','2 Probe Way','555-0200','p4b@probe.invalid','ACCEPTED',jB,17000,
     gen_random_uuid(),true,'',eOTH::text);
  insert into job_payments(id,company_id,job_sync_id,kind,amount_cents,currency,status)
    values (pA,SC,jA,'deposit',925000,'usd','paid');
  insert into payment_records(id,sync_id,company_id,job_sync_id,amount,method,received_at,note,recorded_by)
    values (rA,rA::text,SC,jA,4000,'check',now(),'','Probe Owner A');
  insert into field_changes(id,company_id,sync_id,job_sync_id,summary,detail,changed_by,changed_by_role,at)
    values (fA,SC,fA::text,jA,'Probe change: moved the gate','','Probe Crew A','CREW',now());
  insert into time_entries(id,company_id,sync_id,job_sync_id,employee_sync_id,started_at,ended_at,
                           hourly_rate,notes,updated_at)
    values (tA,SC,tA,jA,eCRW::text,now()-interval '9 hours',now()-interval '1 hour',21.50,'',now()),
           (tCOL,SC,tCOL,jA,eCOL::text,now()-interval '9 hours',now()-interval '1 hour',33.00,'',now());
end $body$;

-- ------------------------------------------------ subjects, picked by property
select pg_temp.p('00 OWNER-A  company/SEE_MONEY/SEE_PAY', 'e1000001-0000-4000-8000-000000000001',
  'select (current_company_id() = ''e0000001-0000-4000-8000-0000000000a1'')::text||''/''||has_permission(''SEE_MONEY'')::text||''/''||has_permission(''SEE_PAY'')::text');
select pg_temp.p('01 CREW-A   company/SEE_MONEY/SEE_PAY', 'e1000002-0000-4000-8000-000000000002',
  'select (current_company_id() = ''e0000001-0000-4000-8000-0000000000a1'')::text||''/''||has_permission(''SEE_MONEY'')::text||''/''||has_permission(''SEE_PAY'')::text');
select pg_temp.p('02 OWNER-B  company is B (not A)/SEE_MONEY', 'e1000004-0000-4000-8000-000000000004',
  'select (current_company_id() = ''e0000002-0000-4000-8000-0000000000b2'')::text||''/''||has_permission(''SEE_MONEY'')::text');

-- ------------------------------------------------ direct SELECT, the yardstick
-- Realtime must never deliver more than these return.
select pg_temp.p('10 CREW-A  SELECT jobs row A (contract_total)', 'e1000002-0000-4000-8000-000000000002',
  'select coalesce(string_agg(contract_total::text, '',''), ''0 rows'') from jobs where id = ''e3000001-0000-4000-8000-000000000001''');
select pg_temp.p('11 CREW-A  SELECT job_payments A (amount_cents)', 'e1000002-0000-4000-8000-000000000002',
  'select coalesce(string_agg(amount_cents::text, '',''), ''0 rows'') from job_payments where id = ''e4000001-0000-4000-8000-000000000001''');
select pg_temp.p('12 CREW-A  SELECT payment_records A (amount)', 'e1000002-0000-4000-8000-000000000002',
  'select coalesce(string_agg(amount::text, '',''), ''0 rows'') from payment_records where id = ''e5000001-0000-4000-8000-000000000001''');
select pg_temp.p('13 CREW-A  SELECT own time_entries (hourly_rate)', 'e1000002-0000-4000-8000-000000000002',
  'select coalesce(string_agg(hourly_rate::text, '',''), ''0 rows'') from time_entries where id = ''e7000001-0000-4000-8000-000000000001''');
select pg_temp.p('14 CREW-A  SELECT own employees row (hourly_rate)', 'e1000002-0000-4000-8000-000000000002',
  'select coalesce(string_agg(hourly_rate::text, '',''), ''0 rows'') from employees where id = ''e2000002-0000-4000-8000-000000000002''');
select pg_temp.p('14b CREW-A SELECT colleague time_entries (hourly_rate)', 'e1000002-0000-4000-8000-000000000002',
  'select coalesce(string_agg(hourly_rate::text, '',''), ''0 rows'') from time_entries where id = ''e7000002-0000-4000-8000-000000000002''');
select pg_temp.p('14c CREW-A SELECT colleague employees row (hourly_rate)', 'e1000002-0000-4000-8000-000000000002',
  'select coalesce(string_agg(hourly_rate::text, '',''), ''0 rows'') from employees where id = ''e2000005-0000-4000-8000-000000000005''');
select pg_temp.p('15 CREW-A  SELECT field_changes A (positive control)', 'e1000002-0000-4000-8000-000000000002',
  'select count(*)::text from field_changes where id = ''e6000001-0000-4000-8000-000000000001''');
select pg_temp.p('16 OWNER-B SELECT jobs row A', 'e1000004-0000-4000-8000-000000000004',
  'select count(*)::text from jobs where id = ''e3000001-0000-4000-8000-000000000001''');
select pg_temp.p('17 OWNER-B SELECT jobs row B (positive control)', 'e1000004-0000-4000-8000-000000000004',
  'select count(*)::text from jobs where id = ''e3000002-0000-4000-8000-000000000002''');

-- ------------------------------------------------ who can HARD delete at all?
-- A DELETE is the one change Realtime cannot authorise. Clients hard-deleting
-- these five tables would be the only everyday source of one.
select pg_temp.x('20 OWNER-A hard DELETE jobs A (TrashBin.purge shape)', 'e1000001-0000-4000-8000-000000000001',
  'delete from jobs where company_id = ''e0000001-0000-4000-8000-0000000000a1'' and sync_id = ''e3000001-0000-4000-8000-000000000001''');
select pg_temp.x('21 OWNER-A hard DELETE job_payments A', 'e1000001-0000-4000-8000-000000000001',
  'delete from job_payments where id = ''e4000001-0000-4000-8000-000000000001''');
select pg_temp.x('22 OWNER-A hard DELETE payment_records A', 'e1000001-0000-4000-8000-000000000001',
  'delete from payment_records where id = ''e5000001-0000-4000-8000-000000000001''');
select pg_temp.x('23 OWNER-A hard DELETE field_changes A', 'e1000001-0000-4000-8000-000000000001',
  'delete from field_changes where id = ''e6000001-0000-4000-8000-000000000001''');
select pg_temp.x('24 OWNER-A hard DELETE member profile', 'e1000001-0000-4000-8000-000000000001',
  'delete from profiles where id = ''e1000003-0000-4000-8000-000000000003''');
select pg_temp.p('25 rows still present (positive control: 5 = nothing was deleted)', 'e1000001-0000-4000-8000-000000000001',
  'select ((select count(*) from jobs where id=''e3000001-0000-4000-8000-000000000001'')
          +(select count(*) from job_payments where id=''e4000001-0000-4000-8000-000000000001'')
          +(select count(*) from payment_records where id=''e5000001-0000-4000-8000-000000000001'')
          +(select count(*) from field_changes where id=''e6000001-0000-4000-8000-000000000001'')
          +(select count(*) from profiles where id=''e1000003-0000-4000-8000-000000000003''))::text');

-- ===========================================================================
-- Subscriptions: what the phone, the dashboard and an attacker would register
-- ===========================================================================
create function pg_temp.sub(label text, uid uuid, tbl regclass, act text, filt realtime.user_defined_filter[], sens text[])
returns void language plpgsql as $fn$
declare s uuid := gen_random_uuid();
begin
  insert into realtime.subscription(subscription_id, entity, filters, claims, action_filter)
  values (s, tbl, coalesce(filt, '{}'),
          case when uid is null   -- the public anon key: no sign-in at all
               then jsonb_build_object('role', 'anon', 'exp', extract(epoch from now() + interval '1 hour')::bigint)
               else jsonb_build_object('sub', uid, 'role', 'authenticated',
                                       'exp', extract(epoch from now() + interval '1 hour')::bigint) end,
          act);
  insert into subs values (label, s, tbl, sens);
exception when others then
  insert into r(k,v) values ('SUB ' || label, 'REJECTED: ' || left(sqlerrm, 150));
end $fn$;

do $subs$
declare
  SC   text := 'e0000001-0000-4000-8000-0000000000a1';
  uOWN uuid := 'e1000001-0000-4000-8000-000000000001';
  uCRW uuid := 'e1000002-0000-4000-8000-000000000002';
  uMEM uuid := 'e1000003-0000-4000-8000-000000000003';
  uOTH uuid := 'e1000004-0000-4000-8000-000000000004';
  byco realtime.user_defined_filter[] := array[('company_id','eq',SC,false)::realtime.user_defined_filter];
  t record;
begin
  for t in select * from (values
      ('jobs',            'UPDATE', array['contract_total','customer_name','quote_approved_at'], ('contract_total','gt','10000',false)::realtime.user_defined_filter),
      ('job_payments',    '*',      array['amount_cents'],            ('amount_cents','gt','100000',false)::realtime.user_defined_filter),
      ('payment_records', '*',      array['amount'],                  ('amount','gt','1000',false)::realtime.user_defined_filter),
      ('field_changes',   '*',      array['summary'],                 ('summary','imatch','^probe',false)::realtime.user_defined_filter),
      ('profiles',        '*',      array['full_name','role','company_id'], ('full_name','imatch','^probe',false)::realtime.user_defined_filter),
      ('time_entries',    '*',      array['hourly_rate'],             ('hourly_rate','gt','20',false)::realtime.user_defined_filter),
      ('employees',       '*',      array['hourly_rate'],             ('hourly_rate','gt','20',false)::realtime.user_defined_filter)
    ) v(tbl, appact, sens, oracle)
  loop
    -- RealtimeWatcher.kt: every flow is filtered on company_id; jobs is Update-only.
    perform pg_temp.sub('A-owner app   ' || t.tbl, uOWN, ('public.' || t.tbl)::regclass, t.appact, byco, t.sens);
    perform pg_temp.sub('A-crew app    ' || t.tbl, uCRW, ('public.' || t.tbl)::regclass, t.appact, byco, t.sens);
    -- Company B, hand-written client: everything, A's company id, and a value oracle.
    perform pg_temp.sub('B unfiltered  ' || t.tbl, uOTH, ('public.' || t.tbl)::regclass, '*', null, t.sens);
    perform pg_temp.sub('B co=A        ' || t.tbl, uOTH, ('public.' || t.tbl)::regclass, '*', byco, t.sens);
    perform pg_temp.sub('B oracle      ' || t.tbl, uOTH, ('public.' || t.tbl)::regclass, '*', array[t.oracle], t.sens);
    -- Nobody signed in: the anon key from website/config.js, same oracle.
    perform pg_temp.sub('anon oracle   ' || t.tbl, null, ('public.' || t.tbl)::regclass, '*', array[t.oracle], t.sens);
  end loop;
  -- dashboard.html line ~17162: jobs UPDATE, no filter.
  perform pg_temp.sub('A-owner dash  jobs', uOWN, 'public.jobs', 'UPDATE', null, array['contract_total','customer_name','quote_approved_at']);
  perform pg_temp.sub('A-crew unfilt jobs', uCRW, 'public.jobs', '*', null, array['contract_total','customer_name','quote_approved_at']);
  -- The member's own phone, watching its own company's profiles.
  perform pg_temp.sub('A-member app  profiles', uMEM, 'public.profiles', '*', byco, array['full_name','role','company_id']);
end $subs$;

insert into r(k,v) select '30 synthetic subscriptions registered', count(*)::text from subs;

-- ===========================================================================
-- Events
-- ===========================================================================
create function pg_temp.events(ph text, ri_jobs text, ri_money text, ri_default text) returns void language plpgsql as $fn$
declare
  jA uuid := 'e3000001-0000-4000-8000-000000000001';
  jB uuid := 'e3000002-0000-4000-8000-000000000002';
  pA uuid := 'e4000001-0000-4000-8000-000000000001';
  rA uuid := 'e5000001-0000-4000-8000-000000000001';
  fA uuid := 'e6000001-0000-4000-8000-000000000001';
  uMEM uuid := 'e1000003-0000-4000-8000-000000000003';
  tA uuid := 'e7000001-0000-4000-8000-000000000001';
  eCRW uuid := 'e2000002-0000-4000-8000-000000000002';
  appr jsonb := jsonb_build_object('quote_approved_at', '2026-09-21 12:00:00+00', 'quote_approved_name', 'Probe Homeowner A');
begin
  -- jobs
  perform pg_temp.deliver(ph, 'I A-job',  pg_temp.wal('I','public.jobs',jA,ri_jobs));
  perform pg_temp.deliver(ph, 'U A-job approved (old unapproved)', pg_temp.wal('U','public.jobs',jA,ri_jobs, appr, '{"quote_approved_at":null,"quote_approved_name":null}'));
  perform pg_temp.deliver(ph, 'D A-job',  pg_temp.wal('D','public.jobs',jA,ri_jobs));
  perform pg_temp.deliver(ph, 'I B-job (B positive control)', pg_temp.wal('I','public.jobs',jB,ri_jobs));
  -- the money tables
  perform pg_temp.deliver(ph, 'I', pg_temp.wal('I','public.job_payments',pA,ri_money));
  perform pg_temp.deliver(ph, 'U', pg_temp.wal('U','public.job_payments',pA,ri_money, '{"status":"refunded"}', '{"status":"paid"}'));
  perform pg_temp.deliver(ph, 'D', pg_temp.wal('D','public.job_payments',pA,ri_money));
  perform pg_temp.deliver(ph, 'I', pg_temp.wal('I','public.payment_records',rA,ri_money));
  perform pg_temp.deliver(ph, 'U', pg_temp.wal('U','public.payment_records',rA,ri_money, '{"note":"edited"}', '{"note":""}'));
  perform pg_temp.deliver(ph, 'D', pg_temp.wal('D','public.payment_records',rA,ri_money));
  perform pg_temp.deliver(ph, 'I', pg_temp.wal('I','public.field_changes',fA,ri_money));
  perform pg_temp.deliver(ph, 'U', pg_temp.wal('U','public.field_changes',fA,ri_money, '{"approved_at":"2026-09-21 12:00:00+00"}', '{"approved_at":null}'));
  perform pg_temp.deliver(ph, 'D', pg_temp.wal('D','public.field_changes',fA,ri_money));
  perform pg_temp.deliver(ph, 'U permission change', pg_temp.wal('U','public.profiles',uMEM,ri_money, '{"permission_overrides":"-SEE_JOBS"}', '{"permission_overrides":""}'));
  perform pg_temp.deliver(ph, 'U removal (company_id -> null)', pg_temp.wal('U','public.profiles',uMEM,ri_money,
            jsonb_build_object('company_id', null, 'removed_from_company_id', 'e0000001-0000-4000-8000-0000000000a1'), '{}'));
  perform pg_temp.deliver(ph, 'D', pg_temp.wal('D','public.profiles',uMEM,ri_money));
  -- pay tables (already DEFAULT) -- the crew parity check
  perform pg_temp.deliver(ph, 'I own shift', pg_temp.wal('I','public.time_entries',tA,ri_default));
  perform pg_temp.deliver(ph, 'D own shift', pg_temp.wal('D','public.time_entries',tA,ri_default));
  perform pg_temp.deliver(ph, 'I colleague shift', pg_temp.wal('I','public.time_entries','e7000002-0000-4000-8000-000000000002',ri_default));
  perform pg_temp.deliver(ph, 'U colleague employee row', pg_temp.wal('U','public.employees','e2000005-0000-4000-8000-000000000005',ri_default, '{"notes":"x"}', '{"notes":""}'));
  perform pg_temp.deliver(ph, 'U own employee row', pg_temp.wal('U','public.employees',eCRW,ri_default, '{"notes":"x"}', '{"notes":""}'));
  perform pg_temp.deliver(ph, 'D own employee row', pg_temp.wal('D','public.employees',eCRW,ri_default));
end $fn$;

insert into r(k,v) values ('40 LIVE wal2json actions', pg_temp.w2j_actions());
insert into r(k,v) select '41 LIVE replica identity', string_agg(relname || '=' || relreplident::text, ' ' order by relname)
  from pg_class where oid in ('public.jobs'::regclass,'public.job_payments'::regclass,'public.payment_records'::regclass,
                              'public.field_changes'::regclass,'public.profiles'::regclass,'public.time_entries'::regclass,'public.employees'::regclass);
select pg_temp.events('LIVE', 'live', 'live', 'live');

-- dashboard banner: a genuine approval, then an ordinary edit of an approved job
select pg_temp.banner('LIVE', 'real approval  ', 'A-owner dash  jobs',
  pg_temp.wal('U','public.jobs','e3000001-0000-4000-8000-000000000001','live',
    '{"quote_approved_at":"2026-09-21 12:00:00+00"}', '{"quote_approved_at":null}'));
select pg_temp.banner('LIVE', 'ordinary edit  ', 'A-owner dash  jobs',
  pg_temp.wal('U','public.jobs','e3000001-0000-4000-8000-000000000001','live',
    '{"quote_approved_at":"2026-09-21 12:00:00+00","notes":"gate moved"}', '{"quote_approved_at":"2026-09-21 12:00:00+00","notes":""}'));

-- ===========================================================================
-- DRYRUN: the planned fix, in this transaction only
-- ===========================================================================
alter publication supabase_realtime set (publish = 'insert, update, truncate');
insert into r(k,v) values ('50 DRYRUN wal2json actions', pg_temp.w2j_actions());
select pg_temp.events('DRYRUN', 'f', 'd', 'd');
select pg_temp.banner('DRYRUN', 'real approval  ', 'A-owner dash  jobs',
  pg_temp.wal('U','public.jobs','e3000001-0000-4000-8000-000000000001','f',
    '{"quote_approved_at":"2026-09-21 12:00:00+00"}', '{"quote_approved_at":null}'));
select pg_temp.banner('DRYRUN', 'ordinary edit  ', 'A-owner dash  jobs',
  pg_temp.wal('U','public.jobs','e3000001-0000-4000-8000-000000000001','f',
    '{"quote_approved_at":"2026-09-21 12:00:00+00","notes":"gate moved"}', '{"quote_approved_at":"2026-09-21 12:00:00+00","notes":""}'));

-- DEPTH: the second layer on its own. If DELETE were ever published again,
-- DEFAULT on the four tables still leaves a DELETE carrying only the primary
-- key, so no filter on any other column can match it.
alter publication supabase_realtime set (publish = 'insert, update, delete, truncate');
insert into r(k,v) values ('60 DEPTH wal2json actions', pg_temp.w2j_actions());
select pg_temp.events('DEPTH', 'f', 'd', 'd');

-- ALT: why jobs keeps FULL. Under DEFAULT payload.old is {id} only.
select pg_temp.banner('ALT jobs=DEFAULT', 'real approval  ', 'A-owner dash  jobs',
  pg_temp.wal('U','public.jobs','e3000001-0000-4000-8000-000000000001','d',
    '{"quote_approved_at":"2026-09-21 12:00:00+00"}', '{"quote_approved_at":null}'));
select pg_temp.banner('ALT jobs=DEFAULT', 'ordinary edit  ', 'A-owner dash  jobs',
  pg_temp.wal('U','public.jobs','e3000001-0000-4000-8000-000000000001','d',
    '{"quote_approved_at":"2026-09-21 12:00:00+00","notes":"gate moved"}', '{"quote_approved_at":"2026-09-21 12:00:00+00","notes":""}'));

select jsonb_pretty(jsonb_build_object(
  'checks', (select jsonb_agg(jsonb_build_array(n,k,v) order by n) from r),
  'events', (select jsonb_agg(format('%-7s %-15s %-34s %-24s %s %s', phase, tbl, tag, label,
                                     case when delivered then 'DELIVERED' else 'no       ' end, detail) order by n) from ev)
)) as p4;
rollback;
