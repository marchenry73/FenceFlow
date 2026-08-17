-- Clock-outs wait for approval before they count.
--
-- Existing rows are approved in place. Retroactively marking every shift ever
-- worked as "pending" would bury a manager under months of history and make the
-- queue useless on the day it appears.
alter table time_entries
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by text not null default '',
  add column if not exists rejected_at timestamptz,
  add column if not exists review_note text not null default '';

update time_entries
   set approved_at = ended_at,
       approved_by = 'Recorded before approval existed'
 where ended_at is not null and approved_at is null and rejected_at is null;

comment on column time_entries.approved_at is
  'Signed off by a manager or owner. Until this is set the hours do not count towards pay or job cost.';
