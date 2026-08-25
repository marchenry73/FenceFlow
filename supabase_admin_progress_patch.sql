-- The admin list gains where each company has got to, so a name on the screen
-- says whether they are stuck at "invited" or actually working.
drop function if exists public.admin_companies();
create function public.admin_companies()
returns table(id uuid, name text, email text, subscription_status text,
              subscription_plan text, monthly_price numeric, suspended boolean,
              suspended_reason text, trial_ends_at timestamptz, days_left integer,
              allowed boolean, people bigint, jobs bigint, last_active timestamptz,
              admin_notes text, billing_email text, grace_ends_at timestamptz,
              oldest_app_version text, newest_app_version text, last_seen timestamptz,
              invited_at timestamptz, invited_email text, joined_at timestamptz,
              details_completed_at timestamptz, agreement_signed_at timestamptz,
              agreement_signed_name text)
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
           (select p.app_version_name from profiles p
             where p.company_id = c.id and p.app_version_code is not null
             order by p.app_version_code asc limit 1),
           (select p.app_version_name from profiles p
             where p.company_id = c.id and p.app_version_code is not null
             order by p.app_version_code desc limit 1),
           (select max(p.last_seen_at) from profiles p where p.company_id = c.id),
           c.invited_at, c.invited_email, c.joined_at,
           c.details_completed_at, c.agreement_signed_at, c.agreement_signed_name
    from companies c
    where is_platform_admin()
    order by c.name;
$$;
grant execute on function public.admin_companies() to authenticated;

-- Records that an invitation went out. The email itself is sent by an edge
-- function; this is the part that has to survive.
create or replace function public.admin_mark_invited(target uuid, to_email text)
returns void
language plpgsql security definer set search_path to 'public'
as $$
begin
    if not is_platform_admin() then
        raise exception 'Only a FenceFlow admin may invite a company.';
    end if;
    update companies
       set invited_at = now(),
           invited_email = nullif(trim(coalesce(to_email, '')), ''),
           email = coalesce(nullif(trim(coalesce(to_email, '')), ''), email)
     where id = target;
end;
$$;
grant execute on function public.admin_mark_invited(uuid, text) to authenticated;

select 'admin progress installed' as done;
