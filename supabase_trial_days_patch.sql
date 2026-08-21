-- The trial tells you it is ending instead of just ending.
--
-- Day 14 was a lock with no warning: the first sign a trial company got was
-- being unable to open the app -- mid-morning, in front of a customer. The
-- status answer now carries how many days remain, so the app can warn at
-- three days and the person has time to decide like a customer rather than
-- react like a lockout.
--
-- Return type changes, so the function is dropped first (Postgres refuses to
-- alter one in place).
drop function if exists public.my_service_status();

create function public.my_service_status()
returns table (
    allowed boolean,
    subscription_status text,
    reason text,
    grace_ends_at timestamptz,
    trial_days_left int
)
language sql
security definer
set search_path = public
as $$
    select
        (not c.suspended) and (
            c.subscription_status = 'active'
            or (c.trial_ends_at is not null and c.trial_ends_at > now())
            or (c.subscription_status = 'past_due'
                and coalesce(c.grace_ends_at, now() + interval '2 days') > now())
        ) as allowed,
        c.subscription_status::text,
        case
            when c.suspended then 'Your FenceFlow account has been suspended. Please get in touch.'
            when c.subscription_status = 'past_due' then 'Your payment did not go through. Please update your card.'
            when c.subscription_status = 'canceled' then 'Your subscription has ended.'
            when c.trial_ends_at is not null and c.trial_ends_at <= now()
                then 'Your trial has ended. Get in touch to keep going.'
            else 'This company does not have access to FenceFlow yet.'
        end as reason,
        c.grace_ends_at,
        -- Null except during a live trial: an active subscriber has no
        -- countdown, and a lapsed trial is the reason text's job. Ceil, so
        -- "ends tomorrow morning" says 1 and never a premature 0.
        case
            when c.subscription_status = 'trialing'
                 and c.trial_ends_at is not null and c.trial_ends_at > now()
            then ceil(extract(epoch from c.trial_ends_at - now()) / 86400.0)::int
        end as trial_days_left
    from companies c
    where c.id = (select company_id from profiles where id = auth.uid());
$$;

select 'trial countdown installed' as done;
