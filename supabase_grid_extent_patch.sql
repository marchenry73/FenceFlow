-- How much ground the no-photo grid covers.
--
-- The grid was a fixed 400ft square fitted to the screen, so on a phone one
-- foot was about two and a half pixels. A 20ft gate section came out as a
-- 50-pixel line nobody could draw accurately, and a small finger drag measured
-- forty feet. Fine for a property boundary, useless for a side gate.
--
-- Additive: everything existing keeps the 400ft it already had.
alter table public.jobs
  add column if not exists grid_extent_ft real not null default 400;
