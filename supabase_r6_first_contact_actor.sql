-- ============================================================
-- FenceFlow -- "Contacted <when> by <who>": the database says who
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- KIND
--   ADDITIVE  hold_first_contact_by() (new) and its trigger
--             "00_hold_first_contact_by" on jobs (new). first_contact_is_first()
--             and its trigger are left exactly as they are.
--   No row is deleted or rewritten; no RLS policy changes.
--
-- APPLY ORDER
--   After supabase_first_contact.sql (the columns). Nothing else depends on it.
--   The office build that labels a lead "Contacted ... by ..." works before and
--   after this file: it still sends its own profile id, and it paints the row
--   the update hands back -- which, once this has run, carries the id this
--   trigger wrote rather than the one the browser sent.
--
-- WHAT WAS WRONG (review 2026-09-21)
--
--   recordFirstContact() in website/dashboard.html writes
--       { first_contact_at: now, first_contact_by: profile.id }
--   and nothing on the server checks that first_contact_by is the caller.
--   first_contact_is_first() keeps the FIRST answer, but it only steps in when
--   first_contact_at changes, so:
--     a. the first write can name anybody in the company, and
--     b. first_contact_by alone can be rewritten later, with first_contact_at
--        left as it was, and the label moves to someone else.
--   Who can do it (checked live): jobs_update is company-scoped with no role
--   test, and the RESTRICTIVE jobs_money_hidden_from_crew SELECT policy means
--   a filtered UPDATE only reaches rows a SEE_MONEY holder can read -- OWNER,
--   MANAGER, SALES and ACCOUNTANT. Crew cannot reach the base row this way,
--   and crew_save_job() does not carry these columns. The office offers the
--   button to OWNER and MANAGER only (canEdit()), but SALES and ACCOUNTANT
--   could still PATCH it directly. Misattribution only -- no money, no
--   customer data -- but the whole point of the label is to say who picked up
--   the phone.
--   This file does not decide who may RECORD contact; that is the RLS
--   question, and it is left alone. It only stops anyone naming someone else.
--
-- WHAT THIS DOES
--   A hold, in the same shape as the other 00_ holds on jobs:
--     UPDATE, first_contact_at going from empty to set  -> by = the caller
--     UPDATE, anything else                              -> by stays as it was
--     INSERT, first_contact_at set                       -> by = the caller
--     INSERT, first_contact_at empty                     -> by = null
--   "The caller" is auth.uid() looked up in profiles, so a login with no
--   profile row writes null instead of failing the whole update on the
--   foreign key. Rows recorded before first_contact_by was written keep their
--   null and go on reading "Contacted <when>" with no name, which is true.
--
--   Exempt, exactly as hold_contract_columns() and protect_customer_identity()
--   are: no request context at all (a migration, a backup, psql) and the
--   service role. Nothing in the backend writes these columns today
--   (send-follow-ups only reads first_contact_at), and neither does the phone.
--
--   Named 00_ so it runs with the other holds and BEFORE jobs_touch_updated_at:
--   a rejected attempt to rewrite first_contact_by alone then changes nothing,
--   and touch_updated_at leaves the edit clock alone instead of making every
--   phone pull an unchanged row.
-- ============================================================

create or replace function public.hold_first_contact_by()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    -- Same exemption the other holds use. No request context is a direct
    -- connection; is_service_role() asks whether the caller IS the backend
    -- rather than inferring it from a missing auth.uid(), which anon shares.
    claims text := nullif(current_setting('request.jwt.claims', true), '');
    caller uuid;
begin
    if claims is null or public.is_service_role() then
        return new;
    end if;

    select p.id into caller from public.profiles p where p.id = auth.uid();

    if tg_op = 'UPDATE' then
        if old.first_contact_at is null and new.first_contact_at is not null then
            new.first_contact_by := caller;
        else
            -- Written once, with its time. first_contact_is_first() holds the
            -- time; this holds the name even when only the name is sent.
            new.first_contact_by := old.first_contact_by;
        end if;
    else
        new.first_contact_by := case when new.first_contact_at is not null then caller end;
    end if;
    return new;
end;
$function$;

drop trigger if exists "00_hold_first_contact_by" on public.jobs;
create trigger "00_hold_first_contact_by"
    before insert or update on public.jobs
    for each row execute function public.hold_first_contact_by();

-- Afterwards, as an office login, in a transaction you roll back:
--
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<your profile id>","role":"authenticated"}';
--   update jobs set first_contact_at = now(), first_contact_by = '<someone else>'
--    where id = '<a lead with no first contact>'
--   returning first_contact_by;            -- must be <your profile id>
--   update jobs set first_contact_by = '<someone else>'
--    where id = '<same lead>'
--   returning first_contact_by;            -- must still be <your profile id>
--   rollback;

do $check$
declare
    n  int;
    nm text;
begin
    select count(*), min(t.tgname) into n, nm
      from pg_trigger t
     where t.tgrelid = 'public.jobs'::regclass and not t.tgisinternal
       and t.tgfoid = 'public.hold_first_contact_by()'::regprocedure;
    if n <> 1 then
        raise exception 'expected exactly one hold_first_contact_by trigger on jobs, found %', n;
    end if;
    if nm collate "C" >= 'jobs_touch_updated_at' collate "C" then
        raise exception 'trigger % fires after jobs_touch_updated_at', nm;
    end if;
end $check$;

select 'first_contact_by is set by the database' as done;

-- Undo:
--   drop trigger if exists "00_hold_first_contact_by" on public.jobs;
--   drop function if exists public.hold_first_contact_by();
