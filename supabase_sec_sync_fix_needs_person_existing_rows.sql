-- The phone's insert-only sync pass is refused, for ever, by three old shifts.
--
-- Sync pushes time_entries in an insert-only pass first: an upsert with
-- Prefer: resolution=ignore-duplicates, on_conflict=company_id,sync_id, which
-- PostgREST turns into
--
--     INSERT ... ON CONFLICT (company_id, sync_id) DO NOTHING
--
-- Rows the server already holds are meant to fall through that ON CONFLICT
-- untouched. They never reach it. time_entry_needs_a_person is a BEFORE
-- INSERT row trigger, and Postgres runs BEFORE INSERT triggers on every
-- candidate row BEFORE it looks for a conflict -- the conflict check happens
-- at the heap insert, after the row triggers have had their say. So for the
-- three real shifts on this database whose employee_sync_id is blank
-- (recorded before the guard existed, deliberately left alone by
-- supabase_shift_needs_a_person.sql because they are field data), the guard
-- sees a blank INSERT and raises 'This shift is not linked to a crew
-- member...'. PostgREST fails the whole batch, the phone reports that it
-- could not reach the cloud, and the same three rows do it again on the next
-- sync, and the one after that. The UPDATE branch already tolerates an
-- already-blank row staying blank; the INSERT branch had no way to know that
-- the row it was refusing was already on the server.
--
-- The fix: in the INSERT branch, if a row with this (company_id, sync_id)
-- already exists, return new at once and let ON CONFLICT decide.
--
-- Why that gives nothing away. time_entries_company_sync_idx is UNIQUE on
-- (company_id, sync_id), so an INSERT whose key already exists can only end
-- three ways, and none of them stores an unchecked employee_sync_id:
--
--   ON CONFLICT DO NOTHING   the candidate row is discarded; the stored row
--                            is not touched (the phone's insert-only pass).
--   ON CONFLICT DO UPDATE    the stored row is UPDATEd, which fires the BEFORE
--                            UPDATE triggers -- including the UPDATE branch
--                            below, which still refuses clearing the person
--                            or moving the shift onto somebody not ours (the
--                            phone's merge pass).
--   no ON CONFLICT           unique_violation; nothing stored.
--
-- A genuinely new key is checked exactly as before: blank is refused, a
-- person from another company is refused. Adding ON CONFLICT to a NEW row
-- changes nothing, because the early return only happens when the key is
-- already there.
--
-- The existence check runs inside this SECURITY DEFINER function with
-- search_path pinned to public, so it sees the stored row whether or not the
-- caller's RLS would -- the same view of the table that ON CONFLICT itself
-- has. Unchanged: signature, SECURITY DEFINER, search_path, the UPDATE branch,
-- every message and error code.
create or replace function public.time_entry_needs_a_person()
returns trigger
language plpgsql
security definer set search_path to 'public'
as $$
declare
    named         boolean;
    already_there boolean;
begin
    if tg_op = 'INSERT' then
        -- A row with this key is already on the server. This INSERT is the
        -- phone's ignore-duplicates pass (or a merge pass) re-sending it, and
        -- BEFORE INSERT fires before Postgres reaches ON CONFLICT, so refusing
        -- here refuses the whole sync batch for ever. Let ON CONFLICT decide:
        -- DO NOTHING discards this candidate row, DO UPDATE runs the UPDATE
        -- branch below on the stored row, and no ON CONFLICT is a
        -- unique_violation. Nothing unchecked can land.
        select exists (
            select 1 from time_entries t
             where t.company_id = new.company_id
               and t.sync_id = new.sync_id
        ) into already_there;
        if already_there then
            return new;
        end if;

        -- A genuinely new shift names one of this company's own people.
        if coalesce(nullif(btrim(new.employee_sync_id, E' \t\r\n '), ''), null) is null then
            raise exception
                'This shift is not linked to a crew member. Assign the job to somebody, or pick who is working, and clock in again.'
                using errcode = '23514';
        end if;
        select exists (
            select 1 from employees e
             where e.company_id = new.company_id
               and e.sync_id::text = new.employee_sync_id
        ) into named;
        if not named then
            raise exception
                'That crew member is not on this company. The shift was not saved.'
                using errcode = '23514';
        end if;
        return new;
    end if;

    -- Update: block clearing the person, and block moving a shift onto
    -- somebody who is not ours. An update that leaves an already-blank row
    -- blank is the office working on one of the three historical rows, and
    -- that has to keep working.
    if new.employee_sync_id is distinct from old.employee_sync_id then
        if coalesce(nullif(btrim(new.employee_sync_id, E' \t\r\n '), ''), null) is null then
            raise exception
                'A shift cannot have its crew member removed. Correct who worked it instead.'
                using errcode = '23514';
        end if;
        select exists (
            select 1 from employees e
             where e.company_id = new.company_id
               and e.sync_id::text = new.employee_sync_id
        ) into named;
        if not named then
            raise exception
                'That crew member is not on this company. The shift was not changed.'
                using errcode = '23514';
        end if;
    end if;
    return new;
end;
$$;

comment on function public.time_entry_needs_a_person() is
  'Refuses a new shift with no crew member, or one naming somebody outside the company. A re-sent row whose (company_id, sync_id) already exists is handed to ON CONFLICT instead, so the historical blank rows stop failing every sync. Existing blank rows stay editable so the office can fix them.';

select 'shift guard lets ON CONFLICT handle rows the server already has' as done;
