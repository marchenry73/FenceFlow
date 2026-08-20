-- A ceiling on what one file can be.
--
-- Photos are compressed to roughly 300-500KB before upload, and surveys and
-- signatures are left alone deliberately (a survey carries the pixel space its
-- fence line is measured in; a signature is line art JPEG would smear). None of
-- those should approach 25MB.
--
-- This is a backstop, not the mechanism: if compression ever silently stops
-- working, the symptom should be one refused upload rather than a storage bill
-- and a crew's data allowance quietly disappearing. 25MB leaves room for an
-- uncompressed survey photo from a high-resolution phone.
update storage.buckets
set file_size_limit = 26214400
where id = 'job-files';

select id, public, file_size_limit from storage.buckets where id = 'job-files';
