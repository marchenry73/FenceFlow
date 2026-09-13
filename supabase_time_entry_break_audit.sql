-- Extends the existing correction audit trail (supabase_time_corrections.sql)
-- to cover recording an unpaid break, not just moving started_at/ended_at.
--
-- The office page now lets a manager set break_minutes from the same
-- "Correct this shift" sheet used for time corrections, with the same
-- required reason. Without this change, a break-only save (start/end left
-- as-is, only break_minutes set) would leave corrected_by / corrected_at
-- untouched, because preserve_original_shift() only looked at the two time
-- columns -- so "who recorded this break and when" would be unanswerable
-- from the database even though the office UI collected it. That is the
-- exact audit trail this task's rules require, so the trigger has to know
-- about the third column it now protects.
--
-- Nothing about the original-value preservation changes: break_minutes has
-- no "original" to protect (there is no clock-side break yet to contradict),
-- so this only widens the condition that stamps corrected_by/corrected_at.
create or replace function public.preserve_original_shift()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
    if new.started_at is distinct from old.started_at then
        new.original_started_at := coalesce(old.original_started_at, old.started_at);
    end if;

    if new.ended_at is distinct from old.ended_at then
        new.original_ended_at := coalesce(old.original_ended_at, old.ended_at);
    end if;

    if old.ended_at is null and new.ended_at is not null then
        new.original_ended_at := old.original_ended_at;
    end if;

    if (new.started_at is distinct from old.started_at)
       or (old.ended_at is not null and new.ended_at is distinct from old.ended_at)
       -- Added for breaks: a change to break_minutes is a pay-affecting edit
       -- exactly like a time correction, so it earns the same "who and when"
       -- stamp. `is distinct from` (not `!=`) so null -> a real number, and a
       -- real number -> null, both count; two equal nulls do not.
       or (new.break_minutes is distinct from old.break_minutes) then
        new.corrected_at := now();
        new.corrected_by := coalesce(auth.uid(), new.corrected_by);
    end if;

    return new;
end;
$$;

-- Belt-and-suspenders behind the office page's own check: the UI refuses a
-- break longer than the shift, but a script or a future client could still
-- write past it if only the app enforced it. Nullable break_minutes is left
-- alone by this constraint whenever either timestamp is missing, so a shift
-- still in progress (no ended_at yet) is never blocked from having a break
-- minutes value staged early.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'time_entries_break_not_longer_than_shift_chk'
  ) then
    alter table time_entries
      add constraint time_entries_break_not_longer_than_shift_chk
      check (
        break_minutes is null
        or started_at is null
        or ended_at is null
        or break_minutes <= extract(epoch from (ended_at - started_at)) / 60
      );
  end if;
end $$;

-- Undo:
--   drop constraint time_entries_break_not_longer_than_shift_chk;
--   recreate preserve_original_shift() from supabase_time_corrections.sql
--   to drop the break_minutes clause.
