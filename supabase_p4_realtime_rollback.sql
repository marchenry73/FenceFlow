-- Rollback for supabase_p4_realtime_fix.sql: puts back exactly what was live
-- on 2026-09-21 before it (DELETE published; profiles, job_payments,
-- payment_records and field_changes at REPLICA IDENTITY FULL; jobs untouched).
--
-- Running this REOPENS the delete oracle described in the fix: anyone holding
-- the public anon key can learn, by value filter, whether another company's
-- hard-deleted rows matched. Only run it to undo a regression, and re-apply
-- the fix once the cause is understood.
begin;
set local lock_timeout = '5s';
alter publication supabase_realtime set (publish = 'insert, update, delete, truncate');
alter table public.profiles        replica identity full;
alter table public.job_payments    replica identity full;
alter table public.payment_records replica identity full;
alter table public.field_changes   replica identity full;
commit;

select format('publish ins=%s upd=%s del=%s', pubinsert, pubupdate, pubdelete) as state
  from pg_publication where pubname = 'supabase_realtime';
