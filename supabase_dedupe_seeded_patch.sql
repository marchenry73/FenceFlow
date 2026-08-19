-- Collapses the duplicate seeded rows that made the website show everything
-- five times over.
--
-- Cause: every install seeds its own copy of the standard pricing tiers and the
-- material catalog, each with its own random sync id, and pushes them. The app
-- hides the duplication because its PULL matches these by name rather than by
-- id -- so each phone shows one of each -- but nothing ever collapsed them in
-- the cloud, and the website reads the cloud directly. Five installs, five
-- copies.
--
-- SOFT delete, not a removal: every row stays in the table with deleted_at set.
-- Nothing is destroyed, DeletionReaper clears them from each phone, and setting
-- deleted_at back to null anywhere would bring one back.
--
-- Two different rules, because the two tables are in different situations.

-- ---------------------------------------------------------------------------
-- 1. Pricing tiers: keep the ZERO-markup copies.
--
-- These exist in two variants -- identical labour rates and discounts, but one
-- set carries a markup and the other does not. The owner confirmed the zero is
-- deliberate: margin is priced into the labour rate instead. Keeping the wrong
-- one would silently change what every future job quotes at, which is why this
-- was asked rather than assumed.
-- ---------------------------------------------------------------------------
with keeper as (
  select distinct on (company_id, lower(trim(name))) id
  from public.pricing_tiers
  where deleted_at is null
  order by company_id, lower(trim(name)),
           -- Zero markup first: that is the variant to keep.
           (markup_percent <> 0) asc,
           updated_at asc,
           sync_id asc
)
update public.pricing_tiers t
set deleted_at = now(),
    deleted_by = 'duplicate cleanup'
where t.deleted_at is null
  and t.id not in (select id from keeper);

-- ---------------------------------------------------------------------------
-- 2. Catalog items: any copy will do.
--
-- Verified before writing this: all 92 item groups agree on price to the cent,
-- so there is no decision to make and nothing to lose. Identity is name + role
-- + fence type + colour, which is the same rule the app already uses when it
-- decides a pulled item is one it already has.
-- ---------------------------------------------------------------------------
with keeper as (
  select distinct on (
           company_id, lower(trim(name)), role, fence_type, lower(trim(color_or_finish))
         ) id
  from public.material_items
  where deleted_at is null
  order by company_id, lower(trim(name)), role, fence_type, lower(trim(color_or_finish)),
           updated_at asc, sync_id asc
)
update public.material_items m
set deleted_at = now(),
    deleted_by = 'duplicate cleanup'
where m.deleted_at is null
  and m.id not in (select id from keeper);

-- What survived.
select 'pricing_tiers' as t,
       count(*) filter (where deleted_at is null) as live,
       count(*) filter (where deleted_at is not null) as tombstoned
from public.pricing_tiers
union all
select 'material_items',
       count(*) filter (where deleted_at is null),
       count(*) filter (where deleted_at is not null)
from public.material_items;
