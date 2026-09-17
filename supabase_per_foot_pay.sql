-- Pay by the foot, next to hourly.
--
-- employees.pay_type and employees.per_foot_rate already exist
-- (supabase_sync_gaps_patch.sql / supabase_defaults_patch.sql), defaulting to
-- HOURLY and 0, so every existing crew member keeps today's behaviour. This
-- file is additive only:
--
--   1. check constraints so a typo can never become a third pay type or a
--      negative rate (added NOT VALID, then validated -- every current row is
--      HOURLY with rates of 0, so validation cannot fail on real data);
--   2. per_foot_crew_count(job), which tells a crew phone how many PER_FOOT
--      workers share a job's footage -- a COUNT, never anyone's rate.
--
-- Nothing here touches employees_read / employees_update, the pay-privacy
-- policies or any money lockdown. Crew still cannot read a colleague's row
-- and still cannot update any employee row, including their own.

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.employees'::regclass
                    and conname = 'employees_pay_type_check') then
    alter table public.employees
      add constraint employees_pay_type_check
      check (pay_type in ('HOURLY', 'PER_FOOT')) not valid;
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.employees'::regclass
                    and conname = 'employees_per_foot_rate_nonneg') then
    alter table public.employees
      add constraint employees_per_foot_rate_nonneg
      check (per_foot_rate >= 0) not valid;
  end if;
end $$;

alter table public.employees validate constraint employees_pay_type_check;
alter table public.employees validate constraint employees_per_foot_rate_nonneg;

-- ---------------------------------------------------------------------------
-- How many PER_FOOT workers split this job's footage.
-- ---------------------------------------------------------------------------
-- "Who worked the job" is who has a finished, non-rejected, non-deleted shift
-- on it (the same test the office's pay tables use). A job nobody clocked on
-- falls back to its assigned employee, so a one-man job paid by the foot still
-- has a divisor of one.
--
-- Answered only to someone who may see pay (SEE_PAY), or to a crew member who
-- is one of that job's workers. Anyone else -- another company, anon, a crew
-- member who never touched the job -- gets NULL, not zero, so "not yours to
-- ask" can never read as "nobody is paid by the foot here".
--
-- It returns a number of people. It never returns a rate, a pay type for a
-- named person, or an amount.
create or replace function public.per_foot_crew_count(p_job_sync_id uuid)
returns integer
language sql stable security definer set search_path to 'public'
as $$
  with j as (
    select jb.sync_id, jb.company_id, jb.assigned_employee_sync_id
      from jobs jb
     where jb.sync_id = p_job_sync_id
       and jb.company_id = public.current_company_id()
       and jb.deleted_at is null
  ),
  worked as (
    select distinct t.employee_sync_id as sid
      from time_entries t
      join j on t.job_sync_id = j.sync_id and t.company_id = j.company_id
     where t.deleted_at is null
       and t.ended_at is not null
       and not (t.rejected_at is not null and t.approved_at is null)
       and coalesce(t.employee_sync_id, '') <> ''
  ),
  crew as (
    select sid from worked
    union
    select j.assigned_employee_sync_id from j
     where not exists (select 1 from worked)
       and coalesce(j.assigned_employee_sync_id, '') <> ''
  ),
  me as (
    select e.sync_id::text as sid
      from employees e
     where e.profile_id = auth.uid()
       and e.company_id = public.current_company_id()
       and e.deleted_at is null
  )
  select case
    when not exists (select 1 from j) then null
    when not (public.has_permission('SEE_PAY')
              or exists (select 1 from me where me.sid in (select sid from crew)))
      then null
    else (select count(*)::int
            from employees e
           where e.company_id = public.current_company_id()
             and e.deleted_at is null
             and e.pay_type = 'PER_FOOT'
             and e.sync_id::text in (select sid from crew))
  end;
$$;

revoke execute on function public.per_foot_crew_count(uuid) from public, anon;
grant  execute on function public.per_foot_crew_count(uuid) to authenticated;
