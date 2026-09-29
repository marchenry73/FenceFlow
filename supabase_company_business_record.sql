-- ============================================================
-- FenceFlow -- the business name, phone and licence number an office types
-- into Settings never reached the record a CUSTOMER sees
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- NOT APPLIED. Written on 29 September. Read this whole file before running
-- any of it -- the answer it reaches, like supabase_company_reply_to_address.sql
-- before it, is that NOTHING HERE NEEDS TO BE RUN. It is a decision record and
-- a live-data proof, kept as its own file because the repo keeps them; PART 3
-- is read-only and changes nothing either way.
--
-- PART 1  the bug
--
--   website/dashboard.html's "Business Settings" panel wired s_businessName,
--   s_phone and s_license through the SET map into save_company_settings(),
--   whose live body (pg_proc.prosrc, checked 29 September, project
--   newcrgafcptspmapacrx) only ever writes the company_settings JSONB blob:
--
--       insert into company_settings (company_id, settings, updated_at)
--           values (target, new_settings, now())
--       on conflict (company_id) do update
--           set settings = company_settings.settings || excluded.settings, ...
--
--   It never touches `companies`. And companies.name / .phone / .license_no is
--   the record everyone OUTSIDE the phone reads:
--     - quote-view/index.ts prints name and phone at the top of the public
--       quote page the customer opens
--     - invite-crew/index.ts puts name and phone on crew invitations
--     - send-follow-ups/index.ts and _shared/mail/caller.ts send under the name
--     - create-payment-link/index.ts and lead-intake/index.ts read the name
--   Only welcome.html's one-time onboarding step ever wrote them, through
--   complete_company_details() (supabase_onboarding_details_patch.sql). So an
--   office that renamed itself, changed its number or finally got licensed
--   typed it into Settings, was told "Saved", and kept quoting under the old
--   details for ever. A control that does not do the thing -- the same shape
--   as the company-email track (F4) in supabase_company_reply_to_address.sql.
--
-- PART 2  why this was MIRRORED and not moved, which is where it differs from F4
--
--   F4's fix moved s_email off the blob entirely, because the blob's `email`
--   key was read by nothing. That reasoning does NOT carry to these three, and
--   checking rather than assuming is the whole of this section. The blob's
--   business_name / phone / license_number are read by the PHONE:
--
--     - app/src/main/java/com/fenceestimator/app/cloud/SettingsSync.kt decodes
--       all three (CloudSettings and CrewSettings both carry them) into
--       SettingsStore.BusinessProfile;
--     - app/src/main/java/com/fenceestimator/app/estimate/PdfExporter.kt prints
--       the name, then phone, then "Licence no: ..." in the header of EVERY PDF
--       quote and contract the phone produces;
--     - app/src/main/java/com/fenceestimator/app/ui/settings/SettingsScreen.kt
--       lets the phone edit them and push them back up.
--
--   And one server reader, easy to miss because it is inside a function body
--   rather than a query anyone greps for -- my_setup_progress(), whose
--   'business' step is (live body, 29 September):
--
--       coalesce(trim((select settings->>'business_name' from s)), '') <> ''
--
--   That is the "Your business details" line on the office setup checklist,
--   and saveSettings() re-reads my_setup_progress() at its own last step to
--   clear it. Deleting the SET entries -- the obvious "move it like the email"
--   fix -- would therefore have traded one dead control for another: the
--   office could no longer change what its own phones print on a customer's
--   PDF, and the setup checklist could never be completed from this page
--   again. So dashboard.html now writes BOTH: the blob first (unchanged
--   payload, unchanged RPC) and companies second.
--
--   Load precedence, for the same reason F4 stopped loading the blob's email:
--   the box shows companies.<col> when it is non-blank, because that is the
--   value actually in effect for a customer today, and falls back to the
--   blob's copy only when the column is blank -- which, live, is the common
--   case (see PART 3). Where the two genuinely disagree there is no tie to
--   break: companies carries no updated_at for these columns. The box shows
--   what the customer sees, and the next save makes the phones agree with it.
--
--   Blank boxes are skipped on the companies side even though the blob write
--   stores ''. All three columns are NOT NULL with a '' default and would take
--   a blank happily; a failed loadSettings() leaves every box empty and
--   nothing prevents a save on top of it, and that save would blank the
--   company name on every quote page, crew invitation and payment link at
--   once. The cost is that a number or licence cannot be CLEARED from this
--   panel (typing a new one replaces it; the admin console can empty it),
--   which is much the cheaper of the two failures.
--
-- WHY THIS IS NOT A SCHEMA CHANGE
--
--   Nothing new is needed. companies.name, .phone and .license_no already
--   exist (supabase_schema.sql, all three `text not null default ''`); the
--   companies_update policy already grants exactly this write to the OWNER and
--   nobody else; and protect_billing_columns() -- the one BEFORE UPDATE
--   trigger on companies that clamps columns back for a non-platform-admin --
--   does not list any of the three, so the write passes through untouched.
--   All three are proved live below rather than read off the repo's .sql
--   files, since those are the patches that were WRITTEN, not necessarily the
--   ones in effect.
--
--   The OWNER-only half is handled honestly in the page rather than by a
--   policy change. A MANAGER may still use this panel (save_company_settings
--   allows OWNER or MANAGER, unchanged) and their edit still reaches the
--   phones, which is a real capability -- so unlike the email box, these three
--   are NOT disabled for them. They get #s_companyOwnerNote instead, which
--   says the customer-facing copy is the owner's to change. The companies
--   write is skipped entirely for a non-OWNER, because companies_update is
--   `using (...) ` with no WITH CHECK and Postgres applies a USING clause on
--   UPDATE as a plain row filter: a filtered row is simply not in the affected
--   set -- no exception, no error field, `data: []` -- which is exactly the
--   "empty answer reads as good news" trap. The OWNER path reads the affected
--   rows back with .select('id') for the one case that can still hit it: an
--   owner demoted by someone else while this page sits open with a stale
--   client-side profile.role.
--
-- STILL OPEN, deliberately out of this change's scope
--
--   1. dashboard.html's SETUP WIZARD (swSaveBusiness, the sw_business_name /
--      sw_phone / sw_license / sw_email boxes) still writes the blob only. It
--      is less wrong than the Settings panel was -- the blob half is live, so
--      nothing it writes is dead -- but a company that renames itself in the
--      wizard still leaves companies.name behind. It runs right after
--      welcome.html has just set companies through complete_company_details(),
--      which is why it has not bitten yet.
--   2. The PHONE can still edit its blob copy and push it up, with no path
--      from there to companies. That direction needs an app release and a
--      decision about which side wins; this change does not pretend to fix it.
--   3. Nothing reconciles the two stores for the companies that already
--      diverged (PART 3 lists them). The first office save fixes each one.
--
-- ------------------------------------------------------------------------
-- PART 3  proof, read-only, changes nothing
-- ------------------------------------------------------------------------

