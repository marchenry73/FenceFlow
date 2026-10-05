-- THE 4 FT VINYL CORNER POST. Dry-run against the live schema; see the end.
--
-- March, 4 October: "4ft vinyl corner post should be a 6ft post, not for a
-- 6ft high vinyl fence."
--
-- That reads oddly until you see the catalog. The 4 ft vinyl family is
-- "5x5x72 ... 4' Closed Top" -- 72 inches, so a SIX FOOT LONG post for a FOUR
-- FOOT fence, the extra two feet being what goes in the ground. The 6 ft-high
-- family is 5x5x102. So he is saying: a 4 ft fence's corner post is the 72"
-- post, and NOT the post used on a fence that is six feet high.
--
-- He is right, and the catalog is one row short of being able to say so:
--
--   role          height 4                                   height 6
--   LINE_POST     5x5x72 HFS Line Post ... $16.75            5 rows
--   END_POST      5x5x72 HFS End Post  ... $16.75            3 rows
--   GATE_POST     5x5x72 HFS Blank Post... $16.75            3 rows
--   CORNER_POST   -- NOTHING --                              1 row, $16.56
--
-- What that does today is subtler than a missing line. The height filter in
-- EstimateEngine narrows only IF something matches -- the same "narrow only if
-- it helps" shape as colour and manufacturer -- so a 4 ft vinyl corner does
-- not lose its post. It silently falls through to the only vinyl corner post
-- there is: the height-6 Co-Ex, an 8.5 ft post, at $16.56.
--
-- So every 4 ft vinyl corner has been quoted with the post for a six-foot
-- fence. The money is trivial (it is 19 cents CHEAPER than the right row); the
-- specification is not. It is the same failure the LINE_POST comment in
-- EstimateEngine already describes, running the other way: there it was a 4 ft
-- post on a 6 ft run with "nothing of it in the ground", here it is a post two
-- and a half feet longer than the job needs.
--
-- The fix is a catalog row, not code. The engine is behaving exactly as
-- designed; it simply has nothing correct to choose.

insert into public.material_items
    (sync_id, company_id, name, category, role, fence_type, height_ft,
     unit, unit_price, taxable, is_active, color_or_finish,
     manufacturer_sync_id, source_doc)
select
    gen_random_uuid(),          -- NOT NULL, and nothing defaults it. The first
                                -- draft of this file omitted it and failed on
                                -- the live schema; see the note at the end.
    mi.company_id,
    '5x5x72 HFS Corner Post White 4'' Closed Top',
    mi.category,                -- POST. The column default is MISC, which
                                -- would file a post under miscellaneous.
    'CORNER_POST',
    'VINYL',
    4,
    mi.unit,                    -- EA
    16.75,                      -- what all three of its siblings cost
    mi.taxable,
    true,
    mi.color_or_finish,         -- White
    mi.manufacturer_sync_id,    -- same maker as the rest of the 4 ft family
    -- NOT the sibling's 'Confirmed'. $16.75 is inferred from the three other
    -- posts in this family, and copying "Confirmed" onto it would state that
    -- a supplier gave us this number when none has. This exact wording is
    -- what isSeededUnverifiedPrice() matches, so the office flags the price
    -- as a placeholder until the supplier answers -- which is precisely what
    -- docs/SUPPLIER_PRICE_REQUEST asks them.
    'Placeholder — verify with your supplier'
from public.material_items mi
-- Copied from the END post of the SAME family, so company_id, maker, unit and
-- colour come from a row that really exists rather than being typed in here.
-- A company that does not stock the 4 ft family gets no row and nothing
-- changes for it.
where mi.name = '5x5x72 HFS End Post White 4'' Closed Top'
  and mi.role::text = 'END_POST'
  and mi.deleted_at is null
  and not exists (
      select 1 from public.material_items x
      where x.company_id = mi.company_id
        and x.role::text = 'CORNER_POST'
        and x.fence_type::text = 'VINYL'
        and x.height_ft = 4
        and x.deleted_at is null
  );

-- Read it back. A write is not done until it has been read back asserting the
-- new value -- not the statement's success, and not a row count.
--
--   select name, unit_price, height_ft, category, source_doc
--     from public.material_items
--    where role::text='CORNER_POST' and fence_type::text='VINYL'
--      and deleted_at is null
--    order by height_ft;
--
-- Expected after: two rows. height 4 at 16.75, category POST, source_doc
-- "Placeholder — verify with your supplier"; height 6 at 16.56 unchanged.

-- ---------------------------------------------------------------------------
-- WHAT THE DRY RUN FOUND
--
-- Run inside BEGIN ... ROLLBACK against the live schema before this file was
-- handed over, which is the only reason it works. The first draft:
--
--   * omitted sync_id, which is NOT NULL with no default -- it failed outright
--     with 23502 and would have done the same on his machine;
--   * let category default to MISC, filing a post under miscellaneous;
--   * omitted unit, taxable and manufacturer_sync_id, so the row would not
--     have matched its own family;
--   * would have copied the sibling's source_doc of "Confirmed" onto an
--     inferred price.
--
-- Re-run after fixing: inserts exactly one row, and running it a SECOND time
-- inserts nothing, because of the not-exists guard. Both verified, then rolled
-- back. Nothing in the catalog was changed by the test.
--
-- STILL NOT RUN FOR REAL, for one reason only: the NAME. The supplier's own
-- name for the part may differ from the pattern used here, and the name is
-- what shows on a materials list somebody carries to a counter. The price is
-- now self-declaring -- it goes in marked as a placeholder, and the office
-- will flag it until a supplier confirms it.
--
-- It can also just be added in the app: Catalog, new item, role Corner post,
-- type Vinyl, height 4, price 16.75 -- and type the supplier's real name as
-- you read it off the invoice. That is the same row by a safer road.
