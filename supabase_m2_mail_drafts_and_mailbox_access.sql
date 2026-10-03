-- ============================================================================
-- m2: server-side drafts, and access decided per mailbox.
--
-- ADDITIVE ONLY. Two new tables, one new function. Nothing existing is dropped,
-- renamed or rewritten, and can_use_company_mail() is NOT touched.
-- ============================================================================


-- ============================================================================
-- DRAFTS
--
-- "FenceFlow does not keep drafts" is a line in the office page today, and
-- closing the compose window has always thrown the message away. He chose
-- server-side over browser-only so a half-written reply survives a closed
-- laptop and is there on the other machine.
--
-- ONE DRAFT PER COMPOSE, not per thread: he can be part-way through a reply to
-- a thread AND a fresh email to the same customer, and merging those into one
-- row loses one of them. The office page owns the id.
--
-- The body is stored as he typed it. Nothing here renders it; the reader's
-- sandboxed iframe is the only thing that ever renders mail in this app, and a
-- draft is not mail until it is sent.
-- ============================================================================
create table if not exists public.mail_drafts (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  author_id   uuid not null references public.profiles(id)  on delete cascade,

  -- Which mailbox it will be sent from, and what it is answering, when it is
  -- answering anything. Both nullable: a brand-new email has neither yet.
  account_id  uuid references public.mail_accounts(id) on delete set null,
  thread_id   uuid references public.mail_threads(id)  on delete set null,
  -- reply | reply_all | forward | new. Text rather than an enum so adding a
  -- kind later is not a migration that locks the table.
  kind        text not null default 'new',

  to_text     text not null default '',
  cc_text     text not null default '',
  bcc_text    text not null default '',
  subject     text not null default '',
  body        text not null default '',

  -- The job this email is about, if he picked one. Matches the shape
  -- mail_messages already uses (a sync id, no foreign key, so a draft about a
  -- job that is later deleted does not vanish mid-sentence).
  job_sync_id uuid,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- His own drafts, newest first. Scoped by author as well as company because a
-- draft is personal: an unfinished sentence is not company correspondence yet.
create index if not exists mail_drafts_mine_idx
  on public.mail_drafts (company_id, author_id, updated_at desc);

alter table public.mail_drafts enable row level security;

-- A draft is the author's alone. Deliberately NARROWER than the rest of mail,
-- which is company-wide: an owner can read every sent message, and should not
-- be reading a manager's half-written one.
drop policy if exists mail_drafts_own on public.mail_drafts;
create policy mail_drafts_own on public.mail_drafts
  for all
  using      (author_id = auth.uid() and (select public.can_use_company_mail()))
  with check (author_id = auth.uid() and (select public.can_use_company_mail())
              and company_id = (select public.current_company_id()));


-- ============================================================================
-- ACCESS PER MAILBOX
--
-- mail_access is COMPANY-wide: (company_id, profile_id, allowed). It answers
-- "may this person use mail at all", and can_use_company_mail() already reads
-- it. This adds a second, narrower question underneath it -- "which of the
-- three mailboxes" -- without touching the first.
--
-- DEFAULT OPEN, and that is the whole safety argument. With no rows for a
-- mailbox, everyone who passes the company gate may use it, which is exactly
-- today's behaviour. So applying this migration changes nothing for anybody
-- until he deliberately restricts a mailbox, and there is no moment where
-- adding a feature quietly took mail away from someone.
--
-- AN OWNER CAN NEVER BE LOCKED OUT. Not a convenience: the only person who can
-- grant access is the owner, so an owner who could be excluded from a mailbox
-- would have no way back in. The check below ignores the table entirely for
-- OWNER rather than relying on him remembering to grant himself.
-- ============================================================================
create table if not exists public.mail_account_access (
  account_id uuid not null references public.mail_accounts(id) on delete cascade,
  profile_id uuid not null references public.profiles(id)      on delete cascade,
  company_id uuid not null references public.companies(id)     on delete cascade,
  allowed    boolean not null default true,
  set_by     uuid references public.profiles(id) on delete set null,
  set_at     timestamptz not null default now(),
  primary key (account_id, profile_id)
);

create index if not exists mail_account_access_profile_idx
  on public.mail_account_access (company_id, profile_id);

alter table public.mail_account_access enable row level security;

-- Readable by anyone who may use mail, so the page can grey out a mailbox it
-- cannot open rather than failing when it tries. Writable by OWNER only --
-- deciding who reads billing@ is an owner's decision, not a manager's.
drop policy if exists mail_account_access_read on public.mail_account_access;
create policy mail_account_access_read on public.mail_account_access
  for select
  using (company_id = (select public.current_company_id())
         and (select public.can_use_company_mail()));

drop policy if exists mail_account_access_write on public.mail_account_access;
create policy mail_account_access_write on public.mail_account_access
  for all
  using      (company_id = (select public.current_company_id())
              and exists (select 1 from public.profiles p
                           where p.id = auth.uid() and p.role::text = 'OWNER'
                             and p.company_id = company_id))
  with check (company_id = (select public.current_company_id())
              and exists (select 1 from public.profiles p
                           where p.id = auth.uid() and p.role::text = 'OWNER'
                             and p.company_id = company_id));


-- ============================================================================
-- THE PER-MAILBOX GATE.
--
-- Composes with can_use_company_mail() rather than restating any part of it --
-- the CREW exclusion, the suspended-company check and SEE_MONEY all stay in
-- that one definition, which is the project's rule: one gate, one place. This
-- function can only ever narrow what that one already allowed.
-- ============================================================================
create or replace function public.can_use_mailbox(p_account uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select
    -- Everything the company gate asks, unchanged and first.
    (select public.can_use_company_mail())
    and exists (
      select 1 from public.mail_accounts a
       where a.id = p_account
         and a.company_id = (select public.current_company_id())
    )
    and (
      -- An owner always, without consulting the table.
      exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role::text = 'OWNER')
      -- Otherwise: an explicit row decides, and NO row means yes, which keeps
      -- an unconfigured mailbox behaving exactly as it does today.
      or coalesce(
           (select x.allowed from public.mail_account_access x
             where x.account_id = p_account and x.profile_id = auth.uid()),
           true)
    )
$$;

revoke all on function public.can_use_mailbox(uuid) from public, anon;
grant execute on function public.can_use_mailbox(uuid) to authenticated;
