-- ============================================================
-- FenceFlow -- the ways a customer can pay a company: Cash App, Zelle, wire, cash
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run, read-only)
--
-- NOT APPLIED. Written 1 October 2026. NOTHING IN THIS FILE NEEDS TO BE RUN for
-- the feature to work -- it adds no column, no table, no function and no policy.
-- It is the decision record (like supabase_company_business_record.sql before
-- it) plus a read-only proof of the claims the decision rests on. PART 4 is the
-- only executable part and it is all SELECTs.
--
-- WHAT THIS ADDS
--
--   One KEY, `payment_methods`, inside the existing JSON blob
--   company_settings.settings. It comes into being the first time the owner
--   presses Save on the new "How customers can pay you" panel in
--   website/dashboard.html, written through the EXISTING save_company_settings()
--   RPC. No DDL. Until somebody saves, no company has the key, and every quote
--   link shows no payment methods at all.
--
-- HOW TO UNDO IT
--
--   Remove the panel from dashboard.html and the paymentMethods block from
--   quote-view, redeploy both. The data is one JSON key and harms nothing left
--   in place. To delete the typed details as well (this DELETES what the owner
--   typed, so only on his say-so), per company or for all:
--
--       -- update company_settings set settings = settings - 'payment_methods';
--
-- ------------------------------------------------------------------------
-- PART 1  THE CONTRACT  (what quote-view serves, what quote.html renders)
-- ------------------------------------------------------------------------
--
--   GET quote-view?t=<token> gains exactly ONE new top-level key. Nothing else
--   about the response changes, and nothing from the company row or the settings
--   blob is added alongside it.
--
--     paymentMethods: {
--       cashApp: "$AcmeFence",   -- "" when off or empty. Always starts with "$".
--                                --   Link to it as  https://cash.app/ + cashApp
--       zelle:   "813-555-0100", -- "" when off or empty. A phone number and/or an
--                                --   email address, exactly as typed, one line.
--       wire:    "Bank: ...\nName: ...",
--                                -- "" when off or empty. A multi-line text block,
--                                --   lines separated by \n. Render it with
--                                --   white-space:pre-wrap and ESCAPE it.
--       cash:    true            -- boolean. true only when the owner switched
--                                --   "we take cash" on.
--     }
--
--   RULES THE PAGE CAN RELY ON
--   - A method is a non-empty string / true ONLY when the owner turned it on AND
--     filled it in. Off, or on-but-empty, arrives as "" / false. Render nothing
--     for "" and false: not a heading, not an empty line, not "Zelle: ".
--   - A method that is switched off is never sent, even though its details may
--     still be saved in the blob (the owner can switch Zelle off for a week and
--     not lose the address).
--   - The key can be ABSENT: an older quote-view deployment, or a failed read,
--     sends no paymentMethods. Treat absent exactly like all-empty.
--   - There is NO card fee field, on purpose. See PART 3.
--
--   HOW IT IS STORED (company_settings.settings -> 'payment_methods'):
--
--       { "cash_app": { "on": true, "tag": "AcmeFence" },   -- stored without the $
--         "zelle":    { "on": true, "to":  "..." },
--         "wire":     { "on": true, "details": "..." },
--         "cash":     { "on": true } }
--
--   The office writes the WHOLE object every time (save_company_settings merges
--   with ||, which is shallow, so a partial object would erase the siblings).
--   The phone never writes this key and its decoder ignores unknown keys
--   (SettingsSync.kt: ignoreUnknownKeys = true), so the phone neither erases it
--   nor trips over it.
--
-- ------------------------------------------------------------------------
-- PART 2  WHY THE SETTINGS BLOB AND NOT A companies COLUMN
-- ------------------------------------------------------------------------
--
--   A company's name, phone and licence already live in TWO places
--   (companies.* and the blob) and that split has bitten before. This adds
--   nothing to the split: the payment methods live in the blob and only there,
--   and no third home is created.
--
--   For the three fields that already have two homes, dashboard.html mirrors to
--   both, because both have real readers (the phone prints the blob copy on
--   every PDF). Payment methods have exactly one reader -- quote-view -- so there
--   is nothing to mirror, and the choice is decided by who else could read it:
--
--   companies (read from pg_policies and information_schema, 1 October 2026,
--   project newcrgafcptspmapacrx):
--     companies_read    SELECT  using (id = current_company_id())
--                       -> EVERY member of the company, crew included, no role test.
--     companies_update  UPDATE  using (id = current_company_id()
--                                      and current_user_role() = 'OWNER')
--     companies_platform_admin_read / _update / _insert: platform admins only.
--     authenticated holds NO table-level SELECT on companies (supabase_sec_company_reads.sql
--     replaced it with per-column grants). So a new companies column would be
--     unreadable by the office page until a grant is added -- and the only grant
--     that exists is per COLUMN, not per role, so granting it to the office
--     grants it to crew. A bank account and routing number readable by every
--     crew login is the one outcome the brief rules out, and the alternative
--     (an owner-only SECURITY DEFINER reader, as my_leads_token() does) is a
--     new function, a new grant and a migration that must be applied BEFORE the
--     page works.
--
--   company_settings (the blob):
--     company_settings_money_needs_permission  RESTRICTIVE SELECT to authenticated
--                       using (has_permission('SEE_MONEY')
--                              or current_user_role() in ('OWNER','MANAGER'))
--     company_settings_read   PERMISSIVE SELECT using (company_id = current_company_id())
--     company_settings_write  PERMISSIVE INSERT check (same company, OWNER or MANAGER)
--     company_settings_update PERMISSIVE UPDATE using (same company, OWNER or MANAGER)
--     company_settings_not_suspended  RESTRICTIVE ALL: a suspended company reads nothing.
--     -> crew without SEE_MONEY read NO row of the blob. The one function that
--        hands part of it to crew, crew_settings(), is an ALLOWLIST of fifteen
--        named keys and payment_methods is not one of them, so a key added
--        tomorrow stays hidden by default.
--     -> save_company_settings() (SECURITY DEFINER) is the write path: OWNER or
--        MANAGER, merges with ||.
--
--   Consequence to know about: a MANAGER can edit payment methods, because a
--   manager can edit every other business setting (labour rate, markup, minimum
--   charge) through the same RPC. Owner-only would need a server rule this file
--   deliberately does not add; it is flagged for the owner to decide.
--
--   quote-view reads the key as the SERVICE ROLE (RLS does not apply to it) with
--   select("payment_methods:settings->payment_methods") -- that one key, not the
--   blob -- and builds what it sends from a whitelist.
--
-- ------------------------------------------------------------------------
-- PART 3  THERE IS NO CARD FEE, SO THE PAGE MUST NOT SAY THERE IS ONE
-- ------------------------------------------------------------------------
--
--   Read from the code on 1 October 2026, not assumed:
--   - supabase/functions/create-payment-link/index.ts line ~729:
--         const stripeFee = 0;
--     with the comment "No card fee on a customer's payment link". It is the only
--     function that makes a link a customer pays through. The Stripe line_items
--     hold ONE line, the job amount; the optional "Card processing fee" line is
--     only built when stripeFee > 0, and stripeFee is the constant 0. The Square
--     branch's quick_pay carries price_money = the amount and nothing else.
--   - cardFeeCents() in that file has no caller (tests/a4-fees.test.mjs pins it).
--   - companies.pass_card_fee is used by exactly one Edge Function,
--     create-checkout-session, and it prices the company's OWN FenceFlow
--     subscription. Staff-only: the protect_billing_columns() trigger clamps it
--     back for anyone who is not a platform admin, and the only other place that
--     touches it is the staff toggle in admin.html -- not the office dashboard.
--
--   So a customer who pays by card pays exactly the amount asked. The processor
--   takes its cut from the company's side. Any sentence on the quote page that
--   says the customer will be charged a card fee would be false today, which is
--   why this contract carries no fee field. If the owner wants one, that is a
--   change to create-payment-link (what is charged, how it is capped, how
--   refunds split it -- stripe-webhook jobShare already knows how) and it must
--   land BEFORE any page copy says so.
--
-- ------------------------------------------------------------------------
-- PART 4  PROOF, read-only, changes nothing
-- ------------------------------------------------------------------------
-- Every row should read true, except the one labelled PLANTED FAILURE, which
-- must read false (it proves this block can say no).

