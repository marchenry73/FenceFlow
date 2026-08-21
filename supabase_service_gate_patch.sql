-- Make the access gate actually gate.
--
-- The check ended with:
--     or coalesce(c.trial_ends_at, now() + interval '1 day') > now()
-- and with trial_ends_at null that reads "now + 1 day is later than now",
-- which is true forever. So any company never explicitly configured had
-- unlimited access, permanently. The gate was open for exactly the companies
-- nobody had thought about -- which is the wrong way round.
--
-- Step 1 first, deliberately: the owner's own company is set to active BEFORE
-- the rule tightens, so tightening it cannot lock them out of their own app.

-- ---------------------------------------------------------------------------
-- 1. The owner's company keeps permanent access. This is the company that
--    builds the product; it is not on trial and never expires.
-- ---------------------------------------------------------------------------
update public.companies
set subscription_status = 'active',
    suspended = false,
    admin_notes = coalesce(nullif(admin_notes, ''), 'Owner company. Permanent access.')
where subscription_status = 'none' or subscription_status is null;

-- ---------------------------------------------------------------------------
-- 2. New companies start on a real 14-day trial rather than on nothing.
-- ---------------------------------------------------------------------------
alter table public.companies
  alter column trial_ends_at set default (now() + interval '14 days'),
  alter column subscription_status set default 'trialing';

-- ---------------------------------------------------------------------------
-- 3. The gate: a company with nothing recorded is NOT allowed.
--
-- Everything else about the original is kept, and it was right: suspended is
-- the only hard stop, and past_due still works while the grace period runs,
-- because cutting a crew off mid-installation over a failed card punishes the
-- customer standing in the yard rather than whoever forgot to pay.
-- ---------------------------------------------------------------------------
-- Dropped first because the return shape changes. Safe: nothing calls this
-- yet, which is the bug being fixed.
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
        (not c.suspended) and (
            c.subscription_status in ('active', 'trialing')
            or (c.subscription_status = 'past_due'
                and coalesce(c.grace_ends_at, now() + interval '2 days') > now())
            -- A real date, or nothing. No coalesce to a moving target: an
            -- unconfigured company is not entitled to the app.
            or (c.trial_ends_at is not null and c.trial_ends_at > now())
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

-- What every company now resolves to.
select name, subscription_status, suspended, trial_ends_at,
       (not suspended) and (
           subscription_status in ('active','trialing')
           or (subscription_status = 'past_due' and coalesce(grace_ends_at, now() + interval '2 days') > now())
           or (trial_ends_at is not null and trial_ends_at > now())
       ) as allowed
from public.companies;
