-- ============================================================
-- FenceFlow -- choose which service FenceFlow mail actually goes out through
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- ADDITIVE. One column on mail_platform_settings and one admin function.
-- Nothing existing is changed, and the default is the provider in use today,
-- so a database that runs this and nothing else sends exactly as before.
--
-- WHY. "FenceFlow mail" -- the sender a company uses when it has not connected
-- a mailbox of its own -- has been Resend, hardcoded in mail-send. That is one
-- account, one price list and one outage away from nobody's quote going out.
-- March asked for the choice, with Brevo as the second option.
--
-- WHAT THIS DOES NOT CHANGE, deliberately:
--
--   * The company's OWN mailbox (Zoho, Gmail, or any host on port 465) is
--     untouched and remains a separate choice per send -- from_account_id is
--     either a mailbox of theirs or the word "fenceflow". This column only
--     decides what "fenceflow" means.
--   * Replies. Whichever provider carries the message, the Reply-To is the
--     company's own address or the inbound token address, exactly as
--     fenceflowReplyTo already decides. Nothing about receiving changes.
--   * The claim, the de-duplication and the rate limit. The message is still
--     written to mail_messages with send_state 'sending' BEFORE a byte leaves,
--     still de-duplicated on (company, client_send_id), and still counted.
--     Only the transport at the very end differs.
--
-- PLATFORM-WIDE, not per company, and that is a choice worth stating: the API
-- key belongs to one account that pays for the sending. A per-company setting
-- would imply each company brings its own key, which is a different product.
-- When that is wanted, this column stays and a per-company override joins it.
-- ============================================================

alter table public.mail_platform_settings
    add column if not exists sender_provider text not null default 'resend';

do $$
begin
    alter table public.mail_platform_settings
        add constraint mail_platform_settings_sender_provider_known
        check (sender_provider in ('resend', 'brevo'));
exception when duplicate_object then null;
end $$;

comment on column public.mail_platform_settings.sender_provider is
    'Which service carries FenceFlow mail: resend (the default, and what was '
    'hardcoded before this column) or brevo. Read by mail-send''s viaFenceflow; '
    'a company''s own connected mailbox is unaffected. Set with '
    'admin_set_mail_sender(); see supabase_r20_mail_sender_choice.sql.';

-- The one row. Created if this database has never had one, left alone if it has.
insert into public.mail_platform_settings (id) values (1)
on conflict (id) do nothing;

-- ---------- Who may change it ----------
--
-- A platform admin, and the second factor that goes with it: is_platform_admin()
-- requires auth.sessions.aal = 'aal2' (supabase_r7_admin_second_factor.sql), so
-- a password-only session cannot switch the sender for every company at once.
-- The same gate every other admin_* function keeps.
create or replace function public.admin_set_mail_sender(provider text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
    if not is_platform_admin() then
        raise exception 'Only a FenceFlow admin may change the mail sender.';
    end if;
    if provider not in ('resend', 'brevo') then
        raise exception 'Unknown mail sender: %', provider;
    end if;
    update mail_platform_settings set sender_provider = provider where id = 1;
end;
$function$;

revoke all on function public.admin_set_mail_sender(text) from public, anon;
grant execute on function public.admin_set_mail_sender(text) to authenticated;

-- Readable by a platform admin so the console can show what is in use. The
-- table's own RLS still decides the row; this only adds the column to what a
-- reader may see.
do $$
declare cols text;
begin
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
      into cols
      from information_schema.columns
     where table_schema = 'public' and table_name = 'mail_platform_settings';
    -- Rebuilt from the live column list on purpose. A per-column grant computed
    -- once goes stale the moment a column is added, and that is exactly how
    -- companies.logo_path took all company email down on 20 October
    -- (supabase_r19_company_column_grants.sql). If this table ever gains
    -- per-column grants, re-running this file fixes them too.
    if exists (select 1 from information_schema.column_privileges
                where table_schema='public' and table_name='mail_platform_settings'
                  and privilege_type='SELECT' and grantee='authenticated')
       and not exists (select 1 from information_schema.table_privileges
                        where table_schema='public' and table_name='mail_platform_settings'
                          and privilege_type='SELECT' and grantee='authenticated')
    then
        execute format('grant select (%s) on public.mail_platform_settings to authenticated', cols);
    end if;
end $$;

-- ------------------------------------------------------------------------
-- PART 2  prove it. Every row must read true.
-- ------------------------------------------------------------------------

select 'the column exists, is text, NOT NULL, and defaults to resend' as check,
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='mail_platform_settings'
                  and column_name='sender_provider' and data_type='text'
                  and is_nullable='NO' and column_default like '%resend%') as ok
union all
select 'nothing has changed sender yet -- mail goes out exactly as it did',
       (select sender_provider from public.mail_platform_settings where id = 1) = 'resend'
union all
select 'only resend and brevo are accepted (the check constraint is on)',
       exists (select 1 from pg_constraint
                where conname = 'mail_platform_settings_sender_provider_known')
union all
select 'admin_set_mail_sender exists and is SECURITY DEFINER',
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname='public' and p.proname='admin_set_mail_sender' and p.prosecdef)
union all
select 'it asks is_platform_admin() -- which itself requires the second factor',
       (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname='public' and p.proname='admin_set_mail_sender')
         like '%is_platform_admin()%'
union all
-- CANARY for the row above: the same probe finds the gate in a function that
-- certainly has one, so "it is there" is a real answer and not a query that
-- cannot read prosrc at all.
select 'CANARY: the probe can see the same gate in admin_extend_trial',
       (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname='public' and p.proname='admin_extend_trial')
         like '%is_platform_admin()%'
union all
select 'anon cannot execute it',
       not exists (select 1 from pg_proc p, unnest(coalesce(p.proacl, '{}')::text[]) a
                    where p.pronamespace = 'public'::regnamespace
                      and p.proname = 'admin_set_mail_sender'
                      and (a like 'anon=%' or a like '=%'))
union all
select 'there is exactly one settings row for mail-send to read',
       (select count(*) from public.mail_platform_settings where id = 1) = 1;
