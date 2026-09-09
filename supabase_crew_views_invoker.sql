-- The crew views were created before Postgres 15's security_invoker option and
-- so run as their owner, which bypasses row-level security on the base tables.
-- Supabase's advisor flags that as critical, and in general it is: a definer
-- view is a hole punched straight through RLS.
--
-- Here it did not leak, because each view repeats the same two conditions the
-- base table's own read policy applies:
--
--     company_id = current_company_id() AND NOT company_is_suspended()
--
-- That is exactly why the switch is safe. With security_invoker on, RLS does
-- the filtering instead of the view's WHERE clause, and both express the same
-- rule -- so the rows do not change, but the views stop being a standing
-- exception to RLS. If a policy is ever tightened, these views now tighten
-- with it instead of quietly keeping the old, looser rule.
alter view public.jobs_crew                set (security_invoker = true);
alter view public.estimate_line_items_crew set (security_invoker = true);
alter view public.time_entries_crew        set (security_invoker = true);
alter view public.material_items_crew      set (security_invoker = true);
alter view public.change_orders_crew       set (security_invoker = true);
