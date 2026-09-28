-- ============================================================
-- FenceFlow -- the admin portal cannot tell one company from another
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- NOT APPLIED. Written on 28 September for list item F3 and left for March to
-- run. The website/admin.html change that goes with it is complete and safe
-- without this file: with no owner_email in the answer the page renders exactly
-- as it did before, because it tells "the column is not there" apart from "this
-- company has no owner" and says nothing in the first case.
--
-- KIND
--   A FUNCTION REPLACEMENT, additive. It adds ONE column to the end of what
--   admin_companies() returns. No table is altered, no policy is touched, no
--   grant is widened, nothing is dropped except the function itself on its way
--   to being recreated, and re-running it changes nothing. Same shape as
--   supabase_admin_columns_patch.sql, which added the last two columns to this
--   same function for the same reason.
--
-- WHY
--   March: "My company in the admin is marchenry73@gmail.com, so it should show
--   that email." The portal shows him marc@fenceflowapp.com.
--
--   Both are correct, which is the actual problem. companies.email is a typed
--   setting and it is CUSTOMER-FACING: quote-view hands it to the public quote
--   page, which prints it as the company's contact line, and invite-crew uses it
--   as the reply-to on the invitations a company sends its own crew. It is
--   pointed at whatever address a company wants a customer to answer. So it is
--   not an identity, and nothing makes it unique -- read live on 28 September,
--   two companies on this list carry the SAME companies.email, and the admin's
--   own company carries a FenceFlow address in it.
--
--   Flipping that column to his login would fix the admin screen by putting a
--   personal Gmail address on his customers' quotes. One column cannot do both
--   jobs. So the column stays where it is and keeps its meaning, and the portal
--   gets the one address about a company that cannot be shared and cannot be
--   retyped from the admin screen: the email its OWNER signs in with.
--
--   This is not cosmetic. On 2026-09-23 the admin suspended his own company from
--   this list, which took his whole office offline, because his own row did not
--   look like his -- and then he could not find it again to undo it.
--
-- WHERE THE ADDRESS COMES FROM
--   auth.users.email, through the profile with role OWNER in that company. There
--   is no email column on public.profiles at all (checked; the columns are id,
--   company_id, full_name, role, created_at, is_platform_admin,
--   permission_overrides, requested_role, app_version_code, app_version_name,
--   last_seen_at, removed_from_company_id, removed_at, active_device_id,
--   active_device_at), so auth.users is the only place it lives.
--
-- NOTHING IS OPENED UP
--   Read live: authenticated and anon both have NO select privilege on
--   auth.users, and neither gets one here. This function is SECURITY DEFINER
--   owned by postgres, which does have it, and that boundary is the only way the
--   address is reachable. PART 2 proves all three.
--
--   There is no new RPC. The gate is the one already in the function body,
--   in the same place, unchanged:
--
--       from companies c
--       where is_platform_admin()
--
--   and is_platform_admin() is itself, live:
--
--       select coalesce((select is_platform_admin from profiles
--                         where id = auth.uid()), false)
--          and public.admin_second_factor_ok();
--
--   -- so the platform-admin flag AND the second factor both still have to hold
--   before any row is produced, and one company's owner email is no more
--   reachable by another company than its name and revenue already were. Adding
--   a separate owner-email RPC would have created a second surface to get that
--   wrong; extending the answer the gate already guards creates none.
--
-- THE TWO JUDGEMENT CALLS IN THIS FILE
--   1. A company with no OWNER profile still returns a row, with owner_email
--      null. That is a real state and a common one -- read live, four of the ten
--      companies are in it (one real company plus the three ZZ TEST rows), so
--      making the owner a requirement would have hidden them from the only page
--      that can start their trial. A scalar subquery is used rather than a join
--      precisely because it yields null instead of dropping the row.
--   2. If a company somehow has two OWNER profiles, the OLDEST by created_at
--      wins, because that is the founder. claim_invited_company already refuses
--      a second owner, so this is a tiebreak for old data rather than a policy;
--      what matters is that it is deterministic, so the list does not reorder
--      the same address in and out between refreshes.
--
-- TO UNDO
--   Re-run the second half of supabase_admin_columns_patch.sql, which is the
--   body this file started from -- read off the live database with
--   pg_proc.prosrc on 28 September and found identical to that file, so nothing
--   has drifted in between. The only difference below is the final column and
--   the subquery that fills it.
-- ============================================================

