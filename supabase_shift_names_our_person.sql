-- A shift must name somebody who works HERE.
--
-- The first version of this guard only checked the field was not blank. That
-- catches the three real rows on this database, which were blank, and it
-- catches the bug that made them -- clocking in on an unassigned job. It does
-- not catch a sync id that is perfectly well formed and names nobody, or names
-- somebody at another company. Either one attributes hours, and the pay
-- computed from them, to the wrong person or the wrong company, and looks
-- entirely normal in every list.
--
-- The existing blank rows stay editable, exactly as before: the office decides
-- what that recorded time was, and this file does not delete field data.
create or replace function public.time_entry_needs_a_person()
returns trigger
language plpgsql
security definer set search_path to 'public'
as $$
declare
    named boolean;
begin
    -- Insert: every new shift names one of this company's own people.
    if tg_op = 'INSERT' then
        if coalesce(nullif(btrim(new.employee_sync_id, E' \t\r\n '), ''), null) is null then
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
        if coalesce(nullif(btrim(new.employee_sync_id, E' \t\r\n '), ''), null) is null then
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
  'Refuses a shift with no crew member, or one naming somebody outside the company. Existing blank rows stay editable so the office can fix them.';

select 'shifts must name one of our own people' as done;
