-- The supplier's own part number for a catalog item, so whoever is on the
-- phone with the yard can quote it instead of describing it.
--
-- Gap #11 of the launch audit ("suppliers, SKU, delivery, misc costs") turned
-- out to be mostly already built: manufacturers already IS the supplier
-- table, material_items.manufacturer_sync_id already links a catalog item to
-- one, and expenses already carries a job-scoped cost with no schema change
-- needed for delivery or misc costs (see the dashboard's own comments on
-- addJobCost). The one real gap was the SKU itself -- nowhere to put it.
--
-- Nullable, no default: null means nobody has typed a part number for this
-- item, which is the ordinary case for an item added by hand rather than
-- from a supplier's own list. A default of '' would look identical to a
-- number somebody deliberately left blank, and the dashboard's own catalog
-- editor already treats that distinction as load-bearing for supplier_sku's
-- neighbour, supplier_unit_price.
alter table material_items
  add column if not exists supplier_sku text;

comment on column material_items.supplier_sku is
  'The supplier''s own part number for this item. Null means not recorded, not "no SKU".';

-- Undo:
--   alter table material_items drop column if exists supplier_sku;
