-- Turn on the live change feed for the two tables that carry money.
--
-- Without this the app's Realtime subscription connects successfully and then
-- receives nothing, which is the worst of both worlds: it looks like it is
-- working. Postgres only publishes tables that are explicitly added to the
-- supabase_realtime publication.
--
-- Only jobs and job_payments. Publishing everything would stream every row of
-- every table to every signed-in phone, which is bandwidth on a work van's
-- data plan and a wider surface than is needed -- these two are what has to be
-- instant.
--
-- Row-level security still applies to the change feed, and the app filters on
-- company_id as well, so a phone only ever receives its own company's rows.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'jobs'
  ) then
    alter publication supabase_realtime add table public.jobs;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'job_payments'
  ) then
    alter publication supabase_realtime add table public.job_payments;
  end if;
end $$;

-- REPLICA IDENTITY FULL so an UPDATE carries the old row as well as the new.
-- Without it the feed reports that a row changed but not what it was, and the
-- filter on company_id cannot be applied to deletes at all.
alter table public.jobs replica identity full;
alter table public.job_payments replica identity full;
