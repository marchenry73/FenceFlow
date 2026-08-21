-- Utility locate tickets, with their clock.
--
-- The app links to call811.com and stops there. A locate has a ticket number,
-- a legally required wait before anyone may dig, and an expiry after which it
-- is void -- and digging outside that window is the most expensive mistake
-- available in fencing: a struck gas line is an evacuation, a struck fibre is
-- a five-figure invoice, and both are the contractor's liability.
--
-- Tracking it is not a convenience feature. It is the liability protection
-- that a contractor is actually buying.
alter table public.jobs
  add column if not exists locate_ticket_no    text not null default '',
  -- When the locate was called in.
  add column if not exists locate_called_at    timestamptz,
  -- The earliest anyone may dig. Set by the utility, not by us -- states
  -- differ, so it is recorded rather than calculated.
  add column if not exists locate_dig_after    timestamptz,
  -- After this the ticket is void and has to be called again.
  add column if not exists locate_expires_at   timestamptz,
  add column if not exists locate_notes        text not null default '';

/**
 * What the locate situation is for a job, in one word.
 *
 * Computed rather than stored so it cannot go stale -- a status column saying
 * "clear to dig" three weeks after the ticket expired is worse than no column.
 */
create or replace function public.locate_state(j public.jobs)
returns text language sql immutable as $$
    select case
        when coalesce(j.locate_ticket_no, '') = '' then 'none'
        when j.locate_expires_at is not null and j.locate_expires_at <= now() then 'expired'
        when j.locate_dig_after  is not null and j.locate_dig_after  >  now() then 'waiting'
        else 'clear'
    end;
$$;

select 'locate ticket columns installed' as done;
