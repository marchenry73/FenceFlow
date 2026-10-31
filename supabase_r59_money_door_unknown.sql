-- r59: "I do not know who you are" must not leave the server as "you may not
-- see money".
--
-- WHAT THIS COST, on 30 October 2026. Job 60e4e93f ("Marco", ACCEPTED, agreed
-- price $17,692.91) had 41 of its 47 takeoff lines re-written at $0.00 a unit,
-- across five sides, while the same products priced correctly on the one side
-- the drawing had not touched since 23 October. The catalog those lines were
-- priced from was correct in this database the whole time and had not changed
-- since 3 September.
--
-- THE CHAIN, which starts here:
--
--   1. can_see_pay() is `coalesce(has_permission('SEE_MONEY'), false)`, and
--      has_permission() reads `from profiles where id = auth.uid()`. When that
--      CTE is empty -- no profile row for the id, or auth.uid() itself null
--      because the phone's token had not attached yet -- the CASE matches no
--      WHEN and falls to ELSE false. So the server answers a confident FALSE
--      to a question it could not actually answer.
--
--   2. The phone is built to tell those two apart and does it carefully:
--      MoneyScope has three states, foldPayAnswer turns a THROWN error into
--      UNKNOWN, and SyncScope.kt says in as many words that "UNKNOWN must
--      never collapse into ALLOWED or DENIED anywhere in this codebase".
--      None of it can fire. Nothing throws. The phone is handed a clean,
--      confident "no" and believes it, which is the correct thing to do with
--      a definite answer.
--
--   3. A definite DENIED that this phone has not seen before runs
--      Repository.forgetMoney(), whose materialDao.scrubMoney() is
--      `UPDATE material_items SET unitPrice = 0.0` over the entire catalog.
--
--   4. And it never comes back. EntitySync.pullCatalog only carries a price
--      when `row.updatedAtMillis() > existing.lastUpdated`, and the scrub
--      deliberately "does not touch lastUpdated" -- so every row's clock still
--      reads exactly where the last pull left it, the comparison is equal, and
--      the branch that carries a price never runs again. Not after signing out,
--      not after signing back in, and not on the promotion pass AutoSync runs
--      precisely so that "the real prices" land before anything is pushed.
--
-- The phone side of this is fixed in the same change (pullCatalog restores a
-- zeroed price whenever the owner door is open, whatever the clock says, and
-- TakeoffLineMerge refuses to write $0.00 over a line that already had a
-- figure). This file fixes the end that produced the false answer, so the
-- phone's three-state design is actually reachable.
--
-- WHAT CHANGES. can_see_pay() and can_see_employee_pay() RAISE when there is
-- no identity to judge, instead of answering false. The phone's runCatching
-- turns that into MoneyScope.UNKNOWN, which skips every money-bearing table in
-- both directions and reports the sync as incomplete -- it scrubs nothing and
-- pushes nothing. A real signed-in person with a profile row is unaffected and
-- gets exactly the answer they got before.
--
-- has_permission() IS DELIBERATELY NOT TOUCHED. Row-level-security policies all
-- over this database call it, and an exception raised inside a policy does not
-- read as "denied" -- it fails the whole query. Changing it would turn a
-- missing profile row from a quiet no into a broken app. It keeps its false;
-- the two functions the phone asks its scope question with are the ones that
-- must tell "no" from "cannot say".
--
-- stamp_time_entry_rate() is the only other caller of either function in this
-- database (checked against pg_policies, pg_proc and pg_views). It is reordered
-- below so it asks the service_role question FIRST and only consults
-- can_see_pay() when there is an identity for it to answer about -- otherwise
-- the raise would propagate out of a trigger and refuse the insert.
--
-- Idempotent: every statement is CREATE OR REPLACE, and the checks at the end
-- raise rather than leave a half-applied file.

begin;

-- ---------------------------------------------------------------- the two doors
create or replace function public.can_see_pay()
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
    uid uuid := auth.uid();
    answer boolean;
begin
    -- No session at all. The phone's token had not attached yet, or this is an
    -- anonymous caller. Either way there is nobody to have a permission.
    if uid is null then
        raise exception 'money scope unknown: no authenticated identity'
            using errcode = 'P0002';
    end if;

    -- Signed in, but this database holds no profile for the id. That is not a
    -- person without SEE_MONEY, it is a question this database cannot answer:
    -- an account still being linked to its company, or a profile row this
    -- transaction cannot see yet.
    if not exists (select 1 from public.profiles where id = uid) then
        raise exception 'money scope unknown: no profile row for %', uid
            using errcode = 'P0002';
    end if;

    -- Past both, has_permission() is answering about a real person and its
    -- false is a real false. Unchanged from the original definition.
    answer := coalesce(public.has_permission('SEE_MONEY'), false);
    return answer;
end;
$$;

create or replace function public.can_see_employee_pay()
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
    uid uuid := auth.uid();
begin
    -- Same reasoning, same two states, for the other door. An owner in a dead
    -- spot once had every cached hourly rate scrubbed by exactly this shape of
    -- answer; see memory/empty-answer-reads-as-good-news.md and the doc on
    -- askEmployeePayScope.
    if uid is null then
        raise exception 'employee pay scope unknown: no authenticated identity'
            using errcode = 'P0002';
    end if;
    if not exists (select 1 from public.profiles where id = uid) then
        raise exception 'employee pay scope unknown: no profile row for %', uid
            using errcode = 'P0002';
    end if;
    -- SEE_PAY, not SEE_EMPLOYEE_PAY. The authority is
    -- supabase_can_see_pay_restored.sql, which defines this function as
    -- `coalesce(public.has_permission('SEE_PAY'), false)`; no role in
    -- has_permission() grants a permission called SEE_EMPLOYEE_PAY at all, so
    -- asking for that name returns false for everybody, owner included.
    --
    -- I wrote SEE_EMPLOYEE_PAY here from the doc comment on
    -- SyncScope.askEmployeePayScope, which says this function "answers with
    -- exactly coalesce(has_permission('SEE_EMPLOYEE_PAY'), false)". That
    -- comment is wrong. tests/a16-payrate-permission-fix.test.mjs caught it in
    -- one line -- its POSITIVE CONTROL asserts an ACCOUNTANT reads true -- and
    -- the control added below is the one this file should have had from the
    -- start. Read the live function, never the comment about it.
    return coalesce(public.has_permission('SEE_PAY'), false);
