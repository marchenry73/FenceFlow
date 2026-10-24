# FenceFlow security audit, 2026-10-24

Read-only. Live database `newcrgafcptspmapacrx`, the repo at `C:\Users\march\AndroidProjects\FenceEstimator`,
and the deployed edge functions (unauthenticated HTTP probes only). No SQL that writes was run; every
impersonation ran inside `begin read only` or was a plain SELECT. Nothing in the repo was changed.
No secret value appears in this file.

**Headline.** Cross-company isolation holds everywhere I could test it. Four things do not:

1. A hardening you shipped on 20 Oct was silently undone on 22 Oct. Any logged-in CREW member can read the
   platform admin's private `admin_notes`, the public `leads_token` and the Stripe ids for their company
   (H1). Your own `supabase_check_column_grants.sql` canary is FAILING right now and says so.
2. A company you remove from the admin console can un-remove itself (H2).
3. The join door is still open: the company id alone makes a stranger a CREW member (H3), and the crew-scope
   fix is also not applied (M1).
4. `invite-company` skips the admin second factor (M2).

## Findings, ranked

| # | Sev | What | Where |
|---|-----|------|-------|
| H1 | High | Column hardening on `companies` undone by a later table-level GRANT; crew read admin notes, leads token, Stripe ids | `supabase_r32_remove_and_restore_company.sql:25` |
| H2 | High | Owner of a removed company can clear `deleted_at` and bring it back | `protect_billing_columns()`, policy `companies_update` |
| H3 | High | `join_company(<company id>)` makes anyone signed in a CREW member; fix written, NOT applied; repo `invite-crew` calls an RPC that does not exist live | live `join_company`; `supabase_r18_join_door.sql`; `supabase/functions/invite-crew/index.ts:153` |
| M1 | Medium | Crew scope (`supabase_crew_job_scope.sql`) not applied: every crew login reads every job's customer phone, email, address | `jobs_crew` view; `customers` policies |
| M2 | Medium | `invite-company` checks the raw admin flag, not `is_platform_admin()`, so the MFA and email pin are bypassed | `supabase/functions/invite-company/index.ts:155-156` |
| M3 | Medium | Payment-link cap is skipped for an unknown job or zero total: any trial owner can mint arbitrary-amount links on FenceFlow's own Stripe account | `supabase/functions/create-payment-link/index.ts:361` (and 875-889) |
| M4 | Medium | `recompute_job_totals(co, job_sid)`: SECURITY DEFINER, no caller check, takes a company id, executable by every signed-in user | live function |
| M5 | Medium | `create-checkout-session` trusts any active Stripe price named "FenceFlow ..."; no allow-list | `supabase/functions/create-checkout-session/index.ts:114-127` |
| M6 | Medium | Structural: default privileges give `anon` and `authenticated` ALL on every new public table and EXECUTE on every new function; RLS is the only wall | `pg_default_acl` |
| L1 | Low | Guards that trust "no claims" or "null uid" (currently unreachable) | see Check 3 |
| L2 | Low | `company_allowed(cid)` is a status oracle for any company id | live function |
| L3 | Low | One shared `NOTIFY_TRIGGER_SECRET` across 5 functions, stored in clear in a trigger definition; `secretMatches` returns early on length | `job-change-push` trigger; `notify-job-change/index.ts:60` etc. |
| L4 | Low | OAuth `state` not bound to the browser session (login-CSRF) | `stripe-connect/index.ts:79`, `square-oauth/index.ts:81` |
| L5 | Low | `record_sign_in_failure` is anon-callable; its global cap can be burned to hide real failures | live function |
| L6 | Low | `quote-map` fails open if `SUPABASE_ANON_KEY` is unset; open tile proxy | `quote-map/index.ts:199-202` |
| L7 | Low | `billing-setup` is one static header token guarding Stripe product creation | `billing-setup/index.ts:49` |
| L8 | Low | Two source files contain a raw NUL byte, so grep treats them as binary | `supabase/functions/_shared/mail/errors.ts:122`, `tests/mail-errors.test.mjs` |
| L9 | Low | `android:allowBackup="true"`; debuggable state of the published APK unverified | `app/src/main/AndroidManifest.xml:30` |
| L10 | Low | Square webhook looks the order up by id without scoping to the merchant's company | `square-webhook/index.ts:478-485` |

