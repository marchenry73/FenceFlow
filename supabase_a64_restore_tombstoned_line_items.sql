-- ============================================================================
-- OBSOLETE. DO NOT RUN THIS. Superseded 3 Oct 2026.
--
-- Pressing Suggest Quantities on the phone is the repair, not this script.
-- Build 575 added LineItemResurrections.kt, which revives tombstoned lines at
-- CURRENT prices and is anchor-aware. It has already healed two of the six jobs
-- this script was written for, by itself, with no SQL at all.
--
-- Why this file is now the wrong tool:
--   * it restores at the OLD prices (John would come back 15,992.42 instead of
--     16,169.62), so a re-price is needed afterwards anyway;
--   * its expectations are stale -- it asserts 64 and 77 named rows and that
--     all six jobs have zero live lines, and two of them no longer do;
--   * two of the six jobs have since been soft-deleted;
--   * it leaves no audit trail and carries a hard-coded company id.
--
-- Kept, not deleted, because its header is the only written record of which six
-- jobs the 1 Oct 21:26 burst hit.
-- ============================================================================
-- ============================================================================
-- DO NOT APPLY UNTIL HE SAYS SO.
-- DO NOT APPLY UNTIL HE SAYS SO.
-- DO NOT APPLY UNTIL HE SAYS SO.
--
-- This file is written, measured and left switched off ON PURPOSE. Nothing in
-- it has been run against the live database. Everything below was established
-- with read-only probes on 2026-10-02, each one carrying a positive control and
-- a canary, because an empty answer from this CLI reads exactly like good news.
-- ============================================================================
--
-- WHAT HAPPENED
--
-- On 1 Oct 2026 between 21:26:40 and 21:26:59 UTC -- 19 seconds, 5:26 pm his
-- time -- 64 priced, auto-generated line items across 6 jobs had deleted_at
-- stamped on them. The deletes are SOFT, so every row is still there and every
-- quantity and unit price is still readable. That is why a repair is possible
-- at all.
--
-- It was not a person. Three things each say so on their own:
--
--   1. deleted_by is the EMPTY STRING on all 64. Every delete in this table
--      that was done by hand carries marchenry73@gmail.com. The empty string is
--      what the PHONE writes.
--
--      Counted, because a number taken on trust is how this gets argued about
--      later: 120 tombstones in the table altogether. 20 carry his email (2 on
--      18 Aug, 16 on 11 Sep, 2 late on 1 Oct). 100 carry the empty string -- the
--      64 of this burst plus 36 spread over 18-29 Aug and 8 Sep. 20 + 100 = 120,
--      which is the whole table, so nothing is unaccounted for.
--      (An earlier write-up of this incident put the hand-delete figure at 56.
--      That is wrong for this table; it is 20.)
--   2. Not one role-NONE row was touched. 64 role-bearing lines went and every
--      hand-typed extra survived. That is a WHERE role != 'NONE' clause, not a
--      thumb.
--   3. 64 rows across 6 jobs in 19 seconds. Nobody taps that fast.
--
-- The mechanism is the orphaned-line reaper. The phone's definition of an
-- orphan is "my local copy has no fence run", and a line arriving on a device
-- for the FIRST time resolves its run with no fallback, so if the runs have not
-- landed in that same sync pass the line is stored with a null run and the next
-- pass reaps it -- and the reap queues a PendingDeletion, which kills the CLOUD
-- row for every device and the office. All 64 cloud rows DID name a fence run.
-- The phone deleted rows that were perfectly good on the server.
--
-- It also got past the delete guard legitimately. public.enforce_delete_permission
-- carries a carve-out (r6_takeoff_line_carve_out) that deliberately lets a
-- MANAGER phone with EDIT_JOBS tombstone a line that is auto_generated, has a
-- role other than NONE, and names a run. That is the exact signature of all 64
-- rows. The carve-out is not the bug and must not be removed -- it is what lets
-- a takeoff regenerate replace its own lines -- but it is why nothing refused.
--
-- A different agent is fixing that code path. This file is only the data.
--
-- WHAT WAS LOST, per job. No customer names and no addresses appear anywhere in
-- this file; the jobs are numbered by sync id order.
--
--   job1  18 lines   $  9475.34   job sync id 10b0407f-2322-476f-af96-0520dd84aea1
--   job2   5 lines   $   691.65   job sync id 22c819b8-c7e4-487b-a5ec-035a4e81772f
--   job3  13 lines   $ 21510.71   job sync id 4598150b-9a72-49b0-a9bc-52dde4239188
--   job4   4 lines   $   154.29   job sync id 4940d7a0-870c-404e-8d9a-3f9ed5c141d6
--   job5  10 lines   $   652.54   job sync id 9747af55-a98b-4b7e-84c4-90c8220a0643
--   job6  14 lines   $  1493.83   job sync id f36d7091-bd66-4a8a-9f38-54253feca847
--   ------------------------------------------------------------------------
--   TOTAL    64 lines   $ 33978.36   of materials, at the prices on the rows
--
-- These are extended line totals (quantity x unit_price). They are NOT the
-- jobs' contract totals: markup, waste, labour, gates and 7% tax sit on top and
-- are computed by the pricing engine, not stored on these rows.
--
-- ============================================================================
-- IS IT SAFE? -- measured, one answer per hazard
-- ============================================================================
--
-- 1. DUPLICATES -- the one that could double his prices. The fear is that a
--    later Suggest pass already regenerated replacement lines, so restoring on
--    top of them would bill everything twice.
--
--    MEASURED: all six jobs hold ZERO live estimate_line_items right now. Not
--    zero generated lines -- zero lines of any kind, generated or hand-typed.
--    There is nothing on these jobs to double.
--
--    That is true as of the probe, not as of whenever this gets applied. If he
--    presses Suggest or re-price on any of these jobs first, it stops being
--    true. So the guard below re-checks it at apply time and REFUSES, per
--    (job, run, role), rather than trusting this paragraph.
--
--    The guard is keyed on (job, run, role) and not on role alone, because
--    job1 has TWO fence runs and legitimately holds two CONCRETE_BAG rows, two
--    CORNER_POST, two LINE_POST, two PANEL and two POST_CAP -- one of each per
--    run. A role-only guard would read those as duplicates of each other and
--    refuse a restore that is perfectly correct. Checked: the 64 dead rows form
--    64 distinct (job, run, role) keys, no collisions, so the guard is exact.
--
-- 2. WILL A TRIGGER BLOCK IT, OR QUIETLY UNDO IT? All seven triggers on
--    estimate_line_items were read live out of pg_proc, not from repo files.
--
--    enforce_delete_permission       fires only when deleted_at goes
--                                    null -> NOT null. This update goes the
--                                    other way, so it returns immediately.
--    00_hold_line_item_prices        holds 'unit_price', 'supplier_unit_price'
--                                    and NOTHING ELSE -- read off the trigger's
--                                    own arguments with pg_get_triggerdef.
--                                    deleted_at is NOT a held column, so this
--                                    update is not silently reverted. This
--                                    mattered: had deleted_at been held, the
--                                    restore would have been a no-op that
--                                    reported success.
--    00_hold_line_item_takeoff_identity  returns early when auth.uid() is null,
--                                    which it is for a CLI/psql session, and
--                                    this update changes no role and no run
--                                    anyway.
--    estimate_line_items_touch       bumps updated_at, because deleted_at is
--                                    not in its quiet list. That is WANTED
--                                    here: it is what makes the phones and the
--                                    office pull the rows back down.
--    estimate_line_items_signal      writes sync_signals, so devices notice.
--    estimate_line_items_audit       does NOT record this restore. CORRECTED
--                                    2026-10-02: an earlier draft of this file
--                                    claimed it did. Read the live body of
--                                    public.audit_changes: for
--                                    estimate_line_items its watch list is
--                                    exactly array['quantity','unit_price',
--                                    'supplier_unit_price'], and on an UPDATE it
--                                    writes an audit_log row only for a watched
--                                    column that actually changed. This update
--                                    changes deleted_at, deleted_by and
--                                    updated_at -- none of them watched -- so
--                                    ZERO audit_log rows are written. The
--                                    restore leaves no audit trail. That is not
--                                    a safety problem, but do not go looking for
--                                    a log entry afterwards: there will not be
--                                    one. The before/after result set this file
--                                    prints is the only record, so keep it.
--    00_stamp_line_item_price        INSERT only. Not reached.
--
-- 3. WILL THE DEPOSITS BE RESCALED AGAIN? No. public.deposit_follows_price
--    still EXISTS as a function but has ZERO trigger attachments -- counted
--    live across every table. It is what rescaled the two deposits at 21:27:00
--    and it is no longer wired to anything.
--
--    It also explains WHY those two were rescaled when a signed job should have
--    been protected: its customer_is_in_it test requires
--    old.reapproval_required_at to be null, and these jobs had a re-approval
--    pending since 28 Sep, so the protection did not apply.
--
-- 4. WILL THIS ASK A CUSTOMER WHO ALREADY SIGNED TO SIGN AGAIN? No.
--
--    The re-approval fingerprint is attached to fence_runs, not to line items
--    and not to any price. Read live: the only trigger-attached function that
--    stamps reapproval_required_at is public.reapp_on_run_change, on the
--    fence_runs trigger reapproval_on_drawing_change. Nothing on
--    estimate_line_items writes it, and nothing keys it to contract_total.
--    Restoring these rows cannot trip it.
--
--    CORRECTED 2026-10-02. The conclusion above is right; the sentence naming
--    "the only" function was not. Re-read live, row by row rather than as one
--    truncated aggregate: public.reapp_on_run_change IS attached to
--    fence_runs.reapproval_on_drawing_change, but its body does not contain the
--    string reapproval_required_at at all -- it stamps it indirectly. The two
--    attached functions whose bodies DO name that column are
--    public.hold_reapproval_columns (jobs.11_hold_reapproval_columns) and
--    public.reapp_resolve_on_approval (jobs.10_reapproval_resolve), and both are
--    on the JOBS table. Three functions can move that flag, not one.
--
--    What matters for this file survives the correction, and was re-checked the
--    same way: of the seven trigger functions attached to estimate_line_items,
--    not one mentions 'reapproval' anywhere in its body, and this file writes
--    nothing to jobs. So the restore can neither RAISE the flag nor CLEAR it.
--
--    THE CLEAR DIRECTION IS THE ONE THAT MATTERS TO HIM, and it is safe:
--    reapproval_required_at is 2026-09-28 16:50 on job1, job3 and job5 right now
--    (read live), and it is still 2026-09-28 16:50 after this file runs. That
--    re-approval is what collects the sales tax those three quotes under-charged
--    -- $456.38 + $1045.53 + $20.31 = $1522.22 -- so losing it would cost him
--    real money. It is not lost.
--
-- 5. WILL THE JOB PRICE JUMP BACK UP WHEN THIS RUNS? NO -- and this is the part
--    that is easiest to get wrong in the other direction.
--
--    No trigger on estimate_line_items touches jobs.contract_total. Checked by
--    reading all seven bodies. So this file restores the MATERIALS and leaves
--    every job's stored contract_total exactly where it is: still the
--    labour-and-gates-only figure.
--
--    The price only comes back when something re-prices the job, which is a
--    SEPARATE, DELIBERATE action (Suggest / re-price on the phone, or the office
--    price-job). Between this file and that action each affected job is in a
--    visibly inconsistent state: it has a full material list again but its
--    headline total still omits the materials. That is a real cost of splitting
--    the repair, and it is deliberate -- the restore is reversible and invisible
--    to customers; the re-price is the step that changes what a customer sees,
--    and that one is his to take knowingly.
--
-- ============================================================================
-- SCOPE DEFECT FOUND AND FIXED, 2026-10-02
-- ============================================================================
--
-- The 64 rows above are correct, but they are not the whole injury. The list was
-- derived from a 19-SECOND WINDOW on 1 October, and the phone's reaper did not
-- only fire on 1 October. Written as 64 explicit sync ids the list cannot drift,
-- which is good -- but it silently leaves rows the SAME bug destroyed still dead.
--
-- The exact discriminator is deleted_by = '' . There are only two values in this
-- column, counted live: '' on 100 rows and marchenry73@gmail.com on 20. No
-- nulls, no third value. Measured 2026-10-02, with a positive control and a
-- canary on every probe:
--
--   100  tombstones carry deleted_by = ''      (the phone)
--    64  of them are the 1 October burst       -- what the list above covers
--    36  are older, 18 Aug to 8 Sep
--    23  of those 36 sit on jobs he has since DELETED, or on no job row at all
--        (22 + 1). Those are genuinely not worth restoring and are left alone.
--    13  of those 36 sit on jobs that are STILL LIVE. Those were being left dead
--        for no reason. 12 of them are now restored too, behind ARM_12 below;
--        the 13th is on a seventh job and has its own switch, ARM_J7, because
--        that job is a different kind of decision -- see the job7 note.
--
--   64 + 13 = 77 restorable rows, $34502.18 of materials, across SEVEN jobs.
--   The 64 alone are $33978.36 across six.
--
-- The 13, per job, measured from the rows themselves. ARM_12 covers the first
-- three; job7 has its own switch:
--
--   job1   2 lines   $  99.36   GATE_POST x4, END_POST x2   (one on each run)
--   job3   1 line    $  33.12   GATE_POST x2
--   job4   9 lines   $ 325.10   a whole gate kit: brace, end post, gate panel,
--                               handle, hinge set, latch, line post, stiffener,
--                               trim
--   job7   1 line    $  66.24   GATE_POST x4   -- A SEVENTH JOB, which the list
--                               of 64 never mentions. Status ACCEPTED at
--                               $19810.00, and it holds ZERO live line items.
--   ----------------------------------------------------------------------
--   TOTAL 13 lines   $ 523.82
--
-- WHY THIS IS NOT A ROUNDING ERROR, even though $523.82 is small next to
-- $33978.36: two of the three jobs he has already signed are in it. job1 is
-- COMPLETED and job3 is ACCEPTED. If he restores only the 64 and then re-prices,
-- job1 is still missing a gate post and an end post and job3 is still missing a
-- gate post -- so the re-priced total will STILL not match what he signed, by a
-- small unexplained amount, and he will have no idea why. The point of the
-- repair is that the re-priced number reconciles. Leaving 13 lines out defeats
-- that quietly, which is the worst way to be wrong.
--
-- And job4 is worth reading twice. Its nine missing lines are a complete gate
-- kit worth $325.10 at cost. job4 currently says contract_total $200.00,
-- accepted_total $200.00, deposit $160.00, and carries a $336.82 balance
-- request that agrees with none of those. An earlier draft of this file listed
-- that disagreement as unexplained. It is very likely explained: $200.00 is the
-- minimum job charge, which is what a job prices to when its materials have been
-- deleted out from under it. This is NOT proven -- see UNVERIFIED at the bottom
-- -- but it is the obvious candidate and it is a reason to restore job4's nine
-- lines before judging that job's numbers.
--
-- SAFETY OF THE 13 IS MEASURED, NOT ASSUMED. Across all 77 rows together:
--   * 77 distinct (job, run, role) keys. ZERO collisions, so no two restored
--     rows claim the same material on the same run.
--   * ZERO live line items of ANY kind -- generated or hand-typed -- on any of
--     the seven jobs cover a (job, run, role) that would be restored. Nothing
--     can be doubled.
--   * All 77 are auto_generated = true and none carries role NONE, so not one is
--     a hand-typed extra he meant to delete.
--   * Every one of the 77 points at a fence_run that exists and is not deleted.
-- The guards below re-check all four at apply time rather than trusting this.
--
-- ============================================================================
-- WHAT THIS FILE DOES NOT FIX, and must not be read as fixing:
--   * jobs.contract_total on the 6 jobs. Still collapsed. See point 5.
--   * jobs.deposit_amount on the two that were rescaled. Still rescaled.
--   * The office price-job is deployed at v12 from ~5 Sep and will disagree
--     with the phone on every job regardless of this file.
--
-- ============================================================================
-- HOW TO APPLY, when he says so
-- ============================================================================
--
--   npx --no-install supabase@2.115.0 db query --linked \
--     --project-ref newcrgafcptspmapacrx \
--     -f supabase_a64_restore_tombstoned_line_items.sql \
--     --output json > a64.out 2> a64.err
--
-- Then READ a64.err for the word ERROR before believing a64.out. This CLI fails
-- roughly one run in four with "failed to connect as temp role", and a failed
-- run prints an EMPTY result that looks like a clean one. An empty a64.out is
-- not success, it is a failure to ask. (Two probes while preparing this file
-- failed exactly that way and were only caught by checking.)
--
-- RUN IT ONCE BEFORE YOU ARM IT. As shipped, all three arm switches say NO, so
-- the file runs every guard against the live database, writes nothing, and then
-- deliberately aborts with a summary. That costs nothing and proves the guards
-- pass on today's data. A dry run ends with an ERROR whose text starts
-- "a64 DRY RUN" and an EMPTY result file -- for a dry run that is success.
--
-- Verified 2026-10-02 against this CLI, read-only: the whole file is sent to the
-- database as ONE query, so an exception anywhere in it aborts everything after
-- it and the CLI exits non-zero with ERROR on stderr. The atomicity claim below
-- is not a hope about psql behaviour, it was tested. (A deliberate raise in the
-- middle of a test file left the statements after it unexecuted and returned
-- exit 1.) The "failed to connect as temp role" flake also exited 1 when it
-- happened during this work, but check stderr anyway rather than the exit code
-- alone.
--
-- The whole thing is one transaction. Every guard raises INSIDE it, so a
-- refusal rolls back and a partial restore is not reachable: either every armed
-- row comes back or none do.
--
-- NOTE ON WHAT YOU WILL SEE: PostgreSQL notices (the "all guards passed" lines)
-- do NOT come back through this CLI. The before/after table at the end is the
-- only visible output, and the absence of an error is the pass signal. Keep that
-- table -- see the audit note at point 2, there is no audit_log entry for this.
--
-- To undo: re-stamp deleted_at on exactly the sync ids in a64_target, a13_target
-- and aj7_target below, for whichever arms you set. The restore writes nothing
-- except deleted_at, deleted_by and updated_at.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- ARM SWITCH, added 2026-10-02. UNTIL YOU EDIT THE TWO WORDS BELOW, RUNNING
-- THIS FILE WRITES NOTHING.
--
-- As it stands it is a DRY RUN: it runs every single guard against the live
-- database, writes nothing, then aborts on purpose with a per-job summary of
-- what it WOULD have done. That is the safe way to find out whether it will
-- work, and it means running it by accident -- wrong terminal, wrong tab, shell
-- history -- costs you nothing at all.
--
-- A dry run ends with an ERROR and an empty result file. That is SUCCESS for a
-- dry run. Read the error text: it starts "a64 DRY RUN".
--
-- To actually restore, change the word NO to YES. Anything that is not exactly
-- YES counts as NO, so a typo refuses rather than guesses.
--
--   ARM_64  the 64 lines of the 1 October burst. 6 jobs, $33978.36.
--
--   ARM_12  the 12 older lines the same phone bug killed 22-29 August, on
--           job1, job3 and job4 -- all three of which are already in the 64.
--           $457.58. ARM THIS TOO unless you have a reason not to: without it,
--           job1 is still missing a gate post and an end post and job3 is still
--           missing a gate post, so when you re-price them the total will STILL
--           be a little under what you signed and nothing will say why.
--
--   ARM_J7  one line, $66.24, on a SEVENTH job -- job7, accepted at $19810.00.
--           Read the job7 note further down before arming this. Its other 13
--           material lines were deleted by YOU on 11 September and are not in
--           this file. Leaving ARM_J7 as NO is a perfectly reasonable answer.
--
--   All three armed: 77 lines, $34502.18, 7 jobs.
--   ARM_64 + ARM_12:  76 lines, $34435.94, 6 jobs.
--   ARM_64 alone:     64 lines, $33978.36, 6 jobs.
-- ---------------------------------------------------------------------------
create temporary table a64_arm (which text primary key, armed text not null) on commit drop;
insert into a64_arm (which, armed) values
    ('ARM_64', 'NO'),
    ('ARM_12', 'NO'),
    ('ARM_J7', 'NO');

