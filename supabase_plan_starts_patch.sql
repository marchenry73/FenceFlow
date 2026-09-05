-- "Your free trial ends in 2 days" -- said to a company that had already
-- picked a plan. The trial is Stripe's trial period on a real subscription:
-- the plan is chosen, the card is on file, and what happens in two days is
-- the first charge, not a lockout. Both status functions now say whether a
-- subscription exists so the office and the app can say "your Pro plan
-- starts in 2 days" instead. Return types change, so drop and recreate;
-- grants restated because a dropped function loses them.

drop function if exists public.my_service_status();
create function public.my_service_status()
returns table(allowed boolean, subscription_status text, subscription_plan text, reason text,
              grace_ends_at timestamptz, trial_days_left integer, suspended boolean,
              suspended_reason text, can_self_serve boolean, subscribed boolean)
language sql security definer set search_path to 'public'
as $$
    select
        coalesce(public.company_allowed(c.id), false) as allowed,
        c.subscription_status::text,
        coalesce(c.subscription_plan, '') as subscription_plan,
        case
            when c.suspended and coalesce(c.suspended_reason,'') = 'HOLD'
                then 'Your account is on hold while we sort something out. '
                     || 'Paying will not lift this — please get in touch and we will get you going again.'
            when c.suspended
                then 'Your FenceFlow account has been suspended. Please get in touch.'
            when c.subscription_status = 'past_due'
                then 'Your payment did not go through. Please update your card.'
            when c.subscription_status = 'canceled' then 'Your subscription has ended.'
            when c.trial_ends_at is not null and c.trial_ends_at <= now()
                then 'Your trial has ended. Pick a plan below to keep going.'
            else 'Pick a plan to start your 14-day free trial.'
        end as reason,
        c.grace_ends_at,
        case
            when c.subscription_status = 'trialing'
                 and c.trial_ends_at is not null and c.trial_ends_at > now()
            then ceil(extract(epoch from c.trial_ends_at - now()) / 86400.0)::int
        end as trial_days_left,
        c.suspended,
        coalesce(c.suspended_reason, '')::text as suspended_reason,
        (not (c.suspended and coalesce(c.suspended_reason,'') = 'HOLD')) as can_self_serve,
        -- A plan has been picked and a card taken: the trial is a countdown to
        -- the first charge, not to being shut out.
        (c.stripe_subscription_id is not null) as subscribed
    from companies c
    where c.id = (select company_id from profiles where id = auth.uid());
$$;
revoke execute on function public.my_service_status() from public, anon;
grant  execute on function public.my_service_status() to authenticated, service_role;

drop function if exists public.my_billing_status();
create function public.my_billing_status()
returns table(subscription_status text, subscription_plan text, subscription_ends_at timestamptz,
              trial_ends_at timestamptz, stripe_account_id text, has_subscription boolean)
language sql security definer set search_path to 'public'
as $$
    select c.subscription_status, c.subscription_plan, c.subscription_ends_at,
           c.trial_ends_at,
           c.stripe_account_id,
           -- A customer record exists the moment checkout opens; a
           -- subscription exists only once a plan was actually picked.
           c.stripe_subscription_id is not null as has_subscription
    from companies c
    where c.id = (select company_id from profiles where id = auth.uid());
$$;
revoke execute on function public.my_billing_status() from public, anon;
grant  execute on function public.my_billing_status() to authenticated, service_role;

notify pgrst, 'reload schema';
