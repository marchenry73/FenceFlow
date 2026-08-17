-- What the supplier actually quoted, kept apart from the catalog guess.
--
-- supplier_unit_price is nullable on purpose: null means nobody has quoted this
-- line yet, which is a different thing from a quote of zero. Collapsing the two
-- would make an unquoted line read as free, and a job costed with free material
-- looks profitable right until the invoice arrives.
alter table estimate_line_items
  add column if not exists supplier_unit_price double precision;

alter table jobs
  add column if not exists material_prices_confirmed_at timestamptz,
  add column if not exists supplier_quote_reference text not null default '';

comment on column estimate_line_items.supplier_unit_price is
  'What the supplier quoted. Null means not yet quoted, and the job stays provisional.';
comment on column jobs.material_prices_confirmed_at is
  'Set once every line carries a real supplier price. Until then the totals are catalog estimates.';