select 'CANARY: company_settings has policies to read (the checks below are reading something real)' as check,
       (select count(*) from pg_policies where schemaname='public' and tablename='company_settings') >= 5 as ok
union all
select 'a restrictive SELECT policy limits company_settings to OWNER, MANAGER or SEE_MONEY -- crew without SEE_MONEY read no row of it',
       exists (select 1 from pg_policies
                where schemaname='public' and tablename='company_settings'
                  and policyname='company_settings_money_needs_permission'
                  and permissive='RESTRICTIVE' and cmd='SELECT'
                  and qual like '%has_permission(''SEE_MONEY''%'
                  and qual like '%''OWNER''%' and qual like '%''MANAGER''%')
union all
select 'only OWNER or MANAGER may INSERT or UPDATE company_settings',
       (select count(*) from pg_policies
         where schemaname='public' and tablename='company_settings'
           and cmd in ('INSERT','UPDATE') and permissive='PERMISSIVE'
           and coalesce(qual, with_check) like '%''OWNER''%' and coalesce(qual, with_check) like '%''MANAGER''%') = 2
union all
select 'CANARY: crew_settings() really is an allowlist (it names business_name and review_template)',
       (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='crew_settings') like '%''business_name''%'
   and (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='crew_settings') like '%''review_template''%'
union all
select 'crew_settings() does NOT name payment_methods, so the one function that hands part of the blob to crew never carries it',
       (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='crew_settings') not like '%payment_methods%'
union all
select 'PLANTED FAILURE (must read FALSE): crew_settings() names payment_methods',
       (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='crew_settings') like '%payment_methods%'
union all
select 'save_company_settings() merges with || (a save that omits payment_methods leaves it alone) and is OWNER/MANAGER only',
       (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='save_company_settings') like '%company_settings.settings || excluded.settings%'
   and (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='save_company_settings') like '%current_user_role() not in (''OWNER'', ''MANAGER'')%'
union all
select 'CANARY: at least one company has a settings row, so the next check is not vacuously true',
       exists (select 1 from company_settings)
union all
select 'no company already stores anything under the key payment_methods (nothing to collide with)',
       not exists (select 1 from company_settings where settings ? 'payment_methods')
union all
-- WHY NOT A companies COLUMN
select 'companies: authenticated has NO table-level SELECT (column grants only), so a new companies column is unreadable to the office until someone grants it',
       not has_table_privilege('authenticated', 'public.companies', 'select')
union all
select 'companies_read lets EVERY member of the company read the row (no role test), so any column granted for the office would be readable by crew too',
       exists (select 1 from pg_policies
                where schemaname='public' and tablename='companies' and policyname='companies_read'
                  and cmd='SELECT' and qual = '(id = current_company_id())')
union all
select 'companies_update is OWNER-only (the owner-only half of the customer-facing record)',
       exists (select 1 from pg_policies
                where schemaname='public' and tablename='companies' and policyname='companies_update'
                  and qual = '((id = current_company_id()) AND (current_user_role() = ''OWNER''::user_role))');
