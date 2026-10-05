-- ============================================================================
-- h1: a site marker can be a BOX, not only a point.
--
-- ADDITIVE ONLY. Three nullable-with-default columns. A marker that never sets
-- them has width 0 and height 0, which is what every one of the 8 existing rows
-- has and is exactly how they behave today: a point.
--
-- WHY A HOUSE NEEDS THIS. SiteMarker is x, y and a label -- a dot. He asked
-- three times for "a larger box, something that looks like a house", and the
-- reason it kept not looking like one is that there was nowhere to put a size.
-- The quote image already anchors on the HOUSE marker, so the position was
-- right and only the shape was missing.
--
-- ZERO MEANS POINT, deliberately, rather than a nullable width with a separate
-- is_box flag. Two columns that can disagree about whether something is a box
-- is one more thing to keep in step; a width of zero is not a box, and that is
-- the whole rule.
-- ============================================================================
alter table public.site_markers
  add column if not exists width_ft    real not null default 0,
  add column if not exists height_ft   real not null default 0,
  -- Degrees clockwise. A house is almost never square to the road, and a box
  -- that cannot turn is a box he has to pretend about.
  add column if not exists rotation_deg real not null default 0;
