-- A LIMITED RELEASE COULD BE PUBLISHED BUT NOT PROMOTED.
--
-- supabase_release_audience_patch.sql did the hard half: a build can ship to
-- named companies first, and the rule is enforced in the READ POLICY, so
-- phones already in the field respect an audience they know nothing about.
-- That part is right and this patch does not touch it.
--
-- What it did not do is leave the platform admin a way back in. app_releases
-- has exactly one policy --
--
--     app_releases_read  SELECT  using (
--         (available_from is null or available_from <= now())
--         and (audience = 'everyone' or release_visible_to_caller(id)))
--
-- -- and release_visible_to_caller() answers "is the CALLER's company on this
-- release's list". There is no is_platform_admin() clause anywhere in it. The
-- admin is one signed-in person in one company like everybody else, so he can
-- see a limited release only when he happened to aim it at himself. Of the
-- one-company rollouts he could publish -- nine of them on 14 September 2026,
-- one per company, and more every time a company signs up -- exactly one, the
-- one naming his own company, comes back to him. The console's Releases table
-- read app_releases directly, so all the others arrived as no row at all: no
-- Promote button, because there is nothing to draw one on.
--
-- Measured, not assumed, before this was written (rolled back):
--   admin reads an 'everyone' release                            -> 1 row
--   admin reads a limited release naming his OWN company         -> 1 row
--   admin reads a limited release naming another company         -> 0 rows
--   admin_promote_release() on that invisible release            -> promotes it
-- So promotion was never the broken half. admin_promote_release() is SECURITY
-- DEFINER, owned by postgres, and does its own is_platform_admin() check, so
-- it moves a row the caller cannot see -- if you can produce the uuid. Getting
-- the uuid meant reading app_releases by hand over psql. Only SEEING was
-- broken, so only seeing is fixed here.
--
-- WHY A DEFINER FUNCTION AND NOT A BYPASS IN THE POLICY.
-- Adding `is_platform_admin() or ...` to app_releases_read would be the
-- smaller diff and the larger risk. That policy is the one every phone in the
-- field evaluates, including a phone with no session at all:
-- supabase_release_visibility_patch.sql exists precisely because a tokenless
-- update check that comes back EMPTY is indistinguishable from "you are on the
-- latest version", and the update prompt silently stopped appearing. Putting
-- is_platform_admin() in that policy means anon evaluates it too, and
-- is_platform_admin() is granted to authenticated only -- an anonymous phone
-- would get `permission denied for function is_platform_admin`, which is that
-- same failure with an error instead of silence. The alternatives were to
-- grant a platform-ownership predicate to anon, or to write a second
-- near-copy of it that anon may call, and supabase_release_guard_patch.sql
-- already argues against having two definitions of the same question that can
-- drift apart.
--
-- So: the policy is not touched at all. Not relaxed, not re-created, not
-- re-stated -- the `create policy` statement does not appear in this file.
-- What a non-admin or an anonymous caller can read out of app_releases after
-- this patch is the same predicate, byte for byte, that they read it through
-- before. The admin gets a separate door instead, gated on the same flag the
-- promote function is already gated on.
--
-- ORDER OF OPERATIONS. website/admin.html now calls admin_releases() instead
-- of selecting from app_releases, so run this file BEFORE publishing that
-- page. If the page goes out first the Releases panel shows PostgREST's
-- "could not find the function" in its message line -- which is at least the
-- honest failure rather than an empty table that reads as "nothing has ever
-- shipped" -- but it is a broken panel until this runs.
--
-- Proved by installing this file and running
-- supabase_admin_release_visibility_proof.sql inside one transaction that was
-- then rolled back, against the live project on 14 September 2026. Every step
-- passed, and the five numbers that describe what a non-admin and an
-- anonymous caller can see came back identical to the same probe run before
-- the function existed.
--
-- To undo:
--   drop function if exists public.admin_releases();

-- Every release there is, for the one account that is allowed to see them
-- all. SECURITY DEFINER and owned by postgres, so RLS on app_releases does
-- not apply inside it -- exactly the mechanism admin_promote_release() has
-- always used, and the reason it can already promote a row the caller cannot
-- read.
--
-- It RAISES for a non-admin rather than returning no rows. An empty list is
-- the answer a genuinely empty release table gives, and this console has been
-- caught by that shape of ambiguity before; a caller who is not entitled to
-- this should be told so, not handed something that reads as good news.
--
-- available_from is deliberately NOT filtered here. The policy hides a release
-- scheduled for next Tuesday from everybody, the person who scheduled it
-- included, so the console could not show a pending rollout at all. The admin
-- is the one reader for whom the honest answer is the table's actual contents;
-- the console labels a future-dated row as not yet visible to phones rather
-- than letting it pass for a live one.
create or replace function public.admin_releases()
returns setof public.app_releases
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
    if not public.is_platform_admin() then
        raise exception 'Only a FenceFlow admin may list every release.'
            using errcode = '42501';
    end if;
    -- Newest first, the order the console has always drawn them in. Kept here
    -- rather than left to the caller so the one consumer cannot quietly get a
    -- different order from a planner change.
    return query
        select * from public.app_releases order by released_at desc;
end;
$$;

-- anon has no business calling this and must not be able to: the check inside
-- would already refuse it (auth.uid() is null, so is_platform_admin() is
-- false), but a function anon cannot execute is defence that does not depend
-- on that body staying correct -- the same argument
-- supabase_release_guard_patch.sql makes for its own revokes.
revoke all on function public.admin_releases() from public, anon;
grant execute on function public.admin_releases() to authenticated;

-- Read back the three facts that matter, so this file can be run and checked
-- rather than run and hoped about:
--   * the read policy is still the one the phones had -- if the qual below is
--     anything other than the available_from/audience pair quoted at the top
--     of this file, something in this patch went further than it claims to;
--   * the new function exists and is a definer;
--   * anon cannot execute it.
-- Behaviour is proved separately and against real callers, in
-- supabase_admin_release_visibility_proof.sql.
select
  (select qual from pg_policies
    where schemaname = 'public' and tablename = 'app_releases'
      and policyname = 'app_releases_read')                        as read_policy_unchanged,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'app_releases')    as policies_on_app_releases,
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'admin_releases')   as admin_releases_is_definer,
  has_function_privilege('anon',          'public.admin_releases()', 'execute') as anon_may_call,
  has_function_privilege('authenticated', 'public.admin_releases()', 'execute') as authenticated_may_call;
