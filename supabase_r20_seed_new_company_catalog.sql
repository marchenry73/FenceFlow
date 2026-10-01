-- supabase_r20_seed_new_company_catalog.sql
--
-- ############################################################################
-- #  STATUS: NOT APPLIED.  Written 2026-09-30.                               #
-- #                                                                          #
-- #  Running this file as it stands changes NOTHING. PART 1 is a dry run:    #
-- #  one transaction that installs the change, exercises it as signed-in     #
-- #  users and as the anonymous role, and ends in ROLLBACK. PART 2 (apply),  #
-- #  PART 3 (reverse) and PART 4 (backfill) are inside block comments and    #
-- #  do not run.                                                             #
-- #                                                                          #
-- #  Applying PART 2 changes only companies created AFTER it. It writes not  #
-- #  one row into any company that exists today. Whether to also give the    #
-- #  existing empty companies the list is PART 4, and that is a separate     #
-- #  decision that is yours.                                                 #
-- ############################################################################
--
-- THE PROBLEM. A company that signs up today has no catalog, and nothing gives
-- it one: no trigger, no function, only a button (Copy FenceFlow's starting
-- list on the phone, Start from FenceFlow's catalog in the office) that almost
-- nobody finds. Nine of ten companies in production hold zero catalog rows.
-- With an empty catalog the app still prints a quote: 100 ft of vinyl at the
-- phone's default rates comes out at $800 (labor alone, materials $0, tax $0)
-- where the same job priced from the starting list is $2,120. Nothing warns.
-- (docs/ONBOARDING_REALITY.md section 5 and tests/a25-new-company-onboarding
-- .test.mjs measured that with the real engine.) The phone now warns loudly
-- about that state whatever this file does (EstimateEngine.hasFenceWithNoMaterials).
-- This file is the other half: it stops new companies being in that state.
--
-- WHERE A COMPANY COMES INTO EXISTENCE, read from the live catalogue on
-- 2026-09-30 (function bodies from pg_proc, not from any repo file):
--   create_company_with_owner(company_name, owner_name)   SECURITY DEFINER
--       inserts companies (name)  then profiles (the caller as OWNER).
--       Called by website sign-up (dashboard.html signUp / finishCompany / boot)
--       and by phone sign-up (SupabaseModule.createCompany).
--   admin_create_company(company_name, contact_email)     SECURITY DEFINER
--       inserts companies (name, email, status 'pending') then a setup code.
--       Called by the staff console (admin.html); the owner later claims the
--       company with claim_company_setup or claim_invited_company.
--   Those are the only two functions in the database that insert into
--   companies. claim_company_setup, claim_invited_company and join_company
--   attach a PERSON to an existing company and never create one. The only
--   other way in is a direct INSERT, which the companies_platform_admin_insert
--   policy allows to a platform admin. No trigger on auth.users; the triggers
--   on companies (audit, welcome-email guard, billing guard) all fire on
--   UPDATE or write elsewhere; no trigger on material_items fires on INSERT.
--   So the one place every one of those paths goes through is the companies
--   row itself. THE SEED IS AN AFTER INSERT TRIGGER ON companies, not a line
--   added to either function: a third creation path added next year, or a
--   staff member inserting a row by hand, is covered without anyone
--   remembering this file.
--
-- WHAT THIS DOES
--   seed_starting_catalog(company_id)   inserts the 92-row starting list for
--       ONE company, and only if that company has never held a catalog row
--       (live OR deleted -- a company that deleted its catalog on purpose is not
--       given it back, and one that already has rows is never mixed with the
--       list). It returns how many rows it wrote. Row identity is derived from
--       the company and the row (an md5 uuid), so a second call is a no-op
--       twice over: the guard, and ON CONFLICT DO NOTHING.
--   companies_seed_catalog_trigger()    the trigger function. It calls the one
--       above for the company just created. IT CAN NEVER STOP A SIGN-UP: any
--       failure is caught, written to app_errors (fatal = false, so the admin
--       console shows it) and the sign-up carries on -- a company with no
--       catalog is exactly today's behaviour, which the phone now warns about.
--   companies_seed_starting_catalog     the trigger: AFTER INSERT, per row.
--   Both functions are SECURITY DEFINER with search_path pinned to
--   public, pg_temp, and EXECUTE is revoked from public, anon and
--   authenticated: seed_starting_catalog takes any company id, so leaving it
--   callable would let any signed-in stranger write a catalog into somebody
--   else's empty company. The dry run attacks exactly that.
--
-- THE LIST. Copied, not invented: the 92 rows of SeedData.materialItems() on the
-- phone, which equal the office's CATALOG_SEED row for row (name, unit, price,
-- taxable, covers, colour, category, role, fence type -- checked again by
-- tests/a26-catalog-seed.test.mjs, which reads all three and fails on any drift).
-- Every row is stamped "Starting price -- verify with your supplier", the label
-- both apps read as unverified. Per type: vinyl 19, wood 10, chain link 18,
-- aluminum 14, ornamental iron 11, split rail 8, composite 10, universal 2.
--
-- ONE DELIBERATE DEVIATION FROM THE PHONE AND OFFICE COPIES, four booleans.
--   The phone and the office lists carry taxable = false on the three 6 ft vinyl
--   privacy panels (White, Tan, Gray) and the 5 ft PVC gate. That is the mistake
--   supabase_r9_taxable_panels.sql corrected on the owner's own catalog on 25
--   September (on 100 ft of vinyl it short-collected $62.30 of tax), and his live
--   catalog carries taxable = true on all 92 rows today. A company seeded from
--   the list as shipped would re-create that bug on day one, so THIS file seeds
--   those four rows as taxable = true and every other column as the lists have it.
--   The lists themselves are NOT fixed here: SeedData.kt's rows feed the golden
--   pricing fixtures in fixtures/pricing (the parity gate), so correcting them
--   is a change of its own -- SeedData.kt and CATALOG_SEED together, fixtures
--   regenerated -- and dashboard.html is not this file's to edit. The test
--   (tests/a26-catalog-seed.test.mjs) allows exactly these four differences and
--   nothing else, and shrinks to none the day the lists are fixed. To seed the
--   lists exactly as shipped, change those four `true` to `false` below (PART 1
--   and PART 2) and the checksum in the dry run; the test pins the four as
--   taxable and would need the same change.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   * It writes nothing into any existing company. (PART 4 is the way to do that
--     on purpose.)
--   * It does not seed pricing tiers (the phone's starter tiers are the founder's
--     labor rates and discounts), settings, suppliers or a standard build.
--   * It does not mark any price as checked. Every seeded row is "unverified".
--
-- WHAT APPLYING CHANGES ELSEWHERE -- read before applying (none of it is done here)
--   1. my_setup_progress() counts catalog_ok as "at least one row". A seeded
--      company therefore shows the catalog step as done from its first minute,
--      with every price unchecked. The step no longer proves the owner looked.
--   2. The office cannot confirm a starting price (catalogItemPayload never
--      carries source_doc; the phone's Confirm box does). The office's send
--      gate (unverifiedPricesOn / renderQuoteBlock) refuses the quote link while
--      a job rests on a starting price. A web-only company seeded by this file
--      will hit that gate on its first quote with no way to clear it except the
--      phone, or by hand-editing the job's lines. Today that is only true of a
--      company that pressed the copy button itself; this moves it to every new
--      company. This is the reason to settle "one place a price is confirmed,
--      reachable from the web" before, or together with, applying.
--   3. Words that become untrue: cat_empty_body ("New companies start with no
--      materials and no prices ..."), and the office/phone empty-catalog copy.
--   4. tests/a25-new-company-onboarding.test.mjs pins today's gap: its LIVE test
--      "nothing in the database creates or seeds anything" will go red, for the
--      right reason. The a25 census test's "control: catalog count can be
--      non-zero" is unaffected.
--   5. Every probe that inserts a company (the rolled-back ones in this
--      repository) will now find 92 catalog rows on it. A probe that counts a
--      fresh company's material_items would need to expect that.
--   6. A phone that is offline or has not synced yet shows an empty local catalog
--      for a company the server already seeded, and its Copy button would push a
--      second copy of every row up. The phone hides such duplicates locally
--      (ensureSeedDataPresent's deleteDuplicates(), a local delete with no
--      tombstone) and the office's Start-from button skips rows it already has
--      by (type, role, name), but nothing removes the extra 92 rows from the
--      server. The window is small (a company whose phone has not pulled once),
--      and closing it is a phone change -- the Copy card checking the server --
--      that this file does not make.
--
-- WHAT THE DRY RUN SHOWED, 2026-09-30, against production, rolled back (nothing
-- left behind -- checked by a separate query afterwards):
--   82 of 82 checks pass. BASELINE on the deployed database: a sign-up made a company with 0
--   catalog rows. With the change in, create_company_with_owner (website and phone),
--   admin_create_company (staff console) and a plain INSERT each leave the new company with
--   exactly 92 rows whose checksum equals the list. A company that already holds a row, or
--   holds only deleted rows, is left alone. A signed-in stranger and the anonymous key are
--   refused (42501) when they try to seed somebody else's empty company, and it stays empty.
--   Crew read none of the seeded prices and cannot change or delete them; another company's
--   owner reads none of them; no policy, table privilege, creator function, trigger or
--   existing company's row count moved; no HTTP call was queued. With the seed made to fail
--   a stranger STILL signs up, and the failure lands in app_errors (fatal = false).
--   Planted-failure runs, each a rolled-back copy of this file with one thing broken, all caught:
--   revoke removed (5 rows red, one of them a stranger filling an empty company), exception
--   block removed (4), guard removed (4), one price mistyped (5), the four-boolean deviation
--   reverted (6), guard narrowed to live rows only (2), SECURITY DEFINER dropped from the helper (1).
--
-- THE BACKFILL, read-only, as of 2026-09-30: which companies hold no catalog row
-- today and would receive 92 rows if PART 4 were run for them:
--   9 of 10 companies hold no catalog row at all (the owner's own company holds 92 and is left alone):
--     Legacy (trialing, Solo, 1 login, 1 job)      Horizon fence llc (pending, 1 login)
--     PeterLLC (trialing, Crew, 1 login)             Marc (trialing, Solo, 1 login)
--     Marco (pending, Crew, 0 logins)
--     and four ZZ TEST fixtures (Busy season, Lapsed, Sample Fence Co, Brand new): 0 logins each.
--   PART 4 for all nine would write 828 rows; for the five non-fixture companies, 460.
--   The dry run below prints the same table live (rows with subject 'backfill').
--   Three of these are real third-party companies (two are locked out of an app
--   they signed up for); this file writes to none of them, and PART 4 names no
--   company: whoever runs it chooses the ids.
--
-- THE REVERSE is PART 3: it drops the trigger and the two functions. It deletes
-- no data -- catalog rows already written stay, because they belong to their
-- companies from the moment they exist.
--
-- USING THIS FILE
--   Dry run:  npx --no-install supabase@2.115.0 db query --linked \
--               --project-ref newcrgafcptspmapacrx -f supabase_r20_seed_new_company_catalog.sql --output json
--             One row per check with PASS or FAIL, a SUMMARY row, and the
--             backfill table. Rows marked 'info' are recorded, not scored.
--             Every probe runs as the signed-in or the anonymous role with a
--             specific user's claims; the bypass role is named nowhere. The only
--             statements that run as the database owner are the fixture setup
--             and the read-backs of what a probe did or did not do.
--   Apply:    delete the two marker lines that open and close the PART 2 block
--             comment, run PART 2 alone, then put the markers back.
--   Reverse:  the same, for PART 3.  Backfill: the same, for PART 4.

-- PART 1 -- DRY RUN. Rolled back.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create temp table r(n serial primary key, subject text, pair text, role text, k text, got text, want text);
create temp table snap(k text primary key, v text);

-- q: run one statement as a signed-in user (or the anonymous key when who is null), keep one scalar back.
-- x: run it for effect and record the real affected-row count, or the error. s: the database owner READS
-- BACK what a probe did or did not do; it never attacks. The role and the claims are set INLINE and reset
-- before anything is recorded, so a probe can never leave the session as somebody else.
create function pg_temp.q(sj text, pr text, ro text, kk text, who uuid, sq text, wt text, gk text default null) returns void language plpgsql as $fn$
declare v text;
begin
  if who is null then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    execute 'set local role anon';
  else
    perform set_config('request.jwt.claims', json_build_object('sub',who,'role','authenticated','aud','authenticated')::text, true);
    execute 'set local role authenticated';
  end if;
  begin execute sq into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,140); end;
  execute 'reset role';
  perform set_config('request.jwt.claims','',true);
  if gk is not null then perform set_config('a26c.' || gk, v, true); end if;
  insert into r(subject,pair,role,k,got,want) values (sj,pr,ro,kk,v,wt);
end $fn$;

create function pg_temp.x(sj text, pr text, ro text, kk text, who uuid, sq text, wt text) returns void language plpgsql as $fn$
declare c int; v text;
begin
  if who is null then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    execute 'set local role anon';
  else
    perform set_config('request.jwt.claims', json_build_object('sub',who,'role','authenticated','aud','authenticated')::text, true);
    execute 'set local role authenticated';
  end if;
  begin execute sq; get diagnostics c = row_count; v := 'rows=' || c;
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,140); end;
  execute 'reset role';
  perform set_config('request.jwt.claims','',true);
  insert into r(subject,pair,role,k,got,want) values (sj,pr,ro,kk,v,wt);
end $fn$;

create function pg_temp.s(sj text, pr text, ro text, kk text, sq text, wt text) returns void language plpgsql as $fn$
declare v text;
begin
  perform set_config('request.jwt.claims','',true);
  begin execute sq into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,140); end;
  insert into r(subject,pair,role,k,got,want) values (sj,pr,ro,kk,v,wt);
