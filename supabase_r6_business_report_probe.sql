-- supabase_r6_business_report_probe.sql -- read-only proof for business_report().
-- Run AFTER supabase_r6_business_report.sql. Everything is inside one
-- transaction that rolls back; nothing is written.
--
-- Personas are chosen by PROPERTY, and each one's property is re-asserted from
-- inside the impersonated session (has_permission / plan), so a persona that
-- quietly changed role cannot turn a refusal into a false pass. Positive
-- controls are interleaved: the owner must get at least one job, and asking
-- for test data must make the answer GROW -- otherwise "0 fixtures" proves
-- nothing (the company might simply have none).
--
-- Expected (ok column is true on every row):
--   a_owner_pro            allowed, jobs > 0, fixture_rows = 0
--   b_owner_pro_with_test  allowed, jobs > a's jobs, fixture_rows > 0, aging >= a's
--   c_manager_asks_test    allowed, include_test false, jobs = a's jobs
--   d_crew                 {allowed:false, reason:'see_money'}, and has_permission false
--   e_owner_crew_plan      {allowed:false, reason:'plan'}
--   f_owner_solo_plan      {allowed:false, reason:'plan'}
--   g_owner_blank_plan     allowed (blank plan = full access)
--   h_anon                 refused by the grant (permission denied)
--   i_profit_matches       a's total projected profit = job_costing() over the same non-fixture jobs
--   j_unrated_split        a's unrated_hours + per_foot_hours = approved zero-rate hours recomputed
--                          from time_entries (and > 0, so the equality has teeth)
--   k_rpcs_signed_in_only  business_report, job_costing and ar_aging: no PUBLIC or anon EXECUTE
begin;

create temp table _brp(persona text, ok boolean, detail text) on commit drop;

do $probe$
declare
  pro_co uuid; owner_pro uuid; mgr uuid; crew uuid; owner_crew uuid; owner_solo uuid; owner_blank uuid;
  r jsonb; a jsonb; b jsonb; perm boolean; jc_profit numeric; a_profit numeric;
  njobs int; nfix int; a_owed numeric; b_owed numeric;
