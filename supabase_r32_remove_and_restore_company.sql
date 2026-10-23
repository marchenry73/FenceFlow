-- ============================================================
-- FenceFlow -- a company can be removed, and brought back.
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- "I want to be able to remove companies too, I want that option so they can
-- get out of the system. Also want the recycle too on there."
--
-- NOTHING IS DELETED. deleted_at is a stamp, not a DELETE: their jobs, their
-- money, their drawings and their mail stay exactly where they are. A removal
-- that destroyed a customer's records would be unrecoverable, and the one
-- thing a recycle bin promises is that it is not.
--
-- ONE GATE DOES THE WORK. company_allowed() is what every policy and every
-- screen already asks before a company's office opens, so the filter goes
-- THERE: a removed company stops working everywhere at once, including in
-- code written after this. Hiding it from the admin list alone would have
-- left a removed company signing in and working normally, which is not a
-- removal at all.
-- ============================================================

alter table public.companies
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid;

grant select, insert, update on public.companies to authenticated;

-- ---- the one gate -------------------------------------------------------
-- Rewritten whole rather than patched: this is the function that decides
-- whether somebody's business opens tomorrow morning, and a blind edit
-- through it is not a thing to do. Only the first line is new; every other
-- clause is carried over exactly, comments and all.
create or replace function public.company_allowed(cid uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $gate$
    -- Removed companies are out, before anything else is considered.
    select c.deleted_at is null
       and (not c.suspended)
       and c.subscription_status is distinct from 'canceled'
       and (
            c.subscription_status = 'active'
            -- 'trialing' used to pass on its own, whatever the date, so a
            -- trial whose end had come and gone kept full access for ever.
            -- A NULL trial end still passes: a subscriber whose trial_end has
            -- not arrived from Stripe yet must not be locked out on their
            -- first day, which is the worse of the two failures and has
            -- happened here before.
            or (c.subscription_status = 'trialing'
                and (c.trial_ends_at is null or c.trial_ends_at > now()))
            or (c.trial_ends_at is not null and c.trial_ends_at > now())
            or (c.subscription_status = 'past_due'
                and coalesce(c.grace_ends_at, c.subscription_ends_at) is not null
                and coalesce(c.grace_ends_at, c.subscription_ends_at) > now())
       )
      from companies c
     where c.id = cid;
$gate$;

-- ---- the list, minus the bin --------------------------------------------
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
    -- A removed company is in the recycle bin, not in the list. Restoring
    -- it clears deleted_at and it comes back whole, which is the whole
    -- point of a bin.
    where is_platform_admin() and c.deleted_at is null
    order by c.name;
$function$
;


-- ---- the bin ------------------------------------------------------------
create or replace function public.admin_removed_companies()
returns table(id uuid, name text, email text, removed_at timestamptz, people bigint, jobs bigint)
language sql
stable
security definer
set search_path to 'public'
as $bin$
    select c.id, c.name, c.email, c.deleted_at,
           (select count(*) from profiles p where p.company_id = c.id),
           (select count(*) from jobs j where j.company_id = c.id and j.deleted_at is null)
      from companies c
     where is_platform_admin() and c.deleted_at is not null
     order by c.deleted_at desc;
$bin$;

-- ---- removing and restoring ---------------------------------------------
create or replace function public.admin_remove_company(target uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $rm$
begin
    if not public.is_platform_admin() then
        raise exception 'Only a platform admin can remove a company.';
    end if;
    -- Not your own. Removing it would lock the operator out of the console
    -- that is the only way to undo it.
    if exists (select 1 from profiles p where p.id = auth.uid() and p.company_id = target) then
        raise exception 'That is your own company.';
    end if;
    -- coalesce, so removing an already-removed company does not move the date
    -- it went into the bin.
    update companies
       set deleted_at = coalesce(deleted_at, now()), deleted_by = auth.uid()
     where id = target;
end $rm$;

create or replace function public.admin_restore_company(target uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $rs$
begin
    if not public.is_platform_admin() then
        raise exception 'Only a platform admin can restore a company.';
    end if;
    update companies set deleted_at = null, deleted_by = null where id = target;
end $rs$;

revoke all on function public.admin_removed_companies() from public;
revoke all on function public.admin_remove_company(uuid) from public;
revoke all on function public.admin_restore_company(uuid) from public;
-- anon as well as authenticated: these are is_platform_admin()-gated inside,
-- and taking EXECUTE off anon is what made eight tables 401 instead of
-- answering nothing this morning. Tighten what a function RETURNS, never who
-- may call it.
grant execute on function public.admin_removed_companies() to anon, authenticated;
grant execute on function public.admin_remove_company(uuid) to anon, authenticated;
grant execute on function public.admin_restore_company(uuid) to anon, authenticated;

-- ------------------------------------------------------------------------
-- PROOF.
-- ------------------------------------------------------------------------
select 'the column exists' as check,
       case when exists (select 1 from information_schema.columns
                          where table_schema='public' and table_name='companies'
                            and column_name='deleted_at') then 'PASS' else 'FAIL' end as result
union all
select 'the one gate checks it',
       case when position('deleted_at is null' in
              (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='public' and p.proname='company_allowed')) > 0
            then 'PASS' else 'FAIL -- a removed company would still sign in and work' end
union all
-- POSITIVE CONTROL. Without it, "the gate checks deleted_at" passes just as
-- well on a gate that now refuses everybody.
select 'and it still admits a live company',
       case when public.company_allowed((select id from companies where name = 'Fence solutions'))
            then 'PASS' else 'FAIL -- the gate now refuses a working company' end
union all
select 'the list hides the bin',
       case when position('deleted_at is null' in
              (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='public' and p.proname='admin_companies')) > 0
            then 'PASS' else 'FAIL' end
union all
-- THE CANARY for a recreate: every column the console reads must survive.
select 'the list kept all 32 of its columns',
       case when (select count(*) from (
                    select unnest(p.proargnames) nm from pg_proc p
                      join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.proname = 'admin_companies') q) = 32
            then 'PASS'
            else 'FAIL -- ' || (select count(*)::text from (
                    select unnest(p.proargnames) nm from pg_proc p
                      join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.proname = 'admin_companies') q)
                 || ' columns, expected 32' end
union all
select 'the bin and the two actions exist',
       case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname in
                     ('admin_removed_companies', 'admin_remove_company', 'admin_restore_company')) = 3
            then 'PASS' else 'FAIL' end
union all
select 'what is in the bin',
       (select count(*)::text || ' removed' from companies where deleted_at is not null);