end;
$$;

grant execute on function public.can_see_pay() to authenticated;
grant execute on function public.can_see_employee_pay() to authenticated;

-- -------------------------------------------------------------- the one caller
-- Reordered only. The service_role test moves ahead of can_see_pay(), and
-- can_see_pay() is asked only when there is an identity for it to be about, so
-- the raise above can never escape through a trigger and refuse a shift.
create or replace function public.stamp_time_entry_rate()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    real_rate  numeric;
    privileged boolean;
begin
    select e.hourly_rate into real_rate
      from employees e
     where e.company_id = new.company_id
       and e.sync_id::text = new.employee_sync_id
     limit 1;

    -- The employee record is the authority whenever there is one to consult,
    -- so the figure the phone sent is ignored. This is the case that matters
    -- for security and it behaves exactly as before.
    if real_rate is not null then
        new.hourly_rate := real_rate;
        return new;
    end if;

    -- Nobody to check against. Who is allowed to state a rate unverified?
    --
    -- Deliberately NOT "auth.uid() is null" as a stand-in for the server, and
    -- deliberately no "session_user = postgres" hatch either: under PostgREST
    -- a role switch leaves session_user alone, so such a test says yes to
    -- everybody the moment anything connects as an admin. An operator who
    -- genuinely needs to set a rate by hand sets a service_role claim.
    --
    -- THE ORDER IS LOAD-BEARING as of r59. can_see_pay() now RAISES rather
    -- than answering false when there is no identity to judge, so it is asked
    -- last and only when auth.uid() is a real id. A raise here would not read
    -- as "not privileged" -- it would refuse the shift outright.
    privileged :=
        coalesce(
          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
          '') = 'service_role'
        or (auth.uid() is not null and coalesce(public.can_see_pay(), false))
        ;

    if tg_op = 'UPDATE' then
        -- Never wipe what is already recorded. Someone without pay access who
        -- tries to change the number simply doesn't change it.
        if new.hourly_rate is distinct from old.hourly_rate and not privileged then
            new.hourly_rate := old.hourly_rate;
        end if;
        return new;
    end if;

    -- A brand new shift with nobody attached. Record no rate rather than an
    -- unverified one, unless it came from someone trusted with pay.
    if not privileged then
        new.hourly_rate := 0;
    else
        new.hourly_rate := coalesce(new.hourly_rate, 0);
    end if;
    return new;
end;
$$;

-- ------------------------------------------------------------------ self-check
-- Raises rather than leaving the file half-applied. Every check carries its own
-- positive control: a rule that cannot be shown to fire is not a rule.
do $check$
declare
    owner_id uuid;
    answered boolean;
    raised   boolean;
begin
    select id into owner_id from public.profiles where role = 'OWNER' limit 1;
    if owner_id is null then
        raise exception 'r59 self-check cannot run: no OWNER profile to use as the control';
    end if;

    -- CONTROL: a real owner still gets a plain true. If this ever fails, the
    -- checks below prove nothing -- they would be measuring a broken function.
    perform set_config('request.jwt.claims',
        json_build_object('sub', owner_id::text, 'role', 'authenticated')::text, true);
    answered := public.can_see_pay();
    if answered is not true then
        raise exception 'r59: a real OWNER no longer reads as allowed (got %)', answered;
    end if;

    -- No identity at all.
    perform set_config('request.jwt.claims', json_build_object('role','authenticated')::text, true);
    raised := false;
    begin
        answered := public.can_see_pay();
    exception when others then raised := true;
    end;
    if not raised then
        raise exception 'r59: can_see_pay() still ANSWERS (%) with no identity -- a phone would scrub its catalog on it', answered;
    end if;

    -- Signed in, no profile row.
    perform set_config('request.jwt.claims',
        json_build_object('sub','00000000-0000-0000-0000-0000000000ff','role','authenticated')::text, true);
    raised := false;
    begin
        answered := public.can_see_pay();
    exception when others then raised := true;
    end;
    if not raised then
        raise exception 'r59: can_see_pay() still ANSWERS (%) for an id with no profile row', answered;
    end if;

    raised := false;
    begin
        answered := public.can_see_employee_pay();
    exception when others then raised := true;
    end;
    if not raised then
        raise exception 'r59: can_see_employee_pay() still ANSWERS (%) for an id with no profile row', answered;
    end if;

    -- CONTROL FOR THE OTHER DOOR, which this file did not have and needed.
    -- Proving only that a function RAISES for an unknown caller is satisfied by
    -- a function that answers false for EVERY caller -- which is exactly the
    -- bug this check now catches: asking has_permission for a permission name
    -- no role grants. An ACCOUNTANT holds SEE_PAY and must read true.
    perform set_config('request.jwt.claims',
        json_build_object('sub', owner_id::text, 'role', 'authenticated')::text, true);
    answered := public.can_see_employee_pay();
    if answered is not true then
        raise exception 'r59: an OWNER cannot see employee pay (got %) -- this door is asking for a permission nobody has', answered;
    end if;

    perform set_config('request.jwt.claims', '', true);
end $check$;

commit;
