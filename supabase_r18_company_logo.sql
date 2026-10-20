-- ============================================================
-- FenceFlow -- a company's own logo on the documents its customers see
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- ADDITIVE. One private bucket, four policies on it, and one column on
-- companies. No existing policy, column, function or trigger is changed, and
-- nothing is deleted or backfilled.
--
-- WHY. A fencing company's quote goes out under its own name and its own
-- phone number and prints its licence number, and then carries no mark of
-- whose business it is. The contractor is handing a customer a document that
-- looks like software output. The logo is the cheapest thing that makes it
-- look like their company's paperwork.
--
-- WHERE IT APPEARS (decided with March): the PDF quote and contract the phone
-- produces, the quote page the customer opens, and the emails sent to the
-- customer. Deliberately NOT in the app's or the office's own header -- staff
-- know which company they work for, and a logo there is just less room for
-- the work.
--
-- ------------------------------------------------------------------------
-- PART 1  the bucket
-- ------------------------------------------------------------------------
--
-- PRIVATE, which was March's call when the alternative was put to him. A
-- public bucket would have been one less moving part for the email and the
-- quote page, but it also means every company's logo is readable by anyone
-- who can guess a company id, and `public` on a bucket is not a per-file
-- decision -- it is the whole bucket, for ever, including whatever anybody
-- uploads into it later. Signing a URL costs one line in the two places that
-- serve one.
--
-- The same shape as job-files (supabase_storage_patch.sql): the first path
-- segment is the company id, so storage can be scoped exactly the way every
-- table is. Paths are {company_id}/logo-{uuid}.{ext} -- a new name on every
-- upload rather than a fixed `logo.png`, because overwriting one path means a
-- browser, an email client and a CDN can all keep showing the old image with
-- nothing able to tell them otherwise.
--
-- Raster only. PNG, JPEG and WEBP, and NOT image/svg+xml, which the original
-- request suggested: an SVG is a document that can carry script, and although
-- every surface here renders it in an <img> (where script does not run), a
-- signed URL opened directly in a browser would run it on the Supabase
-- domain. Nobody's logo needs to be an SVG badly enough to accept that.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'company-logos', 'company-logos', false,
    2097152,                                            -- 2 MB; a logo is not a photograph
    array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
    set public             = false,
        file_size_limit    = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

-- ---------- Read: anyone in the owning company ----------
-- Including CREW. The logo is not money and not a customer's details, and a
-- crew phone caches it the same way an office one does -- see the column
-- below for why this read, not company_settings, is where the path lives.
drop policy if exists company_logos_read on storage.objects;
create policy company_logos_read on storage.objects
    for select using (
        bucket_id = 'company-logos'
        and (storage.foldername(name))[1] =
            (select company_id::text from public.profiles where id = auth.uid())
    );

-- ---------- Write and remove: the OWNER, and only of their own company ----------
-- Matches who may change the rest of the customer-facing record: companies_update
-- is OWNER-only, so anyone who could upload a logo but not record its path
-- would be able to fill the bucket and change nothing. One rule, both halves.
drop policy if exists company_logos_insert on storage.objects;
create policy company_logos_insert on storage.objects
    for insert with check (
        bucket_id = 'company-logos'
        and (storage.foldername(name))[1] =
            (select company_id::text from public.profiles where id = auth.uid())
        and (select role::text from public.profiles where id = auth.uid()) = 'OWNER'
    );

drop policy if exists company_logos_update on storage.objects;
create policy company_logos_update on storage.objects
    for update using (
        bucket_id = 'company-logos'
        and (storage.foldername(name))[1] =
            (select company_id::text from public.profiles where id = auth.uid())
        and (select role::text from public.profiles where id = auth.uid()) = 'OWNER'
    );

-- Deletion IS allowed here, unlike job-files, and the difference is on
-- purpose: a signed contract is evidence and a logo is a picture. Replacing a
-- logo uploads a new name, so the old object has to be removable or the
-- bucket grows for ever.
drop policy if exists company_logos_delete on storage.objects;
create policy company_logos_delete on storage.objects
    for delete using (
        bucket_id = 'company-logos'
        and (storage.foldername(name))[1] =
            (select company_id::text from public.profiles where id = auth.uid())
        and (select role::text from public.profiles where id = auth.uid()) = 'OWNER'
    );

