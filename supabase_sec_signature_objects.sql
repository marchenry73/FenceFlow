-- F8 (P2): job_files_update let ANY company member overwrite any object in the
-- company folder, including the signed-contract images under signature/ and
-- final-sign-off/. The Storage API's upsert path goes through exactly this
-- policy, so a crew phone could replace a homeowner's signature with anything.
--
-- Signatures are written once, under a unique timestamped name, so nothing in
-- the product ever needs to overwrite one. Additive RESTRICTIVE policy: the
-- existing company scoping still applies, this only takes the two signed
-- folders out of reach of an UPDATE. Deletes were already OWNER-only.

drop policy if exists job_files_signatures_are_write_once on storage.objects;
create policy job_files_signatures_are_write_once on storage.objects
    as restrictive for update to authenticated
    using (
        bucket_id <> 'job-files'
        or coalesce((storage.foldername(name))[3], '') not in ('signature', 'final-sign-off')
    )
    with check (
        bucket_id <> 'job-files'
        or coalesce((storage.foldername(name))[3], '') not in ('signature', 'final-sign-off')
    );
