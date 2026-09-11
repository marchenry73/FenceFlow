-- APPROVING YOUR OWN HOURS, AND REASSIGNING ANYBODY'S JOB.
--
-- Both permissions already exist and are already used elsewhere: APPROVE_TIME
-- and SCHEDULE_AND_ASSIGN. Neither is checked on the writes they name. Read
-- straight from pg_policy, both update policies are
--
--     (company_id = current_company_id())
--
-- with no USING permission test and no WITH CHECK at all. So any signed-in
-- member of a company can update any job and any shift belonging to it.
--
-- The one that matters is a person setting approved_at on their own shift.
-- Manager time correction and the employee dispute flow are both built on
-- approval meaning a second person looked. If the person being paid can stamp
-- it themselves, the whole record of who agreed to what is decoration, and the
-- hours it certifies turn into wages.
--
-- Why a trigger and not a policy: row-level security cannot say "you may edit
-- this row but not these four columns of it". Crew legitimately update their
-- own shifts every time they clock out, and legitimately push a job's
-- production stage, so revoking UPDATE outright would stop people working.
-- The trigger refuses only the specific columns.
--
-- Managers keep approving from the phone. The push carries approved_at
-- deliberately -- a shift signed off on a handset used to come back pending on
-- the next pull -- so this checks permission rather than blocking the column.
--
-- Enforced only for calls arriving as an end user (PostgREST sets the role to
-- authenticated or anon). Definer-owned server functions are unaffected. Note
-- what this deliberately does NOT do: it does not exempt callers whose
-- auth.uid() is null. That escape hatch reads as "a trusted server job" and is
-- equally true of an anonymous caller, which is how a definer function gets
-- opened to the world.
--
-- To undo:
--   drop trigger if exists time_entry_approval_needs_permission on time_entries;
--   drop trigger if exists job_assignment_needs_permission on jobs;

-- Deliberately NOT security definer. Inside a definer function current_user
-- is the function owner, not the caller, so the end-user test below was
-- false for everybody and the guard waved every write through. It looked
-- installed and did nothing. As invoker, current_user is the role PostgREST
-- set for the request, which is the thing being asked about.

create or replace function public.guard_time_entry_approval()
returns trigger language plpgsql set search_path to 'public' as $fn$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.approved_at is not distinct from old.approved_at
     and new.approved_by is not distinct from old.approved_by
     and new.rejected_at is not distinct from old.rejected_at then
    return new;
  end if;
  if tg_op = 'INSERT'
     and new.approved_at is null
     and coalesce(new.approved_by, '') = ''
     and new.rejected_at is null then
    return new;
  end if;
  if has_permission('APPROVE_TIME') then
    return new;
  end if;
  raise exception 'Approving or rejecting hours needs APPROVE_TIME. A shift cannot be signed off by the person being paid for it.'
    using errcode = '42501';
end;
$fn$;

drop trigger if exists time_entry_approval_needs_permission on time_entries;
create trigger time_entry_approval_needs_permission
  before insert or update on time_entries
  for each row execute function public.guard_time_entry_approval();

create or replace function public.guard_job_assignment()
returns trigger language plpgsql set search_path to 'public' as $fn$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.assigned_employee_sync_id is not distinct from old.assigned_employee_sync_id
     and new.scheduled_date is not distinct from old.scheduled_date then
    return new;
  end if;
  if has_permission('SCHEDULE_AND_ASSIGN') then
    return new;
  end if;
  raise exception 'Assigning or scheduling a job needs SCHEDULE_AND_ASSIGN.'
    using errcode = '42501';
end;
$fn$;

drop trigger if exists job_assignment_needs_permission on jobs;
create trigger job_assignment_needs_permission
  before update on jobs
  for each row execute function public.guard_job_assignment();

select 'approval and assignment now need their own permissions' as done;
