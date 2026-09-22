-- ============================================================
-- FenceFlow -- a welcome email to every new company, sent exactly once
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
-- Deploy supabase/functions/send-welcome-email BEFORE running this, or the
-- first companies to finish signing up call a function that is not there
-- yet (they lose only the email; the signup itself is never affected).
--
-- ADDITIVE. One new column, one Vault secret, three new functions, two new
-- triggers. No existing column, function, policy or trigger is altered, and
-- no existing row is changed: welcome_sent_at starts empty everywhere.
-- Companies that are already fully set up never receive it, because the
-- trigger fires only on the change INTO "set up", never on a row that was
-- already there.
--
-- WHEN IT IS SENT: the moment a company first has BOTH
--   * its details completed -- details_completed_at, written by
--     complete_company_details() on welcome.html's first step, which every
--     way of signing up goes through (an invitation, a setup code, or
--     signing up on the office, which forwards an owner there); and
--   * a way in -- a subscription (stripe_subscription_id, or status active
--     or trialing, written by stripe-webhook after checkout) or a trial date
--     (trial_ends_at, from the admin's Start trial).
-- That is when company_allowed() first opens the office for them, so the
-- email's "Open your office" button leads somewhere they can use. Whichever
-- half arrives second fires it, whatever code path writes it -- nothing in
-- welcome.html, the office or stripe-webhook has to remember to call it.
--
-- HOW: an AFTER UPDATE trigger queues one pg_net POST to send-welcome-email.
-- pg_net queues inside the transaction and sends after commit, so the
-- function always reads committed data and a rolled-back signup sends
-- nothing. The function then claims the row with
--     update companies set welcome_sent_at = now()
--      where id = $1 and welcome_sent_at is null returning id
-- and sends only if a row came back: once, however many times it is called.
--
-- WHO MAY CALL THE FUNCTION: this trigger. It reads a secret from Vault
-- (welcome_email_trigger_secret, generated here from random bytes and never
-- printed) and sends it in a header; the function asks
-- welcome_email_trigger_ok() -- executable by the service role only -- before
-- reading anything else. Nobody handles the value and there is nothing to
-- copy into the function's secrets. On a copy of this schema in another
-- project (the dev database) the trigger still points at production's URL,
-- but carries that project's own secret, which production refuses.
--
-- NEVER BREAKS A SIGNUP: queue_welcome_email() catches every error and
-- turns it into a warning. A missing secret, pg_net refusing, anything --
-- the company's row is saved regardless; the only cost is that one email.
--
-- welcome_sent_at IS FENCEFLOW'S RECORD, NOT THE OWNER'S: companies_update
-- lets an owner write their own row, and nothing stopped them writing this
-- column. A guard trigger now holds it for every signed-in caller; the edge
-- function (service role) and the SQL editor have no auth.uid() and can.
-- ============================================================

-- ---------- 1. The column ----------
alter table public.companies add column if not exists welcome_sent_at timestamptz;

comment on column public.companies.welcome_sent_at is
  'When FenceFlow''s one welcome email was claimed for this company (send-welcome-email, '
  'supabase_r6_welcome_email.sql). Null = never sent. Set only by the service role; a signed-in '
  'caller cannot change it (companies_protect_welcome_sent_at).';

-- ---------- 2. The secret, in Vault ----------
do $$
begin
    if not exists (select 1 from vault.secrets where name = 'welcome_email_trigger_secret') then
        perform vault.create_secret(
            encode(extensions.gen_random_bytes(32), 'hex'),
            'welcome_email_trigger_secret',
            'Shared secret between the companies_queue_welcome_email trigger and the send-welcome-email '
            'edge function (supabase_r6_welcome_email.sql). Never expose. Rotate by deleting it and '
            're-running that file; nothing else holds a copy.');
    end if;
end $$;

-- ---------- 3. The function's door ----------
-- True only for the exact secret. Digests are compared rather than the
-- values, so how long the comparison takes says nothing about how much of a
-- guess was right.
create or replace function public.welcome_email_trigger_ok(p_secret text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    stored text;
begin
    if p_secret is null or length(p_secret) <> 64 then
        return false;
    end if;
    select decrypted_secret into stored from vault.decrypted_secrets
     where name = 'welcome_email_trigger_secret';
    if stored is null then
        return false;
    end if;
    return extensions.digest(convert_to(p_secret, 'UTF8'), 'sha256')
         = extensions.digest(convert_to(stored, 'UTF8'), 'sha256');
end;
$$;

revoke all on function public.welcome_email_trigger_ok(text) from public, anon, authenticated;
grant execute on function public.welcome_email_trigger_ok(text) to service_role;

-- ---------- 4. The column's guard ----------
create or replace function public.protect_welcome_sent_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    -- A signed-in caller -- owner, manager, even a platform admin in the
    -- console -- cannot move it. The service role and the SQL editor carry no
    -- auth.uid() and can.
    if auth.uid() is not null then
        new.welcome_sent_at := old.welcome_sent_at;
    end if;
    return new;
end;
$$;

revoke all on function public.protect_welcome_sent_at() from public, anon, authenticated;

drop trigger if exists companies_protect_welcome_sent_at on public.companies;
create trigger companies_protect_welcome_sent_at
    before update on public.companies
    for each row
    when (new.welcome_sent_at is distinct from old.welcome_sent_at)
    execute function public.protect_welcome_sent_at();

-- ---------- 5. The trigger that asks for the email ----------
create or replace function public.queue_welcome_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    was_ready boolean;
    now_ready boolean;
    secret    text;
begin
    -- Every term is null-safe (IS NOT NULL, coalesce), so neither of these can
    -- come out null and slip past the IF below.
    now_ready := new.details_completed_at is not null and (
                     new.stripe_subscription_id is not null
                  or coalesce(new.subscription_status, '') in ('active', 'trialing')
                  or new.trial_ends_at is not null);
    was_ready := old.details_completed_at is not null and (
                     old.stripe_subscription_id is not null
                  or coalesce(old.subscription_status, '') in ('active', 'trialing')
                  or old.trial_ends_at is not null);

    if new.welcome_sent_at is not null or not now_ready or was_ready then
        return null;
    end if;

    begin
        select decrypted_secret into secret from vault.decrypted_secrets
         where name = 'welcome_email_trigger_secret';
        if secret is null then
            raise warning 'welcome email not queued for company %: Vault secret welcome_email_trigger_secret is missing', new.id;
            return null;
        end if;

        perform net.http_post(
            url := 'https://newcrgafcptspmapacrx.supabase.co/functions/v1/send-welcome-email',
            body := jsonb_build_object('company_id', new.id),
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'x-fenceflow-welcome', secret),
            timeout_milliseconds := 10000);
    exception when others then
        -- A signup must never fail over its welcome email.
        raise warning 'welcome email not queued for company %: %', new.id, sqlerrm;
    end;
    return null;
end;
$$;

revoke all on function public.queue_welcome_email() from public, anon, authenticated;

drop trigger if exists companies_queue_welcome_email on public.companies;
create trigger companies_queue_welcome_email
    after update on public.companies
    for each row
    when (new.welcome_sent_at is null and new.details_completed_at is not null)
    execute function public.queue_welcome_email();

-- ---------- 6. What this left behind ----------
select
    (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'companies' and column_name = 'welcome_sent_at') as column_added,
    (select count(*) from vault.secrets where name = 'welcome_email_trigger_secret')              as secret_present,
    (select count(*) from pg_trigger
      where tgrelid = 'public.companies'::regclass
        and tgname in ('companies_queue_welcome_email', 'companies_protect_welcome_sent_at'))      as triggers_installed,
    (select count(*) from public.companies where welcome_sent_at is not null)                     as companies_marked_sent;
