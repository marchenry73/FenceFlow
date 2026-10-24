-- ============================================================
-- FenceFlow -- a third of every product key read out loud contains O, I, 0, 1 or L
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- NOT APPLIED. Written 2026-10-24 while answering owner-list item E2. Nothing
-- below has been run against the live database.
--
-- KIND
--   FUNCTION REPLACEMENT, in place. CREATE OR REPLACE, because the OUT columns
--   do not change -- it still returns TABLE(company_id uuid, setup_code text),
--   which is what website/admin.html reads as row.company_id / row.setup_code.
--   The ACL is restated underneath anyway: a plain CREATE resets a function's
--   grants to the default and that is how anon has picked up EXECUTE on a
--   function here before. The live grants, read 2026-10-24, are
--   authenticated/postgres/service_role EXECUTE and NOT anon; that is what is
--   restated, unchanged.
--
--   No table is altered, no policy is touched, no row is written, nothing is
--   dropped. Exactly one expression is reordered.
--
-- THE DEFECT
--   admin_create_company generates the one-time code the admin portal reads out
--   to a new customer. Its own comment says:
--
--       -- Readable over the phone: no look-alike characters, grouped in fours.
--       -- Somebody is going to read this out loud to a contractor in a truck.
--
--   The comment is false. The live expression is
--
--       upper( substr(translate(encode(gen_random_bytes(9),'base64'),
--                               '+/=OI01l','XYZABCDEF'), 1, 4) || '-' || ... )
--
--   -- translate FIRST, upper AFTER. base64 output is mixed case, so the
--   lowercase o, i and L that translate is not asked about survive it, and then
--   upper() turns them into O, I and L. The characters the function exists to
--   remove are put back by its own last step.
--
--   MEASURED against the live database on 2026-10-24, read-only, 4,000 codes
--   generated in memory with the live expression and nothing written:
--
--       codes generated (positive control, must be 4000) ......... 4000
--       LIVE generator: codes containing O, I, 0, 1 or L ......... 1291
--       CORRECTED order: codes containing O, I, 0, 1 or L ........    0
--       CANARY the regex can match at all (codes with any A-Z) ... 4000
--       examples ... EJYQ-LEWG, ISVY-AQN9, OW9D-J449, TTI4-YP2W, 66O7-M6B7
--
--   32% of codes. The canary matters: a regex that matched nothing would have
--   reported zero for both orders and passed this off as already fixed.
--
-- THIS LESSON WAS ALREADY LEARNED HERE, ONE FUNCTION OVER
--   supabase_r8_device_keys.sql's header records exactly this bug in
--   mint_device_key -- "the code generator originally stripped O/0/I/1/L and
--   THEN uppercased, so base64's lowercase o and i came back as O and I in
--   roughly one code in three" -- fixed there the same day and proved against
--   4,000 codes. admin_create_company was never revisited. mint_device_key is
--   correct live today; this is the same mistake in the other generator.
--
-- WHY IT IS WORTH A FILE
--   This code is spoken, not pasted: the admin reads it down the phone to
--   somebody in a van, and claim_company_setup is the only way that person ever
--   becomes the owner of their company. The admin dialog shows the code once and
--   never again, and there is no function that can mint a replacement (checked
--   live: only admin_create_company writes to company_setup_codes, and only at
--   creation). So a code misheard as O-for-0 is an onboarding that stops, with a
--   support call and no self-service way out.
--
-- WHAT IS NOT CHANGED
--   Existing codes. Codes already in company_setup_codes are matched by
--   claim_company_setup with upper(trim(...)) against the stored text, so the
--   one unused code live today (company "Marco") keeps working exactly as it is.
--   This only changes what the NEXT code looks like.
--
-- TO UNDO
--   Re-run with translate and upper the other way round. Nothing else differs.
-- ============================================================

-- ------------------------------------------------------------------------
-- PART 1  the function, from its own live definition
--
-- pg_get_functiondef read 2026-10-24. Everything below is that text verbatim
-- except the two code-generating substr() expressions, which now uppercase
-- BEFORE they translate -- and translate is asked about upper-case L as well,
-- because after upper() that is the only form a lowercase l can arrive in.
-- ------------------------------------------------------------------------

create or replace function public.admin_create_company(company_name text, contact_email text default null::text)
 returns table(company_id uuid, setup_code text)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    new_id uuid;
    code text;
begin
    if not is_platform_admin() then
        raise exception 'Only a FenceFlow admin may create a company.';
    end if;
    if coalesce(trim(company_name), '') = '' then
        raise exception 'A company needs a name.';
    end if;

    -- '' rather than NULL. That is what the column defaults to, and it does
    -- not accept NULL. Unchanged.
    insert into companies (name, email, subscription_status, suspended)
    values (trim(company_name), trim(coalesce(contact_email, '')), 'pending', false)
    returning id into new_id;

    -- Readable over the phone: no look-alike characters, grouped in fours.
    -- Somebody is going to read this out loud to a contractor in a truck.
    --
    -- UPPER FIRST, THEN TRANSLATE. The other way round -- which is how this
    -- was written, and how mint_device_key was written before
    -- supabase_r8_device_keys.sql fixed it -- lets base64's lowercase o, i and
    -- l slip past translate and come back as O, I and L from upper(). Measured:
    -- 1,291 of 4,000 codes. The translate set below therefore lists upper-case
    -- L, not lowercase l, because by this point that is the only form it has.
    --
    -- gen_random_bytes is schema-qualified: pgcrypto lives in `extensions` on
    -- this project and this function pins search_path to public, so the bare
    -- name does not resolve from in here. See supabase_r39_product_key_schema_qualify.sql.
    code := substr(translate(upper(encode(extensions.gen_random_bytes(9), 'base64')), '+/=OI01L', 'XYZABCDEF'), 1, 4)
            || '-' ||
            substr(translate(upper(encode(extensions.gen_random_bytes(9), 'base64')), '+/=OI01L', 'XYZABCDEF'), 1, 4);

    insert into company_setup_codes (code, company_id) values (code, new_id);

    return query select new_id, code;
