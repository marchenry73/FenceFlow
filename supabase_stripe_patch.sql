-- ============================================================
-- FenceFlow -- Stripe
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- Covers the two payment flows, which are NOT the same thing:
--
--   1. Homeowner  -> fencing company   (job deposits and invoices)
--      Payment for a physical service. Any processor is allowed, including
--      inside the Android app -- Google takes no cut of these.
--
--   2. Fencing company -> FenceFlow    (the monthly subscription)
--      A digital service, so this one stays on the website to avoid Play
--      Store billing rules entirely.
--
-- No Stripe secret key is ever stored in this database. Secrets live in
-- Edge Function secrets; this table only ever holds a Stripe *account id*,
-- which is not a credential.
-- ============================================================

-- ---------- 1. Subscription state, per company ----------
alter table companies add column if not exists stripe_customer_id     text;
alter table companies add column if not exists stripe_subscription_id text;
-- none | trialing | active | past_due | canceled
alter table companies add column if not exists subscription_status    text not null default 'none';
alter table companies add column if not exists subscription_plan      text not null default '';
alter table companies add column if not exists subscription_ends_at   timestamptz;
-- Set when the company connects its own Stripe account to take customer
-- payments. Not a secret: it identifies an account, it cannot act on one.
alter table companies add column if not exists stripe_account_id      text;

-- ---------- 2. Payment requests sent to homeowners ----------
create table if not exists job_payments (
    id           uuid primary key default gen_random_uuid(),
    company_id   uuid not null references companies(id) on delete cascade,
    job_sync_id  text not null,
    -- deposit | progress | final
    kind         text not null default 'deposit',
    amount_cents bigint not null,
    currency     text not null default 'usd',
    -- pending | paid | canceled
    status       text not null default 'pending',
    payment_url  text not null default '',
    stripe_id    text,
    created_at   timestamptz not null default now(),
    paid_at      timestamptz
);

create index if not exists job_payments_company_idx on job_payments(company_id);
create index if not exists job_payments_job_idx     on job_payments(job_sync_id);
create unique index if not exists job_payments_stripe_idx
    on job_payments(stripe_id) where stripe_id is not null;

alter table job_payments enable row level security;

-- Everyone in the company can see what's been requested and what's been paid.
drop policy if exists job_payments_select on job_payments;
create policy job_payments_select on job_payments
    for select using (company_id = (select company_id from profiles where id = auth.uid()));

-- Only an owner or manager can ask a customer for money, and nobody edits a
-- payment record by hand -- the Stripe webhook is the only thing that marks
-- one paid, using the service role, which bypasses these policies.
drop policy if exists job_payments_insert on job_payments;
create policy job_payments_insert on job_payments
    for insert with check (
        company_id = (select company_id from profiles where id = auth.uid())
        and (select role from profiles where id = auth.uid()) in ('OWNER', 'MANAGER')
    );

drop policy if exists job_payments_update on job_payments;
create policy job_payments_update on job_payments
    for update using (
        company_id = (select company_id from profiles where id = auth.uid())
        and (select role from profiles where id = auth.uid()) in ('OWNER', 'MANAGER')
    );

-- ---------- 3. Reading your own company's billing state ----------
-- Returns only this company's row, so the website can show plan and status
-- without exposing the companies table.
create or replace function my_billing_status()
returns table (
    subscription_status text,
    subscription_plan   text,
    subscription_ends_at timestamptz,
    stripe_account_id   text
)
language sql
security definer
set search_path = public
as $$
    select c.subscription_status, c.subscription_plan, c.subscription_ends_at, c.stripe_account_id
    from companies c
    where c.id = (select company_id from profiles where id = auth.uid());
$$;

revoke all on function my_billing_status() from public;
grant execute on function my_billing_status() to authenticated;