-- ------------------------------------------------------------------------
-- PART 1  the function, recreated from its own live body
--
-- DROP then CREATE rather than CREATE OR REPLACE: Postgres refuses to change a
-- function's OUT columns in place. The new column is appended LAST, so nothing
-- that reads this result by position shifts -- and the ACL is restated
-- underneath, because a plain CREATE resets it to the default, which is how
-- anon picked up EXECUTE on a reporting function here once already.
-- ------------------------------------------------------------------------

drop function if exists public.admin_companies();
create function public.admin_companies()
returns table(id uuid, name text, email text, subscription_status text,
              subscription_plan text, monthly_price numeric, suspended boolean,
              suspended_reason text, trial_ends_at timestamptz, days_left integer,
              allowed boolean, people bigint, jobs bigint, last_active timestamptz,
              admin_notes text, billing_email text, grace_ends_at timestamptz,
              oldest_app_version text, newest_app_version text, last_seen timestamptz,
              invited_at timestamptz, invited_email text, joined_at timestamptz,
              details_completed_at timestamptz, agreement_signed_at timestamptz,
              agreement_signed_name text, subscription_ends_at timestamptz,
              stripe_subscription_id text, owner_email text)
language sql security definer set search_path to 'public'
as $$
    select c.id, c.name, c.email, c.subscription_status::text, c.subscription_plan::text,
           c.monthly_price, c.suspended, c.suspended_reason,
           c.trial_ends_at,
           case when c.trial_ends_at is null then null
                else greatest(0, extract(day from c.trial_ends_at - now())::int) end,
           public.company_allowed(c.id),
           (select count(*) from profiles p where p.company_id = c.id),
           (select count(*) from jobs j where j.company_id = c.id and j.deleted_at is null),
           (select max(j.updated_at) from jobs j where j.company_id = c.id),
           c.admin_notes, c.billing_email, c.grace_ends_at,
           (select p.app_version_name from profiles p
             where p.company_id = c.id and p.app_version_code is not null
             order by p.app_version_code asc limit 1),
           (select p.app_version_name from profiles p
             where p.company_id = c.id and p.app_version_code is not null
             order by p.app_version_code desc limit 1),
           (select max(p.last_seen_at) from profiles p where p.company_id = c.id),
           c.invited_at, c.invited_email, c.joined_at,
           c.details_completed_at, c.agreement_signed_at, c.agreement_signed_name,
           c.subscription_ends_at, c.stripe_subscription_id::text,
           -- The address this company's owner signs in with. A scalar subquery,
           -- so a company with nobody in the OWNER role still returns its row
           -- with a null here instead of disappearing from the only page that
           -- can start its trial. Oldest owner wins, so the answer does not
           -- change between two refreshes.
           --
           -- No filter on removed_at: release_seat sets company_id to null when
           -- somebody is removed and clears removed_at again when they are let
           -- back in, so company_id alone already excludes a removed person --
           -- and this matches the people/version subqueries above, which is
           -- what keeps the seat count and the owner talking about one set.
           (select u.email::text
              from profiles p
              join auth.users u on u.id = p.id
             where p.company_id = c.id and p.role = 'OWNER'
             order by p.created_at asc
             limit 1)
    from companies c
    where is_platform_admin()
    order by c.name;
$$;
revoke execute on function public.admin_companies() from public, anon;
grant  execute on function public.admin_companies() to authenticated;

