-- ============================================================
-- FenceFlow -- the admin second factor is enforced by the SERVER, not the page
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- KIND
--   ADDITIVE           public.admin_second_factor_ok() -- a new function.
--   FUNCTION-REPLACING is_platform_admin() and protect_billing_columns(). Both
--                      bodies are the LIVE ones (pg_get_functiondef, 2026-09-23)
--                      with one expression changed in each.
--   No row is written, no policy changes, nothing is dropped. Signatures are
--   identical, so every caller keeps working.
--
-- WHAT WAS WRONG (checked on production 2026-09-23)
--   website/admin.html asks for the authenticator code and refuses to render the
--   console without it (assuranceLevel(), mfaGate()). That part works.
--
--   The server never checked. is_platform_admin()'s entire body was
--       select coalesce((select is_platform_admin from profiles
--                         where id = auth.uid()), false);
--   and nothing else in the database mentioned aal, amr or assurance -- no
--   function body, no RLS policy. So a session obtained with the PASSWORD ALONE
--   could call every admin power directly: admin_suspend, admin_unsuspend,
--   admin_grant_access, admin_extend_trial, admin_start_trial,
--   admin_create_company, admin_promote_release, admin_demote_release,
--   admin_companies, admin_error_summary, admin_mark_invited, and the rest.
--   The authenticator only stopped someone LOADING the page, and nobody has to
--   load the page.
--
--   protect_billing_columns() was worse than it looked: it does not call
--   is_platform_admin() at all, it inlines its own
--       exists (select 1 from profiles where id = auth.uid() and is_platform_admin)
--   so tightening the shared function alone would have left the billing columns
--   (suspended, subscription_plan, monthly_price, stripe ids, pass_card_fee...)
--   on the old, password-only rule. It is pointed at the shared function here so
--   there is ONE gate and not two.
--
-- WHY IT CANNOT LOCK ANYONE OUT
--   The rule is "aal2 IF there is a factor to be asked for":
--     * an account with no verified factor in auth.mfa_factors behaves exactly
--       as it does today -- there is nothing to ask it for, and refusing would
--       be a lockout with no way back;
--     * an account WITH one must have used it.
--   Removing a factor already needs aal2 in Supabase, so that escape hatch
--   cannot be opened by someone holding only a password.
--
--   Proven before applying, on live data: there is exactly one account with
--   is_platform_admin, it has one verified factor, and its live session reads
--   aal = 'aal2' on auth.sessions, authenticated 'password+totp'. So the gate is
--   already satisfied for the only person it applies to.
--
-- WHY THE DATABASE DECIDES, NOT THE TOKEN
--   auth.sessions.aal is the server's own record of what a session did, and
--   auth.mfa_amr_claims lists the steps. That is checked FIRST. The signed
--   `aal` claim is accepted as well, because PostgREST verifies the token's
--   signature before setting request.jwt.claims -- so it is not weaker -- and
--   because it still answers during the window where a session row has been
--   rotated away under a live access token. Either is enough; neither alone can
--   be forged by a password-only caller.
--
-- SERVICE ROLE IS UNTOUCHED
--   auth.uid() is null there, so is_platform_admin() returned false before this
--   change and returns false after it. protect_billing_columns() returns early
--   on a null uid (the Stripe webhook's path) and protect_platform_admin_flag()
--   guards on `auth.uid() is not null` -- both unchanged.
--
-- IF IT DOES GO WRONG, the way back is one statement, and it is the first thing
-- to reach for rather than anything clever:
--   create or replace function public.admin_second_factor_ok() returns boolean
--     language sql stable security definer set search_path to 'public'
--     as $$ select true $$;
-- ============================================================

-- ------------------------------------------------------------------------
-- PART 1  did this session actually use a second factor
-- ------------------------------------------------------------------------

create or replace function public.admin_second_factor_ok()
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
    select
        -- Nothing to ask this account for. Never true for an account that has
        -- enrolled one, and the only thing standing between "no factor" and
        -- "factor" is an enrolment the account must already be aal2 to undo.
        not exists (
            select 1 from auth.mfa_factors f
             where f.user_id = auth.uid() and f.status = 'verified'
        )
        -- The server's own record of this session.
        or coalesce((
            select s.aal::text = 'aal2'
              from auth.sessions s
             where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
        ), false)
        -- ...or the signed claim in the token, for the window where the session
        -- row has been rotated away under a still-valid access token.
        or coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$function$;

comment on function public.admin_second_factor_ok() is
    'True when the caller has used a second factor on this session, or has no verified factor to use. '
    'Reads auth.sessions.aal first (the server''s own record) and the signed aal claim second. '
    'The server half of the admin MFA gate; website/admin.html is the other half. '
    'See supabase_r7_admin_second_factor.sql.';

revoke all     on function public.admin_second_factor_ok() from public;
revoke all     on function public.admin_second_factor_ok() from anon;
grant  execute on function public.admin_second_factor_ok() to authenticated;
grant  execute on function public.admin_second_factor_ok() to service_role;


-- ------------------------------------------------------------------------
-- PART 2  the flag is not enough on its own any more
--
-- The live body with the second factor added. Every admin_* function is
-- SECURITY DEFINER and checks this as its first statement, so all eighteen are
-- gated by one edit.
-- ------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_platform_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select coalesce((select is_platform_admin from profiles where id = auth.uid()), false)
       and public.admin_second_factor_ok();
$function$;

comment on function public.is_platform_admin() is
    'The platform-admin flag AND a second factor on this session (admin_second_factor_ok). '
    'False for the service role, as before: auth.uid() is null there. '
    'See supabase_r7_admin_second_factor.sql.';


-- ------------------------------------------------------------------------
-- PART 3  the billing columns join the same gate
--
-- The live body, with its inline profiles lookup replaced by the shared
-- function and nothing else touched. The early return on a null uid -- the
-- Stripe webhook's path -- is left exactly as it was.
-- ------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.protect_billing_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
    if auth.uid() is null then
        return new;
    end if;

    -- Was an inline `exists (select 1 from profiles where id = auth.uid() and
    -- is_platform_admin)`, which is the flag alone -- so the second factor did
    -- not reach the billing columns even once is_platform_admin() required it.
    -- One gate, named once.
    if public.is_platform_admin() then
        return new;
    end if;

    new.suspended              := old.suspended;
    new.subscription_status    := old.subscription_status;
    new.subscription_plan      := old.subscription_plan;
    new.subscription_ends_at   := old.subscription_ends_at;
    new.trial_ends_at          := old.trial_ends_at;
    new.grace_ends_at          := old.grace_ends_at;
    new.stripe_customer_id     := old.stripe_customer_id;
    new.stripe_subscription_id := old.stripe_subscription_id;
    new.stripe_account_id      := old.stripe_account_id;
    new.monthly_price          := old.monthly_price;
    new.pass_card_fee          := old.pass_card_fee;

    -- The admin's own side of the row. suspended was already held; the REASON
    -- was not, and the reason is what decides whether a payment lifts the hold.
    new.suspended_reason       := old.suspended_reason;
    new.admin_notes            := old.admin_notes;
    new.invited_at             := old.invited_at;
    new.invited_email          := old.invited_email;
    new.leads_token            := old.leads_token;

    -- Onboarding evidence: written by sign_service_agreement() and
    -- complete_company_details(), which flag themselves below.
    if coalesce(current_setting('fenceflow.trusted_write', true), '') <> 'on' then
        new.agreement_signed_at   := old.agreement_signed_at;
        new.agreement_signed_name := old.agreement_signed_name;
        new.agreement_version     := old.agreement_version;
        new.details_completed_at  := old.details_completed_at;
    end if;

    return new;
end;
$function$;


-- ------------------------------------------------------------------------
-- PART 4  prove what landed. Every row must read true.
-- ------------------------------------------------------------------------

select 'admin_second_factor_ok exists, stable, definer' as check,
       count(*) = 1 as ok
  from pg_proc
 where pronamespace = 'public'::regnamespace and proname = 'admin_second_factor_ok'
   and provolatile = 's' and prosecdef
union all
select 'it is not executable by anon or PUBLIC',
       not exists (select 1 from pg_proc p, unnest(p.proacl::text[]) a
                    where p.pronamespace = 'public'::regnamespace
                      and p.proname = 'admin_second_factor_ok'
                      and (a like '=%' or a like 'anon=%'))
union all
select 'it reads the server''s own record, not only the claim',
       (select position('auth.sessions' in prosrc) > 0
           and position('mfa_factors' in prosrc) > 0 from pg_proc
         where pronamespace = 'public'::regnamespace and proname = 'admin_second_factor_ok')
union all
select 'is_platform_admin now requires it',
       (select position('admin_second_factor_ok' in prosrc) > 0 from pg_proc
         where pronamespace = 'public'::regnamespace and proname = 'is_platform_admin')
union all
-- Comment lines are stripped before asking, because the comment above the new
-- gate QUOTES the inline lookup it replaced -- and the first version of this
-- check read the quote and reported a correct function as wrong. A check made of
-- text someone may edit has to be pointed at the executable half of it.
select 'protect_billing_columns goes through the same gate',
       (with body as (
          select string_agg(line, E'
') as code
            from (select regexp_split_to_table(prosrc, E'
') as line
                    from pg_proc where pronamespace = 'public'::regnamespace
                                   and proname = 'protect_billing_columns') x
           where btrim(line) not like '--%')
        select position('is_platform_admin()' in code) > 0
           and position('select 1 from profiles' in code) = 0 from body)
union all
select 'protect_billing_columns still returns early for the service role',
       (select position('if auth.uid() is null then' in prosrc) > 0 from pg_proc
         where pronamespace = 'public'::regnamespace and proname = 'protect_billing_columns')
union all
select 'the one admin still passes right now (live session is aal2)',
       exists (select 1 from auth.sessions s join profiles p on p.id = s.user_id
                where p.is_platform_admin and s.aal::text = 'aal2'
                  and (s.not_after is null or s.not_after > now()))
union all
-- The canary. If no account has a verified factor at all, the whole gate is a
-- no-op and every row above would still read true -- so say so out loud.
select 'CANARY: at least one admin has a verified factor, so the gate is live',
       exists (select 1 from profiles p join auth.mfa_factors f
                 on f.user_id = p.id and f.status = 'verified'
                where p.is_platform_admin);
