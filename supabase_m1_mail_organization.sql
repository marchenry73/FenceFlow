-- ============================================================================
-- m1: the organisation layer for mail.
--
-- ADDITIVE ONLY. Every column is nullable or carries a default, every index is
-- created IF NOT EXISTS, and nothing here drops, renames or rewrites an
-- existing column. A mailbox that never uses any of it behaves exactly as it
-- does today.
--
-- WHY THESE AND NOT MORE. The audit found the mail client already has the hard
-- half built: IMAP sync for up to three mailboxes, threading, a sandboxed body
-- reader, attachments in a private bucket, and a send path that records the
-- message as "sending" before any bytes leave. What it has no room for is the
-- half a person actually touches all day -- starring, filing, archiving,
-- putting something off until Tuesday. That is what this adds.
--
-- WHAT IT DELIBERATELY DOES NOT ADD:
--   * spam. The provider decides spam, not us; a column we set ourselves would
--     be a second opinion that disagrees with the mailbox and with Gmail.
--   * a scheduled-send queue. Nothing runs between the office page and the
--     provider, so a "scheduled" row would sit unsent until somebody opened the
--     tab. That is a fake feature. It needs a worker first; see m2.
--   * per-message importance. mail_messages already carries is_flagged from
--     IMAP. A second notion of important that does not travel back to the
--     mailbox would drift the moment he opens Gmail on his phone.
--
-- THREAD-LEVEL, NOT MESSAGE-LEVEL, for everything a person files: he stars and
-- archives a CONVERSATION, and a flag on one message of six reads as an
-- accident. is_seen stays per message, where IMAP already puts it.
-- ============================================================================

-- ---------------------------------------------------------------- stars -----
-- Thread level, local to FenceFlow. IMAP's \Flagged already rides on
-- mail_messages.is_flagged and syncs both ways; this is the office's own star,
-- which is why it is separate rather than an alias for that.
alter table public.mail_threads
  add column if not exists is_starred boolean not null default false;

-- --------------------------------------------------------------- filing -----
-- Archived leaves the inbox without leaving the mailbox. Trashed is the user's
-- own bin, NOT a delete: nothing here removes a row, which is the standing rule
-- for this project's data. mail_messages.server_gone_at already records the
-- separate fact that the MAILBOX no longer has the message.
alter table public.mail_threads
  add column if not exists archived_at timestamptz,
  add column if not exists trashed_at  timestamptz,
  add column if not exists trashed_by  uuid references public.profiles(id) on delete set null;

-- --------------------------------------------------------------- snooze -----
-- The thread leaves the inbox until snoozed_until passes, then comes back. A
-- timestamp rather than a boolean plus a date, so "is it back yet" is one
-- comparison against now() and there is no second column to contradict it.
alter table public.mail_threads
  add column if not exists snoozed_until timestamptz,
  add column if not exists snoozed_by    uuid references public.profiles(id) on delete set null;

-- ------------------------------------------------------------ assignment -----
-- Who owns ANSWERING this thread. mail_messages.sent_by already records who
-- sent an outgoing message; that is history and this is a job, so they are
-- different columns on purpose. Null means unassigned, which is a real and
-- common state, not a missing value.
alter table public.mail_threads
  add column if not exists assigned_to uuid references public.profiles(id) on delete set null,
  add column if not exists assigned_at timestamptz;

