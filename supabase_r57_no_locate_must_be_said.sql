-- "NO UTILITY LOCATE" HAS TO BE SOMETHING SOMEBODY SAID.
--
-- "The no utility locate is too open, need to close it."
--
-- WHAT WAS OPEN. LocateTicket.State has four values, and the first one is
-- NONE, documented as "No ticket recorded. Not a judgement -- some jobs need
-- no digging." That is honest, and it is the hole: a job where nobody has
-- called 811 yet and a job that needs no digging at all are the SAME state,
-- so neither can be chased. The screen says "No utility locate" for both, and
-- nothing anywhere treats one as a problem.
--
-- This splits them. locate_not_required is somebody DECIDING, with their
-- reason in locate_notes. A job without a ticket and without that decision is
-- now a gap the app can show the crew before they are standing in the yard
-- with an auger.
--
-- DEFAULT false, which means every job that exists reads as "nobody has said"
-- rather than as "no locate needed". That is the truth about them, and it is
-- the safe direction: the wrong way round would quietly mark seventy jobs as
-- needing no locate. The app only raises it on jobs that are still ahead
-- (scheduled from today onwards), so the back catalogue does not become a
-- wall of alerts about fences already in the ground.
--
-- WHAT IS NOT CHANGED, and the owner asked about it directly:
--
--   "NO need for the dig on or after or expires, I don't think we need that."
--
-- Nothing forces either of them now. Both columns are nullable, and
-- LocateTicket.stateOf reads a ticket number with no dates as CLEAR -- so he
-- can type the ticket number and ignore both fields entirely, today, with no
-- change at all. They are kept because the expiry is the one thing a busy
-- fortnight loses track of, which is the whole reason the feature exists:
-- "what they lose track of is the date, on the third job of a busy fortnight,
-- when the ticket was called two weeks ago and nobody remembers whether it is
-- still good." Keeping an optional field costs nothing; removing the only
-- thing that catches an expired ticket costs a struck gas line.

alter table public.jobs
  add column if not exists locate_not_required boolean not null default false;

comment on column public.jobs.locate_not_required is
  'Somebody has decided this job needs no utility locate (the reason goes in '
  'locate_notes). FALSE is "nobody has said", not "no locate needed" -- that '
  'is what makes a missing locate chaseable. See r57.';

-- Bookkeeping it is NOT: this is a person making a safety decision, so it
-- must move jobs.updated_at like any other edit and reach every device.
-- Deliberately absent from touch_updated_at's quiet list.

-- ---------------------------------------------------------------------------
-- Self-test.
-- ---------------------------------------------------------------------------
do $$
declare
  cid uuid; js uuid := gen_random_uuid();
  t0 constant timestamptz := '2020-01-01 00:00:00+00';
  after_edit timestamptz;
begin
  select id into cid from public.companies order by created_at limit 1;
  if cid is null then raise notice 'r57: no company to probe with; skipped'; return; end if;

  insert into public.jobs (company_id, sync_id, customer_name, status, is_test_fixture, updated_at)
  values (cid, js, 'ZZ R57 PROBE', 'ACCEPTED', true, t0);

  -- 1. A new job reads as "nobody has said".
  if (select locate_not_required from public.jobs where sync_id = js) <> false then
      raise exception 'r57 FAILED: a new job claims it needs no locate';
  end if;

  -- 2. Saying so sticks, and is LOUD -- it is a safety decision, not
  --    bookkeeping, so every device has to see it.
  update public.jobs set locate_not_required = true, locate_notes = 'no digging, panels on existing posts'
   where sync_id = js;
  if (select locate_not_required from public.jobs where sync_id = js) <> true then
      raise exception 'r57 FAILED: the decision did not stick';
  end if;
  select updated_at into after_edit from public.jobs where sync_id = js;
  if after_edit <= t0 then
      raise exception 'r57 FAILED: deciding no-locate did not move updated_at, so '
        'other devices would never learn about it';
  end if;

  delete from public.jobs where sync_id = js;
  raise notice 'r57 ok: the default is "nobody has said", and saying so is a loud edit';
end $$;

-- How many jobs this makes chaseable right now, and how many are old enough
-- not to matter. Reported, not acted on.
select 'jobs with no ticket and no decision' as check,
       count(*) as total,
       count(*) filter (where scheduled_date >= current_date) as still_ahead
from public.jobs
where coalesce(is_test_fixture, false) = false
  and deleted_at is null
  and coalesce(locate_ticket_no, '') = ''
  and locate_not_required = false;
