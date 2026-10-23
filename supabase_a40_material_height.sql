-- ============================================================
-- FenceFlow -- how tall a catalog panel is: material_items.height_ft
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- ############################################################################
-- #  STATUS: WRITTEN, NOT APPLIED.  Written 1 October 2026.                  #
-- #  Nothing in this file has been run against any database. It was checked  #
-- #  against the live catalogue with SELECTs only (the facts below), and the #
-- #  engine change that reads the column was replayed over every real job.   #
-- #  Apply it to the DEV project first (DEV_ENVIRONMENT.md), read the proof  #
-- #  rows at the bottom, and only then to production.                        #
-- ############################################################################
--
-- WHY
--   A catalog row could not say how tall it was. The pricing engine chose a
--   PANEL or GATE_PANEL by colour, manufacturer, NEAREST WIDTH (covers_ft), then
--   CHEAPEST. In the starting catalog "Ornamental Steel Panel 4'H x 6'W" (135.00)
--   and the 6'H one (175.00) are both 6 ft wide, so a 6 ft high iron run took the
--   cheaper 4 ft high panel: $40 a panel short before tax, $727.60 on a 100 ft
--   job. Between PANEL (or GATE_PANEL) rows of one width, the engines now prefer
--   the row whose height_ft equals the run's panel height (line-items.ts and
--   EstimateEngine.buildLineItems, PRICING_ENGINE_VERSION 2026.10.2). This file
--   is the column they read. It is NOT covers_ft: covers_ft is the WIDTH of a
--   PANEL or GATE_PANEL and the HEIGHT of CHAIN_FABRIC, and that double meaning is
--   the reason this has a column of its own.
--
-- KIND
--   ADDITIVE, with ONE optional data write (PART 3).
--     PART 1  one nullable column on material_items. NULL = "the row does not
--             say", which is every row until PART 3 or a person fills it in, and
--             prices exactly as before the column existed.
--     PART 2  the crew door, material_items_crew, gains the column (and only that).
--             Guarded: it refuses to run if the live view is not what this file
--             was written against, and it checks afterwards that unit_price and
--             supplier_sku are still absent and that the door is no more open
--             than it was (CREATE OR REPLACE leaves ownership and grants alone).
--     PART 3  sets height_ft on the fifteen STARTING-LIST panel and gate-panel
--             rows, by their exact name, role and fence type. READ IT BEFORE YOU
--             APPLY; how to skip it is in its own header.
--   No policy, trigger, function or grant is created, changed or dropped.
--
-- WHAT WAS CHECKED LIVE (read-only, 1 Oct 2026; companies are not named here)
--   - material_items has no height column today; covers_ft is `real`, so this is `real`.
--   - material_items_crew is `security_barrier=true, security_invoker=false`, owned by
--     postgres, 17 columns, no unit_price and no supplier_sku. PART 2 keeps all of it.
--   - The BEFORE UPDATE triggers PART 3 fires: touch_updated_at (bumps updated_at,
--     which is what makes phones pull the new heights), hold_money_columns('unit_price')
--     (resets unit_price to its old value, a no-op here) and enforce_delete_permission
--     (only acts when deleted_at is set). No other trigger is on the table.
--   - PART 3 matches fifteen live rows, all in the one real company that holds a catalog,
--     and no fixture company holds any panel row. Replayed through the engine as it was
--     and as it is now, every one of the real jobs prices identically (none is iron),
--     while a synthetic 6 ft iron job on the same catalog moves from the 4'H panel to the
--     6'H panel: +$727.60 at 100 ft, 7% tax, no markup.
--
-- ORDER OF APPLYING, AND WHY IT MATTERS
--   1. THIS FILE FIRST.
--   2. THEN deploy price-job with `height_ft` added to its CATALOG_COLUMNS. Not before:
--      price-job selects its columns by name, so a deploy that names height_ft before
--      the column exists makes every office re-price answer 500.
--   3. THEN ship the app (Room 49, engine 2026.10.2). A phone that updates earlier is
--      harmless: its catalog pull reads `*`, and it sends height_ft only when it holds
--      one, which it cannot before step 1.
--   Until step 2 the office engine prices as it did (it never sees the column), and until
--   a phone updates it prices as it did; the engine-version comparison in JobSync makes the
--   phone back off, filing a pricing_parity report, on a job the office priced under the
--   newer version rather than overwrite it.
--
-- HOW TO UNDO IT
--   Mostly: don't. Leaving the column, the crew door and the heights in place harms nothing, and
--   with no height filled in prices are exactly as they were. To clear the data (on the owner's
--   say-so, because it deletes what was filled in):
--       -- update public.material_items set height_ft = null where height_ft is not null;
--   To remove the COLUMN itself the crew door has to come out first (it selects the column, and
--   CREATE OR REPLACE cannot remove a view column), be rebuilt without it and be re-granted
--   exactly as supabase_crew_money_shield_patch.sql and supabase_r6_crew_views_readonly.sql
--   grant it. That recipe is deliberately not written out here: an untested recipe for a
--   security door is worse than none. Do it with the live grants in front of you.
-- ============================================================

