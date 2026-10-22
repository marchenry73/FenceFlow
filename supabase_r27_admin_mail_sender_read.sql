-- ============================================================
-- FenceFlow -- the Admin console can read which service carries its mail.
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- THE BUG, as photographed on 2026-10-22: the Admin screen's "FenceFlow mail
-- goes through" panel showed
--
--     permission denied for table mail_platform_settings
--     (Grant the required privileges ... GRANT SELECT ON
--      public.mail_platform_settings TO authenticated;)
--
-- The panel has never worked. The phone read the table directly, and that
-- table is one of six in NO_GRANT_TABLES (tests/a25-tenant-isolation.test.mjs):
-- no grant to authenticated, no grant to anon, RLS on and not one policy. It
-- is service-role only by design, and a25 fails the moment that stops being
-- true.
--
-- SO NOT THE GRANT THE ERROR ASKS FOR. Following that suggestion would hand
-- every signed-in user of every fence company a read of the platform's own
-- mail configuration, and break the test that exists to stop exactly that. A
-- database's advice is about privileges, not about who should have them.
--
-- The write side was already right: admin_set_mail_sender() is a SECURITY
-- DEFINER function behind is_platform_admin(). Only the READ reached past it.
-- This is its twin, and the panel now goes through the same door as the
-- button underneath it.
-- ============================================================

create or replace function public.admin_mail_sender()
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
    -- The guard is inside the query, not a preceding raise: this returns one
    -- value and a refused caller must get nothing rather than a default that
    -- looks like an answer. The console shows "could not read" either way,
    -- which is the truth for somebody who is not allowed to read it.
    select s.sender_provider
      from mail_platform_settings s
     where s.id = 1 and public.is_platform_admin();
$$;

revoke all on function public.admin_mail_sender() from public;
revoke all on function public.admin_mail_sender() from anon;
grant execute on function public.admin_mail_sender() to authenticated;

-- ------------------------------------------------------------------------
-- PROOF.
-- ------------------------------------------------------------------------
select 'the function exists' as check,
       case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.proname = 'admin_mail_sender')
            then 'PASS' else 'FAIL' end as result
union all
select 'it runs as its owner, which is the only way past the table',
       coalesce((select case when p.prosecdef then 'PASS' else 'FAIL -- not SECURITY DEFINER' end
                   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'admin_mail_sender'), 'FAIL')
union all
select 'it asks is_platform_admin, so it is not a hole in the wall',
       case when position('is_platform_admin()' in
              (select pg_get_functiondef(p.oid) from pg_proc p
                 join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'admin_mail_sender')) > 0
            then 'PASS' else 'FAIL -- anybody signed in can read the platform mail setting' end
union all
select 'the console can call it',
       case when has_function_privilege('authenticated', 'public.admin_mail_sender()', 'execute')
            then 'PASS' else 'FAIL' end
union all
select 'anon cannot',
       case when has_function_privilege('anon', 'public.admin_mail_sender()', 'execute')
            then 'FAIL' else 'PASS' end
union all
-- THE RULE THE ERROR TRIED TO TALK US OUT OF. The table itself must still be
-- untouchable by a tenant login; if this ever flips, a25 is lying too.
select 'the table itself is still closed to tenant logins',
       case when (select count(*) from information_schema.role_table_grants
                   where table_schema = 'public' and table_name = 'mail_platform_settings'
                     and grantee in ('authenticated', 'anon')) = 0
            then 'PASS' else 'FAIL -- somebody followed the hint in the error message' end
union all
-- POSITIVE CONTROL: there is a row to read, so "the console shows nothing"
-- would be a real failure rather than an empty table.
select 'there is a setting row to return',
       case when exists (select 1 from mail_platform_settings where id = 1)
            then 'PASS' else 'FAIL -- row 1 does not exist; the panel will stay blank' end
union all
select 'and this is what it says today',
       coalesce((select sender_provider from mail_platform_settings where id = 1), '(null)');