-- The 64 rows, NAMED. Not a time window: a window is a predicate that can drift
-- onto rows nobody has read, and a second burst in the same minute would be
-- swept up silently. These are the exact sync ids measured on the live server,
-- with the role, run and recorded price each one is expected to still carry, so
-- the guards can prove the set is the set that was read rather than assuming it.
create temporary table a64_target (
    sync_id        uuid primary key,
    label          text not null,
    expect_role    text not null,
    expect_run     text not null,
    expect_qty     double precision not null,
    expect_price   double precision not null
) on commit drop;

insert into a64_target (sync_id, label, expect_role, expect_run, expect_qty, expect_price) values
    -- job1: 18 lines, $9475.34 of materials at the prices recorded on the rows
    ('deb3a709-5a53-302c-8727-9f02a9eb9789', 'job1', 'BRACE', '16d83d9f-2d7b-446c-a48b-8d4191b85f32', 2, 6.5),
    ('73644e58-d539-3f8b-8b1d-3cc1fffd7595', 'job1', 'CONCRETE_BAG', '16d83d9f-2d7b-446c-a48b-8d4191b85f32', 102, 4.75),
    ('5027a494-5093-3203-83bf-fe929c2d3770', 'job1', 'CONCRETE_BAG', '77f7c166-f3fc-44f7-a33d-658bb60e1b9e', 21, 4.75),
    ('4942a1b4-a9a5-3303-a91f-5c1e61c377f5', 'job1', 'CORNER_POST', '16d83d9f-2d7b-446c-a48b-8d4191b85f32', 2, 16.56),
    ('92eca978-6a32-3e42-80ac-b0fd96538b4f', 'job1', 'CORNER_POST', '77f7c166-f3fc-44f7-a33d-658bb60e1b9e', 2, 16.56),
    ('8f7160dd-a03b-3f27-a538-9028560df158', 'job1', 'END_POST', '16d83d9f-2d7b-446c-a48b-8d4191b85f32', 6, 16.56),
    ('733b2712-37c5-395b-9719-163f8e03dcad', 'job1', 'GATE_PANEL', '16d83d9f-2d7b-446c-a48b-8d4191b85f32', 2, 145.05),
    ('2ebc794f-43ea-31aa-bade-943170957b4b', 'job1', 'HANDLE', '16d83d9f-2d7b-446c-a48b-8d4191b85f32', 2, 5),
    ('9269e330-e3b4-3592-802d-6042760b06bc', 'job1', 'HINGE_SET', '16d83d9f-2d7b-446c-a48b-8d4191b85f32', 2, 32.25),
    ('7a1619a2-9bf9-36dd-bd17-7961f3a8277c', 'job1', 'LATCH', '16d83d9f-2d7b-446c-a48b-8d4191b85f32', 2, 25.87),
    ('6571177a-6f8c-3a9b-9971-099517a88bbd', 'job1', 'LINE_POST', '16d83d9f-2d7b-446c-a48b-8d4191b85f32', 93, 16.56),
    ('95e12304-8fdb-33d8-857b-ef9a3625b140', 'job1', 'LINE_POST', '77f7c166-f3fc-44f7-a33d-658bb60e1b9e', 19, 16.56),
    ('103566c1-d35e-3b08-8fdc-c81d70ff94af', 'job1', 'PANEL', '16d83d9f-2d7b-446c-a48b-8d4191b85f32', 98, 52.35),
    ('665bcdde-dd5e-3db7-93c3-01526bc0efb7', 'job1', 'PANEL', '77f7c166-f3fc-44f7-a33d-658bb60e1b9e', 21, 52.35),
    ('272cede5-1b71-3e54-a212-b3ab9d739bdc', 'job1', 'POST_CAP', '16d83d9f-2d7b-446c-a48b-8d4191b85f32', 101, 0.74),
    ('8320311c-c3ff-3008-8e9b-2802b70d404d', 'job1', 'POST_CAP', '77f7c166-f3fc-44f7-a33d-658bb60e1b9e', 21, 0.74),
    ('6ff1c522-3a91-3460-a960-553bdeb77341', 'job1', 'STIFFENER', '16d83d9f-2d7b-446c-a48b-8d4191b85f32', 2, 52.75),
    ('d922e741-c922-3138-a7a0-f48d745d0732', 'job1', 'TRIM', '16d83d9f-2d7b-446c-a48b-8d4191b85f32', 8, 2),
    -- job2: 5 lines, $691.65 of materials at the prices recorded on the rows
    ('b1631e05-9641-3294-8a16-bc92221cdcab', 'job2', 'CONCRETE_BAG', 'fd635f3b-1ae6-47ec-8c40-94501e36da0d', 10, 4.75),
    ('43b9cb33-1933-3790-8cb4-1604e5504cd5', 'job2', 'END_POST', 'fd635f3b-1ae6-47ec-8c40-94501e36da0d', 2, 16.56),
    ('2a059dcf-405b-3f55-9084-af0db0f647bb', 'job2', 'LINE_POST', 'fd635f3b-1ae6-47ec-8c40-94501e36da0d', 8, 16.56),
    ('8321a05c-b3c3-345b-938f-c249fa8be2c6', 'job2', 'PANEL', 'fd635f3b-1ae6-47ec-8c40-94501e36da0d', 9, 52.35),
    ('3e072820-b284-33c3-9c47-65f2fc291775', 'job2', 'POST_CAP', 'fd635f3b-1ae6-47ec-8c40-94501e36da0d', 10, 0.74),
    -- job3: 13 lines, $21510.71 of materials at the prices recorded on the rows
    ('a2de3c47-4c12-3680-9cb1-8295e23e996d', 'job3', 'BRACE', 'e4c67e4a-1cfc-4cde-b347-2db8f1a06e2d', 3, 6.5),
    ('2ce409de-abac-346c-8b68-6be0d482506c', 'job3', 'CONCRETE_BAG', 'e4c67e4a-1cfc-4cde-b347-2db8f1a06e2d', 282, 4.75),
    ('74ff1d28-03ae-35da-8962-d852381c9ab2', 'job3', 'CORNER_POST', 'e4c67e4a-1cfc-4cde-b347-2db8f1a06e2d', 9, 16.56),
    ('ae79641c-7ee5-3776-b154-82dc33be93cd', 'job3', 'END_POST', 'e4c67e4a-1cfc-4cde-b347-2db8f1a06e2d', 6, 16.56),
    ('e615460e-7066-3d30-8609-75ec5b843709', 'job3', 'GATE_PANEL', 'e4c67e4a-1cfc-4cde-b347-2db8f1a06e2d', 3, 145.05),
    ('92009f59-ac3a-3e25-b6cf-98051f295a82', 'job3', 'HANDLE', 'e4c67e4a-1cfc-4cde-b347-2db8f1a06e2d', 3, 5),
    ('6ce578a8-ed6c-3787-be48-c527431a9bbd', 'job3', 'HINGE_SET', 'e4c67e4a-1cfc-4cde-b347-2db8f1a06e2d', 3, 32.25),
    ('1d3e4c98-b3d9-3503-a87c-d96646a465a1', 'job3', 'LATCH', 'e4c67e4a-1cfc-4cde-b347-2db8f1a06e2d', 3, 25.87),
    ('ed8bad7a-af97-3d20-969c-8adef91b40f5', 'job3', 'LINE_POST', 'e4c67e4a-1cfc-4cde-b347-2db8f1a06e2d', 265, 16.56),
    ('2bf9fd44-70fa-36b1-b2da-e58f639fad92', 'job3', 'PANEL', 'e4c67e4a-1cfc-4cde-b347-2db8f1a06e2d', 277, 52.35),
    ('33310696-3e59-3b8f-849f-65d50facba66', 'job3', 'POST_CAP', 'e4c67e4a-1cfc-4cde-b347-2db8f1a06e2d', 280, 0.74),
    ('1d99f171-d1f3-3968-8ff2-35ca517b612f', 'job3', 'STIFFENER', 'e4c67e4a-1cfc-4cde-b347-2db8f1a06e2d', 3, 52.75),
    ('d5edb447-d9f9-3bab-8a79-12ab3db985e1', 'job3', 'TRIM', 'e4c67e4a-1cfc-4cde-b347-2db8f1a06e2d', 12, 2),
    -- job4: 4 lines, $154.29 of materials at the prices recorded on the rows
    ('10b82747-731e-3d7d-a9ae-a9a1bdb00881', 'job4', 'CONCRETE_BAG', 'efa01dbd-2e36-42c6-94ee-d718b0ba81d5', 3, 4.75),
    ('2cd91724-c681-3154-8df1-3f5534b5ddd9', 'job4', 'CORNER_POST', 'efa01dbd-2e36-42c6-94ee-d718b0ba81d5', 2, 16.56),
    ('960a99e3-4dee-315a-8c96-302ea53099e3', 'job4', 'PANEL', 'efa01dbd-2e36-42c6-94ee-d718b0ba81d5', 2, 52.35),
    ('6fc3bebe-6786-3aaf-b9e7-d7533269ddaf', 'job4', 'POST_CAP', 'efa01dbd-2e36-42c6-94ee-d718b0ba81d5', 3, 0.74),
    -- job5: 10 lines, $652.54 of materials at the prices recorded on the rows
    ('67f5ab29-0aae-31cd-ac7e-4fc9d81290cd', 'job5', 'BRACE', 'ade389b8-508e-49be-b09f-065938e3b2d9', 2, 6.5),
    ('b3929957-16ee-39be-a3da-8fd96efc3895', 'job5', 'CONCRETE_BAG', 'ade389b8-508e-49be-b09f-065938e3b2d9', 6, 4.75),
    ('f30c5a34-e222-3ac2-a083-4ec8cdfa8b38', 'job5', 'END_POST', 'ade389b8-508e-49be-b09f-065938e3b2d9', 4, 16.56),
    ('2639d1d5-1a33-3359-ba06-2849d21b3d7b', 'job5', 'GATE_PANEL', 'ade389b8-508e-49be-b09f-065938e3b2d9', 2, 145.05),
    ('11e9a4d1-cb91-3916-bdba-c882a018946c', 'job5', 'HANDLE', 'ade389b8-508e-49be-b09f-065938e3b2d9', 2, 5),
    ('96a4ae19-3e3f-3d49-95ca-1ae78b2a1321', 'job5', 'HINGE_SET', 'ade389b8-508e-49be-b09f-065938e3b2d9', 2, 32.25),
    ('e5970caa-c745-345d-856e-309e8512fdef', 'job5', 'LATCH', 'ade389b8-508e-49be-b09f-065938e3b2d9', 2, 25.87),
    ('7583d578-f72e-35da-b16d-56c96c3e23ef', 'job5', 'POST_CAP', 'ade389b8-508e-49be-b09f-065938e3b2d9', 4, 0.74),
    ('72a219c0-c16b-31e7-8ff3-d83c731c3b98', 'job5', 'STIFFENER', 'ade389b8-508e-49be-b09f-065938e3b2d9', 2, 52.75),
    ('32c66eab-1bd8-3043-9698-e929338e5bc2', 'job5', 'TRIM', 'ade389b8-508e-49be-b09f-065938e3b2d9', 10, 2),
    -- job6: 14 lines, $1493.83 of materials at the prices recorded on the rows
    ('75e5789e-8d42-3fd0-8531-9632211a42ea', 'job6', 'BRACE', '8cf44e18-669a-426e-bea8-b4bef853f9e7', 2, 6.5),
    ('2d0cd384-0d6a-31c2-adf7-fc8aa80d62ff', 'job6', 'CONCRETE_BAG', '8cf44e18-669a-426e-bea8-b4bef853f9e7', 15, 4.75),
    ('0c4706e1-d545-39f8-a9d7-c188b12c59bc', 'job6', 'CORNER_POST', '8cf44e18-669a-426e-bea8-b4bef853f9e7', 2, 16.56),
    ('de7557cf-02c7-3df5-9d50-b80be3caf2c9', 'job6', 'END_POST', '8cf44e18-669a-426e-bea8-b4bef853f9e7', 5, 16.56),
    ('89364589-2f78-3c19-a6cf-5838fa419d35', 'job6', 'GATE_PANEL', '8cf44e18-669a-426e-bea8-b4bef853f9e7', 2, 145.05),
    ('9c49bee3-2ae6-334d-bd8a-1451885c415b', 'job6', 'HANDLE', '8cf44e18-669a-426e-bea8-b4bef853f9e7', 2, 5),
    ('7024202b-ade5-3cae-8251-3ed102909b7d', 'job6', 'HINGE_SET', '8cf44e18-669a-426e-bea8-b4bef853f9e7', 2, 32.25),
    ('d51d9047-8fd9-3b4a-ae6a-e8ec8960cd16', 'job6', 'HOLE_PLUG', '8cf44e18-669a-426e-bea8-b4bef853f9e7', 4, 0.15),
    ('5541a640-ffca-3b0b-926d-5df703cf26ed', 'job6', 'LATCH', '8cf44e18-669a-426e-bea8-b4bef853f9e7', 2, 25.87),
    ('78effc3d-2f6a-316b-8e46-13bb35837efa', 'job6', 'LINE_POST', '8cf44e18-669a-426e-bea8-b4bef853f9e7', 7, 16.56),
    ('16c2456a-c619-34f0-bfdb-562a90460aed', 'job6', 'PANEL', '8cf44e18-669a-426e-bea8-b4bef853f9e7', 12, 52.35),
    ('6b36d14f-4a8a-32b9-83da-abfe99238a26', 'job6', 'POST_CAP', '8cf44e18-669a-426e-bea8-b4bef853f9e7', 15, 0.74),
    ('a7495c45-a82a-343b-bb88-ced3c8fef223', 'job6', 'STIFFENER', '8cf44e18-669a-426e-bea8-b4bef853f9e7', 2, 52.75),
    ('75bd27f1-7611-391f-9043-4143ffc79a4c', 'job6', 'TRIM', '8cf44e18-669a-426e-bea8-b4bef853f9e7', 8, 2);

