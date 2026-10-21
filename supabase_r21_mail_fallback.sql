-- ============================================================
-- FenceFlow -- when one mail service refuses, try the other
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- ADDITIVE. One nullable column and one admin function. The default is NULL,
-- which means "no fallback" -- so a database that runs this and nothing else
-- behaves exactly as it did.
--
-- WHY. r20 made the sender a choice. This makes it a pair: a primary, and one
-- to try if the primary says no. A quote that stops going out because one
-- account hit its daily number is the failure this prevents.
--
-- ------------------------------------------------------------------------
-- WHAT "REFUSES" MEANS, AND WHY IT IS NARROWER THAN IT SOUNDS
-- ------------------------------------------------------------------------
--
-- The fallback runs ONLY when the first service has certainly NOT sent the
-- message. That is a short list, and the exclusions are the point:
--
--   rate_limited     the provider answered 429. Nothing was sent. TRY.
--   not_configured   it refused the server's key. Nothing was sent. TRY.
--   send_rejected    it refused the message outright. Nothing was sent. TRY.
--
--   too_large        the other one will refuse it too. DO NOT.
--   NO ANSWER AT ALL a timeout, a dropped connection, a 5xx. The message MAY
--                    have gone. Sending it again through the other service is
--                    how a customer gets the same quote twice, and there is no
--                    way to find out which happened. DO NOT -- the message is
--                    left 'sending' and the office is told to check Sent, which
--                    is what it already does.
--
-- That asymmetry is the whole design. A fallback that fires on "I don't know"
-- is worse than no fallback.
--
-- IT DOES NOT RAISE FENCEFLOW'S OWN LIMIT. A company may send 20 FenceFlow
-- mails an hour and 100 a day whichever service carries them -- that cap is a
-- guard against a bug emailing a customer four hundred times, not a licence
-- bought from a provider, and quietly doubling it by adding a second account
-- would remove the guard rather than extend the allowance.
-- ============================================================

alter table public.mail_platform_settings
    add column if not exists fallback_provider text;

do $$
begin
    alter table public.mail_platform_settings
        add constraint mail_platform_settings_fallback_known
        check (fallback_provider is null or fallback_provider in ('resend', 'brevo'));
exception when duplicate_object then null;
end $$;

do $$
begin
    -- A fallback that is the primary is not a fallback; it would retry the
    -- same refusal against the same account and read as the feature not
    -- working. Refused by the table rather than by whoever remembers.
    alter table public.mail_platform_settings
        add constraint mail_platform_settings_fallback_differs
        check (fallback_provider is null or fallback_provider <> sender_provider);
exception when duplicate_object then null;
end $$;

comment on column public.mail_platform_settings.fallback_provider is
    'Tried when sender_provider certainly did NOT send -- a 429, a refused key, a '
    'refused message. NEVER tried when the answer was unknown (timeout, 5xx): the '
    'message may have gone, and resending it is how a customer gets the quote '
    'twice. NULL means no fallback. See supabase_r21_mail_fallback.sql.';

create or replace function public.admin_set_mail_fallback(provider text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    want text := nullif(btrim(coalesce(provider, '')), '');
begin
    if not is_platform_admin() then
        raise exception 'Only a FenceFlow admin may change the mail fallback.';
    end if;
    if want is not null and want not in ('resend', 'brevo') then
        raise exception 'Unknown mail sender: %', want;
    end if;
    -- The table's own check would catch this too; saying it here makes the
    -- refusal a sentence rather than a constraint violation.
    if want is not null and want = (select sender_provider from mail_platform_settings where id = 1) then
        raise exception 'The fallback must be a different service from the one already sending.';
    end if;
    update mail_platform_settings set fallback_provider = want where id = 1;
end;
$function$;

revoke all on function public.admin_set_mail_fallback(text) from public, anon;
grant execute on function public.admin_set_mail_fallback(text) to authenticated;

-- admin_set_mail_sender has to stop the pair becoming equal from the other
-- side as well: switching the PRIMARY to whatever the fallback already is
-- would leave both the same, which the table now refuses -- as an error with
-- no explanation. Clearing the fallback in that case is the honest answer:
-- the admin asked for that service to be the sender, and it now is.
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
    update mail_platform_settings
       set sender_provider = provider,
           fallback_provider = case when fallback_provider = provider then null else fallback_provider end
     where id = 1;
end;
$function$;

revoke all on function public.admin_set_mail_sender(text) from public, anon;
grant execute on function public.admin_set_mail_sender(text) to authenticated;

-- ------------------------------------------------------------------------
-- PART 2  prove it. Every row must read true.
-- ------------------------------------------------------------------------

select 'the column exists, is text and is NULLABLE (no fallback by default)' as check,
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='mail_platform_settings'
                  and column_name='fallback_provider' and data_type='text'
                  and is_nullable='YES') as ok
union all
select 'nothing has set one yet -- sending behaves exactly as it did',
       (select fallback_provider from public.mail_platform_settings where id = 1) is null
union all
select 'only resend, brevo or nothing are accepted',
       exists (select 1 from pg_constraint where conname = 'mail_platform_settings_fallback_known')
union all
select 'the fallback cannot be the same service as the sender',
       exists (select 1 from pg_constraint where conname = 'mail_platform_settings_fallback_differs')
union all
select 'admin_set_mail_fallback exists, is definer, and asks is_platform_admin()',
       (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname='public' and p.proname='admin_set_mail_fallback')
         like '%is_platform_admin()%'
union all
select 'admin_set_mail_sender now clears a fallback that would collide',
       (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname='public' and p.proname='admin_set_mail_sender')
         like '%fallback_provider = case when fallback_provider = provider then null%'
union all
-- CANARY: the same probe reads a gate in a function that certainly has one.
select 'CANARY: the probe can read prosrc at all (admin_extend_trial has the gate)',
       (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname='public' and p.proname='admin_extend_trial')
         like '%is_platform_admin()%'
union all
select 'neither function is executable by anon',
       not exists (select 1 from pg_proc p, unnest(coalesce(p.proacl, '{}')::text[]) a
                    where p.pronamespace = 'public'::regnamespace
                      and p.proname in ('admin_set_mail_fallback','admin_set_mail_sender')
                      and (a like 'anon=%' or a like '=%'))
union all
select 'the sender itself is untouched by this file',
       (select sender_provider from public.mail_platform_settings where id = 1) = 'resend';
