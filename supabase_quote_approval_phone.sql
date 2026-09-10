-- Quote approval phone gate.
--
-- Today anyone holding a quote link can approve and sign it -- the link
-- itself is the only check. This adds a server-side gate on the APPROVE
-- step only (quote-view stays exactly as readable as it is today): the
-- homeowner must type the last four digits of the phone number on the job,
-- checked in supabase/functions/quote-view/index.ts, never in the browser.
--
-- Purely additive: two new columns on jobs, both nullable/defaulted, no
-- DROP, no ALTER of an existing column, no policy touched or replaced.
-- Safe to run any number of times.

-- How many wrong last-four guesses have landed on this job's quote since
-- the last correct one (or the last lockout). Reset to 0 on a correct
-- guess or once a lockout has been set.
alter table jobs
  add column if not exists quote_phone_attempts integer not null default 0;

-- Set once quote_phone_attempts reaches the limit inside quote-view; while
-- this is in the future, every approval attempt is refused outright with
-- the same wording as a wrong guess, without spending another attempt or
-- touching the counter. Null means "not locked."
alter table jobs
  add column if not exists quote_phone_locked_until timestamptz;

-- True only when a job had no usable phone number on it at the moment it
-- was approved, so the phone gate could not run and the approval went
-- through unchecked. This is the explicit record of that decision -- see
-- the DECISION comment in supabase/functions/quote-view/index.ts -- so a
-- look at the job afterwards shows the gate did not run instead of
-- silently assuming it did.
alter table jobs
  add column if not exists quote_approved_without_phone_check boolean not null default false;
