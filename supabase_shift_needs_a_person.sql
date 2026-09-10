-- A shift that belongs to nobody is payroll that is quietly wrong.
--
-- Three shifts on this database have an empty employee_sync_id. They are not
-- dangling references to a deleted person -- the field is blank, so no one was
-- ever named. CrewJobViewModel.clockIn() takes the identity from the job's
-- assignment (job.assignedEmployeeId), so clocking in on an unassigned job
-- records a shift with no person and, because the rate is looked up from that
-- same missing employee, a rate of zero. It costs nothing, it is owed to no
-- one, and it lands in the labour column of the job's profit as free work.
-- Nothing warns anybody: it looks like a normal shift in every list.
--
-- The existing three rows are LEFT ALONE. They are real recorded time and the
-- office decides what they were; deleting field data is not this file's job.
-- This only stops new ones.
--
-- A trigger rather than a check constraint, for two reasons. A constraint would
-- have to be added NOT VALID to survive those three rows, and a NOT VALID
-- constraint still fires on any later UPDATE of them -- so approving or
-- correcting one of the three would start failing, which is the opposite of
-- what the office needs. And a trigger can say why in words the app can show.
create or replace function public.time_entry_needs_a_person()
returns trigger
language plpgsql
as $$
begin
    -- Insert: every new shift names somebody. No exceptions.
    if tg_op = 'INSERT' then
        if coalesce(nullif(trim(new.employee_sync_id), ''), null) is null then
            raise exception
                'This shift is not linked to a crew member. Assign the job to somebody, or pick who is working, and clock in again.'
                using errcode = '23514';
        end if;
        return new;
    end if;

    -- Update: only block the transition INTO blank. An update that leaves an
    -- already-blank row blank is the office working on one of the three
    -- historical rows, and that must keep working.
    if coalesce(nullif(trim(new.employee_sync_id), ''), null) is null
       and coalesce(nullif(trim(old.employee_sync_id), ''), null) is not null then
        raise exception
            'A shift cannot have its crew member removed. Correct who worked it instead.'
            using errcode = '23514';
    end if;
    return new;
end;
$$;

drop trigger if exists time_entry_needs_a_person on public.time_entries;
create trigger time_entry_needs_a_person
    before insert or update on public.time_entries
    for each row execute function public.time_entry_needs_a_person();

comment on function public.time_entry_needs_a_person() is
  'Refuses a shift with no crew member on it. Existing blank rows stay editable so the office can fix them.';

select 'shifts must name a person' as done;
