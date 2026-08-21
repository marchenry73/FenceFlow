-- Who owes you, and how long they have owed it.
--
-- Every contractor has money sitting out there they have lost track of. The
-- inputs all exist -- contract totals, the payments ledger, job status -- and
-- nothing put them in one place ordered by how overdue they are.
--
-- The clock starts at the job's completion where it is completed, otherwise at
-- its scheduled date. "How long since they were invoiced" would be better, but
-- an invoice date is not tracked as its own event yet; the honest approximation
-- beats a fabricated one.
--
-- Contract totals come from the line items plus signed change orders, the same
-- inputs the app prices from. Computed here so the office page and the phone
-- read one figure -- two implementations of one number is how those two came
-- to disagree about everything else.
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
        select o.job_sync_id, sum(o.additional_cost) as total
        from change_orders o
        where o.company_id = current_company_id() and o.deleted_at is null
          and o.signed_at is not null
        group by o.job_sync_id
    ),
    money as (
        select p.job_sync_id, sum(p.amount) as paid
        from payment_records p
        where p.company_id = current_company_id() and p.deleted_at is null
        group by p.job_sync_id
    ),
    figured as (
        select j.sync_id, j.customer_name, j.phone, j.email, j.status::text,
               coalesce(m.total, 0) + coalesce(x.total, 0) as contract_total,
               coalesce(mo.paid, 0) as paid,
               coalesce(m.total, 0) + coalesce(x.total, 0) - coalesce(mo.paid, 0) as owed,
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
           greatest(0, extract(day from now() - f.since))::int,
           case
               when extract(day from now() - f.since) < 30 then 'current'
               when extract(day from now() - f.since) < 60 then '30'
               when extract(day from now() - f.since) < 90 then '60'
               else '90'
           end
    from figured f
    -- Only real balances. A settled job in an aging report is noise, and a
    -- negative one is a refund conversation rather than a collection one.
    where f.owed > 0.005
    order by f.owed desc;
$$;

select 'ar aging installed' as done;