end;
$function$;

-- The live ACL, restated because a CREATE resets it. anon is explicitly not here.
revoke execute on function public.admin_create_company(text, text) from public, anon;
grant  execute on function public.admin_create_company(text, text) to authenticated;


-- ------------------------------------------------------------------------
-- PART 2  prove it, one row each
--
-- READ THIS FIRST. The SQL editor runs as postgres, so auth.uid() is null, so
-- is_platform_admin() is false, so CALLING admin_create_company here raises
-- 'Only a FenceFlow admin may create a company.' -- on a perfect install and a
-- broken one alike. So nothing below calls it. Every check is about the SHAPE
-- of the function, or about the generator EXPRESSION run directly, which writes
-- nothing. No row is created by this part.
--
-- Run PART 2 on its own BEFORE PART 1 to see it fail: rows 1 and 2 read false
-- against the unchanged function, and row 4 reads a number in the hundreds.
-- ------------------------------------------------------------------------

with body as (
    select p.prosrc, p.prosecdef, p.proconfig
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname = 'admin_create_company'
),
gen as (
    -- The generator as PART 1 writes it, 4,000 times, in memory.
    select substr(translate(upper(encode(extensions.gen_random_bytes(9),'base64')),'+/=OI01L','XYZABCDEF'),1,4)
           || '-' ||
           substr(translate(upper(encode(extensions.gen_random_bytes(9),'base64')),'+/=OI01L','XYZABCDEF'),1,4)
             as code
      from generate_series(1, 4000)
)
select 'the generator uppercases before it translates' as check,
       (select prosrc from body) like '%translate(upper(%' as ok
union all
select 'the old order is gone',
       (select prosrc from body) not like '%upper(%substr(translate(encode%'
union all
-- CANARY for both body checks. Both are "is this text in prosrc", and a prosrc
-- that came back null -- wrong name, wrong schema -- makes LIKE read null and
-- NOT LIKE read null too, and null is not false. Prove the same test finds
-- something that has always been in this body.
select 'CANARY: the body test can find text that is there',
       (select prosrc from body) like '%company_setup_codes%'
union all
select 'no generated code contains O, I, 0, 1 or L (4,000 tried)',
       (select count(*) from gen where code ~ '[OI01L]') = 0
union all
-- CANARY for the row above: a generator that returned the empty string, or a
-- regex that matched nothing, would also report zero look-alikes.
select 'CANARY: 4,000 codes were really generated and they contain letters',
       (select count(*) from gen) = 4000
   and (select count(*) from gen where code ~ '[A-Z]') = 4000
union all
select 'gen_random_bytes is still schema-qualified',
       (select prosrc from body) like '%extensions.gen_random_bytes%'
union all
select 'the platform-admin gate is still the first thing in the body',
       (select prosrc from body) like '%if not is_platform_admin() then%'
union all
-- A real guard, not a canary: the one way this could start answering a caller
-- who is not an admin is an "if nobody is signed in, allow it" hatch, and
-- auth.uid() is null for an anonymous visitor exactly as it is for the service
-- role. That shape must never appear here.
select 'CANARY: no signed-out escape hatch was added',
       (select prosrc from body) not like '%auth.uid() is null%'
   and (select prosrc from body) not like '%service_role%'
union all
select 'it is still SECURITY DEFINER with a pinned search_path',
       (select prosecdef from body)
   and (select coalesce(array_to_string(proconfig, ','), '') from body) like '%search_path=public%'
union all
select 'it still returns company_id and setup_code, in that order',
       (select pg_get_function_result(p.oid) from pg_proc p
         where p.pronamespace='public'::regnamespace and p.proname='admin_create_company')
         = 'TABLE(company_id uuid, setup_code text)'
union all
select 'authenticated can execute it',
       has_function_privilege('authenticated', 'public.admin_create_company(text, text)', 'EXECUTE')
union all
select 'CANARY: anon cannot execute it',
       not has_function_privilege('anon', 'public.admin_create_company(text, text)', 'EXECUTE')
union all
-- CANARY for the row above. has_function_privilege answers true for a superuser
-- on anything and the anon check is a NOT, so a test that could only ever say
-- "anon has nothing" would pass while proving nothing. is_platform_admin is
-- deliberately executable by anon (it answers false, and policies call it), so
-- asking about it proves this test can still say true about anon.
select 'CANARY: the execute test can answer true for anon somewhere',
       has_function_privilege('anon', 'public.is_platform_admin()', 'EXECUTE')
union all
select 'the one unused code live today still matches how claim reads it',
       not exists (select 1 from public.company_setup_codes
                    where used_at is null and code <> upper(trim(code)))
union all
-- CANARY for the row above: it is a NOT EXISTS, so it reads true when there are
-- no unused codes at all, which says nothing. Prove there is one to be wrong about.
select 'CANARY: there is at least one unused setup code to have checked',
       exists (select 1 from public.company_setup_codes where used_at is null);
