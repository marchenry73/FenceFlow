-- ============================================================
-- FenceFlow -- a logo bigger than 2 MB is allowed in, and shrunk on the way
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- ADDITIVE. One bucket's file_size_limit. No policy, column, function or
-- trigger is touched, nothing is deleted, and the four company_logos policies
-- from supabase_r18_company_logo.sql still decide who may write.
--
-- WHY. r18 set the bucket to 2 MB on the reasoning that a logo is a small
-- file. It is -- once somebody has made it small. What a contractor actually
-- has is whatever came back from whoever drew their sign: a 4000px PNG off a
-- phone camera, a screenshot of a letterhead, an export nobody resized. Those
-- are 5 to 15 MB, and the honest 2 MB refusal ("save it smaller and try
-- again") asks them to go and learn an image editor before they can put their
-- own name on a quote. March's call, 21 October 2026: take the big file.
--
-- 20 MB, which covers a camera photo of a sign with room to spare and is well
-- under Supabase's own project-wide upload ceiling, so this limit is the one
-- that actually applies.
--
-- THE FILE THAT LANDS IS STILL SMALL. The limit is what the bucket will
-- ACCEPT; it is not what gets stored. The office and the app both downscale
-- before upload (long edge capped, re-encoded), so what reaches storage is
-- the same few hundred KB it always was. This limit exists so the ORIGINAL is
-- not refused before anything has had a chance to shrink it -- and as the
-- backstop for the case the downscale is skipped or fails: a 20 MB object in
-- a private bucket, one per company, is not a problem; a contractor who
-- cannot show their own logo is.
--
-- Raster only, unchanged: image/png, image/jpeg, image/webp. NOT svg -- see
-- r18 PART 1 for why, and nothing here reopens it.
-- ============================================================

update storage.buckets
   set file_size_limit = 20971520          -- 20 MB
 where id = 'company-logos';

-- ------------------------------------------------------------------------
-- PROOF. Read it back rather than trusting the update's own row count: a
-- bucket that does not exist takes the UPDATE silently and reports zero.
-- ------------------------------------------------------------------------
select 'bucket exists' as check,
       case when exists (select 1 from storage.buckets where id = 'company-logos')
            then 'PASS' else 'FAIL -- r18 was never run' end as result
union all
select 'limit is 20 MB',
       coalesce((select case when file_size_limit = 20971520 then 'PASS'
                             else 'FAIL -- reads ' || coalesce(file_size_limit::text, 'null') end
                   from storage.buckets where id = 'company-logos'), 'FAIL -- no bucket')
union all
select 'still private',
       coalesce((select case when public is false then 'PASS' else 'FAIL -- bucket went public' end
                   from storage.buckets where id = 'company-logos'), 'FAIL -- no bucket')
union all
select 'still raster only',
       coalesce((select case when allowed_mime_types @> array['image/png','image/jpeg','image/webp']
                              and not (allowed_mime_types @> array['image/svg+xml'])
                             then 'PASS'
                             else 'FAIL -- reads ' || coalesce(array_to_string(allowed_mime_types, ','), 'any') end
                   from storage.buckets where id = 'company-logos'), 'FAIL -- no bucket')
union all
select 'write still owner-only',
       case when (select count(*) from pg_policies
                   where schemaname = 'storage' and tablename = 'objects'
                     and policyname in ('company_logos_insert','company_logos_update','company_logos_delete')
                     and coalesce(qual, with_check) like '%OWNER%') = 3
            then 'PASS' else 'FAIL -- a logo write policy no longer names OWNER' end;
