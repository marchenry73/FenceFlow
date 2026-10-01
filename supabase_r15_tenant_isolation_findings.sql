-- supabase_r15_tenant_isolation_findings.sql
--
-- ############################################################################
-- #  STATUS: NOT APPLIED.  Nothing in this file has been run against any     #
-- #  database as a change.  It is a findings record with proposed fixes,     #
-- #  written 2026-09-29 by the tenant-isolation audit.                       #
-- #                                                                          #
-- #  The whole file is ONE transaction that ends in ROLLBACK, so running it  #
-- #  by accident (SQL editor, psql -f, supabase db query -f) changes         #
-- #  nothing.  To apply a fix: read it, then run that block alone in a       #
-- #  transaction of its own that COMMITs.  F1 is a decision, not a patch,    #
-- #  and has no SQL here on purpose.                                         #
-- ############################################################################
--
-- THE QUESTION. Before a public release: can one paying company read or change
-- another company's data? Until now the answer was proven only WITHIN a company
-- (the crew boundary), plus the P4 probe against the Realtime change feed.
--
-- HOW IT WAS ANSWERED. tests/a25-tenant-isolation.test.mjs builds, inside one
-- rolled-back transaction, a synthetic ATTACKER company A, a synthetic VICTIM
-- company B and an empty one, then acts as A's OWNER (the strongest login a
-- tenant can hold, so a refusal has to come from the company boundary, not a
-- role) with `set local role authenticated` and a JWT for that user. Never the
-- service role: it bypasses row-level security, so a pass with it proves
-- nothing. The connection role only builds fixtures and READS BACK what an
-- attack did. Every attack is paired with a CONTROL (the same statement on A's
-- own row must work) or its refusal is worthless; a dead control turns a pair
-- INVALID, "could not establish", never "isolated".
--
--     1912 checks, 1898 pass. The 14 that fail are exactly the findings below
--     (11 attacks across F1-F6). 112 subjects: 106 isolated, 6 with a finding.
--     A second run plants an allow-all policy on every tenant table and demands
--     the isolation checks go red: they do (the probe has teeth).
--     After every live run the file asks the database whether anything was left
--     behind or any HTTP call queued: nothing (users, companies, policies,
--     objects, realtime subscriptions, pg_net requests: all zero).
--
-- WHAT WAS ATTEMPTED, as company A's owner against company B (and against every
-- real tenant, which was only ever COUNTED or looked for by the synthetic
-- attacker, never written and never impersonated):
--   SELECT   B's rows by key and by company_id; EVERY row not A's (the census);
--            rows with no company; as B against A; as anon; as a signed-in
--            person with no profile; as one whose profile has no company
--   UPDATE   B's rows; move A's own row INTO B; pull B's row into A
--   DELETE   B's rows
--   INSERT   a row carrying B's company_id (tenant poisoning), and the same row
--            as an upsert onto a key B already holds
--   REFER    a row of A's own that names B's job by its sync id
--   on 45 tenant tables (companies and profiles among them, including "make
--   myself a platform admin"), 5 crew views, 2 operator views, 8 tables that no
--   tenant login can read, the job-files bucket (select/insert/update/delete),
--   quote tokens (look one up, enumerate them all, read one through the crew
--   view, use one as anon), Realtime (the deployed realtime.apply_rls(), 16
--   published tables, three subscribers each), and 35 SECURITY DEFINER doors
--   called with B's ids, nine of them the operator's admin functions.
--
-- ----------------------------------------------------------------------------
-- VERDICT PER TABLE  (isolated = every attack refused AND its control worked)
-- ----------------------------------------------------------------------------
--   ISOLATED  jobs, estimate_line_items, fence_runs, change_orders,
--             payment_records, job_payments, employees, time_entries,
--             material_items, customers, expenses, punch_list_items,
--             site_markers, job_steps, field_changes, manufacturers,
--             pricing_tiers, build_templates, build_template_uses,
--             pricing_drift, company_settings, follow_up_settings,
--             attention_sweep_settings, attention_findings, automation_flags,
--             automation_rules, automation_runs, audit_log, job_stage_events,
--             follow_up_log, quote_reapprovals, sync_signals, invite_sends,
--             mail_accounts, mail_threads, mail_messages, mail_thread_jobs,
--             mail_access, company_setup_codes, device_tokens,
--             notification_prefs, companies, profiles, storage.objects
--             (job-files), the five *_crew views, platform_clients,
--             admin_release_audience, payment_connections, mail_account_secrets,
--             mail_events, mail_folder_state, mail_inbound_events,
--             mail_platform_settings, auth_events, auth_events_suppressed,
--             and Realtime for every one of the 16 published tables.
--   QUOTE TOKENS: ISOLATED. A cannot look up, enumerate or read B's tokens by
--             any path tried (table, crew view, anon, signed-in stranger). The
--             column defaults to gen_random_uuid(): 122 random bits.
--   LEAKS     device_keys (within one company only, F6), app_errors (F4).
--   LEAKS     through functions, not tables: recompute_job_totals (F2),
--             company_allowed (F3), register_device_token (F5), join_company (F1).
--   COULD NOT ESTABLISH  see "NOT ESTABLISHED" at the end.
--
--   Tables that hold NO real rows today (so the census was blind to nothing and
--   only the synthetic victim tested the policy): change_orders, punch_list_items,
--   manufacturers, build_template_uses, pricing_drift, attention_findings,
--   attention_sweep_settings, follow_up_log, device_keys, invite_sends,
--   mail_threads, mail_messages, mail_thread_jobs, mail_access. The policy text is
--   the same shape as on the tables that do, but "nothing leaked" there is
--   weaker evidence than "21 real jobs were invisible to the attacker".
--
-- ============================================================================
-- F1  HIGH (design)  A company's id is the crew invite code, and joining needs
--                    nobody's approval.
-- ============================================================================
--   Who could see or change what. Any signed-in person (anyone can sign up)
--   who holds a company's id calls join_company(<id>) and is a CREW member of it
--   at once, if the plan has a seat: Solo is full, Crew allows 6, Pro is
--   unlimited, a blank plan counts as 1. Today 3 of the 6 non-test companies
--   have a free seat, and 2 of those are in good standing (a joiner reads data
--   only where the company is allowed): the owner's own, and one Crew-plan trial.
--   Then, with no owner involvement, they read (verified on the synthetic B):
--     jobs_crew      every job: customer name, address, phone, email, notes
--     customers      the whole customer table
--     company_members()  who works there, and each role
--     fence_runs, punch lists, site markers, job steps, field changes,
--     build templates, manufacturers, automation/attention/follow-up rows,
--     sync_signals, quote_reapprovals (prior approver names), and device_keys
--   and change: crew_save_job() marks ANY of the company's jobs COMPLETED, and the
--   customers table takes an update from any member (a customer's name, phone,
--   address, email, notes).
--   Not reachable: money (SEE_MONEY), pay rates, mail, settings.
--   The reach is exactly a crew member's. It is that wide because crew job scope
--   (supabase_crew_job_scope.sql) is not applied in production: every crew login
--   sees every customer. That file would narrow it a long way: a login with no
--   crew record sees no jobs, and its customers policy needs "sees every job" plus
--   SEE_CUSTOMER_CONTACT to read and EDIT_JOBS to write. It narrows the reach; it
--   does not remove the joiner, who would still be a member.
--
--   Where the id leaks. Deliberately: invite-crew emails and the app's share
--   sheet hand it out. Latently: quote-view returns a signed URL for a
--   customer-drawn signature whose path is <company id>/<job id>/quote-signature/
--   ..., so the URL a CUSTOMER'S browser receives contains it. That path is
--   dormant today (quote_approved_signature_path does not exist in production;
--   supabase_quote_signature_patch.sql is not applied) and switches on the day
--   that patch is. Any later signed URL to job-files handed to a customer, an HOA
--   or a supplier carries it the same way.
--
--   Evidence: pairs join_company/join_door, join_reads_jobs, join_reads_customers,
--   join_reads_members, join_writes_jobs, join_writes_customers (control: the same call with an id that
--   is not a company IS refused, so the id is the only thing between a stranger
--   and B; and B's own crew member sees exactly the same rows).
--
--   Options, for the owner to choose (none is a one-line patch, all touch the
--   apps, so no SQL is proposed here):
--     A. Hold joiners. join_company() records a REQUEST (a new table, no profile
--        change); the owner approves it in the Team screen; only then does the
--        profile get its company. Closes it whatever leaks. Needs the owner UI
--        for the queue and a "waiting for approval" state for the joiner.
--     B. Make the code a secret of its own. companies.join_code, ~10 random
--        characters the owner can rotate; join_company(code). The company id
--        stops authorising anything. Needs invite-crew, AccountScreen and the
--        dashboard to share the code instead of the id.
--     C. Stop the leak at the source AND shrink the reach: quote-view proxies the
--        signature bytes instead of returning a URL, and supabase_crew_job_scope.sql
--        (which already scopes the crew views and `customers`) is applied.
--        Cheapest, but the id is still a live password.
--   Recommendation: B before release, A when there is time, C regardless.
--
-- ============================================================================
-- F2  MEDIUM  recompute_job_totals(co, job_sid) is callable by any signed-in user
-- ============================================================================
--   SECURITY DEFINER, executable by `authenticated`, and it takes the company id
--   from the CALLER. A, holding B's company id and one of B's job sync ids,
--   rewrote B's jobs.amount_paid (probe: 0 became 100). The value it writes is
--   recomputed from that job's own payment ledger, so it repairs drift rather
--   than inventing money, but it is a write into another tenant's row, and the
--   audit trigger files it in B's audit log with A's user as the actor (probe:
--   1 such entry), so B's owner sees a stranger's login changing their books.
--   Nothing in the apps, the website or the edge functions calls it; only the
--   payment_records trigger does, which runs as the owner and needs no grant.
--
-- F3  LOW     company_allowed(cid) tells any signed-in user another company's
--             billing standing (active / lapsed / suspended) by id.
--   price-job and invite-crew call it with the CALLER's JWT and their own
--   company (create-payment-link, quote-view, lead-intake and mail-sync call it as
--   the server), so it cannot simply be revoked from `authenticated`; it has to
--   refuse a foreign id itself.
--
-- F4  LOW     app_errors takes whatever company_id and reported_by the caller
--             writes, from anybody signed in, at any size and rate.
--   The insert policy is `auth.role() = 'authenticated'` and nothing else. A can
--   file crash reports attributed to B and to B's owner into the operator's
--   inbox; B never sees them (read is operator-only), so it corrupts the
--   operator's picture, not B's data. Probe: a 200,000-character report and one
--   from a signed-in stranger with no profile both land. It is also an
--   unauthenticated-cost vector: any account can fill the database.
--
-- F5  LOW (needs a secret)  register_device_token(t) re-points an existing push
--                           token at the caller.
--   ON CONFLICT (token) DO UPDATE runs as the owner and takes user_id/company_id
--   from the caller. Whoever knows another device's push token can send that
--   device's job, customer and payment notifications to themselves. The token is
--   ~160 random characters no tenant can read (probe: device_tokens is
--   isolated), so this needs a leak of the token first. Probe: B's token stopped
--   delivering to B.
--
-- F6  LOW (WITHIN one company, not across two)  device_keys is readable by every
--     member, crew included, straight from the table.
--   list_device_keys() is owner/manager only and nothing reads the table
--   directly, but the table's SELECT policy has no role in it, so a crew login
--   reads the unused keys the office minted for somebody else and can use one
--   first, which defeats the one-phone-per-login lock.
--
-- ============================================================================
-- LATENT (not a finding today; recorded so the next feature does not make it one)
-- ============================================================================
--   L1  stripe-webhook trusts metadata.company_id on subscription events and
--       never reads event.account. Safe today ONLY because the endpoint is a
--       platform endpoint: create-payment-link refuses connected-account links
--       (501) for exactly that reason, so a tenant's own Stripe account cannot
--       reach it. The day a Connect endpoint is added ("an event.account branch"
--       is the comment's own phrase), any tenant with a connected Stripe account
--       could create a subscription or checkout session on THEIR account with
--       metadata.company_id = someone else's id and have this handler set that
--       company's plan, subscription id or status. The Connect branch must
--       resolve the company from event.account, and metadata must never pick a
--       company.
--   L2  square-webhook finds the payment request by order id alone and then
--       writes to request.company_id without asserting it equals the merchant's
--       company (payment_connections.external_id = merchant_id). It relies on
--       Square order ids being unique across merchants. Add the equality check.
--   L3  jobs and the other child tables have no foreign key from job_sync_id, so
--       a tenant can insert its own row that names another tenant's job by sync
--       id (probe ref_x: accepted on 12 tables). It is inert: B's rows are
--       byte-for-byte unchanged and B cannot see it. Recorded because a future
--       server-side join on job_sync_id WITHOUT a company_id term would read it.
--
-- ============================================================================
-- NOT ESTABLISHED (could-not-establish, with the reason)
-- ============================================================================
--   * The Realtime websocket itself. The DEPLOYED realtime.apply_rls() was driven
--     with synthetic subscriptions (it is the function the server calls to decide
--     delivery) and B's changes reached nobody but B; the transport was not.
--   * Auth settings that live outside the database: whether email confirmation
--     is enforced (all 9 existing users are confirmed), rate limits on sign-up
--     and sign-in, and whether claim_invited_company's user_metadata path can be
--     reached with an unconfirmed address.
--   * The edge functions were READ, not exercised. Every one that takes an id
--     pins its queries to the caller's company (price-job, create-payment-link,
--     invite-crew, mail-connect, mail-message, mail-send, create-checkout-
--     session, quote-view, lead-intake); mail-* also refuse storage paths outside
--     <company id>/. quote-view, create-payment-link's token door, lead-intake
--     and the webhooks are the anonymous surface and were not called.
--   * claim_company_setup (setup-code guessing): 8 characters from ~34, about
--     1.8e12 codes, unrated. Not brute-forceable at API speed, but unrated.
--   * SECURITY DEFINER functions that take no id from the caller (my_*,
--     business_report, save_company_settings and the like) were read, not
--     attacked: they resolve the company from auth.uid() inside.
--
-- ============================================================================
-- THE PROPOSED FIXES  (F2 .. F6).  Each block is idempotent and non-destructive:
-- no row is read or written, nothing is dropped. They are checked by
--   A25_LIVE=1 A25_FIXES=1 node --test tests/a25-tenant-isolation.test.mjs
-- which runs `begin; <these blocks>; <the whole probe>` against production in ONE
-- rolled-back transaction and demands that only F1's pairs still fail.
-- ============================================================================
begin;
set local lock_timeout = '5s';

-- >>> FIX F2
-- Only the payment_records trigger (SECURITY DEFINER, so it runs as the owner and
-- needs no grant) and the server ever call it. service_role keeps its own grant.
revoke all on function public.recompute_job_totals(uuid, uuid) from public, anon, authenticated;
-- <<< FIX F2

-- >>> FIX F3
-- A signed-in caller may ask about their own company, the operator about any,
-- and the server (no user in the JWT) about any: which is every existing caller
-- (company_is_suspended, can_use_company_mail, my_service_status, price-job and
-- invite-crew: their own company; admin_companies: behind is_platform_admin();
-- attention_sweep_candidates and the service-role edge functions: no user).
-- Patches the LIVE body rather than replacing it, so any other change made to
-- the function since is kept.
do $fix$
declare d text;
begin
    d := pg_get_functiondef('public.company_allowed(uuid)'::regprocedure);
    if position('public.current_company_id()' in d) > 0 then
        raise notice 'company_allowed already refuses a foreign id';
    else
        d := regexp_replace(d, 'where c\.id = cid;',
             E'where c.id = cid\n      and (auth.uid() is null\n           or c.id = public.current_company_id()\n           or public.is_platform_admin());');
        if position('public.current_company_id()' in d) = 0 then
            raise exception 'company_allowed changed shape: the anchor "where c.id = cid;" is gone, merge the guard by hand';
        end if;
        execute d;
    end if;
end $fix$;
-- <<< FIX F3

-- >>> FIX F4
-- A signed-in caller's crash report belongs to that caller and their company,
-- whatever the row says (the server's own writes carry no user and pass
-- untouched), and is capped. The phone's upload keeps working: it never sent
-- anything but its own company, and a stale one is corrected, not refused, so a
-- queued batch is never rejected.
create or replace function public.stamp_app_error_owner() returns trigger
language plpgsql set search_path to 'public' as $function$
begin
    if auth.uid() is not null then
        new.company_id  := public.current_company_id();
        new.reported_by := auth.uid();
        new.message     := left(coalesce(new.message, ''), 2000);
        new.stack       := left(coalesce(new.stack, ''), 20000);
    end if;
    return new;
end $function$;
revoke all on function public.stamp_app_error_owner() from public, anon, authenticated;
create or replace trigger "00_stamp_app_error_owner"
    before insert on public.app_errors
    for each row execute function public.stamp_app_error_owner();
-- <<< FIX F4

-- >>> FIX F5
-- A push token names one physical phone. It may move between the same PERSON's
-- companies and between people of one company (a shared van phone), but not from
-- a person of one business to a stranger of another. TRADE-OFF for the owner: a
-- phone handed to a user of a DIFFERENT business without a sign-out or reinstall
-- now gets a visible refusal instead of silently taking over. Nothing in the app
-- deletes the token at sign-out today, so if that hand-over matters, add the
-- delete to sign-out first.
create or replace function public.register_device_token(device_token text) returns void
language plpgsql security definer set search_path to 'public' as $function$
begin
    if auth.uid() is null then
        raise exception 'Must be signed in to register a device.';
    end if;
    if exists (select 1 from device_tokens t
                where t.token = device_token
                  and t.user_id <> auth.uid()
                  and t.company_id is distinct from current_company_id()) then
        raise exception 'This device is registered to another business. Sign out there first.'
            using errcode = '42501';
    end if;
    insert into device_tokens (token, user_id, company_id, updated_at)
        values (device_token, auth.uid(), current_company_id(), now())
    on conflict (token) do update
        set user_id    = excluded.user_id,
            company_id = excluded.company_id,
            updated_at = now();
end $function$;
-- <<< FIX F5

-- >>> FIX F6
-- Owner and manager only, the same two roles list_device_keys() already serves.
-- Nothing reads the table directly (claim_device and the RPCs are definers).
alter policy device_keys_read on public.device_keys
    using (company_id = public.current_company_id()
           and public.current_user_role()::text in ('OWNER', 'MANAGER'));
-- <<< FIX F6

-- The file is a record. Change this to COMMIT only after reading every block, and
-- then only for the block you mean to apply (see the header).
rollback;