begin;

-- ------------------------------------------------------------------------
-- PART 1  THE COLUMN
-- ------------------------------------------------------------------------
-- `real`, like covers_ft, because the phone holds both as a Float and the two engines
-- compare it with the run's panel height as a Float. Nullable, no default: NULL is "the
-- row does not say". No CHECK constraint: a bad value must not be able to fail a phone's
-- whole catalog push as a batch, and a value that is not a real height simply never
-- equals a run's.
alter table public.material_items add column if not exists height_ft real;

comment on column public.material_items.height_ft is
  'How tall a PANEL or GATE_PANEL row is, in feet. NULL = the row does not say. NOT covers_ft, which is the width of a PANEL or GATE_PANEL and the height of CHAIN_FABRIC. Read by both pricing engines to choose between rows of one width (PRICING_ENGINE_VERSION 2026.10.2); never worked out from the product name.';

-- ------------------------------------------------------------------------
-- PART 2  THE CREW DOOR
-- ------------------------------------------------------------------------
-- A crew phone reads the catalog through material_items_crew (no unit_price), and the view
-- lists its columns, so a new column on the table does not appear in it by itself. Without
-- this a crew phone would choose the 4 ft high panel for a 6 ft job and show it on the
-- materials list, with no money involved at all.
--
-- The view is replaced with EXACTLY its live definition plus height_ft, last (a replaced
-- view may only add columns at the end). WITH (...) replaces every option of the view, so
-- both are written out. Ownership and grants are not touched by CREATE OR REPLACE.
do $a40_guard$
declare
    want constant text[] := array['id', 'company_id', 'sync_id', 'name', 'category', 'role', 'fence_type',
        'color_or_finish', 'unit', 'taxable', 'covers_ft', 'manufacturer_sync_id', 'is_active', 'source_doc',
        'updated_at', 'deleted_at', 'deleted_by'];
    have text[];
    opts text[];
begin
    if to_regclass('public.material_items_crew') is null then
        raise exception 'a40: public.material_items_crew does not exist; refusing to guess its definition';
    end if;
    select array_agg(a.attname::text order by a.attnum) into have
      from pg_attribute a
     where a.attrelid = 'public.material_items_crew'::regclass and a.attnum > 0 and not a.attisdropped;
    select c.reloptions into opts from pg_class c where c.oid = 'public.material_items_crew'::regclass;
    -- A re-run finds the column already there, and that is fine.
    if have is distinct from want and have is distinct from (want || array['height_ft']::text[]) then
        raise exception 'a40: material_items_crew has columns this file was not written against (%). Read the live view before replacing it.', have;
    end if;
    if opts is null or array_length(opts, 1) <> 2
       or not (opts @> array['security_barrier=true', 'security_invoker=false']) then
        raise exception 'a40: material_items_crew options are not exactly security_barrier=true, security_invoker=false (%)', opts;
    end if;
