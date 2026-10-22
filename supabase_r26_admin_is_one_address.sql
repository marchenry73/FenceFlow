-- ============================================================
-- FenceFlow -- the platform console answers ONE address.
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- WHAT CHANGES. is_platform_admin() required two things: the
-- profiles.is_platform_admin flag, and a session that has done the second
-- factor. It now requires three. The third is that the login's own email is
-- marchenry73@gmail.com. Nothing else about the function moves.
--
-- WHY A THIRD LOCK WHEN THE FLAG IS ALREADY RIGHT. Today exactly one profile
-- carries that flag and it is that address, so this changes nothing about who
-- can open the console right now. It changes what happens if the flag is ever
-- wrong. The flag is guarded by protect_platform_admin_flag(), and that
-- trigger skips its own check whenever auth.uid() is null -- written for the
-- backend's own service-role writes, but auth.uid() is null for an anonymous
-- caller too, and for anything running without a token. A flag is a row; an
-- address is who you are. Requiring both means a stray row is not a console.
--
-- WHERE IT BITES. 19 other functions and 11 policies call this one. That is
-- the point of changing it here rather than in each of them: there is one
-- funnel, and new admin code is refused by default because it goes through
-- the same door.
--
-- IF THE ADDRESS EVER CHANGES. Change the one literal below and re-run this
-- file. Changing the login email without doing that locks the console to
-- nobody -- including the person reading this -- and the only way back in is
-- this SQL editor, which answers as the database owner and is not subject to
-- the function at all. That is the deliberate trade: a recovery path that
-- needs the database password, not an account.
-- ============================================================

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
    select coalesce((
        select p.is_platform_admin
          from profiles p
          join auth.users u on u.id = p.id
         where p.id = auth.uid()
           -- The third lock. lower() on both sides: Supabase stores the
           -- address as typed, and a capital letter is not a different person.
           and lower(u.email) = lower('marchenry73@gmail.com')
    ), false)
    and public.admin_second_factor_ok();
$$;

revoke all on function public.is_platform_admin() from public;
revoke all on function public.is_platform_admin() from anon;
grant execute on function public.is_platform_admin() to authenticated;

-- ------------------------------------------------------------------------
-- PROOF. Read back. Every refusal check is paired with a positive control,
-- because a check that refuses everything refuses the right answer too.
-- ------------------------------------------------------------------------
with def as (
  select pg_get_functiondef(p.oid) as src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'is_platform_admin'
)
select 'the address is in the function' as check,
       case when (select position('marchenry73@gmail.com' in src) from def) > 0
            then 'PASS' else 'FAIL -- the third lock is not there' end as result
union all
select 'the second factor is still required',
       case when (select position('admin_second_factor_ok' in src) from def) > 0
            then 'PASS' else 'FAIL -- the console now opens on a password alone' end
union all
select 'the flag is still required',
       case when (select position('is_platform_admin' in src) from def) > 0
            then 'PASS' else 'FAIL -- the address alone now opens it' end
union all
select 'the console still answers authenticated',
       case when has_function_privilege('authenticated', 'public.is_platform_admin()', 'execute')
            then 'PASS' else 'FAIL -- nobody can open the console at all' end
union all
select 'anon cannot call it',
       case when has_function_privilege('anon', 'public.is_platform_admin()', 'execute')
            then 'FAIL -- a signed-out visitor can ask' else 'PASS' end
union all
-- POSITIVE CONTROL. Before asking who is refused, prove somebody is admitted.
-- Without this, every refusal below would also "pass" against an empty table.
select 'exactly one account satisfies both locks',
       coalesce((select case when count(*) = 1 then 'PASS'
                             else 'FAIL -- ' || count(*)::text || ' accounts, expected 1' end
                   from profiles p join auth.users u on u.id = p.id
                  where p.is_platform_admin is true
                    and lower(u.email) = lower('marchenry73@gmail.com')), 'FAIL')
union all
select 'and it is the expected address',
       coalesce((select case when lower(u.email) = 'marchenry73@gmail.com' then 'PASS'
                             else 'FAIL -- ' || u.email end
                   from profiles p join auth.users u on u.id = p.id
                  where p.is_platform_admin is true limit 1), 'FAIL -- nobody carries the flag')
union all
-- CANARY. The same expression against an address that is not pinned must find
-- nobody. If this ever says PASS-by-accident the comparison is not comparing.
select 'CANARY: a different address is refused by the same expression',
       case when (select count(*) from profiles p join auth.users u on u.id = p.id
                   where p.is_platform_admin is true
                     and lower(u.email) = lower('not-the-operator@example.com')) = 0
            then 'PASS' else 'FAIL -- the email comparison is not discriminating' end
union all
-- CANARY. No flag carried by anyone else, under any address.
select 'CANARY: no second account carries the flag',
       case when (select count(*) from profiles where is_platform_admin is true) = 1
            then 'PASS'
            else 'FAIL -- ' ||
                 (select count(*)::text from profiles where is_platform_admin is true) ||
                 ' profiles carry the platform-admin flag' end
union all
-- This statement runs as the database owner, with no JWT, so auth.uid() is
-- null: the one caller that must always be told no.
select 'a caller with no session is refused',
       case when public.is_platform_admin() then 'FAIL -- it answered yes to nobody' else 'PASS' end;
