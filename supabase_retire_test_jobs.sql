-- Retiring three test jobs that have been distorting every money figure.
--
-- March's instruction, 10 September, after being shown the numbers: these are
-- test jobs, delete them. They sit in the real operating company, Fence
-- solutions, and their payments disagree wildly with their contracts:
--
--   John              contract  9,850   paid 46,975   5 payments
--   John Beaunissant  contract 53,640   paid 38,669   6 payments
--   Marco             contract 22,040   paid 31,685   5 payments
--
-- The paid figures agree with the payment ledger, so the money is recorded
-- exactly as it was entered. It is the jobs that are not real. While they
-- exist, profit, margin and the aging report for this company are meaningless.
--
-- SOFT delete throughout -- a tombstone, not a removal. That is how every
-- deletion in this product works, and the reason applies here more than
-- anywhere: this is three jobs and sixteen payments totalling over a hundred
-- thousand dollars, and if any of it turns out to have been real it has to
-- come back. The rows stay, carrying who retired them and why, and the Deleted
-- Items screen can restore them.
--
-- The children go too. A tombstoned job with live line items and payments
-- hanging off it leaves the reports still summing them -- job_costing and
-- ar_aging scope by job, but the ledger checks and the orphan check in
-- scripts/whats-wrong.mjs read the payment rows directly, and would report
-- sixteen payments pointing at a job that no longer exists. That is exactly
-- the state this session spent an hour untangling two payments out of.
do $$
declare
    co uuid := (select id from companies where name = 'Fence solutions');
    mark text := 'retired 2026-09-10: test job, confirmed by March';
    ids uuid[];
    n_jobs int; n_pay int; n_items int; n_shifts int; n_runs int;
begin
    if co is null then
        raise exception 'Fence solutions not found -- refusing to guess which company.';
    end if;

    select array_agg(sync_id) into ids
      from jobs
     where company_id = co and deleted_at is null
       and customer_name in ('John', 'John Beaunissant', 'Marco');

    if ids is null or array_length(ids, 1) <> 3 then
        raise exception 'Expected exactly 3 test jobs, found %. Refusing to act on a different set.',
            coalesce(array_length(ids, 1), 0);
    end if;

    update payment_records set deleted_at = now(), deleted_by = mark
     where company_id = co and deleted_at is null and job_sync_id::text = any (select unnest(ids)::text);
    get diagnostics n_pay = row_count;

    update estimate_line_items set deleted_at = now(), deleted_by = mark
     where company_id = co and deleted_at is null and job_sync_id::text = any (select unnest(ids)::text);
    get diagnostics n_items = row_count;

    update time_entries set deleted_at = now(), deleted_by = mark
     where company_id = co and deleted_at is null and job_sync_id::text = any (select unnest(ids)::text);
    get diagnostics n_shifts = row_count;

    update fence_runs set deleted_at = now(), deleted_by = mark
     where company_id = co and deleted_at is null and job_sync_id::text = any (select unnest(ids)::text);
    get diagnostics n_runs = row_count;

    update jobs set deleted_at = now(), deleted_by = mark
     where company_id = co and deleted_at is null and sync_id = any (ids);
    get diagnostics n_jobs = row_count;

    raise notice 'retired % jobs, % payments, % line items, % shifts, % runs',
        n_jobs, n_pay, n_items, n_shifts, n_runs;
end $$;

select 'test jobs retired' as done,
       (select count(*) from jobs j where j.company_id=(select id from companies where name='Fence solutions')
          and j.deleted_at is null) as jobs_left,
       (select count(*) from payment_records p
         where p.deleted_at is null
           and not exists (select 1 from jobs j where j.company_id=p.company_id
                            and j.sync_id::text=p.job_sync_id::text)) as orphan_payments;
