-- Card fee pass-through. Additive only.
-- companies.pass_card_fee: when true, a card payment link adds a separate
--   "Card processing fee" line so the company nets (close to) the full amount.
-- job_payments.fee_cents: that fee, kept apart from amount_cents. The ledger
--   credits amount_cents only, so the fee never reduces what the job owes, and
--   refunds/disputes are scaled back to the job's share.
alter table companies    add column if not exists pass_card_fee boolean not null default false;
alter table job_payments add column if not exists fee_cents     integer not null default 0;
do $d$ begin
  if not exists (select 1 from pg_constraint where conname = 'job_payments_fee_cents_nonneg') then
    alter table job_payments add constraint job_payments_fee_cents_nonneg check (fee_cents >= 0);
  end if;
end $d$;
select 'card fee passthrough installed' as done;
