-- =============================================================================
-- Retire the three catalog rows superseded by Flori's own newer prices.
-- AUTHORISED BY MARCH, 2 Oct 2026: "Retire the three stale rows and build it".
-- =============================================================================
--
-- WHY THESE THREE AND NOT THE OTHER ELEVEN
--
-- 14 rows carry the label "FloriFence Invoice 36499 / Estimate 17407 (real
-- prices)" and none of them names a supplier (manufacturer_sync_id is null on
-- all 14). A first pass that simply asked "does this row undercut another row"
-- returned ELEVEN, and retiring those would have done real harm: his old line
-- post at $16.56 only undercuts HARTFORD's $19.00, and Flori's own current line
-- post is ALSO $16.56. Retiring it would push every line post to $19.00 and
-- raise his quotes for no reason.
--
-- The honest test is whether the next-cheapest row is the SAME PRODUCT FROM THE
-- SAME SUPPLIER at a newer, higher price. Exactly three pass it:
--
--   PANEL     6d84ff0d  $52.35  "Panel T&G Vinyl Privacy 6'H x 6'W - White"
--             -> d97fe436  $54.15  "Panel T&G White PVC 6'H x 6'W (Flori)"   [Flori Fence]
--   POST_CAP  06014b70  $0.74   "5\" External Pyramid PVC Post Cap, White"
--             -> c8710e77  $0.78   "...Post Cap White (Flori)"               [Flori Fence]
--   BRACE     bf863e5b  $6.50   "Gate Support Brace, 8'"
--             -> fdbaf081  $6.90   "Gate Support Brace White 8' (Flori)"     [Flori Fence]
--
-- Measured effect, by pricing all eight of his real jobs through the real engine
-- twice: materials understated by $1,146.84, quotes by $1,266.27. Markup is 0%
-- on seven of the eight, so it was coming straight off his margin.
--
-- REVERSIBLE. This sets is_active = false. It deletes nothing. To undo, set the
-- three ids back to true.
--
-- REFUSES rather than guesses. If any of the three is missing, already inactive,
-- at a different price, or has lost its dearer Flori twin, nothing is written.
-- =============================================================================

begin;

do $guard$
declare
  n_target int;
  n_twin   int;
  n_other  int;
begin
  -- The three, still active, still at the prices this file was written against.
  select count(*) into n_target
    from public.material_items
   where id in ('6d84ff0d-43ec-4790-bf41-e84e0ca719f0',
                '06014b70-44bd-4e12-ac0d-240a7b7239a3',
                'bf863e5b-5d5d-4ec9-b46e-a730ba1e63ba')
     and company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
     and deleted_at is null
     and is_active is true
     and source_doc = 'FloriFence Invoice 36499 / Estimate 17407 (real prices)'
     and ((role = 'PANEL'    and abs(unit_price - 52.35) < 0.005)
       or (role = 'POST_CAP' and abs(unit_price -  0.74) < 0.005)
       or (role = 'BRACE'    and abs(unit_price -  6.50) < 0.005));

  if n_target <> 3 then
    raise exception
      'REFUSING: expected 3 target rows still active at their measured prices, found %. The catalog has changed since 2 Oct 2026 - re-measure before retiring anything.',
      n_target;
  end if;

  -- Each must still have a DEARER twin attributed to Flori Fence, or retiring it
  -- would leave the engine reaching for someone else's price.
  select count(*) into n_twin
    from public.material_items s
   where s.id in ('6d84ff0d-43ec-4790-bf41-e84e0ca719f0',
                  '06014b70-44bd-4e12-ac0d-240a7b7239a3',
                  'bf863e5b-5d5d-4ec9-b46e-a730ba1e63ba')
     and exists (
       select 1
         from public.material_items t
         join public.manufacturers mf on mf.sync_id = t.manufacturer_sync_id
        where t.company_id = s.company_id
          and t.deleted_at is null
          and t.is_active is true
          and t.role = s.role
          and t.id <> s.id
          and mf.name = 'Flori Fence'
          and t.unit_price > s.unit_price);

  if n_twin <> 3 then
    raise exception
      'REFUSING: only % of the 3 still have a dearer Flori-attributed twin. Retiring one without a replacement would make the engine reach for another supplier.',
      n_twin;
  end if;

  -- Nothing else in the catalog is being touched: the UPDATE names three ids.
  select count(*) into n_other
    from public.material_items
   where company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
     and deleted_at is null and is_active is true;

  raise notice 'Guard passed: 3 targets, 3 Flori twins, % active rows in the catalog before this change.', n_other;
end
$guard$;

select 'BEFORE' as stage, id, role, name,
       to_char(unit_price, 'FM999990.00') as price, is_active, source_doc
  from public.material_items
 where id in ('6d84ff0d-43ec-4790-bf41-e84e0ca719f0',
              '06014b70-44bd-4e12-ac0d-240a7b7239a3',
              'bf863e5b-5d5d-4ec9-b46e-a730ba1e63ba')
 order by role;

update public.material_items
   set is_active = false,
       updated_at = now()
 where id in ('6d84ff0d-43ec-4790-bf41-e84e0ca719f0',
              '06014b70-44bd-4e12-ac0d-240a7b7239a3',
              'bf863e5b-5d5d-4ec9-b46e-a730ba1e63ba')
   and company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
   and deleted_at is null
   and is_active is true;

select 'AFTER' as stage, id, role, name,
       to_char(unit_price, 'FM999990.00') as price, is_active
  from public.material_items
 where id in ('6d84ff0d-43ec-4790-bf41-e84e0ca719f0',
              '06014b70-44bd-4e12-ac0d-240a7b7239a3',
              'bf863e5b-5d5d-4ec9-b46e-a730ba1e63ba')
 order by role;

commit;
