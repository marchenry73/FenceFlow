-- Crew-side notifications (app ui/crew/CrewAttention.kt), the schema side.
--
-- Four of the five alerts this task asked for shipped using data the phone
-- already syncs down -- see the app-side report for which. None of them
-- needed a new column here: a job's assigned_employee_id and
-- scheduled_date, a job's locate_expires_at, and a time_entry's
-- employee_sync_id / rejected_at / review_note, and a field_change's
-- changed_by / is_request / approved_at / rejected_at were all already
-- travelling to the phone before this task touched anything. WRITE AND
-- STOP applies to what follows, which is the one column the fifth alert
-- (an hours correction nobody has acknowledged) would need if it is ever
-- built.
--
-- That alert could not be built this round: it depends on
-- time_entries.corrected_at, original_started_at and correction_reason
-- (added by supabase_time_corrections.sql), and NONE of those three travel
-- to the phone today -- CloudTimeEntry, in the app's cloud/EntitySync.kt,
-- simply does not carry them. Wiring that sync is a change to cloud/**,
-- which is out of scope for the ui/**-only work this task was scoped to.
-- Leaving the alert out, per the no-fake-features rule, was the correct
-- call rather than inventing a "correction" signal from data that cannot
-- reach the device.
--
-- What follows is additive prep for whoever does that follow-up: a place on
-- the server for a crew member's phone to record "I saw this correction",
-- once corrections actually reach it. It is not read or written by any app
-- code shipped in this change -- there is nothing yet on the phone that
-- could set it. Adding it now, rather than when the sync work lands, means
-- that work is only cloud/EntitySync.kt plus one UI screen, not also a
-- database migration.
alter table time_entries
  add column if not exists crew_correction_seen_at timestamptz;

comment on column time_entries.crew_correction_seen_at is
  'When the crew member this shift belongs to acknowledged a correction to it on their phone. Null until the phone-side sync in a later change actually sets it -- see ui/crew/CrewAttention.kt for the alert this exists to support.';

-- Undo:
--   alter table time_entries drop column if exists crew_correction_seen_at;
