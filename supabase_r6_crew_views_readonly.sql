-- ============================================================
-- FenceFlow -- the *_crew views are read-only (applied 2026-09-22)
-- ADDITIVE-SAFE: privileges only; no row, table or function changes.
--
-- Every *_crew view is a simple one-table view, so Postgres makes it
-- updatable, and it runs with its owner's rights (postgres), which bypass
-- RLS. With INSERT/UPDATE/DELETE granted to authenticated, a CREW login
-- could hard-delete any job in its company through jobs_crew and delete
-- shifts through time_entries_crew -- found by the crew-access review and
-- reproduced in a rolled-back test. Nothing legitimate writes through these
-- views (the app pushes through crew_save_job / crew_push_line_items and the
-- base tables; the office only reads), so reading is all that is left.
-- Verified after applying: no non-SELECT grant remains for anon or
-- authenticated; a crew login still reads jobs_crew; a delete is refused.
-- The same statement is PART 1b of supabase_crew_job_scope.sql; running it
-- twice is harmless.
-- ============================================================
revoke insert, update, delete, truncate, references, trigger
    on public.jobs_crew, public.estimate_line_items_crew, public.change_orders_crew,
       public.time_entries_crew, public.material_items_crew
  from anon, authenticated;