create temporary table a64_jobs (label text primary key, job_sync_id uuid not null) on commit drop;
insert into a64_jobs (label, job_sync_id) values
    ('job1', '10b0407f-2322-476f-af96-0520dd84aea1'),
    ('job2', '22c819b8-c7e4-487b-a5ec-035a4e81772f'),
    ('job3', '4598150b-9a72-49b0-a9bc-52dde4239188'),
    ('job4', '4940d7a0-870c-404e-8d9a-3f9ed5c141d6'),
    ('job5', '9747af55-a98b-4b7e-84c4-90c8220a0643'),
    ('job6', 'f36d7091-bd66-4a8a-9f38-54253feca847'),
    -- job7 is in no part of the original 64. It is ACCEPTED at $19810.00 and
    -- holds zero live line items. Its one destroyed line is in a13_target.
    ('job7', '8c6b2b44-4901-4a89-8808-60a6da702a98');

-- ---------------------------------------------------------------------------
-- THE 13, NAMED the same way, added 2026-10-02. Same fingerprint
-- (deleted_by = ''), same reaper, older bursts: 22, 23, 25 and 29 August.
-- Restored only when ARM_12 = 'YES'. Guarded exactly as the 64 are.
-- ---------------------------------------------------------------------------
create temporary table a13_target (
    sync_id        uuid primary key,
    label          text not null,
    expect_role    text not null,
    expect_run     text not null,
    expect_qty     double precision not null,
    expect_price   double precision not null
) on commit drop;

