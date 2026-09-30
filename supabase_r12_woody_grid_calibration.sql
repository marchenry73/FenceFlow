-- ============================================================================
-- PART A AND PART B ARE BOTH APPLIED, 29 September 2026. This header said
-- UNAPPLIED until they were, and is corrected here rather than left to fool a
-- later survey -- a stale header in this repo once did exactly that for four
-- days. Sequence actually run: PART A's dry run first (it rolled back, and the
-- live row was re-read afterwards to prove it had), then PART B.
--
-- RESULT, verified by an independent platform-wide re-survey rather than by
-- this file's own read-back: Woody now reads calibration 320 against grid
-- extent 25, contract_total UNCHANGED at 3620.00, and across all ten companies
-- there are now ZERO extent/calibration mismatches and ZERO missing
-- calibrations at a non-default extent. Woody was the only mismatched row on
-- the whole platform. The formula 8000/extent is corroborated by three
-- untouched rows that already agreed with it: extent 50 -> 160, 100 -> 80,
-- 400 -> 20.
--
-- The nine remaining rows with a NULL calibration are all at extent 400, where
-- the server's flat assumption of 20 px/ft is arithmetically correct, so they
-- never diverged and are deliberately left alone.
--
-- The EXACT REVERSE at the bottom of this file is now live-relevant: it is what
-- puts Woody back to 20 if this turns out to be wrong. Originally verified
-- against the LIVE database (project newcrgafcptspmapacrx) read-only,
-- 2026-09-29, via `supabase db query --linked` -- not inherited from an
-- earlier report. Every figure below is a live reading, not a repo file.
--
-- RESTRUCTURED 2026-09-29. The first version of this file told the reader to
-- review the verification output before applying, but put both verification
-- SELECTs INSIDE the same begin/commit as the UPDATE -- so running the file
-- at all committed the change, and "review before applying" was never
-- actually possible; there was only "review after it already happened."
-- Below is now two independent pieces: PART A is a dry run that runs the
-- real UPDATE, prints the real before-and-after, and always ROLLS BACK, so
-- it is safe to run any number of times and commits nothing; PART B is the
-- separate, clearly marked APPLY step, meant to be run only after PART A's
-- output has been read and matches what this header claims. The arithmetic
-- (8000.0 / grid_extent_ft, the zero-drawn-points safety guard) and the
-- surfaced-not-silently-skipped handling of a mismatched-but-drawn-on job
-- are unchanged from the first version. An exact reverse for today's one
-- known case is added at the end, which the first version did not have.
--
-- RE-VERIFIED LIVE, 2026-09-29, same session as the restructuring: every
-- figure in the section below (grid_extent_ft 25, calibration_pixels_per_
-- foot 20, survey_storage_path null, one fence_runs row "Water softener"
-- with points_encoded length 0 and gates_encoded length 31, zero
-- site_markers, contract_total and signed_contract_total both 3620, signed_
-- at 2026-09-17, 21 jobs total / 19 non-deleted / 2 soft-deleted, exactly
-- one live candidate and zero mismatched-with-drawn-points jobs) still
-- matches the live database exactly as first written. Nothing here needed
-- correcting.
-- ============================================================================
--
-- THE DEFECT
-- ----------
-- Job "Woody" (company "Fence solutions", sync_id
-- 93427b69-9552-4114-b25a-8e607adce480, id 4eb3cfe6-1330-40a1-a623-
-- ecd356a05bf4) carries, live, right now:
--
--     grid_extent_ft               25
--     calibration_pixels_per_foot  20
--     survey_storage_path          null   (a grid job, not a photo job)
--
-- The app's own scale rule for a no-photo grid job (DrawingScale.unitsPerFoot,
-- app/src/main/java/com/fenceestimator/app/estimate/DrawingScale.kt) is
-- GRID_CANVAS_SIZE / grid_extent_ft, with GRID_CANVAS_SIZE = 8000. For a
-- 25ft grid that is 8000 / 25 = 320 pixels/foot. The stored value, 20, is
-- the OLD flat PIXELS_PER_FOOT_GRID constant -- correct only for the 400ft
-- default (8000/400 = 20) -- written onto a job that had already been zoomed
-- to a tighter 25ft grid. 320 / 20 = 16, so anything measured against the
-- stored number reads sixteen times too long: a real 10ft run would draw at
-- 10 * 320 = 3200 canvas units, and 3200 / 20 (the stored, wrong figure)
-- = 160ft. This is the exact defect SurveyViewModel.resetGridCalibration's
-- current doc comment names as the live data point that motivated fixing the
-- write path (see that file, "grid-extent/calibration split") -- this file
-- is the data-side half of that finding: the write path is already fixed
-- (86d5aa3, already in the tree), the one row it left behind is not.
--
-- WHY NOTHING IS WRONG YET -- PROVEN LIVE, NOT ASSUMED
-- ------------------------------------------------------
-- The bug can only move a price by scaling a drawn line. Live reads, same
-- session as the figures above:
--
--   * Exactly one fence_runs row exists for this job (job_sync_id =
--     93427b69-9552-4114-b25a-8e607adce480): label "Water softener",
--     points_encoded length 0, gates_encoded length 31. Zero site_markers.
--     So there is one un-drawn run carrying a single gate marker and NO
--     polyline.
--   * EstimateEngine.footageOf / FenceGeometryEngine.analyze measures a run
--     from FenceCodec.decodePoints(run.pointsEncoded). An empty points string
--     decodes to zero points, which is zero segments, which is 0.0 feet --
--     multiplied by ANY calibration value, 20 or 320, the answer is still
--     0.0. The lone gate's cost (GateMarker.widthFt, e.g. EstimateEngine
--     gateWidthTotal) is typed directly in real feet by whoever placed it
--     and is never multiplied by calibration_pixels_per_foot at all; a gate
--     only borrows the canvas's pixel scale to find which line side it sits
--     nearest (GateSpan), which requires >= 2 points and returns null here
--     (points.size = 0).
--   * So today, on this job, the calibration figure has nothing to multiply.
--     contract_total and signed_contract_total both read 3620 (signed_at
--     2026-09-17 20:20:34+00 -- this is the same "Woody was signed at
--     $3,620" job named in supabase/functions/_shared/quote-deposit.ts's own
--     comment, corroborating this is the job the owner means), and this fix
--     does not touch either figure, directly or through any recompute this
--     file triggers -- it touches only calibration_pixels_per_foot.
--
-- IF HE LEAVES IT AND SOMEBODY DRAWS INSTEAD OF THIS BEING APPLIED
-- -------------------------------------------------------------------
-- The next line drawn on this job's grid, at the job's current 25ft extent,
-- would be measured at the stored 20 px/ft instead of the correct 320 px/ft:
-- every foot actually drawn would price as sixteen feet. A 20ft gate run
-- would read, and bill, as roughly 320ft. Both the phone that drew it and
-- the office reading the same row afterward would agree with each other --
-- both read the one stored number -- so nothing would look inconsistent to
-- either side; it would simply be wrong, silently, by 16x, on whatever gets
-- drawn.
--
-- THE EXACT REVERSE
-- ------------------
-- Applying this fix (or any calibration correction) to a job AFTER real
-- geometry has been drawn under the wrong number is the dangerous direction,
-- not the safe one: it would rescale an already-priced line by the same
-- 16x, silently moving a signed price -- shrinking a wrongly-inflated
-- reading back down, or inflating a correctly-typed manual figure, depending
-- on which way the stored value was wrong. That is exactly why the guarded
-- UPDATE below only ever touches a job with zero points_encoded across every
-- one of its fence_runs, checked at the moment it runs, not from this file's
-- stale reading -- and why it is written to refuse (not silently skip) if
-- that has stopped being true.
--
-- ANY OTHER LIVE JOB WITH THE SAME DISAGREEMENT?
-- -------------------------------------------------
-- No. Read live, 2026-09-29: of 19 non-deleted jobs (21 total, 2 soft-
-- deleted), every grid job (survey_storage_path is null) whose
-- calibration_pixels_per_foot disagrees with a fresh 8000/grid_extent_ft
-- calibration for its OWN grid_extent_ft returns exactly one row -- this
-- one. (Photo jobs are excluded from that comparison on purpose: a photo
-- job's calibration comes from a hand tap-two-points calibration and has no
-- relationship to grid_extent_ft at all, so comparing them there would be a
-- false positive, not a finding.) This is a point-in-time answer: any job
-- edited between this reading and whenever this file is applied is not
-- covered by it, which is exactly why the UPDATE below is a live WHERE
-- clause over the defect's shape, not a list of one hardcoded id.
--
-- WHAT THIS FILE DOES
-- ---------------------
-- One additive UPDATE, scoped to grid jobs (no survey photo) whose stored
-- calibration disagrees with a fresh calibration for their own grid extent,
-- AND that have zero drawn points across every one of their fence_runs
-- (checked live, in the same statement). Today that is exactly Woody's job,
-- moving calibration_pixels_per_foot from 20 to 320. A job that disagrees
-- but ALSO has real points drawn is deliberately left alone -- rescaling
-- drawn geometry safely needs the point-by-point ratio multiply
-- SurveyViewModel.setGridExtent already does in Kotlin, not a bare column
-- UPDATE in SQL -- and is instead surfaced by the SELECT at the bottom so it
-- cannot pass unnoticed.
--
-- No row is deleted. No other column is touched. calibration_known_feet is
-- left as-is (already null on Woody's job; a non-null value there belongs to
-- a hand calibration and this fix has no opinion about hand calibrations).
-- ============================================================================

