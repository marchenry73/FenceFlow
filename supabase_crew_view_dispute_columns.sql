-- ============================================================
-- FenceFlow -- a crew member's own objection is invisible on their next phone
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- NOT APPLIED. Written on 28 September by the B3 pass and left for March to
-- run. The Android change that goes with it is complete and correct without
-- this file: everything below only widens where a dispute can be READ.
--
-- KIND
--   A VIEW REPLACEMENT, additive. It adds three columns that already exist on
--   time_entries to time_entries_crew. No table is altered, no policy is
--   touched, no grant is made or revoked, nothing is dropped, and re-running it
--   changes nothing. Same shape as supabase_crew_sees_corrections.sql, which
--   added the four correction columns to this same view for the same reason.
--
-- WHY
--   acknowledge_my_shift and dispute_my_shift (supabase_shift_dispute.sql)
--   write correction_seen_at, correction_disputed_at and dispute_note, and they
--   are the crew member's own words about their own pay. A phone without
--   SEE_PAY reads shifts through time_entries_crew, and that view carries none
--   of the three -- so the person who typed the objection cannot be shown it
--   again from the shift row. On the phone that sent it, the app falls back to
--   a local record of having sent it; on their NEXT phone, or after a
--   reinstall, there is nothing but a single read-back RPC on one screen.
--
--   An objection that cannot be found again is an objection somebody reports by
--   text message instead, which is exactly how this was reported.
--
-- NONE OF THESE IS MONEY
--   Two timestamps and a sentence. hourly_rate is NOT added and never will be:
--   the whole reason a crew phone reads this view is that it has no rate column
--   at all, and a money field there would render as 0.00 and read as "you
--   earned nothing". PART 2 proves the rate is still absent.
--
-- THE ONE JUDGEMENT CALL IN THIS FILE
--   These three columns are exposed for every shift in the company, not only
--   the reader's own -- the same as review_note, which this view has always
--   carried and which is the office's note about a colleague's hours. So a crew
--   member can read a colleague's objection, and a FOREMAN (APPROVE_TIME
--   without SEE_PAY, who reads this view) can see the objection on a shift they
--   are being asked to sign off. That second one is why it was left wide.
--
--   To narrow it to the reader's own shifts instead, wrap each of the three
--   columns at the end of the select list in a CASE that tests the same
--   employees/profile_id link dispute_my_shift itself tests. The cost is that a
--   foreman then approves disputed hours without being shown the dispute.
-- ============================================================

-- ------------------------------------------------------------------------
-- PART 1  the view, recreated from its own live definition
--
-- Read off the live database on 28 September: twenty-three columns, in this
-- order, and security_barrier set. Every original column is still present and
-- still in the same position -- CREATE OR REPLACE VIEW requires that, and it is
-- also what keeps every existing reader working. The three new ones are added
-- at the end.
--
-- security_barrier is restated rather than left to be inherited, so this file
-- says what the view is instead of depending on what it was.
--
-- To undo: run supabase_crew_sees_corrections.sql, then whichever file last
-- added the break columns, or simply re-run this one without the last three
-- lines of the select list.
-- ------------------------------------------------------------------------

create or replace view public.time_entries_crew
with (security_barrier = true) as
 SELECT id,
    company_id,
    sync_id,
    job_sync_id,
    employee_id,
    started_at,
    ended_at,
    notes,
    updated_at,
    approved_at,
    approved_by,
    rejected_at,
    review_note,
    deleted_at,
    deleted_by,
    employee_sync_id,
    original_started_at,
    original_ended_at,
    corrected_at,
    correction_reason,
    break_minutes,
    break_started_at,
    break_ended_at,
    correction_seen_at,
    correction_disputed_at,
    dispute_note
   FROM time_entries
  WHERE company_id = current_company_id() AND NOT company_is_suspended();

-- ------------------------------------------------------------------------
-- PART 2  prove every claim above, one row each
--
-- Read in the SQL editor as postgres, so current_company_id() is null and the
-- view returns no rows. That is why every check below is about the SHAPE of the
-- view and not about its contents: a row count here would be zero whatever
-- happened, which is the "an empty answer reads as good news" trap.
--
-- PART 2 was run on its own against the UNCHANGED view on 28 September, which
-- is the only way to know it can fail. It answered:
--
--     the three dispute columns are on the crew view ............. false
--     no money column reached the crew view ..................... true
--     CANARY the column test can find a column ................... true
--     every column the view had is still in its original position  true
--     CANARY positions are actually being read ................... false  (23, not 26)
--     security_barrier is still set on the view ................. true
--     authenticated can still select from the view .............. true
--     CANARY anon has no SELECT ................................. true
--
-- The two false rows are the two that depend on PART 1. Every row should read
-- true after it.
-- ------------------------------------------------------------------------

with cols as (
    select column_name, ordinal_position
      from information_schema.columns
     where table_schema = 'public' and table_name = 'time_entries_crew'
)
select 'the three dispute columns are on the crew view' as check,
       (select count(*) from cols
         where column_name in ('correction_seen_at','correction_disputed_at','dispute_note')) = 3
         as ok
union all
select 'no money column reached the crew view',
       not exists (select 1 from cols
                    where column_name in ('hourly_rate','pay_type','per_foot_rate'))
union all
-- CANARY for the two checks above. Both are "is this column name in the list",
-- and a list that came back empty -- a typo in the view name, a different
-- schema -- would make the first read false and the SECOND read TRUE, which is
-- a pass. So prove the same test finds a column that has always been there.
select 'CANARY: the column test can find a column, so its absence means absent',
       exists (select 1 from cols where column_name = 'corrected_at')
union all
select 'every column the view had is still in its original position',
       (select column_name from cols where ordinal_position = 1)  = 'id'
   and (select column_name from cols where ordinal_position = 13) = 'review_note'
   and (select column_name from cols where ordinal_position = 23) = 'break_ended_at'
union all
-- CANARY for the position check: if ordinal_position never matched anything,
-- all three comparisons would be null and the row would read null rather than
-- false, which is easy to skim past as "not a failure".
select 'CANARY: positions are actually being read, not coming back null',
       (select count(*) from cols where ordinal_position between 1 and 26) = 26
union all
select 'security_barrier is still set on the view',
       coalesce(array_to_string(c.reloptions, ','), '') like '%security_barrier=true%'
  from pg_class c where c.oid = 'public.time_entries_crew'::regclass
union all
select 'authenticated can still select from the view',
       has_table_privilege('authenticated', 'public.time_entries_crew', 'SELECT')
union all
-- CANARY for the privilege check: has_table_privilege answers true for a
-- superuser on anything, so ask about a role that must NOT have it. anon losing
-- or gaining SELECT here would both matter, and a check that only ever says
-- true is not checking.
select 'CANARY: anon has no SELECT, so the privilege test is not answering true to everything',
       not has_table_privilege('anon', 'public.time_entries_crew', 'SELECT');
