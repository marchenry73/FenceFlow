-- The person whose hours were changed gets to say so.
--
-- The office can already correct a shift, and the original is preserved by
-- trigger so a correction can never quietly rewrite what the clock said. What
-- has been missing is the other half: the crew member finding out, and having
-- somewhere to disagree that is part of the record rather than a text message.
--
-- Three columns, all additive:
--   correction_seen_at      -- when the person whose shift it is looked at it
--   correction_disputed_at  -- when they said it is wrong
--   dispute_note            -- what they say actually happened
--
-- Deliberately NOT a status column. A dispute does not change the hours or the
-- pay; it puts a flag and a sentence beside them and leaves the office to
-- settle it. Rewriting the times on a disagreement is how the record stops
-- being a record.
alter table time_entries
  add column if not exists correction_seen_at     timestamptz,
  add column if not exists correction_disputed_at timestamptz,
  add column if not exists dispute_note           text;

comment on column time_entries.correction_disputed_at is
  'When the crew member said the corrected times are wrong. Never changes the hours -- the office settles it.';

-- ---------------------------------------------------------------------------
-- Only your own shift, and only through this door.
-- ---------------------------------------------------------------------------
-- time_entries_update is company-wide, so widening it would let anyone mark
-- anyone's shift disputed. These are SECURITY DEFINER and check that the
-- caller IS the person named on the row, by the same profile link the roster
-- uses, so the policy stays exactly as tight as it is.
create or replace function public.acknowledge_my_shift(shift_sync_id text)
returns boolean
language plpgsql security definer set search_path to 'public'
as $$
declare touched int;
begin
    update time_entries t
       set correction_seen_at = coalesce(t.correction_seen_at, now())
     where t.sync_id::text = shift_sync_id
       and t.company_id = public.current_company_id()
       and exists (select 1 from employees e
                    where e.company_id = t.company_id
                      and e.sync_id::text = t.employee_sync_id
                      and e.profile_id = auth.uid());
    get diagnostics touched = row_count;
    return touched > 0;
end;
$$;

create or replace function public.dispute_my_shift(shift_sync_id text, note text)
returns boolean
language plpgsql security definer set search_path to 'public'
as $$
declare touched int; clean text;
begin
    -- A dispute with no words is not a dispute the office can act on, and an
    -- unbounded one is a place to paste a novel into a payroll record.
    clean := left(btrim(coalesce(note, '')), 1000);
    if clean = '' then
        raise exception 'Say what was wrong with the hours.' using errcode = '23514';
    end if;
    update time_entries t
       set correction_disputed_at = now(),
           dispute_note = clean,
           correction_seen_at = coalesce(t.correction_seen_at, now())
     where t.sync_id::text = shift_sync_id
       and t.company_id = public.current_company_id()
       and exists (select 1 from employees e
                    where e.company_id = t.company_id
                      and e.sync_id::text = t.employee_sync_id
                      and e.profile_id = auth.uid());
    get diagnostics touched = row_count;
    return touched > 0;
end;
$$;

revoke execute on function public.acknowledge_my_shift(text) from public, anon;
revoke execute on function public.dispute_my_shift(text, text)  from public, anon;
grant  execute on function public.acknowledge_my_shift(text) to authenticated;
grant  execute on function public.dispute_my_shift(text, text)  to authenticated;

select 'shift dispute installed' as done;
