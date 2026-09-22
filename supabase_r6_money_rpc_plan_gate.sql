-- supabase_r6_money_rpc_plan_gate.sql
--
-- NOT APPLIED, AND NOT PART OF supabase_r6_business_report.sql ON PURPOSE.
-- It changes who gets rows from two live RPCs, so it is its own decision.
--
-- THE HOLE (confirmed live 2026-09-21, read-only): job_costing() and ar_aging()
-- are SECURITY DEFINER, scoped by money_scope_company_id() -- i.e. by
-- has_permission('SEE_MONEY') -- and executable by every signed-in user, but
-- neither looks at the plan. has_permission() answers true for an OWNER on
-- every permission, so the owner of a Solo or Crew company can run
--     await db.rpc('job_costing', {})   /   await db.rpc('ar_aging')
-- from the console and read Pro's per-job profit, margins and aging. The page
-- only avoids it by not asking (loadAll fetches both only when
-- hasAdvancedReports()); business_report() refuses those plans itself.
--
-- THE FIX: one helper, advanced_reports_company_id(), which is
-- money_scope_company_id() when the company's plan is not solo/crew (blank =
-- hand-granted full access, as hasAdvancedReports() treats it) and null
-- otherwise. Both RPCs below are their LIVE definitions, read with
-- pg_get_functiondef() on 2026-09-21, plus ONE line in the CTE that drives each
-- result (job_costing: scope, ar_aging: jobs_in_scope):
--     and public.advanced_reports_company_id() is not null
-- Every other CTE only joins onto that one, so an empty driver is an empty
-- answer. Nothing else differs: same signatures, same OUT columns, and every
-- money_scope_company_id() call is kept -- so the "job_costing_still_guarded"
-- checks in tests/company-golden-path.test.mjs (~871) and
-- tests/company-crew-golden-path.test.mjs (~1155), which look for that name in
-- prosrc, stay true. create or replace, so existing grants are kept, and
-- business_report(), which composes both, is unaffected (it refuses solo/crew
-- before calling them).
--
-- BEFORE APPLYING, change this live test, or it goes red for the right reason:
--   tests/company-golden-path.test.mjs (~line 410 and 419) reads job_costing()
--   as OWNER_NEW, the owner of ZZ_NEW -- a SOLO company -- to prove a priced
--   total reaches the office report. With the gate that read is empty. Point it
--   at a Pro fixture (ZZ_BUSY) or read jobs.contract_total directly.
-- Other live callers checked: tests/downstream-job-costing and
-- tests/live-rules-guard use aba5b097 (pro); company-crew-golden-path uses
-- ZZ_BUSY (pro). No edge function and no Android code calls either RPC.
--
-- CAUTION for later edits: supabase_job_costing_material_budget.sql drops and
-- re-creates job_costing() from its own copy of the body. Re-running it would
-- silently remove this gate AND reset the ACL to PUBLIC. Prefer create or
-- replace, and carry advanced_reports_company_id() into any new copy.

create or replace function public.advanced_reports_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $fn$
    select c.id
      from companies c
     where c.id = public.money_scope_company_id()
       and lower(coalesce(c.subscription_plan, '')) not in ('solo', 'crew');
$fn$;

comment on function public.advanced_reports_company_id() is
  'money_scope_company_id() when the plan includes advanced reports (not solo/crew; blank = full), else null. '
  'Scopes job_costing() and ar_aging(). See supabase_r6_money_rpc_plan_gate.sql.';

revoke all on function public.advanced_reports_company_id() from public, anon;
grant execute on function public.advanced_reports_company_id() to authenticated;

