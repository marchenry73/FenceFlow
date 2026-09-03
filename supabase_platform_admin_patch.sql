-- ============================================================
-- FenceFlow -- the platform owner's view of paying companies
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- Additive: one flag, one table, and read policies. Nothing existing changes.
--
-- This is Marc's side of the business, not a fencing company's. A fencing
-- company must never see it, and by default nobody can -- the flag has to be
-- set by hand, in SQL, on exactly one account.
--
-- NOTE on where this lives. Ideally the platform's own books sit in a separate
-- Supabase project entirely, so a mistake in one policy cannot expose them.
-- That needs a second project created by hand; this version keeps them here
-- but behind a flag nothing in the app can set, which is the same boundary
-- every other table already relies on.
-- ============================================================

-- ---------- 1. Who runs the platform ----------
alter table profiles add column if not exists is_platform_admin boolean not null default false;

-- ---------- 2. Billing state per client company ----------
-- companies already carries subscription_status/plan/stripe ids from the Stripe
-- patch. This adds only what the platform owner needs on top.
alter table companies add column if not exists trial_ends_at    timestamptz;
alter table companies add column if not exists grace_ends_at    timestamptz;
alter table companies add column if not exists suspended        boolean not null default false;
alter table companies add column if not exists monthly_price    numeric(10,2) not null default 0;
alter table companies add column if not exists billing_email    text not null default '';
alter table companies add column if not exists admin_notes      text not null default '';

-- ---------- 3. A platform admin can see and manage every company ----------
create or replace function is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((select is_platform_admin from profiles where id = auth.uid()), false);
$$;

revoke all on function is_platform_admin() from public;
grant execute on function is_platform_admin() to authenticated;

drop policy if exists companies_platform_admin_all on companies;
create policy companies_platform_admin_all on companies
    for all using (is_platform_admin());

-- ---------- 4. One row per client, for the admin screen ----------
-- A view rather than a table: the data already exists, and copying it would
-- create two versions of the truth that drift apart.
create or replace view platform_clients as
select
    c.id,
    c.name,
    c.email,
    c.phone,
    c.billing_email,
    c.subscription_status,
    c.subscription_plan,
    c.monthly_price,
    c.subscription_ends_at,
    c.trial_ends_at,
    c.grace_ends_at,
    c.suspended,
    c.admin_notes,
    c.stripe_customer_id,
    c.created_at,
    (select count(*) from profiles p where p.company_id = c.id)  as user_count,
    (select count(*) from jobs j where j.company_id = c.id)      as job_count,
    (select max(j.updated_at) from jobs j where j.company_id = c.id) as last_activity
from companies c;

-- The view runs as the caller, so the policy above is what gates it.
alter view platform_clients set (security_invoker = true);

-- ---------- 5. Is this company allowed to use the service right now? ----------
-- Called by the app. Everyone can ask about their OWN company only.
create or replace function my_service_status()
returns table (
    allowed         boolean,
    status          text,
    reason          text,
    grace_ends_at   timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
    select
        -- Suspended is the only hard stop. Past due still works while the
        -- grace period runs: cutting a crew off mid-installation over a failed
        -- card punishes the customer standing in the yard, not the biller.
        (not c.suspended) and (
            c.subscription_status in ('active', 'trialing')
            or (c.subscription_status = 'past_due'
                and coalesce(c.grace_ends_at, now() + interval '2 days') > now())
            or coalesce(c.trial_ends_at, now() + interval '1 day') > now()
        ) as allowed,
        c.subscription_status,
        case
            when c.suspended then 'Your FenceFlow account has been suspended. Please contact us.'
            when c.subscription_status = 'past_due' then 'Your payment did not go through. Please update your card.'
            when c.subscription_status = 'canceled' then 'Your subscription has ended.'
            else ''
        end as reason,
        c.grace_ends_at
    from companies c
    where c.id = (select company_id from profiles where id = auth.uid());
$$;

revoke all on function my_service_status() from public;
grant execute on function my_service_status() to authenticated;

-- ============================================================
-- MAKE YOURSELF THE PLATFORM ADMIN
-- Replace the email, then run. Nothing in the app can set this flag, which is
-- the point -- it cannot be granted by signing up or by any request the app
-- makes.
-- ============================================================
-- update profiles set is_platform_admin = true
-- where id = (select id from auth.users where email = 'you@example.com');
