-- The service gate now also answers WHICH plan, so both clients can shape
-- themselves to what was bought without a second round trip.
drop function if exists public.my_service_status();
create function public.my_service_status()
returns table(allowed boolean, subscription_status text, subscription_plan text,
              reason text, grace_ends_at timestamptz, trial_days_left int)
language sql security definer set search_path to 'public'
as $$
    select
        (not c.suspended) and (
            c.subscription_status in ('active', 'trialing')
            or (c.trial_ends_at is not null and c.trial_ends_at > now())
            or (c.subscription_status = 'past_due'
                and coalesce(c.grace_ends_at, now() + interval '2 days') > now())
        ) as allowed,
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
select 'plan in gate' as done;
