-- Crew can see what materials cost. Crew cannot see what people are paid.
--
-- March's decision, 26 August. Supplier costs are working information -- an
-- installer should know what the panel he is fitting costs. What his colleagues
-- earn is not.
--
-- So the estimate line items and expenses stay exactly as they are: everyone in
-- the company reads them. (Two narrow policies existed there intending to hide
-- costs from crew, and a broader policy sitting beside them cancelled each one
-- out, because Postgres OR's permissive policies together. They were never in
-- effect, and by this decision they should not be, so the dead ones are dropped
-- rather than left looking like protection that isn't there.)
drop policy if exists estimate_line_items_select on public.estimate_line_items;
drop policy if exists expenses_select            on public.expenses;

-- Pay lives in four columns across two tables:
--   employees.hourly_rate, employees.pay_type, employees.per_foot_rate
--   time_entries.hourly_rate
--
-- Row Level Security cannot hide a column, and masking them behind a view is
-- not available here: the phone upserts both tables, and Postgres refuses
-- ON CONFLICT against a view with INSTEAD OF triggers. So the row is the unit,
-- and the rule is the one the product already uses -- SEE_MONEY, which is
-- OWNER, MANAGER, SALES and ACCOUNTANT -- plus always your own record.

-- ---------------------------------------------------------------------------
-- The rate is stamped by the server, not sent by the phone.
-- ---------------------------------------------------------------------------
-- This is what actually unlocks hiding pay. CrewJobViewModel.kt:48 clocks in
-- by looking the rate up in the phone's own copy of the employees table:
--     val rate = employees.value.firstOrNull { it.id == employeeId }?.hourlyRate ?: 0.0
-- So hiding that table from crew would not have hidden anything -- it would
-- have silently recorded every crew hour at zero, and payroll would have been
-- quietly wrong instead of visibly broken.
--
-- The rate belongs to the employee record, which is office information. The
-- server reads it and writes it, and whatever the phone sends is ignored. That
-- removes the pay rate from the phone's job entirely, and it also closes a
-- client-trust hole: the rate on a shift was previously whatever the device
-- claimed it was.
create or replace function public.stamp_time_entry_rate()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare
    real_rate numeric;
begin
    select e.hourly_rate into real_rate
      from employees e
     where e.company_id = new.company_id
       and e.sync_id::text = new.employee_sync_id
     limit 1;

    -- No matching employee record means there is no rate to stamp, and the
    -- office fixes it when they approve the shift. Keeping whatever the phone
    -- sent would be worse: it is the thing being distrusted.
    new.hourly_rate := coalesce(real_rate, 0);
    return new;
end;
$$;

drop trigger if exists stamp_time_entry_rate on public.time_entries;
create trigger stamp_time_entry_rate
    before insert or update on public.time_entries
    for each row execute function public.stamp_time_entry_rate();

-- ---------------------------------------------------------------------------
-- The crew roster: who is on the crew, with no pay attached.
-- ---------------------------------------------------------------------------
-- The phone needs names to show who a job is assigned to. That is the only
-- reason a crew account ever read the employees table, so this returns exactly
-- that and nothing else.
create or replace function public.crew_roster()
returns table(id uuid, sync_id text, name text, role text, is_active boolean)
language sql stable security definer set search_path to 'public'
as $$
    select e.id, e.sync_id::text, e.name, e.role::text, coalesce(e.is_active, true)
      from employees e
     where e.company_id = public.current_company_id()
       and e.deleted_at is null
     order by e.name;
$$;
revoke execute on function public.crew_roster() from public, anon;
grant  execute on function public.crew_roster() to authenticated;

-- ---------------------------------------------------------------------------
-- Employees: the money roles, plus your own record.
-- ---------------------------------------------------------------------------
drop policy if exists employees_read on public.employees;
create policy employees_read on public.employees
    for select using (
        company_id = public.current_company_id()
        and (public.has_permission('SEE_MONEY') or profile_id = auth.uid())
    );

-- Writing somebody's pay is office work. Crew were able to edit any crew
-- member's record, including their own rate.
drop policy if exists employees_update on public.employees;
create policy employees_update on public.employees
    for update using (
        company_id = public.current_company_id()
        and public.has_permission('EDIT_CATALOG_AND_SETTINGS')
    )
    with check (
        company_id = public.current_company_id()
        and public.has_permission('EDIT_CATALOG_AND_SETTINGS')
    );