CREATE OR REPLACE FUNCTION public.job_costing(from_date timestamp with time zone DEFAULT NULL::timestamp with time zone, to_date timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(job_sync_id text, customer_name text, status text, quoted numeric, collected numeric, material_cost numeric, labour_cost numeric, other_cost numeric, total_cost numeric, projected_profit numeric, margin_percent numeric, cash_position numeric, costs_are_sell_prices boolean, hours_worked numeric, unapproved_hours numeric, quoted_material numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    with scope as (
        select j.sync_id, j.customer_name, j.status::text, j.contract_total
        from jobs j
        where j.company_id = money_scope_company_id()
          and public.advanced_reports_company_id() is not null   -- the plan gate (supabase_r6_money_rpc_plan_gate.sql)
          and j.deleted_at is null
          and (from_date is null or j.created_at >= from_date)
          and (to_date   is null or j.created_at <= to_date)
    ),
    money as (
        select p.job_sync_id, sum(p.amount) as collected
        from payment_records p
        where p.company_id = money_scope_company_id() and p.deleted_at is null
        group by p.job_sync_id
    ),
    materials as (
        select i.job_sync_id,
               sum(i.quantity * coalesce(i.supplier_unit_price, i.unit_price)) as cost,
               sum(i.quantity * i.unit_price) as sell,
               -- Flagged so the page can say "these costs are your sell
               -- prices" instead of quietly showing a margin of zero-ish.
               bool_and(i.supplier_unit_price is null) as all_fallback
        from estimate_line_items i
        where i.company_id = money_scope_company_id() and i.deleted_at is null
        group by i.job_sync_id
    ),
    labour as (
        select t.job_sync_id,
               sum(case when t.approved_at is not null
                        then extract(epoch from (t.ended_at - t.started_at)) / 3600.0 * t.hourly_rate
                        else 0 end) as cost,
               sum(case when t.approved_at is not null
                        then extract(epoch from (t.ended_at - t.started_at)) / 3600.0
                        else 0 end) as hours,
               sum(case when t.approved_at is null and t.ended_at is not null
                        then extract(epoch from (t.ended_at - t.started_at)) / 3600.0
                        else 0 end) as pending_hours
        from time_entries t
        where t.company_id = money_scope_company_id() and t.deleted_at is null
          and t.ended_at is not null
        group by t.job_sync_id
    ),
    extras as (
        select c.job_sync_id, sum(c.additional_cost) as total
        from change_orders c
        where c.company_id = money_scope_company_id() and c.deleted_at is null
        group by c.job_sync_id
    ),
    other as (
        select e.job_sync_id, sum(e.amount) as cost
        from expenses e
        where e.company_id = money_scope_company_id() and e.deleted_at is null
        group by e.job_sync_id
    ),
    figured as (
        select s.sync_id, s.customer_name, s.status,
               coalesce(s.contract_total,
                        coalesce(m.sell, 0) + coalesce(x.total, 0)) as quoted,
               coalesce(mo.collected, 0) as collected,
               coalesce(m.cost, 0)  as material_cost,
               coalesce(l.cost, 0)  as labour_cost,
               coalesce(o.cost, 0)  as other_cost,
               coalesce(m.all_fallback, false) as all_fallback,
               coalesce(l.hours, 0) as hours,
               coalesce(l.pending_hours, 0) as pending,
               coalesce(m.sell, 0) as quoted_material
        from scope s
        left join money     mo on mo.job_sync_id = s.sync_id
        left join materials m  on m.job_sync_id  = s.sync_id
        left join labour    l  on l.job_sync_id  = s.sync_id
        left join extras    x  on x.job_sync_id  = s.sync_id
        left join other     o  on o.job_sync_id  = s.sync_id
    )
    select f.sync_id, f.customer_name, f.status,
           round(f.quoted::numeric, 2),
           round(f.collected::numeric, 2),
           round(f.material_cost::numeric, 2),
           round(f.labour_cost::numeric, 2),
           round(f.other_cost::numeric, 2),
           round((f.material_cost + f.labour_cost + f.other_cost)::numeric, 2),
           round((f.quoted - f.material_cost - f.labour_cost - f.other_cost)::numeric, 2),
           case when f.quoted > 0
                then round(((f.quoted - f.material_cost - f.labour_cost - f.other_cost)
                            / f.quoted * 100)::numeric, 1) end,
           round((f.collected - f.material_cost - f.labour_cost - f.other_cost)::numeric, 2),
           f.all_fallback,
           round(f.hours::numeric, 2),
           round(f.pending::numeric, 2),
           round(f.quoted_material::numeric, 2)
    from figured f
    order by f.quoted desc;
$function$;

CREATE OR REPLACE FUNCTION public.ar_aging()
 RETURNS TABLE(job_sync_id text, customer_name text, phone text, email text, status text, contract_total numeric, paid numeric, owed numeric, since timestamp with time zone, days_out integer, bucket text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    with jobs_in_scope as (
        select j.* from jobs j
        where j.company_id = money_scope_company_id() and j.deleted_at is null
          and public.advanced_reports_company_id() is not null   -- the plan gate (supabase_r6_money_rpc_plan_gate.sql)
          and j.status in ('ACCEPTED','COMPLETED')
    ),
    materials as (
        select i.job_sync_id, sum(i.quantity * i.unit_price) as total
        from estimate_line_items i
        where i.company_id = money_scope_company_id() and i.deleted_at is null
        group by i.job_sync_id
    ),
    extras as (
        select c.job_sync_id, sum(c.additional_cost) as total from change_orders c
        where c.company_id = money_scope_company_id() and c.deleted_at is null
        group by c.job_sync_id
    ),
    money as (
        select p.job_sync_id, sum(p.amount) as paid from payment_records p
        where p.company_id = money_scope_company_id() and p.deleted_at is null
        group by p.job_sync_id
    ),
    figured as (
        select j.sync_id, j.customer_name, j.phone, j.email, j.status::text,
               coalesce(j.contract_total, coalesce(m.total,0) + coalesce(x.total,0)) as contract_total,
               coalesce(mo.paid, 0) as paid,
               coalesce(j.contract_total, coalesce(m.total,0) + coalesce(x.total,0)) - coalesce(mo.paid,0) as owed,
               coalesce(j.final_sign_off_at, j.scheduled_date, j.created_at) as since
        from jobs_in_scope j
        left join materials m on m.job_sync_id = j.sync_id
        left join extras x on x.job_sync_id = j.sync_id
        left join money mo on mo.job_sync_id = j.sync_id
    )
    select f.sync_id, f.customer_name, f.phone, f.email, f.status,
           round(f.contract_total::numeric,2), round(f.paid::numeric,2), round(f.owed::numeric,2),
           f.since, greatest(0, extract(day from now() - f.since)::int),
           case when extract(day from now() - f.since) >= 90 then '90'
                when extract(day from now() - f.since) >= 60 then '60'
                when extract(day from now() - f.since) >= 30 then '30'
                else 'current' end
    from figured f
    where f.owed > 0.005
    order by f.since asc;
$function$;

revoke execute on function public.job_costing(timestamptz, timestamptz) from public, anon;
grant  execute on function public.job_costing(timestamptz, timestamptz) to authenticated;
revoke execute on function public.ar_aging() from public, anon;
grant  execute on function public.ar_aging() to authenticated;

-- Prove what landed: both RPCs carry the plan gate AND still the money scope
-- (plan_gated and money_guarded true on all three rows), and no PUBLIC or anon
-- execute anywhere.
select proname,
       (proname = 'advanced_reports_company_id'
        or position('advanced_reports_company_id() is not null' in prosrc) > 0) as plan_gated,
       position('money_scope_company_id' in prosrc) > 0      as money_guarded,
       not exists (select 1 from unnest(proacl::text[]) a
                    where a like '=%' or a like 'anon=%')  as no_anon_or_public
  from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname in ('job_costing', 'ar_aging', 'advanced_reports_company_id')
 order by proname;