-- ---------------------------------------------------------------- labels -----
-- A table, not a text[] on the thread: a label gets renamed, recoloured and
-- deleted, and an array makes every one of those a rewrite of every row that
-- carries it. Company scoped, because a label is the company's filing system.
create table if not exists public.mail_labels (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  name        text not null,
  colour      text,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- One label of a given name per company, case-insensitively: "Permits" and
-- "permits" are the same drawer, and letting both exist is how a filing system
-- quietly stops working.
create unique index if not exists mail_labels_company_name_idx
  on public.mail_labels (company_id, lower(name));

create table if not exists public.mail_thread_labels (
  thread_id  uuid not null references public.mail_threads(id) on delete cascade,
  label_id   uuid not null references public.mail_labels(id)  on delete cascade,
  company_id uuid not null references public.companies(id)    on delete cascade,
  applied_by uuid references public.profiles(id) on delete set null,
  applied_at timestamptz not null default now(),
  primary key (thread_id, label_id)
);

create index if not exists mail_thread_labels_company_label_idx
  on public.mail_thread_labels (company_id, label_id);

-- --------------------------------------------------------- internal notes ----
-- A note on a thread that is NEVER sent. Deliberately its own table and NOT a
-- row in mail_messages: a note that lives among the messages is one bad join
-- away from being rendered into a reply and mailed to the customer. Separate
-- storage makes that mistake structurally impossible rather than merely
-- unlikely.
create table if not exists public.mail_thread_notes (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid not null references public.mail_threads(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  body       text not null,
  author_id  uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists mail_thread_notes_thread_idx
  on public.mail_thread_notes (thread_id, created_at desc);

-- -------------------------------------------------------------- templates ----
-- User-editable templates. Every existing template is hardcoded TypeScript in
-- _shared/email-templates.ts and ships with the function; those stay as they
-- are, because they are the system's own transactional mail. These are HIS, for
-- the mail he types himself.
create table if not exists public.mail_templates (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name       text not null,
  subject    text not null default '',
  body       text not null default '',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists mail_templates_company_name_idx
  on public.mail_templates (company_id, lower(name));

-- ---------------------------------------------------------------- indexes ----
-- The inbox query is "this company's threads, not archived, not trashed, not
-- snoozed into the future, newest first". Partial, so it stays small and is
-- only consulted for the rows the inbox actually asks about.
create index if not exists mail_threads_inbox_idx
  on public.mail_threads (company_id, last_message_at desc)
  where archived_at is null and trashed_at is null;

create index if not exists mail_threads_starred_idx
  on public.mail_threads (company_id, last_message_at desc)
  where is_starred and trashed_at is null;

-- Due snoozes: tiny, and read by whatever wakes threads back up.
create index if not exists mail_threads_snoozed_idx
  on public.mail_threads (snoozed_until)
  where snoozed_until is not null;

create index if not exists mail_threads_assigned_idx
  on public.mail_threads (company_id, assigned_to, last_message_at desc)
  where trashed_at is null;

-- -------------------------------------------------------------------- RLS ----
-- Same shape as the rest of mail: the company gate decides, and crew never
-- reach any of it. can_use_company_mail() is the one definition and is not
-- restated here -- a second copy of a permission rule is a second rule.
alter table public.mail_labels        enable row level security;
alter table public.mail_thread_labels enable row level security;
alter table public.mail_thread_notes  enable row level security;
alter table public.mail_templates     enable row level security;

drop policy if exists mail_labels_rw on public.mail_labels;
create policy mail_labels_rw on public.mail_labels
  for all using (company_id = (select public.current_company_id()) and (select public.can_use_company_mail()))
  with check  (company_id = (select public.current_company_id()) and (select public.can_use_company_mail()));

drop policy if exists mail_thread_labels_rw on public.mail_thread_labels;
create policy mail_thread_labels_rw on public.mail_thread_labels
  for all using (company_id = (select public.current_company_id()) and (select public.can_use_company_mail()))
  with check  (company_id = (select public.current_company_id()) and (select public.can_use_company_mail()));

drop policy if exists mail_thread_notes_rw on public.mail_thread_notes;
create policy mail_thread_notes_rw on public.mail_thread_notes
  for all using (company_id = (select public.current_company_id()) and (select public.can_use_company_mail()))
  with check  (company_id = (select public.current_company_id()) and (select public.can_use_company_mail()));

drop policy if exists mail_templates_rw on public.mail_templates;
create policy mail_templates_rw on public.mail_templates
  for all using (company_id = (select public.current_company_id()) and (select public.can_use_company_mail()))
  with check  (company_id = (select public.current_company_id()) and (select public.can_use_company_mail()));

-- ============================================================================
-- WRITES TO mail_threads GO THROUGH FUNCTIONS, NOT THROUGH A POLICY.
--
-- mail_threads carries a READ policy and no write policy at all: every write
-- today is an edge function acting as service_role. Adding a write policy to
-- reach the new columns would widen an existing table for every column on it,
-- not just the five added above -- so the office gets these instead, each one
-- narrow, each one asking the same gate the read policy asks.
--
-- SECURITY DEFINER so they can write past the missing policy, and therefore
-- every one of them re-checks the caller itself. company_id is never taken
-- from the caller: it is read from the thread and compared, so passing another
-- company's thread id writes nothing rather than writing to them.
-- ============================================================================

create or replace function public.mail_set_starred(p_thread uuid, p_starred boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (select can_use_company_mail()) then raise exception 'not permitted'; end if;
  update mail_threads set is_starred = p_starred
   where id = p_thread and company_id = (select current_company_id());
end $$;

create or replace function public.mail_set_filed(
  p_thread uuid, p_archived boolean, p_trashed boolean
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not (select can_use_company_mail()) then raise exception 'not permitted'; end if;
  update mail_threads
     set archived_at = case when p_archived then coalesce(archived_at, now()) else null end,
         trashed_at  = case when p_trashed  then coalesce(trashed_at,  now()) else null end,
         trashed_by  = case when p_trashed  then coalesce(trashed_by, auth.uid()) else null end
   where id = p_thread and company_id = (select current_company_id());
end $$;

create or replace function public.mail_set_snooze(p_thread uuid, p_until timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (select can_use_company_mail()) then raise exception 'not permitted'; end if;
  -- A snooze into the past is already over, so it is stored as no snooze at all
  -- rather than as a row that every inbox query then has to reason about.
  update mail_threads
     set snoozed_until = case when p_until > now() then p_until else null end,
         snoozed_by    = case when p_until > now() then auth.uid() else null end
   where id = p_thread and company_id = (select current_company_id());
end $$;

create or replace function public.mail_set_assignee(p_thread uuid, p_to uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (select can_use_company_mail()) then raise exception 'not permitted'; end if;
  -- The assignee has to be someone in THIS company. Without this check the
  -- parameter is an open door to naming anybody in the database as the owner
  -- of a thread they cannot see.
  if p_to is not null and not exists (
    select 1 from profiles
     where id = p_to and company_id = (select current_company_id())
  ) then
    raise exception 'assignee is not in this company';
  end if;
  update mail_threads
     set assigned_to = p_to,
         assigned_at = case when p_to is null then null else now() end
   where id = p_thread and company_id = (select current_company_id());
end $$;

revoke all on function public.mail_set_starred(uuid, boolean)              from public, anon;
revoke all on function public.mail_set_filed(uuid, boolean, boolean)       from public, anon;
revoke all on function public.mail_set_snooze(uuid, timestamptz)           from public, anon;
revoke all on function public.mail_set_assignee(uuid, uuid)                from public, anon;
grant execute on function public.mail_set_starred(uuid, boolean)           to authenticated;
grant execute on function public.mail_set_filed(uuid, boolean, boolean)    to authenticated;
grant execute on function public.mail_set_snooze(uuid, timestamptz)        to authenticated;
grant execute on function public.mail_set_assignee(uuid, uuid)             to authenticated;
