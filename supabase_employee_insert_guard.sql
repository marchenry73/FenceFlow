-- Only people who may edit settings can add an employee row (and so set a
-- pay rate). Additive: a RESTRICTIVE policy ANDs with employees_insert, which
-- stays as it is. Same permission employees_update already requires.
-- Crew phones never push employees (EntitySync.pushEmployees), so nothing
-- that works today is refused.
do $d$ begin
  if not exists (select 1 from pg_policies where tablename='employees' and policyname='employees_insert_needs_settings') then
    create policy employees_insert_needs_settings on public.employees
      as restrictive for insert to authenticated
      with check (public.has_permission('EDIT_CATALOG_AND_SETTINGS'));
  end if;
end $d$;
select 'employee insert guard installed' as done;