No Critical found. Nothing found lets one company read another company's rows through the API.

---

## H1. companies column grants: the 20 Oct fix was reverted by 22 Oct

Evidence (live):
- `supabase_sec_company_reads.sql:65-66` revoked table SELECT from `authenticated` and re-granted column by column,
  leaving out `admin_notes`, `leads_token`, `stripe_customer_id`, `stripe_subscription_id`, `stripe_account_id`.
  `supabase_r19_company_column_grants.sql` (20 Oct 17:42) repaired it.
- `supabase_r32_remove_and_restore_company.sql:25` (22 Oct) runs `grant select, insert, update on public.companies to authenticated;`.
  A table-level grant covers every column, so the five exclusions are gone.
- `pg_class.relacl` for `public.companies` is `arwdDxtm` for both `anon` and `authenticated`.
  `has_column_privilege('authenticated','public.companies', <each of the five>,'select')` is true.
- Exercised as the CREW login in the main company (impersonated, RLS on): `count(admin_notes)=1`,
  `count(leads_token)=1`, `count(stripe_customer_id)=1`, `count(stripe_subscription_id)=1`,
  `visible_companies=1`, `other_companies=0`. So crew read the notes and tokens for their own company, and
  still cannot see another company's row.
- Independent confirmation: `supabase_check_column_grants.sql` run live returns
  `FAIL -- stopped detecting: companies.admin_notes, companies.leads_token, companies.stripe_customer_id, companies.stripe_subscription_id, companies.stripe_account_id`.
  Its canary did its job; nobody was running it after r32.
- `my_leads_token()` (OWNER/MANAGER only) is meaningless while the column itself is selectable.

Impact: any member of a company, including CREW, reads FenceFlow's private operator notes about that company,
the public-form token (lets them post up to 20 junk leads/hour) and Stripe identifiers. Bounded to the member's own row.

Fix direction: remove line 25 from r32, re-run the r19 pattern, and add the five-column assertion to whatever runs
after every migration. The original design is what keeps breaking (a new column is ungranted and takes mail
down). A sturdier shape is to stop granting columns of `companies` at all and serve the five private columns
only through SECURITY DEFINER functions or a separate table.

## H2. A removed company can un-remove itself

- `admin_remove_company` only sets `companies.deleted_at/deleted_by`. `company_allowed()` is the one gate that
  reads it.
- `protect_billing_columns()` (BEFORE UPDATE trigger on `companies`) resets 16 columns for non-admins but does not
  mention `deleted_at` or `deleted_by` (checked: `prosrc ~ 'deleted_at'` is false; no other trigger on `companies`
  mentions it). Both columns were added by r32 after the trigger was written.
- `companies_update` (`id = current_company_id() AND current_user_role() = 'OWNER'`) has no restrictive
  "not removed" policy beside it, and r32's table grant gives `authenticated` UPDATE on the column
  (`has_column_privilege(..., 'deleted_at','update')` true).
- Probe: as an OWNER, `rows_passing_companies_update_policy = 1`; as CREW (positive control for "the probe can say no") `= 0`.
- NOT exercised: the UPDATE itself would write. This is derived from policy text, trigger source and the privilege catalog.

Impact: the admin "remove company" control is advisory. The removed company's owner signs in (auth is independent
of `company_allowed`) and sends `PATCH companies {deleted_at:null}`.
Fix: add `deleted_at`/`deleted_by` to `protect_billing_columns()`.

## H3. The join door (known, not applied)

- Live `join_company(target_company_id, member_name, requested_role_in)`: after `auth.uid()` is non-null it only
  checks "no company yet", "not previously removed", then inserts a CREW profile. The company id is the only
  credential. `supabase_r18_join_door.sql` says in its own header: STATUS NOT APPLIED. The live catalog confirms it:
  no `company_join_codes` table, no `crew_join_code_for_invite` or `rotate_join_code` function.
