-- THE CLIENT EMAIL LOG, READ AS CONVERSATIONS.
--
-- r35 gave the admin console a way to write to clients and a flat log of what
-- went out. A flat log answers "what did I send" and not the question actually
-- asked in front of a client's name: "what have I said to THEM, and when did I
-- last say it."
--
-- WHAT THIS IS NOT. It is not a two-way mailbox. FenceFlow's mail tables are
-- company-scoped -- one fencing company's own correspondence with its own
-- customers -- and the platform has no inbox of its own: a client replying to
-- one of these goes to the support address, which nothing here ingests. So
-- these are threads with one speaker, and the console says so rather than
-- drawing an empty space where the replies would be. Building the other half
-- means routing inbound mail to a platform mailbox, which is its own piece of
-- work and needs that mailbox to exist first.
--
-- WHY NOT GROUP IN THE BROWSER. admin_client_email_log already returns the
-- body and the company, and with eleven clients the page could group it
-- itself. It would also quietly stop being right: the log caps at 200 rows,
-- so the moment the history is longer than that, a client whose last message
-- fell off the end reads as "never written to" -- which is the worst kind of
-- wrong, because it looks like an answer. These two functions page per
-- client, so the cap bounds one conversation instead of the whole history.
--
-- Same gate as everything else in r35: is_platform_admin(), asked inside each
-- function rather than trusted from the caller.
--
-- Idempotent. Safe to re-run.

-- ----------------------------------------------------- one row per client ---
--
-- Every company that has ever been written to, newest conversation first, with
-- enough to render the list without opening any of them.
--
-- sent / failed / unconfirmed are counted separately rather than returned as
-- one "status", because they mean different things to the person reading:
-- failed is something to fix, unconfirmed is something to check before sending
-- again, and neither is rare enough to fold into the other.
create or replace function public.admin_client_email_threads(
    p_limit  integer default 50,
    p_offset integer default 0
)
returns table (
    company_id        uuid,
    company_name      text,
    to_email          text,
    messages          bigint,
    sent_count        bigint,
    failed_count      bigint,
    unconfirmed_count bigint,
    last_at           timestamptz,
    last_subject      text
)
language sql
security definer
set search_path = public
stable
as $$
    with mine as (
        select e.*
          from public.admin_client_emails e
         where public.is_platform_admin()
    ),
    latest as (
        select distinct on (m.company_id)
               m.company_id, m.created_at, m.subject, m.to_email
          from mine m
         order by m.company_id, m.created_at desc, m.id desc
    )
    select l.company_id,
           c.name,
           l.to_email,
           count(*)                                              as messages,
           count(*) filter (where m.send_state = 'sent')          as sent_count,
           count(*) filter (where m.send_state = 'failed')        as failed_count,
           -- 'sending' is the honest third state: the provider took it and
           -- never answered, so nobody knows. Never folded into failed.
           count(*) filter (where m.send_state = 'sending')       as unconfirmed_count,
           l.created_at,
           l.subject
      from latest l
      join mine m on m.company_id = l.company_id
      left join public.companies c on c.id = l.company_id
     group by l.company_id, c.name, l.to_email, l.created_at, l.subject
     order by l.created_at desc
     limit greatest(1, least(coalesce(p_limit, 50), 200))
    offset greatest(0, coalesce(p_offset, 0));
$$;

revoke all on function public.admin_client_email_threads(integer, integer) from anon;
grant execute on function public.admin_client_email_threads(integer, integer) to authenticated;

-- ------------------------------------------- one client's whole conversation --
--
-- OLDEST FIRST, unlike the flat log. A conversation is read downwards: the
-- newest message belongs at the bottom, where the reply would go, which is how
-- the office's own mail view reads and the one thing that makes this feel like
-- correspondence rather than a report.
create or replace function public.admin_client_email_thread(
    p_company_id uuid,
    p_limit      integer default 100,
    p_offset     integer default 0
)
returns table (
    id            bigint,
    created_at    timestamptz,
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
    select e.id, e.created_at, e.to_email, e.subject, e.body,
           e.send_state, e.send_error, e.sent_by_email
      from public.admin_client_emails e
     where public.is_platform_admin()
       and e.company_id = p_company_id
     order by e.created_at asc, e.id asc
     limit greatest(1, least(coalesce(p_limit, 100), 500))
    offset greatest(0, coalesce(p_offset, 0));
$$;

revoke all on function public.admin_client_email_thread(uuid, integer, integer) from anon;
grant execute on function public.admin_client_email_thread(uuid, integer, integer) to authenticated;

-- ---------------------------------------------------------------- self-check
do $$
declare
    n integer;
begin
    -- Positive control first: a check that cannot fail proves nothing.
    select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname = 'admin_client_emails_not_a_function';
    assert n = 0, 'the control found a function that does not exist';

    select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.proname in ('admin_client_email_threads', 'admin_client_email_thread')
       and p.prosecdef;
    assert n = 2, format('expected 2 SECURITY DEFINER functions, found %s', n);

    select count(*) into n from information_schema.routine_privileges
     where specific_schema = 'public' and grantee = 'anon'
       and routine_name in ('admin_client_email_threads', 'admin_client_email_thread');
    assert n = 0, 'anon can execute one of the new functions';

    raise notice 'r36 admin client email threads: 2 definer functions, anon refused -- all true';
end;
$$;
