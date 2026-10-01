-- supabase_r19_function_doors.sql
--
-- ############################################################################
-- #  STATUS: NOT APPLIED.  Written 2026-09-30.                               #
-- #                                                                          #
-- #  Running this file as it stands changes NOTHING. PART 1 is a dry run:    #
-- #  one transaction that installs all five fixes, attacks them, proves the  #
-- #  legitimate callers still work, undoes them with the REVERSE, proves the #
-- #  reverse too, and ends in ROLLBACK. PARTS 2, 3 and 4 are inside block   #
-- #  comments and do not run.                                                #
-- #                                                                          #
-- #  DOOR 5 (device_keys) and DOOR 3 (crash reports): SAFE TO APPLY.         #
-- #      PART 2. The proof is under each door below.                         #
-- #  DOOR 4 (push token): HELD. PART 3. NOT proven safe: a real caller is    #
-- #      at risk (see door 4). Do not apply it until that is decided.        #
-- #  DOOR 1 (recompute_job_totals) and DOOR 2 (company_allowed): DRY RUN     #
-- #      ONLY. There is deliberately no apply block for either. Door 1 is    #
-- #      fired by the payment trigger on every payment write; door 2 sits    #
-- #      under every table's row-level policy. Both were proven here and     #
-- #      neither was touched in production.                                  #
-- ############################################################################
--
-- THE QUESTION. Five doors (three SECURITY DEFINER functions and two tables' policies)
-- let a signed-in stranger, or a crew login, reach another business or a control.
-- The tables themselves are isolated; these are the doors that skip the walls.
-- The doors keep the numbers a reviewer gave them (door N = the reviewer's item
-- N); this file and its report list them in order of DAMAGE: 1, 5, 3, 2, 4.
--
-- THE SHAPE OF EVERY FIX, and the helper. Each door now confirms that the CALLER
-- BELONGS TO THE BUSINESS IT IS ACTING ON. This database already has the helper
-- for that question, read from the live catalogue on 2026-09-30:
--     public.current_company_id()  =  select company_id from profiles
--                                      where id = auth.uid()
-- SECURITY DEFINER, and the test every row-level-security policy here uses. The
-- other half is "is this the server?", which the database also already answers:
--     public.mail_is_backend()     =  no JWT claims at all, or the JWT's role is
--                                      the service role.
-- (Its EXECUTE is postgres and the service role only, which is fine: every
-- function below is a definer owned by postgres.)
-- The definer trap: inside a SECURITY DEFINER function current_user is the
-- function's OWNER, so a guard written against current_user says nothing about who
-- is asking (the dry run plants exactly that guard and shows it fail). The
-- caller's identity is in the JWT, which is what auth.uid() reads.
-- The NULL trap: current_company_id() is NULL for a signed-in person with no
-- profile or no business, and NULL in "if not (...)" reads as "do not raise".
-- Door 1 wraps the test in coalesce(..., false); the dry run plants the version
-- without it and shows it fail.
--
-- ############################################################################
-- DOOR 1  recompute_job_totals(co, job_sid)   DRY RUN ONLY   the worst of them
-- ############################################################################
--   The hole, reproduced live (rows "baseline"): the signed-in OWNER of one
--     business calls it with another business's ids. It rebuilds the victim job's
--     cached amount_paid/refunded_amount from that job's ledger and WRITES it: a
--     victim job drifted to 0 read 100 afterwards, in a business whose jobs the
--     caller cannot see at all (the same session shows their read of that job
--     return nothing), and the victim's audit log gained an entry naming the
--     attacker's login as the actor. It takes the company from the caller and
--     never asks who the caller is.
--   Real callers, found by reading the live function bodies, then the code:
--     1. The payment_records trigger payment_records_totals (AFTER INSERT/UPDATE/
--        DELETE, function payment_records_recompute, a definer). It fires under
--        the JWT of WHOEVER WROTE THE PAYMENT: the Android app (EntitySync) and
--        the dashboard (its payment import) as a signed-in member, where
--        row-level security has already forced the payment's company to be the
--        writer's own; the payment webhooks and the payment helper (stripe-
--        webhook, square-webhook, _shared/record-payment.ts) as the service
--        role, which carry no user at all; and scripts and migrations with no
--        JWT at all.
--     2. recalculate_my_job_totals() (the Recalculate button; a definer that
--        passes current_company_id()).
--     3. Scripts run from the SQL editor (supabase_fix_test_fixture_ledger.sql).
--     No Kotlin, no website code, no edge function calls it by name; the tests
--     assert that, so a new caller fails a test instead of a customer.
--     No cascade reaches the trigger under a user's JWT: payment_records has a
--     foreign key to companies only (no job foreign key), companies cannot be
--     deleted (supabase_companies_no_delete_patch.sql), and no policy allows a
--     hard DELETE for a login.
--   The guard: raise 42501 unless mail_is_backend() OR co = current_company_id(),
--     wrapped in coalesce(..., false). A guard that demanded a JWT would have
--     broken the webhooks and every no-JWT script silently; the dry run plants
--     that version ("door1-needs-a-jwt") and shows those rows go red. The
--     operator (platform admin) is refused too: nothing in the operator's pages
--     calls this function.
--   Proven here (rows "attack", "legit", "trigger"): a stranger, an attacker's
--     crew member, a person with no profile, a person with no business, the
--     operator, anon, a NULL company, a nonexistent company, the victim's company
--     with the attacker's job, and the attacker's company with the victim's job
--     are all refused or match nothing, and the victim's figure does not move; the
--     business's own owner, the Recalculate function, a no-JWT script, the
--     service-role claim, and the trigger under all three JWTs still work.
--   Also true, not done here: revoking EXECUTE from authenticated would close the
--     direct door too (nothing legitimate calls it as authenticated). The guard is
--     the stronger form, and a revoke on top would hide a guard failure behind a
--     permission error, so the proof uses the guard alone.
--
-- ############################################################################
-- DOOR 5  device_keys_read (the table's policy)   SAFE TO APPLY (PART 2)
-- ############################################################################
--   The hole: the SELECT policy is company_id = current_company_id() and nothing
--     else, so every member of a business, crew included, reads its unused
--     device keys straight from the table, and can use one before the person it was
--     minted for, which defeats the one-phone-per-login lock. (Dry run, baseline:
--     the victim's crew member reads both keys.)
--   The fix: the same two roles list_device_keys(), mint_device_key() and
--     revoke_device_key() already serve: OWNER and MANAGER.
--   Why it is safe: nothing reads the table as its invoker. No Kotlin, website or
--     edge-function code selects it (the tests assert that); no view, policy,
--     constraint or default mentions it; it is not in the realtime publication; the
--     four functions that touch it (list, mint, revoke, claim_device) are definers
--     owned by postgres, which bypasses row-level security on a table that is not
--     FORCEd; production holds 0 rows in it. The dry run exercises every one of the
--     four as each role and they still work, and the office roles still read it.
--
-- ############################################################################
-- DOOR 3  app_errors crash reports   SAFE TO APPLY (PART 2)
-- ############################################################################
--   The hole: the insert policy is auth.role() = 'authenticated' and nothing else,
--     so any signed-in account files reports naming any business and any reporter,
--     at any size and rate. (Dry run, baseline: a report filed against the victim,
--     attributed to the victim's owner, 200,000-character message stored whole.)
--   The fix: a BEFORE INSERT trigger stamps company_id and reported_by from the
--     caller (current_company_id(), auth.uid()) and caps the text columns. The
--     server's own writes (mail_is_backend()) pass untouched.
--   It CORRECTS rather than refuses, and that is a decision, not a shortcut. The
--     phone uploads its whole queue in ONE insert (CrashReporter.upload) and deletes
--     the queue only when that insert succeeds; each queued record carries the
--     company stamped when it happened, and a login that has since changed business
--     (or a phone handed to another login) would make a refusal reject the entire
--     batch on every later launch, for ever. The dry run uploads a batch of three
--     with one foreign company and shows all three accepted.
--   Why it is safe: the only writers are the phone (CrashReporter as a batch and
--     JobSync singly, both as the signed-in user) and nothing server side. The caps are far above the longest real value in the 365 production
--     rows (email 30, where_at 10, android 29, version_name 5, message 400, stack
--     4473 against caps of 320, 200, 200, 64, 2000 and 20000). No existing row is
--     touched; the trigger only sees new inserts.
--   Two things change that you will notice: reported_by starts being filled (it is
--     NULL on all 365 rows today; the comment in scripts/post-release-watch.mjs that
--     says so becomes stale), and a report queued under one business and uploaded
--     after the login moved to another is filed under the uploader's business. The
--     trigger takes a brief write lock on app_errors for the length of the dry run.
--   Not fixed: the volume. Any account can still file reports as fast as it likes;
--     only the size and the attribution are bounded.
--
-- ############################################################################
-- DOOR 2  company_allowed(cid)   DRY RUN ONLY
-- ############################################################################
--   The hole: any signed-in user learns whether ANY business is paid up by naming
--     its id: true, false, or NULL for an id that is no business (baseline rows).
--   Real callers: price-job and invite-crew call it over RPC with the CALLER's JWT and
--     their own business (they read profile.company_id first); create-payment-link,
--     quote-view, lead-intake, mail-sync and send-follow-ups call it with the service
--     role, for other businesses; inside the database company_is_suspended() (the
--     gate under 21 tables' policies), my_service_status() and
--     can_use_company_mail() ask about the caller's own business, admin_companies()
--     asks about all of them behind is_platform_admin(), and
--     attention_sweep_candidates() (execute: postgres and the service role only)
--     asks about every business with the sweep on. No trigger calls it.
--   Why this is three objects and not one. The obvious fix, the membership test
--     inside company_allowed, works and is a measured problem: company_is_suspended()
--     calls it once per ROW (EXPLAIN shows it as a per-row Filter under every one of
--     those 21 policies, not a one-time filter), so the guard's cost lands on every
--     row of every read. Measured in this dry run's own harness, 3000 gate calls:
--     445 ms deployed; 1214 ms with the guard written with the helper; 946 ms with
--     the cheapest inline form; 431 ms with the split below. (Alone, company_allowed
--     costs about 13 us deployed, 38 us inline, 164 us with the helper.) So:
--       a. company_allowed_unchecked(cid): the deployed body, unchanged, under a
--          name no client role and not the server can call (all grants revoked).
--       b. company_allowed(cid): the guarded front door, using the helpers; NULL
--          for a stranger, which is the same NULL an id that is no business gets.
--       c. company_is_suspended(): the deployed body with its one call pointed at
--          the unchecked copy. It only ever asks about the caller's own business,
--          read from their own profile in the same statement.
--     The reverse restores (c) and (b) by md5 and drops (a).
--   Proven here: a stranger, a crew member of another business, a person with no
--     profile and anon get NULL or a refusal, identical for a paid-up, a suspended
--     and a nonexistent business; a member gets the real answer about their own
--     business; the operator and the server get real answers about all; the
--     operator's admin_companies() list, the mail gate, my_service_status(), the
--     row-level wall and the sweep all still work.
--   NOT provable from here: the edge functions themselves were READ, not run.
--     The server path is simulated with the service role's JWT claim and the
--     database role unchanged (see the helpers below); what the guard reads is the
--     claim, and has_function_privilege confirms the service role's grants.
--
-- ############################################################################
-- DOOR 4  register_device_token(device_token)   HELD (PART 3)   NOT PROVEN SAFE
-- ############################################################################
--   The hole: ON CONFLICT (token) DO UPDATE takes user_id and company_id from the
--     caller, so whoever knows another phone's push token re-points it at
--     themselves (baseline rows). Read the direction correctly: the token names
--     one physical phone and device_tokens.company_id is the address servers push
--     to, so this does NOT deliver the victim's notifications to the attacker (the
--     attacker's phone never receives them). It silences the victim's phone and
--     makes it receive the ATTACKER's business's notifications instead. It needs
--     the token, which no tenant can read. (supabase_r15's F5 words it as sending the
--     victim's notifications "to themselves"; the fan-out code addresses phones by
--     company_id and user_id, and the push goes to whoever holds the token, so the
--     direction is the other one.)
--   The fix: the conflicting row may be taken over only by the same PERSON or by a
--     member of the business it is addressed to (a shared van phone). The test is
--     the DO UPDATE ... WHERE itself, decided against the row at that instant, then
--     row_count = 0 raises 42501. Equality, not "is not distinct from": two people
--     with no business cannot take each other's phones (planted and shown red).
--   Why it is NOT safe to apply: the one real caller is the app's sign-in
--     (SessionManager, failure swallowed by runCatching), and the app never deletes
--     a token at sign-out (no Kotlin deletes from device_tokens). So a phone handed
--     from one business's login to a DIFFERENT business's login, WITHOUT
--     reinstalling, carries the same token, and after this change that sign-in is
--     refused and ignored: the new person gets no pushes, and the previous login's
--     job and payment pushes keep arriving on a phone it no longer holds. Today that
--     hand-over silently works.
--     The same person moving between businesses, and colleagues in one business, are
--     unaffected (both proven). Applying this is safe once the app deletes its token
--     at sign-out (the policy that lets it, device_tokens_own_delete, already exists),
--     or once that hand-over is judged not to matter. That is a decision, not a fact
--     this file can supply.
--
-- ############################################################################
-- FOUND ALONG THE WAY (none of it changed here)
-- ############################################################################
--   * mint_device_key() has never worked in production. Its search_path is 'public'
--     but gen_random_bytes lives in 'extensions', so it fails with "function
--     gen_random_bytes(integer) does not exist" for everyone; device_keys has held 0
--     rows ever. The dashboard's product-keys button cannot mint. The dry run records
--     this as unchanged before and after. One-line fix, not made here: put
--     'extensions' on that function's search_path.
--   * The row-level gate NOT company_is_suspended() is evaluated per row on 21
--     tables (EXPLAIN shows a per-row Filter; 500 jobs read in 88 ms as a member,
--     about 176 us a row with has_permission, before any real data volume). Wrapping
--     the call as (select company_is_suspended()) in those policies is the usual
--     way to make it a once-per-query InitPlan. Not tried here.
--   * After applying, tests/a25-tenant-isolation.test.mjs will go red for the right
--     reason: strike from its KNOWN_FINDINGS "recompute_job_totals/cross_write" (door
--     1), "company_allowed/cross_read" (door 2), "app_errors/ins_b" (door 3),
--     "register_device_token/hijack" (door 4) and "device_keys/crew_read" (door 5).
--     supabase/dev/apply-order.txt should list this file. This file supersedes the
--     proposed F2 to F6 blocks in supabase_r15_tenant_isolation_findings.sql (its F2
--     was a plain revoke, F3's guard used auth.uid() is null as the server test,
--     which is also true for anon).
--   * The helpers current_company_id() and the rest keep search_path 'public' with no
--     pg_temp, so a temporary table could shadow profiles; the API offers no way to
--     create one, so it is not reachable today. The functions replaced here put
--     pg_temp last.
--
-- DRY-RUN RESULT, 2026-09-30, against production, rolled back: 184 of 184 rows pass,
--   including the baseline rows that reproduce each hole on the deployed functions and
--   the "reopened" rows that show the reverse puts each hole back. Afterwards: no user,
--   company, profile, job, payment, token, key, crash report, audit entry, setting or
--   queued HTTP call left behind; the four replaced functions have the deployed md5s
--   and device_keys_read the deployed text; no new function or trigger exists.
--   PART 2, 3 and 4 were rehearsed with COMMIT swapped for ROLLBACK (each runs clean and
--   passes its own closing check), and PART 1 was re-run on top of PART 2 and of PART 2
--   plus 3 already applied inside the transaction: 184 of 184 both times.
--   Planted failures (tests/a26-doors.test.mjs, A26_DOORS_LIVE=1) - 16 deliberately
--   broken versions, every one caught: door 1 with no guard, without coalesce, needing
--   a JWT, written against current_user; door 2 with no guard, without the operator,
--   without the server, with the unchecked copy left callable; door 3 without the
--   trigger, refusing instead of correcting, trusting the row; door 4 with no guard,
--   with NULL equal to NULL; door 5 unchanged, and narrowed to the owner only; and a
--   reverse that reverses nothing.
--
-- USING THIS FILE
--   Dry run:  npx --no-install supabase@2.115.0 db query --linked \
--               --project-ref newcrgafcptspmapacrx -f supabase_r19_function_doors.sql --output json
--             One row per check with PASS or FAIL, and a SUMMARY row last. Rows marked
--             "baseline" are the holes themselves, reproduced on the deployed functions
--             before the change goes in; they are recorded, not scored. Every attack row
--             has a CONTROL beside it. Every attack runs as the anonymous or the signed-in
--             role with a specific user's claims, and the database role is never switched to
--             the service role. The s and sx helpers (no JWT at all: a script, a migration,
--             a trigger fired from the SQL editor) and the b and bx helpers (the service
--             role's JWT CLAIM set in the session, the database role untouched: the payment
--             webhooks and edge functions) run as the connection role. They only build
--             fixtures, read back what an attack did, or stand in for the server's own
--             callers; none of them is an attack and no isolation result rests on one.
--             The operator and sweep checks call admin_companies() and
--             attention_sweep_candidates() inside the transaction, which read every
--             business's rows; only the three synthetic ids are kept in what comes back.
--             The dry run takes a brief write lock on app_errors (the trigger is created
--             inside it) for the ten seconds or so it runs.
--   Apply:    delete the two marker lines that open and close the PART block, run that
--             block alone, then put the markers back. PART 2 = doors 5 and 3.
--   Reverse:  the same, for PART 4. It is safe to run whether or not a door was applied.


-- PART 1 -- DRY RUN. Rolled back. Never assumes the bypass role: every attack
-- runs as the anonymous or the signed-in role, with a specific user's claims.
-- (The words "service_role" appear below only as the value of a JWT claim in the
-- b and bx helpers, which stand in for the server's own callers, in a privilege
-- lookup, and in a REVOKE list; the database role is never switched to it.)

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create temp table r(n serial primary key, subject text, pair text, role text, k text, got text, want text);
grant all on r to authenticated, anon;
grant usage on sequence r_n_seq to authenticated, anon;
create temp table snap(k text primary key, v text);

-- The caller's JWT and role are set INLINE in each helper: once the role is
-- switched, another pg_temp function may not be callable, so nothing is called
-- between "set local role" and "reset role". A null "who" is the anon key. Every
-- attack runs as authenticated or anon, never as anything that bypasses row
-- level security. q: one scalar back. x: run for effect, the real affected-row
-- count. s / sx: the database owner with NO JWT at all, which is how a script, a
-- migration or a trigger fired from the SQL editor presents; it READS BACK what
-- an attack did or did not do, and stands in for the server's no-JWT callers.
-- b / bx: the same as s / x but with the JWT claims of the server's own role
-- (role = service_role, no user), which is how the payment webhooks and the
-- edge functions present. b and bx do NOT switch the database role: the
-- connection stays what it is, only the claim is set, because what the guards
-- read is the claim. Nothing here ever runs as the bypass role.
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
  if gk is not null then perform set_config('doors.' || gk, v, true); end if;
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

create function pg_temp.sx(sj text, pr text, ro text, kk text, sq text, wt text) returns void language plpgsql as $fn$
declare c int; v text;
begin
  perform set_config('request.jwt.claims','',true);
  begin execute sq; get diagnostics c = row_count; v := 'rows=' || c;
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,140); end;
  insert into r(subject,pair,role,k,got,want) values (sj,pr,ro,kk,v,wt);
end $fn$;

create function pg_temp.b(sj text, pr text, ro text, kk text, sq text, wt text) returns void language plpgsql as $fn$
declare v text;
begin
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  begin execute sq into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,140); end;
  perform set_config('request.jwt.claims','',true);
  insert into r(subject,pair,role,k,got,want) values (sj,pr,ro,kk,v,wt);
end $fn$;

create function pg_temp.bx(sj text, pr text, ro text, kk text, sq text, wt text) returns void language plpgsql as $fn$
declare c int; v text;
begin
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  begin execute sq; get diagnostics c = row_count; v := 'rows=' || c;
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,140); end;
  perform set_config('request.jwt.claims','',true);
  insert into r(subject,pair,role,k,got,want) values (sj,pr,ro,kk,v,wt);
end $fn$;

-- want: an exact string; 'ERR <sqlstate>' (prefix); '>=N'; '~<regex>'; 'info'
-- (recorded, never fails); or several of those joined with '|'.
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
declare t0 timestamptz;
begin
  perform set_config('request.jwt.claims','',true);
  -- Everything below is synthetic: ids d00dxxxx-0000-4000-8000-..., names PROBE-DOORS-..., addresses @probe.invalid.
  insert into auth.users(id,email) values ('d00d1000-0000-4000-8000-000000000001','doors-vo@probe.invalid'),('d00d1000-0000-4000-8000-000000000002','doors-vm@probe.invalid'),('d00d1000-0000-4000-8000-000000000003','doors-vc@probe.invalid'),('d00d1000-0000-4000-8000-000000000004','doors-vf@probe.invalid'),('d00d1000-0000-4000-8000-000000000005','doors-vs@probe.invalid'),('d00d1000-0000-4000-8000-000000000006','doors-va@probe.invalid'),('d00d1000-0000-4000-8000-000000000007','doors-ao@probe.invalid'),('d00d1000-0000-4000-8000-000000000008','doors-ac@probe.invalid'),('d00d1000-0000-4000-8000-000000000009','doors-so@probe.invalid'),('d00d1000-0000-4000-8000-00000000000a','doors-nobody@probe.invalid'),('d00d1000-0000-4000-8000-00000000000b','doors-nocomp@probe.invalid'),('d00d1000-0000-4000-8000-00000000000c','doors-admin@probe.invalid');
  insert into public.companies(id,name,subscription_status,subscription_plan,suspended,trial_ends_at,admin_notes,leads_token,stripe_customer_id,invited_email,suspended_reason) values
    ('d00d0000-0000-4000-8000-000000000001','PROBE-DOORS-VICTIM','active','pro',false,now()+interval '30 days','','d00df000-0000-4000-8000-000000000001','cus_DOORS','',''),
    ('d00d0000-0000-4000-8000-000000000002','PROBE-DOORS-ATTACKER','active','pro',false,now()+interval '30 days','','d00df000-0000-4000-8000-000000000002','cus_DOORS','',''),
    ('d00d0000-0000-4000-8000-000000000003','PROBE-DOORS-SUSPENDED','active','pro',true,now()+interval '30 days','','d00df000-0000-4000-8000-000000000003','cus_DOORS','','');
  insert into public.profiles(id,company_id,full_name,role,is_platform_admin,permission_overrides,removed_from_company_id) values
    ('d00d1000-0000-4000-8000-000000000001','d00d0000-0000-4000-8000-000000000001','Doors Owner V','OWNER',false,'',null), ('d00d1000-0000-4000-8000-000000000002','d00d0000-0000-4000-8000-000000000001','Doors Manager V','MANAGER',false,'',null),
    ('d00d1000-0000-4000-8000-000000000003','d00d0000-0000-4000-8000-000000000001','Doors Crew V','CREW',false,'',null), ('d00d1000-0000-4000-8000-000000000004','d00d0000-0000-4000-8000-000000000001','Doors Foreman V','FOREMAN',false,'',null),
    ('d00d1000-0000-4000-8000-000000000005','d00d0000-0000-4000-8000-000000000001','Doors Sales V','SALES',false,'',null), ('d00d1000-0000-4000-8000-000000000006','d00d0000-0000-4000-8000-000000000001','Doors Accountant V','ACCOUNTANT',false,'',null),
    ('d00d1000-0000-4000-8000-000000000007','d00d0000-0000-4000-8000-000000000002','Doors Owner A','OWNER',false,'',null), ('d00d1000-0000-4000-8000-000000000008','d00d0000-0000-4000-8000-000000000002','Doors Crew A','CREW',false,'',null),
    ('d00d1000-0000-4000-8000-000000000009','d00d0000-0000-4000-8000-000000000003','Doors Owner S','OWNER',false,'',null),
    ('d00d1000-0000-4000-8000-00000000000b',null,'Doors No Company','CREW',false,'',null),
    ('d00d1000-0000-4000-8000-00000000000c',null,'Doors Operator','OWNER',true,'',null);
  insert into public.jobs(id,company_id,sync_id,customer_name,address,phone,email,status,contract_total,quote_token,is_test_fixture,notes,hoa_name,permit_number,priced_by,pricing_engine_version,estimated_duration_hours,waste_percent,updated_at) values ('d00d2000-0000-4000-8000-000000000001','d00d0000-0000-4000-8000-000000000001','d00d2000-0000-4000-8000-000000000001','DOORS CUSTOMER','1 Probe Way','555-0100','doors@probe.invalid','ACCEPTED',5000,gen_random_uuid(),false,'','','','','',4,10,'2026-01-01 00:00:00+00');
  insert into public.jobs(id,company_id,sync_id,customer_name,address,phone,email,status,contract_total,quote_token,is_test_fixture,notes,hoa_name,permit_number,priced_by,pricing_engine_version,estimated_duration_hours,waste_percent,updated_at) values ('d00d2000-0000-4000-8000-000000000002','d00d0000-0000-4000-8000-000000000001','d00d2000-0000-4000-8000-000000000002','DOORS CUSTOMER','1 Probe Way','555-0100','doors@probe.invalid','ACCEPTED',5000,gen_random_uuid(),false,'','','','','',4,10,'2026-01-01 00:00:00+00');
  insert into public.jobs(id,company_id,sync_id,customer_name,address,phone,email,status,contract_total,quote_token,is_test_fixture,notes,hoa_name,permit_number,priced_by,pricing_engine_version,estimated_duration_hours,waste_percent,updated_at) values ('d00d2000-0000-4000-8000-000000000003','d00d0000-0000-4000-8000-000000000002','d00d2000-0000-4000-8000-000000000003','DOORS CUSTOMER','1 Probe Way','555-0100','doors@probe.invalid','ACCEPTED',5000,gen_random_uuid(),false,'','','','','',4,10,'2026-01-01 00:00:00+00');
  update public.jobs set dispute_opened_at = now(), dispute_amount = 100 where sync_id = 'd00d2000-0000-4000-8000-000000000002';
  insert into public.payment_records(id,sync_id,company_id,job_sync_id,amount,method,received_at,note,recorded_by) values ('d00d3000-0000-4000-8000-000000000001','d00d3000-0000-4000-8000-000000000001','d00d0000-0000-4000-8000-000000000001','d00d2000-0000-4000-8000-000000000001',100,'check',now(),'','DOORS');
  insert into public.payment_records(id,sync_id,company_id,job_sync_id,amount,method,received_at,note,recorded_by) values ('d00d3000-0000-4000-8000-000000000005','d00d3000-0000-4000-8000-000000000005','d00d0000-0000-4000-8000-000000000002','d00d2000-0000-4000-8000-000000000003',200,'check',now(),'','DOORS');
  insert into public.attention_sweep_settings(company_id, enabled) values ('d00d0000-0000-4000-8000-000000000001', true);
  insert into public.company_settings(company_id, settings) values ('d00d0000-0000-4000-8000-000000000001', '{"require_device_key": true}'::jsonb);
  update public.profiles set active_device_id = 'PROBE-DOORS-DEV-OLD' where id = 'd00d1000-0000-4000-8000-000000000003';
  insert into public.device_keys(company_id, code, label, created_by) values ('d00d0000-0000-4000-8000-000000000001','PROBEKY1','doors victim key','d00d1000-0000-4000-8000-000000000001'), ('d00d0000-0000-4000-8000-000000000001','PROBEKY3','doors victim key 2','d00d1000-0000-4000-8000-000000000002'), ('d00d0000-0000-4000-8000-000000000002','PROBEKY2','doors attacker key','d00d1000-0000-4000-8000-000000000007');
  insert into public.device_tokens(token, user_id, company_id) values ('PROBE-DOORS-TOKEN-V1','d00d1000-0000-4000-8000-000000000001','d00d0000-0000-4000-8000-000000000001'), ('PROBE-DOORS-TOKEN-A1','d00d1000-0000-4000-8000-000000000007','d00d0000-0000-4000-8000-000000000002');
  insert into snap values ('fn_other', (select md5(coalesce(string_agg(p.oid::regprocedure::text || md5(pg_get_functiondef(p.oid)), ',' order by p.oid::regprocedure::text), '')) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p') and p.proname not in ('recompute_job_totals','company_allowed','company_allowed_unchecked','company_is_suspended','register_device_token','stamp_app_error_owner')));
  insert into snap values ('fn_acl3', (select md5(coalesce(string_agg(p.proname || ':' || coalesce(p.proacl::text,''), ',' order by p.proname), '')) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('recompute_job_totals','company_allowed','company_is_suspended','register_device_token')));
  insert into snap values ('pol_other', (select md5(coalesce(string_agg(md5(concat_ws('|',schemaname,tablename,policyname,cmd,roles::text,qual,with_check)), ',' order by schemaname,tablename,policyname), '')) from pg_policies where not (tablename = 'device_keys' and policyname = 'device_keys_read')));
  insert into snap values ('relacls', (select md5(coalesce(string_agg(c.relname || ':' || coalesce(c.relacl::text,''), ',' order by c.relname), '')) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','m','p','S')));
  insert into snap values ('trg_other', (select md5(coalesce(string_agg(pg_get_triggerdef(t.oid), ',' order by t.tgrelid::regclass::text, t.tgname), '')) from pg_trigger t where not t.tgisinternal and t.tgname <> '00_stamp_app_error_owner'));
  insert into snap values ('md5_recompute', (select md5(pg_get_functiondef('public.recompute_job_totals(uuid,uuid)'::regprocedure))));
  insert into snap values ('md5_allowed', (select md5(pg_get_functiondef('public.company_allowed(uuid)'::regprocedure))));
  insert into snap values ('md5_susp', (select md5(pg_get_functiondef('public.company_is_suspended()'::regprocedure))));
  insert into snap values ('md5_register', (select md5(pg_get_functiondef('public.register_device_token(text)'::regprocedure))));
  insert into snap values ('applied', (select (position('mail_is_backend' in pg_get_functiondef('public.recompute_job_totals(uuid,uuid)'::regprocedure)) > 0 or to_regprocedure('public.stamp_app_error_owner()') is not null or position('current_user_role' in coalesce((select qual from pg_policies where tablename = 'device_keys' and policyname = 'device_keys_read'),'')) > 0 or to_regprocedure('public.company_allowed_unchecked(uuid)') is not null or position('n = 0' in pg_get_functiondef('public.register_device_token(text)'::regprocedure)) > 0)::text));
  perform pg_temp.s('file','deployed','fixture','the four functions this file replaces are the deployed ones, none of this file is applied yet (the recorded md5 of each is the one the reverse restores)',$q$select (case when (select v from snap where k='applied') = 'true' then 'applied' when (select v from snap where k='md5_recompute') = '47177b2717e22f59f32d62645904caaf' and (select v from snap where k='md5_allowed') = '58d2f4b972cf4106f95cf1981df8fd0e' and (select v from snap where k='md5_register') = '9c5184da36904b48e3d1ab1db6900218' and (select v from snap where k='md5_susp') = '243565dc402ef3ed397598cd5039b8da' then 'true' else 'false' end)$q$,'true|applied');
  perform pg_temp.s('fixture','setup','fixture','the victim job carries the 100 on its ledger',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'100');
  perform pg_temp.s('fixture','setup','fixture','the attacker''s own job carries the 200 on its ledger',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000003'$q$,'200');
  perform pg_temp.s('fixture','setup','fixture','the sweep has a chargeback to report for the victim business (the server-side reader of company_allowed has work to do)',$q$select count(*)::text from public.attention_sweep_candidates() where company_id = 'd00d0000-0000-4000-8000-000000000001'$q$,'>=1');
  perform pg_temp.s('fixture','setup','fixture','the victim''s crew member is on a phone and the business requires a device key',$q$select (p.active_device_id is not null and (select (settings ->> 'require_device_key')::boolean from public.company_settings where company_id = 'd00d0000-0000-4000-8000-000000000001'))::text from public.profiles p where p.id = 'd00d1000-0000-4000-8000-000000000003'$q$,'true');
  perform pg_temp.sx('recompute_job_totals','setup','fixture','victim job 1: its cached amount_paid is set back to 0 while the ledger holds money (drift)',$q$update public.jobs set amount_paid = 0 where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'info');
  perform pg_temp.s('recompute_job_totals','setup','fixture','victim job 1: reads 0 now',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'0');
  perform pg_temp.q('recompute_job_totals','baseline','control','the attacker cannot read the victim''s job (the table wall is up; only the function door is open)','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select count(*)::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'0');
  perform pg_temp.x('recompute_job_totals','baseline','baseline','the attacker''s owner recomputes the totals of the VICTIM''s job by naming its ids (deployed function)','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select public.recompute_job_totals('d00d0000-0000-4000-8000-000000000001'::uuid, 'd00d2000-0000-4000-8000-000000000001'::uuid)$q$,'info');
  perform pg_temp.s('recompute_job_totals','baseline','baseline','...and the victim''s cached amount_paid now reads (0 before)',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'info');
  perform pg_temp.s('recompute_job_totals','baseline','baseline','...and the victim''s audit log now carries entries that name the attacker''s login as the actor',$q$select count(*)::text from public.audit_log where company_id = 'd00d0000-0000-4000-8000-000000000001' and actor = 'd00d1000-0000-4000-8000-000000000007'$q$,'info');
  insert into snap values ('audit_cv_by_ao', (select count(*)::text from public.audit_log where company_id = 'd00d0000-0000-4000-8000-000000000001' and actor = 'd00d1000-0000-4000-8000-000000000007'));
  perform pg_temp.q('company_allowed','baseline','baseline','the attacker asks whether the VICTIM business is paid up (deployed)','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select public.company_allowed('d00d0000-0000-4000-8000-000000000001')::text$q$,'info');
  perform pg_temp.q('company_allowed','baseline','baseline','...and whether the SUSPENDED business is (the answers differ: that is the leak)','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select public.company_allowed('d00d0000-0000-4000-8000-000000000003')::text$q$,'info');
  perform pg_temp.q('company_allowed','baseline','baseline','...and whether an id that is no business is (NULL)','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select public.company_allowed('d00d0000-0000-4000-8000-0000000000ff')::text$q$,'info');
  t0 := clock_timestamp();
  perform pg_temp.q('company_allowed','bench','info','3000 calls to company_is_suspended() by a member (the RLS gate that calls company_allowed)','d00d1000-0000-4000-8000-000000000001'::uuid,$q$select sum((public.company_is_suspended())::int)::text from generate_series(1,3000)$q$,'info');
  insert into r(subject,pair,role,k,got,want) values ('company_allowed','bench','info','ms for those 3000 calls, deployed function (includes the role switch, same on both sides)', round(extract(epoch from clock_timestamp() - t0) * 1000)::text, 'info');
  perform pg_temp.x('app_errors','baseline','baseline','the attacker''s owner files a crash report naming the VICTIM business and the victim''s owner as reporter, 200,000 characters of message (deployed)','d00d1000-0000-4000-8000-000000000007'::uuid,$q$insert into public.app_errors(company_id, reported_by, email, fatal, where_at, message, stack) values ('d00d0000-0000-4000-8000-000000000001', 'd00d1000-0000-4000-8000-000000000001', 'doors-baseline@probe.invalid', true, 'doors-baseline', repeat('A', 200000), repeat('B', 400000))$q$,'info');
  perform pg_temp.s('app_errors','baseline','baseline','...stored as: filed against the victim / attributed to the victim''s owner / message length / stack length',$q$select (company_id = 'd00d0000-0000-4000-8000-000000000001')::text || '/' || (reported_by = 'd00d1000-0000-4000-8000-000000000001')::text || '/' || length(message)::text || '/' || length(stack)::text from public.app_errors where where_at = 'doors-baseline'$q$,'info');
  perform pg_temp.x('register_device_token','baseline','baseline','the attacker''s owner registers the victim owner''s push token as their own (deployed)','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select public.register_device_token('PROBE-DOORS-TOKEN-V1')$q$,'info');
  perform pg_temp.s('register_device_token','baseline','baseline','...the token is now addressed to the attacker''s login and business',$q$select (user_id = 'd00d1000-0000-4000-8000-000000000007' and company_id = 'd00d0000-0000-4000-8000-000000000002')::text from public.device_tokens where token = 'PROBE-DOORS-TOKEN-V1'$q$,'info');
  perform pg_temp.sx('register_device_token','baseline','fixture','the token is put back where it was for the checks that follow',$q$update public.device_tokens set user_id = 'd00d1000-0000-4000-8000-000000000001', company_id = 'd00d0000-0000-4000-8000-000000000001' where token = 'PROBE-DOORS-TOKEN-V1'$q$,'info');
  perform pg_temp.s('register_device_token','baseline','fixture','...and reads as the victim owner''s again',$q$select (user_id = 'd00d1000-0000-4000-8000-000000000001' and company_id = 'd00d0000-0000-4000-8000-000000000001')::text from public.device_tokens where token = 'PROBE-DOORS-TOKEN-V1'$q$,'true');
  perform pg_temp.q('device_keys','baseline','control','the victim''s owner reads the victim''s two device keys','d00d1000-0000-4000-8000-000000000001'::uuid,$q$select count(*)::text from public.device_keys$q$,'2');
  perform pg_temp.q('device_keys','baseline','baseline','the victim''s CREW member reads the victim''s device keys straight from the table (deployed)','d00d1000-0000-4000-8000-000000000003'::uuid,$q$select count(*)::text from public.device_keys$q$,'info');
  perform pg_temp.q('device_keys','baseline','baseline','mint_device_key() as deployed, for the manager. KNOWN BUG, not in this file''s scope: its search_path is ''public'' but gen_random_bytes lives in ''extensions'', so in production it fails and no key has ever been minted (device_keys has held 0 rows ever)','d00d1000-0000-4000-8000-000000000002'::uuid,$q$select public.mint_device_key('doors probe', 7)$q$,'~^[A-Z0-9]{8}$|ERR 42883','mint0');
end $probe_before$;

-- ==== THE CHANGE: BEGIN ====
-- ==== FIX 1 (door 1: recompute_job_totals): BEGIN ====
create or replace function public.recompute_job_totals(co uuid, job_sid uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
    v_paid numeric;
    v_refunded numeric;
begin
    -- THE GUARD. The caller must belong to the business whose totals they ask
    -- to recompute. "Belong" is public.current_company_id() -- the helper every
    -- row-level-security policy in this database already uses -- read from the
    -- caller's JWT (auth.uid()), never from current_user, which inside a
    -- SECURITY DEFINER function is the function's owner and says nothing about
    -- who is asking.
    --
    -- The only other caller allowed is the server itself: mail_is_backend() is
    -- this database's existing test for it (no JWT at all, as for a statement
    -- run from the SQL editor or a migration, or a JWT whose role is the
    -- service role, as for the payment webhooks). A trigger fired by a person's
    -- own write to payment_records carries THAT person's JWT, whose company
    -- is the payment's company, so it passes the first term.
    --
    -- coalesce(..., false) is not decoration. current_company_id() is NULL for a
    -- signed-in person with no profile or no company, and NULL in an IF NOT
    -- reads as "do not raise": without it, exactly the strangers this guard is
    -- for would walk straight through.
    if not coalesce(public.mail_is_backend() or co = public.current_company_id(), false) then
        raise exception 'You can only recompute the totals of the business you belong to.'
            using errcode = '42501';
    end if;

    if job_sid is null then return; end if;
    select coalesce(sum(amount) filter (where amount >= 0), 0),
           coalesce(-sum(amount) filter (where amount < 0), 0)
      into v_paid, v_refunded
      from payment_records
     where company_id = co and job_sync_id = job_sid and deleted_at is null;

    update jobs
       set amount_paid = v_paid,
           refunded_amount = v_refunded
     where company_id = co and sync_id = job_sid
       and (abs(amount_paid - v_paid) > 0.005
            or abs(refunded_amount - v_refunded) > 0.005);
end;
$function$;
-- ==== FIX 1: END ====

-- ==== FIX 5 (door 5: device_keys_read): BEGIN ====
alter policy device_keys_read on public.device_keys
    using (company_id = public.current_company_id()
           and public.current_user_role()::text in ('OWNER', 'MANAGER'));
-- ==== FIX 5: END ====

-- ==== FIX 3 (door 3: crash reports (app_errors)): BEGIN ====
create or replace function public.stamp_app_error_owner() returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
    -- A crash report filed by a signed-in person belongs to that person and to
    -- the business they belong to, whatever the row says: the columns the phone
    -- sends are overwritten, not trusted. The server's own writes (no JWT, or
    -- the service role) pass untouched.
    --
    -- It CORRECTS rather than refuses on purpose. The phone uploads its whole
    -- queue in one insert and deletes the queue only when that insert succeeds,
    -- and each queued record carries the company stamped when it happened. A
    -- refusal for one stale company would reject the entire batch, and every
    -- later launch would retry it and be refused again.
    if not public.mail_is_backend() then
        new.company_id   := public.current_company_id();
        new.reported_by  := auth.uid();
        new.message      := left(new.message, 2000);
        new.stack        := left(new.stack, 20000);
        new.email        := left(new.email, 320);
        new.where_at     := left(new.where_at, 200);
        new.android      := left(new.android, 200);
        new.version_name := left(new.version_name, 64);
    end if;
    return new;
end
$function$;
revoke all on function public.stamp_app_error_owner() from public, anon, authenticated;
create or replace trigger "00_stamp_app_error_owner"
    before insert on public.app_errors
    for each row execute function public.stamp_app_error_owner();
-- ==== FIX 3: END ====

-- ==== FIX 2 (door 2: company_allowed): BEGIN ====
CREATE OR REPLACE FUNCTION public.company_allowed_unchecked(cid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select (not c.suspended)
       and c.subscription_status is distinct from 'canceled'
       and (
            c.subscription_status = 'active'
            -- 'trialing' used to pass on its own, whatever the date, so a
            -- trial whose end had come and gone kept full access for ever --
            -- and Stripe leaves the status at 'trialing' until something moves
            -- the subscription on. A NULL trial end still passes, because a
            -- subscriber whose trial_end has not arrived from Stripe yet must
            -- not be locked out on their first day: that failure is worse than
            -- the one being fixed, and it has happened here before.
            or (c.subscription_status = 'trialing'
                and (c.trial_ends_at is null or c.trial_ends_at > now()))
            or (c.trial_ends_at is not null and c.trial_ends_at > now())
            or (c.subscription_status = 'past_due'
                -- An explicit grace, else the date they have paid through,
                -- else none. Never an open-ended one.
                and coalesce(c.grace_ends_at, c.subscription_ends_at,
                             '-infinity'::timestamptz) > now())
       )
    from companies c
    where c.id = cid;
$function$;
revoke all on function public.company_allowed_unchecked(uuid) from public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.company_allowed(cid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    -- THE GUARD. A caller learns whether a business is paid up only if it is
    -- THEIR business (public.current_company_id(), the helper every policy here
    -- uses, read from the caller's JWT and not from current_user, which inside a
    -- SECURITY DEFINER function is the owner), or they are the operator
    -- (is_platform_admin(), which admin_companies() needs to list every business),
    -- or the server is asking (mail_is_backend(): no JWT, or the service role --
    -- create-payment-link, quote-view, lead-intake, mail-sync, send-follow-ups and
    -- attention_sweep_candidates() all ask about other businesses this way).
    -- Anyone else gets NULL: the same NULL a business that does not exist gets,
    -- which tells a stranger nothing. Every caller that reads this treats only an
    -- explicit false as "shut", so NULL locks nobody out, and a person asking about
    -- their OWN business never reaches it. A NULL in the test (no profile, no
    -- company, no cid) falls through CASE to NULL as well: the safe direction.
    select case when public.mail_is_backend()
                  or cid = public.current_company_id()
                  or public.is_platform_admin()
                then public.company_allowed_unchecked(cid)
           end;
$function$;

CREATE OR REPLACE FUNCTION public.company_is_suspended()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    -- The same question the rest of the product asks, so a cancelled or
    -- expired company cannot reach its data through a second tab or an old
    -- build. Defaults to NOT suspended when there is no company to judge --
    -- somebody mid-signup has no data to reach anyway, and locking out on an
    -- unknown would be a worse failure than the one being fixed.
    select not coalesce(
        public.company_allowed_unchecked(
            (select p.company_id from profiles p where p.id = auth.uid())),
        true);
$function$;
-- ==== FIX 2: END ====

-- ==== FIX 4 (door 4: register_device_token): BEGIN ====
create or replace function public.register_device_token(device_token text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
    n integer;
begin
    if auth.uid() is null then
        raise exception 'Must be signed in to register a device.';
    end if;

    -- A token names one physical phone, and device_tokens.company_id is the
    -- address the servers push to. It may be taken over by the same PERSON (who
    -- moves between businesses) or by a member of the business it is already
    -- addressed to (a shared van phone), and by nobody else. The test rides on the
    -- conflicting row itself (the DO UPDATE ... WHERE), so it is decided against
    -- the row as it is at that instant, not against a copy read a moment earlier.
    -- Equality, not "is not distinct from": a NULL company on either side never
    -- matches, so a person with no business cannot take a phone from one that has.
    insert into device_tokens (token, user_id, company_id, updated_at)
        values (device_token, auth.uid(), current_company_id(), now())
    on conflict (token) do update
        set user_id    = excluded.user_id,
            company_id = excluded.company_id,
            updated_at = now()
        where device_tokens.user_id = excluded.user_id
           or device_tokens.company_id = excluded.company_id;
    get diagnostics n = row_count;
    if n = 0 then
        raise exception 'This device is registered to another business. Sign out there first.'
            using errcode = '42501';
    end if;
end
$function$;
-- ==== FIX 4: END ====
-- ==== THE CHANGE: END ====

do $probe_after$
declare t0 timestamptz;
begin
  perform pg_temp.sx('recompute_job_totals','setup','fixture','victim job 1: its cached amount_paid is set back to 0 while the ledger holds money (drift)',$q$update public.jobs set amount_paid = 0 where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'info');
  perform pg_temp.s('recompute_job_totals','setup','fixture','victim job 1: reads 0 now',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'0');
  perform pg_temp.x('recompute_job_totals','attack','attack','the attacker''s owner recomputes the totals of the VICTIM''s job by naming its ids','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select public.recompute_job_totals('d00d0000-0000-4000-8000-000000000001'::uuid, 'd00d2000-0000-4000-8000-000000000001'::uuid)$q$,'ERR 42501');
  perform pg_temp.s('recompute_job_totals','attack','readback','...the victim''s cached amount_paid is still the 0 it was',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'0');
  perform pg_temp.x('recompute_job_totals','attack','attack','the attacker''s CREW member does the same','d00d1000-0000-4000-8000-000000000008'::uuid,$q$select public.recompute_job_totals('d00d0000-0000-4000-8000-000000000001'::uuid, 'd00d2000-0000-4000-8000-000000000001'::uuid)$q$,'ERR 42501');
  perform pg_temp.x('recompute_job_totals','attack','attack','a signed-in person with no profile at all does the same (current_company_id() is NULL: the trap the guard must not fall into)','d00d1000-0000-4000-8000-00000000000a'::uuid,$q$select public.recompute_job_totals('d00d0000-0000-4000-8000-000000000001'::uuid, 'd00d2000-0000-4000-8000-000000000001'::uuid)$q$,'ERR 42501');
  perform pg_temp.x('recompute_job_totals','attack','attack','a signed-in person whose profile has no business does the same','d00d1000-0000-4000-8000-00000000000b'::uuid,$q$select public.recompute_job_totals('d00d0000-0000-4000-8000-000000000001'::uuid, 'd00d2000-0000-4000-8000-000000000001'::uuid)$q$,'ERR 42501');
  perform pg_temp.x('recompute_job_totals','attack','attack','the operator (platform admin) is refused too: nothing in the operator''s pages calls this, so the money writer has no admin door','d00d1000-0000-4000-8000-00000000000c'::uuid,$q$select public.recompute_job_totals('d00d0000-0000-4000-8000-000000000001'::uuid, 'd00d2000-0000-4000-8000-000000000001'::uuid)$q$,'ERR 42501');
  perform pg_temp.x('recompute_job_totals','attack','attack','an anonymous caller does the same (no EXECUTE grant)',null::uuid,$q$select public.recompute_job_totals('d00d0000-0000-4000-8000-000000000001'::uuid, 'd00d2000-0000-4000-8000-000000000001'::uuid)$q$,'ERR 42501');
  perform pg_temp.x('recompute_job_totals','attack','attack','the attacker passes NULL as the company','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select public.recompute_job_totals(null::uuid, 'd00d2000-0000-4000-8000-000000000001'::uuid)$q$,'ERR 42501');
  perform pg_temp.x('recompute_job_totals','attack','attack','the attacker passes a company id that is no business at all (cannot probe which ids exist either)','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select public.recompute_job_totals('d00d0000-0000-4000-8000-0000000000ff'::uuid, 'd00d2000-0000-4000-8000-000000000001'::uuid)$q$,'ERR 42501');
  perform pg_temp.x('recompute_job_totals','attack','attack','the attacker names the VICTIM''s company with the attacker''s OWN job','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select public.recompute_job_totals('d00d0000-0000-4000-8000-000000000001'::uuid, 'd00d2000-0000-4000-8000-000000000003'::uuid)$q$,'ERR 42501');
  perform pg_temp.x('recompute_job_totals','attack','attack','the attacker names their OWN company with the VICTIM''s job (the guard passes; nothing may match)','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select public.recompute_job_totals('d00d0000-0000-4000-8000-000000000002'::uuid, 'd00d2000-0000-4000-8000-000000000001'::uuid)$q$,'rows=1');
  perform pg_temp.s('recompute_job_totals','attack','readback','...the victim''s cached amount_paid is still 0: an own-company id does not reach a foreign job',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'0');
  perform pg_temp.s('recompute_job_totals','attack','readback','...the victim''s audit log gained no entry naming the attacker since the baseline',$q$select ((select count(*) from public.audit_log where company_id = 'd00d0000-0000-4000-8000-000000000001' and actor = 'd00d1000-0000-4000-8000-000000000007')::text = (select v from snap where k='audit_cv_by_ao'))::text$q$,'true');
  perform pg_temp.s('recompute_job_totals','legit','readback','the victim job is unchanged by every refused call above',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'0');
  perform pg_temp.sx('recompute_job_totals','setup','fixture','the attacker''s own job: its cached amount_paid is set back to 0 while the ledger holds money (drift)',$q$update public.jobs set amount_paid = 0 where sync_id = 'd00d2000-0000-4000-8000-000000000003'$q$,'info');
  perform pg_temp.s('recompute_job_totals','setup','fixture','the attacker''s own job: reads 0 now',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000003'$q$,'0');
  perform pg_temp.x('recompute_job_totals','legit','control','a member recomputes their OWN business''s job (the call the guard must still allow)','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select public.recompute_job_totals('d00d0000-0000-4000-8000-000000000002'::uuid, 'd00d2000-0000-4000-8000-000000000003'::uuid)$q$,'rows=1');
  perform pg_temp.s('recompute_job_totals','legit','readback','...and the cached total is rebuilt from the ledger (200)',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000003'$q$,'200');
  perform pg_temp.x('recompute_job_totals','legit','control','the victim''s owner recomputes the victim job','d00d1000-0000-4000-8000-000000000001'::uuid,$q$select public.recompute_job_totals('d00d0000-0000-4000-8000-000000000001'::uuid, 'd00d2000-0000-4000-8000-000000000001'::uuid)$q$,'rows=1');
  perform pg_temp.s('recompute_job_totals','legit','readback','...and it is rebuilt from the ledger (100)',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'100');
  perform pg_temp.sx('recompute_job_totals','setup','fixture','victim job 1: its cached amount_paid is set back to 0 while the ledger holds money (drift)',$q$update public.jobs set amount_paid = 0 where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'info');
  perform pg_temp.s('recompute_job_totals','setup','fixture','victim job 1: reads 0 now',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'0');
  perform pg_temp.q('recompute_job_totals','legit','control','the Recalculate button''s function (a SECURITY DEFINER that calls this one with the caller''s own company) still works under the caller''s JWT','d00d1000-0000-4000-8000-000000000001'::uuid,$q$select public.recalculate_my_job_totals()::text$q$,'~^[1-9][0-9]*$');
  perform pg_temp.s('recompute_job_totals','legit','readback','...and the drifted job is rebuilt (100)',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'100');
  perform pg_temp.sx('recompute_job_totals','setup','fixture','victim job 1: its cached amount_paid is set back to 0 while the ledger holds money (drift)',$q$update public.jobs set amount_paid = 0 where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'info');
  perform pg_temp.s('recompute_job_totals','setup','fixture','victim job 1: reads 0 now',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'0');
  perform pg_temp.s('recompute_job_totals','legit','control','a caller with NO JWT at all (a script or migration run from the SQL editor) still recomputes any business',$q$select 'ok' from (select public.recompute_job_totals('d00d0000-0000-4000-8000-000000000001'::uuid, 'd00d2000-0000-4000-8000-000000000001'::uuid)) t$q$,'ok');
  perform pg_temp.s('recompute_job_totals','legit','readback','...rebuilt (100)',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'100');
  perform pg_temp.sx('recompute_job_totals','setup','fixture','victim job 1: its cached amount_paid is set back to 0 while the ledger holds money (drift)',$q$update public.jobs set amount_paid = 0 where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'info');
  perform pg_temp.s('recompute_job_totals','setup','fixture','victim job 1: reads 0 now',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'0');
  perform pg_temp.b('recompute_job_totals','legit','control','the server (JWT role = service role, as the payment webhooks) still recomputes any business',$q$select 'ok' from (select public.recompute_job_totals('d00d0000-0000-4000-8000-000000000001'::uuid, 'd00d2000-0000-4000-8000-000000000001'::uuid)) t$q$,'ok');
  perform pg_temp.s('recompute_job_totals','legit','readback','...rebuilt (100)',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'100');
  perform pg_temp.sx('recompute_job_totals','trigger','control','THE TRIGGER, no JWT: a payment written with no login at all (a script or migration) re-totals its job',$q$insert into public.payment_records(id,sync_id,company_id,job_sync_id,amount,method,received_at,note,recorded_by) values ('d00d3000-0000-4000-8000-000000000002','d00d3000-0000-4000-8000-000000000002','d00d0000-0000-4000-8000-000000000001','d00d2000-0000-4000-8000-000000000001',50,'check',now(),'','DOORS')$q$,'rows=1');
  perform pg_temp.s('recompute_job_totals','trigger','readback','...the job''s cached total follows the ledger (100 + 50)',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'150');
  perform pg_temp.x('recompute_job_totals','trigger','control','THE TRIGGER, the business''s own JWT: the victim''s owner records a 25 payment through the table','d00d1000-0000-4000-8000-000000000001'::uuid,$q$insert into public.payment_records(id,sync_id,company_id,job_sync_id,amount,method,received_at,note,recorded_by) values ('d00d3000-0000-4000-8000-000000000003','d00d3000-0000-4000-8000-000000000003','d00d0000-0000-4000-8000-000000000001','d00d2000-0000-4000-8000-000000000001',25,'check',now(),'','DOORS')$q$,'rows=1');
  perform pg_temp.s('recompute_job_totals','trigger','readback','...the job''s cached total follows (175)',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'175');
  perform pg_temp.x('recompute_job_totals','trigger','control','THE TRIGGER, the business''s own JWT: the owner soft-deletes that payment (an UPDATE)','d00d1000-0000-4000-8000-000000000001'::uuid,$q$update public.payment_records set deleted_at = now(), deleted_by = 'DOORS' where sync_id = 'd00d3000-0000-4000-8000-000000000003'$q$,'rows=1');
  perform pg_temp.s('recompute_job_totals','trigger','readback','...the job''s cached total follows (150)',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'150');
  perform pg_temp.bx('recompute_job_totals','trigger','control','THE TRIGGER, the server''s JWT (service role, as the payment webhooks): a 30 payment',$q$insert into public.payment_records(id,sync_id,company_id,job_sync_id,amount,method,received_at,note,recorded_by) values ('d00d3000-0000-4000-8000-000000000004','d00d3000-0000-4000-8000-000000000004','d00d0000-0000-4000-8000-000000000001','d00d2000-0000-4000-8000-000000000001',30,'check',now(),'','DOORS')$q$,'rows=1');
  perform pg_temp.s('recompute_job_totals','trigger','readback','...the job''s cached total follows (180)',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'180');
  perform pg_temp.x('recompute_job_totals','trigger','control','THE TRIGGER, another business''s own JWT: the attacker''s owner records a 10 payment on THEIR job','d00d1000-0000-4000-8000-000000000007'::uuid,$q$insert into public.payment_records(id,sync_id,company_id,job_sync_id,amount,method,received_at,note,recorded_by) values ('d00d3000-0000-4000-8000-000000000006','d00d3000-0000-4000-8000-000000000006','d00d0000-0000-4000-8000-000000000002','d00d2000-0000-4000-8000-000000000003',10,'check',now(),'','DOORS')$q$,'rows=1');
  perform pg_temp.s('recompute_job_totals','trigger','readback','...their job follows their ledger (210)',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000003'$q$,'210');
  perform pg_temp.s('recompute_job_totals','trigger','readback','...and the victim''s job is untouched by it (180)',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'180');
  perform pg_temp.x('recompute_job_totals','trigger','attack','the table wall is unchanged: the attacker''s owner writes a payment INTO the victim''s ledger','d00d1000-0000-4000-8000-000000000007'::uuid,$q$insert into public.payment_records(id,sync_id,company_id,job_sync_id,amount,method,received_at,note,recorded_by) values ('d00d3000-0000-4000-8000-000000000009','d00d3000-0000-4000-8000-000000000009','d00d0000-0000-4000-8000-000000000001','d00d2000-0000-4000-8000-000000000001',999,'check',now(),'','DOORS')$q$,'ERR 42501');
  perform pg_temp.s('recompute_job_totals','trigger','readback','...the victim''s job is still 180',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'180');
  perform pg_temp.q('device_keys','attack','attack','the victim''s crew member reads the victim''s device keys straight from the table','d00d1000-0000-4000-8000-000000000003'::uuid,$q$select count(*)::text from public.device_keys$q$,'0');
  perform pg_temp.q('device_keys','attack','attack','the victim''s foreman member reads the victim''s device keys straight from the table','d00d1000-0000-4000-8000-000000000004'::uuid,$q$select count(*)::text from public.device_keys$q$,'0');
  perform pg_temp.q('device_keys','attack','attack','the victim''s sales member reads the victim''s device keys straight from the table','d00d1000-0000-4000-8000-000000000005'::uuid,$q$select count(*)::text from public.device_keys$q$,'0');
  perform pg_temp.q('device_keys','attack','attack','the victim''s accountant member reads the victim''s device keys straight from the table','d00d1000-0000-4000-8000-000000000006'::uuid,$q$select count(*)::text from public.device_keys$q$,'0');
  perform pg_temp.q('device_keys','attack','attack','the attacker''s owner reads the victim''s device keys (already isolated; unchanged)','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select count(*)::text from public.device_keys where company_id = 'd00d0000-0000-4000-8000-000000000001'$q$,'0');
  perform pg_temp.q('device_keys','attack','attack','a signed-in person with no profile reads any device key','d00d1000-0000-4000-8000-00000000000a'::uuid,$q$select count(*)::text from public.device_keys$q$,'0');
  perform pg_temp.q('device_keys','attack','attack','an anonymous caller reads any device key',null::uuid,$q$select count(*)::text from public.device_keys$q$,'0');
  perform pg_temp.q('device_keys','legit','control','the victim''s owner still reads their business''s two keys from the table','d00d1000-0000-4000-8000-000000000001'::uuid,$q$select count(*)::text from public.device_keys$q$,'2');
  perform pg_temp.q('device_keys','legit','control','the victim''s manager still reads them','d00d1000-0000-4000-8000-000000000002'::uuid,$q$select count(*)::text from public.device_keys$q$,'2');
  perform pg_temp.q('device_keys','legit','control','list_device_keys() (the office''s screen) still lists the key for the owner','d00d1000-0000-4000-8000-000000000001'::uuid,$q$select count(*)::text || ':' || coalesce(string_agg(state, ',' order by code), '') from public.list_device_keys()$q$,'2:ready,ready');
  perform pg_temp.q('device_keys','legit','control','...and for the manager','d00d1000-0000-4000-8000-000000000002'::uuid,$q$select count(*)::text || ':' || coalesce(string_agg(state, ',' order by code), '') from public.list_device_keys()$q$,'2:ready,ready');
  perform pg_temp.q('device_keys','legit','control','...and still lists nothing for a crew member (unchanged)','d00d1000-0000-4000-8000-000000000003'::uuid,$q$select count(*)::text from public.list_device_keys()$q$,'0');
  perform pg_temp.q('device_keys','legit','control','mint_device_key() for the manager behaves exactly as deployed (a code if it works, the same gen_random_bytes failure if it does not: this file neither fixes nor breaks it)','d00d1000-0000-4000-8000-000000000002'::uuid,$q$select public.mint_device_key('doors probe', 7)$q$,'~^[A-Z0-9]{8}$|ERR 42883','mint1');
  perform pg_temp.s('device_keys','legit','readback','...and it is the same kind of answer as before the change',$q$select ((current_setting('doors.mint0') like 'ERR%') = (current_setting('doors.mint1') like 'ERR%'))::text$q$,'true');
  perform pg_temp.q('device_keys','legit','control','revoke_device_key() still revokes a key for the manager','d00d1000-0000-4000-8000-000000000002'::uuid,$q$select public.revoke_device_key('PROBEKY3')::text$q$,'true');
  perform pg_temp.s('device_keys','legit','readback','...and the key is marked revoked',$q$select (revoked_at is not null)::text from public.device_keys where code = 'PROBEKY3'$q$,'true');
  perform pg_temp.x('device_keys','legit','control','claim_device() (a SECURITY DEFINER reading device_keys) still lets a crew member claim a new phone with a valid key','d00d1000-0000-4000-8000-000000000003'::uuid,$q$select public.claim_device('PROBE-DOORS-DEV-NEW', 'PROBEKY1')$q$,'rows=1');
  perform pg_temp.s('device_keys','legit','readback','...and the key is spent by that crew member',$q$select (used_at is not null and used_by = 'd00d1000-0000-4000-8000-000000000003')::text from public.device_keys where code = 'PROBEKY1'$q$,'true');
  perform pg_temp.x('device_keys','legit','control','...and a wrong key is still refused, as before','d00d1000-0000-4000-8000-000000000003'::uuid,$q$select public.claim_device('PROBE-DOORS-DEV-THIRD', 'NOTAKEY99')$q$,'ERR 42501');
  perform pg_temp.x('app_errors','attack','attack','the attacker''s owner files a crash report naming the VICTIM business and the victim''s owner as reporter, 200,000 characters of message','d00d1000-0000-4000-8000-000000000007'::uuid,$q$insert into public.app_errors(company_id, reported_by, email, fatal, where_at, message, stack) values ('d00d0000-0000-4000-8000-000000000001', 'd00d1000-0000-4000-8000-000000000001', 'doors-after@probe.invalid', true, 'doors-after', repeat('A', 200000), repeat('B', 400000))$q$,'rows=1');
  perform pg_temp.s('app_errors','attack','readback','...it is accepted but stored under the ATTACKER''s business and login, message capped at 2000 and stack at 20000',$q$select (company_id = 'd00d0000-0000-4000-8000-000000000002')::text || '/' || (reported_by = 'd00d1000-0000-4000-8000-000000000007')::text || '/' || length(message)::text || '/' || length(stack)::text from public.app_errors where where_at = 'doors-after'$q$,'true/true/2000/20000');
  perform pg_temp.s('app_errors','attack','readback','...and nothing at all is filed against the victim business',$q$select count(*)::text from public.app_errors where company_id = 'd00d0000-0000-4000-8000-000000000001' and where_at like 'doors-%' and where_at <> 'doors-baseline' and email <> 'doors-server@probe.invalid'$q$,'0');
  perform pg_temp.x('app_errors','legit','control','a queued batch of three, as the phone uploads it (one names the victim, one the sender''s own business, one none): the whole batch is accepted','d00d1000-0000-4000-8000-000000000007'::uuid,$q$insert into public.app_errors(company_id, email, fatal, where_at, message, stack) values ('d00d0000-0000-4000-8000-000000000001', 'doors-b1@probe.invalid', true, 'doors-batch1', 'm', 's'), ('d00d0000-0000-4000-8000-000000000002', 'doors-b2@probe.invalid', false, 'doors-batch2', 'm', 's'), (null, 'doors-b3@probe.invalid', false, 'doors-batch3', 'm', 's')$q$,'rows=3');
  perform pg_temp.s('app_errors','legit','readback','...and all three are filed under the sender''s own business, none under the victim',$q$select count(*) filter (where company_id = 'd00d0000-0000-4000-8000-000000000002')::text || '/' || count(*) filter (where company_id = 'd00d0000-0000-4000-8000-000000000001')::text from public.app_errors where where_at like 'doors-batch%'$q$,'3/0');
  perform pg_temp.x('app_errors','legit','control','a report exactly as the phone writes one (every column CrashReporter sends, lengths like the longest real ones)','d00d1000-0000-4000-8000-000000000007'::uuid,$q$insert into public.app_errors(company_id, email, version_code, version_name, android, fatal, where_at, message, stack) values ('d00d0000-0000-4000-8000-000000000002', 'doors-app@probe.invalid', 1530, '1.530', 'Android 14 - Google Pixel 8', false, 'JobScreen', repeat('m', 400), repeat('s', 4473))$q$,'rows=1');
  perform pg_temp.s('app_errors','legit','readback','...is stored intact: message 400, stack 4473, build, screen, email, device, fatal flag, its own business',$q$select length(message)::text || '/' || length(stack)::text || '/' || version_name || '/' || version_code::text || '/' || where_at || '/' || email || '/' || android || '/' || fatal::text || '/' || (company_id = 'd00d0000-0000-4000-8000-000000000002')::text from public.app_errors where email = 'doors-app@probe.invalid'$q$,'400/4473/1.530/1530/JobScreen/doors-app@probe.invalid/Android 14 - Google Pixel 8/false/true');
  perform pg_temp.x('app_errors','attack','attack','a signed-in person with no profile files a report naming the victim','d00d1000-0000-4000-8000-00000000000a'::uuid,$q$insert into public.app_errors(company_id, reported_by, email, fatal, where_at, message, stack) values ('d00d0000-0000-4000-8000-000000000001', null, 'doors-nobody@probe.invalid', true, 'nobody', 'm', 's')$q$,'rows=1');
  perform pg_temp.s('app_errors','attack','readback','...it is stored under no business, as that person''s own',$q$select (company_id is null)::text || '/' || (reported_by = 'd00d1000-0000-4000-8000-00000000000a')::text from public.app_errors where where_at = 'nobody'$q$,'true/true');
  perform pg_temp.x('app_errors','attack','attack','an anonymous caller files a report (the insert policy still needs the signed-in role)',null::uuid,$q$insert into public.app_errors(company_id, reported_by, email, fatal, where_at, message, stack) values ('d00d0000-0000-4000-8000-000000000001', null, 'doors-anon@probe.invalid', true, 'anon', 'm', 's')$q$,'ERR 42501');
  perform pg_temp.b('app_errors','legit','control','the server (JWT role = service role) files a report naming a business: stored untouched',$q$insert into public.app_errors(company_id, reported_by, email, fatal, where_at, message, stack) values ('d00d0000-0000-4000-8000-000000000001', null, 'doors-server@probe.invalid', true, 'server', 'm', 's') returning 'ok'$q$,'ok');
  perform pg_temp.s('app_errors','legit','readback','...still filed under the business it names, and with no reporter',$q$select (company_id = 'd00d0000-0000-4000-8000-000000000001')::text || '/' || (reported_by is null)::text from public.app_errors where where_at = 'server'$q$,'true/true');
  perform pg_temp.s('app_errors','legit','control','a statement with no JWT (a script) files a report naming a business: stored untouched',$q$insert into public.app_errors(company_id, reported_by, email, fatal, where_at, message, stack) values ('d00d0000-0000-4000-8000-000000000001', null, 'doors-script@probe.invalid', true, 'script', 'm', 's') returning 'ok'$q$,'ok');
  perform pg_temp.s('app_errors','legit','readback','...still filed under the business it names',$q$select (company_id = 'd00d0000-0000-4000-8000-000000000001')::text || '/' || (reported_by is null)::text from public.app_errors where where_at = 'script'$q$,'true/true');
  perform pg_temp.q('app_errors','legit','control','the operator still reads the crash reports','d00d1000-0000-4000-8000-00000000000c'::uuid,$q$select count(*)::text from public.app_errors where email like 'doors-%@probe.invalid'$q$,'>=1');
  perform pg_temp.q('app_errors','attack','control','the attacker''s owner still cannot read them (unchanged)','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select count(*)::text from public.app_errors where email like 'doors-%@probe.invalid'$q$,'0');
  perform pg_temp.q('company_allowed','attack','attack','the attacker asks whether the VICTIM business is paid up','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select public.company_allowed('d00d0000-0000-4000-8000-000000000001')::text$q$,'NULL');
  perform pg_temp.q('company_allowed','attack','attack','...whether the SUSPENDED business is','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select public.company_allowed('d00d0000-0000-4000-8000-000000000003')::text$q$,'NULL');
  perform pg_temp.q('company_allowed','attack','attack','...whether an id that is no business is','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select public.company_allowed('d00d0000-0000-4000-8000-0000000000ff')::text$q$,'NULL');
  perform pg_temp.q('company_allowed','attack','attack','...the three answers are one and the same NULL: nothing to tell them apart by','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select (public.company_allowed('d00d0000-0000-4000-8000-000000000001') is null and public.company_allowed('d00d0000-0000-4000-8000-000000000003') is null and public.company_allowed('d00d0000-0000-4000-8000-0000000000ff') is null)::text$q$,'true');
  perform pg_temp.q('company_allowed','attack','attack','a signed-in person with no profile asks about the victim','d00d1000-0000-4000-8000-00000000000a'::uuid,$q$select public.company_allowed('d00d0000-0000-4000-8000-000000000001')::text$q$,'NULL');
  perform pg_temp.q('company_allowed','attack','attack','the attacker''s crew member asks about the victim','d00d1000-0000-4000-8000-000000000008'::uuid,$q$select public.company_allowed('d00d0000-0000-4000-8000-000000000001')::text$q$,'NULL');
  perform pg_temp.x('company_allowed','attack','attack','an anonymous caller asks (no EXECUTE grant)',null::uuid,$q$select public.company_allowed('d00d0000-0000-4000-8000-000000000001')$q$,'ERR 42501');
  perform pg_temp.q('company_allowed','legit','control','the attacker''s owner asks about THEIR OWN business: the real answer','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select public.company_allowed('d00d0000-0000-4000-8000-000000000002')::text$q$,'true');
  perform pg_temp.q('company_allowed','legit','control','the attacker''s crew member asks about their own business: the real answer','d00d1000-0000-4000-8000-000000000008'::uuid,$q$select public.company_allowed('d00d0000-0000-4000-8000-000000000002')::text$q$,'true');
  perform pg_temp.q('company_allowed','legit','control','the owner of the SUSPENDED business asks about their own: still false (suspension still bites)','d00d1000-0000-4000-8000-000000000009'::uuid,$q$select public.company_allowed('d00d0000-0000-4000-8000-000000000003')::text$q$,'false');
  perform pg_temp.q('company_allowed','legit','control','the operator asks about the victim: the real answer','d00d1000-0000-4000-8000-00000000000c'::uuid,$q$select public.company_allowed('d00d0000-0000-4000-8000-000000000001')::text$q$,'true');
  perform pg_temp.q('company_allowed','legit','control','the operator asks about the suspended business: the real answer','d00d1000-0000-4000-8000-00000000000c'::uuid,$q$select public.company_allowed('d00d0000-0000-4000-8000-000000000003')::text$q$,'false');
  perform pg_temp.q('company_allowed','legit','control','admin_companies() (the operator''s list) still reports every business''s real standing','d00d1000-0000-4000-8000-00000000000c'::uuid,$q$select string_agg(id::text || '=' || coalesce(allowed::text, 'null'), ',' order by id) from public.admin_companies() where id in ('d00d0000-0000-4000-8000-000000000001','d00d0000-0000-4000-8000-000000000002','d00d0000-0000-4000-8000-000000000003')$q$,'d00d0000-0000-4000-8000-000000000001=true,d00d0000-0000-4000-8000-000000000002=true,d00d0000-0000-4000-8000-000000000003=false');
  perform pg_temp.q('company_allowed','attack','control','...and returns nothing to anybody else (unchanged)','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select count(*)::text from public.admin_companies()$q$,'0');
  perform pg_temp.b('company_allowed','legit','control','the server (JWT role = service role: create-payment-link, quote-view, lead-intake, mail-sync, send-follow-ups) asks about the victim: true',$q$select public.company_allowed('d00d0000-0000-4000-8000-000000000001')::text$q$,'true');
  perform pg_temp.b('company_allowed','legit','control','...and about the suspended business: false',$q$select public.company_allowed('d00d0000-0000-4000-8000-000000000003')::text$q$,'false');
  perform pg_temp.b('company_allowed','legit','control','...and about an id that is no business: NULL, as before',$q$select public.company_allowed('d00d0000-0000-4000-8000-0000000000ff')::text$q$,'NULL');
  perform pg_temp.s('company_allowed','legit','control','a caller with NO JWT (a script or a migration) asks about the victim: true',$q$select public.company_allowed('d00d0000-0000-4000-8000-000000000001')::text$q$,'true');
  perform pg_temp.b('company_allowed','legit','control','attention_sweep_candidates() (the sweep''s edge function, service role) still reports the victim''s chargeback, because company_allowed still says yes to it',$q$select count(*)::text from public.attention_sweep_candidates() where company_id = 'd00d0000-0000-4000-8000-000000000001'$q$,'>=1');
  perform pg_temp.q('company_allowed','legit','control','company_is_suspended() (the gate every table policy calls) for a member of an active business','d00d1000-0000-4000-8000-000000000001'::uuid,$q$select public.company_is_suspended()::text$q$,'false');
  perform pg_temp.q('company_allowed','legit','control','...and for a member of the suspended business','d00d1000-0000-4000-8000-000000000009'::uuid,$q$select public.company_is_suspended()::text$q$,'true');
  perform pg_temp.x('company_allowed','attack','attack','the unguarded body sits behind a name no client can call: a signed-in person is refused','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select public.company_allowed_unchecked('d00d0000-0000-4000-8000-000000000001')$q$,'ERR 42501');
  perform pg_temp.x('company_allowed','attack','attack','...and an anonymous caller is refused',null::uuid,$q$select public.company_allowed_unchecked('d00d0000-0000-4000-8000-000000000001')$q$,'ERR 42501');
  perform pg_temp.s('company_allowed','attack','attack','...and no role a client or the server connects as has a grant on it (only the owner-run functions that need it can call it)',$q$select (not has_function_privilege('service_role', 'public.company_allowed_unchecked(uuid)', 'execute') and not has_function_privilege('authenticated', 'public.company_allowed_unchecked(uuid)', 'execute') and not has_function_privilege('anon', 'public.company_allowed_unchecked(uuid)', 'execute'))::text$q$,'true');
  perform pg_temp.s('company_allowed','legit','control','the unguarded body still answers correctly (true / false / NULL) for the owner-run functions that call it',$q$select public.company_allowed_unchecked('d00d0000-0000-4000-8000-000000000001')::text || '/' || public.company_allowed_unchecked('d00d0000-0000-4000-8000-000000000003')::text || '/' || coalesce(public.company_allowed_unchecked('d00d0000-0000-4000-8000-0000000000ff')::text, 'null')$q$,'true/false/null');
  perform pg_temp.q('company_allowed','legit','control','company_is_suspended() for a signed-in person with no profile: not suspended, as before (nothing to judge)','d00d1000-0000-4000-8000-00000000000a'::uuid,$q$select public.company_is_suspended()::text$q$,'false');
  perform pg_temp.q('company_allowed','legit','control','company_is_suspended() for an anonymous caller: not suspended, as before',null::uuid,$q$select public.company_is_suspended()::text$q$,'false');
  perform pg_temp.q('company_allowed','legit','control','the row-level wall that calls it still lets an active business read its ledger','d00d1000-0000-4000-8000-000000000001'::uuid,$q$select count(*)::text from public.payment_records$q$,'>=1');
  perform pg_temp.q('company_allowed','legit','control','...and still shows a suspended business nothing','d00d1000-0000-4000-8000-000000000009'::uuid,$q$select count(*)::text from public.payment_records$q$,'0');
  perform pg_temp.q('company_allowed','legit','control','my_service_status() for an active business','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select allowed::text from public.my_service_status()$q$,'true');
  perform pg_temp.q('company_allowed','legit','control','...and for the suspended one','d00d1000-0000-4000-8000-000000000009'::uuid,$q$select allowed::text from public.my_service_status()$q$,'false');
  perform pg_temp.q('company_allowed','legit','control','can_use_company_mail() for an active business''s owner','d00d1000-0000-4000-8000-000000000001'::uuid,$q$select public.can_use_company_mail()::text$q$,'true');
  perform pg_temp.q('company_allowed','legit','control','...for the suspended business''s owner','d00d1000-0000-4000-8000-000000000009'::uuid,$q$select public.can_use_company_mail()::text$q$,'false');
  perform pg_temp.q('company_allowed','legit','control','...and for a crew member, never','d00d1000-0000-4000-8000-000000000003'::uuid,$q$select public.can_use_company_mail()::text$q$,'false');
  t0 := clock_timestamp();
  perform pg_temp.q('company_allowed','bench','info','3000 calls to company_is_suspended() by a member (the RLS gate that calls company_allowed)','d00d1000-0000-4000-8000-000000000001'::uuid,$q$select sum((public.company_is_suspended())::int)::text from generate_series(1,3000)$q$,'info');
  insert into r(subject,pair,role,k,got,want) values ('company_allowed','bench','info','ms for those 3000 calls, with the guard (same shape as the baseline row)', round(extract(epoch from clock_timestamp() - t0) * 1000)::text, 'info');
  perform pg_temp.x('register_device_token','attack','attack','the attacker''s owner registers the victim owner''s push token as their own','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select public.register_device_token('PROBE-DOORS-TOKEN-V1')$q$,'ERR 42501');
  perform pg_temp.s('register_device_token','attack','readback','...the token is still addressed to the victim''s owner and business',$q$select (user_id = 'd00d1000-0000-4000-8000-000000000001' and company_id = 'd00d0000-0000-4000-8000-000000000001')::text from public.device_tokens where token = 'PROBE-DOORS-TOKEN-V1'$q$,'true');
  perform pg_temp.x('register_device_token','attack','attack','the direct table route is sealed as well (unchanged): an upsert of the same token through the table','d00d1000-0000-4000-8000-000000000007'::uuid,$q$insert into public.device_tokens(token, user_id, company_id) values ('PROBE-DOORS-TOKEN-V1','d00d1000-0000-4000-8000-000000000007','d00d0000-0000-4000-8000-000000000002') on conflict (token) do update set user_id = excluded.user_id, company_id = excluded.company_id$q$,'ERR 42501');
  perform pg_temp.x('register_device_token','attack','attack','the attacker''s crew member registers the victim owner''s token','d00d1000-0000-4000-8000-000000000008'::uuid,$q$select public.register_device_token('PROBE-DOORS-TOKEN-V1')$q$,'ERR 42501');
  perform pg_temp.x('register_device_token','attack','attack','an anonymous caller registers a token (as before: signed in only)',null::uuid,$q$select public.register_device_token('PROBE-DOORS-TOKEN-V1')$q$,'ERR P0001');
  perform pg_temp.s('register_device_token','attack','readback','...still the victim''s after all of those',$q$select (user_id = 'd00d1000-0000-4000-8000-000000000001' and company_id = 'd00d0000-0000-4000-8000-000000000001')::text from public.device_tokens where token = 'PROBE-DOORS-TOKEN-V1'$q$,'true');
  perform pg_temp.x('register_device_token','legit','control','the attacker''s owner re-registers THEIR OWN token','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select public.register_device_token('PROBE-DOORS-TOKEN-A1')$q$,'rows=1');
  perform pg_temp.x('register_device_token','legit','control','the attacker''s owner registers a brand-new token','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select public.register_device_token('PROBE-DOORS-TOKEN-NEW')$q$,'rows=1');
  perform pg_temp.s('register_device_token','legit','readback','...addressed to the attacker''s own login and business',$q$select (user_id = 'd00d1000-0000-4000-8000-000000000007' and company_id = 'd00d0000-0000-4000-8000-000000000002')::text from public.device_tokens where token = 'PROBE-DOORS-TOKEN-NEW'$q$,'true');
  perform pg_temp.x('register_device_token','legit','control','a colleague in the SAME business takes over the owner''s phone (a shared van phone)','d00d1000-0000-4000-8000-000000000003'::uuid,$q$select public.register_device_token('PROBE-DOORS-TOKEN-V1')$q$,'rows=1');
  perform pg_temp.s('register_device_token','legit','readback','...the token is now the colleague''s, still in the victim business',$q$select (user_id = 'd00d1000-0000-4000-8000-000000000003' and company_id = 'd00d0000-0000-4000-8000-000000000001')::text from public.device_tokens where token = 'PROBE-DOORS-TOKEN-V1'$q$,'true');
  perform pg_temp.x('register_device_token','legit','control','the same person registers the same token again (the app does this at every sign-in)','d00d1000-0000-4000-8000-000000000003'::uuid,$q$select public.register_device_token('PROBE-DOORS-TOKEN-V1')$q$,'rows=1');
  perform pg_temp.x('register_device_token','legit','control','a signed-in person with no business registers a brand-new token','d00d1000-0000-4000-8000-00000000000a'::uuid,$q$select public.register_device_token('PROBE-DOORS-TOKEN-NOCO')$q$,'rows=1');
  perform pg_temp.s('register_device_token','legit','readback','...stored with no business',$q$select (user_id = 'd00d1000-0000-4000-8000-00000000000a' and company_id is null)::text from public.device_tokens where token = 'PROBE-DOORS-TOKEN-NOCO'$q$,'true');
  perform pg_temp.x('register_device_token','attack','attack','a different person with no business takes that token (a NULL company never matches a NULL company)','d00d1000-0000-4000-8000-00000000000b'::uuid,$q$select public.register_device_token('PROBE-DOORS-TOKEN-NOCO')$q$,'ERR 42501');
  perform pg_temp.s('register_device_token','attack','readback','...still the first person''s',$q$select (user_id = 'd00d1000-0000-4000-8000-00000000000a')::text from public.device_tokens where token = 'PROBE-DOORS-TOKEN-NOCO'$q$,'true');
  -- THE TRADE-OFF, stated as a check rather than left as a hope: a phone handed from one business's login to a
  -- DIFFERENT business's login WITHOUT reinstalling the app carries the same token, and the app never deletes it at
  -- sign-out. The first attack row above is exactly that case; after this change it is refused (and the app swallows the
  -- refusal), where before it silently moved the phone. That is why door 4 is held and not called safe.
  perform pg_temp.s('catalogue','unchanged','control','every other function in public is byte for byte the deployed one',$q$select ((select md5(coalesce(string_agg(p.oid::regprocedure::text || md5(pg_get_functiondef(p.oid)), ',' order by p.oid::regprocedure::text), '')) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p') and p.proname not in ('recompute_job_totals','company_allowed','company_allowed_unchecked','company_is_suspended','register_device_token','stamp_app_error_owner')) = (select v from snap where k='fn_other'))::text$q$,'true');
  perform pg_temp.s('catalogue','unchanged','control','the three replaced functions kept their grants exactly',$q$select ((select md5(coalesce(string_agg(p.proname || ':' || coalesce(p.proacl::text,''), ',' order by p.proname), '')) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('recompute_job_totals','company_allowed','company_is_suspended','register_device_token')) = (select v from snap where k='fn_acl3'))::text$q$,'true');
  perform pg_temp.s('catalogue','unchanged','control','every policy except device_keys_read is untouched',$q$select ((select md5(coalesce(string_agg(md5(concat_ws('|',schemaname,tablename,policyname,cmd,roles::text,qual,with_check)), ',' order by schemaname,tablename,policyname), '')) from pg_policies where not (tablename = 'device_keys' and policyname = 'device_keys_read')) = (select v from snap where k='pol_other'))::text$q$,'true');
  perform pg_temp.s('catalogue','unchanged','control','device_keys_read is the one policy that changed',$q$select (position('current_user_role' in qual) > 0 and position('current_company_id' in qual) > 0 and cmd = 'SELECT')::text from pg_policies where tablename = 'device_keys' and policyname = 'device_keys_read'$q$,'true');
  perform pg_temp.s('catalogue','unchanged','control','no table, view or sequence has a different grant',$q$select ((select md5(coalesce(string_agg(c.relname || ':' || coalesce(c.relacl::text,''), ',' order by c.relname), '')) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','m','p','S')) = (select v from snap where k='relacls'))::text$q$,'true');
  perform pg_temp.s('catalogue','unchanged','control','every trigger except the one new one is untouched',$q$select ((select md5(coalesce(string_agg(pg_get_triggerdef(t.oid), ',' order by t.tgrelid::regclass::text, t.tgname), '')) from pg_trigger t where not t.tgisinternal and t.tgname <> '00_stamp_app_error_owner') = (select v from snap where k='trg_other'))::text$q$,'true');
  perform pg_temp.s('catalogue','unchanged','control','the new trigger is BEFORE INSERT on app_errors and nothing else',$q$select (select count(*) from pg_trigger where tgname = '00_stamp_app_error_owner' and tgrelid = 'public.app_errors'::regclass and tgtype = 7)::text || '/' || (select count(*) from pg_trigger where tgname = '00_stamp_app_error_owner')::text$q$,'1/1');
  perform pg_temp.s('catalogue','unchanged','control','the new function is owned by the same role as the functions it sits beside, and no client role can call it',$q$select (pg_get_userbyid(p.proowner) = (select pg_get_userbyid(proowner) from pg_proc where oid = 'public.recompute_job_totals(uuid,uuid)'::regprocedure) and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute'))::text from pg_proc p where p.oid = 'public.stamp_app_error_owner()'::regprocedure$q$,'true');
end $probe_after$;

-- ==== THE REVERSE: BEGIN ====
-- ==== REVERSE 1 (door 1: recompute_job_totals): BEGIN ====
CREATE OR REPLACE FUNCTION public.recompute_job_totals(co uuid, job_sid uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_paid numeric;
    v_refunded numeric;
begin
    if job_sid is null then return; end if;
    select coalesce(sum(amount) filter (where amount >= 0), 0),
           coalesce(-sum(amount) filter (where amount < 0), 0)
      into v_paid, v_refunded
      from payment_records
     where company_id = co and job_sync_id = job_sid and deleted_at is null;

    update jobs
       set amount_paid = v_paid,
           refunded_amount = v_refunded
     where company_id = co and sync_id = job_sid
       and (abs(amount_paid - v_paid) > 0.005
            or abs(refunded_amount - v_refunded) > 0.005);
end;
$function$;
-- ==== REVERSE 1: END ====

-- ==== REVERSE 5 (door 5: device_keys_read): BEGIN ====
alter policy device_keys_read on public.device_keys
    using (company_id = public.current_company_id());
-- ==== REVERSE 5: END ====

-- ==== REVERSE 3 (door 3: crash reports (app_errors)): BEGIN ====
drop trigger if exists "00_stamp_app_error_owner" on public.app_errors;
drop function if exists public.stamp_app_error_owner();
-- ==== REVERSE 3: END ====

-- ==== REVERSE 2 (door 2: company_allowed): BEGIN ====
CREATE OR REPLACE FUNCTION public.company_is_suspended()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    -- The same question the rest of the product asks, so a cancelled or
    -- expired company cannot reach its data through a second tab or an old
    -- build. Defaults to NOT suspended when there is no company to judge --
    -- somebody mid-signup has no data to reach anyway, and locking out on an
    -- unknown would be a worse failure than the one being fixed.
    select not coalesce(
        public.company_allowed(
            (select p.company_id from profiles p where p.id = auth.uid())),
        true);
$function$;

CREATE OR REPLACE FUNCTION public.company_allowed(cid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select (not c.suspended)
       and c.subscription_status is distinct from 'canceled'
       and (
            c.subscription_status = 'active'
            -- 'trialing' used to pass on its own, whatever the date, so a
            -- trial whose end had come and gone kept full access for ever --
            -- and Stripe leaves the status at 'trialing' until something moves
            -- the subscription on. A NULL trial end still passes, because a
            -- subscriber whose trial_end has not arrived from Stripe yet must
            -- not be locked out on their first day: that failure is worse than
            -- the one being fixed, and it has happened here before.
            or (c.subscription_status = 'trialing'
                and (c.trial_ends_at is null or c.trial_ends_at > now()))
            or (c.trial_ends_at is not null and c.trial_ends_at > now())
            or (c.subscription_status = 'past_due'
                -- An explicit grace, else the date they have paid through,
                -- else none. Never an open-ended one.
                and coalesce(c.grace_ends_at, c.subscription_ends_at,
                             '-infinity'::timestamptz) > now())
       )
    from companies c
    where c.id = cid;
$function$;

drop function if exists public.company_allowed_unchecked(uuid);
-- ==== REVERSE 2: END ====

-- ==== REVERSE 4 (door 4: register_device_token): BEGIN ====
do $reverse_register$
begin
    -- The deployed body has CRLF line endings; chr(13) puts them back so that
    -- md5(pg_get_functiondef(...)) is the deployed function's, not a look-alike.
    execute replace($def$CREATE OR REPLACE FUNCTION public.register_device_token(device_token text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
    if auth.uid() is null then
        raise exception 'Must be signed in to register a device.';
    end if;
    insert into device_tokens (token, user_id, company_id, updated_at)
        values (device_token, auth.uid(), current_company_id(), now())
    on conflict (token) do update
        set user_id    = excluded.user_id,
            company_id = excluded.company_id,
            updated_at = now();
end $function$$def$, chr(10), chr(13) || chr(10));
end
$reverse_register$;
-- ==== REVERSE 4: END ====
-- ==== THE REVERSE: END ====

do $probe_reversed$
begin
  perform pg_temp.s('reverse','restored','reverse','recompute_job_totals is the deployed function again, md5 of its definition',$q$select ((select md5(pg_get_functiondef('public.recompute_job_totals(uuid,uuid)'::regprocedure))) = '47177b2717e22f59f32d62645904caaf')::text$q$,'true');
  perform pg_temp.s('reverse','restored','reverse','company_allowed is the deployed function again',$q$select ((select md5(pg_get_functiondef('public.company_allowed(uuid)'::regprocedure))) = '58d2f4b972cf4106f95cf1981df8fd0e')::text$q$,'true');
  perform pg_temp.s('reverse','restored','reverse','company_is_suspended is the deployed function again',$q$select ((select md5(pg_get_functiondef('public.company_is_suspended()'::regprocedure))) = '243565dc402ef3ed397598cd5039b8da')::text$q$,'true');
  perform pg_temp.s('reverse','restored','reverse','the unguarded copy of company_allowed is gone',$q$select (to_regprocedure('public.company_allowed_unchecked(uuid)') is null)::text$q$,'true');
  perform pg_temp.s('reverse','restored','reverse','register_device_token is the deployed function again (CRLF line endings and all)',$q$select ((select md5(pg_get_functiondef('public.register_device_token(text)'::regprocedure))) = '9c5184da36904b48e3d1ab1db6900218')::text$q$,'true');
  perform pg_temp.s('reverse','restored','reverse','the crash-report trigger and its function are gone',$q$select (to_regprocedure('public.stamp_app_error_owner()') is null and not exists (select 1 from pg_trigger where tgname = '00_stamp_app_error_owner'))::text$q$,'true');
  perform pg_temp.s('reverse','restored','reverse','device_keys_read is the deployed policy again',$q$select (qual = '(company_id = current_company_id())' and cmd = 'SELECT' and with_check is null)::text from pg_policies where tablename = 'device_keys' and policyname = 'device_keys_read'$q$,'true');
  perform pg_temp.s('reverse','restored','reverse','no function, policy, trigger or grant anywhere differs from the deployed state',$q$select ((select md5(coalesce(string_agg(p.oid::regprocedure::text || md5(pg_get_functiondef(p.oid)), ',' order by p.oid::regprocedure::text), '')) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p') and p.proname not in ('recompute_job_totals','company_allowed','company_allowed_unchecked','company_is_suspended','register_device_token','stamp_app_error_owner')) = (select v from snap where k='fn_other') and (select md5(coalesce(string_agg(md5(concat_ws('|',schemaname,tablename,policyname,cmd,roles::text,qual,with_check)), ',' order by schemaname,tablename,policyname), '')) from pg_policies where not (tablename = 'device_keys' and policyname = 'device_keys_read')) = (select v from snap where k='pol_other') and (select md5(coalesce(string_agg(c.relname || ':' || coalesce(c.relacl::text,''), ',' order by c.relname), '')) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','m','p','S')) = (select v from snap where k='relacls') and (select md5(coalesce(string_agg(pg_get_triggerdef(t.oid), ',' order by t.tgrelid::regclass::text, t.tgname), '')) from pg_trigger t where not t.tgisinternal) = (select v from snap where k='trg_other') and (select md5(coalesce(string_agg(p.proname || ':' || coalesce(p.proacl::text,''), ',' order by p.proname), '')) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('recompute_job_totals','company_allowed','company_is_suspended','register_device_token')) = (select v from snap where k='fn_acl3'))::text$q$,'true');
  perform pg_temp.sx('recompute_job_totals','setup','fixture','victim job 1: its cached amount_paid is set back to 0 while the ledger holds money (drift)',$q$update public.jobs set amount_paid = 0 where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'info');
  perform pg_temp.s('recompute_job_totals','setup','fixture','victim job 1: reads 0 now',$q$select amount_paid::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'0');
  perform pg_temp.x('recompute_job_totals','reopened','baseline','after the reverse, the attacker''s owner can recompute the victim''s job again (the hole is back, so the reverse is a true reverse)','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select public.recompute_job_totals('d00d0000-0000-4000-8000-000000000001'::uuid, 'd00d2000-0000-4000-8000-000000000001'::uuid)$q$,'rows=1');
  perform pg_temp.s('recompute_job_totals','reopened','readback','...and the victim''s cached amount_paid moved (it reads the ledger''s total again)',$q$select (amount_paid > 0)::text from public.jobs where sync_id = 'd00d2000-0000-4000-8000-000000000001'$q$,'true');
  perform pg_temp.q('company_allowed','reopened','baseline','after the reverse, the attacker can ask whether the victim is paid up again','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select public.company_allowed('d00d0000-0000-4000-8000-000000000001')::text$q$,'true');
  perform pg_temp.q('device_keys','reopened','baseline','after the reverse, the victim''s crew member reads the victim''s device keys again','d00d1000-0000-4000-8000-000000000003'::uuid,$q$select (count(*) >= 1)::text from public.device_keys$q$,'true');
  perform pg_temp.x('register_device_token','reopened','baseline','after the reverse, the attacker''s owner can take the victim''s token again','d00d1000-0000-4000-8000-000000000007'::uuid,$q$select public.register_device_token('PROBE-DOORS-TOKEN-V1')$q$,'rows=1');
  perform pg_temp.x('app_errors','reopened','baseline','after the reverse, a crash report naming another business is stored as named','d00d1000-0000-4000-8000-000000000007'::uuid,$q$insert into public.app_errors(company_id, reported_by, email, fatal, where_at, message, stack) values ('d00d0000-0000-4000-8000-000000000001', 'd00d1000-0000-4000-8000-000000000001', 'doors-reopened@probe.invalid', true, 'reopened', 'm', 's')$q$,'rows=1');
  perform pg_temp.s('app_errors','reopened','readback','...filed against the victim, attributed to the victim''s owner',$q$select (company_id = 'd00d0000-0000-4000-8000-000000000001' and reported_by = 'd00d1000-0000-4000-8000-000000000001')::text from public.app_errors where where_at = 'reopened'$q$,'true');
end $probe_reversed$;

select n, subject, pair, role, k, got, want, case when pg_temp.ok(got, want) then 'PASS' else 'FAIL' end as result from r
union all
select 1000000, 'SUMMARY', '-', '-', 'passed/total',
       (select count(*) filter (where pg_temp.ok(got, want))::text || '/' || count(*)::text from r), '-', '-'
 order by 1;

rollback;

-- =============================================================================
-- PART 2 -- APPLY DOORS 5 AND 3.  SAFE TO APPLY (see the header for why).
-- To apply: delete the line "/* PART 2 BEGINS" and the line "PART 2 ENDS */", run
-- this block alone, then put both lines back. The statements are byte for byte
-- the ones PART 1 proved (tests/a26-doors.test.mjs holds them equal). Doors 1 and
-- 2 are deliberately NOT here: they are dry-run only until the owner decides.
-- =============================================================================
/* PART 2 BEGINS
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ==== FIX 5 (door 5: device_keys_read): BEGIN ====
alter policy device_keys_read on public.device_keys
    using (company_id = public.current_company_id()
           and public.current_user_role()::text in ('OWNER', 'MANAGER'));
-- ==== FIX 5: END ====

-- ==== FIX 3 (door 3: crash reports (app_errors)): BEGIN ====
create or replace function public.stamp_app_error_owner() returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
    -- A crash report filed by a signed-in person belongs to that person and to
    -- the business they belong to, whatever the row says: the columns the phone
    -- sends are overwritten, not trusted. The server's own writes (no JWT, or
    -- the service role) pass untouched.
    --
    -- It CORRECTS rather than refuses on purpose. The phone uploads its whole
    -- queue in one insert and deletes the queue only when that insert succeeds,
    -- and each queued record carries the company stamped when it happened. A
    -- refusal for one stale company would reject the entire batch, and every
    -- later launch would retry it and be refused again.
    if not public.mail_is_backend() then
        new.company_id   := public.current_company_id();
        new.reported_by  := auth.uid();
        new.message      := left(new.message, 2000);
        new.stack        := left(new.stack, 20000);
        new.email        := left(new.email, 320);
        new.where_at     := left(new.where_at, 200);
        new.android      := left(new.android, 200);
        new.version_name := left(new.version_name, 64);
    end if;
    return new;
end
$function$;
revoke all on function public.stamp_app_error_owner() from public, anon, authenticated;
create or replace trigger "00_stamp_app_error_owner"
    before insert on public.app_errors
    for each row execute function public.stamp_app_error_owner();
-- ==== FIX 3: END ====

do $check$
begin
    if to_regprocedure('public.stamp_app_error_owner()') is null
       or not exists (select 1 from pg_trigger where tgname = '00_stamp_app_error_owner' and tgrelid = 'public.app_errors'::regclass) then
        raise exception 'the crash-report trigger is not in place; nothing committed';
    end if;
    if has_function_privilege('authenticated', 'public.stamp_app_error_owner()', 'execute')
       or has_function_privilege('anon', 'public.stamp_app_error_owner()', 'execute') then
        raise exception 'a client role can call the trigger function; nothing committed';
    end if;
    if position('current_user_role' in coalesce((select qual from pg_policies where tablename = 'device_keys' and policyname = 'device_keys_read'), '')) = 0 then
        raise exception 'device_keys_read was not narrowed to the office roles; nothing committed';
    end if;
end
$check$;

commit;
PART 2 ENDS */

-- =============================================================================
-- PART 3 -- APPLY DOOR 4.  HELD. Not proven safe: read the header first.
-- Same way: delete "/* PART 3 BEGINS" and "PART 3 ENDS */", run alone, put them back.
-- =============================================================================
/* PART 3 BEGINS
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ==== FIX 4 (door 4: register_device_token): BEGIN ====
create or replace function public.register_device_token(device_token text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
    n integer;
begin
    if auth.uid() is null then
        raise exception 'Must be signed in to register a device.';
    end if;

    -- A token names one physical phone, and device_tokens.company_id is the
    -- address the servers push to. It may be taken over by the same PERSON (who
    -- moves between businesses) or by a member of the business it is already
    -- addressed to (a shared van phone), and by nobody else. The test rides on the
    -- conflicting row itself (the DO UPDATE ... WHERE), so it is decided against
    -- the row as it is at that instant, not against a copy read a moment earlier.
    -- Equality, not "is not distinct from": a NULL company on either side never
    -- matches, so a person with no business cannot take a phone from one that has.
    insert into device_tokens (token, user_id, company_id, updated_at)
        values (device_token, auth.uid(), current_company_id(), now())
    on conflict (token) do update
        set user_id    = excluded.user_id,
            company_id = excluded.company_id,
            updated_at = now()
        where device_tokens.user_id = excluded.user_id
           or device_tokens.company_id = excluded.company_id;
    get diagnostics n = row_count;
    if n = 0 then
        raise exception 'This device is registered to another business. Sign out there first.'
            using errcode = '42501';
    end if;
end
$function$;
-- ==== FIX 4: END ====

do $check$
begin
    if position('get diagnostics n = row_count' in pg_get_functiondef('public.register_device_token(text)'::regprocedure)) = 0 then
        raise exception 'register_device_token does not carry the guard; nothing committed';
    end if;
end
$check$;

commit;
PART 3 ENDS */

-- =============================================================================
-- PART 4 -- REVERSE.  Puts every function and the policy back byte for byte
-- (checked by md5 of the definition) and drops the one new function and trigger,
-- which hold no data. It deletes no row. It is safe to run whether or not a door
-- was applied. Same way: delete "/* PART 4 BEGINS" and "PART 4 ENDS */".
-- Reversing re-opens every hole it was applied over.
-- =============================================================================
/* PART 4 BEGINS
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ==== REVERSE 1 (door 1: recompute_job_totals): BEGIN ====
CREATE OR REPLACE FUNCTION public.recompute_job_totals(co uuid, job_sid uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_paid numeric;
    v_refunded numeric;
begin
    if job_sid is null then return; end if;
    select coalesce(sum(amount) filter (where amount >= 0), 0),
           coalesce(-sum(amount) filter (where amount < 0), 0)
      into v_paid, v_refunded
      from payment_records
     where company_id = co and job_sync_id = job_sid and deleted_at is null;

    update jobs
       set amount_paid = v_paid,
           refunded_amount = v_refunded
     where company_id = co and sync_id = job_sid
       and (abs(amount_paid - v_paid) > 0.005
            or abs(refunded_amount - v_refunded) > 0.005);
end;
$function$;
-- ==== REVERSE 1: END ====

-- ==== REVERSE 5 (door 5: device_keys_read): BEGIN ====
alter policy device_keys_read on public.device_keys
    using (company_id = public.current_company_id());
-- ==== REVERSE 5: END ====

-- ==== REVERSE 3 (door 3: crash reports (app_errors)): BEGIN ====
drop trigger if exists "00_stamp_app_error_owner" on public.app_errors;
drop function if exists public.stamp_app_error_owner();
-- ==== REVERSE 3: END ====

-- ==== REVERSE 2 (door 2: company_allowed): BEGIN ====
CREATE OR REPLACE FUNCTION public.company_is_suspended()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    -- The same question the rest of the product asks, so a cancelled or
    -- expired company cannot reach its data through a second tab or an old
    -- build. Defaults to NOT suspended when there is no company to judge --
    -- somebody mid-signup has no data to reach anyway, and locking out on an
    -- unknown would be a worse failure than the one being fixed.
    select not coalesce(
        public.company_allowed(
            (select p.company_id from profiles p where p.id = auth.uid())),
        true);
$function$;

CREATE OR REPLACE FUNCTION public.company_allowed(cid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select (not c.suspended)
       and c.subscription_status is distinct from 'canceled'
       and (
            c.subscription_status = 'active'
            -- 'trialing' used to pass on its own, whatever the date, so a
            -- trial whose end had come and gone kept full access for ever --
            -- and Stripe leaves the status at 'trialing' until something moves
            -- the subscription on. A NULL trial end still passes, because a
            -- subscriber whose trial_end has not arrived from Stripe yet must
            -- not be locked out on their first day: that failure is worse than
            -- the one being fixed, and it has happened here before.
            or (c.subscription_status = 'trialing'
                and (c.trial_ends_at is null or c.trial_ends_at > now()))
            or (c.trial_ends_at is not null and c.trial_ends_at > now())
            or (c.subscription_status = 'past_due'
                -- An explicit grace, else the date they have paid through,
                -- else none. Never an open-ended one.
                and coalesce(c.grace_ends_at, c.subscription_ends_at,
                             '-infinity'::timestamptz) > now())
       )
    from companies c
    where c.id = cid;
$function$;

drop function if exists public.company_allowed_unchecked(uuid);
-- ==== REVERSE 2: END ====

-- ==== REVERSE 4 (door 4: register_device_token): BEGIN ====
do $reverse_register$
begin
    -- The deployed body has CRLF line endings; chr(13) puts them back so that
    -- md5(pg_get_functiondef(...)) is the deployed function's, not a look-alike.
    execute replace($def$CREATE OR REPLACE FUNCTION public.register_device_token(device_token text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
    if auth.uid() is null then
        raise exception 'Must be signed in to register a device.';
    end if;
    insert into device_tokens (token, user_id, company_id, updated_at)
        values (device_token, auth.uid(), current_company_id(), now())
    on conflict (token) do update
        set user_id    = excluded.user_id,
            company_id = excluded.company_id,
            updated_at = now();
end $function$$def$, chr(10), chr(13) || chr(10));
end
$reverse_register$;
-- ==== REVERSE 4: END ====

do $check$
begin
    if md5(pg_get_functiondef('public.recompute_job_totals(uuid,uuid)'::regprocedure)) <> '47177b2717e22f59f32d62645904caaf' then
        raise exception 'recompute_job_totals is not the deployed one; nothing committed';
    end if;
    if md5(pg_get_functiondef('public.company_allowed(uuid)'::regprocedure)) <> '58d2f4b972cf4106f95cf1981df8fd0e' then
        raise exception 'company_allowed is not the deployed one; nothing committed';
    end if;
    if md5(pg_get_functiondef('public.company_is_suspended()'::regprocedure)) <> '243565dc402ef3ed397598cd5039b8da' then
        raise exception 'company_is_suspended is not the deployed one; nothing committed';
    end if;
    if to_regprocedure('public.company_allowed_unchecked(uuid)') is not null then
        raise exception 'the unguarded copy of company_allowed is still there; nothing committed';
    end if;
    if md5(pg_get_functiondef('public.register_device_token(text)'::regprocedure)) <> '9c5184da36904b48e3d1ab1db6900218' then
        raise exception 'register_device_token is not the deployed one; nothing committed';
    end if;
    if to_regprocedure('public.stamp_app_error_owner()') is not null
       or exists (select 1 from pg_trigger where tgname = '00_stamp_app_error_owner') then
        raise exception 'the crash-report trigger is still there; nothing committed';
    end if;
    if position('current_user_role' in coalesce((select qual from pg_policies where tablename = 'device_keys' and policyname = 'device_keys_read'), '')) > 0 then
        raise exception 'device_keys_read is still narrowed; nothing committed';
    end if;
end
$check$;

commit;
PART 4 ENDS */
