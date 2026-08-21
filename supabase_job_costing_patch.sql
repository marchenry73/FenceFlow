-- What a job actually made.
--
-- Every piece of this already existed and nothing put them together, so the
-- honest answer to "did that job make money" was a spreadsheet nobody built.
-- Computed here rather than in the app or the website because both need it and
-- two implementations of one figure is how the phone and the office came to
-- disagree about everything else.
--
-- Labour counts APPROVED hours only. Unapproved hours are a claim, not a cost,
-- and counting them makes a job look worse than it is until somebody signs
-- them off -- which is exactly when an owner would be looking.
create or replace function public.job_costing(from_date timestamptz default null,
                                              to_date   timestamptz default null)
returns table (
    job_sync_id     text,
    customer_name   text,
    status          text,
    collected       numeric,
    material_cost   numeric,
    labour_cost     numeric,
    other_cost      numeric,
    total_cost      numeric,
    profit          numeric,
    margin_percent  numeric,
    hours_worked    numeric,
    unapproved_hours numeric
)
language sql stable security definer set search_path = public as $$
    with scope as (
        select j.sync_id, j.customer_name, j.status::text, j.company_id
        from jobs j
        where j.company_id = current_company_id()
          and j.deleted_at is null
          and (from_date is null or j.created_at >= from_date)
          and (to_date   is null or j.created_at <= to_date)
    ),
    money as (
        -- Net by construction: a refund is a negative row in the ledger.
        select p.job_sync_id, sum(p.amount) as collected
        from payment_records p
        where p.company_id = current_company_id() and p.deleted_at is null
        group by p.job_sync_id
    ),
    materials as (
        select i.job_sync_id,
               -- What it cost YOU where a supplier price is recorded, not what
               -- the customer was charged. Falling back to the quoted price
               -- makes every job look like it cost exactly what it sold for.
               sum(i.quantity * coalesce(i.supplier_unit_price, i.unit_price)) as cost
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
    other as (
        select e.job_sync_id, sum(e.amount) as cost
        from expenses e
        where e.company_id = current_company_id() and e.deleted_at is null
        group by e.job_sync_id
    )
    select s.sync_id, s.customer_name, s.status,
           round((coalesce(m.collected, 0))::numeric, 2),
           round((coalesce(mat.cost, 0))::numeric, 2),
           round((coalesce(l.cost, 0))::numeric, 2),
           round((coalesce(o.cost, 0))::numeric, 2),
           round((coalesce(mat.cost,0) + coalesce(l.cost,0) + coalesce(o.cost,0))::numeric, 2),
           round((coalesce(m.collected,0) - coalesce(mat.cost,0) - coalesce(l.cost,0) - coalesce(o.cost,0))::numeric, 2),
           case when coalesce(m.collected, 0) > 0
                then round((((coalesce(m.collected,0) - coalesce(mat.cost,0) - coalesce(l.cost,0)
                            - coalesce(o.cost,0)) / m.collected * 100))::numeric, 1)
                else null end,
           round((coalesce(l.hours, 0))::numeric, 2),
           round((coalesce(l.pending_hours, 0))::numeric, 2)
    from scope s
    left join money     m   on m.job_sync_id = s.sync_id
    left join materials mat on mat.job_sync_id = s.sync_id
    left join labour    l   on l.job_sync_id = s.sync_id
    left join other     o   on o.job_sync_id = s.sync_id
    order by (coalesce(m.collected,0) - coalesce(mat.cost,0) - coalesce(l.cost,0) - coalesce(o.cost,0)) asc;
$$;

select 'job costing installed' as done;