end $fn$;

-- want: an exact string; 'ERR <sqlstate>' (prefix); '>=N'; '~<regex>'; 'info' (recorded, never fails);
-- or several of those joined with '|'.
create function pg_temp.ok(got text, want text) returns boolean language sql immutable as $fn$
  select coalesce((
    select bool_or(case
      when alt = 'info' then true
      when alt like '>=%' then case when got ~ '^[0-9]+$' then got::numeric >= substr(alt,3)::numeric else false end
      when alt like 'ERR %' then got like alt || '%'
      when alt like '~%' then got ~ substr(alt,2)
      else got = alt end)
    from unnest(string_to_array(want, '|')) as alt), false)
$fn$;

do $probe_before$
begin
  perform set_config('request.jwt.claims','',true);

  -- ---- what the deployed database is, BEFORE the change ----
  insert into snap values ('applied', (exists (select 1 from pg_trigger t where t.tgrelid = 'public.companies'::regclass and t.tgname = 'companies_seed_starting_catalog' and not t.tgisinternal))::text);
  insert into snap values ('policies', (select md5(coalesce(string_agg(md5(concat_ws('|',schemaname,tablename,policyname,cmd,roles::text,qual,with_check)), ',' order by schemaname,tablename,policyname),'')) from pg_policies));
  insert into snap values ('relacls', (select md5(coalesce(string_agg(c.relname||':'||coalesce(c.relacl::text,''), ',' order by c.relname),'')) from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','v','m','p','S')));
  insert into snap values ('creators', (select md5(coalesce(string_agg(p.oid::regprocedure::text||md5(p.prosrc), ',' order by p.oid::regprocedure::text),'')) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('create_company_with_owner','admin_create_company','claim_company_setup','claim_invited_company','join_company','company_allowed','company_is_suspended','has_permission')));
  insert into snap values ('mi_triggers', (select md5(coalesce(string_agg(t.tgname||':'||t.tgenabled::text||':'||t.tgtype::text, ',' order by t.tgname),'')) from pg_trigger t where t.tgrelid='public.material_items'::regclass and not t.tgisinternal));
  insert into snap values ('company_triggers', (select md5(coalesce(string_agg(t.tgname||':'||t.tgenabled::text||':'||t.tgtype::text, ',' order by t.tgname),'')) from pg_trigger t where t.tgrelid='public.companies'::regclass and not t.tgisinternal and t.tgname <> 'companies_seed_starting_catalog'));
  insert into snap values ('per_company', (select md5(coalesce(string_agg(c.id::text||':'||(select count(*) from public.material_items m where m.company_id=c.id)::text, ',' order by c.id),'')) from public.companies c));
  insert into snap values ('companies_n', (select count(*)::text from public.companies));
  begin
    insert into snap select 'http_queue', count(*)::text from net.http_request_queue;
  exception when others then
    insert into snap values ('http_queue', 'none');
  end;

  -- ---- the backfill table, read-only: who holds no catalog row today ----
  insert into r(subject,pair,role,k,got,want)
  select 'backfill', c.name, case when c.name ilike 'ZZ TEST%' then 'test fixture' else 'company' end,
         'status/plan, logins, live jobs -> rows PART 4 would write',
         c.subscription_status || '/' || coalesce(nullif(c.subscription_plan,''),'-') || ', ' ||
         (select count(*) from public.profiles p where p.company_id=c.id)::text || ' login(s), ' ||
         (select count(*) from public.jobs j where j.company_id=c.id and j.deleted_at is null)::text || ' job(s) -> ' ||
         case when exists (select 1 from public.material_items m where m.company_id=c.id) then '0 (already has ' || (select count(*) from public.material_items m where m.company_id=c.id)::text || ' rows, left alone)' else '92' end,
         'info'
    from public.companies c order by c.created_at;
  insert into r(subject,pair,role,k,got,want)
  select 'backfill', 'TOTAL', '-', 'companies with no catalog row / rows PART 4 would write if run for all of them',
         count(*)::text || ' / ' || (count(*) * 92)::text, 'info'
    from public.companies c where not exists (select 1 from public.material_items m where m.company_id=c.id);
  perform pg_temp.s('backfill','control','control','the reader sees a catalog that exists (so a company showing none really has none)',$q$select max(n)::text from (select count(*) n from public.material_items group by company_id) t$q$,'>=1');

  -- ---- BASELINE: a real sign-up on the deployed function, before the change ----
  insert into auth.users(id,email) values ('a26c0001-0000-4000-8000-000000000007','a26c-base@probe.invalid');
  perform pg_temp.q('sign-up','before','baseline','a new sign-up (create_company_with_owner) on the deployed database','a26c0001-0000-4000-8000-000000000007'::uuid,$q$select public.create_company_with_owner('PROBE-A26C-BASELINE','A26C Baseline')::text$q$,'info','base_company');
  perform pg_temp.s('sign-up','before','baseline','...and how many catalog rows that company has (0 is the gap; 92 means this file is already applied)',$q$select count(*)::text from public.material_items where company_id = current_setting('a26c.base_company')::uuid$q$,'info');
end $probe_before$;

-- ==== THE CHANGE: BEGIN ====
-- 1. THE LIST, AND THE GUARD. One function that writes the starting list for one
--    company, and only if that company has never held a catalog row (live or
--    deleted). Row identity is an md5 uuid of company + fence type + role + name,
--    so the same call always makes the same rows and ON CONFLICT DO NOTHING makes
--    a second call harmless even if the guard were ever removed. Every table is
--    schema-qualified and pg_temp is last on the search path, so a caller cannot
--    stand a temp table in front of a real one. It returns the rows written.
create or replace function public.seed_starting_catalog(p_company_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
    n integer;
begin
    if p_company_id is null then
        return 0;
    end if;
    if not exists (select 1 from public.companies c where c.id = p_company_id) then
        return 0;
    end if;
    -- Any row at all, live or deleted. A company that deleted its catalog on
    -- purpose is not handed it back, and one with rows is never mixed with the list.
    if exists (select 1 from public.material_items m where m.company_id = p_company_id) then
        return 0;
    end if;

    insert into public.material_items
        (company_id, sync_id, category, role, fence_type, name, unit, unit_price,
         taxable, covers_ft, color_or_finish, source_doc)
    select p_company_id,
           md5(p_company_id::text || ':starting-catalog:' || v.fence_type || ':' || v.role || ':' || v.name)::uuid,
           v.category, v.role, v.fence_type, v.name, v.unit, v.unit_price,
           v.taxable, v.covers_ft, v.color_or_finish,
           'Starting price — verify with your supplier'
      from (values
        -- vinyl (19)
        ('PANEL', 'PANEL', 'VINYL', 'Panel T&G Vinyl Privacy 6''H x 6''W - White', 'EA', 52.35, true, 6, 'White'),  -- taxable = true here; the phone and office lists say false (see the header)
        ('PANEL', 'PANEL', 'VINYL', 'Panel T&G Vinyl Privacy 6''H x 8''W - White', 'EA', 71.4, true, 8, 'White'),
        ('POST', 'LINE_POST', 'VINYL', '5"x5" Co-Ex Line Post, White', 'EA', 16.56, true, null, 'White'),
        ('POST', 'END_POST', 'VINYL', '5"x5" Co-Ex End Post, White', 'EA', 16.56, true, null, 'White'),
        ('POST', 'CORNER_POST', 'VINYL', '5"x5" Co-Ex Corner Post, White', 'EA', 16.56, true, null, 'White'),
        ('POST', 'GATE_POST', 'VINYL', '5"x5" Co-Ex Gate Post, White', 'EA', 16.56, true, null, 'White'),
        ('CAP', 'POST_CAP', 'VINYL', '5" External Pyramid PVC Post Cap, White', 'EA', 0.74, true, null, 'White'),
        ('GATE', 'GATE_PANEL', 'VINYL', 'Regular PVC Gate 6''H x 5''W, White', 'EA', 145.05, true, 5, 'White'),  -- taxable = true here; the phone and office lists say false (see the header)
        ('HARDWARE', 'HINGE_SET', 'VINYL', 'Self-Closing Hinge Set (box, 12 pairs)', 'BOX', 32.25, true, null, 'White'),
        ('HARDWARE', 'LATCH', 'VINYL', 'Two-Way Latch (box of 20)', 'BOX', 25.87, true, null, 'Black'),
        ('HARDWARE', 'HANDLE', 'VINYL', '7" SS Gate Handle (box of 50)', 'BOX', 5, true, null, 'Black'),
        ('HARDWARE', 'BRACE', 'VINYL', 'Gate Support Brace, 8''', 'EA', 6.5, true, null, 'White'),
        ('HARDWARE', 'STIFFENER', 'VINYL', '5" Econo Stiffener x 8''(H)', 'EA', 52.75, true, null, ''),
        ('TRIM', 'TRIM', 'VINYL', '7/8 x 1-1/2 x 62 1/4 Trim U-Channel, White', 'EA', 2, true, null, 'White'),
        ('PANEL', 'PANEL', 'VINYL', 'Panel T&G Vinyl Privacy 6''H x 6''W - Tan', 'EA', 54.5, true, 6, 'Tan'),  -- taxable = true here; the phone and office lists say false (see the header)
        ('PANEL', 'PANEL', 'VINYL', 'Panel T&G Vinyl Privacy 6''H x 6''W - Gray', 'EA', 54.5, true, 6, 'Gray'),  -- taxable = true here; the phone and office lists say false (see the header)
        ('PANEL', 'PANEL', 'VINYL', 'Panel T&G Vinyl Privacy 6''H x 8''W - Tan', 'EA', 73.9, true, 8, 'Tan'),
        ('POST', 'LINE_POST', 'VINYL', '5"x5" Co-Ex Line Post, Tan', 'EA', 17.25, true, null, 'Tan'),
        ('POST', 'LINE_POST', 'VINYL', '5"x5" Co-Ex Line Post, Gray', 'EA', 17.25, true, null, 'Gray'),
        -- wood (10)
        ('PICKET', 'WOOD_PICKET', 'WOOD', '6'' Dog-Ear Wood Picket, Pressure-Treated Pine', 'EA', 3.25, true, null, ''),
        ('RAIL', 'WOOD_RAIL', 'WOOD', '2x4x8'' Pressure-Treated Rail', 'EA', 6.5, true, null, ''),
        ('POST', 'LINE_POST', 'WOOD', '4x4x8'' Pressure-Treated Post', 'EA', 9.5, true, null, ''),
        ('POST', 'END_POST', 'WOOD', '4x4x8'' Pressure-Treated Post', 'EA', 9.5, true, null, ''),
        ('POST', 'CORNER_POST', 'WOOD', '4x4x8'' Pressure-Treated Post', 'EA', 9.5, true, null, ''),
        ('POST', 'GATE_POST', 'WOOD', '4x4x8'' Pressure-Treated Post', 'EA', 9.5, true, null, ''),
        ('CAP', 'POST_CAP', 'WOOD', '4x4 Wood Post Cap', 'EA', 2.25, true, null, ''),
        ('GATE', 'GATE_FRAME_KIT', 'WOOD', 'Wood Gate Frame Kit, Steel-Reinforced (up to 4''W)', 'EA', 65, true, 4, ''),
        ('HARDWARE', 'HINGE_SET', 'WOOD', 'Heavy-Duty T-Hinge Pair', 'PAIR', 14, true, null, ''),
        ('HARDWARE', 'LATCH', 'WOOD', 'Wood Gate Latch', 'EA', 9, true, null, ''),
        -- chain link (18)
        ('FABRIC', 'CHAIN_FABRIC', 'CHAIN_LINK', 'Galvanized Chain Link Fabric, 4'' (per LF)', 'LF', 3.1, true, 4, ''),
        ('FABRIC', 'CHAIN_FABRIC', 'CHAIN_LINK', 'Galvanized Chain Link Fabric, 6'' (per LF)', 'LF', 4.35, true, 6, ''),
        ('FABRIC', 'CHAIN_FABRIC', 'CHAIN_LINK', 'Galvanized Chain Link Fabric, 8'' (per LF)', 'LF', 5.6, true, 8, ''),
        ('RAIL', 'TOP_RAIL', 'CHAIN_LINK', '1-3/8" Top Rail (per LF)', 'LF', 2.1, true, null, ''),
        ('MISC', 'TENSION_WIRE', 'CHAIN_LINK', '7-Gauge Bottom Tension Wire (per LF)', 'LF', 0.55, true, null, ''),
        ('POST', 'LINE_POST', 'CHAIN_LINK', '1-5/8" Galvanized Line Post, 8''', 'EA', 11.5, true, null, ''),
        ('POST', 'END_POST', 'CHAIN_LINK', '2" Galvanized Terminal Post, 8''', 'EA', 19.75, true, null, ''),
        ('POST', 'CORNER_POST', 'CHAIN_LINK', '2" Galvanized Terminal Post, 8''', 'EA', 19.75, true, null, ''),
        ('POST', 'GATE_POST', 'CHAIN_LINK', '2" Galvanized Terminal Post, 8''', 'EA', 19.75, true, null, ''),
        ('CAP', 'POST_CAP', 'CHAIN_LINK', 'Line Post Cap', 'EA', 1.1, true, null, ''),
        ('HARDWARE', 'TENSION_BAND', 'CHAIN_LINK', 'Tension Band', 'EA', 1.05, true, null, ''),
        ('HARDWARE', 'BRACE_BAND', 'CHAIN_LINK', 'Brace Band', 'EA', 1.35, true, null, ''),
        ('HARDWARE', 'RAIL_END', 'CHAIN_LINK', 'Rail End Cup', 'EA', 1.6, true, null, ''),
        ('HARDWARE', 'BARBED_WIRE_ARM', 'CHAIN_LINK', '3-Strand Barbed Wire Arm', 'EA', 8.75, true, null, ''),
        ('FABRIC', 'PRIVACY_SLAT', 'CHAIN_LINK', 'Privacy Slats (per LF)', 'LF', 2.9, true, null, ''),
        ('GATE', 'GATE_FRAME_KIT', 'CHAIN_LINK', 'Chain Link Walk Gate Frame, 4''W, Galvanized', 'EA', 85, true, 4, ''),
        ('HARDWARE', 'HINGE_SET', 'CHAIN_LINK', 'Chain Link Gate Hinge Set', 'SET', 12.5, true, null, ''),
        ('HARDWARE', 'LATCH', 'CHAIN_LINK', 'Chain Link Fork Latch', 'EA', 9.75, true, null, ''),
        -- aluminum (14)
        ('PANEL', 'PANEL', 'ALUMINUM', 'Aluminum Fence Panel 6''H x 6''W, Rackable, Black', 'EA', 95, true, 6, 'Black'),
        ('PANEL', 'PANEL', 'ALUMINUM', 'Aluminum Fence Panel 6''H x 8''W, Rackable, Black', 'EA', 118, true, 8, 'Black'),
        ('POST', 'LINE_POST', 'ALUMINUM', '3" Aluminum Post, 6'', Black', 'EA', 22, true, null, 'Black'),
        ('POST', 'END_POST', 'ALUMINUM', '3" Aluminum Post, 6'', Black', 'EA', 22, true, null, 'Black'),
        ('POST', 'CORNER_POST', 'ALUMINUM', '3" Aluminum Post, 6'', Black', 'EA', 22, true, null, 'Black'),
        ('POST', 'GATE_POST', 'ALUMINUM', '3" Aluminum Post, 6'', Black', 'EA', 22, true, null, 'Black'),
        ('CAP', 'POST_CAP', 'ALUMINUM', 'Aluminum Post Cap, Flat, Black', 'EA', 3.5, true, null, 'Black'),
        ('GATE', 'GATE_PANEL', 'ALUMINUM', 'Aluminum Walk Gate 6''H x 4''W, Black', 'EA', 175, true, 4, 'Black'),
        ('HARDWARE', 'HINGE_SET', 'ALUMINUM', 'Aluminum Gate Hinge Set, Self-Closing', 'SET', 28, true, null, ''),
        ('HARDWARE', 'LATCH', 'ALUMINUM', 'Aluminum Gate Latch, Self-Latching', 'EA', 22, true, null, ''),
        ('PANEL', 'PANEL', 'ALUMINUM', 'Aluminum Fence Panel 6''H x 6''W, Rackable, White', 'EA', 99, true, 6, 'White'),
        ('PANEL', 'PANEL', 'ALUMINUM', 'Aluminum Fence Panel 6''H x 6''W, Rackable, Bronze', 'EA', 99, true, 6, 'Bronze'),
        ('POST', 'LINE_POST', 'ALUMINUM', '3" Aluminum Post, 6'', White', 'EA', 23, true, null, 'White'),
        ('POST', 'LINE_POST', 'ALUMINUM', '3" Aluminum Post, 6'', Bronze', 'EA', 23, true, null, 'Bronze'),
        -- ornamental iron (11)
        ('PANEL', 'PANEL', 'ORNAMENTAL_IRON', 'Ornamental Steel Panel 4''H x 6''W, Black', 'EA', 135, true, 6, 'Black'),
        ('PANEL', 'PANEL', 'ORNAMENTAL_IRON', 'Ornamental Steel Panel 4''H x 8''W, Black', 'EA', 165, true, 8, 'Black'),
        ('PANEL', 'PANEL', 'ORNAMENTAL_IRON', 'Ornamental Steel Panel 6''H x 6''W, Black', 'EA', 175, true, 6, 'Black'),
        ('POST', 'LINE_POST', 'ORNAMENTAL_IRON', '4"x4" Steel Post, 6'', Black', 'EA', 32, true, null, 'Black'),
        ('POST', 'END_POST', 'ORNAMENTAL_IRON', '4"x4" Steel Post, 6'', Black', 'EA', 32, true, null, 'Black'),
        ('POST', 'CORNER_POST', 'ORNAMENTAL_IRON', '4"x4" Steel Post, 6'', Black', 'EA', 32, true, null, 'Black'),
        ('POST', 'GATE_POST', 'ORNAMENTAL_IRON', '4"x4" Steel Post, 6'', Black', 'EA', 32, true, null, 'Black'),
        ('CAP', 'POST_CAP', 'ORNAMENTAL_IRON', 'Ornamental Post Cap, Black', 'EA', 6, true, null, 'Black'),
        ('GATE', 'GATE_PANEL', 'ORNAMENTAL_IRON', 'Ornamental Steel Walk Gate 4''H x 4''W, Black', 'EA', 210, true, 4, 'Black'),
        ('HARDWARE', 'HINGE_SET', 'ORNAMENTAL_IRON', 'Heavy Iron Gate Hinge Set', 'SET', 24, true, null, ''),
        ('HARDWARE', 'LATCH', 'ORNAMENTAL_IRON', 'Self-Latching Iron Gate Latch', 'EA', 19, true, null, ''),
        -- split rail (8)
        ('RAIL', 'WOOD_RAIL', 'SPLIT_RAIL', '8'' Round Wood Split Rail', 'EA', 9.5, true, null, ''),
        ('POST', 'LINE_POST', 'SPLIT_RAIL', '5" Round Wood Post, 7''', 'EA', 14, true, null, ''),
        ('POST', 'END_POST', 'SPLIT_RAIL', '5" Round Wood Post, 7''', 'EA', 14, true, null, ''),
        ('POST', 'CORNER_POST', 'SPLIT_RAIL', '5" Round Wood Post, 7''', 'EA', 14, true, null, ''),
        ('POST', 'GATE_POST', 'SPLIT_RAIL', '5" Round Wood Post, 7''', 'EA', 14, true, null, ''),
        ('GATE', 'GATE_FRAME_KIT', 'SPLIT_RAIL', 'Split-Rail Gate Frame Kit, 10''W', 'EA', 95, true, 10, ''),
        ('HARDWARE', 'HINGE_SET', 'SPLIT_RAIL', 'Split-Rail Gate Hinge Set', 'SET', 12, true, null, ''),
        ('HARDWARE', 'LATCH', 'SPLIT_RAIL', 'Split-Rail Gate Latch', 'EA', 7, true, null, ''),
        -- composite (10)
        ('PICKET', 'WOOD_PICKET', 'COMPOSITE', '6'' Composite Privacy Board', 'EA', 9.75, true, null, ''),
        ('RAIL', 'WOOD_RAIL', 'COMPOSITE', 'Composite Rail, 8''', 'EA', 16, true, null, ''),
        ('POST', 'LINE_POST', 'COMPOSITE', '4x4 Composite Post w/ Aluminum Insert, 8''', 'EA', 28, true, null, ''),
        ('POST', 'END_POST', 'COMPOSITE', '4x4 Composite Post w/ Aluminum Insert, 8''', 'EA', 28, true, null, ''),
        ('POST', 'CORNER_POST', 'COMPOSITE', '4x4 Composite Post w/ Aluminum Insert, 8''', 'EA', 28, true, null, ''),
        ('POST', 'GATE_POST', 'COMPOSITE', '4x4 Composite Post w/ Aluminum Insert, 8''', 'EA', 28, true, null, ''),
        ('CAP', 'POST_CAP', 'COMPOSITE', 'Composite Post Cap', 'EA', 5, true, null, ''),
        ('GATE', 'GATE_FRAME_KIT', 'COMPOSITE', 'Composite Gate Frame Kit (up to 4''W)', 'EA', 145, true, 4, ''),
        ('HARDWARE', 'HINGE_SET', 'COMPOSITE', 'Composite Gate Hinge Set', 'SET', 18, true, null, ''),
        ('HARDWARE', 'LATCH', 'COMPOSITE', 'Composite Gate Latch', 'EA', 14, true, null, ''),
        -- universal (2)
        ('CONCRETE', 'CONCRETE_BAG', 'UNIVERSAL', 'Concrete Mix 60lb Bag', 'EA', 4.75, true, null, ''),
        ('MISC', 'HOLE_PLUG', 'UNIVERSAL', '5/8" Hole Plug, White', 'EA', 0.15, true, null, 'White')
      ) as v(category, role, fence_type, name, unit, unit_price, taxable, covers_ft, color_or_finish)
    on conflict (company_id, sync_id) do nothing;

    get diagnostics n = row_count;
    return n;
end;
$function$;

-- 2. THE TRIGGER FUNCTION. Seeds the company that was just created, and can
--    never stop the sign-up that created it: any failure is caught, recorded in
--    app_errors (fatal = false, with the company id, so the admin console shows
--    it) and swallowed. A company left with no catalog is today's behaviour, and
--    the phone now warns about it; a sign-up that fails is a new customer lost.
create or replace function public.companies_seed_catalog_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
    why text;
    st  text;
begin
    begin
        perform public.seed_starting_catalog(new.id);
    exception when others then
        why := sqlerrm;
        st  := sqlstate;
        begin
            insert into public.app_errors (company_id, message, where_at, stack, fatal)
            values (new.id, 'Starting catalog was not seeded: ' || why,
                    'companies_seed_starting_catalog', 'SQLSTATE ' || st, false);
        exception when others then
            raise warning 'Starting catalog was not seeded for company % (% / %), and that could not be logged (%)',
                new.id, st, why, sqlerrm;
        end;
    end;
    return new;
end;
$function$;

-- 3. THE TRIGGER. AFTER INSERT on companies, per row: every path that makes a
--    company goes through it (create_company_with_owner, admin_create_company,
--    and a direct insert by a platform admin), and so will the next one.
create or replace trigger companies_seed_starting_catalog
    after insert on public.companies
    for each row execute function public.companies_seed_catalog_trigger();

-- 4. WHO MAY CALL WHAT. Nobody but the database owner and the trigger.
--    seed_starting_catalog takes ANY company id: left callable, a signed-in
--    stranger could write a catalog into somebody else's empty company.
revoke all on function public.seed_starting_catalog(uuid) from public, anon, authenticated;
revoke all on function public.companies_seed_catalog_trigger() from public, anon, authenticated;

comment on function public.seed_starting_catalog(uuid) is
    'Writes the 92-row starting catalog for one company that has never held a catalog row. Owner and trigger only. supabase_r20_seed_new_company_catalog.sql';
comment on function public.companies_seed_catalog_trigger() is
    'AFTER INSERT on companies: seeds the starting catalog; a failure is logged to app_errors and never blocks the sign-up.';

-- ==== THE CHANGE: END ====

do $probe_after$
declare
  c1 constant uuid := 'a26c0100-0000-4000-8000-000000000001';   -- active, seeded by the trigger on a plain INSERT
  c2 constant uuid := 'a26c0100-0000-4000-8000-000000000002';   -- a second active company (isolation)
  c3 constant uuid := 'a26c0100-0000-4000-8000-000000000003';   -- holds exactly one hand-made row
  c4 constant uuid := 'a26c0100-0000-4000-8000-000000000004';   -- holds only a deleted row
  c5 constant uuid := 'a26c0100-0000-4000-8000-000000000005';   -- empty: the backfill case
  c6 constant uuid := 'a26c0100-0000-4000-8000-000000000006';   -- empty, and left empty: the target of the attacks
  u_web constant uuid := 'a26c0001-0000-4000-8000-000000000001';
  u_staff constant uuid := 'a26c0001-0000-4000-8000-000000000002';
  u_own1 constant uuid := 'a26c0001-0000-4000-8000-000000000003';
  u_crew1 constant uuid := 'a26c0001-0000-4000-8000-000000000004';
  u_own2 constant uuid := 'a26c0001-0000-4000-8000-000000000005';
  u_broken constant uuid := 'a26c0001-0000-4000-8000-000000000006';
  label_hex constant text := '5374617274696e6720707269636520e2809420766572696679207769746820796f757220737570706c696572';
  -- One checksum over every column that matters, the same way in node (tests/a26-catalog-seed.test.mjs) and here.
  canon constant text := $c$select md5(string_agg(concat_ws('|', fence_type, role, category, name, unit, unit_price::text, taxable::text, coalesce(covers_ft::text,''), color_or_finish, source_doc), E'\n' order by fence_type collate "C", role collate "C", name collate "C")) from public.material_items where company_id = '%s'$c$;
  http_n text;
begin
  perform set_config('request.jwt.claims','',true);

  -- ---- fixture: synthetic users and companies (ids a26cxxxx-..., names PROBE-A26C-..., addresses @probe.invalid) ----
  insert into auth.users(id,email) values (u_web,'a26c-web@probe.invalid'),(u_staff,'a26c-staff@probe.invalid'),(u_own1,'a26c-o1@probe.invalid'),(u_crew1,'a26c-c1@probe.invalid'),(u_own2,'a26c-o2@probe.invalid'),(u_broken,'a26c-broken@probe.invalid');
  -- Two active companies made by a plain INSERT: the trigger with no function in front of it.
  insert into public.companies(id,name,subscription_status,subscription_plan,suspended,trial_ends_at) values
    (c1,'PROBE-A26C-ACTIVE-1','active','pro',false,now()+interval '30 days'),
    (c2,'PROBE-A26C-ACTIVE-2','active','pro',false,now()+interval '30 days');
  insert into public.profiles(id,company_id,full_name,role) values
    (u_own1,c1,'A26C Owner 1','OWNER'), (u_crew1,c1,'A26C Crew 1','CREW'), (u_own2,c2,'A26C Owner 2','OWNER');
  -- Four companies the trigger must not seed, built with the trigger switched off, to test the function's own guard.
  execute 'alter table public.companies disable trigger companies_seed_starting_catalog';
  insert into public.companies(id,name,subscription_status,subscription_plan,suspended,trial_ends_at) values
    (c3,'PROBE-A26C-ONE-ROW','active','pro',false,now()+interval '30 days'),
    (c4,'PROBE-A26C-DELETED-ONLY','active','pro',false,now()+interval '30 days'),
    (c5,'PROBE-A26C-EMPTY','active','pro',false,now()+interval '30 days'),
    (c6,'PROBE-A26C-TARGET','active','pro',false,now()+interval '30 days');
  execute 'alter table public.companies enable trigger companies_seed_starting_catalog';
  insert into public.material_items(company_id,sync_id,category,role,fence_type,name,unit,unit_price,source_doc)
    values (c3,'a26c0200-0000-4000-8000-000000000001','CONCRETE','CONCRETE_BAG','UNIVERSAL','Hand-made concrete row','EA',5,'hand-made');
  insert into public.material_items(company_id,sync_id,category,role,fence_type,name,unit,unit_price,source_doc,deleted_at,deleted_by)
    values (c4,'a26c0200-0000-4000-8000-000000000002','CONCRETE','CONCRETE_BAG','UNIVERSAL','Deleted concrete row','EA',5,'hand-made',now(),'a26c');
  -- A platform admin, for the staff path. A failed fixture must SHOW as a failed check, never as a skipped one.
  begin
    insert into public.profiles(id,company_id,full_name,role,is_platform_admin) values (u_staff,null,'A26C Staff','CREW',true);
    insert into r(subject,pair,role,k,got,want) values ('fixture','staff','control','a platform-admin login could be built for the staff path','true','true');
  exception when others then
    insert into r(subject,pair,role,k,got,want) values ('fixture','staff','control','a platform-admin login could be built for the staff path','ERR ' || sqlstate || ': ' || left(sqlerrm,120),'true');
  end;

  -- ---- 1. WHAT A NEW COMPANY GETS, by a plain INSERT ----
  perform pg_temp.s('list','count','probe','company 1 was seeded with the whole list',format($q$select count(*)::text from public.material_items where company_id = '%s'$q$,c1),'92');
  perform pg_temp.s('list','count','control','the reader is not blind: company 3 holds exactly the one row it was given',format($q$select count(*)::text from public.material_items where company_id = '%s'$q$,c3),'1');
  perform pg_temp.s('list','per_type','probe','rows per fence type',format($q$select string_agg(fence_type || '=' || n, ',' order by fence_type collate "C") from (select fence_type, count(*) n from public.material_items where company_id = '%s' group by fence_type) t$q$,c1),'ALUMINUM=14,CHAIN_LINK=18,COMPOSITE=10,ORNAMENTAL_IRON=11,SPLIT_RAIL=8,UNIVERSAL=2,VINYL=19,WOOD=10');
  perform pg_temp.s('list','content','probe','every column of every row is the list: checksum over fence type, role, category, name, unit, price, taxable, covers, colour and label',format(canon,c1),'92f0aa5b0e9bd90c430eed66df2d5f50');
  perform pg_temp.s('list','content','control','the checksum query is live: company 3''s one row gives a checksum',format(canon,c3),'~^[0-9a-f]{32}$');
  perform pg_temp.s('list','content','control','...and it is not the list''s checksum (the query can tell a wrong catalog from the right one)',format($q$select ((%s) <> '92f0aa5b0e9bd90c430eed66df2d5f50')::text$q$,format(canon,c3)),'true');
  perform pg_temp.s('list','label','probe','the label is exactly SeedData.SEEDED, byte for byte (utf-8 hex)',format($q$select string_agg(distinct encode(convert_to(source_doc,'UTF8'),'hex'), ',') from public.material_items where company_id = '%s'$q$,c1),label_hex);
  perform pg_temp.s('list','flags','probe','every row is active, undeleted and linked to no manufacturer or sku',format($q$select (bool_and(is_active) and bool_and(deleted_at is null) and bool_and(manufacturer_sync_id is null) and bool_and(supplier_sku is null) and bool_and(deleted_by = ''))::text from public.material_items where company_id = '%s'$q$,c1),'true');
  perform pg_temp.s('list','tax','probe','no row is untaxed (the four rows the phone and office lists carry as false are seeded true: see the header)',format($q$select count(*) filter (where not taxable)::text from public.material_items where company_id = '%s'$q$,c1),'0');
  perform pg_temp.s('list','ids','probe','92 distinct sync ids in one company',format($q$select count(distinct sync_id)::text from public.material_items where company_id = '%s'$q$,c1),'92');
  perform pg_temp.s('list','ids','probe','...and none is shared with another company (184 across two)',format($q$select count(distinct sync_id)::text from public.material_items where company_id in ('%s','%s')$q$,c1,c2),'184');
  perform pg_temp.s('list','ids','probe','a row''s id is derived from its company and the row, so the same call always makes the same ids',format($q$select (sync_id = md5(company_id::text || ':starting-catalog:' || fence_type || ':' || role || ':' || name)::uuid)::text from public.material_items where company_id = '%s' and name = 'Concrete Mix 60lb Bag'$q$,c1),'true');

  -- ---- 2. THE FUNCTION'S OWN GUARD ----
  perform pg_temp.s('guard','idempotent','probe','calling it again for a seeded company writes nothing',format($q$select public.seed_starting_catalog('%s')::text$q$,c1),'0');
  perform pg_temp.s('guard','idempotent','readback','...and the catalog is still 92',format($q$select count(*)::text from public.material_items where company_id = '%s'$q$,c1),'92');
  perform pg_temp.s('guard','one_row','probe','a company that already holds a row of its own is never mixed with the list',format($q$select public.seed_starting_catalog('%s')::text$q$,c3),'0');
  perform pg_temp.s('guard','one_row','readback','...it still has its one row',format($q$select count(*)::text from public.material_items where company_id = '%s'$q$,c3),'1');
  perform pg_temp.s('guard','deleted_only','probe','a company that deleted its whole catalog is not given it back',format($q$select public.seed_starting_catalog('%s')::text$q$,c4),'0');
  perform pg_temp.s('guard','deleted_only','readback','...it still has only its deleted row',format($q$select count(*) filter (where deleted_at is not null)::text || '/' || count(*)::text from public.material_items where company_id = '%s'$q$,c4),'1/1');
  perform pg_temp.s('guard','no_such_company','probe','an id that is not a company writes nothing and does not error',$q$select public.seed_starting_catalog('a26c9999-0000-4000-8000-000000000000')::text$q$,'0');
  perform pg_temp.s('guard','null','probe','null writes nothing and does not error',$q$select public.seed_starting_catalog(null)::text$q$,'0');
  perform pg_temp.s('backfill','empty_company','control','an existing company with no rows (what PART 4 would run for) starts at zero',format($q$select count(*)::text from public.material_items where company_id = '%s'$q$,c5),'0');
  perform pg_temp.s('backfill','empty_company','probe','...PART 4''s call gives it the whole list',format($q$select public.seed_starting_catalog('%s')::text$q$,c5),'92');
  perform pg_temp.s('backfill','empty_company','readback','...identical, column for column, to a company seeded at creation',format(canon,c5),'92f0aa5b0e9bd90c430eed66df2d5f50');
  perform pg_temp.s('backfill','empty_company','probe','...and running it a second time writes nothing',format($q$select public.seed_starting_catalog('%s')::text$q$,c5),'0');

  -- ---- 3. THE TWO REAL WAYS A COMPANY IS MADE, called as the people who call them ----
  perform pg_temp.q('sign-up','web_and_phone','probe','a signed-in stranger with no company signs up (create_company_with_owner), exactly as the website and the phone call it',u_web,$q$select public.create_company_with_owner('PROBE-A26C-WEB','A26C Web')::text$q$,'~^[0-9a-f]{8}-[0-9a-f]{4}-','web_company');
  perform pg_temp.s('sign-up','web_and_phone','readback','...the new company has the whole list',$q$select count(*)::text from public.material_items where company_id = current_setting('a26c.web_company')::uuid$q$,'92');
  perform pg_temp.s('sign-up','web_and_phone','readback','...exactly the list',format(canon,current_setting('a26c.web_company')),'92f0aa5b0e9bd90c430eed66df2d5f50');
  perform pg_temp.s('sign-up','web_and_phone','readback','...and the sign-up itself is unchanged: the caller is its OWNER, the company is pending and not allowed',$q$select ((select role::text from public.profiles where id = 'a26c0001-0000-4000-8000-000000000001') || '/' || c.subscription_status || '/' || public.company_allowed(c.id)::text) from public.companies c where c.id = current_setting('a26c.web_company')::uuid$q$,'OWNER/pending/false');
  perform pg_temp.q('sign-up','pending_lock','probe','...and until it has a plan its owner reads none of it through the tables (the plan lock is unchanged)',u_web,$q$select count(*)::text from public.material_items$q$,'0');

  perform pg_temp.q('staff','admin_create_company','probe','a platform admin creates a company for a contractor (admin_create_company), exactly as the staff console calls it',u_staff,$q$select company_id::text from public.admin_create_company('PROBE-A26C-STAFF','a26c-staff@probe.invalid')$q$,'~^[0-9a-f]{8}-[0-9a-f]{4}-','staff_company');
  perform pg_temp.s('staff','admin_create_company','readback','...the new company has the whole list',$q$select count(*)::text from public.material_items where company_id = current_setting('a26c.staff_company')::uuid$q$,'92');
  perform pg_temp.s('staff','admin_create_company','readback','...exactly the list',format(canon,current_setting('a26c.staff_company')),'92f0aa5b0e9bd90c430eed66df2d5f50');
  perform pg_temp.q('staff','not_admin','control','an ordinary signed-in user still cannot create a company for somebody (unchanged)',u_own2,$q$select company_id::text from public.admin_create_company('PROBE-A26C-NOT-ADMIN','x@probe.invalid')$q$,'ERR P0001');
  perform pg_temp.s('staff','not_admin','readback','...and no company was made by that attempt',$q$select count(*)::text from public.companies where name = 'PROBE-A26C-NOT-ADMIN'$q$,'0');

  -- ---- 4. WHO MAY CALL WHAT ----
  perform pg_temp.s('surface','grants','control','the grant reader is live: a signed-in user can execute create_company_with_owner',$q$select has_function_privilege('authenticated','public.create_company_with_owner(text,text)','execute')::text$q$,'true');
  perform pg_temp.s('surface','grants','probe','the anonymous role cannot execute seed_starting_catalog',$q$select has_function_privilege('anon','public.seed_starting_catalog(uuid)','execute')::text$q$,'false');
  perform pg_temp.s('surface','grants','probe','a signed-in user cannot execute seed_starting_catalog',$q$select has_function_privilege('authenticated','public.seed_starting_catalog(uuid)','execute')::text$q$,'false');
  perform pg_temp.s('surface','grants','probe','...nor the trigger function (anonymous)',$q$select has_function_privilege('anon','public.companies_seed_catalog_trigger()','execute')::text$q$,'false');
  perform pg_temp.s('surface','grants','probe','...nor the trigger function (signed in)',$q$select has_function_privilege('authenticated','public.companies_seed_catalog_trigger()','execute')::text$q$,'false');
  perform pg_temp.q('attack','seed_someone_else','probe','company 2''s owner tries to write the list into an empty company that is not theirs',u_own2,format($q$select public.seed_starting_catalog('%s')::text$q$,c6),'ERR 42501');
  perform pg_temp.q('attack','seed_someone_else','probe','the anonymous key tries the same',null::uuid,format($q$select public.seed_starting_catalog('%s')::text$q$,c6),'ERR 42501');
  perform pg_temp.q('attack','seed_someone_else','probe','a signed-in user calls the trigger function directly',u_own2,$q$select public.companies_seed_catalog_trigger()::text$q$,'ERR 42501');
  perform pg_temp.s('attack','seed_someone_else','readback','...and the target is still empty (control: the same call as the database owner, above, does fill an empty company)',format($q$select count(*)::text from public.material_items where company_id = '%s'$q$,c6),'0');

  -- ---- 5. THE RULES THAT HELD, with the new rows present ----
  perform pg_temp.q('rules','owner_reads','control','company 1''s owner reads its own 92 rows and nobody else''s (several other seeded companies are in the table)',u_own1,$q$select count(*)::text from public.material_items$q$,'92');
  perform pg_temp.q('rules','tenant','probe','company 2''s owner reads none of company 1''s rows',u_own2,format($q$select count(*)::text from public.material_items where company_id = '%s'$q$,c1),'0');
  perform pg_temp.q('rules','tenant','control','...but reads its own',u_own2,format($q$select count(*)::text from public.material_items where company_id = '%s'$q$,c2),'92');
  perform pg_temp.q('rules','crew_no_money','probe','company 1''s crew member reads none of the seeded prices',u_crew1,$q$select count(*)::text from public.material_items$q$,'0');
  perform pg_temp.x('rules','crew_no_delete','probe','...cannot delete any of them',u_crew1,format($q$delete from public.material_items where company_id = '%s'$q$,c1),'rows=0|ERR 42501');
  perform pg_temp.x('rules','crew_no_delete','probe','...cannot soft-delete any of them either',u_crew1,format($q$update public.material_items set deleted_at = now() where company_id = '%s'$q$,c1),'rows=0|ERR 42501');
  perform pg_temp.x('rules','crew_no_delete','probe','...or change a price',u_crew1,format($q$update public.material_items set unit_price = 0 where company_id = '%s'$q$,c1),'rows=0|ERR 42501');
  perform pg_temp.s('rules','crew_no_delete','readback','...and company 1''s list is exactly as it was seeded',format(canon,c1),'92f0aa5b0e9bd90c430eed66df2d5f50');
  perform pg_temp.s('rules','crew_no_delete','readback','...with nothing deleted',format($q$select count(*) filter (where deleted_at is not null)::text from public.material_items where company_id = '%s'$q$,c1),'0');

  -- ---- 6. WHAT DID NOT MOVE ----
  perform pg_temp.s('unchanged','policies','control','no row-level-security policy anywhere in the database changed',$q$select ((select md5(coalesce(string_agg(md5(concat_ws('|',schemaname,tablename,policyname,cmd,roles::text,qual,with_check)), ',' order by schemaname,tablename,policyname),'')) from pg_policies) = (select v from snap where k='policies'))::text$q$,'true');
  perform pg_temp.s('unchanged','relacls','control','no table, view or sequence privilege in public changed',$q$select ((select md5(coalesce(string_agg(c.relname||':'||coalesce(c.relacl::text,''), ',' order by c.relname),'')) from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','v','m','p','S')) = (select v from snap where k='relacls'))::text$q$,'true');
  perform pg_temp.s('unchanged','creators','control','both creators, the other three doors into a company, join_company and the access helpers are byte for byte what they were',$q$select ((select md5(coalesce(string_agg(p.oid::regprocedure::text||md5(p.prosrc), ',' order by p.oid::regprocedure::text),'')) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('create_company_with_owner','admin_create_company','claim_company_setup','claim_invited_company','join_company','company_allowed','company_is_suspended','has_permission')) = (select v from snap where k='creators'))::text$q$,'true');
  perform pg_temp.s('unchanged','triggers','control','the triggers on material_items are the same three',$q$select ((select md5(coalesce(string_agg(t.tgname||':'||t.tgenabled::text||':'||t.tgtype::text, ',' order by t.tgname),'')) from pg_trigger t where t.tgrelid='public.material_items'::regclass and not t.tgisinternal) = (select v from snap where k='mi_triggers'))::text$q$,'true');
  perform pg_temp.s('unchanged','triggers','control','...and the triggers on companies are the same ones, plus ours',$q$select ((select md5(coalesce(string_agg(t.tgname||':'||t.tgenabled::text||':'||t.tgtype::text, ',' order by t.tgname),'')) from pg_trigger t where t.tgrelid='public.companies'::regclass and not t.tgisinternal and t.tgname <> 'companies_seed_starting_catalog') = (select v from snap where k='company_triggers'))::text$q$,'true');
  perform pg_temp.s('unchanged','existing_companies','probe','no company that existed before was given a single row (per-company counts, checksummed)',$q$select ((select md5(coalesce(string_agg(c.id::text||':'||(select count(*) from public.material_items m where m.company_id=c.id)::text, ',' order by c.id),'')) from public.companies c where c.name not like 'PROBE-A26C-%') = (select v from snap where k='per_company'))::text$q$,'true');
  perform pg_temp.s('unchanged','existing_companies','control','...and the same set of companies is being compared',$q$select ((select count(*) from public.companies where name not like 'PROBE-A26C-%')::text = (select v from snap where k='companies_n'))::text$q$,'true');
  begin
    select count(*)::text into http_n from net.http_request_queue;
  exception when others then http_n := 'none'; end;
  perform pg_temp.s('unchanged','http_queue','control','no outbound HTTP call was queued by any of it',format($q$select ('%s' = (select v from snap where k='http_queue'))::text$q$,http_n),'true');
  perform pg_temp.s('surface','trigger','control','exactly one trigger, AFTER INSERT, per row, on companies, enabled',$q$select (count(*) = 1 and bool_and(pg_get_triggerdef(t.oid) ~ 'AFTER INSERT ON public.companies FOR EACH ROW EXECUTE FUNCTION') and bool_and(t.tgenabled = 'O'))::text from pg_trigger t where t.tgrelid='public.companies'::regclass and t.tgname='companies_seed_starting_catalog' and not t.tgisinternal$q$,'true');
  perform pg_temp.s('surface','definer','control','both functions are SECURITY DEFINER with the search path pinned and pg_temp last',$q$select (count(*) = 2 and bool_and(p.prosecdef) and bool_and(exists (select 1 from unnest(p.proconfig) c where c ~ '^search_path=public, pg_temp$')))::text from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('seed_starting_catalog','companies_seed_catalog_trigger')$q$,'true');

  -- ---- 7. A FAILURE OF THE SEED MUST NEVER STOP A SIGN-UP (last: it replaces the function inside this transaction) ----
  perform pg_temp.s('failure','control','control','the earlier successful sign-up logged no seeding error (so a row below can only come from the planted failure)',format($q$select count(*)::text from public.app_errors where company_id = '%s'$q$,current_setting('a26c.web_company')),'0');
  execute $e$create or replace function public.seed_starting_catalog(p_company_id uuid) returns integer language plpgsql security definer set search_path = public, pg_temp as $f$ begin raise exception 'A26C planted failure'; end $f$$e$;
  perform pg_temp.q('failure','sign_up_survives','probe','with the seed made to fail, a stranger still signs up',u_broken,$q$select public.create_company_with_owner('PROBE-A26C-BROKEN','A26C Broken')::text$q$,'~^[0-9a-f]{8}-[0-9a-f]{4}-','broken_company');
  perform pg_temp.s('failure','sign_up_survives','readback','...the company exists and its caller is its OWNER',$q$select ((select count(*) from public.companies where id = current_setting('a26c.broken_company')::uuid)::text || '/' || (select role::text from public.profiles where id = 'a26c0001-0000-4000-8000-000000000006')) $q$,'1/OWNER');
  perform pg_temp.s('failure','sign_up_survives','readback','...with no catalog (the state the phone now warns about)',$q$select count(*)::text from public.material_items where company_id = current_setting('a26c.broken_company')::uuid$q$,'0');
  perform pg_temp.s('failure','sign_up_survives','readback','...and the failure was written to app_errors, not fatal, naming the company, where the admin console will show it',$q$select count(*)::text from public.app_errors where company_id = current_setting('a26c.broken_company')::uuid and fatal = false and message like 'Starting catalog was not seeded: A26C planted failure%' and where_at = 'companies_seed_starting_catalog'$q$,'1');
end $probe_after$;

select n, subject, pair, role, k, got, want, case when pg_temp.ok(got, want) then 'PASS' else 'FAIL' end as result from r
union all
select 1000000, 'SUMMARY', '-', '-', 'passed/total',
       (select count(*) filter (where pg_temp.ok(got, want))::text || '/' || count(*)::text from r), '-', '-'
 order by 1;

rollback;

-- =============================================================================
-- PART 2 -- APPLY.  To apply: delete the line "/* PART 2 BEGINS" and the line
-- "PART 2 ENDS */", run this block alone, then put both lines back. It creates
-- two functions and one trigger. It writes no row into any existing company.
-- =============================================================================

/* PART 2 BEGINS
begin;
set local lock_timeout = '5s';

-- ==== THE CHANGE: BEGIN ====
-- 1. THE LIST, AND THE GUARD. One function that writes the starting list for one
--    company, and only if that company has never held a catalog row (live or
--    deleted). Row identity is an md5 uuid of company + fence type + role + name,
--    so the same call always makes the same rows and ON CONFLICT DO NOTHING makes
--    a second call harmless even if the guard were ever removed. Every table is
--    schema-qualified and pg_temp is last on the search path, so a caller cannot
--    stand a temp table in front of a real one. It returns the rows written.
create or replace function public.seed_starting_catalog(p_company_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
    n integer;
begin
    if p_company_id is null then
        return 0;
    end if;
    if not exists (select 1 from public.companies c where c.id = p_company_id) then
        return 0;
    end if;
    -- Any row at all, live or deleted. A company that deleted its catalog on
    -- purpose is not handed it back, and one with rows is never mixed with the list.
    if exists (select 1 from public.material_items m where m.company_id = p_company_id) then
        return 0;
    end if;

    insert into public.material_items
        (company_id, sync_id, category, role, fence_type, name, unit, unit_price,
         taxable, covers_ft, color_or_finish, source_doc)
    select p_company_id,
           md5(p_company_id::text || ':starting-catalog:' || v.fence_type || ':' || v.role || ':' || v.name)::uuid,
           v.category, v.role, v.fence_type, v.name, v.unit, v.unit_price,
           v.taxable, v.covers_ft, v.color_or_finish,
           'Starting price — verify with your supplier'
      from (values
        -- vinyl (19)
        ('PANEL', 'PANEL', 'VINYL', 'Panel T&G Vinyl Privacy 6''H x 6''W - White', 'EA', 52.35, true, 6, 'White'),  -- taxable = true here; the phone and office lists say false (see the header)
        ('PANEL', 'PANEL', 'VINYL', 'Panel T&G Vinyl Privacy 6''H x 8''W - White', 'EA', 71.4, true, 8, 'White'),
        ('POST', 'LINE_POST', 'VINYL', '5"x5" Co-Ex Line Post, White', 'EA', 16.56, true, null, 'White'),
        ('POST', 'END_POST', 'VINYL', '5"x5" Co-Ex End Post, White', 'EA', 16.56, true, null, 'White'),
        ('POST', 'CORNER_POST', 'VINYL', '5"x5" Co-Ex Corner Post, White', 'EA', 16.56, true, null, 'White'),
        ('POST', 'GATE_POST', 'VINYL', '5"x5" Co-Ex Gate Post, White', 'EA', 16.56, true, null, 'White'),
        ('CAP', 'POST_CAP', 'VINYL', '5" External Pyramid PVC Post Cap, White', 'EA', 0.74, true, null, 'White'),
        ('GATE', 'GATE_PANEL', 'VINYL', 'Regular PVC Gate 6''H x 5''W, White', 'EA', 145.05, true, 5, 'White'),  -- taxable = true here; the phone and office lists say false (see the header)
        ('HARDWARE', 'HINGE_SET', 'VINYL', 'Self-Closing Hinge Set (box, 12 pairs)', 'BOX', 32.25, true, null, 'White'),
        ('HARDWARE', 'LATCH', 'VINYL', 'Two-Way Latch (box of 20)', 'BOX', 25.87, true, null, 'Black'),
        ('HARDWARE', 'HANDLE', 'VINYL', '7" SS Gate Handle (box of 50)', 'BOX', 5, true, null, 'Black'),
        ('HARDWARE', 'BRACE', 'VINYL', 'Gate Support Brace, 8''', 'EA', 6.5, true, null, 'White'),
        ('HARDWARE', 'STIFFENER', 'VINYL', '5" Econo Stiffener x 8''(H)', 'EA', 52.75, true, null, ''),
        ('TRIM', 'TRIM', 'VINYL', '7/8 x 1-1/2 x 62 1/4 Trim U-Channel, White', 'EA', 2, true, null, 'White'),
        ('PANEL', 'PANEL', 'VINYL', 'Panel T&G Vinyl Privacy 6''H x 6''W - Tan', 'EA', 54.5, true, 6, 'Tan'),  -- taxable = true here; the phone and office lists say false (see the header)
        ('PANEL', 'PANEL', 'VINYL', 'Panel T&G Vinyl Privacy 6''H x 6''W - Gray', 'EA', 54.5, true, 6, 'Gray'),  -- taxable = true here; the phone and office lists say false (see the header)
        ('PANEL', 'PANEL', 'VINYL', 'Panel T&G Vinyl Privacy 6''H x 8''W - Tan', 'EA', 73.9, true, 8, 'Tan'),
        ('POST', 'LINE_POST', 'VINYL', '5"x5" Co-Ex Line Post, Tan', 'EA', 17.25, true, null, 'Tan'),
        ('POST', 'LINE_POST', 'VINYL', '5"x5" Co-Ex Line Post, Gray', 'EA', 17.25, true, null, 'Gray'),
        -- wood (10)
        ('PICKET', 'WOOD_PICKET', 'WOOD', '6'' Dog-Ear Wood Picket, Pressure-Treated Pine', 'EA', 3.25, true, null, ''),
        ('RAIL', 'WOOD_RAIL', 'WOOD', '2x4x8'' Pressure-Treated Rail', 'EA', 6.5, true, null, ''),
        ('POST', 'LINE_POST', 'WOOD', '4x4x8'' Pressure-Treated Post', 'EA', 9.5, true, null, ''),
        ('POST', 'END_POST', 'WOOD', '4x4x8'' Pressure-Treated Post', 'EA', 9.5, true, null, ''),
        ('POST', 'CORNER_POST', 'WOOD', '4x4x8'' Pressure-Treated Post', 'EA', 9.5, true, null, ''),
        ('POST', 'GATE_POST', 'WOOD', '4x4x8'' Pressure-Treated Post', 'EA', 9.5, true, null, ''),
        ('CAP', 'POST_CAP', 'WOOD', '4x4 Wood Post Cap', 'EA', 2.25, true, null, ''),
        ('GATE', 'GATE_FRAME_KIT', 'WOOD', 'Wood Gate Frame Kit, Steel-Reinforced (up to 4''W)', 'EA', 65, true, 4, ''),
        ('HARDWARE', 'HINGE_SET', 'WOOD', 'Heavy-Duty T-Hinge Pair', 'PAIR', 14, true, null, ''),
        ('HARDWARE', 'LATCH', 'WOOD', 'Wood Gate Latch', 'EA', 9, true, null, ''),
        -- chain link (18)
        ('FABRIC', 'CHAIN_FABRIC', 'CHAIN_LINK', 'Galvanized Chain Link Fabric, 4'' (per LF)', 'LF', 3.1, true, 4, ''),
        ('FABRIC', 'CHAIN_FABRIC', 'CHAIN_LINK', 'Galvanized Chain Link Fabric, 6'' (per LF)', 'LF', 4.35, true, 6, ''),
        ('FABRIC', 'CHAIN_FABRIC', 'CHAIN_LINK', 'Galvanized Chain Link Fabric, 8'' (per LF)', 'LF', 5.6, true, 8, ''),
        ('RAIL', 'TOP_RAIL', 'CHAIN_LINK', '1-3/8" Top Rail (per LF)', 'LF', 2.1, true, null, ''),
        ('MISC', 'TENSION_WIRE', 'CHAIN_LINK', '7-Gauge Bottom Tension Wire (per LF)', 'LF', 0.55, true, null, ''),
        ('POST', 'LINE_POST', 'CHAIN_LINK', '1-5/8" Galvanized Line Post, 8''', 'EA', 11.5, true, null, ''),
        ('POST', 'END_POST', 'CHAIN_LINK', '2" Galvanized Terminal Post, 8''', 'EA', 19.75, true, null, ''),
        ('POST', 'CORNER_POST', 'CHAIN_LINK', '2" Galvanized Terminal Post, 8''', 'EA', 19.75, true, null, ''),
        ('POST', 'GATE_POST', 'CHAIN_LINK', '2" Galvanized Terminal Post, 8''', 'EA', 19.75, true, null, ''),
        ('CAP', 'POST_CAP', 'CHAIN_LINK', 'Line Post Cap', 'EA', 1.1, true, null, ''),
        ('HARDWARE', 'TENSION_BAND', 'CHAIN_LINK', 'Tension Band', 'EA', 1.05, true, null, ''),
        ('HARDWARE', 'BRACE_BAND', 'CHAIN_LINK', 'Brace Band', 'EA', 1.35, true, null, ''),
        ('HARDWARE', 'RAIL_END', 'CHAIN_LINK', 'Rail End Cup', 'EA', 1.6, true, null, ''),
        ('HARDWARE', 'BARBED_WIRE_ARM', 'CHAIN_LINK', '3-Strand Barbed Wire Arm', 'EA', 8.75, true, null, ''),
        ('FABRIC', 'PRIVACY_SLAT', 'CHAIN_LINK', 'Privacy Slats (per LF)', 'LF', 2.9, true, null, ''),
        ('GATE', 'GATE_FRAME_KIT', 'CHAIN_LINK', 'Chain Link Walk Gate Frame, 4''W, Galvanized', 'EA', 85, true, 4, ''),
        ('HARDWARE', 'HINGE_SET', 'CHAIN_LINK', 'Chain Link Gate Hinge Set', 'SET', 12.5, true, null, ''),
        ('HARDWARE', 'LATCH', 'CHAIN_LINK', 'Chain Link Fork Latch', 'EA', 9.75, true, null, ''),
        -- aluminum (14)
        ('PANEL', 'PANEL', 'ALUMINUM', 'Aluminum Fence Panel 6''H x 6''W, Rackable, Black', 'EA', 95, true, 6, 'Black'),
        ('PANEL', 'PANEL', 'ALUMINUM', 'Aluminum Fence Panel 6''H x 8''W, Rackable, Black', 'EA', 118, true, 8, 'Black'),
        ('POST', 'LINE_POST', 'ALUMINUM', '3" Aluminum Post, 6'', Black', 'EA', 22, true, null, 'Black'),
        ('POST', 'END_POST', 'ALUMINUM', '3" Aluminum Post, 6'', Black', 'EA', 22, true, null, 'Black'),
        ('POST', 'CORNER_POST', 'ALUMINUM', '3" Aluminum Post, 6'', Black', 'EA', 22, true, null, 'Black'),
        ('POST', 'GATE_POST', 'ALUMINUM', '3" Aluminum Post, 6'', Black', 'EA', 22, true, null, 'Black'),
        ('CAP', 'POST_CAP', 'ALUMINUM', 'Aluminum Post Cap, Flat, Black', 'EA', 3.5, true, null, 'Black'),
        ('GATE', 'GATE_PANEL', 'ALUMINUM', 'Aluminum Walk Gate 6''H x 4''W, Black', 'EA', 175, true, 4, 'Black'),
        ('HARDWARE', 'HINGE_SET', 'ALUMINUM', 'Aluminum Gate Hinge Set, Self-Closing', 'SET', 28, true, null, ''),
        ('HARDWARE', 'LATCH', 'ALUMINUM', 'Aluminum Gate Latch, Self-Latching', 'EA', 22, true, null, ''),
        ('PANEL', 'PANEL', 'ALUMINUM', 'Aluminum Fence Panel 6''H x 6''W, Rackable, White', 'EA', 99, true, 6, 'White'),
        ('PANEL', 'PANEL', 'ALUMINUM', 'Aluminum Fence Panel 6''H x 6''W, Rackable, Bronze', 'EA', 99, true, 6, 'Bronze'),
        ('POST', 'LINE_POST', 'ALUMINUM', '3" Aluminum Post, 6'', White', 'EA', 23, true, null, 'White'),
        ('POST', 'LINE_POST', 'ALUMINUM', '3" Aluminum Post, 6'', Bronze', 'EA', 23, true, null, 'Bronze'),
        -- ornamental iron (11)
        ('PANEL', 'PANEL', 'ORNAMENTAL_IRON', 'Ornamental Steel Panel 4''H x 6''W, Black', 'EA', 135, true, 6, 'Black'),
        ('PANEL', 'PANEL', 'ORNAMENTAL_IRON', 'Ornamental Steel Panel 4''H x 8''W, Black', 'EA', 165, true, 8, 'Black'),
        ('PANEL', 'PANEL', 'ORNAMENTAL_IRON', 'Ornamental Steel Panel 6''H x 6''W, Black', 'EA', 175, true, 6, 'Black'),
        ('POST', 'LINE_POST', 'ORNAMENTAL_IRON', '4"x4" Steel Post, 6'', Black', 'EA', 32, true, null, 'Black'),
        ('POST', 'END_POST', 'ORNAMENTAL_IRON', '4"x4" Steel Post, 6'', Black', 'EA', 32, true, null, 'Black'),
        ('POST', 'CORNER_POST', 'ORNAMENTAL_IRON', '4"x4" Steel Post, 6'', Black', 'EA', 32, true, null, 'Black'),
        ('POST', 'GATE_POST', 'ORNAMENTAL_IRON', '4"x4" Steel Post, 6'', Black', 'EA', 32, true, null, 'Black'),
        ('CAP', 'POST_CAP', 'ORNAMENTAL_IRON', 'Ornamental Post Cap, Black', 'EA', 6, true, null, 'Black'),
        ('GATE', 'GATE_PANEL', 'ORNAMENTAL_IRON', 'Ornamental Steel Walk Gate 4''H x 4''W, Black', 'EA', 210, true, 4, 'Black'),
        ('HARDWARE', 'HINGE_SET', 'ORNAMENTAL_IRON', 'Heavy Iron Gate Hinge Set', 'SET', 24, true, null, ''),
        ('HARDWARE', 'LATCH', 'ORNAMENTAL_IRON', 'Self-Latching Iron Gate Latch', 'EA', 19, true, null, ''),
        -- split rail (8)
        ('RAIL', 'WOOD_RAIL', 'SPLIT_RAIL', '8'' Round Wood Split Rail', 'EA', 9.5, true, null, ''),
        ('POST', 'LINE_POST', 'SPLIT_RAIL', '5" Round Wood Post, 7''', 'EA', 14, true, null, ''),
        ('POST', 'END_POST', 'SPLIT_RAIL', '5" Round Wood Post, 7''', 'EA', 14, true, null, ''),
        ('POST', 'CORNER_POST', 'SPLIT_RAIL', '5" Round Wood Post, 7''', 'EA', 14, true, null, ''),
        ('POST', 'GATE_POST', 'SPLIT_RAIL', '5" Round Wood Post, 7''', 'EA', 14, true, null, ''),
        ('GATE', 'GATE_FRAME_KIT', 'SPLIT_RAIL', 'Split-Rail Gate Frame Kit, 10''W', 'EA', 95, true, 10, ''),
        ('HARDWARE', 'HINGE_SET', 'SPLIT_RAIL', 'Split-Rail Gate Hinge Set', 'SET', 12, true, null, ''),
        ('HARDWARE', 'LATCH', 'SPLIT_RAIL', 'Split-Rail Gate Latch', 'EA', 7, true, null, ''),
        -- composite (10)
        ('PICKET', 'WOOD_PICKET', 'COMPOSITE', '6'' Composite Privacy Board', 'EA', 9.75, true, null, ''),
        ('RAIL', 'WOOD_RAIL', 'COMPOSITE', 'Composite Rail, 8''', 'EA', 16, true, null, ''),
        ('POST', 'LINE_POST', 'COMPOSITE', '4x4 Composite Post w/ Aluminum Insert, 8''', 'EA', 28, true, null, ''),
        ('POST', 'END_POST', 'COMPOSITE', '4x4 Composite Post w/ Aluminum Insert, 8''', 'EA', 28, true, null, ''),
        ('POST', 'CORNER_POST', 'COMPOSITE', '4x4 Composite Post w/ Aluminum Insert, 8''', 'EA', 28, true, null, ''),
        ('POST', 'GATE_POST', 'COMPOSITE', '4x4 Composite Post w/ Aluminum Insert, 8''', 'EA', 28, true, null, ''),
        ('CAP', 'POST_CAP', 'COMPOSITE', 'Composite Post Cap', 'EA', 5, true, null, ''),
        ('GATE', 'GATE_FRAME_KIT', 'COMPOSITE', 'Composite Gate Frame Kit (up to 4''W)', 'EA', 145, true, 4, ''),
        ('HARDWARE', 'HINGE_SET', 'COMPOSITE', 'Composite Gate Hinge Set', 'SET', 18, true, null, ''),
        ('HARDWARE', 'LATCH', 'COMPOSITE', 'Composite Gate Latch', 'EA', 14, true, null, ''),
        -- universal (2)
        ('CONCRETE', 'CONCRETE_BAG', 'UNIVERSAL', 'Concrete Mix 60lb Bag', 'EA', 4.75, true, null, ''),
        ('MISC', 'HOLE_PLUG', 'UNIVERSAL', '5/8" Hole Plug, White', 'EA', 0.15, true, null, 'White')
      ) as v(category, role, fence_type, name, unit, unit_price, taxable, covers_ft, color_or_finish)
    on conflict (company_id, sync_id) do nothing;

    get diagnostics n = row_count;
    return n;
end;
$function$;

-- 2. THE TRIGGER FUNCTION. Seeds the company that was just created, and can
--    never stop the sign-up that created it: any failure is caught, recorded in
--    app_errors (fatal = false, with the company id, so the admin console shows
--    it) and swallowed. A company left with no catalog is today's behaviour, and
--    the phone now warns about it; a sign-up that fails is a new customer lost.
create or replace function public.companies_seed_catalog_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
    why text;
    st  text;
begin
    begin
        perform public.seed_starting_catalog(new.id);
    exception when others then
        why := sqlerrm;
        st  := sqlstate;
        begin
            insert into public.app_errors (company_id, message, where_at, stack, fatal)
            values (new.id, 'Starting catalog was not seeded: ' || why,
                    'companies_seed_starting_catalog', 'SQLSTATE ' || st, false);
        exception when others then
            raise warning 'Starting catalog was not seeded for company % (% / %), and that could not be logged (%)',
                new.id, st, why, sqlerrm;
        end;
    end;
    return new;
end;
$function$;

-- 3. THE TRIGGER. AFTER INSERT on companies, per row: every path that makes a
--    company goes through it (create_company_with_owner, admin_create_company,
--    and a direct insert by a platform admin), and so will the next one.
create or replace trigger companies_seed_starting_catalog
    after insert on public.companies
    for each row execute function public.companies_seed_catalog_trigger();

-- 4. WHO MAY CALL WHAT. Nobody but the database owner and the trigger.
--    seed_starting_catalog takes ANY company id: left callable, a signed-in
--    stranger could write a catalog into somebody else's empty company.
revoke all on function public.seed_starting_catalog(uuid) from public, anon, authenticated;
revoke all on function public.companies_seed_catalog_trigger() from public, anon, authenticated;

comment on function public.seed_starting_catalog(uuid) is
    'Writes the 92-row starting catalog for one company that has never held a catalog row. Owner and trigger only. supabase_r20_seed_new_company_catalog.sql';
comment on function public.companies_seed_catalog_trigger() is
    'AFTER INSERT on companies: seeds the starting catalog; a failure is logged to app_errors and never blocks the sign-up.';

-- ==== THE CHANGE: END ====

commit;
PART 2 ENDS */

-- =============================================================================
-- PART 3 -- REVERSE.  Same way: delete "/* PART 3 BEGINS" and "PART 3 ENDS */".
-- Deletes no data. Catalog rows already written stay with their companies.
-- =============================================================================

/* PART 3 BEGINS
begin;
set local lock_timeout = '5s';
drop trigger if exists companies_seed_starting_catalog on public.companies;
drop function if exists public.companies_seed_catalog_trigger();
drop function if exists public.seed_starting_catalog(uuid);
commit;
PART 3 ENDS */

-- =============================================================================
-- PART 4 -- BACKFILL, a separate decision. Requires PART 2 first (it calls the
-- function PART 2 creates). It names no company: you choose the ids.
-- Delete "/* PART 4 BEGINS" and "PART 4 ENDS */" to run it, then put them back.
-- Each company that has never held a catalog row gets the 92 rows; any company
-- that has held one is skipped by the function itself, so a wrong id is harmless.
-- Rows written carry the same "Starting price" label: nothing is marked checked.
-- =============================================================================

/* PART 4 BEGINS
-- (a) read-only: the companies that hold no catalog row at all today.
select c.id, c.name, c.subscription_status, c.subscription_plan, c.created_at::date as created,
       (select count(*) from public.profiles p where p.company_id = c.id) as logins,
       (select count(*) from public.jobs j where j.company_id = c.id and j.deleted_at is null) as live_jobs
  from public.companies c
 where not exists (select 1 from public.material_items m where m.company_id = c.id)
 order by c.created_at;

-- (b) run it for the ones you choose. Replace the placeholders with ids from (a).
begin;
select c.name, public.seed_starting_catalog(c.id) as rows_written
  from public.companies c
 where c.id in ('<company id from (a)>', '<company id from (a)>');
commit;
PART 4 ENDS */
