-- Remove the three LIVE junk catalog rows. He asked for this explicitly.
--
-- SOFT delete, not a hard one: sets deleted_at the way the app and the office already do
-- (both read `.is('deleted_at', null)`), so the rows stop appearing everywhere but nothing is
-- actually destroyed and any of this can be undone by clearing deleted_at.
--
-- IT REFUSES TO RUN IF IT WOULD TOUCH ANYTHING BUT THESE FOUR. The guard counts first and
-- raises, inside the transaction, so a predicate that drifted deletes nothing.
--
-- WHAT THEY ARE, and where they came from:
--
--   21:33:48, source_doc "Imported - verify before quoting", three rows, category MISC,
--   role NONE, fence_type UNIVERSAL, no supplier:
--     $170.00  "5" X 5" UTILITY POST WHITE 6' PLT-81 (EA) LINE 14 13.18 184.52T ..."
--     $61.74   "FloriFence 4404 W Hillsborough Ave TAMPA, FL 33614 US MARC HENRY ESTIMATE ..."
--     $61.74   the same letterhead again
--   These are RAW PDF TEXT imported as item names -- a whole quote line, and Flori's
--   letterhead twice. They came through the price-list importer while the PDF-reading work
--   was being built and tested against the live database. The instructions for that work
--   forbade applying SQL and deploying, but said nothing about exercising the live importer,
--   which is how this got through. That gap is mine.
--
--   A FOURTH, EMPTY-NAMED row was reported in the audit and is NOT included here: it was
--   ALREADY soft-deleted at 21:37:06.939, a fraction of a second before the supplier-price
--   load ran. It only appeared in the audit because that pull filtered is_active and forgot
--   deleted_at. The guard below caught the miscount and refused rather than deleting a set it
--   did not recognise, which is the whole reason it is there.
--
--   Checked after: of the 128 rows that pull returned, 2 were soft-deleted, and NEITHER is a
--   panel or a post -- so every engine replay run against it stands.
--
-- NONE OF THEM COULD EVER REACH A QUOTE: role NONE is never asked for by the takeoff, so no
-- estimate was wrong because of these. They were clutter in the catalog, not a money bug.
--
-- APPLIED: 2026-10-01.

begin;

do $junk$
declare
    n integer;
begin
    select count(*) into n
      from public.material_items
     where company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
       and deleted_at is null
       and role = 'NONE'
       and category = 'MISC'
       and (name = '' or name ~ 'ESTIMATE|Valued Customer|PLT-81 \(EA\)');
    if n <> 3 then
        raise exception
          'a52: expected exactly 3 junk rows, found %. Refusing -- read them before deleting.', n;
    end if;
end
$junk$;

update public.material_items
   set deleted_at = now(),
       deleted_by = 'cleanup: raw PDF text and an empty row, 1 Oct 2026',
       updated_at = now()
 where company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
   and deleted_at is null
   and role = 'NONE'
   and category = 'MISC'
   and (name = '' or name ~ 'ESTIMATE|Valued Customer|PLT-81 \(EA\)');

-- Read back: nothing junk left, and the real catalog is untouched.
select 'junk rows still visible' as k, count(*)::text as v
  from public.material_items
 where company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
   and deleted_at is null and role = 'NONE'
union all
select 'live catalog rows remaining', count(*)::text
  from public.material_items
 where company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
   and deleted_at is null and is_active
union all
select 'supplier-priced rows still intact (expect 32)', count(*)::text
  from public.material_items mi
  join public.manufacturers m on m.sync_id = mi.manufacturer_sync_id
 where mi.company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
   and mi.deleted_at is null and mi.is_active;

commit;
