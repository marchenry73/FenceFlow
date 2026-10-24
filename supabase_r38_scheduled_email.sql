-- r38: AN EMAIL CAN BE SCHEDULED, FROM THE OFFICE AND FROM THE PHONE.
--
-- "I also want to be able to schedule an email from the app too, also on the
--  website, on both."
--
-- WHY mail_drafts AND NOT A NEW TABLE. A scheduled email is a draft with a
-- time on it. mail_drafts already carries everything a send needs -- company,
-- author, account, thread, kind, to/cc/bcc, subject, body, the job it belongs
-- to -- and the office already writes, edits and deletes these rows. A second
-- table would be a second copy of all of that, and the two would drift: the
-- office would learn a field and the scheduler would not.
--
-- WHY THIS IS SAFE TO SEND FROM A CRON. mail_drafts has RLS with one policy:
-- a row may only be written by its own author, in their own company, and only
-- when can_use_company_mail() says they may send at all (which refuses CREW
-- outright and requires SEE_MONEY of everyone else). anon cannot insert,
-- because auth.uid() is null and `author_id = null` is never true. So the
-- sender reads the author and the company FROM THE ROW and acts as that
-- person -- it never takes an identity from the request. The worst a leaked
-- trigger secret can do is send an email a real, mail-entitled user already
-- composed and scheduled, to the recipient they already typed.
--
-- EVERY COLUMN IS NULLABLE OR DEFAULTED, so this is inert on arrival: nothing
-- reads these yet, and an existing draft keeps behaving exactly as it does
-- today (send_at null means "an ordinary draft", which is every row there is).

alter table public.mail_drafts
  -- When to send. NULL is an ordinary draft, which is what every existing row
  -- is. This is the only column that decides whether a row is scheduled.
  add column if not exists send_at timestamptz,

  -- How the send is going. NULL for a row nothing has tried yet.
  --   'sending' -- claimed by a sender run, so a second run leaves it alone
  --   'sent'    -- gone; kept briefly so the office can say "sent at 8:02"
  --   'failed'  -- the provider refused; send_error says what it said
  -- 'sending' is the claim, and the claim is what stops two overlapping cron
  -- runs sending the same letter twice.
  add column if not exists send_state text,
  add column if not exists send_attempted_at timestamptz,
  add column if not exists send_error text,

  -- MINTED WHEN THE EMAIL IS SCHEDULED, NOT WHEN IT IS SENT.
  --
  -- This is the whole anti-double-send story, and it is deliberately not a
  -- new mechanism: mail-send already refuses to send the same client_send_id
  -- twice. Minting it at schedule time means a sender that crashes after
  -- handing the letter to the provider, and a retry that follows, both carry
  -- the SAME id -- so the retry can only ever report what already happened.
  -- Minting it at send time would give the retry a fresh id and send a second
  -- copy, which is the one failure a scheduled email must never have.
  add column if not exists client_send_id uuid,

  -- The job whose quote this is, when it is a quote send: the phone's and the
  -- office's quote buttons stamp quote_sent_at and move the job out of DRAFT
  -- only once the provider has confirmed. A SCHEDULED quote is confirmed long
  -- after the screen is gone, so the sender has to do that stamping, and this
  -- is how it knows to. NULL for an ordinary email, which stamps nothing.
  add column if not exists quote_send_for uuid,

  -- Whether the letter hides the grey address under its buttons. The quote
  -- email does; everything else shows it, because a button with no visible
  -- url is the shape a phishing mail has. Carried on the row so a scheduled
  -- quote looks like the one sent by hand.
  add column if not exists hide_cta_url boolean not null default false;

-- Only ever these words, because a typo in a state is a row that never sends
-- and never says why.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'mail_drafts_send_state_known'
  ) then
    alter table public.mail_drafts
      add constraint mail_drafts_send_state_known
      check (send_state is null or send_state in ('sending', 'sent', 'failed'));
  end if;
end $$;

-- THE SENDER'S OWN QUERY, INDEXED. It asks one question every five minutes --
-- "what is due and unclaimed?" -- and a partial index keeps that off the
-- ordinary drafts, which are the overwhelming majority and are never due.
create index if not exists mail_drafts_due_idx
  on public.mail_drafts (send_at)
  where send_at is not null and send_state is null;

-- A scheduled row is still the author's own row, so the existing
-- mail_drafts_own policy already covers reading it, editing it and cancelling
-- it (deleting the row, or clearing send_at). Nothing new is granted here on
-- purpose: this feature must not widen who can write a draft.
--
-- The grants need no change either -- checked rather than assumed:
-- information_schema.table_privileges lists table-level grants on
-- mail_drafts, so a new column inherits them. A per-column grant would not
-- have, and a new ungranted column once took every company's email down.

comment on column public.mail_drafts.send_at is
  'When to send this draft. NULL is an ordinary draft. See supabase_r38_scheduled_email.sql.';
comment on column public.mail_drafts.client_send_id is
  'Minted at SCHEDULE time so a retry cannot double-send: mail-send never sends the same id twice.';
