-- ============================================================
-- FenceFlow -- a platform admin can read the audit log
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- ADDITIVE. One SELECT policy. No existing policy is changed, nothing is
-- dropped, no grant is widened, and nothing is written or deleted.
--
-- WHY. public.audit_log holds 5,170 rows -- who did what, to which table and
-- record, which field, the old value and the new one -- and it has had no
-- screen anywhere since the day it was created. The one thing an auditor, a
-- customer or a dispute asks for, and the only way to read it was a SQL
-- client.
--
-- The existing policy, audit_log_read, is scoped to ONE company and to the
-- roles inside it. That is correct and it stays exactly as it is: a company's
-- owner reads their own company's history. It also means the operator console
-- -- which exists to look across every company -- would have shown the admin
-- nothing but his own rows, which is the same trap the pricing-drift panel
-- sat in for months while its note blamed the wrong cause.
--
-- WHY A POLICY AND NOT AN RPC. Both patterns are already in this database.
-- companies, app_errors and pricing_drift each carry a plain
-- `using (is_platform_admin())` SELECT policy; admin_releases() is a SECURITY
-- DEFINER function. The policy is the right one here because the console
-- needs to FILTER this table -- by company, by person, by date, by table --
-- and a function would have to grow every one of those filters as arguments
-- and keep them in step with the screen. is_platform_admin() already requires
-- the second factor (see admin_second_factor_ok), so the bar is the same
-- either way.
--
-- WHAT THIS DOES NOT DO. It does not let anybody WRITE this table. `authenticated`
-- holds SELECT on audit_log and nothing else -- no INSERT, no UPDATE, no
-- DELETE -- so the log is already append-only as far as every client is
-- concerned, including the console that is about to display it. That property
-- is the whole value of an audit log and this file leaves it alone; the proof
-- at the bottom asserts it rather than assuming it.
-- ============================================================

drop policy if exists audit_log_admin_read on public.audit_log;
create policy audit_log_admin_read on public.audit_log
    for select
    using (public.is_platform_admin());

-- ------------------------------------------------------------------------
-- PROOF. Read back, never trusted from the statement's own success.
-- ------------------------------------------------------------------------
select 'the admin policy exists' as check,
       case when exists (select 1 from pg_policies
                          where schemaname = 'public' and tablename = 'audit_log'
                            and policyname = 'audit_log_admin_read')
            then 'PASS' else 'FAIL' end as result
union all
select 'it is a SELECT policy and nothing else',
       coalesce((select case when cmd = 'SELECT' and permissive = 'PERMISSIVE' then 'PASS'
                             else 'FAIL -- reads ' || cmd || '/' || permissive end
                   from pg_policies
                  where schemaname = 'public' and tablename = 'audit_log'
                    and policyname = 'audit_log_admin_read'), 'FAIL -- missing')
union all
select 'it asks is_platform_admin() and nothing weaker',
       coalesce((select case when qual = 'is_platform_admin()' then 'PASS'
                             else 'FAIL -- reads ' || qual end
                   from pg_policies
                  where schemaname = 'public' and tablename = 'audit_log'
                    and policyname = 'audit_log_admin_read'), 'FAIL -- missing')
union all
select 'the company-scoped policy is untouched',
       case when exists (select 1 from pg_policies
                          where schemaname = 'public' and tablename = 'audit_log'
                            and policyname = 'audit_log_read')
            then 'PASS' else 'FAIL -- the original read policy is gone' end
union all
-- The canary for the whole file: if a client could write this table, the log
-- would be worth nothing and a screen over it would be theatre.
select 'still append-only for every client',
       case when (select count(*) from information_schema.table_privileges
                   where table_schema = 'public' and table_name = 'audit_log'
                     and grantee in ('authenticated', 'anon')
                     and privilege_type in ('INSERT', 'UPDATE', 'DELETE')) = 0
            then 'PASS'
            else 'FAIL -- a client can write the audit log: ' ||
                 (select string_agg(grantee || ' ' || privilege_type, ', ')
                    from information_schema.table_privileges
                   where table_schema = 'public' and table_name = 'audit_log'
                     and grantee in ('authenticated', 'anon')
                     and privilege_type in ('INSERT', 'UPDATE', 'DELETE')) end
union all
select 'row level security is still on',
       case when (select relrowsecurity from pg_class where oid = 'public.audit_log'::regclass)
            then 'PASS' else 'FAIL -- RLS is off, every row is readable by anyone' end;
