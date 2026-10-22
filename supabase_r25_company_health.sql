-- ============================================================
-- FenceFlow -- is this company actually using the product?
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- ADDITIVE in effect. admin_companies() gains three columns and loses none:
-- every existing column keeps its name, its type and its position. It has to
-- be DROPped first because Postgres will not change a function's return type
-- in place, and the grant is reissued below -- a dropped function takes its
-- grants with it, and a console that cannot call this is a console that shows
-- no companies at all.
--
-- WHY. The list showed people and jobs EVER, and a total never goes down. A
-- company that stopped using FenceFlow in August looked exactly like one that
-- used it this morning, so the one question an operator actually has about a
-- customer -- are they still here -- had no answer anywhere in the product.
-- It was the top finding when the console was compared against Stripe,
-- Shopify Partners, Sentry, PostHog and the Retool/Forest-Admin world: every
-- one of them leads with recency, and this led with totals.
--
-- THREE COUNTS, one window: people seen, jobs created, quotes sent, all over
-- 30 days. Three because they fail differently -- last_seen_at is written by
-- the PHONE, so a company that only uses the office website reads as
-- nobody-seen, and a single people-based figure would call it dormant while
-- it quoted every day.
--
-- NOT A SCORE. No weighting, no 0-100, nothing invented. Three counts and the
-- dates they came from. The console turns them into a colour and says which
-- rule it used, so the rule can be argued with.
-- ============================================================

drop function if exists public.admin_companies();

CREATE OR REPLACE FUNCTION public.admin_companies()
 RETURNS TABLE(id uuid, name text, email text, subscription_status text, subscription_plan text, monthly_price numeric, suspended boolean, suspended_reason text, trial_ends_at timestamp with time zone, days_left integer, allowed boolean, people bigint, jobs bigint, last_active timestamp with time zone, admin_notes text, billing_email text, grace_ends_at timestamp with time zone, oldest_app_version text, newest_app_version text, last_seen timestamp with time zone, invited_at timestamp with time zone, invited_email text, joined_at timestamp with time zone, details_completed_at timestamp with time zone, agreement_signed_at timestamp with time zone, agreement_signed_name text, subscription_ends_at timestamp with time zone, stripe_subscription_id text, owner_email text, active_people_30d bigint, jobs_30d bigint, quotes_30d bigint)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
             limit 1),
           -- ---- HOW ALIVE IS THIS COMPANY --------------------------------
           -- Three counts over the same 30 days. They answer what the list
           -- could not: people and jobs above are totals EVER, and a total
           -- never goes down, so a company that stopped using FenceFlow in
           -- August looked exactly like one that used it this morning.
           --
           -- Three rather than one because they fail differently.
           -- last_seen_at is written by the PHONE, so a company that only
           -- ever opens the office website reads as nobody-seen; judging a
           -- quiet month on people alone would call it dormant while it
           -- quoted every day.
           (select count(*) from profiles p
             where p.company_id = c.id and p.last_seen_at > now() - interval '30 days'),
           (select count(*) from jobs j
             where j.company_id = c.id and j.deleted_at is null
               and j.created_at > now() - interval '30 days'),
           (select count(*) from jobs j
             where j.company_id = c.id and j.deleted_at is null
               and j.quote_sent_at > now() - interval '30 days')
    from companies c
    where is_platform_admin()
    order by c.name;
$function$
;


-- The grant goes back on: DROP took it with it.
revoke all on function public.admin_companies() from public;
revoke all on function public.admin_companies() from anon;
grant execute on function public.admin_companies() to authenticated;

-- ------------------------------------------------------------------------
-- PROOF. Read back, never trusted from the statement's own success.
-- ------------------------------------------------------------------------
select 'the function exists' as check,
       case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.proname = 'admin_companies')
            then 'PASS' else 'FAIL' end as result
union all
select 'it still runs as its owner',
       coalesce((select case when p.prosecdef then 'PASS' else 'FAIL -- not SECURITY DEFINER' end
                   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'admin_companies'), 'FAIL')
union all
select 'the console can still call it',
       case when has_function_privilege('authenticated', 'public.admin_companies()', 'execute')
            then 'PASS' else 'FAIL -- the grant did not come back; the list will be empty' end
union all
select 'anon still cannot',
       case when has_function_privilege('anon', 'public.admin_companies()', 'execute')
            then 'FAIL -- a signed-out visitor can list every company' else 'PASS' end
union all
-- The returned column names come from pg_proc.proargnames, NOT from
-- information_schema.columns: a function's RETURNS TABLE output is not a
-- table, so information_schema.columns knows nothing about it and would have
-- answered zero for both of these checks -- a canary that always fails is no
-- better than one that always passes.
select 'the three new columns are there',
       case when (select count(*) from (
                    select unnest(p.proargnames) as nm from pg_proc p
                      join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.proname = 'admin_companies') q
                   where q.nm in ('active_people_30d', 'jobs_30d', 'quotes_30d')) = 3
            then 'PASS' else 'FAIL -- at least one new column is missing' end
union all
-- THE CANARY for a drop-and-recreate: every column the console already reads
-- has to still be there. Losing one quietly takes a working page down.
select 'no existing column was lost',
       case when (select count(*) from (
                    select unnest(p.proargnames) as nm from pg_proc p
                      join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.proname = 'admin_companies') q
                   where q.nm in ('id','name','email','subscription_status','subscription_plan',
                       'monthly_price','suspended','suspended_reason','trial_ends_at','days_left',
                       'allowed','people','jobs','last_active','admin_notes','billing_email',
                       'grace_ends_at','oldest_app_version','newest_app_version','last_seen',
                       'invited_at','invited_email','joined_at','details_completed_at',
                       'agreement_signed_at','agreement_signed_name','subscription_ends_at',
                       'stripe_subscription_id','owner_email')) = 29
            then 'PASS'
            else 'FAIL -- the recreated function lost one of the 29 columns the console reads' end
union all
select 'it still answers only a platform admin',
       case when position('is_platform_admin()' in
              (select pg_get_functiondef(p.oid) from pg_proc p
                 join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'admin_companies')) > 0
            then 'PASS' else 'FAIL -- the admin check is gone' end;
