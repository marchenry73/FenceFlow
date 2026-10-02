-- =============================================================================
-- *** DO NOT APPLY UNTIL MARCH SAYS SO. THIS WRITES TO LIVE JOB DATA. ***
-- =============================================================================
--
-- WHAT THIS IS FOR
--
-- Three of his jobs were signed at one price, then had every priced line item
-- destroyed by the orphan-reaper bug (see OVERNIGHT_2026-10-01.md, the 03:00
-- and 05:00 sections). All three are flagged re-approval-pending, and
-- _shared/quote-deposit.ts:133 deliberately shows the LIVE price while that
-- flag is set -- which is now the wreckage, not a real re-price.
--
-- Measured live, 2 Oct 2026, read-only, with a positive control and a canary:
--
--   id=6ce970ff...  anchor    870.00  live    200.00  signed    870.00  not viewed  DRAFT
--   id=982451d7...  anchor 15540.00  live   5853.81  signed 15540.00  VIEWED      COMPLETED
--   id=ce7d2eca...  anchor 35240.00  live  13266.87  signed 35240.00  VIEWED      ACCEPTED
--
-- In all three, accepted_total EQUALS signed_contract_total. The agreed price is
-- not in doubt; only the live figure is wrong. quote_approved_at is NULL on all
-- three, which is exactly why quote-view/index.ts:825 would overwrite the
-- correct anchor the moment a customer taps Approve.
--
-- ***** CORRECTION, 05:40. I ALMOST RECOMMENDED THE WRONG THING. *****
--
-- I first wrote this file recommending OPTION A -- clear the re-approval flag --
-- on the assumption the flag was raised BY the deletion. It was not. The flag
-- is dated 2026-09-28 16:50:37.805269 on all three, to the same microsecond:
-- FOUR DAYS BEFORE the deletion. I read reapproval_reason instead of assuming,
-- and it says:
--
--   6ce970ff: "The sales tax on this quote was worked out on part of the
--              materials instead of all of them, so the total was 20.31 short."
--   982451d7: ...same, "456.38 short."
--   ce7d2eca: ...same, "1,045.53 short."  (reapproval_count 3)
--
-- That is the seed tax bug -- four panel rows shipped untaxed -- and the
-- re-approval was raised CORRECTLY to get a HIGHER figure agreed. Clearing that
-- flag would cancel a legitimate request to collect $1,522.22 of tax across
-- three jobs, and quietly leave him short.
--
-- SO: OPTION A IS WRONG. DO NOT USE IT. It is left below, struck out, only so
-- the reasoning survives.
--
-- THE RIGHT ORDER IS:
--
--   1. Restore the deleted line items -- supabase_a64_restore_tombstoned_line_items.sql.
--      That makes the live price correct again, tax correction included.
--   2. The re-approval flag then does exactly what it was built for: it shows
--      her the corrected, HIGHER figure and asks her to agree to it. Nothing
--      needs clearing. The flag was never the problem.
--   3. Touch this file only if you want to close the window BEFORE step 1, in
--      which case use OPTION B.
--
--   OPTION B -- rotate the quote tokens, so the three existing links stop
--     working. Nothing can be approved because nothing can be opened. This is
--     the only option here that is safe to use on its own, and it is a holding
--     action, not a fix.
--     Cost: any link already sent to those three customers is dead and you must
--     send a new one. An old link shows "that quote is no longer available",
--     which needs a phone call. Two of the three have already been opened.
--
--   OPTION A -- DO NOT USE. See the correction above. Clearing the flag would
--     cancel the tax re-approval and cost him $1,522.22.
--
-- NEITHER option restores the deleted line items. That is
-- supabase_a64_restore_tombstoned_line_items.sql, and it should come FIRST.
--
-- BOTH options refuse rather than guess. If the live data has moved since I
-- measured it -- a customer approved, you re-priced, the set is not exactly
-- these three -- the whole thing raises and writes nothing.
-- =============================================================================

begin;

-- --- The guard. Runs for either option. -------------------------------------
do $guard$
declare
  n_exposed  int;
  n_approved int;
  n_mismatch int;
  n_named    int;
