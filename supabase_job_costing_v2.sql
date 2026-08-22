-- Job profit that answers the question actually being asked.
--
-- The old figure was collected minus costs, with the quoted price nowhere in
-- it. Three things March saw follow directly: adding teardown moved nothing,
-- because it raises the CONTRACT and the contract was not in the sum; the
-- labour he charges the customer looked "not added", because only what is
-- PAID counted as revenue; and a healthy job read -4.6%, because with no
-- supplier prices recorded the materials fell back to sell price -- a job
-- costed at what it sold for can never look profitable.
--
-- Two figures now, because there are two honest questions:
--   projected_profit  = contract - costs   (what the job will make)
--   cash_position     = collected - costs  (where the money stands today)
-- The contract comes from the app's own engine (jobs.contract_total), with
-- the materials+extras sum only as a fallback for rows from before the app
-- sent it.
drop function if exists public.job_costing(timestamptz, timestamptz);

create function public.job_costing(from_date timestamptz default null,
                                   to_date   timestamptz default null)
returns table (
    job_sync_id      text,
    customer_name    text,
    status           text,
    quoted           numeric,
    collected        numeric,
    material_cost    numeric,
    labour_cost      numeric,
    other_cost       numeric,
    total_cost       numeric,
    projected_profit numeric,
    margin_percent   numeric,
    cash_position    numeric,
    costs_are_sell_prices boolean,
    hours_worked     numeric,
    unapproved_hours numeric
)
language sql stable security definer set search_path = public as $$
    with scope as (
        select j.sync_id, j.customer_name, j.status::text, j.contract_total
        from jobs j
        where j.company_id = current_company_id()
          and j.deleted_at is null
          and (from_date is null or j.created_at >= from_date)
          and (to_date   is null or j.created_at <= to_date)
    ),
    money as (
        select p.job_sync_id, sum(p.amount) as collected
        from payment_records p
        where p.company_id = current_company_id() and p.deleted_at is null
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
        where i.company_id = current_company_id() and i.deleted_at is null
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
        where t.company_id = current_company_id() and t.deleted_at is null
          and t.ended_at is not null
        group by t.job_sync_id
    ),
    extras as (
        select c.job_sync_id, sum(c.additional_cost) as total
        from change_orders c
        where c.company_id = current_company_id() and c.deleted_at is null
        group by c.job_sync_id
    ),
    other as (
        select e.job_sync_id, sum(e.amount) as cost
        from expenses e
        where e.company_id = current_company_id() and e.deleted_at is null
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
$$;

select 'job costing v2 installed' as done;
