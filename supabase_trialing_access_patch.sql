-- A Stripe checkout trial sets subscription_status = 'trialing', which the
-- access gate did not recognize -- so the first real test of the subscribe
-- flow locked the brand-new subscriber out on day one. Stripe owns the
-- trial clock: when the trial lapses it flips the status itself, so
-- 'trialing' is sufficient for access on its own.
create or replace function public.my_service_status()
returns table(allowed boolean, subscription_status text, reason text,
              grace_ends_at timestamptz, trial_days_left int)
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

-- Put the owner's own company back the way it was before the dry run: it was
-- 'active' by grant, and the test checkout stamped it 'trialing' with no
-- trial end recorded.
update public.companies
   set subscription_status = 'active',
       stripe_subscription_id = null,
       trial_ends_at = null
 where id = (select company_id from public.profiles
             where id = '7bf38947-24cf-4e79-9af0-6100d04b166b');

select subscription_status, trial_ends_at is null as trial_cleared
  from public.companies
 where id = (select company_id from public.profiles
             where id = '7bf38947-24cf-4e79-9af0-6100d04b166b');