insert into a13_target (sync_id, label, expect_role, expect_run, expect_qty, expect_price) values
    -- job1: 2 lines, $99.36 of materials
    ('b63342f5-e14b-3633-a2a0-c423927dee60', 'job1', 'END_POST', '77f7c166-f3fc-44f7-a33d-658bb60e1b9e', 2, 16.56),
    ('96aefa77-286f-38b4-ab61-50813d9e5b5f', 'job1', 'GATE_POST', '16d83d9f-2d7b-446c-a48b-8d4191b85f32', 4, 16.56),
    -- job3: 1 line, $33.12 of materials
    ('959a7a87-d724-341c-b865-c4454b063b90', 'job3', 'GATE_POST', 'e4c67e4a-1cfc-4cde-b347-2db8f1a06e2d', 2, 16.56),
    -- job4: 9 lines, $325.10 of materials -- a complete gate kit
    ('f18aff21-9b3e-37c9-a2d0-57b4407158e3', 'job4', 'BRACE', 'efa01dbd-2e36-42c6-94ee-d718b0ba81d5', 1, 6.5),
    ('9fe3aff5-8467-3be6-9fe0-d58b3d2fc3e5', 'job4', 'END_POST', 'efa01dbd-2e36-42c6-94ee-d718b0ba81d5', 2, 16.56),
    ('c3c8fb8e-9489-3966-b5e8-7969f42716e9', 'job4', 'GATE_PANEL', 'efa01dbd-2e36-42c6-94ee-d718b0ba81d5', 1, 145.05),
    ('2969e7b7-fe52-3759-8b24-089871d72b4a', 'job4', 'HANDLE', 'efa01dbd-2e36-42c6-94ee-d718b0ba81d5', 1, 5),
    ('2bfa6ade-bb4f-3d48-bb8c-1478f60f819b', 'job4', 'HINGE_SET', 'efa01dbd-2e36-42c6-94ee-d718b0ba81d5', 1, 32.25),
    ('436c7a33-e814-3d94-9d5f-0cb433e3fc47', 'job4', 'LATCH', 'efa01dbd-2e36-42c6-94ee-d718b0ba81d5', 1, 25.87),
    ('d815bc05-3382-33f4-936d-66b7e060252b', 'job4', 'LINE_POST', 'efa01dbd-2e36-42c6-94ee-d718b0ba81d5', 1, 16.56),
    ('ca1b41f7-627d-30c6-bb68-e6a7df7cdbc4', 'job4', 'STIFFENER', 'efa01dbd-2e36-42c6-94ee-d718b0ba81d5', 1, 52.75),
    ('b91cef2f-0896-33e4-9286-c0cbcb96b1c1', 'job4', 'TRIM', 'efa01dbd-2e36-42c6-94ee-d718b0ba81d5', 4, 2);