begin
  -- a Pro company that HAS live test fixtures, so the include_test control has teeth
  select c.id into pro_co from companies c
   where lower(coalesce(c.subscription_plan, '')) = 'pro'
     and exists (select 1 from jobs j where j.company_id = c.id and j.deleted_at is null and j.is_test_fixture)
     and exists (select 1 from jobs j where j.company_id = c.id and j.deleted_at is null and not coalesce(j.is_test_fixture, false))
   limit 1;
  select p.id into owner_pro from profiles p where p.company_id = pro_co and p.role::text = 'OWNER' limit 1;
  select p.id into mgr  from profiles p where p.company_id = pro_co and p.role::text = 'MANAGER' limit 1;
  select p.id into crew from profiles p where p.role::text = 'CREW'
    order by (p.company_id = pro_co) desc limit 1;
  select p.id into owner_crew from profiles p join companies c on c.id = p.company_id
   where lower(coalesce(c.subscription_plan, '')) = 'crew' and p.role::text = 'OWNER' limit 1;
  select p.id into owner_solo from profiles p join companies c on c.id = p.company_id
   where lower(coalesce(c.subscription_plan, '')) = 'solo' and p.role::text = 'OWNER' limit 1;
  select p.id into owner_blank from profiles p join companies c on c.id = p.company_id
   where coalesce(c.subscription_plan, '') = '' and p.role::text = 'OWNER' limit 1;

  -- a / b: the Pro owner, without and with test data
  perform set_config('request.jwt.claims', json_build_object('sub', owner_pro, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  perm := public.has_permission('SEE_MONEY');
  a := public.business_report(null, null, false);
  b := public.business_report(null, null, true);
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);

  select count(*), count(*) filter (where j.is_test_fixture) into njobs, nfix
    from jsonb_array_elements(coalesce(a->'jobs', '[]')) e join jobs j on j.sync_id::text = e->>'job_sync_id';
  insert into _brp values ('a_owner_pro', perm and (a->>'allowed')::boolean and njobs > 0 and nfix = 0,
    format('see_money=%s allowed=%s jobs=%s fixture_rows=%s', perm, a->>'allowed', njobs, nfix));

  select count(*) filter (where j.is_test_fixture) into nfix
    from jsonb_array_elements(coalesce(b->'jobs', '[]')) e join jobs j on j.sync_id::text = e->>'job_sync_id';
  -- Aging total across buckets: including test jobs can only add money owed,
  -- never take any away, so b must be at least a.
  select coalesce(sum((v->>'owed')::numeric), 0) into a_owed from jsonb_each(coalesce(a->'aging', '{}')) as x(k, v);
  select coalesce(sum((v->>'owed')::numeric), 0) into b_owed from jsonb_each(coalesce(b->'aging', '{}')) as x(k, v);
  insert into _brp values ('b_owner_pro_with_test',
    (b->>'include_test')::boolean and jsonb_array_length(b->'jobs') > jsonb_array_length(a->'jobs') and nfix > 0
      and b_owed >= a_owed,
    format('include_test=%s jobs=%s (vs %s) fixture_rows=%s aging_owed=%s (vs %s)', b->>'include_test',
           jsonb_array_length(b->'jobs'), jsonb_array_length(a->'jobs'), nfix, b_owed, a_owed));

  -- c: a manager asking for test data gains nothing
  if mgr is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', mgr, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    perm := public.has_permission('SEE_MONEY');
    r := public.business_report(null, null, true);
    execute 'reset role';
    perform set_config('request.jwt.claims', '', true);
    insert into _brp values ('c_manager_asks_test',
      perm and (r->>'allowed')::boolean and not (r->>'include_test')::boolean
        and jsonb_array_length(r->'jobs') = jsonb_array_length(a->'jobs'),
      format('see_money=%s include_test=%s jobs=%s', perm, r->>'include_test', jsonb_array_length(r->'jobs')));
  else
    insert into _brp values ('c_manager_asks_test', null, 'no manager in that company -- not proven');
  end if;

  -- d: crew has no SEE_MONEY and is refused
  if crew is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', crew, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    perm := public.has_permission('SEE_MONEY');
    r := public.business_report(null, null, true);
    execute 'reset role';
    perform set_config('request.jwt.claims', '', true);
    insert into _brp values ('d_crew', not perm and r->>'reason' = 'see_money' and not (r->>'allowed')::boolean,
      format('see_money=%s reply=%s', perm, r::text));
  else
    insert into _brp values ('d_crew', null, 'no crew profile -- not proven');
  end if;

  -- e / f: owners (who DO have SEE_MONEY) on plans without advanced reports
  foreach r in array array[
      jsonb_build_object('who', 'e_owner_crew_plan', 'uid', owner_crew),
      jsonb_build_object('who', 'f_owner_solo_plan', 'uid', owner_solo)] loop
    if r->>'uid' is null then
      insert into _brp values (r->>'who', null, 'no such owner -- not proven');
      continue;
    end if;
    perform set_config('request.jwt.claims', json_build_object('sub', r->>'uid', 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    perm := public.has_permission('SEE_MONEY');
    a_profit := null;
    b := public.business_report(null, null, false);
    execute 'reset role';
    perform set_config('request.jwt.claims', '', true);
    insert into _brp values (r->>'who', perm and b->>'reason' = 'plan',
      format('see_money=%s reply=%s', perm, b::text));
  end loop;

  -- g: blank plan keeps full access
  if owner_blank is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', owner_blank, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    r := public.business_report(null, null, false);
    execute 'reset role';
    perform set_config('request.jwt.claims', '', true);
    insert into _brp values ('g_owner_blank_plan', (r->>'allowed')::boolean,
      format('allowed=%s plan=%s', r->>'allowed', r->>'plan'));
  else
    insert into _brp values ('g_owner_blank_plan', null, 'no blank-plan owner -- not proven');
  end if;

  -- h: anon cannot execute it at all
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  execute 'set local role anon';
  begin
    r := public.business_report(null, null, false);
    execute 'reset role';
    insert into _brp values ('h_anon', false, 'EXECUTED: ' || left(r::text, 120));
  exception when insufficient_privilege then
    execute 'reset role';
    insert into _brp values ('h_anon', true, 'permission denied, as intended');
  end;
  perform set_config('request.jwt.claims', '', true);

  -- i: its profit is job_costing()'s profit over the same (non-fixture) jobs
  perform set_config('request.jwt.claims', json_build_object('sub', owner_pro, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select coalesce(sum(c.projected_profit), 0) into jc_profit
    from public.job_costing(null, null) c
    join jobs j on j.sync_id::text = c.job_sync_id
   where not coalesce(j.is_test_fixture, false);
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  select coalesce(sum((e->>'projected_profit')::numeric), 0) into a_profit
    from jsonb_array_elements(coalesce(a->'jobs', '[]')) e;
  insert into _brp values ('i_profit_matches', a_profit = jc_profit,
    format('business_report=%s job_costing=%s', a_profit, jc_profit));

  -- j: unrated + per-foot hours are exactly the approved, zero-rate hours on
  -- the same jobs, recomputed straight from time_entries -- and there must be
  -- some, or the equality proves nothing.
  select coalesce(sum(greatest(0, extract(epoch from (t.ended_at - t.started_at)) / 3600.0)), 0) into jc_profit
    from time_entries t join jobs j on j.sync_id = t.job_sync_id
   where j.company_id = pro_co and j.deleted_at is null and not coalesce(j.is_test_fixture, false)
     and t.company_id = pro_co and t.deleted_at is null and t.ended_at is not null
     and t.approved_at is not null and coalesce(t.hourly_rate, 0) = 0;
  select coalesce(sum((e->>'unrated_hours')::numeric + (e->>'per_foot_hours')::numeric), 0) into a_profit
    from jsonb_array_elements(coalesce(a->'jobs', '[]')) e;
  insert into _brp values ('j_unrated_split', jc_profit > 0 and abs(a_profit - jc_profit) < 0.05,
    format('unrated+per_foot=%s independent=%s', a_profit, round(jc_profit, 2)));

  -- k: the report and the two RPCs it composes are for signed-in callers only.
  -- A leading "=" in an acl entry is PUBLIC.
  select count(*) into njobs from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('business_report', 'job_costing', 'ar_aging');
  select count(*) into nfix from pg_proc p, unnest(p.proacl::text[]) as g(entry)
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('business_report', 'job_costing', 'ar_aging')
     and (g.entry like '=%' or g.entry like 'anon=%');
  insert into _brp values ('k_rpcs_signed_in_only', njobs = 3 and nfix = 0,
    format('functions=%s public_or_anon_grants=%s', njobs, nfix));
end
$probe$;

select persona, ok, detail from _brp order by persona;

rollback;
