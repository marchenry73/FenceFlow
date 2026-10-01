-- supabase_r16_test_fixture_inventory.sql
--
-- ############################################################################
-- #  STATUS: NOT APPLIED.  Nothing in this file has been run against any     #
-- #  database as a change.  It is an INVENTORY plus PROPOSED changes, written #
-- #  2026-09-29 by the test-fixture containment audit.                        #
-- #                                                                           #
-- #  The whole file is ONE transaction that ends in ROLLBACK, so running it   #
-- #  by accident (SQL editor, psql -f, supabase db query -f) changes          #
-- #  nothing.  To apply a block: read it, then run that block alone inside a  #
-- #  transaction of its own that COMMITs.  Nothing here deletes a row.        #
-- #  Which blocks to run, if any, is the owner's decision.                    #
-- ############################################################################
--
-- THE QUESTION. Test fixtures live in the production database beside real
-- customers, and one of them carries payment records. Before a public release:
-- what exactly is a fixture, what excludes it from what a person is shown, what
-- does not, which live suites need it, and how could it reach a real customer?
--
-- HOW IT WAS ANSWERED. Read-only, against project newcrgafcptspmapacrx, on
-- 2026-09-29, by tests/a25-test-fixture-containment.test.mjs (run it yourself:
-- A25FC_LIVE=1 node --test tests/a25-test-fixture-containment.test.mjs).
-- Every probe carries a POSITIVE CONTROL: a marker query must find a fixture
-- known to exist (ZZ TEST - Busy season, by id AND by name AND by flag) or the
-- result is INVALID, never "clean". The aggregates a person sees were produced
-- by calling the DEPLOYED functions (admin_companies(), ar_aging(),
-- job_costing(), business_report()) as SYNTHETIC logins inside a transaction
-- that is rolled back; never the service role, never a real login. Real
-- third-party rows were only counted. The function bodies read were the LIVE
-- ones from pg_proc, not a repo file.
--
--   THE TEST FILE RECORDS GAPS.  A green run of it means "the ledger below is
--   still accurate", NOT "fixtures are contained".  Fixing a gap turns its
--   test red until the gap is struck from KNOWN_GAPS there, so the ledger can
--   never go stale in either direction.
--
-- ----------------------------------------------------------------------------
-- 1. WHAT EXISTS  (the platform, 2026-09-29)
-- ----------------------------------------------------------------------------
--   10 companies, 21 job rows (19 live), 26 payment_records (3 live), 19
--   job_payments, 92 catalog items, 8 profiles.
--
--   FIXTURE COMPANIES (4, all named "ZZ TEST ...", ids in 11111111- / 22222222-)
--     ZZ TEST - Sample Fence Co   trialing  crew  2 jobs, 2 customers, 2 employees, 3 line
--                                  items, 1 time entry; a FIXED public leads token and two
--                                  FIXED public quote tokens; ~2,700 audit rows since 09-09
--     ZZ TEST - Busy season       active    Pro   5 jobs and TWO PAYMENT RECORDS (3,840 +
--                                  15,364 = 19,204, both live, method CARD, no recorded_by)
--     ZZ TEST - Brand new         trialing  Solo  empty
--     ZZ TEST - Lapsed            past_due  Crew  empty (the seed comment says suspended;
--                                  live suspended = false)
--   No fixture company has a login (profiles = 0), so nobody signs in to one.
--
--   EVERY TABLE, not a hand-picked list: of the 47 tables that carry a company_id, exactly 8 hold rows
--   of a ZZ TEST company -- audit_log (2,750), sync_signals (1,302 of the platform's 1,416: the fixture
--   suites generate 92% of the realtime signal rows), jobs (7), estimate_line_items (3), payment_records
--   (2), customers (2), employees (2), time_entries (1). The other 39 hold none, and that includes the
--   tables the admin portal reads besides admin_companies(): app_errors (365 rows, none from a fixture),
--   pricing_drift, company_setup_codes, app_release_audience, follow_up_log, attention_findings.
--   auth_events is keyed by login, not company, and no fixture company has a login. Behind flagged jobs
--   in the REAL company (the same sweep by job): automation_flags 1, automation_runs 1, fence_runs 1,
--   job_payments 1, job_steps 25, estimate_line_items 6, payment_records 1 (rows in all states).
--   The test pins that list of 8: a ninth table that starts holding fixture rows turns it red.
--
--   FIXTURE JOBS (10, and 10 of the 19 live jobs on the platform are fixtures)
--     7 inside the ZZ TEST companies, and 3 inside the REAL company Fence solutions
--     ("ZZ TEST rules fixture", sync ids 44444444-0000-4000-8000-00000000000{1,2,3}),
--     needed by tests/live-rules-guard.test.mjs and shift-answer-and-followup-settings.
--     On those three, in the owner's real company:
--       * ONE LIVE PAYMENT RECORD, 7,170.00 CASH, recorded by the owner's login, received
--         2026-09-10, against 44444444-...0002 (a DRAFT whose contract_total is 0);
--       * one job_payments row, 7,170.00 deposit, pending, livemode = false;
--       * 6 line items, 1 fence run, 25 job steps, 1 automation flag + 1 run,
--         1 stored file, 9 audit rows.
--
--   THE THREE MARKERS THAT EXIST, and what each finds
--     name    "ZZ TEST%"           4 companies, 10 jobs, 2 employees, 2 customers
--     flag    jobs.is_test_fixture 10 jobs (and NOTHING ELSE: it is the only column
--                                  of that kind in the schema; there is no company,
--                                  payment, employee or customer flag)
--     id      synthetic namespaces 4 companies, 10 jobs, 2 customers, 2 employees,
--             (1111.. 2222.. 3333.. 4444..)  3 line items, 1 time entry, 2 quote
--                                  tokens, 1 leads token
--   On JOBS the three agree exactly (10 = 10 = 10, no job matches one and not
--   another today). Below job level there is no marker at all: a payment, a line
--   item, a step, an employee is a fixture only because of the job or company it
--   hangs from. A fixture row that matches NO marker (section 6) cannot be excluded
--   by anything.
--
--   EVERY LIVE PAYMENT ROW IN THE DATABASE IS A FIXTURE. Of 26 payment_records, 23
--   are tombstoned (retired / duplicates / written off) and the 3 live ones are the
--   7,170 above and the two 19,204 above. All 19 job_payments are livemode = false
--   (Stripe/Square test). The webhooks refuse to book a test-mode payment
--   (_shared/record-payment.ts, stripe-webhook: repo code, the deployed copy was not compared),
--   so no real money has ever been booked.
--
-- ----------------------------------------------------------------------------
-- 2. WHAT EXCLUDES A FIXTURE TODAY, AND WHAT DOES NOT
-- ----------------------------------------------------------------------------
--   Reads jobs.is_test_fixture:
--     dashboard job list (visibleJobs, client side; the OWNER can opt in), the
--     dashboard money tabs (onlyVisibleRows, client side), business_report()
--     (server; p_include_test honoured only for an OWNER), attention_sweep_candidates()
--     (server; the attention-sweep function only pushes what it returns, so it reaches the flag
--     through that call and never mentions it), the jobs_crew view (server: crew never see one),
--     crew_save_job() (it refuses to WRITE the column from a crew phone), send-follow-ups
--     (server: .eq("is_test_fixture", false)), the phone's JobSync pull (never stored),
--     two checks in scripts/whats-wrong.mjs.
--   Reads the NAME ("zz test"): send-welcome-email only. No function in the database reads the name.
--   The live catalogue holds exactly four objects that test the flag: attention_sweep_candidates,
--   business_report, crew_save_job and the jobs_crew view (no policy and no trigger does).
--   Reads NEITHER:
--     admin_companies(), admin_companies_count(), platform_clients, and every number
--       website/admin.html builds from them (tiles, table, CSV export);
--     ar_aging() and job_costing() -- their raw answers. business_report() fences its
--       own scope; the dashboard fences the rows it fetches; any other caller is not;
--     quote-view and create-payment-link (a fixture quote is served, and a payment link
--       can be made, for any job that has a token / id);
--     notify-job-change (a status change on a fixture pushes to that company's staff);
--     lead-intake (a lead arriving for a fixture company is created unflagged).
--
-- ----------------------------------------------------------------------------
-- 3. WHAT THE OWNER SEES THAT IS WRONG TODAY  (numbers replayed from the live rows)
-- ----------------------------------------------------------------------------
--   Admin portal overview, as website/admin.html computes it from admin_companies():
--                                 shown    without ZZ TEST
--       Companies                   10          6
--       On trial                     5          3
--       MRR at list price         $698       $349
--     The Busy-season fixture is Pro + active, so it doubles the MRR tile. The
--     remaining $349 is the owner's own company (Fence solutions, monthly_price 0,
--     "Permanent access"): the Paying tile is 0 either way. The company table and the
--     fenceflow-clients-*.csv export list all 10, and the Jobs column for Fence
--     solutions reads 11 where 8 are not fixtures.
--   The owner's own company, raw server answers (no client fence):
--       ar_aging()      4 rows, 76,300.00 owed, of which 4,200.00 (1 row) is a fixture
--       job_costing()   collected 7,170.00 -- all of it on fixtures; the real figure is 0
--     The dashboard hides both (onlyVisibleRows); business_report() excludes them.
--   Platform-wide revenue: none of the 2 Busy-season payment records is counted in
--     any aggregate. Every function/view that reads payment_records is scoped to the
--     caller's own company (ar_aging, job_costing, recompute_job_totals, audit_changes)
--     and no policy lets a platform admin read payment_records, jobs, job_payments or
--     estimate_line_items across companies. Nobody can sign in to the fixture company.
--     So those 19,204 are not real money in any figure a person sees; they are simply
--     the only "collected" money anywhere in the database.
--
-- ----------------------------------------------------------------------------
-- 3b. THE GAP LEDGER  (mirrors KNOWN_GAPS in tests/a25-test-fixture-containment.test.mjs)
-- ----------------------------------------------------------------------------
--   G1  The admin portal counts fixture companies: Companies +4, On trial +2, MRR +$349, the table
--       and the CSV; its Jobs column counts a company's own flagged jobs.       closed by R1 + R2
--   G2  No company-level flag: jobs.is_test_fixture is the only fixture column in the schema.
--                                                                               closed by R1
--   G3  ar_aging() and job_costing() return flagged jobs; only their callers fence them.
--                                                                               left as is (section 8)
--   G4  A tenant can write jobs.is_test_fixture (closed by R3) and can rename its company to or from a
--       fixture name (not held: R1 makes the flag, not the name, the marker). "Tenant" here is an OWNER
--       or a MANAGER: a CREW login's update finds 0 rows (probed).            R3, in part
--   G5  Fixtures inside the real company (3 jobs, including the only live payment row), and 13 real
--       rows pinned by id in live suites.                                       owner decision
--   G6  Unmarked lookalikes: 2 live jobs whose payments were retired as test data, one fictional-name
--       job, 2 companies.                                                       owner decision
--   G7  Public entry points with FIXED tokens (2 quote tokens, 1 leads token), and no fixture refusal in
--       quote-view, create-payment-link, notify-job-change, lead-intake.        left as is (section 8)
--   G8  No seed sets the flag on the jobs it inserts; it was applied once by a name-pattern backfill.
--                                                                               R3 in part; seeds should set it
--   Test-suite dependence is not a gap but a constraint (section 4); every live payment row being a
--   fixture is a fact to know before launch (section 1), not something to fix.

