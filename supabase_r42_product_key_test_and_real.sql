-- ============================================================
-- FenceFlow -- owner-list item E2: a TEST product key and a REAL one
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- NOT APPLIED. Written 2026-10-24. Nothing below has been run against the live
-- database. PART 3 is the proof, and it is written so that running it BEFORE
-- PART 1/PART 2 fails -- which is the only way to know it can.
--
-- WHAT HE ASKED FOR
--   "A TEST product key that unlocks the test data, and a REAL one -- a sandbox
--    and the live app -- both controlled from the admin portal."
--
-- WHAT A KEY IS, ALREADY, LIVE
--   Read off the live database on 2026-10-24, not assumed:
--
--   There are TWO different things called a key in this project and they are on
--   different axes. Hanging TEST/REAL on the wrong one is the trap in this item.
--
--   1. device_keys + mint_device_key / revoke_device_key / list_device_keys,
--      and the "Product keys" panel in the office (website/dashboard.html, Crew
--      tab). This is the one the OFFICE already calls a product key, and it
--      answers "may this EXTRA PHONE sign in to the company I am already in".
--      It is company-scoped, one-shot, 7 days, minted by that company's own
--      OWNER or MANAGER -- not by the admin portal, which has no reference to it
--      at all. Live state: ZERO rows in device_keys have ever been minted, and
--      require_device_key is unset for all 11 companies, so it is built, live
--      and never once used.
--
--      THIS IS NOT THE KEY E2 IS ABOUT. A key that is spent by the first phone
--      to use it and expires in a week cannot be "the sandbox"; and a key the
--      customer's own office mints cannot be "controlled from the admin portal".
--      Adding a kind='TEST' column to it would break the one invariant it has.
--
--   2. company_setup_codes + admin_create_company / claim_company_setup, and
--      the code the admin portal shows once when it creates a company. This
--      answers "which company does the person typing this become the owner of".
--      It IS minted by the admin portal, it IS one-shot, and the app already has
--      the box to type it into (AccountScreen.kt -> AccountViewModel.
--      claimCompanySetup -> SupabaseModule.claimCompanySetup).
--
--      THIS IS THE KEY E2 IS ABOUT, and the answer falls out of it:
--
--          TEST vs REAL is a property of the COMPANY the code belongs to,
--          not a property of the code.
--
--      One mechanism, two destinations. A code for a real company is the REAL
--      key and unlocks the live app. A code for a sandbox company is the TEST
--      key and unlocks that company's fixture data. The phone needs no change
--      whatever -- which matters, because the app half is where this item would
--      otherwise have died.
--
-- WHAT IS MISSING, PROVED LIVE
--   a) THE ADMIN PORTAL CANNOT ISSUE A KEY FOR A COMPANY THAT ALREADY EXISTS.
--      Only two functions in the whole database touch company_setup_codes
--      (checked by prosrc): admin_create_company, which mints one at creation
--      and whose dialog shows it once and never again, and claim_company_setup,
--      which spends it. website/admin.html can only COPY an existing unused code
--      (copySetupCode, which reads company_setup_codes directly). There is no
--      way to mint a new one. PART 1 is that function.
--
--   b) SO THE TEST COMPANIES ARE UNREACHABLE. Four "ZZ TEST" companies exist.
--      Every one has ZERO profiles and ZERO setup codes, so nobody can sign in
--      to any of them and the test data they hold cannot be looked at from the
--      app at all. Live, 2026-10-24:
--
--        ZZ TEST - Brand new, nothing set up ....... 0 codes 0 profiles  0 jobs
--        ZZ TEST - Busy season, jobs in every state  0 codes 0 profiles  5 jobs (5 flagged test)
--        ZZ TEST - Lapsed, work intact ............. 0 codes 0 profiles  0 jobs
--        ZZ TEST - Sample Fence Co ................. 0 codes 0 profiles  2 jobs (2 flagged test)
--
--   c) NOTHING MARKS A COMPANY AS A SANDBOX. The entire public schema contains
--      exactly three columns with test or live in the name -- job_payments.livemode,
--      jobs.is_test_fixture and jobs_crew.is_test_fixture. There is no company,
--      profile or device level sandbox flag anywhere. So a TEST key handed out
--      today would drop its holder into a company that is live in every respect
--      that costs money: it can take a real Stripe payment and send real mail.
--      PART 2 is that flag, and it is deliberately INERT -- see below.
--
-- WHAT THIS FILE DOES NOT DO, AND WHY
--   It does not make the sandbox flag mean anything. Honouring it is work in
--   three places this file must not reach into:
--     * the mail path (supabase/functions/_shared/mail/**) must refuse to send
--       real mail from a sandbox company,
--     * the Stripe path must force test keys for one, so a sandbox job cannot
--       take real money -- job_payments.livemode RECORDS which mode a payment
--       arrived in (live today: 23 test, 1 live) but nothing REFUSES a live
--       charge from a test session,
--     * the office console hides jobs with is_test_fixture = true from every
--       view, and every job in the ZZ TEST companies is flagged -- so a TEST key
--       holder would claim a company and see an EMPTY office. A sandbox company
--       has to show its fixture jobs, which is the one place the two flags have
--       to be read together.
--   Until those three are done, is_sandbox is a label and nothing more, and the
--   file says so rather than implying a containment that is not there. A lock
--   people believe in and that is not there is worse than no lock.
--
--   It also does not add the admin-portal BUTTON. admin_mint_setup_code does not
--   exist on the live database yet, so a button calling it would fail with
--   "function does not exist" for every company; the panel is a short follow-up
--   in website/admin.html once PART 1 is applied, next to the existing
--   "Copy setup code" in the Manage dialog.
--
-- THE ONE QUESTION ONLY HE CAN ANSWER
--   Is the sandbox a REAL COMPANY ROW he hands out (claim "ZZ TEST - Busy
--   season" and drive it), or the app's existing GUEST DEMO (local sample jobs
--   marked "* Guest Demo - " + FENCEFLOW_GUEST_DEMO_v1, read-only, wiped at the
--   end, no key and no server data)? This file assumes the first, because that
--   is what "unlocks the test data" describes and because the guest demo needs
--   no key at all. If he means the second, PART 1 is still right and PART 2 is
--   unnecessary.
--
-- KIND
--   PART 1  ADDITIVE. One new function. No table altered, no policy touched.
--   PART 2  ADDITIVE. One new column on public.companies, NOT NULL DEFAULT
--           false, so every existing row answers false and nothing changes
--           meaning. Plus its grants -- read THE GRANT TRAP below, it is the
--           part of this file most likely to take the product down.
--   Nothing is dropped. Nothing is deleted. Re-running changes nothing.
-- ============================================================

-- ------------------------------------------------------------------------
-- PART 1  issue a key for a company that already exists
--
-- Why it refuses a company that already has an owner: claim_company_setup
-- updates the caller's profile to company_id = target, role = 'OWNER' and does
-- NOT check whether that company already has an owner. So two outstanding codes
-- for one company, or one code for a company somebody already owns, is a second
-- OWNER inside a live business. Refusing at the mint is the cheap end of that
-- problem, and it costs nothing here: every company this is for -- the four ZZ
-- TEST rows -- has zero profiles.
--
-- Previously issued unused codes are NOT invalidated: marking one used_at would
-- be a lie about who used it, and there is no column for "superseded". PART 3
-- lists every outstanding code so the admin can see what is still live.
-- ------------------------------------------------------------------------

create or replace function public.admin_mint_setup_code(target uuid)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    code text;
    co_name text;
    owners int;
begin
    -- The same gate as every other admin_ function, in the same place: the
    -- platform-admin flag AND the second factor, both, before anything happens.
    if not is_platform_admin() then
        raise exception 'Only a FenceFlow admin may issue a product key.'
          using errcode = '42501';
    end if;

    select c.name into co_name from companies c
     where c.id = target and c.deleted_at is null;
    if co_name is null then
        raise exception 'No such company, or it is in the recycle bin.';
    end if;

    select count(*) into owners from profiles p
     where p.company_id = target and p.role = 'OWNER';
    if owners > 0 then
        raise exception 'That company already has an owner. A setup code makes whoever types it the owner, so issuing one here would put a second owner inside a live business.'
          using errcode = '42501';
    end if;

    -- Readable over the phone: no look-alike characters, grouped in fours.
    -- UPPER FIRST, THEN TRANSLATE -- see supabase_r41_setup_code_lookalikes.sql,
    -- which measured 1,291 look-alikes in 4,000 codes from the other order.
    -- gen_random_bytes is schema-qualified because pgcrypto lives in
    -- `extensions` and this function pins search_path to public.
    code := substr(translate(upper(encode(extensions.gen_random_bytes(9), 'base64')), '+/=OI01L', 'XYZABCDEF'), 1, 4)
            || '-' ||
            substr(translate(upper(encode(extensions.gen_random_bytes(9), 'base64')), '+/=OI01L', 'XYZABCDEF'), 1, 4);

    insert into company_setup_codes (code, company_id) values (code, target);

    return code;
end;
$function$;

-- anon is named explicitly. A plain CREATE resets a function's ACL to the
-- default, which is how anon has picked up EXECUTE on a reporting function in
-- this project before; this is the same two lines every admin_ function carries.
revoke execute on function public.admin_mint_setup_code(uuid) from public, anon;
grant  execute on function public.admin_mint_setup_code(uuid) to authenticated;


-- ------------------------------------------------------------------------
-- PART 2  which companies are sandboxes
--
-- THE GRANT TRAP -- read this before changing the grants below.
--   public.companies has PER-COLUMN privileges, not table-wide ones: all 34
--   existing columns carry SELECT, INSERT, UPDATE and REFERENCES for each of
--   anon, authenticated, postgres and service_role (544 grant rows, read live
--   2026-10-24). A new column that is not granted SELECT does not fail quietly
--   for itself -- PostgREST expands `select *` to every column and the WHOLE
--   query is refused, which is how a new column once took all company email
--   down. So SELECT must be granted here, to both anon and authenticated.
--
--   INSERT and UPDATE are deliberately NOT granted, which makes this column the
--   only one on the table that differs from its neighbours. That is on purpose:
--   a sandbox flag a company can write is a company that can take itself out of
--   the sandbox, or put itself in to dodge a bill. Column-level INSERT/UPDATE
--   privilege is only needed for columns a statement actually NAMES, and nothing
--   names this one, so every existing write to companies is unaffected.
--
--   Checked for the app as well: SupabaseModule's Json is configured with
--   ignoreUnknownKeys = true, so a new column arriving in a `select *` does not
--   break deserialisation on any phone in the field.
-- ------------------------------------------------------------------------

alter table public.companies
    add column if not exists is_sandbox boolean not null default false;

comment on column public.companies.is_sandbox is
    'True when this company exists to be demonstrated, not to run a business. '
    'A label only until the mail path, the Stripe path and the office is_test_fixture '
    'filter read it -- see supabase_r42_product_key_test_and_real.sql.';

grant select (is_sandbox) on public.companies to authenticated;
grant select (is_sandbox) on public.companies to anon;

-- ------------------------------------------------------------------------
-- AND IT MUST NOT BE WRITABLE. This file's own check below tests exactly
-- that, and without what follows it reads FALSE.
--
-- public.companies carries TWO TABLE-LEVEL update grants -- to authenticated
-- and to anon -- so every column added to it inherits INSERT and UPDATE
-- immediately. Measured on the live database before this was written:
--
--     total columns                34
--     updatable by authenticated   34
--     table-level update grants     2
--
-- So `add column is_sandbox` hands the flag to any signed-in caller for its own
-- row. The whole point of the column is a sandbox a company cannot declare for
-- itself, and PART 2's header says the flag is inert precisely so that nobody
-- believes in a containment that is not there -- a writable flag is worse than
-- that: it is a containment that can be switched on by the company it is meant
-- to describe, the moment anything starts reading it.
--
-- The same asymmetry bit this project once before in the other direction:
-- SELECT on companies is per-column, and a new column arriving ungranted took
-- every company email down. UPDATE being table-level is the mirror of that bug.
-- After this, both behave the same way.
--
-- GENERATED FROM THE CATALOG, not listed by hand. Thirty-three column names
-- typed into a migration is a list that will be missing one, and the failure
-- mode is the office silently unable to save a field nobody tests.
--
-- anon's privileges are left exactly as they are. That anon holds INSERT and
-- UPDATE on companies at all is a fair question, and it belongs to the owner,
-- not to a rewrite inside this file.
do $sandbox_grants$
declare
    cols text;
    role_name text;
begin
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
      into cols
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'companies'
       and column_name <> 'is_sandbox';
    if cols is null then
        raise exception 'r42: could not read companies'' columns, so the grants were left alone';
    end if;

    foreach role_name in array array['authenticated', 'anon'] loop
        -- The table-level grant is what reaches a new column, so it has to go
        -- before the per-column grants are put back.
        execute format('revoke insert, update on public.companies from %I', role_name);
        execute format('grant insert (%s) on public.companies to %I', cols, role_name);
        execute format('grant update (%s) on public.companies to %I', cols, role_name);
    end loop;

    -- Proven here as well as in the checks below, because this is the statement
    -- whose silent failure would leave the office unable to save a company.
    if exists (select 1 from information_schema.role_column_grants
                where table_schema = 'public' and table_name = 'companies'
                  and column_name = 'is_sandbox'
                  and privilege_type in ('INSERT', 'UPDATE')
                  and grantee in ('authenticated', 'anon')) then
        raise exception 'r42: is_sandbox is still writable by a client after the re-grant';
    end if;
    if not exists (select 1 from information_schema.role_column_grants
                    where table_schema = 'public' and table_name = 'companies'
                      and column_name = 'name'
                      and privilege_type = 'UPDATE'
                      and grantee = 'authenticated') then
        raise exception 'r42: the re-grant did not put UPDATE back on companies.name -- the office cannot save a company';
    end if;
end $sandbox_grants$;
grant select (is_sandbox) on public.companies to service_role;


-- ------------------------------------------------------------------------
-- PART 3  prove every claim above, one row each
--
-- READ THIS FIRST, because it decides what the checks can be about.
--
-- The SQL editor runs as postgres, so auth.uid() is null, so is_platform_admin()
-- is false, so CALLING admin_mint_setup_code here raises 'Only a FenceFlow admin
-- may issue a product key.' -- on a perfect install and a broken one alike. A
-- row count taken from it would read zero either way. That is the "an empty
-- answer reads as good news" trap. So nothing below calls it: every check is
-- about the SHAPE of the function, the GRANTS, or the live data. No row is
-- written by this part.
--
-- Run PART 3 on its own BEFORE PART 1 and PART 2 to see it fail. Rows 1, 2, 3,
-- 10, 11 and 12 depend on PART 1; rows 13 and 14 depend on PART 2.
-- ------------------------------------------------------------------------

with body as (
    select p.prosrc, p.prosecdef, p.proconfig
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname = 'admin_mint_setup_code'
)
select 'admin_mint_setup_code exists' as check,
       exists (select 1 from body) as ok
union all
select 'it is SECURITY DEFINER with a pinned search_path',
       (select prosecdef from body)
   and (select coalesce(array_to_string(proconfig, ','), '') from body) like '%search_path=public%'
union all
select 'the platform-admin gate is the first thing in its body',
       (select prosrc from body) like '%if not is_platform_admin() then%'
union all
-- CANARY for the body checks. Each is "is this text in prosrc", and a prosrc
-- that came back null makes LIKE read null and NOT LIKE read null too -- and
-- null is not false, so a missing function could skim past as "not a failure".
select 'CANARY: the body test can find text that is there',
       (select prosrc from body) like '%company_setup_codes%'
union all
select 'it refuses a company that already has an owner',
       (select prosrc from body) like '%already has an owner%'
union all
select 'it skips a company in the recycle bin',
       (select prosrc from body) like '%deleted_at is null%'
union all
select 'its generator uppercases before it translates',
       (select prosrc from body) like '%translate(upper(%'
union all
select 'gen_random_bytes is schema-qualified',
       (select prosrc from body) like '%extensions.gen_random_bytes%'
union all
-- A real guard, not a canary: the one way an admin_ function starts answering a
-- caller who is not an admin is an "if nobody is signed in, allow it" hatch --
-- auth.uid() is null for an anonymous visitor exactly as it is for the service
-- role, which is what once made admin_mark_invited callable by anybody.
select 'CANARY: no signed-out escape hatch is in the body',
       (select prosrc from body) not like '%auth.uid() is null%'
   and (select prosrc from body) not like '%service_role%'
union all
select 'authenticated can execute it',
       has_function_privilege('authenticated', 'public.admin_mint_setup_code(uuid)', 'EXECUTE')
union all
select 'CANARY: anon cannot execute it',
       not has_function_privilege('anon', 'public.admin_mint_setup_code(uuid)', 'EXECUTE')
union all
-- CANARY for the row above. has_function_privilege answers true for a superuser
-- on anything and the anon check is a NOT, so a test that could only say "anon
-- has nothing" would pass while proving nothing. is_platform_admin is
-- deliberately executable by anon (it answers false, and policies call it), so
-- asking about it proves this test can still say true about anon.
select 'CANARY: the execute test can answer true for anon somewhere',
       has_function_privilege('anon', 'public.is_platform_admin()', 'EXECUTE')
union all
select 'companies.is_sandbox exists and defaults false for every existing row',
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='companies'
                  and column_name='is_sandbox')
   and not exists (select 1 from public.companies where is_sandbox)
union all
select 'is_sandbox is granted SELECT to authenticated AND anon, so select * is not refused',
       (select count(*) from information_schema.role_column_grants
         where table_schema='public' and table_name='companies'
           and column_name='is_sandbox' and privilege_type='SELECT'
           and grantee in ('authenticated','anon')) = 2
union all
-- CANARY for the row above: it counts grants on ONE column, and a grant view
-- that returned nothing at all would read 0 and look like a missing grant
-- rather than a broken test. Prove the view answers for a column known to be
-- granted since the table was made.
select 'CANARY: the grant view answers for companies.name',
       exists (select 1 from information_schema.role_column_grants
                where table_schema='public' and table_name='companies'
                  and column_name='name' and privilege_type='SELECT'
                  and grantee='authenticated')
union all
select 'is_sandbox is NOT writable by a client, which is the point of it',
       not exists (select 1 from information_schema.role_column_grants
                    where table_schema='public' and table_name='companies'
                      and column_name='is_sandbox'
                      and privilege_type in ('INSERT','UPDATE')
                      and grantee in ('authenticated','anon'))
union all
-- The live facts this file is built on. If any of these three stops being true,
-- stop and find out what changed before trusting anything above.
select 'LIVE: the test companies still have no owner, so a key can be issued for them',
       exists (select 1 from public.companies c
                where c.name like 'ZZ TEST%'
                  and not exists (select 1 from public.profiles p
                                   where p.company_id = c.id and p.role = 'OWNER'))
union all
select 'LIVE: the test companies still have no setup code, so nobody can reach them today',
       not exists (select 1 from public.company_setup_codes k
                    join public.companies c on c.id = k.company_id
                   where c.name like 'ZZ TEST%' and k.used_at is null)
union all
-- CANARY for the row above: it is a NOT EXISTS over a join, and it reads true if
-- there are no unused codes anywhere, or no ZZ TEST companies at all. Prove both
-- halves have something in them.
select 'CANARY: there are ZZ TEST companies and there is an unused code somewhere',
       exists (select 1 from public.companies where name like 'ZZ TEST%')
   and exists (select 1 from public.company_setup_codes where used_at is null)
union all
select 'LIVE: every job in a ZZ TEST company is flagged is_test_fixture, so the office would hide them all',
       not exists (select 1 from public.jobs j
                    join public.companies c on c.id = j.company_id
                   where c.name like 'ZZ TEST%' and j.deleted_at is null
                     and not j.is_test_fixture)
   and exists (select 1 from public.jobs j
                join public.companies c on c.id = j.company_id
               where c.name like 'ZZ TEST%' and j.deleted_at is null);
