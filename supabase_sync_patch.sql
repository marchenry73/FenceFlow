-- ============================================================
-- FenceFlow -- SYNC PATCH (run after supabase_schema.sql and
-- supabase_security_patch.sql)
-- Paste into: Supabase Dashboard -> SQL Editor -> New query -> Run
--
-- Adds a device-generated unique id per job.
--
-- Why: sync previously matched jobs on (company_id, local_id), but local_id
-- is Room's per-phone auto-increment. Two crew phones each creating their
-- first job would BOTH call it id 1, and they would silently overwrite each
-- other in the shared cloud. sync_id is a UUID minted on the device that
-- created the job, so it is unique across every phone on the team.
-- ============================================================

alter table jobs add column if not exists sync_id uuid;

-- Backfill anything already synced under the old scheme.
update jobs set sync_id = gen_random_uuid() where sync_id is null;

alter table jobs alter column sync_id set default gen_random_uuid();
alter table jobs alter column sync_id set not null;

-- One row per job per company, enforced by the database rather than by
-- hopeful client code.
create unique index if not exists jobs_company_sync_id_idx
    on jobs (company_id, sync_id);

-- Keep updated_at honest so last-edit-wins has something trustworthy to
-- compare. Doing this in a trigger means it is correct even if a client
-- forgets to send it.
create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end $$;

drop trigger if exists jobs_touch_updated_at on jobs;
create trigger jobs_touch_updated_at
    before update on jobs
    for each row execute function touch_updated_at();