-- ============================================================================
-- PART A -- DRY RUN. Runs the real UPDATE, prints the real before-and-after,
-- then ALWAYS ROLLS BACK. Safe to run any number of times; commits nothing.
-- Read this output before ever running PART B below.
-- ============================================================================

-- NOTE ON RUNNING THIS: `supabase db query -f <file> --output json` (the
-- method this whole wave's read-only checks used) prints only the LAST
-- statement's result set, not every SELECT in the file -- confirmed while
-- restructuring this file: three separate top-level SELECTs here originally
-- returned only the third. So BEFORE, AFTER and the surfaced-mismatch check
-- are combined below into ONE final unioned SELECT, so one CLI invocation
-- (or one paste into the SQL editor) shows all three together. Tested live,
-- 2026-09-29, in a rolled-back transaction: BEFORE showed Woody at 20,
-- AFTER showed 320, and "surfaced" was empty, exactly as this header claims.

begin;

create temp table r12_before as
select j.id, j.sync_id, j.customer_name, j.grid_extent_ft, j.calibration_pixels_per_foot as before_calibration,
       (8000.0 / j.grid_extent_ft) as fresh_calibration, j.contract_total, j.signed_contract_total, j.signed_at
from public.jobs j
where j.survey_storage_path is null
  and j.deleted_at is null
  and j.calibration_pixels_per_foot is not null
  and j.grid_extent_ft is not null
  and j.grid_extent_ft > 0
  and abs(j.calibration_pixels_per_foot - (8000.0 / j.grid_extent_ft)) > 0.01;

with candidates as (
    select j.id, j.sync_id, j.company_id, j.grid_extent_ft, j.calibration_pixels_per_foot,
           (8000.0 / j.grid_extent_ft) as fresh_calibration,
           (
             select coalesce(sum(length(fr.points_encoded)), 0)
             from public.fence_runs fr
             where fr.job_sync_id = j.sync_id and fr.company_id = j.company_id
           ) as total_points_len
    from public.jobs j
    where j.survey_storage_path is null
      and j.deleted_at is null
      and j.calibration_pixels_per_foot is not null
      and j.grid_extent_ft is not null
      and j.grid_extent_ft > 0
      and abs(j.calibration_pixels_per_foot - (8000.0 / j.grid_extent_ft)) > 0.01
),
safe_to_fix as (
    select * from candidates where total_points_len = 0
)
update public.jobs j
   set calibration_pixels_per_foot = s.fresh_calibration
  from safe_to_fix s
 where j.id = s.id;

-- BEFORE, from the snapshot taken above the UPDATE; AFTER, re-read from the
-- same rows post-UPDATE (still inside this transaction, not yet rolled
-- back) -- this must be exactly the one row, Woody's, 20 -> 320; and
-- anything a mismatched grid job WITH drawn points, which the UPDATE
-- deliberately did not touch and which must be empty today (surfaced here
-- instead of silently updating, same as the first version of this file).
select 'BEFORE' as phase, b.id, b.sync_id, b.customer_name, b.grid_extent_ft,
       b.before_calibration as calibration_pixels_per_foot, b.fresh_calibration,
       b.contract_total, b.signed_contract_total, b.signed_at
  from r12_before b
union all
select 'AFTER' as phase, j.id, j.sync_id, j.customer_name, j.grid_extent_ft,
       j.calibration_pixels_per_foot, (8000.0 / j.grid_extent_ft) as fresh_calibration,
       j.contract_total, j.signed_contract_total, j.signed_at
  from public.jobs j
 where j.id in (select id from r12_before)
union all
select 'SURFACED: mismatched WITH drawn points, left alone on purpose (expect zero rows)' as phase,
       j.id, j.sync_id, j.customer_name, j.grid_extent_ft, j.calibration_pixels_per_foot,
       (8000.0 / j.grid_extent_ft) as fresh_calibration, j.contract_total, j.signed_contract_total, j.signed_at
  from public.jobs j
 where j.survey_storage_path is null
   and j.deleted_at is null
   and j.calibration_pixels_per_foot is not null
   and j.grid_extent_ft is not null
   and j.grid_extent_ft > 0
   and abs(j.calibration_pixels_per_foot - (8000.0 / j.grid_extent_ft)) > 0.01
order by phase;

rollback;

-- ============================================================================
-- PART B -- APPLY. Not run by this file. Identical statement to the UPDATE
-- reviewed in PART A above, this time actually committed. Run this only
-- after PART A's "BEFORE"/"AFTER" output has been read and matches what the
-- header of this file claims (one row, Woody's, 20 -> 320; the "left alone
-- on purpose" SELECT empty). Copy the block below out and run it yourself --
-- it is deliberately not executed as part of this file.
-- ============================================================================
-- begin;
--
-- with candidates as (
--     select j.id, j.sync_id, j.company_id, j.grid_extent_ft, j.calibration_pixels_per_foot,
--            (8000.0 / j.grid_extent_ft) as fresh_calibration,
--            (
--              select coalesce(sum(length(fr.points_encoded)), 0)
--              from public.fence_runs fr
--              where fr.job_sync_id = j.sync_id and fr.company_id = j.company_id
--            ) as total_points_len
--     from public.jobs j
--     where j.survey_storage_path is null
--       and j.deleted_at is null
--       and j.calibration_pixels_per_foot is not null
--       and j.grid_extent_ft is not null
--       and j.grid_extent_ft > 0
--       and abs(j.calibration_pixels_per_foot - (8000.0 / j.grid_extent_ft)) > 0.01
-- ),
-- safe_to_fix as (
--     select * from candidates where total_points_len = 0
-- )
-- update public.jobs j
--    set calibration_pixels_per_foot = s.fresh_calibration
--   from safe_to_fix s
--  where j.id = s.id;
--
-- select j.id, j.sync_id, j.customer_name, j.grid_extent_ft, j.calibration_pixels_per_foot,
--        j.contract_total, j.signed_contract_total, j.signed_at
-- from public.jobs j
-- where j.sync_id = '93427b69-9552-4114-b25a-8e607adce480';
--
-- commit;

-- ============================================================================
-- EXACT REVERSE for today's one known case (Woody, id 4eb3cfe6-1330-40a1-
-- a623-ecd356a05bf4) -- not run by this file. If PART B is applied and needs
-- to come back out, this restores the exact prior value (20) by id, not by
-- re-running the live WHERE clause (which would no longer match once the
-- value is 320). If a future run of PART B ever catches a DIFFERENT job
-- (the WHERE clause is live, not a fixed list), build that job's reverse
-- from PART A's own "BEFORE" output at the time, the same way this one was
-- built from today's.
-- ============================================================================
-- update public.jobs
--    set calibration_pixels_per_foot = 20
--  where id = '4eb3cfe6-1330-40a1-a623-ecd356a05bf4'
--    and sync_id = '93427b69-9552-4114-b25a-8e607adce480';
