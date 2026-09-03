-- Cost reports stop ignoring the "can see money" permission.
--
-- job_costing and ar_aging are SECURITY DEFINER, which means they run with the
-- privileges of their owner and row level security does not apply to them.
-- They scoped by company and nothing else, so a crew member -- who the database
-- otherwise blocks from payment_records entirely -- could call either directly
-- and read every customer's contract, what they have paid, what they still owe
-- and how many days overdue they are.
--
-- Nobody is affected today: every account on the system is an owner, a manager
-- or sales, and all three may see money. It becomes real the first time a crew
-- member is added, which is a thing that happens on an ordinary Tuesday and
-- would not announce itself.
--
-- The guard is a single helper standing in for current_company_id() inside
-- these two functions. Someone without the permission scopes to no company at
-- all and the report is empty, rather than the query erroring: they went
-- looking for this deliberately, and an empty answer tells them nothing about
-- what they were not allowed to see.

create or replace function public.money_scope_company_id()
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $$
  select case when public.can_see_pay() then public.current_company_id() else null end;
$$;

revoke all on function public.money_scope_company_id() from public;
grant execute on function public.money_scope_company_id() to authenticated;

CREATE OR REPLACE FUNCTION public.ar_aging()
 RETURNS TABLE(job_sync_id text, customer_name text, phone text, email text, status text, contract_total numeric, paid numeric, owed numeric, since timestamp with time zone, days_out integer, bucket text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    with jobs_in_scope as (
        select j.* from jobs j
        where j.company_id = money_scope_company_id() and j.deleted_at is null
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
$function$
;

CREATE OR REPLACE FUNCTION public.job_costing(from_date timestamp with time zone DEFAULT NULL::timestamp with time zone, to_date timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(job_sync_id text, customer_name text, status text, quoted numeric, collected numeric, material_cost numeric, labour_cost numeric, other_cost numeric, total_cost numeric, projected_profit numeric, margin_percent numeric, cash_position numeric, costs_are_sell_prices boolean, hours_worked numeric, unapproved_hours numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    with scope as (
        select j.sync_id, j.customer_name, j.status::text, j.contract_total
        from jobs j
        where j.company_id = money_scope_company_id()
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
               coalesce(l.pending_hours, 0) as pending
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
           round(f.pending::numeric, 2)
    from figured f
    order by f.quoted desc;
$function$
;

-- Prove the swap landed in the bodies that are actually installed.
select proname,
       (position('money_scope_company_id' in prosrc) > 0) as guarded,
       (position('current_company_id' in prosrc) > 0)     as still_unguarded
from pg_proc
where pronamespace='public'::regnamespace and proname in ('job_costing','ar_aging')
order by proname;
