-- ============================================================
-- FenceFlow -- company email: the database half
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
-- Proof:  supabase_mail_probe.sql (one rolled-back transaction; splice this
--         file in at its @@MAIL@@ line to prove it before it is applied).
--
-- WHAT THIS IS. Every FenceFlow company can read and send its own business
-- mail from the office: a Zoho (or Gmail, or other IMAP/SMTP) mailbox the
-- owner connects with an app password, and "FenceFlow mail", which sends
-- through FenceFlow's Resend domain under the company's name. The edge
-- functions (mail-connect, mail-sync, mail-message, mail-send,
-- resend-inbound) do the talking to mail servers. This file is everything
-- they stand on: the tables, who may read them, where the password lives,
-- how messages become threads, and the rate ledger.
--
-- WHO GETS MAIL -- can_use_company_mail(), section 3, is the one gate. Every
-- read policy and every client RPC asks it, and every edge function asks it
-- before touching the service role.
--   * OWNER and MANAGER by default; SALES and ACCOUNTANT when the owner grants
--     it; FOREMAN only with a grant AND "See prices and money".
--   * CREW never. Hard-coded: no grant and no permission override opens it,
--     because mail carries quotes and invoices and crew never sees money.
--   * SEE_MONEY is required of everyone, a suspended or lapsed company gets
--     nothing, and platform admins are not special.
-- The grant lives in its own table (mail_access), not in permission_overrides:
-- the phone's Access editor drops tokens it does not recognise
-- (PermissionOverrides.encode()), so a server-only token would be erased --
-- and a manager's revocation undone -- the next time an old APK saved that
-- person. It also keeps has_permission(), the most sensitive function in the
-- schema, untouched.
--
-- THE PASSWORD. Stored only in Supabase Vault, reached only through three
-- SECURITY DEFINER wrappers (section 6) that only the service role can
-- execute and that also refuse any API caller whose JWT is not the service
-- role's. The link table holds a Vault id, never the value, and has no client
-- grants. No function here puts the password into SQL text, a log line, an
-- exception message or a return value, and a stored password is deleted from
-- Vault whenever its link row goes -- on disconnect, and on any cascade.
--
-- WHAT A CLIENT CAN DO. Read (RLS: own company AND the gate) mail_accounts,
-- mail_threads, mail_messages, mail_thread_jobs, and its own row of
-- mail_access (the owner reads all of the company's). Nothing else: no
-- insert, update or delete on any mail table. Every write goes through an
-- edge function using the service role, or one of the narrow RPCs in
-- section 8, each of which checks the gate itself. The public schema's
-- default ACL grants anon and authenticated everything on every new table
-- and function, so every object below carries explicit REVOKEs.
--
-- STORAGE. A new private bucket, mail-files. The only client policy is an
-- INSERT into your own <company>/outgoing/<you>/<uuid>/ folder, for compose
-- attachments. There is no SELECT policy at all: nobody lists or reads the
-- bucket from a client. Downloads are 60-second signed URLs minted by
-- mail-message. Mail attachments never go into job-files, which every
-- company member -- crew included -- can read.
-- ============================================================


-- ---------- 1. Tables ----------

-- Explicit mail grants. No row = the role default (MANAGER yes, others no).
-- OWNER never has a row (set_mail_access refuses), and a CREW row can only
-- ever be allowed=false through the RPC -- the gate ignores it either way.
create table if not exists public.mail_access (
    company_id  uuid not null references public.companies(id) on delete cascade,
    profile_id  uuid not null references public.profiles(id) on delete cascade,
    allowed     boolean not null,
    set_by      uuid not null,
    set_at      timestamptz not null default now(),
    primary key (company_id, profile_id)
);
comment on table public.mail_access is
  'Who may use company email beyond the role default. Written only by set_mail_access(); read by the owner '
  '(whole company) and by each person (own row). Kept out of permission_overrides because the phone drops '
  'tokens it does not know.';

-- One row per connected mailbox, plus at most one lazily created
-- kind='fenceflow' row per company for FenceFlow mail (Resend). Never deleted:
-- disconnect sets status='disconnected' and the messages already fetched stay.
create table if not exists public.mail_accounts (
    id               uuid primary key default gen_random_uuid(),
    company_id       uuid not null references public.companies(id) on delete cascade,
    kind             text not null check (kind in ('imap', 'fenceflow')),
    provider         text not null check (provider in ('zoho', 'gmail', 'custom', 'resend')),
    email_address    text not null check (
                         length(email_address) <= 254
                         and email_address ~ '^[a-z0-9.!#$%&''*+/=?^_{|}~-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
    display_name     text check (display_name is null or length(display_name) <= 70),
    signature        text check (signature is null or length(signature) <= 2000),
    username         text check (username is null or (length(username) between 1 and 254 and username !~ '[[:cntrl:]]')),
    -- Hosts are also vetted by hosts.ts (presets, DNS, private ranges). These
    -- checks are the backstop: a DNS name with an alphabetic last label, so no
    -- IP literal, no single label, no localhost / .local / .internal.
    imap_host        text check (imap_host is null or (
                         length(imap_host) <= 253
                         and imap_host ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
                         and imap_host !~ '\.(local|localhost|internal)$')),
    smtp_host        text check (smtp_host is null or (
                         length(smtp_host) <= 253
                         and smtp_host ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
                         and smtp_host !~ '\.(local|localhost|internal)$')),
    -- Implicit TLS only. 587 is blocked from the edge runtime and STARTTLS is
    -- not used at all.
    imap_port        integer check (imap_port is null or imap_port = 993),
    smtp_port        integer check (smtp_port is null or smtp_port = 465),
    sent_folder      text check (sent_folder is null or (length(sent_folder) <= 300 and sent_folder !~ '[[:cntrl:]]')),
    smtp_saves_sent  boolean,              -- null until the first send finds out
    -- FenceFlow mail only: the routing half of <inbound_token>[.<reply_token>]@reply domain.
    -- Filled by the trigger below, so no writer has to remember it.
    inbound_token    text unique check (inbound_token is null or inbound_token ~ '^[a-f0-9]{12,32}$'),
    status           text not null default 'connected'
                         check (status in ('connected', 'auth_failed', 'error', 'disconnected')),
    last_error_code  text check (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,60}$'),
    last_error       text,                 -- capped to 300 and stripped of control characters by the trigger
    last_error_at    timestamptz,
    last_synced_at   timestamptz,
    sync_lock_until  timestamptz,
    connected_by     uuid,
    connected_at     timestamptz not null default now(),
    disconnected_by  uuid,
    disconnected_at  timestamptz,
    updated_at       timestamptz not null default now(),
    -- The target of the composite foreign keys below: a message, thread or
    -- secret can only ever point at an account in its own company.
    unique (id, company_id),
    constraint mail_accounts_shape check (
        case kind
            when 'imap' then provider in ('zoho', 'gmail', 'custom')
                             and username is not null and imap_host is not null and smtp_host is not null
                             and inbound_token is null
            when 'fenceflow' then provider = 'resend'
                             and username is null and imap_host is null and smtp_host is null
                             and inbound_token is not null
        end
    )
);
create unique index if not exists mail_accounts_live_imap_address_idx
    on public.mail_accounts (company_id, email_address)
    where kind = 'imap' and status <> 'disconnected';
create unique index if not exists mail_accounts_one_fenceflow_idx
    on public.mail_accounts (company_id)
    where kind = 'fenceflow';
comment on table public.mail_accounts is
  'Company mailboxes (kind=imap) and the one FenceFlow-mail sender per company (kind=fenceflow). No secret '
  'is ever stored here; the app password is in Vault via mail_account_secrets. Written only by the service role.';

-- The ONLY link to Vault. No client grants at all; the wrappers in section 6
-- are the only readers and writers.
create table if not exists public.mail_account_secrets (
    account_id      uuid primary key references public.mail_accounts(id) on delete cascade,
    vault_secret_id uuid not null,
    created_at      timestamptz not null default now(),
    rotated_at      timestamptz
);
comment on table public.mail_account_secrets is
  'mail_accounts row -> vault.secrets id of its app password. Deleting a row deletes the Vault secret '
  '(trigger), so a cascade can never orphan a password. Service role only.';

-- Where sync has got to in each folder. Service role only.
create table if not exists public.mail_folder_state (
    account_id          uuid not null references public.mail_accounts(id) on delete cascade,
    role                text not null check (role in ('inbox', 'sent')),
    path                text not null check (length(path) between 1 and 300 and path !~ '[[:cntrl:]]'),
    uidvalidity         bigint,
    last_uid            bigint not null default 0 check (last_uid >= 0),
    backfill_below_uid  bigint,
    initial_done        boolean not null default false,
    updated_at          timestamptz not null default now(),
    primary key (account_id, role)
);

create table if not exists public.mail_threads (
    id               uuid primary key default gen_random_uuid(),
    company_id       uuid not null references public.companies(id) on delete cascade,
    -- The per-thread half of a FenceFlow-mail Reply-To. 48 random bits, and
    -- only ever honoured together with the company's own inbound_token.
    reply_token      text not null unique default encode(extensions.gen_random_bytes(6), 'hex'),
    subject          text not null default '',
    last_message_at  timestamptz,
    message_count    integer not null default 0,
    unread_count     integer not null default 0,
    has_attachments  boolean not null default false,
    participants     text[] not null default '{}',
    snippet          text not null default '',
    in_inbox         boolean not null default false,
    in_sent          boolean not null default false,
    created_at       timestamptz not null default now(),
    unique (id, company_id)
);
create index if not exists mail_threads_company_recent_idx
    on public.mail_threads (company_id, last_message_at desc);
create index if not exists mail_threads_participants_idx
    on public.mail_threads using gin (participants);
comment on column public.mail_threads.message_count is
  'Aggregates (count, unread, attachments, last_message_at, participants, snippet, subject, in_inbox/in_sent) '
  'are recomputed from the live messages by mail_refresh_threads(), which a statement trigger on mail_messages '
  'calls after every insert or update. Never written by hand.';

create table if not exists public.mail_messages (
    id                  uuid primary key default gen_random_uuid(),
    company_id          uuid not null references public.companies(id) on delete cascade,
    account_id          uuid not null,
    thread_id           uuid not null,
    folder_role         text not null check (folder_role in ('inbox', 'sent')),
    source              text not null check (source in ('imap', 'resend_inbound', 'fenceflow_send')),
    uidvalidity         bigint,
    uid                 bigint,
    provider_message_id text check (provider_message_id is null or length(provider_message_id) <= 200),
    -- Threading. Angle brackets stripped. parent_ids = In-Reply-To then
    -- References, de-duplicated, at most 50.
    message_id_header   text check (message_id_header is null or length(message_id_header) <= 998),
    parent_ids          text[] not null default '{}' check (cardinality(parent_ids) <= 50),
    from_address        text,
    from_name           text,
    to_list             jsonb not null default '[]' check (jsonb_typeof(to_list) = 'array'),
    cc_list             jsonb not null default '[]' check (jsonb_typeof(cc_list) = 'array'),
    reply_to_list       jsonb not null default '[]' check (jsonb_typeof(reply_to_list) = 'array'),
    to_text             text not null default '',
    -- Lower-cased external addresses. The company's own mailbox addresses are
    -- removed by mail_ingest, so they never link a message to a job.
    counterpart_emails  text[] not null default '{}' check (cardinality(counterpart_emails) <= 200),
    subject             text not null default '',
    sent_at             timestamptz,
    received_at         timestamptz not null,
    size_bytes          bigint check (size_bytes is null or size_bytes >= 0),
    has_attachments     boolean not null default false,
    is_seen             boolean not null default false,
    is_answered         boolean not null default false,
    is_flagged          boolean not null default false,
    snippet             text not null default '' check (length(snippet) <= 200),
    body_state          text not null default 'none' check (body_state in ('none', 'cached', 'too_large', 'error')),
    body_text           text check (body_text is null or octet_length(body_text) <= 262144),
    body_html           text check (body_html is null or octet_length(body_html) <= 1048576),
    body_truncated      boolean not null default false,
    -- [{idx, filename, content_type, size, content_id, disposition, storage_path, state}]
    attachments         jsonb not null default '[]' check (jsonb_typeof(attachments) = 'array'),
    send_state          text check (send_state is null or send_state in ('sending', 'sent', 'failed')),
    send_error          text check (send_error is null or length(send_error) <= 300),
    client_send_id      uuid,
    sent_by             uuid references public.profiles(id) on delete set null,
    job_sync_id         uuid,
    -- Removed or moved on the server. The row is hidden, never deleted.
    server_gone_at      timestamptz,
    -- Addresses are indexed whole AND split at @ < > , " so a search for a
    -- name, a whole address or just a domain all match. Bodies are not
    -- indexed in v1 (the search box says so).
    search_tsv          tsvector generated always as (
                            to_tsvector('simple'::regconfig,
                                coalesce(subject, '') || ' ' || coalesce(from_name, '') || ' ' ||
                                coalesce(from_address, '') || ' ' || coalesce(to_text, '') || ' ' ||
                                translate(coalesce(from_address, '') || ' ' || coalesce(to_text, ''),
                                          '@<>,"', '     '))
                        ) stored,
    created_at          timestamptz not null default now(),
    -- A message can only belong to an account and a thread of its own company.
    foreign key (account_id, company_id) references public.mail_accounts (id, company_id) on delete cascade,
    foreign key (thread_id, company_id) references public.mail_threads (id, company_id) on delete cascade,
    constraint mail_messages_uid_pair check ((uid is null) = (uidvalidity is null)),
    constraint mail_messages_source_shape check (
        case source
            when 'imap' then uid is not null and send_state is null
            when 'resend_inbound' then folder_role = 'inbox' and provider_message_id is not null and send_state is null
            when 'fenceflow_send' then folder_role = 'sent' and client_send_id is not null and send_state is not null
        end
    )
);
create unique index if not exists mail_messages_uid_idx
    on public.mail_messages (account_id, folder_role, uidvalidity, uid) where uid is not null;
create unique index if not exists mail_messages_provider_id_idx
    on public.mail_messages (account_id, provider_message_id) where provider_message_id is not null;
create unique index if not exists mail_messages_client_send_idx
    on public.mail_messages (company_id, client_send_id) where client_send_id is not null;
create index if not exists mail_messages_company_mid_idx
    on public.mail_messages (company_id, message_id_header);
create index if not exists mail_messages_parent_ids_idx
    on public.mail_messages using gin (parent_ids);
create index if not exists mail_messages_counterparts_idx
    on public.mail_messages using gin (counterpart_emails);
create index if not exists mail_messages_thread_idx
    on public.mail_messages (thread_id, received_at);
create index if not exists mail_messages_folder_recent_idx
    on public.mail_messages (account_id, folder_role, received_at desc);
create index if not exists mail_messages_search_idx
    on public.mail_messages using gin (search_tsv);

-- Manual thread -> job links. Automatic linking is by address, worked out
-- when read (mail_for_job), so editing a job's email re-links immediately.
create table if not exists public.mail_thread_jobs (
    thread_id    uuid not null,
    company_id   uuid not null references public.companies(id) on delete cascade,
    job_sync_id  uuid not null,
    linked_by    uuid,
    linked_at    timestamptz not null default now(),
    primary key (thread_id, job_sync_id),
    foreign key (thread_id, company_id) references public.mail_threads (id, company_id) on delete cascade
);
create index if not exists mail_thread_jobs_job_idx
    on public.mail_thread_jobs (company_id, job_sync_id);

-- The rate-limit ledger. The count is taken from the ledger itself, as
-- invite_sends does. company_id is null only for inbound mail to a token that
-- matches no company, which is still counted. message_session is one mailbox
-- sign-in or Resend receiving call made by mail-message.
create table if not exists public.mail_events (
    id          bigserial primary key,
    company_id  uuid references public.companies(id) on delete cascade,
    actor       uuid,
    kind        text not null,
    at          timestamptz not null default now(),
    check (company_id is not null or kind = 'inbound_dropped')
);
-- The kinds, stated once, outside the create so a re-run also widens the
-- check on a table an earlier version of this file made (whose inline check
-- Postgres named mail_events_kind_check).
alter table public.mail_events drop constraint if exists mail_events_kind_check;
alter table public.mail_events add constraint mail_events_kind_check
    check (kind in ('connect_attempt', 'send_smtp', 'send_resend', 'inbound', 'inbound_dropped', 'message_session'));
create index if not exists mail_events_company_kind_at_idx
    on public.mail_events (company_id, kind, at desc);

-- resend-inbound webhook de-duplication, keyed on svix-id.
create table if not exists public.mail_inbound_events (
    svix_id      text primary key check (length(svix_id) between 1 and 200),
    email_id     text check (email_id is null or length(email_id) <= 200),
    company_id   uuid references public.companies(id) on delete cascade,
    received_at  timestamptz not null default now()
);

-- One row. inbound_verified_at is set by the first signed webhook that
-- arrives; until then no company's Reply-To points at the reply domain.
create table if not exists public.mail_platform_settings (
    id                   integer primary key check (id = 1),
    inbound_domain       text check (inbound_domain is null or length(inbound_domain) <= 253),
    inbound_verified_at  timestamptz,
    last_inbound_at      timestamptz
);
insert into public.mail_platform_settings (id) values (1) on conflict (id) do nothing;


-- ---------- 2. Small helpers (none callable by a client) ----------

-- Largest prefix of p that is at most n bytes of UTF-8, cut on a character
-- boundary. A continuation byte is 10xxxxxx; step back over at most three.
create or replace function public.mail_cap_bytes(p text, n integer)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
    b   bytea;
    cut integer;
begin
    if p is null or octet_length(p) <= n then
        return p;
    end if;
    b := convert_to(p, 'UTF8');
    cut := n;
    while cut > 0 and (get_byte(b, cut) & 192) = 128 loop
        cut := cut - 1;
    end loop;
    return convert_from(substring(b from 1 for cut), 'UTF8');
end;
$$;

-- A timestamp from untrusted text, or null. A malformed Date header must not
-- fail a whole batch of mail.
create or replace function public.mail_try_ts(p text)
returns timestamptz
language plpgsql
stable
set search_path = public
as $$
begin
    if p is null or btrim(p) = '' then
        return null;
    end if;
    return p::timestamptz;
exception when others then
    return null;
end;
$$;

-- A JSON array capped at n elements, order kept; anything else becomes [].
create or replace function public.mail_jarray(j jsonb, n integer)
returns jsonb
language sql
immutable
set search_path = public
as $$
    select case when jsonb_typeof(j) = 'array'
                then coalesce((select jsonb_agg(e order by o)
                                 from jsonb_array_elements(j) with ordinality x(e, o)
                                where o <= n), '[]'::jsonb)
                else '[]'::jsonb end
$$;

-- Is this call the backend? True for the service role, and for a direct
-- database connection with no request context at all (a migration, the SQL
-- editor). An API caller always carries claims, and anon and authenticated
-- carry their own role there -- so the "no auth.uid()" test, which anon also
-- passes, is never used for this.
create or replace function public.mail_is_backend()
returns boolean
language sql
stable
set search_path = public
as $$
    select nullif(current_setting('request.jwt.claims', true), '') is null
        or coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', '') = 'service_role'
$$;

-- Search words -> a prefix query: every word must match the start of some
-- indexed word, so 'cof' finds "coffee" and 'acme' finds bob@acme.com. Words
-- are reduced to letters, digits and @ . _ + - before they reach to_tsquery,
-- so no input can be a tsquery syntax error. At most 8 words.
create or replace function public.mail_search_query(p text)
returns tsquery
language sql
immutable
set search_path = public
as $$
    select case when w is null then null else to_tsquery('simple'::regconfig, w) end
      from (select string_agg(quote_literal(t) || ':*', ' & ' order by o) as w
              from (select regexp_replace(s.t0, '[^[:alnum:]@._+-]', '', 'g') as t, s.o
                      from regexp_split_to_table(lower(left(coalesce(p, ''), 200)), '[[:space:]]+')
                           with ordinality s(t0, o)) c
             where c.t <> '' and c.t ~ '[[:alnum:]]' and c.o <= 8) z
$$;


-- ---------- 3. The gate ----------

create or replace function public.can_use_company_mail()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((
        select p.company_id is not null
           and p.role::text <> 'CREW'                       -- never, whatever the grant
           and public.company_allowed(p.company_id)          -- not suspended, not lapsed
           and public.has_permission('SEE_MONEY')            -- mail carries quotes and invoices
           and (p.role::text = 'OWNER'
                or coalesce((select a.allowed
                               from public.mail_access a
                              where a.company_id = p.company_id
                                and a.profile_id = p.id),
                            p.role::text = 'MANAGER'))
          from public.profiles p
         where p.id = auth.uid()
    ), false)
$$;
comment on function public.can_use_company_mail() is
  'THE company-email gate. True only for a signed-in, non-CREW member of an allowed company who holds '
  'SEE_MONEY and is OWNER, or has mail_access.allowed, or is MANAGER with no mail_access row. Every mail '
  'read policy, client RPC and edge function checks it.';


-- ---------- 4. Row security and grants ----------

alter table public.mail_access            enable row level security;
alter table public.mail_accounts          enable row level security;
alter table public.mail_account_secrets   enable row level security;
alter table public.mail_folder_state      enable row level security;
alter table public.mail_threads           enable row level security;
alter table public.mail_messages          enable row level security;
alter table public.mail_thread_jobs       enable row level security;
alter table public.mail_events            enable row level security;
alter table public.mail_inbound_events    enable row level security;
alter table public.mail_platform_settings enable row level security;

-- Nothing for anyone but the backend, then SELECT back for the four tables
-- the office reads and for mail_access. No client write grant exists at all.
revoke all on public.mail_access, public.mail_accounts, public.mail_account_secrets,
              public.mail_folder_state, public.mail_threads, public.mail_messages,
              public.mail_thread_jobs, public.mail_events, public.mail_inbound_events,
              public.mail_platform_settings
    from public, anon, authenticated;
grant select, insert, update, delete
    on public.mail_access, public.mail_accounts, public.mail_account_secrets,
       public.mail_folder_state, public.mail_threads, public.mail_messages,
       public.mail_thread_jobs, public.mail_events, public.mail_inbound_events,
       public.mail_platform_settings
    to service_role;
grant select on public.mail_access, public.mail_accounts, public.mail_threads,
                public.mail_messages, public.mail_thread_jobs
    to authenticated;
revoke all on sequence public.mail_events_id_seq from public, anon, authenticated;
grant usage, select on sequence public.mail_events_id_seq to service_role;

-- The sub-selects make each function run once per statement, not per row.
drop policy if exists mail_accounts_read on public.mail_accounts;
create policy mail_accounts_read on public.mail_accounts
    for select to authenticated
    using (company_id = (select public.current_company_id()) and (select public.can_use_company_mail()));

drop policy if exists mail_threads_read on public.mail_threads;
create policy mail_threads_read on public.mail_threads
    for select to authenticated
    using (company_id = (select public.current_company_id()) and (select public.can_use_company_mail()));

drop policy if exists mail_messages_read on public.mail_messages;
create policy mail_messages_read on public.mail_messages
    for select to authenticated
    using (company_id = (select public.current_company_id()) and (select public.can_use_company_mail()));

drop policy if exists mail_thread_jobs_read on public.mail_thread_jobs;
create policy mail_thread_jobs_read on public.mail_thread_jobs
    for select to authenticated
    using (company_id = (select public.current_company_id()) and (select public.can_use_company_mail()));

-- The owner sees the whole company's grants (the seat table's "Company email"
-- column); everyone else sees only their own row.
drop policy if exists mail_access_read on public.mail_access;
create policy mail_access_read on public.mail_access
    for select to authenticated
    using (company_id = (select public.current_company_id())
           and ((select public.current_user_role())::text = 'OWNER' or profile_id = (select auth.uid())));

-- mail_account_secrets, mail_folder_state, mail_events, mail_inbound_events
-- and mail_platform_settings: RLS on, no policies, no grants. Service role only.


-- ---------- 5. Triggers that keep rows honest whoever writes them ----------

-- mail_accounts: normalise, fill the FenceFlow routing token, forbid moving a
-- row between companies or kinds, cap live mailboxes at 3 per company (the
-- backstop behind mail-connect's own check), and cap last_error.
create or replace function public.mail_accounts_guard()
returns trigger
language plpgsql
security definer   -- runs the same whoever writes; needs nothing from the writer
set search_path = public
as $$
begin
    new.email_address := lower(btrim(new.email_address));
    new.imap_host := lower(btrim(new.imap_host));
    new.smtp_host := lower(btrim(new.smtp_host));
    new.username := btrim(new.username);
    if new.kind = 'fenceflow' and new.inbound_token is null then
        new.inbound_token := encode(extensions.gen_random_bytes(8), 'hex');
    end if;
    new.last_error := left(regexp_replace(left(new.last_error, 1200), '[[:cntrl:]]+', ' ', 'g'), 300);
    new.updated_at := now();

    if tg_op = 'UPDATE' then
        if new.company_id <> old.company_id or new.kind <> old.kind then
            raise exception 'A mail account cannot move between companies or kinds.' using errcode = '42501';
        end if;
    end if;

    if new.kind = 'imap' and new.status <> 'disconnected'
       and (tg_op = 'INSERT' or old.status = 'disconnected') then
        perform pg_advisory_xact_lock(hashtext('mail:' || new.company_id::text));
        if (select count(*) from public.mail_accounts a
             where a.company_id = new.company_id and a.kind = 'imap'
               and a.status <> 'disconnected' and a.id <> new.id) >= 3 then
            raise exception 'A company can connect at most 3 mailboxes.' using errcode = '23514';
        end if;
    end if;
    return new;
end;
$$;
drop trigger if exists mail_accounts_guard on public.mail_accounts;
create trigger mail_accounts_guard
    before insert or update on public.mail_accounts
    for each row execute function public.mail_accounts_guard();

-- mail_messages: strip control characters from what is displayed and cap
-- every text column, bodies included (flagging body_truncated), so no writer
-- -- mail_ingest, mail-message caching a body, mail-send recording an error
-- -- can fail on a length check or store a header that renders as something
-- it is not.
create or replace function public.mail_messages_clean()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    new.subject      := left(regexp_replace(left(coalesce(new.subject, ''), 4000), '[[:cntrl:]]+', ' ', 'g'), 998);
    new.from_name    := left(regexp_replace(left(new.from_name, 1200), '[[:cntrl:]]+', ' ', 'g'), 300);
    new.from_address := left(lower(btrim(regexp_replace(left(new.from_address, 1200), '[[:cntrl:]]+', '', 'g'))), 320);
    new.to_text      := left(regexp_replace(left(coalesce(new.to_text, ''), 8000), '[[:cntrl:]]+', ' ', 'g'), 4000);
    new.snippet      := left(btrim(regexp_replace(left(coalesce(new.snippet, ''), 2000), '[[:space:][:cntrl:]]+', ' ', 'g')), 200);
    new.send_error   := left(regexp_replace(left(new.send_error, 1200), '[[:cntrl:]]+', ' ', 'g'), 300);
    if octet_length(new.body_text) > 262144 then
        new.body_text := public.mail_cap_bytes(new.body_text, 262144);
        new.body_truncated := true;
    end if;
    if octet_length(new.body_html) > 1048576 then
        new.body_html := public.mail_cap_bytes(new.body_html, 1048576);
        new.body_truncated := true;
    end if;
    new.attachments   := public.mail_jarray(new.attachments, 50);
    new.to_list       := public.mail_jarray(new.to_list, 100);
    new.cc_list       := public.mail_jarray(new.cc_list, 100);
    new.reply_to_list := public.mail_jarray(new.reply_to_list, 20);
    return new;
end;
$$;
drop trigger if exists mail_messages_clean on public.mail_messages;
create trigger mail_messages_clean
    before insert or update on public.mail_messages
    for each row execute function public.mail_messages_clean();

-- Removing the link row removes the password from Vault. This is the one
-- place a stored password is destroyed, so disconnect (mail_secret_forget)
-- and any cascade (a deleted account or company) both forget it.
create or replace function public.mail_account_secrets_forget_vault()
returns trigger
language plpgsql
security definer
set search_path = public, vault
as $$
begin
    delete from vault.secrets where id = old.vault_secret_id;
    return old;
end;
$$;
drop trigger if exists mail_account_secrets_forget_vault on public.mail_account_secrets;
create trigger mail_account_secrets_forget_vault
    after delete on public.mail_account_secrets
    for each row execute function public.mail_account_secrets_forget_vault();

-- Thread aggregates. Recomputed from the live messages of every thread a
-- statement touched, whoever wrote it -- so marking a message read in
-- mail-message cannot leave the unread badge wrong. mail_ingest sets
-- mail.defer_refresh and refreshes once at the end instead of per row.
-- The _core function has no caller check and no grant: only the trigger and
-- the checked wrapper below reach it.
create or replace function public.mail_refresh_threads_core(p_threads uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.mail_threads t
       set message_count   = s.cnt,
           unread_count    = s.unread,
           has_attachments = s.att,
           last_message_at = coalesce(s.last_at, t.last_message_at),
           in_inbox        = s.inbox,
           in_sent         = s.sent,
           snippet         = coalesce(s.snip, ''),
           subject         = coalesce(s.subj, t.subject),
           participants    = s.parts
      from (select distinct x.id from unnest(p_threads) as x(id) where x.id is not null) w
     cross join lateral (
            select count(*)::integer as cnt,
                   (count(*) filter (where m.folder_role = 'inbox' and not m.is_seen))::integer as unread,
                   coalesce(bool_or(m.has_attachments), false) as att,
                   max(m.received_at) as last_at,
                   coalesce(bool_or(m.folder_role = 'inbox'), false) as inbox,
                   coalesce(bool_or(m.folder_role = 'sent'), false) as sent,
                   (array_agg(m.snippet order by m.received_at desc))[1] as snip,
                   (array_agg(m.subject order by m.received_at) filter (where m.subject <> ''))[1] as subj,
                   coalesce((select (array_agg(distinct e order by e))[1:50]
                               from public.mail_messages m2, unnest(m2.counterpart_emails) e
                              where m2.thread_id = w.id and m2.server_gone_at is null), '{}') as parts
              from public.mail_messages m
             where m.thread_id = w.id and m.server_gone_at is null
     ) s
     where t.id = w.id;
end;
$$;

create or replace function public.mail_refresh_threads(p_threads uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.mail_is_backend() then
        raise exception 'Service role only' using errcode = '42501';
    end if;
    perform public.mail_refresh_threads_core(p_threads);
end;
$$;

create or replace function public.mail_messages_refresh_threads()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if coalesce(current_setting('mail.defer_refresh', true), '') = 'on' then
        return null;
    end if;
    if tg_op = 'UPDATE' then
        -- A message that changed thread refreshes both.
        perform public.mail_refresh_threads_core(array(
            select thread_id from new_rows union select thread_id from old_rows));
    else
        perform public.mail_refresh_threads_core(array(select distinct thread_id from new_rows));
    end if;
    return null;
end;
$$;
drop trigger if exists mail_messages_refresh_ins on public.mail_messages;
create trigger mail_messages_refresh_ins
    after insert on public.mail_messages
    referencing new table as new_rows
    for each statement execute function public.mail_messages_refresh_threads();
drop trigger if exists mail_messages_refresh_upd on public.mail_messages;
create trigger mail_messages_refresh_upd
    after update on public.mail_messages
    referencing old table as old_rows new table as new_rows
    for each statement execute function public.mail_messages_refresh_threads();


-- ---------- 6. The app password, in Vault (service role only) ----------
--
-- The owner types the app password into the office; it travels once, over
-- HTTPS, to mail-connect, which calls mail_secret_put. It arrives here as an
-- RPC parameter -- never in SQL text -- and log_statement is 'ddl', so the
-- call is not logged. Nothing below echoes it: length and character errors
-- say what is wrong without repeating the value, and a Vault failure is
-- reported by SQLSTATE only.

create or replace function public.mail_secret_put(p_account uuid, p_secret text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
    acct_kind text;
    sid       uuid;
    nm        text := 'mail_account:' || p_account::text;   -- named by account id, never by address
begin
    if not public.mail_is_backend() then
        raise exception 'Service role only' using errcode = '42501';
    end if;
    select kind into acct_kind from public.mail_accounts where id = p_account;
    if acct_kind is null then
        raise exception 'Unknown mail account' using errcode = 'P0002';
    end if;
    if acct_kind <> 'imap' then
        raise exception 'Only a connected mailbox has an app password' using errcode = '22023';
    end if;
    if p_secret is null or length(p_secret) < 1 or length(p_secret) > 256 then
        raise exception 'The app password must be 1 to 256 characters' using errcode = '22023';
    end if;
    if p_secret ~ '[[:cntrl:]]' then
        raise exception 'The app password contains a character that cannot be used' using errcode = '22023';
    end if;

    begin
        select s.vault_secret_id into sid
          from public.mail_account_secrets s
         where s.account_id = p_account
           for update;
        if sid is not null and not exists (select 1 from vault.secrets v where v.id = sid) then
            sid := null;                     -- link points at nothing; make a new secret
        end if;
        if sid is null then
            -- A secret under this name with no link (a half-finished earlier
            -- attempt) is reused rather than tripping the unique name.
            select v.id into sid from vault.secrets v where v.name = nm;
        end if;
        if sid is null then
            sid := vault.create_secret(p_secret, nm, 'app password for mail_accounts row');
        else
            perform vault.update_secret(sid, p_secret);
        end if;
        insert into public.mail_account_secrets as s (account_id, vault_secret_id)
        values (p_account, sid)
        on conflict (account_id) do update
           set vault_secret_id = excluded.vault_secret_id,
               rotated_at      = now();
    exception when others then
        -- SQLSTATE only: an error from inside Vault must never carry text
        -- that could include the value.
        raise exception 'Could not store the app password (%)', sqlstate using errcode = 'XX000';
    end;
end;
$$;

create or replace function public.mail_secret_get(p_account uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, vault
as $$
declare
    v text;
begin
    if not public.mail_is_backend() then
        raise exception 'Service role only' using errcode = '42501';
    end if;
    select ds.decrypted_secret into v
      from public.mail_account_secrets s
      join vault.decrypted_secrets ds on ds.id = s.vault_secret_id
     where s.account_id = p_account;
    return v;
end;
$$;

-- Deletes the link row; the trigger deletes the Vault secret with it.
-- Answers whether there was a password to forget.
create or replace function public.mail_secret_forget(p_account uuid)
returns boolean
language plpgsql
security definer
set search_path = public, vault
as $$
begin
    if not public.mail_is_backend() then
        raise exception 'Service role only' using errcode = '42501';
    end if;
    delete from public.mail_account_secrets where account_id = p_account;
    return found;
end;
$$;


-- ---------- 7. Service-role RPCs: sync lock, rate ledger, ingest, flags ----------

-- One sync per account at a time. Atomic: the row is claimed only when no
-- unexpired lock is on it. Seconds are clamped to 1..900.
create or replace function public.mail_claim_sync(p_account uuid, p_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.mail_is_backend() then
        raise exception 'Service role only' using errcode = '42501';
    end if;
    update public.mail_accounts
       set sync_lock_until = now() + make_interval(secs => least(greatest(coalesce(p_seconds, 60), 1), 900))
     where id = p_account
       and kind = 'imap'
       and status <> 'disconnected'
       and (sync_lock_until is null or sync_lock_until < now());
    return found;
end;
$$;

-- Records one event and answers with the count of that kind for that company
-- inside the window, this one included. The caller refuses when it is over the
-- cap -- a refused attempt still counts, so hammering burns the budget.
-- Calls for the same company and kind take turns (a transaction-scoped
-- advisory lock), so two arriving together cannot both count before either
-- has recorded: each sees the other, and the cap is exact.
create or replace function public.note_mail_event(p_company uuid, p_actor uuid, p_kind text, p_window interval)
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.mail_is_backend() then
        raise exception 'Service role only' using errcode = '42501';
    end if;
    if p_window is null or p_window <= interval '0' or p_window > interval '7 days' then
        raise exception 'The window must be between 0 and 7 days' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtext('mail_events:' || coalesce(p_company::text, '-') || ':' || coalesce(p_kind, '')));
    insert into public.mail_events (company_id, actor, kind) values (p_company, p_actor, p_kind);
    return public.mail_event_count(p_company, p_kind, p_window);
end;
$$;

-- The same count without recording anything, for a second window on the same
-- event (send: 20 an hour AND 200 a day) -- calling note_mail_event twice would
-- record the send twice.
create or replace function public.mail_event_count(p_company uuid, p_kind text, p_window interval)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    n integer;
begin
    if not public.mail_is_backend() then
        raise exception 'Service role only' using errcode = '42501';
    end if;
    if p_company is null then
        select count(*) into n from public.mail_events
         where company_id is null and kind = p_kind and at > now() - p_window;
    else
        select count(*) into n from public.mail_events
         where company_id = p_company and kind = p_kind and at > now() - p_window;
    end if;
    return n;
end;
$$;

-- The company's FenceFlow-mail account, created on first use. Race-safe (two
-- first sends at once get the same row), and keeps the address current if
-- MAIL_FROM changes. PostgREST cannot upsert against a partial unique index,
-- which is why this is an RPC.
create or replace function public.mail_fenceflow_account(p_company uuid, p_email text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v    uuid;
    addr text := lower(btrim(p_email));
begin
    if not public.mail_is_backend() then
        raise exception 'Service role only' using errcode = '42501';
    end if;
    insert into public.mail_accounts (company_id, kind, provider, email_address, status)
    values (p_company, 'fenceflow', 'resend', addr, 'connected')
    on conflict (company_id) where kind = 'fenceflow' do nothing;
    select id into v from public.mail_accounts where company_id = p_company and kind = 'fenceflow';
    update public.mail_accounts set email_address = addr where id = v and email_address <> addr;
    return v;
end;
$$;

-- Turns parsed messages into rows and threads. p_rows is a JSON array; each
-- element uses mail_messages' column names:
--   folder_role, source, uidvalidity, uid, provider_message_id,
--   message_id_header, parent_ids[], from_address, from_name, to_list[],
--   cc_list[], reply_to_list[], to_text, counterpart_emails[], subject,
--   sent_at, received_at, size_bytes, has_attachments, is_seen, is_answered,
--   is_flagged, snippet, body_state, body_text, body_html, body_truncated,
--   attachments[], send_state, send_error, client_send_id, sent_by,
--   job_sync_id
-- plus reply_token (a thread's token, from a FenceFlow-mail Reply-To).
-- Answers one row per element, in order: (message_id, thread_id, inserted).
--
-- Per element:
--   1. De-duplicate: same (folder, uidvalidity, uid), same provider id, or
--      same client_send_id -> the existing row, inserted=false. mail-send
--      relies on the last one: a second claim with its client_send_id returns
--      the first and it sends nothing.
--   2. Re-bind: FenceFlow's own send (no uid yet) takes the server uid when
--      its Sent copy (same Message-ID) turns up; after a UIDVALIDITY reset the
--      old row takes its new uid rather than being duplicated.
--   3. Thread: explicit reply_token (this company's only) -> a copy of the same
--      Message-ID already here -> a parent (Message-ID in parent_ids) -> a
--      reply that arrived first (its parent_ids hold this Message-ID) -> new.
--      Always inside this account's company. Subjects never merge threads.
--      Threads are not merged in v1: References normally carries the whole
--      chain, so a gap can split a conversation but never mix two.
--   4. Insert. The company's own mailbox addresses are stripped from
--      counterpart_emails here, whatever the caller sent. A job_sync_id that
--      names a live job of this company also links the thread to it.
-- Then the aggregates of every touched thread are recomputed once.
create or replace function public.mail_ingest(p_account uuid, p_rows jsonb)
returns table (message_id uuid, thread_id uuid, inserted boolean)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
    acct        public.mail_accounts%rowtype;
    own         text[];
    touched     uuid[] := '{}';
    r           jsonb;
    v_role      text;
    v_source    text;
    v_uidv      bigint;
    v_uid       bigint;
    v_pmid      text;
    v_mid       text;
    v_parents   text[];
    v_counter   text[];
    v_csid      uuid;
    v_token     text;
    v_sent_by   uuid;
    v_job       uuid;
    v_received  timestamptz;
    v_body_text text;
    v_atts      jsonb;
    hit_id      uuid;
    hit_thread  uuid;
    v_thread    uuid;
begin
    if not public.mail_is_backend() then
        raise exception 'Service role only' using errcode = '42501';
    end if;
    select * into acct from public.mail_accounts a where a.id = p_account;
    if not found then
        raise exception 'Unknown mail account' using errcode = 'P0002';
    end if;
    if jsonb_typeof(p_rows) is distinct from 'array' then
        raise exception 'p_rows must be a JSON array' using errcode = '22023';
    end if;
    if jsonb_array_length(p_rows) > 500 then
        raise exception 'At most 500 messages per call' using errcode = '22023';
    end if;

    -- One ingest per company at a time, so two syncs cannot both decide a
    -- message is new, or both open a thread for the same conversation.
    perform pg_advisory_xact_lock(hashtext('mail:' || acct.company_id::text));
    perform set_config('mail.defer_refresh', 'on', true);

    select coalesce(array_agg(a.email_address), '{}') into own
      from public.mail_accounts a where a.company_id = acct.company_id;

    for r in select e from jsonb_array_elements(p_rows) as x(e) loop
        if jsonb_typeof(r) is distinct from 'object' then
            raise exception 'Each message must be a JSON object' using errcode = '22023';
        end if;

        -- ----- normalise -----
        v_role   := r ->> 'folder_role';
        v_source := r ->> 'source';
        if v_role is null or v_role not in ('inbox', 'sent') then
            raise exception 'folder_role must be inbox or sent' using errcode = '22023';
        end if;
        if v_source is null or v_source not in ('imap', 'resend_inbound', 'fenceflow_send') then
            raise exception 'Unknown source' using errcode = '22023';
        end if;
        if (v_source = 'imap' and acct.kind <> 'imap')
           or (v_source = 'resend_inbound' and acct.kind <> 'fenceflow') then
            raise exception 'Source % does not belong to a % account', v_source, acct.kind using errcode = '22023';
        end if;

        v_uidv := case when (r ->> 'uidvalidity') ~ '^[0-9]{1,18}$' then (r ->> 'uidvalidity')::bigint end;
        v_uid  := case when (r ->> 'uid') ~ '^[0-9]{1,18}$' then (r ->> 'uid')::bigint end;
        if v_uid is null or v_uidv is null then
            v_uid := null;
            v_uidv := null;
        end if;
        v_pmid := nullif(left(btrim(r ->> 'provider_message_id'), 200), '');
        v_mid  := nullif(left(btrim(r ->> 'message_id_header', '<> ' || chr(9)), 998), '');
        v_csid := case when (r ->> 'client_send_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                       then (r ->> 'client_send_id')::uuid end;
        v_token := nullif(lower(btrim(r ->> 'reply_token')), '');

        -- parent_ids: brackets stripped, de-duplicated, first-seen order, at most 50.
        select coalesce(array_agg(p order by first_o), '{}') into v_parents
          from (select p, min(o) as first_o
                  from (select left(btrim(t, '<> ' || chr(9)), 998) as p, o
                          from jsonb_array_elements_text(
                                   case when jsonb_typeof(r -> 'parent_ids') = 'array'
                                        then r -> 'parent_ids' else '[]'::jsonb end)
                               with ordinality x(t, o)) y
                 where p <> '' and p is distinct from v_mid
                 group by p
                 order by first_o
                 limit 50) z;

        -- counterparts: lower-cased, trimmed, never one of the company's own mailboxes.
        select coalesce(array_agg(c order by c), '{}') into v_counter
          from (select c
                  from (select distinct lower(btrim(t)) as c
                          from jsonb_array_elements_text(
                                   case when jsonb_typeof(r -> 'counterpart_emails') = 'array'
                                        then r -> 'counterpart_emails' else '[]'::jsonb end) as x(t)) y
                 where c like '%_@_%' and length(c) <= 320 and not (c = any(own))
                 order by c
                 limit 200) z;

        v_received := least(coalesce(public.mail_try_ts(r ->> 'received_at'),
                                     public.mail_try_ts(r ->> 'sent_at'), now()),
                            now() + interval '1 day');   -- a bogus future date must not pin a thread to the top

        if v_source = 'imap' and v_uid is null then
            raise exception 'An IMAP message needs uid and uidvalidity' using errcode = '22023';
        end if;
        if v_source = 'resend_inbound' and v_pmid is null then
            raise exception 'An inbound message needs provider_message_id' using errcode = '22023';
        end if;
        if v_source = 'fenceflow_send' and v_csid is null then
            raise exception 'A FenceFlow send needs client_send_id' using errcode = '22023';
        end if;

        -- ----- 1. de-duplicate -----
        hit_id := null;
        hit_thread := null;
        if v_uid is not null then
            select m.id, m.thread_id into hit_id, hit_thread from public.mail_messages m
             where m.account_id = acct.id and m.folder_role = v_role
               and m.uidvalidity = v_uidv and m.uid = v_uid;
        end if;
        if hit_id is null and v_pmid is not null then
            select m.id, m.thread_id into hit_id, hit_thread from public.mail_messages m
             where m.account_id = acct.id and m.provider_message_id = v_pmid;
        end if;
        if hit_id is null and v_csid is not null then
            select m.id, m.thread_id into hit_id, hit_thread from public.mail_messages m
             where m.company_id = acct.company_id and m.client_send_id = v_csid;
        end if;
        if hit_id is not null then
            message_id := hit_id; thread_id := hit_thread; inserted := false;
            return next;
            continue;
        end if;

        -- ----- 2. re-bind -----
        if v_source = 'imap' and v_mid is not null then
            -- FenceFlow's own send, waiting for the copy the server saved.
            select m.id, m.thread_id into hit_id, hit_thread from public.mail_messages m
             where m.account_id = acct.id and m.folder_role = v_role
               and m.message_id_header = v_mid and m.uid is null and m.source = 'fenceflow_send'
             order by m.created_at
             limit 1;
            -- The same message under an older UIDVALIDITY.
            if hit_id is null then
                select m.id, m.thread_id into hit_id, hit_thread from public.mail_messages m
                 where m.account_id = acct.id and m.folder_role = v_role
                   and m.message_id_header = v_mid and m.uid is not null
                   and m.uidvalidity <> v_uidv
                 order by m.received_at desc
                 limit 1;
            end if;
            if hit_id is not null then
                update public.mail_messages m
                   set uidvalidity    = v_uidv,
                       uid            = v_uid,
                       server_gone_at = null,
                       size_bytes     = coalesce(m.size_bytes, case when (r ->> 'size_bytes') ~ '^[0-9]{1,15}$'
                                                                    then (r ->> 'size_bytes')::bigint end),
                       -- The server copy proves the send was accepted.
                       send_state     = case when m.send_state = 'sending' then 'sent' else m.send_state end
                 where m.id = hit_id;
                touched := touched || hit_thread;
                message_id := hit_id; thread_id := hit_thread; inserted := false;
                return next;
                continue;
            end if;
        end if;

        -- ----- 3. pick the thread -----
        v_thread := null;
        if v_token is not null then
            select t.id into v_thread from public.mail_threads t
             where t.company_id = acct.company_id and t.reply_token = v_token;
        end if;
        if v_thread is null and v_mid is not null then
            select m.thread_id into v_thread from public.mail_messages m
             where m.company_id = acct.company_id and m.message_id_header = v_mid
             order by m.received_at
             limit 1;
        end if;
        if v_thread is null and cardinality(v_parents) > 0 then
            select m.thread_id into v_thread from public.mail_messages m
             where m.company_id = acct.company_id and m.message_id_header = any(v_parents)
             order by m.received_at desc
             limit 1;
        end if;
        if v_thread is null and v_mid is not null then
            select m.thread_id into v_thread from public.mail_messages m
             where m.company_id = acct.company_id and m.parent_ids @> array[v_mid]
             order by m.received_at
             limit 1;
        end if;
        if v_thread is null then
            insert into public.mail_threads (company_id, subject, last_message_at)
            values (acct.company_id,
                    left(regexp_replace(left(coalesce(r ->> 'subject', ''), 4000), '[[:cntrl:]]+', ' ', 'g'), 998),
                    v_received)
            returning id into v_thread;
        end if;

        -- ----- 4. insert -----
        v_sent_by := case when (r ->> 'sent_by') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                          then (r ->> 'sent_by')::uuid end;
        if v_sent_by is not null and not exists (
               select 1 from public.profiles p where p.id = v_sent_by and p.company_id = acct.company_id) then
            raise exception 'sent_by is not a member of this company' using errcode = '22023';
        end if;
        v_job := case when (r ->> 'job_sync_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                      then (r ->> 'job_sync_id')::uuid end;
        if v_job is not null and not exists (
               select 1 from public.jobs j
                where j.company_id = acct.company_id and j.sync_id = v_job and j.deleted_at is null) then
            v_job := null;
        end if;
        v_body_text := r ->> 'body_text';
        v_atts := public.mail_jarray(r -> 'attachments', 50);

        insert into public.mail_messages (
            company_id, account_id, thread_id, folder_role, source, uidvalidity, uid,
            provider_message_id, message_id_header, parent_ids,
            from_address, from_name, to_list, cc_list, reply_to_list, to_text, counterpart_emails,
            subject, sent_at, received_at, size_bytes, has_attachments,
            is_seen, is_answered, is_flagged, snippet,
            body_state, body_text, body_html, body_truncated, attachments,
            send_state, send_error, client_send_id, sent_by, job_sync_id)
        values (
            acct.company_id, acct.id, v_thread, v_role, v_source, v_uidv, v_uid,
            v_pmid, v_mid, v_parents,
            r ->> 'from_address', r ->> 'from_name',
            coalesce(r -> 'to_list', '[]'::jsonb), coalesce(r -> 'cc_list', '[]'::jsonb),
            coalesce(r -> 'reply_to_list', '[]'::jsonb), coalesce(r ->> 'to_text', ''), v_counter,
            coalesce(r ->> 'subject', ''), public.mail_try_ts(r ->> 'sent_at'), v_received,
            case when (r ->> 'size_bytes') ~ '^[0-9]{1,15}$' then (r ->> 'size_bytes')::bigint end,
            coalesce(case when jsonb_typeof(r -> 'has_attachments') = 'boolean' then (r -> 'has_attachments')::boolean end,
                     jsonb_array_length(v_atts) > 0),
            coalesce(case when jsonb_typeof(r -> 'is_seen') = 'boolean' then (r -> 'is_seen')::boolean end,
                     v_role = 'sent'),
            coalesce(case when jsonb_typeof(r -> 'is_answered') = 'boolean' then (r -> 'is_answered')::boolean end, false),
            coalesce(case when jsonb_typeof(r -> 'is_flagged') = 'boolean' then (r -> 'is_flagged')::boolean end, false),
            coalesce(nullif(r ->> 'snippet', ''), left(coalesce(v_body_text, ''), 400)),
            case when coalesce(r ->> 'body_state', 'none') in ('none', 'cached', 'too_large', 'error')
                 then coalesce(r ->> 'body_state', 'none') else 'none' end,
            v_body_text, r ->> 'body_html',
            coalesce(case when jsonb_typeof(r -> 'body_truncated') = 'boolean' then (r -> 'body_truncated')::boolean end, false),
            v_atts,
            case when v_source = 'fenceflow_send'
                 then case when r ->> 'send_state' in ('sending', 'sent', 'failed') then r ->> 'send_state' else 'sending' end
            end,
            case when v_source = 'fenceflow_send' then r ->> 'send_error' end,
            v_csid, v_sent_by, v_job)
        returning id into hit_id;

        if v_job is not null then
            insert into public.mail_thread_jobs (thread_id, company_id, job_sync_id, linked_by)
            values (v_thread, acct.company_id, v_job, v_sent_by)
            on conflict do nothing;
        end if;

        touched := touched || v_thread;
        message_id := hit_id; thread_id := v_thread; inserted := true;
        return next;
    end loop;

    perform set_config('mail.defer_refresh', '', true);
    perform public.mail_refresh_threads_core(touched);
end;
$$;

-- Flags from a sync's FETCH (FLAGS). p_flags is a JSON array of
-- {uid, seen?, answered?, flagged?}; a missing key leaves that flag alone. A
-- uid the server just reported is not gone, so server_gone_at is cleared.
-- Answers how many rows changed.
create or replace function public.mail_set_flags(p_account uuid, p_role text, p_uidvalidity bigint, p_flags jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    n integer;
begin
    if not public.mail_is_backend() then
        raise exception 'Service role only' using errcode = '42501';
    end if;
    if jsonb_typeof(p_flags) is distinct from 'array' or jsonb_array_length(p_flags) > 10000 then
        raise exception 'p_flags must be a JSON array of at most 10000 entries' using errcode = '22023';
    end if;
    with f as (
        select distinct on (uid) uid, seen, answered, flagged
          from (select (e ->> 'uid')::bigint as uid,
                       case when jsonb_typeof(e -> 'seen') = 'boolean' then (e -> 'seen')::boolean end as seen,
                       case when jsonb_typeof(e -> 'answered') = 'boolean' then (e -> 'answered')::boolean end as answered,
                       case when jsonb_typeof(e -> 'flagged') = 'boolean' then (e -> 'flagged')::boolean end as flagged
                  from jsonb_array_elements(p_flags) as x(e)
                 where (e ->> 'uid') ~ '^[0-9]{1,18}$') y
    )
    update public.mail_messages m
       set is_seen        = coalesce(f.seen, m.is_seen),
           is_answered    = coalesce(f.answered, m.is_answered),
           is_flagged     = coalesce(f.flagged, m.is_flagged),
           server_gone_at = null
      from f
     where m.account_id = p_account and m.folder_role = p_role
       and m.uidvalidity = p_uidvalidity and m.uid = f.uid
       and (m.is_seen is distinct from coalesce(f.seen, m.is_seen)
            or m.is_answered is distinct from coalesce(f.answered, m.is_answered)
            or m.is_flagged is distinct from coalesce(f.flagged, m.is_flagged)
            or m.server_gone_at is not null);
    get diagnostics n = row_count;
    return n;
end;
$$;

-- UIDs a sync no longer finds on the server: hidden, never deleted.
create or replace function public.mail_mark_gone(p_account uuid, p_role text, p_uidvalidity bigint, p_uids bigint[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    n integer;
begin
    if not public.mail_is_backend() then
        raise exception 'Service role only' using errcode = '42501';
    end if;
    if cardinality(p_uids) > 10000 then
        raise exception 'At most 10000 uids per call' using errcode = '22023';
    end if;
    update public.mail_messages m
       set server_gone_at = now()
     where m.account_id = p_account and m.folder_role = p_role
       and m.uidvalidity = p_uidvalidity and m.uid = any(p_uids)
       and m.server_gone_at is null;
    get diagnostics n = row_count;
    return n;
end;
$$;


-- ---------- 8. Client RPCs ----------

-- The Email tab's thread list. SECURITY INVOKER: RLS decides what is visible,
-- so a caller who fails the gate simply gets nothing. Threads with at least
-- one live message in the folder ('inbox', 'sent' or 'all'), optionally for
-- one account, optionally matching every search word as a prefix of a word
-- in the subject, a name or an address. Newest first. Page with the last
-- row's last_message_at as p_before and its id as p_before_id (the id breaks
-- ties: IMAP dates are whole seconds). unread_count is for the same filter.
create or replace function public.mail_list_threads(
    p_folder    text        default 'inbox',
    p_account   uuid        default null,
    p_query     text        default null,
    p_before    timestamptz default null,
    p_limit     integer     default 50,
    p_before_id uuid        default null)
returns table (
    id                  uuid,
    subject             text,
    last_message_at     timestamptz,
    message_count       integer,
    unread_count        integer,
    has_attachments     boolean,
    snippet             text,
    participants        text[],
    in_inbox            boolean,
    in_sent             boolean,
    latest_from_name    text,
    latest_from_address text,
    job_sync_ids        uuid[])
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
    q      tsquery;
    folder text := coalesce(nullif(p_folder, ''), 'inbox');
    lim    integer := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
    if folder not in ('inbox', 'sent', 'all') then
        raise exception 'Unknown folder' using errcode = '22023';
    end if;
    if nullif(btrim(coalesce(p_query, '')), '') is not null then
        q := public.mail_search_query(p_query);
        if q is null or numnode(q) = 0 then
            return;          -- typed something, none of it searchable: nothing matches
        end if;
    end if;

    return query
    with x as (
        select m.thread_id,
               max(m.received_at) as last_at,
               (count(*) filter (where m.folder_role = 'inbox' and not m.is_seen))::integer as unread
          from public.mail_messages m
         where m.server_gone_at is null
           and (folder = 'all' or m.folder_role = folder)
           and (p_account is null or m.account_id = p_account)
           and (q is null or m.search_tsv @@ q)
         group by m.thread_id
    )
    select t.id, t.subject, x.last_at, t.message_count, x.unread, t.has_attachments,
           t.snippet, t.participants, t.in_inbox, t.in_sent,
           lm.from_name, lm.from_address,
           coalesce((select array_agg(l.job_sync_id order by l.linked_at)
                       from public.mail_thread_jobs l where l.thread_id = t.id), '{}')
      from x
      join public.mail_threads t on t.id = x.thread_id
      left join lateral (
            select m.from_name, m.from_address
              from public.mail_messages m
             where m.thread_id = t.id and m.server_gone_at is null
               and (folder = 'all' or m.folder_role = folder)
               and (p_account is null or m.account_id = p_account)
             order by m.received_at desc
             limit 1) lm on true
     where p_before is null
        or x.last_at < p_before
        or (x.last_at = p_before and p_before_id is not null and t.id < p_before_id)
     order by x.last_at desc, t.id desc
     limit lim;
end;
$$;

-- The job sheet's Email panel. SECURITY INVOKER. Threads whose live messages
-- involve the job's email, its customer's email (jobs.customer_id) or its HOA
-- email -- lower-cased and trimmed only, no plus or dot stripping, which would
-- match the wrong people -- plus threads linked by hand. Worked out when read,
-- so editing the job's email re-links at once. matched_hoa is only set for an
-- HOA address that is not also the customer's.
create or replace function public.mail_for_job(p_job_sync_id uuid, p_limit integer default 30)
returns table (
    id               uuid,
    subject          text,
    last_message_at  timestamptz,
    message_count    integer,
    unread_count     integer,
    has_attachments  boolean,
    snippet          text,
    participants     text[],
    linked           boolean,
    matched_customer boolean,
    matched_hoa      boolean)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
    e_job  text;
    e_hoa  text;
    e_cust text;
    cust   text[];
    hoa    text[];
    lim    integer := least(greatest(coalesce(p_limit, 30), 1), 100);
begin
    select nullif(lower(btrim(j.email)), ''), nullif(lower(btrim(j.hoa_email)), ''), nullif(lower(btrim(c.email)), '')
      into e_job, e_hoa, e_cust
      from public.jobs j
      left join public.customers c
             on c.id = j.customer_id and c.company_id = j.company_id and c.deleted_at is null
     where j.company_id = public.current_company_id()
       and j.sync_id = p_job_sync_id
       and j.deleted_at is null;
    if not found then
        return;
    end if;
    cust := array_remove(array[e_job, e_cust], null);
    hoa := case when e_hoa is null or e_hoa = any(cust) then '{}'::text[] else array[e_hoa] end;

    return query
    with hits as (
        select m.thread_id,
               bool_or(m.counterpart_emails && cust) as mc,
               bool_or(m.counterpart_emails && hoa) as mh
          from public.mail_messages m
         where m.server_gone_at is null
           and m.counterpart_emails && (cust || hoa)
         group by m.thread_id
    ), links as (
        select l.thread_id from public.mail_thread_jobs l where l.job_sync_id = p_job_sync_id
    ), ids as (
        select h.thread_id from hits h union select k.thread_id from links k
    )
    select t.id, t.subject, t.last_message_at, t.message_count, t.unread_count,
           t.has_attachments, t.snippet, t.participants,
           exists (select 1 from links k where k.thread_id = t.id),
           coalesce(h.mc, false), coalesce(h.mh, false)
      from ids
      join public.mail_threads t on t.id = ids.thread_id
      left join hits h on h.thread_id = t.id
     order by t.last_message_at desc nulls last, t.id desc
     limit lim;
end;
$$;

-- "Link to a job" on a thread. SECURITY DEFINER, so it checks everything
-- itself: signed in, the gate, the thread is this company's, and the job is a
-- live job of this company. Answers whether a link was added.
create or replace function public.mail_link_thread(p_thread uuid, p_job_sync_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    co uuid := public.current_company_id();
begin
    if auth.uid() is null or co is null then
        raise exception 'Not signed in' using errcode = '42501';
    end if;
    if not public.can_use_company_mail() then
        raise exception 'Company email is not available to you' using errcode = '42501';
    end if;
    if not exists (select 1 from public.mail_threads t where t.id = p_thread and t.company_id = co) then
        raise exception 'Email not found' using errcode = 'P0002';
    end if;
    if not exists (select 1 from public.jobs j
                    where j.company_id = co and j.sync_id = p_job_sync_id and j.deleted_at is null) then
        raise exception 'Job not found' using errcode = 'P0002';
    end if;
    insert into public.mail_thread_jobs (thread_id, company_id, job_sync_id, linked_by)
    values (p_thread, co, p_job_sync_id, auth.uid())
    on conflict do nothing;
    return found;
end;
$$;

create or replace function public.mail_unlink_thread(p_thread uuid, p_job_sync_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    co uuid := public.current_company_id();
begin
    if auth.uid() is null or co is null then
        raise exception 'Not signed in' using errcode = '42501';
    end if;
    if not public.can_use_company_mail() then
        raise exception 'Company email is not available to you' using errcode = '42501';
    end if;
    delete from public.mail_thread_jobs
     where thread_id = p_thread and job_sync_id = p_job_sync_id and company_id = co;
    return found;
end;
$$;

-- The owner's "Company email" switch in the seat table. p_allowed = null
-- removes the explicit grant, so the person is back to the role default.
-- Refuses: anyone but the owner; a person outside the company; an OWNER
-- target (always has it); switching it ON for CREW (never). Audited.
create or replace function public.set_mail_access(p_profile uuid, p_allowed boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    me         uuid := auth.uid();
    co         uuid := public.current_company_id();
    target     public.profiles%rowtype;
    was        boolean;
    who_email  text;
begin
    if me is null or co is null then
        raise exception 'Not signed in' using errcode = '42501';
    end if;
    if public.current_user_role()::text is distinct from 'OWNER' then
        raise exception 'Only the owner can change who uses company email' using errcode = '42501';
    end if;
    select * into target from public.profiles where id = p_profile;
    if not found or target.company_id is distinct from co then
        raise exception 'That person is not in your company' using errcode = 'P0002';
    end if;
    if target.role::text = 'OWNER' then
        raise exception 'The owner always has company email' using errcode = '22023';
    end if;
    if p_allowed and target.role::text = 'CREW' then
        raise exception 'Crew never gets company email' using errcode = '22023';
    end if;

    select a.allowed into was from public.mail_access a where a.company_id = co and a.profile_id = p_profile;
    if p_allowed is null then
        delete from public.mail_access where company_id = co and profile_id = p_profile;
    else
        insert into public.mail_access (company_id, profile_id, allowed, set_by)
        values (co, p_profile, p_allowed, me)
        on conflict (company_id, profile_id) do update
           set allowed = excluded.allowed, set_by = excluded.set_by, set_at = now();
    end if;

    select email into who_email from auth.users where id = me;
    insert into public.audit_log (company_id, actor, actor_email, table_name, record_id, action,
                                  field, old_value, new_value, label)
    values (co, me, who_email, 'mail_access', p_profile::text, 'update',
            'allowed', was::text, p_allowed::text, coalesce(target.full_name, ''));
end;
$$;

-- The tab badge. SECURITY INVOKER: RLS, so it is 0 for anyone without mail.
create or replace function public.mail_unread_count()
returns integer
language sql
stable
security invoker
set search_path = public
as $$
    select coalesce(sum(t.unread_count), 0)::integer from public.mail_threads t
$$;


-- ---------- 9. Function grants ----------
-- The default ACL hands EXECUTE on every new function to anon and
-- authenticated, and PostgreSQL itself to PUBLIC. Take it all back, then give
-- each function exactly the callers it is for.

revoke all on function
    public.mail_cap_bytes(text, integer),
    public.mail_try_ts(text),
    public.mail_jarray(jsonb, integer),
    public.mail_is_backend(),
    public.mail_search_query(text),
    public.can_use_company_mail(),
    public.mail_accounts_guard(),
    public.mail_messages_clean(),
    public.mail_account_secrets_forget_vault(),
    public.mail_refresh_threads_core(uuid[]),
    public.mail_refresh_threads(uuid[]),
    public.mail_messages_refresh_threads(),
    public.mail_secret_put(uuid, text),
    public.mail_secret_get(uuid),
    public.mail_secret_forget(uuid),
    public.mail_claim_sync(uuid, integer),
    public.note_mail_event(uuid, uuid, text, interval),
    public.mail_event_count(uuid, text, interval),
    public.mail_fenceflow_account(uuid, text),
    public.mail_ingest(uuid, jsonb),
    public.mail_set_flags(uuid, text, bigint, jsonb),
    public.mail_mark_gone(uuid, text, bigint, bigint[]),
    public.mail_list_threads(text, uuid, text, timestamptz, integer, uuid),
    public.mail_for_job(uuid, integer),
    public.mail_link_thread(uuid, uuid),
    public.mail_unlink_thread(uuid, uuid),
    public.set_mail_access(uuid, boolean),
    public.mail_unread_count()
from public, anon, authenticated;

-- The office.
grant execute on function
    public.can_use_company_mail(),
    public.mail_list_threads(text, uuid, text, timestamptz, integer, uuid),
    public.mail_for_job(uuid, integer),
    public.mail_link_thread(uuid, uuid),
    public.mail_unlink_thread(uuid, uuid),
    public.set_mail_access(uuid, boolean),
    public.mail_unread_count(),
    -- Called from inside mail_list_threads, which runs as the caller. It
    -- only turns words into a query.
    public.mail_search_query(text)
to authenticated, service_role;

-- The edge functions.
grant execute on function
    public.mail_secret_put(uuid, text),
    public.mail_secret_get(uuid),
    public.mail_secret_forget(uuid),
    public.mail_claim_sync(uuid, integer),
    public.note_mail_event(uuid, uuid, text, interval),
    public.mail_event_count(uuid, text, interval),
    public.mail_fenceflow_account(uuid, text),
    public.mail_ingest(uuid, jsonb),
    public.mail_set_flags(uuid, text, bigint, jsonb),
    public.mail_mark_gone(uuid, text, bigint, bigint[]),
    public.mail_refresh_threads(uuid[])
to service_role;


-- ---------- 10. Storage: mail-files ----------
-- Private, 25 MB per object. Paths:
--   <company>/<account>/<message>/<idx>-<safe name>   stored by mail-message / resend-inbound
--   <company>/outgoing/<uid>/<uuid>/<name>             uploaded by the office for compose
-- The ONLY client policy is the INSERT below. No SELECT, UPDATE or DELETE
-- policy exists, so no client can list, read, overwrite or remove anything
-- here -- including its own uploads. mail-send reads them with the service
-- role after checking the path starts with <company>/outgoing/<caller>/.
insert into storage.buckets (id, name, public, file_size_limit)
values ('mail-files', 'mail-files', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists mail_files_outgoing_insert on storage.objects;
create policy mail_files_outgoing_insert on storage.objects
    for insert to authenticated
    with check (
        bucket_id = 'mail-files'
        and array_length(storage.foldername(name), 1) = 4
        and (storage.foldername(name))[1] = (select public.current_company_id())::text
        and (storage.foldername(name))[2] = 'outgoing'
        and (storage.foldername(name))[3] = (select auth.uid())::text
        and (select public.can_use_company_mail())
    );

select 'company mail installed' as done;
