-- Which build is each phone actually running?
--
-- Nothing recorded it, so the only way to know was to ask the person holding
-- the phone -- and when an update quietly fails to arrive, that is exactly
-- the fact you need. Crashes carried the version; a phone working normally
-- said nothing at all.
alter table public.profiles
  add column if not exists app_version_code int,
  add column if not exists app_version_name text,
  add column if not exists last_seen_at timestamptz;

-- Through a function on purpose: there is no policy letting somebody update
-- their own profile row (only owners updating their crew), and inventing one
-- would open far more than a version stamp needs.
create or replace function public.record_app_version(code int, name text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
    if auth.uid() is null then return; end if;
    update profiles
       set app_version_code = code,
           app_version_name = name,
           last_seen_at = now()
     where id = auth.uid();
end;
$$;
grant execute on function public.record_app_version(int, text) to authenticated;

-- The admin list carried its own copy of the entitlement rule, written before
-- company_allowed() existed -- so it had already drifted: it still counted a
-- future trial date as access for a cancelled company, and knew nothing about
-- 'trialing'. Two answers to "are they allowed" is one too many.
drop function if exists public.admin_companies();
create function public.admin_companies()
returns table(id uuid, name text, email text, subscription_status text,
              subscription_plan text, monthly_price numeric, suspended boolean,
              suspended_reason text, trial_ends_at timestamptz, days_left integer,
              allowed boolean, people bigint, jobs bigint, last_active timestamptz,
              admin_notes text, billing_email text, grace_ends_at timestamptz,
              oldest_app_version text, newest_app_version text, last_seen timestamptz)
language sql security definer set search_path to 'public'
as $$
    select c.id, c.name, c.email, c.subscription_status::text, c.subscription_plan::text,
           c.monthly_price, c.suspended, c.suspended_reason,
           c.trial_ends_at,
           case when c.trial_ends_at is null then null
                else greatest(0, extract(day from c.trial_ends_at - now())::int) end,
           public.company_allowed(c.id),
           (select count(*) from profiles p where p.company_id = c.id),
           (select count(*) from jobs j where j.company_id = c.id and j.deleted_at is null),
           (select max(j.updated_at) from jobs j where j.company_id = c.id),
           c.admin_notes, c.billing_email, c.grace_ends_at,
           -- Both ends, because one phone left behind on an old build is the
           -- thing worth spotting, and an average would hide it.
           (select p.app_version_name from profiles p
             where p.company_id = c.id and p.app_version_code is not null
             order by p.app_version_code asc limit 1),
           (select p.app_version_name from profiles p
             where p.company_id = c.id and p.app_version_code is not null
             order by p.app_version_code desc limit 1),
           (select max(p.last_seen_at) from profiles p where p.company_id = c.id)
    from companies c
    where is_platform_admin()
    order by c.name;
$$;
grant execute on function public.admin_companies() to authenticated;

select 'version telemetry installed' as done;