- The id is not secret (that file lists invite emails, the member's own profile row, and the first segment of every job-file path).
- Once joined, the person reads everything in M1.
- The repo's `supabase/functions/invite-crew/index.ts:153` calls `crew_join_code_for_invite`. If that version is the
  deployed one, every crew invite returns "Could not prepare the invitation" today. UNVERIFIED which version is deployed
  (reading the deployed source needs a download, which writes files).
- Companion gap of the same kind: `notify-device-displaced` answers 500 `could not check the caller` to a bad secret
  because `displaced_push_ok` does not exist live (r9 not applied). It fails closed, so no security impact, but the feature is dead.

## M1. Crew scope not applied

`supabase_crew_job_scope.sql` is listed in `supabase/dev/apply-order.txt` but not live: `can_see_job`,
`sees_all_jobs`, `crew_job_guard` and `job_assignments` do not exist, and `customers` has only `customers_insert/read/update`.
Exercised as the CREW login: `jobs_crew_rows=30` of 33, `phones_visible=11`, `emails_visible=11`, `addresses_visible=11`
while `has_permission('SEE_CUSTOMER_CONTACT')=false`. `customers_read` (company only) lets crew read any customer row
(latent: the live company has 0 customers; the 2 rows sit in a test company with no logins, so a leak was not demonstrable).
It is a known pending item (needs crew logins linked to employee records first). Rated Medium because H3 turns it into a stranger-visible problem.

## M2. invite-company skips the admin second factor

Every other admin function asks `is_platform_admin()` AS THE CALLER (email pin + `admin_second_factor_ok()`).
`invite-company/index.ts:155-156` instead reads `profiles.is_platform_admin` with the service role. Control: the DB gate
works (`is_platform_admin()` is true only for the admin with `aal2`: false for anon, false for the same admin at `aal1`).
`invite-company` then calls `admin_mark_invited` as service role, which passes its own guard (`auth.uid() is null` and `is_service_role()`).
An admin session without the second factor can therefore send invitation mail and overwrite `companies.email/invited_email`
of any company. Taking over a company is limited by `claim_invited_company`, which refuses a company that already has an owner.
The gateway still demands a JWT (`verify_jwt=true`; live probe: 401).
Fix: call `asCaller.rpc("is_platform_admin")` like `admin-special/index.ts` does.

## M3. Payment links: what is and is not capped

Question 6 asked three things.

- **Can an unsigned webhook book a payment? No.** Both verifiers were extracted from the source files and run
  (`scratchpad/q/webhook_probe.mjs`): a correctly signed event is accepted (positive control); forged signature, tampered body,
  wrong secret, missing header and a 10-minute replay are all rejected (Stripe); forged, tampered, wrong URL, missing header,
  unset key and unset URL are all rejected (Square). Live: `stripe-webhook` POST with no signature and with a forged one gives 400
  `Bad signature` (a 500 `Webhook not configured` would mean the secret is unset; it is set);
  `square-webhook` gives 400; `resend-inbound` gives 401 `missing_headers`.
  Square returns the same 400 whether its key is unset or wrong, so "key is set" is UNVERIFIED for Square only
  (the code refuses either way).
- **Can a caller mint a link for another company? No.** `create-payment-link` takes the company only from the
  verified token's profile (`index.ts:669-691`); the body has no company field; every job/payment read is
  `.eq("company_id", profile.company_id)`. Live: no header 401; garbage bearer 401; OPTIONS 200 (control that the endpoint is reachable).
  The homeowner door needs a valid `quote_token` for an approved quote (random uuid gives 404) and derives the amount from the job row.
- **Can a link exceed what is owed? Not for a real, priced job; yes otherwise.** `planOpenLinks` (`index.ts:347-381`) refuses over-owed and
  paid-in-full. Extracted-code probe: $500 of $800 owed passes; $900 refused; $200 beside a $700 open link refused (positive controls).
  But the cap lives inside `if (contractTotal > 0)` (line 361). With `jobRow` null (a `jobSyncId` that is not a job in the
  caller's company) or `contract_total` 0/null, the same function returns `ok:true` for $99,999 (probed). The office door does not
  check that the job exists.
  Consequence: a trial OWNER or MANAGER, with a blank or non-Solo plan, can create unlimited links from $0.50 up. A company
  with no connected processor gets a link on FenceFlow's own Stripe account (`index.ts:1156-1184`; companies with a connected account get 501). That is a
  card-testing channel on your Stripe account and a way to charge a customer for a job that does not exist.
  Fix: in the office door require the job to exist in the caller's company, and refuse when no total is known unless the request is under a small ceiling.
- Minor: `kind` is not validated on the office door (stored as supplied); the role check ignores per-person permission overrides
  (a manager with `-REQUEST_PAYMENT` can still mint links through this function even though the table's RLS would refuse them).

## M4. recompute_job_totals

`public.recompute_job_totals(co uuid, job_sid uuid)` is SECURITY DEFINER, executable by `authenticated` (not `anon`),
and contains no `current_company_id()` or role check. Probe (read-only transaction, identity = the owner of a different company, target = a job in the main company):
the call reached its `UPDATE jobs ... where company_id = co` statement and stopped only because the transaction was read-only
(`25006 cannot execute UPDATE in a read-only transaction`, line 13 of the function). Control: the same call as `anon` gives
`42501 permission denied for function`. The update is idempotent (rewrites paid/refunded from the ledger), a `where` clause skips unchanged rows,
and there is currently no drift (0 jobs differ), so today's effect is nil; but it is an unguarded cross-tenant write primitive and would
touch `updated_at` through triggers if it ever did write. Its only legitimate callers are `payment_records_recompute()` (the ledger trigger) and
`recalculate_my_job_totals()` (which passes the caller's own company); neither needs the grant. Revoke EXECUTE from `authenticated`.

## M5. create-checkout-session trusts the client's priceId

`priceId` comes from the request (line 114). The plan is derived from the price's metadata or product name (126-127); there is no list of
allowed price ids and no `price.active` or amount check. Any active monthly price on the platform account whose product is named "FenceFlow ..."
(an old, discounted or test-leftover price) lets an owner buy that plan at that price. UNVERIFIED whether such a price exists
(listing Stripe prices needs the billing-setup token). Fix: allow-list the three live price ids server-side.

## M6. Default privileges

`pg_default_acl` for schema `public` grants `anon` and `authenticated` ALL on every new table and EXECUTE on every new function;
there is no event trigger that enables RLS. Most of the 63 tables currently give `anon` full DML at the privilege layer, held back only by RLS
(the exceptions are the mail, payment_connections, audit and crew-view relations whose grants were revoked). 23 non-trigger SECURITY DEFINER functions
are anon-executable (all read in Check 3). The first table someone forgets `enable row level security` on is world-writable.
Fix: `alter default privileges ... revoke all on tables/functions from anon`, plus a DDL event trigger or a post-migration assertion.

---

## Check-by-check results, with positive controls

Instrument notes (read before trusting any "0"):
- My first runner printed "0 rows" for a query that had actually errored; I rewrote it to print the raw error when `rows` is absent and proved it with a deliberately bad query.
- Running 6 queries in parallel tripped the pooler's auth circuit breaker for 7 tables; those were rerun serially. All results below are from successful runs.
- Impersonation: `set local role <anon|authenticated>` plus `request.jwt.claims` with `sub` and `role` (the role claim matters).
  Identities used: OWNER of the main company (also the platform admin, MFA enrolled, so NOT admin without `aal2`), OWNER of a second company
  (1 job), CREW in the main company, and `anon`.

### 1. Row Level Security
- 63 base tables in `public`, all with RLS enabled; 146 policies; 7 views (5 definer/barrier crew views scoped by `current_company_id()`, 2 `security_invoker`).
- Zero policies (deny-all): `admin_client_emails`, `invite_sends`, `mail_account_secrets`, `mail_events`, `mail_folder_state`,
  `mail_inbound_events`, `mail_platform_settings`, `payment_connections`. As `authenticated`, 7 of 8 return `42501 permission denied`
  (grants are revoked) while the tables hold rows as postgres (`payment_connections` 2, `mail_events` 34, `mail_inbound_events` 6): control passes.
  `invite_sends` has grants but 0 rows, so the deny is **UNVERIFIED by data** (verified only by catalog: RLS on, no policy).
- Isolation matrix: for the 57 relations that have `company_id`, counted rows "mine" vs "someone else's" as each identity.
  Totals as postgres show other companies' rows exist (jobs 41 total: main owner sees 33, second owner sees 1; audit_log 5402: 2393 / 5;
  sync_signals 1738: 371 / 1; payment_records 26: 24 / 0; employees 4: 2; customers 2, in a third company: 0).
  **"Someone else's" was 0 for every table, for all three signed-in identities.** Only exception: `build_templates` rows with `company_id IS NULL`
  (10 shared templates, readable by anon too; by design).
  Customers, employees, job_payments, payment_records: other-company count 0 (the customers and some employees belong to a company with no logins, so they are hidden from everyone I could impersonate).
- `companies` itself: each identity sees exactly 1 row (its own); `other_companies=0`.
- Storage: `job-files` 25 objects, all in the main company's folder. Main owner sees 25, other owner 0, anon 0; no bucket other than `releases` is public.
- anon: 0 rows on every company table (positive control: the same tables are non-empty as postgres); mail and view relations refuse with permission denied.
- Crew restrictions bite: the crew login sees 0 of 33 jobs on the base table, 0 payments, 0 estimate lines, and only its own time entries (2 of 13) and employee row (1 of 4).
- NOT exercised: cross-company or cross-role WRITES. A write probe cannot run in a read-only transaction. Write paths were checked by reading the INSERT/UPDATE policies: every one carries `company_id = current_company_id()`;
  UPDATE policies with a null WITH CHECK inherit USING, so a row cannot be moved to another company.

### 2. Stale per-column grants
- Query: for every relation in `public`, for `anon` and `authenticated` and for SELECT/INSERT/UPDATE, compare `count(columns)` with
  `count(has_column_privilege(...))`. Result: **no partial grants in `public`**. Only `companies` has column ACLs at all (26 of 33 columns), and it is now "column ACLs but full table grant" (see H1).
- Positive control (same query, same run): `pg_catalog.pg_subscription` is correctly flagged PARTIAL (17 of 18 columns SELECT for anon, authenticated and PUBLIC).
- So the stale-grant failure that took mail down on 20 Oct cannot occur right now, and the reason is the H1 regression. The repo check
  looks for partial grants plus its five named exceptions, which is why its canary now reports FAIL.

### 3. SECURITY DEFINER functions
- 198 functions in `public`; 161 SECURITY DEFINER, all owned by postgres, all with `search_path=public` set (none without).
- 23 non-trigger definers are executable by anon. I read all 23 bodies. All the `admin_*` ones gate on `is_platform_admin()`; `is_platform_admin()` returns
  false for a null uid (`p.id = auth.uid()` matches nothing, then `coalesce(..., false)`), so the null-uid trap is NOT present there.
  Probes (read-only txn): anon gives `is_platform_admin()=false`, 0 rows from `admin_removed_companies()` and `admin_client_email_log()`;
  `admin_remove_company(<nonexistent id>)` as anon raises the guard's own message `Only a platform admin can remove a company.`
  Positive control: the real admin with `aal2` gets `true`; the same admin at `aal1` gets `false`.
  `admin_claim_client_email` explicitly refuses a null actor. `my_leads_token`, `register_device_token`, `record_app_version`, `purge_job` all refuse or no-op for a null uid.
- Functions with a null-uid/no-claims escape hatch (the trap shape), and why each is currently unreachable:
  - `protect_billing_columns()` and `protect_platform_admin_flag()` return early on null `auth.uid()`. Unreachable by a client: RLS stops anon before the trigger fires, and calling the function directly gives
    `0A000 trigger functions can only be called as triggers` (probed as anon).
  - `hold_contract_columns`, `hold_first_contact_by`, `hold_quote_gate_columns`, `money_caller_trusted()`, `mail_is_backend()` treat **absent** `request.jwt.claims` as trusted.
    Probe: crew with claims gives `trusted=false`; no claims at all gives `true` (the hatch exists); anon with `{}` (what PostgREST sets with no JWT) gives `false`.
    Only a direct Postgres connection reaches it. L1.
- No function body contains a JWT or key literal. The `job-change-push` trigger on `jobs` carries `NOTIFY_TRIGGER_SECRET` (64 chars) in clear text in its definition (L3);
  `queue_welcome_email` and `queue_signup_email` read their secrets from Vault (correct) and `welcome_email_trigger_ok` / `signup_email_trigger_ok` are service-role-only and return false on an unset secret.
- 112 non-trigger definers are executable by authenticated. Those with no caller check at all: `recompute_job_totals` (M4), `company_allowed` (L2), `is_service_role`,
  `record_sign_in_failure` (L5). `advanced_reports_company_id`, `ar_aging` and `job_costing` also lack a direct check but are safe: they scope through `money_scope_company_id()`.
- `join_company` (H3) was read; `set_member_role`, `allow_rejoin` and `claim_company_setup` were read and check owner and company properly.

### 4. Secrets
- Scanner: 1,358 text files (build output, node_modules, vendor excluded) against 14 patterns. Canary: a planted file with a fake `sk_live_`, JWT, private-key block, assigned password and DB URL.
  **The canary is caught 5 of 5** (an unquoted `storePassword=` line is a gap in my patterns; `local.properties` was checked by hand instead).
- 36 hits, all triaged by masked line: every one is a unit-test fixture (placeholder passwords/tokens, JWT-shaped dummies, a svix test secret), or
  `app/google-services.json:18` (a Firebase client API key; that file is gitignored), or `website/dashboard.html:11069` (an `autocomplete` attribute name). No live key, no service-role key, no Stripe or Resend key in the tree.
  `website/config.js` holds only the project URL and publishable key (designed to be public).
- No `.env*`, `.pem`, `.p12`, `.jks`, `.keystore`, `keystore.properties` or service-account file in the tree. `local.properties` holds the Supabase URL and key and the keystore path and passwords; the keystore path is outside the project tree.
- `.gitignore` covers `local.properties`, `*.jks`, `*.keystore`, `keystore.properties`, `app/google-services.json`, `*Backups/`. It does not list `.env*`, `*.pem`, `*.p12` or `supabase/.temp` (none exist today).
  The repo has a `.git` directory, but git commands were off-limits, so "never committed" is UNVERIFIED; the result is "not currently present in the working tree".
- Two 64-hex strings in docs/tests are a certificate fingerprint (`GO_LIVE.md:29`) and a file hash (`tests/mail-render.test.mjs:539,545`), not secrets.
- Blind spot found: `supabase/functions/_shared/mail/errors.ts` (NUL at line 122) and `tests/mail-errors.test.mjs` contain raw NUL bytes, so `grep` calls them binary. I scanned them with NULs replaced (3 test-fixture hits only). L8.
- `GO_LIVE.md` (17 Sep) says shipped builds were debug-signed and debuggable; `app/build.gradle.kts:312` now sets `isDebuggable = false` for release. Whether the published APK is the release build is UNVERIFIED.

### 5. Edge function authorization
Door by function (live status from unauthenticated probes in parentheses):
- Signed-in office, JWT validated inside: `create-payment-link`, `price-job`, `invite-crew`, `stripe-connect`, `square-oauth`, `mail-connect`, `mail-message`, `mail-send`, `mail-sync` (office door). All gave 401 with no header or a garbage bearer.
  The company always comes from the token's profile, never the body; `price-job` and `invite-crew` run queries through the caller's own client so RLS applies.
- Gateway JWT plus function checks: `admin-special` and `admin-mail-send` (ask `is_platform_admin()` as the caller: correct), `create-checkout-session` (owner only; see M5), `invite-company` (gateway plus a weaker flag check: M2). Without a header: 401 from the gateway.
- Trigger-secret doors (`x-fenceflow-trigger`): `notify-job-change`, `attention-sweep`, `payment-receipt`, `send-follow-ups`, `quote-approval-email`, `mail-sync` (scheduled), `mail-send` (scheduled sweep).
  - Unset secret: all seven refuse (`503 not_configured` or `401`) before reading the body. Live: `mail-sync` answers `503 MAIL_SYNC_TRIGGER_SECRET is not set` (fails closed; the scheduled sync is simply not running).
  - Compare: `notify-job-change`, `attention-sweep`, `payment-receipt`, `send-follow-ups` and `billing-setup` use a bytewise XOR loop that returns early only on length mismatch (leaks the length only). `quote-approval-email` and the mail functions hash both sides and compare digests (no leak). Control run on the real `secretMatches` text: exact secret true; one wrong char, shorter, null, and empty-vs-empty all false.
  - Live: no header and a wrong header both give 401 on the five push/receipt/follow-up/approval functions. `attention-sweep` and `send-follow-ups` answer from the gateway (JWT required there); the GitHub workflows send the anon bearer plus the trigger header, so they pass the gateway.
  - L3: one shared `NOTIFY_TRIGGER_SECRET` opens `notify-job-change`, `attention-sweep`, `payment-receipt`, `quote-approval-email`, and is the fallback for `send-follow-ups`. It also sits in clear text in the `job-change-push` trigger definition.
- Vault-secret doors: `send-welcome-email`, `send-signup-email`, `notify-device-displaced` (shape-check the 64-hex header, then a service-role-only DB function compares digests; live 401 / 401 / 500 because the function is missing).
- Signature doors: `stripe-webhook`, `square-webhook`, `resend-inbound` (svix, constant time, 5-minute tolerance, unset or malformed secret refused).
- Token doors for strangers: `quote-view` (quote token plus a 4-digit phone gate with a locked counter; random token gives 404), `lead-intake` (leads token, 20/hour per company; random token 404, bad shape 400), `quote-map` (open tile proxy; L6), `apk-proxy` (public by design; filename regex pins it to release files; control: valid-shaped absent name gives 404, bad name 400).
- No function acts without verifying the caller or a secret. The weak spots are M2, M3, M5 and the low items.

### 6. Payment paths
Covered in M3 (unsigned webhook, foreign-company link, amount over owed) with controls. Additional notes:
- Webhooks book the amount from our own `job_payments` row (Stripe) or Square's reported amount for the matched order; a test-mode event is acknowledged but never booked; a replay is idempotent on the processor id.
- The Stripe event handlers key on the `payment_link` id and scope the job lookup by `company_id`.
- L10: the Square payment/refund/dispute handlers resolve the company from the merchant id but look the order up by `external_id` alone, then book to `request.company_id`.
  Exploitation needs a signed Square event whose order id equals another company's order id, which Square does not allow in practice; add `.eq("company_id", conn.company_id)` anyway.
- L4: the OAuth `state` is a server-stored random uuid tied to the company that started the flow, but not to the browser that started it. A contractor can start a flow, send the authorise URL to another business, and get that business's Square or Stripe account attached to the contractor's company.
  They cannot read the token; the cost is misdirected card money.

## Not verified, and why
- Cross-company or role-based WRITE attempts against live (read-only rule).
- The deployed source of each edge function (that it matches the repo is assumed from behaviour: refusals and error strings agree with the code I read).
- Which Stripe prices are active (M5), and whether the Square signature key is set.
- Realtime and PostgREST exposed-schema settings (no CLI read path).
- `invite_sends` deny-all (empty table).
- That nothing was ever committed to git (git was off-limits).
- Intra-company crew UPDATE paths on base tables that a crew login cannot SELECT.

## Method artifacts
Scratch only (not in the repo): `C:\Users\march\AppData\Local\Temp\claude\C--Users-march-OneDrive-Desktop-Claude\1efd664f-6d97-4c6b-86ea-0ee58b04bfdb\scratchpad\q\`
holds the SQL probes, `scan.js` (secret scanner with canary), `webhook_probe.mjs`, `plink_probe.mjs` and `sm_probe.mjs` (extracted-code controls).
