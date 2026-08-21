-- Removes the duplicate money the refund bug wrote, at March's request.
--
-- Five rows, tombstoned rather than deleted so every one is recoverable:
-- three repeats of John's refund (the screen did not move, so it was pressed
-- four times), Marco's hand-keyed copy of a card payment the webhook had
-- already recorded, and the duplicate refund that followed it.
update payment_records
   set deleted_at = now(),
       deleted_by = 'cleanup: duplicate written by the refund bug'
 where sync_id in (
    '3da8d23f-a1dc-44b2-804a-4936fc186411',
    '86c6719c-9fdf-47d2-803f-7d5f5f3316a1',
    'fb9253d7-bbaf-4cbe-8b6e-b208383f5272',
    'dc868566-71d0-4d8d-a900-6075bc4e1b37',
    '1ddbd77d-2f53-42a7-93a5-19ae9131b997'
 ) and deleted_at is null;

-- The job rows cache paid/refunded, and the sync keeps the higher paid figure
-- on purpose ("money that cleared is a fact"). A cleanup is the one legitimate
-- way the figure shrinks, so the caches are rebuilt here from the ledger --
-- otherwise the stale totals would win the next merge and undo this.
update jobs j
   set amount_paid     = coalesce(l.paid, 0),
       refunded_amount = coalesce(l.refunded, 0)
  from (
    select job_sync_id,
           sum(amount) filter (where amount > 0)      as paid,
           -sum(amount) filter (where amount < 0)     as refunded
    from payment_records
    where deleted_at is null
    group by job_sync_id
  ) l
 where l.job_sync_id = j.sync_id
   and j.customer_name in ('Marco','John');

select j.customer_name,
       round(j.amount_paid::numeric,2)     as paid,
       round(j.refunded_amount::numeric,2) as refunded,
       round((j.amount_paid - j.refunded_amount)::numeric,2) as net
from jobs j where j.customer_name in ('Marco','John');