end
$a40_guard$;

create or replace view public.material_items_crew
    with (security_barrier = true, security_invoker = false) as
select id, company_id, sync_id, name, category, role, fence_type, color_or_finish, unit, taxable,
       covers_ft, manufacturer_sync_id, is_active, source_doc, updated_at, deleted_at, deleted_by,
       height_ft
  from public.material_items
 where company_id = public.current_company_id() and not public.company_is_suspended();

-- What must still be true of the door. Any failure rolls the whole file back.
do $a40_check$
declare
    cols text[];
    opts text[];
begin
    select array_agg(a.attname::text order by a.attnum) into cols
      from pg_attribute a
     where a.attrelid = 'public.material_items_crew'::regclass and a.attnum > 0 and not a.attisdropped;
    if cols[array_length(cols, 1)] is distinct from 'height_ft' then
        raise exception 'a40: height_ft is not the last column of material_items_crew (%)', cols;
    end if;
    -- The options were written out in full above; if Postgres replaced them with anything else, undo it all.
    select c.reloptions into opts from pg_class c where c.oid = 'public.material_items_crew'::regclass;
    if opts is null or array_length(opts, 1) <> 2
       or not (opts @> array['security_barrier=true', 'security_invoker=false']) then
        raise exception 'a40: the crew door lost an option when it was replaced (%)', opts;
    end if;
    if 'unit_price' = any(cols) or 'supplier_sku' = any(cols) then
        raise exception 'a40: the crew door carries a column it must not (%)', cols;
    end if;
    if has_table_privilege('anon', 'public.material_items_crew', 'select')
       or has_table_privilege('authenticated', 'public.material_items_crew', 'insert')
       or has_table_privilege('authenticated', 'public.material_items_crew', 'update')
       or has_table_privilege('authenticated', 'public.material_items_crew', 'delete') then
        raise exception 'a40: the crew door is more open than it was';
    end if;
    if not has_table_privilege('authenticated', 'public.material_items_crew', 'select') then
        raise exception 'a40: the crew door can no longer be read by a signed-in crew member';
    end if;
end
$a40_check$;

