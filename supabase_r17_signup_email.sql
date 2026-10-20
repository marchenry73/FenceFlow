-- r17: the email a person gets when they CREATE an account, before they have
-- told us anything about their business.
--
-- Deploy supabase/functions/send-signup-email BEFORE running this, or the
-- first signup after it queues a POST to a function that is not there. The
-- trigger swallows that (see below), so nothing breaks -- that person just
-- never gets this one email.
--
-- ADDITIVE. One new column, one Vault secret, three new functions, two new
-- triggers. Nothing existing is altered or dropped. supabase_r6_welcome_email
-- is untouched and still sends its own, later email.
--
-- WHY. FenceFlow had exactly ONE email for a new company and it goes out only
-- when the company is READY: details finished AND a trial or a plan. A person
-- who created an account and stopped before the details step therefore heard
-- nothing, ever. On 19 October 2026 a real signup did exactly that -- account
-- created at 20:56, owner attached, details_completed_at still null -- and the
-- owner asked why no email arrived. Nothing was broken and nothing was owed:
-- the email simply did not exist. This is it.
--
-- WHEN IT FIRES: on INSERT of a profile with role OWNER. That is the first
-- instant we know both that a real person signed up AND where to write to
-- them. The company row is the wrong hook: it can exist for a moment with no
-- owner, and some companies never get one at all (three in production today).
--
-- WHO MAY CALL THE FUNCTION: this trigger. It reads a secret from Vault
-- (signup_email_trigger_secret, generated here from random bytes and never
-- printed) and sends it in x-fenceflow-signup. A copy of this schema in
-- another project gets its own secret, which production refuses.
--
-- A SIGNUP MUST NEVER FAIL OVER ITS EMAIL. Every failure in the trigger --
-- missing secret, pg_net refusing, the function not deployed, anything -- is
-- caught and turned into a warning. The person still gets their account.
-- The cost of that choice is that a failure is quiet, so the way to check
-- this is working is companies.signup_sent_at, not the absence of errors.
--
-- NOT SENT TWICE, AND NOT SENT WITH THE WELCOME ONE. The function skips a
-- company whose details are already done, so someone who signs up and
-- finishes setup in one sitting gets only the welcome email.
-- ============================================================

-- ---------- 1. The column ----------
alter table public.companies add column if not exists signup_sent_at timestamptz;

comment on column public.companies.signup_sent_at is
  'When FenceFlow''s one signup email was claimed for this company (send-signup-email, '
  'supabase_r17_signup_email.sql). Null = never sent. Set only by the service role; a signed-in '
  'caller cannot change it (companies_protect_signup_sent_at). Distinct from welcome_sent_at, '
  'which is the later "you are all set up" email.';

-- ---------- 2. The secret, in Vault ----------
do $seed$
begin
    if not exists (select 1 from vault.secrets where name = 'signup_email_trigger_secret') then
        perform vault.create_secret(
            encode(extensions.gen_random_bytes(32), 'hex'),
            'signup_email_trigger_secret',
            'Shared secret between the profiles_queue_signup_email trigger and the send-signup-email '
            'Edge Function. Generated here from random bytes and never printed. Copy it into the '
            'function''s secrets only if the function ever needs it directly; it does not today -- '
            'it asks signup_email_trigger_ok() instead.');
    end if;
end
$seed$;

-- ---------- 3. The function's door ----------
-- True only for the exact secret. Digests are compared rather than the
-- values, so how long the comparison takes says nothing about how much of a
-- guess was right.
create or replace function public.signup_email_trigger_ok(p_secret text)
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
     where name = 'signup_email_trigger_secret';
    if stored is null then
        return false;
    end if;
    return extensions.digest(convert_to(p_secret, 'UTF8'), 'sha256')
         = extensions.digest(convert_to(stored, 'UTF8'), 'sha256');
end;
$$;

revoke all on function public.signup_email_trigger_ok(text) from public, anon, authenticated;
grant execute on function public.signup_email_trigger_ok(text) to service_role;

-- ---------- 4. The column's guard ----------
create or replace function public.protect_signup_sent_at()
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
        new.signup_sent_at := old.signup_sent_at;
    end if;
    return new;
end;
$$;

revoke all on function public.protect_signup_sent_at() from public, anon, authenticated;

drop trigger if exists companies_protect_signup_sent_at on public.companies;
create trigger companies_protect_signup_sent_at
    before update on public.companies
    for each row
    when (new.signup_sent_at is distinct from old.signup_sent_at)
    execute function public.protect_signup_sent_at();

-- ---------- 5. The trigger that asks for the email ----------
create or replace function public.queue_signup_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    co     public.companies%rowtype;
    secret text;
begin
    if new.company_id is null then
        return null;
    end if;

    select * into co from public.companies where id = new.company_id;
    if not found then
        return null;
    end if;

    -- The same three refusals the function re-checks for itself. Checked here
    -- too so the common cases never cost a pg_net call: already sent, already
    -- past this step, or a seeded test company.
    if co.signup_sent_at is not null
       or co.details_completed_at is not null
       or co.name ~* '^\s*zz test' then
        return null;
    end if;

    begin
        select decrypted_secret into secret from vault.decrypted_secrets
         where name = 'signup_email_trigger_secret';
        if secret is null then
            raise warning 'signup email not queued for company %: Vault secret signup_email_trigger_secret is missing', co.id;
            return null;
        end if;

        perform net.http_post(
            url := 'https://newcrgafcptspmapacrx.supabase.co/functions/v1/send-signup-email',
            body := jsonb_build_object('company_id', co.id),
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'x-fenceflow-signup', secret),
            timeout_milliseconds := 10000);
    exception when others then
        -- A signup must never fail over its email.
        raise warning 'signup email not queued for company %: %', co.id, sqlerrm;
    end;
    return null;
end;
$$;

revoke all on function public.queue_signup_email() from public, anon, authenticated;

drop trigger if exists profiles_queue_signup_email on public.profiles;
create trigger profiles_queue_signup_email
    after insert on public.profiles
    for each row
    when (new.role = 'OWNER')
    execute function public.queue_signup_email();

-- ---------- 6. What this left behind ----------
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'companies'
      and column_name = 'signup_sent_at')                            as column_added,
  (select count(*) from vault.secrets
    where name = 'signup_email_trigger_secret')                      as secret_created,
  (select count(*) from pg_proc
    where proname in ('signup_email_trigger_ok', 'protect_signup_sent_at', 'queue_signup_email')) as functions_created,
  (select count(*) from pg_trigger
    where tgname in ('companies_protect_signup_sent_at', 'profiles_queue_signup_email')) as triggers_created,
  -- Nobody is retro-emailed: everyone who exists right now is marked as
  -- already handled by leaving signup_sent_at null AND never firing for them
  -- (the trigger is INSERT-only). This is the count that would have been
  -- emailed if it fired on existing rows, and it must stay a count, not an act.
  (select count(*) from public.companies c
    where c.signup_sent_at is null
      and c.details_completed_at is null
      and c.name !~* '^\s*zz test')                                  as existing_not_retro_emailed;
