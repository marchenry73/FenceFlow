-- EMAILING YOUR CLIENTS FROM THE ADMIN CONSOLE.
--
-- "Email your clients from the admin portal" has sat on the not-started list
-- because it needs a sender that posts as FenceFlow rather than as a company's
-- own inbox, and because sending mail to real people deserves more than a
-- textarea and a POST.
--
-- WHAT THIS FILE ADDS, and nothing else:
--   admin_client_emails          one row per company per send, the record
--   admin_email_recipients(uuid[])  who those company ids actually are
--   admin_claim_client_email(...)   the exactly-once claim
--   admin_finish_client_email(...)  the verdict written back
--   admin_client_email_log(...)     what the console shows
--
-- THE RECIPIENT IS NEVER IN THE REQUEST. The console sends company IDS; the
-- address comes from the company row. That is the property that stops this
-- being an open relay with a FenceFlow return address on it: a stolen admin
-- token can mail his own customers, which is bad, but it can never mail
-- anybody who is not already a FenceFlow client.
--
-- EXACTLY ONCE, per (client_send_id, company). The same rule
-- send-welcome-email follows, for the same reason: a double click, a retried
-- request or two tabs must not send the same notice twice. The claim is taken
-- BEFORE a byte goes to the mail provider, and the verdict is written after:
--   accepted              -> 'sent'
--   refused outright (4xx) -> 'failed', and the claim is RELEASED so a retry
--                             with the same id can go out
--   no verdict (5xx, timeout, connection gone) -> left 'sending'
-- which fails toward not sending twice. The console says "could not confirm"
-- for a row still 'sending' and never "failed".
--
-- A TEST COMPANY IS NEVER MAILED. A name starting 'ZZ TEST' is the convention
-- supabase_test_companies.sql and the job fixtures already use, and
-- send-welcome-email already honours. Enforced here, in the recipient list, so
-- no caller can opt out of it.
--
-- WHO MAY DO ANY OF IT: is_platform_admin(), the one funnel every admin action
-- goes through, which carries the second factor. Each function asks it again
-- rather than trusting the caller that reached it.
--
-- Idempotent. Safe to re-run.

-- ---------------------------------------------------------------- the record
create table if not exists public.admin_client_emails (
    id              bigserial primary key,
    -- One per compose window, from the console. The unique index below is what
    -- makes the claim a claim.
    client_send_id  uuid        not null,
    company_id      uuid        not null references public.companies (id) on delete cascade,
    -- Copied, not joined: this is the record of what was sent, and the
    -- company's address may change afterwards.
    to_email        text        not null,
    subject         text        not null,
    body            text        not null,
    send_state      text        not null default 'sending'
                    check (send_state in ('sending', 'sent', 'failed')),
    provider        text,
    provider_id     text,
    send_error      text,
    sent_by         uuid        not null,
    sent_by_email   text,
    created_at      timestamptz not null default now(),
    finished_at     timestamptz
);

create unique index if not exists admin_client_emails_once
    on public.admin_client_emails (client_send_id, company_id);

create index if not exists admin_client_emails_recent
    on public.admin_client_emails (created_at desc);

-- NO POLICIES, AND THAT IS THE POINT. Nothing is granted to authenticated or
-- anon, so RLS being on with an empty policy set means no ordinary session can
-- read or write a row. Every path in goes through the SECURITY DEFINER
-- functions below, each of which asks is_platform_admin() first. A table a
-- client could read would tell them what was sent to every other client.
alter table public.admin_client_emails enable row level security;
revoke all on public.admin_client_emails from anon, authenticated;

-- ------------------------------------------------------------- who they are
--
-- The console passes company ids; this says who that is. Returns FEWER rows
-- than it was given whenever a company has no address, has been removed, or is
-- a test company -- and the console shows that difference, so "I selected 11
-- and it is sending 9" is visible before he presses send rather than after.
create or replace function public.admin_email_recipients(company_ids uuid[])
returns table (company_id uuid, name text, to_email text)
language sql
security definer
set search_path = public
stable
as $$
    select c.id, c.name, lower(btrim(c.email))
      from public.companies c
     where public.is_platform_admin()
       and c.id = any (company_ids)
       and c.deleted_at is null
       and c.email is not null
       and btrim(c.email) <> ''
       -- The same test-company convention send-welcome-email honours. Here
       -- rather than in the caller, so nothing can opt out of it.
       and c.name not like 'ZZ TEST%'
     order by c.name;
$$;

revoke all on function public.admin_email_recipients(uuid[]) from anon;
grant execute on function public.admin_email_recipients(uuid[]) to authenticated;

