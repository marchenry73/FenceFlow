-- F2 (P1): time_entries.hourly_rate was readable by CREW, FOREMAN and SALES.
-- The only SELECT rule on the table was "same company", so every member pulled
-- every colleague's shift with the rate attached. employees is already
-- protected the same way (whole row hidden without SEE_PAY, with crew_roster()
-- as the no-pay fallback); this gives time_entries the same shape, with
-- time_entries_crew (which has no hourly_rate column at all) as the fallback.
--
-- Additive only: a RESTRICTIVE SELECT policy on top of the existing ones, and
-- three non-money columns appended to the crew view so the fallback is a
-- complete answer for everything except pay.

-- 1. The rate is visible only to someone who may see pay, or on your own shift.
drop policy if exists time_entries_pay_needs_see_pay on public.time_entries;
create policy time_entries_pay_needs_see_pay on public.time_entries
    as restrictive for select to authenticated
    using (
        public.has_permission('SEE_PAY')
        or public.is_my_shift(employee_sync_id)
    );

-- 2. The crew view is the no-pay path. Appending columns keeps every existing
--    caller's column positions unchanged.
create or replace view public.time_entries_crew as
 SELECT id,
    company_id,
    sync_id,
    job_sync_id,
    employee_id,
    started_at,
    ended_at,
    notes,
    updated_at,
    approved_at,
    approved_by,
    rejected_at,
    review_note,
    deleted_at,
    deleted_by,
    employee_sync_id,
    original_started_at,
    original_ended_at,
    corrected_at,
    correction_reason,
    break_minutes,
    break_started_at,
    break_ended_at
   FROM time_entries
  WHERE company_id = current_company_id() AND NOT company_is_suspended();

alter view public.time_entries_crew set (security_barrier = true);
alter view public.jobs_crew set (security_barrier = true);

grant select on public.time_entries_crew to authenticated;
