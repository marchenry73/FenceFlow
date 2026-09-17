-- Test-fixture flag on jobs. Additive.
--
-- The office console hides jobs with is_test_fixture = true from every view;
-- the owner can show them again from Settings. Automated security tests rely
-- on the "ZZ TEST" fixture jobs, so they are flagged, never deleted/renamed.
--
-- Trigger notes (checked 2026-09-17): jobs_touch_updated_at bumps updated_at
-- (the flag is not in its quiet list), so phones simply pull the newer server
-- row; jobs_signal records a sync signal; job-change-push only fires on
-- status/assigned_employee_id; jobs_audit does not watch this column.

alter table public.jobs
    add column if not exists is_test_fixture boolean not null default false;

update public.jobs
   set is_test_fixture = true
 where customer_name ilike 'ZZ TEST%'
   and is_test_fixture = false;

select count(*) as flagged from public.jobs where is_test_fixture;
