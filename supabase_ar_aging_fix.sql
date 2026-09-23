-- !! SUPERSEDED -- DO NOT RUN THIS FILE AGAINST PRODUCTION !!
-- The live body of this function has moved on several times since. Running
-- this file would silently undo, at least: the plan gate and
-- money_scope_company_id() (supabase_r6_money_rpc_plan_gate.sql), the
-- quoted_material column (supabase_job_costing_material_budget.sql), and the
-- accepted price (supabase_r7_reports_accepted_price.sql). None of those
-- failures would raise an error -- the reports would just quietly start
-- answering with the wrong figure to the wrong people.
-- The current body is supabase_r7_reports_accepted_price.sql. Take any new
-- edit from pg_get_functiondef() on the live database, never from here.
-- Kept only for the history of why the function looks the way it does.
--
-- Read the app's contract total instead of inventing one.
--
-- See supabase_contract_total_patch.sql. The materials sum stays only as a
-- fallback for rows written before the app started sending the real figure --
-- otherwise every un-synced job would read as $0 owed, which is worse than
-- reading low.
create or replace function public.ar_aging()
returns table (
    job_sync_id   text,
    customer_name text,
    phone         text,
    email         text,
    status        text,
    contract_total numeric,
    paid          numeric,
    owed          numeric,
    since         timestamptz,
    days_out      int,
    bucket        text
)
language sql stable security definer set search_path = public as $$
    with jobs_in_scope as (
        select j.*
        from jobs j
        where j.company_id = current_company_id()
          and j.deleted_at is null
          and j.status in ('ACCEPTED','COMPLETED')
    ),
    materials as (
        select i.job_sync_id, sum(i.quantity * i.unit_price) as total
        from estimate_line_items i
        where i.company_id = current_company_id() and i.deleted_at is null
        group by i.job_sync_id
    ),
    extras as (
        select c.job_sync_id, sum(c.additional_cost) as total
        from change_orders c
        where c.company_id = current_company_id() and c.deleted_at is null
        group by c.job_sync_id
    ),
    money as (
        select p.job_sync_id, sum(p.amount) as paid
        from payment_records p
        where p.company_id = current_company_id() and p.deleted_at is null
        group by p.job_sync_id
    ),
    figured as (
        select j.sync_id, j.customer_name, j.phone, j.email, j.status::text,
               coalesce(
                   j.contract_total,
                   coalesce(m.total, 0) + coalesce(x.total, 0)
               ) as contract_total,
               coalesce(mo.paid, 0) as paid,
               coalesce(
                   j.contract_total,
                   coalesce(m.total, 0) + coalesce(x.total, 0)
               ) - coalesce(mo.paid, 0) as owed,
               coalesce(
                   case when j.status = 'COMPLETED' then coalesce(j.final_sign_off_at, j.updated_at) end,
                   j.scheduled_date,
                   j.created_at
               ) as since
        from jobs_in_scope j
        left join materials m  on m.job_sync_id  = j.sync_id
        left join extras    x  on x.job_sync_id  = j.sync_id
        left join money     mo on mo.job_sync_id = j.sync_id
    )
    select f.sync_id, f.customer_name, f.phone, f.email, f.status,
           round(f.contract_total::numeric, 2),
           round(f.paid::numeric, 2),
           round(f.owed::numeric, 2),
           f.since,
           greatest(0, extract(day from now() - f.since)::int),
           case
               when extract(day from now() - f.since) >= 90 then '90'
               when extract(day from now() - f.since) >= 60 then '60'
               when extract(day from now() - f.since) >= 30 then '30'
               else 'current'
           end
    from figured f
    where f.owed > 0.005
    order by f.since asc;
$$;

select 'ar_aging now reads contract_total' as done;
