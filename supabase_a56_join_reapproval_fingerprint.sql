-- ============================================================
-- FenceFlow -- teaching the re-approval fingerprint and the drawing snapshot
--              that two runs can share a post
--
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- STATUS: WRITTEN, NOT APPLIED. Nothing has run this. Apply to the DEV project first
-- (docs/DEV_ENVIRONMENT.md), read the proof rows at the bottom, and only then to
-- production. Spec and reasoning: docs/JOINING_RUNS.md sections 1.6, 7.2 and 11.
--
-- ONE RED CHECK THIS FILE CAUSES, and the one line that fixes it (not done here, because
--   FenceGeometry.kt is not this phase's to edit and a release build is queued):
--   tests/a33-join-arithmetic-posts.test.mjs check 7k-proposed requires the header of
--   app/.../geometry/FenceGeometry.kt to name every UNAPPLIED .sql that mentions a joint column.
--   This is one. Add this file's name beside supabase_a32_join_runs.sql in that header and the
--   suite goes back to 125 ok. docs/JOINING_RUNS.md 11.5 item 3b.
--
-- ORDER. THIS FILE MUST RUN AFTER supabase_a32_join_runs.sql, which adds
--   fence_runs.start_joint and fence_runs.end_joint. PART 0 below refuses to go any
--   further if they are absent, because a function body that names a column that does
--   not exist is refused by Postgres at CREATE time anyway -- loudly, which is right,
--   but with a message about a column rather than about an ordering mistake.
--
-- ------------------------------------------------------------
-- WHY THIS FILE EXISTS, verified live from pg_proc on 1 Oct 2026, not taken on trust
-- ------------------------------------------------------------
-- The whole live body of public.reapp_row_takeoff is:
--
--     select public.reapp_run_takeoff(
--         r.points_encoded, r.gates_encoded, r.closed_loop,
--         r.manual_linear_feet, r.manual_corner_count, r.is_teardown, ppf);
--
-- and reapp_run_takeoff returns 'b=..|t=..|c=..|e=..|g=..|gf=..|gm=..'. Read live:
-- neither function, nor reapp_job_takeoff, nor reapp_run_snapshot contains the text
-- 'start_joint' or 'end_joint' anywhere (position(...) = 0 in all four bodies).
--
-- public.reapp_on_run_change (SECURITY DEFINER, the AFTER trigger on fence_runs) is
-- a ROW-level comparison: it computes before_fp and after_fp with reapp_row_takeoff
-- and, if `before_fp = after_fp`, returns without touching the approval.
--
-- So writing a joint id onto two runs' ends is, to that trigger, a write that changed
-- nothing. The post count drops by one per joint -- the customer's agreed price moves
-- DOWN, behind her back, on a quote she has already approved -- and the approval is
-- not withdrawn. docs/REAPPROVAL_RULE.md: "the office must not be able to quietly
-- enlarge an approved job". Quietly shrinking it is the same wrong in the other
-- direction, and it is the direction a join actually goes.
--
-- WHICH WAY THIS MUST FAIL. Toward withdrawing. A withdrawal that was not strictly
-- needed costs the customer one more tap on a quote link she already has. A join
-- that slips past costs her a fence she never agreed to buy. Every choice below is
-- made in that direction: the fingerprint carries more than the arithmetic strictly
-- needs, and anything it cannot read is treated as a change.
--
-- ------------------------------------------------------------
-- WHAT IS APPENDED, AND WHY EACH PART IS THERE
-- ------------------------------------------------------------
-- The tail is appended to the existing seven-field fingerprint, and ONLY for a run
-- that is actually a live member of a join. For every other run -- which is every run
-- that exists today -- the tail is the empty string and the fingerprint is BYTE
-- IDENTICAL to what it is now. Proved against his 16 live runs before this file was
-- written, read-only, by computing the expression inline as a SELECT (nothing was
-- created and nothing was written): identical on all 16 unjoined, moved on all 11 of
-- the eligible ones once a joint id was synthesised, and the same test on the joined
-- variant reads FALSE, so it can fail.
--
-- Byte identity is not a nicety. public.reapp_restores_approved_state matches a
-- freshly computed fingerprint against the takeoff_before TEXT stored in
-- quote_reapprovals, so a format change makes every withdrawal already on the books
-- unrestorable. There are rows on the books (two of his jobs are flagged
-- needs-reapproval today). Appending only for joined runs keeps every one of them
-- matchable.
--
--   sj / ej   the two joint ids, normalised. MEMBERSHIP: this is the join itself, and
--             the only part that changes the post COUNT. A re-pointed join (same end,
--             different id) and an un-join both move the fingerprint.
--   jf        fence_type. It decides WHICH height column the ownership rule reads.
--   jph/jfh   panel_height_ft and fabric_height_ft, both raw, so no derivation here
--             can drift from the engine's. OWNERSHIP: the shared post is billed to
--             the TALLEST member (docs/JOINING_RUNS.md 2.4), and since
--             supabase_a50_post_heights.sql a post row is chosen BY HEIGHT, so which
--             member owns it is a price. Both columns are included rather than the
--             one the fence type selects, so a fence-type change cannot hide a
--             height change behind it.
--   jso       sort_order. The ownership TIE-BREAK between members of equal height.
--             This is the one field docs/REAPPROVAL_RULE.md lists as explicitly NOT
--             material, and it stays not material for every unjoined run: the tail
--             is empty there. For a joined run it became material the day ownership
--             started reading it. THE CHEAPER FIX IS IN THE ENGINE, NOT HERE: if the
--             ownership tie-break drops sort_order and settles on sync_id alone --
--             which is immutable, so it can never move a price -- delete the jso line
--             below and this file needs nothing else. docs/JOINING_RUNS.md 11.3
--             records that recommendation. Until then, reordering the run list on a
--             joined approved job withdraws the approval, which is the safe
--             direction and is why it is here.
--
-- WHAT IS DELIBERATELY NOT HERE
--   * is_transition. That column is PART 2 of supabase_a32_join_runs.sql and is
--     contested (docs/JOINING_RUNS.md 4.2, question Q4 -- the owner's call). Joining
--     does not depend on it. When and if it lands it appends its own '|jx=1' to the
--     same tail, under the same gate, and nothing here moves.
--   * A new table, a new trigger, a new policy, a new grant, a new column. The join
--     rides fence_runs, whose own trigger already fires on every write to it. Read
--     live: the triggers on fence_runs are enforce_delete_permission,
--     fence_runs_touch and fence_runs_touch_updated_at (both touch_updated_at), and
--     reapproval_on_drawing_change (reapp_on_run_change). None needs changing.
--   * Any change to RLS, crew scope, plan gates, money, signatures or the payment
--     ledger. A joint id is not money. No money column is named anywhere in this
--     file, and reapp_withdraw_approval -- which this file does not touch -- already
--     writes none.
--   * Any row. Nothing here is an INSERT, UPDATE, DELETE, TRUNCATE or ALTER. Two
--     function bodies are replaced in place. NO BACKFILL: see supabase_a32_join_runs.sql.
--
-- WHY THE GATE HAS FOUR CLAUSES. A joint takes effect only for an open, non-teardown
-- run that prices some footage (docs/JOINING_RUNS.md 1.4, guards G4/G5/G6). The tail
-- is gated on exactly those, so the fingerprint says precisely what the engine will
-- act on. Gating on them hides nothing, because every one of them is ALREADY visible
-- in the seven base fields: is_teardown swaps b= and t=, closed_loop moves e= from 2
-- to 0 and changes the length, and clearing the points empties b=. A run that becomes
-- ineligible therefore moves its own fingerprint anyway.
--
-- The fourth clause, reapp_is_empty(base), is load-bearing for a second reason. The
-- trigger uses reapp_is_empty to let an EMPTY run be added to or removed from an
-- approved job without disturbing it -- by comparing against the exact literal
-- 'b=0.0|t=0.0|c=0|e=0|g=0|gf=0.0|gm='. Append anything to an empty run's fingerprint
-- and that test can never match again, and adding a blank run to an approved job
-- would withdraw the approval for nothing. Verified live: reapp_is_empty is true for
-- that literal and false for a real one.
--
-- WHY A ROW-LEVEL FINGERPRINT IS ENOUGH for a fact that spans two rows. A join is
-- written as an id on BOTH ends, so both rows are written and the trigger fires
-- twice; the first firing withdraws and the second finds nothing left to withdraw
-- (reapp_withdraw_approval returns early when quote_approved_at is null), so one
-- withdrawal row is written, not two. If the two pushes are separated -- offline sync
-- sends one run at a time -- the first arrival withdraws while the id is still alone
-- and therefore still priced as a free end: a withdrawal slightly ahead of the price
-- move, which is the safe side. The cases where a member's geometry, height or
-- eligibility changes without its joint columns changing are all already covered,
-- because that member's own row changed and its own fingerprint moved.
-- ============================================================


-- ---------- PART 0. refuse to run out of order ----------------------------
do $$
begin
    if not exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'fence_runs'
           and column_name in ('start_joint', 'end_joint')
        having count(*) = 2
    ) then
        raise exception
            'fence_runs.start_joint / end_joint are missing. Apply supabase_a32_join_runs.sql first; see the ORDER note at the top of supabase_a56_join_reapproval_fingerprint.sql.';
    end if;
end $$;


-- ---------- PART A. the re-approval fingerprint ---------------------------
-- Same name, same two arguments, same return type, same language, same IMMUTABLE,
-- same invoker rights, same search_path as the live function (all read from pg_proc
-- before this was written), so CREATE OR REPLACE keeps the existing EXECUTE grants
-- to anon, authenticated, postgres and service_role rather than resetting them.
--
-- reapp_job_takeoff and reapp_on_run_change call this by that unchanged signature and
-- need no edit. reapp_run_takeoff itself is NOT touched: its seven arguments and its
-- seven output fields are exactly as they are today.
create or replace function public.reapp_row_takeoff(r public.fence_runs, ppf double precision)
returns text
language sql
immutable
set search_path to 'public'
as $fn$
    with base as (
        select
            public.reapp_run_takeoff(
                r.points_encoded, r.gates_encoded, r.closed_loop,
                r.manual_linear_feet, r.manual_corner_count, r.is_teardown, ppf) as fp,
            -- Normalised the way the READERS normalise (supabase_a32_join_runs.sql:
            -- "the readers validate"). Anything that is not a uuid is not a joint to
            -- the engine, so it must not be a joint to the fingerprint either, or the
            -- two disagree about what the price is. No CHECK constraint exists on
            -- these columns on purpose -- fence_runs upserts are batched and one
            -- refused row fails a whole company's sync -- so junk CAN arrive here.
            case when r.start_joint ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then r.start_joint else '' end as sj,
            case when r.end_joint   ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then r.end_joint   else '' end as ej
    )
    select
        fp
        || case
             -- Not a live join member: the tail is empty and the fingerprint is
             -- exactly what it is today. See "WHY THE GATE HAS FOUR CLAUSES" above.
             when (sj = '' and ej = '')
               or coalesce(r.is_teardown, false)
               or coalesce(r.closed_loop, false)
               or public.reapp_is_empty(fp)
             then ''
             else '|sj='  || sj
               || '|ej='  || ej
               || '|jf='  || coalesce(r.fence_type, '')
               || '|jph=' || round(coalesce(r.panel_height_ft, 0)::numeric, 2)
               || '|jfh=' || round(coalesce(r.fabric_height_ft, 0)::numeric, 2)
               -- Delete this ONE line the day ownership stops reading sort_order.
               || '|jso=' || coalesce(r.sort_order, 0)
           end
      from base;
$fn$;

comment on function public.reapp_row_takeoff(public.fence_runs, double precision) is
  'Per-run re-approval fingerprint. The seven base fields are reapp_run_takeoff''s and are unchanged. A tail naming the joint ids, the fence type, both height columns and the sort order is appended ONLY for a run that is a live join member (a uuid joint id, open, not a teardown run, pricing some footage); for every other run the tail is empty and the fingerprint is byte-identical to the pre-join one, so stored before/after values stay comparable and stored withdrawals stay restorable. See supabase_a56_join_reapproval_fingerprint.sql and docs/JOINING_RUNS.md 11.';


-- ---------- PART B. the drawing snapshot ----------------------------------
--
--   *** DO NOT APPLY PART B UNTIL BOTH READERS ACCEPT A SEVEN-PART SNAPSHOT. ***
--
-- This is an ordering rule, not a caution. reapp_run_snapshot writes six bar-joined
-- parts today and its two readers are STRICT ABOUT THE COUNT -- read from source,
-- 1 Oct 2026:
--
--   phone   parseRunSnapshot, app/.../ui/jobs/JobDetailViewModel.kt
--           `if (parts.size != 3 && parts.size != 6) return null`
--   office  reapprovalRestoreState, website/dashboard.html
--           `if (parts.length !== 3 && parts.length !== 6) return { kind: 'unreadable' }`
--
-- Apply PART B first and every snapshot written for a JOINED run comes back
-- "unreadable" on both -- the restore button dies on exactly the rows that need it.
-- It fails safe (nothing is half-restored) but it fails. Ship the readers, then this.
-- tests/a56-join-decision-fingerprint.test.mjs holds that order: it goes red if this
-- marker is removed while either reader still refuses seven, and red the other way
-- too, once both accept seven and the marker is still here.
--
-- WHAT GOES WRONG WITHOUT PART B AT ALL. A restore writes points_encoded,
-- gates_encoded, closed_loop (and, from a six-part record, the two typed figures and
-- is_teardown) back onto the run -- see the office's patch in dashboard.html and the
-- phone's RunSnapshot.appliedTo. It does not write the joint columns, because the
-- snapshot never recorded them. So a restore puts YESTERDAY'S POINTS back under
-- TODAY'S JOINTS, and produces, concretely:
--   1. A join to a run whose points have moved. The engine honours a join however far
--      apart its ends have drifted (docs/JOINING_RUNS.md 2.5 -- the owner's decision
--      beats the pixels), so the restored drawing keeps a shared post that the
--      restored geometry does not have. The customer's restored price is LOWER than
--      the one she approved, by one post.
--   2. The approval does not come back, and the reason given is wrong.
--      reapp_restores_approved_state matches the recomputed fingerprint against the
--      stored takeoff_before. With PART A live, today's joints are in the recomputed
--      value and yesterday's are in the stored one, so it cannot match; the office
--      reports that the price must have moved and names the drawing, when what
--      actually differs is a joint nobody can see on the screen.
--
-- THE SHAPE, and why a SEVENTH field rather than an eighth and a ninth. One new
-- part, written only when the run carries a joint, holding a semicolon-separated
-- key=value list. A future flag (the contested is_transition) adds a KEY to that
-- part, not another part, so the readers' accepted counts change ONCE, ever. Neither
-- ';' nor '=' can occur in any existing part: points and gates are ':'-pairs joined
-- by ',', and the flags are '1' or '0'.
--
-- THE READER CONTRACT, which must be implemented before this is applied:
--   3 parts -- outline only, as today. Says nothing about joints; leave them alone.
--   6 parts -- joints were EMPTY. Write '' to start_joint and end_joint.
--             This is true of every six-part record that can exist: the ones written
--             before supabase_a32_join_runs.sql ran had no columns to record, and the
--             ones written after it are gated on the joints being empty.
--             This is what lets a restore UNDO a join, which is the whole point --
--             without it, a join made after an approval could never be put back.
--   7 parts -- parts 1-6 as today; part 7 is 'sj=<id>;ej=<id>' with both keys always
--             present and either value possibly empty. A value that is neither empty
--             nor a uuid, or a key the reader does not know with a malformed value,
--             makes the whole row unreadable -- same strictness both readers already
--             apply to the flags and the typed figures. An unknown key with a
--             well-formed value is ignored, so a later flag does not break an older
--             reader. The writer below normalises, so a value that is neither empty
--             nor a uuid can only reach a reader from something that is not this
--             function -- which is precisely when refusing the row is right.
--
-- ALSO STALE ONCE THIS IS APPLIED, and not owned by this file:
--   supabase_r8_drawing_versions_full_snapshot.sql has a proof row asserting that
--   every live run's snapshot splits into exactly 6 parts. The day a run is joined
--   that row reads false for a correct snapshot -- a check that can only fail. It
--   needs `in (6, 7)`. Whoever owns that file must relax it; this file cannot, and a
--   proof that can only fail is how a good build was thrown away before
--   (CLAUDE.md, "A check against UI text rots into a check that cannot pass").
--
-- Kept deliberately identical to the live function in every other respect, including
-- having NO search_path setting (pg_proc.proconfig is null on it today). It reads
-- nothing but its own argument, so adding one would be a change this file was not
-- asked to make.
create or replace function public.reapp_run_snapshot(r public.fence_runs)
returns text
language sql
immutable
as $fn$
    with j as (
        -- Normalised exactly as PART A normalises, and for a reason found by running
        -- PART B against a synthesised row before it was written: a run carrying JUNK
        -- in a joint column would otherwise snapshot as 'sj=oops;ej=', which THE
        -- READER CONTRACT ABOVE must refuse as unreadable -- leaving that run's
        -- withdrawal permanently unrestorable over a value the PRICE already ignores.
        -- Normalising instead means junk snapshots as six parts, and a restore puts ''
        -- back, which is what the price already believes. The two functions therefore
        -- agree, field for field, about what counts as a joint.
        select
            case when r.start_joint ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then r.start_joint else '' end as sj,
            case when r.end_joint   ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then r.end_joint   else '' end as ej
    )
    select coalesce(r.points_encoded, '')
        || '|' || coalesce(r.gates_encoded, '')
        || '|' || case when coalesce(r.closed_loop, false) then '1' else '0' end
        -- Empty, not 0, when there is no typed figure -- so a reader can put the
        -- column back the way it was. It does not change the fingerprint; it keeps
        -- the restore from making a change nobody asked for.
        || '|' || coalesce(r.manual_linear_feet::text, '')
        || '|' || coalesce(r.manual_corner_count::text, '')
        || '|' || case when coalesce(r.is_teardown, false) then '1' else '0' end
        -- The seventh part, present only when there is a joint to record. Six parts
        -- therefore still mean "both joints empty", which is what a restore needs in
        -- order to be able to clear a join. NOT gated on teardown / closed / empty,
        -- unlike the fingerprint above: this records the drawing so it can be put
        -- back exactly, whether or not it currently prices anything.
        || case when sj <> '' or ej <> ''
                then '|sj=' || sj || ';ej=' || ej
                else '' end
      from j;
$fn$;

comment on function public.reapp_run_snapshot(public.fence_runs) is
  'The drawing of one run, as bar-joined parts, so a withdrawn approval can be put back. Six parts as before; a SEVENTH ("sj=<id>;ej=<id>") only when the run carries a joint, so six parts still mean both joints were empty and a restore from an older record correctly clears a join. Readers must accept 3, 6 and 7 BEFORE this is applied: see supabase_a56_join_reapproval_fingerprint.sql PART B.';


-- ---------- proof. Every ok must read true. -------------------------------
-- Read-only: plain SELECTs, no write, no temp table. Each positive control comes
-- BEFORE the claim it protects, so a true cannot be a true about nothing.

select 'POSITIVE CONTROL: there are runs to test this against' as check,
       (select count(*) > 0 from public.fence_runs) as ok
union all
select 'POSITIVE CONTROL: at least one run prices some footage (an all-empty table would make every claim below vacuous)',
       (select bool_or(not public.reapp_is_empty(
                   public.reapp_row_takeoff(r, coalesce(j.calibration_pixels_per_foot, 0))))
          from public.fence_runs r
          join public.jobs j on j.sync_id = r.job_sync_id and j.company_id = r.company_id
         where r.deleted_at is null)
union all
select 'PART 0: the joint columns this file needs exist',
       (select count(*) = 2 from information_schema.columns
         where table_schema = 'public' and table_name = 'fence_runs'
           and column_name in ('start_joint', 'end_joint'))
union all
select 'PART A: the fingerprint now reads both joint columns (this is the gap supabase_a32_join_runs.sql recorded as still open)',
       (select position('start_joint' in prosrc) > 0 and position('end_joint' in prosrc) > 0
          from pg_proc where pronamespace = 'public'::regnamespace
           and proname = 'reapp_row_takeoff')
union all
select 'PART A: its signature, volatility, rights and search_path are unchanged, so its EXECUTE grants survived',
       (select p.provolatile = 'i' and p.prosecdef = false
               and p.proconfig::text = '{search_path=public}'
               and pg_get_function_arguments(p.oid) = 'r fence_runs, ppf double precision'
          from pg_proc p where p.pronamespace = 'public'::regnamespace
           and p.proname = 'reapp_row_takeoff')
union all
select 'PART A: anon, authenticated, postgres and service_role still have EXECUTE on it',
       (select count(distinct grantee) = 4 from information_schema.routine_privileges
         where specific_schema = 'public' and routine_name = 'reapp_row_takeoff'
           and privilege_type = 'EXECUTE'
           and grantee in ('anon', 'authenticated', 'postgres', 'service_role'))
union all
select 'PART A: reapp_run_takeoff itself was NOT touched -- same seven arguments',
       (select pg_get_function_arguments(oid) = 'points_encoded text, gates_encoded text, closed_loop boolean, manual_ft double precision, manual_corners integer, is_teardown boolean, ppf double precision'
          from pg_proc where pronamespace = 'public'::regnamespace
           and proname = 'reapp_run_takeoff')
union all
select 'PART A: the empty-run shortcut the trigger relies on still works',
       (select public.reapp_is_empty('b=0.0|t=0.0|c=0|e=0|g=0|gf=0.0|gm=')
               and not public.reapp_is_empty('b=30.0|t=0.0|c=0|e=2|g=0|gf=0.0|gm='))
union all
-- The claim that matters most: no existing quote moved because this file ran. Every
-- run is unjoined today (supabase_a32_join_runs.sql backfills nothing), so every
-- fingerprint must still be the bare seven fields with no tail.
select 'PART A: no live run has a tail, so every fingerprint is byte-identical to the pre-join one',
       (select bool_and(public.reapp_row_takeoff(r, coalesce(j.calibration_pixels_per_foot, 0))
                        not like '%|sj=%')
          from public.fence_runs r
          join public.jobs j on j.sync_id = r.job_sync_id and j.company_id = r.company_id
         where r.deleted_at is null)
union all
-- CANARY for the row above: the same predicate on a string that DOES carry a tail
-- must read false, or the row above is a sentence that cannot be contradicted.
select 'CANARY: the same predicate on a fingerprint that does carry a tail reads false',
       ('b=30.0|t=0.0|c=0|e=2|g=0|gf=0.0|gm=|sj=a56a0001-0000-4000-8000-000000000001|ej=|jf=VINYL|jph=6.00|jfh=4.00|jso=0'
        not like '%|sj=%') = false
union all
select 'PART A: a junk joint id is ignored exactly as the readers ignore it',
       ('not-a-uuid' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') = false
       and ('a56a0001-0000-4000-8000-000000000001' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
union all
select 'NO BACKFILL: still no run is joined (this file created no join)',
       (select coalesce(bool_and(start_joint = '' and end_joint = ''), true)
          from public.fence_runs)
union all
select 'the trigger that uses all this is still the only one that does, and still SECURITY DEFINER',
       (select count(*) = 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
         where t.tgrelid = 'public.fence_runs'::regclass and not t.tgisinternal
           and p.proname = 'reapp_on_run_change' and p.prosecdef)
union all
-- PART B only. Reads false, not an error, when PART B was left out -- which is the
-- right answer until both readers accept a seven-part snapshot.
select 'PART B (only if applied): the snapshot can now carry the joints',
       (select position('start_joint' in prosrc) > 0 and position('end_joint' in prosrc) > 0
          from pg_proc where pronamespace = 'public'::regnamespace
           and proname = 'reapp_run_snapshot')
union all
select 'PART B (only if applied): every live run still snapshots to 6 parts, because none is joined',
       (select bool_and(array_length(string_to_array(public.reapp_run_snapshot(r), '|'), 1) = 6)
          from public.fence_runs r where r.deleted_at is null);
