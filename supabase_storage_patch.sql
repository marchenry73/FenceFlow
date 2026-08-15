-- ============================================================
-- FenceFlow -- cloud storage for signatures, surveys and photos
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- Additive: one private bucket and its access policies. Nothing existing is
-- touched.
--
-- Why: signatures, survey images and job photos were files on the phone that
-- made them and nowhere else. Change phones and a signed change order kept its
-- date and its amount but lost the signature -- exactly the part you would need
-- in a dispute.
--
-- Files are stored as {company_id}/{job_sync_id}/{kind}/{name}, so the first
-- path segment is the company and access can be scoped the same way the
-- database is.
-- ============================================================

-- Private on purpose. A signed contract and a customer's property photos are
-- not things to leave on a public URL.
insert into storage.buckets (id, name, public)
values ('job-files', 'job-files', false)
on conflict (id) do nothing;

-- ---------- Read: anyone in the owning company ----------
drop policy if exists job_files_read on storage.objects;
create policy job_files_read on storage.objects
    for select using (
        bucket_id = 'job-files'
        and (storage.foldername(name))[1] =
            (select company_id::text from profiles where id = auth.uid())
    );

-- ---------- Write: anyone in the company ----------
-- The crew take the before-and-after photos and collect signatures on site, so
-- upload cannot be limited to the office.
drop policy if exists job_files_insert on storage.objects;
create policy job_files_insert on storage.objects
    for insert with check (
        bucket_id = 'job-files'
        and (storage.foldername(name))[1] =
            (select company_id::text from profiles where id = auth.uid())
    );

drop policy if exists job_files_update on storage.objects;
create policy job_files_update on storage.objects
    for update using (
        bucket_id = 'job-files'
        and (storage.foldername(name))[1] =
            (select company_id::text from profiles where id = auth.uid())
    );

-- ---------- Delete: owner only ----------
-- Consistent with every table: a deleted signature is evidence destroyed, and
-- there is no undo.
drop policy if exists job_files_delete on storage.objects;
create policy job_files_delete on storage.objects
    for delete using (
        bucket_id = 'job-files'
        and (storage.foldername(name))[1] =
            (select company_id::text from profiles where id = auth.uid())
        and (select role::text from profiles where id = auth.uid()) = 'OWNER'
    );

-- ---------- Matching columns on the tables ----------
alter table jobs          add column if not exists survey_storage_path    text;
alter table jobs          add column if not exists signature_storage_path text;
alter table change_orders add column if not exists signature_storage_path text;
