-- r40: the card that paid the deposit can pay the balance.
--
-- HIS WORDS: "once I marked the job completed I want an email to go out to the
--  customer to make the rest of the payment, the same way or I want it to
--  automatically charge the customer using stripes, I like the automatic one,
--  and I say that the customer was satisfied, and the money is automatically
--  taken."
--
-- WHY THE DEPOSIT STEP HAS TO CHANGE FIRST, AND WHY IT CANNOT BE RETROFITTED.
-- Stripe cannot charge a card it never stored. Today the deposit goes through
-- a Payment Link that keeps nothing, so there is no card on file for ANY job
-- ever paid so far. For the balance to be taken later, the deposit has to save
-- the card AND the customer has to agree, at that moment, that the rest will
-- be taken when the work is done. That agreement is not optional: it is what
-- Stripe requires for an off-session charge and what makes the charge
-- defensible if she disputes it.
--
-- OPT IN, PER COMPANY, DEFAULT OFF. auto_charge_balance decides whether a
-- company's deposit links ask to keep the card at all. Eleven companies use
-- this database and none of them asked for their customers' cards to be
-- stored; a global switch would have started doing that to all of them at
-- once. Off is also the honest default for a feature whose failure mode is
-- taking money somebody did not expect.
--
-- WHAT IS KEPT, AND WHAT IS DELIBERATELY NOT. The Stripe customer id and
-- payment-method id -- which are references, not card numbers; Stripe holds
-- the card and this database never sees it. The brand and last four digits
-- are kept ONLY so the office can say "Visa ending 4242" before charging,
-- because a button that takes money without naming what it will charge is a
-- button nobody should press. No PAN, no CVC, no expiry: those would make
-- this database a cardholder-data environment, which it must never become.
--
-- EVERY COLUMN IS NULLABLE OR DEFAULTED, so this is inert on arrival: nothing
-- reads it yet, and no existing row changes behaviour.

alter table public.companies
  -- Does this company's deposit ask to keep the card for the balance?
  add column if not exists auto_charge_balance boolean not null default false;

alter table public.jobs
  -- The Stripe customer the deposit created, and the card it saved. Both are
  -- opaque references; the card itself never touches this database.
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_payment_method_id text,
  -- WHEN SHE AGREED, and to what. Null means no agreement was captured and
  -- nothing may be charged off-session, whatever else is stored. This is the
  -- column that answers "did she say yes" months later, when it matters.
  add column if not exists card_consent_at timestamptz,
  -- Enough to NAME the card before charging it, and nothing more.
  add column if not exists card_brand text,
  add column if not exists card_last4 text;

-- A saved card is only ever four digits here. Anything longer is a sign
-- something tried to store a real number, and should fail loudly at the write
-- rather than quietly become a compliance problem.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'jobs_card_last4_is_four_digits') then
    alter table public.jobs
      add constraint jobs_card_last4_is_four_digits
      check (card_last4 is null or card_last4 ~ '^[0-9]{4}$');
  end if;
end $$;

-- The sweep that charges a balance asks one question: which finished jobs have
-- a saved card and an agreement? Indexed so that question stays cheap.
create index if not exists jobs_chargeable_card_idx
  on public.jobs (company_id)
  where stripe_payment_method_id is not null and card_consent_at is not null;

comment on column public.companies.auto_charge_balance is
  'Opt in: this company''s deposit links ask to keep the card so the balance can be charged when the job is finished. Default false. See supabase_r40_auto_charge_balance.sql.';
comment on column public.jobs.card_consent_at is
  'When the customer agreed the balance could be charged to the saved card. NULL means nothing may be charged off-session, whatever else is stored.';
comment on column public.jobs.card_last4 is
  'Last four digits only, so the office can name the card before charging it. Never a full number.';
