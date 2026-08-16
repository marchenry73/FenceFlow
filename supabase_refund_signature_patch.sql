-- Refunds, processor-locked payment figures, and the terms a signature covers.
--
-- Additive only; every default matches the behaviour these jobs already have.
--
-- refunded_amount is a running total rather than a subtraction from
-- amount_paid, because sync deliberately refuses to let amount_paid go
-- backwards -- that rule is what stops a race erasing a customer's payment. A
-- refund is a second fact, not an edit to the first, so both totals only grow
-- and what is owed is the difference.
--
-- signed_contract_total / signed_linear_feet record what the customer was
-- actually looking at when they signed, so redrawing the layout afterwards can
-- be spotted and a new signature asked for, instead of an old signature
-- silently standing as agreement to a job that no longer exists. Zero means
-- "signed before we tracked this" and is left alone rather than flagged.

alter table jobs
  add column if not exists refunded_amount double precision not null default 0,
  add column if not exists refunded_at timestamptz,
  add column if not exists refund_reason text not null default '',
  add column if not exists payments_from_processor boolean not null default false,
  add column if not exists signed_contract_total double precision not null default 0,
  add column if not exists signed_linear_feet real not null default 0;

comment on column jobs.refunded_amount is
  'Running total of money handed back. Never decreases; net paid is amount_paid minus this.';
comment on column jobs.payments_from_processor is
  'True once Stripe has reported a payment. The app stops allowing the paid figure to be typed over.';