-- ------------------------------------------------------------------------
-- PART 2  where the path is recorded -- ONE store, and why
-- ------------------------------------------------------------------------
--
-- supabase_company_business_record.sql is the reason this needs saying out
-- loud. Business name, phone and licence number live in TWO places -- the
-- companies row that every server function reads, and the company_settings
-- JSONB blob that the phone reads -- and the office panel wrote only the
-- blob, so a company that renamed itself kept quoting under the old name for
-- ever. The fix mirrored into both, because by then both had readers.
--
-- This column has no legacy reader, so it gets ONE home and avoids inheriting
-- that problem:
--
--   * companies.logo_path, and not settings->>'logo_path'.
--
-- That works for every reader there is:
--   - quote-view and the mail functions hold the service role and already
--     read companies for name, phone and email;
--   - the PHONE can read it too, because companies_read
--     (supabase_schema.sql) is `id = current_company_id()` with no role test,
--     so an OWNER, a MANAGER and a CREW member all see their own company row.
--     company_settings, by contrast, is hidden from anyone without SEE_MONEY
--     (supabase_sec_company_reads.sql), which is exactly why SettingsSync has
--     a crew_settings() fallback. A logo in the blob would have been invisible
--     to a crew phone for no reason at all.
--
-- Empty string, not null, like name/phone/license_no beside it, so no reader
-- has to answer the "null or blank" question twice.
alter table public.companies
    add column if not exists logo_path text not null default '';

comment on column public.companies.logo_path is
    'Object path in the private company-logos bucket, {company_id}/logo-{uuid}.{ext}, '
    'or '''' for a company with no logo. The ONLY store for this -- deliberately not '
    'mirrored into the company_settings blob; see supabase_r18_company_logo.sql PART 2. '
    'Written by the OWNER through companies_update; not clamped by protect_billing_columns().';

-- ------------------------------------------------------------------------
-- PART 3  prove what landed. Every row must read true.
--
-- Each check that reads a definition is paired with a CANARY that must find
-- something really there, so a test cannot pass by looking at nothing: a
-- misspelled policy name, a missing function or an empty prosrc would make
-- the plain `not like` checks below pass while proving nothing.
-- ------------------------------------------------------------------------

select 'the bucket exists and is PRIVATE' as check,
       exists (select 1 from storage.buckets where id = 'company-logos' and public = false) as ok
union all
select 'it caps uploads at 2 MB and accepts only png/jpeg/webp (no svg)',
       exists (select 1 from storage.buckets
                where id = 'company-logos'
                  and file_size_limit = 2097152
                  and allowed_mime_types @> array['image/png','image/jpeg','image/webp']
                  and not (allowed_mime_types @> array['image/svg+xml']))
union all
select 'all four policies are on it',
       (select count(*) from pg_policies
         where schemaname = 'storage' and tablename = 'objects'
           and policyname in ('company_logos_read','company_logos_insert',
                              'company_logos_update','company_logos_delete')) = 4
union all
select 'CANARY: the policy test can read a real policy definition (so the role checks below are reading something)',
       exists (select 1 from pg_policies
                where schemaname = 'storage' and tablename = 'objects'
                  and policyname = 'company_logos_read' and qual is not null)
union all
select 'read is company-scoped and does NOT require OWNER (a crew phone can fetch the logo)',
       (select qual from pg_policies
         where schemaname = 'storage' and tablename = 'objects'
           and policyname = 'company_logos_read') like '%company_id%'
   and (select qual from pg_policies
         where schemaname = 'storage' and tablename = 'objects'
           and policyname = 'company_logos_read') not like '%OWNER%'
union all
select 'every write policy requires OWNER',
       (select count(*) from pg_policies
         where schemaname = 'storage' and tablename = 'objects'
           and policyname in ('company_logos_insert','company_logos_update','company_logos_delete')
           and coalesce(qual, '') || coalesce(with_check, '') like '%OWNER%') = 3
union all
select 'companies.logo_path exists, is text, NOT NULL, defaults to '''''
       ,exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'companies'
                   and column_name = 'logo_path' and data_type = 'text'
                   and is_nullable = 'NO' and column_default like '%''''::text%')
union all
select 'no company has a logo recorded yet, so nothing existing changed meaning',
       (select count(*) from public.companies where coalesce(logo_path,'') <> '') = 0
union all
select 'protect_billing_columns() does not clamp logo_path, so the OWNER''s update really lands',
       (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'protect_billing_columns')
         not like '%new.logo_path%'
union all
-- CANARY for the row above: the same body DOES clamp real columns, so a
-- wrong function name or an empty body could not pass by having nothing to find.
select 'CANARY: protect_billing_columns really clamps something (suspended, stripe_account_id)',
       (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'protect_billing_columns')
         like '%new.suspended%'
   and (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'protect_billing_columns')
         like '%new.stripe_account_id%'
union all
select 'the OWNER-only companies_update policy this relies on is still what it was',
       exists (select 1 from pg_policies
                where schemaname = 'public' and tablename = 'companies'
                  and cmd = 'UPDATE' and policyname = 'companies_update'
                  and qual like '%OWNER%')
union all
select 'companies_read has no role test, which is what lets a crew phone read the path',
       (select qual from pg_policies
         where schemaname = 'public' and tablename = 'companies'
           and policyname = 'companies_read') not like '%role%'
union all
-- CANARY for the row above.
select 'CANARY: companies_read really is a company-scoped policy, not a missing one',
       (select qual from pg_policies
         where schemaname = 'public' and tablename = 'companies'
           and policyname = 'companies_read') like '%current_company_id%';
