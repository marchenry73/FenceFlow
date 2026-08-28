-- job_payments could only describe a Stripe payment.
--
-- The table has a stripe_id column and nothing else to identify a payment by,
-- so a Square payment had nowhere to be recorded. Overloading stripe_id would
-- have worked and lied: the next person reading it would reasonably assume
-- every value in it was a Stripe id.
--
-- Two columns instead, with stripe_id kept exactly as it is so nothing that
-- reads it today changes behaviour.
alter table public.job_payments
  add column if not exists processor  text not null default 'stripe',
  add column if not exists external_id text not null default '';

comment on column public.job_payments.processor is
  'Which processor took this payment: stripe or square.';
comment on column public.job_payments.external_id is
  'That processor''s own id for the payment or checkout. For Stripe this mirrors stripe_id.';

-- Everything already in the table came from Stripe, so say so rather than
-- leaving a blank that later reads as unknown.
update public.job_payments
   set external_id = coalesce(stripe_id, '')
 where external_id = '' and coalesce(stripe_id, '') <> '';

-- Finding the company and job a Square payment belongs to, when its webhook
-- arrives carrying only Square's own ids.
create index if not exists job_payments_external_id_idx
    on public.job_payments (processor, external_id);
