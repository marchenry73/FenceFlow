-- ============================================================================
-- UNAPPLIED. Nothing in this file has been run against the live database.
-- It is a proposal for the owner to review and apply by hand. Re-verified
-- against the LIVE database (project newcrgafcptspmapacrx) on 2026-09-28,
-- not inherited from an earlier report -- see the checks cited throughout.
-- ============================================================================
--
-- THE DEFECT
-- ----------
-- stamp_time_entry_rate() -- the BEFORE INSERT OR UPDATE trigger on
-- time_entries that decides whether a submitted hourly_rate may be trusted
-- when no real employee record backs the shift -- asks the wrong permission.
-- Its "privileged" test reads:
--
--     privileged := coalesce(public.can_see_pay(), false) or ... service_role ...
--
-- can_see_pay() resolves to has_permission('SEE_MONEY') (confirmed live,
-- pg_proc, 2026-09-28: `select coalesce(public.has_permission('SEE_MONEY'),
-- false)`). SEE_MONEY is job money -- price, cost, margin, payments -- and is
-- held by SALES. The correctly-named payroll helper, can_see_employee_pay(),
-- already exists and already resolves to has_permission('SEE_PAY') (same
-- pg_proc read), but has ZERO callers anywhere in the schema: a search of
-- every function body and every policy's qual/with_check for
-- `can_see_employee_pay(` returns no rows, while the identical search for
-- `can_see_pay(` returns exactly one, stamp_time_entry_rate itself -- so the
-- query is discriminating, not merely silent (the positive control is the
-- one hit it does find).
--
-- So payroll's "may this rate be trusted unverified" question is being
-- answered with the job-money permission, not the pay permission that was
-- built for exactly this and then never wired in.
--
-- WHO LOSES AN ABILITY THEY HAVE TODAY, AND WHO DOES NOT
-- -------------------------------------------------------
-- has_permission() (live pg_proc, re-read 2026-09-28) grants SEE_MONEY and
-- SEE_PAY together to OWNER (short-circuited true for every permission,
-- unaffected by this change by construction), MANAGER and ACCOUNTANT. SALES
-- gets SEE_MONEY only. FOREMAN and CREW get neither. So by the BASE role
-- table, the only role for which this fix changes the "privileged" answer is
-- SALES: true today (via can_see_pay/SEE_MONEY), false after (via
-- can_see_employee_pay/SEE_PAY).
--
-- A company could in principle strip SEE_PAY from a MANAGER or ACCOUNTANT by
-- hand with a "-SEE_PAY" permission_overrides entry while leaving SEE_MONEY
-- in place, which would put that account in the same losing cohort as SALES
-- -- correctly, since the point of the split (supabase_pay_visibility_split.sql)
-- was that SEE_MONEY no longer implies payroll access. Checked live,
-- 2026-09-28: zero profiles of any role (SALES, MANAGER, ACCOUNTANT, OWNER)
-- carry a "-SEE_PAY" override today. So the honest, current blast radius is
-- exactly ONE real account: the one live SALES profile
-- (f7e1c214-cdd0-492a-84b4-02392b264690), impersonated and read-only-probed
-- live on 2026-09-28:
--
--     has_permission('SEE_MONEY')                = true   (real, held)
--     has_permission('SEE_PAY')                  = false
--     has_permission('EDIT_CATALOG_AND_SETTINGS') = false  (control: not a blanket true)
--     can_see_pay()                              = true   (today's bug: "privileged")
--     can_see_employee_pay()                     = false  (correct answer)
--
-- Everyone else -- every real OWNER (5), the one real MANAGER, every
-- FOREMAN and CREW account -- reads identically before and after this
-- change, because their SEE_PAY answer already matches their SEE_MONEY
-- answer (OWNER: both always true; MANAGER: both true by default, none
-- overridden; FOREMAN/CREW: both false).
--
-- The service_role branch (`... 'role') = 'service_role'`) is untouched, so
-- an operator who sets that JWT claim by hand keeps the same ability they
-- have today. Nothing in this file touches Stripe keys, the keystore, or any
-- secret -- it is a plain SQL function body edit.
--
-- IS THERE A LEGITIMATE APP WORKFLOW THIS BREAKS?
-- ------------------------------------------------
-- Searched, not assumed -- this is the question that actually decides whether
-- the owner should apply this file, and it comes before the fix itself:
--
--   1. No Supabase Edge Function touches time_entries or hourly_rate at all
--      (`grep -rl "time_entries\|hourly_rate" supabase/functions --include=*.ts`
--      -- zero hits). There is no server-side job that writes a rate through
--      this trigger on anyone's behalf.
--
--   2. The Android client never intentionally sends an unresolvable
--      employee_sync_id. ClockInIdentity.resolve() (app/src/main/java/com/
--      fenceestimator/app/cloud/ClockInIdentity.kt) requires either the
--      signed-in account's OWN employee record (matched by profile_id, or by
--      email as a fallback) or the job's assigned employee, and returns
--      Result.NoIdentity -- clock-in refused, no row written -- when neither
--      resolves. So the "privileged, nobody to check against" branch this
--      fix changes is never the branch a legitimate clock-in reaches: a real
--      employee is always named, real_rate is looked up from `employees`
--      (NOT NULL DEFAULT 0, confirmed live) and always wins over whatever the
--      phone sent, regardless of who is privileged. This matches
--      tests/a10-pay-rate-permission.test.mjs check 30-31 (a real employee's
--      submitted fake rate of 555 lands in the database as that employee's
--      real rate, 50).
--
--   3. Recording field work at all is gated in the app on RECORD_FIELD_WORK
--      (app/src/main/java/com/fenceestimator/app/cloud/Permissions.kt),
--      which SALES does not hold and SEE_MONEY does not imply. There is no
--      screen that lets a SEE_MONEY-only account create or correct a shift
--      in the first place.
--
--   4. The only rows where the flawed branch would matter -- ones with no
--      resolvable employee -- are two already-orphaned rows in production
--      that predate the time_entry_needs_a_person trigger (confirmed live,
--      2026-09-28: that trigger still fires BEFORE INSERT OR UPDATE on
--      time_entries and no client path can recreate this state). Reading or
--      targeting either row for UPDATE additionally requires SEE_PAY or
--      is_my_shift() under the RESTRICTIVE policy time_entries_pay_needs_
--      see_pay (confirmed live: Postgres applies a SELECT policy to the row
--      an UPDATE reads), and SALES has neither -- confirmed by
--      tests/a10-pay-rate-permission.test.mjs checks 20-27 against the live
--      schema in a rolled-back transaction.
--
-- Conclusion: no legitimate workflow, on the phone or on the server, submits
-- a time entry rate through the branch this fix changes. Applying it changes
-- NOTHING that works today for any real account -- it removes reliance on
-- "two unrelated guards happen to also close this path" (a10's own words)
-- and replaces it with the correct permission at the source. That is the
-- entire justification: hardening a function whose name (can_see_pay) never
-- matched its job, against a day when either of those two incidental guards
-- moves.
--
-- WHAT THIS FILE DOES NOT TOUCH
-- ------------------------------
-- has_permission(), can_see_pay(), can_see_employee_pay(), the employees
-- table's policies, time_entries_pay_needs_see_pay, time_entry_needs_a_person,
-- guard_time_entry_approval(), guard_time_entry_write_permission(), or any of
-- the three write policies on time_entries (time_entries_insert,
-- time_entries_update, time_entries_update_stays_in_company). The real_rate
-- branch (an employee record exists) is untouched -- only the "nobody to
-- check against" branch's permission changes.
--
-- SHOULD THE WRITE POLICIES ALSO NAME A PERMISSION?
-- ---------------------------------------------------
-- Re-verified live, 2026-09-28: none of the three write policies on
-- time_entries (time_entries_insert PERMISSIVE INSERT, time_entries_update
-- PERMISSIVE UPDATE, time_entries_update_stays_in_company RESTRICTIVE
-- UPDATE) name has_permission or any permission -- each is a company-id match
-- (or, for the RESTRICTIVE one, a company-id match repeated as an explicit
-- WITH CHECK). Positive control for the same query, same day: employees_read
-- DOES name has_permission('SEE_PAY') in its USING clause, so this is a real
-- absence on time_entries, not a query that cannot see permission checks.
--
-- My answer: NO, do not add one, and I am deliberately not writing that as a
-- PART below because I do not recommend it. Permission enforcement on WRITES
-- to this table is already done, correctly, by two BEFORE UPDATE triggers
-- that a blanket RLS USING/WITH CHECK clause cannot express:
--   * guard_time_entry_write_permission() requires APPROVE_TIME or
--     SCHEDULE_AND_ASSIGN to edit a shift that is NOT your own, but leaves
--     your OWN shift editable with no permission at all
--     (supabase_sec_time_entries_write_permission.sql, confirmed live: the
--     trigger and its policy both exist on time_entries today).
--   * stamp_time_entry_rate(), the function this file edits, is the same
--     kind of per-row, context-sensitive gate for hourly_rate specifically.
-- A coarse RLS permission check on the table's UPDATE/INSERT policies cannot
-- encode "your own shift needs nothing, someone else's needs APPROVE_TIME"
-- without duplicating exactly the branching these two triggers already
-- contain -- and if it were added ONLY as a blanket "has_permission(...)"
-- OR'd into the existing company-match USING clause, it would not change who
-- passes (RLS policies for the same command are OR'd together, so a wider
-- clause added beside a narrower one that already passes for everyone in the
-- company adds nothing); if it were added as a WITH CHECK that everyone must
-- satisfy, it would break crew clocking their own shift, which needs no
-- permission and must keep working. So: this file is the payroll fix only,
-- on purpose, and touches no policy.
--
-- ============================================================================
-- PART 1 -- THE FIX (required)
-- ============================================================================
-- One word changes: can_see_pay() becomes can_see_employee_pay() in the
-- "privileged" test. Every comment, branch and the SECURITY DEFINER/search_
-- path/trigger wiring are copied verbatim from the live definition read from
-- pg_proc on 2026-09-28, so this is a like-for-like replace, not a rewrite.
-- === FIX BEGIN ===
create or replace function public.stamp_time_entry_rate()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
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
    -- FIXED 2026-09-28 (supabase_r11_time_entry_rate_permission.sql): this
    -- used to read can_see_pay(), which answers SEE_MONEY -- job price, cost,
    -- margin, payments -- a permission SALES holds. Payroll has its own
    -- permission, SEE_PAY, and its own helper, can_see_employee_pay(), which
    -- existed but had no caller. This is that caller.
    --
    -- Deliberately NOT "auth.uid() is null" as a stand-in for the server, and
    -- deliberately no "session_user = postgres" hatch either: under PostgREST
    -- a role switch leaves session_user alone, so such a test says yes to
    -- everybody the moment anything connects as an admin. An operator who
    -- genuinely needs to set a rate by hand sets a service_role claim.
    -- auth.uid() is null for an anonymous caller too, so that test would have
    -- handed the decision to exactly the people it was meant to exclude.
    privileged :=
        coalesce(public.can_see_employee_pay(), false)
        or coalesce(
             nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
             '') = 'service_role'
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
$function$;

comment on function public.stamp_time_entry_rate() is
  'Stamps the employee''s real rate onto a shift. When no employee matches, keeps the existing rate instead of destroying it; only someone with SEE_PAY (can_see_employee_pay()), or a service_role write, may state one unverified.';
-- === FIX END ===

select 'stamp_time_entry_rate now asks can_see_employee_pay() (SEE_PAY), not can_see_pay() (SEE_MONEY)' as done;

-- ============================================================================
-- EXACT REVERSE (to undo PART 1 -- not run by this file; copy this statement
-- out and run it by hand if the fix needs to come back out)
-- ============================================================================
-- create or replace function public.stamp_time_entry_rate()
-- returns trigger
-- language plpgsql
-- security definer
-- set search_path to 'public'
-- as $function$
-- declare
--     real_rate  numeric;
--     privileged boolean;
-- begin
--     select e.hourly_rate into real_rate
--       from employees e
--      where e.company_id = new.company_id
--        and e.sync_id::text = new.employee_sync_id
--      limit 1;
--
--     if real_rate is not null then
--         new.hourly_rate := real_rate;
--         return new;
--     end if;
--
--     privileged :=
--         coalesce(public.can_see_pay(), false)
--         or coalesce(
--              nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
--              '') = 'service_role'
--         ;
--
--     if tg_op = 'UPDATE' then
--         if new.hourly_rate is distinct from old.hourly_rate and not privileged then
--             new.hourly_rate := old.hourly_rate;
--         end if;
--         return new;
--     end if;
--
--     if not privileged then
--         new.hourly_rate := 0;
--     else
--         new.hourly_rate := coalesce(new.hourly_rate, 0);
--     end if;
--     return new;
-- end;
-- $function$;
--
-- comment on function public.stamp_time_entry_rate() is
--   'Stamps the employee''s real rate onto a shift. When no employee matches, keeps the existing rate instead of destroying it; only someone with SEE_MONEY may state one unverified.';
-- ============================================================================
-- PART 2 -- NOT INCLUDED
-- ============================================================================
-- See "SHOULD THE WRITE POLICIES ALSO NAME A PERMISSION?" above. My answer is
-- no, so there is no SQL here. If the owner disagrees, that should be its own
-- file with its own justification and its own review, not bundled with this
-- one -- the point of keeping them separate is that either can be applied, or
-- not, independently.
