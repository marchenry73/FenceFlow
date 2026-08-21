-- Creating a company and switching it on are two separate acts.
--
-- The previous patch defaulted a new company to a 14-day trial starting at
-- creation, which starts the clock while you are still setting them up and
-- getting them on the phone. A company now exists in a "pending" state until
-- somebody deliberately starts it.
alter table public.companies
  alter column trial_ends_at drop default,
  alter column subscription_status set default 'pending';

-- ---------------------------------------------------------------------------
-- Admin controls.
--
-- Every one is SECURITY DEFINER and checks is_platform_admin() as its first
-- act. Without that check a definer function is a hole straight through RLS --
-- any signed-in user could switch on their own company. The check is the whole
-- reason these are safe.
-- ---------------------------------------------------------------------------

/** Starts the 14-day trial from now. Called when the customer is ready. */
create or replace function public.admin_start_trial(target uuid, days int default 14)
returns void language plpgsql security definer set search_path = public as $$
begin
    if not is_platform_admin() then
        raise exception 'Only a FenceFlow admin may change company access.';
    end if;
    update companies
    set subscription_status = 'trialing',
        trial_ends_at = now() + make_interval(days => days),
        suspended = false
    where id = target;
end;
$$;

/** Open-ended access. For paying customers, and for the owner's own company. */
create or replace function public.admin_grant_access(target uuid, note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
    if not is_platform_admin() then
        raise exception 'Only a FenceFlow admin may change company access.';
    end if;
    update companies
    set subscription_status = 'active',
        suspended = false,
        admin_notes = coalesce(note, admin_notes)
    where id = target;
end;
$$;

/**
 * Turns a company off.
 *
 * Their records are untouched and still theirs -- this is a billing state, not
 * a reason to destroy somebody's books. Everything returns the moment it is
 * switched back on.
 */
create or replace function public.admin_suspend(target uuid, note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
    if not is_platform_admin() then
        raise exception 'Only a FenceFlow admin may change company access.';
    end if;
    update companies
    set suspended = true,
        admin_notes = coalesce(note, admin_notes)
    where id = target;
end;
$$;

/** Adds days to a trial already running, or restarts one that has lapsed. */
create or replace function public.admin_extend_trial(target uuid, days int default 14)
returns void language plpgsql security definer set search_path = public as $$
begin
    if not is_platform_admin() then
        raise exception 'Only a FenceFlow admin may change company access.';
    end if;
    update companies
    set subscription_status = 'trialing',
        suspended = false,
        trial_ends_at = greatest(coalesce(trial_ends_at, now()), now()) + make_interval(days => days)
    where id = target;
end;
$$;

/**
 * Every company with what an admin needs to decide about it.
 *
 * A plain select would be blocked by RLS -- companies are scoped to your own --
 * so this is the deliberate exception, and it checks admin first.
 */
create or replace function public.admin_companies()
returns table (
    id uuid,
    name text,
    email text,
    subscription_status text,
    suspended boolean,
    trial_ends_at timestamptz,
    days_left int,
    allowed boolean,
    people bigint,
    jobs bigint,
    last_active timestamptz,
    admin_notes text
)
language sql security definer set search_path = public as $$
    select c.id, c.name, c.email, c.subscription_status::text, c.suspended, c.trial_ends_at,
           case when c.trial_ends_at is null then null
                else greatest(0, extract(day from c.trial_ends_at - now())::int) end as days_left,
           (not c.suspended) and (
               c.subscription_status = 'active'
               or (c.trial_ends_at is not null and c.trial_ends_at > now())
               or (c.subscription_status = 'past_due'
                   and coalesce(c.grace_ends_at, now() + interval '2 days') > now())
           ) as allowed,
           (select count(*) from profiles p where p.company_id = c.id) as people,
           (select count(*) from jobs j where j.company_id = c.id and j.deleted_at is null) as jobs,
           -- The honest activity signal: when they last touched a job.
           (select max(j.updated_at) from jobs j where j.company_id = c.id) as last_active,
           c.admin_notes
    from companies c
    where is_platform_admin()
    order by c.name;
$$;

select 'defaults and admin controls installed' as done;
