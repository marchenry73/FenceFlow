-- "trialing" was allowed unconditionally, so a trial only ended if something
-- else changed the status -- and with no billing webhooks running, nothing
-- ever would. Every trial company would have had permanent access, which is
-- the same hole as before wearing a different hat.
--
-- Being on trial is now allowed only while the trial date is actually in the
-- future. Active is the unconditional one, because that is what "we have
-- agreed this company may use it" means.
drop function if exists public.my_service_status();

create function public.my_service_status()
returns table (
    allowed boolean,
    subscription_status text,
    reason text,
    grace_ends_at timestamptz
)
language sql
security definer
set search_path = public
as $$
    select
        -- Suspended is the only hard stop. Past due still works while the
        -- grace period runs: cutting a crew off mid-installation over a failed
        -- card punishes the customer standing in the yard, not the biller.
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
        c.grace_ends_at
    from companies c
    where c.id = (select company_id from profiles where id = auth.uid());
$$;
