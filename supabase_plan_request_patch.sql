-- Crew change REQUESTS, told apart from changes they simply made.
--
-- A report says the fence line already moved and the office needs to know. A
-- request says the crew think it should move and are standing there waiting.
-- Filing the second as the first means nobody realises a decision is owed, and
-- a crew waits all afternoon for an answer nobody knows they want.
alter table field_changes
  add column if not exists is_request boolean not null default false,
  add column if not exists approved_at timestamptz,
  add column if not exists rejected_at timestamptz,
  add column if not exists decided_by text not null default '',
  add column if not exists decision_note text not null default '';

-- Requests have to arrive without waiting for a heartbeat: somebody has
-- stopped work over this.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='field_changes'
  ) then
    alter publication supabase_realtime add table public.field_changes;
  end if;
end $$;
alter table public.field_changes replica identity full;
