-- SYNC FIX (2026-09-17): the owner's phone stopped uploading signatures.
--
-- supabase_sec_signature_objects.sql (F8) added a RESTRICTIVE UPDATE policy on
-- storage.objects that takes signature/ and final-sign-off/ out of reach of
-- every authenticated caller. That is the right rule for REPLACING a signed
-- contract image. It is the wrong rule for CREATING one, because the phone
-- asks for an upsert:
--
--     FileSync.upload(...) { upsert = true }        -- every kind, always
--
-- An upsert makes Storage check UPDATE permission on the object BEFORE it
-- writes, so the very first signature upload is refused (403) even though
-- nothing is being overwritten. FileSync swallows the failure and returns
-- null, so job.signature_storage_path stays null, the file is counted as
-- unsynced forever, sign-out is blocked ("work that hasn't uploaded"), and the
-- sync reports a failure the Account screen renders as "Could not reach the
-- cloud". It hits an OWNER exactly as hard as a crew member: the policy is
-- role-blind by design.
--
-- The primary fix is in the app (FileSync now uploads the two write-once kinds
-- without upsert). This file is the server half, and it does NOT weaken the
-- rule F8 installed:
--
--   * a signature object that has been written (metadata.size > 0) can never
--     be updated by any API caller -- exactly as before,
--   * an object row that exists but holds no bytes yet -- the placeholder
--     Storage creates before it streams the body, left behind by an upload
--     that was interrupted -- may be completed by the caller who owns it.
--
-- So "a crew phone replaces a homeowner's signature" is still impossible, and
-- "my own upload finishes" is possible again.

drop policy if exists job_files_signatures_are_write_once on storage.objects;
create policy job_files_signatures_are_write_once on storage.objects
    as restrictive for update to authenticated
    using (
        bucket_id <> 'job-files'
        or coalesce((storage.foldername(name))[3], '') not in ('signature', 'final-sign-off')
        or (owner = auth.uid()
            and coalesce(nullif(metadata ->> 'size', '')::bigint, 0) = 0)
    )
    with check (
        bucket_id <> 'job-files'
        or coalesce((storage.foldername(name))[3], '') not in ('signature', 'final-sign-off')
        or owner = auth.uid()
    );

select 'signature write-once kept; in-flight upload can finish' as done;
