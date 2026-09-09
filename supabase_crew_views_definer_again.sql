-- Reverting my own change from earlier today, because it was correct about the
-- warning and wrong about the design.
--
-- Supabase's advisor flags the five _crew views as critical: they are SECURITY
-- DEFINER, so they bypass row-level security on the tables underneath. I set
-- security_invoker on all five and proved the rows did not change, because each
-- view already repeats the same two conditions the base table's policy applies.
--
-- What I missed is WHY they were definer. These views exist to serve the crew a
-- money-free subset of tables the crew should not be able to read at all. That
-- only works if the view can read what its caller cannot -- which is precisely
-- what SECURITY DEFINER means, and precisely what security_invoker removes.
--
-- Measured rather than reasoned. Two throwaway views over payment_records, a
-- table the crew is already denied, queried as a real crew account:
--
--     direct base table   0 rows
--     definer view       23 rows
--     invoker view        0 rows
--
-- So with invoker set, the moment the crew is denied on jobs and
-- estimate_line_items -- which is the pending fix for a real exposure, where a
-- crew member can currently read every job's deposit and every line item's
-- price straight from the base table -- the _crew views would go dark too, and
-- the crew app would show empty screens instead of a money-free view.
--
-- The advisor warning is a true statement about the mechanism and a false alarm
-- about this use of it. A definer view is dangerous when it silently widens
-- what a caller can see. Here it narrows it: fewer columns, same company, same
-- suspension check. That is the whole point of the object.
--
-- security_barrier stays on, so the planner cannot leak rows through a cheap
-- user-supplied function before the WHERE clause runs.
alter view public.jobs_crew                set (security_invoker = false);
alter view public.estimate_line_items_crew set (security_invoker = false);
alter view public.time_entries_crew        set (security_invoker = false);
alter view public.material_items_crew      set (security_invoker = false);
alter view public.change_orders_crew       set (security_invoker = false);
