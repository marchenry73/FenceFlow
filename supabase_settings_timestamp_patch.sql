-- Settings need a timestamp, or the cloud always wins and local edits revert.
--
-- pull() overwrote every local setting with the cloud copy, with no comparison
-- of which was newer, on every session refresh. So a save whose push did not
-- land -- no signal, a failed RPC -- was silently undone on the next app start,
-- and it looked exactly like the save had never worked.
alter table company_settings
  add column if not exists updated_at timestamptz not null default now();

-- Approval has to survive the trip. Without these the cloud row cannot carry
-- it, so any device pulling a shift it does not already hold recreates it as
-- unapproved -- hours that were signed off come back as pending, which reads
-- as the approval not having saved.
alter table time_entries
  add column if not exists employee_sync_id text not null default '';

comment on column company_settings.updated_at is
  'When these settings were last changed. A pull only overwrites local values that are older than this.';
