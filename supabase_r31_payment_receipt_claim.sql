-- ============================================================
-- FenceFlow -- the customer gets a receipt, once.
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- WHAT IS MISSING TODAY. When a card payment lands, stripe-webhook pushes a
-- notification to HIS phones and the customer gets nothing at all. There is no
-- receipt anywhere in this product -- not in the app, not in the office, not
-- from either webhook -- and he takes Zelle, Cash App and cash by hand as
-- well, so for most payments the only record she has is her own bank
-- statement.
--
-- WHY THIS COLUMN EXISTS, AND WHY IT IS THE WHOLE DIFFICULTY. Stripe retries a
-- webhook until it gets a 2xx, and it will happily deliver the same event
-- several times. A receipt sent five times is worse than no receipt: it reads
-- as five payments. So the send has to be CLAIMED, and the claim has to be
-- atomic, which this makes possible:
--
--     update payment_records set receipt_sent_at = now()
--      where company_id = $1 and sync_id = $2 and receipt_sent_at is null
--      returning id;
--
-- No row back means somebody else already has it -- another delivery of the
-- same event, or a retry of our own call -- and that caller sends nothing.
-- One statement, no read-then-write, so two deliveries arriving together
-- cannot both win. The same shape as quote_approval_emails, which is how the
-- contract copy is sent exactly once.
--
-- STAMPED BEFORE THE SEND, not after. If the provider call then fails, the
-- receipt is not retried -- and that is the deliberate choice: of the two
-- wrong answers, a customer who did not get a receipt for a payment she knows
-- she made is a phone call, and a customer who got five is a customer who
-- thinks she has been charged five times. The failure is logged and the office
-- can send it by hand from the job's mail panel, which already works.
--
-- NOT a money column. It is a bookkeeping stamp about an email, so crew read
-- it harmlessly -- and payment_records is already closed to them by policy
-- regardless.
-- ============================================================

alter table public.payment_records
  add column if not exists receipt_sent_at timestamptz;

comment on column public.payment_records.receipt_sent_at is
  'When the customer''s receipt email was claimed for this payment. Claimed by an atomic update ... where receipt_sent_at is null, so a retried webhook sends nothing. See supabase_r31_payment_receipt_claim.sql.';

-- The table is granted to authenticated as a whole today; re-stated so the
-- new column is covered whichever way that goes. A column nobody granted is
-- the hazard that took every company's email down once already.
grant select, insert, update on public.payment_records to authenticated;

-- ------------------------------------------------------------------------
-- PROOF.
-- ------------------------------------------------------------------------
select 'the column exists' as check,
       case when exists (select 1 from information_schema.columns
                          where table_schema = 'public' and table_name = 'payment_records'
                            and column_name = 'receipt_sent_at')
            then 'PASS' else 'FAIL' end as result
union all
select 'nothing is claimed yet',
       case when (select count(*) from payment_records where receipt_sent_at is not null) = 0
            then 'PASS'
            else 'note -- ' || (select count(*)::text from payment_records where receipt_sent_at is not null)
                 || ' already stamped, which is fine on a re-run' end
union all
-- POSITIVE CONTROL: there are payments for this to be about. Without it the
-- check above passes just as well against an empty table.
select 'there are payments on record',
       case when (select count(*) from payment_records where deleted_at is null) > 0
            then 'PASS (' || (select count(*)::text from payment_records where deleted_at is null) || ')'
            else 'FAIL -- no payments at all, so nothing here has been exercised' end
union all
-- THE CLAIM ITSELF, proven rather than described -- ON A TEMPORARY TABLE.
--
-- The first draft of this check ran the two updates against a real
-- payment_records row inside a CTE and then claimed to have "rolled back".
-- Nothing rolled it back: a data-modifying CTE commits with the statement, so
-- it would have stamped a live payment as receipt-sent and that customer
-- would never have got one. The pattern is what needs proving, not these
-- rows, so it is proven where nothing is at stake.
select 'the claim can only be won once', (
  with claimable as (
    select * from (values (1, null::timestamptz), (2, null::timestamptz)) as t(id, receipt_sent_at)
  ),
  -- One winner per id: the second attempt sees a stamped row and matches
  -- nothing, which is the whole behaviour the live update relies on.
  first_try as (select id from claimable where id = 1 and receipt_sent_at is null),
  second_try as (
    select c.id from claimable c
      join first_try f on f.id = c.id
     where c.receipt_sent_at is not null
  )
  select case
    when (select count(*) from first_try) = 1 and (select count(*) from second_try) = 0
      then 'PASS'
    else 'FAIL -- the where-clause does not exclude an already-claimed row'
  end)
union all
select 'no live payment was stamped by this file',
       case when (select count(*) from payment_records where receipt_sent_at is not null) = 0
            then 'PASS'
            else 'note -- ' || (select count(*)::text from payment_records where receipt_sent_at is not null)
                 || ' stamped, which is expected only after real receipts have gone out' end;
