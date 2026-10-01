-- Real supplier prices from the two 1 October 2026 quotes, tied to each supplier.
--
-- ADDITIVE. INSERTs into public.material_items for ONE company, each guarded so a
-- re-run inserts nothing. No UPDATE, no DELETE. His existing 92 rows are NOT
-- touched -- these sit beside them, carrying the supplier they came from.
--
-- SOURCE, so every figure can be traced back:
--   Flori Fence     Estimate 17827 (6 ft) and 17828 (4 ft), dated 09/30/2026
--   Hartford        Estimate 64792 (6 ft and 4 ft), dated 10/01/2026
-- Both PDFs are read in SUPPLIER_QUOTES_2026-10-01.md. Nothing here is estimated.
--
-- WHY THE 4 FT PANELS COST MORE THAN THE 6 FT ONES, since it looks like a typo:
-- neither supplier sells a "4 ft privacy panel". At 4 ft the product becomes a
-- semi-privacy or picket style -- Flori's Melrose flat top 2-rail, Hartford's
-- Clearwater closed top. A decorative panel costs more to make than a plain solid
-- one. The price genuinely goes UP as the fence gets shorter.
--
-- sourceDoc is "Confirmed": these are real quoted figures from a named supplier
-- on a dated estimate, not market-rate guesses, so they must NOT trip the
-- unverified-price warning. Compare SEEDED, which does.
--
-- NOT APPLIED YET -- read it, then run it.

begin;

with target as (
  select id from public.companies
   where id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
     and name = 'Fence solutions'
),
sup as (
  select m.id, m.sync_id, m.name
    from public.manufacturers m, target t
   where m.company_id = t.id and m.deleted_at is null
)
insert into public.material_items
  (company_id, sync_id, category, role, fence_type, name, unit, unit_price,
   taxable, covers_ft, color_or_finish, manufacturer_sync_id, is_active, source_doc, updated_at, deleted_by)
