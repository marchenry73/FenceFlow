-- Seed the ledger from the authoritative cloud job totals.
--
-- The client migration backfills each device's own local amount_paid, which is
-- exactly the figure that had drifted -- so two devices produced two different
-- opening rows for the same job. The server's value is the one both devices
-- have been reconciling against, so it seeds the ledger and both then adopt it.
--
-- sync_id is derived from the job's sync_id, so this matches the id the client
-- migration generates and the two collapse into one row rather than doubling.
insert into payment_records
  (sync_id, company_id, job_sync_id, amount, method, received_at, note, recorded_by)
select
  'opening-' || j.sync_id::text,
  j.company_id,
  j.sync_id,
  j.amount_paid,
  'OTHER',
  coalesce(j.scheduled_date, j.created_at),
  'Recorded before the payments ledger existed',
  ''
from jobs j
where j.amount_paid > 0 and j.deleted_at is null
on conflict (company_id, sync_id) do update
  set amount = excluded.amount,
      received_at = excluded.received_at;

insert into payment_records
  (sync_id, company_id, job_sync_id, amount, method, received_at, note, recorded_by)
select
  'opening-refund-' || j.sync_id::text,
  j.company_id,
  j.sync_id,
  -j.refunded_amount,
  'OTHER',
  coalesce(j.refunded_at, j.scheduled_date, j.created_at),
  coalesce(nullif(j.refund_reason, ''), 'Refund recorded before the ledger existed'),
  ''
from jobs j
where j.refunded_amount > 0 and j.deleted_at is null
on conflict (company_id, sync_id) do update
  set amount = excluded.amount;
