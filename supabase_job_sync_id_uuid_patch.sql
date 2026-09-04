-- Two job_sync_id columns are text; every other one is uuid.
--
-- jobs.sync_id is uuid, and so is job_sync_id on expenses, fence_runs,
-- estimate_line_items, change_orders, job_steps, site_markers, time_entries,
-- punch_list_items and payment_records. job_payments and field_changes were
-- created with text. Nothing joins them to jobs in SQL today, so nothing is
-- broken -- but the reporting functions join every other child table with
-- "m.job_sync_id = j.sync_id", and the first person to write that against
-- these two gets "operator does not exist: uuid = text". A uuid column also
-- refuses a malformed id at write time, where text would take anything and
-- then silently never match.
--
-- Checked live before writing this: all 16 job_payments rows hold valid
-- uuids, field_changes is empty, and no policy, function or view compares
-- either column as text. The three indexes on them are rebuilt by the ALTER
-- itself. The tables are tiny, so the rewrite is instant; the lock is held
-- for that instant.
--
-- Not a data change: the same values, in the type they always were.

alter table public.job_payments
    alter column job_sync_id type uuid using job_sync_id::uuid;

alter table public.field_changes
    alter column job_sync_id type uuid using job_sync_id::uuid;

-- Proof, run afterwards: both must say uuid.
-- select table_name, data_type from information_schema.columns
--  where column_name = 'job_sync_id' and table_name in ('job_payments','field_changes');