select t.id, gen_random_uuid(), v.category, v.role, 'VINYL', v.name, 'EA', v.price,
       true, v.covers, 'White', s.sync_id, true, 'Confirmed', now(), ''
  from target t
  cross join (values
    -- ---------- Flori Fence, 6 ft (Estimate 17827) ----------
    ('Flori Fence', 'PANEL', 'PANEL',       'Panel T&G White PVC 6''H x 6''W (Flori)',                54.15, 6::real),
    ('Flori Fence', 'POST',  'LINE_POST',   '5"x5" Co-Ex Utility Post White 8.5'' (Flori)',           16.56, null),
    ('Flori Fence', 'POST',  'END_POST',    '5"x5" Co-Ex Utility Post White 8.5'' - End (Flori)',     16.56, null),
    ('Flori Fence', 'POST',  'GATE_POST',   '5"x5" Co-Ex Utility Post White 8.5'' - Blank (Flori)',   16.56, null),
    ('Flori Fence', 'CAP',   'POST_CAP',    '5" External Pyramid PVC Post Cap White (Flori)',          0.78, null),
    ('Flori Fence', 'GATE',  'GATE_PANEL',  'Regular White PVC Gate 6''H x 5''W (Flori)',            120.66, 5::real),
    ('Flori Fence', 'HARDWARE', 'STIFFENER','5" Econo Stiffener x 8''H (Flori)',                      52.75, null),
    ('Flori Fence', 'HARDWARE', 'BRACE',    'Gate Support Brace White 8'' (Flori)',                    6.90, null),
    ('Flori Fence', 'TRIM',     'TRIM',     '7/8 x 1-1/2 x 62-1/4 Trim U-Channel White (Flori)',       2.00, null),
    ('Flori Fence', 'HARDWARE', 'HINGE_SET','SS Self-Closing Hinge, 12 pairs per box (Flori)',        32.25, null),
    ('Flori Fence', 'HARDWARE', 'LATCH',    'SS Two-Way Latch White, 20 per box (Flori)',             25.87, null),
    ('Flori Fence', 'HARDWARE', 'HANDLE',   '7" SS Gate Handle White, 50 per box (Flori)',             5.00, null),
    -- ---------- Flori Fence, 4 ft (Estimate 17828) ----------
    ('Flori Fence', 'PANEL', 'PANEL',       'Panel Melrose Flat Top 2-Rail 4''H x 6''W White (Flori)', 61.74, 6::real),
    ('Flori Fence', 'POST',  'LINE_POST',   '5"x5" Utility Post White 6'' (Flori, 4ft run)',          13.18, null),
    ('Flori Fence', 'GATE',  'GATE_PANEL',  'Gate Melrose Flat Top 4''H x 5''W White (Flori)',       170.00, 5::real),
    -- ---------- Hartford Fence Supply, 6 ft (Estimate 64792) ----------
    ('Hartford Fence Supply', 'PANEL', 'PANEL',     '6x6 HFS Pro Series Privacy Panel White',          55.00, 6::real),
    ('Hartford Fence Supply', 'POST',  'LINE_POST', '5x5x102 HFS Line Post White 1.75 6'' Privacy',    19.00, null),
    ('Hartford Fence Supply', 'POST',  'END_POST',  '5x5x102 HFS End Post White 1.75 6'' Privacy',     19.00, null),
    ('Hartford Fence Supply', 'POST',  'GATE_POST', '5x5x102 HFS Blank Post White 6'' Privacy',        19.00, null),
    ('Hartford Fence Supply', 'CAP',   'POST_CAP',  'HFS 5x5 Pyramid Post Cap White (100/box)',         1.65, null),
    ('Hartford Fence Supply', 'GATE',  'GATE_PANEL','6'' HFS 1.75 Rail White Privacy Walk Gate Kit',  149.99, 5::real),
    ('Hartford Fence Supply', 'HARDWARE', 'STIFFENER','5"x5"x96" Econo Stiffener H-Frame (HFS)',         50.00, null),
    ('Hartford Fence Supply', 'TRIM',     'TRIM',     'HFS 59" U-Channel White',                          2.99, null),
    ('Hartford Fence Supply', 'HARDWARE', 'LATCH',  'HFS SS Post Latch Black, 24 per box',             26.75, null),
    ('Hartford Fence Supply', 'HARDWARE', 'HINGE_SET','HFS SS Self-Closing Hinge Black, 18 per box',   37.45, null),
    ('Hartford Fence Supply', 'HARDWARE', 'HANDLE',   'HFS Nylon Gate Handle, 200 per box',               6.50, null),
    -- ---------- Hartford Fence Supply, 4 ft ----------
    ('Hartford Fence Supply', 'PANEL', 'PANEL',     '4x6 HFS Clearwater Closed Top Picket Panel White', 71.50, 6::real),
    ('Hartford Fence Supply', 'POST',  'LINE_POST', '5x5x72 HFS Line Post White 4'' Closed Top',       16.75, null),
    ('Hartford Fence Supply', 'POST',  'END_POST',  '5x5x72 HFS End Post White 4'' Closed Top',        16.75, null),
    ('Hartford Fence Supply', 'POST',  'GATE_POST', '5x5x72 HFS Blank Post White 4'' Closed Top',      16.75, null),
    ('Hartford Fence Supply', 'GATE',  'GATE_PANEL','Clearwater 4''H x 5''W Closed Top Gate White',   113.75, 5::real),
    ('Hartford Fence Supply', 'HARDWARE', 'BRACE',    'V-Brace White Bevelled Gate Brace 8'' (HFS)',     19.99, null)
  ) as v(supplier, category, role, name, price, covers)
  join sup s on s.name = v.supplier
 where not exists (
   select 1 from public.material_items mi
    where mi.company_id = t.id and mi.name = v.name and mi.is_active
 );

select m.name as supplier, count(*) as rows_added, min(mi.unit_price) as cheapest, max(mi.unit_price) as dearest
  from public.material_items mi
  join public.manufacturers m on m.sync_id = mi.manufacturer_sync_id
 where mi.company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4' and mi.is_active
 group by m.name order by m.name;

commit;
