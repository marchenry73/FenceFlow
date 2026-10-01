-- Give every vinyl POST the fence height it is for.
--
-- ADDITIVE: sets height_ft where it is NULL. No INSERT, no DELETE, no schema change.
--
-- WHY, and this one is not a pricing error. Found by running the real engine against his real
-- catalog for a 72 ft, 6 ft-high vinyl run:
--
--     LINE_POST  10  $13.18  "5""x5"" Utility Post White 6' (Flori, 4ft run)"
--
-- That is the post Flori quotes for a FOUR FOOT fence. It is SIX FEET LONG. On a six foot
-- fence that leaves nothing in the ground. The right post for his 6 ft fence is Flori's
-- 8.5 ft Co-Ex at $16.56, or Hartford's 5x5x102 (102 inches = 8.5 ft) at $19.00.
--
-- The engine chose it because posts are picked by nearest width then CHEAPEST, and the
-- height-aware narrowing shipped this afternoon covers PANEL and GATE_PANEL ONLY. Posts were
-- left out. It became reachable the moment both suppliers' posts were loaded today: before
-- that he held one post per role and there was nothing to choose wrongly between.
--
-- SETTING THESE HEIGHTS IS HALF THE FIX AND DOES NOTHING ON ITS OWN. The engines must also
-- read height for post roles. That is a code change on both sides, a PRICING_ENGINE_VERSION
-- bump and regenerated fixtures. Until it lands, this file only records the truth; it changes
-- no quote.
--
-- height_ft on a POST means THE FENCE HEIGHT THE POST IS FOR, not the post's own length. That
-- is the only reading that lets one comparison serve panels and posts alike: the run says
-- "I am 6 ft", and every row that says 6 is a candidate. The post's physical length is a
-- property of the product and lives in its name, where no engine reads it.
--
-- Lengths, from the suppliers' own PDFs:
--   Flori  8.5 ft Co-Ex  -> 6 ft fence      Flori  6 ft utility   -> 4 ft fence
--   HFS    5x5x102 (8.5 ft) -> 6 ft fence   HFS    5x5x72 (6 ft)  -> 4 ft fence
-- The seeded Co-Ex posts ship with the 6 ft privacy panels, so they are 6 ft fence posts.
--
-- APPLIED: 2026-10-01.

begin;

update public.material_items m
   set height_ft = v.h, updated_at = now()
  from (values
    -- Flori, 8.5 ft posts -> a 6 ft fence
    ('5"x5" Co-Ex Utility Post White 8.5'' (Flori)',           6::real),
    ('5"x5" Co-Ex Utility Post White 8.5'' - End (Flori)',     6::real),
    ('5"x5" Co-Ex Utility Post White 8.5'' - Blank (Flori)',   6::real),
    -- Flori, 6 ft post -> a 4 ft fence
    ('5"x5" Utility Post White 6'' (Flori, 4ft run)',          4::real),
    -- Hartford, 102 inch (8.5 ft) -> a 6 ft fence
    ('5x5x102 HFS Line Post White 1.75 6'' Privacy',           6::real),
    ('5x5x102 HFS End Post White 1.75 6'' Privacy',            6::real),
    ('5x5x102 HFS Blank Post White 6'' Privacy',               6::real),
    -- Hartford, 72 inch (6 ft) -> a 4 ft fence
    ('5x5x72 HFS Line Post White 4'' Closed Top',              4::real),
    ('5x5x72 HFS End Post White 4'' Closed Top',               4::real),
    ('5x5x72 HFS Blank Post White 4'' Closed Top',             4::real),
    -- The seeded Co-Ex posts ship beside the 6 ft privacy panels
    ('5"x5" Co-Ex Line Post, White',                           6::real),
    ('5"x5" Co-Ex Line Post, Gray',                            6::real),
    ('5"x5" Co-Ex Line Post, Tan',                             6::real),
    ('5"x5" Co-Ex End Post, White',                            6::real),
    ('5"x5" Co-Ex Gate Post, White',                           6::real),
    ('5"x5" Co-Ex Corner Post, White',                         6::real)
  ) as v(name, h)
 where m.company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
   and m.name = v.name
   and m.role in ('LINE_POST', 'END_POST', 'CORNER_POST', 'GATE_POST')
   and m.height_ft is null;

-- Read back every vinyl post, so a missed one is visible rather than assumed.
select mi.role, mi.unit_price,
       coalesce(mi.height_ft::text, 'STILL NULL') as for_fence_height,
       mi.name
  from public.material_items mi
 where mi.company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
   and mi.is_active and mi.fence_type = 'VINYL'
   and mi.role in ('LINE_POST', 'END_POST', 'CORNER_POST', 'GATE_POST')
 order by mi.role, mi.unit_price;

commit;