-- ------------------------------------------------------------------------
-- PART 2  prove every claim above, one row each
--
-- READ THIS FIRST, because it decides what the checks below can be about.
--
-- The SQL editor runs as postgres, so auth.uid() is null, so
-- is_platform_admin() is false, so `select * from admin_companies()` returns
-- ZERO ROWS however well or badly this file worked. A row count taken from the
-- function here would read zero on a perfect install and zero on a broken one.
-- That is the "an empty answer reads as good news" trap, and it is why every
-- check below is about either the SHAPE of the function or the owner-email
-- EXPRESSION run directly against companies -- never about rows coming out of
-- admin_companies() itself.
--
-- One check below looks duller than it is. The owner subquery selects
-- auth.users.email, so on its own its output column is called `email` -- the
-- same name companies.email already has in this select list. A `returns
-- table(...)` function takes its OUT names from the DECLARATION rather than from
-- the select list, so the real function is safe; but a probe that copies the
-- body out and runs it as a plain query gets two columns called `email` and a
-- JSON client keeps the last one, which reads as though companies.email held the
-- owner's address. That happened while this file was being written. The position
-- check is what proves column 3 is still `email` and the owner arrived as
-- `owner_email`, and it is the reason it asserts names rather than counting.
--
-- PART 2 was run on its own against the UNCHANGED function on 28 September,
-- which is the only way to know it can fail. It answered:
--
--     owner_email is the last column admin_companies returns ......... false
--     every column it had is still in its original position ......... true
--     CANARY the position test is reading something ................. false  (28, not 29)
--     the owner email really comes from auth.users, not companies.email  false
--     CANARY the body test can find text that is there .............. true
--     the platform-admin gate is still in the body .................. true
--     CANARY no signed-out escape hatch was added to the body ....... true
--     it is still SECURITY DEFINER with a pinned search_path ........ true
--     authenticated can execute it .................................. true
--     CANARY anon cannot execute it ................................. true
--     CANARY the execute test can answer true for anon somewhere .... true
--     anon cannot read auth.users directly .......................... true
--     authenticated cannot read auth.users directly ................. true
--     CANARY postgres CAN read auth.users ........................... true
--     no company is lost by the owner-email subquery ................ true
--     at least one company has an owner email ....................... true
--     at least one company has none, and still has a row ............ true
--     CANARY an owner login differs from its companies.email somewhere  true
--
-- The three false rows are the three that depend on PART 1. Every row should
-- read true after it.
-- ------------------------------------------------------------------------

with outs as (
    -- The OUT columns of admin_companies, in order. proargmodes 't' is a TABLE
    -- column; this function takes no IN arguments, so they are all 't'.
    select a.ord, a.name
      from pg_proc p,
           unnest(p.proargnames, p.proargmodes) with ordinality as a(name, mode, ord)
     where p.pronamespace = 'public'::regnamespace and p.proname = 'admin_companies'
       and a.mode = 't'
),
body as (
    select p.prosrc, p.prosecdef, p.proconfig
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname = 'admin_companies'
),
owners as (
    -- The new subquery, run here on its own so its behaviour can be checked
    -- without going through the gate that silences the function in this editor.
    select c.id, c.email as company_email,
           (select u.email::text
              from profiles p
              join auth.users u on u.id = p.id
             where p.company_id = c.id and p.role = 'OWNER'
             order by p.created_at asc
             limit 1) as owner_email
      from companies c
)
select 'owner_email is the last column admin_companies returns' as check,
       (select name from outs where ord = (select max(ord) from outs)) = 'owner_email' as ok
union all
select 'every column it had is still in its original position',
       (select name from outs where ord = 1)  = 'id'
   and (select name from outs where ord = 3)  = 'email'
   and (select name from outs where ord = 16) = 'billing_email'
   and (select name from outs where ord = 28) = 'stripe_subscription_id'
