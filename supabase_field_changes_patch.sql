-- ============================================================
-- FenceFlow -- changes the crew makes on site
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- Purely additive: one new table and its policies. Nothing existing is
-- dropped, altered or rewritten.
--
-- Why: the crew can correct the plan on site -- they're standing at the fence
-- line and the drawing isn't. The app already records what changed, who
-- changed it and when, but only on the phone that made the change. Without
-- this table the manager on a different device never sees it, which defeats
-- the point: footage drives the estimate, the post count and the material
-- order, so a change the office never hears about is a job that quietly stops
-- matching what the customer agreed to pay.
-- ============================================================

create table if not exists field_changes (
    id              uuid primary key default gen_random_uuid(),
    company_id      uuid not null references companies(id) on delete cascade,
    sync_id         text not null,
    job_sync_id     text not null,
    summary         text not null default '',
    detail          text not null default '',
    changed_by      text not null default '',
    changed_by_role text not null default '',
    at              timestamptz not null default now(),
    acknowledged_at timestamptz
);

create unique index if not exists field_changes_sync_idx
    on field_changes (company_id, sync_id);
create index if not exists field_changes_job_idx
    on field_changes (job_sync_id);

alter table field_changes enable row level security;

-- Everyone in the company can see what changed. A crew member seeing that a
-- run got longer is useful, not sensitive -- there is no pricing here.
drop policy if exists field_changes_select on field_changes;
create policy field_changes_select on field_changes
    for select using (
        company_id = (select company_id from profiles where id = auth.uid())
    );

-- Anyone in the company can report a change; that is the whole point.
drop policy if exists field_changes_insert on field_changes;
create policy field_changes_insert on field_changes
    for insert with check (
        company_id = (select company_id from profiles where id = auth.uid())
    );

-- Only an owner, manager or foreman can mark a change as seen. Letting the
-- person who made the change also clear it would make the acknowledgement
-- meaningless.
drop policy if exists field_changes_update on field_changes;
create policy field_changes_update on field_changes
    for update using (
        company_id = (select company_id from profiles where id = auth.uid())
        and (select role::text from profiles where id = auth.uid())
            in ('OWNER', 'MANAGER', 'FOREMAN')
    );

-- Deleting stays owner-only, consistent with every other table.
drop policy if exists field_changes_delete_owner on field_changes;
create policy field_changes_delete_owner on field_changes
    for delete using (
        company_id = (select company_id from profiles where id = auth.uid())
        and (select role::text from profiles where id = auth.uid()) = 'OWNER'
    );
