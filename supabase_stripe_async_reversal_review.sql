-- ============================================================
-- Stripe async-payment reversal review -- ADDITIVE, NOT APPLIED.
--
-- Written for a decision, not run. See stripe-webhook/index.ts's
-- checkout.session.async_payment_failed case (the "already marked paid"
-- branch) for where this would be read and written.
-- ============================================================
--
-- THE SITUATION
--
-- checkout.session.completed used to mark a job_payments row 'paid' and
-- credit the ledger for ANY completed Checkout Session on a known payment
-- link, without reading session.payment_status. For an asynchronous
-- payment method (US bank account / ACH debit, SEPA Debit, Cash App Pay,
-- and others Stripe may add), Stripe's own event model has this event
-- fire with payment_status "unpaid" the moment the customer submits their
-- bank details -- days before the debit can actually clear -- and settles
-- it later with checkout.session.async_payment_succeeded or
-- ...async_payment_failed. The fix in index.ts now waits for one of those
-- two events instead of crediting on "unpaid".
--
-- That fix closes the hole for every NEW payment link. It does nothing
-- for a job_payments row this bug already credited before the fix
-- shipped: if Stripe now reports (or ever reported) that same payment's
-- async debit failed, the row still reads 'paid', the ledger still shows
-- the money as collected, and the job still shows it as paid to the
-- customer -- none of that is true.
--
-- THE DECISION THIS NEEDS FROM MARCH
--
-- The webhook already has a proven, conservative, downward-only path for
-- taking money back off a job: recordRefund() in
-- supabase/functions/_shared/record-payment.ts, the same function a real
-- Stripe refund and a lost dispute already go through. It is idempotent
-- (keyed on its own id), and by design it can only ever reduce what a job
-- shows as paid, never increase it.
--
-- The code today does NOT call it automatically when
-- checkout.session.async_payment_failed arrives for a link already marked
-- paid. It only logs the contradiction (job_payments.id, company_id,
-- amount, the Stripe session id) to the function's own logs and leaves the
-- ledger untouched, per the owner's instruction that an automatic reversal
-- firing wrongly is worse than a flag a human clears.
--
-- Two ways to close that gap, and which one to build is March's call:
--
--   (a) AUTOMATIC.  Wire that branch straight into recordRefund(), the
--       same way a real refund or a lost dispute already is. Needs no
--       schema change -- it is already additive and idempotent. Risk: if
--       this ever fires for a webhook that is delayed, duplicated, or
--       (implausibly, given job_payments.status is only ever set to
--       'paid' by this function) mis-scoped, it silently removes money
--       from a job that is actually fine, with nothing to say why beyond
--       a log line.
--
--   (b) FLAG FOR REVIEW.  What this file adds: two columns so the branch
--       above can mark the row instead of guessing, and something in the
--       office (a dashboard.html panel, or a new attention-sweep
--       detector alongside payment_failed's, per
--       supabase_p4_attention_candidates_fn.sql) can surface it for a
--       person to check against Stripe's own dashboard and clear by hand
--       -- either by re-running (a) manually once, or by confirming the
--       payment is fine and clearing the flag with nothing else touched.
--
-- Nothing below is applied. If March picks (b), run this and then wire
-- the async_payment_failed branch in stripe-webhook/index.ts to set it
-- instead of only logging. If he picks (a), this file is not needed --
-- call recordRefund() from that branch instead, and this file can stay
-- unused as a record of the decision.
-- ------------------------------------------------------------

alter table public.job_payments
  add column if not exists needs_review   boolean not null default false,
  add column if not exists review_reason  text     not null default '',
  add column if not exists review_flagged_at timestamptz;

comment on column public.job_payments.needs_review is
  'Set by stripe-webhook when checkout.session.async_payment_failed arrives for a link already marked paid -- money the books show as collected that Stripe is now saying never arrived. Not auto-reversed; a person clears this by hand after checking Stripe''s own dashboard.';
comment on column public.job_payments.review_reason is
  'Plain text for the person clearing needs_review: what contradicted what, and the Stripe session id, so it can be looked up without grepping function logs.';
comment on column public.job_payments.review_flagged_at is
  'When the contradiction was detected, so a stale flag is visible as stale.';

-- Cheap to find the handful of rows that ever need this, without a
-- sequential scan of the whole table.
create index if not exists job_payments_needs_review_idx
    on public.job_payments (company_id) where needs_review;

-- Undo:
--   drop index if exists public.job_payments_needs_review_idx;
--   alter table public.job_payments
--     drop column if exists needs_review,
--     drop column if exists review_reason,
--     drop column if exists review_flagged_at;