-- ---------------------------------------------------------------- the claim
--
-- Returns the row id when THIS call won the right to send, and null when the
-- pair was claimed before. Null means "somebody already has this"; the caller
-- sends nothing and reports the existing row's state.
create or replace function public.admin_claim_client_email(
    p_client_send_id uuid,
    p_company_id     uuid,
    p_to_email       text,
    p_subject        text,
    p_body           text
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
    claimed bigint;
    actor   uuid := auth.uid();
begin
    if not public.is_platform_admin() then
        raise exception 'Only a FenceFlow admin may email a client.';
    end if;
    -- auth.uid() is null for the service role AND for anon, so a null actor
    -- here would be an unattributed send. is_platform_admin() above already
    -- refuses anon, but the record is the point of this table: a row with no
    -- author is worse than a refused send.
    if actor is null then
        raise exception 'An emailed client must have a named sender.';
    end if;
    if coalesce(btrim(p_to_email), '') = '' then
        raise exception 'No address to send to.';
    end if;
    if coalesce(btrim(p_subject), '') = '' then
        raise exception 'An email needs a subject.';
    end if;
    if coalesce(btrim(p_body), '') = '' then
        raise exception 'An email needs something in it.';
    end if;

    insert into public.admin_client_emails
        (client_send_id, company_id, to_email, subject, body, sent_by, sent_by_email)
    values
        (p_client_send_id, p_company_id, lower(btrim(p_to_email)), p_subject, p_body,
         actor, (select lower(u.email) from auth.users u where u.id = actor))
    on conflict (client_send_id, company_id) do nothing
    returning id into claimed;

    return claimed;
end;
$$;

revoke all on function public.admin_claim_client_email(uuid, uuid, text, text, text) from anon;
grant execute on function public.admin_claim_client_email(uuid, uuid, text, text, text) to authenticated;

-- --------------------------------------------------------------- the verdict
--
-- p_state is 'sent' or 'failed'. A send with no verdict is simply never
-- finished, so the row stays 'sending' -- see the header.
--
-- RELEASING A FAILED CLAIM. On an outright refusal the row is DELETED rather
-- than marked failed, so the same client_send_id can be used again: the
-- provider said certainly-not-sent, so there is nothing to protect against a
-- second attempt, and leaving the claim would make the retry report
-- "duplicate" and send nothing for ever. p_keep_record keeps it instead, for a
-- refusal worth showing him (a bad address).
create or replace function public.admin_finish_client_email(
    p_id          bigint,
    p_state       text,
    p_provider    text    default null,
    p_provider_id text    default null,
    p_error       text    default null,
    p_keep_record boolean default true
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.is_platform_admin() then
        raise exception 'Only a FenceFlow admin may record an email.';
    end if;
    if p_state not in ('sent', 'failed') then
        raise exception 'Unknown send state: %', p_state;
    end if;

    if p_state = 'failed' and not p_keep_record then
        delete from public.admin_client_emails where id = p_id and send_state = 'sending';
        return;
    end if;

    update public.admin_client_emails
       set send_state  = p_state,
           provider    = coalesce(p_provider, provider),
           provider_id = coalesce(p_provider_id, provider_id),
           send_error  = p_error,
           finished_at = now()
     where id = p_id
       -- Only a row still in flight. A verdict arriving twice, or after
       -- somebody else finished it, must not rewrite history.
       and send_state = 'sending';
end;
$$;

revoke all on function public.admin_finish_client_email(bigint, text, text, text, text, boolean) from anon;
grant execute on function public.admin_finish_client_email(bigint, text, text, text, text, boolean) to authenticated;

-- -------------------------------------------------------------------- the log
--
-- Newest first, with the company's current name beside the address it actually
-- went to. Paged, because this grows for ever and an unpaged read silently
-- stops at a thousand rows (PostgREST's cap) with nothing to say it did.
create or replace function public.admin_client_email_log(
    p_limit  integer default 50,
    p_offset integer default 0
)
returns table (
    id            bigint,
    created_at    timestamptz,
    company_id    uuid,
    company_name  text,
    to_email      text,
    subject       text,
    body          text,
    send_state    text,
    send_error    text,
    sent_by_email text
)
language sql
security definer
set search_path = public
stable
as $$
    select e.id, e.created_at, e.company_id, c.name, e.to_email, e.subject, e.body,
           e.send_state, e.send_error, e.sent_by_email
      from public.admin_client_emails e
      left join public.companies c on c.id = e.company_id
     where public.is_platform_admin()
     order by e.created_at desc, e.id desc
     limit greatest(1, least(coalesce(p_limit, 50), 200))
    offset greatest(0, coalesce(p_offset, 0));
$$;

revoke all on function public.admin_client_email_log(integer, integer) from anon;
grant execute on function public.admin_client_email_log(integer, integer) to authenticated;

-- ---------------------------------------------------------------- self-check
--
-- Run this block after applying. Every line must read true. A positive control
-- comes first: a check that cannot fail proves nothing, so the first row
-- asserts the table is actually there before the rest ask about it.
do $$
declare
    n integer;
begin
    select count(*) into n from information_schema.tables
     where table_schema = 'public' and table_name = 'admin_client_emails';
    assert n = 1, 'admin_client_emails was not created';

    select count(*) into n from pg_indexes
     where schemaname = 'public' and indexname = 'admin_client_emails_once';
    assert n = 1, 'the exactly-once index is missing, so a double click can send twice';

    select count(*) into n from pg_policies
     where schemaname = 'public' and tablename = 'admin_client_emails';
    assert n = 0, 'a policy appeared on admin_client_emails; it is meant to be reachable only through its functions';

    select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.proname in ('admin_email_recipients', 'admin_claim_client_email',
                         'admin_finish_client_email', 'admin_client_email_log');
    assert n = 4, format('expected 4 functions, found %s', n);

    -- Every one of them must be SECURITY DEFINER, or is_platform_admin() is
    -- being asked about a caller who could never have read the table anyway
    -- and the function would simply return nothing.
    select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.proname in ('admin_email_recipients', 'admin_claim_client_email',
                         'admin_finish_client_email', 'admin_client_email_log')
       and p.prosecdef;
    assert n = 4, 'one of the admin email functions is not SECURITY DEFINER';

    raise notice 'r35 admin client email: table, index, 4 functions, no policies -- all true';
end;
$$;
