-- ============================================================
-- FenceFlow -- Hartford Fence Supply TAN vinyl pricing, from Estimate 66420
-- (Noelle Blomster, 17 Nov 2026), into the Legacy Solutions catalog.
--
-- DATA, NOT SCHEMA. One company's catalog, so this is not in
-- supabase/dev/apply-order.txt; it is kept in the repo so what went in, and
-- from where, can be read back later.
--
-- Owner's instruction, 17 Nov 2026: "Take these information and input it in
-- the app, connect them all together." Confirmed row by row before writing.
--
-- WHY: the catalog already held TAN line posts ($17.25) and TAN 6x6 / 6x8
-- panels, but no tan end post, gate post, post cap or gate. The pricing
-- engine narrows a run's candidates to its colour and, when nothing matches,
-- KEEPS EVERY COLOUR -- so a tan fence silently billed its end posts, gate
-- posts, caps and gate at WHITE prices. These rows close that gap for HFS.
--
-- FROM THE QUOTE (Estimate 66420, "Tan Gate", valid 5 days):
--   33803-HFS-T-1.75  6' HFS 1.75 Rail Tan Privacy Walk Gate Kit, <=70"  159.99
--   30510-T-E-1.75    5x5x102 HFS End Post Tan 1.75 6' Privacy             21.25
--   HFS POST CAP      HFS 5x5 Pyramid Post Cap Tan (100/box)                1.75
--   51000-ECO-8       5"x5"x96" Econo Stiffener H-Frame                     54.79
--   Latch 26.75, hinge 37.45, handle 6.50 -- already exactly these prices; untouched.
--   4x tan 7/8x6x62 T&G pickets 6.99 -- LEFT OUT: the only picket role is
--   WOOD_PICKET and the vinyl takeoff never asks for loose pickets, so filing
--   them under a priced role would start adding pickets to vinyl jobs.
--
-- THE GATE POST IS THE END POST. Noelle quoted three END POST TAN for this
-- gate and no gate-post SKU. The owner: "the gate post and the end posts are
-- the same, except that post has the Econo Stiffener." The tan GATE_POST row
-- below is that same part at the same price, so tan gates price correctly on
-- phones before the engine change reaches them in an app release.
--
-- THE STIFFENER PRICE RISES $50.00 -> $54.79, on the existing HFS row. That
-- moves every vinyl gate priced from it, white included, by $4.79. Signed and
-- accepted jobs are anchored and do not move.
-- ============================================================

begin;

do $$
declare
    v_co uuid;
    v_hfs uuid := '548c69f4-d2eb-4320-b601-9cf4cbdb1d67';
    v_src text := 'HFS Estimate 66420 (Noelle Blomster, 2026-11-17)';
    n int;
begin
    select id into v_co from companies where name = 'Legacy Solutions';
    if v_co is null then raise exception 'tan: Legacy Solutions not found'; end if;

    -- Refuse to double up if this has already run.
    select count(*) into n from material_items
     where company_id = v_co and deleted_at is null
       and supplier_sku in ('30510-T-E-1.75','33803-HFS-T-1.75','HFS-CAP-PYR-5-TAN');
    if n > 0 then raise exception 'tan: % HFS tan row(s) already present -- not adding again', n; end if;

    insert into material_items
        (id, sync_id, company_id, name, category, role, fence_type, color_or_finish,
         unit, unit_price, taxable, covers_ft, manufacturer_sync_id, is_active,
         source_doc, supplier_sku, height_ft, updated_at, deleted_by)
    values
      (gen_random_uuid(), gen_random_uuid(), v_co,
       '5x5x102 HFS End Post Tan 1.75 6'' Privacy', 'POST', 'END_POST', 'VINYL', 'Tan',
       'EA', 21.25, true, null, v_hfs, true, v_src, '30510-T-E-1.75', 6, now(), ''),
      (gen_random_uuid(), gen_random_uuid(), v_co,
       '5x5x102 HFS End Post Tan 1.75 6'' Privacy (gate post)', 'POST', 'GATE_POST', 'VINYL', 'Tan',
       'EA', 21.25, true, null, v_hfs, true, v_src, '30510-T-E-1.75-GATE', 6, now(), ''),
      (gen_random_uuid(), gen_random_uuid(), v_co,
       'HFS 5x5 Pyramid Post Cap Tan (100/box)', 'CAP', 'POST_CAP', 'VINYL', 'Tan',
       'EA', 1.75, true, null, v_hfs, true, v_src, 'HFS-CAP-PYR-5-TAN', null, now(), ''),
      (gen_random_uuid(), gen_random_uuid(), v_co,
       '6'' HFS 1.75 Rail Tan Privacy Walk Gate Kit (up to 70")', 'GATE', 'GATE_PANEL', 'VINYL', 'Tan',
       'EA', 159.99, true, 5, v_hfs, true, v_src, '33803-HFS-T-1.75', 6, now(), '');

    update material_items
       set unit_price = 54.79, supplier_sku = '51000-ECO-8',
           source_doc = v_src, updated_at = now()
     where company_id = v_co and deleted_at is null
       and role = 'STIFFENER' and manufacturer_sync_id = v_hfs;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'tan: expected to update exactly 1 HFS stiffener, updated %', n; end if;

    -- Read it all back, rather than trusting the statements above.
    select count(*) into n from material_items
     where company_id = v_co and deleted_at is null and fence_type = 'VINYL'
       and color_or_finish = 'Tan' and source_doc = v_src;
    if n <> 4 then raise exception 'tan: expected 4 tan rows, found %', n; end if;

    if (select unit_price from material_items
         where company_id = v_co and deleted_at is null and role = 'STIFFENER'
           and manufacturer_sync_id = v_hfs) <> 54.79 then
        raise exception 'tan: the stiffener price did not land';
    end if;

    raise notice 'tan OK: 4 HFS tan rows added, stiffener now 54.79';
end $$;

commit;
