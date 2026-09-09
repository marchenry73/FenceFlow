-- Manager time correction, with the original kept.
--
-- A crew member clocks in at 8:47 because they were already carrying panels at
-- 8:30. The office has to be able to fix that. What the office must never be
-- able to do is quietly rewrite what the clock said, because the clock is the
-- record a pay dispute is settled from.
--
-- So the correction is an addition, never a replacement: started_at and
-- ended_at hold the corrected time and are what pay is calculated from, and
-- original_started_at / original_ended_at hold what the clock actually said.
--
-- The preserving is done by a trigger rather than by the office page, because
-- "the original is kept" has to be true no matter which client wrote the row --
-- the office, a phone, a script, or me at a SQL prompt.
alter table time_entries
  add column if not exists original_started_at timestamptz,
  add column if not exists original_ended_at   timestamptz,
  add column if not exists corrected_by        uuid references profiles(id),
  add column if not exists corrected_at        timestamptz,
  add column if not exists correction_reason   text;

comment on column time_entries.original_started_at is
  'What the clock said before anyone corrected it. Written once, by trigger, and never overwritten.';

create or replace function public.preserve_original_shift()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
    -- Only when the times actually move. A sync rewriting a row with identical
    -- values is not a correction, and treating it as one would bury the real
    -- correction under a pile of noise.
    if new.started_at is distinct from old.started_at then
        -- coalesce, so the FIRST original survives. A second correction must
        -- not overwrite what the clock originally said with what the previous
        -- correction said -- that would launder an edit into the record.
        new.original_started_at := coalesce(old.original_started_at, old.started_at);
    end if;

    if new.ended_at is distinct from old.ended_at then
        new.original_ended_at := coalesce(old.original_ended_at, old.ended_at);
    end if;

    -- Clocking out for the first time is not a correction: the shift simply
    -- ended. Only an edit to a time that was already set counts.
    if old.ended_at is null and new.ended_at is not null then
        new.original_ended_at := old.original_ended_at;
    end if;

    if (new.started_at is distinct from old.started_at)
       or (old.ended_at is not null and new.ended_at is distinct from old.ended_at) then
        new.corrected_at := now();
        new.corrected_by := coalesce(auth.uid(), new.corrected_by);
    end if;

    return new;
end;
$$;

drop trigger if exists preserve_original_shift_trg on time_entries;
create trigger preserve_original_shift_trg
  before update on time_entries
  for each row execute function public.preserve_original_shift();

-- Undo:
--   drop trigger if exists preserve_original_shift_trg on time_entries;
--   drop function if exists public.preserve_original_shift();
--   alter table time_entries drop column if exists original_started_at, ...