begin
  -- The set by PROPERTY rather than by the three ids, so a job that has since
  -- developed the same problem is not silently left out. The id check below
  -- then confirms it is still the same three.
  select count(*) into n_exposed
    from public.jobs
   where company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
     and deleted_at is null
     and reapproval_required_at is not null
     and quote_approved_at is null
     and accepted_total is not null
     and contract_total is not null
     and accepted_total > contract_total * 1.5;

  if n_exposed <> 3 then
    raise exception
      'REFUSING: expected exactly 3 exposed jobs, found %. The data has moved since 2 Oct 2026. Re-measure before applying.',
      n_exposed;
  end if;

  select count(*) into n_named
    from public.jobs
   where id in ('6ce970ff-0582-41e2-b9d7-88feb4c54895',
                '982451d7-91d6-4170-b51a-c457a3ed5593',
                'ce7d2eca-2f2c-4d4e-b11a-8f274d98d6be')
     and deleted_at is null
     and reapproval_required_at is not null
     and quote_approved_at is null;

  if n_named <> 3 then
    raise exception
      'REFUSING: only % of the 3 named jobs still match. One may have been approved already -- check before writing.',
      n_named;
  end if;

  select count(*) into n_approved
    from public.jobs
   where id in ('6ce970ff-0582-41e2-b9d7-88feb4c54895',
                '982451d7-91d6-4170-b51a-c457a3ed5593',
                'ce7d2eca-2f2c-4d4e-b11a-8f274d98d6be')
     and quote_approved_at is not null;

  if n_approved > 0 then
    raise exception
      'REFUSING: % of these jobs have been approved since this was written. The anchor may already hold the wrong figure -- read accepted_total against signed_contract_total first.',
      n_approved;
  end if;

  -- The agreed price must still be unambiguous: anchor = signature.
  select count(*) into n_mismatch
    from public.jobs
   where id in ('6ce970ff-0582-41e2-b9d7-88feb4c54895',
                '982451d7-91d6-4170-b51a-c457a3ed5593',
                'ce7d2eca-2f2c-4d4e-b11a-8f274d98d6be')
     and (signed_contract_total is null
          or abs(coalesce(accepted_total, 0) - signed_contract_total) > 0.005);

  if n_mismatch > 0 then
    raise exception
      'REFUSING: on % of these jobs accepted_total no longer equals signed_contract_total. The correct price is no longer obvious and a human must decide it.',
      n_mismatch;
  end if;

  raise notice 'Guard passed: 3 exposed jobs, none approved, anchor equals signature on all three.';
end
$guard$;

-- --- Before. Printed either way, so there is a record of what was true. -----
select 'BEFORE' as stage,
       id,
       status,
       to_char(accepted_total, 'FM999990.00')        as anchor,
       to_char(contract_total, 'FM999990.00')        as live_price,
       to_char(signed_contract_total, 'FM999990.00') as she_signed,
       reapproval_required_at,
       reapproval_reason,
       (quote_viewed_at is not null)                 as link_opened
  from public.jobs
 where id in ('6ce970ff-0582-41e2-b9d7-88feb4c54895',
              '982451d7-91d6-4170-b51a-c457a3ed5593',
              'ce7d2eca-2f2c-4d4e-b11a-8f274d98d6be')
 order by id;


-- =============================================================================
-- OPTION A -- *** DO NOT USE. WRONG. *** Kept only so the reasoning survives.
-- =============================================================================
-- Clearing reapproval_required_at would cancel the SALES TAX re-approval raised
-- on 28 Sep, which exists to collect $20.31 + $456.38 + $1,045.53 = $1,522.22
-- he is currently short. See the correction at the top of this file. Restore the
-- line items instead; then this flag is correct and wants leaving alone.
--
-- update public.jobs
--    set reapproval_required_at = null
--  where id in ('6ce970ff-0582-41e2-b9d7-88feb4c54895',
--               '982451d7-91d6-4170-b51a-c457a3ed5593',
--               'ce7d2eca-2f2c-4d4e-b11a-8f274d98d6be')
--    and quote_approved_at is null
--    and reapproval_required_at is not null;


-- =============================================================================
-- OPTION B -- rotate the quote tokens, killing the three existing links.
-- =============================================================================
-- Look at an existing token's shape before uncommenting: if quote_token is not
-- uuid-shaped text, this is the wrong generator.
--
-- update public.jobs
--    set quote_token = gen_random_uuid()::text
--  where id in ('6ce970ff-0582-41e2-b9d7-88feb4c54895',
--               '982451d7-91d6-4170-b51a-c457a3ed5593',
--               'ce7d2eca-2f2c-4d4e-b11a-8f274d98d6be')
--    and quote_approved_at is null;


-- --- After. ------------------------------------------------------------------
select 'AFTER' as stage,
       id,
       status,
       to_char(accepted_total, 'FM999990.00') as anchor,
       to_char(contract_total, 'FM999990.00') as live_price,
       reapproval_required_at,
       (quote_viewed_at is not null)          as link_opened
  from public.jobs
 where id in ('6ce970ff-0582-41e2-b9d7-88feb4c54895',
              '982451d7-91d6-4170-b51a-c457a3ed5593',
              'ce7d2eca-2f2c-4d4e-b11a-8f274d98d6be')
 order by id;

-- With BOTH options still commented out this transaction writes nothing, and
-- the two selects just show the current state. That is the default on purpose:
-- running this file by accident does nothing at all.
commit;
