-- ============================================================
-- FenceFlow -- a sandbox you cannot mistake for the live business
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- WHAT MARCH ASKED FOR (2026-11-05)
--   "A test environment with everything this app has and the same data, kept
--    very separate so there can be no mistake, without paying for another
--    project."
--
-- WHY A SANDBOX TENANT AND NOT A SECOND SET OF TABLES
--   He suggested a new table. The app and the office read dozens of tables; a
--   parallel copy means every query in both needs a switch, and the copy
--   drifts -- this project already ran a hardcoded table list thirteen tables
--   stale. A second COMPANY needs none of that. The platform is already
--   multi-tenant and its isolation is already audited: the same RLS that stops
--   PeterLLC seeing Legacy Solutions' jobs is what separates a sandbox. No new
--   project, no second bill, no new code path to keep in step.
--
-- WHY THE GUARDS REMOVE CAPABILITY INSTEAD OF CHECKING EACH CALLER
--   is_sandbox landed on 2026-11-05 (r42) as a label its own comment called
--   inert "until the mail path, the Stripe path and the office filter read it".
--   A label nobody reads is worse than nothing: it is a containment that is
--   not there.
--
--   Six transports in supabase/functions reach real people -- Resend, Brevo,
--   FCM, Stripe, Square, and SMTP through the company's own mailbox. Adding a
--   check to each caller is control-by-control gating, which never converges:
--   the next function added forgets it and nothing fails.
--
--   So two of them are closed by taking the CAPABILITY away, which no future
--   code can forget:
--
--     * a sandbox company can never hold a row in mail_accounts, so it has no
--       mailbox: no SMTP to a customer, no inbound sync, no reply.
--     * a sandbox company can never hold a row in payment_connections, so it
--       has no Stripe or Square credential: create-payment-link and
--       create-checkout-session have nothing to charge with.
--
--   Both read the flag at the moment of the write, so flipping a company INTO
--   the sandbox immediately stops new connections -- and PART 3 refuses to
--   flip a company that already holds either, rather than leaving a sandbox
--   with a live mailbox still attached.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT CLOSE
--   Transactional customer email through Resend and Brevo needs no mailbox, so
--   capability removal does not reach it. Twelve functions call those two
--   hosts directly: admin-mail-send, hoa-letter, invite-company, invite-crew,
--   mail-message, mail-send, payment-receipt, quote-approval-email,
--   resend-inbound, send-follow-ups, send-signup-email, send-welcome-email.
--   PART 1 gives them one predicate to ask. Wiring it in is a code change and
--   a deploy, and it is NOT done here -- a migration that claimed to close it
--   would be the same false containment this file exists to remove.
--
--   Push is left alone on purpose, with a reason rather than an omission:
--   device_tokens carry company_id, so a sandbox company can only ever push to
--   a device signed into the sandbox. There is nobody else to reach, and a
--   guard there would protect nothing while reading like protection.
-- ============================================================

-- ------------------------------------------------------------------------
-- PART 1  one predicate, so nothing has to guess how to ask
-- ------------------------------------------------------------------------