union all
-- CANARY for the position check. Every comparison above is against a subselect
-- that returns null when no such position exists, and null is not false -- a
-- function that had lost half its columns could read null here and skim past as
-- "not a failure". So count them.
select 'CANARY: the position test is reading something, not coming back null',
       (select count(*) from outs) = 29
union all
select 'the owner email really comes from auth.users, not from companies.email',
       (select prosrc from body) like '%auth.users%'
   and (select prosrc from body) like '%''OWNER''%'
union all
-- CANARY for the two body checks above and the two below. All four are "is this
-- text in prosrc", and a prosrc that came back null -- wrong name, wrong schema
-- -- makes a LIKE read null and a NOT LIKE read null too. Prove the same test
-- finds something that has always been in this body.
select 'CANARY: the body test can find text that is there',
       (select prosrc from body) like '%from companies c%'
union all
select 'the platform-admin gate is still in the body',
       (select prosrc from body) like '%where is_platform_admin()%'
union all
-- A real guard, not just a canary: the one way this function could start
-- answering to a caller who is not a platform admin is an "if there is no
-- signed-in user, allow it" hatch of the kind that once made admin_mark_invited
-- callable by anybody at all. auth.uid() is null for an anonymous visitor just
-- as it is for the service role, so that shape must never appear here.
select 'CANARY: no signed-out escape hatch was added to the body',
       (select prosrc from body) not like '%auth.uid() is null%'
   and (select prosrc from body) not like '%service_role%'
union all
select 'it is still SECURITY DEFINER with a pinned search_path',
       (select prosecdef from body)
   and (select coalesce(array_to_string(proconfig, ','), '') from body) like '%search_path=public%'
union all
select 'authenticated can execute it',
       has_function_privilege('authenticated', 'public.admin_companies()', 'EXECUTE')
union all
select 'CANARY: anon cannot execute it',
       not has_function_privilege('anon', 'public.admin_companies()', 'EXECUTE')
union all
-- CANARY for the row above. has_function_privilege answers true for a superuser
-- on anything and the anon check is a NOT, so a test that could only ever say
-- "anon has nothing" would pass this file while proving nothing. is_platform_admin
-- is deliberately executable by anon (it answers false, and policies call it),
-- so asking about it proves this test can still say true about anon.
select 'CANARY: the execute test can answer true for anon somewhere',
       has_function_privilege('anon', 'public.is_platform_admin()', 'EXECUTE')
union all
select 'anon cannot read auth.users directly',
       not has_table_privilege('anon', 'auth.users', 'SELECT')
union all
select 'authenticated cannot read auth.users directly',
       not has_table_privilege('authenticated', 'auth.users', 'SELECT')
union all
-- CANARY for the two rows above: both are NOTs, and a privilege test that
-- answered false to everything would pass them while telling us nothing. The
-- SECURITY DEFINER boundary only works because its owner CAN read the table.
select 'CANARY: postgres CAN read auth.users, so the boundary has something to cross',
       has_table_privilege('postgres', 'auth.users', 'SELECT')
union all
select 'no company is lost by the owner-email subquery',
       (select count(*) from owners) = (select count(*) from companies)
union all
select 'at least one company has an owner email',
       exists (select 1 from owners where owner_email is not null)
union all
select 'at least one company has none, and still has a row',
       exists (select 1 from owners where owner_email is null)
union all
-- CANARY that this change does anything at all. If the subquery had been
-- written to hand back companies.email under a new name -- which is the lazy
-- way to make every other row above pass -- this row reads false. It is the
-- only check here that depends on live data: it is true because Fence solutions
-- signs in as one address and shows customers another, which is the whole
-- reason for the file. If it ever reads false, find out whether the data was
-- tidied or the subquery was quietly changed before believing anything above.
select 'CANARY: an owner login differs from its companies.email somewhere, so this is not just email renamed',
       exists (select 1 from owners
                where owner_email is not null
                  and lower(owner_email) <> lower(coalesce(company_email, '')));
