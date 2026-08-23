-- Three server-side holes the overnight sweep confirmed.

-- 1. A company owner could make themselves platform admin through the REST
--    API: the profiles UPDATE policy checks company and role, not columns.
--    Platform admin unlocks every company's data and the admin RPCs, so the
--    column is locked to people who already hold it.
create or replace function public.protect_platform_admin_flag()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    if new.is_platform_admin is distinct from old.is_platform_admin then
        -- Service-role writes carry no user; they are the backend's own.
        if auth.uid() is not null and not is_platform_admin() then
            raise exception 'is_platform_admin can only be changed by a platform admin';
        end if;
    end if;
    return new;
end $$;
drop trigger if exists protect_platform_admin on public.profiles;
create trigger protect_platform_admin before update on public.profiles
    for each row execute function protect_platform_admin_flag();

-- 2. "Crew cannot delete" was app-only. The app deletes by setting
--    deleted_at, which is an UPDATE every member's RLS allows -- so a crew
--    phone speaking to the API directly could tombstone anything. Enforced
--    here: setting deleted_at needs the DELETE_RECORDS permission.
create or replace function public.enforce_delete_permission()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    if new.deleted_at is not null and old.deleted_at is null then
        if auth.uid() is not null and not has_permission('DELETE_RECORDS') then
            raise exception 'Deleting needs the delete permission';
        end if;
    end if;
    return new;
end $$;
do $$
declare t text;
begin
  foreach t in array array[
    'jobs','fence_runs','estimate_line_items','change_orders','job_steps',
    'site_markers','expenses','punch_list_items','time_entries',
    'payment_records','employees','material_items','pricing_tiers','field_changes'
  ] loop
    execute format('drop trigger if exists enforce_delete_permission on public.%I', t);
    execute format('create trigger enforce_delete_permission before update on public.%I
                    for each row execute function enforce_delete_permission()', t);
  end loop;
end $$;

-- 3. AR aging aged completed jobs from updated_at, which every sync rewrites,
--    so the debt fell back into "current" whenever the row was touched.
--    The clock now only uses dates that mean something.
drop function if exists public.ar_aging();
create function public.ar_aging()
returns table (
    job_sync_id text, customer_name text, phone text, email text, status text,
    contract_total numeric, paid numeric, owed numeric,
    since timestamptz, days_out int, bucket text
)
language sql stable security definer set search_path = public as $$
    with jobs_in_scope as (
        select j.* from jobs j
        where j.company_id = current_company_id() and j.deleted_at is null
          and j.status in ('ACCEPTED','COMPLETED')
    ),
    materials as (
        select i.job_sync_id, sum(i.quantity * i.unit_price) as total
        from estimate_line_items i
        where i.company_id = current_company_id() and i.deleted_at is null
        group by i.job_sync_id
    ),
    extras as (
        select c.job_sync_id, sum(c.additional_cost) as total from change_orders c
        where c.company_id = current_company_id() and c.deleted_at is null
        group by c.job_sync_id
    ),
    money as (
        select p.job_sync_id, sum(p.amount) as paid from payment_records p
        where p.company_id = current_company_id() and p.deleted_at is null
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
$$;

-- 4. The Manage dialog edits billing email and grace but the listing never
--    carried them, so opening it showed blanks that a save wrote back.
drop function if exists public.admin_companies();
create function public.admin_companies()
returns table(id uuid, name text, email text, subscription_status text,
              subscription_plan text, monthly_price numeric, suspended boolean,
              trial_ends_at timestamptz, days_left integer, allowed boolean,
              people bigint, jobs bigint, last_active timestamptz, admin_notes text,
              billing_email text, grace_ends_at timestamptz)
language sql security definer set search_path = public as $$
    select c.id, c.name, c.email, c.subscription_status::text, c.subscription_plan::text,
           c.monthly_price, c.suspended, c.trial_ends_at,
           case when c.trial_ends_at is null then null
                else greatest(0, extract(day from c.trial_ends_at - now())::int) end,
           (not c.suspended) and (
               c.subscription_status = 'active'
               or (c.trial_ends_at is not null and c.trial_ends_at > now())
               or (c.subscription_status = 'past_due'
                   and coalesce(c.grace_ends_at, now() + interval '2 days') > now())
           ),
           (select count(*) from profiles p where p.company_id = c.id),
           (select count(*) from jobs j where j.company_id = c.id and j.deleted_at is null),
           (select max(j.updated_at) from jobs j where j.company_id = c.id),
           c.admin_notes, c.billing_email, c.grace_ends_at
    from companies c
    where is_platform_admin()
    order by c.name;
$$;

select 'sweep hardening installed' as done;