create or replace function public.company_is_sandbox(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    -- A company that does not exist is not a sandbox: callers asking about a
    -- missing id get false, not null, so `if company_is_sandbox(x) then refuse`
    -- cannot fall through on a null.
    select coalesce((select c.is_sandbox from public.companies c where c.id = p_company_id), false)
$$;

comment on function public.company_is_sandbox(uuid) is
    'True when this company exists to be demonstrated rather than to run a '
    'business. Read by the guards in supabase_r64_sandbox_company.sql and, when '
    'it is wired in, by the transactional mail path.';

revoke execute on function public.company_is_sandbox(uuid) from public;
grant execute on function public.company_is_sandbox(uuid) to authenticated, service_role;

-- ------------------------------------------------------------------------
-- PART 2  the two capabilities a sandbox must not have
-- ------------------------------------------------------------------------

create or replace function public.refuse_sandbox_real_world()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
    if public.company_is_sandbox(new.company_id) then
        raise exception
            'This is a sandbox company, so it cannot hold a row in %. A sandbox must not be able to reach a real customer; move the work to the live company instead.',
            tg_table_name
            using errcode = 'check_violation',
                  hint = 'See supabase_r64_sandbox_company.sql.';
    end if;
    return new;
end;
$function$;

drop trigger if exists zz_refuse_sandbox_mailbox on public.mail_accounts;
create trigger zz_refuse_sandbox_mailbox
    before insert or update on public.mail_accounts
    for each row execute function public.refuse_sandbox_real_world();

drop trigger if exists zz_refuse_sandbox_payments on public.payment_connections;
create trigger zz_refuse_sandbox_payments
    before insert or update on public.payment_connections
    for each row execute function public.refuse_sandbox_real_world();

-- ------------------------------------------------------------------------
-- PART 3  refuse to make a company a sandbox while it still holds either
--
-- Flipping a live company's flag on would otherwise leave its mailbox and its
-- Stripe credential attached, since the guards above only see NEW writes. That
-- is the worst of both: it reads as contained and is not.
-- ------------------------------------------------------------------------

create or replace function public.hold_is_sandbox()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
    n_mail int;
    n_pay  int;
begin
    if coalesce(new.is_sandbox, false) and not coalesce(old.is_sandbox, false) then
        select count(*) into n_mail from public.mail_accounts  where company_id = new.id;
        select count(*) into n_pay  from public.payment_connections where company_id = new.id;
        if n_mail > 0 or n_pay > 0 then
            raise exception
                'Refusing to make this company a sandbox: it still holds % mailbox row(s) and % payment connection(s). Disconnect both first, or the sandbox keeps the means to reach real people.',
                n_mail, n_pay
                using errcode = 'check_violation',
                      hint = 'See supabase_r64_sandbox_company.sql PART 3.';
        end if;
    end if;
    return new;
end;
$function$;

drop trigger if exists zz_hold_is_sandbox on public.companies;
create trigger zz_hold_is_sandbox
    before update of is_sandbox on public.companies
    for each row execute function public.hold_is_sandbox();

-- ------------------------------------------------------------------------
-- PART 4  refresh a sandbox's catalog and settings from a live company
--
-- ONE DIRECTION ONLY. The target must be a sandbox, which is what makes it
-- impossible for this to write into the real business by a transposed
-- argument -- the mistake March specifically asked to be unable to make.
--
-- Jobs, customers and line items are NOT copied. That needs its table list
-- derived from the schema rather than typed out, because a list typed into a
-- migration is the list that goes stale -- this project's backup list ran
-- thirteen tables behind. The ZZ TEST companies already carry jobs in every
-- state, which is what makes them usable as a sandbox today.
-- ------------------------------------------------------------------------

create or replace function public.sandbox_refresh_from(p_source uuid, p_target uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
    n_items int;
    n_set   int;
begin
    if p_source is null or p_target is null then
        raise exception 'Both a source and a target company are required.';
    end if;
    if p_source = p_target then
        raise exception 'Source and target are the same company.';
    end if;
    if not public.company_is_sandbox(p_target) then
        raise exception
            'Refusing to write into a company that is not a sandbox. This copies one way only, into the sandbox.'
            using errcode = 'check_violation';
    end if;
    if public.company_is_sandbox(p_source) then
        raise exception 'The source is itself a sandbox; copy from the live company.'
            using errcode = 'check_violation';
    end if;

    delete from public.material_items where company_id = p_target;
    insert into public.material_items
        (company_id, sync_id, category, role, fence_type, name, unit, unit_price,
         source_doc, taxable, updated_at)
    select p_target, gen_random_uuid(), m.category, m.role, m.fence_type, m.name,
           m.unit, m.unit_price, m.source_doc, m.taxable, now()
      from public.material_items m
     where m.company_id = p_source
       and m.deleted_at is null;
    select count(*) into n_items from public.material_items where company_id = p_target;

    insert into public.company_settings (company_id, settings, updated_at)
    select p_target, s.settings, now()
      from public.company_settings s
     where s.company_id = p_source
    on conflict (company_id) do update
        set settings = excluded.settings, updated_at = now();
    select count(*) into n_set from public.company_settings where company_id = p_target;

    return format('copied %s catalog row(s) and %s settings row(s) into the sandbox', n_items, n_set);
end;
$function$;

revoke execute on function public.sandbox_refresh_from(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sandbox_refresh_from(uuid, uuid) to service_role;

-- ------------------------------------------------------------------------
-- PART 5  prove it. Every row must read true.
-- ------------------------------------------------------------------------

-- Returns the reason a statement was refused, or '' when it went through.
-- The reason matters, not just the refusal: an insert that failed because its
-- column list was wrong would otherwise read exactly like a guard working, and
-- mail_accounts needs four columns, not two.
create function pg_temp.refusal(sql text) returns text language plpgsql as $fn$
begin
    begin
        execute sql;
    exception when others then
        return sqlerrm;
    end;
    return '';
end $fn$;

do $seed$
declare
    live_id uuid;
    sand_id uuid;
begin
    -- A sandbox and a non-sandbox to test against, both thrown away by the
    -- rollback this block does NOT do -- so they are named and removed below.
    insert into public.companies (id, name, subscription_status, subscription_plan, suspended, is_sandbox)
    values ('a26cee01-0000-4000-8000-00000000000a', 'PROBE-R64-LIVE', 'active', 'pro', false, false),
           ('a26cee01-0000-4000-8000-00000000000b', 'PROBE-R64-SANDBOX', 'active', 'pro', false, true)
    on conflict (id) do update set is_sandbox = excluded.is_sandbox;
end $seed$;

with checks as (
    select 'the predicate exists and answers for a sandbox' as claim,
           public.company_is_sandbox('a26cee01-0000-4000-8000-00000000000b') as ok
    union all
    select 'CANARY: and answers false for a company that is not one',
           not public.company_is_sandbox('a26cee01-0000-4000-8000-00000000000a')
    union all
    select 'CANARY: a company that does not exist reads false, not null',
           public.company_is_sandbox('a26cee01-0000-4000-8000-0000000000ff') is false
    union all
    select 'a sandbox cannot be given a mailbox, and the refusal is this guard''s own',
           pg_temp.refusal($q$insert into public.mail_accounts (company_id, kind, provider, email_address, inbound_token)
                              values ('a26cee01-0000-4000-8000-00000000000b','fenceflow','resend','probe@probe.invalid','abcdef123456')$q$) like '%sandbox company%'
    union all
    select 'CANARY: the identical insert goes THROUGH for a live company, so the guard is not refusing everything and the column list is right',
           pg_temp.refusal($q$insert into public.mail_accounts (company_id, kind, provider, email_address, inbound_token)
                              values ('a26cee01-0000-4000-8000-00000000000a','fenceflow','resend','probe@probe.invalid','abcdef123457')$q$) = ''
    union all
    select 'a sandbox cannot be given a payment connection, and the refusal is this guard''s own',
           pg_temp.refusal($q$insert into public.payment_connections (company_id, processor, external_id)
                              values ('a26cee01-0000-4000-8000-00000000000b','stripe','acct_probe')$q$) like '%sandbox company%'
    union all
    select 'CANARY: that insert goes THROUGH for a live company',
           pg_temp.refusal($q$insert into public.payment_connections (company_id, processor, external_id)
                              values ('a26cee01-0000-4000-8000-00000000000a','stripe','acct_probe2')$q$) = ''
    union all
    select 'a company holding a mailbox cannot be flipped into the sandbox',
           pg_temp.refusal($q$update public.companies set is_sandbox = true
                               where id = 'a26cee01-0000-4000-8000-00000000000a'$q$) like '%still holds%'
    union all
    select 'the refresh refuses a target that is not a sandbox',
           pg_temp.refusal($q$select public.sandbox_refresh_from(
                                 'a26cee01-0000-4000-8000-00000000000b',
                                 'a26cee01-0000-4000-8000-00000000000a')$q$) like '%not a sandbox%'
    union all
    select 'the refresh refuses the same company twice',
           pg_temp.refusal($q$select public.sandbox_refresh_from(
                                 'a26cee01-0000-4000-8000-00000000000a',
                                 'a26cee01-0000-4000-8000-00000000000a')$q$) like '%same company%'
    union all
    select 'anon cannot execute the refresh',
           not has_function_privilege('anon', 'public.sandbox_refresh_from(uuid,uuid)', 'execute')
    union all
    select 'CANARY: the privilege test can answer true somewhere',
           has_function_privilege('service_role', 'public.sandbox_refresh_from(uuid,uuid)', 'execute')
)
select claim, ok from checks order by 1;

-- Clean up the probe companies and everything the probes attached to them.
delete from public.mail_accounts       where company_id in ('a26cee01-0000-4000-8000-00000000000a','a26cee01-0000-4000-8000-00000000000b');
delete from public.payment_connections where company_id in ('a26cee01-0000-4000-8000-00000000000a','a26cee01-0000-4000-8000-00000000000b');
delete from public.material_items      where company_id in ('a26cee01-0000-4000-8000-00000000000a','a26cee01-0000-4000-8000-00000000000b');
delete from public.company_settings    where company_id in ('a26cee01-0000-4000-8000-00000000000a','a26cee01-0000-4000-8000-00000000000b');
delete from public.companies           where id         in ('a26cee01-0000-4000-8000-00000000000a','a26cee01-0000-4000-8000-00000000000b');
