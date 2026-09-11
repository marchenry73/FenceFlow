-- Writing off two payments that belong to no job.
--
-- March's instruction, 10 September, after being shown them: the jobs around
-- them are test jobs, write the payments off.
--
-- $1,000 and $2,000, both cash, both recorded on 18 August at Fence solutions
-- against job 86d9ac37-f640-4bbe-80ad-d41377bfbedd -- an id that exists
-- nowhere in the jobs table, not even as a tombstone. The job was created and
-- lost; the money it carried survived and has been sitting in the ledger
-- attached to nothing ever since, invisible to that job's history, to
-- ar_aging() and to job_costing(), because there is no job to attach it to.
--
-- SOFT delete, not a real one. Every other deletion in this product writes a
-- tombstone rather than removing the row, for the same reason: a payment that
-- turns out to have been real must be recoverable, and an audit that cannot
-- see what was written off is not an audit. The row stays, carrying who did
-- this and when.
--
-- Scoped by the exact orphan id AND by the absence of a matching job, so this
-- statement cannot touch a payment that belongs to something. If the job ever
-- reappears, this writes off nothing.
update payment_records p
   set deleted_at = now(),
       deleted_by = 'written off 2026-09-10: job never existed'
 where p.deleted_at is null
   and p.job_sync_id::text = '86d9ac37-f640-4bbe-80ad-d41377bfbedd'
   and not exists (select 1 from jobs j
                    where j.company_id = p.company_id
                      and j.sync_id::text = p.job_sync_id::text);

select 'written off' as done,
       (select count(*) from payment_records p
         where p.deleted_at is null
           and not exists (select 1 from jobs j
                            where j.company_id = p.company_id
                              and j.sync_id::text = p.job_sync_id::text)) as orphans_left,
       (select count(*) from payment_records
         where deleted_by like 'written off 2026-09-10%') as written_off;
