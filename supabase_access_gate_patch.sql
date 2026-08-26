-- Three holes in the gate that decides who may use FenceFlow.
--
-- 1. THE GRACE PERIOD WAS INFINITE.
--    company_allowed's past_due arm read:
--        coalesce(c.grace_ends_at, now() + interval '2 days') > now()
--    The fallback is always in the future, so a NULL grace_ends_at meant
--    "allowed for ever", not "two days". Nothing writes grace_ends_at, so it
--    is NULL for every company that has ever failed a payment. A card that
--    stops working bought unlimited free service, and the only place anyone
--    was told was the Billing tab if they happened to open it.
--
--    Now: an explicit grace wins; failing that they are covered until the date
--    they have actually paid through; failing that there is no grace. The
--    webhook also sets a real seven-day window when it marks a card failed, so
--    a contractor mid-job is not cut off the same afternoon.
--
-- 2. A HOLD LOOKED LIKE AN UNPAID BILL.
--    my_service_status gave both the same sentence and never returned
--    suspended_reason, so no client could tell them apart. A company March put
--    on hold for a dispute read "FenceFlow is paused / Restart your
--    subscription:" with live plan buttons. They could pay, we would take the
--    money, and they would still be locked out reading the same screen.
--
-- 3. THE LOCKOUT WAS DECORATION.
--    The RESTRICTIVE policy on all 17 data tables is NOT company_is_suspended(),
--    and that function read exactly one column: companies.suspended. It knew
--    nothing about a cancelled subscription, an expired trial or a grace period
--    that had run out. So a company that stopped paying was stopped by the app's
--    own screen and nothing else -- every row still readable and writable by
--    anything holding their login: a second browser tab, an older app build,
--    curl. It now asks the same question the product asks.

create or replace function public.company_allowed(cid uuid)
returns boolean
language sql stable security definer set search_path to 'public'
as $$
    select (not c.suspended)
       and c.subscription_status is distinct from 'canceled'
       and (
            c.subscription_status = 'active'
            -- 'trialing' used to pass on its own, whatever the date, so a
            -- trial whose end had come and gone kept full access for ever --
            -- and Stripe leaves the status at 'trialing' until something moves
            -- the subscription on. A NULL trial end still passes, because a
            -- subscriber whose trial_end has not arrived from Stripe yet must
            -- not be locked out on their first day: that failure is worse than
            -- the one being fixed, and it has happened here before.
            or (c.subscription_status = 'trialing'
                and (c.trial_ends_at is null or c.trial_ends_at > now()))
            or (c.trial_ends_at is not null and c.trial_ends_at > now())
            or (c.subscription_status = 'past_due'
                -- An explicit grace, else the date they have paid through,
                -- else none. Never an open-ended one.
                and coalesce(c.grace_ends_at, c.subscription_ends_at,
                             '-infinity'::timestamptz) > now())
       )
    from companies c
    where c.id = cid;
$$;
revoke execute on function public.company_allowed(uuid) from public, anon;
grant  execute on function public.company_allowed(uuid) to authenticated, service_role;

create or replace function public.company_is_suspended()
returns boolean
language sql stable security definer set search_path to 'public'
as $$
    -- The same question the rest of the product asks, so a cancelled or
    -- expired company cannot reach its data through a second tab or an old
    -- build. Defaults to NOT suspended when there is no company to judge --
    -- somebody mid-signup has no data to reach anyway, and locking out on an
    -- unknown would be a worse failure than the one being fixed.
    select not coalesce(
        public.company_allowed(
            (select p.company_id from profiles p where p.id = auth.uid())),
        true);
$$;

drop function if exists public.my_service_status();
create function public.my_service_status()
returns table(allowed boolean, subscription_status text, subscription_plan text,
              reason text, grace_ends_at timestamptz, trial_days_left integer,
              suspended boolean, suspended_reason text, can_self_serve boolean)
language sql security definer set search_path to 'public'
as $$
    select
        coalesce(public.company_allowed(c.id), false) as allowed,
        c.subscription_status::text,
        coalesce(c.subscription_plan, '') as subscription_plan,
        case
            -- A hold is March's own decision and paying does not lift it, so
            -- it must not read like a bill.
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
        -- Whether showing them plan buttons could actually help. A hold cannot
        -- be paid off, so offering to sell them something is worse than saying
        -- nothing.
        (not (c.suspended and coalesce(c.suspended_reason,'') = 'HOLD')) as can_self_serve
    from companies c
    where c.id = (select company_id from profiles where id = auth.uid());
$$;
revoke execute on function public.my_service_status() from public;
grant  execute on function public.my_service_status() to anon, authenticated, service_role;