-- ----------------------------------------------------------------------------
-- 4. WHO NEEDS THE FIXTURES  (which live suites; read from tests/, checked live)
-- ----------------------------------------------------------------------------
--   Suites whose CODE (comments do not count) touches the live database AND names a
--   persistent fixture row -- 13 distinct rows, in 5 suites:
--     golden-path            ZZ Sample company, its job 11111111-...411, its manager employee, the
--                            FIXED quote token ...501 and FIXED leads token 22222222-...222 -- through
--                            the DEPLOYED quote-view and lead-intake, so the rows must be COMMITTED
--     company-golden-path    ZZ New / Lapsed / Busy, Busy jobs 33333333-...001 and ...003
--     company-crew-golden-path  ZZ Busy and Busy job 33333333-...001
--     live-rules-guard       the three rules fixtures in Fence solutions + the ZZ Sample manager
--     shift-answer-and-followup-settings   rules fixture 44444444-...001
--   (a4-deposit and a4-anchor only QUOTE a fixture / a real job in comments; they do not read it.
--   Seven suites reuse the ZZ Sample company id as a constant in mocks and touch no database.)
--   So the fixtures can NOT be deleted while those suites read production. All but golden-path could
--   stop needing them by building their rows inside their own rolled-back transaction (the a25
--   tenant-isolation suite does exactly that); golden-path cannot, because it calls a deployed HTTP
--   function that only sees committed rows -- it needs a fixture company in whatever database it targets.
--   The reverse dependency is worse: 13 REAL rows are pinned by id in the code of 6 live suites -- two
--   companies (Fence solutions and Horizon fence llc), five logins (one of them Horizon's, one a SALES
--   login with no company), two employees, three shifts and one real DRAFT job. A third party's company
--   and login are load-bearing for release-audience-guard.
--   The structural answer is in DEV_ENVIRONMENT.md: run the suites against a second project.
--   As written there it "has not been created yet".
--
-- ----------------------------------------------------------------------------
-- 5. CAN A FIXTURE REACH A REAL CUSTOMER?
-- ----------------------------------------------------------------------------
--   Email: send-follow-ups is the only AUTOMATIC sender to a customer address, and it excludes
--     flagged jobs (checked in code). Live state, read 2026-09-29: follow_up_settings has ONE row,
--     Fence solutions, with the master switch ON and all four kinds OFF; follow_up_log is empty
--     (nothing has ever been sent); pg_cron is not installed, so nothing inside the database
--     schedules the function (a caller outside it would not be visible from here). So the mailer is
--     dormant, but it is one switch from live, and the test goes red the moment a kind is turned on
--     while a lookalike below could be emailed. send-welcome-email writes to company owners and
--     skips by company NAME. mail-send is composed and sent by a person. attention-sweep pushes to
--     the company's own staff, and reads the flag through attention_sweep_candidates().
--   A quote link: quote-view serves any job by token and never checks the flag. The fixtures'
--     tokens are random EXCEPT the two on ZZ Sample and its leads token, which are FIXED
--     patterns written into tests/golden-path.test.mjs. Anyone holding that file (or guessing
--     11111111-1111-4111-8111-111111111501) is served the fixture quote by quote-view, and can post
--     a lead into that fixture company (a leads-token POST creates a job). Read from the code and
--     from the live token values; NOT fetched, because a view stamps quote_viewed_at on the row.
--   A shared report: business_report, the dashboard and the phone all exclude flagged jobs by
--     default, and the dashboard's CSV exports are cut from the same fenced lists. The admin
--     portal's client list CSV is not fenced (section 3).
--   The path that would actually embarrass him is NOT a fixture: it is the unmarked jobs of
--     section 6. Replayed against the live rows with dueFollowUp()'s own conditions and the
--     company's own thresholds: if he turns on the "quote viewed, not approved" follow-up, both
--     8c6b2b44 (ACCEPTED) and 10b0407f (COMPLETED) are emailed as customers -- each has a viewed
--     timestamp and no approval timestamp. Of the four jobs in that company the mailer can reach at all,
--     three would be emailed by that one kind.
--   A DEFECT beside it, real customers and not fixtures: that rule keys on quote_approved_at, NOT on
--     status. A job the office has moved to ACCEPTED or COMPLETED, whose customer never pressed
--     Approve on the web quote, still gets "you have not approved your quote" as soon as the kind
--     is on. Nothing here changes that; it is a reason to look at the rule before switching it on.
--
-- ----------------------------------------------------------------------------
-- 6. FIXTURE-SHAPED ROWS THAT MATCH NO MARKER  (the dangerous kind: nothing can exclude them)
-- ----------------------------------------------------------------------------
--   In Fence solutions, live, unflagged, name not ZZ:
--     8c6b2b44-4901-4a89-8808-60a6da702a98  ACCEPTED   19,810.00  5 payments tombstoned
--     10b0407f-2322-476f-af96-0520dd84aea1  COMPLETED  16,000.00  6 payments tombstoned
--       -- the payments carry deleted_by 'retired 2026-09-10: test job, confirmed by March'
--          (supabase_retire_test_jobs.sql also tombstoned these jobs; they are live again,
--          the payments stayed retired). Together 35,810.00 of the 72,100.00 that ar_aging()
--          reports as owed on this company's unflagged jobs (the other 36,290.00 is the next job).
--     4598150b-9a72-49b0-a9bc-52dde4239188  ACCEPTED   36,290.00  no payments; the a4-anchor
--          suite quotes it as JAMES_BOND; the name reads as fictional. Whether it is a demo or a
--          customer is not something the database can say.
--   Companies "Marc" and "Marco": no name marker, no flag. Marc's company email is on the operator's
--     own domain and it has a Stripe subscription record; Marco is pending, no login, no jobs. Both
--     are counted in the admin tiles. The database cannot say whether they are customers.
--   Only the owner can classify these. The one statement that would hide a job everywhere the
--   flag is honoured is at the bottom of section 9 and is commented out.
--
-- ----------------------------------------------------------------------------
-- 7. IS THERE ALREADY A FLAG THAT EVERYTHING CHECKS?
-- ----------------------------------------------------------------------------
--   Half of one. jobs.is_test_fixture exists, is boolean not null default false, and is honoured
--   in 8 places (section 2). It is UNDER-USED: 7 consumers a person or a customer reaches ignore
--   it (admin*, ar_aging, job_costing, quote-view, create-payment-link, notify-job-change,
--   lead-intake). And it is only at JOB level: there is no company-level flag, so a fixture
--   COMPANY is recognised by its name and by one consumer. Two more properties make it weaker than
--   it looks:
--     * it is WRITABLE BY A TENANT: jobs_update is "company_id = current_company_id()" with no role test,
--       and no trigger holds this column. Probed as a synthetic OWNER and as a synthetic MANAGER against
--       the deployed database (rolled back): the update lands, and so does an INSERT that names the flag
--       true. A CREW login is stopped -- its update finds 0 rows, for this column and for an ordinary one
--       (the row is hidden from it by jobs_money_hidden_from_crew), and the crew phone's own write
--       funnel crew_save_job() refuses the column by design. A tenant can
--       hide its own jobs from its own reports, follow-ups and alerts; and a flag a tenant can write
--       cannot be what platform reporting trusts;
--     * no seed sets it: the three seed files insert jobs without it, and it was applied once by
--       supabase_test_fixture_flag.sql's `update ... where customer_name ilike 'ZZ TEST%'`. A
--       fixture created after that day is unflagged until somebody reruns a backfill.
--   A company NAME is worse as a marker: an OWNER can rename their own company (probed the same way:
--   the update lands), so a real tenant called "zz test ..." silently loses its welcome email, and any
--   name-based platform figure is tenant-controlled. R1-R3 make the flag, not the name, the marker; they
--   do not stop a tenant renaming.
--
-- ----------------------------------------------------------------------------
-- 8. THE SMALLEST CHANGE  (recommended: R1 + R2.  Optional: R3.  Not recommended: report rewrites.)
-- ----------------------------------------------------------------------------
--   R1  a company-level flag with the SAME name and meaning as the job one, held against tenants,
--       backfilled BY ID onto the four fixture companies. Additive; deletes nothing.
--   R2  admin_companies() and admin_companies_count() leave flagged companies out (and stop counting a
--       company's own flagged jobs in its Jobs / last-active columns). Signatures are unchanged, so
--       CREATE OR REPLACE works and no caller changes. This alone corrects the Companies / On trial /
--       MRR tiles, the table and the CSV: the only place a fixture is a wrong number to the owner.
--   R3  (optional hardening) a trigger on jobs: a tenant can no longer write is_test_fixture, and any job
--       created under a flagged company is flagged (so a lead arriving for a fixture company, or a seed
--       that forgets the column, stays a fixture). The database owner, the service role and a platform
--       admin are exempt, so seeds, suites and the operator work as before.
--   None of R1-R3 deletes or changes a fixture row (beyond R1's four flags), and none changes what any
--   suite reads: company-golden-path, golden-path, live-rules-guard and the others select fixture rows
--   by id and by company, and those still return them. tests/a25-test-fixture-containment.test.mjs
--   (A25FC_LIVE=1 A25FC_FIXES=1) applies exactly these blocks (read from this file, not retyped) inside a
--   rolled-back transaction against the deployed database and checked, on 2026-09-29: the operator's list
--   and tiles (Companies / On trial / MRR fixture contribution 4 / 2 / $349 become 0 / 0 / $0), the Jobs
--   column (2 becomes 1 on the probe company), a tenant's write to the company flag and to a job's flag
--   held, a job inserted under a flagged company born flagged, the helper not callable by a tenant, and
--   a digest of every real row in 12 tables and of the companies table (the new column excluded) identical
--   before and after. It also checks block R2 is the LIVE body of each function plus the marked edits and
--   nothing else. After the run none of the blocks' objects existed: the transaction rolled back.
--
--   WHY NOT make ar_aging() / job_costing() drop flagged jobs? Because business_report() is built on
--   them: it calls both and only then fences by its own scope, and it lets an OWNER opt in
--   (p_include_test) to see fixtures. Making the two functions drop flagged jobs would silently empty that
--   opt-in, and their signatures cannot gain a parameter without a DROP (two overloads make a no-argument
--   rpc() call ambiguous). Both are already fenced where they are read. If a NEW caller appears it must
--   go through business_report() or cut its rows to visible jobs the way the dashboard does.
--
--   THE DURABLE FIX is not a filter. It is to stop putting fixtures in the database real customers use:
--   move the persistent fixtures (and the suites that read them) to the second project in
--   DEV_ENVIRONMENT.md, and let the suites that can build their rows in a rolled-back transaction do that.
--   Until then the fixtures stay, flagged, and R1-R3 make them invisible to the operator's numbers.
--
--   RUN ORDER, if he decides to apply: R1, then R2, then (optionally) R3. R2 needs R1's column.
--   R1/R3 take a brief table lock (companies / jobs); run them at a quiet moment. After applying,
--   regenerate supabase/dev/fingerprint-prod.txt (scripts/schema-fingerprint.mjs): the new column, the
--   new functions and triggers and the two changed functions all show in it. The seed files should then
--   set the flag in their inserts (they are not changed here: this audit changes no source).
--
-- ----------------------------------------------------------------------------
-- 9. OWNER DECISIONS THIS FILE DOES NOT MAKE
-- ----------------------------------------------------------------------------
--   (a) Are 8c6b2b44 / 10b0407f test jobs? If yes they should carry the flag (statement below);
--       if no, their retired payments are missing real money. This is a data question, not a code one.
--   (b) Is 4598150b a demo? Same statement.
--   (c) Are the companies Marc and Marco fixtures? (R1's flag is the way to mark them.)
--   (d) Move the rules fixtures out of Fence solutions? They exist only because live-rules-guard needs a
--       job in the same company as the real accounts it impersonates; the suite could build them in its
--       own rolled-back transaction, after which the flagged jobs and the 7,170 test payment in the real
--       company could be retired by him. Nothing here retires anything.
--   (e) Whether to create the dev project (an organisation change and an account action, not code).
--
--   COMMENTED OUT ON PURPOSE (a data decision; run only after (a)/(b) are answered):
--   --   update public.jobs set is_test_fixture = true
--   --    where company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
--   --      and sync_id in ('8c6b2b44-4901-4a89-8808-60a6da702a98',
--   --                      '10b0407f-2322-476f-af96-0520dd84aea1');

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ============================================================================
-- >>> R1
-- R1. A company-level flag, the same name and meaning as jobs.is_test_fixture.
--
-- ADDITIVE. One column, one trigger function, one trigger, one internal helper and
-- a backfill of exactly four rows BY ID (the name is a second condition, so a wrong
-- id or a renamed company flags nothing rather than the wrong company). No row is
-- deleted, no fixture is changed, no suite reads anything that moves.
--
-- Who may write it: nobody who is a tenant. The hold is the pattern of
-- hold_first_contact_by(): no request context is a direct connection (the database owner,
-- migrations, seed files), is_service_role() is the backend, is_platform_admin() is the
-- operator behind the second factor. Everybody else keeps the old value on UPDATE and
-- gets false on INSERT. companies_update lets an OWNER edit their own company, so without
-- this hold the flag would be as writable as the name is.
-- ============================================================================
alter table public.companies
    add column if not exists is_test_fixture boolean not null default false;

comment on column public.companies.is_test_fixture is
    'A company that exists to be tested against (ZZ TEST ...). Same meaning as jobs.is_test_fixture, one level up. Written only by the database owner, the service role or a platform admin: hold_company_test_fixture().';

create or replace function public.hold_company_test_fixture()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    claims text := nullif(current_setting('request.jwt.claims', true), '');
begin
    -- Security definer, so current_user is the owner here and cannot tell a tenant from the
    -- backend: the request's own claims are what say who is asking (as hold_first_contact_by does).
    if claims is null or public.is_service_role() or public.is_platform_admin() then
        return new;
    end if;
    if tg_op = 'UPDATE' then
        new.is_test_fixture := old.is_test_fixture;
    else
        new.is_test_fixture := false;
    end if;
    return new;
end;
$function$;

create or replace trigger "00_hold_company_test_fixture"
    before insert or update on public.companies
    for each row execute function public.hold_company_test_fixture();

-- The one place that answers "is this company a fixture". Internal: every caller is a
-- SECURITY DEFINER function or trigger, so no tenant needs to execute it.
create or replace function public.is_fixture_company(cid uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
    select coalesce((select c.is_test_fixture from public.companies c where c.id = cid), false);
$function$;

revoke all on function public.is_fixture_company(uuid) from public, anon, authenticated;

-- The four ZZ TEST companies, by id (supabase_test_company.sql, supabase_test_companies.sql).
update public.companies
   set is_test_fixture = true
 where id in ('11111111-1111-4111-8111-111111111111',
              '22222222-2222-4222-8222-222222222001',
              '22222222-2222-4222-8222-222222222002',
              '22222222-2222-4222-8222-222222222003')
   and name ilike 'ZZ TEST%';
-- <<< R1

-- ============================================================================
-- >>> R2
-- R2. The operator's list, count and every number the admin portal builds from
-- them leave fixture companies out. Needs R1's column.
--
-- These are the LIVE bodies read from pg_proc on 2026-09-29, changed in exactly the
-- places marked. RETURNS TABLE and the argument list are unchanged, so CREATE OR
-- REPLACE is allowed and website/admin.html needs no change: it computes Companies /
-- On trial / Paying / MRR, the table and the CSV from admin_companies(), so all of
-- them follow. A fixture company is still in the table and every suite still reads
-- it; it is only left out of the operator's list.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.admin_companies()
 RETURNS TABLE(id uuid, name text, email text, subscription_status text, subscription_plan text, monthly_price numeric, suspended boolean, suspended_reason text, trial_ends_at timestamp with time zone, days_left integer, allowed boolean, people bigint, jobs bigint, last_active timestamp with time zone, admin_notes text, billing_email text, grace_ends_at timestamp with time zone, oldest_app_version text, newest_app_version text, last_seen timestamp with time zone, invited_at timestamp with time zone, invited_email text, joined_at timestamp with time zone, details_completed_at timestamp with time zone, agreement_signed_at timestamp with time zone, agreement_signed_name text, subscription_ends_at timestamp with time zone, stripe_subscription_id text, owner_email text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select c.id, c.name, c.email, c.subscription_status::text, c.subscription_plan::text,
           c.monthly_price, c.suspended, c.suspended_reason,
           c.trial_ends_at,
           case when c.trial_ends_at is null then null
                else greatest(0, extract(day from c.trial_ends_at - now())::int) end,
           public.company_allowed(c.id),
           (select count(*) from profiles p where p.company_id = c.id),
           (select count(*) from jobs j where j.company_id = c.id and j.deleted_at is null
                   and not j.is_test_fixture),
           (select max(j.updated_at) from jobs j where j.company_id = c.id
                   and not j.is_test_fixture),
           c.admin_notes, c.billing_email, c.grace_ends_at,
           (select p.app_version_name from profiles p
             where p.company_id = c.id and p.app_version_code is not null
             order by p.app_version_code asc limit 1),
           (select p.app_version_name from profiles p
             where p.company_id = c.id and p.app_version_code is not null
             order by p.app_version_code desc limit 1),
           (select max(p.last_seen_at) from profiles p where p.company_id = c.id),
           c.invited_at, c.invited_email, c.joined_at,
           c.details_completed_at, c.agreement_signed_at, c.agreement_signed_name,
           c.subscription_ends_at, c.stripe_subscription_id::text,
           -- The address this company's owner signs in with. A scalar subquery,
           -- so a company with nobody in the OWNER role still returns its row
           -- with a null here instead of disappearing from the only page that
           -- can start its trial. Oldest owner wins, so the answer does not
           -- change between two refreshes.
           --
           -- No filter on removed_at: release_seat sets company_id to null when
           -- somebody is removed and clears removed_at again when they are let
           -- back in, so company_id alone already excludes a removed person --
           -- and this matches the people/version subqueries above, which is
           -- what keeps the seat count and the owner talking about one set.
           (select u.email::text
              from profiles p
              join auth.users u on u.id = p.id
             where p.company_id = c.id and p.role = 'OWNER'
             order by p.created_at asc
             limit 1)
    from companies c
    -- A fixture company is not a client. It is still in the table, and the
    -- suites that need it still read it; it is only left out of the operator's
    -- list, the tiles computed from it, and the CSV cut from it.
    where is_platform_admin()
      and not c.is_test_fixture
    order by c.name;
$function$;

CREATE OR REPLACE FUNCTION public.admin_companies_count()
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select count(*) from companies where is_platform_admin() and not is_test_fixture;
$function$;

-- <<< R2

-- ============================================================================
-- >>> R3
-- R3. OPTIONAL hardening: a tenant can no longer write jobs.is_test_fixture, and a job
-- created under a flagged company is flagged. Needs R1.
--
-- Today jobs_update lets any member of a company update its jobs and nothing holds this
-- column, so a tenant can hide its own jobs from its own reports, follow-ups and alerts,
-- and a job a lead-intake call creates in a fixture company is born unflagged.
--
--   INSERT  a tenant's job gets the company's flag (true only in a flagged company).
--           The database owner, the service role and a platform admin may also set it true
--           explicitly (a seed file, a suite) and it can only ever be raised by the company.
--   UPDATE  a tenant keeps the old value. The database owner, the service role and a platform
--           admin may change it (the backfill in supabase_test_fixture_flag.sql, the owner-decision
--           statement in section 9 of this file).
--
-- Nothing reads a different value than before: the dashboard never writes the column, and a
-- phone that pushes its default (false) for a job whose flag is true is now held instead of
-- turning a fixture back into a real job (the risk noted in crew_save_job()).
-- Same exemption test as R1 and as hold_first_contact_by().
-- ============================================================================
create or replace function public.hold_job_test_fixture()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    claims text := nullif(current_setting('request.jwt.claims', true), '');
    trusted boolean := claims is null or public.is_service_role() or public.is_platform_admin();
begin
    if tg_op = 'INSERT' then
        if trusted then
            new.is_test_fixture := coalesce(new.is_test_fixture, false)
                                   or public.is_fixture_company(new.company_id);
        else
            new.is_test_fixture := public.is_fixture_company(new.company_id);
        end if;
        return new;
    end if;
    if not trusted then
        new.is_test_fixture := old.is_test_fixture;
    end if;
    return new;
end;
$function$;

create or replace trigger "00_hold_test_fixture"
    before insert or update on public.jobs
    for each row execute function public.hold_job_test_fixture();
-- <<< R3

-- ============================================================================
-- >>> V
-- V. What to run after applying (SELECT only). Expected values are from 2026-09-29.
-- ============================================================================
select 'fixture companies flagged (expect 4)' as check_name,
       count(*) filter (where is_test_fixture)::text as got
  from public.companies
union all select 'ZZ TEST companies NOT flagged (expect 0)',
       count(*)::text from public.companies where name ilike 'ZZ TEST%' and not is_test_fixture
union all select 'flagged companies NOT named ZZ TEST (expect 0; anything else is a decision)',
       count(*)::text from public.companies where is_test_fixture and name not ilike 'ZZ TEST%'
union all select 'jobs flagged (expect 10 on 2026-09-29)',
       count(*)::text from public.jobs where is_test_fixture
union all select 'jobs named ZZ TEST but not flagged (expect 0)',
       count(*)::text from public.jobs where customer_name ilike 'ZZ TEST%' and not is_test_fixture
union all select 'jobs inside a flagged company but not flagged (expect 0)',
       count(*)::text from public.jobs j join public.companies c on c.id = j.company_id
        where c.is_test_fixture and not j.is_test_fixture;
-- <<< V

rollback;