-- ------------------------------------------------------------------------
-- PART 3  THE STARTING-LIST HEIGHTS  (the one data write; the owner's call)
-- ------------------------------------------------------------------------
-- Without this the engine change does nothing for a company that already has the starting
-- list: every height_ft is NULL, so every row "does not say", and the 6 ft iron run keeps
-- taking the 4 ft panel until somebody fills fifteen rows in by hand, and the catalog editor
-- has no field for it yet.
--
-- It is NOT a parse of the name. It is a list of fifteen exact (name, role, fence type)
-- identities -- the rows SeedData.kt ships and the console's "start from FenceFlow's
-- catalog" copies -- and the height each one's name states, written out by hand. A row that
-- has been renamed, is a different role or fence type, or already has a height is not
-- touched, and the ENGINE never reads a name: rename any of these afterwards and nothing
-- moves. tests/a40-height-*.test.mjs holds this list to SeedData.kt, so it cannot drift.
--
-- What it changes, checked by replay over every real job: nothing that is quoted today.
-- What it enables: a 6 ft high iron run takes the 6'H panel; and a company can add a 4 ft
-- high row to any fence type without it taking over the 6 ft quotes.
--
-- TO SKIP IT: delete this PART, or run only PART 1 and PART 2. Everything else stands, and
-- the heights can be filled in later, per row.
-- TO KEEP A ROW OUT: delete its line. Only rows with height_ft IS NULL are ever written, so
-- a height somebody typed is never overwritten, and a re-run changes nothing.
update public.material_items m
   set height_ft = v.h
  from (values
    -- VINYL
    ('Panel T&G Vinyl Privacy 6''H x 6''W - White', 'PANEL',      'VINYL',           6::real),
    ('Panel T&G Vinyl Privacy 6''H x 6''W - Tan',   'PANEL',      'VINYL',           6::real),
    ('Panel T&G Vinyl Privacy 6''H x 6''W - Gray',  'PANEL',      'VINYL',           6::real),
    ('Panel T&G Vinyl Privacy 6''H x 8''W - White', 'PANEL',      'VINYL',           6::real),
    ('Panel T&G Vinyl Privacy 6''H x 8''W - Tan',   'PANEL',      'VINYL',           6::real),
    ('Regular PVC Gate 6''H x 5''W, White',         'GATE_PANEL', 'VINYL',           6::real),
    -- ALUMINUM
    ('Aluminum Fence Panel 6''H x 6''W, Rackable, Black',  'PANEL',      'ALUMINUM', 6::real),
    ('Aluminum Fence Panel 6''H x 6''W, Rackable, White',  'PANEL',      'ALUMINUM', 6::real),
    ('Aluminum Fence Panel 6''H x 6''W, Rackable, Bronze', 'PANEL',      'ALUMINUM', 6::real),
    ('Aluminum Fence Panel 6''H x 8''W, Rackable, Black',  'PANEL',      'ALUMINUM', 6::real),
    ('Aluminum Walk Gate 6''H x 4''W, Black',              'GATE_PANEL', 'ALUMINUM', 6::real),
    -- ORNAMENTAL IRON: the pair that was being confused, and its neighbours
    ('Ornamental Steel Panel 4''H x 6''W, Black',   'PANEL',      'ORNAMENTAL_IRON', 4::real),
    ('Ornamental Steel Panel 4''H x 8''W, Black',   'PANEL',      'ORNAMENTAL_IRON', 4::real),
    ('Ornamental Steel Panel 6''H x 6''W, Black',   'PANEL',      'ORNAMENTAL_IRON', 6::real),
    ('Ornamental Steel Walk Gate 4''H x 4''W, Black', 'GATE_PANEL', 'ORNAMENTAL_IRON', 4::real)
  ) as v(name, role, fence_type, h)
 where m.name = v.name and m.role = v.role and m.fence_type = v.fence_type
   and m.height_ft is null and m.deleted_at is null;

commit;

-- ------------------------------------------------------------------------
-- PROOF  (SELECT only; run after applying, and read every row)
-- ------------------------------------------------------------------------
-- 1. The column is there, `real`, nullable.
select 'column' as proof, column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'material_items' and column_name = 'height_ft';

-- 2. The crew door: height_ft last, no unit_price, no supplier_sku, options unchanged.
select 'crew_door' as proof,
       (select array_agg(attname::text order by attnum) from pg_attribute
         where attrelid = 'public.material_items_crew'::regclass and attnum > 0 and not attisdropped) as columns,
       (select reloptions from pg_class where oid = 'public.material_items_crew'::regclass) as options;

-- 3. How many rows now say how tall they are, by company ordinal (no names). PART 3 writes
--    fifteen rows per company that holds the starting list and none anywhere else.
select 'heights_by_company' as proof,
       row_number() over (order by company_id)::int as company_ordinal,
       count(*) filter (where height_ft is not null) as rows_with_a_height,
       count(*) filter (where height_ft is null and role in ('PANEL', 'GATE_PANEL') and deleted_at is null) as panel_rows_still_unsaid
  from public.material_items
 group by company_id
having count(*) filter (where role in ('PANEL', 'GATE_PANEL')) > 0;

-- 4. RE-RUN CHECK: apply this file a second time and proof 3 must read exactly as it did after
--    the first. Only rows whose height_ft is NULL are ever written, so a height somebody typed
--    is never overwritten, and a second run writes nothing.
