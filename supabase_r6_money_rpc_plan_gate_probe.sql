-- supabase_r6_money_rpc_plan_gate_probe.sql -- read-only proof for
-- supabase_r6_money_rpc_plan_gate.sql. Run AFTER it. One transaction, rolled
-- back; nothing is written.
--
-- Personas by PROPERTY, each re-asserted from inside the impersonated session.
-- The refusals carry positive controls: the Solo/Crew owner must still HAVE
-- SEE_MONEY and a money scope (so it is the plan refusing, not a missing
-- permission), and their company must have jobs job_costing() would otherwise
-- list (so "0 rows" is not just an empty company).
--
-- Expected (ok true on every row; null = no data to prove it with -- on
-- 2026-09-21 no Crew-plan company had a job, so d_crew_owner read null):
--   a_pro_owner      job_costing rows > 0 and ar_aging rows > 0
--   b_blank_owner    advanced_reports_company_id() is the company (full access)
--   c_solo_owner     SEE_MONEY and money scope present; company has jobs; both RPCs return 0 rows
--   d_crew_owner     same as c, on the Crew plan
--   e_crew_role      no SEE_MONEY: 0 rows, as before the gate
begin;

create temp table _gp(persona text, ok boolean, detail text) on commit drop;
grant all on _gp to authenticated;

do $probe$
declare
  pro_owner uuid; blank_owner uuid; solo_owner uuid; crew_owner uuid; crew_role uuid;
  who text; uid uuid; co uuid;
  perm boolean; scope uuid; adv uuid; njc int; nag int; ncompany int;
begin
  select p.id into pro_owner from profiles p join companies c on c.id = p.company_id
   where lower(coalesce(c.subscription_plan, '')) = 'pro' and p.role::text = 'OWNER'
     and exists (select 1 from jobs j where j.company_id = c.id and j.deleted_at is null
                   and j.status in ('ACCEPTED', 'COMPLETED'))
   limit 1;
  select p.id into blank_owner from profiles p join companies c on c.id = p.company_id
   where coalesce(c.subscription_plan, '') = '' and p.role::text = 'OWNER' limit 1;
  -- the Solo / Crew owner whose company has the most jobs, so the refusal has teeth
  select p.id into solo_owner from profiles p join companies c on c.id = p.company_id
   where lower(coalesce(c.subscription_plan, '')) = 'solo' and p.role::text = 'OWNER'
   order by (select count(*) from jobs j where j.company_id = c.id and j.deleted_at is null) desc limit 1;
  select p.id into crew_owner from profiles p join companies c on c.id = p.company_id
   where lower(coalesce(c.subscription_plan, '')) = 'crew' and p.role::text = 'OWNER'
   order by (select count(*) from jobs j where j.company_id = c.id and j.deleted_at is null) desc limit 1;
  select p.id into crew_role from profiles p where p.role::text = 'CREW' and p.company_id is not null limit 1;

  foreach who in array array['a_pro_owner', 'b_blank_owner', 'c_solo_owner', 'd_crew_owner', 'e_crew_role'] loop
    uid := case who when 'a_pro_owner' then pro_owner when 'b_blank_owner' then blank_owner
                    when 'c_solo_owner' then solo_owner when 'd_crew_owner' then crew_owner
                    else crew_role end;
    if uid is null then
      insert into _gp values (who, null, 'no such profile -- not proven');
      continue;
    end if;
    select p.company_id into co from profiles p where p.id = uid;
    select count(*) into ncompany from jobs j where j.company_id = co and j.deleted_at is null;

    perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    perm  := public.has_permission('SEE_MONEY');
    scope := public.money_scope_company_id();
    adv   := public.advanced_reports_company_id();
    select count(*) into njc from public.job_costing(null, null);
    select count(*) into nag from public.ar_aging();
    execute 'reset role';
    perform set_config('request.jwt.claims', '', true);

    insert into _gp values (who,
      case who
        when 'a_pro_owner'   then adv = co and njc > 0 and nag > 0
        when 'b_blank_owner' then adv = co
        when 'e_crew_role'   then not perm and adv is null and njc = 0 and nag = 0
        -- a Solo/Crew company with no jobs cannot show a refusal: 0 rows is
        -- what it would get anyway. Unproven (null), not passed.
        else case when ncompany = 0 and perm and scope = co and adv is null then null
                  else perm and scope = co and adv is null and ncompany > 0 and njc = 0 and nag = 0 end
      end,
      format('see_money=%s money_scope=%s advanced_scope=%s company_jobs=%s job_costing_rows=%s ar_aging_rows=%s',
             perm, scope is not null, adv is not null, ncompany, njc, nag));
  end loop;
end
$probe$;

select persona, ok, detail from _gp order by persona;

rollback;
