-- ============================================================
-- FenceFlow -- companies' per-column SELECT grant had gone stale, and it
-- broke ALL company email
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- ADDITIVE, and a REPAIR. It re-runs the grant that
-- supabase_sec_company_reads.sql builds, from the live column list, with the
-- same five exclusions. Nothing is revoked that was not already revoked, and
-- no policy, function or column changes.
--
-- ------------------------------------------------------------------------
-- WHAT BROKE, AND HOW
-- ------------------------------------------------------------------------
--
-- supabase_sec_company_reads.sql took the TABLE-level SELECT grant off
-- `authenticated` and put a PER-COLUMN grant back, built from
-- information_schema at the moment it ran, minus five admin/billing columns.
-- Its own comment says the list is built live "so a column added to companies
-- tomorrow is included automatically".
--
-- That is true of the FILE and not of the DATABASE. The grant is computed once,
-- when the file runs. Every column added to `companies` afterwards is simply
-- not granted, for ever, unless somebody re-runs it. Three had accumulated:
--
--     logo_path         (r18, 19 Oct 2026)
--     signup_sent_at    (r17)
--     welcome_sent_at   (r6)
--
-- logo_path is the one that bit. _shared/mail/caller.ts -- mailCaller(), the
-- gate EVERY company-email call goes through -- reads the company row with the
-- CALLER'S OWN token, as `authenticated`:
--
--     userClient.from("companies").select("name, email, logo_path")
--
-- Postgres refuses the whole statement for one ungranted column. caller.ts
-- turns any failure of that read into MailError("server_error"), so the answer
-- was "Something went wrong on FenceFlow's side. Try again in a moment." --
-- with no mention of a column, a grant or a permission anywhere.
--
-- AND IT FAILED BEFORE THE CLAIM. mail_ingest had not run, so there was no
-- mail_messages row at all: the office's Sent list and the mail log were empty,
-- which reads as "nothing was even attempted" rather than as a failure. That
-- emptiness is what proved where it broke -- the send never reached the point
-- where a message is recorded.
--
-- BLAST RADIUS: every company email. The phone's "Email the quote", the
-- office's compose window, every reply -- anything through mail-send, because
-- they all pass mailCaller() first. Not only the logo.
--
-- ------------------------------------------------------------------------
-- WHY THE GRANT, AND NOT A SMALLER SELECT
-- ------------------------------------------------------------------------
--
-- caller.ts could stop reading logo_path, and the mail would work again. It
-- would also leave signup_sent_at and welcome_sent_at ungranted behind it, and
-- the next column added to this table would do the same thing to whoever reads
-- it next. The column list is the thing that is wrong.
--
-- logo_path is not sensitive: it is the path of the company's own logo, inside
-- the company's own folder, in a bucket whose read policy already admits every
-- member of that company -- and RLS on `companies` (companies_read, `id =
-- current_company_id()`) still decides which ROW anyone may see. A grant is the
-- coarse layer under the policy, not instead of it.
--
-- THE FIVE EXCLUSIONS ARE UNCHANGED: admin_notes, leads_token,
-- stripe_customer_id, stripe_subscription_id, stripe_account_id. PART 2 proves
-- they are still out.
-- ============================================================

do $$
declare cols text;
begin
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
      into cols
      from information_schema.columns
     where table_schema = 'public' and table_name = 'companies'
       and column_name not in ('admin_notes', 'leads_token', 'stripe_customer_id',
                               'stripe_subscription_id', 'stripe_account_id');
    -- Same shape as supabase_sec_company_reads.sql: the table grant comes off
    -- (a column-level REVOKE is a no-op while a table grant is in place) and a
    -- per-column grant goes back. anon is deliberately left alone there and
    -- left alone here, for the reason that file gives.
    execute 'revoke select on public.companies from authenticated';
    execute format('grant select (%s) on public.companies to authenticated', cols);
end $$;

-- ------------------------------------------------------------------------
-- PART 2  prove it. Every row must read true.
-- ------------------------------------------------------------------------

select 'authenticated can now read logo_path -- the column that broke company email' as check,
       exists (select 1 from information_schema.column_privileges
                where table_schema='public' and table_name='companies'
                  and privilege_type='SELECT' and grantee='authenticated'
                  and column_name='logo_path') as ok
union all
select 'the other two that had gone missing are back as well (signup_sent_at, welcome_sent_at)',
       (select count(*) from information_schema.column_privileges
         where table_schema='public' and table_name='companies'
           and privilege_type='SELECT' and grantee='authenticated'
           and column_name in ('signup_sent_at','welcome_sent_at')) = 2
union all
select 'the exact three columns mailCaller() reads are all granted together',
       (select count(*) from information_schema.column_privileges
         where table_schema='public' and table_name='companies'
           and privilege_type='SELECT' and grantee='authenticated'
           and column_name in ('name','email','logo_path')) = 3
union all
select 'NOTHING was opened up: the five admin and billing columns are still refused',
       not exists (select 1 from information_schema.column_privileges
                    where table_schema='public' and table_name='companies'
                      and privilege_type='SELECT' and grantee='authenticated'
                      and column_name in ('admin_notes','leads_token','stripe_customer_id',
                                          'stripe_subscription_id','stripe_account_id'))
union all
-- CANARY for the row above: the same probe DOES find those columns for the
-- service role, so "not granted to authenticated" is a real answer rather than
-- a query that cannot see column privileges at all.
select 'CANARY: the probe can see those five columns granted to service_role',
       (select count(*) from information_schema.column_privileges
         where table_schema='public' and table_name='companies'
           and privilege_type='SELECT' and grantee='service_role'
           and column_name in ('admin_notes','leads_token','stripe_customer_id',
                               'stripe_subscription_id','stripe_account_id')) = 5
union all
select 'every column except those five is granted -- the list is complete, not merely longer',
       (select count(*) from information_schema.column_privileges
         where table_schema='public' and table_name='companies'
           and privilege_type='SELECT' and grantee='authenticated')
       = (select count(*) from information_schema.columns
           where table_schema='public' and table_name='companies'
             and column_name not in ('admin_notes','leads_token','stripe_customer_id',
                                     'stripe_subscription_id','stripe_account_id'))
union all
select 'the TABLE-level grant is still off, so the per-column list is what decides',
       not exists (select 1 from information_schema.table_privileges
                    where table_schema='public' and table_name='companies'
                      and privilege_type='SELECT' and grantee='authenticated')
union all
-- The same staleness, asked of the OTHER table this pattern is used on, so a
-- repeat of this outage somewhere else shows up here rather than in a support
-- message. jobs is fully granted today; if this ever reads false, the same
-- rebuild is needed for it.
select 'jobs has no ungranted columns waiting to do the same thing',
       (select count(*) from information_schema.column_privileges
         where table_schema='public' and table_name='jobs'
           and privilege_type='SELECT' and grantee='authenticated')
       = (select count(*) from information_schema.columns
           where table_schema='public' and table_name='jobs');