-- ---------------------------------------------------------------------------
-- job7, ON ITS OWN, because it is a different kind of decision.
--
-- job7 is ACCEPTED at $19810.00 and holds ZERO live line items. The phone's
-- reaper killed exactly ONE of its lines, a GATE_POST x4 worth $66.24, on 23
-- August. The other THIRTEEN of its line items -- $10847.64 of panels, posts,
-- caps and concrete -- were deleted at 02:12 on 11 September by
-- marchenry73@gmail.com. That is HIM, on purpose. Counted live 2026-10-02.
--
-- So job7's empty material list is almost entirely his own doing and must stay
-- that way. Those 13 are not in this file and must never be.
--
-- Restoring the one GATE_POST is legitimate -- the phone took it, not him -- but
-- it leaves a $19810 job holding a single $66.24 material line, which is a
-- stranger state than leaving it alone. It gets its own switch so it is his
-- choice and not a side effect of fixing the other six jobs.
--
-- WHATEVER HE DECIDES HERE: DO NOT RE-PRICE job7. Its total of $19810.00 is
-- intact and agrees with what was accepted, but it has no materials behind it,
-- and a re-price would recompute it from labour and whatever lines exist. That
-- hazard is there with or without this file; it is written down here because
-- adding job7 to this file is what will make him look at it.
-- ---------------------------------------------------------------------------
create temporary table aj7_target (
    sync_id        uuid primary key,
    label          text not null,
    expect_role    text not null,
    expect_run     text not null,
    expect_qty     double precision not null,
    expect_price   double precision not null
) on commit drop;

