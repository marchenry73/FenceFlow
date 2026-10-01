-- Add the two fence suppliers March is actually buying from.
--
-- ADDITIVE. Two INSERTs into public.manufacturers for ONE company, guarded so a
-- re-run inserts nothing. No UPDATE, no DELETE, nothing touched that exists.
--
-- Why this is written down rather than typed into the app: he asked for them to
-- be added from the two quote emails that came back on 1 October 2026, and the
-- details below are transcribed from those emails rather than invented. Anything
-- an email did not state is left NULL -- an empty phone number is honest, a
-- guessed one gets dialled.
--
--   Flori Fence        Aylin Toledo Soto, AToledo@florifence.com
--                      (no phone or address given in the reply)
--   Hartford Fence Supply
--                      Noelle Blomster, nblomster@hartfordfencesupply.com
--                      813-255-2933, direct 772-874-3325 ext 3325
--                      7001 Nundy Ave, Gibsonton, FL 33534
--
-- His company held ZERO suppliers before this, which is why the price-list
-- upload could not be used: that screen applies a list to one supplier at a
-- time and refuses when there is none to apply it to.
--
-- APPLIED: 2026-10-01.
--
-- NOTE: phone and address are NOT NULL on this table, so a supplier with no phone
-- stores an EMPTY STRING, not null. That is why the first attempt failed. Empty is
-- still honest -- it reads as blank in the app -- but it means a query looking for
-- 'suppliers with no phone' must test for '' and not for null.

begin;

-- The company, named twice so a copied ref cannot write into someone else's.
with target as (
  select id from public.companies
   where id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
     and name = 'Fence solutions'
)
insert into public.manufacturers (company_id, sync_id, name, email, phone, address, notes, updated_at)
select t.id, gen_random_uuid(), v.name, v.email, v.phone, v.address, v.notes, now()
  from target t
  cross join (values
    ('Flori Fence',
     'AToledo@florifence.com',
     ''::text,
     ''::text,
     'Contact: Aylin Toledo Soto. Quoted 6ft and 4ft white vinyl on 1 Oct 2026 (Estimate 17827 and 17828).'),
    ('Hartford Fence Supply',
     'nblomster@hartfordfencesupply.com',
     '813-255-2933',
     '7001 Nundy Ave, Gibsonton, FL 33534',
     'Contact: Noelle Blomster, direct 772-874-3325 ext 3325. Quoted 6ft and 4ft white vinyl on 1 Oct 2026 (Est 64792).')
  ) as v(name, email, phone, address, notes)
 where not exists (
   select 1 from public.manufacturers m
    where m.company_id = t.id
      and lower(m.name) = lower(v.name)
      and m.deleted_at is null
 );

-- Read back: exactly what now exists for this company.
select name, email, coalesce(phone, '(none given)') as phone,
       coalesce(address, '(none given)') as address
  from public.manufacturers
 where company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
   and deleted_at is null
 order by name;

commit;
