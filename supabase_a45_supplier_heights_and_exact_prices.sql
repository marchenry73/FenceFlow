-- Give the supplier panel and gate rows their heights, and correct two prices I rounded.
--
-- ADDITIVE in effect: it sets height_ft where it is NULL, and corrects two unit_price
-- figures to the exact numbers on the supplier's own PDF. No INSERT, no DELETE, no schema
-- change. One transaction.
--
-- WHY, measured rather than assumed. The real engine (2026.10.2) was run against his real
-- 124-row live catalog, for a 4 ft and a 6 ft white vinyl run. Both came back:
--
--     $52.35  x17  "Panel T&G Vinyl Privacy 6'H x 6'W - White"
--
-- So a 4 FT RUN IS PRICED WITH A 6 FT PRIVACY PANEL, and at the cheapest one in the
-- catalog. That is a bigger undercharge than the one reported: the real 4 ft panel is
-- $61.74 (Flori) or $71.50 (Hartford), so the quote is short by $9.39 to $19.15 PER PANEL --
-- about $319 to $651 on a 34-panel job.
--
-- The height-aware rule is working exactly as written; it simply has nothing to work with.
-- It sets a candidate aside only when ANOTHER candidate OF ITS OWN WIDTH declares the run's
-- height. The 15 seeded rows declare 6. The 32 supplier rows declare nothing. So for a 4 ft
-- run NOTHING declares 4, nothing is set aside, and cheapest-of-width-6 wins. Filling these
-- eight heights in is what switches the rule on for 4 ft.
--
-- TWO PRICES I GOT WRONG, found by re-reading the PDFs line by line rather than trusting the
-- load. Hartford quotes unit prices to five decimal places (they are derived from a pallet
-- price) and I rounded both:
--     6x6 HFS Pro Series Privacy Panel White      stored 55.00   PDF says 54.99875
--     5x5x102 HFS Line Post White 1.75 6' Privacy stored 19.00   PDF says 18.99929
-- Each is about a tenth of a cent, and on a 34-panel job it is four cents. It is corrected
-- anyway, because a catalog figure that does not match the supplier's invoice is a figure
-- somebody will one day have to reconcile, and "close enough" is not a thing a price is.
-- Verified unchanged against the PDF: every other figure on both estimates.
--
-- The 4 ft products are NOT cheaper versions of the 6 ft ones and the prices are not errors:
-- neither supplier sells a 4 ft PRIVACY panel. Flori's 4 ft is a Melrose flat-top 2-rail,
-- Hartford's is a Clearwater closed-top picket. Both are semi-privacy styles and both cost
-- MORE than the 6 ft solid panel.
--
-- APPLIED: 2026-10-01.

begin;

-- 1. Heights on the eight supplier panel and gate rows. Exact names, only where NULL,
--    so a height anybody typed later is never overwritten and a re-run changes nothing.
update public.material_items m
   set height_ft = v.h, updated_at = now()
  from (values
    ('Panel T&G White PVC 6''H x 6''W (Flori)',                        6::real),
    ('Panel Melrose Flat Top 2-Rail 4''H x 6''W White (Flori)',         4::real),
    ('Regular White PVC Gate 6''H x 5''W (Flori)',                      6::real),
    ('Gate Melrose Flat Top 4''H x 5''W White (Flori)',                 4::real),
    ('6x6 HFS Pro Series Privacy Panel White',                          6::real),
    ('4x6 HFS Clearwater Closed Top Picket Panel White',                4::real),
    ('6'' HFS 1.75 Rail White Privacy Walk Gate Kit',                   6::real),
    ('Clearwater 4''H x 5''W Closed Top Gate White',                    4::real)
  ) as v(name, h)
 where m.company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
   and m.name = v.name
   and m.role in ('PANEL', 'GATE_PANEL')
   and m.height_ft is null;

-- 2. The two prices, to the figure on Hartford's own estimate.
update public.material_items
   set unit_price = 54.99875, updated_at = now()
 where company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
   and name = '6x6 HFS Pro Series Privacy Panel White'
   and unit_price = 55.00;

update public.material_items
   set unit_price = 18.99929, updated_at = now()
 where company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
   and name = '5x5x102 HFS Line Post White 1.75 6'' Privacy'
   and unit_price = 19.00;

-- Read back: every panel and gate, so a missed height is visible rather than assumed.
select mi.role, mi.unit_price, mi.covers_ft as width,
       coalesce(mi.height_ft::text, 'STILL NULL') as height,
       coalesce(m.name, '(seed)') as supplier, mi.name
  from public.material_items mi
  left join public.manufacturers m on m.sync_id = mi.manufacturer_sync_id
 where mi.company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
   and mi.is_active and mi.fence_type = 'VINYL'
   and mi.role in ('PANEL', 'GATE_PANEL')
 order by mi.role, mi.unit_price;

commit;
