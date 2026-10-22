-- ============================================================
-- FenceFlow -- put EXECUTE on is_platform_admin() back for anon.
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- MY MISTAKE, FOUND BY THE PUBLISH GATE AN HOUR LATER.
-- supabase_r26_admin_is_one_address.sql did this, by habit:
--
--     revoke all on function public.is_platform_admin() from anon;
--
-- and its own proof called that a PASS, because "anon cannot call the admin
-- check" sounds like the safe direction. It is not, and the reason is that
-- ELEVEN ROW POLICIES ON EIGHT TABLES call that function:
--
--     app_errors, app_release_audience, audit_log, auth_events,
--     auth_events_suppressed, companies, company_setup_codes, pricing_drift
--
-- A policy is evaluated AS THE CALLER. With no EXECUTE, a signed-out request
-- to any of those tables did not return nothing -- it ERRORED:
--
--     401  {"code":"42501","message":"permission denied for function
--           is_platform_admin"}
--
-- WHY THAT IS WORSE, NOT BETTER. The function answers false for anon anyway
-- (auth.uid() is null), so revoking it hid nothing; the security was always in
-- what the function RETURNS, never in who may ask. What the revoke changed was
-- the failure shape: "no rows" became "permission denied for function
-- is_platform_admin", which names an internal function to a stranger and
-- breaks the contract the whole security suite is written against -- a
-- signed-out caller sees an empty list and learns nothing.
--
-- And it was not only cosmetic. Any signed-out path that so much as touches
-- one of those eight tables got a 401 instead of an empty answer.
--
-- THE LESSON, written down because it will come round again: revoking EXECUTE
-- on a function that RLS policies call does not make those tables stricter. It
-- makes them throw. Tighten what the function returns, never who may call it.
-- ============================================================

grant execute on function public.is_platform_admin() to anon;

-- The grants that were right stay exactly as they were.
grant execute on function public.is_platform_admin() to authenticated;

-- ------------------------------------------------------------------------
-- PROOF. The point is not that anon may CALL it -- it is that anon gets
-- NOTHING back from the tables, quietly, the way it always did.
-- ------------------------------------------------------------------------
select 'anon can call the check again' as check,
       case when has_function_privilege('anon', 'public.is_platform_admin()', 'execute')
            then 'PASS' else 'FAIL -- every one of the eight tables still 401s a stranger' end as result
union all
select 'and so can a signed-in account',
       case when has_function_privilege('authenticated', 'public.is_platform_admin()', 'execute')
            then 'PASS' else 'FAIL' end
union all
-- WHAT IT ANSWERS is the security, and it is unchanged: this statement runs as
-- the database owner with no JWT, which is the same auth.uid() a signed-out
-- caller has.
select 'it still says no to a caller with no session',
       case when public.is_platform_admin() then 'FAIL -- it answered yes to nobody' else 'PASS' end
union all
select 'the address is still pinned',
       case when position('marchenry73@gmail.com' in
              (select pg_get_functiondef(p.oid) from pg_proc p
                 join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'is_platform_admin')) > 0
            then 'PASS' else 'FAIL -- r26 was undone' end
union all
select 'the second factor is still required',
       case when position('admin_second_factor_ok' in
              (select pg_get_functiondef(p.oid) from pg_proc p
                 join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'is_platform_admin')) > 0
            then 'PASS' else 'FAIL' end
union all
-- The eight tables, counted, so "which tables was this about" is not a claim
-- in a comment but a number read back from the catalog.
select 'the policies that depend on it',
       (select count(distinct c.relname)::text || ' tables, ' || count(*)::text || ' policies'
          from pg_policy p
          join pg_class c on c.oid = p.polrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and (coalesce(pg_get_expr(p.polqual, p.polrelid), '') ilike '%is_platform_admin%'
             or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ilike '%is_platform_admin%'));
