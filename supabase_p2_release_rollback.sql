-- Withdrawing a release: the missing half of admin_promote_release.
--
-- Phase 1 audit, release §12: production holds five release functions and not
-- one of them can take a build back. `app_releases` has exactly one policy,
-- `app_releases_read` (SELECT), so once a row says audience = 'everyone' the
-- only ways to change it are a service-role write or the CLI -- neither of
-- which is a thing to reach for at 2am with a bad build going out to every
-- phone. 1.501 is the worked example: published 02:23, five fatal crashes by
-- 13:14, and the only available response was to build forward.
--
-- What this CAN do, stated honestly so nobody expects more of it:
--
--   * it stops the build being OFFERED. `app_releases_read` already filters on
--     audience, and `release_visible_to_caller()` is false for a release with
--     no membership rows, so the next phone to ask "is there an update?" is
--     told no. That is the whole mechanism -- no new column, no new policy,
--     nothing the audience patch did not already install.
--
--   * it does NOT uninstall anything. A phone that already took the bad build
--     keeps it. Android refuses a lower versionCode and UpdateChecker filters
--     `gt(version_code, BuildConfig.VERSION_CODE)`, so there is no path back
--     down: recovery for an already-updated phone is a fix rolled FORWARD as a
--     new build through the full gate run. Demoting buys time, it does not undo.
--
-- Deliberately a mirror of admin_promote_release, down to the grants: same
-- language, same security definer, same search_path, same admin check, same
-- two statements in the same order, same revoke/grant pair. Two functions that
-- are each other's inverse should be readable as one thing. Where they differ
-- is the target value ('limited' instead of 'everyone') and nothing else.
--
-- Note that BOTH functions clear app_release_audience. On promotion that is
-- because "who was in the early group" becomes history rather than access; on
-- demotion it is the point of the exercise -- audience = 'limited' with rows
-- still in the table would keep serving the bad build to exactly the companies
-- who were trusted enough to get it first, which is the opposite of what
-- somebody calling this wants. 'limited' plus empty membership is the safe,
-- useless state the audience patch already described: it behaves like a
-- release that was never published, and the previous 'everyone' release keeps
-- answering the app's query.
--
-- Re-promoting is just admin_promote_release() again: the row is untouched
-- apart from audience, so a build withdrawn by mistake goes back out without a
-- rebuild. That round trip is proved, not assumed -- see the proof run in the
-- report that shipped this file.

create or replace function public.admin_demote_release(target_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $$
begin
    if not public.is_platform_admin() then
        raise exception 'Only a FenceFlow admin may withdraw a release.';
    end if;

    update public.app_releases set audience = 'limited' where id = target_id;
    delete from public.app_release_audience where release_id = target_id;
end;
$$;
revoke all on function public.admin_demote_release(uuid) from public, anon;
grant execute on function public.admin_demote_release(uuid) to authenticated;

comment on function public.admin_demote_release(uuid) is
  'Withdraw a release: audience back to limited with nobody on the list, so no further phone is offered it. Does not uninstall it from a phone that already updated. Platform admin only; the inverse of admin_promote_release.';

-- Read back what was just installed, next to the function it is supposed to
-- mirror. The grants are the part worth asserting: a function that exists but
-- is not executable by `authenticated` is a rollback lever the console cannot
-- pull, and it would look completely fine in \df.
select
  p.proname,
  p.prosecdef                                   as security_definer,
  p.proconfig::text                             as search_path,
  coalesce(array_to_string(p.proacl::text[], ' | '), '(default)') as grants
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('admin_promote_release', 'admin_demote_release')
order by p.proname;
