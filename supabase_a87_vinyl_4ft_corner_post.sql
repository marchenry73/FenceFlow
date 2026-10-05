-- THE 4 FT VINYL CORNER POST. Prepared, NOT run. See the bottom for why.
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
    (company_id, name, role, fence_type, height_ft, unit_price, color_or_finish)
select
    mi.company_id,
    '5x5x72 HFS Corner Post White 4'' Closed Top',
    'CORNER_POST',
    'VINYL',
    4,
    16.75,
    mi.color_or_finish
from public.material_items mi
-- Copied from the END post of the SAME family, so company_id and colour come
-- from a row that really exists rather than being typed in here. If a company
-- does not stock the 4 ft family, it gets no row and nothing changes for it.
where mi.name = '5x5x72 HFS End Post White 4'' Closed Top'
  and mi.role::text = 'END_POST'
  and not exists (
      select 1 from public.material_items x
      where x.company_id = mi.company_id
        and x.role::text = 'CORNER_POST'
        and x.fence_type::text = 'VINYL'
        and x.height_ft = 4
  );

-- Check it landed, and that nothing else moved:
--
--   select name, unit_price, height_ft from public.material_items
--   where role::text='CORNER_POST' and fence_type::text='VINYL'
--   order by height_ft;
--
-- Expected after: two rows, height 4 at 16.75 and height 6 at 16.56.

-- ---------------------------------------------------------------------------
-- WHY THIS IS NOT RUN
--
-- Two things in it are inferred rather than stated.
--
-- The PRICE. $16.75 is what all three of its siblings cost -- the End, Line
-- and Blank posts of the identical 5x5x72 family -- so it is a good inference,
-- and it is still an inference. This row feeds customer quotes.
--
-- The NAME. It follows the family's pattern, but the supplier's actual name for
-- the part may differ, and the name is what shows on a materials list somebody
-- takes to a counter.
--
-- Both are one line from March. Until then this sits here rather than in his
-- live catalog, and the engine goes on doing the defensible thing.
--
-- It can also just be added in the app: Catalog, new item, role Corner post,
-- type Vinyl, height 4, price 16.75. That is the same row by a safer road, and
-- it is probably the better one -- he can type the supplier's real name as he
-- reads it off the invoice.
