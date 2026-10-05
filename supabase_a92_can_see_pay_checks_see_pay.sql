-- can_see_pay() asks for SEE_MONEY. Prepared, NOT run. See the end.
--
-- Found by tests/a4-labour.test.mjs, which is not broken: it is REPORTING, and
-- the four checks it fails are the report. 22 of its 26 checks pass; the four
-- that do not are the links of this chain, each verified against the live
-- database rather than read off the source.
--
-- THE DEFECT, confirmed live:
--
--   create or replace function public.can_see_pay() ... as $$
--       select coalesce(public.has_permission('SEE_MONEY'), false);
--   $$;
--
-- It is named for SEE_PAY and asks for SEE_MONEY. The whole point of splitting
-- the two was that somebody can be trusted with what a job is worth without
-- being trusted with what people are paid.
--
-- WHY THAT MATTERS, the chain a4 sets out:
--
--   1. has_permission() gives SALES exactly
--      ('SEE_MONEY','EDIT_JOBS','SEE_CUSTOMER_CONTACT') -- SEE_MONEY yes,
--      SEE_PAY no. That split is deliberate and correct.
--   2. The time_entries INSERT policy's WITH CHECK is company membership only.
--      There is no permission test on the insert.
--   3. stamp_time_entry_rate() builds its `privileged` flag from
--      can_see_pay(). Privileged means "the rate you submitted is kept";
--      unprivileged means the trigger overwrites it with the employee's real
--      rate.
--   4. When employee_sync_id does not resolve to a real employees row, the
--      real-rate lookup is NULL, so there is nothing to overwrite with and the
--      submitted number is kept.
--
-- Put together: a SALES account inserts a time entry for an employee_sync_id
-- that does not exist, with hourly_rate = 999.00. can_see_pay() answers true
-- because SALES has SEE_MONEY. A fabricated $999/hr payroll figure is stored,
-- written by the one role the SEE_PAY split exists to keep out of payroll.
--
-- HOW URGENT IT IS, measured rather than assumed. There is exactly one SALES
-- profile on this database and its company_id is NULL, so current_company_id()
-- is null for it and the company-scoped insert policy at step 2 refuses it.
-- Nobody can walk this path today. It becomes reachable the first time a real
-- SALES user is created inside a company -- which is an ordinary thing to do
-- and would carry no warning.

create or replace function public.can_see_pay()
returns boolean
language sql stable security definer set search_path to 'public'
as $$
    -- SEE_PAY, not SEE_MONEY. The two were split so that seeing what a job is
    -- worth and seeing what a person is paid are different grants; a function
    -- called can_see_pay must ask the second question.
    select coalesce(public.has_permission('SEE_PAY'), false);
$$;

-- ---------------------------------------------------------------------------
-- WHO THIS CHANGES, from has_permission()'s own live body:
--
--   OWNER     -> true before, true after   (OWNER returns true for everything)
--   MANAGER   -> true before, true after   (its list contains SEE_PAY)
--   SALES     -> true before, FALSE after  <- the entire point
--   CREW      -> false before, false after (it has only RECORD_FIELD_WORK)
--
-- So one role changes, and it is the role the defect is about. Nobody who can
-- see payroll today loses it.
--
-- Read it back afterwards, because a write is not done until it has been read
-- back asserting the new value:
--
--   select position('SEE_PAY' in pg_get_functiondef('public.can_see_pay()'::regprocedure)) > 0;
--   -- expect: true
--
-- VERIFIED BY DRY RUN against the live database: applied inside
-- BEGIN ... ROLLBACK, the body afterwards contains SEE_PAY and not SEE_MONEY,
-- and can_see_pay() still executes. Then rolled back; the live function is
-- unchanged and still reads SEE_MONEY.
--
-- NOT RUN FOR REAL, deliberately. It is a live permission change, and
-- permissions are March's to decide even when the change tightens them. There
-- is no urgency to force the issue: no account can reach the path today. It
-- should go in before a SALES user is ever created in a company.