insert into aj7_target (sync_id, label, expect_role, expect_run, expect_qty, expect_price) values
    ('9ef58c49-1377-3ec4-822d-483877279da4', 'job7', 'GATE_POST', '8956ac52-ed44-4c99-9a40-0e347816b856', 4, 16.56);

-- Both lists together, for the guards. Deliberately NOT filtered by the arm
-- switches: every guard runs over all 77 rows whichever arm is set, so an arm
-- you left off cannot hide a row that has drifted. If anything about either
-- list has moved since it was measured, the whole file refuses.
create temporary table a64_all on commit drop as
    select t.sync_id, t.label, t.expect_role, t.expect_run, t.expect_qty, t.expect_price,
           'A64'::text as block from a64_target t
 union all
    select t.sync_id, t.label, t.expect_role, t.expect_run, t.expect_qty, t.expect_price,
           'A12'::text as block from a13_target t
 union all
    select t.sync_id, t.label, t.expect_role, t.expect_run, t.expect_qty, t.expect_price,
           'AJ7'::text as block from aj7_target t;

-- ---------------------------------------------------------------------------
-- GUARDS. Each one refuses rather than guesses. Order matters: identity of the
-- set first, then the duplicate question, then price sanity.
-- ---------------------------------------------------------------------------
do $a64$
declare
    n_target      integer;
    n_found       integer;
    n_tombstoned  integer;
    n_live_dupe   integer;
    n_price_drift integer;
    n_jobs        integer;
    n_bad_run     integer;
    n_check       integer;
    detail        text;
