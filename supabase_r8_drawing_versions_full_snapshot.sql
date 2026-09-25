-- ============================================================
-- FenceFlow -- the drawing snapshot has to carry everything the fingerprint
--              reads, or "put it back" puts back a job that still does not match
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- KIND
--   ADDITIVE. One function replaced in place (reapp_run_snapshot, same
--   signature, ACL untouched). No column added or dropped, no row changed. Rows
--   already written keep their three-part snapshots and stay readable.
--
-- THE HOLE THIS CLOSES
--   supabase_r8_drawing_versions.sql stored the drawing as
--   points|gates|closedLoop, and a restore that writes those three back is
--   supposed to reproduce the takeoff fingerprint the customer's approval was
--   measured against. It often cannot, because the fingerprint is taken on MORE
--   than those three. reapp_row_takeoff (live, read 24 September) feeds
--   reapp_run_takeoff:
--
--       points_encoded, gates_encoded, closed_loop,
--       manual_linear_feet, manual_corner_count, is_teardown,
--       and ppf -- the JOB's calibration_pixels_per_foot
--
--   manual_linear_feet outranks the geometry outright (typed footage wins, the
--   same way resolveGeometry does), manual_corner_count comes with it, and
--   is_teardown decides whether the footage counts as fence built or fence
--   coming out. So a change that touched the typed footage, the typed corner
--   count or the teardown flag left a snapshot that cannot possibly match, and
--   the restore would put the drawing back, fail the proof, and report "the
--   price must have moved" -- naming the wrong cause, which is worse than
--   saying nothing.
--
-- WHAT IS STILL NOT COVERED, said plainly
--   ppf is on the JOB, not the run. If the grid size or the calibration changed
--   after the customer approved, every run's fingerprint moves and no run-level
--   restore can bring the approval back. Putting the drawing back still works;
--   the approval does not return, and that is correct -- a job measured at a
--   different scale is not the job they agreed to. Nothing here pretends
--   otherwise, and this is the reason the copy in both halves must never promise
--   the approval will come back.
--
-- THE FORMAT, and why it is appended rather than replaced
--   Six fields now, '|' separated:
--       points | gates | closedLoop | manualFeet | manualCorners | isTeardown
--   closedLoop and isTeardown are '1' or '0'. manualFeet is empty when null.
--
--   An empty manualFeet must be read back as NULL, not 0 -- but NOT because the
--   fingerprint would differ. It would not: reapp_run_takeoff branches on
--   `manual_ft is not null and manual_ft > 0`, so NULL and 0 both fall to the
--   geometry side and it returns the same string. An earlier version of this
--   header said otherwise and was wrong. The reasons that hold: a 0 written
--   where NULL stood is a real change, so it provokes a write that moves the
--   run's clock and can beat an edit still on its way up; the change record it
--   produces announces typed footage of 0 ft on a run nobody typed into; and the
--   estimate screen seeds its typed-footage box from the column, so NULL shows an
--   empty box and 0 shows a literal 0.
--
--   manualCorners is written for symmetry only. manual_corner_count is NOT NULL
--   with a default of 0, so it can never be empty in a snapshot the database
--   wrote, and both readers treat an empty one as 0 rather than refusing it.
--
--   Neither points_encoded nor gates_encoded can contain '|': points are
--   'x:y' joined by ',' and gates are 'x:y:width:MOUNTING:SWING' joined by ','.
--   So splitting on '|' is exact, and a reader must accept THREE parts (a row
--   written before today) as well as six. Three parts means geometry only, and a
--   restore from one of those is honest but weaker -- it cannot put typed
--   footage back because it never recorded any.
-- ============================================================

-- ------------------------------------------------------------------------
-- PART 1  the snapshot
-- ------------------------------------------------------------------------

create or replace function public.reapp_run_snapshot(r public.fence_runs)
returns text
language sql
immutable
as $fn$
    select coalesce(r.points_encoded, '')
        || '|' || coalesce(r.gates_encoded, '')
        || '|' || case when coalesce(r.closed_loop, false) then '1' else '0' end
        -- Empty, not 0, when there is no typed figure -- so a reader can put the
        -- column back the way it was. It does not change the fingerprint (see the
        -- header); it keeps the restore from making a change nobody asked for.
        || '|' || coalesce(r.manual_linear_feet::text, '')
        || '|' || coalesce(r.manual_corner_count::text, '')
        || '|' || case when coalesce(r.is_teardown, false) then '1' else '0' end;
$fn$;

-- ------------------------------------------------------------------------
-- PART 2  prove what landed. Every row must read true.
-- ------------------------------------------------------------------------

-- Against real runs, read-only: reapp_run_snapshot is a pure function of a row,
-- so a plain SELECT exercises exactly what the trigger will call. No write, no
-- temp table -- fence_runs carries the reapproval trigger and an edit-version
-- bump, and neither should be woken to answer a question about a string.
select 'every run now snapshots into six parts' as check,
       (select bool_and(array_length(string_to_array(public.reapp_run_snapshot(r), '|'), 1) = 6)
          from public.fence_runs r) as ok
union all
select 'there are runs to test it on (a true above is not an empty table)',
       (select count(*) > 0 from public.fence_runs)
union all
-- The three run columns the old snapshot left out, now present. Checked by
-- name in the body rather than by eye, because leaving one out is silent: the
-- restore works, the fingerprint still misses, and the office is told the price
-- moved when it did not.
select 'the snapshot reads manual_linear_feet, manual_corner_count and is_teardown',
       (select position('manual_linear_feet' in prosrc) > 0
             and position('manual_corner_count' in prosrc) > 0
             and position('is_teardown' in prosrc) > 0
          from pg_proc where pronamespace = 'public'::regnamespace
           and proname = 'reapp_run_snapshot')
union all
-- CANARY: the six-part test must be able to fail. An old three-part snapshot
-- is what a row written before today holds, and a reader has to accept it.
select 'CANARY: a three-part snapshot is still told apart from a six-part one',
       array_length(string_to_array('10:10,90:10||1', '|'), 1) = 3
union all
select 'and the empty typed-footage field is empty, not zero',
       (select bool_and(split_part(public.reapp_run_snapshot(r), '|', 4) = '')
          from public.fence_runs r where r.manual_linear_feet is null);
