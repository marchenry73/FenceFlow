-- Keep test money out of real balances.
--
-- Stripe test-mode and live-mode payments were landing in the same table with
-- nothing to tell them apart, and every one of them was added to the job's
-- balance. Testing the checkout flow four times on a real customer's job left
-- it reading $57,240 paid against a $10,595 contract.
--
-- The danger is not the noise, it is the direction of the error: once this
-- account goes live, a test payment would still credit a real customer as
-- having paid, and the job would show settled when no money had moved.
--
-- Additive only. No rows are deleted and no existing value changes meaning:
-- every payment recorded so far was made through a buy.stripe.com/test_ link,
-- so the `false` default is the truth for all of them.

alter table job_payments
  add column if not exists livemode boolean not null default false;

-- The balance is recomputed per mode, so this is the lookup that matters.
create index if not exists job_payments_mode_idx
  on job_payments (company_id, job_sync_id, status, livemode);

comment on column job_payments.livemode is
  'True when this payment came from a real Stripe key. Balances are summed within a single mode so test payments can never credit a live job.';