select 'CANARY: all three companies columns exist (the checks below are reading something real)' as check,
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='companies'
           and column_name in ('name','phone','license_no')) = 3 as ok
union all
select 'all three are NOT NULL with a '''' default, so a blank box would be accepted rather than rejected (hence the skip-blank rule)',
       not exists (select 1 from information_schema.columns
                    where table_schema='public' and table_name='companies'
                      and column_name in ('name','phone','license_no')
                      and is_nullable <> 'NO')
union all
select 'the OWNER of a company may already UPDATE its own companies row (companies_update), so no policy change is needed',
       exists (select 1 from pg_policies
                where schemaname='public' and tablename='companies' and cmd='UPDATE'
                  and policyname='companies_update'
                  and qual = '((id = current_company_id()) AND (current_user_role() = ''OWNER''::user_role))')
union all
select 'companies_update has no separate WITH CHECK, so a non-OWNER''s UPDATE is a silent zero-row filter, not an error',
       (select with_check from pg_policies
         where schemaname='public' and tablename='companies' and policyname='companies_update') is null
union all
-- CANARY for the two rows above: proves the policy-qual test can find text
-- that is really there, rather than passing on a null/missing policy.
select 'CANARY: the policy test can read a real policy definition',
       exists (select 1 from pg_policies
                where schemaname='public' and tablename='companies'
                  and policyname='companies_update' and qual is not null)
union all
select 'protect_billing_columns() does not clamp name, phone or license_no back',
       (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='protect_billing_columns')
         not similar to '%(new.name|new.phone|new.license_no)%'
union all
-- CANARY for the row above: the same body DOES clamp real columns, so a
-- trigger body that clamped nothing (wrong function, empty prosrc) could not
-- pass this file by having nothing left to find.
select 'CANARY: protect_billing_columns really does clamp something (suspended, stripe_account_id)',
       (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='protect_billing_columns')
         like '%new.suspended%'
   and (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='protect_billing_columns')
         like '%new.stripe_account_id%'
union all
select 'save_company_settings() only ever writes company_settings, never companies (so the SET map alone could not reach the customer-facing record)',
       (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='save_company_settings') like '%insert into company_settings%'
   and (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='save_company_settings') not like '%companies %'
union all
select 'save_company_settings() allows MANAGER as well as OWNER (why the boxes stay editable for a manager instead of being disabled)',
       (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='save_company_settings')
         like '%current_user_role() not in (''OWNER'', ''MANAGER'')%'
union all
select 'my_setup_progress() still reads settings->>''business_name'' for its ''business'' step -- the reason the blob half must keep being written',
       (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='my_setup_progress')
         like '%settings->>''business_name''%'
union all
-- The divergence itself. Every company that has ever used the Settings panel
-- (i.e. has a company_settings row at all) carries business details in the
-- blob that the companies row does not have.
select 'at least one company has business details in the blob that its companies row is missing -- the bug, in the data',
       exists (select 1 from companies c join company_settings cs on cs.company_id = c.id
                where (coalesce(trim(cs.settings->>'phone'),'') <> '' and coalesce(trim(c.phone),'') = '')
                   or (coalesce(trim(cs.settings->>'license_number'),'') <> '' and coalesce(trim(c.license_no),'') = '')
                   or (coalesce(trim(cs.settings->>'business_name'),'') <> ''
                       and coalesce(trim(cs.settings->>'business_name'),'') <> coalesce(trim(c.name),'')))
union all
-- CANARY: proves the row above is not vacuously true because the join is
-- empty. If this ever reads false, there are no company_settings rows at all
-- and the divergence check above is meaningless rather than clean.
select 'CANARY: at least one company_settings row exists at all (the divergence check above is not vacuous)',
       exists (select 1 from companies c join company_settings cs on cs.company_id = c.id)
union all
select 'every real (non-ZZ TEST) company already has a name on its companies row, so the load''s companies-first precedence shows a real value',
       not exists (select 1 from companies
                    where name not ilike 'ZZ TEST%' and coalesce(trim(name),'') = '')
union all
select 'companies.license_no is blank for every company on file today -- nothing could set it after onboarding',
       not exists (select 1 from companies where coalesce(trim(license_no),'') <> '');
