-- ============================================================
-- FenceFlow -- a receipt is claimed on the STRIPE row, so a test payment can
-- have one too.
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- HIS WORDS: "I also did a test payment and it did not show on the app. Work
-- on it and it should also send an email when the person make a payment even
-- if it was a test one"
--
-- WHAT ACTUALLY HAPPENED, read off his own rows. The test payment arrived and
-- was recorded: job_payments carries it, $36,300.00, status 'paid',
-- livemode false, paid_at 23 Oct 03:25. What it did NOT do is reach the books,
-- and that is deliberate and hard-won -- stripe-webhook's creditPayment() has
--
--     if (!livemode) return;
--
-- with the reason written above it: four test checkouts on a real job once
-- left it reading $57,240 paid against a $10,595 contract, and after go-live a
-- test payment would mark a real customer as settled with no money moved.
-- That guard stays. Every one of his Stripe rows is livemode false today, so
-- the first live card will credit the books by itself.
--
-- WHY A SECOND CLAIM COLUMN. r31 put receipt_sent_at on payment_records, which
-- is the right place for the money ledger -- but a test payment has no
-- payment_records row, BY DESIGN (see above), so there is nothing there to
-- claim and a receipt for one could be sent over and over. Stripe retries a
-- webhook until it gets a 2xx and will happily deliver the same event several
-- times. So the claim goes where a row exists in both modes: the Stripe
-- payment itself.
--
--     update job_payments set receipt_sent_at = now()
--      where id = $1 and receipt_sent_at is null
--      returning id;
--
-- No row back means another delivery of the same event already has it, and
-- that caller sends nothing. One statement, no read-then-write, so two
-- deliveries arriving together cannot both win -- the same shape as r31 and as
-- quote_approval_emails.
--
-- STAMPED BEFORE THE SEND, for r31's reason, in r31's words: of the two wrong
-- answers, a customer who did not get a receipt for a payment she knows she
-- made is a phone call, and a customer who got five is a customer who thinks
-- she has been charged five times.
--
-- NOT A MONEY COLUMN. It is a bookkeeping stamp about an email. job_payments
-- is closed to crew by policy regardless.
-- ============================================================

alter table public.job_payments
  add column if not exists receipt_sent_at timestamptz;

comment on column public.job_payments.receipt_sent_at is
  'When the customer''s receipt for this payment was sent (claimed atomically; '
  'see supabase_r34_receipt_claim_on_stripe_row.sql). Exists on this table as '
  'well as on payment_records because a TEST payment never gets a '
  'payment_records row and so has nothing to claim there.';

-- ------------------------------------------------------------------------
-- THE CLAIM, as a function, so the webhook cannot get the statement wrong.
--
-- Returns true to exactly one caller. SECURITY DEFINER because the webhook
-- runs as the service role today but the office's own "send it again" path
-- will not, and the rule must not depend on who is asking.
-- ------------------------------------------------------------------------
create or replace function public.claim_payment_receipt(p_payment_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $claim$
declare
    v_id uuid;
begin
    update job_payments
       set receipt_sent_at = now()
     where id = p_payment_id
       and receipt_sent_at is null
    returning id into v_id;
    return v_id is not null;
end $claim$;

-- NAMED, not just revoked from public. This project grants EXECUTE on new
-- functions to anon and authenticated by default, so "revoke from public"
-- left a signed-in user able to stamp somebody else's receipt as sent -- which
-- would silently stop that receipt ever going out. The proof below is what
-- caught it.
--
-- Safe to revoke here, unlike the lesson r29 paid for: this function is new
-- and no RLS policy calls it, so taking EXECUTE away closes a door rather than
-- turning eight tables into 401s.
revoke all on function public.claim_payment_receipt(uuid) from public;
revoke all on function public.claim_payment_receipt(uuid) from anon;
revoke all on function public.claim_payment_receipt(uuid) from authenticated;
grant execute on function public.claim_payment_receipt(uuid) to service_role;

-- ------------------------------------------------------------------------
-- PROOF. Nothing is sent, and no live row is claimed: the claim is exercised
-- against a row this file inserts and then removes.
-- ------------------------------------------------------------------------
-- ------------------------------------------------------------------------
-- POSITIVE CONTROL AND CANARY IN ONE, as its own statement: a data-modifying
-- CTE may not sit inside a subquery, and the first draft of r31 learned the
-- harder half of this -- such a CTE COMMITS, so it may never touch a live row.
--
-- The claim must answer true ONCE and false after. A function that always
-- answered false would pass every "it did not double-send" check ever written
-- while sending no receipts at all. RAISEs rather than reporting, so a wrong
-- answer here aborts the file instead of printing FAIL into a long list.
-- ------------------------------------------------------------------------
do $proof$
declare
    v_job   record;
    v_id    uuid;
    v_first boolean;
    v_again boolean;
begin
    select company_id, sync_id into v_job
      from jobs where deleted_at is null limit 1;
    if v_job.sync_id is null then
        raise notice 'r34: no job to build a proof row on; claim NOT exercised';
        return;
    end if;

    insert into job_payments
           (company_id, job_sync_id, kind, amount_cents, currency,
            status, livemode, processor)
    values (v_job.company_id, v_job.sync_id, 'deposit', 1, 'usd',
            'canceled', false, 'r34-proof')
    returning id into v_id;

    v_first := public.claim_payment_receipt(v_id);
    v_again := public.claim_payment_receipt(v_id);

    delete from job_payments where id = v_id and processor = 'r34-proof';

    if not v_first then
        raise exception 'r34: the claim was REFUSED on a fresh row -- no receipt would ever send';
    end if;
    if v_again then
        raise exception 'r34: the claim was won TWICE -- a retry would send a second receipt';
    end if;
    raise notice 'r34: claim won once, refused the second time, proof row removed';
end $proof$;

select 'the column exists' as check,
       case when exists (
           select 1 from information_schema.columns
            where table_schema='public' and table_name='job_payments'
              and column_name='receipt_sent_at')
            then 'PASS' else 'FAIL' end as result
union all
select 'the claim function exists and runs as its owner',
       coalesce((select case when p.prosecdef then 'PASS' else 'FAIL' end
                   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='public' and p.proname='claim_payment_receipt'), 'FAIL')
union all
select 'crew cannot claim a receipt',
       case when has_function_privilege('authenticated',
              'public.claim_payment_receipt(uuid)', 'EXECUTE')
            then 'FAIL -- a signed-in user can stamp a receipt as sent'
            else 'PASS' end
union all
-- What is already out there, so the first real send is not a surprise.
select 'payments that would be eligible for a receipt today',
       (select count(*)::text || ' paid Stripe payments, '
            || count(*) filter (where receipt_sent_at is null)::text || ' never receipted'
          from job_payments where status = 'paid');
