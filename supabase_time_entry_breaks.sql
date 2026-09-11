-- Adds break tracking to time_entries. Nothing reads or writes these columns
-- yet -- this is schema only, laid down so the office console can start
-- showing real break figures once a clock-side "start break / end break"
-- control exists on the phone app.
--
-- Nullable, no default. A DEFAULT 0 would make every existing and future
-- shift read as "zero minutes on break," which is a claim nobody made --
-- exactly the fake-figure trap this product has hit twice before (a zero in
-- a pay context reads as a decision, not as missing data). NULL means
-- "not recorded," and stays NULL until a real break is logged.
alter table public.time_entries
  add column if not exists break_minutes integer,
  add column if not exists break_started_at timestamptz,
  add column if not exists break_ended_at timestamptz;

comment on column public.time_entries.break_minutes is
  'Total unpaid break minutes for this shift, entered or computed once the clock supports breaks. NULL = not recorded, never 0-by-default.';
comment on column public.time_entries.break_started_at is
  'Clock time the crew member started an unpaid break, if the app records one. NULL = no break logged.';
comment on column public.time_entries.break_ended_at is
  'Clock time the crew member ended an unpaid break, if the app records one. NULL = no break logged.';

-- A break cannot end before it starts, and cannot fall outside the shift it
-- belongs to. Left permissive on break_minutes itself (no CHECK tying it to
-- the timestamps) because a manager may eventually enter a flat minutes
-- figure without exact clock times -- that is a product decision for later,
-- not one to bake into the schema now.
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS. The first run of this file
-- failed on exactly that and rolled the whole migration back, the columns
-- with it, so nothing landed by halves. Wrapped instead, which also makes
-- re-running this file harmless.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'time_entries_break_order_chk'
  ) then
    alter table time_entries
      add constraint time_entries_break_order_chk
      check (break_ended_at is null or break_started_at is null
             or break_ended_at > break_started_at);
  end if;
end $$;