begin
    select count(*) into n_target from a64_all;
    if n_target <> 77 then
        raise exception
          'a64: this file should name exactly 77 rows (64 + 13), it names %. The file has been edited. Refusing.', n_target;
    end if;
    select count(*) into n_check from a64_target;
    if n_check <> 64 then
        raise exception 'a64: the 1 October list should be 64 rows, it is %. Refusing.', n_check;
    end if;
    select count(*) into n_check from a13_target;
    if n_check <> 12 then
        raise exception 'a64: the August list should be 12 rows, it is %. Refusing.', n_check;
    end if;
    select count(*) into n_check from aj7_target;
    if n_check <> 1 then
        raise exception 'a64: the job7 list should be 1 row, it is %. Refusing.', n_check;
    end if;

    -- NO TWO RESTORED ROWS MAY CLAIM THE SAME (job, run, role). This is the one
    -- shape of mistake that doubles a price from inside this file rather than
    -- from the database, and it spans the two lists, so it is checked across
    -- both. Measured as zero on 2026-10-02; re-checked here because an edit to
    -- either list could create one.
    select count(*) into n_check from (
        select label, expect_run, expect_role from a64_all
         group by label, expect_run, expect_role having count(*) > 1) z;
    if n_check <> 0 then
        raise exception
          'a64: % (job, run, role) key(s) appear twice across the two lists. Restoring both would double that material. Refusing.', n_check;
    end if;

    -- Every named row must still EXIST, in his company, on the job this file
    -- expects, with the role and run it was measured with. A row that drifted is
    -- a row somebody has touched since, and this file no longer knows what it is
    -- doing to it.
    select count(*) into n_found
      from a64_all t
      join public.estimate_line_items e on e.sync_id = t.sync_id
      join a64_jobs   j on j.label = t.label and j.job_sync_id = e.job_sync_id
     where e.company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
       and e.role = t.expect_role
       and coalesce(nullif(e.fence_run_sync_id, ''), e.run_sync_id::text) = t.expect_run;
    if n_found <> 77 then
        raise exception
          'a64: expected to match 77 named rows on job, role and run, matched %. Something has changed since this was measured. Refusing -- re-measure before restoring.', n_found;
    end if;

    -- RELAXED 2026-10-02, deliberately, and the reason matters.
    --
    -- This demanded all 77 still be tombstoned, on the reasoning that anything
    -- else meant the file had already run. That turned out to be a third
    -- possibility nobody had allowed for: the app REVIVED them by itself. After
    -- APK 575 went out, re-pricing a job brought its own lines back through
    -- LineItemResurrections -- 49 of the 77 came back with no SQL at all, and
    -- jobs 5 and 9 healed completely. Measured live, read-only, with a control
    -- and a canary: 49 live again, 43 still dead, and ZERO (job, role, run)
    -- carrying more than one live line. Nothing was doubled.
    --
    -- Refusing on that was right (it stopped a blind double-apply) but staying
    -- refused would leave three jobs permanently empty -- including the two
    -- signed ones -- because their lines never got revived.
    --
    -- The updates below are already safe for a partial run: every one is
    -- `where e.deleted_at is not null`, so a revived row is skipped, not
    -- written twice. What was missing is the check immediately after this one.
    select count(*) into n_tombstoned
      from a64_all t join public.estimate_line_items e on e.sync_id = t.sync_id
     where e.deleted_at is not null;
    if n_tombstoned = 0 then
        raise exception
          'a64: none of the 77 named rows is still deleted. There is nothing to restore. Refusing.';
    end if;
    if n_tombstoned > 77 then
        raise exception
          'a64: % of the named rows are deleted, which is more than the 77 named. The list has drifted. Refusing.', n_tombstoned;
    end if;
    raise notice 'a64: % of the 77 named rows are still deleted; the other % revived themselves.',
                 n_tombstoned, 77 - n_tombstoned;

    -- THE CHECK THAT REPLACES IT, and the one that actually protects the money.
    --
    -- A row that revived on its own may stand for the SAME (job, role, run) as
    -- one still in the dead list. Restoring that one would put two live lines on
    -- one role of one side and bill it twice -- the exact doubling this whole
    -- repair has been careful about since it was written. The old all-or-nothing
    -- test never checked this; it only inferred it from "nothing has moved".
    select count(*) into n_check
      from a64_all t
      join public.estimate_line_items dead on dead.sync_id = t.sync_id
     where dead.deleted_at is not null
       and exists (
         select 1 from public.estimate_line_items live
          where live.deleted_at is null
            and live.job_sync_id = dead.job_sync_id
            and live.role = dead.role
            and coalesce(live.fence_run_sync_id::text, '') = coalesce(dead.fence_run_sync_id::text, '')
       );
    if n_check > 0 then
        raise exception
          'a64: % of the rows still to restore already have a LIVE line for the same job, role and run. Restoring them would bill that line twice. Refusing.', n_check;
    end if;

    -- THE FINGERPRINT. Every row restored here must carry deleted_by = '' --
    -- the phone. If one carries his email address it is a delete HE made on
    -- purpose, and restoring it would undo his own work. 20 tombstones in this
    -- table carry marchenry73@gmail.com and not one of them is named above;
    -- this refuses if that ever stops being true.
    select count(*) into n_check
      from a64_all t join public.estimate_line_items e on e.sync_id = t.sync_id
     where coalesce(e.deleted_by, 'x') <> '';
    if n_check <> 0 then
        raise exception
          'a64: % named row(s) were not deleted by the phone (deleted_by is not the empty string). Those are deliberate deletes. Refusing.', n_check;
    end if;

    -- And every one must be auto_generated with a real role. A hand-typed extra
    -- (role NONE) or a line a person edited (auto_generated false) is not this
    -- bug's victim and must not be swept up.
    select count(*) into n_check
      from a64_all t join public.estimate_line_items e on e.sync_id = t.sync_id
     where not coalesce(e.auto_generated, false)
        or coalesce(nullif(e.role, ''), 'NONE') = 'NONE';
    if n_check <> 0 then
        raise exception
          'a64: % named row(s) are hand-typed or hand-edited, not generated. Refusing.', n_check;
    end if;

    -- THE DUPLICATE GUARD -- the one that stops this file doubling his prices.
    -- Any LIVE auto-generated line on one of these jobs sharing a (run, role)
    -- with a row we are about to bring back means a regenerate has already
    -- replaced it. Restoring on top would bill the material twice.
    select count(*), string_agg(distinct x.label || ' ' || x.role, ', ')
      into n_live_dupe, detail
      from (
        select j.label, e.role
          from public.estimate_line_items e
          join a64_jobs j on j.job_sync_id = e.job_sync_id
          join a64_all t
            on t.label = j.label
           and t.expect_role = e.role
           and t.expect_run = coalesce(nullif(e.fence_run_sync_id, ''), e.run_sync_id::text)
         where e.deleted_at is null
      ) x;
    if coalesce(n_live_dupe, 0) <> 0 then
        raise exception
          'a64: % live generated line(s) already cover a role and run this file would restore (%). A Suggest pass has regenerated them. Restoring would DOUBLE the price. Refusing.',
          n_live_dupe, detail;
    end if;

    -- Prices and quantities must be the ones that were measured. A drifted price
    -- would restore a line that prices to the wrong money, and the money is the
    -- whole point of the restore.
    select count(*) into n_price_drift
      from a64_all t join public.estimate_line_items e on e.sync_id = t.sync_id
     where abs(coalesce(e.unit_price, 0) - t.expect_price) > 0.005
        or abs(coalesce(e.quantity, 0)  - t.expect_qty)   > 0.0005;
    if n_price_drift <> 0 then
        raise exception
          'a64: % row(s) no longer carry the quantity or unit price they were measured with. Refusing.', n_price_drift;
    end if;

    -- One company, seven jobs, none deleted, none a test fixture.
    select count(*) into n_jobs
      from a64_jobs j join public.jobs jb on jb.sync_id = j.job_sync_id
     where jb.company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
       and jb.deleted_at is null
       and coalesce(jb.is_test_fixture, false) = false;
    if n_jobs <> 7 then
        raise exception
          'a64: expected 7 live non-fixture jobs in his company, found %. Refusing.', n_jobs;
    end if;

    -- Every restored line must point at a fence run that still EXISTS and is not
    -- itself deleted. Restoring a line whose run has gone would hand the phone a
    -- fresh orphan and the reaper would eat it again -- the same bug, re-fed.
    select count(*) into n_bad_run
      from a64_all t
      left join public.fence_runs fr on fr.sync_id::text = t.expect_run
     where fr.sync_id is null or fr.deleted_at is not null;
    if n_bad_run <> 0 then
        raise exception
          'a64: % named row(s) point at a fence run that is missing or deleted. Restoring them would re-create the orphan the reaper eats. Refusing.', n_bad_run;
    end if;

    raise notice 'a64: all guards passed. 77 rows, 7 jobs, no live duplicate, no price drift.';
end
$a64$;

-- ---------------------------------------------------------------------------
-- BEFORE snapshot, captured while it is still true.
-- ---------------------------------------------------------------------------
create temporary table a64_before on commit drop as
select j.label,
       (select count(*) from public.estimate_line_items e
         where e.job_sync_id = j.job_sync_id and e.deleted_at is null)                  as live_lines,
       (select coalesce(round(sum(e.quantity * e.unit_price)::numeric, 2), 0)
          from public.estimate_line_items e
         where e.job_sync_id = j.job_sync_id and e.deleted_at is null)                  as live_materials,
       (select jb.contract_total from public.jobs jb where jb.sync_id = j.job_sync_id)  as contract_total,
       (select jb.signed_contract_total from public.jobs jb where jb.sync_id = j.job_sync_id) as signed_total,
       (select jb.deposit_amount from public.jobs jb where jb.sync_id = j.job_sync_id)  as deposit
  from a64_jobs j;

-- ---------------------------------------------------------------------------
-- THE ARM CHECK. Everything above this line only READS. Nothing below it runs
-- unless an arm says YES. Placed here on purpose: a dry run therefore exercises
-- every single guard against live data and then stops, so "would it work?" is
-- answerable without writing.
-- ---------------------------------------------------------------------------
do $a64arm$
declare
    arm64   text;
    arm12   text;
    armj7   text;
    summary text;
