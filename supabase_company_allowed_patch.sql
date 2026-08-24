-- One definition of "is this company entitled", usable by anything.
--
-- The gate lived only inside my_service_status(), which reads auth.uid() and
-- so can only answer for the caller. Edge functions run as the service role
-- with no auth.uid() at all, so create-payment-link could not ask and simply
-- did not -- a suspended company could still raise card payment links, and
-- because the function runs as service_role, RLS could not stop it either.
create or replace function public.company_allowed(cid uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
    select (not c.suspended)
       and c.subscription_status is distinct from 'canceled'
       and (
            c.subscription_status in ('active', 'trialing')
            or (c.trial_ends_at is not null and c.trial_ends_at > now())
            or (c.subscription_status = 'past_due'
                and coalesce(c.grace_ends_at, now() + interval '2 days') > now())
       )
    from companies c
    where c.id = cid;
$$;
grant execute on function public.company_allowed(uuid) to authenticated, service_role;

-- my_service_status now defers to it, so the two can never drift apart.
create or replace function public.my_service_status()
returns table(allowed boolean, subscription_status text, subscription_plan text,
              reason text, grace_ends_at timestamptz, trial_days_left int)
language sql security definer set search_path to 'public'
as $$
    select
        coalesce(public.company_allowed(c.id), false) as allowed,
        c.subscription_status::text,
        coalesce(c.subscription_plan, '') as subscription_plan,
        case
            when c.suspended then 'Your FenceFlow account has been suspended. Please get in touch.'
            when c.subscription_status = 'past_due' then 'Your payment did not go through. Please update your card.'
            when c.subscription_status = 'canceled' then 'Your subscription has ended.'
            when c.trial_ends_at is not null and c.trial_ends_at <= now()
                then 'Your trial has ended. Get in touch to keep going.'
            else 'This company does not have access to FenceFlow yet.'
        end as reason,
        c.grace_ends_at,
        case
            when c.subscription_status = 'trialing'
                 and c.trial_ends_at is not null and c.trial_ends_at > now()
            then ceil(extract(epoch from c.trial_ends_at - now()) / 86400.0)::int
        end as trial_days_left
    from companies c
    where c.id = (select company_id from profiles where id = auth.uid());
$$;
grant execute on function public.my_service_status() to authenticated;

select public.company_allowed(
    (select company_id from public.profiles where id = '7bf38947-24cf-4e79-9af0-6100d04b166b')
) as owner_company_allowed;
