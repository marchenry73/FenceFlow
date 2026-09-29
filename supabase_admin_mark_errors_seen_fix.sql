-- supabase_admin_mark_errors_seen_fix.sql -- REPLACES ONE FUNCTION. NOT APPLIED.
-- Run in: Supabase -> SQL Editor -> New query -> Run  (when you decide to).
--
-- What this fixes: the Crashes panel's "Mark seen" button (website/admin.html,
-- markCrashGroupSeen() / adminAction()) calls admin_mark_errors_seen(msg, wh)
-- and treats { error: null } as success -- there is nothing else it could do
-- with a function that RETURNS VOID. Live pg_proc, read directly (2026-09-28):
--
--   CREATE OR REPLACE FUNCTION public.admin_mark_errors_seen(msg text, wh text)
--    RETURNS void
--    LANGUAGE sql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--       update app_errors
--          set seen = true
--        where is_platform_admin()
--          and message = msg
--          and where_at = wh;
--   $function$
--
-- The platform-admin check sits INSIDE the UPDATE's WHERE clause instead of
-- being a raised exception. So when the caller fails it -- most concretely,
-- when their second factor has gone stale on the SERVER (is_platform_admin()
-- folds in admin_second_factor_ok()) in the window between admin.html's own
-- client-side secondFactorFresh() last checking and this RPC actually
-- landing -- the UPDATE matches zero rows, PostgREST hands back
-- { error: null, data: null }, exactly the shape of a genuine success, and
-- the page reloads and shows the row still unseen with no indication anything
-- was refused. The gate itself is NOT broken: nobody who fails it can mark a
-- row seen, and this is not a security hole. It fails silently instead of
-- loudly, which is the button-lies rule the owner cares about most.
--
-- Every OTHER admin_* RPC in this database puts its guard at the top of a
-- plpgsql body and RAISEs on failure, never inside a WHERE clause -- read live
-- in the same session as the function above:
--
--   admin_suspend(target, note, hold):
--     if not is_platform_admin() then
--         raise exception 'Only a FenceFlow admin may change company access.';
--     end if;
--   admin_unsuspend(target): the same guard, same message.
--   admin_promote_release(target_id):
--     if not public.is_platform_admin() then
--         raise exception 'Only a FenceFlow admin may promote a release.';
--     end if;
--   admin_create_company(company_name, contact_email): the same, before the
--     insert -- the one admin_* function that returns something on success
--     (company_id, setup_code), which a row count would have no room for.
--
-- CHOICE: raise, not a returned row count. Two reasons.
--
--   1. Consistency. Every admin_* function here that has nothing to hand back
--      on success already signals failure by raising, not by a count the
--      caller must remember to check. A row count on just this one function
--      would be the only admin_* RPC using that shape for no reason tied to
--      what it does -- admin_create_company returns a row because it MUST
--      (there is no other way to hand back the generated id and code), not
--      because returning-something is this database's convention for
--      reporting failure. admin_mark_errors_seen has nothing else to report,
--      so it should look like admin_suspend/admin_unsuspend/
--      admin_promote_release, not invent a second convention next to them.
--   2. Safety while unapplied. website/admin.html's adminAction() and the
--      loop in markCrashGroupSeen() (website/admin.html) already treat
--      `error` from db.rpc(...) as the one failure signal and read no success
--      payload at all. Raising slots into that existing check with NO page
--      change required for the "authorized" path. A row-count return WOULD
--      need the page to start reading `data`, and until this file is run
--      `data` from the CURRENT function is always null -- code written to
--      expect a count would see `null` and either misreport a real success as
--      a failure, or throw on `null.rows_affected`: a new bug layered on top
--      of the one being fixed here, and exactly what this wave was told to
--      avoid.
--
-- Page behaviour, both with and without this file applied (website/admin.html,
-- markCrashGroupSeen() and adminAction()):
--
--   Applied:     an unauthorized call raises -> `error` is set -> adminAction()
--                shows error.message and does NOT reload; the loop in
--                markCrashGroupSeen() shows the same message (after reloading
--                first, so the reload cannot erase it -- see that function's
--                comment) and stops, leaving any already-marked rows marked.
--                An authorized call is unchanged: it still marks the row(s)
--                and reloads.
--   Not applied: behaves exactly as it does today -- an unauthorized call
--                still silently matches zero rows, because the live function
--                is untouched until this is run. Leaving this file unapplied
--                introduces no new failure mode; the page's fix this wave
--                (the reload-then-report ordering) is inert until this lands,
--                same as it is today.
--
-- Signature (msg text, wh text) and return type (void) are unchanged, so this
-- is a plain CREATE OR REPLACE: no grants change, no caller needs to change,
-- and the page's part of this fix needs nothing further once this is run.
--
-- Scope check (see this wave's findings for the fuller comparison): unlike
-- the unapplied pricing_drift_admin_update RLS policy in
-- supabase_admin_drift_mark_seen_patch.sql, which -- because a row-level
-- security policy cannot be scoped to a column -- grants UPDATE on every
-- column of every company's pricing_drift row, this function grants nothing
-- broader than before. It is a SECURITY DEFINER function that runs exactly
-- one hardcoded UPDATE statement touching exactly one column (seen), on rows
-- selected by exactly the same (message, where_at) match the live function
-- already uses -- not a policy handing out a verb over a whole table. This
-- patch changes WHERE the admin check lives (WHERE clause vs. raised
-- exception); it does not widen what an admin, once past that check, is
-- permitted to write.

create or replace function public.admin_mark_errors_seen(msg text, wh text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
    if not is_platform_admin() then
        raise exception 'Only a FenceFlow admin may mark errors seen.';
    end if;

    update app_errors
       set seen = true
     where message = msg
       and where_at = wh;
end;
$function$;
