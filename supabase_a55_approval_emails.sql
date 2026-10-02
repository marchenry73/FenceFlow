-- ============================================================
-- FenceFlow -- A55: emailing the customer their contract when they approve,
-- and the record of whether it went.
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- NOT APPLIED. Written 1 October 2026. Apply this BEFORE deploying the
-- quote-approval-email and quote-view functions (see "ORDER" below): without
-- the table the new function cannot record a send, and a function that cannot
-- record a send REFUSES to send ("sent twice" would have no guard), tells the
-- office so, and sends nothing. That is the safe failure, not a silent one --
-- but it is a feature that does not work until this file has run.
--
-- WHAT THIS ADDS: one table, quote_approval_emails. Nothing existing is
-- altered, dropped or rewritten. In particular NO COLUMN IS ADDED TO jobs.
--
-- WHY A TABLE AND NOT A STAMP ON THE JOB
--
--   "Once, not every time" wants a stamp, and a column on jobs is the obvious
--   shape. It is the wrong one here, for four reasons:
--
--   1. jobs is the offline-sync table. Every column on it rides the phone's
--      wire format (EntitySync.kt / JobSync.kt) and the updated_at clock that
--      decides whose offline edit wins. A bookkeeping write that moves that
--      clock can silently beat a real edit made in the field -- supabase_
--      reapproval_on_drawing_change.sql had to teach touch_updated_at() about
--      three such columns. A new column would need the same treatment, in a
--      trigger other work is editing, plus a Room migration and a wire-format
--      change on the phone.
--   2. One stamp per job cannot say "this contract" -- and it must. The key
--      below is a fingerprint of what the email STATES (property, scope, total,
--      deposit), so approving, withdrawing and approving again at the same
--      price sends nothing, while approving a CHANGED contract (the drawing
--      moved, the price moved) sends the new one. A stamp would have to choose
--      between "never again" (she holds a copy with the old price on it) and
--      "every approval" (she is emailed again and again).
--   3. A stamp can say "sent". It cannot say "NOT sent, and why": no address on
--      the job, a malformed address, no price, mail not configured, a rate
--      limit, a refusal, an unconfirmed send. Those are exactly the outcomes
--      the owner must not miss, and they need a place to live.
--   4. The unique key is the claim. The email goes only to the call that
--      inserts the row (insert ... returning, unique violation = someone else
--      has it), so two tabs, a retry and a double click are one email -- the
--      same claim-before-send shape as follow_up_log and automation_runs.
--
-- WHO MAY READ IT: members of the company who hold SEE_CUSTOMER_CONTACT (owner,
-- manager, sales, accountant, foreman, plus per-person overrides) -- the row
-- carries the address the contract went to. It carries NO money: no total, no
-- deposit, nothing the crew are built never to see. Crew without that
-- permission read nothing. Nobody writes it from a client: no insert, update or
-- delete grant and no write policy, so only the service-role edge functions
-- (quote-approval-email, and quote-view for the one case where it could not
-- even call it) ever add or change a row.
--
-- The public schema's default privileges grant anon and authenticated
-- everything on every new table, so the REVOKE below is not optional: without
-- it row security is the only wall and a mistake in a policy is a leak.
--
-- ORDER (nothing here is applied by the code; each step is the owner's):
--   1. Run this file.
--   2. Deploy quote-approval-email  (supabase functions deploy quote-approval-email --no-verify-jwt;
--      config.toml pins verify_jwt = false for it as well).
--   3. Deploy quote-view.
--   Secrets it relies on, all already set on the project: NOTIFY_TRIGGER_SECRET,
--   MAIL_API_KEY, MAIL_FROM, SITE_URL, MAIL_INBOUND_DOMAIN, RESEND_WEBHOOK_SECRET,
--   RESEND_RECEIVING_KEY, FIREBASE_SERVICE_ACCOUNT. No new secret.
--
-- TO UNDO:  drop table if exists public.quote_approval_emails;
--
-- ------------------------------------------------------------------------
-- READ-ONLY CHECKS to run after go-live (they change nothing):
--
--   -- Every contract email that did NOT go out, and why:
--   select a.attempted_at, a.job_sync_id, a.state, a.reason_code, a.reason
--     from public.quote_approval_emails a
--    where a.state <> 'sent'
--    order by a.attempted_at desc;
--
--   -- Approved jobs the sender never recorded anything for (a crash between
--   -- the approval landing and the call being made, or the sender never
--   -- reached). Bound it by the go-live time: every job approved BEFORE this
--   -- feature will, rightly, show here.
--   select j.sync_id, j.customer_name, j.quote_approved_at
--     from public.jobs j
--    where j.quote_approved_at > timestamptz '<go-live time>'
--      and j.deleted_at is null and j.is_test_fixture = false
--      and not exists (select 1 from public.quote_approval_emails e
--                       where e.company_id = j.company_id and e.job_sync_id = j.sync_id);
--
--   -- Sends that began and never reported back (should be rare; treat as
--   -- "may have gone out" -- look in company email's Sent before resending):
--   select * from public.quote_approval_emails
--    where state = 'sending' and attempted_at < now() - interval '10 minutes';
-- ------------------------------------------------------------------------

create table if not exists public.quote_approval_emails (
    id                   uuid primary key default gen_random_uuid(),
    company_id           uuid not null references public.companies(id) on delete cascade,
    -- jobs.sync_id, the same key follow_up_log and mail_thread_jobs use. Not a
    -- foreign key: a job is soft-deleted, never removed, and the record of an
    -- email that was sent must outlive whatever happens to the job.
    job_sync_id          uuid not null,
    -- sha256 (hex) of what the email states: property, scope, total, deposit.
    -- See contractKey() in quote-approval-email/email.ts. Not of the
    -- approval's timestamp, the name or the language.
    contract_key         text not null check (contract_key ~ '^[0-9a-f]{64}$'),
    -- sending       claimed; the provider has not answered (or this call died)
    -- sent          the provider accepted it
    -- unconfirmed   it may have gone out (provider 5xx, no answer): never retried
    -- failed        certainly NOT sent; reason_code says why
    -- no_address    the job has no (valid) email address: NOT sent
    -- not_priced    the quote has no price: NOT sent
    state                text not null check (state in ('sending', 'sent', 'failed', 'unconfirmed', 'no_address', 'not_priced')),
    -- A short machine code (no_address, bad_address, not_configured, rate_limited,
    -- send_rejected, ledger_unavailable, sender_unavailable, ...) and one sentence
    -- the office can show. Fixed sentences: nothing the mail provider said is
    -- ever copied in.
    reason_code          text check (reason_code is null or reason_code ~ '^[a-z0-9_]{1,60}$'),
    reason               text check (reason is null or length(reason) <= 300),
    -- Where it went, as it was on the job at the time: the job's address can be
    -- edited afterwards, and "who did we send it to" must not change with it.
    sent_to              text check (sent_to is null or length(sent_to) <= 254),
    -- The Sent-view copy (mail_messages.id) and the provider's own id.
    mail_message_id      uuid,
    provider_message_id  text check (provider_message_id is null or length(provider_message_id) <= 200),
    lang                 text check (lang is null or lang in ('en', 'es', 'fr')),
    attempted_at         timestamptz not null default now(),
    settled_at           timestamptz,
    unique (company_id, job_sync_id, contract_key)
);

create index if not exists quote_approval_emails_job_idx
    on public.quote_approval_emails (company_id, job_sync_id, attempted_at desc);
create index if not exists quote_approval_emails_unsent_idx
    on public.quote_approval_emails (company_id, attempted_at desc) where state <> 'sent';

alter table public.quote_approval_emails enable row level security;

-- Nothing for anyone but the backend, then SELECT back for signed-in members.
revoke all on public.quote_approval_emails from public, anon, authenticated;
grant select, insert, update, delete on public.quote_approval_emails to service_role;
grant select on public.quote_approval_emails to authenticated;

drop policy if exists quote_approval_emails_read on public.quote_approval_emails;
create policy quote_approval_emails_read on public.quote_approval_emails
    for select to authenticated
    using (
        company_id = (select public.current_company_id())
        and (select public.has_permission('SEE_CUSTOMER_CONTACT'))
    );

comment on table public.quote_approval_emails is
  'One row per contract the customer approved, claimed BEFORE the contract email is sent (unique on company, job and contract_key) and settled after. state says whether it went and reason says why not. Written only by the quote-approval-email and quote-view service-role functions. Carries no money.';

select 'quote_approval_emails installed' as done;
