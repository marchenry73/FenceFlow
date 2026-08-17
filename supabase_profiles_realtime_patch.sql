-- Access changes have to arrive in seconds, not at the next app restart.
--
-- The owner revoking someone's access is often not routine housekeeping -- it
-- is someone being cut off mid-action. Until now the app only re-read a
-- profile at startup or when the Account screen was opened, so a revoked
-- permission could sit unapplied on the other phone indefinitely.
--
-- Publishing profiles lets each device react the moment its own row changes.
-- RLS still applies to the feed, and the app filters to its own company.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;
end $$;

alter table public.profiles replica identity full;
