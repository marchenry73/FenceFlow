-- ============================================================
-- FenceFlow -- takeoff improvements
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- Adds the columns behind three changes in the app:
--   * a run can be quoted from typed-in footage, with no drawing and no
--     calibration (manual_linear_feet / manual_corner_count)
--   * auto-added items the contractor deletes stay deleted (suppressed_roles)
--   * a job-level cut-and-waste allowance (waste_percent)
-- ============================================================

alter table fence_runs add column if not exists manual_linear_feet  double precision;
alter table fence_runs add column if not exists manual_corner_count integer not null default 0;
alter table fence_runs add column if not exists suppressed_roles    text    not null default '';

alter table jobs add column if not exists waste_percent double precision not null default 0;