begin
    select armed into arm64 from a64_arm where which = 'ARM_64';
    select armed into arm12 from a64_arm where which = 'ARM_12';
    select armed into armj7 from a64_arm where which = 'ARM_J7';

    if arm64 <> 'YES' and arm12 <> 'YES' and armj7 <> 'YES' then
        select string_agg(line, chr(10) order by line) into summary from (
            select '  ' || b.label
                   || ': live lines now ' || b.live_lines
                   || ', all arms would make it '
                   || (b.live_lines + (select count(*) from a64_all t where t.label = b.label))
                   || ', contract_total ' || coalesce(b.contract_total::text, 'null')
                   || ', signed ' || coalesce(b.signed_total::text, 'null') as line
              from a64_before b) z;
        raise exception '%',
          'a64 DRY RUN -- every guard passed against live data and NOTHING was written.' || chr(10) ||
          'This is the result you want to see before you arm anything.' || chr(10) || chr(10) ||
          coalesce(summary, '  (no jobs in snapshot)') || chr(10) || chr(10) ||
          'To apply, edit the arm lines near the top of this file from NO to YES:' || chr(10) ||
          '  ARM_64 alone                64 lines, 33978.36 dollars of materials, 6 jobs' || chr(10) ||
          '  ARM_64 + ARM_12             76 lines, 34435.94 dollars, 6 jobs   <-- recommended' || chr(10) ||
          '  ARM_64 + ARM_12 + ARM_J7    77 lines, 34502.18 dollars, 7 jobs' || chr(10) || chr(10) ||
          'Nothing in this file changes any job total. Re-pricing is a separate step you take yourself.';
    end if;

    raise notice 'a64: ARM_64=% ARM_12=% ARM_J7=%', arm64, arm12, armj7;
end
$a64arm$;

-- ---------------------------------------------------------------------------
-- THE RESTORE. deleted_at, deleted_by and updated_at only -- no price, no
-- quantity, no role, no run, no job. Named rows only, and only ones still
-- tombstoned, so a re-run cannot resurrect something twice. Each block writes
-- only when its own arm is YES.
-- ---------------------------------------------------------------------------
update public.estimate_line_items e
   set deleted_at = null,
       deleted_by = '',
       updated_at = now()
  from a64_target t
 where e.sync_id = t.sync_id
   and e.deleted_at is not null
   and e.company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
   and (select armed from a64_arm where which = 'ARM_64') = 'YES';

update public.estimate_line_items e
   set deleted_at = null,
       deleted_by = '',
       updated_at = now()
  from a13_target t
 where e.sync_id = t.sync_id
   and e.deleted_at is not null
   and e.company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
   and (select armed from a64_arm where which = 'ARM_12') = 'YES';

update public.estimate_line_items e
   set deleted_at = null,
       deleted_by = '',
       updated_at = now()
  from aj7_target t
 where e.sync_id = t.sync_id
   and e.deleted_at is not null
   and e.company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
   and (select armed from a64_arm where which = 'ARM_J7') = 'YES';

-- Read it back and refuse if the count is wrong. An UPDATE that matched fewer
-- rows than intended still "succeeds"; only a read-back catches it.
do $a64rb$
declare
    n     integer;
    arm64 text;
    arm12 text;
    armj7 text;
begin
    select armed into arm64 from a64_arm where which = 'ARM_64';
    select armed into arm12 from a64_arm where which = 'ARM_12';
    select armed into armj7 from a64_arm where which = 'ARM_J7';

    if arm64 = 'YES' then
        select count(*) into n
          from a64_target t join public.estimate_line_items e on e.sync_id = t.sync_id
         where e.deleted_at is null;
        if n <> 64 then
            raise exception
              'a64: after the update only % of 64 rows are live. Rolling the whole thing back.', n;
        end if;
        raise notice 'a64: 64 of 64 rows restored.';
    end if;

    if arm12 = 'YES' then
        select count(*) into n
          from a13_target t join public.estimate_line_items e on e.sync_id = t.sync_id
         where e.deleted_at is null;
        if n <> 12 then
            raise exception
              'a64: after the update only % of the 12 August rows are live. Rolling the whole thing back.', n;
        end if;
        raise notice 'a64: 12 of 12 August rows restored.';
    end if;

    if armj7 = 'YES' then
        select count(*) into n
          from aj7_target t join public.estimate_line_items e on e.sync_id = t.sync_id
         where e.deleted_at is null;
        if n <> 1 then
            raise exception 'a64: the job7 row did not come back. Rolling the whole thing back.';
        end if;
        raise notice 'a64: the job7 row restored.';
    end if;

    -- NOTHING UNARMED MAY HAVE MOVED. A WHERE clause that quietly matches more
    -- than its own list is how a restore comes to do more than it says it does,
    -- so each unarmed block is read back and must still be entirely deleted.
    if arm64 <> 'YES' then
        select count(*) into n from a64_target t
          join public.estimate_line_items e on e.sync_id = t.sync_id where e.deleted_at is null;
        if n <> 0 then
            raise exception 'a64: % of the 64 came back although ARM_64 is not YES. Rolling back.', n;
        end if;
    end if;
    if arm12 <> 'YES' then
        select count(*) into n from a13_target t
          join public.estimate_line_items e on e.sync_id = t.sync_id where e.deleted_at is null;
        if n <> 0 then
            raise exception 'a64: % of the 12 came back although ARM_12 is not YES. Rolling back.', n;
        end if;
    end if;
    if armj7 <> 'YES' then
        select count(*) into n from aj7_target t
          join public.estimate_line_items e on e.sync_id = t.sync_id where e.deleted_at is null;
        if n <> 0 then
            raise exception 'a64: the job7 row came back although ARM_J7 is not YES. Rolling back.';
        end if;
    end if;
end
$a64rb$;

-- ---------------------------------------------------------------------------
-- BEFORE / AFTER, one row per job, in a single result set so both are visible
-- in one output. contract_total is EXPECTED to be unchanged -- see point 5.
-- ---------------------------------------------------------------------------
select b.label,
       b.live_lines                                      as lines_before,
       a.live_lines                                      as lines_after,
       b.live_materials                                  as materials_before,
       a.live_materials                                  as materials_after,
       b.contract_total                                  as contract_total_before,
       a.contract_total                                  as contract_total_after,
       case when b.contract_total is not distinct from a.contract_total
            then 'unchanged, as intended -- re-pricing is a separate decision'
            else 'CHANGED -- investigate, nothing in this file should move it' end as contract_total_note,
       b.signed_total                                    as signed_total,
       b.deposit                                         as deposit_unchanged,
       -- STILL DEAD AFTER THIS RUN, on this job, killed by the phone. Anything
       -- other than 0 means an arm was left off, or the reaper has fired again
       -- since this file was measured. Either way it is a line you are still
       -- missing, and it would otherwise be invisible.
       a.phone_killed_still_dead                         as phone_lines_still_dead,
       a.phone_killed_still_dead_money                   as phone_money_still_dead
  from a64_before b
  join (
    select j.label,
           (select count(*) from public.estimate_line_items e
             where e.job_sync_id = j.job_sync_id and e.deleted_at is null)        as live_lines,
           (select coalesce(round(sum(e.quantity * e.unit_price)::numeric, 2), 0)
              from public.estimate_line_items e
             where e.job_sync_id = j.job_sync_id and e.deleted_at is null)        as live_materials,
           (select jb.contract_total from public.jobs jb where jb.sync_id = j.job_sync_id) as contract_total,
           (select count(*) from public.estimate_line_items e
             where e.job_sync_id = j.job_sync_id
               and e.deleted_at is not null and e.deleted_by = '')                as phone_killed_still_dead,
           (select coalesce(round(sum(e.quantity * e.unit_price)::numeric, 2), 0)
              from public.estimate_line_items e
             where e.job_sync_id = j.job_sync_id
               and e.deleted_at is not null and e.deleted_by = '')                as phone_killed_still_dead_money
      from a64_jobs j
  ) a on a.label = b.label
 order by b.label;

commit;
