-- The paid-in-full fixture had no payments behind it.
--
-- I seeded "ZZ TEST Paid in full, finished" with amount_paid = 19,204 and
-- never wrote the payment rows that money would have come from. The ledger
-- check caught it within the hour, which is the check working exactly as
-- intended -- a job whose stored total disagrees with its own payment history
-- is the single most valuable thing that test looks for, and my own fixture
-- was the first thing it found.
--
-- Fixing it by adding the payments rather than by zeroing the job, because the
-- fixture exists to represent a finished, fully paid job. Zeroing it would
-- make the check pass and leave the fixture useless for the thing it is for.
--
-- Two payments rather than one: a deposit and a balance is what a real job of
-- this size looks like, and a fixture that only ever exercises the single
-- payment path is a fixture that hides the other one.
insert into payment_records (sync_id, company_id, job_sync_id, amount, method, received_at)
select gen_random_uuid()::text,
       '22222222-2222-4222-8222-222222222003',
       '33333333-0000-4000-8000-000000000004',
       v.amount, 'CARD', v.when_paid
  from (values
        (3840.00::numeric, now() - interval '290 days'),
        (15364.00::numeric, now() - interval '280 days')
       ) as v(amount, when_paid)
 where not exists (
       select 1 from payment_records p
        where p.job_sync_id::text = '33333333-0000-4000-8000-000000000004'
          and p.deleted_at is null);

-- Let the product's own mechanism do the arithmetic rather than typing a
-- number in. If recompute disagrees with what I seeded, I want to find that
-- out here rather than paper over it.
select public.recompute_job_totals(
         '22222222-2222-4222-8222-222222222003'::uuid,
         '33333333-0000-4000-8000-000000000004'::uuid);

select 'fixture ledger repaired' as done,
       (select amount_paid from jobs
         where sync_id = '33333333-0000-4000-8000-000000000004') as job_says,
       (select coalesce(sum(amount), 0) from payment_records
         where job_sync_id::text = '33333333-0000-4000-8000-000000000004'
           and deleted_at is null) as ledger_says;
