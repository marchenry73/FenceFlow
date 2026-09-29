-- ============================================================
-- FenceFlow -- F4, "the customer reply-to address should be the company's
-- email, accurately"
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- NOT APPLIED. Written on 28 September for list item F4. Read this whole
-- file before running any of it -- the answer it reaches is that NOTHING
-- HERE NEEDS TO BE RUN. It is a decision record and a live-data proof, kept
-- as its own file because the task that produced it asked for one; PART 2
-- is read-only and changes nothing either way.
--
-- WHY THIS ISN'T A SCHEMA CHANGE
--
--   The task that produced this file arrived with a located bug: mail-send's
--   Resend path sets replyTo to null, so a customer's reply goes to the
--   platform address instead of the contractor. That is not what the code
--   does. Read end to end (supabase/functions/mail-send/index.ts, its
--   caller.ts and reply.ts), the FenceFlow-mail path already computes a real
--   Reply-To with fenceflowReplyTo(): the thread's own inbound address once
--   receiving is proven (MAIL_INBOUND_DOMAIN + a verified webhook), else
--   companies.email, else the send is refused outright with "Add your
--   business email in Settings first" rather than silently falling back to
--   MAIL_FROM. tests/mail-send.test.mjs already asserts this in both
--   directions (line ~1448 and the inbound/company-email matrix at
--   ~1527) and passed before this file was written -- proving the rule is
--   real, not merely that a test exists. The only literal `replyTo: null` in
--   the file is in viaMailbox (the OWN-MAILBOX send path, ~line 894): that
--   path sends FROM the mailbox's own real, connected address, so a reply
--   already lands there with no header needed, and mail-send/index.ts now
--   carries a comment saying so plus a new test
--   ("mailbox: no Reply-To is added even though the company has its own
--   email on file") that fails if that is ever "fixed" into borrowing
--   companies.email there instead.
--
--   So the code's RULE was already right. What was checked next is whether
--   companies.email -- the column that rule reads -- is an address the
--   company can actually set to something of its own, accurately. It was
--   not, and PART 1 below is that finding.
--
-- PART 1  the real gap, found live (28 September, project newcrgafcptspmapacrx)
--
--   Every customer- or crew-facing consumer of a company's address reads the
--   SAME column, companies.email:
--     - mail-send's Resend reply-to (via caller.ts's companyEmail, this file)
--     - quote-view, printed on the customer's quote page
--     - invite-crew, the reply-to on crew invitation emails
--     - send-follow-ups, the reply-to on automated customer follow-ups
--   All four were confirmed live to read this one column and nothing else.
--
--   Nothing in the app could change it after signup. website/dashboard.html's
--   "Business Settings" panel has an Email field (s_email), but it read and
--   wrote company_settings.settings->>'email' -- a JSONB key inside a
--   DIFFERENT table, via the save_company_settings() RPC, whose live body
--   (pg_proc.prosrc, checked 28 September) only ever touches company_settings
--   and never companies:
--
--       insert into company_settings (company_id, settings, updated_at)
--           values (target, new_settings, now())
--       on conflict (company_id) do update
--           set settings = company_settings.settings || excluded.settings, ...
--
--   grep across supabase/functions and website/*.html for
--   settings->>'email' / settings.email found no reader anywhere. The office
--   could type an address into Business Settings, see it save, and it would
--   never reach a single quote, invitation, follow-up or FenceFlow-mail
--   reply. A control that does not do the thing.
--
--   This is why marc@fenceflowapp.com sat in companies.email for "Fence
--   solutions" (id aba5b097-afc4-48dd-9851-b50200d5e8f4) with no way for its
--   owner to change it short of the admin portal (a platform-admin-only
--   surface, not "his" settings) or SQL. Two more of the ten companies on
--   file are March's own test rows in the same state (Marc, Marco); every
--   REAL company checked (Horizon fence llc, PeterLLC, Legacy) already has
--   its own working address in companies.email, set at signup
--   (supabase_company_setup_patch.sql / supabase_onboarding_patch.sql both
--   insert companies with (name, email, ...)) and never touched since --
--   which is consistent with nobody having a way to touch it since.
--
-- THE FIX SHIPPED (no SQL): website/dashboard.html's Business Settings Email
-- field now loads from, and an OWNER's save writes directly to,
-- companies.email itself -- db.from('companies').update({email}) -- instead
-- of the settings blob. This needs no new column, no new RPC and no policy
-- change: the companies_update RLS policy already grants exactly this
-- (checked live, PART 2 below), and protect_billing_columns() (the one
-- BEFORE UPDATE trigger that clamps columns back for a non-platform-admin)
-- does not list email among the columns it protects, so the write passes
-- through untouched. A manager can still open the panel (save_company_settings
-- allows OWNER or MANAGER, unchanged), but the email field is disabled for
-- them client-side, because the RLS write-check is OWNER-only and a filtered
-- UPDATE is 0 rows changed with NO ERROR -- silently pretending to save is
-- worse than a disabled field that says why.
--
-- WHY NOT A SEPARATE reply_to_email COLUMN
--
--   The owner's own words distinguish "his address within the company" from
--   "the company's own", which reads as asking for two different addresses.
--   Read against what actually exists, the cleaner match is: his own address
--   (marc@fenceflowapp.com) is what happens to be typed into a field he had
--   no way to retype -- not a second, deliberately-different concept. A
--   reply_to_email column usable only from mail-send (the one file this
--   track owns) while quote-view, invite-crew and send-follow-ups kept
--   reading companies.email would let a company's quote promise one address
--   and a FenceFlow-mail reply land at another -- a worse inconsistency than
--   today's single stale value, and exactly the shape of problem F3's own
--   file (supabase_admin_owner_login_email.sql) already reasoned through for
--   the admin display: one column, one meaning, extend the READER instead of
--   forking the column. If a genuine company-level address independent of
--   any one person is wanted later (an office inbox, distinct from whatever
--   quotes show today), that is a real, separate feature -- add the column
--   then, wire all four readers to it in the same change, and give it a
--   real editor from day one. Adding it now, read by nothing but this one
--   function, is the fake control the owner's own rule names.
--
-- ------------------------------------------------------------------------
-- PART 2  proof, read-only, changes nothing
-- ------------------------------------------------------------------------

select 'CANARY: companies.email column exists (position check below is reading something)' as check,
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='companies' and column_name='email') as ok
union all
select 'no reply_to_email or similar column exists today (so nothing already reads one)',
       not exists (select 1 from information_schema.columns
                    where table_schema='public' and table_name='companies'
                      and column_name in ('reply_to_email','company_reply_to','support_email'))
union all
select 'the OWNER of a company may already UPDATE its own companies row (companies_update policy)',
       exists (select 1 from pg_policies
                where schemaname='public' and tablename='companies' and cmd='UPDATE'
                  and policyname='companies_update'
                  and qual = '((id = current_company_id()) AND (current_user_role() = ''OWNER''::user_role))')
union all
-- CANARY for the row above: proves this test can read a real policy
-- definition and is not vacuously true on a null/missing qual.
select 'CANARY: the policy-qual test can find text that is there',
       exists (select 1 from pg_policies
                where schemaname='public' and tablename='companies' and policyname='companies_update'
                  and qual is not null)
union all
select 'protect_billing_columns() does not clamp the email column back',
       (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='protect_billing_columns') not like '%new.email%'
union all
-- CANARY for the row above: the same body DOES clamp a real billing column,
-- so a trigger body that clamped nothing (wrong function, empty prosrc)
-- would not pass this file by having nothing left to find.
select 'CANARY: protect_billing_columns really does clamp something (suspended)',
       (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='protect_billing_columns') like '%new.suspended%'
union all
select 'save_company_settings() only ever writes company_settings, never companies',
       (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='save_company_settings') like '%insert into company_settings%'
   and (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='save_company_settings') not like '%companies%'
union all
select 'at least one real company already has its own working companies.email, set at signup',
       exists (select 1 from companies
                where email <> '' and email not ilike '%@fenceflowapp.com'
                  and name not ilike 'ZZ TEST%')
union all
-- CANARY: proves the row above is not vacuously true because the table is
-- empty or every row happens to be blank.
select 'CANARY: at least one company has SOME non-blank email (the row above is not vacuous)',
       exists (select 1 from companies where email <> '');
